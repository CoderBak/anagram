// lib/dom/text.ts — the scoring Unit (v2) + text utilities.
//
// v2 replaces the single-run Unit with a SEGMENT: one or more visual paragraphs
// ("parts") scored together. A part is a run of consecutive text nodes inside one
// block container. Most units have exactly one part; short neighbouring paragraphs
// of ONE voice (list items, BR-separated lines of a post, the short paragraphs of
// one article or one comment) are merged into multi-part units so text below the
// per-paragraph evidence floor still gets covered instead of being silently skipped.

/** One visual paragraph inside a unit: an inline run of text nodes + its block. */
export interface UnitPart {
  /** Ordered consecutive text nodes of the run. */
  nodes: Text[];
  /** Nearest block-laid-out ancestor of the run — render/measure anchor. */
  container: Element;
}

/** A scoreable segment (≥1 visual paragraph). */
export interface Unit {
  /** Stable per-scan id (e.g. "u_3f"); rendering keys off this, NOT array index. */
  id: string;
  /** The visual paragraphs scored together, in document order. */
  parts: UnitPart[];
  /** Joined text of all parts ("\n\n" between parts), trimmed per part. */
  text: string;
  /** Word count of `text` (Intl.Segmenter — CJK counts correctly). */
  wordCount: number;
  /** Formulas (MathML / MathJax / KaTeX / Wikipedia math) skipped inside the unit —
   *  disclosed in the card, because the model scored prose with holes in it. */
  formulas: number;
  /** Document-order index at collect time (contract ScoreBlock.order). */
  order: number;
  /** First part's container — IntersectionObserver anchor. */
  topElement: Element;
  /** Last part's container — badge anchor. */
  container: Element;
  /** Claim flag: a result has rendered for this unit. */
  isScored: boolean;
}

// ---- thresholds -------------------------------------------------------------------

/**
 * Evidence floor per unit. Pangram Labs (the commercial detector) states predictions are unreliable below
 * ~50 words (it cannot attribute below ~75). A unit is only emitted at ≥ this.
 */
export const MIN_UNIT_WORDS = 50;

/**
 * Prose by LENGTH: a short run that does not end like a sentence (a bullet item
 * without a full stop) still takes part in merging once it carries this many
 * words. Under it, an unpunctuated run in a block of its own is a LABEL — a
 * username, a timestamp, "Reply · Share", a pseudo-heading — and never prose.
 */
export const MIN_MERGE_WORDS = 8;

/** Prose by FORM: a run that ends like a sentence needs only this many words
 *  ("I agree completely."). Shorter ones ("Yes.", "Me too!") are asides — skipped. */
export const MIN_SENTENCE_WORDS = 3;

/**
 * A further LINE of the text block a group is already reading (BR- or blank-line-
 * separated lines of one post) joins without any punctuation from this many words:
 * "I quit my job", "Here is what happened next". Shorter unpunctuated lines are
 * skipped — that is where a name, a handle or "2h ago" sits when a site puts it in
 * the same block as the message.
 */
export const MIN_LINE_WORDS = 4;

/** Hard storage cap for a single unit's text (pathological single-node dumps). */
export const MAX_UNIT_TEXT_CHARS = 20_000;

/**
 * Cap on the text actually SENT for scoring; cut at a sentence boundary. The
 * rendered unit still covers the full paragraph — long paragraphs must never be
 * split mid-flow at the surface (the M1 1000-char cap truncated the HF abstract
 * and dropped its tail).
 */
export const MAX_SCORE_CHARS = 4000;

// ---- extraction / normalization ---------------------------------------------------

/** The source text of one part = join of its text nodes' content. */
export function extractPartText(nodes: Text[]): string {
  let s = "";
  for (const n of nodes) s += n.textContent ?? "";
  return s;
}

/**
 * Presentation-only invisibles that must never reach hashing OR the detector:
 * zero-width space/joiners, BOM, soft hyphens (hyphenation hints), and bidi
 * control characters. The same visible sentence on two sites must produce the
 * same payload — soft-hyphenated news text was scoring differently per site.
 */
const INVISIBLES_RE =
  // ZWSP..RLM | SHY | BOM | LRE..RLO+PDF | word-joiner block | LRI..PDI
  /[\u200B-\u200F\u00AD\uFEFF\u202A-\u202E\u2060-\u2064\u2066-\u2069]/g;

/** Strip presentation-only invisible characters (kept in the rendered DOM). */
export function stripInvisibles(s: string): string {
  return s.replace(INVISIBLES_RE, "");
}

/** Un-rendered inline LaTeX ($\tau^{2}$): only spans that contain a command — "$5 and $10" stays. */
const RAW_LATEX_RE = /\$[^$\n]*\\[A-Za-z]+[^$\n]*\$/g;

/**
 * The ONE canonical form of a paragraph for scoring AND for cache keys.
 *
 * Presentation is normalized, content is not: the same sentence rendered by arXiv's
 * abstract page, its HTML converter, a PDF-derived copy or a CMS must reach the model
 * as the same bytes. EditLens is surface-sensitive — a LaTeX `---` where the page
 * meant an em dash moved a verdict from 55 % to 9 % — so LaTeX residue and
 * typographic variants are folded to one convention: NFKC (ligatures, full-width
 * forms), invisibles and non-breaking spaces out, `---`/`--` → dashes, LaTeX quotes
 * and escapes (`\%`) → characters, curly quotes/apostrophes → ASCII, digit ranges
 * `1–5` → `1-5`, whitespace collapsed. No lowercasing, no punctuation stripping — the
 * daemon applies the model's own preprocessing on top of this.
 */
export function canonicalForScoring(s: string): string {
  return stripInvisibles(s.normalize("NFKC"))
    .replace(/\u00A0/g, " ")
    .replace(/---/g, "—")
    .replace(/(?<=\S)--(?=\S)/g, "–")
    .replace(/``|''/g, '"')
    .replace(/(?<=\s|^)`(?=\S)/g, "'")
    .replace(/\\([%&_#$])/g, "$1")
    .replace(RAW_LATEX_RE, "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/(\d)[\u2013\u2010\u2011](\d)/g, "$1-$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize for hashing/cache — the same canonical form the model receives, so two
 * renderings of one paragraph share one cache entry and one verdict.
 */
export function normalizeText(s: string): string {
  return canonicalForScoring(s);
}

/** True if the text contains at least one letter in ANY script (incl. CJK). */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

// ---- segmenters (cached — constructing Intl.Segmenter per call is expensive) -------

type Seg = { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };

let _wordSeg: Seg | null | undefined;
function wordSegmenter(): Seg | null {
  if (_wordSeg === undefined) {
    try {
      _wordSeg = new (Intl as any).Segmenter(undefined, { granularity: "word" });
    } catch {
      _wordSeg = null;
    }
  }
  return _wordSeg ?? null;
}

let _sentSeg: Seg | null | undefined;
function sentenceSegmenter(): Seg | null {
  if (_sentSeg === undefined) {
    try {
      _sentSeg = new (Intl as any).Segmenter(undefined, { granularity: "sentence" });
    } catch {
      _sentSeg = null;
    }
  }
  return _sentSeg ?? null;
}

/** Word count via Intl.Segmenter (CJK-correct), whitespace-split fallback. */
export function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const seg = wordSegmenter();
  if (seg) {
    let n = 0;
    for (const s of seg.segment(t)) if ((s as any).isWordLike) n++;
    return n;
  }
  return t.split(/\s+/).filter(Boolean).length;
}

/** Sentence split (Intl.Segmenter sentence granularity, regex fallback). */
export function splitSentences(text: string): string[] {
  const seg = sentenceSegmenter();
  if (seg) {
    return [...seg.segment(text)].map((x) => x.segment).filter((s) => s.trim());
  }
  return text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim());
}

/**
 * Offsets at which a new sentence STARTS (ascending, never 0 and never the end of the
 * text) — the places a long text may be cut into windows. A sentence owns the
 * whitespace that follows it, so a cut never opens a window on a space. The "\n\n"
 * between the parts of a merged unit is a boundary too: a bullet list whose items carry
 * no full stop can still be cut between two items. CJK sentence marks count with
 * nothing after them, because Chinese and Japanese put no space there.
 */
export function sentenceStarts(text: string): number[] {
  const out: number[] = [];
  const seg = sentenceSegmenter();
  if (seg) {
    // ICU reports the second newline of a "\n\n" joint as a sentence of its own.
    for (const s of seg.segment(text)) if (s.index > 0 && /\S/.test(s.segment)) out.push(s.index);
    return out;
  }
  const re = /(?:[.!?]["'”’»)\]]*(?=\s)|[。！？][」』）】]*|\n\n)\s*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index + m[0].length;
    if (at > 0 && at < text.length && out[out.length - 1] !== at) out.push(at);
  }
  return out;
}

/**
 * Prepare text for SCORING: strip presentation invisibles, then truncate at a
 * sentence boundary near `max` chars. Rendering always covers the full unit;
 * only the backend input is capped.
 */
export function truncateForScoring(text: string, max: number = MAX_SCORE_CHARS): string {
  text = stripInvisibles(text);
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  // Prefer the last sentence end in the head; fall back to last whitespace; then hard cut.
  const m = head.match(/[\s\S]*[.!?。！？](?=\s|$)/);
  if (m && m[0].length >= max / 2) return m[0];
  const ws = head.lastIndexOf(" ");
  return ws >= max / 2 ? head.slice(0, ws) : head;
}

/** What is actually SENT for a unit: canonical form, then the sentence-bounded cap. */
export function scoringText(text: string, max: number = MAX_SCORE_CHARS): string {
  return truncateForScoring(canonicalForScoring(text), max);
}

// ---- what a short run IS (the assembler's role test) -----------------------------------

/** Closing quotes/brackets and trailing emoji that may follow the last punctuation mark. */
const END_TAIL = String.raw`["'”’»)\]」』）】]*[\s\p{S}\p{M}\u200D\uFE0F]*$`;
const PROSE_END_RE = new RegExp(`[.!?…,;。！？，；、]${END_TAIL}`, "u");
const LEAD_IN_END_RE = new RegExp(`[:：]${END_TAIL}`, "u");

/**
 * Ends the way running prose ends: sentence or clause punctuation (Latin and CJK),
 * optionally followed by closing quotes/brackets and trailing emoji. Names, handles,
 * timestamps, action rows and headings do not end like that.
 */
export function endsLikeProse(text: string): boolean {
  return PROSE_END_RE.test(text);
}

/**
 * Ends in a colon. Kept apart from endsLikeProse because a colon cuts both ways:
 * "Can also be written as:" before a code sample is the author's own sentence (MDN
 * is full of them), while "alice:" and "bob wrote:" name somebody ELSE. The assembler
 * accepts the colon only on a run that is otherwise a sentence.
 */
export function endsInColon(text: string): boolean {
  return LEAD_IN_END_RE.test(text);
}

/** What the words of a short run look like — the assembler's role test reads this. */
export interface WordShape {
  /** Words that contain a letter: "10:42", "2026", "p. 208" are not the words of a
   *  sentence, and Wikipedia's "Hodges 1983, p. 208." is a citation, not a remark. */
  letterWords: number;
  /** Some word of two or more letters starts in lowercase, or the script has no
   *  case at all (CJK, Arabic, Thai): running text — not a Name Surname, a Title In
   *  Title Case, "Acme Inc." or a SHOUTING BUTTON. */
  running: boolean;
}

export function wordShape(text: string): WordShape {
  let letterWords = 0;
  let lowerStart = false;
  const see = (t: string): void => {
    if (!/\p{L}/u.test(t)) return;
    letterWords++;
    if (/^\p{Ll}\p{L}/u.test(t)) lowerStart = true;
  };
  const seg = wordSegmenter();
  if (seg) {
    for (const s of seg.segment(text)) if ((s as any).isWordLike) see(s.segment);
  } else {
    for (const t of text.split(/\s+/)) see(t);
  }
  return { letterWords, running: lowerStart || !/[\p{Lu}\p{Ll}]/u.test(text) };
}

/** Separator-looking runs ("* * *", "———"): punctuation/symbols only, no digits. */
export function isSeparatorRun(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  return t.length >= 3 && /^[\p{P}\p{S}]+$/u.test(t);
}

// ---- structural noise ---------------------------------------------------------------

const STRUCTURAL_SYMBOLS = new Set([
  "+", "-", "|", "=", "_", "~", "^", "*", "\\", "/", "<", ">", "#", "`",
  "─", "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼", "═", "║", "╔", "╗", "╚", "╝",
]);

/**
 * Fraction of non-whitespace characters that are structural/box-drawing symbols.
 * ASCII diagrams, table rules and divider rows score far above prose (which sits
 * around 0.02–0.06 even with heavy hyphenation) — used as a merge barrier.
 */
export function symbolNoiseRatio(text: string): number {
  let sym = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total++;
    if (STRUCTURAL_SYMBOLS.has(ch)) sym++;
  }
  return total > 0 ? sym / total : 0;
}

/**
 * Column-layout detector for preserved-whitespace text: prose never contains 8+
 * consecutive INTERIOR SPACES on one line (newlines don't match), but headers,
 * TOCs and tabular layouts do ("RFC 768<spaces>J. Postel").
 */
export function hasColumnGaps(rawText: string): boolean {
  return /\S {8,}\S/.test(rawText);
}

// ---- name lists / citation strings ------------------------------------------------------

/**
 * "Pallarés-Carratalá V, Polo García J, Martín Rioboo E, …" — author lists, bylines
 * and citation strings clear the word floor on reference pages but are not prose:
 * nearly every token is a capitalised name or initial and commas come every few
 * tokens. Prose (even German, with its capitalised nouns) stays well under the
 * capitalised share; title-case headlines are too short to matter.
 */
export function looksLikeNameList(text: string): boolean {
  const tokens = text.split(/\s+/).filter((t) => /\p{L}/u.test(t));
  if (tokens.length < 12) return false;
  let capitalised = 0;
  for (const t of tokens) if (/^[("]?\p{Lu}[\p{L}'’\-.]*[,;.)]?$/u.test(t)) capitalised++;
  const commas = (text.match(/,/g) ?? []).length;
  return capitalised / tokens.length >= 0.6 && commas >= tokens.length / 8;
}

// ---- link density ------------------------------------------------------------------

/**
 * Fraction of the run's text inside <a> links. Article prose has some links but is
 * mostly plain text; nav menus / story-title lists are ~all links. High ratio marks
 * a non-prose run that also acts as a merge barrier.
 */
export function linkTextRatio(nodes: Text[]): number {
  let total = 0;
  let link = 0;
  for (const n of nodes) {
    const len = (n.textContent ?? "").trim().length;
    if (len === 0) continue;
    total += len;
    if (n.parentElement && n.parentElement.closest("a")) link += len;
  }
  return total > 0 ? link / total : 0;
}
