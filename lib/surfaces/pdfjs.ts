// lib/surfaces/pdfjs.ts — a PDF shown by a pdf.js viewer inside a web page.
//
// Many sites show a PDF with Mozilla's pdf.js rather than the browser's own viewer: its
// ready-made viewer page (…/web/viewer.html?file=…, the one on mozilla.github.io among them)
// and OneDrive's preview of a PDF, whose pages Read Aloud reads as `.OneUp-pdf--loaded
// .page[data-page-number] .textLayer > span` (js/content/onedrive-doc.js,
// https://github.com/ken107/read-aloud, MIT licence, Copyright (c) 2016 Hai Phan and
// contributors). Each page is a canvas under a text layer of absolutely positioned,
// transparent spans, one per run of the PDF's text — a word, half a line, a line — in the
// order the PDF wrote them, which in a two-column paper is not the order anyone reads them.
// The walk made those runs into units that ran down both columns at once.
//
// These spans are exactly what the PDF reader's reconstruction is built for, so this source
// only says where they are: the pages by `.page[data-page-number]`, the runs by the spans of
// the page's `.textLayer`, and each run's box as the browser lays it out, relative to the
// page — which holds for every pdf.js version, whatever units its styles use (pixels,
// percentages, `calc(var(--scale-factor) * …)`).
import type { LineBox, LinePage, LineSource } from "./lineLayer";

/** The runs of a text layer: pdf.js's own spans, not the `markedContent` groups around them
 *  nor the search highlights inside them. */
function runsOf(layer: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const span of layer.querySelectorAll<HTMLElement>("span")) {
    if (span.classList.contains("markedContent")) continue;
    const parent = span.parentElement;
    if (parent && parent !== layer && !parent.classList.contains("markedContent")) continue;
    if ((span.textContent ?? "").trim() === "") continue;
    out.push(span);
  }
  return out;
}

interface Seen {
  layer: Element;
  count: number;
  width: number;
  page: LinePage | null;
}

export function createPdfjsSource(doc: Document): LineSource {
  const seen = new WeakMap<HTMLElement, Seen>();

  function readPage(box: HTMLElement, n: number, layer: HTMLElement): LinePage | null {
    // The page's own box inside its border: what an absolutely positioned child is placed
    // in, and so the frame marks and chips are placed in too.
    const r = box.getBoundingClientRect();
    const left = r.left + box.clientLeft, top = r.top + box.clientTop;
    const w = box.clientWidth, h = box.clientHeight;
    if (w <= 0 || h <= 0) return null;
    const unit = 100 / w;
    const lines: HTMLElement[] = [];
    const boxes: LineBox[] = [];
    const range = doc.createRange();
    for (const span of runsOf(layer)) {
      range.selectNodeContents(span);
      const b = range.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      lines.push(span);
      boxes.push({
        x: (b.left - left) * unit,
        top: (b.top - top) * unit,
        width: b.width * unit,
        height: b.height * unit,
        rotated: /rotate/.test(span.style.transform),
      });
    }
    return lines.length > 0 ? { n, box, layer, width: 100, height: h * unit, lines, boxes } : null;
  }

  return {
    pages() {
      const all = doc.querySelectorAll<HTMLElement>(".page[data-page-number]");
      if (all.length === 0) return null;
      const pages: LinePage[] = [];
      let any = false;
      for (const box of all) {
        const layer = box.querySelector<HTMLElement>(".textLayer");
        const n = Number(box.dataset.pageNumber);
        if (!layer || !Number.isInteger(n) || n < 1) continue;
        any = true;
        // A layer is rebuilt when its page is drawn again (a zoom, a recycled page), so an
        // unchanged one keeps its element and its children; the page's width says zoom.
        const count = layer.childElementCount, width = box.clientWidth;
        const was = seen.get(box);
        let page: LinePage | null;
        if (was && was.layer === layer && was.count === count && was.width === width && (!was.page || was.page.n === n)) {
          page = was.page;
        } else {
          page = readPage(box, n, layer);
          seen.set(box, { layer, count, width, page });
        }
        if (page) pages.push(page);
      }
      return any ? pages.sort((a, b) => a.n - b.n) : null;
    },
  };
}
