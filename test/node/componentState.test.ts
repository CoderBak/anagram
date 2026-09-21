import { describe, expect, it } from "vitest";
import { componentBusy, componentReady, componentStateLabel, componentConnectionLabel } from "../../lib/ui/componentSettings";
import type { ComponentSnapshot } from "../../lib/backend/nativeClient";

const snapshot = (patch: Partial<ComponentSnapshot> = {}): ComponentSnapshot => ({
  schema_version: 1, version: "0.4.0", home: "/local/anagram", state: "needs_models",
  download: { status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null },
  runtime: null, storage: { models_bytes: 0 }, error: null, operation: null, ...patch,
});

describe("native component UI lifecycle", () => {
  it("distinguishes an occupied native host from a missing installation", () => {
    expect(componentConnectionLabel({ kind: "rejected", code: "busy" })).toBe("Another Anagram instance is using the local component");
    expect(componentStateLabel(snapshot({ state: "error", error: { code: "busy", message: "legacy daemon" } }))).toBe("Another Anagram instance is using the local component");
  });
  it("does not call installed components or completed downloads ready before model selection", () => {
    expect(componentReady(snapshot({ state: "ready" }))).toBe(false);
    expect(componentReady(snapshot({ state: "awaiting_selection", download: { status: "completed", bytes_received: 10, total_bytes: 10, file: null, error: null } }))).toBe(false);
  });
  it("keeps scheduled system cleanup busy and distinct from confirmed removal", () => {
    const s = snapshot({ state: "stopped", operation: { name: "uninstall", status: "scheduled", receipt: null } });
    expect(componentBusy(s)).toBe(true);
    expect(componentStateLabel(s)).toBe("Cleanup is running in a system window");
    expect(componentReady(s)).toBe(false);
  });
  it("makes a completed model deletion usable for a deliberate redownload", () => {
    expect(componentBusy(snapshot({ operation: { name: "delete_models", status: "completed", receipt: "done" } }))).toBe(false);
    expect(componentStateLabel(snapshot())).toBe("Model files are needed");
  });
  it("labels lifecycle work independently of a stale ready runtime state", () => {
    const s = snapshot({ state: "ready", operation: { name: "delete_models", status: "running", receipt: null } });
    expect(componentBusy(s)).toBe(true);
    expect(componentStateLabel(s)).toBe("Deleting model files…");
  });
  it("identifies preparation phases even before the selected size is known", () => {
    for (const [phase,label] of [["detecting","Detecting usable devices…"], ["verifying","Verifying model files…"],
      ["downloading","Downloading model files…"], ["complete","Model files prepared"]] as const) {
      const s = snapshot({state:"downloading",download:{status:"running",phase,bytes_received:0,total_bytes:0,file:null,error:null}});
      expect(componentStateLabel(s)).toBe(label);
      expect(componentBusy(s)).toBe(true);
      expect(componentReady(s)).toBe(false);
    }
    expect(componentStateLabel(snapshot({state:"paused",download:{status:"paused",phase:"verifying",bytes_received:50,total_bytes:100,file:null,error:null}}))).toBe("Model download paused");
  });
});
