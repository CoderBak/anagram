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
  const attrPending = new Set<Element>();
  let attrTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

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
  }

  return { observeUnit, dropUnit, start, stop };
}
