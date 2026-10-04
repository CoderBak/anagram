// test/webengine/scripted-engine.mjs — the in-browser engine's states, handed to one page.
//
// The setup page, popup and panel paint whatever the engine's `status` says
// (lib/ui/inBrowserEngine.ts, lib/backend/engineSetup.ts). Some of those states take minutes
// or a machine to reach for real — a finished 1.4 GB download, a GPU, a full disk, a model
// that failed to load, a local engine that kept crashing — so the layout, accessibility and
// copy suites script them: an init script answers the page's own contract requests, its
// question which engine is in use and its backend-status question with a snapshot of the
// engine's exact shape, and can stand in for the browser's storage estimate and its
// Save-Data setting. Everything else the page asks goes to the real extension.
// test/inbrowser.mjs drives the real engine through the same states it can reach.
const TOTAL = 1_425_459_555;
/** The FP16 tier's download: its model and the tokenizer (lib/device.ts TIERS). */
const TOTAL_FP16 = 714_899_390;

const download = (over = {}) => ({ status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null, phase: "detecting", detail: null, ...over });
const runtime = (active, selected = active ?? "webgpu:fp32") => ({
  schema_version: 1, state: active ? "ready" : "idle", active_id: active, selected_id: selected, recommended_id: selected, fastest_id: null,
  candidates: [
    { id: "webgpu:fp32", label: "GPU (WebGPU, FP32) — apple metal-3", device: "gpu", runtime: "onnxruntime-web/webgpu", precision: "fp32", experimental: false, available: selected === "webgpu:fp32", reason: null },
    { id: "wasm:fp32", label: "CPU (WebAssembly, FP32, 8 threads)", device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false, available: true, reason: null },
  ],
  benchmark: { status: "idle", budget_s: 0, elapsed_s: 0, measurement_s: 0, phase: "idle", current_id: null, completed: 0, total: 0, results: [] },
  error: null,
});
const snapshot = (over) => ({
  schema_version: 1, version: "0.7.0", home: "opfs:anagram-engine", state: "needs_models", download: download(), runtime: null,
  storage: { models_bytes: 0 }, error: null, settings: { idle_unload_s: 300 }, operation: null, ...over,
});
const failed = (error, received = TOTAL * 0.4) =>
  snapshot({ state: "error", download: download({ status: "failed", bytes_received: received, total_bytes: TOTAL, phase: "downloading", file: "model.onnx", error }), storage: { models_bytes: received }, error: { code: "download_failed", message: error } });
const done = download({ status: "completed", bytes_received: TOTAL, total_bytes: TOTAL, phase: "complete" });

/** Named snapshots of the engine, in `status`'s shape (lib/webengine/engine.ts). */
export const STATES = {
  needed: snapshot({}),
  downloading: snapshot({ state: "downloading", download: download({ status: "running", bytes_received: TOTAL * 0.45, total_bytes: TOTAL, phase: "downloading", file: "model.onnx" }), storage: { models_bytes: TOTAL * 0.45 } }),
  // The lighter model (FP16) downloading: the line that says so beside the progress.
  lighter: snapshot({ tier: "fp16", state: "downloading", download: download({ status: "running", bytes_received: TOTAL_FP16 * 0.45, total_bytes: TOTAL_FP16, phase: "downloading", file: "model_fp16.onnx" }), storage: { models_bytes: TOTAL_FP16 * 0.45 } }),
  retrying: snapshot({ state: "downloading", download: download({ status: "running", bytes_received: TOTAL * 0.45, total_bytes: TOTAL, phase: "downloading", file: "model.onnx", detail: "Retrying model.onnx in 5 s" }), storage: { models_bytes: TOTAL * 0.45 } }),
  // Hugging Face unreachable: the files come from hf-mirror.com, and the line beside the progress says so.
  mirror: snapshot({ state: "downloading", download: download({ status: "running", bytes_received: TOTAL * 0.45, total_bytes: TOTAL, phase: "downloading", file: "model.onnx", detail: "Hugging Face is unreachable; downloading from hf-mirror.com" }), storage: { models_bytes: TOTAL * 0.45 } }),
  paused: snapshot({ state: "paused", download: download({ status: "paused", bytes_received: TOTAL * 0.45, total_bytes: TOTAL, phase: "downloading", file: "model.onnx" }), storage: { models_bytes: TOTAL * 0.45 } }),
  network: failed("The connection for model.onnx was lost"),
  storage: failed("There is not enough free disk space for model.onnx"),
  server: failed("The server answered model.onnx with status 503"),
  damaged: failed("Checksum or size mismatch for model.onnx"),
  stopped_download: failed("Retry the model download to continue setup"),
  loading: snapshot({ state: "loading", download: done, runtime: runtime(null), storage: { models_bytes: TOTAL } }),
  ready_gpu: snapshot({ state: "ready", download: done, runtime: runtime("webgpu:fp32"), storage: { models_bytes: TOTAL + 300 } }),
  ready_cpu: snapshot({ state: "ready", download: done, runtime: runtime("wasm:fp32", "wasm:fp32"), storage: { models_bytes: TOTAL + 300 } }),
  load_failed: snapshot({ state: "error", download: done, runtime: { ...runtime(null), state: "error", error: "WebGPU device lost" }, storage: { models_bytes: TOTAL }, error: { code: "not_ready", message: "WebGPU device lost" } }),
  // The lighter model failed here and the full one does not fit: nothing can run.
  cannot_run: snapshot({ state: "error", runtime: runtime(null), error: { code: "cannot_run", message: "This device cannot run the model: the lighter version failed and the full one does not fit" } }),
};

/** What the background says about the engine while it is in `state` (entrypoints/background.ts). */
/** Why a download failed, as the background tells the toolbar menu (lib/webengine/download.ts
 *  failureKind, through lib/backend/engineSetup.ts). */
function failureOf(message) {
  if (/not enough free disk space/.test(message ?? "")) return "storage";
  if (/Checksum or size mismatch|larger than its pinned size/.test(message ?? "")) return "damaged";
  if (/answered \S+ with status \d+/.test(message ?? "")) return "server";
  if (/network request for|connection for \S+ was lost|Incomplete download|unexpected range|sent no body/.test(message ?? "")) return "network";
  return "other";
}

/** The engine's error codes that say the model did not start, as the background tells the
 *  toolbar menu (lib/backend/engineSetup.ts START_PROBLEM). */
const START_PROBLEM = { not_ready: "load", cannot_run: "device", webgpu_unavailable: "device" };

export function backendFor(name, { crashed = false, engine = "inbrowser" } = {}) {
  const s = STATES[name];
  const up = s.state === "ready" && !crashed;
  const percent = s.download.total_bytes ? Math.floor((Math.max(s.download.bytes_received, s.storage.models_bytes) * 100) / s.download.total_bytes) : 0;
  const setup = crashed || engine === "native" ? undefined
    : s.download.status === "running" ? { state: "downloading", percent }
    : s.download.status === "paused" ? { state: "paused", percent }
    : s.download.status === "failed" ? { state: "failed", percent, failure: failureOf(s.download.error) }
    : s.state === "needs_models" ? { state: "needed", percent: 0 }
    : s.state === "loading" ? { state: "loading", percent: 100 }
    : s.state === "error" && START_PROBLEM[s.error?.code] ? { state: "error", percent: 100, problem: START_PROBLEM[s.error.code] } : null;
  return up
    ? { active: "server", engine, model: { id: "editlens_roberta-large", ver: "sha256:test-web1", calibration: "editlens-4bucket-cosine(0.03,0.15)" }, server: { ok: true, checkedAt: 1, device: "webgpu", dtype: "fp32" } }
    // A model loading answers health with engine_loading: reachable, not down.
    : s.state === "loading" && !crashed
      ? { active: "loading", engine, model: null, server: { ok: false, checkedAt: 1, reason: "unreachable", code: "engine_loading" }, setup }
      : { active: "down", engine, model: null, server: { ok: false, checkedAt: 1, reason: "unreachable", code: crashed ? "engine_crashed" : "not_ready" }, setup };
}

/**
 * Before `page` loads: the stand-in device the test build reads (lib/ui/deviceInputs.ts) is
 * `device`, as test/test-build.mjs deviceBuild would package it, for this page alone.
 */
export async function scriptDevice(page, device) {
  await page.addInitScript((device) => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => String(input?.url ?? input).endsWith("/test-device.json")
      ? Promise.resolve(new Response(JSON.stringify(device), { headers: { "content-type": "application/json" } }))
      : real(input, init);
  }, device);
}

/**
 * Before `page` loads: its contract requests are answered with STATES[name] (the page can
 * switch with `window.__engineState = name` later), which engine is in use with `engine`
 * (the in-browser one unless it says "native", or null for none chosen yet), its backend-status question with
 * backendFor(name), and — when given — the storage estimate with `estimate` and the
 * browser's Save-Data setting with `saveData`. Requests the page made are in `window.__engineOps`.
 */
export async function scriptEngine(page, name, { crashed = false, engine = "inbrowser", estimate, saveData } = {}) {
  await page.addInitScript(({ states, name, backends, engine, estimate, saveData }) => {
    window.__engineState = name;
    window.__engineOps = [];
    const api = globalThis.chrome;
    const send = api.runtime.sendMessage.bind(api.runtime);
    api.runtime.sendMessage = (message, ...rest) => {
      if (message?.action === "anagram.nativeRequest") {
        window.__engineOps.push(message.op);
        return Promise.resolve({ v: 1, id: "scripted", ok: true, status: 200, data: states[window.__engineState] });
      }
      if (message?.action === "getBackendStatus") return Promise.resolve(backends[window.__engineState]);
      if (message?.action === "getEngine") return Promise.resolve({ engine });
      return send(message, ...rest);
    };
    if (estimate) navigator.storage.estimate = () => Promise.resolve(estimate);
    if (saveData !== undefined) Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData } });
  }, { states: STATES, name, backends: Object.fromEntries(Object.keys(STATES).map((n) => [n, backendFor(n, { crashed, engine })])), engine, estimate, saveData });
}
