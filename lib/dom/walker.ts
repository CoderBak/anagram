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
//           text around it without ending it. A declared scope whose own prose fits ONE
//           window is a POST and becomes one unit whole, its full paragraphs included; a
//           longer one is an article and keeps a unit per full paragraph. What a short
//           run IS decides its part: a further line of the block being read and a
//           sentence join, an unpunctuated name / time / action row never does — and on
//           a page with no semantic markup that row is what separates two voices. Text
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
  clipsOwnText,
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

  function pushNode(tn: Text, ctx: Ctx): void {
    if (cur.length === 0) {
      curContainer = ctx.container;
      curPreserved = ctx.preserves;
    }
    cur.push(tn);
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
      return;
    }
    const nodes = cur;
    const container = curContainer as Element;
    const preserved = curPreserved;
    cur = [];
    curContainer = null;
    curPreserved = false;
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
    if (run) asm.run(run);
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
      (tag === "PRE" && !plainTextDoc) || // Chrome's text viewer wraps .txt in body>pre
      isNoTranslate(el) ||
      (el as HTMLElement).isContentEditable ||
      el.getAttribute("aria-hidden") === "true" ||
      // A box that clips its own text is not read until the reader expands it. It takes
      // space, so it closes the run — but it is no barrier: the paragraphs around a
      // clamped teaser still read as one text.
      (cs !== null && clipsOwnText(el, cs)) ||
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
    if (ctx.preserves && PARA_GAP_RE.test(s)) {
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
   * Preserved-whitespace text (plain-text docs, pre-wrap chat transcripts): blank
   * lines are paragraph gaps. The node is split ONCE at each gap (idempotent — the
   * resulting chunk nodes contain no further gaps) so parts stay whole-node spans.
   */
  function splitPreservedText(tn: Text, ctx: Ctx): void {
    let node: Text = tn;
    for (;;) {
      const s = node.textContent ?? "";
      const m = PARA_GAP_RE.exec(s);
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
  const styles = createStyleCache();
  let el: Element | null = start;
  while (el) {
    const tag = tagOf(el);
    if (NO_SCORE_TAGS.has(tag)) return true;
    if (tag === "PRE" && !plainTextDoc) return true;
    if (el.hasAttribute(MARK_ATTR)) return true;
    if (isNoTranslate(el)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (isBoilerplate(el)) return true;
    // A re-scan started INSIDE a clipped box (LinkedIn appends to the post it is
    // hiding) must not score what the reader still cannot see.
    const cs = styles.get(el);
    if (cs !== null && clipsOwnText(el, cs)) return true;
    el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
  }
  return false;
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
 * VOICE BOUNDARIES. Proximity alone merged two sibling <article>s by different
 * authors into one verdict describing nobody, and an author with the person they
 * quote. Every run therefore belongs to a SCOPE — the nearest ancestor-or-self of
 * its container that the markup declares to be one voice — and runs merge only
 * inside the same scope (no match: the page itself is the scope).
 *
 *   article, [role=article] — one post: X and Mastodon statuses, WordPress comments
 *                             (`ol.comment-list > li > article`), Discourse and
 *                             XenForo posts, LinkedIn feed cards; Reddit puts
 *                             role=article on each comment's <details>.
 *   blockquote              — the person being quoted, not the author quoting them.
 *   figure                  — a caption or a pull quote set into the text; on news
 *                             sites the caption is the picture desk's, not the writer's.
 *   [role=link]             — a whole card that is one link: the QUOTED post on X
 *                             sits inside the quoting post's <article>, in a
 *                             `div[role=link]`; Bluesky has no <article> at all, every
 *                             feed item and every quote embed is such a div. (An inline
 *                             `<span role=link>` never contains a run's container.)
 *
 * Not <li>: bullet lists inside one author's text are what merging is for. Not
 * <td>: forums laid out with tables (Hacker News) keep each comment several levels
 * deep in a cell of its own, which proximity already separates, while a prose table
 * is one author's. One closest() per run; shadow hosts are climbed through.
 */
const VOICE_SCOPE_SELECTOR = 'article,[role="article"],blockquote,figure,[role="link"]';

function scopeOf(el: Element): Element | null {
  for (let cur: Element | null = el; cur; ) {
    const hit = cur.closest(VOICE_SCOPE_SELECTOR);
    if (hit) return hit;
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
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
  const scope = scopeOf(root);
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
function standingTogether(runs: Run[]): Run[][] {
  const places: Run[][] = [];
  for (const r of runs) {
    const home = places.find((place) => place.some((other) => compatible(other.container, r.container)));
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
      const beside = (a: Run, b: Run): boolean => compatible(a.container, b.container);
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
    close(f);
    f.unread = []; // nothing new came to stand beside them
    if (f.scope === null) return;
    if (!f.partial && wordsOf(f.prose) >= MIN_UNIT_WORDS && joinedChars(f.prose) <= WINDOW_CHARS) {
      for (const runs of standingTogether(f.prose)) if (wordsOf(runs) >= MIN_UNIT_WORDS) release(runs);
      return;
    }
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

  function enter(scope: Element | null): Frame {
    let f = unwindTo(scope);
    if (!f) {
      const partial = scope !== null && !composedContains(walkRoot, scope);
      f = { scope, group: [], block: null, pending: null, prev: null, prose: [], held: [], partial, unread: [], live: false };
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
    if (!f) return;
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
    if (prose) {
      f.pending = null;
      if (last && !compatible(last.container, r.container)) close(f); // another section
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
    const tag = tagOf(r.container);
    if (f.scope === null && tag !== "LI" && tag !== "DT" && last && compatible(last.container, r.container)) {
      close(f);
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
