// test/node/windowsProps.test.ts — properties of the window plan.
//
// planWindows() decides which characters of a long text the model ever sees, and the
// marks are painted per window, so a plan that overlaps, leaves a gap or overruns the
// budget shows up as text underlined twice, text underlined in a colour nobody measured,
// or a request the daemon cuts. These run the planner over a few hundred seeded texts of
// every awkward shape — no sentence ends at all, paragraph joints, CJK full stops, one
// unbroken token far larger than a window, lengths straddling the budget and the cap — and
// assert what the file documents. A failure names the seed to reproduce it.
import { describe, expect, it } from "vitest";
import {
  MAX_READ_CHARS,
  MAX_WINDOWS,
  MIN_WINDOW_CHARS,
  WINDOW_CHARS,
  planWindows,
  type TextSpan,
} from "../../lib/capture/windows";
import { makeText, rng, seeds, type Rng, type TextOpts } from "./random";
import { MAX_UNIT_TEXT_CHARS } from "../../lib/dom/text";

function forSeeds(count: number, check: (r: Rng, seed: number) => void): void {
  for (const seed of seeds(count)) {
    try {
      check(rng(seed), seed);
    } catch (e) {
      throw new Error(`seed ${seed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The shapes a unit's text arrives in; lengths straddle the budget and the cap. */
function shape(r: Rng): TextOpts {
  const targetChars = r.pick([
    r.int(1, WINDOW_CHARS),
    r.int(WINDOW_CHARS - 40, WINDOW_CHARS + 40),
    r.int(WINDOW_CHARS, 6 * WINDOW_CHARS),
    // Long, but not the bound itself (that has a test of its own, below): the bound is
    // 200 000 characters and a few hundred texts of that size would take minutes.
    r.int(8 * WINDOW_CHARS, 16 * WINDOW_CHARS),
  ]);
  return r.pick<TextOpts>([
    { targetChars, newlines: true },
    { targetChars, parts: r.int(2, 9), newlines: true }, // merged unit: "\n\n" joints
    { targetChars, cjk: 1 }, // CJK sentence marks, no space after them
    { targetChars, cjk: 0.5, noise: 0.2, newlines: true },
    { targetChars, unpunctuated: true }, // no sentence end anywhere
    { targetChars, hugeToken: r.int(WINDOW_CHARS, 3 * WINDOW_CHARS) },
    { targetChars: 1, hugeToken: r.int(2 * WINDOW_CHARS, 5 * WINDOW_CHARS) },
  ]);
}

/** Every invariant the plan of one text must satisfy. */
function checkPlan(text: string, spans: TextSpan[]): void {
  expect(spans.length).toBeGreaterThan(0);
  expect(spans.length).toBeLessThanOrEqual(MAX_WINDOWS);
  expect(spans[0].start).toBe(0);
  for (let i = 0; i < spans.length; i++) {
    expect(spans[i].end).toBeGreaterThan(spans[i].start);
    // Consecutive and non-overlapping: what one window ends, the next begins.
    if (i > 0) expect(spans[i].start).toBe(spans[i - 1].end);
  }
  const last = spans[spans.length - 1];
  expect(last.end).toBeLessThanOrEqual(text.length);
  expect(last.end).toBeLessThanOrEqual(MAX_READ_CHARS);
  // The windows put back together ARE the span that was read.
  expect(spans.map((s) => text.slice(s.start, s.end)).join("")).toBe(text.slice(0, last.end));
  // Never through the middle of a surrogate pair — half of one cannot be encoded.
  for (const s of spans) {
    const before = text.charCodeAt(s.start - 1);
    if (s.start > 0) expect(before >= 0xd800 && before <= 0xdbff).toBe(false);
  }
}

describe("planWindows", () => {
  it("returns ONE window identical to the input span for a text that fits", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, { targetChars: r.int(1, WINDOW_CHARS - 60), newlines: true, cjk: r.float() });
      if (text.length > WINDOW_CHARS) return; // the generator overshoots its target a little
      expect(planWindows(text)).toEqual([{ start: 0, end: text.length }]);
    });
  });

  it("plans consecutive, non-overlapping windows that cover the read span exactly", () => {
    forSeeds(300, (r) => checkPlan(...planned(r)));
  });

  it("keeps every window inside the character budget", () => {
    forSeeds(300, (r) => {
      const [, spans] = planned(r);
      for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(WINDOW_CHARS);
    });
  });

  it("makes no window shorter than the documented minimum unless the whole text is", () => {
    forSeeds(300, (r) => {
      const [text, spans] = planned(r);
      if (text.length <= WINDOW_CHARS) return; // one window, whatever its length
      for (const s of spans) expect(s.end - s.start).toBeGreaterThanOrEqual(MIN_WINDOW_CHARS);
    });
  });

  it("honours the cap and reports what it did not read", () => {
    // Texts this long are 200 000 characters each since the cost cap went: a dozen prove
    // the bound as well as two hundred did, in a fraction of the time.
    forSeeds(12, (r) => {
      const text = makeText(r, { targetChars: r.int(MAX_READ_CHARS, MAX_READ_CHARS + 20_000), newlines: true });
      const spans = planWindows(text);
      checkPlan(text, spans);
      expect(spans.length).toBe(MAX_WINDOWS);
      const read = spans[spans.length - 1].end;
      expect(read).toBeLessThanOrEqual(MAX_READ_CHARS);
      // The cap costs at most one window's worth of text, never more.
      expect(read).toBeGreaterThan(MAX_READ_CHARS - WINDOW_CHARS);
    });
  });

  it("is deterministic: the same text plans the same way every time", () => {
    forSeeds(200, (r) => {
      const [text, spans] = planned(r);
      expect(planWindows(text)).toEqual(spans);
      expect(planWindows(text.slice())).toEqual(spans);
    });
  });
});

/** One seeded text and its plan — every property but the first works on this pair. */
function planned(r: Rng): [string, TextSpan[]] {
  const text = makeText(r, shape(r));
  return [text, planWindows(text)];
}

describe("the two bounds on a long text", () => {
  it("reads everything a unit may hold", () => {
    // MAX_UNIT_TEXT_CHARS (lib/dom/text.ts) guards against a dump in one node;
    // MAX_READ_CHARS is what the window planner will read. Were the second ever the
    // smaller, a paragraph found on a page would be half-read again — the very thing the
    // eight-window cost cap did to a 4 220-word answer.
    expect(MAX_READ_CHARS).toBeGreaterThanOrEqual(MAX_UNIT_TEXT_CHARS);
    const text = "A sentence of plain words that ends here. ".repeat(Math.ceil(MAX_UNIT_TEXT_CHARS / 42)).slice(0, MAX_UNIT_TEXT_CHARS);
    const spans = planWindows(text);
    expect(spans[spans.length - 1].end).toBe(text.length);
  });
});
