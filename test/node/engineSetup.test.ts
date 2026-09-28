// test/node/engineSetup.test.ts — the in-browser engine's status, in the few stages the
// setup page, the popup and the panel tell people about (lib/backend/engineSetup.ts).
import { describe, expect, it } from "vitest";
import { engineSetup, percentOf, setupStage } from "../../lib/backend/engineSetup";
import type { ComponentSnapshot } from "../../lib/backend/nativeClient";
import { parseWorkerMessage, permitsMessage, type AccessSender } from "../../lib/access/messages";
import { ACTIONS } from "../../lib/messaging/protocol";

const TOTAL = 1_426_397_568;
const runtime = (active: string | null, selected = "webgpu:fp32") => ({
  schema_version: 1 as const, state: active ? "ready" as const : "idle" as const, active_id: active, selected_id: selected, recommended_id: selected, fastest_id: null,
  candidates: [
    { id: "webgpu:fp32", label: "GPU (WebGPU, FP32)", device: "gpu", runtime: "onnxruntime-web/webgpu", precision: "fp32", experimental: false, available: selected === "webgpu:fp32" },
    { id: "wasm:fp32", label: "CPU (WebAssembly, FP32, 4 threads)", device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false, available: true },
  ],
  benchmark: { status: "idle" as const, budget_s: 0, elapsed_s: 0, measurement_s: 0, phase: "idle", current_id: null, completed: 0, total: 0, results: [] },
  error: null,
});
function snapshot(over: Omit<Partial<ComponentSnapshot>, "download"> & { download?: Partial<ComponentSnapshot["download"]> } = {}): ComponentSnapshot {
  const { download, ...rest } = over;
  return {
    schema_version: 1, version: "0.7.0", home: "opfs:anagram-engine", state: "needs_models",
    download: { status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null, phase: "detecting", detail: null, ...download },
    runtime: null, storage: { models_bytes: 0 }, error: null, settings: { idle_unload_s: 300 }, operation: null,
    ...rest,
  } as ComponentSnapshot;
}

describe("the stage setup is in", () => {
  it("starts with nothing downloaded", () => {
    expect(setupStage(snapshot())).toEqual({ stage: "needed" });
    expect(engineSetup(snapshot())).toEqual({ state: "needed", percent: 0 });
  });

  it("follows a download with its bytes, and says when it is retrying", () => {
    const running = snapshot({ state: "downloading", download: { status: "running", bytes_received: TOTAL / 4, total_bytes: TOTAL, phase: "downloading", file: "model.onnx" } });
    expect(setupStage(running)).toEqual({ stage: "downloading", received: TOTAL / 4, total: TOTAL, retrying: false });
    expect(engineSetup(running)).toEqual({ state: "downloading", percent: 25 });
    const retrying = snapshot({ state: "downloading", download: { status: "running", bytes_received: 10, total_bytes: TOTAL, detail: "Retrying model.onnx in 5 s" } });
    expect(setupStage(retrying)).toMatchObject({ stage: "downloading", retrying: true });
  });

  it("counts what is on disk for a download paused or failed before this run of the browser", () => {
    // After a restart the engine knows the flags, not the bytes: the parts on disk say how far it got.
    const paused = snapshot({ state: "paused", download: { status: "paused", bytes_received: 0, total_bytes: TOTAL }, storage: { models_bytes: TOTAL / 2 } });
    expect(setupStage(paused)).toEqual({ stage: "paused", received: TOTAL / 2, total: TOTAL });
    expect(engineSetup(paused)).toEqual({ state: "paused", percent: 50 });
    const failed = snapshot({ state: "needs_models", download: { status: "failed", total_bytes: TOTAL, error: "Retry the model download to continue setup" }, storage: { models_bytes: 700 } });
    expect(setupStage(failed)).toEqual({ stage: "failed", received: 700, total: TOTAL, failure: "other" });
  });

  it("names why a download failed", () => {
    const failed = (error: string) => setupStage(snapshot({ state: "error", download: { status: "failed", total_bytes: TOTAL, error } }));
    expect(failed("The connection for model.onnx was lost")).toMatchObject({ stage: "failed", failure: "network" });
    expect(failed("There is not enough free disk space for model.onnx")).toMatchObject({ failure: "storage" });
    expect(failed("The server answered model.onnx with status 503")).toMatchObject({ failure: "server" });
    expect(failed("Checksum or size mismatch for model.onnx")).toMatchObject({ failure: "damaged" });
    expect(engineSetup(snapshot({ state: "error", download: { status: "failed", total_bytes: TOTAL, bytes_received: TOTAL / 10 } }))).toEqual({ state: "failed", percent: 10 });
  });

  it("is loading, then ready on the GPU or the CPU, once the files are there", () => {
    const done = { status: "completed" as const, bytes_received: TOTAL, total_bytes: TOTAL, phase: "complete" as const };
    expect(setupStage(snapshot({ state: "loading", download: done, runtime: runtime(null) }))).toEqual({ stage: "loading" });
    expect(setupStage(snapshot({ state: "ready", download: done, runtime: runtime("webgpu:fp32") }))).toEqual({ stage: "ready", device: "gpu" });
    expect(setupStage(snapshot({ state: "ready", runtime: runtime("wasm:fp32", "wasm:fp32") }))).toEqual({ stage: "ready", device: "cpu" });
    // Unloaded while idle: where it will run again is the selected configuration.
    expect(setupStage(snapshot({ state: "idle", runtime: runtime(null, "wasm:fp32") }))).toEqual({ stage: "ready", device: "cpu" });
    expect(setupStage(snapshot({ state: "stopped", runtime: runtime(null) }))).toEqual({ stage: "stopped" });
    expect(setupStage(snapshot({ state: "error", runtime: runtime(null), error: { code: "not_ready", message: "no" } }))).toEqual({ stage: "error" });
    // Loading is the last stage of setup, which the popup and the panel say rather than "not ready".
    expect(engineSetup(snapshot({ state: "loading", download: done, runtime: runtime(null) }))).toEqual({ state: "loading", percent: 100 });
    // Nothing left to set up: the popup and the panel say what they always say.
    for (const state of ["ready", "idle", "stopped", "error"] as const) expect(engineSetup(snapshot({ state, runtime: runtime(null) }))).toBeNull();
  });

  it("rounds a percentage down, so 100% means done", () => {
    expect(percentOf(TOTAL - 1, TOTAL)).toBe(99);
    expect(percentOf(TOTAL, TOTAL)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
  });
});

describe("the panel's way to setup", () => {
  const session = "11111111-2222-4333-8444-555555555555";
  const top: AccessSender = { id: "ext", url: "https://example.com/post", tab: { id: 3, url: "https://example.com/post" }, frameId: 0 };

  it("is asked for by a page's top frame or the reader, and names nothing but itself", () => {
    const open = parseWorkerMessage({ action: ACTIONS.OPEN_ENGINE_SETUP, session })!;
    expect(open).not.toBeNull();
    expect(permitsMessage("content", open, top)).toBe(true);
    expect(permitsMessage("reader", open, top)).toBe(true);
    expect(permitsMessage("content", open, { ...top, frameId: 7 })).toBe(false);
    expect(permitsMessage("paste", open, top)).toBe(false);
    // Where it opens is the worker's to say: a page cannot name an address.
    expect(parseWorkerMessage({ action: ACTIONS.OPEN_ENGINE_SETUP, session, url: "https://example.org/" })).toBeNull();
  });
});
