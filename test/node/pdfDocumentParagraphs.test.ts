// test/node/pdfDocumentParagraphs.test.ts — the PDF reader reads a document's paragraphs
// before their pages are drawn (lib/pdf/readAhead.ts), and a page's chips come from the cache
// when it is: which holds only if the paragraphs it reads ahead are, text for text and in the
// same order, the units the page's unit source mints once the pages are drawn. That is
// documentParagraphs' contract with createPdfUnitSource (lib/pdf/units.ts), pinned here on a
// document built by hand as Zotero's structure and pdf.js's text runs (as in
// test/node/pdf-structured.test.ts), with the text layers' spans in a linkedom document.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { PdfPageText, PdfTextItem, ReflowBlock } from "../../lib/pdf/reflow";
import { createStructuredReader, type SdtBlock, type SdtStructure, type StructuredBlock } from "../../lib/pdf/structured";
import { createPdfUnitSource, documentParagraphs, type DocumentParagraph } from "../../lib/pdf/units";
import type { Unit } from "../../lib/types";

const WIDTH = 612;
const HEIGHT = 792;
const SIZE = 10;
const CW = 5;
const PITCH = 14;

const WORDS = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings before a timetable moved off paper until trains ran on time in winter".split(" ");
/** Eight words to a line, all different from any other line's. */
const line = (seed: number): string => Array.from({ length: 8 }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(" ") + ` w${seed}`;

/** One drawn line: pdf.js's text run, and Zotero's glyph run for the same glyphs. */
function drawn(page: number, text: string, y: number): { item: PdfTextItem; run: (number | number[])[] } {
  const item: PdfTextItem = { str: text, x: 72, y, width: text.length * CW, height: SIZE, fontName: "f_text" };
  const widths: (number | number[])[] = [];
  let space = 0;
  for (const ch of text) {
    if (ch === " ") { space += CW; continue; }
    widths.push(space ? [space, CW] : CW);
    space = 0;
  }
  return { item, run: [0, page - 1, 72, HEIGHT - y - 0.2 * SIZE, 72 + text.length * CW, HEIGHT - y + 0.7 * SIZE, ...widths] };
}

interface Piece { page: number; block: SdtBlock; items: PdfTextItem[]; }

/**
 * A paragraph, or one part of one, of `lines` lines from `top` down on `page`: a full stop at
 * its end unless it goes on over the page (`open`).
 */
function piece(page: number, seed: number, lines: number, top: number, extra: Partial<SdtBlock> = {}, open = false): Piece {
  const texts = Array.from({ length: lines }, (_, i) => line(seed + i));
  if (!open) texts[lines - 1] += ".";
  const runs: (number | number[])[][] = [];
  const items: PdfTextItem[] = [];
  texts.forEach((text, i) => {
    const d = drawn(page, text, top + i * PITCH);
    items.push(d.item);
    runs.push(d.run);
  });
  const width = Math.max(...texts.map((t) => t.length)) * CW;
  const bottom = top + (lines - 1) * PITCH;
  return {
    page,
    items,
    block: {
      type: "paragraph",
      anchor: { pageRects: [[page - 1, 72, HEIGHT - bottom - 0.2 * SIZE, 72 + width, HEIGHT - top + 0.7 * SIZE]] },
      content: [{ text: texts.join(" "), anchor: { textMap: JSON.stringify(runs) } }],
      ...extra,
    },
  };
}

/**
 * Three pages, nine words to a line:
 *  1  A (72 words), B and C (36 each: under the shipped floor of 50, read together), and the
 *     first half of D, which goes on over the page;
 *  2  the rest of D (81 words in all), E (72);
 *  3  F (72), and G (18 words: short, read with F).
 */
function documentOf(): { structure: SdtStructure; pages: PdfPageText[] } {
  const pieces = [
    piece(1, 10, 8, 100),
    piece(1, 30, 4, 240),
    piece(1, 40, 4, 320),
    piece(1, 50, 5, 400, { nextPart: [4] }, true),
    piece(2, 60, 4, 80, { previousPart: [3] }),
    piece(2, 70, 8, 180),
    piece(3, 80, 8, 100),
    piece(3, 90, 2, 260),
  ];
  const pages = [1, 2, 3].map((n): PdfPageText => ({
    page: n, width: WIDTH, height: HEIGHT, items: pieces.filter((p) => p.page === n).flatMap((p) => p.items), fonts: {},
  } as PdfPageText));
  return {
    structure: { catalog: { pages: pages.map(() => ({ viewRect: [0, 0, WIDTH, HEIGHT] })) }, content: pieces.map((p) => p.block) },
    pages,
  };
}

let dom: ReturnType<typeof parseHTML>;
beforeEach(() => {
  dom = parseHTML("<!doctype html><html><body></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A page's text layer as pdf.js builds it: one span per text run, in the page's own order. */
function layerOf(page: PdfPageText): { layer: Element; spans: HTMLElement[] } {
  const layer = dom.document.createElement("div");
  const spans = page.items.map((item) => {
    const span = dom.document.createElement("span");
    span.textContent = item.str;
    layer.append(span);
    return span as unknown as HTMLElement;
  });
  dom.document.body.append(layer);
  return { layer: layer as unknown as Element, spans };
}

/** What a document paragraph and a unit have in common. */
const shape = (p: { order: number; text: string; words: number; page: number | undefined }) => ({ order: p.order, text: p.text, words: p.words, page: p.page });
const unitShape = (u: Unit) => shape({ order: u.order, text: u.text, words: u.wordCount, page: u.page });

function read(drawnPages: readonly number[], mergeShorts = true, floor = 50): { plan: DocumentParagraph[]; units: Unit[]; blocks: StructuredBlock[]; reader: ReturnType<typeof createStructuredReader>; layers: Map<number, Element> } {
  const { structure, pages } = documentOf();
  const reader = createStructuredReader(structure);
  // The reader has the text of every page, drawn or read ahead (entrypoints/reader/main.ts).
  const blocks = reader.blocks(pages);
  const plan = documentParagraphs(blocks, (block) => reader.pagesOf(block as StructuredBlock), mergeShorts, floor);
  const source = createPdfUnitSource();
  source.setBlocks(blocks);
  const layers = new Map<number, Element>();
  for (const n of drawnPages) {
    const { layer, spans } = layerOf(pages[n - 1]!);
    layers.set(n, layer);
    source.setPage(n, { layer, spans });
  }
  return { plan, units: source.collect(() => "take", mergeShorts, floor), blocks, reader, layers };
}

describe("StructuredReader.pagesOf", () => {
  it("names every page a block lies on, and a block's own page for one it did not answer with", () => {
    const { blocks, reader } = read([]);
    expect(blocks.map((b) => reader.pagesOf(b))).toEqual([[1], [1], [1], [1, 2], [2], [3], [3]]);
    expect(reader.pagesOf({ ...blocks[0]!, page: 7 })).toEqual([7]);
  });

  it("names them even while a page's text is not in", () => {
    const { structure, pages } = documentOf();
    const reader = createStructuredReader(structure);
    const blocks = reader.blocks([pages[0]!]);
    const carried = blocks.find((b) => b.text.startsWith(line(50).slice(0, 20)))!;
    expect(reader.pagesOf(carried)).toEqual([1, 2]);
    expect(new Set(carried.runs.map((r) => r.page))).toEqual(new Set([1]));
  });
});

describe("documentParagraphs", () => {
  it("is the document's units once every page is drawn: the same texts, words, pages and order", () => {
    const { plan, units } = read([1, 2, 3]);
    expect(units.map(unitShape)).toEqual(plan.map(shape));
    // The case has what it is meant to have: two short paragraphs read as one, a short one
    // read with the paragraph before it, and one carried over a page whose chip stands where
    // it ends.
    expect(plan.map((p) => p.text.split("\n\n").length)).toEqual([1, 2, 1, 1, 2]);
    const carried = plan.find((p) => p.pages.length > 1)!;
    expect(carried).toMatchObject({ pages: [1, 2], page: 2 });
    expect(carried.text).toContain(line(50));
    expect(carried.text).toContain(line(60));
    expect(plan.map((p) => p.order)).toEqual(plan.map((_, i) => i));
  });

  it.each([[false, 50], [true, 25], [true, 75]] as const)("is the units under the reader's own setting too (merge shorts %s, floor %i)", (merge, floor) => {
    const { plan, units } = read([1, 2, 3], merge, floor);
    expect(plan.length).toBeGreaterThan(0);
    expect(units.map(unitShape)).toEqual(plan.map(shape));
  });

  it("says which pages each paragraph needs, and puts its chip on the page it ends on", () => {
    const { plan } = read([]);
    expect(plan.map((p) => [p.pages, p.page])).toEqual(plan.map((p) => [p.pages, p.pages.at(-1)]));
    expect(plan.flatMap((p) => p.pages)).toEqual(expect.arrayContaining([1, 2, 3]));
  });
});

describe("a paragraph partly drawn", () => {
  it("is a unit of its drawn part with the WHOLE paragraph's text, whose chip stands on the drawn page", () => {
    const { plan, units, layers } = read([1]);
    const carried = plan.find((p) => p.pages.length > 1)!;
    // Every paragraph with a part on page 1, and nothing of the pages not drawn.
    expect(units.map((u) => u.text)).toEqual(plan.filter((p) => p.pages.includes(1)).map((p) => p.text));
    const unit = units.find((u) => u.text === carried.text)!;
    expect(unit).toBeDefined();
    expect(unit.page).toBe(1);
    expect(unit.order).toBe(carried.order);
    expect(unit.wordCount).toBe(carried.words);
    expect(unit.parts.length).toBeGreaterThan(0);
    expect(unit.parts.every((part) => part.container === layers.get(1))).toBe(true);
    // Only the drawn part's glyphs are its nodes.
    const firstHalf = Array.from({ length: 5 }, (_, i) => line(50 + i)).join(" ");
    expect(carried.text.startsWith(firstHalf)).toBe(true);
    expect(unit.parts.flatMap((part) => part.nodes.map((n) => n.textContent)).join(" ")).toBe(firstHalf);
  });

  it("is a unit on the second page alone, with the same text, when only that page is drawn", () => {
    const { plan, units, layers } = read([2]);
    const carried = plan.find((p) => p.pages.length > 1)!;
    const unit = units.find((u) => u.text === carried.text)!;
    expect(unit).toBeDefined();
    expect(unit.page).toBe(2);
    expect(unit.parts.every((part) => part.container === layers.get(2))).toBe(true);
    expect(units.map((u) => u.text)).toEqual(plan.filter((p) => p.pages.includes(2)).map((p) => p.text));
  });

  it("is no unit at all while none of it is drawn", () => {
    expect(read([]).units).toEqual([]);
    const { plan, units } = read([3]);
    expect(units.map(unitShape)).toEqual(plan.filter((p) => p.pages.includes(3)).map(shape));
  });
});

// The read-ahead reads the page a drawn paragraph goes on to, and the paragraph's text grows
// while the nodes drawn of it stay the same: the unit source's claim protocol cannot see that,
// so the source mints it again itself (and the orchestrator's refresh retires the old unit,
// which nothing claimed: test/node/scoreDetached.test.ts).
describe("a paragraph whose text changes while its drawn nodes do not", () => {
  it("is minted again under a new id over the same nodes, without a claim, and is the live unit after", () => {
    const page = documentOf().pages[0]!;
    const { layer, spans } = layerOf(page);
    const items = page.items.slice(0, 8); // A's eight lines
    let at = 0;
    const runs = items.map((it, item) => {
      const run = { page: 1, item, at, length: it.str.length, from: 0 };
      at += it.str.length + 1;
      return run;
    });
    const drawnText = items.map((it) => it.str).join(" ");
    const block = (text: string, more: typeof runs = []): ReflowBlock => ({ kind: "paragraph", text, page: 1, runs: [...runs, ...more], apart: false, columnBreak: true });
    const source = createPdfUnitSource();
    source.setPage(1, { layer, spans });
    source.setBlocks([block(drawnText)]);

    // The orchestrator's claim, as far as it matters here: "skip" for exactly a live unit's part.
    const owners = new Map<Text, Unit>();
    const claim = vi.fn((nodes: Text[]): "take" | "skip" => {
      const owner = owners.get(nodes[0]!);
      return owner?.parts.some((p) => p.nodes.length === nodes.length && p.nodes.every((n, i) => n === nodes[i])) ? "skip" : "take";
    });
    const own = (unit: Unit): void => { for (const part of unit.parts) for (const node of part.nodes) owners.set(node, unit); };

    const [first, ...none] = source.collect(claim);
    expect(none).toEqual([]);
    own(first!);
    expect(source.collect(claim), "nothing changed: nothing new").toEqual([]);

    const grown = `${drawnText} and the rest of it, on the next page.`;
    source.setBlocks([block(grown, [{ page: 2, item: 0, at: drawnText.length + 1, length: 35, from: 0 }])]);
    claim.mockClear();
    const [second, ...others] = source.collect(claim);
    expect(others).toEqual([]);
    expect(second!.id).not.toBe(first!.id);
    expect(second!.text).toBe(grown);
    expect(second!.parts.flatMap((p) => p.nodes)).toEqual(first!.parts.flatMap((p) => p.nodes));
    expect(claim).not.toHaveBeenCalled();
    expect(source.ranges(first!, [{ start: 0, end: 5 }]), "the stale unit's placement is let go").toBeNull();

    own(second!);
    expect(source.collect(claim), "the new unit is the live one").toEqual([]);
  });
});

describe("documentParagraphs and blocks on no page", () => {
  const prose = (seed: number): string => Array.from({ length: 12 }, (_, i) => line(seed + i)).join(" ") + ".";
  const block = (text: string, page: number, runs: ReflowBlock["runs"]): ReflowBlock => ({ kind: "paragraph", text, page, runs, apart: true, columnBreak: false });

  it("keeps a paragraph whose pages are not read yet, leaves out one on no page, and keeps the others' order", () => {
    const first = prose(1), nowhere = prose(40), unread = prose(80);
    const blocks = [
      block(first, 1, [{ page: 1, item: 0, at: 0, length: first.length, from: 0 }]),
      block(nowhere, 1, []),
      block(unread, 2, []),
    ];
    const pages = new Map<ReflowBlock, number[]>([[blocks[0]!, [1]], [blocks[1]!, []], [blocks[2]!, [2]]]);
    const plan = documentParagraphs(blocks, (b) => pages.get(b)!, false, 1);
    expect(plan.map((p) => p.text)).toEqual([first, unread]);
    expect(plan.map((p) => p.order)).toEqual([0, 2]);
    expect(plan.map((p) => p.pages)).toEqual([[1], [2]]);
  });
});
