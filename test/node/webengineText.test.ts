// test/node/webengineText.test.ts — the engine's cleaning, tokenizer and rounding.
import { describe, expect, it } from "vitest";
import { cleanText, pyStrip } from "../../lib/webengine/clean";
import { demojize, removeEmoji } from "../../lib/webengine/emoji";
import { Tokenizer } from "../../lib/webengine/tokenizer";
import { countTokens, pad, passes, pyRound, scoreTexts } from "../../lib/webengine/scoring";
import { tinyTokenizerJson } from "../fixtures/webengine/tinyTokenizer.mjs";

const tokenizer = () => new Tokenizer(tinyTokenizerJson() as never);
const id = (token: string) => (tinyTokenizerJson().model.vocab as Record<string, number>)[token];

describe("emoji names", () => {
  it("spells emoji out as the emoji package does, joiners and modifiers included", () => {
    expect(demojize("hi 👍🏽 there 👨‍👩‍👧 x 🇺🇸 ☺ ☺️ 1️⃣ #️⃣")).toBe("hi :thumbs_up_medium_skin_tone: there :family_man_woman_girl: x :United_States: :smiling_face: :smiling_face: :keycap_1: :keycap_#:");
    expect(demojize("a‍👍 z")).toBe("a‍:thumbs_up: z");
    expect(demojize("plain text, no emoji")).toBe("plain text, no emoji");
    expect(demojize("stray ️ selector")).toBe("stray  selector");
  });
  it("removes emoji for the header check", () => {
    expect(removeEmoji("Sure 😀 thing 👍🏽")).toBe("Sure  thing ");
  });
});

describe("clean_text", () => {
  it("follows scripts/preprocess.py step by step", () => {
    expect(cleanText("  Hello   World\n\nAgain ")).toBe("hello world again");
    expect(cleanText("<think>plan</think> The Answer.")).toBe("the answer.");
    expect(cleanText("Sure! Here you go:\nThe body.")).toBe("the body.");
    expect(cleanText("Sure! Only one paragraph.")).toBe("sure! only one paragraph.");
    // The header check strips the emoji name's punctuation, then sees "thumbs_up…", not "Certainly".
    expect(cleanText("👍 Certainly.\nSecond.")).toBe(":thumbs_up: certainly. second.");
    expect(cleanText("👍 Certainly.\nSecond.".replace("👍 ", ""))).toBe("second.");
    expect(cleanText("Text 😀 here")).toBe("text :grinning_face: here");
    expect(cleanText("")).toBe("");
  });
  it("uses Python's whitespace, not JavaScript's", () => {
    expect(cleanText("a\x1cb\x85c")).toBe("a b c");
    expect(cleanText("a﻿b")).toBe("a﻿b");
    expect(pyStrip("　x ")).toBe("x");
  });
});

describe("byte-level BPE", () => {
  it("cuts text as GPT-2 does and merges by rank", () => {
    const t = tokenizer();
    expect(t.encode("the", false)).toEqual([id("the")]);
    expect(t.encode("the the", false)).toEqual([id("the"), id("Ġthe")]);
    expect(t.encode(" the", false)).toEqual([id("Ġthe")]);
    expect(t.encode("and's", false)).toEqual([id("and"), id("'s")]);
    expect(t.encode("123", false)).toEqual([id("123")]);
    expect(t.encode("a word", false)).toEqual([id("a"), id("Ġword")]);
    // Two spaces: the first stays a lone space token, the second joins the word.
    expect(t.encode("a  word", false)).toEqual([id("a"), id("Ġ"), id("Ġword")]);
    // Bytes above ASCII are spelt one token per byte.
    expect(t.encode("é", false)).toEqual([id("Ã"), id("©")]);
  });
  it("adds RoBERTa's special tokens and finds the added tokens in the text", () => {
    const t = tokenizer();
    expect(t.encode("the", true)).toEqual([0, id("the"), 2]);
    expect(t.encode("", true)).toEqual([0, 2]);
    expect(t.encode("the </s> and", false)).toEqual([id("the"), id("Ġ"), 2, id("Ġand")]);
    // <mask> strips the space before it (lstrip), <s> does not.
    expect(t.encode("the <mask>", false)).toEqual([id("the"), t.encode("<mask>", false)[0]]);
    expect(t.encode("the <s>", false)).toEqual([id("the"), id("Ġ"), 0]);
    expect(t.clsId).toBe(0);
    expect(t.sepId).toBe(2);
    expect(t.padId).toBe(1);
  });
  it("counts tokens alone and following a space", () => {
    const counts = countTokens(tokenizer(), ["The word", "", "  "]);
    expect(counts).toEqual({ alone: [2, 0, 0], following: [2, 0, 0], window: 510 });
  });
});

describe("scoring arithmetic", () => {
  it("rounds as Python does, half to even on exact ties", () => {
    expect(pyRound(0.12345, 4)).toBe(0.1235);
    expect(pyRound(0.5, 0)).toBe(0);
    expect(pyRound(1.5, 0)).toBe(2);
    expect(pyRound(2.5, 0)).toBe(2);
    expect(pyRound(0.00015, 4)).toBe(0.0001);
    expect(pyRound(0.99995, 4)).toBe(1);
    expect(pyRound(-0.12345, 4)).toBe(-0.1235);
    expect(pyRound(0.1234, 4)).toBe(0.1234);
    expect(pyRound(0.00005, 4)).toBe(0.0001);
    expect(pyRound(0.12335, 4)).toBe(0.1234);
    expect(pyRound(2.675, 2)).toBe(2.67);
  });
  it("pads on the right with the pad id", () => {
    expect(pad([[0, 5, 2], [0, 2]], 1)).toEqual({ inputIds: [[0, 5, 2], [0, 2, 1]], attentionMask: [[1, 1, 1], [1, 1, 0]] });
  });
  it("scores in length order, in batches, and answers in input order", async () => {
    const seen: number[][][] = [];
    const backend = {
      async logits(ids: number[][]) {
        seen.push(ids);
        const out = new Float32Array(ids.length * 4);
        ids.forEach((row, r) => { out[r * 4 + 3] = row.length; out[r * 4] = 1; });
        return out;
      },
    };
    // 35 texts of 3 to 37 tokens, given longest first.
    const texts = Array.from({ length: 35 }, (_, i) => "the ".repeat(35 - i).trim());
    const results = await scoreTexts(backend, tokenizer(), texts);
    // Shortest first, every pass at most the batch, and no text in two.
    const widths = seen.flat().map((row) => row.filter((id) => id !== 1).length);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(seen.every((b) => b.length <= 32)).toBe(true);
    expect(seen.flat()).toHaveLength(35);
    seen.length = 0;
    await scoreTexts({ ...backend, batchSize: 8 }, tokenizer(), texts);
    expect(seen.every((b) => b.length <= 8)).toBe(true);
    expect(seen.flat()).toHaveLength(35);
    expect(results).toHaveLength(35);
    expect(results[34]!.tokens).toBe(3);
    expect(results[0]!.tokens).toBe(37);
    expect(results[0]!.bucket).toBe(3);
    expect(results[0]!.probs.reduce((a, b) => a + b)).toBeCloseTo(1, 3);
    expect(results.every((r) => !r.truncated)).toBe(true);
  });
  it("cuts passes where padding costs more than another pass, and least in all", () => {
    // Equal widths: as few passes as the batch allows, the short one first.
    expect(passes(Array(35).fill(100), 8).map(([a, b]) => b - a)).toEqual([3, 8, 8, 8, 8]);
    // A short text is not padded to a long one's width.
    expect(passes([30, 500], 8)).toEqual([[0, 1], [1, 2]]);
    expect(passes([30, 40], 8)).toEqual([[0, 2]]);
    expect(passes([], 8)).toEqual([]);
    // Least total cost, against every way to cut, on random sorted widths.
    const cost = (w: number[], spans: [number, number][], fixed: number) => spans.reduce((sum, [a, b]) => sum + fixed + (b - a) * w[b - 1]!, 0);
    const cheapest = (w: number[], limit: number, fixed: number, from = 0): number => from === w.length ? 0
      : Math.min(...Array.from({ length: Math.min(limit, w.length - from) }, (_, k) => fixed + (k + 1) * w[from + k]! + cheapest(w, limit, fixed, from + k + 1)));
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 200; trial++) {
      const w = Array.from({ length: 1 + Math.floor(random() * 9) }, () => 2 + Math.floor(random() * 510)).sort((a, b) => a - b);
      const limit = 1 + Math.floor(random() * 5), fixed = [24, 40][trial % 2]!;
      const spans = passes(w, limit, fixed);
      expect(spans.every(([a, b]) => b - a >= 1 && b - a <= limit)).toBe(true);
      expect(spans.flatMap(([a, b]) => Array.from({ length: b - a }, (_, k) => a + k))).toEqual(w.map((_, k) => k));
      expect(cost(w, spans, fixed)).toBe(cheapest(w, limit, fixed));
    }
  });
  it("truncates to the window, keeping the end token, and says so", async () => {
    const backend = { async logits(ids: number[][]) { expect(ids[0]).toHaveLength(512); expect(ids[0]![511]).toBe(2); return new Float32Array(4); } };
    const [r] = await scoreTexts(backend, tokenizer(), ["the ".repeat(600)]);
    expect(r!.truncated).toBe(true);
    expect(r!.tokens).toBe(512);
    expect(r!.probs).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(r!.score).toBe(0.5);
  });
});
