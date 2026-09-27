// lib/pdf/structured.ts — Zotero's reading of a PDF, as the reader's own paragraphs.
//
// Zotero's document-worker (https://github.com/zotero/document-worker, AGPL-3.0) reads a
// whole PDF at once: its pdf.js fork gives it every glyph with a rectangle, a model cuts
// each page into blocks, and rules decide which are body text, which are captions,
// footnotes, tables, running heads or references, and which paragraph carries on from
// which across a column or a page. The result is its Structured Document Text: a tree of
// typed blocks whose text nodes carry a `textMap` — one rectangle per glyph on the page.
//
// The reader still DISPLAYS the document with Mozilla's pdf.js, and highlights are
// painted on its text layer, which knows nothing of Zotero's glyphs: it has one span per
// text run, in content-stream order. So the work here is a translation. Every glyph of a
// body paragraph is found again among pdf.js's runs by where it is on the page and what
// character it is, and the paragraph comes out as a ReflowBlock with SourceRuns onto those
// runs — the same contract lib/pdf/reflow.ts produces, consumed unchanged by
// lib/pdf/units.ts. Pure, DOM-free, and covered by test/node/pdf-structured.test.ts.
//
// Three things are decided here and not by Zotero, each measured on the benchmark
// (test/pdf-bench) before it went in. Which blocks are READ: body paragraphs, list items
// and headings; what Zotero marks auxiliary or excluded (captions, notes, tables,
// figures, equations, furniture) is passed over without becoming a boundary, and a
// bibliography entry ends the writing. Which blocks are ONE paragraph: the parts Zotero
// links, and a paragraph an equation, a column or a page cut in two whose sentence runs
// on. And what the TEXT of a paragraph is: Zotero's glyphs, read by lib/pdf/reading.ts — a
// space put back where two glyphs stand a word apart, a hyphen kept where the document
// spells the word with it, a formula and a citation mark left out.
//
// The textMap decoding follows structured-document-text/src/pdf/decode.js of
// https://github.com/zotero/structured-document-text (AGPL-3.0).
import { ACCENT, MARK_NUMBERS, assemble, indexPage, isSpace, mathPagesOf, sameLine, type Box, type Glyph, type Located, type PageIndex, type Piece, type Source } from "./reading";
import { SENTENCE_END, vocabularyOf, type PdfPageText, type ReflowBlock } from "./reflow";

export { isMathFont } from "./reading";

// ---- the structure, as far as this reads it ----------------------------------------------

/** An inline text node: text with, when it came from the page, one rect per glyph. */
export interface SdtTextNode {
  text: string;
  anchor?: { textMap?: string };
  /** How the text is set; `sup` is a raised run. */
  style?: { sup?: boolean };
  /** Paths of the blocks the text refers to: the bibliography entries a citation names,
   *  a figure, an equation. */
  refs?: number[][];
}

/** A block of the content tree. Containers (list, blockquote) hold blocks; leaves hold text. */
export interface SdtBlock {
  type: string;
  content?: (SdtBlock | SdtTextNode)[];
  anchor?: { pageRects?: number[][]; textMap?: string };
  /** Zotero's verdict that the block is beside the body text ("auxiliary") or furniture
   *  ("excluded"). Absent means body. */
  flowClass?: string;
  /** A bibliography entry. */
  reference?: boolean;
  /** Path of the block this one continues (a paragraph carried over a column or page). */
  previousPart?: number[];
  nextPart?: number[];
}

export interface SdtStructure {
  catalog: { pages: { viewRect?: number[] }[] };
  content: SdtBlock[];
}

// ---- tuning -----------------------------------------------------------------------------

/** How far outside a run's box, in glyph heights, a glyph may still be that run's. */
const BOX_SLACK = 0.15;
/** A run's box reaches this far above its baseline and this far below, in its own size. */
const ASCENT = 1.0;
const DESCENT = 0.35;
/** How far, in run heights, a glyph may stand from the nearest run on its line and still
 *  be that run's: the width of the word space Zotero's fork folded into it. */
const DRIFT = 1.5;
/** How far right of a glyph, in run heights, the run it came from may stand: the spaces
 *  Zotero's fork dropped from a line add up along it (boxesFor). */
const REACH = 4;

// ---- glyphs -----------------------------------------------------------------------------

const SOFT_HYPHEN = 1;
const AXIS_SHIFT = 1;

/**
 * The glyph rects a textMap encodes, one per NON-WHITESPACE UTF-16 unit of the node's
 * text, in order. A run is [header, page, minX, minY, maxX, maxY, ...widths]; a width is
 * a number or [gap, width]; a single-glyph run carries no widths at all; a trailing soft
 * hyphen is a glyph the text does not have.
 */
export function glyphsOf(textMap: string | undefined): Glyph[] {
  if (!textMap) return [];
  let runs: unknown;
  try {
    runs = JSON.parse(textMap);
  } catch {
    return [];
  }
  if (!Array.isArray(runs)) return [];
  const out: Glyph[] = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length < 6) continue;
    const [header, page, minX, minY, maxX, maxY] = run as number[];
    const vertical = (((header >> AXIS_SHIFT) & 0b11) & 1) === 1;
    const widths = run.slice(6) as (number | [number, number])[];
    const positions: [number, number][] = [];
    let pos = vertical ? minY : minX;
    if (widths.length === 0) positions.push([pos, vertical ? maxY : maxX]);
    for (const w of widths) {
      if (Array.isArray(w)) pos += w[0];
      const width = Array.isArray(w) ? w[1] : w;
      positions.push([pos, pos + width]);
      pos += width;
    }
    if (header & SOFT_HYPHEN) positions.pop();
    for (const [a, b] of positions) {
      out.push(vertical ? { page, x1: minX, y1: a, x2: maxX, y2: b } : { page, x1: a, y1: minY, x2: b, y2: maxY });
    }
  }
  return out;
}

/** A glyph's centre in the page's top-left space, and its height there. */
function centreOf(g: Glyph, m: number[]): { cx: number; cy: number; h: number } {
  const xs = [g.x1, g.x2], ys = [g.y1, g.y2];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of xs) for (const y of ys) {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, h: maxY - minY };
}

/**
 * The runs a glyph may belong to, the likeliest first: the run whose box holds its centre
 * (the nearest when several do), else the nearest one to its right within DRIFT heights;
 * after it, every other run to its right on the line within REACH heights, nearest first.
 *
 * Zotero's fork folds a dropped word space into the glyphs after it and sets the rest of
 * the line on from there, so a glyph can stand a space's width LEFT of where pdf.js drew
 * it, and more further along a line that lost several: out of its own run and into the
 * gap before it, or into the run before it — the formula before a word, or an italic word
 * the next one follows without a space in Zotero's text. Never a run to its left: that is
 * the run the space came after.
 */
function boxesFor(index: PageIndex, g: Glyph): Box[] {
  const { cx, cy, h } = centreOf(g, index.transform);
  const boxes = index.boxes;
  // Baselines lie below a glyph's centre by up to its ascent; scan the band around it.
  let lo = 0, hi = boxes.length;
  const from = cy - 4 * h;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (boxes[mid].y < from) lo = mid + 1; else hi = mid; }
  let best: Box | null = null, bestScore = Infinity;
  let near: Box | null = null, nearScore = Infinity;
  const right: Box[] = [];
  for (let i = lo; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.y > cy + 4 * h) break;
    const slack = b.h * BOX_SLACK;
    if (cy < b.y - b.h * ASCENT - slack || cy > b.y + b.h * DESCENT + slack) continue;
    const dx = cx < b.x1 ? b.x1 - cx : cx > b.x2 ? cx - b.x2 : 0;
    const score = Math.abs(cy - (b.y - b.h * 0.35)) / b.h + dx / b.h;
    if (dx <= slack) {
      if (score < bestScore) { best = b; bestScore = score; }
    } else if (cx < b.x1 && dx <= b.h * DRIFT && score < nearScore) { near = b; nearScore = score; }
    if (cx < b.x1 && b.x1 - cx <= b.h * REACH) right.push(b);
  }
  const first = best ?? near;
  if (!first) return [];
  return [first, ...right.filter((b) => b !== first).sort((a, b) => a.x1 - b.x1)];
}

// ---- pieces of a paragraph ----------------------------------------------------------------

function isTextNode(node: SdtBlock | SdtTextNode): node is SdtTextNode {
  return typeof (node as SdtTextNode).text === "string";
}

/** The pieces of a block: its text nodes' units, each with its glyph, nested blocks' too.
 *  `raised` says which nodes are raised citations. */
function piecesOf(block: SdtBlock, raised: (node: SdtTextNode) => boolean, out: Piece[] = []): Piece[] {
  for (const node of block.content ?? []) {
    if (!isTextNode(node)) {
      if (out.length && out[out.length - 1].ch !== " ") out.push({ ch: " ", glyph: null });
      piecesOf(node, raised, out);
      continue;
    }
    const glyphs = glyphsOf(node.anchor?.textMap);
    const cite = raised(node) ? { raised: true } : {};
    let k = 0;
    let nonSpace = 0;
    for (const ch of node.text) nonSpace += isSpace(ch) ? 0 : ch.length;
    // A node whose glyph count does not fit its text is not trusted glyph by glyph.
    const trusted = glyphs.length === nonSpace;
    for (let i = 0; i < node.text.length; i++) {
      const ch = node.text[i];
      if (isSpace(ch)) out.push({ ch: " ", glyph: null, ...cite });
      else out.push({ ch, glyph: trusted ? glyphs[k++] : null, ...cite });
    }
  }
  return out;
}

/** How many letters away from where Zotero put it an accent's letter is looked for. */
const ACCENT_REACH = 3;

/**
 * Every accent after the letter it is drawn over. TeX sets an accent as a glyph of its own
 * and Zotero reads it as a combining mark, but it can put the mark past its letter —
 * "Alfven´" for "Alfvén", "Garcıá" for "García" — and the mark then accents another
 * letter, or none. The letter is the one of its word whose box holds the mark's centre.
 */
function placeMarks(pieces: Piece[]): Piece[] {
  const home = new Map<number, number>();
  pieces.forEach((m, i) => {
    if (!m.glyph || !ACCENT.test(m.ch)) return;
    const cx = (m.glyph.x1 + m.glyph.x2) / 2;
    const under = (j: number): boolean => {
      const g = pieces[j].glyph;
      return g !== null && g.page === m.glyph!.page && /\p{L}/u.test(pieces[j].ch) && g.x1 <= cx && cx <= g.x2 && sameLine(g, m.glyph!);
    };
    for (let j = i - 1, n = 0; j >= 0 && pieces[j].ch !== " " && n <= ACCENT_REACH; j--, n++) if (under(j)) return void home.set(i, j);
    for (let j = i + 1, n = 0; j < pieces.length && pieces[j].ch !== " " && n <= ACCENT_REACH; j++, n++) if (under(j)) return void home.set(i, j);
  });
  if (home.size === 0) return pieces;
  const after = new Map<number, Piece[]>();
  for (const [i, j] of home) after.set(j, [...(after.get(j) ?? []), pieces[i]]);
  const out: Piece[] = [];
  pieces.forEach((p, i) => {
    if (home.has(i)) return;
    out.push(p);
    out.push(...(after.get(i) ?? []));
  });
  return out;
}

/**
 * Find every piece's glyph among the text layer's runs: by geometry to the run, then in
 * order along the run's own string, so that "e" number three of a run is the third "e".
 * A glyph its run cannot take in order — the run has no such character left — is one
 * Zotero moved left out of a run further right (boxesFor): it is the next character of
 * that run, if it is the next character of one.
 */
function locate(pieces: Piece[], pagesByNumber: Map<number, PageIndex>): Located {
  const sources: (Source | null)[] = pieces.map(() => null);
  const faces: (Box | null)[] = pieces.map(() => null);
  /** How far along each run's string its glyphs have been found. */
  const cursor = new Map<Box, number>();
  const put = (i: number, box: Box, offset: number): void => {
    sources[i] = { page: box.page, item: box.item, offset, box };
    faces[i] = box;
    cursor.set(box, offset + 1);
  };
  /** Where `ch` is the next character of a run, spaces passed over, or -1. */
  const opens = (box: Box, ch: string): number => {
    const str = box.it.str;
    let k = cursor.get(box) ?? 0;
    while (k < str.length && isSpace(str[k])) k++;
    return str[k] === ch ? k : -1;
  };
  pieces.forEach((p, i) => {
    if (!p.glyph) return;
    const index = pagesByNumber.get(p.glyph.page + 1);
    if (!index) return;
    const [first, ...right] = boxesFor(index, p.glyph);
    if (!first) return;
    faces[i] = first;
    let j = first.it.str.indexOf(p.ch, cursor.get(first) ?? 0);
    if (j >= 0) return put(i, first, j);
    for (const box of right) {
      const k = opens(box, p.ch);
      if (k >= 0) return put(i, box, k);
    }
    // Out of step (a superscript Zotero read after the line): look from the start once.
    j = first.it.str.indexOf(p.ch);
    if (j >= 0) put(i, first, j);
  });
  return { sources, faces };
}

/**
 * A raised number Zotero links to the bibliography entries it names: a citation as
 * Nature's style and many journals' set it, "errors¹⁻⁴". Zotero links an exponent to the
 * entry of its number too ("cm²", "σ²"), so the mark is taken for a citation only after a
 * word (citationMarks).
 */
function isRaisedCitation(node: SdtTextNode, content: SdtBlock[]): boolean {
  if (!node.style?.sup || !node.refs?.length || !MARK_NUMBERS.test(node.text.trim())) return false;
  return node.refs.every((path) => blockAt(content, path)?.reference === true);
}

/** The block at a path of the content tree, if there is one. */
function blockAt(content: SdtBlock[], path: number[]): SdtBlock | undefined {
  let node: SdtBlock | SdtTextNode | undefined = { type: "root", content };
  for (const k of path) node = node && !isTextNode(node) ? node.content?.[k] : undefined;
  return node && !isTextNode(node) ? node : undefined;
}

// ---- the document -------------------------------------------------------------------------

/**
 * What is read of a node. A heading and a body paragraph are read; a bibliography entry
 * is a BARRIER, the end of the writing; everything else Zotero found — a display equation,
 * a caption, a footnote, a table, a figure's text, a running head, a page number — is
 * SKIPPED: not read, and not a boundary either. Such a block interrupts the layout, not the
 * writing: the paragraph before a display equation and the one after it are neighbours,
 * and often halves of one paragraph (see `continues`), and the reader's grouping of short
 * paragraphs (lib/plan/group.ts) must be free to read them together.
 */
type Reading = { kind: "heading" | "paragraph"; block: SdtBlock; path: number[]; origin: string };

/** What Zotero called a block, for the benchmark's accounting. */
function originOf(node: SdtBlock): string {
  return `${node.type}${node.flowClass ? `:${node.flowClass}` : ""}${node.reference ? ":ref" : ""}`;
}

function readingsOf(content: SdtBlock[], everything: boolean): (Reading | "barrier" | "display" | "skip")[] {
  const out: (Reading | "barrier" | "display" | "skip")[] = [];
  const aside = (node: SdtBlock, path: number[]): void => {
    if (everything) out.push({ kind: "paragraph", block: node, path, origin: originOf(node) });
    else out.push(node.reference ? "barrier" : node.type === "math" ? "display" : "skip");
  };
  content.forEach((node, i) => {
    if (node.flowClass || node.reference) { aside(node, [i]); return; }
    if (node.type === "heading") out.push({ kind: "heading", block: node, path: [i], origin: originOf(node) });
    else if (node.type === "paragraph") out.push({ kind: "paragraph", block: node, path: [i], origin: originOf(node) });
    else if (node.type === "list" || node.type === "blockquote") {
      (node.content ?? []).forEach((child, k) => {
        if (isTextNode(child)) return;
        if (child.reference || child.flowClass) { aside(child, [i, k]); return; }
        if (child.type === "listitem" || child.type === "paragraph") {
          // A list item with nested blocks reads as its paragraphs.
          const inner = (child.content ?? []).filter((c): c is SdtBlock => !isTextNode(c));
          if (inner.length === 0) out.push({ kind: "paragraph", block: child, path: [i, k], origin: originOf(child) });
          else inner.forEach((c, m) => { if (c.type === "paragraph") out.push({ kind: "paragraph", block: c, path: [i, k, m], origin: originOf(c) }); else aside(c, [i, k, m]); });
        } else aside(child, [i, k]);
      });
    } else aside(node, [i]);
  });
  return out;
}

/**
 * The paragraph after a display equation, a column or a page carries the one before it
 * on when that one did not end a sentence and this one opens in lower case — the reflow's
 * own test (lib/pdf/reflow.ts continuesInto). Zotero marks some of these itself
 * (`previousPart`); a LaTeX paragraph cut in two by its own equation it does not.
 */
function continues(prev: Piece[], next: Piece[]): boolean {
  const first = next.find((p) => p.ch !== " ");
  return runsOn(prev) && first !== undefined && /\p{Ll}/u.test(first.ch);
}

/** The text stops without ending its sentence. */
function runsOn(pieces: Piece[]): boolean {
  const text = pieces.map((p) => p.ch).join("").trimEnd();
  return text !== "" && !SENTENCE_END.test(text);
}

/** 1-based page a block starts on, by its first rect. */
function startPage(block: SdtBlock): number {
  const rect = block.anchor?.pageRects?.[0];
  return rect ? rect[0] + 1 : 0;
}

/**
 * A block's text as the document spelt it, for its vocabulary (lib/pdf/reflow.ts): a word
 * that runs on from one line or page to the next is two pieces there. Zotero mends every
 * such word — "nearequilibrium" for "near-/equilibrium" — and counted as written, that
 * mend was the document spelling the compound as one word, so every compound broken at a
 * line end was taken to be one and lost its hyphen.
 */
function written(pieces: Piece[]): string {
  let out = "";
  let prev: Glyph | null = null;
  for (const p of pieces) {
    if (p.ch === " ") { out += " "; prev = null; continue; }
    if (prev && p.glyph && !sameLine(prev, p.glyph)) out += " ";
    out += p.ch;
    if (p.glyph) prev = p.glyph;
  }
  return out;
}

/** 1-based page a block's text ends on, by its last glyph. */
function endPage(draft: Draft): number {
  for (let i = draft.pieces.length - 1; i >= 0; i--) {
    const g = draft.pieces[i].glyph;
    if (g) return g.page + 1;
  }
  return draft.block.page;
}

/**
 * Zotero's structure as ReflowBlocks over the pages the reader has rendered. A block on a
 * page not in `pages` keeps its text and comes back with no runs for that page, so
 * lib/pdf/units.ts leaves it unscored until the page is there. Blocks are in Zotero's
 * reading order; a paragraph Zotero marked as continued is one block.
 */
export interface StructuredOptions {
  /** Read EVERY block, whatever Zotero called it, and say what that was in `origin`:
   *  the benchmark's way of finding body text in blocks the reader leaves out. */
  everything?: boolean;
}

/** A ReflowBlock that remembers what Zotero called it (StructuredOptions.everything). */
export interface StructuredBlock extends ReflowBlock {
  origin?: string;
}

/** A block as read from the structure, before any page has been seen. */
interface Draft {
  block: StructuredBlock;
  pieces: Piece[];
  /** 1-based pages the block's glyphs lie on. */
  pages: number[];
  /** The last answer, and which of the block's pages were rendered when it was given. */
  seen: string | null;
  result: StructuredBlock | null;
  /** A display equation came after the block's last part. */
  display: boolean;
}

/**
 * The structure, read once, translated as often as the pages on screen change. The
 * reader calls `blocks` on every text layer pdf.js builds or drops, and a 300-page book is
 * ten thousand blocks: parsing every glyph map again each time cost a tenth of a second,
 * so the drafts are kept, and a block is only located again when one of ITS pages came or
 * went — the answer for every other block is the one given before.
 */
export interface StructuredReader {
  blocks(pages: readonly PdfPageText[]): StructuredBlock[];
}

export function createStructuredReader(structure: SdtStructure, options: StructuredOptions = {}): StructuredReader {
  const readings = readingsOf(structure.content, options.everything === true);
  /** The draft each read path became, for the parts that continue it. */
  const byPath = new Map<string, Draft>();
  const drafts: Draft[] = [];
  let barrier = true;
  /** The last paragraph read, still open for a continuation. */
  let open: Draft | null = null;
  for (const r of readings) {
    if (r === "barrier") { barrier = true; open = null; continue; }
    if (r === "display" && open) open.display = true;
    if (r === "skip" || r === "display") continue;
    const pieces = placeMarks(piecesOf(r.block, (node) => isRaisedCitation(node, structure.content)));
    const part = r.block.previousPart ? byPath.get(r.block.previousPart.join(".")) : undefined;
    const prev = part ?? (r.kind === "paragraph" && open !== null && !options.everything && continues(open.pieces, pieces) ? open : undefined);
    if (prev) {
      // Carried over an equation, a column or a page: one paragraph. A hyphen the break
      // left behind is mended when what follows is a lowercase continuation.
      const last = prev.pieces.at(-1);
      const first = pieces.find((p) => p.ch !== " ");
      if (last && last.ch === "-" && first && /\p{Ll}/u.test(first.ch)) prev.pieces.pop();
      else prev.pieces.push({ ch: " ", glyph: null });
      prev.pieces.push(...pieces);
      prev.display = false;
      byPath.set(r.path.join("."), prev);
      continue;
    }
    const page = startPage(r.block);
    const previous = drafts.at(-1);
    // A page is no break in the writing where the sentence before it goes on over it —
    // most often into a display equation at the head of the next page. Where it ended, the
    // page is where the reader's grouping stops, as it always did.
    const turned = previous !== undefined && endPage(previous) !== page && !(previous.block.kind === "paragraph" && runsOn(previous.pieces));
    const block: StructuredBlock = {
      kind: r.kind, text: "", page, runs: [], apart: false,
      columnBreak: barrier || !previous || turned,
      ...(options.everything ? { origin: r.origin } : {}),
    };
    barrier = false;
    const draft: Draft = { block, pieces, pages: [], seen: null, result: null, display: false };
    drafts.push(draft);
    byPath.set(r.path.join("."), draft);
    open = r.kind === "paragraph" ? draft : null;
  }
  for (const d of drafts) {
    const on = new Set<number>();
    for (const p of d.pieces) if (p.glyph) on.add(p.glyph.page + 1);
    d.pages = [...on].sort((a, b) => a - b);
  }
  const vocab = vocabularyOf(drafts.map((d) => written(d.pieces)));

  return {
    blocks(pages) {
      const pagesByNumber = new Map<number, PageIndex>();
      for (const p of pages) pagesByNumber.set(p.page, indexPage(p));
      const kinds = mathPagesOf(pagesByNumber);
      const out: StructuredBlock[] = [];
      for (const d of drafts) {
        const seen = d.pages.filter((n) => pagesByNumber.has(n)).join(",");
        if (d.seen !== seen) {
          const { text, runs } = assemble(d.pieces, locate(d.pieces, pagesByNumber), vocab, kinds);
          const on = d.display && d.block.kind === "paragraph" && !SENTENCE_END.test(text);
          d.result = text === "" ? null : { ...d.block, text, runs, ...(on ? { runsOn: true } : {}) };
          d.seen = seen;
        }
        if (d.result) out.push(d.result);
      }
      return out;
    },
  };
}

/** One reading, for one set of pages: the benchmark's call (test/pdf-bench/pipeline.ts). */
export function structuredBlocks(structure: SdtStructure, pages: readonly PdfPageText[], options: StructuredOptions = {}): StructuredBlock[] {
  return createStructuredReader(structure, options).blocks(pages);
}
