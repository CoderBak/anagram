import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canApplyRuntime, parseRuntime, requestHttpRuntime as requestRuntime, runtimeBusy, runtimePollMs, runtimeReady,
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
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

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

describe("runtime requests", () => {
  it("reading setup is GET only; automatic benchmarking belongs to the daemon", async () => {
    const fetcher = respond(snapshot());
    expect((await requestRuntime("http://127.0.0.1:8765")).kind).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8765/runtime", expect.objectContaining({ method: "GET", redirect: "error", cache: "no-store" }));
  });
  it.each([
    ["benchmark", undefined, { budget_s: 30 }],
    ["cancel", undefined, {}],
    ["config", "torch:cpu:fp32", { id: "torch:cpu:fp32" }],
  ] as const)("sends only the documented %s action", async (action, id, body) => {
    const fetcher = respond(snapshot(), 202);
    await requestRuntime("http://localhost:8765", action, id);
    expect(fetcher).toHaveBeenCalledWith(`http://localhost:8765/runtime/${action}`, expect.objectContaining({ method: "POST", body: JSON.stringify(body) }));
  });
  it("refuses a remote address before fetching", async () => {
    const fetcher = respond(snapshot());
    expect((await requestRuntime("https://example.com")).kind).toBe("invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("identifies legacy daemons and action conflicts", async () => {
    respond({}, 404);
    expect((await requestRuntime("http://localhost:8765")).kind).toBe("unsupported");
    respond({ detail: "Benchmark already running" }, 409);
    expect(await requestRuntime("http://localhost:8765", "benchmark")).toEqual({ kind: "rejected", message: "Benchmark already running" });
  });
});
