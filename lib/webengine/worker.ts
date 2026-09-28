// lib/webengine/worker.ts — the engine's Web Worker: native_host.py's message loop.
//
// Built by scripts/webengine.mjs into vendor/engine/worker.min.mjs and started by
// lib/webengine/host.ts from an offscreen document (Chrome) or the background page
// (Firefox). It imports no extension API: everything it needs to know — the pin, the
// runtime's URLs, the extension version — arrives in the first message. Requests are
// the native host's envelopes and are answered with its replies, concurrently, each
// under its own id; a request that is not one is refused as the host refuses it. When
// the engine lets the model go while idle the worker says so ("idle"), and every reply
// says whether it still is: a worker's WebAssembly memory cannot shrink, so the host
// ends an idle worker once nothing waits on it, and starts the next one with `idle`
// set, which loads the model again only when a score asks.
import { Engine, type EngineInit } from "./engine";
import { EngineError, fail, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, ok, parseEngineRequest, type EngineReply } from "./protocol";
import { probeRuntimes } from "./session";
import { OpfsStore } from "./storage";

export interface WorkerInit {
  type: "init"; pin: EngineInit["pin"]; assets: EngineInit["assets"]; version: string | null; idle?: boolean;
  /** The engine's own suites only (test/webengine/harness.mjs): a software WebGPU adapter counts as a GPU. */
  softwareGpu?: boolean;
}
export type WorkerMessage = WorkerInit | { type: "request"; request: unknown };
export type WorkerReply = { type: "ready" } | { type: "reply"; reply: EngineReply; idle: boolean } | { type: "idle" };

let engine: Engine | null = null;
const pending = new Set<string>();

async function answer(request: unknown): Promise<EngineReply> {
  if (JSON.stringify(request).length > MAX_REQUEST_BYTES) return fail("protocol-error", "invalid_request", "Native request exceeds the allowed size", 400);
  const parsed = parseEngineRequest(request);
  if (!parsed) {
    const id = (request as { id?: unknown })?.id;
    return fail(typeof id === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(id) ? id : "protocol-error", "invalid_request", "Invalid native request envelope or operation", 422);
  }
  if (pending.has(parsed.id)) return fail(parsed.id, "busy", "A request with this identifier is already pending", 409);
  pending.add(parsed.id);
  try {
    const { status, data } = await engine!.handle(parsed.op, parsed.payload);
    const reply = ok(parsed.id, data, status);
    if (JSON.stringify(reply).length > MAX_RESPONSE_BYTES) return fail(parsed.id, "response_too_large", "The native response exceeds the allowed size", 413);
    return reply;
  } catch (error) {
    if (error instanceof EngineError) return fail(parsed.id, error.code, error.message, error.status);
    return fail(parsed.id, "internal_error", "The local component operation failed", 500);
  } finally {
    pending.delete(parsed.id);
  }
}

const post = (message: WorkerReply): void => (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    if (engine) return;
    void (async () => {
      const store = await OpfsStore.open();
      engine = new Engine({
        pin: message.pin, assets: message.assets, version: message.version, store, idle: message.idle === true,
        onIdle: () => post({ type: "idle" }),
        ...(message.softwareGpu === true ? { probe: () => probeRuntimes({ softwareGpu: true }) } : {}),
      });
      await engine.start();
      post({ type: "ready" });
    })();
    return;
  }
  if (message.type === "request") {
    if (!engine) { post({ type: "reply", reply: fail("protocol-error", "not_ready", "The engine is starting", 503), idle: false }); return; }
    void answer(message.request).then((reply) => post({ type: "reply", reply, idle: engine!.idle }));
  }
};
