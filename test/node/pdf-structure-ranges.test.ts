// test/node/pdf-structure-ranges.test.ts — the page ranges a long document's structure is read
// in (lib/pdf/structureWorker.ts): as even as can be, none longer than the most, end to end.
import { describe, expect, it, vi } from "vitest";

vi.mock("#imports", () => ({ browser: { runtime: { getURL: (p: string) => p } } }));
const { pageRanges, RANGE_PAGES } = await import("../../lib/pdf/structureWorker");

describe("page ranges", () => {
  it("reads a document up to the most in one piece", () => {
    expect(pageRanges(1)).toEqual([[0, 1]]);
    expect(pageRanges(RANGE_PAGES)).toEqual([[0, RANGE_PAGES]]);
  });

  it("cuts a longer one in even ranges, none longer than the most, covering every page once", () => {
    expect(pageRanges(2445)).toEqual([[0, 815], [815, 1630], [1630, 2445]]);
    expect(pageRanges(30, 12)).toEqual([[0, 10], [10, 20], [20, 30]]);
    for (const pages of [1001, 1999, 2000, 2001, 2500, 4999]) {
      const ranges = pageRanges(pages);
      expect(ranges[0]![0]).toBe(0);
      expect(ranges.at(-1)![1]).toBe(pages);
      for (const [k, [start, end]] of ranges.entries()) {
        expect(end - start).toBeLessThanOrEqual(RANGE_PAGES);
        expect(end - start).toBeGreaterThan(0);
        if (k > 0) expect(start).toBe(ranges[k - 1]![1]);
      }
      const sizes = ranges.map(([start, end]) => end - start);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(Math.ceil(pages / ranges.length) - Math.floor(pages / ranges.length) + 1);
    }
  });
});
