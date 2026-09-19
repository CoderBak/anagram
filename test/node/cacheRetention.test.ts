// test/node/cacheRetention.test.ts — nothing is kept forever, and the number the options
// page shows is the store's own.
//
// The store is a fake (vitest has no IndexedDB), which is the point: what is checked here
// is the RULE — thirty days from the write, a hit does not restart the clock — rather than
// the cursor walk that carries it out.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createSwCache, type ScoreStore, type Stored } from "../../lib/backend/swCache";
import type { ScoreResult } from "../../lib/contract";

const DIM = "model-a@1";
const DAY = 24 * 60 * 60 * 1000;
const flushed = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

function result(bucket = 3): ScoreResult {
  return { id: "", bucket, probs: [0, 0, 0.1, 0.9], score: bucket / 3 };
}

function fakeStore() {
  const rows = new Map<string, Stored>();
  const store: ScoreStore & { rows: Map<string, Stored>; cutoffs: number[]; overflows: number } = {
    rows,
    cutoffs: [],
    overflows: 0,
    async get(keys) {
      return keys.map((k) => rows.get(k));
    },
    async put(batch) {
      for (const row of batch) rows.set(row.key, row);
    },
    async clear() {
      rows.clear();
    },
    async count() {
      return rows.size;
    },
    async dropOlderThan(cutoff) {
      store.cutoffs.push(cutoff);
      let dropped = 0;
      for (const [k, row] of rows) {
        if (row.t < cutoff) {
          rows.delete(k);
          dropped++;
        }
      }
      return dropped;
    },
    async dropOldest() {
      store.overflows++;
      return 0;
    },
  };
  return store;
}

beforeEach(() => fakeBrowser.reset());

describe("how long a verdict is kept", () => {
  it("drops what is over thirty days old the first time the cache is used", async () => {
    const store = fakeStore();
    const cache = createSwCache(store);
    const old = cache.keyOf("read a month and a day ago", DIM);
    const recent = cache.keyOf("read yesterday", DIM);
    store.rows.set(old, { key: old, b: 3, p: [0, 0, 0.1, 0.9], s: 1, t: Date.now() - 31 * DAY });
    store.rows.set(recent, { key: recent, b: 1, p: [0.1, 0.9, 0, 0], s: 0.3, t: Date.now() - DAY });

    const hits = await cache.getMany([old, recent]);
    await flushed();
    expect(store.rows.has(old)).toBe(false);
    expect(store.rows.has(recent)).toBe(true);
    // The sweep is thirty days back, and it runs once per worker lifetime, not per call.
    expect(store.cutoffs.length).toBe(1);
    expect(Date.now() - store.cutoffs[0]).toBeGreaterThan(29 * DAY);
    expect(Date.now() - store.cutoffs[0]).toBeLessThan(31 * DAY);
    await cache.getMany([recent]);
    expect(store.cutoffs.length).toBe(1);
    // The row was read in the same breath as it was expired; both answers are legitimate,
    // so what is asserted is only that the recent one came back.
    expect(hits.has(recent)).toBe(true);
  });

  it("does not restart the clock when a verdict is read", async () => {
    const store = fakeStore();
    const cache = createSwCache(store);
    cache.set("a paragraph somebody keeps revisiting", result(), DIM);
    await flushed();
    const key = cache.keyOf("a paragraph somebody keeps revisiting", DIM);
    const written = store.rows.get(key)?.t ?? 0;
    expect(written).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 20));
    expect((await cache.getMany([key])).has(key)).toBe(true);
    await flushed();
    // A hit that rewrote the row would be a disk write caused by a lookup — which is
    // exactly what a lookup from a private tab may never do.
    expect(store.rows.get(key)?.t).toBe(written);
  });

  it("sweeps for age as well as for size on the periodic prune", async () => {
    const store = fakeStore();
    const cache = createSwCache(store);
    for (let i = 0; i < 500; i++) cache.set(`paragraph ${i}`, result(), DIM);
    await flushed();
    // Once for the first use of the cache, once for the prune every 500 writes — and the
    // size cap is still asked about in the same pass.
    expect(store.cutoffs.length).toBe(2);
    expect(store.overflows).toBe(1);
  });

  it("counts what is on the disk, and nothing else", async () => {
    const store = fakeStore();
    const cache = createSwCache(store);
    expect(await cache.count()).toBe(0);
    cache.set("one", result(), DIM);
    cache.set("two", result(), DIM);
    cache.set("three, in a private tab", result(), DIM, false);
    await flushed();
    expect(await cache.count()).toBe(2);
    await cache.clear();
    expect(await cache.count()).toBe(0);
  });
});
