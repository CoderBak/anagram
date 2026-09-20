// test/node/router.test.ts — provenance and settlement invariants of the SW router.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createRouter } from "../../lib/backend/router";
import type {
  ModelInfo,
  ScoreBatchRequest,
  ScoreBatchResponse,
  ScoreBlock,
  ScoreClient,
  ScoredBatch,
} from "../../lib/contract";
import { CONTRACT_VERSION } from "../../lib/contract";

const A: ModelInfo = { id: "model-a", ver: "1", calibration: "none" };
const B: ModelInfo = { id: "model-b", ver: "1", calibration: "none" };

function req(texts: string[], priority: ScoreBatchRequest["priority"] = "viewport"): ScoreBatchRequest {
  return {
    v: CONTRACT_VERSION,
    session: "s",
    priority,
    blocks: texts.map((text, i) => ({ id: `b${i}`, text })),
  };
}

function scored(blocks: ScoreBlock[], model: ModelInfo, bucket = 3): ScoredBatch {
  return {
    model,
    results: blocks.map((b) => ({ id: b.id, bucket, probs: bucket === 3 ? [0, 0, 0.1, 0.9] : [0.9, 0.1, 0, 0], score: bucket / 3 })),
  };
}

/** The error a daemon that is merely BUSY produces (lib/backend/httpClient.ts's
 *  DaemonHttpError shape) — the only kind of failure the router may send again. */
function busyError(retryAfterMs: number | null = null): Error {
  return Object.assign(new Error("anagramd HTTP 503"), { status: 503, retryAfterMs });
}

/** A controllable fake backend: every scoreBatch call is recorded and can be held open.
 *  A held call carries ITS OWN blocks, so releasing one or all of them answers each with
 *  the paragraphs it was actually given. */
function fakeClient(initial: ModelInfo) {
  let current = initial;
  const calls: ScoreBlock[][] = [];
  const holds: Array<{ blocks: ScoreBlock[]; settle: (v: ScoredBatch) => void }> = [];
  let mode: "auto" | "hold" | "fail" = "auto";
  let failure: Error = busyError();
  const client: ScoreClient & {
    calls: ScoreBlock[][];
    setModel(m: ModelInfo): void;
    hold(): void;
    fail(error?: Error): void;
    release(model?: ModelInfo): void;
    releaseOne(model?: ModelInfo): void;
  } = {
    calls,
    model: () => current,
    setModel: (m) => {
      current = m;
    },
    hold: () => {
      mode = "hold";
    },
    fail: (error = busyError()) => {
      mode = "fail";
      failure = error;
    },
    /** Answer every held call and let later ones through. */
    release: (model = current) => {
      for (const h of holds.splice(0)) h.settle(scored(h.blocks, model));
      mode = "auto";
    },
    /** Answer the oldest held call only; the backend stays held. */
    releaseOne: (model = current) => {
      const h = holds.shift();
      if (h) h.settle(scored(h.blocks, model));
    },
    async scoreBatch(blocks) {
      calls.push(blocks);
      if (mode === "fail") throw failure;
      if (mode === "hold") {
        return new Promise<ScoredBatch>((res) => {
          holds.push({ blocks, settle: res });
        });
      }
      return scored(blocks, current);
    },
  };
  return client;
}

/** Let the router's awaits (cache lookup, queue dispatch) run to quiescence. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

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
    client.fail(); // a busy daemon: the one failure that is worth sending again
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

  it("a joined request reports the identity that produced the batch it joined", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.hold();
    const producer = router.handle(req(["one paragraph, two readers"]));
    await settle();
    const joiner = router.handle(req(["one paragraph, two readers"]));
    await settle();
    expect(client.calls.length).toBe(1);
    client.setModel(B); // the health probe now reports another backend…
    client.release(A); // …but this batch came from A
    const [p, j] = await Promise.all([producer, joiner]);
    expect(p.model).toEqual(A);
    expect(j.model).toEqual(A); // the producer's identity, not the current snapshot
  });
});

describe("router queueing", () => {
  it("a request joins a batch that is still waiting for a slot", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.hold();
    // Four held batches occupy every slot, so the fifth can only wait in the queue.
    const busy = Array.from({ length: 4 }, (_, i) => router.handle(req([`busy ${i}`], "background")));
    await settle();
    expect(client.calls.length).toBe(4);
    const first = router.handle(req(["queued paragraph"], "background"));
    await settle();
    expect(client.calls.length).toBe(4); // still queued: nothing reached the backend
    const second = router.handle(req(["queued paragraph"], "background"));
    await settle();
    client.release();
    const [r1, r2] = await Promise.all([first, second]);
    await Promise.all(busy);
    expect(client.calls.length).toBe(5); // the waiting batch was joined, not duplicated
    expect(r1.results[0].degraded).toBeUndefined();
    expect(r2.results[0].degraded).toBeUndefined();
  });

  it("a viewport request promotes the queued batch it joins", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.hold();
    const busy = Array.from({ length: 4 }, (_, i) => router.handle(req([`busy ${i}`], "background")));
    await settle();
    const queued = ["q0", "q1", "q2"].map((t) => router.handle(req([t], "background")));
    await settle();
    expect(client.calls.length).toBe(4); // the three background batches are all waiting
    const vp = router.handle(req(["q2"], "viewport")); // joins the LAST of them
    await settle();
    client.releaseOne(); // one slot frees; the promoted batch must take it
    await settle();
    expect(client.calls[4][0].text).toBe("q2");
    client.release();
    await Promise.all([...busy, ...queued, vp]);
  });

  it("a joined request settles degraded when the batch it joined fails", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail(); // busy, so there IS a backoff for the second request to arrive inside
    const first = router.handle(req(["doomed paragraph"]));
    await settle(); // inside the retry backoff, so the join happens mid-flight
    const second = router.handle(req(["doomed paragraph"]));
    const both = await Promise.race([
      Promise.all([first, second]),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
    ]);
    expect(both).not.toBe("timeout");
    const [r1, r2] = both as ScoreBatchResponse[];
    expect(r1.results[0].degraded).toBe(true);
    expect(r2.results[0].degraded).toBe(true);
    expect(client.calls.length).toBe(2); // one attempt plus the retry; the joiner added none
    client.release();
    const again = await router.handle(req(["doomed paragraph"]));
    expect(again.results[0].degraded).toBeUndefined(); // nothing degraded was cached
    expect(client.calls.length).toBe(3);
  });
});

describe("router retry", () => {
  it("does not send a batch the daemon refused on its merits", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    // A response that failed validation says the same thing every time it is asked for;
    // sending it again only doubles the load on a daemon already answering.
    client.fail(Object.assign(new Error("malformed /score response"), { name: "ProtocolError" }));
    const r = await router.handle(req(["a paragraph the daemon mis-answers"]));
    expect(r.results[0].degraded).toBe(true);
    expect(client.calls.length).toBe(1);
  });

  it("does not send a batch again after a 4xx", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail(Object.assign(new Error("anagramd HTTP 413"), { status: 413, retryAfterMs: null }));
    await router.handle(req(["too much text for the daemon"]));
    expect(client.calls.length).toBe(1);
  });

  it("sends it again when the transport failed", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail(new TypeError("Failed to fetch"));
    await router.handle(req(["a paragraph nobody could deliver"]));
    expect(client.calls.length).toBe(2);
  });

  it("waits as long as a short Retry-After asks", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail(busyError(400));
    const started = Date.now();
    await router.handle(req(["one request too many"]));
    expect(client.calls.length).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
  });

  it("answers at once rather than holding a slot for a long Retry-After", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail(busyError(30_000)); // "come back in half a minute" — not with a slot held
    const started = Date.now();
    const r = await router.handle(req(["one request too many, for a while"]));
    expect(client.calls.length).toBe(1);
    expect(r.results[0].degraded).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
