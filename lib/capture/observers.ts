// lib/capture/observers.ts — IntersectionObserver (viewport-first) + MutationObserver
// (dirty queue) (§4.3).
//
// IntersectionObserver { root: null, rootMargin: "500px 0px", threshold: 0 } replaces
// the reference's 600ms getBoundingClientRect poll: an entry that intersects the real
// viewport → onVisible (viewport lane); an entry that intersects only within the
// rootMargin band → onNear (near lane).
//
// MutationObserver { childList, subtree, characterData } pushes dirty subtrees into a
// dedup Set and tracks removedNodes, drained on a 250ms trailing-edge debounce — an
// upgrade from the reference's blunt 2000ms setInterval. A self-mutation guard skips
// our own injected DOM (MARK_ATTR hosts) and inline/no-score churn so the badge layer
// never feeds its own mutations back into the queue.
import { MARK_ATTR, type Unit } from "../types";
import { NO_SCORE_TAGS, INLINE_TEXT_TAGS, INLINE_IGNORE_TAGS } from "../dom/tags";

export interface Observers {
  observeUnit(unit: Unit): void; // register topElement with the IO
  start(): void;
  stop(): void;
}

const DRAIN_DEBOUNCE_MS = 250;
const ROOT_MARGIN = "500px 0px";

export function createObservers(opts: {
  onVisible(unit: Unit): void; // unit entered viewport → enqueue 'viewport'
  onNear(unit: Unit): void; // within rootMargin → enqueue 'near'
  onDirty(nodes: Node[], removed: Node[]): void; // debounced mutation drain
}): Observers {
  const unitByEl = new WeakMap<Element, Unit>();
  // Per-element dispatch latches: don't re-fire the same lane for the same element.
  const visibleDispatched = new WeakSet<Element>();
  const nearDispatched = new WeakSet<Element>();

  // Mutation dirty queue (dedup by node identity, reference's newNodes.indexOf) +
  // removed-node tracking (reference's removed-node guard).
  const dirty = new Set<Node>();
  const removed = new Set<Node>();
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  // --- Self-mutation guard -------------------------------------------------------

  /** True if this node is (or lives inside) one of our own MARK_ATTR-marked hosts. */
  function inSelfHost(node: Node): boolean {
    const el: Element | null =
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return false;
    if (el.hasAttribute(MARK_ATTR)) return true;
    return el.closest(`[${MARK_ATTR}]`) !== null;
  }

  /** True if this element's tag is inline/no-score churn we never treat as a new block. */
  function isGuardedTag(node: Node): boolean {
    const name = node.nodeName;
    return (
      NO_SCORE_TAGS.has(name) ||
      INLINE_TEXT_TAGS.has(name) ||
      INLINE_IGNORE_TAGS.has(name)
    );
  }

  function ingest(records: MutationRecord[]): void {
    for (const rec of records) {
      if (rec.type === "characterData") {
        // In-place text edit (SPA paragraph update). Guard only against our own DOM;
        // the tag-union guard does not apply to text targets, otherwise characterData
        // watching would be pointless ("#text" ∈ INLINE_TEXT_TAGS).
        if (!inSelfHost(rec.target)) dirty.add(rec.target);
        continue;
      }
      // childList
      rec.addedNodes.forEach((n) => {
        if (inSelfHost(n)) return;
        if (n.nodeType === Node.ELEMENT_NODE && isGuardedTag(n)) return;
        dirty.add(n);
      });
      rec.removedNodes.forEach((n) => {
        if (inSelfHost(n)) return;
        removed.add(n);
      });
    }
  }

  function scheduleDrain(): void {
    // Trailing-edge debounce: each new mutation pushes the drain out to 250ms after
    // the last one.
    if (drainTimer !== null) clearTimeout(drainTimer);
    drainTimer = setTimeout(drain, DRAIN_DEBOUNCE_MS);
  }

  function drain(): void {
    drainTimer = null;
    // Flush any records the observer has buffered but not yet delivered.
    if (mo) ingest(mo.takeRecords());
    if (dirty.size === 0 && removed.size === 0) return;
    const nodes = Array.from(dirty);
    const rem = Array.from(removed);
    dirty.clear();
    removed.clear();
    opts.onDirty(nodes, rem);
  }

  // --- Observers -----------------------------------------------------------------

  const io = new IntersectionObserver(
    (entries) => {
      const vh = window.innerHeight || document.documentElement.clientHeight;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const unit = unitByEl.get(el);
        if (!unit) continue;
        const r = entry.boundingClientRect;
        // Intersecting the *real* viewport → visible; only inside the rootMargin
        // band (above/below the fold) → near.
        const inViewport = r.bottom > 0 && r.top < vh;
        if (inViewport) {
          if (visibleDispatched.has(el)) continue;
          visibleDispatched.add(el);
          io.unobserve(el); // one-shot: highest priority reached
          opts.onVisible(unit);
        } else {
          if (nearDispatched.has(el)) continue;
          nearDispatched.add(el);
          // Keep observing so it can still upgrade to 'viewport' on further scroll.
          opts.onNear(unit);
        }
      }
    },
    { root: null, rootMargin: ROOT_MARGIN, threshold: 0 },
  );

  const mo = new MutationObserver((records) => {
    ingest(records);
    scheduleDrain();
  });

  function observeUnit(unit: Unit): void {
    // Register the unit's topElement (viewport gating anchor); fall back to its block
    // parent when the walker could not resolve a top block.
    const el = unit.topElement ?? unit.parentElement;
    if (!el) return;
    unitByEl.set(el, unit);
    io.observe(el);
  }

  function start(): void {
    if (started) return;
    started = true;
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function stop(): void {
    started = false;
    io.disconnect();
    mo.disconnect();
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    dirty.clear();
    removed.clear();
  }

  return { observeUnit, start, stop };
}
