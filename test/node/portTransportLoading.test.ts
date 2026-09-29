// test/node/portTransportLoading.test.ts — a score that waits for a model that is still loading
// (lib/backend/portTransport.ts loadWaitMs, the in-browser engine's) is not timed out at 30 s while
// the engine says it is loading: it is answered when the model is in, with no new request, no
// pause and no retry cycle; a load that hangs still fails at the overall bound, and the local
// engine's transport keeps its 30 s exactly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortTransport, type NativePort } from "../../lib/backend/portTransport";
import { NativeScoreClient } from "../../lib/backend/nativeScoreClient";

const MODEL = { id: "editlens_roberta-large", ver: "verified", calibration: "editlens" };
const HEALTH = { ok: true, contract: "3.0", model: MODEL, n_buckets: 4, buckets: ["a", "b", "c", "d"], max_tokens: 512, device: "wasm", dtype: "fp32" };
const RESULT = { id: "p1", bucket: 3, probs: [0, 0, 0, 1], score: 1 };

/** An engine whose model is loaded `loadMs` from now (never, when null): health says engine_loading
 *  and status says loading until then; a score is held until then, and answered. */
function loadingEngine(loadMs: number | null, { holdsScores = true } = {}) {
  const posted: Array<{ id: string; op: string }> = [];
  let receive: (value: unknown) => void = () => {};
  let loaded = false;
  const held: string[] = [];
  const reply = (id: string, data: unknown) => receive({ v: 1, id, ok: true, status: 200, data });
  if (loadMs !== null) setTimeout(() => { loaded = true; for (const id of held.splice(0)) reply(id, { v: "3.0", model: MODEL, results: [RESULT] }); }, loadMs);
  const port: NativePort = {
    postMessage(message) {
      const { id, op } = message as { id: string; op: string };
      posted.push({ id, op });
      if (op === "status") reply(id, { state: holdsScores && !loaded ? "loading" : "ready" });
      else if (op === "health") {
        if (loaded) reply(id, HEALTH);
        else receive({ v: 1, id, ok: false, status: 503, error: { code: "engine_loading", message: "The model is loading; what is sent waits for it" } });
      } else if (op === "score") {
        if (loaded) reply(id, { v: "3.0", model: MODEL, results: [RESULT] });
        else held.push(id);
      }
    },
    disconnect() { /* nothing */ },
    onMessage: { addListener: (fn) => { receive = fn; } },
    onDisconnect: { addListener: () => { /* the port stays up */ } },
  };
  return { port, posted, ops: (op: string) => posted.filter((m) => m.op === op).length };
}

const web = (port: NativePort) => new PortTransport(() => port, { cannotStart: "x", loadWaitMs: 300_000 });
const local = (port: NativePort) => new PortTransport(() => port, { cannotStart: "x" });
const client = (transport: PortTransport) => new NativeScoreClient((op, payload, signal) => transport.request(op, payload, signal));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a request that waits for a model that is loading", () => {
  it("is answered when the model is in, past the old 30 s, with no new request and no retry cycle", async () => {
    const engine = loadingEngine(100_000);
    const transport = web(engine.port);
    const scores = client(transport);
    const batch = scores.scoreBatch([{ id: "p1", text: "some text" }]);
    let settled: unknown;
    void batch.then((b) => { settled = b; }, (e) => { settled = e; });
    await vi.advanceTimersByTimeAsync(95_000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(settled).toMatchObject({ results: [{ id: "p1", bucket: 3 }], model: MODEL });
    // Asked once, held, answered: the page was never told to pause and try again.
    expect(engine.ops("score")).toBe(1);
    // The transport looked at the engine each 30 s, and nothing more.
    expect(engine.ops("status")).toBeGreaterThanOrEqual(3);
    expect(engine.ops("status")).toBeLessThanOrEqual(4);
    expect(scores.isUp()).toBe(true);
    transport.close();
  });

  it("still fails at the overall bound when the load hangs", async () => {
    const engine = loadingEngine(null);
    const transport = web(engine.port);
    const outcome = transport.request("score", { v: "3.0", blocks: [{ id: "p1", text: "x" }] }).then(() => "answered", (e: { code?: string }) => e.code);
    let result: string | undefined;
    void outcome.then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(290_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(result).toBe("native_timeout");
    expect(engine.ops("score")).toBe(1);
    transport.close();
  });

  it("times out at its own 30 s when the engine is not loading (it is only slow)", async () => {
    const engine = loadingEngine(null, { holdsScores: false });
    const transport = web(engine.port);
    let result: string | undefined;
    void transport.request("score", { v: "3.0", blocks: [{ id: "p1", text: "x" }] }).then(() => "answered", (e: { code?: string }) => e.code).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result).toBe("native_timeout");
    transport.close();
  });

  it("leaves the local engine's transport exactly as it is: 30 s, then a timeout", async () => {
    const engine = loadingEngine(100_000);
    const transport = local(engine.port);
    let result: string | undefined;
    void transport.request("score", { v: "3.0", blocks: [{ id: "p1", text: "x" }] }).then(() => "answered", (e: { code?: string }) => e.code).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(result).toBe("native_timeout");
    // Nothing else was asked of the engine on its account.
    expect(engine.ops("status")).toBe(0);
    transport.close();
  });

  it("keeps the timeout of every other operation, whatever the engine says", async () => {
    const engine = loadingEngine(null);
    const transport = web(engine.port);
    let result: string | undefined;
    // A `runtime` read that gets no answer times out on time, the engine loading or not.
    void transport.request("runtime", {}, undefined, 5_000).then(() => "answered", (e: { code?: string }) => e.code).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(result).toBe("native_timeout");
    transport.close();
  });
});
