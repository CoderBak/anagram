import { describe, expect, it, vi } from "vitest";
import { groupPassages, type PassageBlock } from "../../lib/plan/passages";
import { detectorText } from "../../lib/dom/text";
import { readDetectorPassages, unitVerdict } from "../../lib/capture/windows";

const block = (text: string, words = 60, breakBefore = false): PassageBlock => ({ text, words, breakBefore });
const counter = (window: number) => vi.fn(async (texts: string[]) => ({
  window, alone: texts.map(t => t.length), following: texts.map(t => t.length + 1),
}));

describe("context from sibling paragraphs", () => {
  it("uses the selected tokenizer's count of the complete input, including its blank lines", async () => {
    const blocks = ["aaa", "bbb", "ccc"].map(t => block(t, 30));
    const count = counter(13);
    expect(await groupPassages(blocks, 50, count)).toEqual([[0, 1, 2]]);
    expect(count.mock.calls.at(-1)?.[0]).toEqual(["aaa\n\nbbb\n\nccc"]);
    expect(await groupPassages(blocks, 50, counter(8))).toEqual([[0, 1], [2]]);
  });

  it("keeps short siblings readable, including a short tail and a long paragraph beside them", async () => {
    const count = counter(8);
    const blocks = [block("aaa"), block("bbb"), block("ccc", 12), block("a full long paragraph")];
    expect(await groupPassages(blocks, 50, count)).toEqual([[0], [1, 2], [3]]);
  });

  it("keeps independently readable paragraphs separate without calling the tokenizer", async () => {
    const count = counter(512);
    expect(await groupPassages([block("first", 60), block("second", 70), block("third", 55)], 50, count)).toEqual([[0], [1], [2]]);
    expect(count).not.toHaveBeenCalled();
  });

  it("cannot cross a structural break or infer a token window from an unavailable engine", async () => {
    const blocks = [block("A"), block("B", 61, true), block("C", 12), block("D", 62, true)];
    const count = counter(100);
    expect(await groupPassages(blocks, 50, count)).toEqual([[0], [1, 2], [3]]);
    expect(count.mock.calls).toEqual([[["B\n\nC"]]]);
    expect(await groupPassages(blocks, 50, async () => null)).toBeNull();
  });

  it("maps the detector's labels back to the source with and without a labelled separator", async () => {
    const raw = "First paragraph ends here.\n\nSecond paragraph has no full stop\n\nThird paragraph ends here.";
    for (const sentenceLabels of [[0, 2, 1], [0, 0, 2, 1]]) {
      const passes = await readDetectorPassages([{ id: "x", text: raw, order: 0 }], async blocks => {
        expect(blocks[0]?.text).toBe(raw);
        return new Map([["x", { id: "x", probs: [.3, .3, .4], bucket: 1, score: .55, sentenceLabels }]]);
      });
      const { stretches, result, windows } = unitVerdict("x", raw.length, passes.get("x")!, raw);
      expect(result.sentenceLabels).toEqual([0, 2, 1]);
      expect(windows[0]!.result.sentenceLabels).toEqual([0, 2, 1]);
      expect(stretches.map(s => [raw.slice(s.start, s.end).trim(), s.result.bucket])).toEqual([
        ["First paragraph ends here.", 0], ["Second paragraph has no full stop", 2], ["Third paragraph ends here.", 1],
      ]);
    }
    expect(detectorText("one\ntwo")).not.toBe(detectorText("one\n\ntwo"));
  });
});
