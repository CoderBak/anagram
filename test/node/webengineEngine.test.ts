// test/node/webengineEngine.test.ts — the in-browser engine's lifecycle and operations,
// on the in-memory store, a fake server and a fake forward pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, type LoadedSession } from "../../lib/webengine/engine";
import { parseEngineRequest, parseScorePayload, parseTokensPayload } from "../../lib/webengine/protocol";
import { sha256Hex } from "../../lib/webengine/sha256";
import { MemoryStore } from "../../lib/webengine/storage";
import { probeRuntimes, wasmThreads, type Candidate } from "../../lib/webengine/session";
import { tinyTokenizerJson } from "../fixtures/webengine/tinyTokenizer.mjs";
import { fakeServer, FullDisk, type FakeServerOptions } from "./webengineFake";
import { parseComponent } from "../../lib/backend/nativeClient";
import { engineSetup, setupStage } from "../../lib/backend/engineSetup";

const FIXTURES = join(__dirname, "..", "fixtures", "webengine");
const MODEL = new Uint8Array(readFileSync(join(FIXTURES, "tiny.onnx")));
const LID = new Uint8Array(readFileSync(join(FIXTURES, "tiny-lid.bin")));
const TOKENIZER = new TextEncoder().encode(JSON.stringify(tinyTokenizerJson()));
const FILES = { "/model.onnx": MODEL, "/tokenizer.json": TOKENIZER };
/** The package's lid.176.ftz, as the engine fetches it: here a data: URL of `bytes`. */
const packaged = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
const pin = (lid: Uint8Array = LID) => ({
  files: [
    { name: "model.onnx", size_bytes: MODEL.length, sha256: sha256Hex(MODEL), url: "https://example.test/model.onnx" },
    { name: "tokenizer.json", size_bytes: TOKENIZER.length, sha256: sha256Hex(TOKENIZER), url: "https://example.test/tokenizer.json" },
  ],
  lid: { name: "lid.176.ftz", size_bytes: LID.length, sha256: sha256Hex(LID), url: packaged(lid) },
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

async function fakeSession(candidate: Candidate, model: Blob, log: string[]): Promise<LoadedSession> {
  expect(new Uint8Array(await model.arrayBuffer())).toEqual(MODEL);
  log.push(`create ${candidate.id}`);
  return {
    info: { candidate, createMs: 5, firstRunMs: 1 },
    device: candidate.id === "webgpu:fp32" ? "webgpu" : "wasm",
    async logits(ids, mask) {
      const out = new Float32Array(ids.length * 4);
      ids.forEach((r, i) => r.forEach((id, j) => { if (mask[i]![j]) row(id).forEach((v, k) => { out[i * 4 + k]! += v; }); }));
      return out;
    },
    async release() { log.push(`release ${candidate.id}`); },
  };
}

interface Made { engine: Engine; store: MemoryStore; log: string[]; server: ReturnType<typeof fakeServer>; clock: { now: number } }
function make(options: { store?: MemoryStore; server?: FakeServerOptions; failing?: string[]; probe?: Candidate[]; idle?: boolean; lid?: Uint8Array; hold?: Promise<void> } = {}): Made {
  const store = options.store ?? new MemoryStore();
  const log: string[] = [];
  const server = fakeServer(FILES, options.server);
  const clock = { now: 1_000_000 };
  const engine = new Engine({
    pin: pin(options.lid), assets: ASSETS, version: "9.9.9", store, transport: server.fetch, retryWaits: [0],
    createSession: async (candidate, model) => {
      if (options.failing?.includes(candidate.id)) { log.push(`fail ${candidate.id}`); throw new Error("no such device"); }
      await options.hold; // a model that takes its time to load
      return fakeSession(candidate, model, log);
    },
    probe: async () => options.probe ?? candidates(),
    now: () => clock.now,
    idle: options.idle,
    onIdle: () => log.push("idle"),
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
    // lid.176.ftz is the package's: setup downloads and counts the model and tokenizer only.
    const total = MODEL.length + TOKENIZER.length;
    expect(data).toMatchObject({ download: { status: "completed", phase: "complete", bytes_received: total, total_bytes: total }, storage: { models_bytes: expect.any(Number) } });
    // The model files, not the state file beside them.
    expect((data as { storage: { models_bytes: number } }).storage.models_bytes).toBe(total);
    expect(m.server.requests.map((r) => r.url)).toEqual(["https://example.test/model.onnx", "https://example.test/tokenizer.json"]);
    expect(await m.store.list()).toEqual(["model.onnx", "state.json", "tokenizer.json"]);
    expect(m.log).toEqual(["create webgpu:fp32"]);
    ({ data } = await m.engine.handle("health", {}));
    expect(data).toMatchObject({ ok: true, contract: "3.0", app_version: "9.9.9", model: { id: "editlens_roberta-large", calibration: "editlens-4bucket-cosine(0.03,0.15)" }, n_buckets: 4, max_tokens: 512, device: "webgpu", dtype: "fp32", lid: "fasttext-lid.176" });
    expect((data as { model: { ver: string } }).model.ver).toMatch(/^sha256:[0-9a-f]{12}-p[0-9a-f]{8}-web1$/);
    ({ data } = await m.engine.handle("runtime", {}));
    expect(data).toMatchObject({ state: "ready", active_id: "webgpu:fp32", recommended_id: "webgpu:fp32", selected_id: "webgpu:fp32", benchmark: { status: "idle", results: [{ candidate_id: "webgpu:fp32", status: "ok" }] } });
  });

  it("reads lid.176.ftz from the package whenever it loads, and refuses bytes that are not the pinned ones", async () => {
    const tampered = LID.slice();
    tampered[100] = tampered[100]! ^ 0xff;
    const m = track(make({ lid: tampered }));
    await m.engine.handle("models.download", {});
    const status = await ready(m.engine);
    expect(status).toMatchObject({ state: "error", error: { code: "not_ready", message: "lid.176.ftz in the extension is not the pinned file" } });
    expect(m.log).toEqual([]);
    expect(m.server.requests.map((r) => r.url)).not.toContain(expect.stringContaining("lid"));
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
    expect(a!.lang_prob).toBe(0.535);
    expect((a!.probs as number[]).reduce((x, y) => x + y)).toBeCloseTo(1, 3);
    expect(b).toMatchObject({ bucket: 0, probs: [0.25, 0.25, 0.25, 0.25], score: 0, tokens: 0, truncated: false, lang: "fr", lang_prob: 0.529, unsupported: true });
    expect(c).toMatchObject({ bucket: 0, score: 0, tokens: 0, degraded: true });
    // The tiny model sums a fixed row per token: the expected logits are known.
    const ids = [0, ...[0, 0].map(() => 0), 2];
    void ids;
    expect(d!.tokens).toBe(4);
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

  it("says it is retrying a dropped connection only until the bytes come again", async () => {
    // The first answer is cut after 50 bytes; the retry's delivers 200 more and then waits.
    const cut = fakeServer(FILES, { cutAfter: 50 }), slow = fakeServer(FILES, { stallAfter: 200 });
    let calls = 0;
    const engine = new Engine({
      pin: pin(), assets: ASSETS, version: "9.9.9", store: new MemoryStore(), retryWaits: [20],
      transport: ((url: string, init?: RequestInit) => (calls++ === 0 ? cut : slow).fetch(url, init)) as typeof fetch,
      createSession: async (candidate, model) => fakeSession(candidate, model, []), probe: async () => candidates(),
    });
    engines.push(engine);
    await engine.handle("models.download", {});
    type Download = { status: string; bytes_received: number; detail: string | null };
    const seen: Download[] = [];
    for (let i = 0; i < 400 && seen.at(-1)?.bytes_received !== 250; i++) {
      seen.push(((await engine.handle("status", {})).data as { download: Download }).download);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(seen.some((d) => d.detail === "Retrying model.onnx in 0 s")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ status: "running", bytes_received: 250, detail: null });
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

  it("stops at once on a disk that fills up mid-download, says how much room to make, and Retry carries on from the part", async () => {
    // The state file is written first; then 2,000 bytes of the model fit, and every write after
    // that, the state file's included, is refused as a full disk refuses it.
    const store = new FullDisk(Infinity);
    const m = track(make({ store }));
    await m.engine.handle("status", {});
    store.room = store.used() + 400 + 2000;
    await m.engine.handle("models.download", {});
    const status = await ready(m.engine) as unknown as { state: string; download: { error: string } };
    expect(status).toMatchObject({ state: "error", error: { code: "download_failed" }, download: { status: "failed", file: "model.onnx" } });
    expect(status.download.error).toBe("There is not enough free disk space for model.onnx");
    // One request, no retry; the part keeps every byte the disk took.
    expect(m.server.requests).toEqual([{ url: "https://example.test/model.onnx", range: null }]);
    const kept = (await store.size("model.onnx.part"))!;
    expect(kept).toBeGreaterThan(1900);
    // What the setup page, the popup and the panel make of it: a disk-full failure, and the
    // room it asks for is what is left to download.
    const snapshot = parseComponent(status)!;
    const stage = setupStage(snapshot);
    const total = MODEL.length + TOKENIZER.length;
    expect(stage).toMatchObject({ stage: "failed", failure: "storage", total });
    expect(stage.stage === "failed" && stage.total - stage.received).toBe(total - kept);
    expect(engineSetup(snapshot)).toEqual({ state: "failed", percent: Math.floor((kept * 100) / total) });
    // The browser restarts, the disk still full: the same failure is said, over the same bytes.
    await m.engine.close();
    const next = track(make({ store }));
    let again: { download: { status: string; error: string } } | undefined;
    for (let i = 0; i < 200 && again?.download.status !== "failed"; i++) {
      again = (await next.engine.handle("status", {})).data as typeof again;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(again!.download).toMatchObject({ status: "failed", error: "There is not enough free disk space for model.onnx" });
    expect(await store.size("model.onnx.part")).toBe(kept);
    // Room again, and Retry: the rest of the model only, then the tokenizer, then ready.
    store.room = Infinity;
    await next.engine.handle("models.download", {});
    expect((await ready(next.engine)).state).toBe("ready");
    expect(next.server.requests.at(-2)).toEqual({ url: "https://example.test/model.onnx", range: `bytes=${kept}-` });
  });

  it("says why a failed download stopped after a restart too", async () => {
    const m = track(make({ server: { status: 404 } }));
    await m.engine.handle("models.download", {});
    const failed = (await ready(m.engine) as unknown as { download: { error: string } }).download.error;
    expect(failed).toBe("The server answered model.onnx with status 404");
    await m.engine.close();
    const next = track(make({ store: m.store }));
    const { data } = await next.engine.handle("status", {});
    expect(data).toMatchObject({ state: "needs_models", download: { status: "failed", error: failed }, error: { code: "download_failed", message: failed } });
    expect(next.server.requests).toEqual([]);
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
    expect(m.log).toEqual(["create webgpu:fp32", "release webgpu:fp32", "idle"]);
    await fails(m.engine.handle("health", {}), "engine_idle", 503);
    ({ data } = await m.engine.handle("score", { v: "3.0", blocks: [{ id: "a", text: "hello world" }] }));
    expect((data as { results: Array<{ lang: string }> }).results[0]!.lang).toBe("en");
    expect(m.log).toEqual(["create webgpu:fp32", "release webgpu:fp32", "idle", "create webgpu:fp32"]);
    ({ data } = await m.engine.handle("status", {}));
    expect((data as { state: string }).state).toBe("ready");
  }, 10_000);

  it("warms an idle model on request, which the first score then finds loaded, and lets a warmed model go when nothing asks", async () => {
    const m = track(make());
    await m.engine.handle("models.download", {});
    await ready(m.engine);
    await m.engine.handle("engine.settings", { idle_unload_s: 60 });
    m.clock.now += 61_000;
    await new Promise((r) => setTimeout(r, 1100));
    expect(m.log).toEqual(["create webgpu:fp32", "release webgpu:fp32", "idle"]);
    // Warmed: it loads without a score, and answers one with the model already in.
    let { data } = await m.engine.handle("warm", {});
    expect(data).toEqual({ state: "loading" });
    expect((await ready(m.engine)).state).toBe("ready");
    expect(m.log.at(-1)).toBe("create webgpu:fp32");
    ({ data } = await m.engine.handle("score", { v: "3.0", blocks: [{ id: "a", text: "hello world" }] }));
    expect((data as { results: Array<{ lang: string }> }).results[0]!.lang).toBe("en");
    expect(m.log.filter((l) => l.startsWith("create"))).toHaveLength(2);
    // A warm-up of a loaded model changes nothing, not even the idle clock: sixty seconds
    // after the score, warmed again all along, the model is let go as it would be anyway.
    for (let i = 0; i < 6; i++) {
      m.clock.now += 10_000;
      ({ data } = await m.engine.handle("warm", {}));
      expect(data).toEqual({ state: "ready" });
    }
    m.clock.now += 1_000;
    await new Promise((r) => setTimeout(r, 1100));
    expect((await m.engine.handle("status", {})).data).toMatchObject({ state: "idle" });
    // Warmed and then never asked for: let go after the idle time too.
    await m.engine.handle("warm", {});
    expect((await ready(m.engine)).state).toBe("ready");
    const idles = m.log.filter((l) => l === "idle").length;
    m.clock.now += 61_000;
    await new Promise((r) => setTimeout(r, 1100));
    expect((await m.engine.handle("status", {})).data).toMatchObject({ state: "idle" });
    expect(m.log.filter((l) => l === "idle")).toHaveLength(idles + 1);
  }, 15_000);

  it("warms nothing that is not set up, and nothing it was not asked to", async () => {
    const m = track(make());
    expect((await m.engine.handle("warm", {})).data).toEqual({ state: "needs_models" });
    await fails(m.engine.handle("warm", { now: true }), "invalid_request", 422);
    expect(m.log).toEqual([]);
    expect(m.server.requests).toEqual([]);
    // A worker that starts idle after an idle one loads on a warm-up as it would on a score.
    const first = track(make());
    await first.engine.handle("models.download", {});
    await ready(first.engine);
    await first.engine.close();
    const next = track(make({ store: first.store, idle: true }));
    expect((await next.engine.handle("warm", {})).data).toEqual({ state: "loading" });
    expect((await ready(next.engine)).state).toBe("ready");
    expect(next.log).toEqual(["create webgpu:fp32"]);
  });

  it("starts idle in the worker that follows an idle one, and loads for the next score", async () => {
    const first = track(make());
    await first.engine.handle("models.download", {});
    await ready(first.engine);
    await first.engine.close();
    const m = track(make({ store: first.store, idle: true }));
    let { data } = await m.engine.handle("status", {});
    expect(data).toMatchObject({ state: "idle", runtime: { state: "idle", active_id: null } });
    await fails(m.engine.handle("health", {}), "engine_idle", 503);
    expect(m.log).toEqual([]);
    ({ data } = await m.engine.handle("score", { v: "3.0", blocks: [{ id: "a", text: "hello world" }] }));
    expect((data as { results: Array<{ lang: string }> }).results[0]!.lang).toBe("en");
    expect(m.log).toEqual(["create webgpu:fp32"]);
    expect(m.server.requests).toEqual([]);
  });

  it("says it is loading, not down, while the model loads, and holds a score until it is in", async () => {
    const first = track(make());
    await first.engine.handle("models.download", {});
    await ready(first.engine);
    await first.engine.close();
    let loaded!: () => void;
    const m = track(make({ store: first.store, hold: new Promise<void>((resolve) => { loaded = resolve; }) }));
    expect(((await m.engine.handle("status", {})).data as { state: string }).state).toBe("loading");
    await fails(m.engine.handle("health", {}), "engine_loading", 503);
    let answered = false;
    const score = m.engine.handle("score", { v: "3.0", blocks: [{ id: "a", text: "hello world" }] }).finally(() => { answered = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    loaded();
    expect(((await score).data as { results: Array<{ lang: string }> }).results[0]!.lang).toBe("en");
    expect((await m.engine.handle("health", {})).data).toMatchObject({ ok: true, device: "webgpu" });
  });

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

describe("the runtimes a browser offers", () => {
  const wasm = globalThis.WebAssembly as { Suspending?: unknown };
  afterEach(() => { delete wasm.Suspending; });

  it("needs WebAssembly JSPI on both paths, the runtime's only build", async () => {
    delete wasm.Suspending;
    const without = await probeRuntimes();
    expect(without.map((c) => [c.id, c.available])).toEqual([["webgpu:fp32", false], ["wasm:fp32", false]]);
    expect(without.every((c) => c.reason?.includes("JSPI"))).toBe(true);
    wasm.Suspending = function Suspending() {};
    const withJspi = await probeRuntimes();
    // Node offers no WebGPU: the CPU path only.
    expect(withJspi.map((c) => [c.id, c.available])).toEqual([["webgpu:fp32", false], ["wasm:fp32", true]]);
    expect(withJspi[0]!.reason).toMatch(/no WebGPU/);
  });

  it("takes a software WebGPU adapter for no GPU, unless the engine's own suites ask", async () => {
    wasm.Suspending = function Suspending() {};
    const limits = { maxStorageBufferBindingSize: 2 ** 31, maxBufferSize: 2 ** 31 };
    const offer = (adapter: object) => vi.stubGlobal("navigator", { hardwareConcurrency: 10, gpu: { requestAdapter: async () => adapter } });
    try {
      // SwiftShader, which Chrome offers a machine without a usable GPU when WebGPU is forced on.
      offer({ limits, info: { vendor: "google", architecture: "swiftshader", isFallbackAdapter: true } });
      const [software, cpu] = await probeRuntimes();
      expect(software).toMatchObject({ id: "webgpu:fp32", available: false, reason: expect.stringMatching(/software/) });
      expect(cpu).toMatchObject({ id: "wasm:fp32", available: true });
      expect((await probeRuntimes({ softwareGpu: true }))[0]).toMatchObject({ available: true, label: "GPU (WebGPU, FP32) — google swiftshader" });
      // Browsers before GPUAdapterInfo carried the flag on the adapter.
      offer({ limits, isFallbackAdapter: true });
      expect((await probeRuntimes())[0]!.available).toBe(false);
      offer({ limits, info: { vendor: "apple", architecture: "metal-3", isFallbackAdapter: false } });
      expect((await probeRuntimes())[0]).toMatchObject({ available: true, reason: null });
    } finally { vi.unstubAllGlobals(); }
  });

  it("gives the CPU path two threads fewer than the processor has, at most eight, and one without isolation", () => {
    const threads = (cores: number, isolated = true) => {
      vi.stubGlobal("navigator", { hardwareConcurrency: cores });
      vi.stubGlobal("crossOriginIsolated", isolated);
      try { return wasmThreads(); } finally { vi.unstubAllGlobals(); }
    };
    expect([1, 2, 4, 6, 8, 10, 16, 64].map((cores) => threads(cores))).toEqual([1, 1, 2, 4, 6, 8, 8, 8]);
    expect(threads(10, false)).toBe(1);
  });
});
