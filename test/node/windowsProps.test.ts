// test/node/windowsProps.test.ts — properties of the piece cut and the pass plan.
//
// cutPieces() decides where a pass may begin or end, and planPasses() which characters of a
// long text the model ever sees, and how often. A plan that leaves a gap, goes backwards or
// overruns the model's window shows up as text nobody read, a verdict that depends on one
// arbitrary cut, or a request the engine cuts. These run the planner over a few hundred
// seeded texts of every awkward shape — no sentence ends at all, paragraph joints, CJK full
// stops, one unbroken token far larger than a window, lengths straddling the one-pass bound
// and the cap — and assert what the file documents. A failure names the seed to reproduce it.
import { describe, expect, it } from "vitest";
import {
  MAX_PIECE_CHARS,
  MAX_READ_CHARS,
  MAX_WINDOWS,
  ONE_PASS_CHARS,
  PASS_TOKENS,
  WINDOW_CHARS,
  cutPieces,
  estimateTokens,
  planPasses,
  planWindows,
  readEnd,
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

const noSurrogateCut = (text: string, at: number): void => {
  const before = text.charCodeAt(at - 1);
  if (at > 0) expect(before >= 0xd800 && before <= 0xdbff).toBe(false);
};

/** Every invariant the pieces of one text must satisfy. */
function checkPieces(text: string, end: number, pieces: TextSpan[]): void {
  expect(pieces[0]?.start ?? 0).toBe(0);
  for (let i = 0; i < pieces.length; i++) {
    expect(pieces[i].end).toBeGreaterThan(pieces[i].start);
    expect(pieces[i].end - pieces[i].start).toBeLessThanOrEqual(MAX_PIECE_CHARS);
    if (i > 0) expect(pieces[i].start).toBe(pieces[i - 1].end);
    noSurrogateCut(text, pieces[i].start);
  }
  expect(pieces[pieces.length - 1]?.end ?? 0).toBe(end);
}

/** Every invariant the passes over pieces holding `tokens` must satisfy. */
function checkPasses(pieces: TextSpan[], tokens: number[], passes: TextSpan[], limit: number): void {
  const edges = new Set(pieces.flatMap((p) => [p.start, p.end]));
  const tokensIn = (s: TextSpan) =>
    pieces.reduce((n, p, i) => (p.start >= s.start && p.end <= s.end ? n + tokens[i] : n), 0);
  expect(passes.length).toBeGreaterThan(0);
  expect(passes[0].start).toBe(pieces[0].start);
  expect(passes[passes.length - 1].end).toBe(pieces[pieces.length - 1].end);
  for (let i = 0; i < passes.length; i++) {
    const s = passes[i];
    // Never cut inside a piece.
    expect(edges.has(s.start) && edges.has(s.end)).toBe(true);
    // Inside the window — or one piece too large for it, on its own.
    const inside = pieces.filter((p) => p.start >= s.start && p.end <= s.end).length;
    if (inside > 1) expect(tokensIn(s)).toBeLessThanOrEqual(limit);
    if (i > 0) {
      // Forwards, and no gap: each starts past the one before and no later than its end.
      expect(s.start).toBeGreaterThan(passes[i - 1].start);
      expect(s.end).toBeGreaterThan(passes[i - 1].end);
      expect(s.start).toBeLessThanOrEqual(passes[i - 1].end);
    }
  }
  // About as many passes as half-pass steps across the text, not more.
  const total = tokens.reduce((a, b) => a + b, 0);
  if (total > limit) expect(passes.length).toBeLessThanOrEqual(Math.ceil((2 * total) / limit) + 2);
}

describe("cutPieces", () => {
  it("cuts every text into short, contiguous pieces, however little it offers to cut at", () => {
    forSeeds(200, (r) => {
      const text = makeText(r, shape(r));
      checkPieces(text, text.length, cutPieces(text));
    });
  });

  it("prefers a sentence start, then a clause mark, then a word", () => {
    const sentences = "One sentence ends here. Another follows it now. ".repeat(20);
    expect(cutPieces(sentences).every((p) => /^\S/.test(sentences.slice(p.start, p.end)))).toBe(true);
    const clauses = ("a clause runs on, and on; " + "word ".repeat(10)).repeat(20);
    const cuts = cutPieces(clauses).slice(1).map((p) => clauses.slice(p.start - 2, p.start));
    expect(cuts.every((c) => /[,;] $/.test(c) || / $/.test(c))).toBe(true);
    expect(cuts.some((c) => /[,;] $/.test(c))).toBe(true);
  });
});

describe("planPasses", () => {
  it("reads pieces that fit the window in one pass", () => {
    const pieces = [{ start: 0, end: 10 }, { start: 10, end: 30 }];
    expect(planPasses(pieces, [100, 200])).toEqual([{ start: 0, end: 30 }]);
  });

  it("plans full, overlapping passes over counted pieces of every size", () => {
    forSeeds(300, (r) => {
      const k = r.int(2, 400);
      const pieces: TextSpan[] = [];
      const tokens: number[] = [];
      for (let i = 0, at = 0; i < k; i++) {
        const len = r.int(1, 300);
        pieces.push({ start: at, end: at + len });
        at += len;
        // Mostly ordinary pieces, some tiny, now and then one larger than a pass.
        tokens.push(r.pick([r.int(1, 80), r.int(1, 8), r.int(100, 300), r.int(PASS_TOKENS, 2 * PASS_TOKENS)]));
      }
      const limit = PASS_TOKENS - 8;
      checkPasses(pieces, tokens, planPasses(pieces, tokens), limit);
    });
  });

  it("plans exactly one pass per half-pass step when pieces are one token each", () => {
    const limit = PASS_TOKENS - 8;
    for (let total = limit + 1; total <= limit * 8; total += 7) {
      const pieces = Array.from({ length: total }, (_, i) => ({ start: i, end: i + 1 }));
      const passes = planPasses(pieces, pieces.map(() => 1));
      expect(passes.length).toBe(1 + Math.ceil((total - limit) / (limit / 2)));
      expect(passes.every((s) => s.end - s.start === limit)).toBe(true);
    }
  });

  it("reads every token past the first half pass at least twice when pieces are small", () => {
    const pieces = Array.from({ length: 200 }, (_, i) => ({ start: i * 40, end: (i + 1) * 40 }));
    const tokens = pieces.map(() => 10);
    const passes = planPasses(pieces, tokens);
    const limit = PASS_TOKENS - 8;
    for (let at = limit * 2; at < 8000 - limit * 2; at += 37) {
      expect(passes.filter((s) => s.start <= at && s.end > at).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("planWindows (planned on estimates)", () => {
  it("returns ONE pass identical to the input span for a text short enough", () => {
    forSeeds(100, (r) => {
      const text = makeText(r, { targetChars: r.int(1, ONE_PASS_CHARS), newlines: true }).slice(0, ONE_PASS_CHARS);
      expect(planWindows(text)).toEqual([{ start: 0, end: text.length }]);
    });
  });

  it("plans passes over the text's own pieces that hold everything that is read", () => {
    forSeeds(200, (r) => {
      const [text, spans] = planned(r);
      if (text.length <= ONE_PASS_CHARS) return;
      const pieces = cutPieces(text, readEnd(text));
      checkPieces(text, readEnd(text), pieces);
      const tokens = pieces.map((p) => estimateTokens(text.slice(p.start, p.end)));
      checkPasses(pieces, tokens, spans, PASS_TOKENS - 8);
      expect(spans.length).toBeLessThanOrEqual(MAX_WINDOWS);
    });
  });

  it("honours the cap and reports what it did not read", () => {
    // Texts this long are 200 000 characters each: a dozen prove the bound.
    forSeeds(12, (r) => {
      const text = makeText(r, { targetChars: r.int(MAX_READ_CHARS, MAX_READ_CHARS + 20_000), newlines: true });
      const spans = planWindows(text);
      const read = spans[spans.length - 1].end;
      expect(read).toBeLessThanOrEqual(MAX_READ_CHARS);
      expect(read).toBeGreaterThan(MAX_READ_CHARS - WINDOW_CHARS);
      expect(spans.length).toBeLessThanOrEqual(MAX_WINDOWS);
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
