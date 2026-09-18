// test/node/cacheLru.test.ts — the two in-memory score caches stay bounded.
// Neither map may grow for the lifetime of its worker or its tab, and what survives the
// cap must be what was used most recently. IndexedDB does not exist in this environment,
// so the worker cache is memory-only here and getMany() reports its memory layer exactly.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createSwCache, MEMORY_MAX_ENTRIES } from "../../lib/backend/swCache";
import { createScoreCache, L1_MAX_ENTRIES } from "../../lib/capture/cache";
import type { ScoreResult } from "../../lib/contract";

const DIM = "model-a@1";

function result(bucket: number): ScoreResult {
  return { id: "", bucket, probs: [0, 0, 0.1, 0.9], score: bucket / 3 };
}

beforeEach(() => fakeBrowser.reset());

describe("bounded score caches", () => {
  it("the worker cache evicts the oldest entry past its cap and a hit refreshes recency", async () => {
    const cache = createSwCache();
    for (let i = 0; i < MEMORY_MAX_ENTRIES; i++) cache.set(`paragraph ${i}`, result(3), DIM);
    const key = (i: number): string => cache.keyOf(`paragraph ${i}`, DIM);

    // Reading the oldest entry makes it the youngest, so the next insert evicts #1.
    expect((await cache.getMany([key(0)])).has(key(0))).toBe(true);
    cache.set("paragraph fresh", result(2), DIM);
    const after = await cache.getMany([key(0), key(1), key(2), cache.keyOf("paragraph fresh", DIM)]);
    expect(after.has(key(0))).toBe(true);
    expect(after.has(key(1))).toBe(false);
    expect(after.has(key(2))).toBe(true);
    expect(after.has(cache.keyOf("paragraph fresh", DIM))).toBe(true);
  });

  it("the per-tab cache evicts the oldest entry past its cap and a hit refreshes recency", () => {
    const cache = createScoreCache();
    for (let i = 0; i < L1_MAX_ENTRIES; i++) cache.set(`paragraph ${i}`, result(3));
    expect(cache.size()).toBe(L1_MAX_ENTRIES);

    expect(cache.get("paragraph 0")).toBeDefined();
    cache.set("paragraph fresh", result(2));
    expect(cache.size()).toBe(L1_MAX_ENTRIES); // still capped
    expect(cache.get("paragraph 0")).toBeDefined(); // the touched entry stayed
    expect(cache.get("paragraph 1")).toBeUndefined(); // the oldest untouched one went
    expect(cache.get("paragraph fresh")).toBeDefined();
  });
});
