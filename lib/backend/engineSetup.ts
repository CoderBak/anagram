// lib/backend/engineSetup.ts — the in-browser engine's status, in the few stages people are
// told about: nothing yet, downloading, paused, stopped short, starting, ready.
//
// The in-browser engine answers the native host's `status` (lib/webengine/engine.ts);
// its setup page (lib/ui/inBrowserEngine.ts) reads the whole of it, and the background
// passes the popup and the in-page panel the short form, `EngineSetup`, beside "not ready"
// (entrypoints/background.ts). The stages are pure, so each is settled without a browser
// (test/node/engineSetup.test.ts).
import { parseComponent, type ComponentSnapshot } from "./nativeClient";
import type { NativeReply } from "./nativeProtocol";
import type { EngineSetup } from "../messaging/protocol";
import { failureKind, mirrorOf, type DownloadFailure } from "../webengine/download";

export type SetupStage =
  | { stage: "needed" }
  /** `mirror`: the host the files come from where Hugging Face could not be reached. */
  | { stage: "downloading"; received: number; total: number; retrying: boolean; mirror: string | null }
  | { stage: "paused"; received: number; total: number }
  | { stage: "failed"; received: number; total: number; failure: DownloadFailure }
  | { stage: "loading" }
  | { stage: "ready"; device: "gpu" | "cpu" | null }
  | { stage: "stopped" }
  | { stage: "error" };

/** Whole percent, rounded down: 100% only once every byte is there. */
export function percentOf(received: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((received * 100) / total)) : 0;
}

/** How much more room `needed` bytes take than the browser's storage estimate leaves, or null
 *  when they fit or the browser gives no estimate. */
export function roomShort(estimate: { quota?: number; usage?: number }, needed: number): number | null {
  const { quota, usage } = estimate;
  if (quota === undefined || usage === undefined) return null;
  const free = Math.max(0, quota - usage);
  return free < needed ? needed - free : null;
}

/** Where the model runs, or will when it is loaded again: the active configuration, else the selected one. */
function deviceOf(s: ComponentSnapshot): "gpu" | "cpu" | null {
  const id = s.runtime?.active_id ?? s.runtime?.selected_id;
  const device = s.runtime?.candidates.find((c) => c.id === id)?.device;
  return device === "gpu" || device === "cpu" ? device : null;
}

export function setupStage(s: ComponentSnapshot): SetupStage {
  const { status, total_bytes: total } = s.download;
  // A download paused or failed before the browser restarted knows its flags but not its
  // bytes; what is on disk (the parts) says how far it got.
  const received = Math.min(total, Math.max(s.download.bytes_received, s.storage.models_bytes));
  if (status === "running") {
    const mirror = mirrorOf(s.download.detail);
    return { stage: "downloading", received: s.download.bytes_received, total, retrying: !!s.download.detail && !mirror, mirror };
  }
  if (status === "paused" || s.state === "paused") return { stage: "paused", received, total };
  if (status === "failed") return { stage: "failed", received, total, failure: failureKind(s.download.error) };
  switch (s.state) {
    case "needs_models": return { stage: "needed" };
    case "starting": case "loading": return { stage: "loading" };
    case "ready": case "idle": return { stage: "ready", device: deviceOf(s) };
    case "stopped": return { stage: "stopped" };
    default: return { stage: "error" };
  }
}

/** The engine's error codes that say the model could not start, and what the menu calls them:
 *  it failed to load here (lib/webengine/engine.ts "not_ready"), or nothing can run on this
 *  device (the lighter model failed and the full one does not fit; Safari without WebGPU). */
const START_PROBLEM: Record<string, NonNullable<EngineSetup["problem"]>> = {
  not_ready: "load", cannot_run: "device", webgpu_unavailable: "device",
};

/** What the popup and the panel say instead of "not ready", or null when setup is not the reason. */
export function engineSetup(s: ComponentSnapshot): EngineSetup | null {
  const stage = setupStage(s);
  switch (stage.stage) {
    case "needed": return { state: "needed", percent: 0 };
    case "downloading": case "paused": return { state: stage.stage, percent: percentOf(stage.received, stage.total) };
    case "failed": return { state: "failed", percent: percentOf(stage.received, stage.total), failure: stage.failure };
    case "loading": return { state: "loading", percent: 100 };
    case "error": {
      const problem = s.error ? START_PROBLEM[s.error.code] : undefined;
      return problem ? { state: "error", percent: 100, problem } : null;
    }
    default: return null;
  }
}

/** The in-browser engine's setup, asked of the engine itself, or null when it does not say. */
export async function readEngineSetup(request: (op: "status") => Promise<NativeReply>): Promise<EngineSetup | null> {
  try {
    const reply = await request("status");
    const snapshot = reply.ok ? parseComponent(reply.data) : null;
    return snapshot ? engineSetup(snapshot) : null;
  } catch { return null; }
}
