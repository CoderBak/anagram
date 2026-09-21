// Retry only native failures that can recover: a busy/loading engine or a broken port.
// Protocol errors, invalid requests and programming errors are final for this batch.
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

/** Jitter spreads retries from simultaneous tab failures; null means do not retry. */
export function retryWaitMs(error: unknown, backoffMs = RETRY_BACKOFF_MS): number | null {
  return isTransientFailure(error) ? Math.round(backoffMs * (1 + Math.random())) : null;
}
