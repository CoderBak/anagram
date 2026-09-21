// test/node/windows.test.ts — reading a long text in windows: what travels, in how many
// calls, and what comes back when the daemon cuts a window, fails one, or answers nothing.
import { describe, expect, it } from "vitest";
import { readInWindows, unitVerdict, planWindows, blockText, WINDOW_CHARS, type ScoreBlocks } from "../../lib/capture/windows";
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

describe("readInWindows", () => {
  it("sends a text that fits exactly as before: one block, the unit's own id, its canonical form", async () => {
    const text = "It costs ``nothing'' --- 74.1\\% of the time. " + prose(8);
    const { calls, scoreBlocks } = recorder();
    const read = await readInWindows([{ id: "u_1", text, order: 7 }], scoreBlocks);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ id: "u_1", text: canonicalForScoring(text) }]);
    expect(read.get("u_1")).toEqual([{ start: 0, end: text.length, result: real(calls[0][0]) }]);
  });

  it("sends every window of every unit in ONE call and names each block's owner", async () => {
    const long = prose(60);
    const short = prose(9);
    const { calls, owners, scoreBlocks } = recorder();
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }, { id: "u_b", text: short, order: 1 }], scoreBlocks);
    expect(calls).toHaveLength(1);
    const spans = planWindows(long);
    expect(spans).toHaveLength(3);
    expect(calls[0].map((b) => b.text)).toEqual([...spans.map((s) => blockText(long, s)), canonicalForScoring(short)]);
    expect(new Set(calls[0].map((b) => b.id)).size).toBe(4);
    expect(calls[0].every((b) => b.text.length <= WINDOW_CHARS)).toBe(true);
    expect([...owners[0].values()]).toEqual(["u_a", "u_a", "u_a", "u_b"]);
    expect(read.get("u_a")!.map((w) => [w.start, w.end])).toEqual(spans.map((s) => [s.start, s.end]));
    // Cut first, canonicalize after: the windows put back together are the text itself.
    expect(read.get("u_a")!.map((w) => long.slice(w.start, w.end)).join("")).toBe(long);
  });

  it("re-reads a window the daemon had to cut, once, in two halves", async () => {
    const long = prose(60);
    const [, middle] = planWindows(long);
    const dense = blockText(long, middle);
    const { calls, scoreBlocks } = recorder((b) => real(b, b.text === dense ? { truncated: true, tokens: 512 } : {}));
    const windows = (await readInWindows([{ id: "u_a", text: long, order: 0 }], scoreBlocks)).get("u_a")!;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(2);
    expect(calls[1].map((b) => b.text).join(" ")).toBe(dense);
    expect(windows).toHaveLength(4);
    expect(windows.map((w) => long.slice(w.start, w.end)).join("")).toBe(long);
    expect(windows.some((w) => w.result.truncated)).toBe(false);
    expect(unitVerdict("u_a", long.length, windows).result.truncated).toBeUndefined();
  });

  it("also re-reads a ONE-window text that turned out denser than a window", async () => {
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

  it("gives a unit no verdict at all while one of its windows is unanswered; its neighbours keep theirs", async () => {
    const long = prose(60);
    const lost = blockText(long, planWindows(long)[2]);
    const { scoreBlocks } = recorder((b) => (b.text === lost ? undefined : real(b)));
    const read = await readInWindows([{ id: "u_a", text: long, order: 0 }, { id: "u_b", text: prose(9), order: 1 }], scoreBlocks);
    expect(read.has("u_a")).toBe(false);
    expect(read.get("u_b")).toHaveLength(1);
  });

  it("turns one degraded window into an Unavailable unit", async () => {
    const long = prose(60);
    const failed = blockText(long, planWindows(long)[1]);
    const { scoreBlocks } = recorder((b) => real(b, b.text === failed ? { degraded: true } : {}));
    const windows = (await readInWindows([{ id: "u_a", text: long, order: 0 }], scoreBlocks)).get("u_a")!;
    expect(windows).toHaveLength(3);
    expect(unitVerdict("u_a", long.length, windows).result.degraded).toBe(true);
  });
});

it("keeps original source spans when canonical ranges, repeated escapes and joined accents contract", async () => {
  const raw = (`Original 1–2–3 costs \\\\% and A\u200b\u0301 remains mapped to its source. ` + prose(8)).repeat(5);
  const spans = planWindows(raw), {calls, scoreBlocks} = recorder();
  const windows = (await readInWindows([{id:"mapped",text:raw,order:0}],scoreBlocks)).get("mapped")!;
  expect(windows.map(({start,end}) => [start,end])).toEqual(spans.map(({start,end}) => [start,end]));
  expect(windows.map(({start,end}) => raw.slice(start,end)).join("")).toBe(raw);
  expect(calls.flat().map(({text}) => text)).toEqual(spans.map((span) => canonicalForScoring(raw.slice(span.start,span.end))));
  expect(calls.flat().some(({text}) => text.includes("1-2-3 costs % and Á"))).toBe(true);
});
