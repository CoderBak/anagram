// lib/stats/summary.ts — the recorded days added up the ways the statistics page and the
// toolbar menu show them. Pure, so the numbers on the page are the numbers tested.
import { addTally, datesBetween, emptyTally, finer, PAGE_KINDS, viewedWords, type PageKind, type StatsLevel, type Tally } from "./model";
import type { DayRecord, PageRecord, SiteRecord } from "./record";
import type { StatsRange } from "./store";

export function sumDays(days: readonly DayRecord[]): Tally {
  const t = emptyTally();
  for (const d of days) addTally(t, d.total);
  return t;
}

/** Each kind of page over the days, in PAGE_KINDS order, the kinds with nothing read left out. */
export function byKind(days: readonly DayRecord[]): { kind: PageKind; tally: Tally }[] {
  const out = new Map<PageKind, Tally>();
  for (const d of days) {
    for (const kind of PAGE_KINDS) {
      const t = d.kinds[kind];
      if (t) addTally(out.get(kind) ?? out.set(kind, emptyTally()).get(kind)!, t);
    }
  }
  return PAGE_KINDS.filter((k) => out.has(k) && viewedWords(out.get(k)!) > 0).map((kind) => ({ kind, tally: out.get(kind)! }));
}

/** Feeds against everything else read. */
export function feedsAndRest(days: readonly DayRecord[]): { feeds: Tally; rest: Tally } {
  const feeds = emptyTally();
  const rest = emptyTally();
  for (const d of days) {
    for (const kind of PAGE_KINDS) {
      const t = d.kinds[kind];
      if (t) addTally(kind === "feed" ? feeds : rest, t);
    }
  }
  return { feeds, rest };
}

/** Each site over the days, most read first. */
export function bySite(sites: readonly SiteRecord[]): { site: string; tally: Tally }[] {
  const out = new Map<string, Tally>();
  for (const s of sites) addTally(out.get(s.site) ?? out.set(s.site, emptyTally()).get(s.site)!, s.tally);
  return [...out].map(([site, tally]) => ({ site, tally })).sort((a, b) => viewedWords(b.tally) - viewedWords(a.tally) || a.site.localeCompare(b.site));
}

/** Every date of the range with what was read on it, nothing where nothing was. */
export function trend(days: readonly DayRecord[], from: string, to: string): { date: string; tally: Tally }[] {
  const byDate = new Map(days.map((d) => [d.date, d.total]));
  return datesBetween(from, to).map((date) => ({ date, tally: byDate.get(date) ?? emptyTally() }));
}

/** Pages, latest first. */
export function pagesLatestFirst(pages: readonly PageRecord[]): PageRecord[] {
  return [...pages].sort((a, b) => b.date.localeCompare(a.date) || b.start.localeCompare(a.start) || a.url.localeCompare(b.url));
}

/** The finest level anything in the range was recorded at, "off" for nothing at all. */
export function recordedLevel(range: StatsRange): StatsLevel {
  let level: StatsLevel = range.days.length > 0 ? "daily" : "off";
  for (const d of range.days) level = finer(level, d.level);
  if (range.sites.length > 0) level = finer(level, "sites");
  if (range.pages.length > 0) level = finer(level, "pages");
  return level;
}
