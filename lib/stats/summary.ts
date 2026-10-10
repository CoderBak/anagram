// lib/stats/summary.ts — the log added up the ways the statistics page and the toolbar menu show
// it: by day, kind of page, site, page or visit, under a lens. Pure, so the numbers on the page
// are the numbers tested.
//
// Under the default lens the totals the worker kept are the numbers, whatever was recorded.
// Under any other lens they are worked out again from the paragraphs, which only paragraph rows
// or finer keep: `canApply` says whether a lens can be applied to what was recorded.
import { addTally, datesBetween, emptyTally, PAGE_KINDS, viewedWords, type PageKind, type Tally, type TotalRow, type UnitRow, type VisitRow } from "./model";
import { isDefaultLens, tallyUnder, type Lens } from "./lens";
import type { LogRange } from "./store";

export interface Row { key: string; tally: Tally; title?: string; start?: string; dwell?: number; kind?: PageKind; url?: string; visit?: VisitRow }

/** Whether `lens` can be applied to what `range` holds: any lens to paragraphs, the default to
 *  anything. */
export function canApply(range: LogRange, lens: Lens): boolean {
  return isDefaultLens(lens) || range.units.length > 0;
}

/** The tallies of each visit under `lens`, from its paragraphs. */
function visitTallies(range: LogRange, lens: Lens): Map<string, Tally> {
  const byVisit = new Map<string, UnitRow[]>();
  for (const u of range.units) (byVisit.get(u.visit) ?? byVisit.set(u.visit, []).get(u.visit)!).push(u);
  // A paragraph read once ever, or once a day, is counted where it was first read.
  if (lens.once !== "visit") {
    const all = tallyPerVisitInOrder(range, lens);
    return all;
  }
  const out = new Map<string, Tally>();
  for (const [visit, units] of byVisit) out.set(visit, tallyUnder(units, lens));
  return out;
}

function tallyPerVisitInOrder(range: LogRange, lens: Lens): Map<string, Tally> {
  const start = new Map(range.visits.map((v) => [v.id, v.start]));
  const units = [...range.units].sort((a, b) => (start.get(a.visit) ?? 0) + a.found - ((start.get(b.visit) ?? 0) + b.found));
  const seen = new Set<string>();
  const out = new Map<string, Tally>();
  for (const u of units) {
    if (u.hash) {
      const key = lens.once === "day" ? `${u.date} ${u.hash}` : u.hash;
      if (seen.has(key)) continue;
      const t = tallyUnder([u], { ...lens, once: "visit" });
      if (viewedWords(t) > 0) seen.add(key);
      addTally(out.get(u.visit) ?? out.set(u.visit, emptyTally()).get(u.visit)!, t);
    } else addTally(out.get(u.visit) ?? out.set(u.visit, emptyTally()).get(u.visit)!, tallyUnder([u], { ...lens, once: "visit" }));
  }
  return out;
}

export interface Summary {
  total: Tally;
  trend: { date: string; tally: Tally }[];
  kinds: { kind: PageKind; tally: Tally }[];
  feeds: Tally;
  rest: Tally;
  sites: Row[];
  pages: Row[];
  visits: Row[];
  /** Whether the numbers are the lens's, worked out from paragraphs; false: the kept totals. */
  fromParagraphs: boolean;
}

/** Everything the statistics page shows for `range` under `lens`. */
export function summarize(range: LogRange, from: string, to: string, lens: Lens): Summary {
  const fromParagraphs = !isDefaultLens(lens) && range.units.length > 0;
  const day = new Map<string, Tally>(), kind = new Map<PageKind, Tally>(), site = new Map<string, Row>(), page = new Map<string, Row>();
  const visits: Row[] = [];
  const add = <K>(map: Map<K, Tally>, key: K, t: Tally): void => { addTally(map.get(key) ?? map.set(key, emptyTally()).get(key)!, t); };
  if (fromParagraphs) {
    const tallies = visitTallies(range, lens);
    for (const v of range.visits) {
      const t = tallies.get(v.id) ?? emptyTally();
      add(day, v.date, t);
      add(kind, v.kind, t);
      if (v.site !== undefined) { const r = site.get(v.site) ?? { key: v.site, tally: emptyTally() }; addTally(r.tally, t); site.set(v.site, r); }
      if (v.url !== undefined) {
        const r = page.get(v.url) ?? { key: v.url, url: v.url, title: v.title, kind: v.kind, tally: emptyTally(), dwell: 0 };
        addTally(r.tally, t); r.dwell! += Math.round(v.shown / 1000); page.set(v.url, r);
      }
      visits.push({ key: v.id, tally: t, title: v.title, url: v.url, kind: v.kind, visit: v });
    }
  } else {
    for (const t of range.totals) {
      if (t.scope === "day") add(day, t.date, t.tally);
      else if (t.scope === "kind") add(kind, t.key as PageKind, t.tally);
      else if (t.scope === "site") { const r = site.get(t.key) ?? { key: t.key, tally: emptyTally() }; addTally(r.tally, t.tally); site.set(t.key, r); }
      else {
        const k = `${t.date}\t${t.key}`;
        page.set(k, { key: t.key, url: t.key.startsWith("file:") ? undefined : t.key, title: t.title, start: `${t.date} ${t.start ?? ""}`.trim(), dwell: t.dwell, kind: t.kind, tally: structuredClone(t.tally) });
      }
    }
    for (const v of range.visits) visits.push({ key: v.id, tally: v.tally, title: v.title, url: v.url, kind: v.kind, visit: v });
  }
  const total = emptyTally();
  for (const t of day.values()) addTally(total, t);
  const feeds = emptyTally(), rest = emptyTally();
  for (const [k, t] of kind) addTally(k === "feed" ? feeds : rest, t);
  const byWords = (a: Row, b: Row): number => viewedWords(b.tally) - viewedWords(a.tally) || a.key.localeCompare(b.key);
  return {
    total,
    trend: datesBetween(from, to).map((date) => ({ date, tally: day.get(date) ?? emptyTally() })),
    kinds: PAGE_KINDS.filter((k) => kind.has(k) && viewedWords(kind.get(k)!) > 0).map((k) => ({ kind: k, tally: kind.get(k)! })),
    feeds, rest,
    sites: [...site.values()].sort(byWords),
    pages: [...page.values()].sort((a, b) => (b.start ?? "").localeCompare(a.start ?? "") || byWords(a, b)),
    visits: visits.filter((r) => viewedWords(r.tally) > 0 || (r.visit?.shown ?? 0) > 0).sort((a, b) => (b.visit?.start ?? 0) - (a.visit?.start ?? 0)),
    fromParagraphs,
  };
}

/** The day's total, the toolbar menu's line. */
export function dayTotal(row: TotalRow | undefined): Tally {
  return row?.tally ?? emptyTally();
}

export { viewedWords };
