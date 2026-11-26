import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mountReport } from "../../entrypoints/popup/report";
import { reportOffset, type PageReport } from "../../lib/capture/pageReport";

describe("toolbar result pagination", () => {
  it.each([
    [0, 0, 0], [50, 0, 0], [50, 50, 0], [50, 51, 50],
    [999, 101, 100], [-1, 101, 0], [75, 101, 50],
    [Number.NaN, 101, 0], [Number.POSITIVE_INFINITY, 101, 0], [1.5, 101, 0],
  ])("clamps offset %s for %s flagged paragraphs to %s", (requested, total, expected) => {
    expect(reportOffset(requested, total)).toBe(expected);
  });
});

it("shows an incomplete scan immediately and keeps routine coverage in the breakdown", ({ onTestFinished }) => {
  const { document } = parseHTML(readFileSync(new URL("../../entrypoints/popup/index.html", import.meta.url), "utf8"));
  vi.stubGlobal("document", document);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const host = document.getElementById("pageReport")!;
  const paint = mountReport(host, { jump: vi.fn(), page: vi.fn(), allow: vi.fn() });
  const report: PageReport = {
    documentId: "sample", visible: true, total: 0, offset: 0, entries: [],
    scopeNote: "", commentOrigins: [], pageAction: null,
    counts: { read: 3, bands: [3, 0, 0, 0], short: 1, lessReliable: 0, notEnglish: 0, pending: 1, unavailable: 0 },
  };
  const visibleNote = () => host.querySelector(".report-body > .report-coverage:not([hidden])")?.textContent;
  paint(report);
  expect(visibleNote()).toContain("1 pending");
  report.counts.pending = 0;
  report.counts.unavailable = 1;
  paint(report);
  expect(visibleNote()).toContain("1 unavailable");
  report.counts.unavailable = 0;
  paint(report);
  expect(visibleNote()).toBeUndefined();
  expect(host.querySelector("details .report-coverage")?.textContent).toBe("1 too short");
});
