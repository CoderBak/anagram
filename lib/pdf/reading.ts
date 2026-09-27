// lib/pdf/reading.ts — what of a paragraph's glyphs is read.
//
// A paragraph arrives as pieces: one character each, with the glyph it draws where there is
// one and the pdf.js run it was found in (lib/pdf/structured.ts finds Zotero's glyphs among
// the text layer's runs). What comes out is the text the model reads and the runs it came
// from: a space put back where two glyphs stand a word apart, a hyphen kept at a line break
// where the document spells the word with it, and what is no one's prose left out — the
// glyphs of a formula, a citation mark, an accent set apart from its letter.
import { skipGap } from "../dom/text";
import { bracketCitations, dehyphenates, type PdfPageText, type PdfTextItem, type SourceRun, type Vocabulary } from "./reflow";

/** One glyph: its rect on a 0-based page, in the space its reader measures in (Zotero's
 *  text: PDF user space). */
export interface Glyph {
  page: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A gap wider than this share of the glyph height is a word space (lib/pdf/reflow.ts). */
const SPACE_GAP = 0.2;

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
export interface Box {
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
  /** A text face that sets no prose on the page (formulaFaces). */
  aside: boolean;
}

/** The page's runs by page number, boxed and sorted by baseline. */
export interface PageIndex {
  page: PdfPageText;
  boxes: Box[];
  /** [a, b, c, d, e, f]: PDF user space → top-left page space. */
  transform: number[];
}

/** Typewriter faces: Courier and its clones, Computer and Latin Modern's, txfonts',
 *  Inconsolata. */
const MONO_FONT = /mono|monl|courier|consol|menlo|tt\d|tt$|^pcr/i;
/** Sans-serif faces: a heading's or a label's, never TeX's for a formula. */
const SANS_FONT = /sans|sanl|helvet|arial|biolinum|calibri|verdana|tahoma|segoe|roboto|^(?:cm|sf|lm)ss/i;
/** Words of four letters or more a face must set on a page to be one the text is set in. */
const PROSE_WORDS = 3;

/** A face's family: the name without its subset tag, weight, shape and size. Computer
 *  Modern's faces are one family (CMR10, CMBX12), and so are the EC fonts' (SFRM1095). */
function familyOf(name: string): string {
  const base = name.replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0].replace(/\d.*$/, "");
  return /^CM[A-Z]/.test(base) ? "CM" : /^SF[A-Z]{2}/.test(base) ? "SF" : base;
}

function sameFamily(a: string, b: string): boolean {
  const x = familyOf(a), y = familyOf(b);
  return x === y || (x.length >= 5 && y.startsWith(x)) || (y.length >= 5 && x.startsWith(y));
}

/**
 * The text faces a page uses only for formulas. A paper set in Times takes its formulas'
 * digits, operators and upright names from Computer Modern ("$300$", "\mathrm{km}"), and
 * one set in the EC fonts takes them from the older CM faces; neither is a face its words
 * are set in. Such a face is of another family than the one that sets most of the page's
 * letters, and sets hardly a word of four letters there; a typewriter face (code) and a
 * sans-serif one (a heading) are never it.
 */
function formulaFaces(page: PdfPageText): Set<string> {
  const letters = new Map<string, number>(), words = new Map<string, number>();
  for (const it of page.items) {
    const name = page.fonts?.[it.fontName ?? ""] ?? it.fontName ?? "";
    for (const w of it.str.split(/\s+/)) {
      const l = w.replace(/\P{L}/gu, "");
      letters.set(name, (letters.get(name) ?? 0) + l.length);
      if (l.length >= 4 && !OPERATOR.has(l)) words.set(name, (words.get(name) ?? 0) + 1);
    }
  }
  let body = "";
  for (const [name, n] of letters) if (n > (letters.get(body) ?? -1)) body = name;
  const out = new Set<string>();
  for (const name of letters.keys()) {
    const base = name.replace(/^[A-Z]{6}\+/, "");
    if (sameFamily(name, body) || isMathFont(name) || MONO_FONT.test(base) || SANS_FONT.test(base)) continue;
    if ((words.get(name) ?? 0) < PROSE_WORDS) out.add(name);
  }
  return out;
}

export function indexPage(page: PdfPageText): PageIndex {
  const boxes: Box[] = [];
  const aside = formulaFaces(page);
  page.items.forEach((it, item) => {
    if (it.rotated || it.str.trim() === "" || !(it.height > 0)) return;
    const name = page.fonts?.[it.fontName ?? ""];
    const font = name ?? it.fontName ?? "";
    boxes.push({
      page: page.page, item, it, x1: it.x, x2: it.x + it.width, y: it.y, h: it.height,
      math: isMathFont(name), mono: MONO_FONT.test(name?.replace(/^[A-Z]{6}\+/, "") ?? ""), font, aside: aside.has(font),
    });
  });
  boxes.sort((a, b) => a.y - b.y);
  return { page, boxes, transform: page.transform ?? [1, 0, 0, -1, 0, page.height] };
}

/** One UTF-16 unit of Zotero's text for a block, with the glyph it draws, if any. */
export interface Piece {
  ch: string;
  glyph: Glyph | null;
  /** Part of a raised number Zotero links to the bibliography (isRaisedCitation). */
  raised?: boolean;
}

/** Where a piece was found in the text layer. */
export interface Source {
  page: number;
  item: number;
  offset: number;
  box: Box;
}

export function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

export const ACCENT = /^\p{M}$/u;

/** Where each piece was found, and the run it stands in even where it was not: a glyph
 *  pdf.js spells otherwise (a Greek letter of a formula it maps to another character)
 *  is in no run's string, but its run's face still says whether it is mathematics. */
export interface Located {
  sources: (Source | null)[];
  faces: (Box | null)[];
}

/** Two glyphs on one line of one page: their heights overlap. */
export function sameLine(a: Glyph, b: Glyph): boolean {
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
/** The relations TeX sets a thick space after inside a formula. */
const RELATION = /^[=<>≤≥≈∼≃≅≡∝≲≳≪≫≠∈]$/u;
/** A gap narrower than this share of the size, between two runs, is no space at all:
 *  a thick space is 5/18 of the size. */
const GLUED = 0.1;

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

/** Which pages set mathematics, and how. */
export interface MathPages {
  /** Pages with a run in a mathematics face: there capital Greek is a formula's. */
  mathPages: ReadonlySet<number>;
  /** Of those, the pages where no mathematics face sets a formula's letters — a lower-case
   *  Latin letter or a mathematical alphanumeric symbol; CMSY's calligraphic capitals and
   *  the blackboard bold capitals are no text's letters either way. There the formulas take
   *  their letters from the text's italic (mathptmx, mathpazo). */
  italicMath: ReadonlySet<number>;
}

const MATH_LETTER = /[a-z\u{1D400}-\u{1D7FF}]/u;

export function mathPagesOf(pages: ReadonlyMap<number, PageIndex>): MathPages {
  const mathPages = new Set<number>(), italicMath = new Set<number>();
  for (const [n, index] of pages) {
    if (!index.boxes.some((b) => b.math)) continue;
    mathPages.add(n);
    if (!index.boxes.some((b) => b.math && MATH_LETTER.test(b.it.str))) italicMath.add(n);
  }
  return { mathPages, italicMath };
}

/** A token of the text: consecutive glyphs with no word space among them. */
interface Token {
  /** Indices into `pieces`, spaces left out. */
  at: number[];
  math: boolean;
  letters: boolean;
  /** A citation mark was left out right before it. */
  marked?: true;
  /** The word a formula is hyphened to, split from it (hyphened): set against the token
   *  before it, with no space, where that one is read. */
  glued?: true;
}

/** Faces that set italic: Times', Palatino's, TeX's text italic, and so on. */
const ITALIC_FONT = /ital|obli|slant|(?:^|[-_])it(?:$|[-_\d])|^(?:cm|sf|lm)\w*ti\d|libertine\w*i$/i;

/**
 * Split off what stands before the hyphen of a token when it is a formula's: "(2+1)" of
 * "$(2+1)$-dimensional", whose operator TeX spaces, leaves "1)-dimensional" one token, and a
 * formula's letter set in the text's italic runs into its word ("$g$-band"). A letterless
 * stretch with a digit or a closing bracket before the hyphen, or one letter of an italic
 * face the word after the hyphen is not set in on a page whose formulas take their letters
 * from the text's italic, becomes a token of its own, and the word after it a token glued to
 * it; whether either is a formula's is then decided as for any other token.
 */
function hyphened(tokens: Token[], pieces: Piece[], faces: (Box | null)[], formula: (i: number) => boolean, italicMath: ReadonlySet<number>): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const h = t.at.findIndex((i, k) => k > 0 && /^[-‐]$/u.test(pieces[i].ch) && LETTER.test(pieces[t.at[k + 1]]?.ch ?? ""));
    const head = h > 0 ? t.at.slice(0, h) : [];
    const chars = head.map((i) => pieces[i].ch).join("");
    const f = faces[head[0]], g = faces[t.at[h + 1]];
    const split = !/\p{L}/u.test(chars) ? /[\p{N})\]]/u.test(chars)
      : head.length === 1 && f !== null && g !== null && !f.math && !f.mono && italicMath.has(f.page) && ITALIC_FONT.test(baseName(f.font)) && g.font !== f.font;
    if (!split) { out.push(t); continue; }
    const rest = t.at.slice(h);
    out.push({ at: head, math: head.some(formula), letters: /\p{L}/u.test(chars), ...(t.marked ? { marked: true as const } : {}) });
    out.push({ at: rest, math: rest.some(formula), letters: true, glued: true });
  }
  return out;
}

const baseName = (font: string): string => font.replace(/^[A-Z]{6}\+/, "");

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
 *    one of what a formula is made of in any face (formulaChars), a letter set alone in a
 *    bold face of its own (alone) and what is set in a face the page uses only for formulas
 *    (formulaFaces). Beside one on the same line
 *    go the rest of what TeX takes from the text face: a letterless token (parentheses,
 *    digits, operators, punctuation), an operator name ("log", "sup") and a token set in
 *    a sub- or superscript's size ("init" of x_init). What remains is the sentence around
 *    the formula, which is the writing, with the full stop or comma that closed the
 *    formula, as arXiv's HTML has it.
 *  - A HYPHEN at a line break is Zotero's to drop, and it drops every one: "language-only"
 *    becomes "languageonly". The hyphen is still in pdf.js's run, and the document's own
 *    vocabulary says whether the word is spelt with it (lib/pdf/reflow.ts). With no
 *    vocabulary the line ends are the reflow's, mended already.
 *
 * A bracketed citation mark goes too; `keepOpening` keeps one that opens the block, the
 * label of a reference list's entry, which only the reflow reads.
 */
export function assemble(pieces: Piece[], located: Located, vocab: Vocabulary | null, { mathPages, italicMath }: MathPages, { keepOpening = false } = {}): Assembled {
  const { sources, faces } = located;
  // ---- tokens: where a word space belongs ----
  let tokens: Token[] = [];
  let open: Token | null = null;
  let prevGlyph: Glyph | null = null;
  let prevSource: Source | null = null;
  let prevFormula: boolean | null = null;
  let spaced = true;
  /** A citation mark was left out since the last piece kept. */
  let marked = false;
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
      if (apart || !open) { open = { at: [], math: false, letters: false, ...(marked ? { marked: true as const } : {}) }; tokens.push(open); }
      open.at.push(i);
      if (formula) open.math = true;
      if (/\p{L}/u.test(p.ch)) open.letters = true;
      spaced = false;
      marked = false;
    } else marked = true;
    if (p.glyph) prevGlyph = p.glyph;
    if (src) prevSource = src;
    if (formula !== null && !cited[i]) prevFormula = formula;
  });
  tokens = hyphened(tokens, pieces, faces, (i) => symbolic[i] || faces[i]?.math === true, italicMath);

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
  /** The piece follows a space in its pdf.js run. pdf.js gives a run one size, and a Word
   *  document's equation leaves the words after a script in the script's run ("i and" of
   *  "$c_i$ and"): what a space parts from a script in its run is not the script. */
  const afterSpace = (i: number): boolean => {
    const s = sources[i];
    return s !== null && /\s/u.test(s.box.it.str.slice(0, s.offset));
  };
  const script = (t: Token): boolean => t.at.every((i) => faces[i] !== null && faces[i]!.h <= body * SCRIPT_SIZE && !afterSpace(i));
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
  /** A number set against the relation that ends the formula before it: TeX puts a thick
   *  space after a relation inside a formula, outside a sub- or superscript, so "$\sim$10
   *  kHz" and "$\geq$50%" are the text's numbers, and "$\sim 10$" is not. What decides is
   *  pdf.js's runs, which keep the space Zotero's glyphs fold away. */
  /** A number a cross-reference names, with nothing between it and the formula after it:
   *  "by Proposition 1 $f$ is", "Eq. (3) $x$". */
  const referenced = (k: number): boolean =>
    k > 0 && !drop[k - 1] && /^[(\[]?\p{N}/u.test(pieces[tokens[k].at[0]].ch + (pieces[tokens[k].at[1]]?.ch ?? "")) && REFERENCE.test(letters(tokens[k - 1]));
  /** A name set against the bracket of the formula after it: a function applied,
   *  "\mathrm{Aug}(\mathcal{G})", "\operatorname{KL}(p\|q)". */
  const applied = (k: number): boolean => {
    const t = tokens[k], next = tokens[k + 1];
    return t.letters && /\p{L}[([]$/u.test(pieces[t.at[t.at.length - 2]]?.ch + pieces[t.at[t.at.length - 1]].ch) && next !== undefined && pieces[next.at[0] - 1]?.ch !== " ";
  };
  const typedAfter = (k: number): boolean => {
    const t = tokens[k], before = tokens[k - 1];
    if (!before || !/^\p{N}/u.test(pieces[t.at[0]].ch) || !RELATION.test(pieces[before.at[before.at.length - 1]].ch)) return false;
    const a = sources[before.at[before.at.length - 1]], b = sources[t.at[0]];
    if (!a || !b || a.page !== b.page || a.item === b.item || b.offset !== 0) return false;
    if (a.offset !== a.box.it.str.trimEnd().length - 1 || b.box.h <= body * SCRIPT_SIZE) return false;
    return Math.abs(a.box.y - b.box.y) < b.box.h * 0.5 && b.box.x1 - a.box.x2 < b.box.h * GLUED;
  };
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
  /** A letter set alone: one letter of a text face on a page that sets mathematics, what
   *  else the token holds punctuation or the letter's own script, not a label's digit
   *  ("(A1)"); no label itself, "(A)" or the "A" of "Appendix A"; and no word beside it in
   *  its face — "Part A" is a phrase of it — but one in another. Its face, and whether it
   *  carries a script. */
  const lone = (k: number): { face: Box; script: boolean } | null => {
    const t = tokens[k];
    const size = Math.max(...t.at.map((i) => faces[i]?.h ?? 0));
    const small = (i: number): boolean => faces[i] !== null && faces[i]!.h < size * CORNER && !afterSpace(i);
    const main = t.at.filter((i) => LETTER.test(pieces[i].ch) && !small(i));
    const face = main.length === 1 ? faces[main[0]] : null;
    if (!face || face.math || face.mono || !mathPages.has(face.page)) return null;
    if (t.at.some((i) => i !== main[0] && !/^[\p{P}\p{M}\p{Lm}\p{Sk}]$/u.test(pieces[i].ch) && !small(i))) return null;
    if (/^[([]\p{L}[)\]]/u.test(t.at.map((i) => pieces[i].ch).join(""))) return null;
    const before = word(k, -1);
    if (before && REFERENCE.test(letters(before))) return null;
    const around = [before, word(k, 1)].filter((n): n is Token => n !== null);
    const same = (n: Token): boolean => faceOf(n)?.font === face.font;
    if (!around.some((n) => !same(n)) || around.some((n) => same(n) && count(n) > 1)) return null;
    return { face, script: t.at.some((i) => small(i) && ALNUM.test(pieces[i].ch)) };
  };
  /** A single letter set alone in a bold face: "\mathbf{h}", "\mathbf{J}_0". */
  const alone = (k: number): boolean => BOLD_FONT.test(lone(k)?.face.font ?? "");
  /** A formula's letter set alone in the text's italic, on a page whose mathematics has no
   *  face of its own for letters (italicMath: mathptmx, mathpazo): beside a formula ("$R =
   *  $"), with a script of its own ("$D_i$", "$M_\odot$"), or hyphened to a word ("$g$-band").
   *  An italic letter nothing marks stays ("plan B"), and every one does where the
   *  mathematics sets its letters in a face of its own: there the italic is the writer's. */
  const variable = (k: number): boolean => {
    const l = lone(k);
    if (!l || !italicMath.has(l.face.page) || !ITALIC_FONT.test(baseName(l.face.font))) return false;
    const t = tokens[k], prev = tokens[k - 1], next = tokens[k + 1];
    return l.script || next?.glued === true || (prev?.math === true && beside(prev, t)) || (next?.math === true && beside(t, next));
  };
  /** Set in a face the page uses only for formulas (formulaFaces): a number, a symbol, a
   *  word of three letters or fewer ("km", "SNR"), an operator name or a function applied
   *  ("var(", "span("). A longer word is left to the text: a heading's, a name in small
   *  capitals. */
  const formulaFace = (t: Token): boolean => {
    let any = false;
    for (const i of t.at) {
      const f = faces[i];
      if (!f) continue;
      if (!f.aside || !mathPages.has(f.page)) return false;
      any = true;
    }
    const name = letters(t);
    return any && (name.length <= 3 || OPERATOR.has(name) || /\p{L}\(/u.test(t.at.map((i) => pieces[i].ch).join("")));
  };
  const drop = tokens.map((t, k) => t.math || alone(k) || variable(k) || formulaFace(t));
  for (let i = 1; i < tokens.length; i++) {
    if (drop[i - 1] && withFormula(tokens[i]) && !written(tokens[i]) && !typedAfter(i) && beside(tokens[i - 1], tokens[i])) drop[i] = true;
  }
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (drop[i + 1] && (withFormula(tokens[i]) || applied(i)) && !written(tokens[i]) && !closes(tokens[i]) && !referenced(i) && beside(tokens[i], tokens[i + 1])) drop[i] = true;
  }

  // ---- the text ----
  let text = "";
  let prov: (Source | null)[] = [];
  /** Where a formula or a citation mark was left out of `text`. */
  const skips: number[] = [];
  tokens.forEach((t, k) => {
    if (drop[k]) {
      // The formula goes; the full stop or the comma after it, set in the text face, stays
      // with the sentence it ends, as it does on arXiv's HTML: "the value of x." reads
      // "the value of.", not "the value of" run into the next sentence.
      let tail = t.at.length;
      while (tail > 0 && CLAUSE_END.test(pieces[t.at[tail - 1]].ch) && !faces[t.at[tail - 1]]?.math) tail--;
      if (text === "") return;
      skips.push(text.length);
      for (const i of t.at.slice(tail)) { text += pieces[i].ch; prov.push(sources[i]); }
      return;
    }
    if (t.marked && text !== "") skips.push(text.length);
    if (text !== "" && !(t.glued && !drop[k - 1])) { text += " "; prov.push(null); }
    let previous: number | null = null;
    for (const i of t.at) {
      const p = pieces[i], src = sources[i];
      // A line break inside a token with no space: Zotero mended a hyphenation. The
      // hyphen is at the end of the previous glyph's run, if it is anywhere.
      if (vocab && previous !== null) {
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

  ({ text, prov } = closedUp(text, prov, skips));
  ({ text, prov } = composed(text, prov));
  ({ text, prov } = withoutCitations(text, prov, keepOpening));

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

/**
 * The text without the space a formula or a citation mark left out leaves before punctuation
 * (skipGap, lib/dom/text.ts): "as Dunne ⁴⁶." reads "as Dunne.", as the web walker reads the
 * same sentence. A space the author set there stays.
 */
function closedUp(text: string, prov: (Source | null)[], skips: number[]): { text: string; prov: (Source | null)[] } {
  const gaps = skips.map((at) => skipGap(text, at)).filter((gap) => gap !== null);
  if (gaps.length === 0) return { text, prov };
  const drop = new Array<boolean>(text.length).fill(false);
  for (const [from, to] of gaps) drop.fill(true, from, to);
  let out = "";
  const kept: (Source | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    if (drop[i]) continue;
    out += text[i];
    kept.push(prov[i]);
  }
  return { text: out, prov: kept };
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
function withoutCitations(text: string, prov: (Source | null)[], keepOpening: boolean): { text: string; prov: (Source | null)[] } {
  const cuts = bracketCitations(text).filter(([from]) => !keepOpening || from > 0);
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
export const MARK_NUMBERS = /^[[(]?\d{1,4}[a-z]?(?:\s*[,;–-]\s*\d{1,4}[a-z]?)*[\])]?$/u;

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
