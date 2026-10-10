// lib/stats/lens.ts — the choices made when the log is looked at, not when it is recorded:
// what counts as read, what is counted once, which estimator, weighted by what.
//
// The recorder keeps each paragraph's time on screen under every rule a lens can ask for
// (UnitRow.expo), so any of them can be applied to what was recorded at paragraph rows or
// finer. Totals, and visits, hold the default lens's numbers alone: there the lens is the
// default and nothing else. Pure.
import {
  addTally, emptyTally, tallyOfRead, viewedWords, type Exposure, type PageKind, type SkipReason, type Tally, type UnitRow,
} from "./model";
import { MIN_WORDS } from "../dom/text";

/** The viewport's middle 80%, as an IntersectionObserver margin: what `visibility: "band"`
 *  means, and the band the recorder watches (lib/stats/recorder.ts). */
export const BAND_MARGIN = "-10% 0px -10% 0px";

export interface Lens {
  /** Time on screen that makes a paragraph read. */
  readMs: number;
  /** What counts as on screen: any part in the middle 80% of the viewport; at least half of
   *  the paragraph; any part of it anywhere on screen. */
  visibility: "band" | "half" | "any";
  /** Only time in a focused window counts. */
  focusedOnly: boolean;
  /** Time while the page was flung past (two screens a second or faster) does not count. */
  excludeFling: boolean;
  /** A paragraph read again counts again per visit (the default), per day, or once ever. */
  once: "visit" | "day" | "ever";
  /** The headline: the AI-generated band, or heavily edited and AI-generated. */
  headline: "ai" | "heavyAndAi";
  /** How the shares are estimated: expected words (Σ words × p); paragraphs under the word
   *  their chip showed; paragraphs under their most likely band. */
  estimator: "expected" | "chip" | "argmax";
  /** What a paragraph weighs: its words, one, or its seconds on screen. */
  weight: "words" | "paragraphs" | "time";
  /** Paragraphs shorter than this are counted as short (MIN_WORDS is what is read at all; 75
   *  is the model's training minimum). Approximate above MIN_WORDS: a joined group of 50–74
   *  words would have kept joining under a real floor of 75. */
  minWords: number;
}

export const DEFAULT_LENS: Lens = {
  readMs: 1000, visibility: "band", focusedOnly: false, excludeFling: true, once: "visit",
  headline: "ai", estimator: "expected", weight: "words", minWords: MIN_WORDS,
};

export function isDefaultLens(lens: Lens): boolean {
  return (Object.keys(DEFAULT_LENS) as (keyof Lens)[]).every((k) => lens[k] === DEFAULT_LENS[k]);
}

/** The milliseconds of `e` a lens counts. */
export function countedMs(e: Exposure, lens: Pick<Lens, "focusedOnly" | "excludeFling">): number {
  const [all, focused, flung, focusedFlung] = e;
  if (lens.focusedOnly) return lens.excludeFling ? focused - focusedFlung : focused;
  return lens.excludeFling ? all - flung : all;
}

/** How long `unit` was on screen by `lens`, or null where its exposure was not kept. */
export function readTime(unit: UnitRow, lens: Lens): number | null {
  if (!unit.expo) return null;
  return Math.max(0, countedMs(unit.expo[lens.visibility], lens));
}

/** Whether `unit` was read by `lens`. Without its exposure, what the recorder decided by the
 *  default rule. */
export function wasRead(unit: UnitRow, lens: Lens): boolean {
  const ms = readTime(unit, lens);
  if (ms === null) return unit.expo?.readAt !== undefined || unit.status !== "pending";
  return ms >= lens.readMs;
}

/** Why a read paragraph has no verdict under `lens`, or null when it is scored. */
function skipOf(unit: UnitRow, lens: Lens): SkipReason | null {
  const words = unit.len?.words ?? 0;
  if (unit.status === "scored") return words < lens.minWords ? "short" : null;
  if (unit.status === "pending") return "unavailable";
  return unit.status;
}

/** The weight of one paragraph read. */
function weightOf(unit: UnitRow, lens: Lens): number {
  const words = unit.len?.words ?? 0;
  if (lens.weight === "words") return words;
  if (lens.weight === "paragraphs") return 1;
  return Math.round((readTime(unit, lens) ?? 0) / 100) / 10;
}

/**
 * The tally of `units` under `lens`: each read paragraph, counted once as `once` says (a
 * paragraph whose text was not hashed counts once per visit whatever `once` asks), its weight
 * in its verdict's bands or under why it has none.
 */
export function tallyUnder(units: readonly UnitRow[], lens: Lens): Tally {
  const out = emptyTally();
  const seen = new Set<string>();
  for (const unit of units) {
    if (!wasRead(unit, lens)) continue;
    if (lens.once !== "visit" && unit.hash) {
      const key = lens.once === "day" ? `${unit.date} ${unit.hash}` : unit.hash;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const why = skipOf(unit, lens);
    const probs = why ? null : unit.verdict?.p ?? null;
    addTally(out, tallyOfRead(weightOf(unit, lens), probs, probs ? null : why ?? "unavailable"));
  }
  return out;
}

/** The headline share of `t` under `lens`, or null with nothing scored. */
export function headlineOf(t: Tally, lens: Pick<Lens, "headline" | "estimator">): number | null {
  const bands = lens.estimator === "expected" ? t.expected : lens.estimator === "chip" ? t.units : t.argmax;
  const whole = lens.estimator === "expected" ? t.scored : bands.reduce((a, b) => a + b, 0);
  if (!(whole > 0)) return null;
  return (lens.headline === "ai" ? bands[3] : bands[2] + bands[3]) / whole;
}

/** The four shares of `t` under `lens`'s estimator, or null with nothing scored. */
export function sharesUnder(t: Tally, lens: Pick<Lens, "estimator">): [number, number, number, number] | null {
  const bands = lens.estimator === "expected" ? t.expected : lens.estimator === "chip" ? t.units : t.argmax;
  const whole = lens.estimator === "expected" ? t.scored : bands.reduce((a, b) => a + b, 0);
  if (!(whole > 0)) return null;
  return bands.map((b) => b / whole) as [number, number, number, number];
}

export { viewedWords };

/** The page-kind rule's thresholds (lib/stats/pageKind.ts), which a lens may set otherwise and
 *  apply to the signals a visit kept. */
/** The page-kind rule's numbers (lib/stats/pageKind.ts kindFrom): posts that make a feed, and no
 *  one of them holding `onePost` of the words; the share of the words in one article, or in
 *  <main>, that makes an article, with a body of text of `textBody` words; the body an article
 *  declared in og:type alone needs. Measured on the web benchmark's labelled pages, 2026-10-09. */
export interface KindRule { manyVoices: number; articleShare: number; onePost: number; textBody: number; ogBody: number }
export const DEFAULT_KIND_RULE: KindRule = { manyVoices: 5, articleShare: 0.6, onePost: 0.4, textBody: 300, ogBody: 150 };
export type { PageKind };
