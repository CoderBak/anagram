// test/node/router.test.ts — provenance and settlement invariants of the SW router.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createRouter } from "../../lib/backend/router";
import type { ModelInfo, ScoreBatchRequest, ScoreBlock, ScoreClient, ScoredBatch } from "../../lib/contract";
import { CONTRACT_VERSION } from "../../lib/contract";

const A: ModelInfo = { id: "model-a", ver: "1", calibration: "none" };
const B: ModelInfo = { id: "model-b", ver: "1", calibration: "none" };

function req(texts: string[], priority: ScoreBatchRequest["priority"] = "viewport"): ScoreBatchRequest {
  return {
    v: CONTRACT_VERSION,
    session: "s",
    surface: "chrome-ext",
    priority,
    lang: "en",
    domain: "test",
    blocks: texts.map((text, i) => ({ id: `b${i}`, text, order: i })),
  };
}

function scored(blocks: ScoreBlock[], model: ModelInfo, bucket = 3): ScoredBatch {
  return {
    model,
    results: blocks.map((b) => ({ id: b.id, bucket, probs: bucket === 3 ? [0, 0, 0.1, 0.9] : [0.9, 0.1, 0, 0], score: bucket / 3 })),
  };
}

/** A controllable fake backend: every scoreBatch call is recorded and can be held open. */
function fakeClient(initial: ModelInfo) {
  let current = initial;
  const calls: ScoreBlock[][] = [];
  const holds: Array<(v: ScoredBatch | Error) => void> = [];
  let mode: "auto" | "hold" | "fail" = "auto";
  const client: ScoreClient & {
    calls: ScoreBlock[][];
    setModel(m: ModelInfo): void;
    hold(): void;
    fail(): void;
    release(model?: ModelInfo): void;
  } = {
    calls,
    model: () => current,
    setModel: (m) => {
      current = m;
    },
    hold: () => {
      mode = "hold";
    },
    fail: () => {
      mode = "fail";
    },
    release: (model = current) => {
      const pending = holds.splice(0);
      for (const h of pending) h(scored(calls[calls.length - pending.length + pending.indexOf(h)] ?? [], model));
      mode = "auto";
    },
    async scoreBatch(blocks) {
      calls.push(blocks);
      if (mode === "fail") throw new Error("backend down");
      if (mode === "hold") {
        return new Promise<ScoredBatch>((res, rej) => {
          holds.push((v) => (v instanceof Error ? rej(v) : res(v)));
        });
      }
      return scored(blocks, current);
    },
  };
  return client;
}

beforeEach(() => fakeBrowser.reset());

describe("router provenance", () => {
  it("a joined request settles with a real result when the backend identity changes mid-flight", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.hold();
    const first = router.handle(req(["same paragraph text"]));
    await new Promise((r) => setTimeout(r, 10)); // let it register its in-flight key
    const second = router.handle(req(["same paragraph text"]));
    await new Promise((r) => setTimeout(r, 10));
    expect(client.calls.length).toBe(1); // second joined the first
    client.setModel(B); // the identity flips while the batch is in the air
    client.release(A); // …but batch #1 was produced by A
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.results[0].degraded).toBeUndefined();
    expect(r2.results[0].degraded).toBeUndefined();
    expect(r1.model).toEqual(A); // provenance = producer, not the post-hoc identity
    // A third request must not hang on a stale in-flight entry and is served by B.
    const third = await Promise.race([
      router.handle(req(["same paragraph text"])),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000)),
    ]);
    expect(third).not.toBe("timeout");
    expect((third as { model: ModelInfo }).model).toEqual(B);
  });

  it("cache hits are scoped to the backend identity", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    await router.handle(req(["cached under a"]));
    expect(client.calls.length).toBe(1);
    await router.handle(req(["cached under a"]));
    expect(client.calls.length).toBe(1); // hit
    client.setModel(B);
    await router.handle(req(["cached under a"]));
    expect(client.calls.length).toBe(2); // another model → miss
    client.setModel(A);
    await router.handle(req(["cached under a"]));
    expect(client.calls.length).toBe(2); // A's verdict was still there
  });

  it("backend failure yields degraded results that are never cached", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail();
    const r = await router.handle(req(["will fail"]));
    expect(r.results[0].degraded).toBe(true);
    client.release();
    const again = await router.handle(req(["will fail"]));
    expect(again.results[0].degraded).toBeUndefined();
    expect(client.calls.length).toBe(3); // 2 attempts (retry) + 1 fresh
  });

  it("duplicate texts in one request are fetched once and fanned out", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    const r = await router.handle(req(["dup", "dup", "other"]));
    expect(client.calls[0].length).toBe(2);
    expect(r.results.map((x) => x.id)).toEqual(["b0", "b1", "b2"]);
    expect(r.results[0].bucket).toBe(r.results[1].bucket);
  });

  it("viewport batches run before background ones", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.hold();
    const order: string[] = [];
    const tag = (p: Promise<unknown>, name: string) => p.then(() => order.push(name));
    // Fill all four slots with background work, then queue more background and one viewport.
    const bg = Array.from({ length: 6 }, (_, i) => tag(router.handle(req([`bg ${i}`], "background")), `bg${i}`));
    await new Promise((r) => setTimeout(r, 10));
    const vp = tag(router.handle(req(["vp"], "viewport")), "vp");
    await new Promise((r) => setTimeout(r, 10));
    // Only the first four batches have reached the client; the viewport one must be next.
    expect(client.calls.length).toBe(4);
    client.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.calls[4][0].text).toBe("vp");
    client.release();
    await Promise.all([...bg, vp]);
  });
});
