// entrypoints/reader/chips.ts — where a chip goes on a real page.
//
// On a web page the chip is inserted into the flow after the paragraph's last word and the
// browser finds room for it. A PDF page has no flow: it is a drawing with absolutely
// positioned transparent spans over it, and the one thing that must never happen is a chip
// over the document's own words. So the place is worked out from the page's own geometry:
//
//   1. just after the END of the paragraph's last line, where a last line nearly always
//      leaves white space, or
//   2. in the gutter or margin to the right of the COLUMN the paragraph is set in, at the
//      same baseline, when that last line ran the full measure, or
//   3. failing both, at the page's right margin on that line.
//
// It is stated in the page's own coordinates — `calc(var(--total-scale-factor) * Npx)` —
// so a chip placed once follows every zoom without being placed again, and it is clamped
// into the page box so nothing of ours can ever hang off the paper.
import type { Unit } from "../../lib/types";
import { MARK_ATTR } from "../../lib/types";
import { unitParagraphs } from "../../lib/dom/text";
import type { PageView, Viewer } from "./viewer";

/** A box in page coordinates: points from the page's top-left corner, y growing down. */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The chip's footprint in CSS pixels. It is a pill of a dot and at most four characters
 * ("100%") in the shipped style; these are upper bounds, used because the host is measured
 * before its number is written into it and a chip must never be placed optimistically.
 */
const CHIP_W = 54;
/** A unit of several paragraphs says so after the number ("38% ×3"), which is three more
 *  characters — four from ten paragraphs up. A chip is never placed optimistically, so
 *  the widest of those is what is reserved. */
const CHIP_XN_W = 26;
const CHIP_H = 22;
/** The gap between the last word and the chip, in page points — about one word space. */
const GAP = 5;
/** The page's own edge is never reached: a chip on the trim looks like a printing fault. */
const EDGE = 6;

/** Rects of a page's own text, in page coordinates — measured once, valid at every zoom. */
const measured = new WeakMap<Element, Box[]>();

function boxesOf(view: PageView, scale: number): Box[] {
  const hit = measured.get(view.box);
  if (hit) return hit;
  const page = view.box.getBoundingClientRect();
  const out: Box[] = [];
  for (const span of view.spans) {
    if (!span || !span.isConnected) continue;
    const r = span.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    out.push({
      x0: (r.left - page.left) / scale,
      y0: (r.top - page.top) / scale,
      x1: (r.right - page.left) / scale,
      y1: (r.bottom - page.top) / scale,
    });
  }
  measured.set(view.box, out);
  return out;
}

/** The box of one span in page coordinates. */
function boxOf(view: PageView, span: Element, scale: number): Box | null {
  const page = view.box.getBoundingClientRect();
  const r = span.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return {
    x0: (r.left - page.left) / scale,
    y0: (r.top - page.top) / scale,
    x1: (r.right - page.left) / scale,
    y1: (r.bottom - page.top) / scale,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** The spans of this unit that are on `view`'s page — its own lines, and its measure. */
function ownBoxes(view: PageView, unit: Unit, scale: number): Box[] {
  const out: Box[] = [];
  for (const part of unit.parts) {
    if (part.container !== view.layer) continue;
    for (const node of part.nodes) {
      const span = node.parentElement;
      if (!span) continue;
      const box = boxOf(view, span, scale);
      if (box) out.push(box);
    }
  }
  return out;
}

/** The page the unit's last line is on, from the span its last text node lives in. */
function endOf(unit: Unit): { layer: Element; span: Element } | null {
  const part = unit.parts[unit.parts.length - 1];
  const node = part?.nodes[part.nodes.length - 1];
  const span = node?.parentElement;
  return span ? { layer: part.container, span } : null;
}

/**
 * Put `host` on the page, or say that the unit is not on one this viewer shows. Called by
 * the badge layer the moment a chip is built (BadgeLayerOptions.place).
 */
export function placeChip(viewer: Viewer, unit: Unit, host: HTMLElement): boolean {
  const end = endOf(unit);
  if (!end) return false;
  const page = viewer.pageOf(end.layer);
  if (!page) return false;
  const scale = viewer.scale();
  const line = boxOf(page, end.span, scale);
  if (!line) return false;

  const w = (CHIP_W + (unitParagraphs(unit) > 1 ? CHIP_XN_W : 0)) / scale;
  const h = CHIP_H / scale;
  const y = (line.y0 + line.y1) / 2;
  const right = page.width - EDGE;
  const own = ownBoxes(page, unit, scale);
  const measure = own.reduce((m, b) => Math.max(m, b.x1), line.x1);
  const others = boxesOf(page, scale);
  const free = (x: number): boolean => {
    if (x < EDGE || x + w > right) return false;
    const candidate: Box = { x0: x, y0: y - h / 2, x1: x + w, y1: y + h / 2 };
    return !others.some((b) => overlaps(candidate, b));
  };

  // After the last word; else beside the column; else against the right margin.
  const wanted = [line.x1 + GAP, measure + GAP, right - w];
  const x = wanted.find(free) ?? Math.min(Math.max(wanted[0], EDGE), right - w);

  const slot = document.createElement("span");
  slot.setAttribute(MARK_ATTR, "host");
  slot.style.left = `calc(var(--total-scale-factor) * ${x.toFixed(2)}px)`;
  slot.style.top = `calc(var(--total-scale-factor) * ${y.toFixed(2)}px)`;
  slot.style.transform = "translateY(-50%)";
  slot.append(host);
  // A chip that was removed (a verdict retired, the display mode changed) leaves its slot
  // behind; the next chip on the same page takes the empty ones with it.
  for (const stale of [...page.chips.children]) {
    if (!stale.firstElementChild) stale.remove();
  }
  page.chips.append(slot);
  return true;
}
