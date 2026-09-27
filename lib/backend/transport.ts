// What the background worker needs from whatever runs the model: the native host over
// Native Messaging (lib/backend/nativeTransport.ts) or the in-browser engine
// (lib/webengine/client.ts). Each flavor links exactly one, as `engineTransport()` from
// "#flavor/engine-transport" (scripts/flavor.mjs). Both answer the same contract
// operations with the same replies (lib/backend/nativeProtocol.ts, lib/backend/scoreProtocol.ts).
import type { NativeOperation, NativePayload, NativeReply } from "./nativeProtocol";

/** A transport that closed, or could not open, is not opened again before this. */
export const RECONNECT_MS = 1500;

/**
 * A request that got no reply. Either transport rejects with this, and its code decides
 * what happens next (lib/backend/retry.ts, nativeScoreClient.ts): `native_unavailable`
 * (the engine cannot be reached, or went away mid-request), `native_timeout`, `busy`
 * (too many requests pending), `cancelled`, `request_too_large`, `native_protocol` (an
 * invalid reply), `component_updated`, `engine_crashed` (the engine kept dying with work in
 * flight and is not started again until retry()). The name predates the in-browser engine
 * and is what retry.ts reads.
 */
export class NativeTransportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "NativeTransportError"; }
}

export interface EngineTransport {
  /** One contract operation. Resolves with the engine's reply, `ok` or not; rejects with a
   *  NativeTransportError when there is none. Opens the engine on first use. */
  request(op: NativeOperation, payload?: NativePayload, signal?: AbortSignal, timeout?: number): Promise<NativeReply>;
  /** Called when the engine connection closes: every pending request has been rejected,
   *  and health must be read again. Returns the unsubscribe. */
  onDisconnect(listener: () => void): () => void;
  /** Rejects everything pending with `code`, closes the connection and tells the
   *  disconnect listeners; the next request opens it again. */
  close(code?: string, message?: string): void;
  /** The user asked to try again: an engine given up on after it kept dying may be started
   *  once more. Only a transport that gives up has it. */
  retry?(): void;
}
