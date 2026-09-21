import type { Unit } from "../../lib/types";
import { MARK_ATTR } from "../../lib/types";
import { unitParagraphs } from "../../lib/dom/text";
import type { Viewer } from "./viewer";

/** Place outside glyphs and other chips. If no space remains, highlights/panel still work. */
export function placeChip(viewer: Viewer, unit: Unit, host: HTMLElement): boolean {
  const part = unit.parts.at(-1);
  const node = part?.nodes.at(-1);
  const page = part && viewer.pageOf(part.container);
  if (!page || !node?.isConnected) return false;
  const range = new Range();
  range.selectNodeContents(node);
  const last = [...range.getClientRects()].at(-1);
  if (!last || !last.width) return false;
  const box = page.box.getBoundingClientRect();
  // Badge content is populated after placement; reserve its widest normal label.
  const width = unitParagraphs(unit) > 1 ? 80 : 54, height = 22;
  const y = (last.top + last.bottom) / 2 - box.top;
  const obstacles = [
    ...page.spans.filter((span): span is HTMLElement => !!span?.isConnected),
    ...page.chips.querySelectorAll<HTMLElement>(":scope > span"),
  ].map((element) => element.getBoundingClientRect());
  const xs = [last.right - box.left + 5, box.width - width - 6];
  const x = xs.find((at) => at >= 6 && at + width <= box.width - 6 &&
    !obstacles.some((r) => r.left < box.left + at + width && r.right > box.left + at &&
      r.top < box.top + y + height / 2 && r.bottom > box.top + y - height / 2));
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
