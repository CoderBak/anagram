// lib/backend/retry.ts — which failures are worth asking the daemon about again.
//
// Asking twice only helps when the second attempt can answer differently: the daemon was
// still loading its weights, a request was refused for being one too many, a reverse proxy
// in front of it was restarting. A 400, a body that does not match the contract, a
// response whose probabilities do not sum to one — those come back identical however often
// they are sent, and retrying them doubles the load on a machine that is already saying no
// and doubles how long the reader waits for the "Unavailable" they were always going to
// get. So the list below is short and POSITIVE: a failure is retried only if it is named
// here, and anything new or unrecognised is left alone.
//
// The jitter matters more than it looks. A daemon restart fails every batch in every tab
// at the same moment; a fixed backoff brings all of them back in one burst, which is the
// one thing a machine that has just come up cannot take.

/** Statuses that mean "busy, or not ready yet" — and only those. 500 is deliberately NOT
 *  here: a model that threw on this text will throw on it again. Nor is 413 or 422, which
 *  say the request itself is the problem. */
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

/** The base wait before a retry, jittered to 1–2× below. */
export const RETRY_BACKOFF_MS = 150;

/** The longest `Retry-After` worth honouring. Past this the batch is better answered
 *  "Unavailable" straight away: the content script re-asks on its own schedule, and a
 *  waiting retry holds one of the router's four request slots for the whole wait. */
export const MAX_RETRY_AFTER_MS = 5_000;

/** `Retry-After` as milliseconds: delta-seconds ("120") or an HTTP date. Null when the
 *  header is absent or is neither. Never negative — a date already past means "now". */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Could asking again help? Three shapes say yes:
 *   - an HTTP status from the list above (the daemon carries it on the error it throws);
 *   - a TypeError, which in a service worker is what a fetch that never connected throws
 *     ("Failed to fetch", "NetworkError when attempting to fetch resource");
 *   - an abort, which here is our own 25 s cut-off rather than anyone cancelling.
 * Everything else — a ProtocolError, a 4xx, a bug — is a definite answer.
 */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const e = error as { status?: unknown; name?: unknown; code?: unknown } | null;
  if (!e) return false;
  if (typeof e.status === "number" && TRANSIENT_STATUS.has(e.status)) return true;
  if (e.name === "NativeScoreError" && e.status === 409 && e.code === "busy") return true;
  if (e.name === "NativeTransportError" && ["native_unavailable", "native_timeout", "busy"].includes(String(e.code))) return true;
  return e.name === "AbortError" || e.name === "TimeoutError";
}

/** What the daemon itself asked for, when it asked (see `DaemonHttpError`). */
function retryAfterOf(error: unknown): number | null {
  const asked = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof asked === "number" ? asked : null;
}

/**
 * How long to wait before trying this batch once more — or null for "do not". The wait is
 * the base backoff with 1–2× of jitter on it, or whatever the daemon asked for when that is
 * longer; a daemon asking for more than `MAX_RETRY_AFTER_MS` is telling us not to wait for
 * it at all, which is a null rather than a long sleep.
 */
export function retryWaitMs(error: unknown, backoffMs = RETRY_BACKOFF_MS): number | null {
  if (!isTransientFailure(error)) return null;
  const jittered = Math.round(backoffMs * (1 + Math.random()));
  const asked = retryAfterOf(error);
  if (asked === null) return jittered;
  if (asked > MAX_RETRY_AFTER_MS) return null;
  return Math.max(asked, jittered);
}
