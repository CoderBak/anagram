// test/node/webengineTier.test.ts — the FP16 tier of the in-browser engine (lib/webengine/pin.ts,
// engine.ts): the file it downloads, the identity it reports, the one model kept on disk, and
// what happens where the FP16 model does not run on a device.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, type LoadedSession } from "../../lib/webengine/engine";
import { pin as extensionPin, pinnedFiles, modelFileName, modelId } from "../../lib/webengine/pin";
import { sha256Hex } from "../../lib/webengine/sha256";
import { MemoryStore } from "../../lib/webengine/storage";
import { probeRuntimes, type Candidate } from "../../lib/webengine/session";
import { tinyTokenizerJson } from "../fixtures/webengine/tinyTokenizer.mjs";
import { fakeServer } from "./webengineFake";
import { parseComponent } from "../../lib/backend/nativeClient";
import { TIERS } from "../../lib/device";

const FIXTURES = join(__dirname, "..", "fixtures", "webengine");
const MODEL = new Uint8Array(readFileSync(join(FIXTURES, "tiny.onnx")));
const LID = new Uint8Array(readFileSync(join(FIXTURES, "tiny-lid.bin")));
const TOKENIZER = new TextEncoder().encode(JSON.stringify(tinyTokenizerJson()));
const FILES = { "/model.onnx": MODEL, "/model_fp16.onnx": MODEL, "/tokenizer.json": TOKENIZER };
const lid = { name: "lid.176.ftz", size_bytes: LID.length, sha256: sha256Hex(LID), url: `data:application/octet-stream;base64,${Buffer.from(LID).toString("base64")}` };
const pinOf = (tier: "fp32" | "fp16") => ({
  tier,
  files: [
    { name: modelFileName(tier), size_bytes: MODEL.length, sha256: sha256Hex(MODEL), url: `https://example.test/${modelFileName(tier)}` },
    { name: "tokenizer.json", size_bytes: TOKENIZER.length, sha256: sha256Hex(TOKENIZER), url: "https://example.test/tokenizer.json" },
  ],
  lid,
  model: { id: modelId(tier), calibration: "editlens-4bucket-cosine(0.03,0.15)" },
  license: "CC-BY-NC-SA-4.0",
});
const gpu = (id: string, precision: "fp32" | "fp16"): Candidate => ({ id, label: "GPU", device: "gpu", runtime: "onnxruntime-web/webgpu", precision, experimental: false, available: true, reason: null });
const cpu = (available: boolean): Candidate => ({ id: "wasm:fp32", label: "CPU", device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false, available, reason: available ? null : "The FP16 model runs on the graphics card only" });
const probe = async (tier: "fp32" | "fp16"): Promise<Candidate[]> => (tier === "fp16" ? [gpu("webgpu:fp16", "fp16"), cpu(false)] : [gpu("webgpu:fp32", "fp32"), cpu(true)]);

const row = (i: number) => [((i % 7) / 7 - 0.5) * 0.4, ((i % 11) / 11 - 0.5) * 0.4, ((i % 13) / 13 - 0.5) * 0.4, ((i % 17) / 17 - 0.5) * 0.4];
const session = (candidate: Candidate): LoadedSession => ({
  info: { candidate, createMs: 5, firstRunMs: 1 },
  device: candidate.device === "gpu" ? "webgpu" : "wasm",
  async logits(ids, mask) {
    const out = new Float32Array(ids.length * 4);
    ids.forEach((r, i) => r.forEach((id, j) => { if (mask[i]![j]) row(id).forEach((v, k) => { out[i * 4 + k]! += v; }); }));
    return out;
  },
  async release() { /* nothing */ },
});

const engines: Engine[] = [];
afterEach(async () => { for (const e of engines.splice(0)) await e.close(); });

function make(options: { tier?: "fp32" | "fp16"; fallback?: boolean; failing?: string[]; store?: MemoryStore } = {}) {
  const store = options.store ?? new MemoryStore();
  const log: string[] = [];
  const server = fakeServer(FILES);
  const tier = options.tier ?? "fp16";
  const engine = new Engine({
    pin: pinOf(tier), ...(options.fallback ? { fallback: pinOf("fp32") } : {}), assets: { ort: "x", mjs: "x", wasm: "x" }, version: "9.9.9",
    store, transport: server.fetch, retryWaits: [0], probe,
    createSession: async (candidate) => {
      if (options.failing?.includes(candidate.id)) { log.push(`fail ${candidate.id}`); throw new Error("Program Gather requires f16"); }
      log.push(`create ${candidate.id}`);
      return session(candidate);
    },
  });
  engines.push(engine);
  return { engine, store, log, server };
}
const status = async (e: Engine) => (await e.handle("status", {})).data as Record<string, any>;
const settled = async (e: Engine, states = ["ready", "error"]) => {
  for (let i = 0; i < 400; i++) {
    const s = await status(e);
    if (states.includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never settled");
};

describe("the pin of each tier", () => {
  it("offers the FP16 file from the same revision and URL form, by its pinned size and hash", () => {
    const [model] = pinnedFiles("fp16");
    expect(model).toMatchObject({ name: "model_fp16.onnx", size_bytes: 711_340_748, sha256: "a0da0f46c5026489c37137b5f455e092e09ac48eafd031bec6f05433c5c2ec01" });
    expect(model!.url).toBe(pinnedFiles("fp32")[0]!.url.replace("onnx/model.onnx", "onnx/model_fp16.onnx"));
    expect(pinnedFiles("fp32")[0]).toMatchObject({ name: "model.onnx", size_bytes: 1_421_900_913 });
    // A tier's download is its model and the tokenizer (TIERS bytes).
    for (const [i, id] of ["fp32", "fp16"].entries()) expect(pinnedFiles(id as "fp32" | "fp16").reduce((n, f) => n + f.size_bytes, 0)).toBe(TIERS[i]!.bytes);
    
  });

  it("names the tier in the model id, so that the two never share a cache key", () => {
    expect(extensionPin("x", "fp32").model.id).toBe("editlens_roberta-large");
    expect(extensionPin("x", "fp16").model.id).toBe("editlens_roberta-large-fp16");
    expect(extensionPin("x", "fp16").tier).toBe("fp16");
  });

  it("probes FP16 for the graphics card only, with shader-f16 and half the embedding matrix", async () => {
    const saved = (globalThis as { navigator?: unknown }).navigator;
    const adapter = (features: string[], limit: number) => ({
      limits: { maxStorageBufferBindingSize: limit, maxBufferSize: limit },
      features: { has: (name: string) => features.includes(name) }, info: { vendor: "apple", isFallbackAdapter: false },
    });
    const withAdapter = async (a: unknown, tier: "fp32" | "fp16") => {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: { requestAdapter: async () => a }, hardwareConcurrency: 8 } });
      (globalThis as { WebAssembly: Record<string, unknown> }).WebAssembly.Suspending ??= function Suspending() { /* stands in for JSPI */ };
      return probeRuntimes({ tier });
    };
    try {
      const ok = await withAdapter(adapter(["shader-f16"], 110e6), "fp16");
      expect(ok.map((c) => [c.id, c.available])).toEqual([["webgpu:fp16", true], ["wasm:fp32", false]]);
      expect(ok[0]!.precision).toBe("fp16");
      expect((await withAdapter(adapter([], 110e6), "fp16"))[0]).toMatchObject({ available: false, reason: expect.stringContaining("shader-f16") });
      expect((await withAdapter(adapter(["shader-f16"], 90e6), "fp16"))[0]).toMatchObject({ available: false });
      // FP32 needs the whole matrix and no f16.
      expect((await withAdapter(adapter([], 110e6), "fp32"))[0]).toMatchObject({ id: "webgpu:fp32", available: false });
      expect((await withAdapter(adapter([], 210e6), "fp32")).map((c) => c.available)).toEqual([true, true]);
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: saved });
    }
  });
});

describe("the FP16 tier's engine", () => {
  it("downloads the FP16 file, and reports the tier in status, health and every score", async () => {
    const { engine, server, store } = make();
    expect((await status(engine))).toMatchObject({ state: "needs_models", tier: "fp16", download: { total_bytes: MODEL.length + TOKENIZER.length } });
    await engine.handle("models.download", {});
    expect((await settled(engine)).state).toBe("ready");
    expect(server.requests.map((r) => r.url)).toEqual(["https://example.test/model_fp16.onnx", "https://example.test/tokenizer.json"]);
    expect(await store.list()).toEqual(["model_fp16.onnx", "state.json", "tokenizer.json"]);
    const health = (await engine.handle("health", {})).data as { model: { id: string; ver: string }; dtype: string; device: string };
    expect(health).toMatchObject({ model: { id: "editlens_roberta-large-fp16" }, dtype: "fp16", device: "webgpu" });
    const score = (await engine.handle("score", { v: "3.0", blocks: [{ id: "a", text: "hello world" }] })).data as { model: { id: string; ver: string } };
    expect(score.model).toEqual(health.model);
    // The same weights' bytes under the other tier are another version, and another id.
    const fp32 = make({ tier: "fp32" });
    await fp32.engine.handle("models.download", {});
    await settled(fp32.engine);
    const other = ((await fp32.engine.handle("health", {})).data as { model: { id: string; ver: string }; dtype: string });
    expect(other).toMatchObject({ model: { id: "editlens_roberta-large" }, dtype: "fp32" });
    expect(other.model.ver).not.toBe(health.model.ver);
    expect(parseComponent(await status(engine))).toMatchObject({ tier: "fp16" });
  });

  it("keeps one tier's model at a time: FP32's files go before FP16 downloads", async () => {
    const store = new MemoryStore();
    const first = make({ tier: "fp32", store });
    await first.engine.handle("models.download", {});
    await settled(first.engine);
    await first.engine.close();
    expect(await store.list()).toContain("model.onnx");
    const { engine } = make({ tier: "fp16", store });
    await engine.handle("models.download", {});
    await settled(engine);
    expect(await store.list()).toEqual(["model_fp16.onnx", "state.json", "tokenizer.json"]);
    expect(await engine.handle("health", {})).toMatchObject({ data: { dtype: "fp16" } });
  });
});

describe("where the FP16 model does not run", () => {
  it("deletes its files and downloads FP32 in its place, on the processor, where FP32 fits", async () => {
    const { engine, store, log, server } = make({ fallback: true, failing: ["webgpu:fp16"] });
    await engine.handle("models.download", {});
    const s = await settled(engine);
    expect(s).toMatchObject({ state: "ready", tier: "fp32" });
    expect(log).toEqual(["fail webgpu:fp16", "create wasm:fp32"]);
    expect(await store.list()).toEqual(["model.onnx", "state.json", "tokenizer.json"]);
    expect(server.requests.map((r) => r.url)).toEqual(["https://example.test/model_fp16.onnx", "https://example.test/tokenizer.json", "https://example.test/model.onnx"]);
    expect((await engine.handle("health", {})).data).toMatchObject({ model: { id: "editlens_roberta-large" }, dtype: "fp32", device: "wasm" });
    // The graphics card is not tried again for FP32 either: the runtime list says so.
    const runtime = (await engine.handle("runtime", {})).data as { candidates: Candidate[] };
    expect(runtime.candidates.find((c) => c.device === "gpu")).toMatchObject({ available: false });
    // Another start of the engine remembers: FP16 is not tried again, FP32 loads from disk.
    await engine.close();
    const again = make({ fallback: true, store });
    await again.engine.start();
    expect((await settled(again.engine)).tier).toBe("fp32");
    expect(again.log).toEqual(["create wasm:fp32"]);
    expect(again.server.requests).toEqual([]);
  });

  it("deletes the files and says the device cannot run the model where FP32 does not fit", async () => {
    const { engine, store, log, server } = make({ fallback: false, failing: ["webgpu:fp16"] });
    await engine.handle("models.download", {});
    const s = await settled(engine);
    expect(s).toMatchObject({ state: "error", tier: "fp16", error: { code: "cannot_run" } });
    expect(log).toEqual(["fail webgpu:fp16"]);
    expect(await store.list()).toEqual(["state.json"]);
    // Nothing downloads again, now or after the engine starts again.
    expect(await status(engine)).toMatchObject({ state: "error", error: { code: "cannot_run" } });
    await engine.handle("models.download", {});
    expect(await status(engine)).toMatchObject({ state: "error" });
    expect(server.requests).toHaveLength(2);
    await engine.close();
    const again = make({ fallback: false, store });
    expect(await status(again.engine)).toMatchObject({ state: "error", error: { code: "cannot_run" } });
    expect(again.server.requests).toEqual([]);
    expect(await store.list()).toEqual(["state.json"]);
  });
});
