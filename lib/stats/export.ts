// lib/stats/export.ts — the file a reader saves from the statistics page, and may choose to
// give somebody (a research study, say). Anagram never sends it anywhere; docs/statistics.md
// describes every field.
//
// A file can be COARSER than what was recorded and never finer: recorded by page, it can be
// saved as daily totals alone, and then it holds no site and no page, not even how many
// there were. Every number is the stored one, rounded for the file.
import type { ModelInfo } from "../contract";
import { MIN_WORDS } from "../dom/text";
import { SCORE_CUTS } from "../render/scale";
import { atLeast, coarser, viewedWords, type StatsLevel, type Tally } from "./model";
import type { DayRecord, PageRecord, SiteRecord } from "./record";
import { sumDays } from "./summary";
import type { StatsRange } from "./store";

export const EXPORT_SCHEMA = "anagram-stats";
export const EXPORT_VERSION = 1;
export type ExportLevel = Exclude<StatsLevel, "off">;

/** What the file says about where it came from, besides the records. */
export interface ExportContext {
  generatedAt: string;
  extensionVersion: string;
  /** The reader's settings when the file was made. */
  flagFrom: string;
}

/** A Tally as the file has it: words viewed and scored, expected words and units per band
 *  (human, lightly edited, heavily edited, AI-generated), and what was not scored. */
export interface ExportTally {
  words: { viewed: number; scored: number };
  expected: number[];
  units: number[];
  coverage: { short: number; language: number; unavailable: number };
}

export interface StatsExport extends ExportTally {
  schema: typeof EXPORT_SCHEMA;
  version: typeof EXPORT_VERSION;
  generatedAt: string;
  extension: { version: string };
  model: ModelInfo[];
  settings: { minWords: number; flagFrom: string };
  scale: { bands: string[]; cuts: number[] };
  level: { recorded: StatsLevel; exported: ExportLevel };
  range: { from: string; to: string };
  days: (ExportTally & { date: string; level: ExportLevel; kinds: Record<string, ExportTally> })[];
  sites?: (ExportTally & { date: string; site: string })[];
  pages?: (ExportTally & { date: string; start: string; url: string; title: string; kind: string; dwell: number })[];
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

function tallyOut(t: Tally): ExportTally {
  return {
    words: { viewed: viewedWords(t), scored: t.scored },
    expected: t.expected.map(r1),
    units: [...t.units],
    coverage: { short: t.short, language: t.language, unavailable: t.unavailable },
  };
}

function dayOut(d: DayRecord, level: ExportLevel): StatsExport["days"][number] {
  const kinds: Record<string, ExportTally> = {};
  for (const [kind, t] of Object.entries(d.kinds)) if (t) kinds[kind] = tallyOut(t);
  return { date: d.date, level: coarser(d.level, level) as ExportLevel, ...tallyOut(d.total), kinds };
}

const siteOut = (s: SiteRecord) => ({ date: s.date, site: s.site, ...tallyOut(s.tally) });
const pageOut = (p: PageRecord) => ({ date: p.date, start: p.start, url: p.url, title: p.title, kind: p.kind, dwell: p.dwell, ...tallyOut(p.tally) });

/** The file for `range` (from `from` to `to`) at `level`, which is coarsened to what was
 *  recorded when that is coarser. */
export function buildExport(range: StatsRange, from: string, to: string, recorded: StatsLevel, wanted: ExportLevel, ctx: ExportContext): StatsExport {
  const level = (recorded === "off" ? "daily" : coarser(wanted, recorded)) as ExportLevel;
  const days = [...range.days].sort((a, b) => a.date.localeCompare(b.date));
  const models: ModelInfo[] = [];
  for (const d of days) {
    for (const m of d.models) if (!models.some((x) => x.id === m.id && x.ver === m.ver && x.calibration === m.calibration)) models.push(m);
  }
  const out: StatsExport = {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    generatedAt: ctx.generatedAt,
    extension: { version: ctx.extensionVersion },
    model: models,
    settings: { minWords: MIN_WORDS, flagFrom: ctx.flagFrom },
    scale: { bands: ["human", "light", "heavy", "ai"], cuts: [...SCORE_CUTS].map((c) => Math.round(c * 10_000) / 10_000) },
    level: { recorded, exported: level },
    range: { from, to },
    ...tallyOut(sumDays(days)),
    days: days.map((d) => dayOut(d, level)),
  };
  if (atLeast(level, "sites")) {
    out.sites = [...range.sites].sort((a, b) => a.date.localeCompare(b.date) || a.site.localeCompare(b.site)).map(siteOut);
  }
  if (atLeast(level, "pages")) {
    out.pages = [...range.pages].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.url.localeCompare(b.url)).map(pageOut);
  }
  return out;
}

/** The daily rows alone, as CSV: one line a day, the same numbers as the JSON's `days`. */
export function dailyCsv(file: StatsExport): string {
  const head = ["date", "words_viewed", "words_scored",
    "expected_human", "expected_light", "expected_heavy", "expected_ai",
    "units_human", "units_light", "units_heavy", "units_ai",
    "not_scored_short", "not_scored_language", "not_scored_unavailable"];
  const rows = file.days.map((d) => [d.date, d.words.viewed, d.words.scored, ...d.expected, ...d.units,
    d.coverage.short, d.coverage.language, d.coverage.unavailable].join(","));
  return [head.join(","), ...rows].join("\n") + "\n";
}
