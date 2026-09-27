// lib/webengine/session.ts — ONNX Runtime Web around the FP32 model: which of its two
// execution providers, and the forward pass.
//
// The runtime is the pinned onnxruntime-web package, copied verbatim into
// vendor/engine/ by scripts/webengine.mjs and imported here by its extension URL: the
// library, its WebAssembly loader and the one WebAssembly binary that carries both the
// WebGPU execution provider (JSEP, the GPU path) and the CPU one (the WASM path).
//
// The choice is automatic and FP32 either way, as the native engine's: WebGPU when the
// browser offers an adapter whose storage-buffer limit can hold the word-embedding matrix
// (50 265 × 1024 floats, 206 MB, which the Gather kernel binds as one buffer; WebGPU's
// default limit is 128 MiB, and the runtime asks the adapter for its maximum), otherwise
// the CPU provider, with as many threads as the page allows (one, unless it is
// cross-origin isolated and SharedArrayBuffer exists). A session that fails to build on
// the GPU falls back to the CPU provider on its own.
import type { Backend } from "./scoring";

/** The files scripts/webengine.mjs copies, by URL. */
export interface RuntimeAssets { ort: string; mjs: string; wasm: string }

/** One runtime configuration, as the native engine lists its candidates. */
export interface Candidate {
  id: string;
  label: string;
  device: string;
  runtime: string;
  precision: "fp32";
  experimental: false;
  available: boolean;
  reason?: string | null;
}

/** The word-embedding matrix, the largest single tensor the GPU binds. */
export const EMBEDDING_BYTES = 50265 * 1024 * 4;
export const WEBGPU_ID = "webgpu:fp32";
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
  InferenceSession: { create(buffer: Uint8Array, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => OrtTensor;
}

interface GpuAdapterLike {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  info?: { vendor?: string; architecture?: string; description?: string };
  isFallbackAdapter?: boolean;
}

/** The candidates on this browser, most preferred first. */
export async function probeRuntimes(): Promise<Candidate[]> {
  const webgpu: Candidate = { id: WEBGPU_ID, label: "GPU (WebGPU, FP32)", device: "gpu", runtime: "onnxruntime-web/webgpu", precision: "fp32", experimental: false, available: false, reason: null };
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(o?: unknown): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) webgpu.reason = "This browser offers no WebGPU here";
  else {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) webgpu.reason = "No WebGPU adapter";
      else if (adapter.limits.maxStorageBufferBindingSize < EMBEDDING_BYTES || adapter.limits.maxBufferSize < EMBEDDING_BYTES) {
        webgpu.reason = `The GPU binds at most ${Math.floor(adapter.limits.maxStorageBufferBindingSize / 1048576)} MiB per buffer; the model needs ${Math.ceil(EMBEDDING_BYTES / 1048576)} MiB`;
      } else {
        webgpu.available = true;
        const name = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(" ");
        if (name) webgpu.label = `GPU (WebGPU, FP32) — ${name}`;
      }
    } catch (error) { webgpu.reason = `WebGPU adapter request failed: ${(error as Error).message}`; }
  }
  const threads = wasmThreads();
  const wasm: Candidate = { id: WASM_ID, label: `CPU (WebAssembly, FP32, ${threads} thread${threads === 1 ? "" : "s"})`, device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false, available: true, reason: null };
  return [webgpu, wasm];
}

/** Threads the CPU provider may use: more than one needs SharedArrayBuffer. */
export function wasmThreads(): number {
  const isolated = typeof SharedArrayBuffer !== "undefined" && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1;
  return Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
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

export interface SessionInfo { candidate: Candidate; threads: number; createMs: number; firstRunMs: number }

/** One loaded model on one execution provider. */
export class Session implements Backend {
  private constructor(private readonly ort: OrtModule, private session: OrtSession | null, readonly info: SessionInfo) {}

  /**
   * Build the session from the model's bytes. The caller drops its reference to `model`
   * afterwards: the runtime copies it into WebAssembly memory and keeps only its own copy.
   */
  static async create(assets: RuntimeAssets, candidate: Candidate, model: Uint8Array, signal?: AbortSignal): Promise<Session> {
    const ort = await loadRuntime(assets);
    const threads = candidate.id === WASM_ID ? wasmThreads() : 1;
    ort.env.wasm.numThreads = threads;
    const began = performance.now();
    const provider = candidate.id === WEBGPU_ID ? [{ name: "webgpu" }] : ["wasm"];
    const session = await ort.InferenceSession.create(model, {
      executionProviders: provider,
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
      ...(candidate.id === WASM_ID ? { intraOpNumThreads: threads } : {}),
    });
    if (signal?.aborted) { await session.release(); throw new Error("cancelled"); }
    const createMs = performance.now() - began;
    for (const name of ["input_ids", "attention_mask"]) if (!session.inputNames.includes(name)) { await session.release(); throw new Error(`the model has no ${name} input`); }
    if (!session.outputNames.includes("logits")) { await session.release(); throw new Error("the model has no logits output"); }
    const out = new Session(ort, session, { candidate, threads, createMs, firstRunMs: 0 });
    // The first pass compiles the GPU shaders (or warms the CPU kernels), as the native engine warms up.
    const warm = performance.now();
    await out.logits([[0, 1, 2, 2, 2, 2, 2, 2]], [[1, 1, 1, 1, 1, 1, 1, 1]]);
    out.info.firstRunMs = performance.now() - warm;
    return out;
  }

  get device(): string { return this.info.candidate.id === WEBGPU_ID ? "webgpu" : "wasm"; }

  async logits(inputIds: number[][], attentionMask: number[][], signal?: AbortSignal): Promise<Float32Array> {
    if (!this.session) throw new Error("session released");
    if (signal?.aborted) throw new Error("cancelled");
    const rows = inputIds.length;
    const width = inputIds[0].length;
    const ids = new BigInt64Array(rows * width);
    const mask = new BigInt64Array(rows * width);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < width; c++) { ids[r * width + c] = BigInt(inputIds[r][c]); mask[r * width + c] = BigInt(attentionMask[r][c]); }
    }
    const feeds = { input_ids: new this.ort.Tensor("int64", ids, [rows, width]), attention_mask: new this.ort.Tensor("int64", mask, [rows, width]) };
    const result = await this.session.run(feeds);
    const logits = result.logits;
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
