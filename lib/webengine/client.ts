// lib/webengine/client.ts — the in-browser engine's transport (lib/backend/transport.ts).
//
// The same multiplexing as the native host's (lib/backend/nativeTransport.ts: request(op,
// payload, signal, timeout) → the host's reply, onDisconnect, close), over a different
// port. On Chrome the engine's worker lives in an offscreen document (a service worker
// cannot start workers, and dies after thirty idle seconds, which no 1.4 GB model should
// follow), reached through a runtime port named ENGINE_PORT; the document is created on
// the first request and kept. On Firefox the background page is a document already, so
// it hosts the worker itself. Safari uses a pinned engine tab. Each transport speaks the native host's contract,
// and lib/backend/nativeScoreClient.ts and nativeClient.ts need no change.
import { browser } from "#imports";
import { PortTransport, type NativePort } from "../backend/portTransport";
import type { EngineTransport } from "../backend/transport";
import { WORKER_URL, workerInit } from "./assets";
import { EngineHost } from "./host";
import { ENGINE_PORT } from "./protocol";
import { tierQuery } from "./tier";
import { engineTierChoice } from "./tierStore";
import { IS_SAFARI } from "../surface";
import { closeSafariEngine, safariEnginePort, safariEngineRunning } from "./safariTab";

const OFFSCREEN_PATH = "/engine.html";
/** The overall bound on a request that waits for the model to load: about five minutes. */
export const LOAD_WAIT_MS = 300_000;

interface OffscreenApi {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
}
const offscreenApi = (): OffscreenApi | undefined => (globalThis as { chrome?: { offscreen?: OffscreenApi } }).chrome?.offscreen;

let creating: Promise<void> | null = null;

// Chrome 137 can enumerate offscreen contexts. Only the engine uses one in this extension.
async function offscreenExists(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

/** Concurrent requests and an engine switch share the entire lookup and creation. */
export function ensureOffscreenDocument(): Promise<void> {
  creating ??= createOffscreenDocument().finally(() => { creating = null; });
  return creating;
}

async function createOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (!api) throw new Error("no offscreen API");
  if (await offscreenExists()) return;
  const tier = tierQuery(await engineTierChoice.getValue().catch(() => null));
  const version = `${tier ? "&" : "?"}version=${encodeURIComponent(browser.runtime.getManifest().version)}`;
  await api.createDocument({
    url: OFFSCREEN_PATH + tier + version,
    reasons: ["WORKERS"],
    justification: "Runs the selected Anagram detector in a Web Worker while the extension's service worker is idle",
  });
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
      queued.length = 0;
      try { port?.disconnect(); } catch { /* gone */ }
      port = null;
    },
    onMessage: { addListener: (fn) => { messageListeners.add(fn); } },
    onDisconnect: { addListener: (fn) => { disconnectListeners.add(fn); } },
  };
  async function connect(): Promise<void> {
    try {
      await ensureOffscreenDocument();
      if (failed) return;
      port = browser.runtime.connect({ name: ENGINE_PORT });
      port.onMessage.addListener((value) => { for (const fn of messageListeners) fn(value); });
      port.onDisconnect.addListener(() => {
        const message = browser.runtime.lastError?.message ?? "Engine document disconnected";
        if (failed) return;
        failed = true;
        port = null;
        out.error = { message };
        for (const fn of disconnectListeners) fn();
      });
      for (const message of queued.splice(0)) port.postMessage(message);
    } catch (error) {
      if (failed) return;
      out.error = { message: `Engine document unavailable: ${error instanceof Error ? error.message : String(error)}` };
      out.disconnect();
      for (const fn of disconnectListeners) fn();
    }
  }
  void connect();
  return out;
}

class WebEngineTransport extends PortTransport {
  constructor() {
    // A score waits for a loading model, which takes minutes on the processor, for at most as long as
    // the engine itself does (its WAKE_TIMEOUT_MS, 285 s) and a little more, so its answer is the one heard.
    super(() => (IS_SAFARI ? safariEnginePort() : offscreenApi() ? offscreenPort() : new EngineHost({ workerUrl: WORKER_URL(), init: async () => workerInit(await engineTierChoice.getValue().catch(() => null)) })),
      {
        cannotStart: "The in-browser engine could not be started", loadWaitMs: LOAD_WAIT_MS,
        cancelScore: (port, id) => port.postMessage({ type: "cancelScore", id }),
      });
  }
  protected override lastError(): string | undefined { return browser.runtime.lastError?.message; }
}

/** Whether the engine document exists (Chrome offscreen document or Safari tab), so
 *  a warm-up can reuse it; false where no separate document exists (Firefox). */
export async function webEngineRunning(): Promise<boolean> {
  if (IS_SAFARI) return safariEngineRunning();
  try { return !!offscreenApi() && await offscreenExists(); } catch { return false; }
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
  if (IS_SAFARI) { await closeSafariEngine(); return; }
  const api = offscreenApi();
  try {
    await creating?.catch(() => undefined);
    if (api && await offscreenExists()) await api.closeDocument();
  } catch { /* already closed */ }
}
