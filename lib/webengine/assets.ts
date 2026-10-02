// lib/webengine/assets.ts — where the engine's worker and runtime are, in this extension.
//
// Shared by the background's transport (lib/webengine/client.ts) and the offscreen document (entrypoints/engine/main.ts), which starts the
// worker itself: the first message the worker gets carries the pin, the runtime files'
// URLs and the extension version, so the worker imports no extension API at all.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { LID_PATH, pin } from "./pin";
import type { TierChoice } from "./tier";
import type { WorkerInit } from "./worker";
import { IS_SAFARI } from "../surface";

const url = (path: string): string => browser.runtime.getURL(path as PublicPath);

/** The worker's first message, for the tier the setup page chose (FP32 when none). */
export function workerInit(choice?: TierChoice | null): Omit<WorkerInit, "type"> {
  let version: string | null = null;
  try { version = browser.runtime.getManifest().version; } catch { /* outside an extension */ }
  return {
    pin: pin(url(LID_PATH), choice?.tier === "fp16" ? "fp16" : "fp32"),
    // Where FP16 fails to run and FP32 fits the device, FP32 takes its place (lib/webengine/engine.ts).
    ...(choice?.tier === "fp16" && choice.fallback && !IS_SAFARI ? { fallback: pin(url(LID_PATH), "fp32") } : {}),
    ...(IS_SAFARI ? { gpuOnly: true } : {}),
    assets: {
      ort: url("/vendor/engine/ort.jspi.min.mjs"),
      mjs: url("/vendor/engine/ort-wasm-simd-threaded.jspi.mjs"),
      wasm: url("/vendor/engine/ort-wasm-simd-threaded.jspi.wasm"),
    },
    version,
  };
}

/** The worker script, wherever the host runs. */
export const WORKER_URL = (): string => url("/vendor/engine/worker.min.mjs");
