// test/node/windowsProps.test.ts — properties of the word chunks and the pass plan.
//
// chunksOf() decides where a pass may begin or end, and planPasses() which characters of a
// long text the model sees, and how often. A plan that leaves a gap, goes backwards, reads a
// half other than twice or overruns the model's window shows up as text nobody read, a
// verdict one arbitrary cut decides, or a request the engine cuts. These run the planner
// over a few hundred seeded texts of every awkward shape — no sentence ends at all,
// paragraph joints, CJK full stops, one unbroken token far larger than a pass, lengths
// straddling one pass and the cap — and over random counts, and assert what the file
// documents. A failure names the seed to reproduce it.
import { describe, expect, it } from "vitest";
import {
  MAX_CHUNK_CHARS,
  MAX_READ_CHARS,
  MAX_WINDOWS,
  PASS_TOKENS,
  SNAP_TOKENS,
  WINDOW_CHARS,
  chunksOf,
  planPasses,
  readEnd,
  type Chunk,
  type TextSpan,
} from "../../lib/capture/windows";
import type { TokenCounts } from "../../lib/contract";
import { makeText, rng, seeds, type Rng, type TextOpts } from "./random";
import { MAX_UNIT_TEXT_CHARS } from "../../lib/dom/text";
import { planText } from "./fakeCounts";

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

/** A space between words: JavaScript counts the byte-order mark as one, the model form drops it. */
const SPACE = /[^\S\uFEFF]/;

/** Every invariant the chunks of one text must satisfy: what breaks one, or null. */
function chunkFault(text: string, end: number, chunks: Chunk[]): string | null {
  if ((chunks[0]?.start ?? 0) !== 0) return "does not start at 0";
  const starts = new Set(chunks.map((c) => c.start));
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.end <= c.start) return `empty chunk ${i}`;
    if (i > 0 && c.start !== chunks[i - 1].end) return `gap before chunk ${i}`;
    if (c.glued !== (c.start > 0 && !SPACE.test(text[c.start - 1]))) return `chunk ${i} glued wrong`;
    if (text.slice(c.start, c.end).trimEnd().length > MAX_CHUNK_CHARS) return `chunk ${i} too long`;
    const before = text.charCodeAt(c.start - 1);
    if (c.start > 0 && before >= 0xd800 && before <= 0xdbff) return `chunk ${i} splits a surrogate pair`;
  }
  if ((chunks[chunks.length - 1]?.end ?? 0) !== end) return "does not reach the end";
  // A pass can begin on every word.
  for (let at = 1; at < end; at++) if (SPACE.test(text[at - 1]) && !SPACE.test(text[at]) && !starts.has(at)) return `no chunk at word ${at}`;
  return null;
}

/** Every invariant the passes over counted chunks must satisfy: what breaks one, or null. */
function planFault(chunks: Chunk[], counts: TokenCounts, passes: TextSpan[]): string | null {
  const k = chunks.length;
  const inner = chunks.map((c, i) => (i === 0 || c.glued ? counts.alone[i] : counts.following[i]));
  const cum = [0];
  for (let i = 0; i < k; i++) cum.push(cum[i] + inner[i]);
  const total = cum[k];
  const index = new Map(chunks.map((c, i) => [c.start, i]));
  index.set(chunks[k - 1].end, k);
  const tokens = (s: TextSpan) => {
    const a = index.get(s.start)!;
    return cum[index.get(s.end)!] - cum[a] - inner[a] + counts.alone[a];
  };

  if (passes[0].start !== 0 || passes[passes.length - 1].end !== chunks[k - 1].end) return "does not cover the text";
  // Never cut inside a chunk.
  if (!passes.every((s) => index.has(s.start) && index.has(s.end))) return "cuts inside a chunk";
  const halves = Math.min(k, Math.ceil((2 * total) / (PASS_TOKENS - 2 * SNAP_TOKENS)));
  if (total <= PASS_TOKENS || halves < 3) return passes.length === 1 ? null : `${passes.length} passes where one fits`;
  if (passes.length !== halves - 1) return `${passes.length} passes over ${halves} halves`;
  for (let i = 0; i < passes.length; i++) {
    // Two neighbouring halves each: a pass ends where the one after next starts, and each
    // starts inside the one before it, after its start, and reaches past its end.
    if (i + 2 < passes.length && passes[i].end !== passes[i + 2].start) return `pass ${i} does not end where pass ${i + 2} starts`;
    if (i > 0 && !(passes[i].start > passes[i - 1].start && passes[i].start < passes[i - 1].end && passes[i].end > passes[i - 1].end))
      return `pass ${i} does not overlap the one before`;
  }
  // With no chunk larger than an edge may move, every pass fits and every edge lies within
  // reach of its even place.
  if (inner.every((n, i) => n <= SNAP_TOKENS && counts.alone[i] <= n + 2)) {
    const over = passes.findIndex((s) => tokens(s) > PASS_TOKENS);
    if (over >= 0) return `pass ${over} holds ${tokens(passes[over])} tokens`;
    const far = passes.slice(1).findIndex((s, i) => Math.abs(cum[index.get(s.start)!] - ((i + 1) * total) / halves) > SNAP_TOKENS);
    if (far >= 0) return `edge ${far + 1} out of reach`;
  }
  return null;
}

describe("chunksOf", () => {
  it("cuts every text into contiguous words, however little it offers to cut at", () => {
    forSeeds(200, (r) => {
      const text = makeText(r, shape(r));
      expect(chunkFault(text, text.length, chunksOf(text))).toBeNull();
    });
  });

  it("starts a chunk at a sentence with no space in front, and glues it on", () => {
    const text = "第一句话。第二句话。 Third one.";
    const chunks = chunksOf(text);
    expect(chunks.map((c) => [text.slice(c.start, c.end), c.glued])).toEqual([["第一句话。", false], ["第二句话。 ", true], ["Third ", false], ["one.", false]]);
  });
});

describe("planPasses", () => {
  const counted = (r: Rng, chunks: Chunk[]): TokenCounts => {
    const following = chunks.map(() => r.pick([r.int(1, 12), r.int(0, 3), r.int(20, 60), r.int(PASS_TOKENS / 2, 2 * PASS_TOKENS)]));
    return { following, alone: following.map((n) => Math.max(0, n + r.int(-1, 2))) };
  };

  it("reads a text that fits in one pass", () => {
    const text = "Two words.";
    expect(planPasses(text, chunksOf(text), { alone: [200, 300], following: [201, 310] })).toEqual([{ start: 0, end: 10 }]);
  });

  it("plans passes over two neighbouring halves each, over counted chunks of every size", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, shape(r));
      const chunks = chunksOf(text);
      const counts = counted(r, chunks);
      expect(planFault(chunks, counts, planPasses(text, chunks, counts))).toBeNull();
    });
  });

  it("divides a text of one-token words into halves even to the token", () => {
    for (let words = 511; words <= 4000; words += 97) {
      const text = Array.from({ length: words }, () => "a").join(" ");
      const chunks = chunksOf(text);
      const passes = planPasses(text, chunks, { alone: chunks.map(() => 1), following: chunks.map(() => 1) });
      const halves = Math.ceil((2 * words) / (PASS_TOKENS - 2 * SNAP_TOKENS));
      expect(passes).toHaveLength(halves - 1);
      const edges = [...new Set(passes.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
      const sizes = edges.slice(1).map((e, i) => text.slice(edges[i], e).split(" ").filter(Boolean).length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it("moves an edge to a sentence start within reach, and no further", () => {
    // 1 200 one-token words; a sentence starts every 50 words.
    const words = Array.from({ length: 1200 }, (_, i) => (i % 50 === 49 ? "end." : i % 50 === 0 ? "Start" : "word"));
    const text = words.join(" ");
    const chunks = chunksOf(text);
    const passes = planPasses(text, chunks, { alone: chunks.map(() => 1), following: chunks.map(() => 1) });
    for (const p of passes.slice(1)) {
      expect(text.slice(p.start).startsWith("Start")).toBe(true);
    }
  });
});

describe("the plan of a real text (four characters a token)", () => {
  it("covers everything that is read, by halves, within the model's window", () => {
    forSeeds(200, (r) => {
      const text = makeText(r, shape(r));
      const end = readEnd(text);
      const chunks = chunksOf(text, end);
      expect(chunkFault(text, end, chunks)).toBeNull();
      const passes = planText(text);
      expect(passes[0].start).toBe(0);
      expect(passes[passes.length - 1].end).toBe(end);
      expect(passes.length).toBeLessThanOrEqual(MAX_WINDOWS);
    });
  });

  it("honours the cap and reports what it did not read", () => {
    // Texts this long are 200 000 characters each: a dozen prove the bound.
    forSeeds(12, (r) => {
      const text = makeText(r, { targetChars: r.int(MAX_READ_CHARS, MAX_READ_CHARS + 20_000), newlines: true });
      const spans = planText(text);
      const read = spans[spans.length - 1].end;
      expect(read).toBeLessThanOrEqual(MAX_READ_CHARS);
      expect(read).toBeGreaterThan(MAX_READ_CHARS - WINDOW_CHARS);
      expect(spans.length).toBeLessThanOrEqual(MAX_WINDOWS);
    });
  });

  it("is deterministic: the same text plans the same way every time", () => {
    forSeeds(100, (r) => {
      const text = makeText(r, shape(r));
      expect(planText(text.slice())).toEqual(planText(text));
    });
  });
});

describe("the two bounds on a long text", () => {
  it("reads everything a unit may hold", () => {
    // MAX_UNIT_TEXT_CHARS (lib/dom/text.ts) guards against a dump in one node;
    // MAX_READ_CHARS is what the planner will read. Were the second ever the smaller, a
    // paragraph found on a page would be half-read again — the very thing the
    // eight-window cost cap did to a 4 220-word answer.
    expect(MAX_READ_CHARS).toBeGreaterThanOrEqual(MAX_UNIT_TEXT_CHARS);
    const text = "A sentence of plain words that ends here. ".repeat(Math.ceil(MAX_UNIT_TEXT_CHARS / 42)).slice(0, MAX_UNIT_TEXT_CHARS);
    const spans = planText(text);
    expect(spans[spans.length - 1].end).toBe(text.length);
  });
});
