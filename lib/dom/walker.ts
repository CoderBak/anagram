// lib/dom/walker.ts — v2 paragraph segmentation.
//
// One recursive pass over the COMPOSED tree (shadow roots + slots) segments the
// page into visual paragraphs by computed layout, then assembles them into
// scoreable Units:
//
//   walk  — text nodes accumulate into an inline RUN; block-laid-out elements
//           close runs (a run == one visual paragraph). Inline markup — <code>,
//           <em>, links, drop caps — never splits a sentence. <br> and blank
//           lines in preserved-whitespace contexts are paragraph breaks.
//   asm   — a paragraph of ≥ MIN_UNIT_WORDS is a unit of its own. Consecutive SHORT runs
//           of ONE VOICE (the lines of a post, list items, the short paragraphs of an
//           article or of one comment) MERGE into multi-part units — short text gets
//           covered instead of silently skipped. The stretch is read to its end and then
//           divided, between paragraphs and evenly, into groups of at most ONE MODEL
//           WINDOW: the merged-group analogue of a paragraph chip, never one verdict per
//           thousand words and never an arbitrary cut at the floor. A short text that
//           cannot stand alone joins the full paragraph next to it when the two fit one
//           window — no orphans inside one voice. A merge never crosses a voice
//           boundary: every run has a SCOPE (its post, quotation, figure or quoted card;
//           else the page) and merges only within it, an embedded scope interrupting the
//           text around it without ending it. A scope is declared by the markup or, where
//           a site declares nothing, recognised by its structure — one of several like
//           it, each with its own byline (lib/dom/scope.ts). A scope whose own prose fits ONE
//           window is a POST and becomes one unit whole, its full paragraphs included; a
//           longer one is an article and keeps a unit per full paragraph. What a short
//           run IS decides its part: a further line of the block being read and a
//           sentence join, an unpunctuated name / time / action row never does — and on
//           a page with no semantic markup that row is what separates two voices; inside
//           a post, short unpunctuated lines beside unstopped lines of the same body are
//           lines of verse, and join. Text
//           too short on its own, with nobody of its voice to join, gets no unit.
//           Headings, boilerplate, link-dense runs, name lists, ASCII art and separator
//           rules are barriers nothing is merged across (inside a post they are merely
//           left out).
//
// v1's hard 1000-char mid-paragraph split is gone: a long paragraph is ONE unit
// end-to-end (the HF-abstract "underline stops mid-paragraph" bug); a unit that does not
// fit the model's window is read in windows (lib/capture/windows.ts), never cut here.
import { NO_SCORE_TAGS, INLINE_FALLBACK_TAGS, isHeading, isHeadingLabel, tagOf } from "./tags";
import { isBoilerplate, isNoTranslate } from "./boilerplate";
import {
  createStyleCache,
  flowClassOf,
  isInlineDisplay,
  isOutOfFlow,
  isVisuallyHidden,
  preservesNewlines,
} from "./style";
import { createRectVisibleCache } from "./visibility";
import {
  type Unit,
  type UnitPart,
  extractPartText,
  hasLetters,
  countWords,
  linkTextRatio,
  symbolNoiseRatio,
  hasColumnGaps,
  isSeparatorRun,
  looksLikeNameList,
  endsLikeProse,
  endsInColon,
  wordShape,
  MIN_UNIT_WORDS,
  MIN_MERGE_WORDS,
  MIN_SENTENCE_WORDS,
  MIN_LINE_WORDS,
  MAX_UNIT_TEXT_CHARS,
} from "./text";
import { type Scopes, createScopes } from "./scope";
import { WINDOW_CHARS } from "../capture/windows";
import { MARK_ATTR } from "../types";

/**
 * Formula containers of every renderer in use: raw MathML, MathJax v2/v3, KaTeX,
 * Wikipedia's math element, LaTeXML's equation tables, Material-for-MkDocs arithmatex.
 * A formula is skipped mid-sentence and counted — never a run break, whatever its
 * computed display (Chromium gives `<math>` `display: math`, MathJax an inline-block
 * with a hidden block child, LaTeXML display equations a `<table>`).
 * Case-sensitive on purpose: arXiv marks whole abstracts `class="abstract mathjax"`
 * (a "please typeset this" hint), which must not read as a formula.
 */
const MATH_CLASS_RE =
  /(?:^|\s)(?:katex|katex-display|MathJax|MathJax_Preview|MathJax_Display|MathJax_SVG|MathJax_CHTML|mwe-math-element|math-container|ltx_Math|ltx_equation|ltx_equationgroup|ltx_eqn|arithmatex)(?:\s|$)/;

function isMathContainer(el: Element, tag: string): boolean {
  if (tag === "MATH" || tag === "MJX-CONTAINER") return true;
  const cls = el.getAttribute("class");
  return !!cls && MATH_CLASS_RE.test(cls);
}

/**
 * Footnote / citation marks: `<sup class="reference">[7]</sup>` (Wikipedia),
 * `<sup class="ltx_note_mark">1</sup>` and `<cite class="ltx_cite">[12]</cite>` (arXiv),
 * markdown footnote refs, `[citation needed]`, daggers. Not prose — skipped without
 * closing the run. A bare-number `<sup>` counts only when it is a link, so
 * `km<sup>2</sup>` keeps its exponent.
 */
const MARKER_CLASS_RE =
  /(?:^|\s)(?:reference|references|footnote|footnote-ref|footnote-reference|footnoteRef|fn-ref|fnref|noteref|note-ref|ltx_note_mark|ltx_cite|citation|cite-bracket|Inline-Template|mw-ref)(?:\s|$)/;

function isCitationMarker(el: Element, tag: string): boolean {
  if (tag !== "SUP" && tag !== "CITE") return false;
  const text = (el.textContent ?? "").trim();
  if (text.length > 40) return false; // a real <cite> title
  const cls = el.getAttribute("class");
  if (cls && MARKER_CLASS_RE.test(cls)) return true;
  if (/^\[[^\]]{1,30}\]$/.test(text)) return true; // [7] · [a] · [12, 13] · [citation needed]
  if (tag === "SUP" && /^[*†‡§¶]{1,3}$/.test(text)) return true;
  if (tag === "SUP" && /^\d{1,3}$/.test(text) && el.querySelector("a")) return true;
  return false;
}

/** One assembled inline run (== one visual paragraph) awaiting unit assembly. */
interface Run {
  nodes: Text[];
  container: Element;
  text: string;
  /** Pre-collapse text — interior column gaps only survive here. */
  raw: string;
  /** Run came from preserved-whitespace context (column-gap check applies). */
  preserved: boolean;
  words: number;
  linkRatio: number;
  /** Formulas skipped inside this run. */
  formulas: number;
  /** Position in the walk (set by the assembler) — units are returned in this order. */
  index: number;
  /** Incremental re-scan: a live unit already owns exactly this run. */
  claimed: boolean;
}

/** A run the walk has found but nobody has READ yet: reading — joining the text, counting
 *  its words, measuring its links and its box — is most of what a run costs. */
interface Found {
  nodes: Text[];
  container: Element;
  preserved: boolean;
  formulas: number;
}

export interface CollectOptions {
  /**
   * Ownership filter for incremental re-scans. "skip" → exactly these nodes are a part
   * of a live unit; "take" → process them (the orchestrator invalidates any stale owner
   * before answering "take"). Asked once per run. A re-scan reads the page the way a
   * first scan would, owned runs included, and a unit that would come out holding only
   * owned runs is the live one and is left alone. One that would hold owned runs NEXT TO
   * new ones — a post that gained a paragraph — is asked for once more, as a whole: that
   * node list is no live part, so the stale owner is retired and the unit is taken anew.
   */
  claimFilter?: (nodes: Text[]) => "take" | "skip";
  /**
   * Group sub-floor paragraphs with compatible neighbors of the same voice, and read a
   * post that fits one model window whole (default). False = strict per-paragraph
   * mode: every full paragraph by itself, short runs skipped.
   */
  mergeShorts?: boolean;
  /**
   * Called once per open shadow root the walk descends into. The orchestrator
   * registers a MutationObserver on each: subtree observation of the document
   * never crosses a shadow boundary, so content appended inside a web component
   * after the first scan would otherwise never be seen.
   */
  onShadowRoot?: (root: ShadowRoot) => void;
}

/** Max link-text fraction for a run to count as prose (nav/menu barrier above it). */
const MAX_LINK_RATIO = 0.6;
/** An out-of-flow element with at most this much text is a marker (page number,
 *  badge, anchor label), not content — skipped without breaking the sentence. */
const SMALL_OUT_OF_FLOW_CHARS = 40;

/** Blank line inside preserved-whitespace text == paragraph gap. */
const PARA_GAP_RE = /\n[ \t\r]*\n/;

let _unitSeq = 0;

/**
 * TOP-LEVEL — collect scoreable Units under `root` (default: document.body).
 * Safe to call on subtree roots for incremental re-scans; claimed runs are skipped.
 */
export function collectUnits(
  root: ParentNode = document.body,
  opts: CollectOptions = {},
): Unit[] {
  if (!root) return [];
  const rootEl: Element | null = root instanceof Element ? root : null;
  if (rootEl && !rootEl.isConnected) return [];
  if (rootEl && isExcludedByAncestry(rootEl)) return [];

  const plainTextDoc = document.contentType === "text/plain";
  const styles = createStyleCache();
  const rects = createRectVisibleCache();
  const startEl = rootEl ? wholePost(rootEl) : document.body;
  if (!startEl) return [];
  const asm = createAssembler(opts.mergeShorts ?? true, startEl, read, (nodes) => opts.claimFilter?.(nodes) !== "skip");

  // ---- run accumulation ------------------------------------------------------------

  let cur: Text[] = [];
  let curContainer: Element | null = null;
  let curPreserved = false;
  let curFormulas = 0;
  /** Quote depth the last processed run spoke in (e-mail quotations, see processRun). */
  let quoteLevel = 0;
  /** Quote depth the OPEN run speaks in; -1 until it has its first node. */
  let curQuote = -1;

  function pushNode(tn: Text, ctx: Ctx): void {
    if (cur.length === 0) {
      curContainer = ctx.container;
      curPreserved = ctx.preserves;
      curQuote = ctx.preserves ? runQuoteDepth(tn.textContent ?? "") : 0;
    }
    cur.push(tn);
  }

  /** Does the text accumulated so far end a line, so that the next node opens one?
   *  lore.kernel.org wraps every quoted block in a `<span class="q">` of its own, which
   *  puts the quote boundary BETWEEN two text nodes rather than inside one. */
  function atLineStart(): boolean {
    for (let i = cur.length - 1; i >= 0; i--) {
      const s = cur[i].textContent ?? "";
      if (s.length === 0) continue;
      return /\n[ \t]*$/.test(s);
    }
    return true;
  }

  function closeRun(): void {
    // Interior whitespace nodes were kept (see visitText); trailing ones are not
    // part of the paragraph.
    while (cur.length > 0 && (cur[cur.length - 1].textContent ?? "").trim() === "") cur.pop();
    const formulas = curFormulas;
    curFormulas = 0;
    if (cur.length === 0) {
      cur = [];
      curContainer = null;
      curPreserved = false;
      curQuote = -1;
      return;
    }
    const nodes = cur;
    const container = curContainer as Element;
    const preserved = curPreserved;
    cur = [];
    curContainer = null;
    curPreserved = false;
    curQuote = -1;
    processRun(nodes, container, preserved, formulas);
  }

  function read(found: Found, claimed: boolean): Run | null {
    const { nodes, container, preserved, formulas } = found;
    if (!rects.get(container)) return null; // zero-size container → invisible text
    const raw = extractPartText(nodes);
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return null;
    return {
      nodes,
      container,
      text,
      raw,
      preserved,
      words: countWords(text),
      linkRatio: linkTextRatio(nodes),
      formulas,
      index: 0,
      claimed,
    };
  }

  function processRun(nodes: Text[], container: Element, preserved: boolean, formulas: number): void {
    const found: Found = { nodes, container, preserved, formulas };
    if (opts.claimFilter && opts.claimFilter(nodes) === "skip") {
      asm.owned(found); // a live unit's part: read only if something new turns up beside it
      return;
    }
    const run = read(found, false);
    if (!run) return;
    // A change of e-mail quote depth is a change of voice: the reply of a
    // lists.debian.org message never merges with the lines it quotes, nor those with
    // the quotation nested inside them.
    const depth = run.preserved ? runQuoteDepth(run.raw) : 0;
    if (depth !== quoteLevel) {
      quoteLevel = depth;
      asm.barrier(run.container);
    }
    asm.run(run);
  }

  // ---- traversal ---------------------------------------------------------------------

  interface Ctx {
    container: Element; // nearest block-laid-out ancestor
    hidden: boolean; // computed visibility: hidden/collapse
    preserves: boolean; // computed white-space preserves newlines
  }

  function visitChildren(el: Element, ctx: Ctx): void {
    for (const child of composedChildren(el, opts.onShadowRoot)) visit(child, ctx);
  }

  function visit(node: Node, ctx: Ctx): void {
    if (node.nodeType === Node.TEXT_NODE) {
      visitText(node as Text, ctx);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = tagOf(el); // normalized — SVG/MathML/XHTML report lowercase nodeName

    if (tag === "BR") {
      closeRun(); // hard line/paragraph break — merge logic rejoins short halves
      return;
    }
    if (tag === "WBR") return; // word-break OPPORTUNITY — must not split the word
    if (el.hasAttribute(MARK_ATTR)) return; // our own UI — transparent, mid-flow safe

    const cs = styles.get(el);
    const flow = flowClassOf(el, cs);
    // display:none takes NO space: the text around it reads as one sentence, so it
    // must never close the run (hidden template spans, lazy content, <script>…).
    if (flow === "hidden") return;

    // Mid-sentence markup that is not prose — skipped WITHOUT closing the run, so the
    // sentence continues around it: formulas (counted for the card), footnote and
    // citation marks, and visually hidden out-of-flow copies (sr-only text, the
    // accessibility MathML that math renderers keep beside the visible glyphs).
    if (isMathContainer(el, tag)) {
      curFormulas++;
      return;
    }
    if (isCitationMarker(el, tag)) return;
    if (cs && isVisuallyHidden(cs)) return;
    // Absolutely positioned page numbers ("[Pg 12]"), corner badges and anchor labels
    // sit in the middle of a paragraph's markup but not in its sentence. (Chromium
    // blockifies them, so without this they closed the run — Gutenberg paragraphs were
    // scored in two pieces.) Large out-of-flow boxes (tooltips, positioned columns)
    // keep behaving as their own blocks.
    if (cs && isOutOfFlow(cs) && (el.textContent ?? "").trim().length <= SMALL_OUT_OF_FLOW_CHARS) return;

    // Exclusions: never descend, never score. Whether they BREAK the sentence
    // depends on layout — inline exclusions (icons, <img>, MathJax spans, sr-only,
    // aria-hidden decorations) sit mid-sentence and are skipped silently; block
    // exclusions occupy their own space and close the run.
    const boiler = isBoilerplate(el);
    const excluded =
      boiler ||
      NO_SCORE_TAGS.has(tag) ||
      // Chrome's text viewer wraps .txt in body>pre. A <pre> of PROSE — an RFC or a man
      // page published as HTML, a mailing-list message — is read like any other block.
      (tag === "PRE" && !plainTextDoc && !isProsePre(el)) ||
      isNoTranslate(el) ||
      (el as HTMLElement).isContentEditable ||
      el.getAttribute("aria-hidden") === "true" ||
      (cs !== null && (cs.opacity === "0" || (cs as any).contentVisibility === "hidden"));
    if (excluded) {
      if (flow !== "inline" && flow !== "contents") closeRun();
      if (boiler) asm.barrier(el); // page chrome separates sections — no merging across
      return;
    }

    const hidden = cs ? cs.visibility === "hidden" || cs.visibility === "collapse" : ctx.hidden;
    const preserves = cs ? preservesNewlines(cs) : ctx.preserves;

    if (flow === "contents") {
      visitChildren(el, { container: ctx.container, hidden, preserves });
      return;
    }

    if (flow === "inline") {
      // An inline-block/-flex/-grid hosting its own block children is a CARD laid
      // into the line (tweet embeds, product tiles) — treat as a block boundary.
      if (cs && cs.display.startsWith("inline-") && hasBlockChildren(el)) {
        closeRun();
        visitChildren(el, { container: el, hidden, preserves });
        closeRun();
        return;
      }
      visitChildren(el, { container: ctx.container, hidden, preserves });
      return;
    }

    // block-laid-out from here on.
    // Floated phrase-tag elements (drop caps: <span class="dropcap">T</span>) still
    // read as part of the sentence — keep them in the run.
    const float = cs ? ((cs as any).float ?? cs.cssFloat ?? "none") : "none";
    if (float !== "none" && INLINE_FALLBACK_TAGS.has(tag)) {
      visitChildren(el, { container: ctx.container, hidden, preserves });
      return;
    }
    // A heading is a barrier only while it is a LABEL. A container that merely declares
    // itself one — lobste.rs' comment bodies, a teaser card wrapped in <h2> — is walked
    // like the block it is (isHeadingLabel); the real headings inside it still stop here.
    if (isHeading(el) && isHeadingLabel(el)) {
      closeRun();
      asm.barrier(el); // topic boundary; headings themselves are never scored
      return;
    }
    closeRun();
    visitChildren(el, { container: el, hidden, preserves });
    closeRun();
  }

  function visitText(tn: Text, ctx: Ctx): void {
    if (ctx.hidden) return;
    const s = tn.textContent ?? "";
    if (ctx.preserves && s.trim() !== "" && curQuote >= 0 && (curQuote > 0 || s.indexOf(">") >= 0)) {
      // The quotation ends (or begins) at a node boundary rather than inside a node:
      // lore.kernel.org puts every quoted block in a `<span class="q">` of its own. The
      // boundary is a line start on either side of the seam — the span ends its line, or
      // the text after it opens one.
      const opensLine = /^[ \t]*\n/.test(s) || atLineStart();
      if (opensLine && runQuoteDepth(s) !== curQuote) closeRun();
    }
    if (ctx.preserves && (PARA_GAP_RE.test(s) || nextQuoteBoundary(s) > 0)) {
      splitPreservedText(tn, ctx);
      return;
    }
    if (s.trim().length === 0) {
      // A whitespace-only node BETWEEN inline elements is the space between two
      // words (`<b>Alan</b> <i>Turing</i>`); dropping it glued them into one token
      // and starved the word count. Keep it while a run is open; leading ones are
      // nothing, trailing ones are trimmed in closeRun.
      if (cur.length > 0) pushNode(tn, ctx);
      return;
    }
    pushNode(tn, ctx);
  }

  /**
   * Preserved-whitespace text (plain-text docs, pre-wrap chat transcripts, a
   * mailing-list message): blank lines are paragraph gaps, and so is the line where an
   * e-mail quotation starts or ends — a reply written under the quoted lines with no
   * blank line between them is still two voices. The node is split ONCE at each break
   * (idempotent — the resulting chunk nodes contain no further breaks) so parts stay
   * whole-node spans.
   */
  function splitPreservedText(tn: Text, ctx: Ctx): void {
    let node: Text = tn;
    for (;;) {
      const s = node.textContent ?? "";
      const m = PARA_GAP_RE.exec(s);
      const quoteAt = nextQuoteBoundary(s);
      if (quoteAt > 0 && (m === null || quoteAt < m.index)) {
        const rest = node.splitText(quoteAt); // the boundary is a line start: never 0
        if ((node.textContent ?? "").trim()) pushNode(node, ctx);
        closeRun();
        node = rest;
        continue;
      }
      if (!m) {
        if (s.trim()) pushNode(node, ctx);
        return;
      }
      if (m.index > 0) {
        const rest = node.splitText(m.index); // node keeps the paragraph text
        if ((node.textContent ?? "").trim()) pushNode(node, ctx);
        closeRun();
        node = rest; // rest begins with the gap → next iteration hits index 0
        continue;
      }
      // Gap at position 0: consume it (and any following blank space).
      let end = m.index + m[0].length;
      while (end < s.length && /\s/.test(s[end])) end++;
      closeRun();
      // Whole node is gap: NOTHING to split. splitText(length) would be a mutating
      // no-op that fires fresh mutation records — the first scan already left this
      // gap in its own node, and re-splitting it forever fed an infinite
      // observe→rescan loop with one leaked empty text node per cycle.
      if (end >= s.length) return;
      node = node.splitText(end);
    }
  }

  function hasBlockChildren(el: Element): boolean {
    for (const c of el.children) {
      const ccs = styles.get(c);
      const d = ccs?.display ?? "";
      if (ccs && isOutOfFlow(ccs)) continue; // absolutely positioned helpers are not layout
      if (d && d !== "none" && d !== "contents" && !isInlineDisplay(d)) return true;
    }
    return false;
  }

  // ---- go ------------------------------------------------------------------------

  visit(startEl, { container: startEl, hidden: false, preserves: false });
  closeRun();
  return asm.finish();
}

/** Composed-tree children: shadow root replaces light children; slots resolve. */
function composedChildren(el: Element, onShadowRoot?: (root: ShadowRoot) => void): Node[] {
  const sr = el.shadowRoot;
  if (sr) {
    onShadowRoot?.(sr);
    return Array.from(sr.childNodes);
  }
  if (typeof HTMLSlotElement !== "undefined" && el instanceof HTMLSlotElement) {
    return el.assignedNodes({ flatten: true });
  }
  return Array.from(el.childNodes);
}

/** Hard exclusion check up the ancestor chain — guards partial re-scan roots. */
function isExcludedByAncestry(start: Element): boolean {
  const plainTextDoc = document.contentType === "text/plain";
  let el: Element | null = start;
  while (el) {
    const tag = tagOf(el);
    if (NO_SCORE_TAGS.has(tag)) return true;
    if (tag === "PRE" && !plainTextDoc && !isProsePre(el)) return true;
    if (el.hasAttribute(MARK_ATTR)) return true;
    if (isNoTranslate(el)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (isBoilerplate(el)) return true;
    el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
  }
  return false;
}

// ---- <pre>: machine text, or prose that happens to be typeset? -----------------------

/** How much of a <pre> is sampled for the shape tests. Twenty-five lines settle it,
 *  and an RFC published as HTML has 176 of these blocks in one document. */
const PRE_SAMPLE_CHARS = 2000;
/** Below this there is nothing to score anyway, and a short <pre> is nearly always a
 *  command line or a snippet. */
const PRE_MIN_WORDS = 20;
const PRE_MIN_LINES = 3;
/** Code lines are short (a statement, a key, a flag); wrapped prose fills its column. */
const PRE_MIN_WORDS_PER_LINE = 4;
/** Share of non-space characters that may be code punctuation — `(){}[];=<>`. Prose in
 *  an RFC stays under 0.03 even where it quotes header syntax; Python sits at 0.10,
 *  C and JavaScript above that, a unified diff at 0.12. */
const PRE_MAX_CODE_PUNCT = 0.03;
/** Share of words that begin in lower case (or in a script without case): running text.
 *  JSON, SQL, logs and a table of contents are far below it. */
const PRE_MIN_LOWER_SHARE = 0.5;
/** Sentence ends per hundred words. Code, configuration and log lines have none. */
const PRE_MIN_SENTENCE_ENDS = 1.5;

const CODE_PUNCT_CHARS = new Set(["(", ")", "{", "}", "[", "]", ";", "=", "<", ">"]);

/** Markup that means "this is code", on the <pre> itself or just above it: the
 *  `<pre><code>` idiom, and the class tokens every highlighter and docs generator
 *  leaves behind (highlight.js, Pygments/Sphinx, Chroma, prettify, Prism's
 *  `language-*`, GitHub's `data-lang`). */
const CODE_MARKUP_SELECTOR = "code,samp,kbd,var";
const CODE_CLASS_RE =
  /(?:^|[\s_-])(?:code|codeblock|codehilite|highlight|highlighter|hljs|chroma|prettyprint|prettyprinted|linenums|sourcecode|syntax|snippet|terminal|console|repl|crayon|gist|diff|patch|listing|language-[\w+#.-]+|lang-[\w+#.-]+|brush:[\w+#.-]+)(?:[\s_-]|$)/i;
/** How far above the <pre> the wrapper of a highlighter sits (Sphinx: `<div
 *  class="highlight-python"><div class="highlight"><pre>`). */
const CODE_WRAPPER_LEVELS = 3;

function hasCodeMarkup(el: Element): boolean {
  if (el.querySelector(CODE_MARKUP_SELECTOR) !== null) return true;
  let cur: Element | null = el;
  for (let up = 0; cur && up < CODE_WRAPPER_LEVELS; up++, cur = cur.parentElement) {
    if (up > 0 && tagOf(cur) === "CODE") return true;
    if (cur.hasAttribute("data-lang") || cur.hasAttribute("data-language")) return true;
    const hay = `${(cur as HTMLElement).id ?? ""} ${cur.getAttribute("class") ?? ""}`;
    if (hay.trim() !== "" && CODE_CLASS_RE.test(hay)) return true;
  }
  return false;
}

/**
 * Does this text READ as prose? One pass over the sample counts lines, words, words
 * that begin in lower case, code punctuation and sentence ends — no allocation, because
 * a document may hold 176 of these blocks. Every threshold has to be cleared, so
 * anything ambiguous stays excluded, exactly as before.
 */
function readsAsProse(raw: string): boolean {
  const t = raw.length > PRE_SAMPLE_CHARS ? raw.slice(0, PRE_SAMPLE_CHARS) : raw;
  let lines = 0;
  let words = 0;
  let lowerWords = 0;
  let punct = 0;
  let nonSpace = 0;
  let sentences = 0;
  let lineHasText = false;
  let inWord = false;
  let wordHasLetter = false;
  let wordStartsLower = false;
  const endWord = (): void => {
    if (inWord && wordHasLetter) {
      words++;
      if (wordStartsLower) lowerWords++;
    }
    inWord = false;
    wordHasLetter = false;
    wordStartsLower = false;
  };
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    if (code === 10 /* \n */) {
      endWord();
      if (lineHasText) lines++;
      lineHasText = false;
      continue;
    }
    if (code === 32 || code === 9 || code === 13) {
      endWord();
      continue;
    }
    nonSpace++;
    lineHasText = true;
    const ch = t[i];
    if (CODE_PUNCT_CHARS.has(ch)) punct++;
    if (code === 46 /* . */ || code === 33 /* ! */ || code === 63 /* ? */) {
      // A full stop ends a sentence only where a space or the end of the text follows
      // it, so "1.1" and "ls.1" do not count.
      const next = i + 1 < t.length ? t.charCodeAt(i + 1) : 32;
      if (next === 32 || next === 9 || next === 10 || next === 13) sentences++;
    }
    // Letters: ASCII plus everything above it (accented Latin, Cyrillic, CJK). A script
    // without case counts as lower case — its prose is running text too.
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 127;
    if (!inWord) {
      inWord = true;
      wordStartsLower = (code >= 97 && code <= 122) || code > 127;
    }
    if (letter) wordHasLetter = true;
  }
  endWord();
  if (lineHasText) lines++;
  if (words < PRE_MIN_WORDS || lines < PRE_MIN_LINES) return false;
  if (words / lines < PRE_MIN_WORDS_PER_LINE) return false;
  if (punct / Math.max(1, nonSpace) > PRE_MAX_CODE_PUNCT) return false;
  if (lowerWords / words < PRE_MIN_LOWER_SHARE) return false;
  return (sentences / words) * 100 >= PRE_MIN_SENTENCE_ENDS;
}

/**
 * Whole classes of document are prose typeset in a `<pre>`: RFCs published as HTML
 * (RFC 2616 has 176 of them, 59 963 words, and produced nothing — while the same RFC
 * served as text/plain was read), the messages of lore.kernel.org and lists.debian.org,
 * man pages on man7.org. Excluding every `<pre>` lost all of it.
 *
 * The test is deliberately one-sided: a `<pre>` is prose only when nothing around it
 * says "code" (no `<code>`/`<samp>`/`<kbd>` inside or above it, no highlighter or
 * `language-*` class on it or its wrapper) AND the text itself reads as prose. When
 * anything is unclear it stays excluded, exactly as it was. What gets in is walked as
 * preserved-whitespace text, so blank lines are paragraph gaps and the existing
 * column-gap and symbol-noise barriers still keep tables of contents, ASCII tables,
 * headers and diffs out of the units.
 */
function isProsePre(el: Element): boolean {
  if (hasCodeMarkup(el)) return false;
  return readsAsProse(el.textContent ?? "");
}

// ---- e-mail quotations ---------------------------------------------------------------

/**
 * Quote depth of a line: "> " once, ">> " twice. In a mailing-list message the quoted
 * lines are somebody ELSE's words and the reply around them is the author's, so the two
 * never belong to one unit — the same boundary a <blockquote> draws in HTML.
 */
function quoteDepth(line: string): number {
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

/** Offset of the first line whose quote depth differs from the line before it, or -1.
 *  Blank lines carry no depth of their own and never break the comparison. The text of
 *  a page has no quote marker in it at all nine times out of ten — that is one indexOf,
 *  and the line scan never runs. */
function nextQuoteBoundary(s: string): number {
  if (s.indexOf(">") < 0) return -1;
  let lineStart = 0;
  let depth = -1;
  for (let i = 0; i <= s.length; i++) {
    if (i < s.length && s[i] !== "\n") continue;
    const line = s.slice(lineStart, i);
    if (line.trim() !== "") {
      const d = quoteDepth(line);
      if (depth >= 0 && d !== depth && lineStart > 0) return lineStart;
      depth = d;
    }
    lineStart = i + 1;
  }
  return -1;
}

/** Quote depth a run speaks in: that of its first line with text in it. */
function runQuoteDepth(raw: string): number {
  for (const line of raw.split("\n")) {
    if (line.trim() !== "") return quoteDepth(line);
  }
  return 0;
}

// ---- unit assembly ---------------------------------------------------------------

interface Assembler {
  run(r: Run): void;
  /** A run a live unit owns (incremental re-scan), not read yet. */
  owned(found: Found): void;
  /** No group of short runs continues across this point. `at` — the element the barrier
   *  sits in — keeps a barrier INSIDE a quotation or a figure from also ending the
   *  author's text around it; without it everything open is closed. */
  barrier(at?: Element): void;
  finish(): Unit[];
}

/**
 * Merge compatibility: same container (BR-split halves), sibling containers (the
 * paragraphs of one post, <li>s), or one-level cousins (<li><p> structures). Anything
 * further apart is a different section and must not merge.
 */
function compatible(a: Element, b: Element): boolean {
  if (a === b) return true;
  const ap = a.parentElement;
  const bp = b.parentElement;
  if (ap && ap === bp) return true;
  if (ap && bp && (ap === bp.parentElement || bp === ap.parentElement)) return true;
  return false;
}

/**
 * VOICE BOUNDARIES. Every run belongs to a SCOPE — its post, comment, quotation, figure or
 * quoted card, declared by the markup or recognised by its structure (lib/dom/scope.ts);
 * else the page — and runs merge only inside one scope. The answers are cached per scan,
 * and a scan asks twice: `wholePost` before the walk, the assembler during it. The first
 * to ask creates the scopes of the scan and the assembler takes them over, so the page is
 * surveyed for bylines once.
 */
let scanScopes: Scopes | null = null;

function scopesOfScan(): Scopes {
  return (scanScopes ??= createScopes());
}

/** `root` holds `el` in the COMPOSED tree: contains() alone stops at a shadow root. */
function composedContains(root: Element, el: Element): boolean {
  for (let cur: Element | null = el; cur; ) {
    if (root.contains(cur)) return true;
    const shadow = cur.getRootNode();
    cur = shadow instanceof ShadowRoot ? shadow.host : null;
  }
  return false;
}

/** Two blocks of ONE BODY of text: siblings of the same tag and the same class — the <p>s
 *  of one rendered answer, not a paragraph and the stats row the card sets beside it. */
function sameBody(a: Element, b: Element): boolean {
  return (
    a !== b &&
    a.parentElement !== null &&
    a.parentElement === b.parentElement &&
    a.tagName === b.tagName &&
    (a.getAttribute("class") ?? "") === (b.getAttribute("class") ?? "")
  );
}

/** All the text of a scope — names, counters and a quoted post included — up to which a
 *  walk that was asked to start INSIDE the scope starts at the scope instead. */
const WHOLE_POST_CHARS = 2 * WINDOW_CHARS;

/**
 * Where a walk asked to start at `root` really starts. Whether a declared scope is a post
 * or an article (see `settle`) can only be told from ALL of its prose, and a re-scan
 * usually starts inside one: React sets the text of X's `div[data-testid=tweetText]`
 * anew when a post is opened or translated in place, a forum appends a paragraph to the
 * post body, and the orchestrator re-scans what a retired unit released one container at
 * a time — each <p> of a comment, read by itself, is a short text with nobody to join. A
 * root inside a scope that is small ALTOGETHER is therefore moved up to the scope: cheap
 * by construction, and the re-scan decides from what the first scan saw. Inside anything
 * larger the walk stays where it was asked to start and the scope is read as an article,
 * so a mutation in a long article never re-reads the article.
 */
function wholePost(root: Element): Element {
  const scope = scopesOfScan().of(root);
  if (!scope || scope === root) return root;
  const all = scope.textContent ?? "";
  // Pretty-printed markup is mostly indentation; far beyond the bound it is not worth collapsing.
  if (all.length > 8 * WHOLE_POST_CHARS) return root;
  return all.replace(/\s+/g, " ").length <= WHOLE_POST_CHARS ? scope : root;
}

/** Length of the text these runs become as one unit: their texts, "\n\n" between them. */
function joinedChars(runs: Run[]): number {
  return runs.reduce((n, r) => n + r.text.length, 0) + 2 * Math.max(0, runs.length - 1);
}

function wordsOf(runs: Run[]): number {
  return runs.reduce((n, r) => n + r.words, 0);
}

/** `runs` in `n` consecutive pieces, each as near to an even share of the characters as the
 *  joints between two runs allow. */
function evenPieces(runs: Run[], n: number): Run[][] {
  const total = joinedChars(runs);
  const pieces: Run[][] = [];
  let piece: Run[] = [];
  let seen = 0;
  for (const r of runs) {
    const next = seen + r.text.length + 2;
    const share = ((pieces.length + 1) * total) / n;
    if (piece.length > 0 && pieces.length < n - 1 && Math.abs(seen - share) <= Math.abs(next - share)) {
      pieces.push(piece);
      piece = [];
    }
    piece.push(r);
    seen = next;
  }
  pieces.push(piece);
  return pieces;
}

/**
 * A stretch of short runs of one voice as the units it becomes. Closing a group the
 * moment it reached fifty words cut a 1767-word Zhihu answer of 49 paragraphs into 20
 * chips and a 288-word X post into four; reading the whole stretch as ONE unit would put
 * a single number on a thousand words, and what makes a chip worth having on a long text
 * is that it is fine-grained. So the stretch is divided into groups of at most one model
 * window (WINDOW_CHARS, some 300 words — about the mean length of the texts the model was
 * trained on, and what it judges in a single reading): ceil(total / window) of them, cut
 * between two paragraphs, as even as the paragraphs allow, so there is no small tail
 * group. Every group keeps the evidence floor; only where that cannot be had inside a
 * window (words of thirty letters) is a group longer, and read in windows like any long
 * paragraph.
 */
function modelSized(runs: Run[]): Run[][] {
  if (joinedChars(runs) <= WINDOW_CHARS) return [runs];
  const floor = (pieces: Run[][]): boolean => pieces.every((p) => wordsOf(p) >= MIN_UNIT_WORDS);
  const first = Math.ceil(joinedChars(runs) / WINDOW_CHARS);
  let best: Run[][] | null = null;
  for (let n = first; n <= runs.length; n++) {
    const pieces = evenPieces(runs, n);
    if (!floor(pieces)) break;
    best = pieces;
    if (pieces.every((p) => joinedChars(p) <= WINDOW_CHARS)) break; // else a joint fell badly: one more
  }
  for (let n = first - 1; !best && n > 1; n--) {
    const pieces = evenPieces(runs, n);
    if (floor(pieces)) best = pieces;
  }
  return best ?? [runs];
}

/**
 * The prose of a post, divided by where it stands: a run belongs with the first earlier
 * run it is `compatible` with. A LinkedIn card sets the author's headline ("VP, Chief
 * Strategy Officer at …", eleven words that read like running text) in the entity lockup
 * at the top of the same <article>, far from the commentary; X hangs a reader-written
 * context note under a status. Neither is the post, and the rule that keeps a group of
 * short runs to one section keeps them out of it. Paragraphs on both sides of a list whose
 * items sit a level deeper still find each other, because ANY earlier run will do.
 */
function standingTogether(runs: Run[], together: (a: Element, b: Element) => boolean): Run[][] {
  const places: Run[][] = [];
  for (const r of runs) {
    const home = places.find((place) => place.some((other) => together(other.container, r.container)));
    if (home) home.push(r);
    else places.push([r]);
  }
  return places;
}

/** The merge state of one scope. Scopes nest (a quotation inside a post inside the
 *  page), so the assembler keeps a stack of these. */
interface Frame {
  /** The voice boundary element; null = the page itself. */
  scope: Element | null;
  /** The short runs being read together; open until the voice ends. */
  group: Run[];
  /** Container of the line the group read last (or of `pending`): a further run in
   *  the SAME container is the next line of one text block. */
  block: Element | null;
  /** An unpunctuated first line that could not open a group by itself. */
  pending: Run | null;
  /** Inside a post: unpunctuated lines in blocks of their own, side by side, that nothing
   *  has shown to be text yet (see `short`, lines of verse). */
  lines: Run[];
  /** The unit of the last FULL paragraph, not yet let go: a short text right after it that
   *  cannot stand alone may still join it (see `endGroup`). */
  prev: Run[] | null;
  /** A declared scope: every run of its own prose, in document order … */
  prose: Run[];
  /** … and the units it becomes if it turns out to be an article. Both are held until the
   *  walk leaves the scope, because only then is it known which of the two it is. */
  held: Run[][];
  /** The walk started inside this scope and cannot see all of it. */
  partial: boolean;
  /** Owned runs that arrived while nothing new was being read here, in order, position in
   *  the walk included; `null` is a barrier among them (see `owned`). */
  unread: ((Found & { index: number }) | null)[];
  /** Something NEW is being read here, so owned runs are read as they come (see `owned`):
   *  on the page while a new run is open, in a declared scope from the first new run on. */
  live: boolean;
}

function createAssembler(
  mergeShorts: boolean,
  walkRoot: Element,
  /** Read a found run; null when there is nothing to read (invisible, empty). */
  read: (found: Found, claimed: boolean) => Run | null,
  /** Ask the claim filter for a whole would-be unit; true = its stale owners are gone. */
  retake: (nodes: Text[]) => boolean,
): Assembler {
  /** Emitted units with the walk index of their first run — scopes interleave, so
   *  units complete out of document order and are sorted once at the end. */
  const emitted: { unit: Unit; at: number }[] = [];
  const stack: Frame[] = [];
  let runIndex = 0;
  const scopes = scopesOfScan();
  scanScopes = null; // the next scan looks at the page anew
  const scopeOf = (el: Element): Element | null => scopes.of(el);

  /**
   * Do two runs of one frame stand in the same place? Proximity (`compatible`) everywhere.
   * Inside a RECOGNISED post also when nothing but that person's text lies between them
   * (scope.ts, `oneBody`): there proximity is not what keeps a voice together — the post is.
   * Declared scopes and the bare page are read exactly as before.
   */
  function together(f: Frame, a: Element, b: Element): boolean {
    if (compatible(a, b)) return true;
    return f.scope !== null && scopes.recognised(f.scope) && scopes.oneBody(a, b, f.scope);
  }

  function emit(runs: Run[]): void {
    const parts: UnitPart[] = runs.map((r) => ({ nodes: r.nodes, container: r.container }));
    const text = runs.map((r) => r.text).join("\n\n").slice(0, MAX_UNIT_TEXT_CHARS);
    const unit: Unit = {
      id: "",
      parts,
      text,
      wordCount: wordsOf(runs),
      formulas: runs.reduce((n, r) => n + r.formulas, 0),
      order: 0,
      topElement: runs[0].container,
      container: runs[runs.length - 1].container,
      isScored: false,
    };
    emitted.push({ unit, at: runs[0].index });
  }

  /**
   * One would-be unit leaves the assembler. Runs a live unit owns (incremental re-scan)
   * are never emitted a second time: all of them owned → this IS the live unit. Owned
   * runs next to new ones — a comment that gained a paragraph while it was on screen,
   * a chat answer still being streamed into its <article> — are what the old unit no
   * longer describes: the whole is asked for again, which retires the owner, and taken
   * as one unit. Emitting only the new paragraph would leave it a short text with
   * nobody to join, under a chip that speaks for a post it has not read to the end.
   */
  function release(runs: Run[]): void {
    const owned = runs.reduce((n, r) => n + (r.claimed ? 1 : 0), 0);
    if (owned === runs.length) return;
    if (owned > 0 && !retake(runs.flatMap((r) => r.nodes))) return;
    emit(runs);
  }

  /** What a frame produces: the page emits as it goes, a declared scope holds (see settle). */
  function out(f: Frame, runs: Run[]): void {
    if (f.scope === null) release(runs);
    else f.held.push(runs);
  }

  /**
   * The stretch of short runs ends here — at a barrier, another section, the end of the
   * scope, or at `following`, the full paragraph that comes right after it. With fifty
   * words it stands by itself, in model-sized groups. Without them it used to be dropped,
   * and next to full paragraphs that is most of what went unjudged: a Substack article
   * lost 570 of its 2407 words that way (isolated paragraphs of 40 to 47 words between
   * full ones), a Zhihu answer the 13-word lead-in before a 57-word paragraph and the
   * 40-word close after an 82-word one. NO ORPHANS INSIDE ONE VOICE: such a text joins
   * the full paragraph standing next to it — the one before it by preference, else the
   * one after — when the two are in the same place (`compatible`, the proximity merging
   * always required) and together still fit one model window. The chip then reads ×2.
   * Nothing else may lie between them: a barrier or another voice's name row has let the
   * earlier unit go (`close`) before the orphan gets here. Returns what joins `following`.
   */
  function endGroup(f: Frame, following: Run | null): Run[] {
    const g = f.group;
    f.group = [];
    let lead: Run[] = [];
    if (g.length > 0 && wordsOf(g) >= MIN_UNIT_WORDS) {
      for (const runs of modelSized(g)) out(f, runs);
    } else if (g.length > 0) {
      const beside = (a: Run, b: Run): boolean => together(f, a.container, b.container);
      if (f.prev && beside(f.prev[f.prev.length - 1], g[0]) && joinedChars([...f.prev, ...g]) <= WINDOW_CHARS) {
        f.prev.push(...g);
      } else if (following && beside(g[g.length - 1], following) && joinedChars([...g, following]) <= WINDOW_CHARS) {
        lead = g;
      }
      // else: below the evidence floor with nobody of its voice to join — dropped (by policy).
    }
    if (f.prev) out(f, f.prev);
    f.prev = null;
    return lead;
  }

  /** End whatever the frame was reading: nothing is merged across this. */
  function close(f: Frame): void {
    endGroup(f, null);
    f.block = null;
    f.pending = null;
    f.lines = [];
    if (f.scope === null) f.live = false;
  }

  /**
   * The walk has left the scope: decide what it was. X cut a 181-word post of twelve
   * short paragraphs into three chips (×4 / ×4 / ×4) when groups still closed at the
   * floor, and a post written as [30 words][55][20][60][25] got two chips and three
   * paragraphs nobody judged — arbitrary pieces of what a reader sees as ONE thing said
   * by ONE person. So a declared scope whose own prose (nested scopes, name and action
   * rows left out as always) clears the floor and fits ONE model window is a POST: one
   * unit, every paragraph of it in document order, the full ones included. One window —
   * WINDOW_CHARS, some 300 words — is about the mean length of the texts the model was
   * trained on, and it is what it judges in a single reading.
   *
   * Barriers inside a post end nothing: a heading over a forum post, a line of hashtags
   * or a "Show more" link in the middle of a status, a row of asterisks are left out of
   * the unit, but the text on both sides of them is still the same person's. Proximity
   * still counts (standingTogether): what stands elsewhere in the card is not the post.
   *
   * Anything longer is an ARTICLE — a paper, a news story, a long answer — and keeps
   * what readers of those rely on: a chip per full paragraph, only the short ones
   * grouped. A scope the walk cannot see all of is read as one too (see wholePost).
   */
  function settle(f: Frame): void {
    conclude(f);
    f.unread = []; // nothing new came to stand beside them
  }

  /** Decide what the prose read so far in a scope was — a post or an article — and let it
   *  go. At the end of the scope (settle), and in a recognised post at a row of the card
   *  (see `short`): what comes after that row is read as a text of its own. */
  function conclude(f: Frame): void {
    close(f);
    if (f.scope === null) return;
    if (!f.partial && wordsOf(f.prose) >= MIN_UNIT_WORDS && joinedChars(f.prose) <= WINDOW_CHARS) {
      for (const runs of standingTogether(f.prose, (a, b) => together(f, a, b))) if (wordsOf(runs) >= MIN_UNIT_WORDS) release(runs);
    } else {
      // A post that has just outgrown the window while a unit still owns ALL of what it was
      // (an answer streamed paragraph by paragraph does this once): its paragraphs are
      // about to get chips of their own, so that owner goes first.
      const owned = f.prose.filter((r) => r.claimed);
      if (
        !f.partial &&
        owned.length > 1 &&
        owned.length < f.prose.length &&
        wordsOf(owned) >= MIN_UNIT_WORDS &&
        joinedChars(owned) <= WINDOW_CHARS &&
        retake(owned.flatMap((r) => r.nodes))
      ) {
        for (const r of owned) r.claimed = false;
      }
      for (const runs of f.held) release(runs);
    }
    f.prose = [];
    f.held = [];
  }

  /**
   * A label inside a recognised post stands AMONG THE TEXT when it is a sibling of one of
   * the post's paragraphs (or of the list one of its items sits in): the bold
   * `<p><b>二、后来发生的事</b></p>` in the middle of a Zhihu answer, the unpunctuated
   * three-to-seven-word <p>s between the lists of a V2EX topic. That is a pseudo-heading the
   * author wrote, and it cuts nothing.
   */
  function amongTheText(f: Frame, label: Element): boolean {
    const home = label.parentElement;
    return f.prose.some((r) => {
      const at = r.container.parentElement;
      if (at === home) return true;
      const tag = tagOf(r.container);
      return (tag === "LI" || tag === "DT" || tag === "DD") && at !== null && at.parentElement === home;
    });
  }

  /**
   * Leave every frame the walk is no longer inside. A frame that CONTAINS `scope` stays
   * open underneath: a quotation, a caption or a quoted post interrupts the author's
   * text, it does not end it — the two short paragraphs around a block quotation in a
   * news article still read as one unit, without the quotation. A frame that does not
   * contain it is settled for good (a subtree is contiguous; the walk never comes back).
   * Returns the frame of `scope` itself if it is open.
   */
  function unwindTo(scope: Element | null): Frame | null {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.scope === scope) return top;
      if (top.scope === null || (scope !== null && top.scope.contains(scope))) return null;
      settle(top);
      stack.pop();
    }
    return null;
  }

  /**
   * The frame of `scope`, opened if the walk has just entered it. A DECLARED scope inside
   * another text — a quotation, a caption, a quoted post — interrupts that text and no more
   * (unwindTo). A RECOGNISED post is a peer, one of several like it, and it begins with a
   * byline: on the bare page that byline was a name row or a link row and ended the group
   * being read, and it still has to. A chat transcript whose name rows carry an avatar has
   * every such row recognised as a "post" of its own; were it merely to interrupt, alice's
   * last message and bob's first — siblings, both short — would be read together across it.
   */
  function enter(scope: Element | null): Frame {
    let f = unwindTo(scope);
    if (!f) {
      if (stack.length > 0 && scopes.recognised(scope)) cut(stack[stack.length - 1]);
      const partial = scope !== null && !composedContains(walkRoot, scope);
      f = { scope, group: [], block: null, pending: null, lines: [], prev: null, prose: [], held: [], partial, unread: [], live: false };
      stack.push(f);
    }
    return f;
  }

  /**
   * A barrier ends the group of the scope it sits in, and whatever is nested inside that.
   * The link-dense `<cite><a>…</a></cite>` under a block quotation, the credit link of a
   * figure and a heading inside an embedded card are barriers INSIDE the embed: the
   * author's paragraphs around it are still adjacent. With no position, everything open
   * ends.
   */
  function barrier(at?: Element): void {
    if (stack.length === 0) return;
    if (!at) {
      while (stack.length > 0) settle(stack.pop() as Frame);
      return;
    }
    const f = unwindTo(scopeOf(at));
    if (f) cut(f);
  }

  /** Nothing of `f` is merged across this point of the walk. */
  function cut(f: Frame): void {
    if (f.scope === null) f.unread = []; // on the page nothing reaches across a barrier: never needed
    if (f.unread.length > 0) f.unread.push(null); // in a post it ends nothing, in an article it must keep its place
    else close(f);
  }

  /**
   * INCREMENTAL RE-SCANS. A re-scan reads the page the way a first scan would, the runs
   * live units own included — a full paragraph still ends the group before it, a line of
   * a post is still a line of that post — and `release` keeps them from being emitted
   * twice. But an owned run only matters if something NEW comes to stand beside it, and
   * nearly always nothing does: Wikipedia appends a preview card to <body> for every link
   * the pointer crosses, which re-scans a page of a thousand owned paragraphs, and reading
   * those (joining text, counting words, measuring boxes) is seven times the cost of
   * walking past them. So owned runs wait unread, in order, until a new run arrives in
   * their frame; a frame reading something new (`live`) reads them as they come.
   */
  function catchUp(f: Frame): void {
    if (f.unread.length === 0) return;
    const unread = f.unread;
    f.unread = [];
    for (const found of unread) {
      if (found === null) {
        close(f);
        continue;
      }
      const r = read(found, true);
      if (r) route(r, found.index);
    }
  }

  /**
   * The group does NOT close when it reaches the evidence floor. It used to, and one
   * voice came out in arbitrary pieces: a status of twelve short paragraphs as three
   * chips (×4 / ×4 / ×4), a list of ten items as two. The stretch is read to its end — a
   * barrier, a full paragraph, another section, the end of the scope — and divided
   * evenly then (endGroup, modelSized).
   */
  function push(f: Frame, r: Run): void {
    f.group.push(r);
    f.block = r.container;
    if (f.scope !== null) f.prose.push(r);
    if (!r.claimed) f.live = true;
  }

  /**
   * A FULL paragraph: a unit of its own, and the end of the stretch of shorts before it.
   * It is not let go at once: a short text on either side that cannot stand alone joins
   * it (endGroup), so the unit stays with the frame until what follows it is known.
   * Inside a declared scope it is held beyond that, like everything else, because a post
   * that fits one window is read whole (settle).
   */
  function full(r: Run): void {
    if (!mergeShorts) {
      release([r]); // strict per-paragraph mode: nothing is grouped, so nothing is held
      return;
    }
    const f = enter(scopeOf(r.container));
    catchUp(f);
    const lead = endGroup(f, r);
    // Inside a post a further run in the same container is the next line of this text block
    // ("Here is what I learned" after a full paragraph of an X status). On the bare page
    // that is where a forum sets "Posted by alice on March 3" under the message.
    f.block = f.scope !== null ? r.container : null;
    f.pending = null;
    f.lines = [];
    f.prev = [...lead, r];
    if (f.scope !== null) f.prose.push(r);
    f.live = f.scope === null ? f.prev.some((x) => !x.claimed) : f.live || !r.claimed;
  }

  /**
   * A SHORT run. Whether it takes part in merging depends on what it IS, not on how
   * long it is: a flat eight-word floor dropped a whole post written one short
   * sentence per line (LinkedIn, X — exactly the text people want checked), and, being
   * transparent, let a thread's short comments merge ACROSS the "alice · 2h" and
   * "Reply · Share" rows between them — fifty words borrowed from other authors.
   */
  function short(r: Run): void {
    const f = enter(scopeOf(r.container));
    catchUp(f);
    if (!r.claimed && f.scope !== null) f.live = true;
    const punctuated = endsLikeProse(r.text);

    if (f.block === r.container) {
      // The next LINE of the text block this group is reading (BR- or blank-line-
      // separated): the same author by construction, whatever the punctuation. One to
      // three unpunctuated words are skipped, not joined — that is where a name or
      // "2h ago" sits when a site sets it in the message's own block.
      if (!punctuated && wordShape(r.text).letterWords < MIN_LINE_WORDS) return;
      f.lines = [];
      if (f.pending) {
        const first = f.pending;
        f.pending = null;
        push(f, first);
      }
      push(f, r);
      return;
    }

    // A block of its own is PROSE when it reads like a sentence ("I agree completely.",
    // or the lead-in "Can also be written as:" before a code sample) or is long enough
    // to be one without the full stop (most bullet items). Either way it must be running
    // text: "Alice Moreau, Ph.D." and "SIGN UP TODAY!" are not, and neither is "alice:".
    const shape = wordShape(r.text);
    const prose =
      shape.running &&
      (((punctuated || endsInColon(r.text)) && shape.letterWords >= MIN_SENTENCE_WORDS) ||
        shape.letterWords >= MIN_MERGE_WORDS);
    // What the text stood beside last: the open group, else the full paragraph before it.
    const last = f.group.length > 0 ? f.group[f.group.length - 1] : f.prev ? f.prev[f.prev.length - 1] : null;
    // Reads on without a stop at its end: a line of verse, if it is text at all.
    const unstopped = !punctuated && !endsInColon(r.text);
    if (prose) {
      const lines = f.lines;
      f.lines = [];
      f.pending = null;
      if (last && !together(f, last.container, r.container)) close(f); // another section
      // The short lines held before it are lines of the same verse (see below).
      if (unstopped && lines.length > 0 && sameBody(lines[lines.length - 1].container, r.container)) for (const line of lines) push(f, line);
      push(f, r);
      return;
    }

    // "Yes." / "Me too!" / "Hodges 1983, p. 208." — punctuated, but too little to be
    // evidence or to mean anything about who is speaking: skipped without consequence.
    if (punctuated) return;

    // A LABEL: an unpunctuated handful of words in a block of its own — a username, a
    // timestamp, "Reply · Share", a pseudo-heading made of a div. On the bare page —
    // div-soup chat transcripts, hand-rolled comment widgets, nothing semantic anywhere —
    // a label standing WHERE THE TEXT STANDS (a sibling or one-level cousin of the
    // paragraph before it, the same proximity merging itself requires) is the only thing
    // between two voices, so it ends the open group. Everything else stays transparent:
    //   · inside a declared scope (one post, one quotation) it cannot be the next
    //     author's name row — the bold `**Title**` lines of a listicle in an <article>
    //     do not cut one author's text to pieces;
    //   · in list markup it is an item or a term ("Sea salt", a glossary <dt>);
    //   · buried deeper than the text, it is a widget's crumb — the "Play" link of the
    //     live samples between two paragraphs on MDN, which has no <article>.
    //
    // A RECOGNISED post is a card of several boxes, and only one of them is the text. Steam
    // sets "26 people found this review helpful / 3 people found this review funny" in a box
    // above "Recommended", "1,204 hrs on record" and "Posted: 12 September", and the review
    // under those; with every label transparent the two counter lines were read as the
    // opening lines of the review, and one 333-word review outgrew its window by them. So
    // there a label is transparent only AMONG THE TEXT. Standing where the text stands
    // without being one of its paragraphs it is a row of the card: what was read so far is
    // concluded, exactly where the bare page would have ended the group, and the post rule
    // does not reach across it.
    const tag = tagOf(r.container);
    if (tag !== "LI" && tag !== "DT" && last && compatible(last.container, r.container)) {
      if (f.scope === null) close(f);
      else if (scopes.recognised(f.scope) && !amongTheText(f, r.container)) conclude(f);
    }
    // LINES OF VERSE. A Zhihu answer written one line per <p> — 4, 6, 13, 9, 13 and 7
    // words, not one of them ending in punctuation — got nothing: only the three lines long
    // enough to be prose without a full stop joined (35 words), and each shorter one was a
    // "label". Inside a post they are all the same person's text. What tells such a line
    // from the pseudo-heading that stays out (V2EX's "What we tried first" before a list,
    // Zhihu's bold one-liner between two paragraphs) is its company: a heading introduces
    // sentences, a line of verse stands beside other lines that read on without a stop, in
    // the SAME BODY — sibling blocks of one tag and one class. So a short line is held, and
    // counted only once an unstopped prose line of its body stands next to it, before or
    // after. Two counter rows above a punctuated review are never that, and a row of the
    // card has concluded what was read (above) before it gets here. List markup keeps its
    // own rule — an item is prose from eight words, "Sea salt" and "2 spoons of brown sugar"
    // are skipped: the short bullets of Google's terms of service and of an sspai article
    // joined their longer neighbours as "verse", which no reader would call them.
    const item = tag === "LI" || tag === "DT" || tag === "DD";
    if (f.scope !== null && !item && shape.running && shape.letterWords >= MIN_LINE_WORDS) {
      const before = f.group.length > 0 ? f.group[f.group.length - 1] : null;
      if (before && !endsLikeProse(before.text) && !endsInColon(before.text) && sameBody(before.container, r.container)) {
        push(f, r);
        return;
      }
      const held = f.lines;
      f.lines = held.length > 0 && sameBody(held[held.length - 1].container, r.container) ? [...held, r] : [r];
    }
    if (f.group.length === 0 && shape.letterWords >= MIN_LINE_WORDS) {
      // "I quit my job" — the unpunctuated first line of a post. It opens the group
      // only if the next run turns out to be a further line of the same block.
      f.pending = r;
      f.block = r.container;
      if (!r.claimed) f.live = true;
    }
  }

  /** What a run is decides where it goes. `index` is its position in the walk. */
  function route(r: Run, index: number): void {
    r.index = index;
    if (!hasLetters(r.text)) {
      // "* * *" and rule-like separators are section dividers → barrier. Other
      // letterless runs (an equation number "(3)", a page number, a lone "12") are
      // transparent: not prose, but not a boundary either.
      if (isSeparatorRun(r.text)) barrier(r.container);
      return;
    }
    if (symbolNoiseRatio(r.text) > 0.2 || (r.preserved && hasColumnGaps(r.raw))) {
      // ASCII diagrams / table rules / column-layout headers ("RFC 768   J.
      // Postel"): machine layout, not prose — barrier, never merged. The
      // column-gap check applies ONLY to preserved-whitespace runs: in normal
      // HTML, interior space runs collapse invisibly and must not drop prose.
      barrier(r.container);
      return;
    }
    if (r.linkRatio > MAX_LINK_RATIO || looksLikeNameList(r.text)) {
      // Nav/menu/story-title lists and author/citation strings: not prose AND a
      // section boundary.
      barrier(r.container);
      return;
    }
    if (r.words >= MIN_UNIT_WORDS) full(r);
    else if (mergeShorts) short(r); // strict per-paragraph mode: sub-floor runs skipped
  }

  return {
    barrier,

    run(r: Run): void {
      route(r, runIndex++);
    },

    owned(found: Found): void {
      const index = runIndex++;
      if (!mergeShorts) return; // strict per-paragraph mode: nothing stands beside anything
      const f = enter(scopeOf(found.container));
      if (!f.live) {
        f.unread.push({ ...found, index });
        return;
      }
      const r = read(found, true);
      if (r) route(r, index);
    },

    finish(): Unit[] {
      barrier();
      emitted.sort((a, b) => a.at - b.at);
      return emitted.map(({ unit }) => {
        const seq = _unitSeq++;
        unit.id = `u_${seq.toString(36)}`;
        unit.order = seq;
        return unit;
      });
    },
  };
}
