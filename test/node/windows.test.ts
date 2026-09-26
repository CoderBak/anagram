// test/node/windows.test.ts — reading a long text in passes: what travels, in how many
// calls, and what comes back when the engine cuts a pass, fails one, or answers nothing.
import { describe, expect, it } from "vitest";
import { readInWindows, unitVerdict, blockText, fitsWithoutCounting, wordsOf, requestSlices, MAX_BLOCK_CHARS, MAX_WINDOWS, PASS_TOKENS, REQUEST_BLOCKS, REQUEST_CHARS, type CountTokens, type ScoreBlocks, type WindowVerdict } from "../../lib/capture/windows";
import { ROUTER_LIMITS } from "../../lib/backend/router";
import type { ScoreBlock, ScoreResult } from "../../lib/contract";
import { modelText } from "../../lib/dom/text";
import { fakeCounts, planText, spanTokens } from "./fakeCounts";

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

/** A token counter at the fake engine's rate, recording what it was asked. */
function counter() {
  const asked: string[][] = [];
  const countTokens: CountTokens = async (texts) => {
    asked.push(texts);
    return fakeCounts(texts);
  };
  return { asked, countTokens };
}

/** Every character of [0, end) inside some pass. */
const covered = (passes: readonly { start: number; end: number }[], end: number): boolean =>
  passes[0].start === 0 && passes.every((p, i) => i === 0 || p.start <= passes[i - 1].end) && passes[passes.length - 1].end === end;

/** Passes over two neighbouring halves each: every pass ends where the one after next starts. */
const byHalves = (passes: readonly { start: number; end: number }[]): boolean =>
  passes.every((p, i) => i + 2 >= passes.length || p.end === passes[i + 2].start) &&
  passes.every((p, i) => i === 0 || (p.start > passes[i - 1].start && p.start < passes[i - 1].end && p.end > passes[i - 1].end));

describe("readInWindows", () => {
  it("sends a text that certainly fits exactly as before: one block, the unit's own id, its model form, no count", async () => {
    const text = "It costs ``nothing'' --- 74.1\\% of the time. " + prose(4);
    expect(fitsWithoutCounting(text)).toBe(true);
    const { calls, scoreBlocks } = recorder();
    const { asked, countTokens } = counter();
    const read = await readInWindows([{ id: "u_1", text, order: 7 }], scoreBlocks, countTokens);
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ id: "u_1", text: modelText(text) }]);
    expect(read.get("u_1")).toEqual([{ start: 0, end: text.length, result: real(calls[0][0]) }]);
  });

  it("counts a text that may not fit, and reads it in one pass as before when it does", async () => {
    const text = prose(12);
    expect(fitsWithoutCounting(text)).toBe(false);
    const { calls, scoreBlocks } = recorder();
    const { asked, countTokens } = counter();
    const read = await readInWindows([{ id: "u_1", text, order: 0 }], scoreBlocks, countTokens);
    expect(asked).toHaveLength(1);
    expect(calls[0]).toEqual([{ id: "u_1", text: modelText(text) }]);
    expect(read.get("u_1")!.map(({ start, end }) => [start, end])).toEqual([[0, text.length]]);
  });

  it("counts every distinct word of every long text in ONE call, then sends every pass of every unit in ONE call", async () => {
    const long = prose(60);
    const short = prose(4);
    const { calls, owners, scoreBlocks } = recorder();
    const { asked, countTokens } = counter();
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }, { id: "u_b", text: short, order: 1 }], scoreBlocks, countTokens);
    expect(asked).toHaveLength(1);
    expect(new Set(asked[0]).size).toBe(asked[0].length);
    expect(new Set(asked[0])).toEqual(new Set(wordsOf(long).words));
    expect(calls).toHaveLength(1);
    const passes = read.get("u_a")!;
    expect(passes.map(({ start, end }) => ({ start, end }))).toEqual(planText(long));
    expect(passes.length).toBeGreaterThan(2);
    expect(covered(passes, long.length)).toBe(true);
    expect(byHalves(passes)).toBe(true);
    expect(passes.every((p) => spanTokens(long, p) <= PASS_TOKENS)).toBe(true);
    // Every edge on a sentence start: a pass opens on a capital and closes on a full stop.
    expect(passes.every((p) => /^Sentence number \d+ /.test(long.slice(p.start)) && /\.\s*$/.test(long.slice(p.start, p.end)))).toBe(true);
    expect(calls[0].map((b) => b.text)).toEqual([...passes.map((p) => blockText(long, p)), modelText(short)]);
    expect(new Set(calls[0].map((b) => b.id)).size).toBe(passes.length + 1);
    expect([...owners[0].values()]).toEqual([...passes.map(() => "u_a"), "u_b"]);
  });

  it("makes a text whose words went uncounted Unavailable, and reads the others", async () => {
    const long = prose(60);
    const { calls, scoreBlocks } = recorder();
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }, { id: "u_b", text: prose(4), order: 1 }], scoreBlocks, async () => null);
    expect(calls.flat().map((b) => b.id)).toEqual(["u_b"]);
    expect(unitVerdict("u_a", long.length, read.get("u_a")!).result.degraded).toBe(true);
    expect(read.get("u_b")).toHaveLength(1);
  });

  it("re-reads a pass the engine had to cut, once, in two halves", async () => {
    const long = prose(60);
    const plan = planText(long);
    const dense = blockText(long, plan[1]);
    const { calls, scoreBlocks } = recorder((b) => real(b, b.text === dense ? { truncated: true, tokens: 512 } : {}));
    const windows = (await readInWindows([{ id: "u_a", text: long, order: 0 }], scoreBlocks, counter().countTokens)).get("u_a")!;
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
    const windows = (await readInWindows([{ id: "u_d", text, order: 0 }], scoreBlocks, counter().countTokens)).get("u_d")!;
    expect(calls.map((c) => c.length)).toEqual([1, 2]);
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => text.slice(w.start, w.end)).join("")).toBe(text);
  });

  it("keeps a half that is STILL cut, and the verdict says so — no third round, no silent gap", async () => {
    const text = prose(12);
    const { calls, scoreBlocks } = recorder((b) => real(b, { truncated: true, tokens: 512 }));
    const windows = (await readInWindows([{ id: "u_d", text, order: 0 }], scoreBlocks, counter().countTokens)).get("u_d")!;
    expect(calls).toHaveLength(2);
    expect(unitVerdict("u_d", text.length, windows).result.truncated).toBe(true);
  });

  it("gives a unit no verdict at all while one of its passes is unanswered; its neighbours keep theirs", async () => {
    const long = prose(60);
    const lost = blockText(long, planText(long)[2]);
    const { scoreBlocks } = recorder((b) => (b.text === lost ? undefined : real(b)));
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }, { id: "u_b", text: prose(4), order: 1 }], scoreBlocks, counter().countTokens);
    expect(read.has("u_a")).toBe(false);
    expect(read.get("u_b")).toHaveLength(1);
  });

  it("turns one degraded pass into an Unavailable unit", async () => {
    const long = prose(60);
    const failed = blockText(long, planText(long)[1]);
    const { scoreBlocks } = recorder((b) => real(b, b.text === failed ? { degraded: true } : {}));
    const windows = (await readInWindows([{ id: "u_a", text: long, order: 0 }], scoreBlocks, counter().countTokens)).get("u_a")!;
    expect(windows).toHaveLength(planText(long).length);
    expect(unitVerdict("u_a", long.length, windows).result.degraded).toBe(true);
  });
});

describe("combining overlapping passes", () => {
  const pass = (start: number, end: number, probs: number[], extra: Partial<ScoreResult> = {}): WindowVerdict =>
    ({ start, end, result: { id: `${start}-${end}`, bucket: probs.indexOf(Math.max(...probs)), probs, score: (probs[1] + 2 * probs[2] + 3 * probs[3]) / 3, ...extra } });
  const human = [1, 0, 0, 0];
  const ai = [0, 0, 0, 1];

  it("judges every stretch between two pass edges by the mean of the passes that read it", () => {
    const v = unitVerdict("u", 150, [pass(0, 100, human), pass(50, 150, ai)]);
    expect(v.stretches.map((s) => [s.start, s.end])).toEqual([[0, 50], [50, 100], [100, 150]]);
    expect(v.stretches[0].result.probs).toEqual(human);
    expect(v.stretches[2].result.probs).toEqual(ai);
    expect(v.stretches[1].result.probs).toEqual([0.5, 0, 0, 0.5]);
    expect(v.result.score).toBeCloseTo(0.5);
  });

  it("counts both readings of a half alike, however long the passes around it", () => {
    const v = unitVerdict("u", 150, [pass(0, 100, human), pass(40, 150, ai)]);
    expect(v.stretches.find((s) => s.start === 40)!.result.probs).toEqual([0.5, 0, 0, 0.5]);
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

it("keeps original source spans when repeated escapes and invisibles contract", async () => {
  const raw = (`Original 1–2–3 costs \\\\% and A\u200b\u0301 remains mapped to its source. ` + prose(8)).repeat(5);
  const spans = planText(raw), {calls, scoreBlocks} = recorder();
  const windows = (await readInWindows([{id:"mapped",text:raw,order:0}],scoreBlocks,counter().countTokens)).get("mapped")!;
  expect(spans.length).toBeGreaterThan(1);
  expect(windows.map(({start,end}) => [start,end])).toEqual(spans.map(({start,end}) => [start,end]));
  expect(covered(windows, raw.length)).toBe(true);
  expect(calls.flat().map(({text}) => text)).toEqual(spans.map((span) => modelText(raw.slice(span.start,span.end))));
  expect(calls.flat().some(({text}) => text.includes("1–2–3 costs % and \u00c1"))).toBe(true);
});

describe("the model form in passes", () => {
  const written = "“Quoted” words — and a soft\u00ADhyphen, the ﬁnal 👨\u200D👩\u200D👧 emoji…\n\nNext -- paragraph™ with\u200Bzero width, by\uFEFFtes.";

  it("counts each word in the form the pass sends it, so the counts add up to the pass", () => {
    const { words } = wordsOf(written);
    expect(words).toEqual(["“Quoted”", "words", "—", "and", "a", "softhyphen,", "the", "final", "👨\u200D👩\u200D👧", "emoji…",
      "Next", "--", "paragraph™", "withzero", "width,", "bytes."]);
    expect(words.join(" ")).toBe(modelText(written).replace(/\n/g, " "));
  });

  it("measures whether a text fits on its typography as written", () => {
    expect(fitsWithoutCounting(`"${"a".repeat(508)}"`)).toBe(true);
    expect(fitsWithoutCounting(`“${"a".repeat(508)}”`)).toBe(false);
  });

  it("keeps the line breaks of a pass that opens the text, and sends a later pass's as spaces", () => {
    const text = `Sure! Here is a rewrite.\n\n${prose(3)}\n\nHere is the second part.\n\n${prose(3)}`;
    const later = text.indexOf("Here is the second");
    expect(blockText(text, { start: 0, end: text.length })).toBe(modelText(text));
    expect(blockText(text, { start: 0, end: text.length })).toContain("rewrite.\nSentence number 0");
    expect(blockText(text, { start: later, end: text.length })).toBe(modelText(text.slice(later)).replace(/\n/g, " "));
    expect(blockText(text, { start: later, end: text.length })).not.toContain("\n");
  });
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
