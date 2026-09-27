// lib/webengine/host.ts — the engine's worker, seen as a port.
//
// lib/backend/nativeTransport.ts multiplexes requests over anything with a native port's
// four members (postMessage, disconnect, onMessage, onDisconnect). EngineHost is that
// for the worker: it starts vendor/engine/worker.min.mjs, sends it the initial message
// with the pin and the runtime's URLs, queues requests until the engine says it is up,
// and turns a crashed worker into a disconnect, after which the next request starts a
// fresh one. A worker that has let the model go while idle is ended quietly once no
// request waits on it and its last reply says it is still idle: that is the only way to
// give its WebAssembly memory back. The next request starts a fresh one that knows it is
// idle. It imports no extension API either; the caller hands it the URLs.
import type { NativePort } from "../backend/portTransport";
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
  /** Requests the current worker has not answered yet: every request gets one reply. */
  private unanswered = 0;
  /** The worker said it let the model go while idle: end it when nothing waits on it. */
  private ending = false;
  /** The last worker was ended while idle: the next one starts so. */
  private idle = false;
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
        this.unanswered--;
        if (!message.idle) this.ending = false;
        for (const listener of this.messageListeners) listener(message.reply);
        this.endIfIdle(worker);
      } else if (message.type === "idle") {
        this.ending = true;
        this.endIfIdle(worker);
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      this.error = { message: event.message || "The engine worker failed" };
      this.disconnect();
    };
    const init: WorkerInit = { type: "init", ...this.options.init, idle: this.idle };
    this.idle = false;
    worker.postMessage(init);
    return worker;
  }

  private endIfIdle(worker: Worker): void {
    if (!this.ending || this.worker !== worker || this.unanswered > 0 || this.queue.length > 0) return;
    this.worker = null;
    this.ready = false;
    this.ending = false;
    this.idle = true;
    worker.terminate();
  }

  postMessage(message: unknown): void {
    const worker = this.start();
    this.unanswered++;
    if (this.ready) worker.postMessage({ type: "request", request: message });
    else this.queue.push(message);
  }

  /** Stop the worker; pending requests are the transport's to reject. */
  disconnect(): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.queue = [];
    this.unanswered = 0;
    this.ending = false;
    worker?.terminate();
    if (worker) for (const listener of this.disconnectListeners) listener();
  }
}
