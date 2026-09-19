// test/node/retry.test.ts — the policy that decides whether a failed batch is sent again.
import { describe, expect, it, vi, afterEach } from "vitest";
import { DaemonHttpError, ProtocolError } from "../../lib/backend/httpClient";
import {
  MAX_RETRY_AFTER_MS,
  RETRY_BACKOFF_MS,
  isTransientFailure,
  parseRetryAfter,
  retryWaitMs,
} from "../../lib/backend/retry";

afterEach(() => vi.restoreAllMocks());

describe("which failures are worth a second attempt", () => {
  it("says yes to a busy daemon, a dead transport and our own timeout", () => {
    for (const status of [429, 502, 503, 504]) {
      expect(isTransientFailure(new DaemonHttpError(status, null)), String(status)).toBe(true);
    }
    expect(isTransientFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientFailure(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("says no to anything that would answer the same way again", () => {
    for (const status of [400, 401, 403, 404, 413, 422, 500, 501]) {
      expect(isTransientFailure(new DaemonHttpError(status, null)), String(status)).toBe(false);
    }
    expect(isTransientFailure(new ProtocolError("probabilities must sum to 1"))).toBe(false);
    expect(isTransientFailure(new Error("anagramd unavailable"))).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
    expect(isTransientFailure("nope")).toBe(false);
  });
});

describe("how long to wait first", () => {
  it("jitters the backoff over 1–2×, so a restart does not bring every tab back at once", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(retryWaitMs(new DaemonHttpError(503, null))).toBe(RETRY_BACKOFF_MS);
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(retryWaitMs(new DaemonHttpError(503, null))).toBe(2 * RETRY_BACKOFF_MS);
  });

  it("honours a Retry-After longer than the backoff, and refuses to wait out a long one", () => {
    expect(retryWaitMs(new DaemonHttpError(429, 400))).toBe(400);
    // Shorter than our own backoff: the backoff still applies.
    expect(retryWaitMs(new DaemonHttpError(429, 10))).toBeGreaterThanOrEqual(RETRY_BACKOFF_MS);
    // "Come back much later" means answer Unavailable now, not sit on a request slot.
    expect(retryWaitMs(new DaemonHttpError(503, MAX_RETRY_AFTER_MS + 1))).toBeNull();
  });

  it("never waits for a failure that is not transient", () => {
    expect(retryWaitMs(new ProtocolError("contract 3.0 ≠ 2.1"))).toBeNull();
    expect(retryWaitMs(new DaemonHttpError(400, 100))).toBeNull();
  });
});

describe("Retry-After", () => {
  it("reads delta-seconds and an HTTP date, and nothing else", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(" 0 ")).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfter(inTwoSeconds) ?? -1;
    expect(ms).toBeGreaterThan(500);
    expect(ms).toBeLessThanOrEqual(2000);
    // A date already past is "now", never a negative wait.
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });
});
