import type { Unit } from "../../lib/types";
import { MARK_ATTR } from "../../lib/types";
import { unitParagraphs } from "../../lib/dom/text";
import type { Viewer } from "./viewer";

/** The rectangles of a unit's glyphs on one page's part of it, one per line fragment. */
function partRects(nodes: readonly Text[]): DOMRect[] {
  const out: DOMRect[] = [];
  for (const node of nodes) {
    if (!node.isConnected) continue;
    const range = new Range();
    range.selectNodeContents(node);
    out.push(...[...range.getClientRects()].filter((r) => r.width > 0));
  }
  return out;
}

/** One line of a part: the band its body-size glyphs stand in, and how far the whole line
 *  runs, a raised note number or a lowered index included. */
interface Line { top: number; bottom: number; left: number; right: number }

/**
 * The part's lines, top to bottom. A piece under three quarters of the part's usual height is
 * a raised or lowered mark — a note's number, an index, a reference in a smaller face — and
 * joins the line it stands beside without moving it: a chip centred on a raised "1" stood half
 * a line high, met the line above and was sent to the margin.
 */
function linesOf(rects: readonly DOMRect[]): Line[] {
  const heights = rects.map((r) => r.height).sort((a, b) => a - b);
  const usual = heights[Math.floor(heights.length / 2)] ?? 0;
  const lines: Line[] = [];
  for (const r of rects.filter((r) => r.height >= usual * 0.75).sort((a, b) => a.top - b.top)) {
    const mid = (r.top + r.bottom) / 2;
    const line = lines.find((l) => mid > l.top && mid < l.bottom);
    if (!line) { lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }); continue; }
    line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom);
    line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right);
  }
  for (const r of rects) {
    if (r.height >= usual * 0.75) continue;
    const line = lines.find((l) => r.bottom > l.top && r.top < l.bottom);
    if (line) { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right); }
  }
  return lines.sort((a, b) => a.top - b.top);
}

/** How far apart the part's lines are set, top to top, in px: the median step between them,
 *  or a single line's own height and a fifth where it has one. */
function linePitch(lines: readonly Line[]): number {
  const steps = lines.slice(1).map((l, i) => l.top - lines[i]!.top).sort((a, b) => a - b);
  const only = lines[0];
  return steps.length ? steps[Math.floor(steps.length / 2)]! : only ? (only.bottom - only.top) * 1.2 : 16;
}

/**
 * The pill's font size for a document set at `pitch`: the badge's own 12 px where the lines
 * leave room for it, smaller where they are tighter, so that a chip on a paragraph's last
 * line stands between the lines above and below instead of over them — never under the
 * badge's 9 px floor (lib/render/badge.css.ts: `clamp(9px, 0.66em, 12px)`, a box of 1.6 em
 * and its border).
 */
function pillFontFor(pitch: number): number {
  return Math.min(12, Math.max(9, (pitch * 0.94 - 2) / 1.6));
}

/**
 * Place the chip beside the paragraph's last line, outside glyphs and other chips: right after
 * the line, or a square of its colour alone there where the whole chip has no room. Where the
 * line's own row is closed by the text of the paragraph's neighbours the chip goes to the
 * margin, and a margin is only the paragraph's own when no other text stands between it and
 * the line: the page's right margin is the left column's only across the right column's
 * lines, so a left column's chip goes to the margin on its own side. If no such place has
 * room the chip is left out; the marks and the toolbar menu's list still work.
 */
export function placeChip(viewer: Viewer, unit: Unit, host: HTMLElement): boolean {
  const part = unit.parts.at(-1);
  const node = part?.nodes.at(-1);
  const page = part && viewer.pageOf(part.container);
  if (!page || !node?.isConnected) return false;
  const range = new Range();
  range.selectNodeContents(node);
  const end = [...range.getClientRects()].filter((r) => r.width > 0).at(-1);
  if (!end) return false;
  // The chip layer is the page's padding box (inside pdf.js's border) and the chip's place is a
  // share of it, so it is measured from the layer, not from the page.
  const box = page.chips.getBoundingClientRect();
  const column = partRects(part.nodes);
  const lines = linesOf(column);
  // The paragraph's last line is the one its last glyphs stand on.
  const last = lines.filter((l) => end.bottom > l.top && end.top < l.bottom).at(-1) ?? lines.at(-1);
  if (!last) return false;
  // Badge content is populated after placement: its box is reserved from the size the pill
  // is given — ".38" is 3 em of it and ".38 ×2" 4.8 em, after the host's own 6 px margin.
  const font = pillFontFor(linePitch(lines));
  const width = 7 + font * (unitParagraphs(unit) > 1 ? 4.8 : 3), height = font * 1.6 + 2;
  const mid = (last.top + last.bottom) / 2;
  const y = mid - box.top;
  // Search highlights nest inside an item's span: every ancestor up to the layer is the paragraph's.
  const own = new Set<Element>();
  for (const p of unit.parts) for (const n of p.nodes) {
    for (let e = n.parentElement; e && e !== p.container; e = e.parentElement) own.add(e);
  }
  const rectOf = (element: Element) => ({ own: own.has(element), rect: element.getBoundingClientRect() });
  const obstacles = [
    // A span with no area (pdf.js keeps one for an empty item) is no text to stand beside.
    ...page.spans.filter((span): span is HTMLElement => !!span?.isConnected).map(rectOf).filter(({ rect }) => rect.width > 0 && rect.height > 0),
    ...[...page.chips.querySelectorAll(":scope > span")].map(rectOf),
  ];
  // The column this part of the paragraph is set in: which half of the page it lies in
  // says which margin is nearer to it.
  const columnLeft = Math.min(last.left, ...column.map((r) => r.left));
  const columnRight = Math.max(last.right, ...column.map((r) => r.right));

  // What the reading leaves out but the line still shows right after its last glyph — a
  // note's raised number, a closing mark — belongs to the line's end: the chip goes after it
  // rather than to the margin.
  let lineEnd = last.right;
  for (let moved = true; moved;) {
    moved = false;
    for (const { rect: r } of obstacles) {
      if (r.left <= lineEnd + 2 && r.right > lineEnd && r.right - last.right < 40 && r.bottom > last.top && r.top < last.bottom) { lineEnd = r.right; moved = true; }
    }
  }
  /** Does a chip `w` wide and `h` tall stand free at `at`, on the line's row? */
  const free = (at: number, w: number, h: number): boolean => {
    const top = y - h / 2 + 1, bottom = y + h / 2 - 1; // a glyph's box is taller than its ink
    return at >= 6 && at + w <= box.width - 6 &&
      !obstacles.some(({ rect: r }) => r.left < box.left + at + w && r.right > box.left + at && r.top < box.top + bottom && r.bottom > box.top + top) &&
      // A margin away from the column is the paragraph's only where no text of another column
      // stands on the line's row between the column's edge and the chip.
      !(at > columnRight - box.left && obstacles.some(({ own, rect: r }) => !own &&
        r.top < mid && r.bottom > mid && r.left >= columnRight - 1 && r.left < box.left + at));
  };
  // The chip's places, the paragraph's end first. Where the whole chip has no room there, a
  // square of its colour alone (the score on hover) still stands at the end of the line — in
  // the gap between two columns, say — and only then does a chip go to a margin.
  const compactWidth = 2 + font * 1.1 + 2, compactHeight = font * 1.1 + 2;
  const afterLine = lineEnd - box.left + 1;
  const margins = (w: number): number[] => {
    const left = columnLeft - box.left - w - 4, right = box.width - w - 6;
    return (columnRight - box.left) * 2 > box.width ? [right, left] : [left, right];
  };
  const places: { at: number; compact: boolean }[] = [
    { at: afterLine, compact: false },
    { at: afterLine, compact: true },
    ...margins(width).map((at) => ({ at, compact: false })),
    ...margins(compactWidth).map((at) => ({ at, compact: true })),
  ];
  // A dot in a narrow gap keeps a few pixels from the next column's text, or it reads as that
  // column's.
  const place = places.find(({ at, compact }) => free(at, compact ? compactWidth + 4 : width, compact ? compactHeight : height));
  if (!place) return false;
  const x = place.at;
  // A host placed again (a zoom, a page drawn anew) may have been the square alone last time.
  if (place.compact) host.dataset.compact = "";
  else delete host.dataset.compact;
  host.style.marginInlineStart = place.compact ? "2px" : "";
  const slot = document.createElement("span");
  slot.setAttribute(MARK_ATTR, "host");
  slot.style.left = `${x / box.width * 100}%`;
  slot.style.top = `${y / box.height * 100}%`;
  slot.style.fontSize = `${font / 0.66}px`;
  slot.append(host);
  for (const stale of [...page.chips.children]) if (!stale.firstElementChild) stale.remove();
  page.chips.append(slot);
  return true;
}
