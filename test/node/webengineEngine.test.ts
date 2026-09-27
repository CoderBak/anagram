// test/node/webengineEngine.test.ts — the in-browser engine's lifecycle and operations,
// on the in-memory store, a fake server and a fake forward pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, type LoadedSession } from "../../lib/webengine/engine";
import { parseEngineRequest, parseScorePayload, parseTokensPayload } from "../../lib/webengine/protocol";
import { sha256Hex } from "../../lib/webengine/sha256";
import { MemoryStore } from "../../lib/webengine/storage";
import type { Candidate } from "../../lib/webengine/session";
import { tinyTokenizerJson } from "../fixtures/webengine/tinyTokenizer.mjs";
import { fakeServer, type FakeServerOptions } from "./webengineFake";

const FIXTURES = join(__dirname, "..", "fixtures", "webengine");
const MODEL = new Uint8Array(readFileSync(join(FIXTURES, "tiny.onnx")));
const LID = new Uint8Array(readFileSync(join(FIXTURES, "tiny-lid.bin")));
const TOKENIZER = new TextEncoder().encode(JSON.stringify(tinyTokenizerJson()));
const FILES = { "/model.onnx": MODEL, "/tokenizer.json": TOKENIZER, "/lid.176.ftz": LID };
const pin = () => ({
  files: [
    { name: "model.onnx", size_bytes: MODEL.length, sha256: sha256Hex(MODEL), url: "https://example.test/model.onnx" },
    { name: "tokenizer.json", size_bytes: TOKENIZER.length, sha256: sha256Hex(TOKENIZER), url: "https://example.test/tokenizer.json" },
    { name: "lid.176.ftz", size_bytes: LID.length, sha256: sha256Hex(LID), url: "https://example.test/lid.176.ftz" },
  ],
  model: { id: "editlens_roberta-large", calibration: "editlens-4bucket-cosine(0.03,0.15)" },
  license: "CC-BY-NC-SA-4.0",
});
const ASSETS = { ort: "x", mjs: "x", wasm: "x" };

/** make-fixtures.py's table: what the tiny ONNX model computes. */
const row = (i: number) => [((i % 7) / 7 - 0.5) * 0.4, ((i % 11) / 11 - 0.5) * 0.4, ((i % 13) / 13 - 0.5) * 0.4, ((i % 17) / 17 - 0.5) * 0.4];
const candidates = (): Candidate[] => [
  { id: "webgpu:fp32", label: "GPU", device: "gpu", runtime: "onnxruntime-web/webgpu", precision: "fp32", experimental: false, available: true, reason: null },
  { id: "wasm:fp32", label: "CPU", device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false, available: true, reason: null },
];

function fakeSession(candidate: Candidate, model: Uint8Array, log: string[]): LoadedSession {
  expect(model).toEqual(MODEL);
  log.push(`create ${candidate.id}`);
  return {
    info: { candidate, threads: 1, createMs: 5, firstRunMs: 1 },
    device: candidate.id === "webgpu:fp32" ? "webgpu" : "wasm",
    async logits(ids, mask) {
      const out = new Float32Array(ids.length * 4);
      ids.forEach((r, i) => r.forEach((id, j) => { if (mask[i][j]) row(id).forEach((v, k) => { out[i * 4 + k] += v; }); }));
      return out;
    },
    async release() { log.push(`release ${candidate.id}`); },
  };
}

interface Made { engine: Engine; store: MemoryStore; log: string[]; server: ReturnType<typeof fakeServer>; clock: { now: number } }
function make(options: { store?: MemoryStore; server?: FakeServerOptions; failing?: string[]; probe?: Candidate[] } = {}): Made {
  const store = options.store ?? new MemoryStore();
  const log: string[] = [];
  const server = fakeServer(FILES, options.server);
  const clock = { now: 1_000_000 };
  const engine = new Engine({
    pin: pin(), assets: ASSETS, version: "9.9.9", store, transport: server.fetch, retryWaits: [0],
    createSession: async (candidate, model) => {
      if (options.failing?.includes(candidate.id)) { log.push(`fail ${candidate.id}`); throw new Error("no such device"); }
      return fakeSession(candidate, model, log);
    },
    probe: async () => options.probe ?? candidates(),
    now: () => clock.now,
  });
  return { engine, store, log, server, clock };
}
const ready = async (engine: Engine) => {
  for (let i = 0; i < 200; i++) {
    const { data } = await engine.handle("status", {});
    const state = (data as { state: string }).state;
    if (state === "ready" || state === "error") return data as { state: string; error: unknown };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never ready");
};
const fails = (p: Promise<unknown>, code: string, status: number) => expect(p).rejects.toMatchObject({ code, status });

let engines: Engine[] = [];
beforeEach(() => { engines = []; });
afterEach(async () => { for (const e of engines) await e.close(); });
const track = (m: Made) => { engines.push(m.engine); return m; };

describe("the engine's lifecycle", () => {
  it("needs the models first, downloads them on request, verifies each and loads the model", async () => {
    const m = track(make());
    let { data } = await m.engine.handle("status", {});
    expect(data).toMatchObject({ schema_version: 1, version: "9.9.9", state: "needs_models", runtime: null, download: { status: "idle" }, storage: { models_bytes: 0 } });
    await fails(m.engine.handle("health", {}), "not_ready", 503);
    await fails(m.engine.handle("runtime", {}), "not_ready", 503);
    ({ data } = await m.engine.handle("models.download", {}));
    expect((data as { state: string }).state).toBe("downloading");
    const status = await ready(m.engine);
    expect(status.state).toBe("ready");
    ({ data } = await m.engine.handle("status", {}));
    const total = MODEL.length + TOKENIZER.length + LID.length;
    expect(data).toMatchObject({ download: { status: "completed", phase: "complete", bytes_received: total, total_bytes: total }, storage: { models_bytes: expect.any(Number) } });
    expect((data as { storage: { models_bytes: number } }).storage.models_bytes).toBeGreaterThan(total);
    expect(m.server.requests.map((r) => r.url)).toEqual(["https://example.test/model.onnx", "https://example.test/tokenizer.json", "https://example.test/lid.176.ftz"]);
    expect(m.log).toEqual(["create webgpu:fp32"]);
    ({ data } = await m.engine.handle("health", {}));
    expect(data).toMatchObject({ ok: true, contract: "3.0", app_version: "9.9.9", model: { id: "editlens_roberta-large", calibration: "editlens-4bucket-cosine(0.03,0.15)" }, n_buckets: 4, max_tokens: 512, device: "webgpu", dtype: "fp32", lid: "fasttext-lid.176" });
    expect((data as { model: { ver: string } }).model.ver).toMatch(/^sha256:[0-9a-f]{12}-p[0-9a-f]{8}-web1$/);
    ({ data } = await m.engine.handle("runtime", {}));
    expect(data).toMatchObject({ state: "ready", active_id: "webgpu:fp32", recommended_id: "webgpu:fp32", selected_id: "webgpu:fp32", benchmark: { status: "idle", results: [{ candidate_id: "webgpu:fp32", status: "ok" }] } });
  });

  it("scores English through the gate and refuses the rest, in the contract's shapes", async () => {
    const m = track(make());
    await m.engine.handle("models.download", {});
    await ready(m.engine);
    const { data } = await m.engine.handle("score", { v: "3.0", blocks: [
      { id: "a", text: "hello world" }, { id: "b", text: "bonjour le monde" }, { id: "c", text: "   " }, { id: "d", text: "the the" },
    ] });
    const response = data as { v: string; model: { id: string }; results: Array<Record<string, unknown>> };
    expect(response.v).toBe("3.0");
    expect(response.model.id).toBe("editlens_roberta-large");
    expect(response.results.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    const [a, b, c, d] = response.results;
    expect(a).toMatchObject({ lang: "en", tokens: expect.any(Number), truncated: false });
    expect(a.lang_prob).toBe(0.535);
    expect((a.probs as number[]).reduce((x, y) => x + y)).toBeCloseTo(1, 3);
    expect(b).toMatchObject({ bucket: 0, probs: [0.25, 0.25, 0.25, 0.25], score: 0, tokens: 0, truncated: false, lang: "fr", lang_prob: 0.529, unsupported: true });
    expect(c).toMatchObject({ bucket: 0, score: 0, tokens: 0, degraded: true });
    // The tiny model sums a fixed row per token: the expected logits are known.
    const ids = [0, ...[0, 0].map(() => 0), 2];
    void ids;
    expect(d.tokens).toBe(4);
    const { data: counts } = await m.engine.handle("tokens", { v: "3.0", texts: ["the the", ""] });
    expect(counts).toEqual({ alone: [2, 0], following: [2, 0], window: 510 });
  });

  it("refuses malformed requests as the native host does", async () => {
    const m = track(make());
    await m.engine.handle("models.download", {});
    await ready(m.engine);
    await fails(m.engine.handle("score", { v: "2.0", blocks: [] }), "invalid_request", 422);
    await fails(m.engine.handle("score", { v: "3.0", blocks: [{ id: "x", text: "a" }, { id: "x", text: "b" }] }), "invalid_request", 422);
    await fails(m.engine.handle("score", { v: "3.0", blocks: [{ id: "", text: "a" }] }), "invalid_request", 422);
    await fails(m.engine.handle("score", { v: "3.0", blocks: [{ id: "x", text: "a".repeat(16001) }] }), "invalid_request", 422);
    await fails(m.engine.handle("score", { v: "3.0", blocks: new Array(257).fill(0).map((_, i) => ({ id: String(i), text: "a" })) }), "invalid_request", 422);
    await fails(m.engine.handle("tokens", { v: "3.0", texts: [1] }), "invalid_request", 422);
    await fails(m.engine.handle("status", { extra: 1 }), "invalid_request", 422);
    await fails(m.engine.handle("engine.settings", { idle_unload_s: 30 }), "invalid_request", 422);
    await fails(m.engine.handle("models.delete", { confirm: false }), "invalid_request", 422);
    await fails(m.engine.handle("runtime.config", { id: "nope" }), "invalid_request", 422);
    expect(parseEngineRequest({ v: 1, id: "a-1", op: "status", payload: {} })).not.toBeNull();
    expect(parseEngineRequest({ v: 1, id: "a-1", op: "component.update", payload: {} })).toBeNull();
    expect(parseEngineRequest({ v: 1, id: "bad id", op: "status", payload: {} })).toBeNull();
    expect(parseEngineRequest({ v: 1, id: "a", op: "status", payload: {}, more: 1 })).toBeNull();
    expect(() => parseScorePayload({ v: "3.0" })).not.toThrow();
    expect(() => parseTokensPayload({ v: "3.0", texts: ["a".repeat(16000), "b".repeat(16000)].concat(new Array(15).fill("c".repeat(16000))) })).toThrow();
  });

  it("pauses a download, resumes it from where it stopped, and carries on after a restart", async () => {
    const m = track(make({ server: { stallAfter: 2000 } }));
    await m.engine.handle("models.download", {});
    await new Promise((r) => setTimeout(r, 30));
    let { data } = await m.engine.handle("status", {});
    expect(data).toMatchObject({ state: "downloading", download: { status: "running", phase: "downloading", file: "model.onnx", bytes_received: 2000 } });
    ({ data } = await m.engine.handle("models.pause", {}));
    expect(data).toMatchObject({ state: "paused", download: { status: "paused", bytes_received: 2000 } });
    await fails(m.engine.handle("models.pause", {}), "busy", 409);
    expect(await m.store.size("model.onnx.part")).toBe(2000);
    // A new engine over the same store (the browser restarted): still paused, then resumed.
    await m.engine.close();
    const next = track(make({ store: m.store }));
    ({ data } = await next.engine.handle("status", {}));
    expect(data).toMatchObject({ state: "paused", download: { status: "paused" } });
    await next.engine.handle("engine.resume", {});
    expect((await ready(next.engine)).state).toBe("ready");
    expect(next.server.requests[0]).toEqual({ url: "https://example.test/model.onnx", range: "bytes=2000-" });
  });

  it("reports a failed download and retries it on request", async () => {
    const m = track(make({ server: { status: 500 } }));
    await m.engine.handle("models.download", {});
    const status = await ready(m.engine);
    expect(status).toMatchObject({ state: "error", error: { code: "download_failed" }, download: { status: "failed" } });
    m.server.options.status = undefined;
    await m.engine.handle("models.download", {});
    expect((await ready(m.engine)).state).toBe("ready");
  });

  it("lets the model go when idle and loads it again for the next score", async () => {
    const m = track(make());
    await m.engine.handle("models.download", {});
    await ready(m.engine);
    await m.engine.handle("engine.settings", { idle_unload_s: 60 });
    m.clock.now += 61_000;
    await new Promise((r) => setTimeout(r, 1100));
    let { data } = await m.engine.handle("status", {});
    expect(data).toMatchObject({ state: "idle", runtime: { state: "idle", active_id: null } });
    expect(m.log).toEqual(["create webgpu:fp32", "release webgpu:fp32"]);
    await fails(m.engine.handle("health", {}), "engine_idle", 503);
    ({ data } = await m.engine.handle("score", { v: "3.0", blocks: [{ id: "a", text: "hello world" }] }));
    expect((data as { results: Array<{ lang: string }> }).results[0].lang).toBe("en");
    expect(m.log).toEqual(["create webgpu:fp32", "release webgpu:fp32", "create webgpu:fp32"]);
    ({ data } = await m.engine.handle("status", {}));
    expect((data as { state: string }).state).toBe("ready");
  }, 10_000);

  it("stops and resumes, and deletes the model files", async () => {
    const m = track(make());
    await m.engine.handle("models.download", {});
    await ready(m.engine);
    let { data } = await m.engine.handle("engine.stop", {});
    expect(data).toMatchObject({ state: "stopped" });
    expect(m.log).toContain("release webgpu:fp32");
    await fails(m.engine.handle("score", { v: "3.0", blocks: [] }), "not_ready", 503);
    await m.engine.handle("engine.resume", {});
    expect((await ready(m.engine)).state).toBe("ready");
    ({ data } = await m.engine.handle("models.delete", { confirm: true }));
    expect(data).toMatchObject({ state: "needs_models", operation: { name: "delete_models", status: "completed" }, storage: { models_bytes: expect.any(Number) } });
    expect(await m.store.list()).toEqual(["state.json"]);
    // A restart finds nothing to load and does not download by itself.
    await m.engine.close();
    const next = track(make({ store: m.store }));
    expect((await next.engine.handle("status", {})).data).toMatchObject({ state: "needs_models" });
    expect(next.server.requests).toEqual([]);
  });

  it("falls back to the CPU provider when the GPU one fails, and honours a chosen runtime", async () => {
    const m = track(make({ failing: ["webgpu:fp32"] }));
    await m.engine.handle("models.download", {});
    await ready(m.engine);
    expect(m.log).toEqual(["fail webgpu:fp32", "create wasm:fp32"]);
    let { data } = await m.engine.handle("runtime", {});
    expect(data).toMatchObject({ active_id: "wasm:fp32", candidates: [{ id: "webgpu:fp32", available: false, reason: expect.stringContaining("no such device") }, { id: "wasm:fp32", available: true }] });
    await fails(m.engine.handle("runtime.config", { id: "webgpu:fp32" }), "invalid_request", 422);
    const both = track(make());
    await both.engine.handle("models.download", {});
    await ready(both.engine);
    ({ data } = await both.engine.handle("runtime.config", { id: "wasm:fp32" }));
    expect(data).toMatchObject({ selected_id: "wasm:fp32" });
    expect((await ready(both.engine)).state).toBe("ready");
    expect(both.log).toEqual(["create webgpu:fp32", "release webgpu:fp32", "create wasm:fp32"]);
    expect((await both.engine.handle("health", {})).data).toMatchObject({ device: "wasm" });
  });

  it("refuses to download on a damaged preference file until told to", async () => {
    const store = new MemoryStore();
    const writer = await store.writer("state.json", false);
    await writer.write(new TextEncoder().encode("{not json"));
    await writer.close();
    const m = track(make({ store }));
    expect((await m.engine.handle("status", {})).data).toMatchObject({ state: "stopped", error: { code: "invalid_request" } });
    expect(m.server.requests).toEqual([]);
    await m.engine.handle("models.download", {});
    expect((await ready(m.engine)).state).toBe("ready");
  });

  it("bounds the score queue", async () => {
    const m = track(make());
    await m.engine.handle("models.download", {});
    await ready(m.engine);
    const many = Array.from({ length: 9 }, (_, i) => m.engine.handle("score", { v: "3.0", blocks: [{ id: String(i), text: "hello world" }] }));
    const settled = await Promise.allSettled(many);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
    expect((settled[8] as PromiseRejectedResult).reason).toMatchObject({ code: "busy", status: 409 });
  });
});
void vi;
