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
//   asm   — runs ≥ MIN_UNIT_WORDS become units directly. Consecutive SHORT runs
//           (chat messages, list items, comment threads, BR-separated prose)
//           MERGE into one multi-part unit until the evidence floor is met —
//           short text gets covered instead of silently skipped. Headings,
//           boilerplate, link-dense and letterless runs are barriers no merge
//           may cross.
//
// v1's hard 1000-char mid-paragraph split is gone: a long paragraph is ONE unit
// end-to-end (the HF-abstract "underline stops mid-paragraph" bug); only the text
// sent to the backend is capped, at a sentence boundary (lib/dom/text.ts).
import { NO_SCORE_TAGS, INLINE_FALLBACK_TAGS, isHeading, tagOf } from "./tags";
import { isBoilerplate } from "./boilerplate";
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
  MIN_UNIT_WORDS,
  MIN_MERGE_WORDS,
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
      asm.barrier();
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

    // Exclusions: never descend, never score. Whether they BREAK the sentence
    // depends on layout — inline exclusions (icons, <img>, MathJax spans, sr-only,
    // aria-hidden decorations) sit mid-sentence and are skipped silently; block
    // exclusions occupy their own space and close the run.
    const boiler = isBoilerplate(el);
    const excluded =
      boiler ||
      NO_SCORE_TAGS.has(tag) ||
      (tag === "PRE" && !plainTextDoc) || // Chrome's text viewer wraps .txt in body>pre
      el.getAttribute("translate") === "no" ||
      el.classList.contains("notranslate") ||
      (el as HTMLElement).isContentEditable ||
      el.getAttribute("aria-hidden") === "true" ||
      (cs !== null && (cs.opacity === "0" || (cs as any).contentVisibility === "hidden"));
    if (excluded) {
      if (flow !== "inline" && flow !== "contents") closeRun();
      if (boiler) asm.barrier(); // page chrome separates sections — no merging across
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
      asm.barrier(); // topic boundary; headings themselves are never scored
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
    if (el.getAttribute("translate") === "no" || el.classList.contains("notranslate")) return true;
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
  barrier(): void;
  finish(): Unit[];
}

/**
 * Merge compatibility: same container (BR-split halves), sibling containers (chat
 * messages, <li>s), or one-level cousins (<li><p> structures). Anything further
 * apart is a different section and must not merge.
 */
function compatible(a: Element, b: Element): boolean {
  if (a === b) return true;
  const ap = a.parentElement;
  const bp = b.parentElement;
  if (ap && ap === bp) return true;
  if (ap && bp && (ap === bp.parentElement || bp === ap.parentElement)) return true;
  return false;
}

function createAssembler(mergeShorts: boolean): Assembler {
  const units: Unit[] = [];
  let group: Run[] = [];
  let groupWords = 0;
  /** Last unit emitted via the merge path — may absorb a trailing short orphan. */
  let lastMergedUnit: Unit | null = null;

  function emit(runs: Run[]): Unit {
    const parts: UnitPart[] = runs.map((r) => ({ nodes: r.nodes, container: r.container }));
    const text = runs.map((r) => r.text).join("\n\n").slice(0, MAX_UNIT_TEXT_CHARS);
    const seq = _unitSeq++;
    const unit: Unit = {
      id: `u_${seq.toString(36)}`,
      parts,
      text,
      wordCount: runs.reduce((n, r) => n + r.words, 0),
      formulas: runs.reduce((n, r) => n + r.formulas, 0),
      order: seq,
      topElement: runs[0].container,
      container: runs[runs.length - 1].container,
      isScored: false,
    };
    units.push(unit);
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

  function flushGroup(): void {
    if (group.length === 0) return;
    const g = group;
    const words = groupWords;
    group = [];
    groupWords = 0;
    if (words >= MIN_UNIT_WORDS) {
      lastMergedUnit = emit(g);
    } else if (
      lastMergedUnit &&
      compatible(lastMergedUnit.container, g[0].container)
    ) {
      extend(lastMergedUnit, g); // trailing orphan joins the previous merged unit
    }
    // else: below the evidence floor with nothing to join — dropped (by policy).
  }

  return {
    barrier(): void {
      flushGroup();
      lastMergedUnit = null; // nothing merges or extends across a barrier
    },

    run(r: Run): void {
      if (!hasLetters(r.text)) {
        // "* * *" and rule-like separators are section dividers → barrier. Other
        // letterless runs (an equation number "(3)", a page number, a lone "12") are
        // transparent: not prose, but not a boundary either.
        if (isSeparatorRun(r.text)) {
          flushGroup();
          lastMergedUnit = null;
        }
        return;
      }
      if (symbolNoiseRatio(r.text) > 0.2 || (r.preserved && hasColumnGaps(r.raw))) {
        // ASCII diagrams / table rules / column-layout headers ("RFC 768   J.
        // Postel"): machine layout, not prose — barrier, never merged. The
        // column-gap check applies ONLY to preserved-whitespace runs: in normal
        // HTML, interior space runs collapse invisibly and must not drop prose.
        flushGroup();
        lastMergedUnit = null;
        return;
      }
      if (r.linkRatio > MAX_LINK_RATIO) {
        // Nav/menu/story-title lists: not prose AND a section boundary.
        flushGroup();
        lastMergedUnit = null;
        return;
      }
      if (r.words >= MIN_UNIT_WORDS) {
        flushGroup();
        emit([r]); // full paragraphs stay pure — they never absorb orphans
        lastMergedUnit = null;
        return;
      }
      if (!mergeShorts) return; // strict per-paragraph mode: sub-floor runs skipped
      if (r.words < MIN_MERGE_WORDS) return; // bylines/timestamps — transparent
      if (group.length > 0 && !compatible(group[group.length - 1].container, r.container)) {
        flushGroup();
        lastMergedUnit = null; // container context changed
      }
      group.push(r);
      groupWords += r.words;
      if (groupWords >= MIN_UNIT_WORDS) flushGroup();
    },

    finish(): Unit[] {
      flushGroup();
      return units;
    },
  };
}
