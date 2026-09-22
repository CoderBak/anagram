import { describe, expect, it } from "vitest";
import { componentBusy, componentReady, componentStateLabel, componentConnectionLabel } from "../../lib/ui/componentSettings";
import type { ComponentSnapshot } from "../../lib/backend/nativeClient";
import type { RuntimeSnapshot } from "../../lib/backend/runtimeClient";

const runtime = (patch: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  schema_version: 1, state: "ready", active_id: "torch:cpu:fp32", selected_id: "torch:cpu:fp32", recommended_id: "torch:cpu:fp32", fastest_id: null,
  candidates: [{ id: "torch:cpu:fp32", label: "CPU", device: "cpu", runtime: "torch", precision: "fp32", experimental: false, available: true }],
  benchmark: { status: "idle", budget_s: 30, elapsed_s: 0, measurement_s: 0, phase: "ready", current_id: null, completed: 0, total: 0, results: [] },
  error: null, ...patch,
});

const snapshot = (patch: Partial<ComponentSnapshot> = {}): ComponentSnapshot => ({
  schema_version: 1, version: "0.4.0", home: "/local/anagram", state: "needs_models",
  download: { status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null },
  runtime: null, storage: { models_bytes: 0 }, error: null, operation: null, ...patch,
});

describe("native component UI lifecycle", () => {
  it("distinguishes an occupied native host from a missing installation", () => {
    expect(componentConnectionLabel({ kind: "rejected", code: "busy" })).toBe("In use by another browser");
    expect(componentConnectionLabel({ kind: "unavailable" })).toBe("Not installed");
    expect(componentStateLabel(snapshot({ state: "error", error: { code: "busy", message: "legacy daemon" } }))).toBe("In use by another browser");
  });
  it("is ready only with a loaded or idle-but-selected runtime, never on a completed download alone", () => {
    expect(componentReady(snapshot({ state: "ready" }))).toBe(false);
    expect(componentReady(snapshot({ state: "loading", runtime: runtime({ state: "loading", active_id: null }), download: { status: "completed", bytes_received: 10, total_bytes: 10, file: null, error: null } }))).toBe(false);
    expect(componentReady(snapshot({ state: "ready", runtime: runtime() }))).toBe(true);
    expect(componentReady(snapshot({ state: "idle", runtime: runtime({ state: "idle", active_id: null }) }))).toBe(true);
    expect(componentReady(snapshot({ state: "idle", runtime: runtime({ state: "idle", active_id: null, selected_id: null }) }))).toBe(false);
  });
  it("keeps scheduled system cleanup busy and distinct from confirmed removal", () => {
    const s = snapshot({ state: "stopped", operation: { name: "uninstall", status: "scheduled", receipt: null } });
    expect(componentBusy(s)).toBe(true);
    expect(componentStateLabel(s)).toBe("Finishing in a system window");
    expect(componentReady(s)).toBe(false);
  });
  it("reads ready and idle as Ready, and stopped or starting as their own words", () => {
    expect(componentStateLabel(snapshot({ state: "ready", runtime: runtime() }))).toBe("Ready");
    expect(componentStateLabel(snapshot({ state: "idle", runtime: runtime({ state: "idle", active_id: null }) }))).toBe("Ready");
    expect(componentStateLabel(snapshot({ state: "stopped" }))).toBe("Stopped");
    expect(componentStateLabel(snapshot({ state: "loading" }))).toBe("Starting…");
  });
  it("makes a completed model deletion usable for a deliberate redownload", () => {
    expect(componentBusy(snapshot({ operation: { name: "delete_models", status: "completed", receipt: "done" } }))).toBe(false);
    expect(componentStateLabel(snapshot())).toBe("Model files needed");
  });
  it("labels lifecycle work independently of a stale ready runtime state", () => {
    const s = snapshot({ state: "ready", operation: { name: "delete_models", status: "running", receipt: null } });
    expect(componentBusy(s)).toBe(true);
    expect(componentStateLabel(s)).toBe("Removing…");
  });
  it("labels every download phase as busy, verification by name", () => {
    for (const [phase,label] of [["detecting","Downloading models…"], ["verifying","Verifying model files…"],
      ["downloading","Downloading models…"], ["complete","Downloading models…"]] as const) {
      const s = snapshot({state:"downloading",download:{status:"running",phase,bytes_received:0,total_bytes:0,file:null,error:null}});
      expect(componentStateLabel(s)).toBe(label);
      expect(componentBusy(s)).toBe(true);
      expect(componentReady(s)).toBe(false);
    }
    expect(componentStateLabel(snapshot({state:"paused",download:{status:"paused",phase:"verifying",bytes_received:50,total_bytes:100,file:null,error:null}}))).toBe("Paused");
  });
});
