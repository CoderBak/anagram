// test/node/pdfStructuredProps.test.ts — Zotero's structure as a hostile PDF could shape it.
//
// lib/pdf/structured.ts reads what Zotero's document-worker made of an untrusted PDF: the
// tree is Zotero's, but every number in it — the glyph boxes of each text node's textMap, the
// blocks' page rectangles, the pages' boxes — and every string is the PDF's, and pdf.js's
// text layer, which it is matched against, is the PDF's too. A PDF can set its text with
// matrices that overflow to Infinity or cancel to NaN, a glyph map can be cut short, and
// nothing guarantees that the parts of a structure agree. None of it may throw out of the
// reader (the reader rebuilds its paragraphs on every page it draws, unguarded) or take
// more than linear time. fast-check draws the structures; a failure prints the smallest one.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createStructuredReader, createStructuredReaderInSlices, glyphsOf, type SdtBlock, type SdtStructure, type SdtTextNode } from "../../lib/pdf/structured";
import type { PdfPageText, PdfTextItem } from "../../lib/pdf/reflow";
import { readReflowed } from "../../lib/pdf/reading";
import { rng, type Rng } from "./random";

/** A coordinate: ordinary, enormous, or not a number at all. */
const coordinate = fc.oneof(
  { weight: 6, arbitrary: fc.double({ min: -50, max: 900, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(NaN, Infinity, -Infinity, 0, -0, 1e308, -1e308, 5e-324) },
);

/** A number as a textMap writes it: JSON has no NaN, but 1e999 parses to Infinity. */
const json = (x: unknown): string =>
  typeof x === "number" && !Number.isFinite(x) ? (Number.isNaN(x) ? "null" : x > 0 ? "1e999" : "-1e999")
    : Array.isArray(x) ? `[${x.map(json).join(",")}]` : JSON.stringify(x);

/** One glyph run of a textMap: [header, page, minX, minY, maxX, maxY, ...widths]. */
const glyphRun = fc.tuple(
  fc.integer({ min: 0, max: 7 }),
  fc.oneof(fc.integer({ min: -1, max: 4 }), coordinate),
  coordinate, coordinate, coordinate, coordinate,
  fc.array(fc.oneof(coordinate, fc.tuple(coordinate, coordinate)), { maxLength: 12 }),
).map(([header, page, ...rest]) => [header, page, ...rest.slice(0, 4), ...(rest[4] as unknown[])]);

const textMap = fc.oneof(
  { weight: 6, arbitrary: fc.array(glyphRun, { maxLength: 6 }).map(json) },
  { weight: 1, arbitrary: fc.oneof(fc.string(), fc.constantFrom("", "null", "{}", "[]", "[[]]", "[1,2,3]", "[[1,2]]", "[\"x\"]", "[[0,0,0,0,0,0,{}]]", "[".repeat(5000) + "]".repeat(5000))) },
);

const TEXTS = ["the", "quick", "fox", " ", "  ", "-", "é", "é", "́", "Ω", "𝑥", "1", "[12]", "¹", "†", "…", ".", "x", "­", "ﬁ", "中", "\n"];
const text = fc.array(fc.constantFrom(...TEXTS), { maxLength: 30 }).map((parts) => parts.join(""));

const textNode: fc.Arbitrary<SdtTextNode> = fc.record({
  text,
  anchor: fc.option(fc.record({ textMap }, { requiredKeys: [] }), { nil: undefined }),
  style: fc.option(fc.record({ sup: fc.boolean(), monospace: fc.boolean() }, { requiredKeys: [] }), { nil: undefined }),
  refs: fc.option(fc.array(fc.array(fc.integer({ min: -2, max: 40 }), { maxLength: 4 }), { maxLength: 3 }), { nil: undefined }),
}, { requiredKeys: ["text"] });

const path = fc.array(fc.integer({ min: -2, max: 40 }), { maxLength: 4 });
const rect = fc.array(fc.oneof(fc.integer({ min: -1, max: 5 }), coordinate), { maxLength: 6 });
const TYPES = ["paragraph", "paragraph", "paragraph", "heading", "list", "listitem", "blockquote", "math", "image", "table", "caption", "note", "x"];

const { block } = fc.letrec<{ block: SdtBlock }>((tie) => ({
  block: fc.record({
    type: fc.constantFrom(...TYPES),
    content: fc.option(fc.array(fc.oneof({ weight: 4, arbitrary: textNode }, { weight: 1, arbitrary: tie("block") }), { maxLength: 5 }), { nil: undefined }),
    anchor: fc.option(fc.record({ pageRects: fc.array(rect, { maxLength: 3 }), textMap }, { requiredKeys: [] }), { nil: undefined }),
    flowClass: fc.option(fc.constantFrom("auxiliary", "excluded", "body", ""), { nil: undefined }),
    reference: fc.option(fc.boolean(), { nil: undefined }),
    previousPart: fc.option(path, { nil: undefined }),
    nextPart: fc.option(path, { nil: undefined }),
    backRefs: fc.option(fc.array(path, { maxLength: 2 }), { nil: undefined }),
  }, { requiredKeys: ["type"] }) as fc.Arbitrary<SdtBlock>,
}));

const structure: fc.Arbitrary<SdtStructure> = fc.record({
  catalog: fc.record({ pages: fc.array(fc.record({ viewRect: fc.option(fc.array(coordinate, { maxLength: 5 }), { nil: undefined }) }, { requiredKeys: [] }), { maxLength: 4 }) }),
  content: fc.array(block, { maxLength: 12 }),
});

const item: fc.Arbitrary<PdfTextItem> = fc.record({
  str: text,
  x: coordinate, y: coordinate, width: coordinate, height: coordinate,
  fontName: fc.option(fc.constantFrom("f_text", "f_math", "f_mono", ""), { nil: undefined }),
  hasEOL: fc.option(fc.boolean(), { nil: undefined }),
  rotated: fc.option(fc.boolean(), { nil: undefined }),
}, { requiredKeys: ["str", "x", "y", "width", "height"] });

const pageText = (page: number): fc.Arbitrary<PdfPageText> => fc.record({
  page: fc.constant(page),
  width: coordinate,
  height: coordinate,
  items: fc.array(item, { maxLength: 14 }),
  transform: fc.option(fc.array(coordinate, { minLength: 0, maxLength: 7 }), { nil: undefined }),
  fonts: fc.constant({ f_text: "ABCDEF+Times-Roman", f_math: "ABCDEF+CMMI10", f_mono: "ABCDEF+Courier", "": "" }),
}, { requiredKeys: ["page", "width", "height", "items"] });

const pages = fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 5 }).chain((ns) => fc.tuple(...ns.map(pageText)));

/** What a reading owes whatever the input: blocks of text, every run inside its block's text
 *  and on an item of its page. */
function wellFormed(blocks: ReturnType<ReturnType<typeof createStructuredReader>["blocks"]>, given: readonly PdfPageText[]): void {
  for (const b of blocks) {
    expect(typeof b.text).toBe("string");
    for (const r of b.runs) {
      const page = given.find((p) => p.page === r.page);
      expect(page, `run on page ${r.page}`).toBeDefined();
      expect(r.item >= 0 && r.item < page!.items.length, `item ${r.item} of ${page!.items.length}`).toBe(true);
      expect(r.at >= 0 && r.length >= 0 && r.at + r.length <= b.text.length, `run ${r.at}+${r.length} of ${b.text.length}`).toBe(true);
    }
  }
}

// ---- documents that read, then broken ---------------------------------------------------
// Random trees seldom put a glyph where a run of the text layer is, so most of the reading
// never runs on them. These are documents as the reader meets them — lines of words that
// pdf.js and Zotero both have, Zotero's glyphs on pdf.js's runs, paragraphs carried over a
// page, lists, notes, figures — and then some of what a hostile PDF can do to them.

const HEIGHT = 792;
const SIZE = 10;
/** A glyph's advance, and the width of a word space. */
const CW = 5;
const WORDS = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows".split(" ");
const BAD = [NaN, Infinity, -Infinity, 1e308, -1e308, 0, -0, 5e-324];

/** A line as pdf.js's run and as Zotero's glyph run (see test/node/pdf-structured.test.ts). */
function line(page: number, s: string, x: number, y: number, size = SIZE): { item: PdfTextItem; run: unknown[] } {
  const item: PdfTextItem = { str: s, x, y, width: s.length * CW, height: size, fontName: "f_text" };
  const widths: unknown[] = [];
  let space = 0;
  for (const ch of s) {
    if (ch === " ") { space += CW; continue; }
    widths.push(space ? [space, CW] : CW);
    space = 0;
  }
  return { item, run: [0, page - 1, x, HEIGHT - y - 0.2 * size, x + s.length * CW, HEIGHT - y + 0.7 * size, ...(widths.length === 1 ? [] : widths)] };
}

/** A document that reads, then broken by `r`: its structure and the pages pdf.js drew. */
function document(r: Rng, hostile = true): { structure: SdtStructure; pages: PdfPageText[] } {
  const pageCount = r.int(1, 3);
  const items = new Map<number, PdfTextItem[]>();
  const content: SdtBlock[] = [];
  const paths: number[][] = [];
  const paragraphOn = (page: number, y: number): { block: SdtBlock; y: number } => {
    const lines = r.int(1, 4);
    const runs: unknown[][] = [];
    let text = "";
    for (let k = 0; k < lines; k++, y += 14) {
      const s = Array.from({ length: r.int(1, 9) }, () => r.pick(WORDS)).join(" ") + (k === lines - 1 && r.chance(0.6) ? "." : "");
      const { item, run } = line(page, s, 72, y, r.chance(0.1) ? 7 : SIZE);
      items.set(page, [...(items.get(page) ?? []), item]);
      runs.push(run);
      text += (k ? " " : "") + s;
    }
    const block: SdtBlock = {
      type: "paragraph",
      anchor: { pageRects: [[page - 1, 72, HEIGHT - y, 500, HEIGHT - y + 14 * lines]] },
      content: [{ text, anchor: { textMap: json(runs) }, ...(r.chance(0.1) ? { style: { sup: true } } : {}) }],
    };
    return { block, y };
  };
  for (let page = 1; page <= pageCount; page++) {
    let y = 80;
    for (let b = r.int(1, 6); b > 0; b--) {
      const made = paragraphOn(page, y);
      y = made.y + 10;
      const block = made.block;
      if (r.chance(0.15)) block.type = r.pick(["heading", "math", "image", "table", "caption"]);
      if (r.chance(0.15)) block.flowClass = r.pick(["auxiliary", "excluded"]);
      if (r.chance(0.05)) block.reference = true;
      if (r.chance(0.15) && paths.length) block.previousPart = r.pick(paths);
      if (r.chance(0.05)) block.previousPart = [r.int(-1, 50), r.int(-1, 3)];
      if (r.chance(0.1)) block.backRefs = [[r.int(0, 20), 0]];
      if (r.chance(0.15)) {
        // A list of items, each a paragraph of its own or holding one.
        const list: SdtBlock = { type: "list", content: [] };
        for (let k = r.int(1, 3); k > 0; k--) {
          const it = paragraphOn(page, y);
          y = it.y + 10;
          list.content!.push(r.chance(0.5) ? { ...it.block, type: "listitem" } : { type: "listitem", content: [it.block] });
        }
        content.push(list);
      }
      paths.push([content.length]);
      content.push(block);
    }
  }
  const pages: PdfPageText[] = [...items].map(([page, list]) => ({ page, width: 612, height: HEIGHT, items: list, fonts: { f_text: "ABCDEF+Times-Roman" } }));
  const whole = { catalog: { pages: Array.from({ length: pageCount }, () => ({ viewRect: [0, 0, 612, HEIGHT] })) }, content };
  if (!hostile) return { structure: whole, pages };
  // And the hostile part.
  for (const p of pages) {
    if (r.chance(0.2)) p.transform = r.pick([[1, 0, 0, -1, 0, HEIGHT], [r.pick(BAD), 0, 0, -1, 0, HEIGHT], [1, 0], []]);
    for (const it of p.items) {
      if (r.chance(0.08)) (it as unknown as Record<string, number>)[r.pick(["x", "y", "width", "height"])] = r.pick(BAD);
      if (r.chance(0.03)) it.str = it.str.slice(0, r.int(0, it.str.length));
      if (r.chance(0.03)) it.rotated = true;
    }
    if (r.chance(0.1)) p.items.reverse();
  }
  const walk = (blocks: SdtBlock[]): void => {
    for (const block of blocks) {
      if (r.chance(0.05)) block.anchor = { pageRects: [[r.pick(BAD), r.pick(BAD), 0, r.pick(BAD), 1]] };
      for (const node of block.content ?? []) {
        if (!("text" in node)) { walk([node as SdtBlock]); continue; }
        const map = node.anchor?.textMap;
        if (!map) continue;
        const runs = JSON.parse(map) as unknown[][];
        for (const run of runs) {
          if (r.chance(0.08)) run[r.int(1, 5)] = r.pick(BAD);
          if (r.chance(0.05)) run.splice(r.int(6, run.length), r.int(1, 3));
          if (r.chance(0.05)) run.push(r.pick(BAD), [r.pick(BAD), CW]);
          if (r.chance(0.03)) run[1] = r.int(-2, 6);
        }
        if (r.chance(0.05)) node.text += r.pick([" extra", "é́", "-"]);
        if (r.chance(0.05)) node.text = node.text.slice(1);
        node.anchor = { textMap: r.chance(0.03) ? json(runs).slice(0, r.int(0, 40)) : json(runs) };
      }
    }
  };
  walk(content);
  return { structure: whole, pages };
}

describe("structured reading of a hostile structure", () => {
  it("a document that reads, broken every way a PDF can break it: never throws, every run inside its text, on an item of its page", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.boolean(), (seed, everything) => {
      const r = rng(seed);
      const { structure: s, pages: given } = document(r);
      const reader = createStructuredReader(s, { everything, pagesStay: r.chance(0.5) });
      for (let k = 0; k <= given.length; k++) {
        const drawn = given.slice(0, k);
        wellFormed(reader.blocks(drawn), drawn);
      }
    }), { numRuns: 600, seed: 0xA6A6 });
  });

  it("a document that reads, unbroken, reads its paragraphs back from pdf.js's runs", () => {
    // The generator's own check: without the hostile part its documents read, so the cases
    // above exercise the reading itself, not only its first refusals.
    let runs = 0;
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
      const { structure: s, pages: given } = document(rng(seed), false);
      for (const block of createStructuredReader(s, { everything: true }).blocks(given)) {
        for (const run of block.runs) {
          const item = given.find((p) => p.page === run.page)!.items[run.item]!;
          expect(item.str.slice(run.from, run.from + run.length)).toBe(block.text.slice(run.at, run.at + run.length));
          runs++;
        }
      }
    }), { numRuns: 100, seed: 0xA6A6 });
    expect(runs).toBeGreaterThan(500);
  });

  it("glyphsOf takes any textMap, valid JSON or not, and gives finite-length glyph lists", () => {
    fc.assert(fc.property(textMap, (map) => {
      const glyphs = glyphsOf(map);
      expect(Array.isArray(glyphs)).toBe(true);
    }), { numRuns: 500, seed: 0xA6A6 });
  });

  it("never throws, from the structure alone or with any pages drawn, and every run lies inside its text", () => {
    fc.assert(fc.property(structure, pages, fc.boolean(), fc.boolean(), (s, given, everything, pagesStay) => {
      const reader = createStructuredReader(s, { everything, pagesStay });
      wellFormed(reader.blocks(given), given);
      // Drawn again, and then with fewer pages: the reader is asked on every page drawn.
      wellFormed(reader.blocks(given), given);
      wellFormed(reader.blocks(given.slice(1)), given.slice(1));
    }), { numRuns: 400, seed: 0xA6A6 });
  });

  // Sizes no paper has and a PDF can: each threw (a spread past V8's ~120,000 arguments, a call
  // per level of nesting) or took time as the square of its size. A bound on time is what
  // tells linear from quadratic here: each was over ten seconds before.
  it("a page of 64,000 runs along one line is read in a bounded time", () => {
    const items: PdfTextItem[] = [];
    const runs: unknown[] = [];
    for (let i = 0; i < 64000; i++) {
      const { item, run } = line(1, "ab", 72 + i * 15, 100);
      items.push(item);
      runs.push(run);
    }
    const s: SdtStructure = { catalog: { pages: [{ viewRect: [0, 0, 612, HEIGHT] }] }, content: [{ type: "paragraph", content: [{ text: Array(64000).fill("ab").join(" "), anchor: { textMap: json(runs) } }] }] };
    const began = performance.now();
    const blocks = createStructuredReader(s).blocks([{ page: 1, width: 612, height: HEIGHT, items }]);
    expect(blocks).toHaveLength(1);
    expect(performance.now() - began).toBeLessThan(5000);
  });

  it("a paragraph of 300,000 characters, carried on from the one before, and blocks nested 100,000 deep are read", () => {
    let deep: SdtBlock = { type: "paragraph", content: [{ text: "the deepest text" }] };
    for (let i = 0; i < 100_000; i++) deep = { type: "blockquote", content: [deep] };
    const s: SdtStructure = {
      catalog: { pages: [] },
      content: [
        { type: "paragraph", content: [{ text: "It opens here and" }] },
        { type: "paragraph", previousPart: [0], content: [{ text: "goes on ".repeat(37_500) }] },
        { type: "paragraph", content: [{ text: "A paragraph holds a quotation " }, deep] },
        { type: "list", content: [{ type: "listitem", content: [deep] }] },
      ],
    };
    const blocks = createStructuredReader(s).blocks([]);
    expect(blocks[0]!.text.length).toBeGreaterThan(300_000);
    expect(blocks.some((b) => b.text.startsWith("A paragraph holds a quotation"))).toBe(true);
  });

  it("the reflow reads a page of 200,000 runs, a line of them one unbroken word, in a bounded time", () => {
    const items: PdfTextItem[] = Array.from({ length: 200_000 }, (_, i) => ({ str: "w", x: 72 + i * 5.5, y: 100, width: 5, height: 10, fontName: "f" }));
    const began = performance.now();
    const blocks = readReflowed([{ page: 1, width: 612, height: HEIGHT, items }]);
    expect(blocks.length).toBeGreaterThan(0);
    expect(performance.now() - began).toBeLessThan(10_000);
  }, 15_000); // past its own bound: vitest's 5 s would fail it first on a busy machine

  it("made in slices, reads as made at once", async () => {
    await fc.assert(fc.asyncProperty(structure, pages, async (s, given) => {
      const once = createStructuredReader(s).blocks(given);
      const sliced = await (await createStructuredReaderInSlices(s)).blocksInSlices(given);
      expect(sliced).toEqual(once);
    }), { numRuns: 100, seed: 0xA6A6 });
  });
});
