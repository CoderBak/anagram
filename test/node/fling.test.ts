// test/node/fling.test.ts — the page flung past holds what is on screen for a moment
// (lib/capture/fling.ts): the speeds, the settling, and the scrollers it follows.
import { describe, expect, it } from "vitest";
import { createFling } from "../../lib/capture/fling";

function page() {
  let clock = 0;
  const root = { scrollTop: 0, clientHeight: 800 };
  const doc = Object.assign(new EventTarget(), { scrollingElement: root, defaultView: { innerHeight: 800 } }) as unknown as Document;
  const fling = createFling(doc, () => clock);
  fling.watch(true);
  /** A scroll of the page (the document's own event) or of a box inside it: a box's scroll does
   *  not bubble, and reaches the document's capturing listener with the box as its target. */
  const scrollTo = (top: number, after: number, target: object = doc): void => {
    clock += after;
    const event = new Event("scroll");
    if (target === doc) root.scrollTop = top;
    else {
      (target as { scrollTop: number }).scrollTop = top;
      Object.defineProperty(event, "target", { value: target });
    }
    doc.dispatchEvent(event);
  };
  return { doc, fling, scrollTo, advance: (ms: number) => { clock += ms; } };
}

describe("a page flung past", () => {
  it("holds what is on screen while the page moves faster than two screens a second, and goes once it settles", () => {
    const { fling, scrollTo, advance } = page();
    scrollTo(0, 0);
    // Reading pace: a few hundred pixels a second on an 800-pixel screen.
    for (let i = 1; i <= 10; i++) scrollTo(i * 5, 16);
    expect(fling.delay()).toBe(0);
    // A fling: 120 px a frame, 7500 px a second.
    for (let i = 1; i <= 10; i++) scrollTo(50 + i * 120, 16);
    expect(fling.delay()).toBeGreaterThan(0);
    expect(fling.delay()).toBeLessThanOrEqual(150);
    advance(160);
    expect(fling.delay()).toBe(0);
  });

  it("is not let go by a scroll's end between the steps of a script's scroll, only by the pause after", () => {
    const { doc, fling, scrollTo, advance } = page();
    scrollTo(0, 0);
    for (let i = 1; i <= 5; i++) {
      scrollTo(i * 100, 13);
      doc.dispatchEvent(new Event("scrollend"));
    }
    expect(fling.delay()).toBeGreaterThan(0);
    advance(150);
    expect(fling.delay()).toBe(0);
  });

  it("measures a scrolling box against its own height, and two scrolls apart are no speed", () => {
    const { fling, scrollTo, advance } = page();
    const box = { scrollTop: 0, clientHeight: 200 };
    // 500 px a second is two and a half of this box's screens: a fling inside it.
    scrollTo(0, 0, box);
    scrollTo(8, 16, box);
    expect(fling.delay()).toBeGreaterThan(0);
    advance(150);
    // A jump of a screen after a long pause is a page turned, not a speed.
    scrollTo(1000, 1000);
    scrollTo(1800, 1000);
    expect(fling.delay()).toBe(0);
  });

  it("follows nothing once stopped", () => {
    const { fling, scrollTo } = page();
    fling.watch(false);
    scrollTo(0, 0);
    scrollTo(5000, 16);
    expect(fling.delay()).toBe(0);
  });
});
