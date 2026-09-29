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

/**
 * Place the chip beside the paragraph's last line, outside glyphs and other chips. Where the
 * line's own row is closed by the text of the paragraph's neighbours the chip goes to the
 * margin, and a margin is only the paragraph's own when no other text stands between it and
 * the line: the page's right margin is the left column's only across the right column's
 * lines, so a left column's chip goes to the margin on its own side. If no such place has
 * room the chip is left out; highlights and the panel still work.
 */
export function placeChip(viewer: Viewer, unit: Unit, host: HTMLElement): boolean {
  const part = unit.parts.at(-1);
  const node = part?.nodes.at(-1);
  const page = part && viewer.pageOf(part.container);
  if (!page || !node?.isConnected) return false;
  const range = new Range();
  range.selectNodeContents(node);
  const last = [...range.getClientRects()].at(-1);
  if (!last || !last.width) return false;
  // The chip layer is the page's padding box (inside pdf.js's border) and the chip's place is a
  // share of it, so it is measured from the layer, not from the page.
  const box = page.chips.getBoundingClientRect();
  // Badge content is populated after placement; reserve its widest normal label.
  const width = unitParagraphs(unit) > 1 ? 80 : 54, height = 22;
  const y = (last.top + last.bottom) / 2 - box.top;
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
  const column = partRects(part.nodes);
  const columnLeft = Math.min(last.left, ...column.map((r) => r.left));
  const columnRight = Math.max(last.right, ...column.map((r) => r.right));
  const left = columnLeft - box.left - width - 5, right = box.width - width - 6;
  const xs = [last.right - box.left + 5, ...((columnRight - box.left) * 2 > box.width ? [right, left] : [left, right])];
  const row = { top: y - height / 2, bottom: y + height / 2 };
  const x = xs.find((at) => at >= 6 && at + width <= box.width - 6 &&
    !obstacles.some(({ rect: r }) => r.left < box.left + at + width && r.right > box.left + at &&
      r.top < box.top + row.bottom && r.bottom > box.top + row.top) &&
    // A margin away from the column is the paragraph's only where no text of another column
    // stands on the line's row between the column's edge and the chip.
    !(at > columnRight - box.left && obstacles.some(({ own, rect: r }) => !own &&
      r.top < (last.top + last.bottom) / 2 && r.bottom > (last.top + last.bottom) / 2 &&
      r.left >= columnRight - 1 && r.left < box.left + at)));
  if (x === undefined) return false;
  const slot = document.createElement("span");
  slot.setAttribute(MARK_ATTR, "host");
  slot.style.left = `${x / box.width * 100}%`;
  slot.style.top = `${y / box.height * 100}%`;
  slot.append(host);
  for (const stale of [...page.chips.children]) if (!stale.firstElementChild) stale.remove();
  page.chips.append(slot);
  return true;
}
