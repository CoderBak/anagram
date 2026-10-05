// test/node/statsHash.test.ts — the log's hashes and sketches (lib/stats/hash.ts): HMAC as RFC
// 2104 has it, the same text the same hash under one key and another under another, and a
// sketch that finds an edited copy and not a stranger.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { headOf, hmac, keyedHash, sketchOf, sketchSimilarity } from "../../lib/stats/hash";

const key = new Uint8Array(32).map((_, i) => i * 7 + 3);
const other = new Uint8Array(32).map((_, i) => 255 - i);
const TEXT = "The survey of the old harbour began in the spring, when the water was low enough to show the stones along the northern wall. Three of us walked the length of it every morning with a notebook and a measuring tape, writing down every crack and every loose block we could find.";

describe("hmac", () => {
  it("is RFC 2104's HMAC-SHA-256, for short keys and long", () => {
    for (const k of [key, new Uint8Array(100).fill(9), new Uint8Array(0)]) {
      for (const m of ["", "abc", TEXT, "日本語のテキスト"]) {
        expect(hmac(k, m)).toBe(createHmac("sha256", Buffer.from(k)).update(m, "utf8").digest("hex"));
      }
    }
  });
});

describe("keyedHash and sketchOf", () => {
  it("give one text one hash under one key, and another under another", () => {
    expect(keyedHash(key, TEXT)).toBe(keyedHash(key, TEXT));
    expect(keyedHash(key, TEXT)).not.toBe(keyedHash(other, TEXT));
    expect(keyedHash(key, TEXT)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("find an edited copy alike and a different text not", () => {
    const edited = TEXT.replace("Three of us", "Four of us").replace("measuring tape", "long tape");
    const stranger = "Most of the repairs were honest work. Somebody had cut new stones to fit the old gaps, and the mortar between them was still hard after fifty years of salt water.";
    const a = sketchOf(key, TEXT);
    expect(a).toHaveLength(86);
    expect(sketchSimilarity(a, sketchOf(key, TEXT))).toBe(1);
    expect(sketchSimilarity(a, sketchOf(key, edited))).toBeGreaterThan(0.5);
    expect(sketchSimilarity(a, sketchOf(key, stranger))).toBeLessThan(0.2);
    // Another key's sketch of the same text is a stranger's.
    expect(sketchSimilarity(a, sketchOf(other, TEXT))).toBeLessThan(0.2);
  });
  it("sketch a text of fewer than five words too", () => {
    expect(sketchSimilarity(sketchOf(key, "Thanks."), sketchOf(key, "thanks"))).toBe(1);
  });
});

describe("headOf", () => {
  it("is the first twelve words", () => {
    expect(headOf(TEXT)).toBe("The survey of the old harbour began in the spring, when the");
    expect(headOf("  two words ")).toBe("two words");
  });
});
