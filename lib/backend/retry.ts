// Retry only native failures that can recover: a busy/loading engine or a broken port.
// Protocol errors, invalid requests and programming errors are final for this batch.
import { RECONNECT_MS } from "./nativeTransport";

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
export const RETRY_BACKOFF_MS = 150;

export function isTransientFailure(error: unknown): boolean {
  const e = error as { name?: unknown; status?: unknown; code?: unknown } | null;
  if (!e) return false;
  if (e.name === "NativeScoreError") {
    return typeof e.status === "number" && (TRANSIENT_STATUS.has(e.status) || (e.status === 409 && e.code === "busy"));
  }
  return e.name === "NativeTransportError" && ["native_unavailable", "native_timeout", "busy"].includes(String(e.code));
}

/** Jitter spreads retries from simultaneous tab failures; null means do not retry. A port
 *  that closed opens again only after RECONNECT_MS, and a health check refused meanwhile is
 *  not repeated for as long again, so a retry after a closed port waits out both. */
export function retryWaitMs(error: unknown, backoffMs = RETRY_BACKOFF_MS): number | null {
  if (!isTransientFailure(error)) return null;
  const e = error as { name?: unknown; code?: unknown };
  const closed = e.name === "NativeTransportError" && e.code === "native_unavailable";
  return Math.round((closed ? 2 * RECONNECT_MS : 0) + backoffMs * (1 + Math.random()));
}
