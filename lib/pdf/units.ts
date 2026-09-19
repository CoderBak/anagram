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
//  - their PARTS are pieces of a page — one per contiguous stretch of the paragraph on
//    one page and in one column — not paragraphs of one voice, which is the other thing
//    `textFixed` says: a unit of three parts is still one paragraph and its chip must not
//    read "×3".
//
// v1 scores each paragraph that clears the evidence floor on its own. The walker's
// assembler, which merges the short paragraphs of one voice, is not reused: it is built
// around DOM runs, their containers and the scope survey, and none of those exist here.
// So a heading, a caption, an author line and a paragraph under fifty words are read by
// nobody — the same verdict the walker reaches for them on a web page, by a shorter road.
import {
  countWords,
  MAX_UNIT_TEXT_CHARS,
  MIN_UNIT_WORDS,
  type Unit,
  type UnitPart,
} from "../dom/text";
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
  /**
   * The document's units, as `OrchestratorOptions.collect` asks for them: everything a
   * live unit already owns exactly is left alone, and the rest comes back fresh.
   */
  collect(claim: (nodes: Text[]) => "take" | "skip"): Unit[];
  /**
   * Ranges over the page's own glyphs for each of `spans` — what lib/render/highlight.ts
   * paints instead of re-deriving the text from the nodes, which for a PDF never matches.
   */
  ranges(unit: Unit, spans: readonly TextSpan[]): Range[][] | null;
}

/**
 * One block, ready to be handed out as a unit. The unit itself is MINTED on each collect
 * rather than kept, because a unit carries run state (its id, whether it was scored) and a
 * rescan drops all of that: handing the same object back would give the orchestrator a
 * paragraph that already believes it has a verdict.
 */
interface Blueprint {
  parts: UnitPart[];
  text: string;
  words: number;
  order: number;
  topElement: Element;
  container: Element;
  /** The runs the text is made of, and the text node each of them lives in. */
  runs: SourceRun[];
  nodes: Text[];
  /** The id of the unit last minted from this, so its placement can be let go. */
  minted: string | null;
}

let _seq = 0;

export function createPdfUnitSource(): PdfUnitSource {
  const pages = new Map<number, PdfPageSpans>();
  let blocks: ReflowBlock[] = [];
  /** What `collect` last handed out, by unit id, so a mark can find its glyphs. */
  const placed = new Map<string, Blueprint>();
  /** The blueprints of the current blocks, rebuilt when the reconstruction changes. */
  let built: Blueprint[] | null = null;

  function setBlocks(next: ReflowBlock[]): void {
    blocks = next;
    built = null;
  }

  function setPage(n: number, page: PdfPageSpans): void {
    pages.set(n, page);
    built = null;
  }

  /** The text node of one source run, or null where the page has no span for it. */
  function nodeOf(run: SourceRun): Text | null {
    const span = pages.get(run.page)?.spans[run.item];
    const node = span?.firstChild;
    return node && node.nodeType === Node.TEXT_NODE ? (node as Text) : null;
  }

  /**
   * One block as a Unit, or null where it is not something to score. Parts break at a page
   * boundary and wherever the item index stops climbing — which is a column change, and is
   * also what keeps every part in document order, so a range over one is a range over the
   * glyphs it names and nothing between them.
   */
  function build(block: ReflowBlock, order: number): Blueprint | null {
    if (block.kind === "heading") return null;
    const text = block.text.slice(0, MAX_UNIT_TEXT_CHARS);
    const words = countWords(text);
    if (words < MIN_UNIT_WORDS) return null;

    const parts: UnitPart[] = [];
    const runs: SourceRun[] = [];
    const nodes: Text[] = [];
    let open: { part: UnitPart; page: number; item: number } | null = null;
    for (const run of block.runs) {
      if (run.at + run.length > text.length) break; // past the storage cap
      const node = nodeOf(run);
      const layer = pages.get(run.page)?.layer;
      if (!node || !layer) continue;
      if (open === null || open.page !== run.page || run.item < open.item) {
        const part: UnitPart = { nodes: [], container: layer };
        parts.push(part);
        open = { part, page: run.page, item: run.item };
      }
      // Two runs of one item (a collapsed space cut the stretch in two) share its node.
      if (open.part.nodes[open.part.nodes.length - 1] !== node) open.part.nodes.push(node);
      open.item = run.item;
      runs.push(run);
      nodes.push(node);
    }
    if (parts.length === 0) return null;

    const first = parts[0].nodes[0];
    const lastPart = parts[parts.length - 1];
    const last = lastPart.nodes[lastPart.nodes.length - 1];
    const topElement = first.parentElement;
    const container = last.parentElement;
    if (!topElement || !container) return null;

    // The SPANS anchor the unit, not the page: a page of a two-column paper holds dozens
    // of paragraphs, and anchoring them all on the layer would put every one of them in
    // the viewport lane at once. A span is absolutely positioned and has a box, so it is
    // an IntersectionObserver target like any other.
    return { parts, text, words, order, topElement, container, runs, nodes, minted: null };
  }

  function rebuild(): Blueprint[] {
    if (built) return built;
    const out: Blueprint[] = [];
    blocks.forEach((block, i) => {
      const p = build(block, i);
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
    };
    from.minted = unit.id;
    placed.set(unit.id, from);
    return unit;
  }

  function collect(claim: (nodes: Text[]) => "take" | "skip"): Unit[] {
    const out: Unit[] = [];
    for (const candidate of rebuild()) {
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
        try {
          const range = new Range();
          range.setStart(home.nodes[i], run.from + (from - run.at));
          range.setEnd(home.nodes[i], run.from + (to - run.at));
          out[k].push(range);
        } catch {
          return null; // the page went away under us — the caller marks the whole unit
        }
      }
    }
    return out;
  }

  return { setBlocks, setPage, collect, ranges };
}
