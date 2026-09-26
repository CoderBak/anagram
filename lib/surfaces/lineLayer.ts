// lib/surfaces/lineLayer.ts — a document shown as pictures of its pages, with its lines set
// over them.
//
// Google Drive previews a PDF or a Word file this way: every page is an image, and over it
// sits a layer holding one absolutely positioned element per printed line, at 1% opacity so
// the text can be selected but is never seen. Walked like a page, that layer is a heap of
// one-line blocks: a line of up to forty characters is skipped as a positioned label, a
// longer one becomes a "paragraph" of its own, and what comes out is a unit of twenty-one
// "paragraphs" that are the lines of four real ones, with holes where the short lines were
// and "collabora- tion" where a word was hyphenated.
//
// Those lines are what a PDF's text runs are: text at coordinates. So they are read the way
// the PDF reader reads a PDF. lib/pdf/reflow.ts rebuilds the paragraphs — joins the lines,
// mends the hyphens, finds headings, columns and the running heads repeated page after page
// — and lib/pdf/units.ts turns them into units whose parts are the lines' own text nodes,
// grouped by the same rules as everywhere else. Pages arrive as the viewer loads them; each
// unbroken run of loaded pages is rebuilt as one document, as the reader does.
//
// What the layer cannot do is SHOW anything: a highlight on text at 1% opacity is painted at
// 1%, a chip inside it would be too, and the invisible text is not even set in the picture's
// font. So marks and chips go in a layer of our own over the page box, placed from the lines'
// own boxes in the page's proportions (percentages), which keeps them on the printed words at
// any zoom without being drawn again.
import { reflowPdf, type PdfPageText, type ReflowBlock } from "../pdf/reflow";
import { createPdfUnitSource } from "../pdf/units";
import { scaleColor, SCALE_STEPS } from "../render/scale";
import type { MarkPainter } from "../render/highlight";
import { unitParagraphs } from "../dom/text";
import { MARK_ATTR, type Unit } from "../types";
import type { Span, Surface } from "./types";

/** Where one line was set, in the page's own units (origin top-left, y down). */
export interface LineBox {
  x: number;
  top: number;
  width: number;
  height: number;
}

/** One loaded page of the document, as its source reads it off the page. */
export interface LinePage {
  /** 1-based page number in the document. */
  n: number;
  /** The page's box. Marks and chips are drawn over it, so it must be positioned. */
  box: HTMLElement;
  /** The element the lines are set in. */
  layer: HTMLElement;
  /** The page's size in the units of `boxes`. */
  width: number;
  height: number;
  /** The page's lines, in the order the page gives them, and where each was set. */
  lines: HTMLElement[];
  boxes: LineBox[];
}

export interface LineSource {
  /** The document's loaded pages in page order ([] while none has loaded yet), or null
   *  when there is no document on the page. */
  pages(): LinePage[] | null;
}

/** A line's box is its ink: one with descenders is taller than one without. The size of the
 *  type is the page's usual line height, unless a line is this much taller — a heading. */
const TALLER = 1.25;
/** Where the baseline sits in a line box, and how tall the glyphs are, as shares of it. */
const BASELINE = 0.8;
const GLYPH = 0.75;
/** A chip is this far from the end of the line it closes, in shares of the page width. */
const CHIP_GAP = 0.006;
/** Chip widths the badge reserves before its label is in: one paragraph, several. */
const CHIP_PX = 54;
const CHIP_GROUP_PX = 80;
const MARK_PX = 2;

/** The type size of each line: the page's usual one, or the line's own where it is larger. */
function typeSizes(boxes: readonly LineBox[]): number[] {
  const heights = boxes.map((b) => b.height).sort((a, b) => a - b);
  const usual = heights[Math.floor(heights.length / 2)] ?? 0;
  return boxes.map((b) => (b.height > usual * TALLER ? b.height : usual));
}

/** A page as the reflow reads a PDF page: every line one text run, at its baseline. */
function pageText(page: LinePage, sizes: readonly number[]): PdfPageText {
  return {
    page: page.n,
    width: page.width,
    height: page.height,
    items: page.lines.map((line, i) => {
      const b = page.boxes[i];
      return { str: line.textContent ?? "", x: b.x, y: b.top + sizes[i] * BASELINE, width: b.width, height: sizes[i] * GLYPH };
    }),
  };
}

/** Every unbroken run of loaded pages, rebuilt as a document of its own. */
function reflowRuns(pages: readonly LinePage[], sizes: ReadonlyMap<LinePage, number[]>): ReflowBlock[] {
  const blocks: ReflowBlock[] = [];
  let run: PdfPageText[] = [];
  let last = -1;
  const flush = (): void => {
    if (run.length > 0) blocks.push(...reflowPdf(run));
    run = [];
  };
  for (const page of pages) {
    if (page.n !== last + 1) flush();
    run.push(pageText(page, sizes.get(page) ?? []));
    last = page.n;
  }
  flush();
  return blocks;
}

/** The text nodes a range covers, each with the stretch of it that is covered. The ranges
 *  a stretch is located by lie inside one line; the whole-unit fallback spans a part. */
function textIn(range: Range): [Text, number, number][] {
  const start = range.startContainer, end = range.endContainer;
  if (start === end && start.nodeType === Node.TEXT_NODE) return [[start as Text, range.startOffset, range.endOffset]];
  const out: [Text, number, number][] = [];
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!range.intersectsNode(t)) continue;
    out.push([t, t === start ? range.startOffset : 0, t === end ? range.endOffset : t.length]);
  }
  return out;
}

function sameLines(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((el, i) => el === b[i]);
}

/** A position in the page's proportions, as CSS. */
const pct = (v: number, of: number): string => `${((v / of) * 100).toFixed(4)}%`;

export function createLineLayerSurface(source: LineSource): Surface {
  const units = createPdfUnitSource();
  let known = new Map<number, LinePage>();
  /** Every line's page, index and type size, for the marks and the chips. */
  let lineAt = new WeakMap<Element, { page: LinePage; i: number; size: number }>();
  /** The units handed out here, by id: everything else on the page is somebody else's. */
  const mine = new Map<string, Unit>();
  /** Our layer over each page box. */
  const overlays = new Map<HTMLElement, HTMLElement>();
  /** What each unit's marks are made of. */
  const drawn = new Map<string, { bars: HTMLElement[]; tints: HTMLElement[] }>();
  let visible = true;
  let answered = false;
  /** The pages as read once per turn: a burst asks whether the document is there and for
   *  its units once per changed root, and the page cannot change in between. */
  let snapshot: LinePage[] | null | undefined;

  function current(): LinePage[] | null {
    if (snapshot === undefined) {
      snapshot = source.pages();
      queueMicrotask(() => {
        snapshot = undefined;
      });
    }
    return snapshot;
  }

  function sync(pages: LinePage[]): void {
    let changed = pages.length !== known.size;
    const next = new Map<number, LinePage>();
    for (const page of pages) {
      next.set(page.n, page);
      const old = known.get(page.n);
      if (old && old.layer === page.layer && sameLines(old.lines, page.lines)) continue;
      changed = true;
      units.setPage(page.n, { layer: page.layer, spans: page.lines });
    }
    for (const n of known.keys()) {
      if (next.has(n)) continue;
      units.removePage(n);
      changed = true;
    }
    known = next;
    if (!changed) return;
    const sizes = new Map<LinePage, number[]>();
    lineAt = new WeakMap();
    for (const page of pages) {
      const s = typeSizes(page.boxes);
      sizes.set(page, s);
      page.lines.forEach((line, i) => lineAt.set(line, { page, i, size: s[i] }));
    }
    units.setBlocks(reflowRuns(pages, sizes));
  }

  function collect(claim: (nodes: Text[]) => "take" | "skip", mergeShorts: boolean): Unit[] {
    // A mutation burst asks once per changed root; the whole document answers the first.
    if (answered) return [];
    answered = true;
    queueMicrotask(() => {
      answered = false;
    });
    const pages = current();
    if (!pages) return [];
    sync(pages);
    for (const [id, unit] of mine) {
      if (!unit.parts.every((p) => p.nodes.every((n) => n.isConnected))) mine.delete(id);
    }
    const fresh = units.collect(claim, mergeShorts);
    for (const unit of fresh) mine.set(unit.id, unit);
    return fresh;
  }

  /** The line a text node belongs to, and how far into the line's text the node starts. */
  function lineOf(node: Node): { page: LinePage; i: number; size: number; before: number; length: number } | null {
    let el: Element | null = node.parentElement;
    let at = el ? lineAt.get(el) : undefined;
    while (el && !at) {
      el = el.parentElement;
      at = el ? lineAt.get(el) : undefined;
    }
    if (!el || !at) return null;
    let before = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t && t !== node; t = walker.nextNode()) before += (t as Text).length;
    // What the line shows: Drive ends every line's text with a newline nobody sees.
    const length = (el.textContent ?? "").trimEnd().length;
    return { ...at, before, length };
  }

  function overlayFor(page: LinePage): HTMLElement {
    let layer = overlays.get(page.box);
    if (!layer?.isConnected) {
      layer = document.createElement("div");
      layer.setAttribute(MARK_ATTR, "marks");
      layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:3;";
      page.box.append(layer);
      overlays.set(page.box, layer);
    }
    return layer;
  }

  function place(unit: Unit, host: HTMLElement): boolean | null {
    if (!mine.has(unit.id)) return null;
    const node = unit.parts.at(-1)?.nodes.at(-1);
    const at = node?.isConnected ? lineOf(node) : null;
    if (!at) return false;
    const { page, i, size } = at;
    const b = page.boxes[i];
    const px = page.box.getBoundingClientRect().width;
    const chip = ((unitParagraphs(unit) > 1 ? CHIP_GROUP_PX : CHIP_PX) / Math.max(px, 1)) * page.width;
    // After the last word where the line leaves room; else just outside the page's edge,
    // where the viewer shows its own background — never over the printed text.
    let x = b.x + b.width + page.width * CHIP_GAP;
    const onPaper = x + chip <= page.width;
    if (!onPaper) x = page.width * (1 + CHIP_GAP);
    const layer = overlayFor(page);
    for (const stale of [...layer.children]) if (stale.hasAttribute("data-chip") && !stale.firstElementChild) stale.remove();
    const slot = document.createElement("span");
    slot.setAttribute("data-chip", "");
    // The chip is themed by what it sits on (lib/render/badge.ts): the page is a picture of
    // white paper, which paints no background of its own, so the slot says so.
    slot.style.cssText =
      `position:absolute;left:${pct(x, page.width)};top:${pct(b.top + size / 2, page.height)};` +
      "transform:translateY(-50%);pointer-events:auto;white-space:nowrap;line-height:0;" +
      (onPaper ? "background:#fff;border-radius:999px;" : "");
    host.style.marginInlineStart = "0";
    slot.append(host);
    layer.append(slot);
    return true;
  }

  function clear(id: string): void {
    const d = drawn.get(id);
    if (!d) return;
    for (const el of [...d.bars, ...d.tints]) el.remove();
    drawn.delete(id);
  }

  const painter: MarkPainter = {
    paint(unit, marks, active) {
      if (!mine.has(unit.id)) return false;
      clear(unit.id);
      const d = { bars: [] as HTMLElement[], tints: [] as HTMLElement[] };
      for (const { step, ranges } of marks) {
        const score = step / SCALE_STEPS;
        for (const [node, from, to] of ranges.flatMap((range) => (range.collapsed ? [] : textIn(range)))) {
          const at = lineOf(node);
          if (!at || at.length === 0) continue;
          const f0 = Math.min(1, (at.before + from) / at.length);
          const f1 = Math.min(1, (at.before + to) / at.length);
          if (f1 <= f0) continue;
          const { page, i, size } = at;
          const b = page.boxes[i];
          const left = pct(b.x + b.width * f0, page.width);
          const width = pct(b.width * (f1 - f0), page.width);
          const layer = overlayFor(page);
          const bar = document.createElement("div");
          bar.style.cssText =
            `position:absolute;left:${left};width:${width};top:${pct(b.top + size, page.height)};` +
            `height:${MARK_PX}px;background:${scaleColor(score, false)};`;
          const tint = document.createElement("div");
          tint.style.cssText =
            `position:absolute;left:${left};width:${width};top:${pct(b.top, page.height)};` +
            `height:${pct(size, page.height)};background:${scaleColor(score, false, 0.18)};`;
          bar.hidden = !visible;
          tint.hidden = !active || !visible;
          layer.prepend(tint, bar); // under the chips, which come after
          d.bars.push(bar);
          d.tints.push(tint);
        }
      }
      drawn.set(unit.id, d);
      return true;
    },
    clear,
    activate(id, active) {
      const d = drawn.get(id);
      if (d) for (const tint of d.tints) tint.hidden = !active || !visible;
    },
    show(on) {
      visible = on;
      for (const d of drawn.values()) {
        for (const bar of d.bars) bar.hidden = !on;
        if (!on) for (const tint of d.tints) tint.hidden = true;
      }
    },
  };

  return {
    active: () => current() !== null,
    collect,
    ranges(unit: Unit, spans: readonly Span[]) {
      return mine.has(unit.id) ? units.ranges(unit, spans) : undefined;
    },
    place,
    painter,
  };
}
