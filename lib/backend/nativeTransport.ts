// One native port per background worker; all tabs share it. Never import this in a page.
import { browser } from "#imports";
import { MAX_NATIVE_BYTES, NATIVE_HOST, parseNativeReply, type NativeOperation, type NativePayload, type NativeReply } from "./nativeProtocol";

/** A port that closed, or could not open, is not opened again before this. */
export const RECONNECT_MS = 1500;

export class NativeTransportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "NativeTransportError"; }
}

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {addListener(fn: (value: unknown) => void): void};
  onDisconnect: {addListener(fn: () => void): void};
  error?: {message?: string};
}
interface Pending {op: NativeOperation; resolve(reply: NativeReply): void; reject(error: Error): void; cleanup(): void}

export class NativeTransport {
  private port: NativePort | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private retryAt = 0;
  private prefix = Math.random().toString(36).slice(2);
  private disconnectListeners = new Set<() => void>();
  constructor(private readonly connect: () => NativePort = () => browser.runtime.connectNative(NATIVE_HOST)) {}

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private connectPort(): NativePort {
    if (this.port) return this.port;
    if (Date.now() < this.retryAt) throw new NativeTransportError("native_unavailable", "Local component is not connected");
    let port: NativePort;
    try { port = this.connect(); }
    catch { this.retryAt = Date.now() + RECONNECT_MS; throw new NativeTransportError("native_unavailable", "Local component is not installed or cannot start"); }
    this.port = port;
    port.onMessage.addListener((value) => {
      if (this.port !== port) return;
      const reply = parseNativeReply(value);
      if (!reply) { this.close("native_protocol", "Invalid local component response"); return; }
      const request = this.pending.get(reply.id);
      if (!request) return; // a cancelled/timed-out request may still finish in the host
      this.pending.delete(reply.id);
      request.cleanup();
      request.resolve(reply);
      // A host that could not acquire its home lock keeps a startup error for its
      // lifetime. Retire that port so a later Retry can acquire the released lock.
      // Ordinary scoring/control busy responses must not interrupt our own host.
      const startupBusy = !reply.ok && reply.status === 409 && reply.error?.code === "busy" &&
        (request.op === "status" || request.op === "health");
      const updated = !reply.ok && reply.error?.code === "component_updated";
      if (startupBusy || updated) {
        this.retryAt = Date.now() + RECONNECT_MS;
        this.close(updated ? "component_updated" : "busy", updated ? "Local component updated; reconnecting" : "Another browser is using the local component");
      }
    });
    port.onDisconnect.addListener(() => {
      // Chrome lastError must be consumed in this callback to avoid an unchecked error.
      const message = browser.runtime.lastError?.message ?? port.error?.message;
      if (this.port !== port) return;
      this.port = null;
      this.retryAt = Date.now() + RECONNECT_MS;
      this.rejectAll(new NativeTransportError("native_unavailable", message?.slice(0, 2000) ?? "Local component disconnected"));
      this.notifyDisconnect();
    });
    return port;
  }

  request(op: NativeOperation, payload: NativePayload = {}, signal?: AbortSignal, timeout = 30_000): Promise<NativeReply> {
    if (signal?.aborted) return Promise.reject(new NativeTransportError("cancelled", "Request cancelled"));
    if (this.pending.size >= 64) return Promise.reject(new NativeTransportError("busy", "Too many pending requests"));
    const id = `${this.prefix}-${++this.sequence}`;
    const message = {v: 1, id, op, payload};
    try {
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_NATIVE_BYTES)
        return Promise.reject(new NativeTransportError("request_too_large", "Request is too large"));
      const port = this.connectPort();
      return new Promise((resolve, reject) => {
        const abort = () => settle(new NativeTransportError("cancelled", "Request cancelled"));
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        const settle = (error: Error) => {
          if (!this.pending.delete(id)) return;
          cleanup(); reject(error);
        };
        const timer = setTimeout(() => settle(new NativeTransportError("native_timeout", "Local component did not answer in time")), timeout);
        this.pending.set(id, {op, resolve, reject, cleanup});
        signal?.addEventListener("abort", abort, {once: true});
        try { port.postMessage(message); }
        catch { this.close("native_unavailable", "Local component disconnected"); }
      });
    } catch (error) { return Promise.reject(error); }
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
    this.rejectAll(new NativeTransportError(code, message));
    this.notifyDisconnect();
    try { port?.disconnect(); } catch { /* already disconnected */ }
  }
}

let instance: NativeTransport | undefined;
export function nativeTransport(): NativeTransport { return instance ??= new NativeTransport(); }
