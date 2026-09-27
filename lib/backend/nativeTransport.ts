// One native port per background worker; all tabs share it. Never import this in a page.
// The native flavor's engine transport (lib/backend/transport.ts).
import { browser } from "#imports";
import { MAX_NATIVE_BYTES, NATIVE_HOST, isRecord, parseNativeReply, type NativeOperation, type NativePayload, type NativeReply } from "./nativeProtocol";
import { NativeTransportError, RECONNECT_MS, type EngineTransport } from "./transport";

/**
 * A host that dies with work in flight is started again and that work is asked of the new
 * one, once: the engine aborts the whole process on some GPU failures (MLX ends in libc++abi
 * when Metal discards a command buffer), and nothing it was asked has changed anything. After
 * CRASH_LIMIT such deaths within CRASH_WINDOW_MS, with no batch answered in between, the
 * engine is given up on: scoring is refused without starting it until retry().
 */
export const CRASH_LIMIT = 4;
export const CRASH_WINDOW_MS = 120_000;
/** The first restart waits this long, each later one twice as long as the one before. */
export const RESTART_BACKOFF_MS = 250;
/** A restarted host loads its model before it can score: it is asked how far it got this
 *  often, for at most this long, and what waits for it is sent once it has. */
const RESTART_POLL_MS = 250;
const RESTART_WAIT_MS = 60_000;
/** Reads: asking one twice changes nothing, so what died with its host is asked again. */
const REPLAYABLE = new Set<NativeOperation>(["score", "tokens", "health", "status", "runtime"]);
/** What is refused once the engine was given up on. Setup and Settings still reach it. */
const ENGINE_WORK = new Set<NativeOperation>(["score", "tokens", "health"]);

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {addListener(fn: (value: unknown) => void): void};
  onDisconnect: {addListener(fn: () => void): void};
  error?: {message?: string};
}
interface Pending {
  op: NativeOperation;
  message: {v: 1; id: string; op: NativeOperation; payload: NativePayload};
  /** The port it was posted on; null while it waits for a restarted host. */
  port: NativePort | null;
  /** Asked again after its first host died: it is not asked a third time. */
  replayed: boolean;
  /** The restart's own question, never the caller's. */
  internal: boolean;
  resolve(reply: NativeReply): void; reject(error: Error): void;
  /** Its timeout runs while a host has it, not while it waits for one. */
  arm(): void; disarm(): void; cleanup(): void;
}

export class NativeTransport implements EngineTransport {
  private port: NativePort | null = null;
  /** The current port has answered something: its host was running, not failing to start. */
  private answered = false;
  /** What the current host was given and has not answered, whether or not anybody still
   *  waits for it (a cancelled batch is still being worked on). */
  private working = new Set<string>();
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private retryAt = 0;
  private prefix = Math.random().toString(36).slice(2);
  private disconnectListeners = new Set<() => void>();
  /** When each recent death happened; a score answered forgets them. */
  private crashes: number[] = [];
  private gaveUp = false;
  /** Set while a dead host is replaced: requests wait for the new one instead of going out. */
  private restarting: {timer?: ReturnType<typeof setTimeout>; until: number} | null = null;
  constructor(private readonly connect: () => NativePort = () => browser.runtime.connectNative(NATIVE_HOST)) {}

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** An explicit Retry: an engine given up on may be started again. */
  retry(): void { this.gaveUp = false; this.crashes = []; this.retryAt = 0; }

  private connectPort(): NativePort {
    if (this.port) return this.port;
    if (Date.now() < this.retryAt) throw new NativeTransportError("native_unavailable", "Local component is not connected");
    let port: NativePort;
    try { port = this.connect(); }
    catch { this.retryAt = Date.now() + RECONNECT_MS; throw new NativeTransportError("native_unavailable", "Local component is not installed or cannot start"); }
    this.port = port;
    this.answered = false;
    this.working.clear();
    port.onMessage.addListener((value) => this.received(port, value));
    port.onDisconnect.addListener(() => {
      // Chrome lastError must be consumed in this callback to avoid an unchecked error.
      const message = browser.runtime.lastError?.message ?? port.error?.message;
      this.lost(port, message?.slice(0, 2000) ?? "Local component disconnected");
    });
    return port;
  }

  private received(port: NativePort, value: unknown): void {
    if (this.port !== port) return;
    const reply = parseNativeReply(value);
    if (!reply) { this.close("native_protocol", "Invalid local component response"); return; }
    this.answered = true;
    this.working.delete(reply.id);
    const request = this.pending.get(reply.id);
    if (!request) return; // a cancelled/timed-out request may still finish in the host
    this.pending.delete(reply.id);
    request.cleanup();
    request.resolve(reply);
    // The engine scores again: earlier deaths were not a run of them.
    if (request.op === "score" && reply.ok) this.crashes = [];
    // A host that could not start answers once and exits, and the next request after
    // RECONNECT_MS starts a fresh one. A host from an earlier release kept a busy
    // startup error for its lifetime instead: retire that port so a later Retry can
    // acquire the released lock. Ordinary scoring/control busy responses must not
    // interrupt our own host.
    const startupBusy = !reply.ok && reply.status === 409 && reply.error?.code === "busy" &&
      (request.op === "status" || request.op === "health");
    const updated = !reply.ok && reply.error?.code === "component_updated";
    if (startupBusy || updated) {
      this.retryAt = Date.now() + RECONNECT_MS;
      this.close(updated ? "component_updated" : "busy", updated ? "Local component updated; reconnecting" : "Another browser is using the local component");
    }
  }

  /** The port closed without our asking. A host that had been answering and died while it
   *  worked, or while work waited for it to load, crashed; any other close means it is not
   *  there (not installed, stopped, failing to start), which the next request after
   *  RECONNECT_MS finds out again. */
  private lost(port: NativePort, message: string): void {
    if (this.port !== port) return;
    this.port = null;
    const outstanding = this.working.size > 0 || [...this.pending.values()].some((request) => request.port === null);
    if (this.answered && outstanding) { this.crashed(port); return; }
    this.stopRestart();
    this.retryAt = Date.now() + RECONNECT_MS;
    this.rejectAll(new NativeTransportError("native_unavailable", message));
    this.notifyDisconnect();
  }

  private crashed(port: NativePort): void {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= CRASH_LIMIT) { this.giveUp(); return; }
    for (const [id, request] of this.pending) {
      if (request.port !== port) continue; // already waiting for the next host
      if (!request.internal && !request.replayed && REPLAYABLE.has(request.op)) {
        request.disarm(); request.replayed = true; request.port = null;
        continue;
      }
      this.pending.delete(id); request.cleanup();
      // Twice in flight when a host died: this is not asked of a third one.
      request.reject(request.replayed
        ? new NativeTransportError("engine_crashed", "The local engine stopped twice while working on this request")
        : new NativeTransportError("native_unavailable", "Local component stopped unexpectedly"));
    }
    this.stopRestart();
    const delay = RESTART_BACKOFF_MS * 2 ** (this.crashes.length - 1);
    this.restarting = {until: now + delay + RESTART_WAIT_MS, timer: setTimeout(() => this.reopen(), delay)};
  }

  private reopen(): void {
    const restart = this.restarting;
    if (!restart) return;
    restart.timer = undefined;
    let port: NativePort;
    try { port = this.connectPort(); }
    catch (error) {
      this.stopRestart();
      this.rejectAll(error instanceof Error ? error : new NativeTransportError("native_unavailable", "Local component cannot start"));
      this.notifyDisconnect();
      return;
    }
    void this.awaitModel(port, restart.until);
  }

  /** Hold what waits until the new host has loaded its model (or says it will not): sent
   *  at once, it would only be told the engine is not ready. */
  private async awaitModel(port: NativePort, until: number): Promise<void> {
    for (;;) {
      let state: unknown;
      try {
        const reply = await this.create("status", {}, undefined, 5_000, port, true);
        state = reply.ok && isRecord(reply.data) ? reply.data.state : undefined;
      } catch { return; } // the host went away again, and lost() has seen to it
      if (this.port !== port || !this.restarting) return;
      if ((state !== "starting" && state !== "loading") || Date.now() >= until) break;
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
      if (this.port !== port || !this.restarting) return;
    }
    this.restarting = null;
    for (const request of [...this.pending.values()]) if (request.port === null) this.post(port, request);
  }

  private giveUp(): void {
    this.gaveUp = true;
    this.stopRestart();
    this.retryAt = Date.now() + RECONNECT_MS;
    this.rejectAll(this.crashError());
    this.notifyDisconnect();
  }
  private crashError(): NativeTransportError {
    return new NativeTransportError("engine_crashed", `The local engine stopped unexpectedly ${CRASH_LIMIT} times in a row`);
  }
  private stopRestart(): void {
    if (this.restarting?.timer !== undefined) clearTimeout(this.restarting.timer);
    this.restarting = null;
  }

  request(op: NativeOperation, payload: NativePayload = {}, signal?: AbortSignal, timeout = 30_000): Promise<NativeReply> {
    if (this.gaveUp && ENGINE_WORK.has(op)) return Promise.reject(this.crashError());
    return this.create(op, payload, signal, timeout, null, false);
  }

  /** `port`: post there now whatever else is going on (the restart's own question);
   *  otherwise post on the current port, or wait for the restarted one. */
  private create(op: NativeOperation, payload: NativePayload, signal: AbortSignal | undefined, timeout: number,
    port: NativePort | null, internal: boolean): Promise<NativeReply> {
    if (signal?.aborted) return Promise.reject(new NativeTransportError("cancelled", "Request cancelled"));
    if (this.pending.size >= 64) return Promise.reject(new NativeTransportError("busy", "Too many pending requests"));
    const id = `${this.prefix}-${++this.sequence}`;
    const message = {v: 1 as const, id, op, payload};
    try {
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_NATIVE_BYTES)
        return Promise.reject(new NativeTransportError("request_too_large", "Request is too large"));
      const target = port ?? (this.restarting ? null : this.connectPort());
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => settle(new NativeTransportError("cancelled", "Request cancelled"));
        const disarm = () => clearTimeout(timer);
        const cleanup = () => { disarm(); signal?.removeEventListener("abort", abort); };
        const settle = (error: Error) => {
          if (!this.pending.delete(id)) return;
          cleanup(); reject(error);
        };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => settle(new NativeTransportError("native_timeout", "Local component did not answer in time")), timeout);
        };
        const request: Pending = {op, message, port: null, replayed: false, internal, resolve, reject, arm, disarm, cleanup};
        this.pending.set(id, request);
        signal?.addEventListener("abort", abort, {once: true});
        if (target) this.post(target, request);
      });
    } catch (error) { return Promise.reject(error); }
  }

  private post(port: NativePort, request: Pending): void {
    request.port = port;
    request.arm();
    this.working.add(request.message.id);
    try { port.postMessage(request.message); }
    catch { this.close("native_unavailable", "Local component disconnected"); }
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) { request.cleanup(); request.reject(error); }
    this.pending.clear();
  }
  private notifyDisconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }
  close(code = "native_unavailable", message = "Local connection restarted"): void {
    const port = this.port;
    this.port = null;
    this.stopRestart();
    this.rejectAll(new NativeTransportError(code, message));
    this.notifyDisconnect();
    try { port?.disconnect(); } catch { /* already disconnected */ }
  }
}

let instance: NativeTransport | undefined;
export function nativeTransport(): NativeTransport { return instance ??= new NativeTransport(); }
/** What "#flavor/engine-transport" names in the native flavor. */
export { nativeTransport as engineTransport };
