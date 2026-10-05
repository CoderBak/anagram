// lib/stats/recorder.ts — the page's half of the reading log: what of a page was on screen and
// for how long, by every rule a lens can ask for, and how the person moved through it, at the
// layers the reader chose (lib/stats/config.ts). The worker keeps it (lib/stats/worker.ts).
//
// Its own chunk (scripts/vendor.mjs, stats.min.mjs), which the content script imports only
// while statistics are on, outside a private window; the PDF reader bundles it. It touches no
// extension API: the content script hands it a `send` and everything else it needs.
//
// WHAT IT COSTS A PAGE. Nothing per scroll event beyond a comparison, except what the scroll
// and input layers ask for (a sample a frame at most); two IntersectionObservers tell it when
// a paragraph crosses a step of how much of it is on screen or into or out of the middle band,
// and a timer runs once a second while a paragraph is on screen. What it learns waits in plain
// arrays and goes to the worker every few seconds, and once more as the page goes.
//
// WHAT COUNTS AS READ, BY DEFAULT (lib/stats/lens.ts DEFAULT_LENS): a second in all with some
// of the paragraph in the middle 80% of the viewport, while the page was shown and not flung
// past. That is what the totals and the toolbar menu count, once per visit. Every other rule
// can be applied afterwards to what is kept here: each paragraph's time by how much of it was
// on screen, in a focused window or not, flung past or not.
import type { ScoreResult } from "../contract";
import type { Unit } from "../types";
import { cyrb53 } from "../hash";
import { countWords, unitParagraphs } from "../dom/text";
import { rank, type Layers } from "./config";
import {
  INPUT_KINDS, STATE_KINDS, UI_EVENTS, type EventStreams, type Exposure, type InputKind, type KindSignals, type PageKind,
  type SkipReason, type StateKind, type Surface, type UiEvent, type UnitKind, type UnitStatus, type VisitRow,
} from "./model";
import type { WireUnit, WireVisit, StatsWire } from "./wire";

/** The default rule's band, threshold and idle cut-off (lib/stats/lens.ts DEFAULT_LENS). */
const READ_MS = 1000;
const BAND_MARGIN = "-10% 0px -10% 0px";
const IDLE_MS = 120_000;
const TICK_MS = 1000;
/** How soon what was learned is sent; and how often the time a page is shown is sent, when
 *  nothing else is. */
const FLUSH_MS = 5000;
const HEARTBEAT_MS = 60_000;
/** A visit is sent once it has been shown this long, or something on it was read: a tab
 *  opened behind another and never looked at is no visit. */
const SHOWN_TO_SEND_MS = 1000;
/** At most this many paragraphs, and this many entries of a stream, in one message. */
const MOST_UNITS = 200;
const MOST_EVENTS = 4000;
/** And this much text: the rest goes in the next one. */
const MOST_TEXT = 400_000;
/** A paragraph that moved less than this on the page has not moved. */
const MOVED_PX = 20;
/** One scroll episode ends after this long without scrolling. */
const EPISODE_GAP_MS = 300;
const TENTHS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export interface RecorderHost {
  layers: Layers;
  surface: Surface;
  frame: "top" | "frame";
  /** The top frame and the PDF reader say how long the page was shown; a frame does not. */
  ownsDwell: boolean;
  fling: { delay(): number };
  verdictOf(unit: Unit): ScoreResult | undefined;
  /** Whether a short stretch (by its first node) is still one the walk left unread. */
  stillShort(first: Text): boolean;
  kind(): { kind: PageKind; signals: KindSignals | null };
  display(): { chips: string; underlines: string; flagFrom: string };
  flagged(result: ScoreResult): boolean;
  /** Paragraphs and words the reader holds of the page now, read or not. */
  found(): { units: number; words: number };
  pdf?(): VisitRow["pdf"];
  send(message: StatsWire): Promise<unknown>;
  /** Post a message now, on the document's session port (lib/access/session.ts
   *  postDocumentMessage), and tell whether it went: a visit's last messages, which the page
   *  sends as it goes, must reach the worker before the port's close does. */
  post?(message: StatsWire): boolean;
  now?(): number;
  clock?(): number;
}

export interface Recorder {
  running(): boolean;
  start(units: Iterable<Unit>): void;
  /** Stop. `send` (the default) sends what was learned first and ends the visit; false drops
   *  it (the reader turned statistics off). */
  stop(send?: boolean, ended?: WireVisit["ended"]): void;
  track(unit: Unit): void;
  trackShort(nodes: Text[]): void;
  verdict(unit: Unit, result: ScoreResult): void;
  forget(unit: Unit): void;
  /** Every unit is about to be replaced (a rescan): let them all go; what counted stays. */
  drop(): void;
  /** Another visit begins in the same document (a route change). */
  newView(units: Iterable<Unit>): void;
  /** The document is going: the visit's last message, now (its session's port is still up). */
  leave(): void;
  ui(kind: UiEvent, unit?: Unit): void;
}

interface Tracked {
  n: number;
  key: number;
  units: Set<Unit>;
  short: Text[] | null;
  el: Element | null;
  text: string;
  words: number;
  status: UnitStatus;
  result?: ScoreResult;
  any: boolean;
  half: boolean;
  band: boolean;
  since: number | null;
  expo: { any: Exposure; half: Exposure; band: Exposure; first?: number; last?: number; sightings: number; readAt?: number };
  counted: boolean;
  dirty: boolean;
  sentText: boolean;
  found: number;
  removedAt?: number;
  answered?: number;
  geom?: { x: number; y: number; w: number; h: number; page?: number; share?: number };
  docTop?: number;
  lines?: number;
  struct?: WireUnit["struct"];
}

const newExposure = (): Exposure => [0, 0, 0, 0];

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The writing system most of a text's letters are in. */
function scriptOf(text: string): string {
  const sample = text.slice(0, 400);
  const scripts: [string, RegExp][] = [["Latin", /\p{Script=Latin}/gu], ["Han", /\p{Script=Han}/gu], ["Cyrillic", /\p{Script=Cyrillic}/gu],
    ["Arabic", /\p{Script=Arabic}/gu], ["Hangul", /\p{Script=Hangul}/gu], ["Kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
    ["Devanagari", /\p{Script=Devanagari}/gu], ["Greek", /\p{Script=Greek}/gu], ["Hebrew", /\p{Script=Hebrew}/gu], ["Thai", /\p{Script=Thai}/gu]];
  let best = "Other", most = 0;
  for (const [name, re] of scripts) {
    const n = sample.match(re)?.length ?? 0;
    if (n > most) { most = n; best = name; }
  }
  return best;
}

const sentencesOf = (text: string): number => Math.max(1, (text.match(/[.!?。！？]+(?=\s|$)/g) ?? []).length);

/** A post of a feed or a thread, where the markup marks one (as lib/stats/pageKind.ts). */
const POST = 'article, [role="article"], [aria-posinset], [role="listitem"]:not(li)';
const LANDMARK = "main, [role=main], article, aside, [role=complementary], nav, [role=navigation], header, footer, dialog, [role=dialog]";

const READ_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

export function createRecorder(host: RecorderHost): Recorder {
  const L = host.layers;
  const now = host.now ?? (() => performance.now());
  const clock = host.clock ?? (() => Date.now());
  const atLeast = <D extends keyof Layers>(d: D, layer: Layers[D]): boolean => rank(d, L[d]) <= rank(d, layer);
  const rowsUnits = rank("rows", L.rows) <= rank("rows", "paragraph");
  const rowsEvents = L.rows === "event";
  const keepSteps = rowsEvents && L.expo === "steps";
  const keepIntervals = rowsEvents && atLeast("expo", "intervals");
  const keepState = rowsEvents && L.state === "changes";
  const keepUi = rowsEvents && L.ui === "events";
  const keepGeomChanges = rowsEvents && L.geom === "changes";
  const scrollLayer = L.scroll;
  const inputLayer = L.input;
  const sendText = rowsUnits && L.text !== "none";

  let on = false;
  let viewIO: IntersectionObserver | null = null;
  let bandIO: IntersectionObserver | null = null;
  const byEl = new Map<Element, Set<Tracked>>();
  const byUnit = new Map<Unit, Tracked>();
  const byKey = new Map<number, Tracked>();
  const onScreen = new Set<Tracked>();
  let nextN = 0;
  let tick: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flingTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // ---- the visit ------------------------------------------------------------------------
  let visit = newVisitState();
  function newVisitState() {
    return {
      id: randomId(), seq: 0, startClock: clock(), startNow: now(), href: location.href,
      referrer: document.referrer, restored: false, route: false,
      shown: 0, active: 0, focused: 0, dwellSent: 0, shownSince: null as number | null,
      lastActivity: now(), idleFrom: null as number | null, idle: [] as [number, number][],
      minutes: { pointer: [] as number[], key: [] as number[], wheel: [] as number[], touch: [] as number[] },
      ui: {} as Partial<Record<UiEvent, number>>,
      scroll: { depth: 0, distance: 0 },
      reads: [] as NonNullable<StatsWire["reads"]>,
      streams: emptyStreams(),
      sent: false, ended: undefined as WireVisit["ended"],
    };
  }
  const offset = (at: number): number => Math.round(at - visit.startNow);

  // Page-level states.
  let shown = document.visibilityState !== "hidden";
  let focused = document.hasFocus();
  let flinging = false;

  function emptyStreams(): Required<EventStreams> {
    return {
      steps: { t: [], unit: [], obs: [], ratio: [], top: [], h: [] },
      intervals: { unit: [], kind: [], start: [], end: [], peak: [] },
      scroll: { t: [], box: [], x: [], y: [], vw: [], vh: [], ph: [] },
      episodes: { start: [], end: [], distance: [], peak: [] },
      input: { t: [], kind: [], x: [], y: [], n: [] },
      state: { t: [], kind: [] },
      ui: { t: [], kind: [], unit: [] },
      geom: { t: [], unit: [], x: [], y: [], w: [], h: [] },
    };
  }
  /** Open intervals, by paragraph and kind (0 on screen, 1 in the band): start and peak share. */
  const openIntervals = new Map<string, { start: number; peak: number }>();

  function noteState(kind: StateKind): void {
    if (!keepState) return;
    visit.streams.state.t.push(offset(now()));
    visit.streams.state.kind.push(STATE_KINDS.indexOf(kind));
  }

  // ---- time --------------------------------------------------------------------------------

  /** Add what each paragraph on screen has had since it was last looked at, under the page's
   *  states until now; then whether it has been read. */
  function settle(t: Tracked, at: number): void {
    if (t.since === null) return;
    const dt = at - t.since;
    t.since = at;
    if (!(dt > 0) || !shown) return;
    const add = (e: Exposure): void => {
      e[0] += dt;
      if (focused) e[1] += dt;
      if (flinging) e[2] += dt;
      if (focused && flinging) e[3] += dt;
    };
    if (t.any) add(t.expo.any);
    if (t.half) add(t.expo.half);
    if (t.band) add(t.expo.band);
    t.expo.last = offset(at);
    t.dirty = true;
    if (rowsUnits) schedule();
    if (t.expo.readAt === undefined && t.expo.band[0] - t.expo.band[2] >= READ_MS) {
      t.expo.readAt = offset(at);
      count(t);
    }
  }
  function settleAll(at = now()): void {
    for (const t of onScreen) settle(t, at);
  }

  /** The page's time: shown, shown and active, shown in a focused window. */
  let pageSince = now();
  function settlePage(at = now()): void {
    const dt = at - pageSince;
    pageSince = at;
    if (!(dt > 0) || !shown) return;
    visit.shown += dt;
    if (focused) visit.focused += dt;
    const activeUntil = Math.min(at, visit.lastActivity + IDLE_MS);
    const from = at - dt;
    if (activeUntil > from) visit.active += activeUntil - from;
  }

  /** A page state changes: everything is added up under the old one first. */
  function changeState(update: () => void): void {
    const at = now();
    settleAll(at);
    settlePage(at);
    update();
    armTick();
  }

  function activity(): void {
    const at = now();
    if (visit.idleFrom !== null) {
      visit.idle.push([offset(visit.idleFrom), offset(at)]);
      visit.idleFrom = null;
    } else if (at - visit.lastActivity > IDLE_MS && shown) {
      visit.idle.push([offset(visit.lastActivity + IDLE_MS), offset(at)]);
    }
    settlePage(at);
    visit.lastActivity = at;
  }

  // ---- reading and counting ----------------------------------------------------------------

  function outcomeOf(t: Tracked): { status: UnitStatus; why: SkipReason | null } {
    if (t.short) return { status: "short", why: "short" };
    const r = t.result;
    if (!r || r.degraded) return { status: "pending", why: null };
    if (r.unsupported) return { status: "language", why: "language" };
    return { status: "scored", why: null };
  }

  /** A paragraph read, counted for the totals once its verdict can be (or that it has none). */
  function count(t: Tracked): void {
    if (t.counted || t.expo.readAt === undefined) return;
    const { status, why } = outcomeOf(t);
    if (status === "pending") return;
    t.status = status;
    t.counted = true;
    t.dirty = true;
    visit.reads.push(why ? { n: t.n, w: t.words, why } : { n: t.n, w: t.words, p: t.result!.probs.slice(0, 4) });
    schedule();
  }

  // ---- observing ---------------------------------------------------------------------------

  function observe(t: Tracked, el: Element): void {
    t.el = el;
    let set = byEl.get(el);
    if (!set) {
      set = new Set();
      byEl.set(el, set);
      viewIO?.observe(el);
      bandIO?.observe(el);
    }
    set.add(t);
  }

  function unobserve(t: Tracked): void {
    const el = t.el;
    if (!el) return;
    const set = byEl.get(el);
    set?.delete(t);
    if (set && set.size === 0) {
      byEl.delete(el);
      viewIO?.unobserve(el);
      bandIO?.unobserve(el);
    }
    t.el = null;
  }

  function onView(entries: IntersectionObserverEntry[]): void {
    const at = now();
    for (const entry of entries) {
      const set = byEl.get(entry.target);
      if (!set) continue;
      const rect = entry.boundingClientRect;
      const vh = entry.rootBounds?.height ?? window.innerHeight;
      const any = entry.isIntersecting;
      // Half of it, or, for a paragraph taller than the screen, any of it.
      const half = any && (entry.intersectionRatio >= 0.5 || rect.height > vh);
      for (const t of set) {
        settle(t, at);
        if (any && !t.any) { t.expo.sightings++; t.expo.first ??= offset(at); }
        t.any = any;
        t.half = half;
        track1(t, any || t.band, at);
        if (keepSteps) push(visit.streams.steps, { t: offset(at), unit: t.n, obs: 0, ratio: round3(entry.intersectionRatio), top: Math.round(rect.top), h: Math.round(rect.height) });
        if (keepIntervals) interval(t, 0, any, entry.intersectionRatio, at);
        geometry(t, rect, at);
      }
    }
    armTick();
  }

  function onBand(entries: IntersectionObserverEntry[]): void {
    const at = now();
    for (const entry of entries) {
      const set = byEl.get(entry.target);
      if (!set) continue;
      for (const t of set) {
        settle(t, at);
        t.band = entry.isIntersecting;
        track1(t, t.any || t.band, at);
        if (keepSteps) push(visit.streams.steps, { t: offset(at), unit: t.n, obs: 1, ratio: round3(entry.intersectionRatio), top: Math.round(entry.boundingClientRect.top), h: Math.round(entry.boundingClientRect.height) });
        if (keepIntervals) interval(t, 1, entry.isIntersecting, entry.intersectionRatio, at);
      }
      // A paragraph crossing into the band is somebody reading on.
      if (entry.isIntersecting) activity();
    }
    armTick();
  }

  function track1(t: Tracked, onIt: boolean, at: number): void {
    if (onIt) { onScreen.add(t); t.since ??= at; }
    else { onScreen.delete(t); t.since = null; }
  }

  function interval(t: Tracked, kind: 0 | 1, isIn: boolean, ratio: number, at: number): void {
    const key = `${t.n}:${kind}`;
    const open = openIntervals.get(key);
    if (isIn) {
      if (open) open.peak = Math.max(open.peak, ratio);
      else openIntervals.set(key, { start: offset(at), peak: ratio });
    } else if (open) {
      openIntervals.delete(key);
      push(visit.streams.intervals, { unit: t.n, kind, start: open.start, end: offset(at), peak: round3(open.peak) });
    }
  }
  function closeIntervals(at: number): void {
    for (const [key, open] of openIntervals) {
      const [n, kind] = key.split(":").map(Number) as [number, number];
      push(visit.streams.intervals, { unit: n, kind, start: open.start, end: offset(at), peak: round3(open.peak) });
    }
    openIntervals.clear();
  }

  /** Where the paragraph is on the page: when first seen, and where the layout has moved it. */
  function geometry(t: Tracked, rect: DOMRectReadOnly, at: number): void {
    if (L.geom === "none") return;
    const top = rect.top + window.scrollY;
    if (t.geom === undefined) {
      const height = document.documentElement.scrollHeight || 1;
      t.geom = { x: Math.round(rect.left + window.scrollX), y: Math.round(top), w: Math.round(rect.width), h: Math.round(rect.height), share: round3(top / height) };
      t.docTop = top;
      t.dirty = true;
      if (L.len === "all" && t.el) {
        const lh = parseFloat(getComputedStyle(t.el).lineHeight);
        if (lh > 0) t.lines = Math.max(1, Math.round(rect.height / lh));
      }
    } else if (keepGeomChanges && Math.abs(top - (t.docTop ?? top)) > MOVED_PX) {
      t.docTop = top;
      push(visit.streams.geom, { t: offset(at), unit: t.n, x: Math.round(rect.left + window.scrollX), y: Math.round(top), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  }

  function armTick(): void {
    if (tick !== null || !on || onScreen.size === 0 || !shown) return;
    tick = setTimeout(() => { tick = null; settleAll(); settlePage(); armTick(); }, TICK_MS);
  }

  // ---- what a paragraph is ------------------------------------------------------------------

  function structOf(unit: Unit | null, el: Element): WireUnit["struct"] {
    if (!atLeast("struct", "unit")) return undefined;
    const post = el.closest(POST);
    const kind: UnitKind = !unit ? "paragraph" : unit.textFixed ? (host.surface === "pdf" ? "pdf" : "surface")
      : host.surface === "docs" ? "docs" : unit.parts.length > 1 ? "joined" : post ? "post" : "paragraph";
    const out: NonNullable<WireUnit["struct"]> = { unit: kind, order: unit?.order, post: post ? postIndex(post) : undefined, paragraphs: unit ? unitParagraphs(unit) : 1 };
    if (L.struct === "full") {
      out.tag = el.tagName.toLowerCase();
      out.role = el.getAttribute("role") ?? undefined;
      const landmark = el.closest(LANDMARK);
      out.landmark = landmark ? landmark.getAttribute("role") ?? landmark.tagName.toLowerCase() : undefined;
      out.quoted = el.closest("blockquote, .gmail_quote, [type=cite]") !== null;
      let depth = 0;
      for (let p: Element | null = post; p; p = p.parentElement?.closest(POST) ?? null) depth++;
      out.depth = depth;
    }
    return out;
  }
  let posts = new WeakMap<Element, number>();
  let nextPost = 0;
  function postIndex(el: Element): number {
    let n = posts.get(el);
    if (n === undefined) { n = nextPost++; posts.set(el, n); }
    return n;
  }

  function adopt(key: number, text: string, words: number, unit: Unit | null, short: Text[] | null, el: Element): Tracked {
    let t = byKey.get(key);
    if (t) {
      // The same text again in this visit — a re-render, or the PDF reader drawing a page
      // again: the same paragraph, read once.
      if (t.removedAt !== undefined) { t.removedAt = undefined; t.dirty = true; }
      if (unit) t.units.add(unit);
      if (t.el !== el) { unobserve(t); observe(t, el); }
      return t;
    }
    t = {
      n: nextN++, key, units: new Set(unit ? [unit] : []), short, el: null, text, words, status: short ? "short" : "pending",
      any: false, half: false, band: false, since: null,
      expo: { any: newExposure(), half: newExposure(), band: newExposure(), sightings: 0 },
      counted: false, dirty: true, sentText: false, found: offset(now()),
      struct: structOf(unit, el),
    };
    if (unit?.page !== undefined) t.geom = { x: 0, y: 0, w: 0, h: 0, page: unit.page };
    byKey.set(key, t);
    observe(t, el);
    return t;
  }

  function track(unit: Unit): void {
    if (!on || !unit.topElement.isConnected || byUnit.has(unit)) return;
    const t = adopt(cyrb53(unit.text), unit.text, unit.wordCount, unit, null, unit.topElement);
    byUnit.set(unit, t);
    const r = host.verdictOf(unit);
    if (r) verdict(unit, r);
  }

  function trackShort(nodes: Text[]): void {
    const el = nodes[0]?.parentElement;
    if (!on || !el || !el.isConnected) return;
    const text = nodes.filter((n) => n.isConnected).map((n) => n.data).join(" ").trim();
    const words = countWords(text);
    if (words === 0) return;
    adopt(cyrb53(text), text, words, null, nodes, el);
  }

  function verdict(unit: Unit, result: ScoreResult): void {
    const t = byUnit.get(unit);
    if (!on || !t || result.degraded) return;
    t.result = result;
    t.answered ??= offset(now());
    t.dirty = true;
    count(t);
  }

  function forget(unit: Unit): void {
    const t = byUnit.get(unit);
    byUnit.delete(unit);
    if (!t) return;
    t.units.delete(unit);
    if (t.units.size > 0) return;
    settle(t, now());
    onScreen.delete(t);
    t.since = null;
    unobserve(t);
    t.removedAt = offset(now());
    t.dirty = true;
    // Read, and taken off the page before its verdict came: counted as removed.
    if (!t.counted && t.expo.readAt !== undefined && outcomeOf(t).status === "pending") {
      t.status = "removed";
      t.counted = true;
      visit.reads.push({ n: t.n, w: t.words, why: "removed" });
    }
  }

  // ---- scrolling and input -------------------------------------------------------------------

  let boxes = new WeakMap<object, number>();
  let nextBox = 1;
  let lastSample = 0;
  let episode: { start: number; last: number; distance: number; peak: number; at: number; y: number } | null = null;
  const lastY = new WeakMap<object, number>();
  let episodeTimer: ReturnType<typeof setTimeout> | null = null;

  function onScroll(event: Event): void {
    const at = now();
    const target = event.target === document ? document.scrollingElement : event.target;
    if (!target || typeof (target as Element).scrollTop !== "number") return;
    const el = target as Element;
    const page = el === document.scrollingElement;
    const y = el.scrollTop, x = el.scrollLeft;
    const before = lastY.get(el);
    lastY.set(el, y);
    if (before !== undefined) visit.scroll.distance += Math.abs(y - before);
    if (page) visit.scroll.depth = Math.max(visit.scroll.depth, round3((y + window.innerHeight) / Math.max(1, el.scrollHeight)));
    activity();
    // Flung past, or settled: a page state.
    const fling = host.fling.delay() > 0;
    if (fling !== flinging) { changeState(() => { flinging = fling; }); noteState(fling ? "fling" : "settled"); }
    if (fling) armFling();
    if (!rowsEvents) return;
    if (scrollLayer === "episodes" || rank("scroll", scrollLayer) <= rank("scroll", "episodes")) {
      const speed = before !== undefined && episode ? Math.abs(y - before) / Math.max(1, at - episode.at) * 1000 : 0;
      if (!episode) episode = { start: offset(at), last: offset(at), distance: 0, peak: 0, at, y };
      else { episode.distance += before !== undefined ? Math.abs(y - before) : 0; episode.peak = Math.max(episode.peak, speed); episode.last = offset(at); episode.at = at; }
      if (episodeTimer !== null) clearTimeout(episodeTimer);
      episodeTimer = setTimeout(endEpisode, EPISODE_GAP_MS);
    }
    const every = scrollLayer === "frames" ? 0 : scrollLayer === "tenth" ? 100 : scrollLayer === "second" ? 1000 : null;
    if (every === null || at - lastSample < every) return;
    lastSample = at;
    schedule();
    let box = 0;
    if (!page) { box = boxes.get(el) ?? 0; if (!box) { box = nextBox++; boxes.set(el, box); } }
    push(visit.streams.scroll, { t: offset(at), box, x: Math.round(x), y: Math.round(y), vw: window.innerWidth, vh: window.innerHeight, ph: page ? el.scrollHeight : el.clientHeight });
  }
  function endEpisode(): void {
    episodeTimer = null;
    if (!episode) return;
    push(visit.streams.episodes, { start: episode.start, end: episode.last, distance: Math.round(episode.distance), peak: Math.round(episode.peak) });
    episode = null;
  }
  function armFling(): void {
    if (flingTimer !== null) clearTimeout(flingTimer);
    flingTimer = setTimeout(() => {
      flingTimer = null;
      if (host.fling.delay() > 0) { armFling(); return; }
      if (flinging) { changeState(() => { flinging = false; }); noteState("settled"); }
    }, host.fling.delay() + 20);
  }

  let lastMove = 0;
  let lastField = 0;
  function noteInput(kind: InputKind, e?: { clientX?: number; clientY?: number }, n?: number): void {
    const at = now();
    if (inputLayer === "minutes") {
      const minute = Math.floor(offset(at) / 60_000);
      const list = kind.startsWith("pointer") ? visit.minutes.pointer : kind === "wheel" ? visit.minutes.wheel
        : kind.startsWith("touch") ? visit.minutes.touch : kind.endsWith("key") || kind === "shortcut" ? visit.minutes.key : null;
      if (list) { while (list.length <= minute) list.push(0); list[minute]!++; }
    }
    if (!rowsEvents || !atLeast("input", "events")) return;
    schedule();
    const s = visit.streams.input as Required<NonNullable<EventStreams["input"]>>;
    s.t.push(offset(at)); s.kind.push(INPUT_KINDS.indexOf(kind));
    const positions = atLeast("input", "positions") && e?.clientX !== undefined;
    s.x.push(positions ? Math.round(e!.clientX!) : -1); s.y.push(positions ? Math.round(e!.clientY!) : -1);
    s.n.push(n ?? -1);
  }
  const onPointer = (e: PointerEvent): void => { activity(); noteInput(e.type === "pointerdown" ? "pointerdown" : "pointerup", e); };
  const onWheel = (): void => { activity(); noteInput("wheel"); };
  const onTouch = (e: TouchEvent): void => { activity(); const p = e.changedTouches[0]; noteInput(e.type === "touchstart" ? "touchstart" : "touchend", p); };
  const onKey = (e: KeyboardEvent): void => {
    activity();
    const field = e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])") !== null;
    noteInput(e.ctrlKey || e.metaKey || e.altKey ? "shortcut" : READ_KEYS.has(e.key) && !field ? "readkey" : "typekey");
  };
  const onMove = (e: PointerEvent): void => {
    const at = now();
    if (at - lastMove < 100) return;
    lastMove = at;
    noteInput("move", e);
  };
  const onCopy = (): void => noteInput("copy", undefined, document.getSelection()?.toString().length ?? 0);
  const onSelectEnd = (): void => {
    const length = document.getSelection()?.toString().length ?? 0;
    if (length > 0) noteInput("select", undefined, length);
  };
  const onField = (): void => {
    const at = now();
    if (at - lastField < 2000) return;
    lastField = at;
    activity();
    noteInput("field");
  };
  const onPrint = (): void => noteInput("print");
  const onFullscreen = (): void => noteInput("fullscreen");

  // ---- page states ----------------------------------------------------------------------------

  function onVisibility(): void {
    const isShown = document.visibilityState !== "hidden";
    if (isShown === shown) return;
    changeState(() => { shown = isShown; });
    noteState(isShown ? "shown" : "hidden");
    if (isShown) { visit.lastActivity = now(); for (const t of onScreen) t.since = now(); armTick(); schedule(); }
    else flush(false);
  }
  const onFocus = (): void => { if (!focused) { changeState(() => { focused = true; }); noteState("focus"); } };
  const onBlur = (): void => { if (focused) { changeState(() => { focused = false; }); noteState("blur"); } };
  const onFreeze = (): void => { noteState("frozen"); flush(false); };
  const onResume = (): void => noteState("resumed");
  const onPageShow = (e: PageTransitionEvent): void => { if (e.persisted) { visit.restored = true; noteState("restored"); } };
  let left = false;
  const onPageHide = (): void => { if (!left) flush(true, "navigated"); left = true; };

  // ---- sending ---------------------------------------------------------------------------------

  function schedule(): void {
    if (!on || flushTimer !== null) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(false); }, FLUSH_MS);
  }

  function snapshotUnit(t: Tracked): WireUnit {
    const r = t.result;
    const out: WireUnit = { n: t.n, status: t.status, found: t.found, len: { words: t.words } };
    if (sendText && !t.sentText) out.text = t.text.slice(0, 200_000);
    if (L.len !== "none") {
      out.len = {
        words: t.words, chars: t.text.length, sentences: sentencesOf(t.text), lines: t.lines,
        formulas: [...t.units][0]?.formulas, pieces: [...t.units][0] && [...t.units][0]!.parts.length > 1 ? [...t.units][0]!.parts.map((p) => countWords(p.nodes.map((n) => n.data).join(" "))) : undefined,
        tokens: r?.tokens, windows: undefined,
      };
    }
    if (r && !r.degraded) {
      out.verdict = {
        p: r.unsupported ? undefined : r.probs.slice(0, 4), score: r.unsupported ? undefined : r.score,
        flagged: r.unsupported ? undefined : host.flagged(r), truncated: r.truncated,
      };
      out.lang = { label: r.lang, prob: r.lang_prob, script: scriptOf(t.text) };
      out.timing = { cached: r.cached === true, answered: t.answered };
    } else if (t.short) out.lang = { script: scriptOf(t.text) };
    if (t.struct) out.struct = t.struct;
    if (t.geom) out.geom = t.geom;
    const ms = (e: Exposure): Exposure => e.map(Math.round) as Exposure;
    out.expo = { any: ms(t.expo.any), half: ms(t.expo.half), band: ms(t.expo.band), sightings: t.expo.sightings, first: t.expo.first, last: t.expo.last, readAt: t.expo.readAt };
    if (t.removedAt !== undefined) out.removedAt = t.removedAt;
    return out;
  }

  function snapshotVisit(final: boolean): WireVisit {
    const { kind, signals } = safeKind();
    const out: WireVisit = {
      id: visit.id, start: visit.startClock, frame: host.frame, surface: host.surface, kind, href: visit.href,
      shown: Math.round(visit.shown), active: Math.round(visit.active), focused: Math.round(visit.focused),
    };
    if (signals && L.struct === "full") out.signals = signals;
    if (visit.referrer && L.nav === "full") out.referrer = visit.referrer;
    if (visit.restored) out.restored = true;
    if (visit.route) out.route = true;
    if (L.geom !== "none") { out.height = document.documentElement.scrollHeight; out.width = document.documentElement.scrollWidth; }
    if (L.cover === "visit") out.found = host.found();
    out.display = host.display();
    if (L.scroll !== "none") out.scroll = { ...visit.scroll };
    if (L.input !== "none") out.idle = [...visit.idle];
    if (L.input === "minutes") out.minutes = visit.minutes;
    if (L.ui !== "none" && Object.keys(visit.ui).length > 0) out.ui = { ...visit.ui };
    const pdf = host.pdf?.();
    if (pdf) out.pdf = pdf;
    if (final) { out.end = clock(); out.ended = visit.ended ?? "navigated"; }
    return out;
  }
  function safeKind(): { kind: PageKind; signals: KindSignals | null } {
    try { return host.kind(); } catch { return { kind: "other", signals: null }; }
  }

  /** Send what is waiting. `final`: the visit ends, and what was read without a verdict it can
   *  count is counted as unavailable. */
  function flush(final: boolean, ended?: WireVisit["ended"]): void {
    if (!on) return;
    const at = now();
    settleAll(at);
    settlePage(at);
    if (final) {
      visit.ended ??= ended;
      if (visit.idleFrom === null && at - visit.lastActivity > IDLE_MS) visit.idle.push([offset(visit.lastActivity + IDLE_MS), offset(at)]);
      for (const t of byKey.values()) {
        if (!t.counted && t.expo.readAt !== undefined) {
          t.status = "unavailable"; t.counted = true; t.dirty = true;
          visit.reads.push({ n: t.n, w: t.words, why: "unavailable" });
        }
      }
      if (keepIntervals) closeIntervals(at);
      if (episodeTimer !== null) { clearTimeout(episodeTimer); endEpisode(); }
    }
    const anythingRead = visit.reads.length > 0 || [...byKey.values()].some((t) => t.counted);
    if (!visit.sent && visit.shown < SHOWN_TO_SEND_MS && !anythingRead) return;
    const dirty = rowsUnits ? [...byKey.values()].filter((t) => t.dirty) : [];
    const reads = visit.reads;
    visit.reads = [];
    const streams = rowsEvents ? visit.streams : null;
    if (rowsEvents) visit.streams = emptyStreams();
    const base = snapshotVisit(final);
    if (host.ownsDwell) { base.dwell = Math.max(0, Math.round(visit.shown - visit.dwellSent)); visit.dwellSent = visit.shown; }
    // Split what is waiting into messages the worker takes.
    let units: WireUnit[] = [];
    let textSize = 0;
    const out: StatsWire[] = [];
    const send = (last: boolean): void => {
      out.push({ visit: base, seq: visit.seq++, ...(units.length ? { units } : {}), ...(last && reads.length ? { reads } : {}),
        ...(last && streams ? { events: trimmed(streams) } : {}) });
      units = []; textSize = 0;
    };
    for (const t of dirty) {
      const u = snapshotUnit(t);
      const size = u.text?.length ?? 0;
      if (units.length >= MOST_UNITS || (textSize + size > MOST_TEXT && units.length > 0)) send(false);
      units.push(u); textSize += size;
      t.dirty = false;
      if (u.text !== undefined) t.sentText = true;
    }
    send(true);
    visit.sent = true;
    for (const message of out) {
      if (final && host.post?.(message)) continue;
      void host.send(message).catch(() => undefined);
    }
  }

  /** Each stream at most MOST_EVENTS long: the rest of a burst is dropped, not sent late. */
  function trimmed(s: Required<EventStreams>): EventStreams {
    const out: EventStreams = {};
    for (const [name, stream] of Object.entries(s) as [keyof EventStreams, Record<string, number[]>][]) {
      const length = Object.values(stream)[0]?.length ?? 0;
      if (length === 0) continue;
      (out as Record<string, unknown>)[name] = Object.fromEntries(Object.entries(stream).map(([k, v]) => [k, v.slice(0, MOST_EVENTS)]));
    }
    return out;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  const listeners: [EventTarget, string, EventListener, AddEventListenerOptions][] = [];
  function listen(target: EventTarget, type: string, fn: EventListener, opts: AddEventListenerOptions = { capture: true, passive: true }): void {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function observers(): void {
    viewIO = new IntersectionObserver(onView, { threshold: keepSteps ? TENTHS : [0, 0.5] });
    bandIO = new IntersectionObserver(onBand, { rootMargin: BAND_MARGIN, threshold: 0 });
  }

  function start(units: Iterable<Unit>): void {
    if (on) return;
    on = true;
    observers();
    shown = document.visibilityState !== "hidden";
    focused = document.hasFocus();
    pageSince = now();
    visit.lastActivity = now();
    listen(document, "visibilitychange", onVisibility as EventListener);
    listen(window, "focus", onFocus as EventListener);
    listen(window, "blur", onBlur as EventListener);
    listen(document, "freeze", onFreeze as EventListener);
    listen(document, "resume", onResume as EventListener);
    listen(window, "pageshow", onPageShow as EventListener);
    // Capture, so this runs before the document's session lets go of its port on the same
    // event (lib/access/session.ts): the last message still goes out on it.
    listen(window, "pagehide", onPageHide as EventListener, { capture: true });
    listen(document, "scroll", onScroll as EventListener);
    listen(window, "pointerdown", onPointer as EventListener);
    listen(window, "pointerup", onPointer as EventListener);
    listen(window, "wheel", onWheel as EventListener);
    listen(window, "touchstart", onTouch as EventListener);
    listen(window, "touchend", onTouch as EventListener);
    listen(window, "keydown", onKey as EventListener);
    if (rowsEvents && atLeast("input", "events")) {
      listen(document, "copy", onCopy as EventListener);
      listen(window, "mouseup", onSelectEnd as EventListener);
      listen(document, "input", onField as EventListener);
      listen(window, "beforeprint", onPrint as EventListener);
      listen(document, "fullscreenchange", onFullscreen as EventListener);
    }
    if (rowsEvents && L.input === "pointer") listen(window, "pointermove", onMove as EventListener);
    if (host.ownsDwell) heartbeat = setInterval(() => { if (shown) flush(false); }, HEARTBEAT_MS);
    for (const unit of units) track(unit);
  }

  function release(): void {
    viewIO?.disconnect(); bandIO?.disconnect();
    viewIO = bandIO = null;
    byEl.clear(); byUnit.clear(); byKey.clear(); onScreen.clear();
    openIntervals.clear();
    for (const timer of [tick, flushTimer, flingTimer, episodeTimer]) if (timer !== null) clearTimeout(timer);
    tick = flushTimer = flingTimer = episodeTimer = null;
    episode = null;
  }

  function stop(send = true, ended: WireVisit["ended"] = "stopped"): void {
    if (!on) return;
    if (send) flush(true, ended);
    on = false;
    release();
    if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; }
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
  }

  return {
    running: () => on,
    start,
    stop,
    track,
    trackShort,
    verdict,
    forget,
    drop() {
      // Every unit is about to be replaced: their paragraphs stay this visit's, and are
      // adopted again, by their text, when the rescan hands them back.
      if (!on) return;
      const at = now();
      settleAll(at);
      for (const t of byKey.values()) { unobserve(t); t.units.clear(); t.since = null; t.any = t.half = t.band = false; }
      byUnit.clear();
      onScreen.clear();
      viewIO?.disconnect(); bandIO?.disconnect();
      observers();
    },
    newView(units) {
      if (!on) return;
      flush(true, "route");
      release();
      visit = newVisitState();
      visit.route = true;
      visit.referrer = "";
      nextN = 0;
      posts = new WeakMap(); nextPost = 0; boxes = new WeakMap(); nextBox = 1;
      observers();
      pageSince = now();
      for (const unit of units) track(unit);
    },
    leave() { onPageHide(); },
    ui(kind, unit) {
      if (!on || L.ui === "none") return;
      visit.ui[kind] = (visit.ui[kind] ?? 0) + 1;
      if (keepUi) push(visit.streams.ui, { t: offset(now()), kind: UI_EVENTS.indexOf(kind), unit: unit ? byUnit.get(unit)?.n ?? -1 : -1 });
      schedule();
    },
  };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function push<S extends Record<string, number[]>>(stream: S, row: { [K in keyof S]: number }): void {
  for (const key of Object.keys(row) as (keyof S)[]) stream[key]!.push(row[key]);
}
