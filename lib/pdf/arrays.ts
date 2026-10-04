// lib/pdf/arrays.ts — what a document-sized array is put through.
//
// A spread passes each element of an array as an argument of its own, and V8 takes some
// 120,000 arguments before it throws a RangeError. `out.push(...pieces)` and
// `Math.max(...xs)` over a page's runs, a paragraph's characters or a line's glyphs threw on
// a page or a paragraph that long, which a PDF can make as long as it likes, and the reading
// of the document stopped there. These take arrays of any length.

/** Every element of `items` pushed onto `out`, in order; returns `out`. */
export function append<T>(out: T[], items: readonly T[]): T[] {
  for (const item of items) out.push(item);
  return out;
}

/** Math.min over `f` of each item: Infinity for none, NaN where any is. */
export function least<T>(items: readonly T[], f: (item: T) => number): number {
  let m = Infinity;
  for (const item of items) m = Math.min(m, f(item));
  return m;
}

/** Math.max over `f` of each item: -Infinity for none, NaN where any is. */
export function most<T>(items: readonly T[], f: (item: T) => number): number {
  let m = -Infinity;
  for (const item of items) m = Math.max(m, f(item));
  return m;
}
