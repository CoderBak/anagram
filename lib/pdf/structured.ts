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
import { BARE_NUMBER, lineNumberMarks, mayHoldColumn, type NumberMark, type PageContent } from "./lineNumbers";
import { SENTENCE_END, vocabularyOf, type PdfPageText, type ReflowBlock } from "./reflow";
import { finish, finishInSlices } from "../slices";

export { isMathFont } from "./reading";

// ---- the structure, as far as this reads it ----------------------------------------------

/** An inline text node: text with, when it came from the page, one rect per glyph. */
export interface SdtTextNode {
  text: string;
  anchor?: { textMap?: string };
  /** How the text is set; `sup` is a raised run, `monospace` one in a typewriter face. */
  style?: { sup?: boolean; monospace?: boolean };
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
  /** Paths of the text nodes that refer to this block: the raised mark of a note. */
  backRefs?: number[][];
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
    const [header, page, minX, minY, maxX, maxY] = run as [number, number, number, number, number, number];
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
    positions.forEach(([a, b], k) => {
      const at = vertical ? { page, x1: minX, y1: a, x2: maxX, y2: b } : { page, x1: a, y1: minY, x2: b, y2: maxY };
      out.push(k === 0 ? { ...at, start: true } : at);
    });
  }
  return out;
}

/** A glyph's centre in the page's top-left space, and its height there. */
function centreOf(g: Glyph, m: number[]): { cx: number; cy: number; h: number } {
  const xs = [g.x1, g.x2], ys = [g.y1, g.y2];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of xs) for (const y of ys) {
    const px = m[0]! * x + m[2]! * y + m[4]!;
    const py = m[1]! * x + m[3]! * y + m[5]!;
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
  while (lo < hi) { const mid = (lo + hi) >> 1; if (boxes[mid]!.y < from) lo = mid + 1; else hi = mid; }
  let best: Box | null = null, bestScore = Infinity;
  let near: Box | null = null, nearScore = Infinity;
  const right: Box[] = [];
  for (let i = lo; i < boxes.length; i++) {
    const b = boxes[i]!;
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
      if (out.length && out[out.length - 1]!.ch !== " ") out.push({ ch: " ", glyph: null });
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
      const ch = node.text[i]!;
      if (isSpace(ch)) out.push({ ch: " ", glyph: null, ...cite });
      else out.push({ ch, glyph: trusted ? glyphs[k++]! : null, ...cite, ...(i === 0 ? { opens: true } : {}) });
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
      const g = pieces[j]!.glyph;
      return g !== null && g.page === m.glyph!.page && /\p{L}/u.test(pieces[j]!.ch) && g.x1 <= cx && cx <= g.x2 && sameLine(g, m.glyph!);
    };
    for (let j = i - 1, n = 0; j >= 0 && pieces[j]!.ch !== " " && n <= ACCENT_REACH; j--, n++) if (under(j)) return void home.set(i, j);
    for (let j = i + 1, n = 0; j < pieces.length && pieces[j]!.ch !== " " && n <= ACCENT_REACH; j++, n++) if (under(j)) return void home.set(i, j);
  });
  if (home.size === 0) return pieces;
  const after = new Map<number, Piece[]>();
  for (const [i, j] of home) after.set(j, [...(after.get(j) ?? []), pieces[i]!]);
  const out: Piece[] = [];
  pieces.forEach((p, i) => {
    if (home.has(i)) return;
    out.push(p);
    out.push(...(after.get(i) ?? []));
  });
  return out;
}

/** What pdf.js spells otherwise than Zotero does: TeX's ℓ, which Zotero reads as a plain "l". */
const SPELT: Record<string, string> = { l: "ℓ" };

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
    while (k < str.length && isSpace(str[k]!)) k++;
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
    // Out of step (a superscript Zotero read after the line): look from the start once. A
    // character that only the part already found holds, or the run holds not at all, is not
    // this one's: TeX's ℓ, which Zotero reads as "l", stands in the run beside it, and not in
    // the "areal" or the ", where" it stands against.
    j = first.it.str.indexOf(p.ch);
    const alias = SPELT[p.ch];
    if (alias && j < (cursor.get(first) ?? 0)) {
      for (const box of right) {
        const k = box.it.str.indexOf(alias, cursor.get(box) ?? 0);
        if (k >= 0) return put(i, box, k);
      }
    }
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
type Reading = { kind: "heading" | "paragraph" | "table" | "reference"; block: SdtBlock; path: number[]; origin: string };
type Marker = "barrier" | "display" | "skip";

/** What Zotero called a block, for the benchmark's accounting. */
function originOf(node: SdtBlock): string {
  return `${node.type}${node.flowClass ? `:${node.flowClass}` : ""}${node.reference ? ":ref" : ""}`;
}

/** The first text node of a block, however deep. */
function firstText(block: SdtBlock): SdtTextNode | null {
  for (const node of block.content ?? []) {
    if (isTextNode(node)) { if (node.text.trim() !== "") return node; continue; }
    const inner = firstText(node);
    if (inner) return inner;
  }
  return null;
}

/**
 * A note Zotero took for the body: it opens with a raised number and a raised mark of the
 * text links to it. A report's footnotes are set as "¹⁷DOD civilian personnel …", and
 * Zotero reads them as the items of a numbered list, yet links the body's "…by
 * location.¹⁸" to the item all the same. Where it links one note of such a list, the others
 * that open with a raised number are notes too: it can link a mark to the block after one.
 */
function isNote(block: SdtBlock): boolean {
  return (block.backRefs?.length ?? 0) > 0 && opensRaised(block);
}

/** The block opens with a raised number. */
function opensRaised(block: SdtBlock): boolean {
  const first = firstText(block);
  return first?.style?.sup === true && /^\s*\d{1,3}\s*$/u.test(first.text);
}

/** A raised mark an author's name or an affiliation carries: "1", "2,3", "a", "∗", "†". */
const AFFILIATION_MARK = /^(?:\d{1,2}(?:\s*,\s*\d{1,2})*,?|[a-h]|[∗*†‡§¶#]+)$/u;
/** What an affiliation or a title page's note names. */
const AFFILIATION = /universit|institut|department|dept\.|laborator|school|college|faculty|cent(?:er|re)\b|academy|hospital|clinic|corporation|\binc\b|\bltd\b|gmbh|e-?mail|@|correspond|contributed equally|equal contribution/iu;
/** An author list carries this many raised marks at least, one every this many words. */
const AUTHOR_MARKS = 3;
const WORDS_PER_MARK = 5;

/**
 * A paper's authors and affiliations, which Zotero reads as paragraphs of the first page:
 * "Alexandre Andre¹, Shivashriganesh P. Mahato¹, …", "¹Department of Physics, University of
 * …", "∗Corresponding author: …". An affiliation or a title page's note opens with its mark
 * and names an institution or an address; an author list carries a raised mark every few
 * words.
 */
function isTitlePageMatter(block: SdtBlock): boolean {
  if (startPage(block) !== 1) return false;
  const text = plainText(block);
  const first = firstText(block);
  if (AFFILIATION.test(text) && ((first?.style?.sup === true && AFFILIATION_MARK.test(first.text.trim())) || /^[∗*†‡§¶]/u.test(text))) return true;
  let marks = 0;
  for (const node of block.content ?? []) if (isTextNode(node) && node.style?.sup && AFFILIATION_MARK.test(node.text.trim())) marks++;
  return marks >= AUTHOR_MARKS && text.split(" ").length <= marks * WORDS_PER_MARK;
}

/** A paragraph this much of whose letters are set in a typewriter face, and this long, is
 *  code, a listing, or a prompt quoted as typed; unless the document's own paragraphs are
 *  mostly set in one (a screenplay, a typed filing), where the face is the body's. */
const CODE_SHARE = 0.9;
const CODE_CHARS = 20;
const TYPED_BODY = 0.5;

/** The letters of a block, and those of them Zotero styles monospace. */
function typewriter(block: SdtBlock, out = { mono: 0, all: 0 }): { mono: number; all: number } {
  for (const node of block.content ?? []) {
    if (!isTextNode(node)) { typewriter(node, out); continue; }
    const n = node.text.replace(/\s+/gu, "").length;
    out.all += n;
    if (node.style?.monospace) out.mono += n;
  }
  return out;
}

/**
 * Whether a paragraph Zotero read as body text is code: a listing, a JSON record, a prompt
 * quoted as typed (`" final_comment " : " Both i n q u i r i e s …`). Never in a document
 * whose paragraphs are mostly set in a typewriter face.
 */
function codeTest(content: SdtBlock[]): (block: SdtBlock) => boolean {
  const doc = { mono: 0, all: 0 };
  for (const node of content) if (!node.flowClass && !node.reference && (node.type === "paragraph" || node.type === "list")) typewriter(node, doc);
  if (doc.mono >= TYPED_BODY * doc.all) return () => false;
  return (block) => {
    const t = typewriter(block);
    return t.all >= CODE_CHARS && t.mono >= CODE_SHARE * t.all;
  };
}

/** The readings of the content tree. A table is skipped like the rest of what is set aside,
 *  and a bibliography entry is a barrier, unless either is the prose of a manuscript with
 *  numbered lines (numberedReadings). */
function readingsOf(content: SdtBlock[], everything: boolean): (Reading | Marker)[] {
  const out: (Reading | Marker)[] = [];
  const aside = (node: SdtBlock, path: number[]): void => {
    if (everything) out.push({ kind: "paragraph", block: node, path, origin: originOf(node) });
    else if (node.reference) out.push({ kind: "reference", block: node, path, origin: originOf(node) });
    else if (node.type === "table") out.push({ kind: "table", block: node, path, origin: originOf(node) });
    else out.push(node.type === "math" ? "display" : "skip");
  };
  const isCode = everything ? (): boolean => false : codeTest(content);
  content.forEach((node, i) => {
    if (node.flowClass || node.reference) { aside(node, [i]); return; }
    if ((isNote(node) || (node.type === "paragraph" && (isTitlePageMatter(node) || isCode(node)))) && !everything) { out.push("skip"); return; }
    if (node.type === "heading") out.push({ kind: "heading", block: node, path: [i], origin: originOf(node) });
    else if (node.type === "paragraph") out.push({ kind: "paragraph", block: node, path: [i], origin: originOf(node) });
    else if (node.type === "list" || node.type === "blockquote") {
      const notes = (node.content ?? []).some((child) => !isTextNode(child) && isNote(child));
      const bibliography = !everything && node.type === "list" && isBibliography(node);
      (node.content ?? []).forEach((child, k) => {
        if (isTextNode(child)) return;
        if (bibliography) { out.push({ kind: "reference", block: child, path: [i, k], origin: originOf(child) }); return; }
        if (child.reference || child.flowClass) { aside(child, [i, k]); return; }
        if ((isNote(child) || (notes && opensRaised(child)) || isTitlePageMatter(child) || isCode(child)) && !everything) { out.push("skip"); return; }
        if (child.type === "listitem" || child.type === "paragraph") {
          // A list item with nested blocks reads as its paragraphs.
          const inner = (child.content ?? []).filter((c): c is SdtBlock => !isTextNode(c));
          if (inner.length === 0) out.push({ kind: "paragraph", block: child, path: [i, k], origin: originOf(child) });
          else inner.forEach((c, m) => { if (c.type === "paragraph") out.push({ kind: "paragraph", block: c, path: [i, k, m], origin: originOf(c) }); else aside(c, [i, k, m]); });
        } else aside(child, [i, k]);
      });
    } else aside(node, [i]);
  });
  if (!everything) leaveOutContents(out);
  return out;
}

/** A block's text as Zotero has it, a nested block's a space apart. */
function plainText(block: SdtBlock): string {
  let out = "";
  for (const node of block.content ?? []) out += isTextNode(node) ? node.text : ` ${plainText(node)} `;
  return out.replace(/\s+/gu, " ").trim();
}

/** A bibliography entry's label, "[12]", and the year an entry cites. */
const ENTRY_LABEL = /^\[\d{1,4}\]/u;
const YEAR = /\b(?:1[5-9]|20)\d\d[a-z]?\b/u;
/** Shares of a list's items that must open with a label, and cite a year. */
const LABELLED_ITEMS = 0.6;
const DATED_ITEMS = 0.5;

/**
 * A bibliography Zotero did not find: a list whose items mostly open with a bracketed number
 * and cite a year, "[11]R. Saha, F. Fauth, … Phys. Rev. B 94, 064420 (2016)." A paper set
 * in REVTeX or JHEP's style has no References heading, and Zotero then reads the whole
 * bibliography as a list of the body. Every such list of the benchmark's corpora is one.
 */
function isBibliography(list: SdtBlock): boolean {
  const items = (list.content ?? []).filter((c): c is SdtBlock => !isTextNode(c)).map(plainText);
  return items.length > 0
    && items.filter((t) => ENTRY_LABEL.test(t)).length >= items.length * LABELLED_ITEMS
    && items.filter((t) => YEAR.test(t)).length >= items.length * DATED_ITEMS;
}

/** An entry of a table of contents or of a list of figures or tables: a dot leader, then
 *  the page it points to. An entry whose caption fills its last line keeps a leader of two
 *  or three dots ("…prediction [276].. .187"), taken only where the entry opens with its
 *  number. */
const CONTENTS_ENTRY = /(?:[.·…]\s*){4,}(?:\d{1,4}|[ivxlc]{1,7})$/iu;
const SHORT_LEADER = /[^.\s](?:\s*\.){2,3}\s*(?:\d{1,4}|[ivxlc]{1,7})$/iu;
/** What an entry opens with: its figure's, table's or section's number. */
const ENTRY_NUMBER = /^(?:[A-Z]\.?)?\d/u;
/** How many paragraphs Zotero may cut one entry into. */
const ENTRY_PARTS = 4;

/**
 * A thesis's or a report's contents, and its lists of figures and tables. Zotero reads an
 * entry as a paragraph or a list item, and a list of figures is the captions of the whole
 * document over again, so each was read and scored: "4.7 A simulation example of the rough
 * terrain … . . . . 50". Each entry ends in a dot leader and a page number, and the writing
 * stops there, as at a bibliography. So does every item of a list at least half of whose
 * items are entries (one set too full for a leader: "…the lattice results [219]146"). An
 * entry Zotero cut into paragraphs ("1.1 IHMC's fully electric Alex … A video is available
 * at" / "youtu.be/… . . . 2") is one: the part with the leader, which does not open with a
 * number, and the paragraphs before it back to the one that does.
 */
function leaveOutContents(out: (Reading | Marker)[]): void {
  const isEntry = (r: Reading | Marker): boolean => {
    if (typeof r === "string" || r.kind === "reference" || r.kind === "table") return false;
    const text = plainText(r.block);
    return CONTENTS_ENTRY.test(text) || (SHORT_LEADER.test(text) && ENTRY_NUMBER.test(text));
  };
  const entries = out.map(isEntry);
  // The items of each list, by the list's place in the tree.
  const lists = new Map<number, number[]>();
  out.forEach((r, k) => {
    if (typeof r !== "string" && r.path.length > 1) lists.set(r.path[0]!, [...(lists.get(r.path[0]!) ?? []), k]);
  });
  for (const items of lists.values()) {
    if (items.filter((k) => entries[k]).length * 2 >= items.length) for (const k of items) entries[k] = true;
  }
  entries.forEach((entry, k) => {
    const r = out[k]!;
    if (!entry || typeof r === "string") return;
    out[k] = "barrier";
    if (ENTRY_NUMBER.test(plainText(r.block))) return;
    const parts: number[] = [];
    for (let j = k - 1; j >= 0 && parts.length < ENTRY_PARTS; j--) {
      const p = out[j]!;
      if (p === "skip") continue;
      if (typeof p === "string" || p.kind !== "paragraph") return;
      parts.push(j);
      if (ENTRY_NUMBER.test(plainText(p.block))) {
        for (const q of parts) out[q] = "barrier";
        return;
      }
    }
  });
}

/** A caption's label, and what sets it off from the caption: "Figure 3:", "FIG. 1.", "Table
 *  S7:", "Figure 4 |", "Fig 3. GNSS…", "Figure-SI 4 Variability…", "TABLE IV COMPARISON".
 *  Never a sentence that names one: "Figure 3 compares", "Figure 4.21 shows", "Table 4.c
 *  shows", "Figures 4–7 establish", "Figure 1 (upper panel) presents". */
const CAPTION_LABEL = /^(?:(?:Supplementary|Suppl\.|Extended Data|Appendix)\s+)?(?:Fig(?:ure)?s?\.?|FIG(?:URE)?S?\.?|Tab(?:le)?\.?|TABLE|Chart|Scheme|Algorithm|Listing|Exhibit|Plate)[\s-]*(?:[A-Z]{1,2}[\s.-]?)?(?:\d+(?:[.\-–]\d+)*[a-z]?|[IVXLC]+)(?:\s*[:|]|\s+[—–]\s|\.(?=\s)|\s+(?=\p{Lu}))/u;
/** The words a sentence names a figure after: what follows them on the next line is that
 *  sentence ("…as shown in" / "Figure 6.32. Notice …"). */
const NAMES_NEXT = /(?:^|\s)(?:in|of|see|at|from|to|by|on|with|and|or|than|under|into|per|via|cf\.|e\.g\.,?|i\.e\.,?|the|a|an|this|that|these|those|our|shown)$/iu;

/**
 * Captions Zotero took for paragraphs. One that opens with its label — "Table S7: All five
 * conditioning rungs…", "FIG. 1. The partition sum…", "Figure 8 Difference of density
 * plots…" — is set aside as Zotero's own captions are, but not where the paragraph before
 * it stops at a word that names a figure and the label is set right under that paragraph's
 * last line: that is its own sentence carried on, "…as shown in" / "Figure 6.32. Notice this
 * node…". A paragraph the float cut off ("…are projected to" at the foot of one page, the
 * figure and its caption at the head of the next) stops at such a word too, and its caption is
 * still a caption. So is a paragraph that carries on the
 * caption set right above it (continuesCaption), and one that is the note set under a table
 * (notesTable). A reading whose lines are numbered is not one Zotero's paragraph stands for
 * (numberedReadings): `numbered` says which.
 */
function leaveOutCaptions(out: (Reading | Marker)[], content: SdtBlock[], numbered: (k: number) => boolean): void {
  let before: Reading | null = null;
  /** Paragraphs of the tree, by place, read as the rest of the caption or the table above. */
  const carried = new Map<number, "caption" | "table">();
  let body: number | null = null;
  const bodySize = (): number => (body ??= median(content.flatMap((b) => (b.type === "paragraph" && !b.flowClass ? runHeights(b) : []))));
  const restOfFloat = (r: Reading): boolean => {
    if (r.path.length !== 1 || r.block.previousPart) return false;
    const at = r.path[0]!;
    const above = content[at - 1];
    if (!above) return false;
    const float = carried.get(at - 1) ?? (above.type === "caption" && above.flowClass ? "caption" : above.type === "table" ? "table" : null);
    if (float === null) return false;
    if (!(float === "caption" ? continuesCaption(above, r.block) : notesTable(above, r.block, bodySize))) return false;
    carried.set(at, float);
    return true;
  };
  out.forEach((r, k) => {
    if (typeof r === "string") {
      if (r === "barrier") before = null;
      return;
    }
    const prev = before;
    before = r;
    if (r.kind !== "paragraph" || numbered(k)) return;
    if (!restOfFloat(r)) {
      if (!CAPTION_LABEL.test(plainText(r.block))) return;
      if (prev?.kind === "paragraph" && NAMES_NEXT.test(plainText(prev.block)) && setUnder(prev.block, r.block, CAPTION_RUN_ON_GAP)) return;
    }
    out[k] = "skip";
    before = prev;
  });
}

/** The rest of a caption Zotero read as a paragraph starts where the caption's next line
 *  would: at most this many of the paragraph's line heights below it, this many where the
 *  caption stops mid-sentence, and this many below a caption that is its label alone
 *  ("Figure 3.["). Body text after a float is set further off. */
const CAPTION_GAP = 0.25;
const CAPTION_RUN_ON_GAP = 0.6;
const CAPTION_LABEL_GAP = 1.5;
/** …and under it: this share of the narrower of the two. */
const CAPTION_OVERLAP = 0.8;
const BARE_LABEL = /^(?:fig(?:ure)?s?\.?|table|tab\.)\s*[A-Z]?\d+(?:[.\-–]\d+)*[a-z]?\s*[.:|]?\s*[[(]?$/iu;

/** A block's extent on its first or its last page, over its rects there: [page, x1, y1, x2,
 *  y2] in PDF space, y upward. */
function extentOn(block: SdtBlock, which: "first" | "last"): number[] | null {
  const rects = block.anchor?.pageRects;
  if (!rects?.length) return null;
  const page = rects[which === "first" ? 0 : rects.length - 1]![0]!;
  const on = rects.filter((r) => r[0] === page);
  return [page, Math.min(...on.map((r) => r[1]!)), Math.min(...on.map((r) => r[2]!)), Math.max(...on.map((r) => r[3]!)), Math.max(...on.map((r) => r[4]!))];
}

/**
 * The paragraph carries on the caption set right above it. Zotero can take a caption's first
 * lines for the caption and the rest for body text: "Figure 4 | Held-out accuracy at M4 under
 * five exploration conditions. Each dot is one system;" / "the horizontal line in each column
 * marks the median…". The rest starts where the caption's next line would, and under it.
 */
function continuesCaption(caption: SdtBlock, para: SdtBlock): boolean {
  const text = plainText(caption);
  return setUnder(caption, para, BARE_LABEL.test(text) ? CAPTION_LABEL_GAP : SENTENCE_END.test(text) ? CAPTION_GAP : CAPTION_RUN_ON_GAP);
}

/** A table's note is set off from the table by at least this many of its line heights and at
 *  most this many, and smaller than the body: its lines under this share of the body's. A
 *  paragraph of the body after a table is set at the body's size; one right against what
 *  Zotero took for a table is the table's own text, or text Zotero mistook for a table. */
const NOTE_SET_OFF = 0.5;
const NOTE_GAP = 1.3;
const NOTE_SIZE = 0.95;

/**
 * The paragraph is the note set under a table: "BC, bounded coalescent; SC, standard
 * coalescent; …", "Notes. Columns: (1) PAH band(s) included in the ratio; …", "Agreement is the
 * percentage of replicates in which…". Zotero sets the table aside and reads its note as body
 * text. `bodySize` is the size of the document's body lines.
 */
function notesTable(table: SdtBlock, para: SdtBlock, bodySize: () => number): boolean {
  return setUnder(table, para, NOTE_GAP, table.type === "table" ? NOTE_SET_OFF : -1) && median(runHeights(para)) < NOTE_SIZE * bodySize();
}

/** The paragraph starts on the page `above` ends on, under it (sharing this much of the
 *  narrower of the two's width), at least `least` and at most `limit` of its line heights
 *  below it. */
function setUnder(above: SdtBlock, para: SdtBlock, limit: number, least = -1): boolean {
  const c = extentOn(above, "last"), p = extentOn(para, "first");
  const glyph = glyphsOf(firstText(para)?.anchor?.textMap)[0];
  if (!c || !p || !glyph || c[0] !== p[0]) return false;
  const h = glyph.y2 - glyph.y1;
  const overlap = Math.min(c[3]!, p[3]!) - Math.max(c[1]!, p[1]!);
  if (!(h > 0) || overlap < CAPTION_OVERLAP * Math.min(c[3]! - c[1]!, p[3]! - p[1]!)) return false;
  const gap = c[2]! - p[4]!;
  return gap >= h * least && gap <= h * limit;
}

/** The heights of the runs of a block's text, as its glyph maps give them. */
function runHeights(block: SdtBlock, out: number[] = []): number[] {
  for (const node of block.content ?? []) {
    if (!isTextNode(node)) { runHeights(node, out); continue; }
    let runs: unknown;
    try {
      runs = JSON.parse(node.anchor?.textMap ?? "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(runs)) continue;
    for (const run of runs) if (Array.isArray(run) && run.length >= 6) out.push((run[5] as number) - (run[3] as number));
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

// ---- the order of a page's columns -----------------------------------------------------------
//
// Zotero reads a page column by column, but a magazine's or a newsletter's page it can read in
// the wrong order of columns: under a photograph set across the page, the middle and right
// columns before the left one ("- a definite favourite for many curious families…" before
// "and information centres. The first day took off…"); a framed article on the right before
// the two boxes to its left, and the lower of those before the upper one. The runs of blocks
// it read down one column are kept as it read them, and the runs of a page are put in the
// order the page sets them: a run before any run it stands above in the same column, and
// before any run it stands left of in the same band of the page. Where Zotero's order keeps
// both, as on a paper's pages, nothing moves.

/** How far, in points, two blocks may overlap and still be one above or left of the other. */
const ORDER_SLACK = 3;
/** The share of the narrower (or the shorter) of two runs they must have in common to be in
 *  one column (or one band). */
const SHARED = 0.5;

/** A block's extent on its first page, [x1, y1, x2, y2] in PDF space (y upward), and whether
 *  it goes on to another page. */
function boxOf(block: SdtBlock): { page: number; box: number[]; spans: boolean } | null {
  const rects = block.anchor?.pageRects;
  if (!rects?.length) return null;
  const page = rects[0]![0]!;
  const on = rects.filter((r) => r[0] === page);
  return {
    page,
    box: [Math.min(...on.map((r) => r[1]!)), Math.min(...on.map((r) => r[2]!)), Math.max(...on.map((r) => r[3]!)), Math.max(...on.map((r) => r[4]!))],
    spans: on.length < rects.length,
  };
}

const shared = (a1: number, a2: number, b1: number, b2: number): number => Math.min(a2, b2) - Math.max(a1, b1);
const inColumn = (a: number[], b: number[]): boolean => shared(a[0]!, a[2]!, b[0]!, b[2]!) >= SHARED * Math.min(a[2]! - a[0]!, b[2]! - b[0]!);
/** A block under a headline is in the headline's column when it shares this much of its own width
 *  with it: a headline set across two columns is no part of the right one. */
const HEADLINE_SHARED = 0.8;
const inHeadline = (a: number[], b: number[]): boolean => shared(a[0]!, a[2]!, b[0]!, b[2]!) >= HEADLINE_SHARED * Math.min(a[2]! - a[0]!, b[2]! - b[0]!);
const inBand = (a: number[], b: number[]): boolean => shared(a[1]!, a[3]!, b[1]!, b[3]!) >= SHARED * Math.min(a[3]! - a[1]!, b[3]! - b[1]!);
/** `a` is to be read before `b`: above it in its column, or left of it in its band. */
const readsBefore = (a: number[], b: number[]): boolean =>
  (a[1]! >= b[3]! - ORDER_SLACK && inColumn(a, b)) || (a[2]! <= b[0]! + ORDER_SLACK && inBand(a, b));

/** The readings with each page's runs of blocks in the page's order of columns. A reading
 *  keeps the markers after it; a bibliography entry, a barrier, a block that goes on to the
 *  next page and one with no rects end the stretch of a page that can move. */
function readInColumns(out: (Reading | Marker)[]): (Reading | Marker)[] {
  interface Item { parts: (Reading | Marker)[]; box: number[]; heading: boolean }
  const result: (Reading | Marker)[] = [];
  let stretch: Item[] = [];
  let page = -1;
  const flush = (): void => {
    for (const item of orderRuns(stretch)) result.push(...item.parts);
    stretch = [];
  };
  for (const r of out) {
    if (typeof r === "string") {
      if (stretch.length) stretch[stretch.length - 1]!.parts.push(r);
      else result.push(r);
      if (r === "barrier") flush();
      continue;
    }
    const at = r.kind === "reference" ? null : boxOf(r.block);
    if (!at) { flush(); result.push(r); page = -1; continue; }
    if (at.page !== page) flush();
    page = at.page;
    stretch.push({ parts: [r], box: at.box, heading: r.kind === "heading" });
    if (at.spans) { flush(); page = -1; }
  }
  flush();
  return result;

  function orderRuns<T extends { box: number[]; heading: boolean }>(items: T[]): T[] {
    if (items.length < 3) return items;
    // Runs: each block below the one before it, in its column.
    const runs: { items: T[]; box: number[] }[] = [];
    for (const item of items) {
      const run = runs[runs.length - 1];
      const last = run?.items[run.items.length - 1];
      if (run && last && item.box[3]! <= last.box[1]! + ORDER_SLACK && (last.heading ? inHeadline : inColumn)(item.box, last.box)) {
        run.items.push(item);
        run.box = [Math.min(run.box[0]!, item.box[0]!), Math.min(run.box[1]!, item.box[1]!), Math.max(run.box[2]!, item.box[2]!), Math.max(run.box[3]!, item.box[3]!)];
      } else runs.push({ items: [item], box: [...item.box] });
    }
    if (runs.length < 2) return items;
    // The page's order, Zotero's where the page leaves it open; Zotero's if it goes round.
    const before = runs.map((a, i) => runs.map((b, j) => i !== j && readsBefore(a.box, b.box)));
    const done = runs.map(() => false);
    const order: number[] = [];
    while (order.length < runs.length) {
      const next = runs.findIndex((_, j) => !done[j] && runs.every((_, i) => done[i] || !before[i]![j]));
      if (next < 0) return items;
      done[next] = true;
      order.push(next);
    }
    return order.flatMap((i) => runs[i]!.items);
  }
}

/** A reading with its pieces: what the drafts are made of. `paths` are the content tree's
 *  paths it reads, for the parts Zotero says continue it. */
interface Prepared {
  kind: "heading" | "paragraph";
  pieces: Piece[];
  page: number;
  paths: string[];
  previousPart?: string;
  origin: string;
}

// ---- a manuscript's numbered lines ---------------------------------------------------------
//
// A manuscript sent for review numbers its lines (lib/pdf/lineNumbers.ts), and Zotero's
// model reads such a page as nothing else: each number looks like a list's marker, so each
// line becomes an item of a list, and a page of numbered prose often a table, which the
// reader sets aside. Where Zotero's glyphs show a column of line numbers, the numbers are
// left out, a table whose every line is numbered and none holds a table's gaps is read as
// the prose it is, and the paragraphs of those lines — which Zotero did not find — are found
// again as the reflow finds them: by a first-line indent, a last line that stopped short
// before a new sentence, and a gap wider than the line pitch.

const DIGIT = /^\p{Nd}$/u;
const HYPHEN_PIECE = /^[-‐]$/u;
/** Two glyphs closer than this share of their height are set against each other: no space. */
const TOUCH = 0.15;
/** As lib/pdf/reflow.ts: a gap of this many line pitches, an indent of this share of the
 *  size, and a last line this many sizes short of the measure start a paragraph. */
const PARA_GAP = 1.45;
const INDENT = 0.5;
const SHORT_LINE = 2;
/** A manuscript whose numbered lines end flush right fewer than this share of the time is
 *  set ragged, and there only a line that ends before this share of the measure stopped
 *  short. */
const FLUSH_SHARE = 0.5;
const RAGGED_SHORT = 0.7;
/** A gap this many sizes wide inside a line is a table's, between two cells. */
const CELL_GAP = 1.5;
/** Share of a table's lines that must be numbered, and at most hold a cell's gap, for it to
 *  be prose. */
const NUMBERED_TABLE = 0.9;
const GAPPED_TABLE = 0.1;
const LIST_OPENING = /^(?:[•▪◦‣·∙*]|[–—-]\s)/u;
/** The heading of a bibliography, numbered or not. */
const REFERENCES_HEAD = /^(?:[\dIVX]+(?:\.\d+)*\.?\s*)?(?:references|bibliography|literature cited|works cited|reference list|cited literature)\s*:?$/iu;
const FRESH_START = /^[\p{Lu}\p{Lt}\d"“'‘([]/u;

function touching(a: Glyph, b: Glyph): boolean {
  const h = Math.max(a.y2 - a.y1, b.y2 - b.y1);
  const gap = b.x1 - a.x2;
  return sameLine(a, b) && gap < h * TOUCH && gap > -h;
}

/** Two pieces set against each other in one text node; a new node is another run. */
const glued = (a: Piece | undefined, b: Piece | undefined): boolean => !!a?.glyph && !!b?.glyph && !b.opens && touching(a.glyph, b.glyph);

/**
 * Two pieces set against each other, unless a word begins a run of Zotero's glyph map there:
 * where a line's number and its text are parted by white space in a tab or a run of spaces,
 * Zotero's fork folds the space's width out of the text, which then starts exactly where the
 * number ends ("21As the basic", "32smallholder", "372020-2050"), and only the run says the
 * two are apart. A full stop or a bracket after a number is the number's own ("1.").
 */
const within = (a: Piece | undefined, b: Piece | undefined): boolean => glued(a, b) && !(b!.glyph!.start === true && /^[\p{L}\p{N}]$/u.test(b!.ch));

/** The numbers a run alone parts from their text found a column of line numbers only on a
 *  page that holds this many of them; elsewhere they join a column found. */
const FOLDED_MIN = 16;

/** Where down the page a glyph's middle is: PDF space grows upward. */
const down = (g: Glyph): number => -(g.y1 + g.y2) / 2;

/**
 * The pieces of these blocks that number their lines: a bare number of Zotero's text —
 * digits set against each other, nothing set against them — that stands first or last on
 * its line among every glyph of the page, in a column of such numbers counting on.
 */
function* lineNumberPieces(texts: Piece[][]): Generator<void, Set<Piece>> {
  const marks: (NumberMark & { run: Piece[]; folded: boolean })[] = [];
  for (const pieces of texts) {
    yield;
    for (let i = 0; i < pieces.length; i++) {
      const g = pieces[i]!.glyph;
      if (!g || !DIGIT.test(pieces[i]!.ch)) continue;
      let j = i + 1;
      while (j < pieces.length && DIGIT.test(pieces[j]!.ch) && within(pieces[j - 1], pieces[j])) j++;
      const run = pieces.slice(i, j);
      const text = run.map((p) => p.ch).join("");
      if (BARE_NUMBER.test(text) && !glued(pieces[i - 1], pieces[i]) && !within(pieces[j - 1], pieces[j])) {
        const glyphs = run.map((p) => p.glyph!);
        // Set against the text by Zotero's glyphs, and parted from it only by the run.
        let k = i + 1;
        while (k < pieces.length && DIGIT.test(pieces[k]!.ch) && glued(pieces[k - 1], pieces[k])) k++;
        const folded = !(BARE_NUMBER.test(pieces.slice(i, k).map((p) => p.ch).join("")) && !glued(pieces[i - 1], pieces[i]) && !glued(pieces[k - 1], pieces[k]));
        marks.push({
          page: g.page, x1: Math.min(...glyphs.map((q) => q.x1)), x2: Math.max(...glyphs.map((q) => q.x2)),
          y: down(g), h: g.y2 - g.y1, value: Number(text), first: true, last: true, run, folded,
        });
      }
      i = j - 1;
    }
  }
  // A page of numbered prose holds this many lines at least; an algorithm's, a list's or a
  // table's numbers, which the run alone parts from their text, are fewer, and found nothing.
  const foldedOn = new Map<number, number>();
  for (const m of marks) if (m.folded) foldedOn.set(m.page, (foldedOn.get(m.page) ?? 0) + 1);
  for (const m of marks) if (m.folded && foldedOn.get(m.page)! < FOLDED_MIN) m.weak = true;
  if (!mayHoldColumn(marks)) return new Set();
  // Where each mark stands on its line, among every glyph of its page; and what else each
  // printed line of the pages holds, from where it starts to where it ends.
  const pages = new Set(marks.map((m) => m.page));
  const byPage = new Map<number, Glyph[]>();
  const inMark = new Set<Piece>(marks.flatMap((m) => m.run));
  const content: PageContent[] = marks.map((m) => ({ page: m.page, x1: m.x1, x2: m.x2, y: m.y, weight: m.run.length, mark: m }));
  for (const pieces of texts) {
    yield;
    if (!pieces.some((p) => p.glyph && pages.has(p.glyph.page))) continue;
    for (const row of rowsOf(pieces, inMark)) {
      if (!pages.has(row.page)) continue;
      const list = byPage.get(row.page) ?? [];
      byPage.set(row.page, list);
      let x1 = Infinity, x2 = -Infinity, weight = 0;
      /** Where the row's own number ended, while its text has not begun. */
      let number: Glyph | null = null;
      /** The text starts where the number ends, in the run after it: the space between them
       *  was folded out, and the text stands at least a space further right. */
      let folded = 0;
      for (const p of row.pieces) {
        if (!p.glyph) continue;
        list.push(p.glyph);
        if (inMark.has(p)) { number = p.glyph; continue; }
        if (number && weight === 0 && p.glyph.start && /^[\p{L}\p{N}]$/u.test(p.ch) && sameLine(number, p.glyph) && Math.abs(p.glyph.x1 - number.x2) <= (p.glyph.y2 - p.glyph.y1) * TOUCH) folded = p.glyph.y2 - p.glyph.y1;
        x1 = Math.min(x1, p.glyph.x1);
        x2 = Math.max(x2, p.glyph.x2);
        weight++;
      }
      x1 += folded;
      x2 += folded;
      if (weight > 0) content.push({ page: row.page, x1, x2, y: (row.top + row.bottom) / 2, weight });
    }
  }
  for (const list of byPage.values()) list.sort((a, b) => down(a) - down(b));
  for (const m of marks) {
    yield;
    const list = byPage.get(m.page)!;
    const own = new Set(m.run.map((p) => p.glyph));
    const g = m.run[0]!.glyph!;
    const mid = (m.x1 + m.x2) / 2;
    let lo = 0, hi = list.length;
    while (lo < hi) { const k = (lo + hi) >> 1; if (down(list[k]!) < m.y - 2 * m.h) lo = k + 1; else hi = k; }
    for (let k = lo; k < list.length && down(list[k]!) <= m.y + 2 * m.h; k++) {
      const o = list[k]!;
      if (own.has(o) || !sameLine(o, g)) continue;
      if ((o.x1 + o.x2) / 2 < mid) m.first = false;
      else m.last = false;
    }
  }
  return new Set([...lineNumberMarks(marks, content)].flatMap((m) => m.run));
}

/**
 * A block's pieces without its line numbers. Where a number stood at a line break the words
 * either side of it meet as the break would have had them: a hyphen before a lower-case
 * continuation, or a word Zotero ran straight into the number (a hyphenation it mended),
 * joins the next line's word — the hyphen is then the document's to keep or drop
 * (lib/pdf/reading.ts); otherwise one space parts them.
 */
function withoutNumbers(pieces: Piece[], numbers: ReadonlySet<Piece>): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (!numbers.has(pieces[i]!)) { out.push(pieces[i]!); continue; }
    let j = i;
    while (j < pieces.length && numbers.has(pieces[j]!)) j++;
    let k = j;
    while (k < pieces.length && pieces[k]!.ch === " ") k++;
    let t = out.length - 1;
    while (t >= 0 && out[t]!.ch === " ") t--;
    const runInto = out.length > 0 && out[out.length - 1]!.ch !== " ";
    const prev = out[t], next = pieces[k];
    const broken = prev?.glyph && next?.glyph && !sameLine(prev.glyph, next.glyph);
    if (broken && HYPHEN_PIECE.test(prev.ch) && /\p{Ll}/u.test(next.ch)) {
      out.length = t;
      i = k - 1;
    } else if ((broken && runInto) || !runInto) {
      // One word over the break, or a space before the number already parts the words.
      i = k - 1;
    } else {
      // A number run into a word of its own line: the space after it parts them.
      i = j - 1;
      if (k === j) out.push({ ch: " ", glyph: null });
    }
  }
  return out;
}

/** One printed line of a block, as its glyphs lie. */
interface Row {
  pieces: Piece[];
  page: number;
  x0: number;
  x1: number;
  /** Down the page: the top and bottom of the line's first glyph, and its height. */
  top: number;
  bottom: number;
  h: number;
  /** A line number was set on the line. */
  numbered: boolean;
  /** The line opens its block. */
  opens: boolean;
  /** Its reading, as an index into the pool. */
  from: number;
  /** A cell's gap stands inside the line. */
  gapped: boolean;
}

/** A block's pieces cut into its printed lines: a glyph starts a line where its middle is
 *  below the line's first glyph, well above it (a new column), or on another page. A piece
 *  with no glyph stays on the line it comes after. */
function rowsOf(pieces: Piece[], numbers: ReadonlySet<Piece>): Row[] {
  const rows: Row[] = [];
  let row: Row | null = null;
  let last: Glyph | null = null;
  const pending: Piece[] = [];
  for (const p of pieces) {
    const g = p.glyph;
    if (g) {
      const mid = down(g);
      if (!row || row.page !== g.page || mid > row.bottom || mid < row.top - row.h) {
        row = { pieces: rows.length === 0 ? pending.splice(0) : [], page: g.page, x0: g.x1, x1: g.x2, top: -g.y2, bottom: -g.y1, h: g.y2 - g.y1, numbered: false, opens: rows.length === 0, from: 0, gapped: false };
        rows.push(row);
        last = null;
      }
      row.x0 = Math.min(row.x0, g.x1);
      row.x1 = Math.max(row.x1, g.x2);
      if (last && g.x1 - last.x2 > row.h * CELL_GAP) row.gapped = true;
      last = g;
    }
    if (row) row.pieces.push(p);
    else pending.push(p);
    if (row && numbers.has(p)) row.numbered = true;
  }
  return rows;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))] ?? 0;
}

const firstLetter = (pieces: Piece[]): string => pieces.find((p) => p.ch !== " ")?.ch ?? "";

/**
 * The paragraphs of a run of numbered lines, by the reflow's signals on each page's own
 * margins and pitch (`pages`): a line below the last by more than PARA_GAP pitches, one
 * indented where the last was flush, one opening a sentence or a list item after a line
 * that stopped short; and it goes on over a page or a column where its last line ran full
 * without ending a sentence and the next line is not indented. A manuscript is often set
 * ragged right, where every line stops a word or two short of the margin and as often as
 * not the next opens with a capital or a bracket: there a line has stopped short only well
 * inside the measure.
 */
function paragraphsOfRows(rows: Row[], pages: ReadonlyMap<number, Margins>, ragged: boolean): Row[][] {
  const out: Row[][] = [];
  const short = (r: Row, m: Margins): boolean =>
    ragged ? r.x1 < m.left + (m.right - m.left) * RAGGED_SHORT : r.x1 < m.right - r.h * SHORT_LINE;
  const indented = (r: Row, m: Margins): boolean => r.x0 > m.left + r.h * INDENT;
  const listItem = (r: Row): boolean => LIST_OPENING.test(r.pieces.map((p) => p.ch).join("").trimStart());
  rows.forEach((b, i) => {
    const a = rows[i - 1];
    const m = pages.get(b.page);
    const ma = a && pages.get(a.page);
    let breaks: boolean;
    if (!a || !m || !ma) breaks = true;
    else if (a.page !== b.page || b.top <= a.top) {
      // Over a page or a column: the paragraph goes on where its last line ran full to the
      // margin without ending a sentence and the next opens neither indented nor as an item.
      const ended = SENTENCE_END.test(a.pieces.map((p) => p.ch).join("").trimEnd());
      breaks = ended || short(a, ma) || indented(b, m) || listItem(b);
    } else {
      breaks = b.top - a.top > m.pitch * PARA_GAP
        || (indented(b, m) && !indented(a, m))
        || (short(a, m) && FRESH_START.test(firstLetter(b.pieces)))
        || listItem(b);
    }
    if (breaks) out.push([b]);
    else out[out.length - 1]!.push(b);
  });
  return out;
}

/** The lines of one paragraph as its pieces: lines of one block as Zotero joined them, the
 *  line that opens another block after a space, or after the hyphen it mends. */
function joinRows(rows: Row[]): Piece[] {
  const out: Piece[] = [];
  for (const r of rows) {
    const pieces = r.pieces;
    if (out.length > 0 && r.opens) {
      while (out.length && out[out.length - 1]!.ch === " ") out.pop();
      const first = pieces.find((p) => p.ch !== " ");
      if (out.length && HYPHEN_PIECE.test(out[out.length - 1]!.ch) && first && /\p{Ll}/u.test(first.ch)) out.pop();
      else out.push({ ch: " ", glyph: null });
    }
    out.push(...pieces);
  }
  while (out.length && out[0]!.ch === " ") out.shift();
  return out;
}

/** A page's numbered prose: its left and right margins, and its line pitch. */
interface Margins {
  left: number;
  right: number;
  pitch: number;
}

/** A reading as it is prepared when nothing of it is numbered. */
function plain(r: Reading, pieces: Piece[]): Prepared | Marker {
  if (r.kind === "table") return "skip";
  if (r.kind === "reference") return "barrier";
  return { kind: r.kind, pieces, page: startPage(r.block), paths: [r.path.join(".")], ...(r.block.previousPart ? { previousPart: r.block.previousPart.join(".") } : {}), origin: r.origin };
}

/**
 * The readings of a document whose lines are numbered: every number left out, and the runs
 * of consecutive numbered prose — paragraphs, list items, tables that are prose — read again
 * as the paragraphs their lines make. A heading keeps its place; a reading with no number
 * on it is Zotero's as it was. (With `everything`, the numbers only are left out.)
 */
function numberedReadings(readings: (Reading | Marker)[], texts: (Piece[] | null)[], numbers: ReadonlySet<Piece>, everything: boolean): (Prepared | Marker)[] {
  const out: (Prepared | Marker)[] = [];
  /** Each run of numbered prose: its readings, and their lines. */
  const pools: { at: number; readings: Reading[]; rows: Row[] }[] = [];
  let pool: { at: number; readings: Reading[]; rows: Row[] } | null = null;
  // Zotero takes numbered lines for the numbered entries of a bibliography, wherever they
  // are: before the document's own References heading, such an entry is its prose.
  const bibliography = readings.findIndex((r, k) => typeof r !== "string" && r.kind !== "table" && REFERENCES_HEAD.test(withoutNumbers(texts[k] ?? [], numbers).map((p) => p.ch).join("").trim()));
  readings.forEach((r, k) => {
    const pieces = texts[k];
    // A run of numbered prose goes on past what is skipped — a page's furniture, a figure —
    // and stops at a bibliography's barrier or a display equation.
    if (typeof r === "string" || !pieces) { if (r !== "skip") pool = null; out.push(r as Marker); return; }
    const numbered = pieces.some((p) => numbers.has(p));
    if (r.kind === "reference" && (!numbered || bibliography < 0 || k >= bibliography)) { pool = null; out.push("barrier"); return; }
    if (!numbered) { pool = null; out.push(plain(r, pieces)); return; }
    const kept = withoutNumbers(pieces, numbers);
    if (everything || r.kind === "heading") {
      pool = null;
      out.push({ ...(plain(r, kept) as Prepared), kind: r.kind === "heading" ? "heading" : "paragraph" });
      return;
    }
    const rows = rowsOf(kept, numbers);
    if (r.kind === "table") {
      // Prose only if nearly every line carried a number and hardly any holds a cell's gap.
      const lines = rowsOf(pieces, numbers);
      const numbered = lines.filter((l) => l.numbered).length;
      if (numbered < lines.length * NUMBERED_TABLE || rows.filter((l) => l.gapped).length > rows.length * GAPPED_TABLE) {
        out.push("skip");
        return;
      }
    }
    if (!pool) {
      pool = { at: out.length, readings: [], rows: [] };
      pools.push(pool);
      out.push("skip");
    }
    for (const row of rows) row.from = pool.readings.length;
    pool.readings.push(r);
    pool.rows.push(...rows);
  });
  // Each page's margins and line pitch, from all its numbered prose.
  const byPage = new Map<number, { rows: Row[]; steps: number[] }>();
  for (const p of pools) p.rows.forEach((r, i) => {
    const on = byPage.get(r.page) ?? { rows: [], steps: [] };
    byPage.set(r.page, on);
    on.rows.push(r);
    const a = p.rows[i - 1];
    if (a && a.page === r.page && r.top > a.top && r.top - a.top < 3 * r.h) on.steps.push(r.top - a.top);
  });
  const pages = new Map<number, Margins>();
  let flush = 0, all = 0;
  for (const [n, { rows, steps }] of byPage) {
    const right = percentile(rows.map((r) => r.x1), 0.85);
    pages.set(n, { left: percentile(rows.map((r) => r.x0), 0.15), right, pitch: steps.length ? percentile(steps, 0.5) : rows[0]!.h * 1.2 });
    flush += rows.filter((r) => r.x1 >= right - r.h).length;
    all += rows.length;
  }
  const ragged = flush < all * FLUSH_SHARE;
  // Each pool's paragraphs, in the place the pool holds.
  const replaced = new Map<number, (Prepared | Marker)[]>();
  for (const p of pools) {
    const made: (Prepared | Marker)[] = [];
    for (const rows of paragraphsOfRows(p.rows, pages, ragged)) {
      const pieces = joinRows(rows);
      const text = pieces.map((q) => q.ch).join("");
      if (CAPTION_LABEL.test(text)) { made.push("skip"); continue; }
      const sources = [...new Set(rows.map((r) => r.from))].map((i) => p.readings[i]!);
      const head = p.readings[rows[0]!.from]!;
      made.push({
        kind: "paragraph", pieces, page: rows[0]!.page + 1, paths: sources.map((s) => s.path.join(".")),
        ...(rows[0]!.opens && head.block.previousPart ? { previousPart: head.block.previousPart.join(".") } : {}), origin: head.origin,
      });
    }
    replaced.set(p.at, made);
  }
  return out.flatMap((x, i) => replaced.get(i) ?? [x]);
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
  return rect ? rect[0]! + 1 : 0;
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
    const g = draft.pieces[i]!.glyph;
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
  /** Every page the reader is given stays given (the PDF reader keeps the text of every page
   *  it has read): a paragraph whose pages are all there is read for good, and its glyphs are
   *  let go — at 300 pages they held 150 MB. */
  pagesStay?: boolean;
}

/** A ReflowBlock that remembers what Zotero called it (StructuredOptions.everything). */
export interface StructuredBlock extends ReflowBlock {
  origin?: string;
}

/** A block as read from the structure, before any page has been seen. */
/** Draft.seen of a block read for good (StructuredOptions.pagesStay). */
const FINAL = "final";

interface Draft {
  block: StructuredBlock;
  pieces: Piece[];
  /** 1-based pages the block's glyphs lie on. */
  pages: number[];
  /** The last answer, and which of the block's pages (which text of each) it was given from. */
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
  /** The same, a few milliseconds at a time (lib/slices.ts): the first answer reads every
   *  paragraph of the document. */
  blocksInSlices(pages: readonly PdfPageText[]): Promise<StructuredBlock[]>;
  /** The 1-based pages a block of the last answer lies on, as the structure has it: the pages
   *  whose text the block needs before it reads as it will when they are all drawn. */
  pagesOf(block: StructuredBlock): readonly number[];
}

/** The drafts and the vocabulary, in a scope of their own: the reader's closures then keep
 *  neither the structure nor what was made on the way (39 MB at 300 pages). */
function* prepare(structure: SdtStructure, everything: boolean): Generator<void, Drafted> {
  const readings = readInColumns(readingsOf(structure.content, everything));
  yield;
  const read = (r: Reading): Piece[] => placeMarks(piecesOf(r.block, (node) => isRaisedCitation(node, structure.content)));
  // A bibliography is read only where the lines are numbered, and asked about then.
  const texts: (Piece[] | null)[] = [];
  for (const r of readings) {
    texts.push(typeof r === "string" || r.kind === "reference" ? null : read(r));
    yield;
  }
  let numbers = yield* lineNumberPieces(texts.filter((t): t is Piece[] => t !== null));
  if (numbers.size > 0) {
    readings.forEach((r, k) => { if (typeof r !== "string" && r.kind === "reference") texts[k] = read(r); });
    yield;
    numbers = yield* lineNumberPieces(texts.filter((t): t is Piece[] => t !== null));
  }
  // Numbered lines are read again as the paragraphs they make, and a caption among them is
  // told there, once its lines are one paragraph (numberedReadings).
  if (!everything) leaveOutCaptions(readings, structure.content, (k) => texts[k]?.some((p) => numbers.has(p)) === true);
  yield;
  const prepared = numbers.size > 0
    ? numberedReadings(readings, texts, numbers, everything)
    : readings.map((r, k) => (typeof r === "string" ? r : plain(r, texts[k] ?? [])));
  yield;
  /** The draft each read path became, for the parts that continue it. */
  const byPath = new Map<string, Draft>();
  const drafts: Draft[] = [];
  let barrier = true;
  /** The last paragraph read, still open for a continuation. */
  let open: Draft | null = null;
  for (const r of prepared) {
    yield;
    if (r === "barrier") { barrier = true; open = null; continue; }
    if (r === "display" && open) open.display = true;
    if (r === "skip" || r === "display") continue;
    const pieces = r.pieces;
    const part = r.previousPart ? byPath.get(r.previousPart) : undefined;
    const prev = part ?? (r.kind === "paragraph" && open !== null && !everything && continues(open.pieces, pieces) ? open : undefined);
    if (prev) {
      // Carried over an equation, a column or a page: one paragraph. A hyphen the break
      // left behind is mended when what follows is a lowercase continuation.
      const last = prev.pieces.at(-1);
      const first = pieces.find((p) => p.ch !== " ");
      if (last && last.ch === "-" && first && /\p{Ll}/u.test(first.ch)) prev.pieces.pop();
      else prev.pieces.push({ ch: " ", glyph: null });
      prev.pieces.push(...pieces);
      prev.display = false;
      for (const path of r.paths) byPath.set(path, prev);
      continue;
    }
    const page = r.page;
    const previous = drafts.at(-1);
    // A page is no break in the writing where the sentence before it goes on over it —
    // most often into a display equation at the head of the next page. Where it ended, short
    // paragraphs are not read together across the page, but one that cannot stand alone may
    // still join the paragraph before it (ReflowBlock.pageTurn).
    const turned = previous !== undefined && endPage(previous) !== page && !(previous.block.kind === "paragraph" && runsOn(previous.pieces));
    const block: StructuredBlock = {
      kind: r.kind, text: "", page, runs: [], apart: false,
      columnBreak: barrier || !previous,
      ...(turned && !barrier ? { pageTurn: true } : {}),
      ...(everything ? { origin: r.origin } : {}),
    };
    barrier = false;
    const draft: Draft = { block, pieces, pages: [], seen: null, result: null, display: false };
    drafts.push(draft);
    for (const path of r.paths) byPath.set(path, draft);
    open = r.kind === "paragraph" ? draft : null;
  }
  for (const d of drafts) {
    yield;
    const on = new Set<number>();
    for (const p of d.pieces) if (p.glyph) on.add(p.glyph.page + 1);
    d.pages = [...on].sort((a, b) => a - b);
  }
  yield;
  return { drafts, vocab: vocabularyOf(drafts.map((d) => written(d.pieces))) };
}

/** What prepare() makes of a structure: the drafts of its blocks and their vocabulary. */
interface Drafted { drafts: Draft[]; vocab: ReturnType<typeof vocabularyOf> }

export function createStructuredReader(structure: SdtStructure, options: StructuredOptions = {}): StructuredReader {
  return readerOf(finish(prepare(structure, options.everything === true)), options);
}

/** The same reader, made a few milliseconds at a time (lib/slices.ts): a 300-page document's
 *  structure took a third of a second of the main thread in one piece, as the reader started
 *  reading. */
export async function createStructuredReaderInSlices(structure: SdtStructure, options: StructuredOptions = {}): Promise<StructuredReader> {
  return readerOf(await finishInSlices(prepare(structure, options.everything === true)), options);
}

function readerOf({ drafts, vocab }: Drafted, options: StructuredOptions): StructuredReader {
  const pagesStay = options.pagesStay === true;
  /** Each page's text, by the object it came in: a page read again (one that could not be
   *  read, then drawn) reads its blocks again. */
  const serials = new WeakMap<PdfPageText, number>();
  let serial = 0;
  const serialOf = (p: PdfPageText): number => {
    let n = serials.get(p);
    if (n === undefined) serials.set(p, (n = ++serial));
    return n;
  };
  // A page's index, once per page's text: the reader passes every page it has the text of to
  // each call, and indexing them all again each time a page is drawn would be the cost.
  const indexed = new WeakMap<PdfPageText, PageIndex>();
  const indexOf = (p: PdfPageText): PageIndex => {
    let index = indexed.get(p);
    if (!index) indexed.set(p, (index = indexPage(p)));
    return index;
  };
  const pagesOfResult = new WeakMap<StructuredBlock, readonly number[]>();

  function* blocks(pages: readonly PdfPageText[]): Generator<void, StructuredBlock[]> {
      const pagesByNumber = new Map<number, PageIndex>();
      const given = new Map<number, PdfPageText>();
      for (const p of pages) { pagesByNumber.set(p.page, indexOf(p)); given.set(p.page, p); }
      const kinds = mathPagesOf(pagesByNumber);
      const out: StructuredBlock[] = [];
      for (const d of drafts) {
        yield;
        // Read for good: its glyphs are gone, and its answer is the last.
        if (d.pieces.length === 0 && d.seen === FINAL) { if (d.result) out.push(d.result); continue; }
        const seen = d.pages.map((n) => { const p = given.get(n); return p ? serialOf(p) : "-"; }).join(",");
        if (d.seen !== seen) {
          const { text, runs } = assemble(d.pieces, locate(d.pieces, pagesByNumber), vocab, kinds);
          const on = d.display && d.block.kind === "paragraph" && !SENTENCE_END.test(text);
          d.result = text === "" ? null : { ...d.block, text, runs, ...(on ? { runsOn: true } : {}) };
          if (d.result) pagesOfResult.set(d.result, d.pages);
          d.seen = seen;
          // Every page it lies on is there, each with text (an empty one may be a page that
          // could not be read, and be read again): it reads as it ever will.
          if (pagesStay && d.pages.every((n) => (given.get(n)?.items.length ?? 0) > 0)) { d.pieces = []; d.seen = FINAL; }
        }
        if (d.result) out.push(d.result);
      }
      return out;
  }

  return {
    pagesOf: (block) => pagesOfResult.get(block) ?? [block.page],
    blocks: (pages) => finish(blocks(pages)),
    blocksInSlices: (pages) => finishInSlices(blocks(pages)),
  };
}

/** One reading, for one set of pages: the benchmark's call (test/pdf-bench/pipeline.ts). */
export function structuredBlocks(structure: SdtStructure, pages: readonly PdfPageText[], options: StructuredOptions = {}): StructuredBlock[] {
  return createStructuredReader(structure, options).blocks(pages);
}
