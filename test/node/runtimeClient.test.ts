import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { NATIVE_MESSAGE } from "../../lib/backend/nativeProtocol";
import {
  canApplyRuntime, parseRuntime, requestRuntime, runtimeBusy, runtimePollMs, runtimeReady,
  type RuntimeSnapshot,
} from "../../lib/backend/runtimeClient";

const candidate = (id: string, precision = "fp32") => ({ id, precision, label: id, device: "cpu", runtime: "torch", experimental: false, available: true });
const snapshot = (patch: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  schema_version: 1, state: "awaiting_selection", active_id: null, selected_id: null,
  recommended_id: "torch:cpu:fp32", needs_selection: true,
  candidates: [candidate("torch:cpu:fp32"), candidate("torch:cpu:fp16", "fp16")],
  benchmark: { status: "completed", budget_s: 30, elapsed_s: 62, measurement_s: 30, phase: "awaiting_selection", current_id: null, completed: 2, total: 2, results: [] },
  error: null, ...patch,
});

const result = (batch_size: number) => ({ candidate_id: "torch:cpu:fp32", status: "ok" as const, batch_size, samples: 4, latency_ms: 40, throughput_per_s: 30, load_ms: 1000, warmup_ms: 300, peak_rss_bytes: 1024 });
function respond(body: unknown, status = 200) {
  return vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(status < 400
    ? {v:1,id:"fixture",ok:true,status,data:body}
    : {v:1,id:"fixture",ok:false,status,error:{code:"busy",message:"Benchmark already running"}});
}
beforeEach(() => fakeBrowser.reset());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("runtime contract validation", () => {
  it("accepts two workloads for one candidate and preserves unavailable accelerator memory", () => {
    const s = snapshot(); s.benchmark.results = [result(1), { ...result(8), accelerator_bytes: null }];
    const parsed = parseRuntime(s)!;
    expect(parsed.benchmark.results).toHaveLength(2);
    expect(parsed.benchmark.results[0].accelerator_bytes).toBeUndefined();
    expect(parsed.benchmark.results[1].accelerator_bytes).toBeNull();
  });
  it("accepts an errored measurement without pretending its metrics are zero", () => {
    const s = snapshot(); s.benchmark.results = [{ candidate_id: "torch:cpu:fp32", status: "error", error: "load failed", latency_ms: null, samples: null, batch_size: 1 }];
    expect(parseRuntime(s)?.benchmark.results[0].latency_ms).toBeNull();
  });
  it.each([
    () => snapshot({ schema_version: 2 as 1 }),
    () => snapshot({ active_id: "unknown" }),
    () => snapshot({ candidates: [candidate("same"), candidate("same")] }),
    () => { const s = snapshot(); s.benchmark.results = [{ ...result(1), latency_ms: -1 }]; return s; },
    () => { const s = snapshot(); s.benchmark.measurement_s = Infinity; return s; },
    () => { const s = snapshot(); s.benchmark.results = [{ ...result(1), candidate_id: "unknown" }]; return s; },
  ])("rejects a malformed response", (body) => expect(parseRuntime(body())).toBeNull());
});

describe("runtime readiness and explicit choice", () => {
  const ready = () => snapshot({ state: "ready", needs_selection: false, selected_id: "torch:cpu:fp32", active_id: "torch:cpu:fp32" });
  it("does not call completed measurements ready before the user selects", () => {
    expect(runtimeReady(snapshot())).toBe(false);
    expect(canApplyRuntime(snapshot(), null)).toBe(false);
    expect(canApplyRuntime(snapshot(), "torch:cpu:fp16")).toBe(true);
  });
  it("requires the selected model to be the active one", () => {
    expect(runtimeReady(ready())).toBe(true);
    expect(runtimeReady({ ...ready(), selected_id: "torch:cpu:fp16" })).toBe(false);
    expect(runtimeReady({ ...ready(), needs_selection: true })).toBe(false);
  });
  it("a rerun blocks changes without silently replacing the saved configuration", () => {
    const s = ready(); s.benchmark.status = "running"; s.state = "benchmarking";
    expect(runtimeBusy(s)).toBe(true);
    expect(canApplyRuntime(s, "torch:cpu:fp16")).toBe(false);
    expect(s.selected_id).toBe("torch:cpu:fp32");
    expect(runtimePollMs(s)).toBe(1000);
    expect(runtimePollMs(ready())).toBe(15000);
  });
  it("refuses unavailable candidates and an already-active choice", () => {
    const s = ready(); s.candidates[1].available = false;
    expect(canApplyRuntime(s, "torch:cpu:fp16")).toBe(false);
    expect(canApplyRuntime(s, "torch:cpu:fp32")).toBe(false);
    expect(canApplyRuntime(s, "unknown")).toBe(false);
  });
});

describe("native runtime requests", () => {
  it("reads status without starting the automatic benchmark", async () => {
    const send = respond(snapshot());
    expect((await requestRuntime()).kind).toBe("ok");
    expect(send).toHaveBeenCalledExactlyOnceWith({action:NATIVE_MESSAGE,op:"runtime",payload:{}});
  });
  it.each([
    ["benchmark",undefined,{budget_s:30}], ["cancel",undefined,{}], ["config","torch:cpu:fp32",{id:"torch:cpu:fp32"}],
  ] as const)("sends only the documented %s operation", async (action,id,payload) => {
    const send = respond(snapshot(),202); await requestRuntime(action,id);
    expect(send).toHaveBeenCalledExactlyOnceWith({action:NATIVE_MESSAGE,op:`runtime.${action}`,payload});
  });
  it("rejects missing or overlong configuration IDs before invoking the bridge", async () => {
    const send = respond(snapshot());
    expect((await requestRuntime("config")).kind).toBe("invalid");
    expect((await requestRuntime("config","x".repeat(121))).kind).toBe("invalid");
    expect(send).not.toHaveBeenCalled();
  });
  it("reports native conflicts and malformed snapshots", async () => {
    respond({},409);
    expect(await requestRuntime("benchmark")).toEqual({kind:"rejected",message:"Benchmark already running"});
    vi.restoreAllMocks(); respond({}); expect((await requestRuntime()).kind).toBe("invalid");
  });
  it("ignores stale HTTP settings and never fetches", async () => {
    await fakeBrowser.storage.local.set({backendTransport:"http",serverUrl:"https://example.com"});
    const fetcher = vi.fn(); vi.stubGlobal("fetch",fetcher); const send = respond(snapshot());
    expect((await requestRuntime()).kind).toBe("ok"); expect(send).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not dispatch a cancelled request", async () => {
    const send = respond(snapshot()); const controller = new AbortController(); controller.abort();
    expect((await requestRuntime(undefined,undefined,controller.signal)).kind).toBe("unavailable"); expect(send).not.toHaveBeenCalled();
  });
});
