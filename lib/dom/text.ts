// lib/dom/text.ts — the scoring Unit (v2) + text utilities.
//
// v2 replaces the single-run Unit with a SEGMENT: one or more visual paragraphs
// ("parts") scored together. A part is a run of consecutive text nodes inside one
// block container. Most units have exactly one part; short neighbouring paragraphs
// of ONE voice (list items, BR-separated lines of a post, the short paragraphs of
// one article or one comment) are merged into multi-part units so text below the
// per-paragraph evidence floor still gets covered instead of being silently skipped,
// and a post that fits one model window is one unit whole (lib/dom/walker.ts).

/** One visual paragraph inside a unit: an inline run of text nodes + its block. */
export interface UnitPart {
  /** Ordered consecutive text nodes of the run. */
  nodes: Text[];
  /** Nearest block-laid-out ancestor of the run — render/measure anchor. */
  container: Element;
  /** The run came from preserved-whitespace text (a mailing-list message, a plain-text
   *  document). Only there is a leading `>` a quote marker rather than prose, so only
   *  there do the text and the offset map leave one out (stripQuoteMarkers). */
  preserved?: boolean;
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
  /** Where the unit comes in its source's order. The walker's is the order units were
   *  FOUND in — document order within one walk, after every earlier walk's units wherever
   *  they are — so where its units stand on the page is asked of the page instead
   *  (inPageOrder in lib/dom/walker.ts). */
  order: number;
  /** First part's container — IntersectionObserver anchor. */
  topElement: Element;
  /** Last part's container — badge anchor. */
  container: Element;
  /** Claim flag: a result has rendered for this unit. */
  isScored: boolean;
  /**
   * The unit's text is the DOCUMENT's, not the page's, and cannot be read back off the
   * nodes. The PDF reader is where this happens (lib/pdf/units.ts): a paragraph there has
   * had its hyphens mended, its running heads dropped and its two halves sewn across a
   * page break, so concatenating the spans it covers gives something else entirely. Two
   * things follow. The orchestrator must not recompute the text to ask whether it changed
   * — it would never match, and every dirty pass would retire the unit. And the PARTS are
   * pieces of a page rather than the paragraphs of one voice, so a unit of three parts is
   * still ONE paragraph unless the unit says otherwise (`paragraphs`).
   */
  textFixed?: true;
  /**
   * How many of the document's PARAGRAPHS this unit reads, where the parts do not say so.
   * A PDF's parts are the pieces a page break or a column cut one paragraph into, so a
   * unit built there states this outright: 1 for a paragraph however many pages it crosses,
   * N for N short paragraphs read together (lib/pdf/units.ts). Left out by the walker,
   * whose parts ARE the paragraphs.
   */
  paragraphs?: number;
}

/**
 * How many paragraphs a unit reads — what the chip counts when it says "×3" and what the
 * card names. One per part, unless the unit stated it itself.
 */
export function unitParagraphs(unit: Unit): number {
  return unit.paragraphs ?? (unit.textFixed ? 1 : unit.parts.length);
}

// ---- thresholds -------------------------------------------------------------------

/**
 * Evidence floor per unit: a unit is only emitted at ≥ this. The open EditLens model was
 * trained and evaluated only on texts of at least 75 words, and scores shorter ones
 * unreliably: on 50-word openings a quarter of human texts read as AI-edited.
 */
export const MIN_UNIT_WORDS = 75;

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

/**
 * The most text one unit holds: some 32 000 words. This is a guard against a single node
 * that is not writing at all — a log, a data dump, a minified page in one <div> — and
 * NOT a limit on how much of a paragraph gets read: everything up to here is read, window
 * by window (lib/capture/windows.ts keeps MAX_READ_CHARS at or above this). It stood at
 * 20 000 with an eight-window reading cap on top, and a 4 220-word answer Gemini wrote as
 * ONE paragraph was judged on its first half only; the model is fast enough on the
 * machines this runs on that cost is no reason to stop early.
 */
export const MAX_UNIT_TEXT_CHARS = 200_000;


// ---- extraction / normalization ---------------------------------------------------

/** The source text of one part = join of its text nodes' content. */
export function extractPartText(nodes: Text[]): string {
  let s = "";
  for (const n of nodes) s += n.textContent ?? "";
  return s;
}

/**
 * Characters that shape how a page is SET and are no part of what was written: soft
 * hyphens (hyphenation hints), the zero-width space and non-joiner, the byte-order mark,
 * the word joiner and the invisible math operators, bidi marks and controls. The same
 * sentence on two sites must reach the model alike — soft-hyphenated news text was scored
 * differently per site. The zero-width JOINER stays, as do the variation selectors: they
 * hold an emoji sequence together ("👨‍👩‍👧" is one family, not three people), and the
 * engine spells out each sequence by its name.
 */
const INVISIBLES_RE =
  // SHY | ZWSP ZWNJ | LRM RLM | BOM | LRE..RLO+PDF | word joiner..invisible plus | LRI..PDI
  /[\u00AD\u200B\u200C\u200E\u200F\uFEFF\u202A-\u202E\u2060-\u2064\u2066-\u2069]/g;

/** Un-rendered inline LaTeX ($\tau^{2}$): only spans that contain a command — "$5 and $10" stays. */
const RAW_LATEX_RE = /\$[^$\n]*\\[A-Za-z]+[^$\n]*\$/g;

/** Bump when the model form changes; caches from older rules must never match. */
export const SCORING_NORMALIZATION_VERSION = "3";

/**
 * The text the model reads, which is also what its verdicts are cached under.
 *
 * EditLens was trained on text as it was written, prepared only by the cleaning the
 * engine applies itself (anagramd/engine.py clean_text, the official pipeline's): emoji
 * spelled out, a chatbot's opening paragraph dropped, lower case, whitespace collapsed.
 * Typography is part of that text — curly quotes, dashes, "…", "--" and "™" are evidence
 * of who wrote it — so nothing here folds them. Only what reading a page leaves behind is
 * repaired: the invisibles above out, `\%` `\&` `\_` `\#` `\$` escapes to the character and
 * un-rendered LaTeX spans out (arXiv-like pages), a PDF's ligature glyphs (ﬁ, ﬄ) to their
 * letters, runs of spaces to one space, and a run of whitespace that breaks a line to one
 * "\n" — the engine can drop an opening paragraph only where it sees one end.
 *
 * A FIXED POINT: m(m(x)) === m(x), so the worker can apply it again to what a page sends
 * and key its cache on the same bytes. Ligatures go first: "$\ﬁ$" is a LaTeX span only
 * once spelled out. Removing an invisible, an escape or a span can join what stood on
 * either side of it into another, so those steps repeat until none applies.
 */
export function modelText(s: string): string {
  s = s.replace(/[\uFB00-\uFB06]/g, (ligature) => ligature.normalize("NFKC"));
  for (;;) {
    const next = s.replace(INVISIBLES_RE, "").replace(/\\+([%&_#$])/g, "$1").replace(RAW_LATEX_RE, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, (run) => (/[\n\r\u2028\u2029]/.test(run) ? "\n" : " ")).trim();
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
  /** Some word of two or more letters starts in lowercase, or most of the words are in
   *  a script that has no case at all (CJK, Arabic, Thai): running text — not a Name
   *  Surname, a Title In Title Case, "Acme Inc." or a SHOUTING BUTTON. */
  running: boolean;
}

export function wordShape(text: string): WordShape {
  let letterWords = 0;
  let casedWords = 0;
  let lowerStart = false;
  const see = (t: string): void => {
    if (!/\p{L}/u.test(t)) return;
    letterWords++;
    if (/[\p{Lu}\p{Ll}]/u.test(t)) casedWords++;
    if (/^\p{Ll}\p{L}/u.test(t)) lowerStart = true;
  };
  const seg = wordSegmenter();
  if (seg) {
    for (const s of seg.segment(text)) if ((s as any).isWordLike) see(s.segment);
  } else {
    for (const t of text.split(/\s+/)) see(t);
  }
  // A Chinese sentence that names OpenAI or an iPhone is still a Chinese sentence: one
  // capitalised brand used to make it "punctuated but not prose", and a 223-word post on X
  // was judged by 135 of its words. Most words caseless → running text.
  return { letterWords, running: lowerStart || casedWords * 2 < letterWords };
}

/**
 * The line a mail program writes over a quotation — "On 14 Sep 2026, at 09:12, Alice Moreau
 * <alice@example.org> wrote:" — which Apple Mail sets inside the quotation and Thunderbird and
 * Yahoo in a block of their own above it. It reads like a lead-in sentence, but nobody wrote
 * it. The shape is mailgun talon's RE_QUOTE_HEADER (https://github.com/mailgun/talon,
 * talon/html_quotations.py, Apache-2.0, Copyright Mailgun Inc.); a clock time or an address
 * in it tells it from an author's "On 3 March 1931 the editor wrote:".
 */
const ATTRIBUTION_RE = /^On\s.{0,500}\swrote\s?:$/s;
const ATTRIBUTION_DETAIL_RE = /\d{1,2}[:.]\d{2}|\S@\S/;

export function isAttribution(text: string): boolean {
  return ATTRIBUTION_RE.test(text) && ATTRIBUTION_DETAIL_RE.test(text);
}

/** What a short run turns out to BE (shortRole). */
export type ShortRole =
  /** A sentence, or long enough to be one without the full stop: it takes part in merging. */
  | "prose"
  /** Punctuated, but too little to be evidence or to mean anything about who is speaking
   *  ("Yes.", "Me too!", "Hodges 1983, p. 208."): passed over without consequence. */
  | "aside"
  /** An unpunctuated handful of words in a block of its own: a username, a timestamp,
   *  "Reply · Share", a pseudo-heading made of a div. */
  | "label";

/**
 * What a run under the evidence floor is, by its text alone. A block of its own is PROSE
 * when it reads like a sentence ("I agree completely.", or the lead-in "Can also be
 * written as:" before a code sample) or is long enough to be one without the full stop
 * (most bullet items). Either way it must be running text: "Alice Moreau, Ph.D." and
 * "SIGN UP TODAY!" are not, and neither is "alice:" nor "On …, alice wrote:".
 *
 * The caller passes the shape when it has already measured it — the walker reads it again
 * for its own tests, and wordShape segments the text.
 */
export function shortRole(text: string, shape: WordShape = wordShape(text)): ShortRole {
  if (isAttribution(text)) return "label";
  const prose =
    shape.running &&
    (((endsLikeProse(text) || endsInColon(text)) && shape.letterWords >= MIN_SENTENCE_WORDS) ||
      shape.letterWords >= MIN_MERGE_WORDS);
  if (prose) return "prose";
  return endsLikeProse(text) ? "aside" : "label";
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

// ---- e-mail quotations ---------------------------------------------------------------

/**
 * Quote depth of a line: "> " once, ">> " twice. In a mailing-list message the quoted
 * lines are somebody ELSE's words and the reply around them is the author's, so the two
 * never belong to one unit — the same boundary a <blockquote> draws in HTML.
 */
export function quoteDepth(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ">") {
      depth++;
      continue;
    }
    if (ch === " " || ch === "\t") continue;
    break;
  }
  return depth;
}

/** Quote depth a run speaks in: that of its first line with text in it. */
export function runQuoteDepth(raw: string): number {
  for (const line of raw.split("\n")) {
    if (line.trim() !== "") return quoteDepth(line);
  }
  return 0;
}

/** The markers at the start of a quoted line: any indent, the `>`s (`>>`, `> >`) and one
 *  space after the last of them. What follows keeps its own indentation. */
const QUOTE_MARKER_RE = /^[ \t]*(?:>[ \t]*)*>[ \t]?/gm;

/**
 * The `>` a mail client puts in front of every quoted line is how it DRAWS the quotation —
 * the indent a <blockquote> draws in HTML — and not a word of it. Scoring the markers sent
 * the model a text with a `>` at the head of every line, which is nothing anybody wrote.
 * They are stripped from the text of a preserved-whitespace run that speaks at a quote
 * depth (lists.debian.org, lore.kernel.org), and from nowhere else: a `>` at the start of
 * ordinary prose is a shell prompt or a quotation somebody typed, and ours to leave alone.
 */
function stripQuoteMarkers(raw: string): string {
  return runQuoteDepth(raw) === 0 ? raw : raw.replace(QUOTE_MARKER_RE, "");
}

/**
 * From a run's RAW text to the text a unit carries: the `>` markers of a quoted mail run
 * out — they are the quotation's frame, not its words — and every whitespace run collapsed.
 * THREE places read one paragraph this way and they must agree character for character: the
 * walker writes it (walker.ts, `read`), the orchestrator recomputes it to ask whether a
 * unit's text changed (`currentTextOf`), and lib/dom/locate.ts maps offsets in it back to
 * the page. It lives here so there is one definition to agree with.
 */
export function unitPartText(raw: string, preserved: boolean): string {
  return (preserved ? stripQuoteMarkers(raw) : raw).replace(/\s+/g, " ").trim();
}

/**
 * The same for a part that is already in a unit. The orchestrator asks this to learn
 * whether a unit's text CHANGED; rebuilding it any other way left a quoted unit never
 * equal to itself, so every mutation near it threw the unit away and read it again.
 */
export function partTextOf(part: UnitPart): string {
  return unitPartText(extractPartText(part.nodes), part.preserved === true);
}

/**
 * The same markers as a flag per character of `raw`, for the map that leads from an offset
 * in a unit's text back to the page (lib/dom/locate.ts): the two must drop exactly the same
 * characters, or the text and the page disagree and every window falls back to marking the
 * whole unit. Null where there is no quotation at all — nearly always.
 */
export function quoteMarkerMask(raw: string): boolean[] | null {
  if (runQuoteDepth(raw) === 0) return null;
  const mask = new Array<boolean>(raw.length).fill(false);
  for (const m of raw.matchAll(QUOTE_MARKER_RE)) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = true;
  }
  return mask;
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
