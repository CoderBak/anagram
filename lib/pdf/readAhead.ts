// lib/pdf/readAhead.ts — in what order, and how much of the document, the PDF reader reads
// the pages it has not drawn.
//
// The reader reads a document whole, not only the pages pdf.js has drawn: their text comes
// from the document (pdf.js's own find bar reads every page that way), and their paragraphs are
// scored in the background so that the report covers the document and a page's chips are
// there the moment it is drawn. How fast is the pacer's (lib/capture/pace.ts), the same one a
// web page's background prefetch keeps to; what follows is what only a paged document has.
//
// - Order: outward from the page being read, two pages ahead for each one behind (the
//   direction of reading), as pdf.js pre-renders ahead and Hypothesis searches outward.
// - Scope: a slow engine reads only around the page being read; the menu offers the rest.

export { createPacer, seedFor, type Pacer, type Speed } from "../capture/pace";

/** Where a slow engine reads without being asked: these pages behind and ahead. */
export const SLOW_SCOPE = { behind: 2, ahead: 6 } as const;

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
