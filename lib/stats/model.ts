// lib/stats/model.ts — what the reading log is made of: its rows, and the tallies every view
// adds them up into. Shared by the page's recorder, the worker that keeps the log, and the
// pages that show and export it. Pure.
//
// The statistic is an EXPECTATION, not a count of verdicts. A paragraph the model calls 60%
// AI-generated and 40% heavily edited adds 0.6 of its words to one band and 0.4 to the other;
// added up over everything read, the shares are what the model expects the reading to have
// been made of. Counting each paragraph under one word instead would round every doubt the
// same way. Both counts are kept beside it — by the word the chip showed (`units`) and by the
// most likely band (`argmax`) — because that is what the reader saw, and because a researcher
// correcting for the classifier's error rates (Rogan–Gladen) needs one of them.
import { BUCKET_COUNT, type ModelInfo } from "../contract";
import { levelOf } from "../render/scale";

/** What sort of page the words were read on (lib/stats/pageKind.ts says how it is told). */
export const PAGE_KINDS = ["feed", "article", "forum", "document", "other"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Why words that were read have no verdict: under the minimum length; not in English; the
 *  engine could not read them by the time the visit ended; or the page took them away before
 *  their verdict came. */
export const SKIP_REASONS = ["short", "language", "unavailable", "removed"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What a paragraph of a visit came to. */
export const UNIT_STATUSES = ["scored", ...SKIP_REASONS, "pending"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

/** Where a visit's text came from: a web page walked, or a surface that reads a document. */
export const SURFACES = ["web", "pdf", "docs", "drive", "pdfjs", "kindle", "webnovel"] as const;
export type Surface = (typeof SURFACES)[number];

/** How a visit was arrived at: the browser's transition, or a route change within a page. */
export const ARRIVALS = ["link", "typed", "bookmark", "reload", "history", "form", "redirect", "generated", "restored", "route", "other"] as const;
export type Arrival = (typeof ARRIVALS)[number];

/** Text a walk leaves out, by why (lib/dom/walker.ts barriers and drops). */
/** How often a page's recorder speaks while its page is shown and nothing else is to be said:
 *  the worker takes a tab it has not heard from for a while longer than this as not covered
 *  (lib/stats/tabs.ts). */
export const HEARTBEAT_MS = 60_000;

/** Why the walk left text out (lib/dom/walker.ts CollectOptions.onLeftOut). */
export const LEFT_OUT = ["links", "symbols", "names", "code", "teaser", "chrome", "hidden"] as const;
export type LeftOut = (typeof LEFT_OUT)[number];

/** Totals in historical band order, with an additional AI-assisted slot for current readings. */
export type Bands = [number, number, number, number, ...number[]];
// Preserve historical EditLens slots. New AI-assisted readings occupy slot four.
const detectorSlots = [0,4,3] as const;

/** What was read of some stretch of reading, in words, and the paragraphs the words were in. */
export interface Tally {
  /** Words of the paragraphs read that the model scored. */
  scored: number;
  /** Words expected in each band: Σ words × the model's probability of that band. */
  expected: Bands;
  /** A recount includes scored paragraphs for which only verdict labels survived. */
  missingProbabilities?: true;
  /** Paragraphs under each word, the word the chip showed. */
  units: Bands;
  /** Paragraphs under each band, the model's most likely one. */
  argmax: Bands;
  /** Words read that were not scored, by why. */
  short: number;
  language: number;
  unavailable: number;
  removed: number;
}

export function emptyTally(): Tally {
  return { scored: 0, expected: [0, 0, 0, 0], units: [0, 0, 0, 0], argmax: [0, 0, 0, 0], short: 0, language: 0, unavailable: 0, removed: 0 };
}

/** Everything read, scored or not. */
export function viewedWords(t: Tally): number {
  return t.scored + t.short + t.language + t.unavailable + (t.removed ?? 0);
}

/** `into` plus `t`, in place. */
export function addTally(into: Tally, t: Tally): Tally {
  into.scored += t.scored;
  if (t.missingProbabilities) into.missingProbabilities = true;
  for (const why of SKIP_REASONS) into[why] = (into[why] ?? 0) + (t[why] ?? 0);
  into.argmax ??= [0, 0, 0, 0];
  for (let i = 0; i < Math.max(t.expected.length,t.units.length,t.argmax?.length ?? 0); i++) {
    into.expected[i] = (into.expected[i] ?? 0)+(t.expected[i] ?? 0);
    into.units[i] = (into.units[i] ?? 0)+(t.units[i] ?? 0);
    into.argmax[i] = (into.argmax[i] ?? 0)+(t.argmax?.[i] ?? 0);
  }
  return into;
}

/** The share of the scored words each band is expected to hold, or null with none scored. */
export function shares(t: Tally): Bands | null {
  if (!(t.scored > 0) || t.missingProbabilities) return null;
  return t.expected.map((w) => w / t.scored) as Bands;
}

/** The share expected to be AI-generated, the headline's number; null with nothing scored. */
export function aiShare(t: Tally): number | null {
  return shares(t)?.[3] ?? null;
}

/** The score a chip shows: Σ pᵢ·i / 3. */
export function scoreOf(probs: readonly number[]): number {
  let score = 0;
  for (let i = 0; i < probs.length; i++) score += (probs[i] ?? 0) * i;
  return score / (probs.length - 1);
}

/** The word a chip shows for these probabilities: the score's slice of the scale
 *  (lib/render/scale.ts), not the most likely bucket. */
export function bandOf(probs: readonly number[]): number {
  return probs.length===3 ? argmaxOf(probs) : levelOf(scoreOf(probs));
}

/** The most likely band; the lower one on a tie. */
export function argmaxOf(probs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < BUCKET_COUNT; i++) if ((probs[i] ?? 0) > (probs[best] ?? 0)) best = i;
  return probs.length===3 ? detectorSlots[best]! : best;
}

/** One paragraph read, as a tally: its words in its verdict's bands, or under why it has none. */
export function tallyOfRead(words: number, probs: readonly number[] | null, why: SkipReason | null): Tally {
  return addRead(emptyTally(), words, probs, why);
}

export function addRead(t: Tally, words: number, probs: readonly number[] | null, why: SkipReason | null, verdict?: UnitRow["verdict"]): Tally {
  if (probs && !why) {
    t.scored += words;
    if(probs.length===3) {
      for(const a of [t.expected,t.units,t.argmax]) a[4] ??= 0;
      probs.forEach((p,i)=>{ t.expected[detectorSlots[i]!]! += words*p; });
    } else for(let i=0;i<BUCKET_COUNT;i++) t.expected[i]! += words*(probs[i] ?? 0);
    t.units[verdict?.band ?? bandOf(probs)]!++;
    t.argmax[verdict?.argmax ?? argmaxOf(probs)]!++;
  } else if (why) t[why] += words;
  return t;
}

// ---- the rows of the log ----------------------------------------------------------------------
// Every field below is optional where a layer of its dimension leaves it out; docs/statistics.md
// and lib/stats/dictionary.ts say what each is, and which dimension decides it.

/** What was known of the engine when it scored. */
export interface EngineInfo {
  kind?: "native" | "inbrowser";
  backend?: string;
  tier?: string;
}

/** What decided a page's kind (lib/stats/pageKind.ts): kept so the rule can be checked, or
 *  another one tried, afterwards. */
export interface KindSignals {
  feedHost: boolean;
  feedRole: boolean;
  forumPath: boolean;
  declared: string | null;
  posts: number;
  inPosts: number;
  sample: number;
  largestShare: number;
  mainShare: number;
  /** Since 2026-10-10 (a visit kept before has none, and is filed as it was then): */
  /** The page names forum software in its generator meta (Discourse, phpBB, …). */
  forumSoftware?: boolean;
  /** Its host is a forum's: forum., forums., community., discuss. */
  forumHost?: boolean;
  /** It says it is an article in og:type alone, with no schema.org Article type. */
  ogOnly?: boolean;
  /** It says it is a product (og:type). */
  ogProduct?: boolean;
  /** The words of the paragraphs looked at that one element holds as its children: the page's
   *  body of text, if it has one. */
  body?: number;
}

export interface VisitRow {
  /** Random; unique in this log. */
  id: string;
  /** The local date the visit began on: what retention and the views go by. */
  date: string;
  /** Epoch milliseconds, as fine as TIME allows. */
  start: number;
  end?: number;
  /** Why it ended. */
  ended?: "navigated" | "closed" | "route" | "hidden" | "stopped";
  frame: "top" | "frame";
  /** The visit of the page a frame is in. */
  parent?: string;
  tab?: string;
  window?: string;
  /** The address at the layer recorded and at every coarser one (PLACE), in the clear or
   *  hashed: `url` is the finest of them, `site` the host or the domain. */
  places?: Partial<Record<"url" | "nofragment" | "querynames" | "path" | "pattern" | "host" | "domain", string>>;
  url?: string;
  site?: string;
  /** Site of the top page for grouping a frame with its page totals. */
  pageSite?: string;
  titleLayer?: import("./config").Layer<"title">;
  title?: string;
  kind: PageKind;
  signals?: KindSignals;
  surface: Surface;
  arrival?: Arrival;
  /** The page it came from, at PLACE's layer. */
  referrer?: string;
  /** The visit before it in the same tab, and the one whose tab opened this one's. */
  previous?: string;
  opener?: string;
  /** Milliseconds the page was shown; shown with somebody active (input within 2 min); shown
   *  in a focused window. */
  shown: number;
  active: number;
  focused: number;
  height?: number;
  width?: number;
  /** Paragraphs and words the reader found on the page, read or not. */
  found?: { units: number; words: number };
  leftOut?: Partial<Record<LeftOut, number>>;
  display?: { chips: string; underlines: string; flagFrom: string };
  model?: ModelInfo;
  engine?: EngineInfo;
  scroll?: { depth: number; distance: number };
  /** Idle periods (offsets from the start), or input counts per minute of the visit. */
  idle?: [number, number][];
  minutes?: { pointer: number[]; key: number[]; wheel: number[]; touch: number[] };
  /** Uses of Anagram's own chips and menu, by kind. */
  ui?: Partial<Record<UiEvent, number>>;
  pdf?: { pages: number; bytes?: number; reader: "structure" | "reflow"; drawn: number };
  /** Everything read in the visit under the default lens (lib/stats/lens.ts). */
  tally: Tally;
  /** Which of its values were kept as salted hashes. */
  hashed?: ("place" | "title")[];
}

/** [all, focused, flung, focused and flung] milliseconds. */
export type Exposure = [number, number, number, number];

export const UNIT_KINDS = ["paragraph", "post", "joined", "pdf", "docs", "surface"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export type HashedPlaces = Map<string, NonNullable<VisitRow["places"]>>;
export type PlaceLayerKey = keyof NonNullable<VisitRow["places"]>;

/** Link address hashes only to the layers actually retained with the visit. */
export function indexHashedPlaces(index: HashedPlaces, visit: VisitRow, wanted?: ReadonlyMap<string, PlaceLayerKey>): void {
  if (!visit.hashed?.includes("place") || !visit.places) return;
  for (const address of Object.values(visit.places)) {
    const layer = wanted?.get(address);
    if (!wanted || (layer && visit.places[layer] !== undefined)) index.set(address, visit.places);
  }
}

export interface UnitRow {
  visit: string;
  /** Its order of finding in the visit, from 0. */
  n: number;
  /** Opening day of the parent visit, used to retrieve an entire visit for a raw export. */
  date: string;
  /** Local day of the first recorded read, or of discovery while still unread. */
  readDate?: string;
  status: UnitStatus;
  /** Salted hash of the text; a salted near-duplicate sketch; the first twelve words. The
   *  whole text, where kept, is in the texts table under `hash`. */
  hash?: string;
  sketch?: string;
  head?: string;
  len?: { chars?: number; sent?: number; words: number; tokens?: number; sentences?: number; lines?: number; pieces?: number[]; formulas?: number; windows?: number; band?: string };
  lang?: { label?: string; prob?: number; script?: string; english?: boolean };
  struct?: { unit?: UnitKind; tag?: string; role?: string; landmark?: string; post?: number; depth?: number; order?: number; quoted?: boolean; teaser?: boolean; expanded?: boolean; paragraphs?: number };
  geom?: { x?: number; y?: number; w?: number; h?: number; page?: number; share?: number };
  verdict?: { p?: number[]; score?: number; band?: number; argmax?: number; flagged?: boolean; doubt?: boolean; windows?: number[][]; tokens?: number; truncated?: boolean };
  timing?: { cached?: boolean; asked?: number; answered?: number; drawn?: number; batch?: number };
  /** Milliseconds on screen, while the page was shown, by how much of it: any part of it; at
   *  least half of it; any part in the middle 80% of the viewport (the default "read" band).
   *  Each as [all of it, in a focused window, while the page was flung past, both]. When it
   *  was first and last there, how many times it came on screen, and when it counted as read
   *  by the default rule (lib/stats/lens.ts DEFAULT_LENS). */
  expo?: { any: Exposure; half: Exposure; band: Exposure; first?: number; last?: number; sightings: number; readAt?: number; read?: boolean };
  /** Offsets from the visit's start. */
  found: number;
  removedAt?: number;
}

/** The read-only layer stores the decision without exposure durations. Older rows used
 *  zero-filled vectors and a read offset for the same representation. */
export function readFlagOnly(e: NonNullable<UnitRow["expo"]>): boolean {
  return e.read !== undefined || (e.first === undefined && e.last === undefined &&
    e.any.every((n) => n === 0) && e.half.every((n) => n === 0) && e.band.every((n) => n === 0));
}

/** Older logs with sightings but no durations or flag lost the read decision. */
export function recordedRead(e: NonNullable<UnitRow["expo"]>): boolean | undefined {
  if (e.read !== undefined) return e.read;
  if (e.readAt !== undefined) return true;
  return e.sightings > 0 && readFlagOnly(e) ? undefined : false;
}

/** Best available reading day for a row written before its calendar day was recorded. */
export function readingDay(u: UnitRow, visit?: VisitRow): string {
  if (u.readDate) return u.readDate;
  if (!u.expo || !visit || u.date !== visit.date) return u.date;
  const date = localDate(new Date(visit.start + (u.expo.readAt ?? u.found)));
  // If the opening instant falls on a different day here, the old record came
  // from another time zone. Its original midnight cannot be recovered.
  return date === u.date || localDate(new Date(visit.start)) === u.date ? date : u.date;
}

/** The streams of a visit's events, each a set of columns of equal length. Offsets are from
 *  the visit's start, in DUR's precision. Units are their `n`. */
export interface EventStreams {
  /** Visible share steps: which observer (0 the whole viewport, 1 the middle band), the share,
   *  and the paragraph's top edge and height relative to the viewport, in CSS pixels. */
  steps?: { t: number[]; unit: number[]; obs: number[]; ratio: number[]; top: number[]; h: number[] };
  /** On-screen intervals: kind 0 any part shown, 1 in the middle band. */
  intervals?: { unit: number[]; kind: number[]; start: number[]; end: number[]; peak: number[] };
  /** Scroll position of the page (box 0) or of the box that scrolled (its order of scrolling),
   *  with the viewport and the page's size. */
  scroll?: { t: number[]; box: number[]; x: number[]; y: number[]; vw: number[]; vh: number[]; ph: number[] };
  episodes?: { start: number[]; end: number[]; distance: number[]; peak: number[] };
  /** Input: INPUT_KINDS, with the pointer's position where the layer keeps it. */
  input?: { t: number[]; kind: number[]; x?: number[]; y?: number[]; n?: number[] };
  /** STATE_KINDS. */
  state?: { t: number[]; kind: number[] };
  /** UI_EVENTS, and the paragraph it was about (-1 none). */
  ui?: { t: number[]; kind: number[]; unit: number[] };
  /** A paragraph's box after a change of the page's layout. */
  geom?: { t: number[]; unit: number[]; x: number[]; y: number[]; w: number[]; h: number[] };
}

export interface EventChunk { visit: string; seq: number; date: string; streams: EventStreams }

export const INPUT_KINDS = ["pointerdown", "pointerup", "wheel", "touchstart", "touchend", "readkey", "typekey", "shortcut", "move", "select", "copy", "field", "print", "fullscreen"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
export const STATE_KINDS = ["shown", "hidden", "focus", "blur", "frozen", "resumed", "restored", "fling", "settled"] as const;
export type StateKind = (typeof STATE_KINDS)[number];
export const UI_EVENTS = ["card", "cardClosed", "details", "chipClick", "menu", "jump", "analyze", "siteOn", "siteOff", "reader", "statsPage", "export"] as const;
export type UiEvent = (typeof UI_EVENTS)[number];

/** A window or tab event, kept by the worker (TABS). Ids are random per browser session. */
export interface TabEvent {
  at: number;
  date: string;
  kind: "windowOpened" | "windowClosed" | "windowFocus" | "windowBlur" | "windowState" | "tabOpened" | "tabFront" | "tabClosed" | "uncovered" | "ui";
  window?: string;
  tab?: string;
  opener?: string;
  state?: string;
  index?: number;
  tabs?: number;
  /** For "uncovered": how long a tab Anagram cannot read was in front of a focused window. */
  ms?: number;
  /** For "ui": a use of one of Anagram's own pages (the toolbar menu, the reader, the
   *  statistics page), with the visit of the tab it was about. */
  ui?: UiEvent;
  visit?: string;
}

/** A change of what the log records under, or of the device, engine or settings that
 *  shape what it holds. */
export interface ContextRow {
  at: number;
  date: string;
  extension?: string;
  browser?: string;
  os?: string;
  hardware?: { cores?: number; memory?: number; gpu?: string };
  screen?: { w: number; h: number; dpr: number; dark: boolean };
  locale?: { ui: string; zone: string; offset: number };
  model?: ModelInfo;
  engine?: EngineInfo;
  settings?: { flagFrom: string; chips: string; underlines: string; cache: string; pdfReadAhead: boolean; autoOpenPdfs: boolean; access: string; granted: number; off: number };
  recording?: { layers: Record<string, string>; hashed: string[]; retention: Record<string, number> };
}

/** A total under the default lens: a day, a kind of page in a day, a site in a day, a page in
 *  a day. What every preset keeps, and what the toolbar menu reads. */
export interface TotalRow {
  date: string;
  scope: "day" | "kind" | "site" | "page";
  /** "" for the day; the kind; the site; the page's address (or "file:" and its title). */
  key: string;
  tally: Tally;
  /** A page's: its title, when it was first read that day (HH:MM) and how long it was shown. */
  title?: string;
  start?: string;
  /** Opening day when a visit continued into this total's day. */
  startDate?: string;
  dwell?: number;
  kind?: PageKind;
  models?: ModelInfo[];
  /** The key (a site or a page) and the title are salted hashes. */
  hashed?: boolean;
  titleHashed?: boolean;
  titleLayer?: import("./config").Layer<"title">;
  placeLayer?: import("./config").Layer<"place">;
  /** Host hash for a hashed web page. It lets a site filter work after visits expire. */
  siteHash?: string;
}

// ---- dates ----------------------------------------------------------------------------
// Days are the reader's own: a day starts at local midnight where the browser is, and is
// named "YYYY-MM-DD", which sorts as it reads and is IndexedDB's key for it.

const pad = (n: number): string => String(n).padStart(2, "0");

export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** "HH:MM", local. */
export function localMinute(at: Date = new Date()): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The day `days` after `date` (before, when negative). Noon, so no daylight-saving change
 *  moves a date across midnight. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return localDate(new Date(y, m - 1, d + days, 12));
}

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const day = new Date(`${from}T12:00:00`), end = new Date(`${to}T12:00:00`);
  if (localDate(day) !== from || localDate(end) !== to) return out;
  while (day <= end) {
    out.push(localDate(day));
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** The first and last day of the month a "YYYY-MM" names. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: `${month}-01`, to: localDate(new Date(y, m, 0, 12)) };
}
