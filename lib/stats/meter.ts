// lib/stats/meter.ts — what of a page was READ, for the reading statistics: the page's half.
//
// A paragraph is read once it has been on screen for a second in all, while the page was
// shown and not being flung past (lib/capture/fling.ts: faster than anyone reads, what
// flashes by is not read). It counts once per page view however often it is scrolled back
// to, and if it was read before its verdict came, it counts when the verdict does. A stretch
// the walk left unread for being short (CollectOptions.onShortText) counts the same way, as
// words without a verdict.
//
// The orchestrator's own observers let a paragraph go the moment it is scored, which is
// usually before anyone reads it, so this keeps an observer of its own, and only while the
// reader has asked for statistics: off, nothing here runs. It does nothing per scroll event.
// Its observer is told only when a paragraph crosses into or out of the screen, and a timer
// runs once a second while a paragraph is on screen to add up the time. A paragraph leaves
// the observer once it has counted.
//
// What leaves the page is numbers: each paragraph's words and the model's four
// probabilities, the words that had none and why, the kind of page and how long it was
// shown — sent every few seconds while there is something to send, and once more as the
// page goes (STATS_RECORD; lib/stats/worker.ts decides what is kept). Never text, never an
// address: the worker takes those from the browser.
import { browser } from "#imports";
import type { Unit } from "../types";
import type { ScoreResult } from "../contract";
import { ACTIONS } from "../messaging/protocol";
import { cyrb53 } from "../hash";
import { countWords } from "../dom/text";
import { STATS_MAX_DWELL_S, STATS_MAX_ENTRIES, STATS_MAX_WORDS, type PageKind, type SkipReason } from "./model";

/** Time on screen that makes a paragraph read. */
export const READ_MS = 1000;
/** How often the time on screen is added up while something is on screen. */
const TICK_MS = 1000;
/** How soon what was read is sent. */
const FLUSH_MS = 5000;
/** How often the time shown alone is sent, once something on the page has been read. */
const DWELL_FLUSH_MS = 60_000;
/** Nobody has scrolled, clicked or typed for this long: the time shown stops counting. */
const IDLE_MS = 120_000;
/** The edges of the screen, a tenth at the top and at the bottom, where a paragraph is only
 *  peeking in. */
const ROOT_MARGIN = "-10% 0px -10% 0px";

/** This document is in a private window, where nothing is measured (the worker would keep
 *  none of it either). */
export function inPrivateWindow(): boolean {
  try {
    return browser.extension?.inIncognitoContext === true;
  } catch {
    return false; // a dead extension context records nothing anyway
  }
}

export interface ReadingMeterOptions {
  /** The page's own fling detector: while it says the page is flung past, nothing is read. */
  fling: { delay(): number };
  /** The unit's verdict now, if it has one. */
  verdictOf(unit: Unit): ScoreResult | undefined;
  /** Whether a short stretch (by its first node) is still one the walk left unread. */
  stillShort(first: Text): boolean;
  kind(): PageKind;
  /** The top frame and the PDF reader say how long the page was shown; a frame does not. */
  ownsDwell: boolean;
  send(message: object): Promise<unknown>;
}

export interface ReadingMeter {
  running(): boolean;
  /** Start measuring, with the units already on the page. */
  start(units: Iterable<Unit>): void;
  /** Stop. `send` (the default) sends what was read first, and counts what was read with no
   *  verdict as unavailable; false drops it — the reader turned statistics off. */
  stop(send?: boolean): void;
  track(unit: Unit): void;
  trackShort(nodes: Text[]): void;
  /** A unit's verdict arrived. */
  verdict(unit: Unit, result: ScoreResult): void;
  /** The unit is gone from the page. */
  forget(unit: Unit): void;
  /** Every unit is about to be replaced (a rescan): let them all go. What counted stays counted. */
  drop(): void;
  /** Another page view begins in the same document (a route change). */
  newView(units: Iterable<Unit>): void;
}

interface Watch {
  units: Set<Unit>;
  short: Text[] | null;
  /** Time on screen so far, and since when it is on screen now (null: it is not). */
  dwell: number;
  since: number | null;
}

interface Pending {
  units: { w: number; p: number[] }[];
  skipped: { w: number; why: SkipReason }[];
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const wordsOf = (n: number): number => Math.min(STATS_MAX_WORDS, Math.max(1, Math.round(n)));

export function createReadingMeter(opts: ReadingMeterOptions): ReadingMeter {
  let on = false;
  let io: IntersectionObserver | null = null;
  const watched = new Map<Element, Watch>();
  const shownNow = new Set<Element>();
  /** Read, and waiting for a verdict that can be counted. */
  const awaiting = new Set<Unit>();
  /** The texts counted in this page view, by hash: a paragraph the page re-renders, or the
   *  PDF reader draws again, is the same paragraph. */
  const counted = new Set<number>();
  let pending: Pending = { units: [], skipped: [] };
  let tick: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushDue = 0;
  /** The page's time shown: what is not sent yet, since when it is shown, the last sign of a
   *  reader, and whether anything of this view has counted (until then it is never sent). */
  let dwellMs = 0;
  let shownSince: number | null = null;
  let lastActivity = 0;
  let readSomething = false;

  const now = (): number => performance.now();
  const hidden = (): boolean => document.visibilityState === "hidden";

  function watchOf(el: Element): Watch {
    let w = watched.get(el);
    if (!w) {
      w = { units: new Set(), short: null, dwell: 0, since: null };
      watched.set(el, w);
      io?.observe(el);
    }
    return w;
  }

  /** Watch a unit until it is read. Whether its text has counted already is asked only then:
   *  a page's every paragraph comes through here, and most are never read. */
  function track(unit: Unit): void {
    if (!on || !unit.topElement.isConnected) return;
    watchOf(unit.topElement).units.add(unit);
  }

  function trackShort(nodes: Text[]): void {
    const el = nodes[0]?.parentElement;
    if (!on || !el || !el.isConnected) return;
    watchOf(el).short = nodes;
  }

  /** Add the time `el` has been on screen since it was last looked at, if the page was shown
   *  (`shown`: as the page is hidden, the time up to then was) and settled; then whether it
   *  has been read. */
  function credit(el: Element, w: Watch, at: number, shown = !hidden()): void {
    if (w.since !== null && shown && opts.fling.delay() === 0) w.dwell += at - w.since;
    if (w.since !== null) w.since = at;
    if (w.dwell >= READ_MS) read(el, w);
  }

  function read(el: Element, w: Watch): void {
    io?.unobserve(el);
    watched.delete(el);
    shownNow.delete(el);
    for (const unit of w.units) count(unit, opts.verdictOf(unit));
    const first = w.short?.[0];
    if (w.short && first && opts.stillShort(first)) {
      const text = w.short.filter((n) => n.isConnected).map((n) => n.data).join(" ");
      const key = cyrb53(text);
      const words = countWords(text);
      if (words > 0 && !counted.has(key)) {
        counted.add(key);
        add({ w: wordsOf(words), why: "short" });
      }
    }
  }

  /** A read unit and its verdict: counted, or kept waiting for one that can be. */
  function count(unit: Unit, result: ScoreResult | undefined): void {
    const key = cyrb53(unit.text);
    if (counted.has(key)) { awaiting.delete(unit); return; }
    if (!result || result.degraded) { awaiting.add(unit); return; }
    awaiting.delete(unit);
    counted.add(key);
    if (result.unsupported) add({ w: wordsOf(unit.wordCount), why: "language" });
    else add({ w: wordsOf(unit.wordCount), p: result.probs.slice(0, 4).map(round4) });
  }

  function add(entry: { w: number; p: number[] } | { w: number; why: SkipReason }): void {
    readSomething = true;
    if ("p" in entry) pending.units.push(entry);
    else pending.skipped.push(entry);
    schedule();
  }

  function onEntries(entries: IntersectionObserverEntry[]): void {
    const at = now();
    // A paragraph coming onto the screen or leaving it is somebody scrolling; the first answer
    // for one far below, which a feed adding posts brings, is not.
    let moved = false;
    for (const entry of entries) {
      const el = entry.target;
      const w = watched.get(el);
      if (!w) { io?.unobserve(el); continue; }
      if (entry.isIntersecting) {
        moved = true;
        shownNow.add(el);
        w.since = at;
      } else {
        if (w.since !== null) moved = true;
        credit(el, w, at);
        shownNow.delete(el);
        w.since = null;
      }
    }
    if (moved) onActivity();
    armTick();
  }

  function armTick(): void {
    if (tick !== null || !on || shownNow.size === 0 || hidden()) return;
    tick = setTimeout(onTick, TICK_MS);
  }

  function onTick(): void {
    tick = null;
    const at = now();
    for (const el of [...shownNow]) {
      const w = watched.get(el);
      if (w) credit(el, w, at);
      else shownNow.delete(el);
    }
    armTick();
  }

  /** The time shown, up to now: not past the reader's last sign plus IDLE_MS. */
  function addShown(at: number): void {
    if (shownSince === null) return;
    const until = Math.min(at, lastActivity + IDLE_MS);
    if (until > shownSince) dwellMs += until - shownSince;
    shownSince = at;
  }

  function onActivity(): void {
    const at = now();
    // Back from being away: the time away is not added; from here it is again.
    if (shownSince !== null && at - lastActivity > IDLE_MS) { addShown(at); shownSince = at; }
    lastActivity = at;
  }

  function onVisibility(): void {
    const at = now();
    if (hidden()) {
      addShown(at);
      shownSince = null;
      for (const el of [...shownNow]) { const w = watched.get(el); if (w) credit(el, w, at, true); }
      flush(false);
    } else {
      shownSince = at;
      lastActivity = at;
      for (const el of shownNow) { const w = watched.get(el); if (w) w.since = at; }
      armTick();
      schedule();
    }
  }

  const onPageHide = (): void => flush(true);

  function schedule(): void {
    if (!on) return;
    const delay = pending.units.length || pending.skipped.length ? FLUSH_MS
      : opts.ownsDwell && readSomething && !hidden() ? DWELL_FLUSH_MS : null;
    if (delay === null) return;
    // A send already due sooner stands; one due later (the time shown alone) gives way.
    const due = now() + delay;
    if (flushTimer !== null && flushDue <= due) return;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushDue = due;
    flushTimer = setTimeout(() => { flushTimer = null; flush(false); schedule(); }, delay);
  }

  /** Send what is waiting. `last`: the page view is ending, and what was read without a
   *  verdict it can count is counted as unavailable. */
  function flush(last: boolean): void {
    if (last) {
      for (const unit of awaiting) {
        const key = cyrb53(unit.text);
        if (counted.has(key)) continue;
        counted.add(key);
        pending.skipped.push({ w: wordsOf(unit.wordCount), why: "unavailable" });
        readSomething = true;
      }
      awaiting.clear();
    }
    let dwell = 0;
    if (opts.ownsDwell && readSomething) {
      addShown(now());
      dwell = Math.min(STATS_MAX_DWELL_S, Math.floor(dwellMs / 1000));
      dwellMs -= dwell * 1000;
    }
    const { units, skipped } = pending;
    pending = { units: [], skipped: [] };
    if (units.length === 0 && skipped.length === 0 && dwell === 0) return;
    let kind: PageKind = "other";
    try { kind = opts.kind(); } catch { /* the page's markup is not ours to trust: "other" */ }
    for (let i = 0; i === 0 || i < Math.max(units.length, skipped.length); i += STATS_MAX_ENTRIES) {
      const message = {
        action: ACTIONS.STATS_RECORD,
        kind,
        dwell: i === 0 ? dwell : 0,
        units: units.slice(i, i + STATS_MAX_ENTRIES),
        skipped: skipped.slice(i, i + STATS_MAX_ENTRIES),
      };
      // Nothing is asked again: a worker that was restarting, or a page whose access was
      // taken back, loses a few seconds of reading, which is less than a retry would cost.
      void opts.send(message).catch(() => undefined);
    }
  }

  function drop(): void {
    io?.disconnect();
    watched.clear();
    shownNow.clear();
    awaiting.clear();
    if (tick !== null) { clearTimeout(tick); tick = null; }
    if (on) io = new IntersectionObserver(onEntries, { rootMargin: ROOT_MARGIN, threshold: 0 });
  }

  function start(units: Iterable<Unit>): void {
    if (on) return;
    on = true;
    io = new IntersectionObserver(onEntries, { rootMargin: ROOT_MARGIN, threshold: 0 });
    const at = now();
    shownSince = hidden() ? null : at;
    lastActivity = at;
    document.addEventListener("visibilitychange", onVisibility);
    // Capture, so this runs before the document's session lets go of its port on the same
    // event (lib/access/session.ts): the last message still goes out on it.
    window.addEventListener("pagehide", onPageHide, { capture: true });
    for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, onActivity, { capture: true, passive: true });
    for (const unit of units) track(unit);
  }

  function stop(send = true): void {
    if (!on) return;
    if (send) flush(true);
    on = false;
    drop();
    io = null;
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide, { capture: true });
    for (const type of ["pointerdown", "keydown"]) window.removeEventListener(type, onActivity, { capture: true });
    pending = { units: [], skipped: [] };
    counted.clear();
    dwellMs = 0;
    shownSince = null;
    readSomething = false;
  }

  return {
    running: () => on,
    start,
    stop,
    track,
    trackShort,
    verdict(unit, result) {
      if (on && awaiting.has(unit)) count(unit, result);
    },
    forget(unit) {
      awaiting.delete(unit);
      const el = unit.topElement;
      const w = watched.get(el);
      if (!w) return;
      w.units.delete(unit);
      if (w.units.size === 0 && !w.short) {
        io?.unobserve(el);
        watched.delete(el);
        shownNow.delete(el);
      }
    },
    drop,
    newView(units) {
      if (!on) return;
      flush(false);
      counted.clear();
      readSomething = false;
      dwellMs = 0;
      shownSince = hidden() ? null : now();
      const waiting = [...awaiting];
      drop();
      for (const unit of waiting) awaiting.add(unit);
      for (const unit of units) track(unit);
    },
  };
}
