// lib/webengine/host.ts — the engine's worker, seen as a port.
//
// lib/backend/nativeTransport.ts multiplexes requests over anything with a native port's
// four members (postMessage, disconnect, onMessage, onDisconnect). EngineHost is that
// for the worker: it starts vendor/engine/worker.min.mjs, sends it the initial message
// with the pin and the runtime's URLs, queues requests until the engine says it is up,
// and turns a crashed worker into a disconnect, after which the next request starts a
// fresh one. It imports no extension API either; the caller hands it the URLs.
import type { NativePort } from "../backend/nativeTransport";
import type { WorkerInit, WorkerReply } from "./worker";

export interface HostOptions {
  /** The worker script's URL. */
  workerUrl: string;
  init: Omit<WorkerInit, "type">;
}

export class EngineHost implements NativePort {
  private worker: Worker | null = null;
  private ready = false;
  private queue: unknown[] = [];
  private readonly messageListeners = new Set<(value: unknown) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  error?: { message?: string };

  constructor(private readonly options: HostOptions) {}

  readonly onMessage = { addListener: (fn: (value: unknown) => void): void => { this.messageListeners.add(fn); } };
  readonly onDisconnect = { addListener: (fn: () => void): void => { this.disconnectListeners.add(fn); } };

  /** Whether a worker is running. */
  get running(): boolean { return this.worker !== null; }

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerUrl, { type: "module", name: "anagram-engine" });
    this.worker = worker;
    this.ready = false;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message.type === "ready") {
        this.ready = true;
        const queued = this.queue;
        this.queue = [];
        for (const request of queued) worker.postMessage({ type: "request", request });
      } else if (message.type === "reply") {
        for (const listener of this.messageListeners) listener(message.reply);
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      this.error = { message: event.message || "The engine worker failed" };
      this.disconnect();
    };
    const init: WorkerInit = { type: "init", ...this.options.init };
    worker.postMessage(init);
    return worker;
  }

  postMessage(message: unknown): void {
    const worker = this.start();
    if (this.ready) worker.postMessage({ type: "request", request: message });
    else this.queue.push(message);
  }

  /** Stop the worker; pending requests are the transport's to reject. */
  disconnect(): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.queue = [];
    worker?.terminate();
    if (worker) for (const listener of this.disconnectListeners) listener();
  }
}
