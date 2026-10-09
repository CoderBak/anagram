// lib/dom/frameGate.ts — which frames below a page's top are worth reading, asked first by
// the frame's stub (entrypoints/frame.content.ts) and again by the reader (entrypoints/content.ts).

/** A frame's viewport at least this wide and this large: tracking pixels and slim banners
 *  are smaller. */
export const MIN_FRAME_WIDTH = 200;
export const MIN_FRAME_AREA = 40_000; // e.g. 400×100

export const frameLargeEnough = (): boolean =>
  window.innerWidth >= MIN_FRAME_WIDTH && window.innerWidth * window.innerHeight >= MIN_FRAME_AREA;

/** What holds no text a reader sees. */
const UNREAD = new Set(["script", "style", "noscript", "template", "textarea"]);

/**
 * The frame's text holds at least `least` characters other than white space, outside scripts
 * and styles. Every word the reader counts holds one at least, so a frame with fewer has no
 * paragraph as long as the shortest it reads (MIN_WORDS); an ad slot's line or two is far
 * below it. Stops counting as soon as it has enough.
 */
export function holdsText(least: number): boolean {
  const body = document.body;
  if (!body) return false;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (UNREAD.has(t.parentElement?.localName ?? "")) continue;
    const text = t.nodeValue ?? "";
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > 32 && c !== 160) n++;
    }
    if (n >= least) return true;
  }
  return false;
}
