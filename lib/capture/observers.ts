// lib/capture/observers.ts — IntersectionObserver (viewport-first) + MutationObserver
// (dirty queue).
//
// v2 fixes over M1:
// - Dispatch latches key off UNIT ID, not element identity. (M1 latched elements in
//   a WeakSet, so after a rescan or a disable→enable cycle the same elements never
//   re-fired and nothing was ever scored again.)
// - An element can anchor SEVERAL units (a container whose BR-split halves each
//   cleared the word floor), so the registry is Element → Map<unitId, Unit>.
// - Attribute mutations (class/style/hidden/open/aria-hidden) mark subtrees dirty:
//   tab panels, accordions, "read more" reveals and <details> now get scored when
//   they appear. Rate-limited per element so style-animation churn can't storm.
// - Added inline elements (spans carrying new text — chat apps) are no longer
//   filtered out of the dirty queue; only our own UI and no-score tags are.
// - removedNodes are surfaced so the orchestrator can purge dead units.
import { MARK_ATTR, type Unit } from "../types";
import { NO_SCORE_TAGS } from "../dom/tags";

export interface Observers {
  observeUnit(unit: Unit): void;
  /** Watch mutations inside an open shadow root the walker descended into. Idempotent. */
  observeRoot(root: ShadowRoot): void;
  /** Stop tracking one unit (scored, invalidated, or purged). */
  dropUnit(unit: Unit): void;
  start(): void;
  stop(): void;
}

const DRAIN_DEBOUNCE_MS = 250;
/** A trailing debounce alone never fires on a page that mutates continuously (live
 *  tickers, streaming chat): the drain is forced once dirt has waited this long. */
const DRAIN_MAX_WAIT_MS = 1000;
// Prefetch margin for the "near" lane: at reading-speed scrolling, ~1.5 screens ahead
// keeps chips landing before the paragraph enters the viewport.
const ROOT_MARGIN = "1200px 0px";
/** Min interval between attribute-driven re-scans of the SAME element. */
const ATTR_RESCAN_MIN_MS = 1500;
// "aria-expanded" belongs here because of the clipped-box rule (lib/dom/style.ts): the
// only thing some "see more" controls change in the DOM is that flag on the BUTTON, and
// the box it expands is the button's sibling — a scan root one level above the dirty
// node covers both, so the post is scored the moment it opens.
export const WATCHED_ATTRS = ["class", "style", "hidden", "open", "aria-hidden", "aria-expanded"];

export function createObservers(opts: {
  onVisible(unit: Unit): void;
  onNear(unit: Unit): void;
  onDirty(nodes: Node[], removed: Node[]): void;
  /** The document element itself was replaced (document.open()/write()). */
  onDocumentReplaced?(): void;
}): Observers {
  const unitsByEl = new WeakMap<Element, Map<string, Unit>>();
  /** Per-unit dispatch latch: which lane has fired. Cleaned up in dropUnit. */
  const dispatched = new Map<string, "near" | "viewport">();
  const attrScanAt = new WeakMap<Element, number>();

  const dirty = new Set<Node>();
  const removed = new Set<Node>();
  const attrPending = new Set<Element>();
  let attrTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest undrained dirt arrived (max-wait guard). */
  let dirtySince: number | null = null;
  let documentReplaced = false;
  let started = false;
  /** Shadow roots the single MutationObserver also watches (it accepts many targets). */
  let observedRoots = new WeakSet<ShadowRoot>();
  const pendingRoots = new Set<ShadowRoot>();
  const MO_OPTIONS: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRS,
  };

  function flushAttrPending(): void {
    attrTimer = null;
    if (attrPending.size === 0) return;
    const now = Date.now();
    for (const el of attrPending) {
      attrScanAt.set(el, now);
      dirty.add(el);
    }
    attrPending.clear();
    scheduleDrain();
  }

  /** True if this node is (or lives inside) one of our own MARK_ATTR hosts. */
  function inSelfHost(node: Node): boolean {
    const el: Element | null =
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el) return false;
    if (el.hasAttribute(MARK_ATTR)) return true;
    return el.closest(`[${MARK_ATTR}]`) !== null;
  }

  function ingest(records: MutationRecord[]): void {
    for (const rec of records) {
      // A childList record on the Document node means <html> itself came or went.
      if (rec.type === "childList" && rec.target.nodeType === Node.DOCUMENT_NODE) {
        if ([...rec.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE)) {
          documentReplaced = true;
          scheduleDrain();
        }
        continue;
      }
      if (rec.type === "characterData") {
        if (!inSelfHost(rec.target)) dirty.add(rec.target);
        continue;
      }
      if (rec.type === "attributes") {
        const el = rec.target as Element;
        if (inSelfHost(el)) continue;
        const now = Date.now();
        const last = attrScanAt.get(el) ?? 0;
        if (now - last < ATTR_RESCAN_MIN_MS) {
          // Animation-churn guard — but DEFER instead of dropping, or the second
          // change inside the window (the actual reveal) would never be scanned.
          attrPending.add(el);
          if (attrTimer === null) {
            attrTimer = setTimeout(flushAttrPending, ATTR_RESCAN_MIN_MS - (now - last) + 20);
          }
          continue;
        }
        attrScanAt.set(el, now);
        dirty.add(el);
        continue;
      }
      // childList
      rec.addedNodes.forEach((n) => {
        if (inSelfHost(n)) return;
        if (n.nodeType === Node.ELEMENT_NODE && NO_SCORE_TAGS.has(n.nodeName.toUpperCase())) return;
        dirty.add(n);
      });
      rec.removedNodes.forEach((n) => {
        if (inSelfHost(n)) return;
        removed.add(n);
      });
    }
  }

  function scheduleDrain(): void {
    const now = Date.now();
    if (dirtySince === null) dirtySince = now;
    if (drainTimer !== null) clearTimeout(drainTimer);
    const wait = Math.max(0, Math.min(DRAIN_DEBOUNCE_MS, dirtySince + DRAIN_MAX_WAIT_MS - now));
    drainTimer = setTimeout(drain, wait);
  }

  function drain(): void {
    drainTimer = null;
    dirtySince = null;
    if (mo) ingest(mo.takeRecords());
    if (documentReplaced) {
      documentReplaced = false;
      dirty.clear();
      removed.clear();
      opts.onDocumentReplaced?.();
      return;
    }
    if (dirty.size === 0 && removed.size === 0) return;
    const nodes = Array.from(dirty);
    const rem = Array.from(removed);
    dirty.clear();
    removed.clear();
    opts.onDirty(nodes, rem);
  }

  // TWO observers: with a single rootMargin observer and threshold 0, no event
  // fires when an element moves from the margin band INTO the real viewport (the
  // intersection state vs the expanded root never changes), so the near→viewport
  // lane upgrade was unreachable. ioNear prefetches; ioViewport upgrades.
  function dispatchLane(el: Element, lane: "near" | "viewport"): void {
    const units = unitsByEl.get(el);
    if (!units || units.size === 0) return;
    for (const unit of units.values()) {
      if (unit.isScored) continue;
      const prev = dispatched.get(unit.id);
      if (lane === "viewport" && prev !== "viewport") {
        dispatched.set(unit.id, "viewport"); // fresh dispatch or near→viewport upgrade
        opts.onVisible(unit);
      } else if (lane === "near" && prev === undefined) {
        dispatched.set(unit.id, "near");
        opts.onNear(unit);
      }
    }
  }

  const ioNear = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) dispatchLane(entry.target as Element, "near");
      }
    },
    { root: null, rootMargin: ROOT_MARGIN, threshold: 0 },
  );

  const ioViewport = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as Element;
        dispatchLane(el, "viewport");
        // Highest priority reached for everything anchored here → one-shot.
        ioViewport.unobserve(el);
        ioNear.unobserve(el);
      }
    },
    { root: null, threshold: 0 },
  );

  const mo = new MutationObserver((records) => {
    ingest(records);
    scheduleDrain();
  });

  function observeUnit(unit: Unit): void {
    const el = unit.topElement;
    if (!el || !el.isConnected) return;
    let units = unitsByEl.get(el);
    if (!units) {
      units = new Map();
      unitsByEl.set(el, units);
    }
    units.set(unit.id, unit);
    ioNear.observe(el); // observing an already-observed target is a no-op
    ioViewport.observe(el);
  }

  function dropUnit(unit: Unit): void {
    dispatched.delete(unit.id);
    const el = unit.topElement;
    const units = el ? unitsByEl.get(el) : undefined;
    if (units) {
      units.delete(unit.id);
      if (units.size === 0 && el) {
        ioNear.unobserve(el);
        ioViewport.unobserve(el);
      }
    }
  }

  function observeRoot(root: ShadowRoot): void {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    if (started) mo.observe(root, MO_OPTIONS);
    else pendingRoots.add(root);
  }

  function start(): void {
    if (started) return;
    started = true;
    // The Document node, not <html>: document.open()/write() replaces <html>, and an
    // observer on the old element would never hear from the new tree.
    mo.observe(document, MO_OPTIONS);
    for (const root of pendingRoots) mo.observe(root, MO_OPTIONS);
    pendingRoots.clear();
  }

  function stop(): void {
    started = false;
    ioNear.disconnect();
    ioViewport.disconnect();
    mo.disconnect();
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (attrTimer !== null) {
      clearTimeout(attrTimer);
      attrTimer = null;
    }
    attrPending.clear();
    dirty.clear();
    removed.clear();
    dispatched.clear();
    dirtySince = null;
    observedRoots = new WeakSet(); // disconnect() dropped them; the next scan re-registers
    pendingRoots.clear();
  }

  return { observeUnit, observeRoot, dropUnit, start, stop };
}
