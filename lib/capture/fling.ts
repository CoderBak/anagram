// lib/capture/fling.ts — whether the reader is flinging the page past what is on screen.
//
// The observers report a paragraph on screen the moment it is (lib/capture/observers.ts), and
// the scheduler sends what is on screen first. While the page is flung past, what is on screen
// for a moment is not what will be read: on a processor a paragraph takes seconds, four went out
// as they flashed by, and the one the reader stopped at waited behind all four. What is in
// flight cannot be called back (lib/webengine/engine.ts), so the on-screen lanes wait while the
// page moves faster than anyone reads, and go once it has settled: a short pause, the way a
// scroll's end was told before browsers had `scrollend` — which is no help here, as a page's own
// script that scrolls in steps ends a scroll at every step. A paragraph that left the screen
// meanwhile has been placed again by the observers, and waits where it stands now.

/** Faster than this, in screens a second, nobody is reading what passes: a page of prose is
 *  read in a minute, skimmed in a few seconds. */
const READING_SCREENS_PER_SECOND = 2;
/** The page has settled once it has moved slower than that for this long. */
const SETTLE_MS = 150;
/** Two scroll events further apart than this are two scrolls, not one speed. */
const SAMPLE_MS = 200;

export interface Fling {
  /** How long the on-screen lanes wait yet, in ms (the scheduler's foregroundDelay). */
  delay(): number;
  /** Follow the page's scrolling while a run is on. */
  watch(on: boolean): void;
}

export function createFling(doc: Document = document, now: () => number = () => performance.now()): Fling {
  let until = 0;
  /** The last position seen of each scroller, and when. */
  const last = new WeakMap<object, { at: number; top: number }>();
  const onScroll = (event: Event): void => {
    const scroller = (event.target === doc ? doc.scrollingElement : event.target) as { scrollTop?: unknown; clientHeight?: number } | null;
    if (!scroller || typeof scroller.scrollTop !== "number") return;
    const at = now(), top = scroller.scrollTop;
    const seen = last.get(scroller);
    last.set(scroller, { at, top });
    if (!seen || at - seen.at > SAMPLE_MS || at === seen.at) return;
    const screen = scroller === doc.scrollingElement ? doc.defaultView?.innerHeight ?? scroller.clientHeight ?? 0 : scroller.clientHeight ?? 0;
    if (!(screen > 0)) return;
    const speed = (Math.abs(top - seen.top) / (at - seen.at)) * 1000;
    if (speed > READING_SCREENS_PER_SECOND * screen) until = at + SETTLE_MS;
  };
  return {
    delay: () => Math.max(0, until - now()),
    watch(on) {
      if (on) doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
      else {
        doc.removeEventListener("scroll", onScroll, { capture: true });
        until = 0;
      }
    },
  };
}
