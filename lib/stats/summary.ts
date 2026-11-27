// lib/stats/summary.ts — the log added up the ways the statistics page and the toolbar menu show
// it: by day, kind of page, site, page or visit, under a lens. Pure, so the numbers on the page
// are the numbers tested.
//
// Under the default lens the totals the worker kept are the numbers, whatever was recorded.
// Changes to eligibility, repeat counting or weight use paragraph records. The headline
// and estimator can use the histograms already present in aggregate-only history.
import { addTally, datesBetween, emptyTally, localDate, localMinute, readingDay, PAGE_KINDS, viewedWords, type PageKind, type Tally, type TotalRow, type UnitRow, type VisitRow } from "./model";
import { needsParagraphs, supportsRecount, countUnit, DEFAULT_LENS, wasRead, type Lens } from "./lens";
import type { LogRange } from "./store";

export interface Row { key: string; tally: Tally; title?: string; start?: string; dwell?: number; kind?: PageKind; url?: string; visit?: VisitRow }

/** Whether the retained paragraphs support a recount, or the saved totals suffice. */
export function canApply(range: LogRange, lens: Lens): boolean {
  if (!needsParagraphs(lens)) return true;
  let supported = false, classified = false;
  for (const unit of range.units) {
    const scored = unit.status === "scored" && (unit.len?.words ?? 0) >= lens.minWords;
    if (supportsRecount(unit, lens)) {
      if (scored) return true;
      supported = true;
    }
    classified ||= scored;
  }
  return supported && !classified;
}

/** Per-visit tallies split by reading day. Deduplicate in reading order when the same
 *  paragraph can appear in different visits. */
export function visitTallies(range: LogRange, lens: Lens): Map<string, Map<string, Tally>> {
  const visits = new Map(range.visits.map((v) => [v.id, v]));
  const readAt = (u: UnitRow) => (visits.get(u.visit)?.start ?? 0) + (u.expo?.readAt ?? u.found);
  const units = lens.once === "visit" ? range.units : range.units.toSorted((a, b) => readAt(a) - readAt(b));
  const seen = new Set<string>();
  const out = new Map<string, Map<string, Tally>>();
  for (const u of units) {
    const date = readingDay(u, visits.get(u.visit));
    const hash = lens.once === "visit" || !u.hash ? undefined : lens.once === "day" ? `${date} ${u.hash}` : u.hash;
    if (hash !== undefined && seen.has(hash)) continue;
    let days = out.get(u.visit);
    if (!days) { days = new Map(); out.set(u.visit, days); }
    let tally = days.get(date);
    if (!tally) { tally = emptyTally(); days.set(date, tally); }
    if (countUnit(tally, u, lens) && hash !== undefined) seen.add(hash);
  }
  return out;
}

export interface Summary {
  total: Tally;
  trend: { date: string; tally: Tally }[];
  kinds: { kind: PageKind; tally: Tally }[];
  sites: Row[];
  pages: Row[];
  visits: Row[];
  /** Whether the numbers are the lens's, worked out from paragraphs; false: the kept totals. */
  fromParagraphs: boolean;
  omittedWords: number;
}

function pageStart(t: TotalRow): string {
  return `${t.startDate ?? t.date} ${t.start ?? ""}`.trim();
}

/** Everything the statistics page shows for `range` under `lens`. */
export function summarize(range: LogRange, from: string, to: string, lens: Lens): Summary {
  const fromParagraphs = needsParagraphs(lens) && canApply(range, lens);
  const day = new Map<string, Tally>(), kind = new Map<PageKind, Tally>(), site = new Map<string, Row>(), page = new Map<string, Row>();
  const visits: Row[] = [];
  const add = <K>(map: Map<K, Tally>, key: K, t: Tally): void => { addTally(map.get(key) ?? map.set(key, emptyTally()).get(key)!, t); };
  if (fromParagraphs) {
    const tallies = visitTallies(range, lens);
    const pages = range.totals.filter((t) => t.scope === "page");
    const files = new Set(pages.filter((t) => t.key.startsWith("file:")).map((t) => t.key));
    const recorded = new Map(pages.map((p) => [`${p.date}\t${p.key}`, p]));
    for (const v of range.visits) {
      const t = emptyTally();
      const localFile = `file:${v.title ?? ""}`;
      const key = v.url ?? (v.site === "" && v.surface === "pdf" && files.has(localFile) ? localFile : undefined);
      for (const [date, part] of tallies.get(v.id) ?? []) {
        if (date < from || date > to) continue;
        addTally(t, part);
        add(day, date, part);
        if (key === undefined) continue;
        const id = `${date}\t${key}`;
        const meta = recorded.get(id);
        const opened = new Date(v.start);
        const start = meta ? pageStart(meta) : `${localDate(opened)} ${localMinute(opened)}`;
        const r = page.get(id) ?? { key, url: v.url, title: v.title, kind: v.kind, tally: emptyTally(), start, dwell: 0 };
        if (start < r.start!) r.start = start;
        addTally(r.tally, part);
        r.dwell = meta?.dwell ?? ((r.dwell ?? 0) + (date === v.date ? Math.round(v.shown / 1000) : 0));
        page.set(id, r);
      }
      add(kind, v.kind, t);
      const pageSite = v.pageSite ?? v.site;
      if (pageSite !== undefined) { const r = site.get(pageSite) ?? { key: pageSite, tally: emptyTally() }; addTally(r.tally, t); site.set(pageSite, r); }
      visits.push({ key: v.id, tally: t, title: v.title, url: v.url, kind: v.kind, visit: v });
    }
  } else {
    for (const t of range.totals) {
      if (t.scope === "day") add(day, t.date, t.tally);
      else if (t.scope === "kind") add(kind, t.key as PageKind, t.tally);
      else if (t.scope === "site") { const r = site.get(t.key) ?? { key: t.key, tally: emptyTally() }; addTally(r.tally, t.tally); site.set(t.key, r); }
      else {
        const k = `${t.date}\t${t.key}`;
        page.set(k, { key: t.key, url: t.key.startsWith("file:") ? undefined : t.key, title: t.title, start: pageStart(t), dwell: t.dwell, kind: t.kind, tally: structuredClone(t.tally) });
      }
    }
    for (const v of range.visits) visits.push({ key: v.id, tally: v.tally, title: v.title, url: v.url, kind: v.kind, visit: v });
  }
  const total = emptyTally();
  for (const t of day.values()) addTally(total, t);
  const byWords = (a: Row, b: Row): number => viewedWords(b.tally) - viewedWords(a.tally) || a.key.localeCompare(b.key);
  return {
    total,
    trend: datesBetween(from, to).map((date) => ({ date, tally: day.get(date) ?? emptyTally() })),
    kinds: PAGE_KINDS.filter((k) => kind.has(k) && viewedWords(kind.get(k)!) > 0).map((k) => ({ kind: k, tally: kind.get(k)! })),
    sites: [...site.values()].sort(byWords),
    pages: [...page.values()].sort((a, b) => (b.start ?? "").localeCompare(a.start ?? "") || byWords(a, b)),
    visits: visits.filter((r) => viewedWords(r.tally) > 0 || (r.visit?.shown ?? 0) > 0).sort((a, b) => (b.visit?.start ?? 0) - (a.visit?.start ?? 0)),
    fromParagraphs,
    omittedWords: fromParagraphs ? missingDetailWords(range, lens) : 0,
  };
}

/** Baseline words in the period for which the recalculation has no paragraph records. */
export function missingDetailWords(range: LogRange, lens: Lens): number {
  const baseline = range.totals.reduce((n, t) => n + (t.scope === "day" ? viewedWords(t.tally) : 0), 0);
  const covered = range.units.reduce((n, u) => n + (supportsRecount(u, lens) &&
    (u.expo?.readAt !== undefined || wasRead(u, DEFAULT_LENS)) ? u.len?.words ?? 0 : 0), 0);
  return Math.max(0, baseline - covered);
}

/** The day's total, the toolbar menu's line. */
export function dayTotal(row: TotalRow | undefined): Tally {
  return row?.tally ?? emptyTally();
}

export { viewedWords };
