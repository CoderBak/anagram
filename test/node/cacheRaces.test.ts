import { afterEach, describe, expect, it, vi } from "vitest";
import { createSwCache, indexedDbStore } from "../../lib/backend/swCache";
import { createScoreCache } from "../../lib/capture/cache";
import { SCORE_CACHE_MAX_AGE_MS } from "../../lib/cachePolicy";
import { SCORING_NORMALIZATION_VERSION } from "../../lib/dom/text";
import { deferred, fakeScoreStore } from "./scoreStore";

const result = { id: "x", bucket: 3, probs: [0, 0, 0, 1], score: 1 };
const dim = '["model","1","none"]';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("cache invalidation and retention races", () => {
  it("does not return or restore rows from a read that crosses clear", async () => {
    const store = fakeScoreStore(), cache = createSwCache(store);
    const key = cache.keyOf("old", dim);
    store.rows.set(key, { key, b: 3, p: result.probs, s: 1, t: Date.now() });
    const started = deferred<void>(), release = deferred<void>();
    store.get = async (keys) => {
      const rows = keys.map((key) => store.rows.get(key));
      started.resolve(); await release.promise; return rows;
    };
    const read = cache.getMany([key], false);
    await started.promise;
    await cache.clear();
    release.resolve();
    expect((await read).size).toBe(0);
    expect((await cache.getMany([key], false)).size).toBe(0);
  });

  it("orders old flush, clear and new flush without a late all-store clear", async () => {
    vi.useFakeTimers();
    const store = fakeScoreStore(), cache = createSwCache(store);
    const started = deferred<void>(), release = deferred<void>();
    const put = store.put, clear = vi.spyOn(store, "clear");
    let first = true;
    store.put = async (rows) => {
      if (first) { first = false; started.resolve(); await release.promise; }
      await put(rows);
    };
    cache.set("old", result, dim);
    await vi.advanceTimersByTimeAsync(251); await started.promise;
    const deletion = cache.clear();
    cache.set("new", result, dim);
    await vi.advanceTimersByTimeAsync(251);
    release.resolve(); await deletion;
    await vi.advanceTimersByTimeAsync(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect([...store.rows.keys()]).toEqual([cache.keyOf("new", dim)]);
  });

  it("rejects failed deletion, blocks old disk rows, and permits an explicit retry", async () => {
    const store = fakeScoreStore(), cache = createSwCache(store);
    const key = cache.keyOf("old", dim);
    store.rows.set(key, { key, b: 3, p: result.probs, s: 1, t: Date.now() });
    expect((await cache.getMany([key], false)).size).toBe(1);
    const clear = store.clear;
    store.clear = async () => { throw new Error("transaction aborted"); };
    await expect(cache.clear()).rejects.toThrow("transaction aborted");
    expect((await cache.getMany([key], false)).size).toBe(0);
    expect(store.rows.size).toBe(1); // failing is not evidence that the data was removed
    store.clear = clear;
    await cache.clear();
    expect(store.rows.size).toBe(0);
  });

  it("does not claim deletion or an empty count when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      await expect(indexedDbStore().clear()).rejects.toThrow(/deletion was not verified/);
      await expect(indexedDbStore().count()).rejects.toThrow(/unavailable/);
    } finally { vi.unstubAllGlobals(); }
  });

  it("checks age on every L1, worker-memory and disk read, including private reads", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const l1 = createScoreCache(), store = fakeScoreStore(), cache = createSwCache(store);
    l1.set("old", result);
    cache.set("memory", result, dim, false);
    const diskKey = cache.keyOf("disk", dim), memoryKey = cache.keyOf("memory", dim);
    store.rows.set(diskKey, { key: diskKey, b: 3, p: result.probs, s: 1, t: now });
    expect((await cache.getMany([diskKey], false)).size).toBe(1);
    now += SCORE_CACHE_MAX_AGE_MS;
    expect(l1.get("old")).toBeUndefined();
    expect((await cache.getMany([diskKey, memoryKey], false)).size).toBe(0);
    expect(store.cutoffs).toHaveLength(0); // private reads never prune persistent data
  });

  it("session mode erases persistent rows and never reads or writes disk afterwards", async () => {
    vi.useFakeTimers();
    const store = fakeScoreStore(), cache = createSwCache(store);
    cache.set("persistent", result, dim);
    await vi.advanceTimersByTimeAsync(251);
    expect(store.rows.size).toBe(1);
    await cache.setMode("session");
    const get = vi.spyOn(store, "get"), put = vi.spyOn(store, "put");
    cache.set("session", result, dim);
    expect((await cache.getMany([cache.keyOf("session", dim), "missing"])).size).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0); expect(await cache.count()).toBe(1);
    await cache.setMode("persistent");
    expect((await cache.getMany([cache.keyOf("session", dim)])).size).toBe(0);
  });

  it("reports and retries a failed session transition rather than silently accepting it", async () => {
    const store = fakeScoreStore(), cache = createSwCache(store);
    const clear = vi.spyOn(store, "clear").mockRejectedValueOnce(new Error("blocked"));
    await expect(cache.setMode("session")).rejects.toThrow("blocked");
    await expect(cache.count()).rejects.toThrow(/not been verified/);
    await cache.setMode("session");
    expect(clear).toHaveBeenCalledTimes(2);
    expect(await cache.count()).toBe(0);
  });

  it("versioned keys and epoch-guarded writes exclude pre-clear work", async () => {
    const cache = createSwCache(fakeScoreStore()), epoch = cache.epoch();
    expect(cache.keyOf("1–2–3", dim)).toBe(cache.keyOf("1-2-3", dim));
    expect(cache.keyOf("text", dim)).toMatch(new RegExp(`^n${SCORING_NORMALIZATION_VERSION}:`));
    expect(createScoreCache().keyOf("text")).toMatch(new RegExp(`^n${SCORING_NORMALIZATION_VERSION}:`));
    await cache.clear(); cache.set("late", result, dim, false, epoch);
    expect((await cache.getMany([cache.keyOf("late", dim)], false)).size).toBe(0);
  });
});
