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
import { NO_SCORE_TAGS, INLINE_FALLBACK_TAGS, isHeading } from "./tags";
import { isBoilerplate } from "./boilerplate";
import {
  createStyleCache,
  flowClassOf,
  isInlineDisplay,
  isVisuallyHiddenInline,
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
  MIN_UNIT_WORDS,
  MIN_MERGE_WORDS,
  MAX_UNIT_TEXT_CHARS,
} from "./text";
import { MARK_ATTR } from "../types";

/** One assembled inline run (== one visual paragraph) awaiting unit assembly. */
interface Run {
  nodes: Text[];
  container: Element;
  text: string;
  /** Pre-collapse text — interior column gaps only survive here. */
  raw: string;
  words: number;
  linkRatio: number;
}

export interface CollectOptions {
  /**
   * Ownership filter for incremental re-scans. "skip" → this exact run is already
   * owned by a live unit; "take" → process it (the orchestrator invalidates any
   * stale owner before answering "take").
   */
  claimFilter?: (nodes: Text[]) => "take" | "skip";
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
  const asm = createAssembler();

  // ---- run accumulation ------------------------------------------------------------

  let cur: Text[] = [];
  let curContainer: Element | null = null;

  function closeRun(): void {
    if (cur.length === 0) return;
    const nodes = cur;
    const container = curContainer as Element;
    cur = [];
    curContainer = null;
    processRun(nodes, container);
  }

  function processRun(nodes: Text[], container: Element): void {
    if (opts.claimFilter && opts.claimFilter(nodes) === "skip") return;
    if (!rects.get(container)) return; // zero-size container → invisible text
    const raw = extractPartText(nodes);
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    asm.run({
      nodes,
      container,
      text,
      raw,
      words: countWords(text),
      linkRatio: linkTextRatio(nodes),
    });
  }

  // ---- traversal ---------------------------------------------------------------------

  interface Ctx {
    container: Element; // nearest block-laid-out ancestor
    hidden: boolean; // computed visibility: hidden/collapse
    preserves: boolean; // computed white-space preserves newlines
  }

  function visitChildren(el: Element, ctx: Ctx): void {
    for (const child of composedChildren(el)) visit(child, ctx);
  }

  function visit(node: Node, ctx: Ctx): void {
    if (node.nodeType === Node.TEXT_NODE) {
      visitText(node as Text, ctx);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.nodeName;

    if (tag === "BR") {
      closeRun(); // hard line/paragraph break — merge logic rejoins short halves
      return;
    }
    if (tag === "WBR") return; // word-break OPPORTUNITY — must not split the word
    if (NO_SCORE_TAGS.has(tag)) {
      closeRun();
      return;
    }
    // <pre> is machine text — except when the whole document IS plain text
    // (Chrome's text viewer wraps .txt/.log/.md files in body > pre).
    if (tag === "PRE" && !plainTextDoc) {
      closeRun();
      return;
    }
    if (el.hasAttribute(MARK_ATTR)) return; // our own UI — transparent, mid-flow safe
    if (el.getAttribute("translate") === "no" || el.classList.contains("notranslate")) {
      closeRun();
      return;
    }
    if ((el as HTMLElement).isContentEditable) {
      closeRun(); // live editors (comment boxes, docs) are never scored
      return;
    }
    if (el.getAttribute("aria-hidden") === "true") {
      closeRun();
      return;
    }
    if (isBoilerplate(el)) {
      closeRun();
      asm.barrier(); // page chrome separates sections — no merging across it
      return;
    }

    const cs = styles.get(el);
    const flow = flowClassOf(el, cs);
    if (flow === "hidden") {
      closeRun();
      return;
    }
    if (cs && (cs.opacity === "0" || (cs as any).contentVisibility === "hidden")) {
      closeRun();
      return;
    }

    const hidden = cs ? cs.visibility === "hidden" || cs.visibility === "collapse" : ctx.hidden;
    const preserves = cs ? preservesNewlines(cs) : ctx.preserves;

    if (flow === "contents") {
      visitChildren(el, { container: ctx.container, hidden, preserves });
      return;
    }

    if (flow === "inline") {
      // Visually-absent inline content (sr-only labels, "(opens in new tab)") is
      // skipped WITHOUT closing the run — it sits mid-sentence.
      if (cs && isVisuallyHiddenInline(cs)) return;
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
    if (s.trim().length === 0) return;
    cur.push(tn);
    curContainer ??= ctx.container;
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
        if (s.trim()) {
          cur.push(node);
          curContainer ??= ctx.container;
        }
        return;
      }
      if (m.index > 0) {
        const rest = node.splitText(m.index); // node keeps the paragraph text
        if ((node.textContent ?? "").trim()) {
          cur.push(node);
          curContainer ??= ctx.container;
        }
        closeRun();
        node = rest; // rest begins with the gap → next iteration hits index 0
        continue;
      }
      // Gap at position 0: consume it (and any following blank space) and move on.
      let end = m.index + m[0].length;
      while (end < s.length && /\s/.test(s[end])) end++;
      const rest = node.splitText(end);
      closeRun();
      node = rest;
    }
  }

  function hasBlockChildren(el: Element): boolean {
    for (const c of el.children) {
      const d = styles.get(c)?.display ?? "";
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
function composedChildren(el: Element): Node[] {
  const sr = el.shadowRoot;
  if (sr) return Array.from(sr.childNodes);
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
    const tag = el.nodeName;
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

function createAssembler(): Assembler {
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
        // "* * *" separators, number rows: visual dividers → barrier.
        flushGroup();
        lastMergedUnit = null;
        return;
      }
      if (symbolNoiseRatio(r.text) > 0.2 || hasColumnGaps(r.raw)) {
        // ASCII diagrams / table rules / column-layout headers ("RFC 768   J.
        // Postel"): machine layout, not prose — barrier, never merged.
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
