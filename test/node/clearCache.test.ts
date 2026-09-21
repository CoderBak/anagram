// test/node/clearCache.test.ts — "Clear cached verdicts" at the layer that owns the caches.
// There is no IndexedDB in this environment, which is exactly the memory-only case the
// cache is built for: the store is emptied by a function of its own (clearStore) that
// returns quietly when no store opened, so everything below is the memory path.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createSwCache } from "../../lib/backend/swCache";
import { NativeScoreError } from "../../lib/backend/nativeScoreClient";
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
const DIM = "model-a@1";

function req(texts: string[]): ScoreBatchRequest {
  return {
    v: CONTRACT_VERSION,
    session: "s",
    priority: "viewport",
    blocks: texts.map((text, i) => ({ id: `b${i}`, text })),
  };
}

/** A backend that records what it was asked and can be made to fail. It fails the way a
 *  BUSY daemon does, which is the only failure the router tries a second time — so a
 *  request really is in flight while the clear below happens. */
function fakeClient() {
  const calls: ScoreBlock[][] = [];
  let failing = false;
  const client: ScoreClient & { calls: ScoreBlock[][]; fail(v: boolean): void } = {
    calls,
    model: () => MODEL,
    fail: (v) => {
      failing = v;
    },
    async scoreBatch(blocks): Promise<ScoredBatch> {
      calls.push(blocks);
      if (failing) throw new NativeScoreError(503,"not_ready","Engine loading");
      return {
        model: MODEL,
        results: blocks.map((b) => ({ id: b.id, bucket: 3, probs: [0, 0, 0.1, 0.9], score: 1 })),
      };
    },
  };
  return client;
}

beforeEach(() => fakeBrowser.reset());

describe("clearing the cached verdicts", () => {
  it("empties the memory layer, pending writes included", async () => {
    const cache = createSwCache();
    const key = cache.keyOf("a paragraph the daemon answered for", DIM);
    cache.set("a paragraph the daemon answered for", { id: "x", bucket: 2, probs: [0, 0, 1, 0], score: 0.67 }, DIM);
    expect((await cache.getMany([key])).has(key)).toBe(true);
    await cache.clear();
    expect((await cache.getMany([key])).size).toBe(0);
    // The write waiting for its flush went with it, so nothing can reappear later.
    await new Promise((r) => setTimeout(r, 400));
    expect((await cache.getMany([key])).size).toBe(0);
  });

  it("sends a paragraph to the backend again after a clear", async () => {
    const client = fakeClient();
    const router = createRouter(client);
    await router.handle(req(["one paragraph, scored once"]));
    expect(client.calls.length).toBe(1);
    await router.handle(req(["one paragraph, scored once"]));
    expect(client.calls.length).toBe(1); // still cached
    await router.clear();
    await router.handle(req(["one paragraph, scored once"]));
    expect(client.calls.length).toBe(2); // the daemon is asked again
  });

  it("lets a request in flight over the clear settle, and caches nothing degraded", async () => {
    const client = fakeClient();
    const router = createRouter(client);
    client.fail(true);
    const inFlight = router.handle(req(["a paragraph nobody can score right now"]));
    await router.clear(); // mid-flight: the request must still answer its caller
    const answered = await Promise.race([
      inFlight,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
    ]);
    expect(answered).not.toBe("timeout");
    expect((answered as { results: { degraded?: boolean }[] }).results[0].degraded).toBe(true);
    // A degraded verdict is never cached — before a clear or after one.
    client.fail(false);
    const calls = client.calls.length;
    const again = await router.handle(req(["a paragraph nobody can score right now"]));
    expect(again.results[0].degraded).toBeUndefined();
    expect(client.calls.length).toBe(calls + 1);
  });
});
