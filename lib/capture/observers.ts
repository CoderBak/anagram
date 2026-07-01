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
  /** Stop tracking one unit (scored, invalidated, or purged). */
  dropUnit(unit: Unit): void;
  /** Externally mark a subtree dirty (same debounced drain as mutations). */
  markDirty(node: Node): void;
  start(): void;
  stop(): void;
}

const DRAIN_DEBOUNCE_MS = 250;
const ROOT_MARGIN = "500px 0px";
/** Min interval between attribute-driven re-scans of the SAME element. */
const ATTR_RESCAN_MIN_MS = 1500;
const WATCHED_ATTRS = ["class", "style", "hidden", "open", "aria-hidden"];

export function createObservers(opts: {
  onVisible(unit: Unit): void;
  onNear(unit: Unit): void;
  onDirty(nodes: Node[], removed: Node[]): void;
}): Observers {
  const unitsByEl = new WeakMap<Element, Map<string, Unit>>();
  /** Per-unit dispatch latch: which lane has fired. Cleaned up in dropUnit. */
  const dispatched = new Map<string, "near" | "viewport">();
  const attrScanAt = new WeakMap<Element, number>();

  const dirty = new Set<Node>();
  const removed = new Set<Node>();
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

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
      if (rec.type === "characterData") {
        if (!inSelfHost(rec.target)) dirty.add(rec.target);
        continue;
      }
      if (rec.type === "attributes") {
        const el = rec.target as Element;
        if (inSelfHost(el)) continue;
        const now = Date.now();
        const last = attrScanAt.get(el) ?? 0;
        if (now - last < ATTR_RESCAN_MIN_MS) continue; // animation churn guard
        attrScanAt.set(el, now);
        dirty.add(el);
        continue;
      }
      // childList
      rec.addedNodes.forEach((n) => {
        if (inSelfHost(n)) return;
        if (n.nodeType === Node.ELEMENT_NODE && NO_SCORE_TAGS.has(n.nodeName)) return;
        dirty.add(n);
      });
      rec.removedNodes.forEach((n) => {
        if (inSelfHost(n)) return;
        removed.add(n);
      });
    }
  }

  function scheduleDrain(): void {
    if (drainTimer !== null) clearTimeout(drainTimer);
    drainTimer = setTimeout(drain, DRAIN_DEBOUNCE_MS);
  }

  function drain(): void {
    drainTimer = null;
    if (mo) ingest(mo.takeRecords());
    if (dirty.size === 0 && removed.size === 0) return;
    const nodes = Array.from(dirty);
    const rem = Array.from(removed);
    dirty.clear();
    removed.clear();
    opts.onDirty(nodes, rem);
  }

  const io = new IntersectionObserver(
    (entries) => {
      const vh = window.innerHeight || document.documentElement.clientHeight;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        const units = unitsByEl.get(el as Element);
        if (!units || units.size === 0) {
          io.unobserve(el);
          continue;
        }
        const r = entry.boundingClientRect;
        // Intersecting the REAL viewport → 'viewport' lane; only within the
        // rootMargin band above/below the fold → 'near' lane.
        const inViewport = r.bottom > 0 && r.top < vh;
        for (const unit of units.values()) {
          if (unit.isScored) continue;
          const lane = dispatched.get(unit.id);
          if (inViewport) {
            if (lane !== "viewport") {
              dispatched.set(unit.id, "viewport");
              opts.onVisible(unit);
            }
          } else if (!lane) {
            dispatched.set(unit.id, "near");
            opts.onNear(unit);
          }
        }
        // Highest priority reached for everything anchored here → one-shot.
        if (inViewport) io.unobserve(el);
      }
    },
    { root: null, rootMargin: ROOT_MARGIN, threshold: 0 },
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
    io.observe(el); // observing an already-observed target is a no-op
  }

  function dropUnit(unit: Unit): void {
    dispatched.delete(unit.id);
    const el = unit.topElement;
    const units = el ? unitsByEl.get(el) : undefined;
    if (units) {
      units.delete(unit.id);
      if (units.size === 0 && el) io.unobserve(el);
    }
  }

  function markDirty(node: Node): void {
    if (inSelfHost(node)) return;
    dirty.add(node);
    scheduleDrain();
  }

  function start(): void {
    if (started) return;
    started = true;
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRS,
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
    dispatched.clear();
  }

  return { observeUnit, dropUnit, markDirty, start, stop };
}
