// lib/stats/wire.ts — what the page's recorder sends the worker (STATS_RECORD), and the
// schema the worker holds it to before anything is kept (lib/access/messages.ts).
//
// A page says what it read and how; WHERE it was read is the browser's to say. The worker
// takes the site from the tab the browser names on the sender, and the address the recorder
// names (`href`, the address the visit began at — a route change since makes another visit)
// only where its origin is that tab's own: a page that claimed another site's address could
// not put its reading there.
import * as v from "valibot";
import {
  ARRIVALS, INPUT_KINDS, LEFT_OUT, PAGE_KINDS, SKIP_REASONS, STATE_KINDS, SURFACES, UI_EVENTS, UNIT_KINDS, UNIT_STATUSES,
  type EventStreams, type Exposure, type KindSignals, type LeftOut, type PageKind, type SkipReason, type Surface, type UiEvent,
  type UnitKind, type UnitStatus,
} from "./model";

export interface WireVisit {
  /** The recorder's id for the visit: random, 32 hex digits. */
  id: string;
  /** Epoch ms when it began. */
  start: number;
  end?: number;
  ended?: "navigated" | "closed" | "route" | "hidden" | "stopped";
  frame: "top" | "frame";
  surface: Surface;
  kind: PageKind;
  signals?: KindSignals;
  /** The address the visit began at (the worker checks it against the tab's). */
  href: string;
  referrer?: string;
  restored?: boolean;
  /** It began with a route change within the page, not a load. */
  route?: boolean;
  height?: number;
  width?: number;
  found?: { units: number; words: number };
  leftOut?: Partial<Record<LeftOut, number>>;
  display?: { chips: string; underlines: string; flagFrom: string };
  pdf?: { pages: number; bytes?: number; reader: "structure" | "reflow"; drawn: number };
  scroll?: { depth: number; distance: number };
  shown: number;
  active: number;
  focused: number;
  /** Milliseconds shown since the visit's last message (the top frame's and the reader's). */
  dwell?: number;
  idle?: [number, number][];
  minutes?: { pointer: number[]; key: number[]; wheel: number[]; touch: number[] };
  ui?: Partial<Record<UiEvent, number>>;
}

export interface WireUnit {
  n: number;
  status: UnitStatus;
  /** Sent once, where the reader keeps a hash, a sketch or the text itself: the worker hashes
   *  it with a secret the page never has. */
  text?: string;
  found: number;
  removedAt?: number;
  len?: { chars?: number; words: number; tokens?: number; sentences?: number; lines?: number; pieces?: number[]; formulas?: number; windows?: number };
  lang?: { label?: string; prob?: number; script?: string };
  struct?: { unit?: UnitKind; tag?: string; role?: string; landmark?: string; post?: number; depth?: number; order?: number; quoted?: boolean; paragraphs?: number };
  geom?: { x: number; y: number; w: number; h: number; page?: number; share?: number };
  verdict?: { p?: number[]; score?: number; flagged?: boolean; truncated?: boolean };
  timing?: { cached?: boolean; answered?: number };
  expo?: { any: Exposure; half: Exposure; band: Exposure; first?: number; last?: number; sightings: number; readAt?: number };
}

/** A paragraph read and counted by the default rule: its words, and its probabilities or why
 *  it has none. */
export interface WireRead { n: number; w: number; p?: number[]; why?: SkipReason }

export interface StatsWire {
  visit: WireVisit;
  /** The message's order within the visit. */
  seq: number;
  units?: WireUnit[];
  reads?: WireRead[];
  events?: EventStreams;
}

// ---- the schema ------------------------------------------------------------------------------

export const STATS_LIMITS = Object.freeze({
  units: 256, reads: 2048, events: 4096, textChars: 200_000, messageText: 600_000, words: 100_000, ms: 31 * 24 * 3600_000,
  idle: 512, minutes: 24 * 60, string: 64, href: 8192,
});

const int = (min: number, max: number) => v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));
const num = (min: number, max: number) => v.pipe(v.number(), v.finite(), v.minValue(min), v.maxValue(max));
const short = v.pipe(v.string(), v.maxLength(STATS_LIMITS.string));
const ms = int(0, STATS_LIMITS.ms);
const offset = int(-STATS_LIMITS.ms, STATS_LIMITS.ms);
const words = int(0, STATS_LIMITS.words);
const probs = v.pipe(v.array(num(0, 1)), v.length(4), v.check((p) => Math.abs(p.reduce((a, b) => a + b, 0) - 1) <= 0.02, "probabilities do not sum to one"));
const exposure = v.pipe(v.array(ms), v.length(4)) as unknown as v.GenericSchema<Exposure>;
const counts = (keys: readonly string[]) => v.pipe(v.record(v.picklist(keys as [string, ...string[]]), int(0, 1_000_000)));

const Signals = v.strictObject({
  feedHost: v.boolean(), feedRole: v.boolean(), forumPath: v.boolean(), declared: v.nullable(v.picklist(["forum", "article"])),
  posts: int(0, 100_000), inPosts: int(0, 100_000), sample: int(0, 100_000), largestShare: num(0, 1), mainShare: num(0, 1),
});

const Visit = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/)),
  start: v.pipe(v.number(), v.integer(), v.minValue(0)),
  end: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  ended: v.optional(v.picklist(["navigated", "closed", "route", "hidden", "stopped"])),
  frame: v.picklist(["top", "frame"]),
  surface: v.picklist(SURFACES),
  kind: v.picklist(PAGE_KINDS),
  signals: v.optional(Signals),
  href: v.pipe(v.string(), v.maxLength(STATS_LIMITS.href)),
  referrer: v.optional(v.pipe(v.string(), v.maxLength(STATS_LIMITS.href))),
  restored: v.optional(v.boolean()),
  route: v.optional(v.boolean()),
  height: v.optional(int(0, 10_000_000)),
  width: v.optional(int(0, 10_000_000)),
  found: v.optional(v.strictObject({ units: int(0, 10_000_000), words: int(0, 1_000_000_000) })),
  leftOut: v.optional(counts(LEFT_OUT)),
  display: v.optional(v.strictObject({ chips: short, underlines: short, flagFrom: short })),
  pdf: v.optional(v.strictObject({ pages: int(0, 100_000), bytes: v.optional(int(0, 2 ** 40)), reader: v.picklist(["structure", "reflow"]), drawn: int(0, 100_000) })),
  scroll: v.optional(v.strictObject({ depth: num(0, 100), distance: num(0, 1e9) })),
  shown: ms, active: ms, focused: ms, dwell: v.optional(ms),
  idle: v.optional(v.pipe(v.array(v.pipe(v.array(offset), v.length(2))), v.maxLength(STATS_LIMITS.idle))) as unknown as v.GenericSchema<[number, number][] | undefined>,
  minutes: v.optional(v.strictObject(Object.fromEntries(["pointer", "key", "wheel", "touch"].map((k) => [k, v.pipe(v.array(int(0, 1_000_000)), v.maxLength(STATS_LIMITS.minutes))])) as unknown as Record<"pointer" | "key" | "wheel" | "touch", v.GenericSchema<number[]>>)),
  ui: v.optional(counts(UI_EVENTS)),
});

const Unit = v.strictObject({
  n: int(0, 10_000_000),
  status: v.picklist(UNIT_STATUSES),
  text: v.optional(v.pipe(v.string(), v.maxLength(STATS_LIMITS.textChars))),
  found: offset,
  removedAt: v.optional(offset),
  len: v.optional(v.strictObject({
    chars: v.optional(int(0, 10_000_000)), words, tokens: v.optional(int(0, 10_000_000)), sentences: v.optional(int(0, 1_000_000)),
    lines: v.optional(int(0, 1_000_000)), pieces: v.optional(v.pipe(v.array(words), v.maxLength(1000))), formulas: v.optional(int(0, 100_000)),
    windows: v.optional(int(0, 10_000)),
  })),
  lang: v.optional(v.strictObject({ label: v.optional(short), prob: v.optional(num(0, 1)), script: v.optional(short) })),
  struct: v.optional(v.strictObject({
    unit: v.optional(v.picklist(UNIT_KINDS)), tag: v.optional(short), role: v.optional(short), landmark: v.optional(short),
    post: v.optional(int(0, 10_000_000)), depth: v.optional(int(0, 10_000)), order: v.optional(int(0, 100_000_000)),
    quoted: v.optional(v.boolean()), paragraphs: v.optional(int(0, 100_000)),
  })),
  geom: v.optional(v.strictObject({ x: num(-1e7, 1e8), y: num(-1e7, 1e8), w: num(0, 1e8), h: num(0, 1e8), page: v.optional(int(0, 100_000)), share: v.optional(num(-1, 2)) })),
  verdict: v.optional(v.strictObject({ p: v.optional(probs), score: v.optional(num(0, 1)), flagged: v.optional(v.boolean()), truncated: v.optional(v.boolean()) })),
  timing: v.optional(v.strictObject({ cached: v.optional(v.boolean()), answered: v.optional(offset) })),
  expo: v.optional(v.strictObject({ any: exposure, half: exposure, band: exposure, first: v.optional(offset), last: v.optional(offset), sightings: int(0, 1_000_000), readAt: v.optional(offset) })),
});

const Read = v.strictObject({ n: int(0, 10_000_000), w: words, p: v.optional(probs), why: v.optional(v.picklist(SKIP_REASONS)) });

/** A stream: columns of equal length, numbers each within `range`. */
const stream = <K extends string>(columns: readonly K[], optional: readonly K[] = []) => v.pipe(
  v.strictObject(Object.fromEntries(columns.map((c) => {
    const column = v.pipe(v.array(num(-1e9, 1e12)), v.maxLength(STATS_LIMITS.events));
    return [c, optional.includes(c) ? v.optional(column) : column];
  })) as unknown as Record<K, v.GenericSchema<number[] | undefined>>),
  v.check((s) => new Set(Object.values(s).filter(Array.isArray).map((a) => (a as number[]).length)).size <= 1, "columns differ in length"),
);

const Events = v.strictObject({
  steps: v.optional(stream(["t", "unit", "obs", "ratio", "top", "h"])),
  intervals: v.optional(stream(["unit", "kind", "start", "end", "peak"])),
  scroll: v.optional(stream(["t", "box", "x", "y", "vw", "vh", "ph"])),
  episodes: v.optional(stream(["start", "end", "distance", "peak"])),
  input: v.optional(stream(["t", "kind", "x", "y", "n"], ["x", "y", "n"])),
  state: v.optional(stream(["t", "kind"])),
  ui: v.optional(stream(["t", "kind", "unit"])),
  geom: v.optional(stream(["t", "unit", "x", "y", "w", "h"])),
}) as unknown as v.GenericSchema<EventStreams>;

export const StatsWireSchema = v.pipe(
  v.strictObject({
    visit: Visit,
    seq: int(0, 10_000_000),
    units: v.optional(v.pipe(v.array(Unit), v.maxLength(STATS_LIMITS.units))),
    reads: v.optional(v.pipe(v.array(Read), v.maxLength(STATS_LIMITS.reads))),
    events: v.optional(Events),
  }),
  v.check((m) => (m.units ?? []).reduce((n, u) => n + (u.text?.length ?? 0), 0) <= STATS_LIMITS.messageText, "too much text"),
);

/** Kinds' names, for whoever reads a stream's numbers. */
export const STREAM_NAMES = { input: INPUT_KINDS, state: STATE_KINDS, ui: UI_EVENTS, arrival: ARRIVALS } as const;
export type { EventStreams };
