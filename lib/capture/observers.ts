// lib/capture/observers.ts — IntersectionObserver (viewport-first) + MutationObserver
// (dirty queue).
//
// v2 fixes over M1:
// - Dispatch latches key off UNIT ID, not element identity. (M1 latched elements in
//   a WeakSet, so after a rescan or a disable→enable cycle the same elements never
//   re-fired and nothing was ever scored again.)
// - An element stays observed until its units are scored, and every change of where it
//   stands — on screen, near it, far from it — is reported, leaving included: a unit that
//   was on screen for a moment of a fast scroll is not left at the head of the queue.
//   (Firefox's full-page translation, translations-document.sys.mjs, keeps its
//   in-viewport and beyond-viewport observers for the same reason.)
// - An element can anchor SEVERAL units (a container whose BR-split halves each
//   cleared the word floor), so the registry is Element → Map<unitId, Unit>.
// - Attribute mutations (class/style/hidden/open/aria-hidden) mark subtrees dirty:
//   tab panels, accordions, "read more" reveals and <details> now get scored when
//   they appear. Rate-limited per element so style-animation churn can't storm.
// - Added inline elements (spans carrying new text — chat apps) are no longer
//   filtered out of the dirty queue; only our own UI and no-score tags are.
// - removedNodes are surfaced so the orchestrator can purge dead units.
// - Shadow roots the walk never went into are watched too: every root already on the page
//   at start, every root in a subtree the page adds, and every root the page attaches
//   later, which the page-world script announces (lib/dom/shadow.ts).
// - Text that changes without changing shape — a like count, a relative time, a score —
//   is QUIET: it is handed over apart from the dirt (see sameShape), because it can change
//   a unit that owns it and nothing else. A feed rewrites those every second on every post
//   it shows, and each rewrite was a walk: on a page that keeps its posts, a walk costs as
//   much as the page is long, so an hour on it cost more every minute than the last.
import { MARK_ATTR, type Unit } from "../types";
import { NO_SCORE_TAGS } from "../dom/tags";
import { countWords } from "../dom/text";
import { repairSplits } from "../dom/splits";
import { eachShadowRoot, eachShadowRootInSlices, noteShadowHost, shadowAttachedEvent, shadowRootOf } from "../dom/shadow";
import { finishInSlices } from "../slices";

export interface Observers {
  observeUnit(unit: Unit): void;
  /** Watch mutations inside an open shadow root the walker descended into. Idempotent. */
  observeRoot(root: ShadowRoot): void;
  /** Stop tracking one unit (scored, invalidated, or purged). */
  dropUnit(unit: Unit): void;
  /** Place a unit again as if it had just been found: its batch was abandoned, and the one
   *  dispatch it gets was spent on it — the viewport observer lets an element go once seen. */
  reobserve(unit: Unit): void;
  /** Both observers have said where the unit stands — on screen, near, or neither. Until
   *  they have, the idle prefetch leaves it to them: the page's first screen, sent in a
   *  background batch the moment the walk ended, waited for the batch's every paragraph,
   *  and could not be moved to the viewport lane once out. A unit nothing observes is placed. */
  placed(unit: Unit): boolean;
  start(): void;
  stop(): void;
}

const DRAIN_DEBOUNCE_MS = 250;
/** How long the idle prefetch waits for the observers to place a unit (Observers.placed). */
const PLACE_WAIT_MS = 1000;
/** A trailing debounce alone never fires on a page that mutates continuously (live
 *  tickers, streaming chat): the drain is forced once dirt has waited this long. */
const DRAIN_MAX_WAIT_MS = 1000;
/**
 * A drain waits this many times as long as the last ones took, so draining takes at most
 * one part in twenty of the main thread however long the page grows. A walk costs about
 * as much as the page is long (the scopes it surveys are the whole page's), and a feed
 * that keeps every post it has shown grows for as long as it is read: without this, the
 * same trickle of mutations cost more every minute. Mutations are collected as they come
 * and handed over in batches, as uBlock Origin's DOM watcher does (vAPI.domWatcher in
 * src/js/contentscript.js, https://github.com/gorhill/uBlock, GPL-3.0); the batch here
 * waits in proportion to what the last ones cost rather than for the next frame.
 */
const DRAIN_COST_SPACING = 19;
/** But no longer than this. A drain is timed by the clock, so one a busy machine or a
 *  garbage collection stalled looks dear, and what the page adds after it would wait for
 *  as long as twenty such drains: it is read within this instead. Only drains dearer than
 *  260 ms, which no page has been seen to cost, take more than a twentieth again. */
const DRAIN_MAX_SPACING_MS = 5000;
// Prefetch margin for the "near" lane: 1200 px ahead, about a screen and a half of a laptop's
// (1.4 at the budgets' 850 px) and less than one of a tall monitor's, keeps chips landing
// before the paragraph enters the viewport at reading speed.
const ROOT_MARGIN = "1200px 0px";
/** Min interval between attribute-driven re-scans of the SAME element. */
const ATTR_RESCAN_MIN_MS = 1500;
/**
 * The most changed nodes held for the next drain. They are held themselves, the ones the page
 * has thrown away since included, until the drain: a page that rebuilds ten thousand elements
 * every frame had millions of its discarded nodes kept alive here for seconds. Past this
 * many, nothing more is held and the drain reads the whole page again, which costs what its
 * first reading did and is spaced like any other drain.
 */
const MOST_HELD = 10_000;
// "aria-expanded" belongs here because of the clipped-box rule (lib/dom/style.ts): the
// only thing some "see more" controls change in the DOM is that flag on the BUTTON, and
// the box it expands is the button's sibling — a scan root one level above the dirty
// node covers both, so the post is scored the moment it opens.
export const WATCHED_ATTRS = ["class", "style", "hidden", "open", "aria-hidden", "aria-expanded"];

/** Where an observed element stands: on screen, within the prefetch margin, or beyond it. */
type Zone = "viewport" | "near" | "far";

export function createObservers(opts: {
  onVisible(unit: Unit): void;
  onNear(unit: Unit): void;
  /** A unit reported near or on screen before is beyond the prefetch margin now. */
  onFar?(unit: Unit): void;
  /** Both observers have answered for some elements for the first time (Observers.placed). */
  onPlaced?(): void;
  /** `quiet`: text that changed without changing shape — the text node that changed (for
   *  one the page replaced, the one that left) and the element it stood in. */
  /** Re-read what changed. A promise is a drain that walks in slices: it resolves to what it
   *  cost the main thread, in ms, and no other drain starts before it does. */
  onDirty(nodes: Node[], removed: Node[], quiet: Map<Text, Element>): void | Promise<number>;
  /** The document element itself was replaced (document.open()/write()). */
  onDocumentReplaced?(): void;
}): Observers {
  const unitsByEl = new WeakMap<Element, Map<string, Unit>>();
  /** Per-unit latch: the zone last reported for it. Cleaned up in dropUnit. */
  const reported = new Map<string, Zone>();
  /** What each observer last said about an element, and which have said anything (1 near,
   *  2 viewport). */
  let seen = new WeakMap<Element, { near: boolean; viewport: boolean; known: number }>();
  const attrScanAt = new WeakMap<Element, number>();
  /** An element was placed in the batch of entries being noted. */
  let placedSome = false;
  /** When each element was first given to the observers (placed). */
  const observedAt = new WeakMap<Element, number>();

  const dirty = new Set<Node>();
  const removed = new Set<Node>();
  const quiet = new Map<Text, Element>();
  const attrPending = new Set<Element>();
  let attrTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest undrained dirt arrived (max-wait guard). */
  let dirtySince: number | null = null;
  /** What recent drains cost, in ms: the last one's, or half the one before if more. */
  let drainCost = 0;
  /** A drain is walking still. */
  let draining = false;
  let lastDrainAt = 0;
  let documentReplaced = false;
  /** More changed than is held (MOST_HELD): the next drain reads the whole page. */
  let wholePage = false;
  let started = false;
  /** Shadow roots the single MutationObserver also watches (it accepts many targets). */
  let observedRoots = new WeakSet<ShadowRoot>();
  const pendingRoots = new Set<ShadowRoot>();
  const MO_OPTIONS: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
    // repairSplits tells the page's own writes from the walker's cuts by the old value.
    characterDataOldValue: true,
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
    // First put back any page node the walker cut and the page has since changed, so what
    // follows reads the page as its own script left it.
    repairSplits(records);
    for (const rec of records) {
      // A childList record on the Document node means <html> itself came or went.
      if (rec.type === "childList" && rec.target.nodeType === Node.DOCUMENT_NODE) {
        if ([...rec.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE)) {
          documentReplaced = true;
          scheduleDrain();
        }
        continue;
      }
      // Past MOST_HELD nothing is held: only the shadow roots a subtree brings are looked for.
      const holding = !wholePage && !overflowed();
      if (!holding && rec.type !== "childList") continue;
      if (rec.type === "characterData") {
        if (inSelfHost(rec.target)) continue;
        const parent = rec.target.parentElement;
        if (parent && sameShape(rec.oldValue ?? "", (rec.target as Text).data)) quiet.set(rec.target as Text, parent);
        else dirty.add(rec.target);
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
      // childList. A text node swapped for another of the same shape (`el.textContent = n`
      // on a counter) is quiet: what left is what a unit could have owned.
      if (textSwap(rec)) {
        if (holding && !inSelfHost(rec.target)) rec.removedNodes.forEach((n) => quiet.set(n as Text, rec.target as Element));
        continue;
      }
      rec.addedNodes.forEach((n) => {
        if (inSelfHost(n)) return;
        if (n.nodeType === Node.ELEMENT_NODE && NO_SCORE_TAGS.has(n.nodeName.toUpperCase())) return;
        if (holding) dirty.add(n);
        // A root attached before its host was added, which the walk of this subtree will
        // not go into while it is empty — a closed panel, a widget that renders later.
        if (n.nodeType === Node.ELEMENT_NODE) eachShadowRoot(n, observeRoot);
      });
      if (holding) {
        rec.removedNodes.forEach((n) => {
          if (inSelfHost(n)) return;
          removed.add(n);
        });
      }
    }
    overflowed();
  }

  /** More is held than MOST_HELD: let it all go, and have the next drain read the whole page. */
  function overflowed(): boolean {
    if (dirty.size + removed.size + quiet.size < MOST_HELD) return false;
    wholePage = true;
    dirty.clear();
    removed.clear();
    quiet.clear();
    return true;
  }

  function scheduleDrain(): void {
    const now = Date.now();
    if (dirtySince === null) dirtySince = now;
    if (drainTimer !== null) clearTimeout(drainTimer);
    const spacing = Math.min(drainCost * DRAIN_COST_SPACING, DRAIN_MAX_SPACING_MS);
    const debounced = Math.min(DRAIN_DEBOUNCE_MS, dirtySince + Math.max(DRAIN_MAX_WAIT_MS, spacing) - now);
    drainTimer = setTimeout(drain, Math.max(0, debounced, lastDrainAt + spacing - now));
  }

  function drain(): void {
    drainTimer = null;
    // A drain still walking (it pauses to let the page run): the dirt waits for it, and is
    // handed over when it is done.
    if (draining) return;
    dirtySince = null;
    if (mo) ingest(mo.takeRecords());
    if (documentReplaced) {
      documentReplaced = false;
      wholePage = false;
      dirty.clear();
      removed.clear();
      quiet.clear();
      opts.onDocumentReplaced?.();
      return;
    }
    if (wholePage) {
      wholePage = false;
      dirty.clear();
      dirty.add(document.body ?? document.documentElement);
    }
    if (dirty.size === 0 && removed.size === 0 && quiet.size === 0) return;
    const nodes = Array.from(dirty);
    const rem = Array.from(removed);
    const still = new Map(quiet);
    dirty.clear();
    removed.clear();
    quiet.clear();
    const began = performance.now();
    const done = (cost: number): void => {
      drainCost = Math.max(cost, drainCost / 2);
      lastDrainAt = Date.now();
    };
    const pending = opts.onDirty(nodes, rem, still);
    if (!(pending instanceof Promise)) { done(performance.now() - began); return; }
    // What the drain cost is what it says: its walks' pauses were the page's time.
    draining = true;
    void pending.then((cost) => done(typeof cost === "number" ? cost : performance.now() - began), () => done(performance.now() - began)).finally(() => {
      draining = false;
      if (wholePage || dirty.size > 0 || removed.size > 0 || quiet.size > 0) scheduleDrain();
    });
  }

  // TWO observers: with a single rootMargin observer and threshold 0, no event
  // fires when an element moves from the margin band INTO the real viewport (the
  // intersection state vs the expanded root never changes), so the near→viewport
  // lane upgrade was unreachable. ioNear prefetches; ioViewport upgrades.
  /** Tell the orchestrator about every unscored unit here whose zone has changed. A zone
   *  first seen as "far" is only noted: the idle prefetch queues those in reading order. */
  function report(el: Element): void {
    const units = unitsByEl.get(el);
    const at = seen.get(el);
    // Placed once both observers have answered for it: their first answers come in one frame,
    // in no fixed order, and the near one alone sent the first screen in a near batch of four
    // paragraphs before the viewport one could say they were on screen.
    if (!units || units.size === 0 || !at || at.known !== 3) return;
    const zone: Zone = at.viewport ? "viewport" : at.near ? "near" : "far";
    for (const unit of units.values()) {
      if (unit.isScored) continue;
      const prev = reported.get(unit.id);
      if (prev === zone) continue;
      reported.set(unit.id, zone);
      if (zone === "viewport") opts.onVisible(unit);
      else if (zone === "near") opts.onNear(unit);
      else if (prev !== undefined) opts.onFar?.(unit);
    }
  }

  function note(entries: IntersectionObserverEntry[], key: "near" | "viewport"): void {
    for (const entry of entries) {
      const el = entry.target as Element;
      const at = seen.get(el) ?? { near: false, viewport: false, known: 0 };
      at[key] = entry.isIntersecting;
      const was = at.known;
      at.known |= key === "near" ? 1 : 2;
      if (was !== 3 && at.known === 3) placedSome = true;
      seen.set(el, at);
      report(el);
    }
    // Whatever the idle prefetch was waiting for the observers to place may go now.
    if (placedSome) { placedSome = false; opts.onPlaced?.(); }
  }

  const ioNear = new IntersectionObserver((entries) => note(entries, "near"), {
    root: null,
    rootMargin: ROOT_MARGIN,
    threshold: 0,
  });

  const ioViewport = new IntersectionObserver((entries) => note(entries, "viewport"), {
    root: null,
    threshold: 0,
  });

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
    if (!observedAt.has(el)) observedAt.set(el, performance.now());
    ioNear.observe(el); // observing an already-observed target is a no-op
    ioViewport.observe(el);
    // …so a unit joining an element the observers have already placed is placed with it.
    report(el);
  }

  function dropUnit(unit: Unit): void {
    reported.delete(unit.id);
    const el = unit.topElement;
    const units = el ? unitsByEl.get(el) : undefined;
    if (units) {
      units.delete(unit.id);
      if (units.size === 0 && el) {
        ioNear.unobserve(el);
        ioViewport.unobserve(el);
        seen.delete(el);
      }
    }
  }

  function reobserve(unit: Unit): void {
    reported.delete(unit.id);
    const el = unit.topElement;
    if (!el || !el.isConnected) return;
    // Observing a target that is already observed reports nothing: let go of it first, so
    // the observers answer where it is NOW.
    ioNear.unobserve(el);
    ioViewport.unobserve(el);
    seen.delete(el);
    observeUnit(unit);
  }

  /** The page attached a shadow root (entrypoints/shadow.content.ts): watch it from now on,
   *  and walk its host again once whatever it renders there has settled. */
  function onShadowAttached(e: Event): void {
    const host = e.composedPath()[0] as Node | undefined;
    if (!host || host.nodeType !== Node.ELEMENT_NODE || inSelfHost(host)) return;
    noteShadowHost(host as Element); // closed or open, its root is read from now on
    // The root just attached is all that is new: whatever is below the host was looked in
    // when it came, and a page that gave a root to each of ten thousand nested elements had
    // the whole tree below each one walked again.
    const root = shadowRootOf(host as Element);
    if (root) {
      observeRoot(root);
      eachShadowRoot(root, observeRoot);
    }
    dirty.add(host);
    scheduleDrain();
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
    // …and every shadow root already on the page, walked into or not: every element of it, a
    // slice at a time (a table of twenty thousand rows is a hundred thousand of them). The
    // walk reports the roots it goes into as it does (CollectOptions.onShadowRoot).
    void finishInSlices(eachShadowRootInSlices(document, (root) => { if (started) observeRoot(root); }));
    const attached = shadowAttachedEvent();
    if (attached) document.addEventListener(attached, onShadowAttached, true);
  }

  function stop(): void {
    started = false;
    const attached = shadowAttachedEvent();
    if (attached) document.removeEventListener(attached, onShadowAttached, true);
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
    quiet.clear();
    wholePage = false;
    reported.clear();
    seen = new WeakMap(); // disconnect() forgot every target: the next start asks afresh
    dirtySince = null;
    drainCost = 0;
    lastDrainAt = 0;
    observedRoots = new WeakSet(); // disconnect() dropped them; the next scan re-registers
    pendingRoots.clear();
  }

  function placed(unit: Unit): boolean {
    const el = unit.topElement;
    if (!el || !el.isConnected || !unitsByEl.get(el)?.has(unit.id)) return true;
    // An observer answers within a frame or two; one that has not in a second never will.
    return seen.get(el)?.known === 3 || performance.now() - (observedAt.get(el) ?? 0) > PLACE_WAIT_MS;
  }

  return { observeUnit, observeRoot, dropUnit, reobserve, placed, start, stop };
}

/**
 * The same number of words before and after. Text that keeps its shape cannot take a
 * paragraph over the word floor or out from under it, so it cannot make a unit or unmake
 * one it is not part of; what it can change is the text of a unit that owns it, and the
 * orchestrator checks that. Anything that grows or shrinks — a chat message typed, a
 * paragraph streamed — is dirt as before.
 */
function sameShape(before: string, after: string): boolean {
  return countWords(before) === countWords(after);
}

/** A childList record that only put text in place of text, of the same shape. */
function textSwap(rec: MutationRecord): boolean {
  if (rec.target.nodeType !== Node.ELEMENT_NODE || rec.addedNodes.length === 0 || rec.removedNodes.length === 0) return false;
  let before = "";
  let after = "";
  for (const n of rec.removedNodes) {
    if (n.nodeType !== Node.TEXT_NODE) return false;
    before += (n as Text).data;
  }
  for (const n of rec.addedNodes) {
    if (n.nodeType !== Node.TEXT_NODE) return false;
    after += (n as Text).data;
  }
  return sameShape(before, after);
}
