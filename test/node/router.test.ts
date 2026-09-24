// test/node/router.test.ts — provenance and settlement invariants of the SW router.
import { describe, expect, it, beforeEach, vi } from "vitest";
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
import { NativeScoreError } from "../../lib/backend/nativeScoreClient";
import { NativeTransportError } from "../../lib/backend/nativeTransport";

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

function busyError(): Error {
  return new NativeScoreError(409, "busy", "Local queue full");
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
    client.fail(new NativeScoreError(413, "request_too_large", "Too much text"));
    await router.handle(req(["too much text for the daemon"]));
    expect(client.calls.length).toBe(1);
  });

  it("sends it again when the transport failed", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail(new NativeTransportError("native_unavailable", "Disconnected"));
    await router.handle(req(["a paragraph nobody could deliver"]));
    expect(client.calls.length).toBe(2);
  });

  it("does not retry a cancelled native request", async () => {
    const client = fakeClient(A);
    const router = createRouter(client);
    client.fail(new NativeTransportError("cancelled", "Cancelled"));
    const result = await router.handle(req(["cancelled work"]));
    expect(client.calls).toHaveLength(1);
    expect(result.results[0].degraded).toBe(true);
  });
});

describe("router invalidation, bounded admission and fairness", () => {
  it("uses identical canonical bytes for inference and dedup keys", async () => {
    const client = fakeClient(A), router = createRouter(client);
    const first = await router.handle(req(["range 1–2–3 costs \\\\%"]));
    await router.handle(req(["range 1-2-3 costs %"]));
    expect(first.results[0].degraded).toBeUndefined();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0][0].text).toBe("range 1-2-3 costs %");
  });

  it("separates calibration and snapshots a mutable model object", async () => {
    const mutable = { ...A }, client = fakeClient(mutable), router = createRouter(client);
    await router.handle(req(["same"]));
    mutable.calibration = "recalibrated";
    const answer = await router.handle(req(["same"]));
    expect(client.calls).toHaveLength(2);
    mutable.calibration = "changed after response";
    expect(answer.model.calibration).toBe("recalibrated");
  });

  it("never labels cached A and freshly produced B results as one model", async () => {
    const client = fakeClient(A), router = createRouter(client);
    await router.handle(req(["cached"]));
    client.hold();
    const work = router.handle(req(["cached", "fresh"]));
    await settle(); client.release(B);
    expect((await work).results.every((result) => result.degraded)).toBe(true);
  });

  it("never merges two micro-batches from different model snapshots", async () => {
    const client = fakeClient(A), router = createRouter(client);
    client.hold();
    const work = router.handle(req(["a".repeat(6000), "b".repeat(6000)]));
    await settle(); expect(client.calls).toHaveLength(2);
    client.releaseOne(A); client.releaseOne(B);
    expect((await work).results.every((result) => result.degraded)).toBe(true);
  });

  it("discards a late result after the runtime generation changes, even with the same model name", async () => {
    const client = fakeClient(A), router = createRouter(client);
    let generation = 1; client.revision = () => generation;
    client.hold(); const work = router.handle(req(["same runtime label"]));
    await settle(); generation++; client.release(A);
    expect((await work).results[0].degraded).toBe(true);
    await router.handle(req(["same runtime label"]));
    expect(client.calls).toHaveLength(2);
  });

  it("clears held successful inference and refuses its late cache write", async () => {
    const { createSwCache } = await import("../../lib/backend/swCache");
    const { fakeScoreStore } = await import("./scoreStore");
    const store = fakeScoreStore(), cache = createSwCache(store);
    const client = fakeClient(A), router = createRouter(client, cache);
    client.hold(); const work = router.handle(req(["old successful work"]));
    await settle(); await router.clear();
    expect((await work).results).toEqual([]); // no answer, so the page asks again
    client.release(); await settle();
    expect((await cache.getMany([cache.keyOf("old successful work", JSON.stringify([A.id, A.ver, A.calibration]))])).size).toBe(0);
    await router.handle(req(["old successful work"]));
    expect(client.calls).toHaveLength(2);
  });

  it("cancels before discovery settles and never starts the obsolete work", async () => {
    const { deferred } = await import("./scoreStore");
    const ready = deferred<void>(), client = fakeClient(A), router = createRouter(client);
    client.ready = () => ready.promise;
    const controller = new AbortController();
    const work = router.handle(req(["abandoned page"]), { documentKey: "doc", signal: controller.signal });
    controller.abort(); expect((await work).results[0].degraded).toBe(true);
    ready.resolve(); await settle(); expect(client.calls).toHaveLength(0);
  });

  it("keeps a shared batch alive for another document when its first reader cancels", async () => {
    const client = fakeClient(A), router = createRouter(client);
    client.hold();
    const cancel = new AbortController();
    const first = router.handle(req(["shared"]), { documentKey: "first", signal: cancel.signal });
    await settle();
    const second = router.handle(req(["shared"]), { documentKey: "second" });
    await settle(); cancel.abort();
    expect((await first).results[0].degraded).toBe(true);
    client.release(); expect((await second).results[0].degraded).toBeUndefined();
    expect(client.calls).toHaveLength(1);
  });

  it("leaves slots for other documents and rotates equal-priority queued work", async () => {
    const client = fakeClient(A), router = createRouter(client);
    client.hold();
    const many = Array.from({ length: 6 }, (_, index) => router.handle(req([`one ${index}`]), { documentKey: "one" }));
    await settle(); expect(client.calls).toHaveLength(2);
    const other = router.handle(req(["two"]), { documentKey: "two" });
    await settle(); expect(client.calls[2][0].text).toBe("two");
    client.release(); await Promise.all([...many, other]);
  });

  it("rejects per-document and global queued payload overflow before scoring", async () => {
    const { ROUTER_LIMITS } = await import("../../lib/backend/router");
    const client = fakeClient(A), router = createRouter(client);
    client.hold();
    const huge = await router.handle(req(["x".repeat(ROUTER_LIMITS.documentChars + 1)]), { documentKey: "one" });
    expect(huge.results[0].degraded).toBe(true); expect(client.calls).toHaveLength(0);
    const active = Array.from({ length: 4 }, (_, index) => router.handle(req([String(index).repeat(250_000)]), { documentKey: `doc${index}` }));
    await settle();
    expect((await router.handle(req(["overflow"]), { documentKey: "extra" })).results[0].degraded).toBe(true);
    expect(client.calls).toHaveLength(4);
    client.release(); await Promise.all(active);
    expect((await router.handle(req(["quota released"]), { documentKey: "extra" })).results[0].degraded).toBeUndefined();
  });
});

it("clear cancels discovery and delayed cache lookups before they can reserve work", async () => {
  const { deferred, fakeScoreStore } = await import("./scoreStore");
  const { createSwCache } = await import("../../lib/backend/swCache");
  const store = fakeScoreStore(), cache = createSwCache(store), client = fakeClient(A);
  const router = createRouter(client, cache), ready = deferred<void>();
  client.ready = () => ready.promise;
  const beforeReady = router.handle(req(["before ready"]));
  await router.clear(); ready.resolve();
  expect((await beforeReady).results).toEqual([]);
  client.ready = undefined;
  const started = deferred<void>(), read = deferred<Array<undefined>>();
  store.get = async () => { started.resolve(); return read.promise; };
  const beforeRead = router.handle(req(["before read"]));
  await started.promise; await router.clear(); read.resolve([undefined]);
  expect((await beforeRead).results).toEqual([]);
  expect(client.calls).toHaveLength(0);
});

it("limits queued item counts, reclaims cancelled capacity, and never sends abandoned queued work", async () => {
  const { ROUTER_LIMITS } = await import("../../lib/backend/router");
  const client = fakeClient(A), router = createRouter(client);
  client.hold();
  const over = await router.handle(req(Array.from({length: ROUTER_LIMITS.documentBlocks + 1}, (_, index) => `row ${index}`)), {documentKey:"too many"});
  expect(over.results.every((result) => result.degraded)).toBe(true);
  const held = Array.from({length:4}, (_, index) => router.handle(req([`held ${index}`]), {documentKey:`held ${index}`}));
  await settle();
  const cancel = new AbortController();
  const queued = router.handle(req(["cancelled queued"]), {documentKey:"cancel me", signal: cancel.signal});
  await settle(); cancel.abort();
  expect((await queued).results[0].degraded).toBe(true);
  client.release(); await Promise.all(held);
  expect(client.calls.flat().some((block) => block.text === "cancelled queued")).toBe(false);
});

it("aborts the underlying transport when the last reader leaves, but not while another remains", async () => {
  const { deferred } = await import("./scoreStore");
  const completion = deferred<ScoredBatch>();
  let signal: AbortSignal | undefined;
  const client: ScoreClient = {model:()=>A, scoreBatch: async (_blocks, value) => {signal = value; return completion.promise;}};
  const router = createRouter(client);
  const one = new AbortController(), two = new AbortController();
  const first = router.handle(req(["shared cancellation"]), {documentKey:"one", signal: one.signal});
  await settle();
  const second = router.handle(req(["shared cancellation"]), {documentKey:"two", signal: two.signal});
  await settle(); one.abort(); await first;
  expect(signal?.aborted).toBe(false);
  two.abort(); await second; expect(signal?.aborted).toBe(true);
  completion.resolve(scored([{id:"b0",text:"shared cancellation"}], A));
});


it("ages waiting background work ahead of a later stream of viewport requests", async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const client = fakeClient(A), router = createRouter(client);
  client.hold();
  try {
    const held = Array.from({length:4}, (_, index) => router.handle(req([`held aging ${index}`], "background")));
    await settle();
    const old = router.handle(req(["old background"], "background")); await settle();
    now += 3000;
    const recent = router.handle(req(["new viewport"], "viewport")); await settle();
    client.releaseOne(); await settle();
    expect(client.calls[4][0].text).toBe("old background");
    client.release(); await Promise.all([...held, old, recent]);
  } finally { client.release(); clock.mockRestore(); }
});

it("bounds all queued block references even when requests contain short text", async () => {
  const client = fakeClient(A), router = createRouter(client);
  client.hold();
  const held = Array.from({length:4}, (_, doc) => router.handle(req(Array.from({length:256}, (_, index)=>`d${doc} b${index}`)),{documentKey:`bounded ${doc}`}));
  await settle();
  const extra = await router.handle(req(["one more"]),{documentKey:"other"});
  expect(extra.results[0].degraded).toBe(true); expect(client.calls).toHaveLength(4);
  client.release(); await Promise.all(held);
});
