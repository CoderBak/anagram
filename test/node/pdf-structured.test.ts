// test/node/pdf-structured.test.ts — Zotero's structure, found again on pdf.js's text layer.
//
// Every case is a page built by hand twice over: once as pdf.js's text runs (what the
// text layer renders — a run per string the PDF drew, in top-left coordinates) and once
// as Zotero's reading of it (text nodes with a glyph map in PDF coordinates, y upward).
// What lib/pdf/structured.ts owes is the same contract lib/pdf/reflow.ts keeps: a block's
// text, and SourceRuns that name exactly the stretches of pdf.js's runs the text came
// from — which lib/pdf/units.ts turns into ranges over the page's own glyphs.
import { describe, expect, it } from "vitest";
import type { PdfPageText, PdfTextItem, ReflowBlock } from "../../lib/pdf/reflow";
import { glyphsOf, isMathFont, structuredBlocks, type SdtBlock, type SdtStructure } from "../../lib/pdf/structured";

const WIDTH = 612;
const HEIGHT = 792;
const SIZE = 10;
/** A glyph's advance, and the width of a word space. */
const CW = 5;

interface Drawn {
  /** The string the PDF drew, as pdf.js reports it. */
  text: string;
  x: number;
  /** Baseline from the top of the page. */
  y: number;
  font?: string;
  /** The run ends in a hyphen the typesetter put there: Zotero's text drops it. */
  softHyphen?: boolean;
  /** Zotero's glyphs stand this much left of where pdf.js drew them (a folded space). */
  drift?: number;
}

/** The text run as pdf.js hands it over, and Zotero's glyph run for the same glyphs. */
function drawn(page: number, d: Drawn): { item: PdfTextItem; run: (number | number[])[] } {
  const item: PdfTextItem = { str: d.text, x: d.x, y: d.y, width: d.text.length * CW, height: SIZE, fontName: d.font ?? "f_text" };
  const x0 = d.x + (d.drift ?? 0);
  const widths: (number | number[])[] = [];
  let pendingSpace = 0;
  for (const ch of d.text) {
    if (ch === " ") { pendingSpace += CW; continue; }
    widths.push(pendingSpace ? [pendingSpace, CW] : CW);
    pendingSpace = 0;
  }
  const header = d.softHyphen ? 1 : 0;
  // PDF space: y grows upward; the glyph box reaches 2 below the baseline and 7 above.
  const run = [header, page - 1, x0, HEIGHT - d.y - 2, x0 + d.text.length * CW, HEIGHT - d.y + 7, ...(widths.length === 1 ? [] : widths)];
  return { item, run };
}

/** Zotero's text for a line: the drawn string minus a soft hyphen. */
const said = (d: Drawn): string => (d.softHyphen ? d.text.replace(/-$/, "") : d.text);

/** One text node of a block from the lines it was set on, joined as Zotero joins them:
 *  a space at a line break, none after a soft hyphen. */
function node(page: number, lines: Drawn[]): { text: string; anchor: { textMap: string }; items: PdfTextItem[] } {
  let text = "";
  const runs: (number | number[])[][] = [];
  const items: PdfTextItem[] = [];
  lines.forEach((d, i) => {
    const { item, run } = drawn(page, d);
    items.push(item);
    runs.push(run);
    text += said(d);
    if (i < lines.length - 1 && !d.softHyphen) text += " ";
  });
  return { text, anchor: { textMap: JSON.stringify(runs) }, items };
}

const pageText = (page: number, items: PdfTextItem[], fonts: Record<string, string> = {}): PdfPageText =>
  ({ page, width: WIDTH, height: HEIGHT, items, fonts });

const structure = (content: SdtBlock[], pages = 1): SdtStructure =>
  ({ catalog: { pages: Array.from({ length: pages }, () => ({ viewRect: [0, 0, WIDTH, HEIGHT] })) }, content });

const paragraph = (page: number, nodes: { text: string; anchor: { textMap: string } }[], extra: Partial<SdtBlock> = {}): SdtBlock =>
  ({ type: "paragraph", anchor: { pageRects: [[page - 1, 72, 100, 500, 700]] }, content: nodes.map(({ text, anchor }) => ({ text, anchor })), ...extra });

/** Every run of a block reads back, from pdf.js's runs, exactly the text it claims. */
function expectRunsToMatch(block: ReflowBlock, pages: PdfPageText[]): void {
  expect(block.runs.length).toBeGreaterThan(0);
  for (const run of block.runs) {
    const item = pages.find((p) => p.page === run.page)!.items[run.item];
    expect(item.str.slice(run.from, run.from + run.length)).toBe(block.text.slice(run.at, run.at + run.length));
  }
}

describe("glyphsOf", () => {
  it("gives one rect per glyph, spaces as gaps, and drops a trailing soft hyphen", () => {
    const { run } = drawn(1, { text: "ab cd-", x: 100, y: 100, softHyphen: true });
    const glyphs = glyphsOf(JSON.stringify([run]));
    expect(glyphs.map((g) => [g.x1, g.x2])).toEqual([[100, 105], [105, 110], [115, 120], [120, 125]]);
    expect(glyphs[0]).toMatchObject({ page: 0, y1: HEIGHT - 102, y2: HEIGHT - 93 });
  });

  it("uses the whole box for a single glyph, and answers nothing to a bad map", () => {
    const { run } = drawn(1, { text: "x", x: 100, y: 100 });
    expect(glyphsOf(JSON.stringify([run])).map((g) => [g.x1, g.x2])).toEqual([[100, 105]]);
    expect(glyphsOf("not json")).toEqual([]);
    expect(glyphsOf(undefined)).toEqual([]);
  });
});

describe("isMathFont", () => {
  it("knows the TeX and OpenType mathematics faces, subset tag and all", () => {
    for (const name of ["BXJUHM+CMMI10", "CMSY7", "XEQPCY+CMEX10", "MSBM10", "txsy", "LatinModernMath-Regular", "STIXTwoMath-Regular", "CambriaMath", "Symbol", "SymbolMT"]) {
      expect(isMathFont(name), name).toBe(true);
    }
  });
  it("leaves the text faces alone", () => {
    for (const name of ["UTRHDZ+CMR10", "NimbusRomNo9L-Regu", "Times-Roman", "CMBX12", "CMTI10", "Helvetica", "DejaVuSans", ""]) {
      expect(isMathFont(name), name).toBe(false);
    }
  });
});

describe("structuredBlocks — text and runs", () => {
  it("joins a paragraph's lines and maps every glyph back onto pdf.js's runs", () => {
    const n = node(1, [
      { text: "the paragraph opens on the first", x: 72, y: 100 },
      { text: "line and closes on the second.", x: 72, y: 114 },
    ]);
    const pages = [pageText(1, n.items)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("the paragraph opens on the first line and closes on the second.");
    expect(blocks[0]).toMatchObject({ kind: "paragraph", page: 1, apart: false, columnBreak: true });
    expect(blocks[0].runs).toEqual([
      { page: 1, item: 0, at: 0, length: 32, from: 0 },
      { page: 1, item: 1, at: 33, length: 30, from: 0 },
    ]);
    expectRunsToMatch(blocks[0], pages);
  });

  it("keeps a block whose page is not rendered yet, with no runs to hang it on", () => {
    const n = node(1, [{ text: "text on a page the viewer has not drawn", x: 72, y: 100 }]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), []);
    expect(blocks[0].text).toBe("text on a page the viewer has not drawn");
    expect(blocks[0].runs).toEqual([]);
  });

  it("finds a glyph that Zotero placed a folded space's width left of the run", () => {
    const head = drawn(1, { text: "Inference", x: 72, y: 100, font: "f_bold" });
    const rest = drawn(1, { text: "Uncertainty was estimated", x: 72 + 9 * CW + 10, y: 100, drift: -10 });
    const n = { text: "InferenceUncertainty was estimated", anchor: { textMap: JSON.stringify([head.run, rest.run]) } };
    const pages = [pageText(1, [head.item, rest.item])];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    // The space Zotero lost is put back: the two runs stand a word apart on the page.
    expect(blocks[0].text).toBe("Inference Uncertainty was estimated");
    expect(blocks[0].runs).toEqual([
      { page: 1, item: 0, at: 0, length: 9, from: 0 },
      { page: 1, item: 1, at: 10, length: 25, from: 0 },
    ]);
    expectRunsToMatch(blocks[0], pages);
  });

  it("finds a glyph Zotero moved left into the run before it: a formula's, or an italic word's", () => {
    // pdf.js: "lattice carrying", a space, "M" in the math face, a space, "physical modes".
    // Zotero dropped both spaces and set the glyphs after them on from where it dropped
    // them, so the "p" of "physical" stands inside the box of "M".
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "OHTAKJ+CMMI10" };
    const a = drawn(1, { text: "lattice carrying", x: 72, y: 100 });
    // A capital twice a letter's width.
    const mx = 72 + 17 * CW;
    const m: PdfTextItem = { str: "M", x: mx, y: 100, width: 2 * CW, height: SIZE, fontName: "f_math" };
    const mRun = [0, 0, mx - CW, HEIGHT - 102, mx + CW, HEIGHT - 93];
    const b = drawn(1, { text: "physical modes", x: mx + 3 * CW, y: 100, drift: -2 * CW });
    const n = { text: "lattice carryingMphysical modes", anchor: { textMap: JSON.stringify([a.run, mRun, b.run]) } };
    const pages = [pageText(1, [a.item, m, b.item], fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0].text).toBe("lattice carrying physical modes");
    expectRunsToMatch(blocks[0], pages);

    // An italic word, then a narrow "i" Zotero drew where the space was: its centre is
    // just past the end of the italic run, inside that run's slack.
    const it1 = drawn(1, { text: "contextuality", x: 72, y: 200, font: "f_italic" });
    const x0 = 72 + 13 * CW;
    const it2: PdfTextItem = { str: "is tested", x: x0 + 4, y: 200, width: 9 * CW, height: SIZE, fontName: "f_text" };
    const run2 = [0, 0, x0, HEIGHT - 202, x0 + 2.5 + 8 * CW, HEIGHT - 193, 2.5, CW, [CW, CW], CW, CW, CW, CW, CW];
    const n2 = { text: "contextualityis tested", anchor: { textMap: JSON.stringify([it1.run, run2]) } };
    const pages2 = [pageText(1, [it1.item, it2])];
    const blocks2 = structuredBlocks(structure([paragraph(1, [n2])]), pages2);
    expect(blocks2[0].text).toBe("contextuality is tested");
    expectRunsToMatch(blocks2[0], pages2);
  });

  it("puts back a space pdf.js's own run has where Zotero's text has none", () => {
    // One run on the page; Zotero dropped the spaces around a linked "II" and set the
    // glyphs after them on without the gap, so geometry alone cannot see them.
    const page = drawn(1, { text: "The paper is organized as follows. Section II presents the results", x: 72, y: 100 });
    const zotero = drawn(1, { text: "The paper is organized as follows. SectionIIpresents the results", x: 72, y: 100 });
    const n = { text: "The paper is organized as follows. SectionIIpresents the results", anchor: { textMap: JSON.stringify([zotero.run]) } };
    const pages = [pageText(1, [page.item])];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0].text).toBe("The paper is organized as follows. Section II presents the results");
    expectRunsToMatch(blocks[0], pages);
  });

  it("leaves out numeric citation marks, as the web walker does, and keeps author-year ones", () => {
    const n = node(1, [
      { text: "[1] Direct constructions span the bases [2,3]. They apply [5–7] to", x: 72, y: 100 },
      { text: "superconductors [10, 11], as Smith et al. (2020) showed in [4].", x: 72, y: 114 },
    ]);
    const pages = [pageText(1, n.items)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0].text).toBe("Direct constructions span the bases. They apply to superconductors, as Smith et al. (2020) showed in.");
    expectRunsToMatch(blocks[0], pages);
  });

  it("puts a space between two glyphs a word apart that Zotero ran together", () => {
    const a = drawn(1, { text: "where", x: 72, y: 100 });
    const b = drawn(1, { text: "the", x: 72 + 5 * CW + 6, y: 100 });
    const n = { text: "wherethe", anchor: { textMap: JSON.stringify([a.run, b.run]) } };
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, [a.item, b.item])]);
    expect(blocks[0].text).toBe("where the");
  });
});

describe("structuredBlocks — hyphens at line ends", () => {
  it("mends a syllable break and keeps a compound's own hyphen, by the document's usage", () => {
    const n = node(1, [
      { text: "a word broken by the typesetter into hyphen-", x: 72, y: 100, softHyphen: true },
      { text: "ation is mended, while a compound such as state-of-the-", x: 72, y: 114, softHyphen: true },
      { text: "art keeps the hyphen it was written with.", x: 72, y: 128 },
    ]);
    // Zotero joined both without a hyphen.
    expect(n.text).toContain("hyphenation");
    expect(n.text).toContain("state-of-theart");
    const pages = [pageText(1, n.items)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0].text).toBe("a word broken by the typesetter into hyphenation is mended, while a compound such as state-of-the-art keeps the hyphen it was written with.");
    // The kept hyphen is the run's own glyph, so a highlight over it is a highlight over the page.
    expectRunsToMatch(blocks[0], pages);
    const hyphenAt = blocks[0].text.indexOf("the-art") + 3;
    const run = blocks[0].runs.find((r) => r.at <= hyphenAt && hyphenAt < r.at + r.length)!;
    expect(pages[0].items[run.item].str[run.from + hyphenAt - run.at]).toBe("-");
  });

  it("keeps a hyphen the document itself writes ('in-depth') and mends one it writes fused", () => {
    const n = node(1, [
      { text: "an in-depth study, then in-", x: 72, y: 100, softHyphen: true },
      { text: "depth again; a nonlinear model, and non-", x: 72, y: 114, softHyphen: true },
      { text: "linear again.", x: 72, y: 128 },
    ]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, n.items)]);
    expect(blocks[0].text).toBe("an in-depth study, then in-depth again; a nonlinear model, and nonlinear again.");
  });
});

describe("structuredBlocks — formulas", () => {
  it("leaves out the glyphs in a mathematics font and the symbols set beside them", () => {
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10", f_cmr: "UTRHDZ+CMR10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let x = 72;
    const put = (text: string, font: string, gap = CW) => {
      const d = drawn(1, { text, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      x += text.length * CW + gap;
    };
    put("where", "f_text");
    put("r", "f_math");
    put("is the value of", "f_text");
    put("(", "f_cmr", 0);
    put("x", "f_math", 0);
    put(")", "f_cmr");
    put("+ 0.5 in the", "f_text");
    const text = "where r is the value of (x) + 0.5 in the";
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    // "+ 0.5" goes with the formula: letterless, on its line, and TeX sets the operators
    // and digits of a formula in the text face with word-sized spaces around them.
    expect(blocks[0].text).toBe("where is the value of in the");
    expectRunsToMatch(blocks[0], pages);
  });

  it("keeps the full stop and the comma that close a formula, as arXiv's HTML does", () => {
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10", f_cmr: "UTRHDZ+CMR10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let x = 72;
    const put = (text: string, font: string, gap = CW) => {
      const d = drawn(1, { text, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      x += text.length * CW + gap;
    };
    put("the value of", "f_text");
    put("x", "f_math", 0);
    put(",", "f_cmr");
    put("then of", "f_text");
    put("y", "f_math", 0);
    put("= 1.5.", "f_cmr");
    put("The next", "f_text");
    const n = { text: "the value of x, then of y = 1.5. The next", anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0].text).toBe("the value of, then of. The next");
    expectRunsToMatch(blocks[0], pages);
  });

  it("leaves out a formula's letter that pdf.js spells otherwise, by the face it is set in", () => {
    // Zotero reads a "ψ" where pdf.js's run of the mathematics face holds another code
    // point (a font without a Unicode map): the glyph is in no run's string.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "OHTAKJ+CMMI10" };
    const a = drawn(1, { text: "which determines", x: 72, y: 100 });
    const m: PdfTextItem = { str: "", x: 72 + 17 * CW, y: 100, width: CW, height: SIZE, fontName: "f_math" };
    const mRun = drawn(1, { text: "ψ", x: 72 + 17 * CW, y: 100 }).run;
    const b = drawn(1, { text: "entirely.", x: 72 + 19 * CW, y: 100 });
    const n = { text: "which determines ψ entirely.", anchor: { textMap: JSON.stringify([a.run, mRun, b.run]) } };
    const pages = [pageText(1, [a.item, m, b.item], fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0].text).toBe("which determines entirely.");
    expectRunsToMatch(blocks[0], pages);
  });

  it("changes nothing in a document with no mathematics face", () => {
    const n = node(1, [{ text: "a plain sentence with x = 5 and (2 + 0.5) in it.", x: 72, y: 100 }]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, n.items, { f_text: "Calibri" })]);
    expect(blocks[0].text).toBe("a plain sentence with x = 5 and (2 + 0.5) in it.");
  });
});

describe("structuredBlocks — the document", () => {
  it("reads body paragraphs, list items and headings; not what Zotero set aside", () => {
    const head = node(1, [{ text: "1 Introduction", x: 72, y: 80 }]);
    const body = node(1, [{ text: "the body paragraph.", x: 72, y: 100 }]);
    const caption = node(1, [{ text: "Figure 1: a caption.", x: 72, y: 300 }]);
    const note = node(1, [{ text: "a footnote.", x: 72, y: 700 }]);
    const running = node(1, [{ text: "Preprint.", x: 72, y: 760 }]);
    const item = node(1, [{ text: "• an item of a list.", x: 90, y: 130 }]);
    const ref = node(1, [{ text: "[1] A. Author. A paper. 2020.", x: 72, y: 500 }]);
    const pages = [pageText(1, [...head.items, ...body.items, ...caption.items, ...note.items, ...running.items, ...item.items, ...ref.items])];
    const blocks = structuredBlocks(structure([
      { type: "heading", anchor: { pageRects: [[0, 72, 700, 300, 712]] }, content: [head] },
      paragraph(1, [body]),
      { type: "caption", anchor: { pageRects: [[0, 72, 480, 300, 492]] }, content: [caption], flowClass: "auxiliary" },
      { type: "list", anchor: { pageRects: [[0, 90, 650, 300, 662]] }, content: [{ type: "listitem", anchor: { pageRects: [[0, 90, 650, 300, 662]] }, content: [item] }] },
      { type: "note", anchor: { pageRects: [[0, 72, 80, 300, 92]] }, content: [note], flowClass: "auxiliary" },
      paragraph(1, [running], { flowClass: "excluded" }),
      paragraph(1, [ref], { reference: true }),
    ]), pages);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["heading", "1 Introduction"],
      ["paragraph", "the body paragraph."],
      ["paragraph", "• an item of a list."],
    ]);
    for (const b of blocks) expectRunsToMatch(b, pages);
  });

  it("makes a paragraph carried over a page one block, with runs on both pages", () => {
    const first = node(1, [{ text: "the paragraph begins on one page and", x: 72, y: 700 }]);
    const second = node(2, [{ text: "ends on the next.", x: 72, y: 80 }]);
    const pages = [pageText(1, first.items), pageText(2, second.items)];
    const blocks = structuredBlocks(structure([
      paragraph(1, [first], { nextPart: [1] }),
      paragraph(2, [second], { previousPart: [0] }),
    ], 2), pages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("the paragraph begins on one page and ends on the next.");
    expect(blocks[0].runs.map((r) => r.page)).toEqual([1, 2]);
    expectRunsToMatch(blocks[0], pages);
  });

  it("marks a break after a bibliography entry and at a new page, and none at an equation", () => {
    const a = node(1, [{ text: "first paragraph.", x: 72, y: 100 }]);
    const b = node(1, [{ text: "second paragraph.", x: 72, y: 130 }]);
    const eq = node(1, [{ text: "E = mc2", x: 200, y: 160 }]);
    const c = node(1, [{ text: "Third paragraph.", x: 72, y: 190 }]);
    const ref = node(1, [{ text: "[1] A. Author. A paper. 2020.", x: 72, y: 500 }]);
    const d = node(1, [{ text: "an appendix paragraph.", x: 72, y: 530 }]);
    const e = node(2, [{ text: "over the page.", x: 72, y: 100 }]);
    const pages = [pageText(1, [...a.items, ...b.items, ...eq.items, ...c.items, ...ref.items, ...d.items]), pageText(2, e.items)];
    const blocks = structuredBlocks(structure([
      paragraph(1, [a]), paragraph(1, [b]),
      { type: "math", anchor: { pageRects: [[0, 200, 620, 300, 632]] }, content: [eq], flowClass: "auxiliary" },
      paragraph(1, [c]),
      paragraph(1, [ref], { reference: true }),
      paragraph(1, [d]), paragraph(2, [e]),
    ], 2), pages);
    expect(blocks.map((x) => x.text)).toEqual(["first paragraph.", "second paragraph.", "Third paragraph.", "an appendix paragraph.", "over the page."]);
    expect(blocks.map((x) => x.columnBreak)).toEqual([true, false, false, true, true]);
  });

  it("carries a paragraph on across a display equation when the sentence runs on", () => {
    const a = node(1, [{ text: "the loss is defined as", x: 72, y: 100 }]);
    const eq = node(1, [{ text: "L = 1", x: 200, y: 130 }]);
    const b = node(1, [{ text: "where the sum runs over all examples.", x: 72, y: 160 }]);
    const c = node(1, [{ text: "The next paragraph stands alone.", x: 72, y: 190 }]);
    const pages = [pageText(1, [...a.items, ...eq.items, ...b.items, ...c.items])];
    const blocks = structuredBlocks(structure([
      paragraph(1, [a]),
      { type: "math", anchor: { pageRects: [[0, 200, 650, 300, 662]] }, content: [eq], flowClass: "auxiliary" },
      paragraph(1, [b]), paragraph(1, [c]),
    ]), pages);
    expect(blocks.map((x) => x.text)).toEqual(["the loss is defined as where the sum runs over all examples.", "The next paragraph stands alone."]);
    for (const x of blocks) expectRunsToMatch(x, pages);
  });
});
