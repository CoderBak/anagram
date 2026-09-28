// lib/webengine/assets.ts — where the engine's worker and runtime are, in this extension.
//
// Shared by the background's transport (lib/webengine/client.ts, the flavor-swapped
// module) and the offscreen document (entrypoints/engine/main.ts), which starts the
// worker itself: the first message the worker gets carries the pin, the runtime files'
// URLs and the extension version, so the worker imports no extension API at all.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { LID_PATH, pin } from "./pin";
import type { WorkerInit } from "./worker";

const url = (path: string): string => browser.runtime.getURL(path as PublicPath);

/** The worker's first message. */
export function workerInit(): Omit<WorkerInit, "type"> {
  let version: string | null = null;
  try { version = browser.runtime.getManifest().version; } catch { /* outside an extension */ }
  return {
    pin: pin(url(LID_PATH)),
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
