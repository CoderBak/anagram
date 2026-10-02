import { beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
const send = vi.fn();
import { safariPort } from "../../lib/backend/safariPort";

beforeEach(() => {
  fakeBrowser.reset();
  send.mockReset();
  send.mockImplementation((_app, value) => Promise.resolve(value.anagram === "connect" ? { connected: true } : {}));
  Object.assign(fakeBrowser.runtime, { sendNativeMessage: send });
});

it("forwards native replies without changing the protocol envelope", async () => {
  const reply = { v: 1, id: "a", ok: true, status: 200, data: {} };
  send.mockImplementation((_app, value) => Promise.resolve(value.anagram === "connect" ? { connected: true } : reply));
  const port = safariPort();
  const receive = vi.fn();
  port.onMessage.addListener(receive);
  const request = { v: 1, id: "a", op: "status", payload: {} };
  port.postMessage(request);
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(reply));
  const client = send.mock.calls[0]![1].client;
  expect(send).toHaveBeenCalledWith("dev.coderbak.Anagram", { anagram: "request", client, message: request });
});

it("disconnects once on native failure and suppresses replies after closure", async () => {
  send.mockRejectedValue(new Error("XPC unavailable"));
  const port = safariPort();
  const disconnected = vi.fn();
  port.onDisconnect.addListener(disconnected);
  port.postMessage({ id: "a" });
  port.postMessage({ id: "b" });
  await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
  expect(port.error?.message).toBe("XPC unavailable");
  expect(() => port.postMessage({})).toThrow("closed");
});

it("ignores an in-flight reply after explicit disconnect", async () => {
  let resolve!: (value: object) => void;
  send.mockImplementation((_app, value) => value.anagram === "request"
    ? new Promise((done) => { resolve = done; }) : Promise.resolve({ connected: true }));
  const port = safariPort();
  const receive = vi.fn();
  port.onMessage.addListener(receive);
  port.postMessage({ id: "a" });
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  port.disconnect();
  resolve({ id: "a" });
  await Promise.resolve();
  expect(receive).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith("dev.coderbak.Anagram", { anagram: "disconnect", client: send.mock.calls[0]![1].client });
});

it("releases a connection that finishes opening after an engine switch", async () => {
  let finish!: (value: object) => void;
  send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const port = safariPort();
  port.postMessage({ id: "a" });
  port.disconnect();
  finish({ connected: true });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]![1]).toEqual({ anagram: "disconnect", client: send.mock.calls[0]![1].client });
});
