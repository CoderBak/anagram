// lib/stats/model.ts — what the reading statistics are made of, shared by the worker that
// records them, the pages that show and export them, and the content script that measures.
//
// The statistic is an EXPECTATION, not a count of verdicts. A paragraph the model calls 60%
// AI-generated and 40% heavily edited adds 0.6 of its words to one band and 0.4 to the other;
// added up over everything read, the shares are what the model expects the reading to have
// been made of. Counting each paragraph under its one word instead would round every doubt the
// same way, and a day of borderline paragraphs would read as certain. The words each chip
// showed are counted beside it (`units`), because that is what the reader saw, and because a
// researcher correcting for the classifier's error rates (Rogan–Gladen) needs them.
//
// Nothing here holds text. A record is numbers, a date, and at the finer levels a site's name
// or a page's address and title (docs/statistics.md).
import { BUCKET_COUNT } from "../contract";
import { levelOf } from "../render/scale";

/** How much is recorded, each level holding everything the one before it does. */
export const STATS_LEVELS = ["off", "daily", "sites", "pages"] as const;
export type StatsLevel = (typeof STATS_LEVELS)[number];
export const DEFAULT_STATS_LEVEL: StatsLevel = "off";

/** How many days are kept; older ones are deleted. */
export const RETENTION_CHOICES = [30, 90, 365] as const;
export type RetentionDays = (typeof RETENTION_CHOICES)[number];
export const DEFAULT_RETENTION: RetentionDays = 90;

/** What sort of page the words were read on (lib/stats/pageKind.ts says how it is told). */
export const PAGE_KINDS = ["feed", "article", "forum", "document", "other"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Why words that were read have no verdict: under the minimum length, not in English, or
 *  the engine could not read them when they were. */
export const SKIP_REASONS = ["short", "language", "unavailable"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What one message of a page may carry: entries of each kind, words in one entry, and
 *  seconds of reading (a page sends every few seconds; this leaves room for a slow worker). */
export const STATS_MAX_ENTRIES = 256;
export const STATS_MAX_WORDS = 100_000;
export const STATS_MAX_DWELL_S = 600;

export function statsLevelOf(value: unknown): StatsLevel {
  return (STATS_LEVELS as readonly unknown[]).includes(value) ? (value as StatsLevel) : DEFAULT_STATS_LEVEL;
}

export function retentionOf(value: unknown): RetentionDays {
  return (RETENTION_CHOICES as readonly unknown[]).includes(value) ? (value as RetentionDays) : DEFAULT_RETENTION;
}

/** `level` records at least what `floor` does: "pages" covers "sites", which covers "daily". */
export function atLeast(level: StatsLevel, floor: StatsLevel): boolean {
  return STATS_LEVELS.indexOf(level) >= STATS_LEVELS.indexOf(floor);
}

/** The coarser of two levels. */
export function coarser(a: StatsLevel, b: StatsLevel): StatsLevel {
  return STATS_LEVELS.indexOf(a) <= STATS_LEVELS.indexOf(b) ? a : b;
}

/** The finer of two levels. */
export function finer(a: StatsLevel, b: StatsLevel): StatsLevel {
  return STATS_LEVELS.indexOf(a) >= STATS_LEVELS.indexOf(b) ? a : b;
}

/** Four numbers, one per word, human first. */
export type Bands = [number, number, number, number];

/** What was read of some stretch of reading, in words, and the units the words were in. */
export interface Tally {
  /** Words of the paragraphs read that the model scored. */
  scored: number;
  /** Words expected in each band: Σ words × the model's probability of that band. */
  expected: Bands;
  /** Paragraphs (chips) under each word, the word the chip showed. */
  units: Bands;
  /** Words read that were not scored, by why. */
  short: number;
  language: number;
  unavailable: number;
}

export function emptyTally(): Tally {
  return { scored: 0, expected: [0, 0, 0, 0], units: [0, 0, 0, 0], short: 0, language: 0, unavailable: 0 };
}

/** Everything read, scored or not. */
export function viewedWords(t: Tally): number {
  return t.scored + t.short + t.language + t.unavailable;
}

/** `into` plus `t`, in place. */
export function addTally(into: Tally, t: Tally): Tally {
  into.scored += t.scored;
  into.short += t.short;
  into.language += t.language;
  into.unavailable += t.unavailable;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    into.expected[i]! += t.expected[i] ?? 0;
    into.units[i]! += t.units[i] ?? 0;
  }
  return into;
}

/** The share of the scored words each band is expected to hold, or null with none scored. */
export function shares(t: Tally): Bands | null {
  if (!(t.scored > 0)) return null;
  return t.expected.map((w) => w / t.scored) as Bands;
}

/** The share expected to be AI-generated, the headline's number; null with nothing scored. */
export function aiShare(t: Tally): number | null {
  return shares(t)?.[3] ?? null;
}

/** The word a chip shows for these probabilities: the score's slice of the scale
 *  (lib/render/scale.ts), not the most likely bucket. */
export function bandOf(probs: readonly number[]): number {
  let score = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) score += (probs[i] ?? 0) * i;
  return levelOf(score / (BUCKET_COUNT - 1));
}

/** One paragraph read: its words and the model's four probabilities. */
export interface ReadUnit {
  words: number;
  probs: readonly number[];
}

/** One stretch of words read that has no verdict. */
export interface ReadSkip {
  words: number;
  why: SkipReason;
}

/** What one message of a page adds, as a Tally. */
export function tallyOf(units: readonly ReadUnit[], skipped: readonly ReadSkip[]): Tally {
  const t = emptyTally();
  for (const u of units) {
    t.scored += u.words;
    for (let i = 0; i < BUCKET_COUNT; i++) t.expected[i]! += u.words * (u.probs[i] ?? 0);
    t.units[bandOf(u.probs)]!++;
  }
  for (const s of skipped) t[s.why] += s.words;
  return t;
}

// ---- dates ----------------------------------------------------------------------------
// Days are the reader's own: a day starts at local midnight where the browser is, and is
// named "YYYY-MM-DD", which sorts as it reads and is IndexedDB's key for it.

const pad = (n: number): string => String(n).padStart(2, "0");

export function localDate(at: Date = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** "HH:MM", local: when a page was opened, to the minute and no finer. */
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
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The first and last day of the month a "YYYY-MM" names. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: `${month}-01`, to: localDate(new Date(y, m, 0, 12)) };
}
