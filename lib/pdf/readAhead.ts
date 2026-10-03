// lib/pdf/readAhead.ts — how fast, and in what order, the PDF reader reads the pages it has
// not drawn.
//
// The reader reads a document whole, not only the pages pdf.js has drawn: their text comes
// from the document (pdf.js's own find bar reads every page that way), and their paragraphs are
// scored in the background so that the report covers the document and a page's chips are
// there the moment it is drawn. The engine reads one pass at a time and cannot be interrupted
// (lib/webengine/engine.ts), so whatever is read in the background is a delay for what is on
// screen and a cost in power. What follows keeps both bounded, on a fast GPU and on a slow CPU
// alike, from one measurement: how long the engine takes here for a thousand characters (a
// pass's cost grows with its text, and paragraphs are of every length: timed per pass, short
// ones made a CPU look like a GPU). One batch far slower than the pace — the model loaded
// again after five idle minutes, another tab's work ahead of it — is not taken at its word;
// two in a row are.
//
// - Order: outward from the page being read, two pages ahead for each one behind (the
//   direction of reading), as pdf.js pre-renders ahead and Hypothesis searches outward.
// - Pace: a duty cycle. After a batch that kept the engine busy for B ms the reader rests
//   B·(1 − d)/d, with d by how fast the engine is — about half its time on a GPU, a third on a
//   CPU, a seventh on a slow one — and half that on battery. (The spellcheckers' "cold mode"
//   and Zotero's indexer work in slices on the same principle.) A speed changes class only a
//   fifth past the line, so one odd batch does not swing it.
// - Batches: about a second of the engine's time where it is fast, ONE paragraph where it is
//   not, so what is drawn next waits behind at most one paragraph — and one paragraph until
//   something has been measured, whatever the device says. Where it is not fast the page's
//   own paragraphs, on screen and off, go one at a time too: a pass pads its texts to the
//   longest of them (three paragraphs of a page took 4.8 s together on an M4's CPU, 3.1 s
//   one by one), and each chip is up as soon as its paragraph is read.
// - Quiet: nothing starts until the reader has left the page alone for twice what a thousand
//   characters take (at least half a second, at most five), as a spellchecker waits for
//   typing to stop.
// - Scope: a slow engine reads only around the page being read; the menu offers the rest.

import { deviceKind } from "../backend/deviceKind";

export type Speed = "fast" | "mid" | "slow";

/** Milliseconds per thousand characters at or under which the engine is "fast" (a GPU: about
 *  200 on an M4; the local engine), and over which it is "slow" (an M4's CPU: about 1000). */
const FAST_MS_PER_K = 400;
const SLOW_MS_PER_K = 2000;
/** How far past a line a speed must go to change class. */
const HYSTERESIS = 0.2;
/** A batch this many times slower than the pace is not counted, unless the next is too. */
const OUTLIER = 6;
/** The engine's share of time the background may take, by speed. */
const DUTY: Record<Speed, number> = { fast: 0.5, mid: 1 / 3, slow: 0.15 };
/** A fast engine's batch: about this much of its time, and at most this many characters. */
const BATCH_MS = 1000;
const MAX_BATCH_CHARS = 4000;
/** Where a slow engine reads without being asked: these pages behind and ahead. */
export const SLOW_SCOPE = { behind: 2, ahead: 6 } as const;
/** Engine time a document may take in the background while it is open before the reader keeps
 *  to the pages around the one being read, as a slow engine does: ten minutes. */
const SESSION_MS = 10 * 60_000;
/** The first guess, before anything has been measured: between a GPU and a CPU. */
const SEED_MS_PER_K = 600;

/** What the engine's device says of its pace, where it says something. */
export function seedFor(device: string | undefined): number | null {
  const kind = deviceKind(device);
  return kind === "gpu" ? 250 : kind === "cpu" ? 1000 : null;
}

function classOf(msPerK: number): Speed {
  return msPerK <= FAST_MS_PER_K ? "fast" : msPerK <= SLOW_MS_PER_K ? "mid" : "slow";
}

export interface Pacer {
  /** A background batch came back: it took `ms`, and the engine read `chars` characters of it
   *  (cache hits are not read, and teach nothing about speed). */
  done(ms: number, chars: number): void;
  /** How long a thousand characters take here, smoothed. */
  msPerK(): number;
  /** How many batches it has measured. */
  samples(): number;
  speed(): Speed;
  /** How long to rest after a batch that took `ms`; `asked`, the reader asked for the whole
   *  document, gives a slow engine a third of its time rather than a seventh. */
  restAfter(ms: number, onBattery: boolean, asked?: boolean): number;
  /** About how long `chars` more characters take in the background, its rests included. */
  timeFor(chars: number, onBattery: boolean, asked?: boolean): number;
  /** Characters a batch may carry; 0 means one paragraph. */
  budget(): number;
  /** How long the reader must have left the page alone before background work starts. */
  quiet(): number;
  /** The reader keeps to the pages around the one being read (slow, or the document's share
   *  spent) until asked for the whole document. */
  limited(): boolean;
  /** A new document: its share of engine time starts again; the pace measured stays. */
  newDocument(): void;
}

export function createPacer(seedMsPerK = SEED_MS_PER_K): Pacer {
  let pace = seedMsPerK;
  let cls = classOf(pace);
  let spent = 0;
  let samples = 0;
  let outlier = false;
  const duty = (onBattery: boolean, asked: boolean): number => Math.max(DUTY[cls], asked ? DUTY.mid : 0) * (onBattery ? 0.5 : 1);
  return {
    done(ms, chars) {
      spent += ms;
      if (chars <= 0) return;
      const measured = ms * 1000 / chars;
      // Against a measured pace only: the first batch is the measure, the seed a guess.
      if (samples > 0 && measured > OUTLIER * pace && !outlier) { outlier = true; return; }
      outlier = false;
      // The guess gives way fast: the first measurements weigh half.
      const weight = samples < 3 ? 0.5 : 0.2;
      pace = (1 - weight) * pace + weight * measured;
      samples++;
      const above = (line: number) => pace > line * (1 + HYSTERESIS);
      const below = (line: number) => pace < line * (1 - HYSTERESIS);
      if (cls === "fast" && above(FAST_MS_PER_K)) cls = above(SLOW_MS_PER_K) ? "slow" : "mid";
      else if (cls === "mid" && below(FAST_MS_PER_K)) cls = "fast";
      else if (cls === "mid" && above(SLOW_MS_PER_K)) cls = "slow";
      else if (cls === "slow" && below(SLOW_MS_PER_K)) cls = below(FAST_MS_PER_K) ? "fast" : "mid";
    },
    msPerK: () => pace,
    samples: () => samples,
    speed: () => cls,
    restAfter(ms, onBattery, asked = false) {
      const d = duty(onBattery, asked);
      return Math.round(ms * (1 - d) / d);
    },
    timeFor: (chars, onBattery, asked = false) => Math.round(chars / 1000 * pace / duty(onBattery, asked)),
    budget: () => (cls === "fast" && samples > 0 ? Math.min(MAX_BATCH_CHARS, Math.round(BATCH_MS * 1000 / pace)) : 0),
    quiet: () => Math.min(5000, Math.max(500, 2 * pace)),
    limited: () => cls === "slow" || spent > SESSION_MS,
    newDocument() { spent = 0; },
  };
}

/** How far `page` is from `current` in reading order: pages ahead count once, pages behind
 *  twice (`down` false reverses which way is ahead). */
export function readingDistance(page: number, current: number, down = true): number {
  const ahead = down ? page - current : current - page;
  return ahead >= 0 ? ahead : -2 * ahead;
}

/** Whether `page` is read without being asked, around `current` where the reader is limited. */
export function inScope(page: number, current: number, limited: boolean): boolean {
  return !limited || (page >= current - SLOW_SCOPE.behind && page <= current + SLOW_SCOPE.ahead);
}

/** Take paragraphs, in the order given, up to `budget` characters, and at least one. */
export function takeBatch<T extends { text: string }>(ordered: readonly T[], budget: number): T[] {
  const out: T[] = [];
  let chars = 0;
  for (const p of ordered) {
    if (out.length > 0 && chars + p.text.length > budget) break;
    out.push(p);
    chars += p.text.length;
  }
  return out;
}
