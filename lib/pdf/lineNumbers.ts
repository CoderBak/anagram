// lib/pdf/lineNumbers.ts — the numbers down the margin of a manuscript sent for review.
//
// A review copy numbers its lines: Word's line numbering, LaTeX's lineno, a preprint
// server's stamp. The numbers stand in a column beside the text, one on each line, and
// both readings took them for words — "84 Vertical land motion (VLM), defined as … 85
// represents" — which also hid every paragraph's first-line indent behind a number and
// made every line open like a new sentence. What tells such a number from a number of the
// text is where it stands, never what it says: it is a bare number, the first or the last
// thing set on its line, the numbers in line with it down the page count on one line at a
// time, and the column they make stands clear of the text — in the margin, where nothing
// else of those lines is set and nothing else starts or ends in line with it. A table's
// column of figures does not count on, a list's markers and a table's first column stand
// in line with the text above and below them, and a page number is one.
//
// Both readings ask the same question with their own glyphs: lib/pdf/reflow.ts with
// pdf.js's runs, lib/pdf/structured.ts with Zotero's.

/** A bare number set on a page, and where it stands on its line. */
export interface NumberMark {
  page: number;
  x1: number;
  x2: number;
  /** Its line's place down the page, in any space where y grows downward. */
  y: number;
  /** Its height: the unit every tolerance here is measured in. */
  h: number;
  value: number;
  /** Nothing else on its line stands to its left. */
  first: boolean;
  /** Nothing else on its line stands to its right. */
  last: boolean;
}

/** Something else set on a page: a run, or a glyph, weighed by how much text it is. `mark`
 *  is the number it is, when it is one. */
export interface PageContent {
  page: number;
  x1: number;
  x2: number;
  y: number;
  weight: number;
  mark?: NumberMark;
}

/** A column holds at least this many numbers on one page before the page alone is believed. */
const COLUMN_MIN = 8;
/** How many more than the number above it the next one down the column may be: a blank
 *  line is numbered too, and a reading can lose the number of one. */
const MAX_STEP = 3;
/** Share of neighbouring numbers down a column that must count on like that. */
const COUNTING = 0.8;
/** How far apart, in number heights, the aligned edges of one column's numbers may stand. */
const ALIGN = 0.35;
/** At most this share of the text set down the page beside the column may lie beyond it… */
const OUTER = 0.1;
/** …and at most this many things per number may start (or, right of the text, end) in line
 *  with it: a list's items and a table's rows do, line numbers in a margin do not. */
const IN_LINE = 0.2;
/** What starts within this many heights of a column's edge stands in line with it. */
const REACH = 0.5;
const TOUCH = 0.15;

/** A column as found: which edge of its lines it stands at, which of its own edges its
 *  numbers are aligned on (right-aligned "9" and "10" share their right edge), and where. */
interface Column {
  side: "first" | "last";
  edge: "x1" | "x2";
  at: number;
  h: number;
}

/** Neighbouring numbers down the column count on, one line at a time. */
function counts(marks: NumberMark[]): boolean {
  const down = [...marks].sort((a, b) => a.y - b.y);
  let good = 0;
  for (let i = 1; i < down.length; i++) {
    const step = down[i].value - down[i - 1].value;
    if (step >= 1 && step <= MAX_STEP) good++;
  }
  return down.length === 1 || good >= (down.length - 1) * COUNTING;
}

/** The column stands clear of the page's text: down the page beside it hardly anything lies
 *  beyond it, in a margin further out, and hardly anything starts (or ends) in line with it. */
function clear(marks: NumberMark[], side: "first" | "last", content: readonly PageContent[]): boolean {
  const own = new Set<NumberMark>(marks);
  const h = Math.max(...marks.map((m) => m.h));
  const x1 = Math.min(...marks.map((m) => m.x1)), x2 = Math.max(...marks.map((m) => m.x2));
  const top = Math.min(...marks.map((m) => m.y)) - h, bottom = Math.max(...marks.map((m) => m.y)) + h;
  let total = 0, outer = 0, inLine = 0;
  for (const c of content) {
    if (c.mark && own.has(c.mark)) continue;
    if (side === "first" ? c.x1 >= x1 - h * REACH && c.x1 <= x2 + h * TOUCH : c.x2 <= x2 + h * REACH && c.x2 >= x1 - h * TOUCH) inLine++;
    if (c.y < top || c.y > bottom) continue;
    total += c.weight;
    // Beyond the column, further out than it: a caption set across it is not.
    if (side === "first" ? c.x2 <= x1 + h * TOUCH : c.x1 >= x2 - h * TOUCH) outer += c.weight;
  }
  return outer <= total * OUTER && inLine <= marks.length * IN_LINE;
}

/** Marks of one page, at one side, gathered by one aligned edge within ALIGN heights. */
function clusters<T extends NumberMark>(marks: T[], edge: "x1" | "x2"): T[][] {
  const sorted = [...marks].sort((a, b) => a[edge] - b[edge]);
  const out: T[][] = [];
  for (const m of sorted) {
    const open = out.at(-1);
    if (open && m[edge] - open[0][edge] <= Math.max(open[0].h, m.h) * ALIGN) open.push(m);
    else out.push([m]);
  }
  return out;
}

/** Whether any page holds enough numbers in line, counting on, to be a column at all —
 *  asked before anything is measured of where they stand, which costs a pass over the pages. */
export function mayHoldColumn(marks: readonly NumberMark[]): boolean {
  const byPage = new Map<number, NumberMark[]>();
  for (const m of marks) {
    const list = byPage.get(m.page);
    if (list) list.push(m);
    else byPage.set(m.page, [m]);
  }
  for (const list of byPage.values()) {
    if (list.length < COLUMN_MIN) continue;
    for (const edge of ["x1", "x2"] as const) {
      for (const cluster of clusters(list, edge)) {
        if (cluster.length < COLUMN_MIN) continue;
        const down = [...cluster].sort((a, b) => a.y - b.y);
        let good = 0;
        for (let i = 1; i < down.length; i++) {
          const step = down[i].value - down[i - 1].value;
          if (step >= 1 && step <= MAX_STEP) good++;
        }
        if (good >= (COLUMN_MIN - 1) * COUNTING) return true;
      }
    }
  }
  return false;
}

/**
 * The marks that are line numbers, given everything else set on their pages. A page's
 * column is believed on its own when it holds COLUMN_MIN numbers; a page with fewer lines
 * (a figure and its caption) has its numbers taken where they stand in line with a column
 * believed on another page.
 */
export function lineNumberMarks<T extends NumberMark>(marks: readonly T[], content: readonly PageContent[]): Set<T> {
  const out = new Set<T>();
  if (marks.length === 0) return out;
  const byPage = new Map<number, T[]>();
  for (const m of marks) {
    if (!m.first && !m.last) continue;
    const list = byPage.get(m.page);
    if (list) list.push(m);
    else byPage.set(m.page, [m]);
  }
  if (![...byPage.values()].some((list) => list.length >= COLUMN_MIN)) return out;
  const contentOf = new Map<number, PageContent[]>();
  for (const c of content) {
    if (!byPage.has(c.page)) continue;
    const list = contentOf.get(c.page);
    if (list) list.push(c);
    else contentOf.set(c.page, [c]);
  }
  const columns: Column[] = [];
  const found: { cluster: T[]; column: Column; page: number }[] = [];
  for (const [page, list] of byPage) {
    for (const side of ["first", "last"] as const) {
      const at = list.filter((m) => m[side]);
      for (const edge of ["x1", "x2"] as const) {
        for (const cluster of clusters(at, edge)) {
          if (!counts(cluster)) continue;
          const column: Column = { side, edge, at: cluster[0][edge], h: cluster[0].h };
          found.push({ cluster, column, page });
          if (cluster.length >= COLUMN_MIN && clear(cluster, side, contentOf.get(page) ?? [])) columns.push(column);
        }
      }
    }
  }
  if (columns.length === 0) return out;
  const known = (c: Column): boolean =>
    columns.some((k) => k.side === c.side && k.edge === c.edge && Math.abs(k.at - c.at) <= Math.max(k.h, c.h) * ALIGN);
  for (const { cluster, column, page } of found) {
    if (known(column) && clear(cluster, column.side, contentOf.get(page) ?? [])) for (const m of cluster) out.add(m);
  }
  return out;
}

/** A bare number, as a run or a token sets it. */
export const BARE_NUMBER = /^\d{1,5}$/;
