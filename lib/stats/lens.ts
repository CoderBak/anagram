// lib/stats/lens.ts — the choices made when the log is looked at, not when it is recorded:
// what counts as read, what is counted once, which estimator, weighted by what.
//
// A recount uses the exposure and verdict detail retained with each paragraph.
// The default eligibility rule and weights are also available in saved totals.
import {
  readFlagOnly, recordedRead, addRead, emptyTally, viewedWords, type Bands, type Exposure, type PageKind, type SkipReason, type Tally, type UnitRow,
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
  /** The selected verdict classes. Historical heavy editing and current AI assistance have separate bins. */
  headline: "ai" | "assistedAndAi" | "heavyAndAi";
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

/** Presentation changes can use the histograms already stored in daily totals. */
export function needsParagraphs(lens: Lens): boolean {
  return !isDefaultLens({ ...lens, estimator: DEFAULT_LENS.estimator, headline: DEFAULT_LENS.headline });
}

/** The milliseconds of `e` a lens counts. */
export function countedMs(e: Exposure, lens: Pick<Lens, "focusedOnly" | "excludeFling">): number {
  const [all, focused, flung, focusedFlung] = e;
  if (lens.focusedOnly) return lens.excludeFling ? focused - focusedFlung : focused;
  return lens.excludeFling ? all - flung : all;
}

/** How long `unit` was on screen by `lens`, or null where its exposure was not kept. */
export function readTime(unit: UnitRow, lens: Lens): number | null {
  if (!unit.expo || readFlagOnly(unit.expo)) return null;
  return Math.max(0, countedMs(unit.expo[lens.visibility], lens));
}

/** A read flag describes the default visibility rule only. Durations are required for
 *  a different rule or a weight measured in seconds. */
export function supportsReadRule(unit: UnitRow, lens: Lens): boolean {
  if (!unit.expo) return false;
  return !readFlagOnly(unit.expo) || (lens.weight !== "time" && lens.readMs === DEFAULT_LENS.readMs &&
    lens.visibility === DEFAULT_LENS.visibility && lens.focusedOnly === DEFAULT_LENS.focusedOnly &&
    lens.excludeFling === DEFAULT_LENS.excludeFling && recordedRead(unit.expo) !== undefined);
}

export function wasRead(unit: UnitRow, lens: Lens): boolean {
  const ms = readTime(unit, lens);
  if (ms !== null) return ms >= lens.readMs;
  return !!unit.expo && supportsReadRule(unit, lens) && recordedRead(unit.expo) === true;
}

/** A categorical verdict retains both labels but cannot reconstruct expected shares. */
export function supportsRecount(unit: UnitRow, lens: Lens): boolean {
  return supportsReadRule(unit, lens) && (skipOf(unit, lens) !== null || !!unit.verdict?.p ||
    (lens.estimator !== "expected" && unit.verdict?.band !== undefined && unit.verdict.argmax !== undefined));
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
    const key = lens.once === "visit" || !unit.hash ? undefined :
      lens.once === "day" ? `${unit.readDate ?? unit.date} ${unit.hash}` : unit.hash;
    if (key !== undefined && seen.has(key)) continue;
    if (countUnit(out, unit, lens) && key !== undefined) seen.add(key);
  }
  return out;
}

/** Accumulate directly into the group so a long history needs no tally allocation per paragraph. */
export function countUnit(out: Tally, unit: UnitRow, lens: Lens): boolean {
  if (!wasRead(unit, lens)) return false;
  const why = skipOf(unit, lens);
  const weight = weightOf(unit, lens);
  const verdict = unit.verdict;
  if (why || verdict?.p) addRead(out, weight, verdict?.p ?? null, why, verdict);
  else if (lens.estimator !== "expected" && verdict?.band !== undefined && verdict.argmax !== undefined) {
    out.scored += weight;
    out.units[verdict.band] = (out.units[verdict.band] ?? 0)+1;
    out.argmax[verdict.argmax] = (out.argmax[verdict.argmax] ?? 0)+1;
    out.missingProbabilities = true;
  } else return false;
  return weight > 0;
}

/** The quantities shown by a verdict chart. Older records can lack the argmax histogram. */
export function verdictBands(t: Tally, lens: Pick<Lens, "estimator">): Bands {
  if (lens.estimator === "expected") return t.expected;
  if (lens.estimator === "chip") return t.units;
  return t.argmax ?? [0, 0, 0, 0];
}

export function verdictDenominator(t: Tally, lens: Pick<Lens, "estimator">): number {
  if (lens.estimator === "expected") return t.missingProbabilities ? 0 : t.scored;
  return verdictBands(t, lens).reduce((a, b) => a + b, 0);
}

/** The headline share of `t` under `lens`, or null with nothing scored. */
export function headlineOf(t: Tally, lens: Pick<Lens, "headline" | "estimator">): number | null {
  const bands = verdictBands(t, lens);
  const whole = verdictDenominator(t, lens);
  if (!(whole > 0)) return null;
  const extra = lens.headline === "assistedAndAi" ? bands[4] ?? 0 : lens.headline === "heavyAndAi" ? bands[2] : 0;
  return (bands[3] + extra) / whole;
}

/** Shares in stored band order, or null with nothing scored. */
export function sharesUnder(t: Tally, lens: Pick<Lens, "estimator">): Bands | null {
  const bands = verdictBands(t, lens);
  const whole = verdictDenominator(t, lens);
  if (!(whole > 0)) return null;
  return bands.map((b) => b / whole) as Bands;
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
