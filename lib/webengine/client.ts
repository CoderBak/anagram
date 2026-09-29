// lib/webengine/client.ts — the in-browser engine's transport (lib/backend/transport.ts).
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
import { PortTransport, type NativePort } from "../backend/portTransport";
import type { EngineTransport } from "../backend/transport";
import { WORKER_URL, workerInit } from "./assets";
import { EngineHost } from "./host";
import { ENGINE_PORT } from "./protocol";
import { tierQuery } from "./tier";
import { engineTierChoice } from "./tierStore";

const OFFSCREEN_PATH = "/engine.html";
/** The overall bound on a request that waits for the model to load: about five minutes. */
export const LOAD_WAIT_MS = 300_000;

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
  // The tier the setup page chose goes in the address: the document has no storage to read it from.
  const tier = tierQuery(await engineTierChoice.getValue().catch(() => null));
  creating ??= api.createDocument({
    url: OFFSCREEN_PATH + tier,
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

class WebEngineTransport extends PortTransport {
  constructor() {
    // A score waits for a loading model, which takes minutes on the processor, for at most as long as
    // the engine itself does (its WAKE_TIMEOUT_MS, 285 s) and a little more, so its answer is the one heard.
    super(() => (offscreenApi() ? offscreenPort() : new EngineHost({ workerUrl: WORKER_URL(), init: async () => workerInit(await engineTierChoice.getValue().catch(() => null)) })),
      { cannotStart: "The in-browser engine could not be started", loadWaitMs: LOAD_WAIT_MS });
  }
  protected override lastError(): string | undefined { return browser.runtime.lastError?.message; }
}

/** Whether the engine's offscreen document is there (Chrome), so that asking the engine
 *  something cannot start it; false where there is none, or no such API (Firefox). */
export async function webEngineRunning(): Promise<boolean> {
  const api = offscreenApi();
  try { return !!api?.hasDocument && (await api.hasDocument()); } catch { return false; }
}

let instance: EngineTransport | undefined;

/**
 * The in-browser engine: the offscreen document's port on Chrome, a worker in this page on
 * Firefox, behind the same request multiplexing, timeouts and reconnection as the local
 * engine's transport.
 */
export function webEngineTransport(): EngineTransport {
  return instance ??= new WebEngineTransport();
}

/**
 * The in-browser engine is no longer the one in use: what it was asked is refused, and it
 * lets its model go — Chrome's offscreen document is closed, Firefox's worker ended (closing
 * the transport ends it). The next request starts it afresh.
 */
export async function closeWebEngine(): Promise<void> {
  instance?.close("native_unavailable", "The engine was switched");
  const api = offscreenApi() as (OffscreenApi & { closeDocument?(): Promise<void> }) | undefined;
  try {
    await creating?.catch(() => undefined);
    if (api?.closeDocument && (!api.hasDocument || (await api.hasDocument()))) await api.closeDocument();
  } catch { /* already closed */ }
}
