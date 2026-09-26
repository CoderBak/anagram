// lib/surfaces/kindle.ts — where a chip goes in Kindle's web reader.
//
// Kindle for the web (read.amazon.com, a book's sample and the reader) draws each page as a
// picture and sets an accessibility layer over it: `[role=region].kg-a11y-abs` for the page,
// one per column, a `p.kg-a11y-abs` per paragraph, and inside it every word as a transparent
// inline-block of its own width, `overflow: hidden`, moved onto the printed word by a
// relative offset (measured on a public sample, 2026-09). The walk reads those paragraphs as
// they are and the underlines land on the printed words; only the chip goes wrong. The flow
// puts it after the paragraph's first line box, which is the whole column wide, so a chip
// of the right-hand column lands past the page's edge and is cut off by the reader's frame.
// Here the chip is placed after the paragraph's last printed word instead, inside the page.
//
// Read Aloud reads the same reader (js/content/kindle-book.js, https://github.com/ken107/read-aloud,
// MIT licence, Copyright (c) 2016 Hai Phan and contributors); for a book without this layer it
// photographs the page and sends it to an OCR service, which Anagram does not do.
import { MARK_ATTR, type Unit } from "../types";
import type { Surface } from "./types";

const CHIP_GAP = 4;
const CHIP_PX = 54;

/** The outermost accessibility region an element sits in: the page. */
function pageOf(el: Element | null): HTMLElement | null {
  let page: HTMLElement | null = null;
  for (let e = el; e; e = e.parentElement) {
    if (e instanceof HTMLElement && e.classList.contains("kg-a11y-abs") && e.getAttribute("role") === "region") page = e;
  }
  return page;
}

export function createKindleSurface(doc: Document): Surface {
  return {
    active: () => false, // the page is walked as it is
    ranges: () => undefined,
    place(unit: Unit, host: HTMLElement): boolean | null {
      const node = unit.parts.at(-1)?.nodes.at(-1);
      const page = node?.isConnected ? pageOf(node.parentElement) : null;
      if (!node || !page) return null;
      const range = doc.createRange();
      range.selectNodeContents(node);
      const word = [...range.getClientRects()].at(-1);
      if (!word || !word.width) return null;
      const box = page.getBoundingClientRect();
      // After the last word; where the line reaches the page's edge, as far right as the
      // page still shows it.
      const x = Math.min(word.right - box.left + CHIP_GAP, box.width - CHIP_PX);
      const slot = doc.createElement("span");
      slot.setAttribute(MARK_ATTR, "marks");
      slot.style.cssText =
        `position:absolute;left:${x}px;top:${(word.top + word.bottom) / 2 - box.top}px;transform:translateY(-50%);` +
        "pointer-events:auto;white-space:nowrap;line-height:0;color:initial;z-index:1;";
      host.style.marginInlineStart = "0";
      slot.append(host);
      page.append(slot);
      for (const stale of page.querySelectorAll(`:scope > [${MARK_ATTR}="marks"]`)) if (!stale.firstElementChild) stale.remove();
      return true;
    },
  };
}
