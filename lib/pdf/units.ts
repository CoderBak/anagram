// lib/pdf/units.ts — the document's paragraphs as scoring Units.
//
// On a web page the units come from a DOM walk: the walker finds runs of text nodes and
// decides which of them are prose. A PDF has no such structure — the page is glyphs at
// coordinates — so the paragraphs come from the reconstruction (lib/pdf/reflow.ts) and
// the DOM only says WHERE they are: each block's source runs name a page and an item, and
// each item has a span in that page's text layer with the document's own text node in it.
//
// The units this builds are ordinary Units. That is the whole point: the orchestrator
// schedules them by visibility, prefetches them, retires them, marks them and chips them
// exactly as it does a web page's, because from where it stands there is no difference.
// Two things are peculiar to them and both are declared rather than assumed:
//
//  - their TEXT is the reconstruction, not the concatenation of their nodes (hyphens
//    mended, running heads dropped, two pages sewn together), so `textFixed` tells the
//    orchestrator not to try to derive it back; and
//  - their PARTS are pieces of a page — one per contiguous stretch of a paragraph on one
//    page and in one column — not paragraphs of one voice, so how many PARAGRAPHS a unit
//    reads is stated outright (`Unit.paragraphs`) instead of being counted off the parts.
//
// SHORT PARAGRAPHS ARE READ TOO. A paragraph under the evidence floor used to be dropped
// here, which on a page the walker would never do: there short neighbours of one voice are
// read together in window-sized groups. The rules for that are not the walk's own, so they
// were taken out of it (lib/plan/group.ts) and this calls them with the same floor, the
// same window and the same even division. What a PDF must supply instead of the markup is
// what stands beside what, and the reconstruction knows it: nothing is read across a
// heading, a caption, a footnote, the front matter, a table row, a line of author names or
// a column break, and only consecutive body paragraphs are ever read together. A grouped
// unit is a `textFixed` unit like the others, carrying every part's provenance, so the
// marks land on all of them and the chip sits after the last and says ×N.
import {
  countWords,
  hasLetters,
  isSeparatorRun,
  looksLikeNameList,
  shortRole,
  symbolNoiseRatio,
  MAX_UNIT_TEXT_CHARS,
  MIN_UNIT_WORDS,
  type Unit,
  type UnitPart,
} from "../dom/text";
import { groupBlocks, type BlockRole, type PlanBlock } from "../plan/group";
import type { ReflowBlock, SourceRun } from "./reflow";

/** A stretch of a unit's text: offsets into `unit.text`, end exclusive. */
export interface TextSpan {
  start: number;
  end: number;
}

/** What one page contributes: pdf.js's span per text run, and the layer they live in. */
export interface PdfPageSpans {
  /** The page's text layer — the block the spans are laid out in. */
  layer: Element;
  /** One entry per item of the page's text runs, in that order; undefined where pdf.js
   *  made no span (past its own cap of 100 000). */
  spans: (HTMLElement | undefined)[];
}

/** The live document, as the reader hands it to the orchestrator and to the marks. */
export interface PdfUnitSource {
  /** The reconstruction changed (more pages were read): use these blocks from now on. */
  setBlocks(blocks: ReflowBlock[]): void;
  /** A page's text layer is built and its spans are known. */
  setPage(n: number, page: PdfPageSpans): void;
  /** Retire a recycled upstream text layer. */
  removePage(n: number): void;
  /**
   * The document's units, as `OrchestratorOptions.collect` asks for them: everything a
   * live unit already owns exactly is left alone, and the rest comes back fresh.
   * `mergeShorts` is the reader's own setting, exactly as the walker takes it: false is
   * strict per-paragraph mode, in which a paragraph under the floor is read by nobody.
   */
  collect(claim: (nodes: Text[]) => "take" | "skip", mergeShorts?: boolean): Unit[];
  /**
   * Ranges over the page's own glyphs for each of `spans` — what lib/render/highlight.ts
   * paints instead of re-deriving the text from the nodes, which for a PDF never matches.
   */
  ranges(unit: Unit, spans: readonly TextSpan[]): Range[][] | null;
}

/**
 * One unit-to-be, ready to be handed out. The unit itself is MINTED on each collect
 * rather than kept, because a unit carries run state (its id, whether it was scored) and a
 * rescan drops all of that: handing the same object back would give the orchestrator a
 * paragraph that already believes it has a verdict.
 */
interface Blueprint {
  parts: UnitPart[];
  text: string;
  words: number;
  /** How many of the document's paragraphs were read together here. */
  paragraphs: number;
  order: number;
  topElement: Element;
  container: Element;
  /** The runs the text is made of, and the text node each of them lives in. */
  runs: SourceRun[];
  nodes: Text[];
  /** The id of the unit last minted from this, so its placement can be let go. */
  minted: string | null;
}

/**
 * Share of a block's characters that may be structural symbols before it is machine
 * layout rather than writing — a table rule, an ASCII diagram, a row of dot leaders. The
 * walker's own bound, applied here for the same reason: a stretch of short blocks must
 * not be welded into a unit of table rows.
 */
const MAX_SYMBOL_NOISE = 0.2;

/**
 * What a block is, as far as reading it with its neighbours goes. Above the evidence floor
 * nothing is refused that was not refused before — a block that clears the floor is scored
 * exactly as it is today, and this only decides what may be read WITH it. Below the floor
 * the walker's own tests decide (lib/dom/text.ts): a line of author names, a table row, a
 * page number that escaped the margin rule and a caption label are not somebody's prose
 * and nothing is grouped across them.
 */
function roleOf(block: ReflowBlock, words: number): BlockRole {
  if (block.kind === "heading") return "barrier";
  if (block.apart) return words >= MIN_UNIT_WORDS ? "apart" : "barrier";
  if (words >= MIN_UNIT_WORDS) return "prose";
  if (!hasLetters(block.text)) return isSeparatorRun(block.text) ? "barrier" : "skip";
  if (symbolNoiseRatio(block.text) > MAX_SYMBOL_NOISE) return "barrier";
  if (looksLikeNameList(block.text)) return "barrier";
  const role = shortRole(block.text);
  return role === "prose" ? "prose" : role === "aside" ? "skip" : "barrier";
}

/** The document's blocks as the grouping rules see them — word counts, lengths, roles and
 *  the breaks between them, and nothing of the page they were printed on. */
export function planOf(blocks: readonly ReflowBlock[]): PlanBlock[] {
  return blocks.map((block) => {
    const text = block.text.slice(0, MAX_UNIT_TEXT_CHARS);
    const words = countWords(text);
    return { words, chars: text.length, role: roleOf(block, words), barrierBefore: block.columnBreak };
  });
}

/** Strict per-paragraph mode, as the walker means it (CollectOptions.mergeShorts false):
 *  every block that clears the floor by itself, and nothing else. */
function soloGroups(plan: readonly PlanBlock[]): number[][] {
  const out: number[][] = [];
  plan.forEach((b, i) => {
    if (b.role !== "barrier" && b.role !== "skip" && b.words >= MIN_UNIT_WORDS) out.push([i]);
  });
  return out;
}

/**
 * Which blocks are read together, as groups of indices into `blocks`. Pure — the vitest
 * suite drives it with reflowed pages and nothing else (test/node/pdfGroup.test.ts).
 */
export function groupsOf(blocks: readonly ReflowBlock[], mergeShorts = true): number[][] {
  const plan = planOf(blocks);
  return mergeShorts ? groupBlocks(plan) : soloGroups(plan);
}

/** Search highlights split PDF.js item spans into nested text nodes. */
function descendantText(element: Element): Text[] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text);
  return out;
}

export function itemRanges(element: Element, start: number, end: number): Range[] | null {
  const out: Range[] = [];
  let offset = 0;
  for (const node of descendantText(element)) {
    const next = offset + node.length;
    if (start < next && end > offset) {
      const range = new Range();
      range.setStart(node, Math.max(0, start - offset));
      range.setEnd(node, Math.min(node.length, end - offset));
      out.push(range);
    }
    offset = next;
  }
  return start >= 0 && end <= offset && start < end ? out : null;
}

let _seq = 0;

export function createPdfUnitSource(): PdfUnitSource {
  const pages = new Map<number, PdfPageSpans>();
  let blocks: ReflowBlock[] = [];
  /** What `collect` last handed out, by unit id, so a mark can find its glyphs. */
  const placed = new Map<string, Blueprint>();
  /** The blueprints of the current blocks, rebuilt when the reconstruction changes. */
  let built: Blueprint[] | null = null;
  /** The setting the blueprints were built under: changing it changes the segmentation. */
  let merged = true;

  function setBlocks(next: ReflowBlock[]): void {
    blocks = next;
    built = null;
  }

  function setPage(n: number, page: PdfPageSpans): void {
    pages.set(n, page);
    built = null;
  }

  function removePage(n: number): void {
    pages.delete(n);
    built = null;
  }

  function nodesOf(run: SourceRun): Text[] {
    const span = pages.get(run.page)?.spans[run.item];
    return span?.isConnected ? descendantText(span) : [];
  }

  /**
   * One group of blocks as a Unit, or null where there is nothing on the page to hang it
   * on (its pages have not been rendered yet). Parts break at a page boundary, at the
   * joint between two blocks, and wherever the item index stops climbing — which is a
   * column change, and is also what keeps every part in document order, so a range over
   * one is a range over the glyphs it names and nothing between them.
   */
  function build(members: readonly ReflowBlock[], wordsPer: readonly number[], order: number): Blueprint | null {
    // The unit's text is the paragraphs joined the way a merged unit's text is joined
    // everywhere else — "\n\n" between them, which is also where the window planner
    // prefers to cut (lib/capture/windows.ts).
    const starts: number[] = [];
    let text = "";
    for (const m of members) {
      starts.push(text.length === 0 ? 0 : text.length + 2);
      text = text.length === 0 ? m.text : `${text}\n\n${m.text}`;
    }
    text = text.slice(0, MAX_UNIT_TEXT_CHARS);
    // The words are the ones already counted for the plan; a grouped unit's count is the
    // sum of its paragraphs', exactly as a merged unit's is on a page (lib/dom/walker.ts).
    let words = 0;
    for (const n of wordsPer) words += n;

    const parts: UnitPart[] = [];
    const runs: SourceRun[] = [];
    const nodes: Text[] = [];
    let missing = false;
    members.forEach((block, i) => {
      const base = starts[i];
      let open: { part: UnitPart; page: number; item: number } | null = null;
      for (const run of block.runs) {
        const at = base + run.at;
        if (at + run.length > text.length) break; // past the storage cap
        const itemNodes = nodesOf(run);
        const layer = pages.get(run.page)?.layer;
        if (!itemNodes.length || !layer?.isConnected) { missing = true; continue; }
        if (open === null || open.page !== run.page || run.item < open.item) {
          const part: UnitPart = { nodes: [], container: layer };
          parts.push(part);
          open = { part, page: run.page, item: run.item };
        }
        // Two runs of one item (a collapsed space cut the stretch in two) share its node.
        for (const node of itemNodes) if (!open.part.nodes.includes(node)) open.part.nodes.push(node);
        open.item = run.item;
        runs.push({ ...run, at });
        nodes.push(...itemNodes);
      }
    });
    if (missing || parts.length === 0) return null;

    const first = parts[0].nodes[0];
    const lastPart = parts[parts.length - 1];
    const last = lastPart.nodes[lastPart.nodes.length - 1];
    const topElement = first.parentElement;
    const container = last.parentElement;
    if (!topElement || !container) return null;

    // The SPANS anchor the unit, not the page: a page of a two-column paper holds dozens
    // of paragraphs, and anchoring them all on the layer would put every one of them in
    // the viewport lane at once. A span is absolutely positioned and has a box, so it is
    // an IntersectionObserver target like any other. The LAST span anchors the chip, which
    // is what puts a grouped unit's chip after the last of its paragraphs.
    return { parts, text, words, paragraphs: members.length, order, topElement, container, runs, nodes, minted: null };
  }

  function rebuild(mergeShorts: boolean): Blueprint[] {
    if (built && merged === mergeShorts && built.every((b) => b.nodes.every((n) => n.isConnected))) return built;
    merged = mergeShorts;
    const plan = planOf(blocks);
    const groups = mergeShorts ? groupBlocks(plan) : soloGroups(plan);
    const out: Blueprint[] = [];
    groups.forEach((group, i) => {
      const p = build(group.map((at) => blocks[at]), group.map((at) => plan[at].words), i);
      if (p) out.push(p);
    });
    built = out;
    return out;
  }

  function mint(from: Blueprint): Unit {
    if (from.minted) placed.delete(from.minted);
    const unit: Unit = {
      id: `p_${(_seq++).toString(36)}`,
      parts: from.parts,
      text: from.text,
      wordCount: from.words,
      formulas: 0,
      order: from.order,
      topElement: from.topElement,
      container: from.container,
      isScored: false,
      textFixed: true,
      paragraphs: from.paragraphs,
    };
    from.minted = unit.id;
    placed.set(unit.id, from);
    return unit;
  }

  function collect(claim: (nodes: Text[]) => "take" | "skip", mergeShorts = true): Unit[] {
    const out: Unit[] = [];
    for (const [id, blueprint] of placed) {
      if (blueprint.nodes.some((node) => !node.isConnected)) placed.delete(id);
    }
    for (const candidate of rebuild(mergeShorts)) {
      // The walker's protocol, run by hand: a part a live unit owns EXACTLY is skipped,
      // and a paragraph all of whose parts are skipped IS that live unit and is not
      // emitted again. One part answering differently means the paragraph is not what it
      // was — it gained the page that followed it — so the whole is asked for once more,
      // which retires the stale owner, and comes back as a new unit with a new id.
      let live = true;
      for (const part of candidate.parts) {
        if (claim(part.nodes) !== "skip") live = false;
      }
      if (live) continue;
      if (claim(candidate.parts.flatMap((p) => p.nodes)) === "skip") continue;
      out.push(mint(candidate));
    }
    return out;
  }

  function ranges(unit: Unit, spans: readonly TextSpan[]): Range[][] | null {
    const home = placed.get(unit.id);
    if (!home) return null;
    const out: Range[][] = spans.map(() => []);
    for (let k = 0; k < spans.length; k++) {
      const { start, end } = spans[k];
      for (let i = 0; i < home.runs.length; i++) {
        const run = home.runs[i];
        const from = Math.max(start, run.at);
        const to = Math.min(end, run.at + run.length);
        if (from >= to) continue;
        const element = pages.get(run.page)?.spans[run.item];
        if (!element?.isConnected) return null;
        const resolved = itemRanges(element, run.from + from - run.at, run.from + to - run.at);
        if (!resolved) return null;
        out[k].push(...resolved);
      }
    }
    return out;
  }

  return { setBlocks, setPage, removePage, collect, ranges };
}
