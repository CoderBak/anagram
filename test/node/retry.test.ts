import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeScoreError } from "../../lib/backend/nativeScoreClient";
import { NativeTransportError } from "../../lib/backend/nativeTransport";
import { ProtocolError } from "../../lib/backend/scoreProtocol";
import { RETRY_BACKOFF_MS, isTransientFailure, retryWaitMs } from "../../lib/backend/retry";
import { RECONNECT_MS } from "../../lib/backend/nativeTransport";

afterEach(() => vi.restoreAllMocks());

describe("native retry policy", () => {
  it("retries loading/queue failures and recoverable port errors", () => {
    for (const status of [429,502,503,504]) expect(isTransientFailure(new NativeScoreError(status,"busy","Wait"))).toBe(true);
    expect(isTransientFailure(new NativeScoreError(409,"busy","Wait"))).toBe(true);
    for (const code of ["native_unavailable","native_timeout","busy"]) expect(isTransientFailure(new NativeTransportError(code,"Wait"))).toBe(true);
  });
  it("does not retry invalid requests, protocol failures, cancellations or programming errors", () => {
    for (const status of [400,401,403,404,413,422,500,501]) expect(isTransientFailure(new NativeScoreError(status,"invalid_request","No"))).toBe(false);
    for (const error of [new NativeScoreError(409,"conflict","No"),new NativeTransportError("cancelled","Stop"),new NativeTransportError("native_protocol","Invalid"),new ProtocolError("Invalid"),new TypeError("Bug"),new Error("Bug"),null,"nope"]) {
      expect(isTransientFailure(error)).toBe(false); expect(retryWaitMs(error)).toBeNull();
    }
  });
  it("spreads retries over 1–2 times the base delay", () => {
    const error = new NativeScoreError(503,"not_ready","Loading");
    vi.spyOn(Math,"random").mockReturnValue(0); expect(retryWaitMs(error)).toBe(RETRY_BACKOFF_MS);
    vi.spyOn(Math,"random").mockReturnValue(0.999); expect(retryWaitMs(error)).toBe(2*RETRY_BACKOFF_MS);
  });
  it("waits for a closed port to open again, and for a health check refused meanwhile", () => {
    vi.spyOn(Math,"random").mockReturnValue(0);
    expect(retryWaitMs(new NativeTransportError("native_unavailable","Disconnected"))).toBe(2*RECONNECT_MS + RETRY_BACKOFF_MS);
    expect(retryWaitMs(new NativeTransportError("busy","Queue full"))).toBe(RETRY_BACKOFF_MS);
  });
});
