// test/webengine/scripted-engine.mjs — the in-browser engine's states, handed to one page.
//
// The oneclick build's setup page, popup and panel paint whatever the engine's `status`
// says (lib/ui/inBrowserEngine.ts, lib/backend/engineSetup.ts). Some of those states take
// minutes or a machine to reach for real — a finished 1.4 GB download, a GPU, a full disk,
// a model that failed to load — so the layout, accessibility and copy suites script them:
// an init script answers the page's own contract requests and backend-status question with
// a snapshot of the engine's exact shape, and can stand in for the browser's permission
// answer and storage estimate. Everything else the page asks goes to the real extension.
// test/oneclick.mjs drives the real engine through the same states it can reach.
const TOTAL = 1_426_397_568;

const download = (over = {}) => ({ status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null, phase: "detecting", detail: null, ...over });
const runtime = (active, selected = active ?? "webgpu:fp32") => ({
  schema_version: 1, state: active ? "ready" : "idle", active_id: active, selected_id: selected, recommended_id: selected, fastest_id: null,
  candidates: [
    { id: "webgpu:fp32", label: "GPU (WebGPU, FP32) — apple metal-3", device: "gpu", runtime: "onnxruntime-web/webgpu", precision: "fp32", experimental: false, available: selected === "webgpu:fp32", reason: null },
    { id: "wasm:fp32", label: "CPU (WebAssembly, FP32, 4 threads)", device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false, available: true, reason: null },
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
  retrying: snapshot({ state: "downloading", download: download({ status: "running", bytes_received: TOTAL * 0.45, total_bytes: TOTAL, phase: "downloading", file: "model.onnx", detail: "Retrying model.onnx in 5 s" }), storage: { models_bytes: TOTAL * 0.45 } }),
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
};

/** What the background says about the engine while it is in `state` (entrypoints/background.ts). */
export function backendFor(name, { crashed = false } = {}) {
  const s = STATES[name];
  const up = s.state === "ready" && !crashed;
  const percent = s.download.total_bytes ? Math.floor((Math.max(s.download.bytes_received, s.storage.models_bytes) * 100) / s.download.total_bytes) : 0;
  const setup = crashed ? undefined
    : s.download.status === "running" ? { state: "downloading", percent }
    : s.download.status === "paused" ? { state: "paused", percent }
    : s.download.status === "failed" ? { state: "failed", percent }
    : s.state === "needs_models" ? { state: "needed", percent: 0 } : null;
  return up
    ? { active: "server", model: { id: "editlens_roberta-large", ver: "sha256:test-web1", calibration: "editlens-4bucket-cosine(0.03,0.15)" }, server: { ok: true, checkedAt: 1, device: "webgpu", dtype: "fp32" } }
    : { active: "down", model: null, server: { ok: false, checkedAt: 1, reason: "unreachable", code: crashed ? "engine_crashed" : "not_ready" }, setup };
}

/**
 * Before `page` loads: its contract requests are answered with STATES[name] (the page can
 * switch with `window.__engineState = name` later), its backend-status question with
 * backendFor(name), and — when given — the permission prompt with `permission` and the
 * storage estimate with `estimate`. Requests the page made are in `window.__engineOps`.
 */
export async function scriptEngine(page, name, { crashed = false, permission, estimate } = {}) {
  await page.addInitScript(({ states, name, backends, permission, estimate }) => {
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
      return send(message, ...rest);
    };
    if (permission !== undefined) {
      api.permissions.request = (request) => { window.__engineOps.push(`permissions.request ${request.origins.join(" ")}`); return Promise.resolve(permission); };
      api.permissions.contains = () => Promise.resolve(permission);
    }
    if (estimate) navigator.storage.estimate = () => Promise.resolve(estimate);
  }, { states: STATES, name, backends: Object.fromEntries(Object.keys(STATES).map((n) => [n, backendFor(n, { crashed })])), permission, estimate });
}
