// lib/backend/portTransport.ts — contract requests multiplexed over one message port, with
// the recovery both engines need when the port dies with work in flight.
//
// What both engine transports share (lib/backend/transport.ts): requests go out on one
// port with an id each and replies come back by id, in any order; a request is bounded
// by a timeout and an abort signal; a port that closes rejects everything pending and is
// not opened again before RECONNECT_MS; the pending set is bounded. The local engine's
// transport opens a Native Messaging port to the host (lib/backend/nativeTransport.ts), the
// in-browser engine's a port to its offscreen document or a worker (lib/webengine/client.ts).
//
// An engine that dies with work in flight is started again and that work is asked of the
// new one, once: the native engine aborts the whole process on some GPU failures (MLX ends
// in libc++abi when Metal discards a command buffer), the in-browser one loses its worker
// to a WebGPU device loss or its offscreen document to the browser, and nothing it was
// asked has changed anything. After CRASH_LIMIT such deaths within CRASH_WINDOW_MS, with
// no batch answered in between, the engine is given up on: scoring is refused without
// starting it until retry().
//
// A request's timeout runs while the engine works on it, not while it waits its turn. Both
// engines score one request at a time in the order they came (anagramd/native_host.py's score
// lane, lib/webengine/engine.ts's scoreChain), and the router keeps several batches with the
// engine (lib/backend/router.ts MAX_IN_FLIGHT): timed from posting, the fourth of four batches
// on a processor that takes ten seconds a batch failed as Unavailable although the engine was
// sound. So each lane (LANES) keeps the order it posted in, and a request's timer starts when
// the one before it has been answered — or has run out of time itself. A cancelled request the
// engine is still working through keeps its place, with a timer of its own: if the engine
// never answers it, the request after it is not left waiting for ever.
import { MAX_NATIVE_BYTES, isRecord, parseNativeReply, type NativeOperation, type NativePayload, type NativeReply } from "./nativeProtocol";
import { NativeTransportError, RECONNECT_MS, type EngineTransport } from "./transport";

export const CRASH_LIMIT = 4;
export const CRASH_WINDOW_MS = 120_000;
/** The first restart waits this long, each later one twice as long as the one before. */
export const RESTART_BACKOFF_MS = 250;
/** A restarted engine loads its model before it can score: it is asked how far it got this
 *  often, for at most this long, and what waits for it is sent once it has. */
const RESTART_POLL_MS = 250;
const RESTART_WAIT_MS = 60_000;
/** Reads: asking one twice changes nothing, so what died with its engine is asked again. */
const REPLAYABLE = new Set<NativeOperation>(["score", "tokens", "health", "status", "runtime"]);
/** What is refused once the engine was given up on. Setup and Settings still reach it. */
const ENGINE_WORK = new Set<NativeOperation>(["score", "tokens", "health"]);
/** What an engine works through one at a time, in the order it came, each op a lane of its
 *  own (counting tokens never waits behind a score batch). */
const LANES = new Set<NativeOperation>(["score", "tokens"]);

/** A place in a lane: a request the engine has, answered or not. `timer` runs only for a
 *  cancelled request whose turn it is, which nobody waits for but the requests behind it. */
interface Turn { id: string; timeout: number; timer?: ReturnType<typeof setTimeout> }

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
  /** The port it was posted on; null while it waits for a restarted engine. */
  port: NativePort | null;
  /** Asked again after its first engine died: it is not asked a third time. */
  replayed: boolean;
  /** The restart's own question, never the caller's. */
  internal: boolean;
  resolve(reply: NativeReply): void; reject(error: Error): void;
  /** Its timeout runs while an engine works on it: not while it waits for one, nor while it
   *  waits its turn in its lane. */
  arm(): void; disarm(): void; cleanup(): void;
  timeout: number;
}

export interface PortMessages {
  /** What a failed `connect()` means to the user. */
  cannotStart: string;
  /**
   * The in-browser engine loads its model on the processor in minutes, not seconds: a score
   * or token count that reaches its timeout while the engine says it is loading (`status`
   * answers `loading`) waits on, another timeout at a time, until this many ms have passed
   * since it was asked, and only then fails. Without it (the local engine) a request that
   * reaches its timeout fails, as ever.
   */
  loadWaitMs?: number;
}

export class PortTransport implements EngineTransport {
  private port: NativePort | null = null;
  /** The current port has answered something: its engine was running, not failing to start. */
  private answered = false;
  /** What the current engine was given and has not answered, whether or not anybody still
   *  waits for it (a cancelled batch is still being worked on). */
  private working = new Set<string>();
  /** Each lane's requests on the current port, in the order they were posted. */
  private lanes = new Map<NativeOperation, Turn[]>();
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private retryAt = 0;
  private connectionError: string | undefined;
  private prefix = Math.random().toString(36).slice(2);
  private disconnectListeners = new Set<() => void>();
  /** When each recent death happened; a score answered forgets them. */
  private crashes: number[] = [];
  private gaveUp = false;
  /** Set while a dead engine is replaced: requests wait for the new one instead of going out. */
  private restarting: {timer?: ReturnType<typeof setTimeout>; until: number} | null = null;
  constructor(private readonly connect: () => NativePort, private readonly messages: PortMessages) {}

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** An explicit Retry: an engine given up on may be started again. */
  retry(): void { this.gaveUp = false; this.crashes = []; this.retryAt = 0; }

  /** The browser's reason for a disconnect, read where the browser requires it to be. */
  protected lastError(): string | undefined { return undefined; }

  private connectPort(): NativePort {
    if (this.port) return this.port;
    if (Date.now() < this.retryAt) throw new NativeTransportError("native_unavailable", this.connectionError ?? this.messages.cannotStart);
    let port: NativePort;
    try { port = this.connect(); }
    catch { this.connectionError = this.messages.cannotStart; this.retryAt = Date.now() + RECONNECT_MS; throw new NativeTransportError("native_unavailable", this.messages.cannotStart); }
    this.port = port;
    this.answered = false;
    this.working.clear();
    this.clearLanes();
    port.onMessage.addListener((value) => this.received(port, value));
    port.onDisconnect.addListener(() => {
      // Chrome lastError must be consumed in this callback to avoid an unchecked error.
      const message = this.lastError() ?? port.error?.message;
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
    this.passTurn(reply.id);
    const request = this.pending.get(reply.id);
    if (!request) return; // a cancelled/timed-out request may still finish in the engine
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

  /** The port closed without our asking. An engine that had been answering and died while
   *  it worked, or while work waited for it to load, crashed; any other close means it is
   *  not there (not installed, stopped, failing to start), which the next request after
   *  RECONNECT_MS finds out again. */
  private lost(port: NativePort, message: string): void {
    if (this.port !== port) return;
    this.port = null;
    this.clearLanes();
    const outstanding = this.working.size > 0 || [...this.pending.values()].some((request) => request.port === null);
    if (this.answered && outstanding) { this.crashed(port); return; }
    this.stopRestart();
    this.connectionError = message;
    this.retryAt = Date.now() + RECONNECT_MS;
    this.rejectAll(new NativeTransportError("native_unavailable", message));
    this.notifyDisconnect();
  }

  private crashed(port: NativePort): void {
    const now = Date.now();
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (this.crashes.length >= CRASH_LIMIT) { this.giveUp(); return; }
    for (const [id, request] of this.pending) {
      if (request.port !== port) continue; // already waiting for the next engine
      if (!request.internal && !request.replayed && REPLAYABLE.has(request.op)) {
        request.disarm(); request.replayed = true; request.port = null;
        continue;
      }
      this.pending.delete(id); request.cleanup();
      // Twice in flight when an engine died: this is not asked of a third one.
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
      this.rejectAll(error instanceof Error ? error : new NativeTransportError("native_unavailable", this.messages.cannotStart));
      this.notifyDisconnect();
      return;
    }
    void this.awaitModel(port, restart.until);
  }

  /** Hold what waits until the new engine has loaded its model (or says it will not): sent
   *  at once, it would only be told the engine is not ready. */
  private async awaitModel(port: NativePort, until: number): Promise<void> {
    for (;;) {
      let state: unknown = "loading";
      try {
        const reply = await this.create("status", {}, undefined, 5_000, port, true);
        state = reply.ok && isRecord(reply.data) ? reply.data.state : undefined;
      } catch { /* unanswered: asked again below, unless the engine is gone (lost() saw to it) */ }
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
    // The restart's own question is never refused: what waits depends on it.
    if (this.pending.size >= 64 && !internal) return Promise.reject(new NativeTransportError("busy", "Too many pending requests"));
    const id = `${this.prefix}-${++this.sequence}`;
    const message = {v: 1 as const, id, op, payload};
    try {
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_NATIVE_BYTES)
        return Promise.reject(new NativeTransportError("request_too_large", "Request is too large"));
      const target = port ?? (this.restarting ? null : this.connectPort());
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => { settle(new NativeTransportError("cancelled", "Request cancelled")); this.keepTurn(id); };
        const disarm = () => clearTimeout(timer);
        const cleanup = () => { disarm(); signal?.removeEventListener("abort", abort); };
        const settle = (error: Error) => {
          if (!this.pending.delete(id)) return;
          cleanup(); reject(error);
        };
        const began = Date.now();
        /** Out of time: the engine may still be at it, but the next in its lane starts its own. */
        const expire = () => { settle(new NativeTransportError("native_timeout", "Local component did not answer in time")); this.passTurn(id); };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const wait = this.messages.loadWaitMs;
            const on = request.port;
            if (wait && on && !request.internal && (op === "score" || op === "tokens") && Date.now() - began < wait) {
              // Out of time, but the model may be on its way in: ask, and keep waiting while it is.
              void this.isLoading(on).then((loading) => {
                if (!this.pending.has(id) || request.port !== on) return;
                if (loading && Date.now() - began < wait) arm();
                else expire();
              });
              return;
            }
            expire();
          }, timeout);
        };
        const request: Pending = {op, message, port: null, replayed: false, internal, resolve, reject, arm, disarm, cleanup, timeout};
        this.pending.set(id, request);
        signal?.addEventListener("abort", abort, {once: true});
        if (target) this.post(target, request);
      });
    } catch (error) { return Promise.reject(error); }
  }

  /** Whether the engine behind `port` says its model is loading. */
  private async isLoading(port: NativePort): Promise<boolean> {
    try {
      const reply = await this.create("status", {}, undefined, 5_000, port, true);
      const state = reply.ok && isRecord(reply.data) ? reply.data.state : undefined;
      return state === "loading" || state === "starting";
    } catch { return false; }
  }

  private post(port: NativePort, request: Pending): void {
    request.port = port;
    this.working.add(request.message.id);
    const lane = LANES.has(request.op) ? this.lanes.get(request.op) ?? [] : null;
    if (lane) {
      this.lanes.set(request.op, lane);
      lane.push({id: request.message.id, timeout: request.timeout});
    }
    // In a lane, its time starts at its turn (startTurn).
    if (!lane || lane.length === 1) request.arm();
    try { port.postMessage(request.message); }
    catch { this.close("native_unavailable", "Local component disconnected"); }
  }

  /** `id` is done with its lane — answered, or out of time — and the next in it starts. */
  private passTurn(id: string): void {
    for (const lane of this.lanes.values()) {
      const at = lane.findIndex((turn) => turn.id === id);
      if (at < 0) continue;
      clearTimeout(lane[at]!.timer);
      lane.splice(at, 1);
      if (at === 0) this.startTurn(lane);
      return;
    }
  }

  /** The head of `lane` is what the engine works on now: its timeout starts. A request
   *  cancelled meanwhile is still worked on, and keeps the lane's time for it. */
  private startTurn(lane: Turn[]): void {
    const head = lane[0];
    if (!head) return;
    const request = this.pending.get(head.id);
    if (request && request.port !== null) request.arm();
    else head.timer = setTimeout(() => this.passTurn(head.id), head.timeout);
  }

  /** A cancelled request leaves `pending` but not its lane: the engine has it. If it was the
   *  one being worked on, the lane times it from here. */
  private keepTurn(id: string): void {
    for (const lane of this.lanes.values()) {
      if (lane[0]?.id === id && lane[0].timer === undefined) lane[0].timer = setTimeout(() => this.passTurn(id), lane[0].timeout);
    }
  }

  private clearLanes(): void {
    for (const lane of this.lanes.values()) for (const turn of lane) clearTimeout(turn.timer);
    this.lanes.clear();
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
    this.clearLanes();
    this.stopRestart();
    this.rejectAll(new NativeTransportError(code, message));
    this.notifyDisconnect();
    try { port?.disconnect(); } catch { /* already disconnected */ }
  }
}
