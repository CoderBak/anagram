import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { cancelDocumentSession, connectDocument, documentSessionId, sendDocumentMessage } from "../../lib/access/session";
import { requestScores } from "../../lib/messaging/client";
import { CONTRACT_VERSION, type ScoreBatchRequest } from "../../lib/contract";
import { deferred } from "./scoreStore";

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  cancelDocumentSession();
});
afterEach(() => {
  cancelDocumentSession();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function connections() {
  const ports: ReturnType<typeof makePort>[] = [];
  function makePort() {
    let receive: (message: unknown) => void = () => {};
    let disconnected = () => {};
    const port = {
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      onDisconnect: { addListener: (listener: typeof disconnected) => { disconnected = listener; } },
      postMessage: vi.fn(), disconnect: vi.fn(),
      acknowledge() { receive(port.postMessage.mock.calls[0][0]); },
      disconnected() { disconnected(); },
    };
    return port;
  }
  vi.spyOn(fakeBrowser.runtime, "connect").mockImplementation(() => {
    const port = makePort(); ports.push(port); return port as never;
  });
  return ports;
}
const req = (): ScoreBatchRequest => ({ v: CONTRACT_VERSION, session: "scan", priority: "viewport", blocks: [{ id: "1", text: "paragraph" }] });

describe("document connection lifetime", () => {
  it("keeps simultaneous replies paired with their own model snapshots", async () => {
    const ports = connections(), a = deferred<unknown>(), b = deferred<unknown>();
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = requestScores(req()), second = requestScores(req()); ports[0].acknowledge();
    const modelA = {id: "A", ver: "1", calibration: "a"}, modelB = {id: "B", ver: "2", calibration: "b"};
    const result = (score: number) => ({id: "1", bucket: score ? 3 : 0, score, probs: score ? [0, 0, 0, 1] : [1, 0, 0, 0]});
    // Both browser replies arrive before either caller resumes after requestScores.
    a.resolve({backend: "up", model: modelA, results: [result(0)]});
    b.resolve({backend: "up", model: modelB, results: [result(1)]});
    const [replyA, replyB] = await Promise.all([first, second]);
    expect(replyA).toMatchObject({model: modelA, results: [{score: 0}]});
    expect(replyB).toMatchObject({model: modelB, results: [{score: 1}]});
    modelA.ver = "mutated"; modelB.ver = "mutated";
    expect(replyA.model?.ver).toBe("1"); expect(replyB.model?.ver).toBe("2");
  });

  it("does not attach a previous model to a real verdict that omitted provenance", async () => {
    const ports = connections();
    vi.spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValueOnce({backend: "up", model: {id: "previous", ver: "1", calibration: "none"}, results: []})
      .mockResolvedValueOnce({backend: "up", results: [{id: "1", bucket: 3, score: 1, probs: [0, 0, 0, 1]}]});
    const previous = requestScores(req()); ports[0].acknowledge(); await previous;
    await expect(requestScores(req())).resolves.toEqual({results: [], backend: "unreachable"});
  });

  it("rejects a cancelled handshake and ignores its late disconnect after reconnecting", async () => {
    const ports = connections();
    const firstId = documentSessionId();
    const first = connectDocument();
    expect(connectDocument()).toBe(first);
    const rejected = expect(first).rejects.toThrow("cancelled");
    cancelDocumentSession();
    await rejected;
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    expect(documentSessionId()).not.toBe(firstId);
    const next = connectDocument();
    ports[1].acknowledge();
    await expect(next).resolves.toBe(documentSessionId());
    ports[0].disconnected(); ports[0].acknowledge();
    expect(connectDocument()).toBe(next);
    expect(ports).toHaveLength(2);
  });

  it("rejects an in-flight message immediately and never delivers its late reply", async () => {
    const ports = connections();
    let complete!: (value: unknown) => void;
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const first = sendDocumentMessage({ action: "first" });
    ports[0].acknowledge();
    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    const rejected = expect(first).rejects.toThrow("cancelled");
    cancelDocumentSession(); await rejected;
    send.mockResolvedValueOnce({ ok: "new" });
    const next = sendDocumentMessage({ action: "next" });
    ports[1].acknowledge(); ports[0].disconnected(); complete({ ok: "old" });
    await expect(next).resolves.toEqual({ ok: "new" });
    expect(send.mock.calls[0][0]).not.toEqual(send.mock.calls[1][0]);
    expect(ports).toHaveLength(2);
  });

  it("never retries old score text after cancellation during the handshake", async () => {
    const ports = connections();
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage");
    const pending = requestScores(req());
    cancelDocumentSession();
    await expect(pending).resolves.toEqual({ results: [], backend: "unreachable" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    expect(ports).toHaveLength(1);
  });

  it("does not resend old text if cancellation happens in the transport retry delay", async () => {
    const ports = connections();
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockRejectedValue(new Error("worker unavailable"));
    const pending = requestScores(req());
    ports[0].acknowledge();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    cancelDocumentSession();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toEqual({ results: [], backend: "unreachable" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("still retries a transient worker failure without explicit cancellation", async () => {
    const ports = connections();
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage")
      .mockRejectedValueOnce(new Error("worker unavailable"))
      .mockResolvedValueOnce({ results: [], backend: "up" });
    const pending = requestScores(req()); ports[0].acknowledge();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toEqual({ results: [], backend: "up" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stops at once when the worker found the request malformed", async () => {
    const ports = connections();
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue({ok: false, error: "invalid_request"});
    const pending = requestScores(req()); ports[0].acknowledge();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({results: [], backend: "refused"});
    expect(send).toHaveBeenCalledOnce();
  });

  it("asks once more when the page was not authorized, and a second refusal stands", async () => {
    const ports = connections();
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue({ok: false, error: "forbidden"});
    const pending = requestScores(req()); ports[0].acknowledge();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({results: [], backend: "refused"});
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("takes the second answer when the first refusal came from a worker that had just restarted", async () => {
    const ports = connections();
    vi.spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValueOnce({ok: false, error: "forbidden"})
      .mockResolvedValueOnce({results: [], backend: "up"});
    const pending = requestScores(req()); ports[0].acknowledge();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toEqual({results: [], backend: "up"});
  });

  it("reconnects with a fresh nonce after pagehide/BFCache restore", async () => {
    const ports = connections();
    const previous = connectDocument(); ports[0].acknowledge();
    const oldSession = await previous;
    window.dispatchEvent(new Event("pagehide"));
    expect(ports[0].disconnect).toHaveBeenCalledOnce();
    const restored = connectDocument(); ports[1].acknowledge();
    expect(await restored).not.toBe(oldSession);
    ports[0].disconnected();
    expect(connectDocument()).toBe(restored);
  });

  it("clears a timed-out handshake without letting its late acknowledgement revive it", async () => {
    const ports = connections();
    const first = connectDocument();
    const rejected = expect(first).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(2000); await rejected;
    const next = connectDocument(); ports[1].acknowledge(); ports[0].acknowledge();
    await expect(next).resolves.toBe(documentSessionId());
    expect(connectDocument()).toBe(next);
  });
});
