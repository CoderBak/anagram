// lib/webengine/client.ts — the oneclick flavor's engine transport (lib/backend/transport.ts).
//
// The same multiplexing as the native host's (lib/backend/nativeTransport.ts: request(op,
// payload, signal, timeout) → the host's reply, onDisconnect, close), over a different
// port. On Chrome the engine's worker lives in an offscreen document (a service worker
// cannot start workers, and dies after thirty idle seconds, which no 1.4 GB model should
// follow), reached through a runtime port named ENGINE_PORT; the document is created on
// the first request and kept. On Firefox the background page is a document already, so
// it hosts the worker itself. Either way the transport speaks the native host's contract,
// and lib/backend/nativeScoreClient.ts and nativeClient.ts need no change.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { NativeTransport, type NativePort } from "../backend/nativeTransport";
import type { EngineTransport } from "../backend/transport";
import { EngineHost } from "./host";
import { pin } from "./pin";
import { ENGINE_PORT } from "./protocol";
import type { WorkerInit } from "./worker";

const OFFSCREEN_PATH = "/engine.html";

const url = (path: string): string => browser.runtime.getURL(path as PublicPath);

/** The worker's first message: the pin, the runtime files' URLs and the extension version. */
export function workerInit(): Omit<WorkerInit, "type"> {
  let version: string | null = null;
  try { version = browser.runtime.getManifest().version; } catch { /* outside an extension */ }
  return {
    pin: pin(),
    assets: {
      ort: url("/vendor/engine/ort.min.mjs"),
      mjs: url("/vendor/engine/ort-wasm-simd-threaded.jsep.mjs"),
      wasm: url("/vendor/engine/ort-wasm-simd-threaded.jsep.wasm"),
    },
    version,
  };
}

/** The worker script, wherever the host runs. */
export const WORKER_URL = (): string => url("/vendor/engine/worker.min.mjs");

interface OffscreenApi {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  hasDocument?(): Promise<boolean>;
}
const offscreenApi = (): OffscreenApi | undefined => (globalThis as { chrome?: { offscreen?: OffscreenApi } }).chrome?.offscreen;

let creating: Promise<void> | null = null;

/** The offscreen document, created once; concurrent callers share the creation. */
export async function ensureOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (!api) throw new Error("no offscreen API");
  if (api.hasDocument && (await api.hasDocument())) return;
  creating ??= api.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS"],
    justification: "Runs the EditLens scoring model in a Web Worker; a service worker cannot start workers and is unloaded when idle",
  }).catch((error: unknown) => {
    // Two callers raced past hasDocument: the document is there.
    if (!/single offscreen|already exists|Only a single/i.test(String((error as Error)?.message ?? error))) throw error;
  }).finally(() => { creating = null; });
  await creating;
}

/**
 * A port to the offscreen document that connects when the document is up: requests
 * posted before then wait, and a document that cannot be created disconnects the port.
 */
export function offscreenPort(): NativePort {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  let failed = false;
  const queued: unknown[] = [];
  const messageListeners = new Set<(value: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const out: NativePort = {
    postMessage(message) {
      if (failed) throw new Error("engine port closed");
      if (port) port.postMessage(message);
      else queued.push(message);
    },
    disconnect() {
      failed = true;
      try { port?.disconnect(); } catch { /* gone */ }
      port = null;
    },
    onMessage: { addListener: (fn) => { messageListeners.add(fn); } },
    onDisconnect: { addListener: (fn) => { disconnectListeners.add(fn); } },
  };
  void ensureOffscreenDocument().then(() => {
    if (failed) return;
    const connected = browser.runtime.connect({ name: ENGINE_PORT });
    connected.onMessage.addListener((value) => { for (const fn of messageListeners) fn(value); });
    connected.onDisconnect.addListener(() => {
      out.error = { message: browser.runtime.lastError?.message ?? "Engine document disconnected" };
      failed = true;
      port = null;
      for (const fn of disconnectListeners) fn();
    });
    port = connected;
    for (const message of queued.splice(0)) connected.postMessage(message);
  }, (error: unknown) => {
    out.error = { message: `Engine document unavailable: ${(error as Error)?.message ?? error}` };
    failed = true;
    for (const fn of disconnectListeners) fn();
  });
  return out;
}

let instance: EngineTransport | undefined;

/**
 * What "#flavor/engine-transport" names in the oneclick flavor: the offscreen document's
 * port on Chrome, a worker in this page on Firefox, behind the native transport's
 * request multiplexing, timeouts and reconnection.
 */
export function engineTransport(): EngineTransport {
  return instance ??= new NativeTransport(() => (offscreenApi() ? offscreenPort() : new EngineHost({ workerUrl: WORKER_URL(), init: workerInit() })));
}
