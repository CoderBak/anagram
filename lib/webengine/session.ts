// lib/webengine/session.ts — ONNX Runtime Web around the model: which of its two
// execution providers, and the forward pass.
//
// The runtime is the pinned onnxruntime-web package, copied verbatim into
// vendor/engine/ by scripts/webengine.mjs and imported here by its extension URL: the
// library, its WebAssembly loader and the one WebAssembly binary that carries both the
// native WebGPU execution provider (the GPU path) and the CPU one (the WASM path), in
// the JSPI build (see scripts/webengine.mjs for why not the package's default JSEP one).
// WebAssembly JSPI is in Chrome 137 and Firefox 153, the manifests' minimums,
// so a browser without it is a plain failure below.
//
// The model reaches the runtime as its graph without the weights, with the file itself as
// external data (lib/webengine/onnx.ts): the JSPI build reads each tensor from the file
// as it creates it, onto the GPU, or once into WebAssembly memory for the CPU provider,
// so the 1.4 GB of weights never pass whole through the worker's memory. A worker's
// WebAssembly memory never shrinks, so the worker is ended when the engine lets
// the model go (lib/webengine/host.ts).
//
// The choice is automatic and FP32 either way, as the native engine's (the FP16 tier, below, is
// the one exception): WebGPU when the
// browser offers a hardware adapter (not a software one such as SwiftShader, which Chrome
// gives a machine without a usable GPU when WebGPU is forced on, and which is far slower
// than the CPU provider) whose storage-buffer limit can hold the word-embedding matrix
// (50 265 × 1024 floats, 206 MB, which the Gather kernel binds as one buffer; WebGPU's
// default limit is 128 MiB, and the runtime asks the adapter for its maximum), otherwise
// the CPU provider, with as many threads as wasmThreads allows (one, unless the page is
// cross-origin isolated and SharedArrayBuffer exists). A session that fails to build on
// the GPU falls back to the CPU provider on its own.
import { weightlessGraph } from "./onnx";
import type { Backend } from "./scoring";
import type { ModelTier } from "./pin";

/** The runtime's files by URL, as scripts/webengine.mjs copies them: the library, its loader and its WebAssembly. */
export interface RuntimeAssets { ort: string; mjs: string; wasm: string }

/** Whether this browser runs the runtime's build: WebAssembly JavaScript Promise Integration. */
export function hasJspi(): boolean {
  return typeof (globalThis.WebAssembly as { Suspending?: unknown } | undefined)?.Suspending === "function";
}

/** One runtime configuration, as the native engine lists its candidates. */
export interface Candidate {
  id: string;
  label: string;
  device: string;
  runtime: string;
  precision: ModelTier;
  experimental: false;
  available: boolean;
  reason?: string | null;
}

/** The word-embedding matrix, the largest single tensor the GPU binds. */
export const EMBEDDING_BYTES = 50265 * 1024 * 4;
/**
 * Texts per forward pass, by provider. The GPU provider keeps the activation buffers of
 * the passes it has run in its size buckets, to reuse them (its other cache modes either
 * keep every size seen or hold a whole pass's buffers until it ends, gigabytes at 512
 * tokens), so the batch bounds what stays on the GPU after the weights. Measured on an M4
 * at the product's shapes: four texts a pass keeps 0.3 GB where eight kept 0.6 GB, and
 * scores 512 tokens a text 5% faster and 160 as fast; two or one keep 0.1–0.2 GB less but
 * are 7–15% slower on short texts. The CPU provider frees what a pass allocates, and eight
 * texts a pass are 6% faster there than four. The extension's own requests hold a few
 * texts each (lib/backend/router.ts's character budget); the results do not depend on the
 * batch.
 */
export const SESSION_BATCH = { webgpu: 4, wasm: 8 } as const;
/**
 * What a pass costs beyond its tokens, in tokens, by provider (lib/webengine/scoring.ts
 * passes). On an M4 at the product's shapes the GPU takes about 12 ms a pass and 0.5 ms a
 * token, the CPU's eight threads about 110 ms and 2.7 ms: a pass of one text costs the CPU
 * relatively more, and it pads a little more willingly.
 */
export const PASS_TOKENS = { webgpu: 24, wasm: 40 } as const;
export const WEBGPU_ID = "webgpu:fp32";
/** The FP16 tier's only configuration (lib/device.ts TIERS): ONNX Runtime upcasts FP16 on the
 *  processor and gains nothing, so it is never run there. It needs the adapter feature
 *  `shader-f16` (without it the session builds and the first pass fails on the first Gather)
 *  and a buffer for half the embedding matrix. */
export const WEBGPU_FP16_ID = "webgpu:fp16";
export const EMBEDDING_BYTES_FP16 = EMBEDDING_BYTES / 2;
/** The name the graph gives the file its tensors lie in. */
const MODEL_FILE = "model.onnx";
export const WASM_ID = "wasm:fp32";

interface OrtTensor { data: ArrayLike<number> | BigInt64Array; dims: readonly number[]; dispose?(): void }
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
}
interface OrtModule {
  env: {
    logLevel?: string;
    wasm: { wasmPaths?: string | { mjs?: string; wasm?: string }; numThreads?: number; proxy?: boolean; simd?: boolean };
    webgpu: { powerPreference?: string; adapter?: unknown; device?: unknown };
  };
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => OrtTensor;
}

interface GpuAdapterLike {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean };
  features?: { has(name: string): boolean };
  /** Where browsers carried it before GPUAdapterInfo did. */
  isFallbackAdapter?: boolean;
}

const NO_JSPI = "This browser has no WebAssembly JSPI, which the runtime needs";

/** The candidates on this browser, most preferred first. `softwareGpu` takes a software
 *  adapter for a GPU: for the engine's own suites only (test/webengine/harness.mjs), so a
 *  machine without a GPU still runs the GPU path's kernels; the extension never sets it. */
export async function probeRuntimes({ softwareGpu = false, tier = "fp32" }: { softwareGpu?: boolean; tier?: ModelTier } = {}): Promise<Candidate[]> {
  const fp16 = tier === "fp16";
  const needed = fp16 ? EMBEDDING_BYTES_FP16 : EMBEDDING_BYTES;
  const precision = fp16 ? "FP16" : "FP32";
  const webgpu: Candidate = { id: fp16 ? WEBGPU_FP16_ID : WEBGPU_ID, label: `GPU (WebGPU, ${precision})`, device: "gpu", runtime: "onnxruntime-web/webgpu", precision: tier, experimental: false, available: false, reason: null };
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(o?: unknown): Promise<GpuAdapterLike | null> } }).gpu;
  const jspi = hasJspi();
  if (!jspi) webgpu.reason = NO_JSPI;
  else if (!gpu) webgpu.reason = "This browser offers no WebGPU here";
  else {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) webgpu.reason = "No WebGPU adapter";
      else if ((adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter) === true && !softwareGpu) {
        webgpu.reason = "The only WebGPU adapter is a software one, slower than the processor";
      } else if (adapter.limits.maxStorageBufferBindingSize < needed || adapter.limits.maxBufferSize < needed) {
        webgpu.reason = `The GPU binds at most ${Math.floor(adapter.limits.maxStorageBufferBindingSize / 1048576)} MiB per buffer; the model needs ${Math.ceil(needed / 1048576)} MiB`;
      } else if (fp16 && adapter.features?.has("shader-f16") !== true) {
        webgpu.reason = "The GPU does not offer shader-f16, which the FP16 model needs";
      } else {
        webgpu.available = true;
        const name = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(" ");
        if (name) webgpu.label = `GPU (WebGPU, ${precision}) — ${name}`;
      }
    } catch (error) { webgpu.reason = `WebGPU adapter request failed: ${(error as Error).message}`; }
  }
  const threads = wasmThreads();
  const wasm: Candidate = { id: WASM_ID, label: `CPU (WebAssembly, FP32, ${threads} thread${threads === 1 ? "" : "s"})`, device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false,
    ...(fp16 ? { available: false, reason: "The FP16 model runs on the graphics card only" } : { available: jspi, reason: jspi ? null : NO_JSPI }) };
  return [webgpu, wasm];
}

/**
 * Threads the CPU provider may use: more than one needs SharedArrayBuffer. Two of the
 * processor's threads are left to the browser and the page, and eight at most (more is not
 * measured). On a 10-thread M4 left to itself, 8×512 tokens took 10.7 s on eight threads,
 * 14.4 on four and 10.1 on all ten; with other programs busy, 16.4, 22.0 and 17.8, the ten
 * now sharing the cores with the browser's own. The count changes no result.
 */
export function wasmThreads(): number {
  const isolated = typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1;
  return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 2));
}

let runtime: Promise<OrtModule> | undefined;

function loadRuntime(assets: RuntimeAssets): Promise<OrtModule> {
  // The package's own module, unmodified, from the extension; see scripts/webengine.mjs.
  runtime ??= import(/* @vite-ignore */ assets.ort).then((module) => {
    const ort = module as OrtModule;
    ort.env.logLevel = "error";
    ort.env.wasm.wasmPaths = { mjs: assets.mjs, wasm: assets.wasm };
    ort.env.wasm.proxy = false;
    ort.env.webgpu.powerPreference = "high-performance";
    return ort;
  });
  return runtime;
}

export interface SessionInfo { candidate: Candidate; createMs: number; firstRunMs: number }

/** One loaded model on one execution provider. */
export class Session implements Backend {
  private constructor(private readonly ort: OrtModule, private session: OrtSession | null, readonly info: SessionInfo) {}

  /**
   * Build the session from the model file, which the runtime reads as it needs it and
   * lets go of once the session exists.
   */
  static async create(assets: RuntimeAssets, candidate: Candidate, model: Blob, signal?: AbortSignal): Promise<Session> {
    const ort = await loadRuntime(assets);
    // The runtime's one thread pool (the session's own thread options are not read), made
    // when its WebAssembly starts: once a worker, by the first session. The GPU session asks
    // for the CPU path's threads too, so a CPU session after a GPU one that failed has them
    // rather than one (2 s for one text of 160 tokens instead of 1); on the GPU they change
    // neither speed nor memory measurably (0.03 GB).
    ort.env.wasm.numThreads = wasmThreads();
    const began = performance.now();
    const graph = await weightlessGraph(async (offset, length) => new Uint8Array(await model.slice(offset, offset + length).arrayBuffer()), model.size, MODEL_FILE);
    if (signal?.aborted) throw new Error("cancelled");
    const provider = candidate.device === "gpu" ? [{ name: "webgpu" }] : ["wasm"];
    const session = await ort.InferenceSession.create(graph.model, {
      executionProviders: provider,
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
      externalData: [{ path: MODEL_FILE, data: model }],
      // The CPU provider would repack every weight matrix into a copy of its own, and the
      // memory the originals leave is never given back: 0.5 GB more for 2–8% of speed.
      ...(candidate.id === WASM_ID ? { extra: { session: { disable_prepacking: "1" } } } : {}),
    });
    if (signal?.aborted) { await session.release(); throw new Error("cancelled"); }
    const createMs = performance.now() - began;
    for (const name of ["input_ids", "attention_mask"]) if (!session.inputNames.includes(name)) { await session.release(); throw new Error(`the model has no ${name} input`); }
    if (!session.outputNames.includes("logits")) { await session.release(); throw new Error("the model has no logits output"); }
    const out = new Session(ort, session, { candidate, createMs, firstRunMs: 0 });
    // The first pass compiles the GPU shaders (or warms the CPU kernels), as the native engine
    // warms up. A session that cannot run is let go here, or its weights stay on the GPU.
    const warm = performance.now();
    try { await out.logits([[0, 1, 2, 2, 2, 2, 2, 2]], [[1, 1, 1, 1, 1, 1, 1, 1]]); }
    catch (error) { await out.release().catch(() => {}); throw error; }
    out.info.firstRunMs = performance.now() - warm;
    return out;
  }

  get device(): "webgpu" | "wasm" { return this.info.candidate.device === "gpu" ? "webgpu" : "wasm"; }
  get batchSize(): number { return SESSION_BATCH[this.device]; }
  get passTokens(): number { return PASS_TOKENS[this.device]; }

  async logits(inputIds: number[][], attentionMask: number[][], signal?: AbortSignal): Promise<Float32Array> {
    if (!this.session) throw new Error("session released");
    if (signal?.aborted) throw new Error("cancelled");
    const rows = inputIds.length;
    // A padded batch (scoring.pad): at least one row, and every row of both as wide.
    const width = inputIds[0]!.length;
    const ids = new BigInt64Array(rows * width);
    const mask = new BigInt64Array(rows * width);
    for (let r = 0; r < rows; r++) {
      const idRow = inputIds[r]!, maskRow = attentionMask[r]!;
      for (let c = 0; c < width; c++) { ids[r * width + c] = BigInt(idRow[c]!); mask[r * width + c] = BigInt(maskRow[c]!); }
    }
    const feeds = { input_ids: new this.ort.Tensor("int64", ids, [rows, width]), attention_mask: new this.ort.Tensor("int64", mask, [rows, width]) };
    const result = await this.session.run(feeds);
    const logits = result.logits;
    if (!logits) throw new Error("the model has no logits output");
    const data = logits.data as ArrayLike<number>;
    const out = Float32Array.from(data as ArrayLike<number>);
    logits.dispose?.();
    return out;
  }

  async release(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) await session.release();
  }
}
