// test/node/pdf-route.test.ts — where a PDF opens, and why.
//
// Two decisions, each a plain function over its inputs:
//
//   htmlTwinOf()     — which address would be this PDF's real HTML rendering, offered to
//                      the reader as a link they may follow themselves;
//   shouldAutoOpen() — whether a PDF tab may turn itself into the reading mode.
//
// Neither touches the network, and nothing else here does either: the existence probe
// that used to ask arxiv.org whether a paper had been converted was removed on
// 2026-09-20, with the automatic re-routing that depended on it. "Open in Anagram" on a
// PDF now opens THAT PDF. docs/footprint.md is the inventory that keeps it so.
import { describe, expect, it } from "vitest";
import { htmlTwinOf } from "../../lib/pdf/source";
import { shouldAutoOpen, type AutoOpenFacts } from "../../lib/pdf/route";

describe("the HTML twin of a PDF address", () => {
  it.each([
    // The forms arXiv's own pages and everybody else's links really use.
    ["https://arxiv.org/pdf/2301.10226", "https://arxiv.org/html/2301.10226"],
    ["https://arxiv.org/pdf/2301.10226v7", "https://arxiv.org/html/2301.10226v7"],
    ["https://arxiv.org/pdf/2301.10226v7.pdf", "https://arxiv.org/html/2301.10226v7"],
    ["https://arxiv.org/pdf/2301.10226.pdf", "https://arxiv.org/html/2301.10226"],
    ["https://arxiv.org/pdf/2402.17764?download=true", "https://arxiv.org/html/2402.17764"],
    ["http://arxiv.org/pdf/2402.17764", "https://arxiv.org/html/2402.17764"],
    // Five-digit ids (arXiv went to five in 2015) and the pre-2007 archive/number form.
    ["https://arxiv.org/pdf/1706.03762", "https://arxiv.org/html/1706.03762"],
    ["https://arxiv.org/pdf/hep-th/9901001v2", "https://arxiv.org/html/hep-th/9901001v2"],
    ["https://arxiv.org/pdf/hep-th/9901001.pdf", "https://arxiv.org/html/hep-th/9901001"],
    ["https://arxiv.org/pdf/math.AG/0601001", "https://arxiv.org/html/math.AG/0601001"],
    ["https://arxiv.org/pdf/cond-mat.stat-mech/0703041v2", "https://arxiv.org/html/cond-mat.stat-mech/0703041v2"],
    // The mirrors are the same repository; the paper is asked for from arxiv.org itself.
    ["https://www.arxiv.org/pdf/2301.10226", "https://arxiv.org/html/2301.10226"],
    ["https://export.arxiv.org/pdf/2301.10226v1", "https://arxiv.org/html/2301.10226v1"],
    ["https://ARXIV.ORG/pdf/2301.10226", "https://arxiv.org/html/2301.10226"],
  ])("%s → %s", (pdf, html) => {
    expect(htmlTwinOf(pdf)).toBe(html);
  });

  it.each([
    // Already HTML — the walker reads it where it stands.
    ["https://arxiv.org/abs/2301.10226"],
    ["https://arxiv.org/html/2301.10226"],
    // Not arXiv, however much the address would like to look like it.
    ["https://notarxiv.org/pdf/2301.10226"],
    ["https://arxiv.org.evil.example/pdf/2301.10226"],
    ["https://evil.example/pdf/2301.10226?host=arxiv.org"],
    ["https://example.com/papers/2301.10226.pdf"],
    // arXiv, but not a paper's PDF.
    ["https://arxiv.org/pdf/"],
    ["https://arxiv.org/pdf/2301.10226v7/supplement"],
    ["https://arxiv.org/format/2301.10226"],
    ["https://arxiv.org/pdf/not-an-id"],
    ["https://arxiv.org/pdf/230.1022"],
    // Nothing the reading mode could hand back to a publisher anyway.
    ["file:///Users/someone/2301.10226.pdf"],
    ["blob:https://arxiv.org/8f0c-4a11"],
    ["not a url at all"],
    [""],
  ])("%s → null", (pdf) => {
    expect(htmlTwinOf(pdf)).toBeNull();
  });
});

// ---- may a PDF tab open itself? -------------------------------------------------------------

describe("the automatic route", () => {
  /** A PDF tab as it arrives with the setting on and nothing in the way. */
  const ordinary: AutoOpenFacts = {
    setting: true,
    contentType: "application/pdf",
    protocol: "https:",
    navigationType: "navigate",
    frame: 0,
    pass: false,
  };

  it("opens an ordinary PDF tab when the setting is on", () => {
    expect(shouldAutoOpen(ordinary)).toBe(true);
    expect(shouldAutoOpen({ ...ordinary, protocol: "http:" })).toBe(true);
    // A local PDF too: the tick that lets a content script run on file URLs is the same
    // one that lets the reader fetch them, so where this is asked at all it can be done.
    expect(shouldAutoOpen({ ...ordinary, protocol: "file:" })).toBe(true);
    // A reload of the PDF itself is an ordinary visit; the reader's own URL reloads as
    // the reader, which never reaches this decision at all.
    expect(shouldAutoOpen({ ...ordinary, navigationType: "reload" })).toBe(true);
  });

  it.each([
    ["the setting is off", { setting: false }],
    ["the document is not a PDF", { contentType: "text/html" }],
    ["the reader pressed Back out of the reading mode", { navigationType: "back_forward" }],
    ["the reader is on its way to the original", { pass: true }],
    ["the PDF is somebody's iframe, not the tab", { frame: 3 }],
    ["the PDF exists only in this tab (blob:)", { protocol: "blob:" }],
    ["the PDF exists only in this tab (data:)", { protocol: "data:" }],
    ["the tab is showing something that is not a document at all", { protocol: "about:" }],
  ])("leaves the tab alone when %s", (_why, override) => {
    expect(shouldAutoOpen({ ...ordinary, ...override })).toBe(false);
  });
});
