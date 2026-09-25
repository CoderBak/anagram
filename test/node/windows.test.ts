// test/node/windows.test.ts — reading a long text in passes: what travels, in how many
// calls, and what comes back when the engine cuts a pass, fails one, or answers nothing.
import { describe, expect, it } from "vitest";
import { readInWindows, unitVerdict, planWindows, blockText, cutPieces, readEnd, requestSlices, MAX_BLOCK_CHARS, MAX_WINDOWS, ONE_PASS_CHARS, PASS_TOKENS, REQUEST_BLOCKS, REQUEST_CHARS, type CountTokens, type ScoreBlocks, type WindowVerdict } from "../../lib/capture/windows";
import { ROUTER_LIMITS } from "../../lib/backend/router";
import type { ScoreBlock, ScoreResult } from "../../lib/contract";
import { canonicalForScoring } from "../../lib/dom/text";

const sentence = (i: number): string => `Sentence number ${i} keeps walking through the quiet town while the rain falls on it.`;
const prose = (n: number): string => Array.from({ length: n }, (_, i) => sentence(i)).join(" ");
const real = (b: ScoreBlock, extra: Partial<ScoreResult> = {}): ScoreResult => ({ id: b.id, bucket: 3, probs: [0, 0, 0.1, 0.9], score: 0.9666, tokens: Math.ceil(b.text.length / 4), ...extra });

/** A scoreBlocks that records every call and answers through `answer` (undefined = no answer). */
function recorder(answer: (b: ScoreBlock) => ScoreResult | undefined = real) {
  const calls: ScoreBlock[][] = [];
  const owners: Array<ReadonlyMap<string, string>> = [];
  const scoreBlocks: ScoreBlocks = async (blocks, own) => {
    calls.push(blocks);
    owners.push(own);
    const out = new Map<string, ScoreResult>();
    for (const b of blocks) {
      const r = answer(b);
      if (r) out.set(b.id, r);
    }
    return out;
  };
  return { calls, owners, scoreBlocks };
}

/** A token counter at four characters a token (the fake engine's rate), recording its calls. */
function counter() {
  const asked: string[][] = [];
  const countTokens: CountTokens = async (texts) => {
    asked.push(texts);
    return texts.map((t) => Math.ceil(t.length / 4));
  };
  return { asked, countTokens };
}

/** Every character of [0, end) inside some pass. */
const covered = (passes: readonly { start: number; end: number }[], end: number): boolean =>
  passes[0].start === 0 && passes.every((p, i) => i === 0 || p.start <= passes[i - 1].end) && passes[passes.length - 1].end === end;

describe("readInWindows", () => {
  it("sends a text that fits exactly as before: one block, the unit's own id, its canonical form, no count", async () => {
    const text = "It costs ``nothing'' --- 74.1\\% of the time. " + prose(8);
    expect(text.length).toBeLessThanOrEqual(ONE_PASS_CHARS);
    const { calls, scoreBlocks } = recorder();
    const { asked, countTokens } = counter();
    const read = await readInWindows([{ id: "u_1", text, order: 7 }], scoreBlocks, countTokens);
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ id: "u_1", text: canonicalForScoring(text) }]);
    expect(read.get("u_1")).toEqual([{ start: 0, end: text.length, result: real(calls[0][0]) }]);
  });

  it("counts the pieces of every long text in ONE call, then sends every pass of every unit in ONE call", async () => {
    const long = prose(60);
    const short = prose(9);
    const { calls, owners, scoreBlocks } = recorder();
    const { asked, countTokens } = counter();
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }, { id: "u_b", text: short, order: 1 }], scoreBlocks, countTokens);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(cutPieces(long, readEnd(long)).map((p) => blockText(long, p)));
    expect(calls).toHaveLength(1);
    const passes = read.get("u_a")!;
    expect(passes.length).toBeGreaterThan(2);
    expect(covered(passes, long.length)).toBe(true);
    // Overlapping, and each within one pass of the model at the counter's rate.
    expect(passes.slice(1).every((p, i) => p.start < passes[i].end)).toBe(true);
    expect(passes.every((p) => Math.ceil(canonicalForScoring(long.slice(p.start, p.end)).length / 4) <= PASS_TOKENS)).toBe(true);
    expect(calls[0].map((b) => b.text)).toEqual([...passes.map((p) => blockText(long, p)), canonicalForScoring(short)]);
    expect(new Set(calls[0].map((b) => b.id)).size).toBe(passes.length + 1);
    expect([...owners[0].values()]).toEqual([...passes.map(() => "u_a"), "u_b"]);
  });

  it("plans on estimates when the engine cannot count, exactly as planWindows does", async () => {
    const long = prose(60);
    const { calls, scoreBlocks } = recorder();
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }], scoreBlocks, async () => null);
    expect(read.get("u_a")!.map(({ start, end }) => ({ start, end }))).toEqual(planWindows(long));
    expect(calls).toHaveLength(1);
  });

  it("re-reads a pass the engine had to cut, once, in two halves", async () => {
    const long = prose(60);
    const plan = planWindows(long);
    const dense = blockText(long, plan[1]);
    const { calls, scoreBlocks } = recorder((b) => real(b, b.text === dense ? { truncated: true, tokens: 512 } : {}));
    const windows = (await readInWindows([{ id: "u_a", text: long, order: 0 }], scoreBlocks)).get("u_a")!;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(2);
    expect(calls[1].map((b) => b.text).join(" ")).toBe(dense);
    expect(windows).toHaveLength(plan.length + 1);
    expect(covered(windows, long.length)).toBe(true);
    expect(windows.some((w) => w.result.truncated)).toBe(false);
    expect(unitVerdict("u_a", long.length, windows).result.truncated).toBeUndefined();
  });

  it("also re-reads a ONE-pass text that turned out denser than a pass", async () => {
    const text = prose(12);
    const { calls, scoreBlocks } = recorder((b) => real(b, b.id === "u_d" ? { truncated: true, tokens: 512 } : {}));
    const windows = (await readInWindows([{ id: "u_d", text, order: 0 }], scoreBlocks)).get("u_d")!;
    expect(calls.map((c) => c.length)).toEqual([1, 2]);
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => text.slice(w.start, w.end)).join("")).toBe(text);
  });

  it("keeps a half that is STILL cut, and the verdict says so — no third round, no silent gap", async () => {
    const text = prose(12);
    const { calls, scoreBlocks } = recorder((b) => real(b, { truncated: true, tokens: 512 }));
    const windows = (await readInWindows([{ id: "u_d", text, order: 0 }], scoreBlocks)).get("u_d")!;
    expect(calls).toHaveLength(2);
    expect(unitVerdict("u_d", text.length, windows).result.truncated).toBe(true);
  });

  it("gives a unit no verdict at all while one of its passes is unanswered; its neighbours keep theirs", async () => {
    const long = prose(60);
    const lost = blockText(long, planWindows(long)[2]);
    const { scoreBlocks } = recorder((b) => (b.text === lost ? undefined : real(b)));
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }, { id: "u_b", text: prose(9), order: 1 }], scoreBlocks);
    expect(read.has("u_a")).toBe(false);
    expect(read.get("u_b")).toHaveLength(1);
  });

  it("turns one degraded pass into an Unavailable unit", async () => {
    const long = prose(60);
    const failed = blockText(long, planWindows(long)[1]);
    const { scoreBlocks } = recorder((b) => real(b, b.text === failed ? { degraded: true } : {}));
    const windows = (await readInWindows([{ id: "u_a", text: long, order: 0 }], scoreBlocks)).get("u_a")!;
    expect(windows).toHaveLength(planWindows(long).length);
    expect(unitVerdict("u_a", long.length, windows).result.degraded).toBe(true);
  });
});

describe("combining overlapping passes", () => {
  const pass = (start: number, end: number, probs: number[], extra: Partial<ScoreResult> = {}): WindowVerdict =>
    ({ start, end, result: { id: `${start}-${end}`, bucket: probs.indexOf(Math.max(...probs)), probs, score: (probs[1] + 2 * probs[2] + 3 * probs[3]) / 3, ...extra } });
  const human = [1, 0, 0, 0];
  const ai = [0, 0, 0, 1];

  it("judges every stretch between two pass edges by the passes that read it", () => {
    const v = unitVerdict("u", 150, [pass(0, 100, human), pass(50, 150, ai)]);
    expect(v.stretches.map((s) => [s.start, s.end])).toEqual([[0, 50], [50, 100], [100, 150]]);
    expect(v.stretches[0].result.probs).toEqual(human);
    expect(v.stretches[2].result.probs).toEqual(ai);
    // Both passes cut 25 characters from the middle stretch's centre: they count alike.
    expect(v.stretches[1].result.probs[0]).toBeCloseTo(0.5);
    expect(v.stretches[1].result.probs[3]).toBeCloseTo(0.5);
    expect(v.result.score).toBeCloseTo(0.5);
  });

  it("counts a pass less where it cut the text than where it read with context", () => {
    // The first pass reads [40, 100) 30 characters from its cut at 100 (of a half of 50);
    // the second 30 from its cut at 40, of a half of 55 — so it counts for less.
    const v = unitVerdict("u", 150, [pass(0, 100, human), pass(40, 150, ai)]);
    const middle = v.stretches.find((s) => s.start === 40)!;
    expect(middle.result.probs[0]).toBeGreaterThan(middle.result.probs[3]);
  });

  it("reads passes that do not overlap as before: the length-weighted mean", () => {
    const v = unitVerdict("u", 4000, [pass(0, 1000, [0.9, 0.1, 0, 0]), pass(1000, 4000, [0, 0, 0.2, 0.8])]);
    expect(v.result.probs.map((p) => +p.toFixed(6))).toEqual([0.225, 0.025, 0.15, 0.6]);
    expect(v.stretches).toHaveLength(2);
  });

  it("leaves a pass the language gate refused out of the stretches and the mean", () => {
    const fr = pass(40, 150, [0.25, 0.25, 0.25, 0.25], { unsupported: true, lang: "fr" });
    const v = unitVerdict("u", 150, [pass(0, 100, human), fr]);
    expect(v.stretches.map((s) => [s.start, s.end])).toEqual([[0, 100]]);
    expect(v.result.probs).toEqual(human);
  });
});

it("keeps original source spans when canonical ranges, repeated escapes and joined accents contract", async () => {
  const raw = (`Original 1–2–3 costs \\\\% and A​́ remains mapped to its source. ` + prose(8)).repeat(5);
  const spans = planWindows(raw), {calls, scoreBlocks} = recorder();
  const windows = (await readInWindows([{id:"mapped",text:raw,order:0}],scoreBlocks)).get("mapped")!;
  expect(windows.map(({start,end}) => [start,end])).toEqual(spans.map(({start,end}) => [start,end]));
  expect(covered(windows, raw.length)).toBe(true);
  expect(calls.flat().map(({text}) => text)).toEqual(spans.map((span) => canonicalForScoring(raw.slice(span.start,span.end))));
  expect(calls.flat().some(({text}) => text.includes("1-2-3 costs % and Á"))).toBe(true);
});

it("sends the most a batch can hold in requests the worker takes, four of them at once included", () => {
  // Every window of the longest unit, NFKC-expanded to the block cap, and its halves.
  const blocks = Array.from({length: MAX_WINDOWS * 2}, (_, i) => ({id: `w${i}`, text: "x".repeat(MAX_BLOCK_CHARS)}));
  const slices = requestSlices(blocks, (b) => b.text.length);
  expect(slices.flat()).toEqual(blocks);
  for (const slice of slices) {
    expect(slice.length).toBeLessThanOrEqual(REQUEST_BLOCKS);
    expect(slice.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(REQUEST_CHARS);
  }
  // lib/access/messages.ts refuses past 256 blocks or 256 000 characters; the router answers
  // Unavailable past its per-page share, which the orchestrator's four batches split.
  expect(REQUEST_BLOCKS * 4).toBeLessThanOrEqual(Math.min(256, ROUTER_LIMITS.documentBlocks));
  expect(REQUEST_CHARS * 4).toBeLessThanOrEqual(Math.min(256_000, ROUTER_LIMITS.documentChars));
  expect(REQUEST_CHARS * 6 + REQUEST_BLOCKS * 100).toBeLessThanOrEqual(900_000);
  expect(requestSlices([{id: "one", text: "x".repeat(10)}], (b) => b.text.length)).toHaveLength(1);
});
