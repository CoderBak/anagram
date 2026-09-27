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
// on. And what the TEXT of a paragraph is: Zotero's glyphs, with a space put back where
// two glyphs stand a word apart but its text runs them together (a bold run-in head, an
// italic variable), a hyphen kept at a line break where the document spells the word
// with it, and glyphs set in a mathematics font left out — an inline formula is not
// anybody's prose, and the web walker already skips arXiv's inline math.
//
// The textMap decoding follows structured-document-text/src/pdf/decode.js of
// https://github.com/zotero/structured-document-text (AGPL-3.0).
import { SENTENCE_END, bracketCitations, dehyphenates, vocabularyOf, type PdfPageText, type PdfTextItem, type ReflowBlock, type SourceRun, type Vocabulary } from "./reflow";

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

/** A gap wider than this share of the glyph height is a word space (lib/pdf/reflow.ts). */
const SPACE_GAP = 0.2;
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

/** One glyph of Zotero's text: its rect in PDF user space, on a 0-based page. */
interface Glyph {
  page: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

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

// ---- fonts ------------------------------------------------------------------------------

/**
 * Faces that set mathematics: the Computer Modern math faces and their descendants
 * (CMMI, CMSY, CMEX, MSAM/MSBM, txfonts/pxfonts/newtx math and newtx's …MathMI faces,
 * Latin Modern's Type 1 math, kpfonts, mathpazo, cmbright), the OpenType math faces
 * (Latin Modern Math, STIX, XITS, Cambria Math, Asana, TeX Gyre …Math), Euler and the
 * script faces, the symbol packages (mathabx, MnSymbol, fdsymbol, stmaryrd, esint) and
 * blackboard faces (doublestroke, bbold, bbm), and the symbol faces of office suites. The
 * base name is matched after the subset tag ("BXJUHM+CMMI10" is CMMI10). A text face that happens to carry a formula
 * (an upright "x" in CMR10) is not caught, and is not meant to be.
 */
const MATH_FONT = /^(?:CM(?:MI|SY|EX|BSY|MIB)\d|(?:MS[AB]M|EU(?:FM|FB|SM|SB|RM|RB|EX)|RSFS|CMSY|CMEX|CMMI)\d|r?(?:tx|px|ntx|npx|newtx|newpx)(?:mi|sy|ex|bmi|bsy|sys|exa|exb|exs|exx|exmods|mia|btmi|mio|bmio)|lmmath|latinmodernmath|M?LMMath|STIX(?:Math|Two-?Math|General)|XITS-?Math|CambriaMath|Cambria-Math|Asana-?Math|TeXGyre\w*Math|FiraMath|Erewhon-?Math|Libertinus-?Math|GFSNeohellenicMath|NotoSansMath|MathJax_(?:Main|Math|AMS|Caligraphic|Fraktur|Script|Size\d)|Symbol(?:MT)?|MTExtra|MT-Extra|MathematicalPi|Mathematica\d|LucidaNewMath|LucidaMath|MathTime|Wingdings|Euclid|(?:TeX-)?math[abxu]\d|MnSymbol|Kp-+M-|[A-Za-z]+Math(?:MI|SY|EX|BMI|BSY|RM|BB)|FdSymbol|ds(?:rom|ss)\d|bbold|bbm\w*\d|esint|StandardSym|PazoMath|HFBR(?:MI|SY|EX)|ztmcm|stmary)/i;

/** Whether a font, by its PDF name, sets mathematics rather than text. */
export function isMathFont(name: string | undefined): boolean {
  if (!name) return false;
  const base = name.replace(/^[A-Z]{6}\+/, "");
  return MATH_FONT.test(base);
}

// ---- runs of the text layer -------------------------------------------------------------

/** A pdf.js run as a box in top-left page space, ready to be searched. */
interface Box {
  /** 1-based page number. */
  page: number;
  item: number;
  it: PdfTextItem;
  x1: number;
  x2: number;
  /** Baseline, and the size the box is measured in. */
  y: number;
  h: number;
  math: boolean;
  /** A typewriter face: code, whose "x = 5" is the text's. */
  mono: boolean;
  /** The face, by the PDF's name for it. */
  font: string;
}

/** The page's runs by page number, boxed and sorted by baseline. */
interface PageIndex {
  page: PdfPageText;
  boxes: Box[];
  /** [a, b, c, d, e, f]: PDF user space → top-left page space. */
  transform: number[];
}

/** Typewriter faces: Courier and its clones, Computer and Latin Modern's, Inconsolata. */
const MONO_FONT = /mono|monl|courier|consol|menlo|(?:cm|sf|lm|ec|tx|px)tt\d|^pcr/i;

function indexPage(page: PdfPageText): PageIndex {
  const boxes: Box[] = [];
  page.items.forEach((it, item) => {
    if (it.rotated || it.str.trim() === "" || !(it.height > 0)) return;
    const name = page.fonts?.[it.fontName ?? ""];
    boxes.push({
      page: page.page, item, it, x1: it.x, x2: it.x + it.width, y: it.y, h: it.height,
      math: isMathFont(name), mono: MONO_FONT.test(name?.replace(/^[A-Z]{6}\+/, "") ?? ""), font: name ?? it.fontName ?? "",
    });
  });
  boxes.sort((a, b) => a.y - b.y);
  return { page, boxes, transform: page.transform ?? [1, 0, 0, -1, 0, page.height] };
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

/** One UTF-16 unit of Zotero's text for a block, with the glyph it draws, if any. */
interface Piece {
  ch: string;
  glyph: Glyph | null;
  /** Part of a raised number Zotero links to the bibliography (isRaisedCitation). */
  raised?: boolean;
}

/** Where a piece was found in the text layer. */
interface Source {
  page: number;
  item: number;
  offset: number;
  box: Box;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

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

const ACCENT = /^\p{M}$/u;
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

/** Where each piece was found, and the run it stands in even where it was not: a glyph
 *  pdf.js spells otherwise (a Greek letter of a formula it maps to another character)
 *  is in no run's string, but its run's face still says whether it is mathematics. */
interface Located {
  sources: (Source | null)[];
  faces: (Box | null)[];
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

/** Two glyphs on one line of one page: their heights overlap. */
function sameLine(a: Glyph, b: Glyph): boolean {
  if (a.page !== b.page) return false;
  const h = Math.max(a.y2 - a.y1, b.y2 - b.y1);
  return Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) >= h * 0.3;
}

/** The second glyph stands a word space or more after the first, on one line. */
function wordApart(a: Glyph, b: Glyph): boolean {
  const h = Math.max(a.y2 - a.y1, b.y2 - b.y1);
  return sameLine(a, b) && b.x1 - a.x2 > h * SPACE_GAP;
}

/**
 * The same test on pdf.js's runs, for the gap Zotero's geometry cannot see: its fork folds
 * the space after a glyph into the glyph's own extent and sometimes drops the space from
 * the text as well (a bold run-in head, "InferenceUncertainty"; a linked "Section II" in
 * the middle of a line, "SectionIIpresents"). pdf.js's own string says where a space is:
 * between the two glyphs in one run, or, when the first glyph ends one run and the second
 * opens another on the same line, at the end of the first or the start of the second;
 * where neither run holds one, the distance between the two runs is the gap.
 */
function runsApart(a: Source, b: Source): boolean {
  if (a.page !== b.page) return false;
  const sa = a.box.it.str, sb = b.box.it.str;
  if (a.item === b.item) return b.offset > a.offset + 1 && sa.slice(a.offset + 1, b.offset).trim() === "";
  if (a.offset !== sa.trimEnd().length - 1 || b.offset !== sb.length - sb.trimStart().length) return false;
  const h = Math.max(a.box.h, b.box.h);
  if (Math.abs(a.box.y - b.box.y) > h * 0.5) return false;
  return sa.length > a.offset + 1 || b.offset > 0 || b.box.x1 - a.box.x2 > h * SPACE_GAP;
}

const HYPHEN = /[-‐­]/u;
/** Punctuation that ends a clause or a sentence, kept where the formula before it is not. */
const CLAUSE_END = /^[.,;:!?]$/u;

/** Operator names TeX sets upright in the text face (\log, \max, \Pr …). Not the ones that
 *  are also English set before a symbol: "of rank r", "the sign of x", "mod p". */
const OPERATOR = new Set([
  "arccos", "arcsin", "arctan", "arg", "argmax", "argmin", "cos", "cosh", "cot", "coth", "Cov", "csc", "det",
  "diag", "dim", "exp", "gcd", "hom", "inf", "ker", "lg", "lim", "liminf", "limsup", "ln", "log", "max", "min",
  "Pr", "sgn", "sin", "sinh", "sup", "supp", "tan", "tanh", "tr", "Tr", "Var",
]);
/** A token set this much smaller than its block is a formula's sub- or superscript. */
const SCRIPT_SIZE = 0.8;

// ---- what a formula is made of ---------------------------------------------------------------
//
// BabelDOC (https://github.com/funstory-ai/BabelDOC, AGPL-3.0, Copyright (c) awwaawwa,
// funstory.ai and the BabelDOC contributors) tells a formula's characters from the text's
// one at a time, by face and by what the character is (babeldoc/format/pdf/document_il/
// utils/formular_helper.py, is_formulas_start_char): a mathematical symbol, a modifier
// accent, a nonspacing mark, a private-use glyph, a Greek letter and a glyph the font does
// not map are a formula's, and a change between the two is where a formula starts or stops
// (midend/styles_and_formulas.py, _classify_characters_in_composition). TeX narrows this:
// it draws a formula's symbols and lower-case Greek from its mathematics faces, which the
// face already tells, so one of those in a text face was typed in the text ("2048 × 2048",
// "an α-helix"). What it takes from the text face is "+", "=" and the upright capitals.

/** The operators a formula takes from the text face. */
const TEXT_OPERATOR = /^[+=]$/u;
const CAPITAL_GREEK = /^(?=\p{Lu})\p{Script=Greek}$/u;
const GREEK = /^\p{Script=Greek}$/u;
/** The spacing accents \hat, \tilde, \bar and \dot are drawn with. */
const SPACING_ACCENT = /^[\^¨¯´¸ˆˇˉ˘˙˚˛˜˝]$/u;
const MARK = /^\p{Mn}$/u;
const ALNUM = /^[\p{Script=Latin}\p{N}]$/u;
/** A letter, and not a modifier letter such as the ˆ of a formula's hat. */
const LETTER = /^[\p{Lu}\p{Ll}\p{Lt}\p{Lo}]$/u;
const BOLD_FONT = /bold|medi|semibold|demi|heavy|black|bx\d|^cmb|mib/i;
/** A glyph set below this share of the size of the letter it follows is that letter's sub-
 *  or superscript: BabelDOC's corner mark (a script is set at 0.76 of the size, small
 *  capitals at 0.8). */
const CORNER = 0.79;
/** The words a cross-reference names a numbered or lettered thing with: "Appendix A",
 *  "by Proposition 1", "Eq. (3)". */
const REFERENCE = /^(?:Eqs?|Equations?|Secs?|Sections?|Figs?|Figures?|Tables?|Theorems?|Thms?|Lemmas?|Propositions?|Props?|Corollar(?:y|ies)|Cors?|Definitions?|Defs?|Assumptions?|Remarks?|Examples?|Algorithms?|Algs?|Appendi(?:x|ces)|Steps?|Cases?|Chapters?|Conditions?|Claims?|Parts?|Stages?|Lines?|Items?|Propert(?:y|ies)|Hypothes[ei]s|Conjectures?|Problems?|Rules?|Axioms?|Observations?|Facts?|Panels?)$/u;

/**
 * Which pieces are a formula's by what they are, on a page that sets mathematics in a
 * mathematics face and outside a typewriter face: a "+" or "=" standing apart (TeX spaces
 * the operators of a formula; "J1351+0039" and "stol=0.5" were typed), an upright capital
 * Greek letter ("$\Lambda$CDM"), an accent that is no letter's (a formula's \hat or \bar,
 * not the one of "Müller" or "Jureˇcková"), a private-use glyph, and a symbol or a Greek
 * letter that pdf.js spells otherwise — a glyph of a formula Zotero ran into the word
 * before it ("Thusθ"), though not the μ of a unit after a number ("14 μm").
 */
function formulaChars(pieces: Piece[], { sources, faces }: Located, mathPages: ReadonlySet<number>): boolean[] {
  const letter = (i: number): boolean => i >= 0 && i < pieces.length && /\p{L}/u.test(pieces[i].ch);
  /** The next piece past at most one space. */
  const near = (i: number, step: number): string => (pieces[i + step]?.ch === " " ? pieces[i + 2 * step] : pieces[i + step])?.ch ?? " ";
  /** The μ of a quantity's unit, "14 μm", "4μ B". */
  const unit = (i: number): boolean => pieces[i].ch === "μ" && /\p{N}/u.test(near(i, -1)) && /\p{Script=Latin}/u.test(near(i, 1));
  /** A letter or digit stands against the i-th piece, past any more of it ("C++"). */
  const glued = (i: number, step: number): boolean => {
    let j = i + step;
    while (j >= 0 && j < pieces.length && pieces[j].ch === pieces[i].ch) j += step;
    return j >= 0 && j < pieces.length && ALNUM.test(pieces[j].ch);
  };
  return pieces.map((p, i) => {
    const page = faces[i]?.page ?? (p.glyph ? p.glyph.page + 1 : 0);
    if (!mathPages.has(page) || faces[i]?.mono) return false;
    const ch = p.ch;
    if (/^\p{Co}$/u.test(ch)) return true;
    if (/^\p{Sm}$/u.test(ch)) return sources[i] === null || (TEXT_OPERATOR.test(ch) && !glued(i, -1) && !glued(i, 1));
    if (GREEK.test(ch)) return CAPITAL_GREEK.test(ch) || (sources[i] === null && !unit(i));
    if (SPACING_ACCENT.test(ch)) return !(letter(i - 1) && letter(i + 1));
    if (!MARK.test(ch) || /[\uFE00-\uFE0F]/u.test(ch)) return false;
    // A mark stays with its letter where the two make one character.
    let j = i - 1;
    while (j >= 0 && MARK.test(pieces[j].ch)) j--;
    if (!letter(j)) return true;
    const cluster = (DOTLESS[pieces[j].ch] ?? pieces[j].ch) + pieces.slice(j + 1, i + 1).map((q) => q.ch).join("");
    return /\p{Mn}/u.test(cluster.normalize("NFC"));
  });
}

/** A token of the text: consecutive glyphs with no word space among them. */
interface Token {
  /** Indices into `pieces`, spaces left out. */
  at: number[];
  math: boolean;
  letters: boolean;
}

interface Assembled {
  text: string;
  runs: SourceRun[];
}

/**
 * The block's text and where it came from. Whitespace collapses to single spaces, and a
 * space goes in wherever two glyphs stand a word apart and Zotero's text runs them
 * together. Then two decisions the reflow makes too, taken here on Zotero's glyphs:
 *
 *  - A FORMULA is left out. A token with a glyph in a mathematics font is one, and so are
 *    one of what a formula is made of in any face (formulaChars) and a letter set alone in
 *    a bold face of its own (alone). Beside one on the same line
 *    go the rest of what TeX takes from the text face: a letterless token (parentheses,
 *    digits, operators, punctuation), an operator name ("log", "sup") and a token set in
 *    a sub- or superscript's size ("init" of x_init). What remains is the sentence around
 *    the formula, which is the writing, with the full stop or comma that closed the
 *    formula, as arXiv's HTML has it.
 *  - A HYPHEN at a line break is Zotero's to drop, and it drops every one: "language-only"
 *    becomes "languageonly". The hyphen is still in pdf.js's run, and the document's own
 *    vocabulary says whether the word is spelt with it (lib/pdf/reflow.ts).
 */
function assemble(pieces: Piece[], located: Located, vocab: Vocabulary, mathPages: ReadonlySet<number>): Assembled {
  const { sources, faces } = located;
  // ---- tokens: where a word space belongs ----
  const tokens: Token[] = [];
  let open: Token | null = null;
  let prevGlyph: Glyph | null = null;
  let prevSource: Source | null = null;
  let prevFormula: boolean | null = null;
  let spaced = true;
  const cited = citationMarks(pieces, faces);
  const symbolic = formulaChars(pieces, located, mathPages);
  pieces.forEach((p, i) => {
    if (p.ch === " ") { spaced = true; return; }
    const src = sources[i];
    // A formula's by its face or by what it is; unknown with no face and no such character.
    const formula = symbolic[i] ? true : faces[i] ? faces[i]!.math : null;
    // A citation mark is left out, but the text after it follows it on the page: "errors¹⁻⁴."
    // is a word and its full stop.
    if (!cited[i]) {
      // A change between text and mathematics is a word boundary too, however tight TeX set
      // it or Zotero ran it together: "with" and the "C" of "withC :=", "Thus" and the θ of
      // "Thusθ is" are two words.
      const apart = spaced
        || (prevGlyph !== null && p.glyph !== null && wordApart(prevGlyph, p.glyph))
        || (prevSource !== null && src !== null && runsApart(prevSource, src))
        || (prevFormula !== null && formula !== null && prevFormula !== formula);
      if (apart || !open) { open = { at: [], math: false, letters: false }; tokens.push(open); }
      open.at.push(i);
      if (formula) open.math = true;
      if (/\p{L}/u.test(p.ch)) open.letters = true;
      spaced = false;
    }
    if (p.glyph) prevGlyph = p.glyph;
    if (src) prevSource = src;
    if (formula !== null && !cited[i]) prevFormula = formula;
  });

  // ---- formulas: the math tokens and the letterless tokens beside them ----
  const glyphAt = (t: Token, last: boolean): Glyph | null => {
    for (const i of last ? [...t.at].reverse() : t.at) if (pieces[i].glyph) return pieces[i].glyph;
    return null;
  };
  const beside = (a: Token, b: Token): boolean => {
    const x = glyphAt(a, true), y = glyphAt(b, false);
    return x !== null && y !== null && sameLine(x, y);
  };
  const letters = (t: Token): string => t.at.map((i) => pieces[i].ch).join("").replace(/\P{L}/gu, "");
  const sizes = pieces.flatMap((p, i) => (faces[i] && /\p{L}/u.test(p.ch) ? [faces[i].h] : [])).sort((a, b) => a - b);
  const body = sizes[sizes.length >> 1] ?? 0;
  const script = (t: Token): boolean => t.at.every((i) => faces[i] !== null && faces[i].h <= body * SCRIPT_SIZE);
  /** What stands beside a formula and goes with it; not a word it is hyphened to, the
   *  "liminf" of "$\Gamma$-liminf". */
  const withFormula = (t: Token): boolean =>
    !t.letters || ((OPERATOR.has(letters(t)) || script(t)) && !/^[-‐]\p{L}/u.test(pieces[t.at[0]].ch + (pieces[t.at[1]]?.ch ?? "")));
  /** A comma or a full stop in the text face. TeX sets a formula's own in its mathematics
   *  face — the point of "$0.5$", the comma of "$x, y$" — so this one is the text's. */
  const textStop = (i: number): boolean => (pieces[i].ch === "." || pieces[i].ch === ",") && faces[i] !== null && !faces[i]!.math;
  /** A number the text writes, its decimal point or its thousands comma in the text face:
   *  the "11.3" of "11.3 $\mu$m". */
  const written = (t: Token): boolean =>
    t.at.some((i, k) => k > 0 && k + 1 < t.at.length && textStop(i) && /\d/u.test(pieces[t.at[k - 1]].ch) && /\d/u.test(pieces[t.at[k + 1]].ch));
  /** The token ends its clause in the text face, so a formula after it starts after it:
   *  "by Theorem 2, $x$". */
  const closes = (t: Token): boolean => textStop(t.at[t.at.length - 1]);
  /** The one text face a token's letters are set in, if there is one. */
  const faceOf = (t: Token): Box | null => {
    let face: Box | null = null;
    for (const i of t.at) {
      if (!LETTER.test(pieces[i].ch)) continue;
      const f = faces[i];
      if (!f || f.math || f.mono || (face !== null && f.font !== face.font)) return null;
      face = f;
    }
    return face;
  };
  const count = (t: Token): number => t.at.filter((i) => LETTER.test(pieces[i].ch)).length;
  /** The nearest token with letters before or after the k-th. */
  const word = (k: number, step: number): Token | null => {
    for (let j = k + step; j >= 0 && j < tokens.length; j += step) if (tokens[j].letters) return tokens[j];
    return null;
  };
  /** A single letter set alone in a bold face: "\mathbf{h}", "\mathbf{J}_0". No word beside it
   *  is in that face — "Part A" is a phrase of it — and one is in another; what else the token
   *  holds is punctuation or the letter's script, not a label's digit ("(A1)"); and it is no
   *  label itself, "(A)" or the "A" of "Appendix A". An italic letter stays: the text's
   *  italic sets the writer's \textit as often as a formula's letter. */
  const alone = (k: number): boolean => {
    const t = tokens[k];
    const size = Math.max(...t.at.map((i) => faces[i]?.h ?? 0));
    const small = (i: number): boolean => faces[i] !== null && faces[i]!.h < size * CORNER;
    const main = t.at.filter((i) => LETTER.test(pieces[i].ch) && !small(i));
    const face = main.length === 1 ? faces[main[0]] : null;
    if (!face || face.math || face.mono || !BOLD_FONT.test(face.font) || !mathPages.has(face.page)) return false;
    if (t.at.some((i) => i !== main[0] && !/^[\p{P}\p{M}\p{Lm}\p{Sk}]$/u.test(pieces[i].ch) && !small(i))) return false;
    if (/^[([]\p{L}[)\]]/u.test(t.at.map((i) => pieces[i].ch).join(""))) return false;
    const before = word(k, -1);
    if (before && REFERENCE.test(letters(before))) return false;
    const around = [before, word(k, 1)].filter((n): n is Token => n !== null);
    const same = (n: Token): boolean => faceOf(n)?.font === face.font;
    return around.some((n) => !same(n)) && !around.some((n) => same(n) && count(n) > 1);
  };
  const drop = tokens.map((t, k) => t.math || alone(k));
  for (let i = 1; i < tokens.length; i++) if (drop[i - 1] && withFormula(tokens[i]) && !written(tokens[i]) && beside(tokens[i - 1], tokens[i])) drop[i] = true;
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (drop[i + 1] && withFormula(tokens[i]) && !written(tokens[i]) && !closes(tokens[i]) && beside(tokens[i], tokens[i + 1])) drop[i] = true;
  }

  // ---- the text ----
  let text = "";
  let prov: (Source | null)[] = [];
  tokens.forEach((t, k) => {
    if (drop[k]) {
      // The formula goes; the full stop or the comma after it, set in the text face, stays
      // with the sentence it ends, as it does on arXiv's HTML: "the value of x." reads
      // "the value of.", not "the value of" run into the next sentence.
      let tail = t.at.length;
      while (tail > 0 && CLAUSE_END.test(pieces[t.at[tail - 1]].ch) && !faces[t.at[tail - 1]]?.math) tail--;
      if (text === "") return;
      for (const i of t.at.slice(tail)) { text += pieces[i].ch; prov.push(sources[i]); }
      return;
    }
    if (text !== "") { text += " "; prov.push(null); }
    let previous: number | null = null;
    for (const i of t.at) {
      const p = pieces[i], src = sources[i];
      // A line break inside a token with no space: Zotero mended a hyphenation. The
      // hyphen is at the end of the previous glyph's run, if it is anywhere.
      if (previous !== null) {
        const a = pieces[previous], s = sources[previous];
        if (a.glyph && p.glyph && !sameLine(a.glyph, p.glyph) && s && HYPHEN.test(s.box.it.str[s.offset + 1] ?? "")) {
          const stem = /(\S+)$/u.exec(text)?.[1] ?? "";
          const from = previous;
          const head = t.at.filter((j) => j > from).map((j) => pieces[j].ch).join("");
          if (!dehyphenates(stem, head, vocab)) { text += s.box.it.str[s.offset + 1]; prov.push({ ...s, offset: s.offset + 1 }); }
        }
      }
      text += p.ch;
      prov.push(src);
      previous = i;
    }
  });

  ({ text, prov } = composed(text, prov));
  ({ text, prov } = withoutCitations(text, prov));

  // The space a run contributes between two of its own glyphs is the run's, not ours.
  for (let i = 1; i + 1 < prov.length; i++) {
    if (prov[i] !== null) continue;
    const a = prov[i - 1], b = prov[i + 1];
    if (a && b && a.item === b.item && a.page === b.page && b.offset === a.offset + 2 && isSpace(a.box.it.str[a.offset + 1])) {
      prov[i] = { ...a, offset: a.offset + 1 };
    }
  }
  const runs: SourceRun[] = [];
  let run: SourceRun | null = null;
  prov.forEach((s, at) => {
    if (s && run && run.page === s.page && run.item === s.item && run.from + run.length === s.offset) { run.length++; return; }
    run = s ? { page: s.page, item: s.item, at, length: 1, from: s.offset } : null;
    if (run) runs.push(run);
  });
  return { text, runs };
}

/** TeX's dotless letters, which it accents instead of "i" and "j": \'{\i} is "í". */
const DOTLESS: Record<string, string> = { "ı": "i", "ȷ": "j" };

/**
 * Each letter and its accents as one character (NFC), as a web page writes "Lévy" and the
 * model reads it: Zotero gives "e" and a combining acute. The character keeps the letter's
 * place on the page.
 */
function composed(text: string, prov: (Source | null)[]): { text: string; prov: (Source | null)[] } {
  if (!/\p{M}/u.test(text)) return { text, prov };
  let out = "";
  const kept: (Source | null)[] = [];
  for (let i = 0; i < text.length;) {
    const size = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    let end = i + size;
    while (end < text.length && ACCENT.test(text[end])) end++;
    const cluster = end > i + size ? (DOTLESS[text[i]] ?? text.slice(i, i + size)) + text.slice(i + size, end) : text.slice(i, end);
    const nfc = cluster.normalize("NFC");
    out += nfc;
    for (let k = 0; k < nfc.length; k++) kept.push(k < size ? prov[i + k] : null);
    i = end;
  }
  return { text: out, prov: kept };
}

/** The text without its bracketed citation marks (bracketCitations, lib/pdf/reflow.ts). */
function withoutCitations(text: string, prov: (Source | null)[]): { text: string; prov: (Source | null)[] } {
  const cuts = bracketCitations(text);
  if (cuts.length === 0) return { text, prov };
  let out = "";
  const kept: (Source | null)[] = [];
  let at = 0;
  for (const [from, to] of cuts) {
    out += text.slice(at, from);
    kept.push(...prov.slice(at, from));
    at = to;
  }
  out += text.slice(at);
  kept.push(...prov.slice(at));
  // A mark that opened the paragraph leaves the space after it.
  if (out.startsWith(" ")) { out = out.slice(1); kept.shift(); }
  return { text: out, prov: kept };
}

/** "7", "1–4", "13,14", "(1)": the numbers a citation mark is set as. */
const MARK_NUMBERS = /^[[(]?\d{1,4}[a-z]?(?:\s*[,;–-]\s*\d{1,4}[a-z]?)*[\])]?$/u;

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

/** Letters of the word a raised citation follows; fewer are a unit's ("cm²"). */
const CITED_WORD = 3;
const CLOSING = /^[.,;:!?)\]’”"']$/u;
const SEPARATOR = /^[\s,;–-]$/u;

/**
 * The pieces of the raised citations that follow a word of the text face, spaces and
 * closing punctuation aside: "errors¹⁻⁴", "behavior.⁵", "Dunne ⁴⁶", "forms²²,²³". They
 * point to the bibliography and are no words of the sentence: the web walker skips them
 * (isCitationMarker, lib/dom/walker.ts), and so does the reader. After a unit or a
 * formula's letter the number is an exponent, and stays.
 */
function citationMarks(pieces: Piece[], faces: (Box | null)[]): boolean[] {
  const out = pieces.map(() => false);
  /** Where the last mark left out ends. */
  let last = -1;
  for (let i = 0; i < pieces.length;) {
    if (!pieces[i].raised) { i++; continue; }
    let end = i;
    while (end < pieces.length && pieces[end].raised) end++;
    // Back over the marks before it in the same run, spaces and closing punctuation, to its word.
    let j = i - 1;
    while (j >= 0 && (pieces[j].raised || SEPARATOR.test(pieces[j].ch))) j--;
    while (j >= 0 && CLOSING.test(pieces[j].ch)) j--;
    let letters = 0;
    for (; j >= 0 && /\p{L}/u.test(pieces[j].ch) && !faces[j]?.math; j--) letters++;
    if (letters >= CITED_WORD) {
      // What separates it from the mark before it goes with the two.
      const from = last >= 0 && pieces.slice(last, i).every((p) => SEPARATOR.test(p.ch)) ? last : i;
      out.fill(true, from, end);
      last = end;
    }
    i = end;
  }
  return out;
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
      /** Pages that set mathematics in a mathematics face, where capital Greek is a formula's. */
      const mathPages = new Set<number>();
      for (const [n, index] of pagesByNumber) if (index.boxes.some((b) => b.math)) mathPages.add(n);
      const out: StructuredBlock[] = [];
      for (const d of drafts) {
        const seen = d.pages.filter((n) => pagesByNumber.has(n)).join(",");
        if (d.seen !== seen) {
          const { text, runs } = assemble(d.pieces, locate(d.pieces, pagesByNumber), vocab, mathPages);
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
