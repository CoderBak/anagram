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
import { glyphsOf, isMathFont, structuredBlocks, type SdtBlock, type SdtStructure, type SdtTextNode } from "../../lib/pdf/structured";
import { groupsOf } from "../../lib/pdf/units";

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
  /** The size it is set in: pdf.js's run height, and the height of Zotero's glyph boxes. */
  size?: number;
}

/** The text run as pdf.js hands it over, and Zotero's glyph run for the same glyphs. */
function drawn(page: number, d: Drawn): { item: PdfTextItem; run: (number | number[])[] } {
  const size = d.size ?? SIZE;
  const item: PdfTextItem = { str: d.text, x: d.x, y: d.y, width: d.text.length * CW, height: size, fontName: d.font ?? "f_text" };
  const x0 = d.x + (d.drift ?? 0);
  const widths: (number | number[])[] = [];
  let pendingSpace = 0;
  for (const ch of d.text) {
    if (ch === " ") { pendingSpace += CW; continue; }
    widths.push(pendingSpace ? [pendingSpace, CW] : CW);
    pendingSpace = 0;
  }
  const header = d.softHyphen ? 1 : 0;
  // PDF space: y grows upward; the glyph box reaches a fifth of the size below the baseline
  // and seven tenths above.
  const run = [header, page - 1, x0, HEIGHT - d.y - 0.2 * size, x0 + d.text.length * CW, HEIGHT - d.y + 0.7 * size, ...(widths.length === 1 ? [] : widths)];
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

/**
 * One line set run by run, as TeX sets a sentence with a formula in it: each run in its face
 * and size (a smaller one a little below the line, a script), `gap` after it — a word space
 * when it is CW. Zotero's text has a space wherever there is a gap. `read` is the one block's
 * text, its runs checked against pdf.js's.
 */
function setLine(fonts: Record<string, string>): { put(s: string, font: string, gap?: number, size?: number): void; read(): string } {
  const items: PdfTextItem[] = [];
  const runs: (number | number[])[][] = [];
  let text = "";
  let x = 72;
  return {
    put(s, font, gap = CW, size = SIZE) {
      const d = drawn(1, { text: s, x, y: size < SIZE ? 102 : 100, font, size });
      items.push(d.item);
      runs.push(d.run);
      text += s + (gap ? " " : "");
      x += s.length * CW + gap;
    },
    read() {
      const n = { text, anchor: { textMap: JSON.stringify(runs) } };
      const pages = [pageText(1, items, fonts)];
      const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
      expectRunsToMatch(blocks[0]!, pages);
      return blocks[0]!.text;
    },
  };
}

/** Every run of a block reads back, from pdf.js's runs, exactly the text it claims. */
function expectRunsToMatch(block: ReflowBlock, pages: PdfPageText[]): void {
  expect(block.runs.length).toBeGreaterThan(0);
  for (const run of block.runs) {
    const item = pages.find((p) => p.page === run.page)!.items[run.item]!;
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
    for (const name of ["BXJUHM+CMMI10", "CMSY7", "XEQPCY+CMEX10", "MSBM10", "txsy", "LatinModernMath-Regular", "STIXTwoMath-Regular", "CambriaMath", "Symbol", "SymbolMT",
      // mathabx, MnSymbol, kpfonts, the MLM build of Latin Modern, txfonts, newtx's alternative
      // math faces, fdsymbol, doublestroke, bbold, esint, URW's Symbol, mathpazo, cmbright.
      "QJDHKG+TeX-matha10", "TeX-mathx10", "MnSymbol10", "Kp--M-Italic", "Kp--M-Sy-Regular", "UASACH+MLMMathItalic10-Regular",
      "MLMMathSymbols8-Regular", "rtxmi", "LibertineMathMI7", "XCharterMathMI", "FdSymbolA-Book", "XMDXUT+dsrom10", "BBOLD10",
      "esint10", "StandardSymL-Slant_167", "PazoMath-Italic", "HFBRMI10", "HFBRSY10"]) {
      expect(isMathFont(name), name).toBe(true);
    }
  });
  it("leaves the text faces alone", () => {
    for (const name of ["UTRHDZ+CMR10", "NimbusRomNo9L-Regu", "Times-Roman", "CMBX12", "CMTI10", "Helvetica", "DejaVuSans", "",
      "MLMRoman10-Regular", "rtxr", "Kp-Regular", "LinLibertineT", "URWPalladioL-Roma", "SFRM1000"]) {
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
    expect(blocks[0]!.text).toBe("the paragraph opens on the first line and closes on the second.");
    expect(blocks[0]).toMatchObject({ kind: "paragraph", page: 1, apart: false, columnBreak: true });
    expect(blocks[0]!.runs).toEqual([
      { page: 1, item: 0, at: 0, length: 32, from: 0 },
      { page: 1, item: 1, at: 33, length: 30, from: 0 },
    ]);
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("keeps a block whose page is not rendered yet, with no runs to hang it on", () => {
    const n = node(1, [{ text: "text on a page the viewer has not drawn", x: 72, y: 100 }]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), []);
    expect(blocks[0]!.text).toBe("text on a page the viewer has not drawn");
    expect(blocks[0]!.runs).toEqual([]);
  });

  it("finds a glyph that Zotero placed a folded space's width left of the run", () => {
    const head = drawn(1, { text: "Inference", x: 72, y: 100, font: "f_bold" });
    const rest = drawn(1, { text: "Uncertainty was estimated", x: 72 + 9 * CW + 10, y: 100, drift: -10 });
    const n = { text: "InferenceUncertainty was estimated", anchor: { textMap: JSON.stringify([head.run, rest.run]) } };
    const pages = [pageText(1, [head.item, rest.item])];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    // The space Zotero lost is put back: the two runs stand a word apart on the page.
    expect(blocks[0]!.text).toBe("Inference Uncertainty was estimated");
    expect(blocks[0]!.runs).toEqual([
      { page: 1, item: 0, at: 0, length: 9, from: 0 },
      { page: 1, item: 1, at: 10, length: 25, from: 0 },
    ]);
    expectRunsToMatch(blocks[0]!, pages);
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
    expect(blocks[0]!.text).toBe("lattice carrying physical modes");
    expectRunsToMatch(blocks[0]!, pages);

    // An italic word, then a narrow "i" Zotero drew where the space was: its centre is
    // just past the end of the italic run, inside that run's slack.
    const it1 = drawn(1, { text: "contextuality", x: 72, y: 200, font: "f_italic" });
    const x0 = 72 + 13 * CW;
    const it2: PdfTextItem = { str: "is tested", x: x0 + 4, y: 200, width: 9 * CW, height: SIZE, fontName: "f_text" };
    const run2 = [0, 0, x0, HEIGHT - 202, x0 + 2.5 + 8 * CW, HEIGHT - 193, 2.5, CW, [CW, CW], CW, CW, CW, CW, CW];
    const n2 = { text: "contextualityis tested", anchor: { textMap: JSON.stringify([it1.run, run2]) } };
    const pages2 = [pageText(1, [it1.item, it2])];
    const blocks2 = structuredBlocks(structure([paragraph(1, [n2])]), pages2);
    expect(blocks2[0]!.text).toBe("contextuality is tested");
    expectRunsToMatch(blocks2[0]!, pages2);
  });

  it("puts back a space pdf.js's own run has where Zotero's text has none", () => {
    // One run on the page; Zotero dropped the spaces around a linked "II" and set the
    // glyphs after them on without the gap, so geometry alone cannot see them.
    const page = drawn(1, { text: "The paper is organized as follows. Section II presents the results", x: 72, y: 100 });
    const zotero = drawn(1, { text: "The paper is organized as follows. SectionIIpresents the results", x: 72, y: 100 });
    const n = { text: "The paper is organized as follows. SectionIIpresents the results", anchor: { textMap: JSON.stringify([zotero.run]) } };
    const pages = [pageText(1, [page.item])];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("The paper is organized as follows. Section II presents the results");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out numeric citation marks, as the web walker does, and keeps author-year ones", () => {
    const n = node(1, [
      { text: "[1] Direct constructions span the bases [2,3]. They apply [5–7] to", x: 72, y: 100 },
      { text: "superconductors [10, 11], as Smith et al. (2020) showed in [4].", x: 72, y: 114 },
    ]);
    const pages = [pageText(1, n.items)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("Direct constructions span the bases. They apply to superconductors, as Smith et al. (2020) showed in.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out a run of citation marks as IEEE's style sets it, as one", () => {
    const n = node(1, [
      { text: "Related work generates programs [19], [20], geometric constraints", x: 72, y: 100 },
      { text: "[21]–[23], and rewards [24].", x: 72, y: 114 },
    ]);
    const pages = [pageText(1, n.items)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("Related work generates programs, geometric constraints, and rewards.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out a bracketed mark with a locator or an alphabetic key, and keeps brackets that are words", () => {
    // arXiv's HTML marks each of these as a citation, and the web walker skips it; a year
    // makes one author-year, and a bracket with no reference in it is the writer's own.
    const n = node(1, [
      { text: "As Kahn and Szemerédi [16, Section 4] showed [e.g., 17, 18], the bound [And58] holds", x: 72, y: 100 },
      { text: "[Kir08, Theorem 3.9; GK12]; it [sic] is known [Higham, 2002] and [see Section 3].", x: 72, y: 114 },
    ]);
    const pages = [pageText(1, n.items)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("As Kahn and Szemerédi showed, the bound holds; it [sic] is known [Higham, 2002] and [see Section 3].");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out a superscript number that refers to the bibliography after a word, and keeps exponents", () => {
    // Nature's style sets a citation as a raised number after the word, and Zotero links it
    // to the bibliography entries it names; arXiv's HTML skips it as a mark. Zotero links an
    // exponent to an entry of the same number too, but an exponent follows a unit or a
    // formula's letter, not a word.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10" };
    const items: PdfTextItem[] = [];
    const nodes: SdtTextNode[] = [];
    let x = 72;
    /** A run of the line, and Zotero's node for it: `gap` word spaces before it. */
    const put = (text: string, { gap = 0, raised = false, refs, font = "f_text" }: { gap?: number; raised?: boolean; refs?: number[][]; font?: string } = {}) => {
      x += gap * CW;
      const d = drawn(1, { text, x, y: raised ? 96 : 100, font });
      if (raised) d.item.height = 7;
      items.push(d.item);
      if (gap) nodes.push({ text: " " });
      nodes.push({ text, anchor: { textMap: JSON.stringify([d.run]) }, ...(raised ? { style: { sup: true } } : {}), ...(refs ? { refs } : {}) });
      x += text.length * CW;
    };
    const entry = [[1, 1]];
    put("learn through prediction errors");
    put("1–4", { raised: true, refs: [[1, 0], [1, 1]] });
    put("over an area of 5 cm", { gap: 1 });
    put("2", { raised: true, refs: entry });
    put("of the variance", { gap: 1 });
    put("σ", { gap: 1, font: "f_math" });
    put("2", { raised: true, refs: entry });
    put("as Dunne", { gap: 1 });
    put("2", { gap: 1, raised: true, refs: entry });
    put("found in two forms", { gap: 1 });
    put("1", { raised: true, refs: [[1, 0]] });
    put(",");
    put("2", { raised: true, refs: entry });
    put(".");
    const bibliography: SdtBlock = { type: "list", content: [{ type: "listitem", reference: true, content: [] }, { type: "listitem", reference: true, content: [] }] };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([{ type: "paragraph", content: nodes }, bibliography]), pages);
    expect(blocks[0]!.text).toBe("learn through prediction errors over an area of 5 cm2 of the variance as Dunne found in two forms.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("closes up the space a mark left out leaves before punctuation, and keeps the author's own", () => {
    const items: PdfTextItem[] = [];
    const nodes: SdtTextNode[] = [];
    let x = 72;
    const put = (text: string, { gap = 0, raised = false }: { gap?: number; raised?: boolean } = {}) => {
      x += gap * CW;
      const d = drawn(1, { text, x, y: raised ? 96 : 100 });
      if (raised) d.item.height = 7;
      items.push(d.item);
      if (gap) nodes.push({ text: " " });
      nodes.push({ text, anchor: { textMap: JSON.stringify([d.run]) }, ...(raised ? { style: { sup: true }, refs: [[1, 0]] } : {}) });
      x += text.length * CW;
    };
    put("as reported by Dunne");
    put("46", { gap: 1, raised: true });
    put(".");
    put("It spans the bases [4] , and a word", { gap: 1 });
    put(".", { gap: 1 });
    const bibliography: SdtBlock = { type: "list", content: [{ type: "listitem", reference: true, content: [] }] };
    const pages = [pageText(1, items, { f_text: "NimbusRomNo9L-Regu" })];
    const blocks = structuredBlocks(structure([{ type: "paragraph", content: nodes }, bibliography]), pages);
    expect(blocks[0]!.text).toBe("as reported by Dunne. It spans the bases, and a word .");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("puts a space between two glyphs a word apart that Zotero ran together", () => {
    const a = drawn(1, { text: "where", x: 72, y: 100 });
    const b = drawn(1, { text: "the", x: 72 + 5 * CW + 6, y: 100 });
    const n = { text: "wherethe", anchor: { textMap: JSON.stringify([a.run, b.run]) } };
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, [a.item, b.item])]);
    expect(blocks[0]!.text).toBe("where the");
  });
});

describe("structuredBlocks — accented letters", () => {
  it("writes a letter and its accent as one character, the accent on the letter it is drawn over", () => {
    // pdf.js keeps TeX's accent as a glyph of its own before the letter ("Alfv´en"); Zotero
    // reads it as a combining mark but can put it past the letter ("Alfven´"), or after the
    // next one when the letter is a dotless ı ("Garcıá"). Each word is one run on the page.
    const words: [string, string][] = [["the", "the"], ["Alfv´en", "Alfveń"], ["speed,", "speed,"], ["as", "as"],
      ["Garcı´a", "Garcıá"], ["and", "and"], ["Le´vy", "Lévy"], ["found.", "found."]];
    /** Which letter of the word the accent is drawn over. */
    const over: Record<string, number> = { "Alfveń": 4, "Garcıá": 4, "Lévy": 1 };
    const items: PdfTextItem[] = [];
    const spans: [number, number][] = [];
    let x = 72;
    for (const [drawnAs, read] of words) {
      const letters = [...read].filter((c) => !/\p{M}/u.test(c)).length;
      items.push({ str: drawnAs, x, y: 100, width: letters * CW, height: SIZE, fontName: "f_text" });
      let k = 0;
      for (const c of read) {
        if (/\p{M}/u.test(c)) spans.push([x + over[read]! * CW + 0.5, x + over[read]! * CW + CW - 0.5]);
        else spans.push([x + k * CW, x + ++k * CW]);
      }
      x += (letters + 1) * CW;
    }
    // One glyph run for the line: each glyph's box as a [gap, width] from the one before.
    const widths: (number | number[])[] = [];
    let pos = spans[0]![0];
    for (const [a, b] of spans) {
      widths.push(a === pos ? b - a : [a - pos, b - a]);
      pos = b;
    }
    const n = { text: words.map(([, read]) => read).join(" "), anchor: { textMap: JSON.stringify([[0, 0, spans[0]![0], HEIGHT - 102, pos, HEIGHT - 93, ...widths]]) } };
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, items)]);
    expect(blocks[0]!.text).toBe("the Alfvén speed, as García and Lévy found.");
    // The accented letter is found where its letter is: a highlight over the word covers it.
    for (const word of ["Alfvén", "García", "Lévy"]) {
      const at = blocks[0]!.text.indexOf(word);
      let covered = 0;
      for (const r of blocks[0]!.runs) covered += Math.max(0, Math.min(r.at + r.length, at + word.length) - Math.max(r.at, at));
      expect(covered, word).toBe(word.length);
    }
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
    expect(blocks[0]!.text).toBe("a word broken by the typesetter into hyphenation is mended, while a compound such as state-of-the-art keeps the hyphen it was written with.");
    // The kept hyphen is the run's own glyph, so a highlight over it is a highlight over the page.
    expectRunsToMatch(blocks[0]!, pages);
    const hyphenAt = blocks[0]!.text.indexOf("the-art") + 3;
    const run = blocks[0]!.runs.find((r) => r.at <= hyphenAt && hyphenAt < r.at + r.length)!;
    expect(pages[0]!.items[run.item]!.str[run.from + hyphenAt - run.at]).toBe("-");
  });

  it("keeps a hyphen the document itself writes ('in-depth') and mends one it writes fused", () => {
    const n = node(1, [
      { text: "an in-depth study, then in-", x: 72, y: 100, softHyphen: true },
      { text: "depth again; a nonlinear model, and non-", x: 72, y: 114, softHyphen: true },
      { text: "linear again.", x: 72, y: 128 },
    ]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, n.items)]);
    expect(blocks[0]!.text).toBe("an in-depth study, then in-depth again; a nonlinear model, and nonlinear again.");
  });

  it("does not count a word Zotero mended at a line end as the document writing it fused", () => {
    // Zotero's text reads "nearequilibrium" and "selfattention": the document never wrote
    // them so, and a compound whose first element it writes with a hyphen ("near-optimal"),
    // or that the rule keeps ("self-"), keeps its hyphen.
    const n = node(1, [
      { text: "we train a near-optimal policy in the near-", x: 72, y: 100, softHyphen: true },
      { text: "equilibrium regime, with a self-", x: 72, y: 114, softHyphen: true },
      { text: "attention layer and a hyphen-", x: 72, y: 128, softHyphen: true },
      { text: "ated word.", x: 72, y: 142 },
    ]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, n.items)]);
    expect(blocks[0]!.text).toBe("we train a near-optimal policy in the near-equilibrium regime, with a self-attention layer and a hyphenated word.");
  });

  it("mends a word broken after an opening bracket", () => {
    const n = node(1, [
      { text: "the counts (Ta-", x: 72, y: 100, softHyphen: true },
      { text: "ble 1) and the “fig-", x: 72, y: 114, softHyphen: true },
      { text: "ure” differ.", x: 72, y: 128 },
    ]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, n.items)]);
    expect(blocks[0]!.text).toBe("the counts (Table 1) and the “figure” differ.");
  });

  it("decides the hyphen that ends one part of a paragraph by the document's usage too", () => {
    // A paragraph carried over a page is no more the document writing "finitesample" than
    // a line break is. It writes "finite-dimensional", so "finite-" keeps its hyphen there,
    // and "posi-" does not.
    const a = node(1, [{ text: "a finite-dimensional bound holds in the finite-", x: 72, y: 700 }]);
    const b = node(2, [{ text: "sample case, and is posi-", x: 72, y: 80 }]);
    const c = node(3, [{ text: "tive.", x: 72, y: 80 }]);
    const pages = [pageText(1, a.items), pageText(2, b.items), pageText(3, c.items)];
    const blocks = structuredBlocks(structure([
      paragraph(1, [a], { nextPart: [1] }),
      paragraph(2, [b], { previousPart: [0], nextPart: [2] }),
      paragraph(3, [c], { previousPart: [1] }),
    ], 3), pages);
    expect(blocks[0]!.text).toBe("a finite-dimensional bound holds in the finite-sample case, and is positive.");
    expectRunsToMatch(blocks[0]!, pages);
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
    // TeX sets the decimal point of a formula in its mathematics face.
    put("+ 0", "f_cmr", 0);
    put(".", "f_math", 0);
    put("5", "f_cmr");
    put("in the", "f_text");
    const text = "where r is the value of (x) + 0.5 in the";
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    // "+ 0.5" goes with the formula: letterless, on its line, and TeX sets the operators
    // and digits of a formula in the text face with word-sized spaces around them.
    expect(blocks[0]!.text).toBe("where is the value of in the");
    expectRunsToMatch(blocks[0]!, pages);
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
    put("= 1", "f_cmr", 0);
    put(".", "f_math", 0);
    put("5.", "f_cmr");
    put("The next", "f_text");
    const n = { text: "the value of x, then of y = 1.5. The next", anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("the value of, then of. The next");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("closes up the space a formula left out leaves before punctuation, as the web walker does", () => {
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let x = 72;
    const put = (text: string, font: string) => {
      const d = drawn(1, { text, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      x += text.length * CW + CW;
    };
    put("it holds for x", "f_text");
    put("f", "f_math");
    put(". A word", "f_text");
    put(".", "f_text");
    const n = { text: "it holds for x f . A word .", anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("it holds for x. A word .");
    expectRunsToMatch(blocks[0]!, pages);
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
    expect(blocks[0]!.text).toBe("which determines entirely.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out what TeX sets of a formula in the text face: operator names, capital Greek, sub- and superscripts", () => {
    // "\sup \Gamma(\Delta)", "\log p", "x_{\mathrm{init}}": TeX takes the operator names,
    // the upright capital Greek and the letters of \mathrm from the text face, so only the
    // face of their neighbours says they are mathematics. The same word in the sentence stays.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10", f_cmr: "UTRHDZ+CMR10", f_cmr7: "UTRHDZ+CMR7" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let x = 72;
    const put = (text: string, font: string, gap = CW, size = SIZE) => {
      const d = drawn(1, { text, x, y: 100, font, size });
      items.push(d.item);
      runs.push(d.run);
      x += text.length * CW + gap;
    };
    put("the bound", "f_text");
    put("sup", "f_cmr", 2);
    put("Γ(∆)", "f_cmr");
    put("is finite, and", "f_text");
    put("log", "f_cmr", 2);
    put("p", "f_math");
    put("is the score of", "f_text");
    put("x", "f_math", 0);
    put("init", "f_cmr7", CW, 7);
    put("in the log of the data.", "f_text");
    const text = "the bound sup Γ(∆) is finite, and log p is the score of xinit in the log of the data.";
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("the bound is finite, and is the score of in the log of the data.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("keeps a number the text writes beside a formula, as arXiv's HTML does", () => {
    // TeX sets a formula's decimal point and comma in its mathematics face, so a number
    // whose point or comma is in the text face is the text's ("11.3 $\mu$m"), and so is one
    // that ends its clause before the formula starts ("Theorem 2, $x$").
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let x = 72;
    const put = (text: string, font: string, gap = CW) => {
      const d = drawn(1, { text, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      x += text.length * CW + gap;
    };
    put("the pores are 11.3", "f_text");
    put("µ", "f_math", 0);
    put("m wide, and by Theorem 2,", "f_text");
    put("x", "f_math");
    put("is bounded by 1,024", "f_text");
    put("n", "f_math", 0);
    put(".", "f_text");
    const n = { text: "the pores are 11.3 µm wide, and by Theorem 2, x is bounded by 1,024 n.", anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("the pores are 11.3 m wide, and by Theorem 2, is bounded by 1,024.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out the characters BabelDOC takes for a formula's in any face: operators, Greek, stray accents", () => {
    // TeX sets the "=" of "$18 = 324$" and the Λ of "$\Lambda$CDM" in the text face, and
    // Zotero runs a formula's letter or accent into the word before it when no run of
    // pdf.js spells it ("Thusθ", "that̄"). A typewriter face is code; a symbol TeX would
    // have drawn from a mathematics face was typed ("×", "α"), and so was an operator with
    // no space around it ("J1351+0039"); "C++", "μm" and "Müller" are words, and a μ after a
    // number is a unit's whatever pdf.js makes of it.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10", f_cmr: "UTRHDZ+CMR10", f_tt: "NimbusMonL-Regu" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let text = "";
    let x = 72;
    const put = (s: string, font: string, gap = CW) => {
      const d = drawn(1, { text: s, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      text += s + (gap ? " " : "");
      x += s.length * CW + gap;
    };
    /** A glyph Zotero reads that no run of pdf.js holds: a formula's letter or accent. */
    const lone = (ch: string, at: number) => {
      runs.push([0, 0, at, HEIGHT - 102, at + CW, HEIGHT - 93]);
      text += ch;
    };
    put("so all", "f_text");
    put("18", "f_cmr");
    put("=", "f_cmr");
    put("324", "f_cmr");
    put("pairs of", "f_text");
    put("ΛCDM", "f_text");
    put("fits of J1351+0039 on 2048 × 2048 pixels of an α-helix run in", "f_text");
    put("C++", "f_text");
    put("with", "f_text");
    put("seed + 1", "f_tt");
    put("at 5", "f_text");
    put("μm, or 5–14", "f_text", 0);
    lone("μ", x);
    text += " ";
    x += 2 * CW;
    put("m,", "f_text");
    put("where", "f_text");
    put("x", "f_math");
    put("is small.", "f_text");
    put("Thus", "f_text", 0);
    lone("θ", x);
    text += " ";
    x += 2 * CW;
    put("is fixed, and", "f_text");
    put("that", "f_text", 0);
    lone("̄", x - CW);
    text += " ";
    x += CW;
    put("ε", "f_math");
    put("holds for Müller.", "f_text");
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("so all pairs of CDM fits of J1351+0039 on 2048 × 2048 pixels of an α-helix run in C++ with seed + 1 at 5 μm, or 5–14μ m, where is small. Thus is fixed, and that holds for Müller.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out a letter set alone in a bold face: \\mathbf", () => {
    // "\mathbf{h}" and "\mathbf{J}_0" are set in a bold face the words around them are not set
    // in. A phrase in that face ("Part A") is the text's, and so are a label ("(A1)", "(B)",
    // "Appendix C") and an italic letter, which is the writer's \textit as often as a
    // formula's.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_bold: "CMBX10", f_bold7: "CMR7", f_medi: "NimbusRomNo9L-Medi", f_ital: "NimbusRomNo9L-ReguItal", f_sy: "CMSY10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let text = "";
    let x = 72;
    const put = (s: string, font: string, gap = CW, size = SIZE) => {
      const d = drawn(1, { text: s, x, y: size < SIZE ? 102 : 100, font, size });
      items.push(d.item);
      runs.push(d.run);
      text += s + (gap ? " " : "");
      x += s.length * CW + gap;
    };
    put("Let", "f_text");
    put("h", "f_bold");
    put("denote the state and", "f_text");
    put("(v", "f_bold", 0);
    put(",", "f_sy");
    put("u)", "f_bold");
    put("the readouts,", "f_text");
    put("J", "f_bold", 0);
    put("0", "f_bold7", CW, 7);
    put("the matrix, and", "f_text");
    put("R", "f_ital");
    put("the ratio, as in", "f_text");
    put("Part A", "f_medi");
    put("under", "f_text");
    put("(A1)", "f_medi");
    put("and", "f_text");
    put("(B)", "f_medi");
    put("of Appendix", "f_text");
    put("C", "f_medi");
    put("with a", "f_text");
    put("b", "f_text");
    put("side.", "f_text");
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("Let denote the state and the readouts, the matrix, and R the ratio, as in Part A under (A1) and (B) of Appendix C with a b side.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out what is set in a face the page uses only for formulas", () => {
    // A paper set in Times takes "$300$", "\mathrm{km}" and "\operatorname{var}(" from
    // Computer Modern, which sets no words of the text. A word of its own in that face stays
    // ("otherwise"), and so do the Times italic of "et al.", a sans-serif heading word and
    // code in a typewriter face.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_cmr: "UTRHDZ+CMR10", f_math: "BXJUHM+CMMI10", f_sans: "NimbusSanL-Bold", f_tt: "NimbusMonL-Regu", f_ital: "NimbusRomNo9L-ReguItal" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let text = "";
    let x = 72;
    const put = (s: string, font: string, gap = CW) => {
      const d = drawn(1, { text: s, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      text += s + (gap ? " " : "");
      x += s.length * CW + gap;
    };
    put("We train the network for up to", "f_text");
    put("300", "f_cmr");
    put("epochs at", "f_text");
    put("5", "f_cmr");
    put("km", "f_cmr");
    put("per second, keeping", "f_text");
    put("var(", "f_cmr", 0);
    put("x", "f_math", 0);
    put(")", "f_cmr");
    put("bounded, as the", "f_text");
    put("Results", "f_sans");
    put("section shows;", "f_text");
    put("lr", "f_tt");
    put("is tuned, and", "f_text");
    put("otherwise", "f_cmr");
    put("the", "f_text");
    put("et al.", "f_ital");
    put("method holds.", "f_text");
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("We train the network for up to epochs at per second, keeping bounded, as the Results section shows; lr is tuned, and otherwise the et al. method holds.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("keeps a number set against the relation that ends a formula, as TeX sets a typed one", () => {
    // "$\geq$10 kHz": TeX puts a thick space after a relation inside a formula, so a number
    // with none before it follows the formula and is the text's; "$x \geq 10$" is spaced.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10", f_sy: "CMSY10", f_cmr: "UTRHDZ+CMR10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let text = "";
    let x = 72;
    const put = (s: string, font: string, gap = CW) => {
      const d = drawn(1, { text: s, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      text += s + (gap >= CW ? " " : "");
      x += s.length * CW + gap;
    };
    put("recorded at a", "f_text");
    put("≥", "f_sy", 0);
    put("10", "f_text");
    put("kHz rate, and the bound", "f_text");
    put("x", "f_math", 3);
    put("≥", "f_sy", 3);
    put("10", "f_cmr");
    put("holds.", "f_text");
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("recorded at a 10 kHz rate, and the bound holds.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("keeps the number a cross-reference names when a formula follows it", () => {
    // "by Proposition 1 $f$ is bounded", "Eq. (3) $x$": no comma closes the clause before the
    // formula, but the number is the reference's.
    const fonts = { f_text: "NimbusRomNo9L-Regu", f_math: "BXJUHM+CMMI10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let text = "";
    let x = 72;
    const put = (s: string, font: string, gap = CW) => {
      const d = drawn(1, { text: s, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      text += s + (gap ? " " : "");
      x += s.length * CW + gap;
    };
    put("by Proposition 1", "f_text");
    put("f", "f_math");
    put("is bounded, and by Eq. (3)", "f_text");
    put("x", "f_math");
    put("holds, while a 2", "f_text");
    put("x", "f_math");
    put("stays.", "f_text");
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("by Proposition 1 is bounded, and by Eq. (3) holds, while a stays.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out a name set against the bracket of a formula's argument", () => {
    // "\mathrm{Aug}(\mathcal{G})" and "\operatorname{KL}(p\|q)" take their names from the
    // text face; the bracket against the formula makes them a function applied to it.
    const fonts = { f_text: "UTRHDZ+CMR10", f_math: "BXJUHM+CMMI10", f_sy: "CMSY10" };
    const items: PdfTextItem[] = [];
    const runs: (number | number[])[][] = [];
    let text = "";
    let x = 72;
    const put = (s: string, font: string, gap = CW) => {
      const d = drawn(1, { text: s, x, y: 100, font });
      items.push(d.item);
      runs.push(d.run);
      text += s + (gap ? " " : "");
      x += s.length * CW + gap;
    };
    put("the edge in", "f_text");
    put("Aug(", "f_text", 0);
    put("G", "f_sy", 0);
    put(")", "f_text");
    put("is kept, the model(s) agree, and", "f_text");
    put("KL(", "f_text", 0);
    put("p", "f_math", 0);
    put("∥", "f_sy", 0);
    put("q", "f_math", 0);
    put(")", "f_text");
    put("is small.", "f_text");
    const n = { text, anchor: { textMap: JSON.stringify(runs) } };
    const pages = [pageText(1, items, fonts)];
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
    expect(blocks[0]!.text).toBe("the edge in is kept, the model(s) agree, and is small.");
    expectRunsToMatch(blocks[0]!, pages);
  });

  it("leaves out the part of a formula a hyphen joins to a word, and keeps the word: \"$(2+1)$-dimensional\"", () => {
    // TeX spaces the "+" of "(2+1)" as an operator, so the formula is three tokens and the
    // last runs into the word after it; arXiv's HTML reads "-dimensional". A number the text
    // hyphens to a word with no formula beside it ("3-dimensional") is the text's.
    const line = setLine({ f_text: "UTRHDZ+CMR10", f_math: "BXJUHM+CMMI10" });
    line.put("the linear span is", "f_text");
    line.put("(2", "f_text", 3);
    line.put("+", "f_text", 3);
    line.put("1)-dimensional, and", "f_text");
    line.put("(", "f_text", 0);
    line.put("d", "f_math", 3);
    line.put("+", "f_text", 3);
    line.put("1)-dimensional", "f_text");
    line.put("as well, while a 3-dimensional space keeps its number.", "f_text");
    expect(line.read()).toBe("the linear span is -dimensional, and -dimensional as well, while a 3-dimensional space keeps its number.");
  });

  it("leaves out a formula's letter set in the text's italic where the mathematics has no letter face of its own", () => {
    // mathptmx and mathpazo set a formula's letters in the text's italic (Times, Palatino)
    // and only its symbols in a mathematics face. A letter of that italic set alone is a
    // formula's beside a formula ("$R = $ Er", "$M_\odot$"), with a script of its own
    // ("$D_i$"), or hyphened to a word ("$g$-band"); the writer's italic word, a lone italic
    // letter nothing marks ("plan B") and an italic statement's "a" stay.
    const line = setLine({ f_text: "NimbusRomNo9L-Regu", f_ital: "NimbusRomNo9L-ReguItal", f_sy: "CMSY10", f_sym: "Symbol" });
    line.put("for", "f_text");
    line.put("R", "f_ital", 3);
    line.put("=", "f_text", 3);
    line.put("Er the moments align, the ZTF", "f_text");
    line.put("g", "f_ital", 0);
    line.put("-band light curve varies, and", "f_text");
    line.put("D", "f_ital", 0);
    line.put("i", "f_ital", CW, 7);
    line.put("is fitted in", "f_text");
    line.put("M", "f_ital", 0);
    line.put("⊙", "f_sy", CW, 7);
    line.put("units, as we call it", "f_text");
    line.put("robust", "f_ital");
    line.put("and plan", "f_text");
    line.put("B", "f_ital");
    line.put("works. Let", "f_text");
    line.put("f map X into a", "f_ital");
    line.put("σ", "f_sym", 0);
    line.put("-algebra.", "f_ital");
    expect(line.read()).toBe("for Er the moments align, the ZTF -band light curve varies, and is fitted in units, as we call it robust and plan B works. Let f map X into a -algebra.");

    // Where the mathematics sets its letters in a face of its own (CMMI), an italic letter of
    // the text is the writer's \textit.
    const cm = setLine({ f_text: "UTRHDZ+CMR10", f_ital: "CMTI10", f_math: "BXJUHM+CMMI10" });
    cm.put("of type", "f_text");
    cm.put("A", "f_ital", 3);
    cm.put("x", "f_math", 3);
    cm.put("holds, and the", "f_text");
    cm.put("g", "f_ital", 0);
    cm.put("-band too.", "f_text");
    expect(cm.read()).toBe("of type A holds, and the g-band too.");
  });

  it("keeps the words a Word equation leaves in its script's run", () => {
    // Word sets "$c_i$ and" as a run of the "c" and one run of "i and" at the subscript's
    // size: pdf.js gives the words after the script its size.
    const read = (letters: string): string => {
      const fonts = { f_text: "TimesNewRomanPSMT", f_letters: letters, f_extra: "MT-Extra" };
      const items: PdfTextItem[] = [];
      const runs: (number | number[])[][] = [];
      let text = "";
      let x = 72;
      /** A run of pdf.js; `parts` are Zotero's glyph runs within it, each at its own size. */
      const put = (font: string, size: number, parts: [string, number][], gap = CW) => {
        const str = parts.map(([s]) => s).join("");
        items.push({ str, x, y: size < SIZE ? 101 : 100, width: str.length * CW, height: size, fontName: font });
        let at = x;
        for (const [s, sz] of parts) {
          const glyphs = s.trim();
          if (glyphs) runs.push(drawn(1, { text: glyphs, x: at + (s.length - s.trimStart().length) * CW, y: sz < SIZE ? 101 : 100, size: sz }).run);
          at += s.length * CW;
        }
        text += str + (gap ? " " : "");
        x += str.length * CW + gap;
      };
      put("f_text", SIZE, [["the resetting parameters", SIZE]]);
      put("f_letters", SIZE, [["c", SIZE]], 0);
      put("f_text", 7, [["i", 7], [" and", SIZE]]);
      put("f_letters", SIZE, [["d", SIZE]], 0);
      put("f_text", 7, [["i", 7], [" are drawn at random", SIZE]]);
      put("f_text", SIZE, [["where", SIZE]]);
      put("f_extra", SIZE, [["∼", SIZE]]);
      put("f_text", SIZE, [["holds.", SIZE]]);
      const n = { text: text.replace(/  +/g, " "), anchor: { textMap: JSON.stringify(runs) } };
      const pages = [pageText(1, items, fonts)];
      const blocks = structuredBlocks(structure([paragraph(1, [n])]), pages);
      expectRunsToMatch(blocks[0]!, pages);
      return blocks[0]!.text;
    };
    // Word's own equations are set in Cambria Math.
    expect(read("CambriaMath")).toBe("the resetting parameters and are drawn at random where holds.");
    // MathType sets the letters in the text's italic, and only its symbols in a face of its own.
    expect(read("TimesNewRomanPS-ItalicMT")).toBe("the resetting parameters and are drawn at random where holds.");
  });

  it("changes nothing in a document with no mathematics face", () => {
    const n = node(1, [{ text: "a plain sentence with x = 5 and (2 + 0.5) in it.", x: 72, y: 100 }]);
    const blocks = structuredBlocks(structure([paragraph(1, [n])]), [pageText(1, n.items, { f_text: "Calibri" })]);
    expect(blocks[0]!.text).toBe("a plain sentence with x = 5 and (2 + 0.5) in it.");
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

  it("leaves out a footnote Zotero took for an item of a list: it opens with the raised number a mark links to", () => {
    // A report's notes open with their raised number, "17DOD civilian personnel…", and
    // Zotero reads them as a numbered list of the body; it links the body's raised "18" to
    // the note all the same (and a note of the same list it links no mark to is one too).
    const body = node(1, [{ text: "the severity of those challenges varied by location.", x: 72, y: 100 }]);
    const mark = drawn(1, { text: "18", x: 72 + 52 * CW, y: 96 });
    const n17 = node(1, [{ text: "DOD civilian personnel are funded through two avenues.", x: 80, y: 700 }]);
    const n18 = node(1, [{ text: "Our review focuses on the challenges of remote installations.", x: 80, y: 714 }]);
    const sup = (text: string, y: number): SdtTextNode => {
      const d = drawn(1, { text, x: 72, y: y - 4 });
      return { text, anchor: { textMap: JSON.stringify([d.run]) }, style: { sup: true } };
    };
    const pages = [pageText(1, [...body.items, mark.item, ...n17.items, ...n18.items])];
    const blocks = structuredBlocks(structure([
      { type: "paragraph", content: [{ text: body.text, anchor: body.anchor }, { text: "18", anchor: { textMap: JSON.stringify([mark.run]) }, style: { sup: true }, refs: [[1, 1]] }] },
      { type: "list", content: [
        { type: "listitem", content: [sup("17", 700), { text: n17.text, anchor: n17.anchor }] },
        { type: "listitem", backRefs: [[0, 1]], content: [sup("18", 714), { text: n18.text, anchor: n18.anchor }] },
      ] },
      paragraph(1, [node(1, [{ text: "A body paragraph after the notes.", x: 72, y: 300 }])]),
    ]), pages);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toMatch(/^the severity of those challenges varied by location\./);
    expect(blocks[1]!.text).toBe("A body paragraph after the notes.");
  });

  it("leaves out a thesis's contents and list of figures: entries that end in a dot leader and a page number", () => {
    // Zotero reads each entry as a paragraph or a list item; a list of figures is every
    // caption over again. Entries it cut into paragraphs: the part with the leader does not
    // open with the entry's number, the part that does comes before it. In a list of
    // entries, one set too full for a leader, and one left two dots.
    const lines: [string, number][] = [
      ["The abstract ends here.", 100],
      ["1 Introduction . . . . . . . . 1", 130],
      ["1.1 A robot traversing a right pull door. . . . . . . . 2", 160],
      ["4.7 A simulation of the rough terrain behavior. A video is available at", 190],
      ["https://youtu.be/abc. . . . . . . . 47", 204],
      ["4.17 A presentation of teleoperation features.", 230],
      ["In the center, a view of the camera is shown.", 244],
      ["This clears debris and opens doors. . . . . . . . 60", 258],
      ["5.16 Pion form factors compared to the lattice results [219]146", 290],
      ["5.17 Quark and gluon contributions to the form factor.. .147", 304],
      ["5.18 Nucleon trace form factor . . . . . . . . 149", 318],
      ["The first chapter begins.", 400],
    ];
    const nodes = lines.map(([text, y]) => node(1, [{ text, x: 72, y }]));
    const pages = [pageText(1, nodes.flatMap((n) => n.items))];
    const [abstract, toc, lof1, cutA, cutB, longA, longB, longC, item1, item2, item3, body] = nodes;
    const item = (n: typeof body): SdtBlock => ({ type: "listitem", content: [n!] });
    const blocks = structuredBlocks(structure([
      paragraph(1, [abstract!]),
      { type: "heading", content: [toc!] },
      paragraph(1, [lof1!]), paragraph(1, [cutA!]), paragraph(1, [cutB!]),
      paragraph(1, [longA!]), paragraph(1, [longB!]), paragraph(1, [longC!]),
      { type: "list", content: [item(item1), item(item2), item(item3)] },
      paragraph(1, [body!]),
    ]), pages);
    expect(blocks.map((b) => b.text)).toEqual(["The abstract ends here.", "The first chapter begins."]);
    expect(blocks[1]!.columnBreak).toBe(true);
  });

  it("leaves out a caption Zotero took for a paragraph by its label, and keeps a sentence that names a figure", () => {
    const lines: [string, number][] = [
      ["Results follow.", 100],
      ["Table S7: All five conditioning rungs, all four families.", 130],
      ["FIG. 1. The partition sum in the ninth equation.", 160],
      ["Figure 8 Difference of density plots of the fractions.", 190],
      ["Figure 3 compares the spectra of the two dwarfs.", 220],
      ["Figure 4.21 shows an improved version of the behavior.", 250],
      ["we add the spine action to turn the spine as shown in", 280],
      ["Figure 6.32. Notice this node is a sibling of the fallback.", 310],
    ];
    const nodes = lines.map(([text, y]) => node(1, [{ text, x: 72, y }]));
    const pages = [pageText(1, nodes.flatMap((n) => n.items))];
    const blocks = structuredBlocks(structure(nodes.map((n) => paragraph(1, [n]))), pages);
    expect(blocks.map((b) => b.text)).toEqual([0, 4, 5, 6, 7].map((i) => lines[i]![0]));
  });

  it("keeps a paragraph that ends in a number after a full stop, and one that opens with a number", () => {
    const a = node(1, [{ text: "2.3 Results are summarized in the appendix, p. 12", x: 72, y: 100 }]);
    const b = node(1, [{ text: "The ratio rose from 1. to 3. 4", x: 72, y: 130 }]);
    const pages = [pageText(1, [...a.items, ...b.items])];
    const blocks = structuredBlocks(structure([paragraph(1, [a]), paragraph(1, [b])]), pages);
    expect(blocks.map((x) => x.text)).toEqual([a.text, b.text]);
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
    expect(blocks[0]!.text).toBe("the paragraph begins on one page and ends on the next.");
    expect(blocks[0]!.runs.map((r) => r.page)).toEqual([1, 2]);
    expectRunsToMatch(blocks[0]!, pages);
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

describe("structuredBlocks — text cut off by a display equation", () => {
  /** A display equation as Zotero sets it aside. */
  const display = (page: number, y: number): { block: SdtBlock; items: PdfTextItem[] } => {
    const eq = node(page, [{ text: "A = B + C", x: 200, y }]);
    return { block: { type: "math", anchor: { pageRects: [[page - 1, 200, HEIGHT - y - 2, 300, HEIGHT - y + 7]] }, content: [eq], flowClass: "auxiliary" }, items: eq.items };
  };
  /** A sentence of `n` words, all different from the other sentences'. */
  const sentence = (seed: string, n: number): string =>
    `${seed.toUpperCase()}${Array.from({ length: n }, (_, i) => `${seed}${String.fromCharCode(97 + (i % 26))}${i}`).join(" ").slice(1)}.`;

  it("reads a lead-in to an equation as the start of a sentence, and a connective as nothing", () => {
    // "The matrix is defined by [eq] <40 words>. [eq] Then [eq] <40 words>." — each piece
    // under the floor, and the lead-in and the "Then" unpunctuated. On arXiv's HTML all of
    // it is one paragraph box and read as one; here the lead-in was a label that cut the
    // paragraph off from what came before, and "Then" one that cut it in two.
    const lead = node(1, [{ text: "The sensitivity matrix is defined by", x: 72, y: 100 }]);
    const first = node(1, [{ text: sentence("f", 40), x: 72, y: 160 }]);
    const then = node(1, [{ text: "Then", x: 72, y: 220 }]);
    const second = node(1, [{ text: sentence("s", 40), x: 72, y: 280 }]);
    const eqs = [display(1, 130), display(1, 190), display(1, 250)];
    const pages = [pageText(1, [...lead.items, ...first.items, ...then.items, ...second.items, ...eqs.flatMap((e) => e.items)])];
    const blocks = structuredBlocks(structure([
      paragraph(1, [lead]), eqs[0]!.block, paragraph(1, [first]), eqs[1]!.block, paragraph(1, [then]), eqs[2]!.block, paragraph(1, [second]),
    ]), pages);
    expect(blocks.map((b) => b.text.split(" ")[0])).toEqual(["The", "Fa0", "Then", "Sa0"]);
    expect(blocks.map((b) => b.runsOn === true)).toEqual([true, false, true, false]);
    expect(groupsOf(blocks)).toEqual([[0, 1, 3]]);
  });

  it("does not take a heading or a sentence that ended for a lead-in", () => {
    const head = node(1, [{ text: "2 Results", x: 72, y: 80 }]);
    const done = node(1, [{ text: "The equation reads.", x: 72, y: 100 }]);
    const eq = display(1, 130);
    const pages = [pageText(1, [...head.items, ...done.items, ...eq.items])];
    const blocks = structuredBlocks(structure([
      { type: "heading", anchor: { pageRects: [[0, 72, 700, 300, 712]] }, content: [head] }, eq.block,
      paragraph(1, [done]), display(1, 160).block,
    ]), pages);
    expect(blocks.map((b) => [b.kind, b.runsOn === true])).toEqual([["heading", false], ["paragraph", false]]);
  });

  it("reads on across a page break where the sentence runs on, and stops at one where it ended", () => {
    // Page 1 ends "…the correction is given by", the equation opens page 2 and the text
    // after it starts a new sentence: the break is inside the writing, not between two
    // pieces of it. A paragraph that ended at the foot of page 1 still ends there.
    const tail = node(1, [{ text: sentence("t", 30), x: 72, y: 600 }]);
    const lead = node(1, [{ text: "and the correction is given by", x: 72, y: 700 }]);
    const eq = display(2, 90);
    const after = node(2, [{ text: sentence("a", 30), x: 72, y: 130 }]);
    const ended = node(2, [{ text: sentence("e", 30), x: 72, y: 700 }]);
    const fresh = node(3, [{ text: sentence("n", 30), x: 72, y: 100 }]);
    const pages = [pageText(1, [...tail.items, ...lead.items]), pageText(2, [...eq.items, ...after.items, ...ended.items]), pageText(3, fresh.items)];
    const blocks = structuredBlocks(structure([
      paragraph(1, [tail]), paragraph(1, [lead]), eq.block, paragraph(2, [after]), paragraph(2, [ended]), paragraph(3, [fresh]),
    ], 3), pages);
    expect(blocks.map((b) => b.columnBreak)).toEqual([true, false, false, false, true]);
    expect(blocks[1]!.runsOn).toBe(true);
  });

  it("marks no break after a paragraph that was carried onto the page it ends on", () => {
    const first = node(1, [{ text: "the paragraph begins on one page and", x: 72, y: 700 }]);
    const second = node(2, [{ text: "ends on the next.", x: 72, y: 80 }]);
    const next = node(2, [{ text: "Another paragraph follows it.", x: 72, y: 110 }]);
    const pages = [pageText(1, first.items), pageText(2, [...second.items, ...next.items])];
    const blocks = structuredBlocks(structure([
      paragraph(1, [first], { nextPart: [1] }),
      paragraph(2, [second], { previousPart: [0] }),
      paragraph(2, [next]),
    ], 2), pages);
    expect(blocks.map((b) => [b.page, b.columnBreak])).toEqual([[1, true], [2, false]]);
  });
});

describe("structuredBlocks — a manuscript with numbered lines", () => {
  // Word numbers every line of a review copy, a tab before the text: "84" right-aligned at
  // the margin, the text at 72, a paragraph's first line at 108. Zotero takes each number
  // for a list marker and each line for an item of a list, or reads the page — text,
  // numbers and all — as a table, and sets it aside.
  /** Words, all different, to exactly `n` characters. */
  const fill = (seed: string, n: number): string => {
    let s = "";
    for (let i = 0; s.length < n; i++) s += `${s ? " " : ""}${seed}${String.fromCharCode(97 + (i % 26))}${i}`;
    return s.slice(0, n).replace(/ $/, "x");
  };
  /** Three paragraphs: indented first lines, full lines, a short last line ending a sentence. */
  const LINES = [
    { text: `The ${fill("a", 79)}`, x: 108 }, { text: fill("b", 90), x: 72 }, { text: fill("c", 90), x: 72 }, { text: `${fill("d", 35)}.`, x: 72 },
    { text: `Then ${fill("e", 78)}`, x: 108 }, { text: fill("f", 90), x: 72 }, { text: `${fill("g", 30)}.`, x: 72 },
    { text: `Last ${fill("h", 78)}`, x: 108 }, { text: `${fill("i", 88)}.`, x: 72 },
  ];
  const PARAGRAPHS = [[0, 4], [4, 7], [7, 9]].map(([a, b]) => LINES.slice(a, b).map((l) => l.text).join(" "));
  const PITCH = 14;
  interface Line { items: PdfTextItem[]; run: (number | number[])[][]; text: string }
  /** A numbered line: pdf.js's two runs and Zotero's glyphs for them, the number first. */
  const numbered = (page: number, n: number, line: { text: string; x: number }, y: number): Line => {
    const num = String(n);
    const a = drawn(page, { text: num, x: 54 - num.length * CW, y });
    const b = drawn(page, { text: line.text, x: line.x, y });
    return { items: [a.item, b.item], run: [a.run, b.run], text: `${num} ${line.text}` };
  };
  const lines = (page: number, first: number, top: number, of = LINES): Line[] => of.map((l, i) => numbered(page, first + i, l, top + i * PITCH));
  /** Zotero's one text node for several lines. */
  const textOf = (set: Line[]): SdtTextNode => ({ text: set.map((l) => l.text).join(" "), anchor: { textMap: JSON.stringify(set.flatMap((l) => l.run)) } });
  const asList = (set: Line[]): SdtBlock => ({ type: "list", content: set.map((l) => ({ type: "listitem", content: [textOf([l])] })) });

  it("reads a list of numbered lines as the paragraphs they are, without the numbers", () => {
    const head = numbered(1, 83, { text: "1. Introduction", x: 72 }, 86);
    const set = lines(1, 84, 100);
    const pages = [pageText(1, [...head.items, ...set.flatMap((l) => l.items)])];
    const blocks = structuredBlocks(structure([{ type: "heading", content: [textOf([head])] }, asList(set)]), pages);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([["heading", "1. Introduction"], ...PARAGRAPHS.map((p) => ["paragraph", p])]);
    for (const b of blocks) expectRunsToMatch(b, pages);
  });

  it("finds the paragraphs of numbered lines set ragged right by their indents", () => {
    // Every line stops short of the margin by a word or two, and many of them are followed
    // by a line opening with a capital or a bracket: only the indent opens a paragraph.
    const ragged = [
      { text: `The ${fill("a", 80)}`, x: 108 }, { text: fill("b", 78), x: 72 }, { text: `(Smith ${fill("c", 76)}`, x: 72 },
      { text: `Jones ${fill("d", 78)}`, x: 72 }, { text: `${fill("e", 70)}.`, x: 72 },
      { text: `Then ${fill("f", 76)}`, x: 108 }, { text: `(Doe ${fill("g", 82)}`, x: 72 }, { text: `${fill("h", 60)}.`, x: 72 },
    ];
    const set = lines(1, 84, 100, ragged);
    const pages = [pageText(1, set.flatMap((l) => l.items))];
    const blocks = structuredBlocks(structure([asList(set)]), pages);
    expect(blocks.map((b) => b.text)).toEqual([ragged.slice(0, 5), ragged.slice(5)].map((p) => p.map((l) => l.text).join(" ")));
  });

  it("reads a numbered paragraph on over a page whose next line opens with a capital", () => {
    // "…in the United" at the foot of one page, "Kingdom (Figure 1)." at the head of the
    // next, the page's own furniture between them.
    const foot = [...LINES.slice(0, 8), { text: fill("i", 90), x: 72 }];
    const head = { text: `Kingdom ${fill("k", 60)}.`, x: 72 };
    const one = lines(1, 84, 100, foot);
    const two = lines(2, 93, 100, [head]);
    const stamp = node(1, [{ text: "This manuscript is a preprint.", x: 72, y: 760 }]);
    const pages = [pageText(1, [...one.flatMap((l) => l.items), ...stamp.items]), pageText(2, two.flatMap((l) => l.items))];
    const blocks = structuredBlocks(structure([asList(one), paragraph(1, [stamp], { flowClass: "excluded" }), asList(two)], 2), pages);
    expect(blocks.map((b) => b.text)).toEqual([...PARAGRAPHS.slice(0, 2), [LINES[7]!.text, fill("i", 90), head.text].join(" ")]);
  });

  it("reads a page of numbered prose Zotero took for a table", () => {
    const set = lines(1, 84, 100);
    const pages = [pageText(1, set.flatMap((l) => l.items))];
    const blocks = structuredBlocks(structure([{ type: "table", flowClass: "auxiliary", content: [textOf(set)] }]), pages);
    expect(blocks.map((b) => b.text)).toEqual(PARAGRAPHS);
    for (const b of blocks) expectRunsToMatch(b, pages);
  });

  it("reads numbered lines Zotero took for a bibliography before the References heading", () => {
    const set = lines(1, 84, 100);
    const more = lines(1, 93, 100 + 9 * PITCH);
    const head = numbered(1, 102, { text: "References", x: 72 }, 100 + 18 * PITCH);
    const entry = numbered(1, 103, { text: "Doe, J. (2020). A paper about papers. Journal 1, 1-2.", x: 72 }, 100 + 19 * PITCH);
    const pages = [pageText(1, [...set, ...more, head, entry].flatMap((l) => l.items))];
    const asEntries = (of: Line[]): SdtBlock => ({ type: "list", content: of.map((l) => ({ type: "listitem", reference: true, content: [textOf([l])] })) });
    const blocks = structuredBlocks(structure([asList(set), asEntries(more), { type: "heading", content: [textOf([head])] }, asEntries([entry])]), pages);
    expect(blocks.map((b) => b.text)).toEqual([...PARAGRAPHS, ...PARAGRAPHS, "References"]);
  });

  it("leaves a real table set aside, though its caption's lines are numbered", () => {
    const set = lines(1, 84, 100);
    const caption = lines(1, 94, 240, [{ text: "Table 1. Rates of land motion at six stations.", x: 72 }]);
    const rows = ["Boston", "Woods Hole", "Nantucket", "Chatham", "Fall River", "New Bedford"].map((name, i): Line => {
      const y = 260 + i * PITCH;
      const cells = [drawn(1, { text: name, x: 72, y }), drawn(1, { text: `-${i}.59`, x: 250, y }), drawn(1, { text: `${i}.6`, x: 400, y })];
      return { items: cells.map((c) => c.item), run: cells.map((c) => c.run), text: [name, `-${i}.59`, `${i}.6`].join(" ") };
    });
    const pages = [pageText(1, [...set.flatMap((l) => l.items), ...caption.flatMap((l) => l.items), ...rows.flatMap((r) => r.items)])];
    const blocks = structuredBlocks(structure([asList(set), { type: "table", flowClass: "auxiliary", content: [textOf([...caption, ...rows])] }]), pages);
    expect(blocks.map((b) => b.text)).toEqual(PARAGRAPHS);
  });

  it("leaves out a caption Zotero took for a paragraph among numbered lines, where the caption's own lines are not numbered", () => {
    const set = lines(1, 84, 100);
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const caption = node(1, [{ text: `Figure 8 Difference of density plots of all reference fractions ${words}.`, x: 72, y: 300 }]);
    const pages = [pageText(1, [...set.flatMap((l) => l.items), ...caption.items])];
    const blocks = structuredBlocks(structure([asList(set), paragraph(1, [caption])]), pages);
    expect(blocks.map((b) => b.text)).toEqual(PARAGRAPHS);
  });

  it("leaves a paper's own numbers alone: a table of years under a paragraph", () => {
    // Ten years counting on, each first on its line: but the paragraph's lines start where
    // the years do, so they are the table's first column, not a margin's.
    const years = Array.from({ length: 10 }, (_, i): Line => {
      const y = 200 + i * PITCH;
      const a = drawn(1, { text: String(2001 + i), x: 72, y });
      const b = drawn(1, { text: `rainfall was ${i + 3}00 millimetres that year`, x: 140, y });
      return { items: [a.item, b.item], text: `${2001 + i} rainfall was ${i + 3}00 millimetres that year`, run: [a.run, b.run] };
    });
    const body = node(1, ["the body paragraph above the table", "reads as it did before, all its", "lines set flush left where the", "years of the table are set too."].map((text, i) => ({ text, x: 72, y: 100 + i * PITCH })));
    const pages = [pageText(1, [...body.items, ...years.flatMap((r) => r.items)])];
    const blocks = structuredBlocks(structure([paragraph(1, [body]), { type: "table", flowClass: "auxiliary", content: [textOf(years)] }]), pages);
    expect(blocks.map((b) => b.text)).toEqual([body.text]);
  });
});
