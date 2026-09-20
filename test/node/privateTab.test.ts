// test/node/privateTab.test.ts — the invariant: NOTHING that exists only because of a
// private tab is ever written to the disk.
//
// A private tab may read the cache (a hit writes nothing), and what its batches produce
// lives in this worker's memory until an ordinary tab asks for the same text — which it
// would have produced identically, so from that moment it is nobody's trace. The store is
// a fake here: vitest has no IndexedDB, and what these checks are about is which rows
// reach the persistent layer at all, not how it keeps them.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createSwCache, type ScoreStore, type Stored } from "../../lib/backend/swCache";
import { createRouter } from "../../lib/backend/router";
import type {
  ModelInfo,
  ScoreBatchRequest,
  ScoreBlock,
  ScoreClient,
  ScoredBatch,
} from "../../lib/contract";
import { CONTRACT_VERSION } from "../../lib/contract";

const MODEL: ModelInfo = { id: "model-a", ver: "1", calibration: "none" };
/** Long enough for the cache's 250 ms write flush to have happened. */
const flushed = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

/** The persistent layer as a plain map, so a test can see exactly what was written. */
function fakeStore() {
  const rows = new Map<string, Stored>();
  const store: ScoreStore & { rows: Map<string, Stored>; cutoffs: number[] } = {
    rows,
    cutoffs: [],
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
    async dropOldest(max, keep) {
      if (rows.size <= max) return 0;
      const oldest = [...rows.values()].sort((a, b) => a.t - b.t).slice(0, rows.size - keep);
      for (const row of oldest) rows.delete(row.key);
      return oldest.length;
    },
  };
  return store;
}

function req(texts: string[]): ScoreBatchRequest {
  return {
    v: CONTRACT_VERSION,
    session: "s",
    surface: "chrome-ext",
    priority: "viewport",
    lang: "en",
    domain: "test",
    blocks: texts.map((text, i) => ({ id: `b${i}`, text, order: i })),
  };
}

function fakeClient() {
  const calls: ScoreBlock[][] = [];
  const holds: Array<{ blocks: ScoreBlock[]; settle: (v: ScoredBatch) => void }> = [];
  const answer = (blocks: ScoreBlock[]): ScoredBatch => ({
    model: MODEL,
    results: blocks.map((b) => ({ id: b.id, bucket: 3, probs: [0, 0, 0.1, 0.9], score: 1 })),
  });
  let holding = false;
  const client: ScoreClient & { calls: ScoreBlock[][]; hold(): void; release(): void } = {
    calls,
    model: () => MODEL,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const h of holds.splice(0)) h.settle(answer(h.blocks));
    },
    async scoreBatch(blocks) {
      calls.push(blocks);
      if (!holding) return answer(blocks);
      return new Promise<ScoredBatch>((res) => holds.push({ blocks, settle: res }));
    },
  };
  return client;
}

beforeEach(() => fakeBrowser.reset());

describe("a private tab leaves nothing on the disk", () => {
  it("scores for a private tab and writes no row", async () => {
    const store = fakeStore();
    const client = fakeClient();
    const router = createRouter(client, createSwCache(store));
    await router.handle(req(["read in a private window"]), { private: true });
    await flushed();
    expect(store.rows.size).toBe(0);
    // …and the verdict is still THERE, in this worker's memory: the same private tab
    // scrolling back does not pay for it twice.
    await router.handle(req(["read in a private window"]), { private: true });
    expect(client.calls.length).toBe(1);
    await flushed();
    expect(store.rows.size).toBe(0);
  });

  it("serves a private tab from the disk without writing anything", async () => {
    const store = fakeStore();
    const client = fakeClient();
    const router = createRouter(client, createSwCache(store));
    await router.handle(req(["read in an ordinary window first"])); // an ordinary tab
    await flushed();
    expect(store.rows.size).toBe(1);
    const written = [...store.rows.values()][0].t;

    await router.handle(req(["read in an ordinary window first"]), { private: true });
    await flushed();
    expect(client.calls.length).toBe(1); // a hit
    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()][0].t).toBe(written); // the read did not rewrite it
  });

  it("writes it once an ordinary tab asks for the same text", async () => {
    const store = fakeStore();
    const client = fakeClient();
    const router = createRouter(client, createSwCache(store));
    await router.handle(req(["the same page, two windows"]), { private: true });
    await flushed();
    expect(store.rows.size).toBe(0);

    await router.handle(req(["the same page, two windows"]));
    await flushed();
    // The ordinary tab would have produced this verdict itself, so keeping it says
    // nothing about the private window that got there first.
    expect(store.rows.size).toBe(1);
    expect(client.calls.length).toBe(1); // and it was not scored a second time
  });

  it("writes a batch a private and an ordinary tab are both waiting for", async () => {
    const store = fakeStore();
    const client = fakeClient();
    const router = createRouter(client, createSwCache(store));
    client.hold();
    const secret = router.handle(req(["one paragraph, two windows"]), { private: true });
    await new Promise((r) => setTimeout(r, 10)); // it has reserved the key
    const ordinary = router.handle(req(["one paragraph, two windows"]));
    await new Promise((r) => setTimeout(r, 10));
    expect(client.calls.length).toBe(1); // the second joined the first
    client.release();
    await Promise.all([secret, ordinary]);
    await flushed();
    // The ordinary tab asked for it, so the answer is written — being deduplicated
    // against a private tab's batch must not cost it its cache entry.
    expect(store.rows.size).toBe(1);
  });

  it("keeps a private joiner from putting an ordinary tab's batch back on the disk", async () => {
    const store = fakeStore();
    const client = fakeClient();
    const router = createRouter(client, createSwCache(store));
    client.hold();
    const ordinary = router.handle(req(["an ordinary read, joined"]));
    await new Promise((r) => setTimeout(r, 10));
    const secret = router.handle(req(["an ordinary read, joined"]), { private: true });
    await new Promise((r) => setTimeout(r, 10));
    client.release();
    await Promise.all([ordinary, secret]);
    await flushed();
    expect(store.rows.size).toBe(1); // the ordinary tab's row, as it would have been
  });
});
