// test/node/portTransportTurns.test.ts — a request's timeout runs while the engine works on it,
// not while it waits its turn (lib/backend/portTransport.ts LANES). Both engines score one
// request at a time in the order it came; four batches of ten seconds each, posted at once,
// used to fail the fourth at 30 s although the engine was sound.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortTransport, type NativePort } from "../../lib/backend/portTransport";

/** An engine that works through its score requests one at a time, `workMs` each (a request
 *  whose id is in `hang` is never answered), and answers a token count at once. */
function serialEngine(workMs: number, hang: ReadonlySet<number> = new Set()) {
  let receive: (value: unknown) => void = () => {};
  const queue: string[] = [];
  let busy = false;
  let n = 0;
  const reply = (id: string) => receive({ v: 1, id, ok: true, status: 200, data: { v: "3.0", model: { id: "m", ver: "1", calibration: "c" }, results: [] } });
  const next = (): void => {
    if (busy || queue.length === 0) return;
    const id = queue.shift()!;
    const index = n++;
    busy = true;
    if (hang.has(index)) return; // the engine never comes back from this one
    setTimeout(() => { busy = false; reply(id); next(); }, workMs);
  };
  const port: NativePort = {
    postMessage(message) {
      const { id, op } = message as { id: string; op: string };
      if (op === "tokens") { reply(id); return; }
      queue.push(id);
      next();
    },
    disconnect() { /* nothing */ },
    onMessage: { addListener: (fn) => { receive = fn; } },
    onDisconnect: { addListener: () => { /* the port stays up */ } },
  };
  return port;
}

const score = (transport: PortTransport, signal?: AbortSignal) => {
  let outcome: string | undefined;
  void transport.request("score", { v: "3.0", blocks: [{ id: "p", text: "x" }] }, signal)
    .then(() => { outcome = "answered"; }, (e: { code?: string }) => { outcome = e.code; });
  return () => outcome;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a request's timeout starts at its turn", () => {
  it("answers four ten-second batches posted at once, the last at 40 s", async () => {
    const transport = new PortTransport(() => serialEngine(10_000), { cannotStart: "x" });
    const outcomes = [0, 1, 2, 3].map(() => score(transport));
    await vi.advanceTimersByTimeAsync(39_000);
    expect(outcomes.map((o) => o())).toEqual(["answered", "answered", "answered", undefined]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcomes.map((o) => o())).toEqual(["answered", "answered", "answered", "answered"]);
    transport.close();
  });

  it("still times out a request the engine works on for longer than its timeout", async () => {
    const transport = new PortTransport(() => serialEngine(40_000), { cannotStart: "x" });
    const first = score(transport), second = score(transport);
    await vi.advanceTimersByTimeAsync(30_500);
    expect(first()).toBe("native_timeout");
    // The second's turn began when the first ran out of time, though the engine is still at it.
    expect(second()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second()).toBe("native_timeout");
    transport.close();
  });

  it("does not leave the requests behind a hung one waiting for ever, cancelled or not", async () => {
    const transport = new PortTransport(() => serialEngine(1_000, new Set([0])), { cannotStart: "x" });
    const controller = new AbortController();
    const first = score(transport, controller.signal), second = score(transport);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(first()).toBe("cancelled");
    // The engine still has the cancelled one: the second waits its turn, and gets it when the
    // cancelled one has had its time.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(second()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(41_000);
    expect(second()).toBe("native_timeout");
    transport.close();
  });

  it("never makes a token count wait for a score batch's turn", async () => {
    const transport = new PortTransport(() => serialEngine(20_000), { cannotStart: "x" });
    score(transport); score(transport);
    let counted = false;
    void transport.request("tokens", { texts: ["x"] }).then(() => { counted = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(counted).toBe(true);
    transport.close();
  });
});
