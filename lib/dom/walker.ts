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
//   asm   — runs ≥ MIN_UNIT_WORDS become units directly. Consecutive SHORT runs of
//           ONE VOICE (the lines of a post, list items, the short paragraphs of an
//           article or of one comment) MERGE into one multi-part unit until the
//           evidence floor is met — short text gets covered instead of silently
//           skipped. A merge never crosses a voice boundary to get there: every run
//           has a SCOPE (its post, quotation, figure or quoted card; else the page)
//           and merges only within it, an embedded scope interrupting the text
//           around it without ending it. What a short run IS decides its part: a
//           further line of the block being read and a sentence join, an
//           unpunctuated name / time / action row never does — and on a page with no
//           semantic markup that row is what separates two voices. Text too short
//           on its own gets no unit. Headings, boilerplate, link-dense runs, name
//           lists, ASCII art and separator rules are barriers no merge may cross.
//
// v1's hard 1000-char mid-paragraph split is gone: a long paragraph is ONE unit
// end-to-end (the HF-abstract "underline stops mid-paragraph" bug); only the text
// sent to the backend is capped, at a sentence boundary (lib/dom/text.ts).
import { NO_SCORE_TAGS, INLINE_FALLBACK_TAGS, isHeading, tagOf } from "./tags";
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
}

export interface CollectOptions {
  /**
   * Ownership filter for incremental re-scans. "skip" → this exact run is already
   * owned by a live unit; "take" → process it (the orchestrator invalidates any
   * stale owner before answering "take").
   */
  claimFilter?: (nodes: Text[]) => "take" | "skip";
  /**
   * Group sub-floor paragraphs with compatible neighbors until the evidence floor
   * is met (default). False = strict per-paragraph mode: short runs are skipped.
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
  const asm = createAssembler(opts.mergeShorts ?? true);

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

  function processRun(nodes: Text[], container: Element, preserved: boolean, formulas: number): void {
    if (opts.claimFilter && opts.claimFilter(nodes) === "skip") {
      // An existing rendered unit sits here — new shorts on either side must not
      // merge ACROSS it (they are not adjacent prose).
      asm.barrier(container);
      return;
    }
    if (!rects.get(container)) return; // zero-size container → invisible text
    const raw = extractPartText(nodes);
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    asm.run({
      nodes,
      container,
      text,
      raw,
      preserved,
      words: countWords(text),
      linkRatio: linkTextRatio(nodes),
      formulas,
      index: 0,
    });
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
    if (isHeading(el)) {
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

  const startEl = rootEl ?? document.body;
  if (!startEl) return [];
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
    if (tag === "PRE" && !plainTextDoc) return true;
    if (el.hasAttribute(MARK_ATTR)) return true;
    if (isNoTranslate(el)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (isBoilerplate(el)) return true;
    el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
  }
  return false;
}

// ---- unit assembly ---------------------------------------------------------------

interface Assembler {
  run(r: Run): void;
  /** Nothing merges or extends across this point. `at` — the element the barrier
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
 * is one author's. One closest() per short run; shadow hosts are climbed through.
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

/** The merge state of one scope. Scopes nest (a quotation inside a post inside the
 *  page), so the assembler keeps a stack of these. */
interface Frame {
  /** The voice boundary element; null = the page itself. */
  scope: Element | null;
  group: Run[];
  words: number;
  /** Last unit emitted via the merge path — may absorb a trailing short orphan. */
  lastMerged: Unit | null;
  /** Container of the line the group read last (or of `pending`): a further run in
   *  the SAME container is the next line of one text block. */
  block: Element | null;
  /** An unpunctuated first line that could not open a group by itself. */
  pending: Run | null;
}

function createAssembler(mergeShorts: boolean): Assembler {
  /** Emitted units with the walk index of their first run — scopes interleave, so
   *  units complete out of document order and are sorted once at the end. */
  const emitted: { unit: Unit; at: number }[] = [];
  const stack: Frame[] = [];
  let runIndex = 0;

  function emit(runs: Run[]): Unit {
    const parts: UnitPart[] = runs.map((r) => ({ nodes: r.nodes, container: r.container }));
    const text = runs.map((r) => r.text).join("\n\n").slice(0, MAX_UNIT_TEXT_CHARS);
    const unit: Unit = {
      id: "",
      parts,
      text,
      wordCount: runs.reduce((n, r) => n + r.words, 0),
      formulas: runs.reduce((n, r) => n + r.formulas, 0),
      order: 0,
      topElement: runs[0].container,
      container: runs[runs.length - 1].container,
      isScored: false,
    };
    emitted.push({ unit, at: runs[0].index });
    return unit;
  }

  function extend(unit: Unit, runs: Run[]): void {
    for (const r of runs) unit.parts.push({ nodes: r.nodes, container: r.container });
    unit.text = (unit.text + "\n\n" + runs.map((r) => r.text).join("\n\n")).slice(
      0,
      MAX_UNIT_TEXT_CHARS,
    );
    unit.wordCount += runs.reduce((n, r) => n + r.words, 0);
    unit.formulas += runs.reduce((n, r) => n + r.formulas, 0);
    unit.container = runs[runs.length - 1].container;
  }

  function flushGroup(f: Frame): void {
    if (f.group.length === 0) return;
    const g = f.group;
    const words = f.words;
    f.group = [];
    f.words = 0;
    if (words >= MIN_UNIT_WORDS) {
      f.lastMerged = emit(g);
    } else if (f.lastMerged && compatible(f.lastMerged.container, g[0].container)) {
      extend(f.lastMerged, g); // trailing orphan joins the previous merged unit
    }
    // else: below the evidence floor with nothing to join — dropped (by policy).
  }

  /** End whatever the frame was reading: nothing merges or extends across this. */
  function close(f: Frame): void {
    flushGroup(f);
    f.lastMerged = null;
    f.block = null;
    f.pending = null;
  }

  /**
   * Leave every frame the walk is no longer inside. A frame that CONTAINS `scope` stays
   * open underneath: a quotation, a caption or a quoted post interrupts the author's
   * text, it does not end it — the two short paragraphs around a block quotation in a
   * news article still read as one unit, without the quotation. A frame that does not
   * contain it is closed for good (a subtree is contiguous; the walk never comes back).
   * Returns the frame of `scope` itself if it is open.
   */
  function unwindTo(scope: Element | null): Frame | null {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.scope === scope) return top;
      if (top.scope === null || (scope !== null && top.scope.contains(scope))) return null;
      close(top);
      stack.pop();
    }
    return null;
  }

  function enter(scope: Element | null): Frame {
    let f = unwindTo(scope);
    if (!f) {
      f = { scope, group: [], words: 0, lastMerged: null, block: null, pending: null };
      stack.push(f);
    }
    return f;
  }

  /**
   * A barrier ends the scope it sits in, and whatever is nested inside that. The link-
   * dense `<cite><a>…</a></cite>` under a block quotation, the credit link of a figure
   * and a heading inside an embedded card are barriers INSIDE the embed: the author's
   * paragraphs around it are still adjacent. With no position, everything open ends.
   */
  function barrier(at?: Element): void {
    if (stack.length === 0) return;
    if (!at) {
      while (stack.length > 0) close(stack.pop() as Frame);
      return;
    }
    const f = unwindTo(scopeOf(at));
    if (f) close(f);
  }

  function push(f: Frame, r: Run): void {
    f.group.push(r);
    f.words += r.words;
    f.block = r.container;
    if (f.words >= MIN_UNIT_WORDS) flushGroup(f);
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
    if (prose) {
      f.pending = null;
      const last = f.group[f.group.length - 1];
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
    const before = f.group.length > 0 ? f.group[f.group.length - 1].container : f.lastMerged?.container;
    if (f.scope === null && tag !== "LI" && tag !== "DT" && before && compatible(before, r.container)) {
      close(f);
    }
    if (f.group.length === 0 && shape.letterWords >= MIN_LINE_WORDS) {
      // "I quit my job" — the unpunctuated first line of a post. It opens the group
      // only if the next run turns out to be a further line of the same block.
      f.pending = r;
      f.block = r.container;
    }
  }

  return {
    barrier,

    run(r: Run): void {
      r.index = runIndex++;
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
      if (r.words >= MIN_UNIT_WORDS) {
        barrier(r.container);
        emit([r]); // full paragraphs stay pure — they never absorb orphans
        return;
      }
      if (mergeShorts) short(r); // strict per-paragraph mode: sub-floor runs skipped
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
