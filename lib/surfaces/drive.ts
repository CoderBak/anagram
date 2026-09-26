// lib/surfaces/drive.ts — the document in Google Drive's file preview.
//
// Surface idea and first selectors from Read Aloud's Google Drive adapters
// (js/content/google-drive-preview.js, google-drive-doc.js), https://github.com/ken107/read-aloud,
// MIT licence, Copyright (c) 2016 Hai Phan and contributors. Read Aloud reads the <p> of each
// page and joins lines by their punctuation; this reads their geometry instead
// (lib/surfaces/lineLayer.ts).
//
// Measured logged-out on public files at drive.google.com/file/d/…/view (2026-09): the viewer
// is `[role=document]`, whose children include one box per page, `padding-bottom: N%` giving
// the page's proportions whether or not it has loaded. A loaded page holds the page image and
// a layer at `opacity: 0.01` whose `<h2>` names the page ("Page 2 of 12", in the reader's
// language) and whose `<p>`s are the printed lines, one each, placed by an inline
// `left/top/width/height` in percentages of the page. Pages load as the reader scrolls and
// nothing is fetched here: the text is the viewer's own. Every class name is generated and
// changes between releases, so none is used — only the roles, the tags and the geometry.
import type { LineBox, LinePage, LineSource } from "./lineLayer";

/** "12.5%" → 12.5, anything else → null. */
function percent(value: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

/** A printed line: a <p> placed by percentages. Its box in page units, where the page is 100
 *  wide and `tall` high (the page box's padding-bottom). */
function lineBox(p: HTMLElement, tall: number): LineBox | null {
  const s = p.style;
  const x = percent(s.left), top = percent(s.top), width = percent(s.width), height = percent(s.height);
  if (x === null || top === null || width === null || height === null) return null;
  return { x, top: (top * tall) / 100, width, height: (height * tall) / 100 };
}

/** What a page box held when it was last read, so an unchanged page costs one comparison. */
interface Seen {
  count: number;
  first: Element | null;
  last: Element | null;
  page: LinePage | null;
}

export function createDriveSource(doc: Document): LineSource {
  const seen = new WeakMap<HTMLElement, Seen>();

  function readPage(box: HTMLElement, n: number, tall: number): LinePage | null {
    const lines: HTMLElement[] = [];
    const boxes: LineBox[] = [];
    let layer: HTMLElement | null = null;
    for (const p of box.querySelectorAll<HTMLElement>("p")) {
      const b = lineBox(p, tall);
      if (!b || !p.parentElement) continue;
      layer ??= p.parentElement;
      if (p.parentElement !== layer) continue;
      lines.push(p);
      boxes.push(b);
    }
    return layer && lines.length > 0 ? { n, box, layer, width: 100, height: tall, lines, boxes } : null;
  }

  return {
    pages() {
      const viewer = doc.querySelector('[role="document"]');
      if (!viewer) return null;
      const pages: LinePage[] = [];
      let n = 0;
      for (const box of viewer.children) {
        if (!(box instanceof HTMLElement)) continue;
        const tall = percent(box.style.paddingBottom);
        if (tall === null || tall <= 0) continue;
        n++;
        // The page's text layer is the one element of the box holding <p>s; its children
        // change only when the page loads or is let go.
        const layer = box.querySelector("p")?.parentElement ?? null;
        const now = { count: layer?.childElementCount ?? 0, first: layer?.firstElementChild ?? null, last: layer?.lastElementChild ?? null };
        const was = seen.get(box);
        let page: LinePage | null;
        if (was && was.count === now.count && was.first === now.first && was.last === now.last && (!was.page || was.page.n === n)) {
          page = was.page;
        } else {
          page = readPage(box, n, tall);
          seen.set(box, { ...now, page });
        }
        if (page) pages.push(page);
      }
      return n > 0 ? pages : null;
    },
  };
}
