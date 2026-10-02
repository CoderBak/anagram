import { describe, expect, it } from "vitest";
import { reportOffset } from "../../lib/capture/pageReport";

describe("toolbar result pagination", () => {
  it.each([
    [0, 0, 0], [50, 0, 0], [50, 50, 0], [50, 51, 50],
    [999, 101, 100], [-1, 101, 0], [75, 101, 50],
    [Number.NaN, 101, 0], [Number.POSITIVE_INFINITY, 101, 0], [1.5, 101, 0],
  ])("clamps offset %s for %s flagged paragraphs to %s", (requested, total, expected) => {
    expect(reportOffset(requested, total)).toBe(expected);
  });
});
