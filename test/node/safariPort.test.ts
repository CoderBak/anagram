import { beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
const send = vi.fn();
import { safariPort } from "../../lib/backend/safariPort";

beforeEach(() => {
  fakeBrowser.reset();
  send.mockReset();
  Object.assign(fakeBrowser.runtime, { sendNativeMessage: send });
});

it("forwards native replies without changing the protocol envelope", async () => {
  const reply = { v: 1, id: "a", ok: true, status: 200, data: {} };
  send.mockResolvedValue(reply);
  const port = safariPort();
  const receive = vi.fn();
  port.onMessage.addListener(receive);
  const request = { v: 1, id: "a", op: "status", payload: {} };
  port.postMessage(request);
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(reply));
  expect(send).toHaveBeenCalledWith("dev.coderbak.Anagram", request);
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
  send.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const port = safariPort();
  const receive = vi.fn();
  port.onMessage.addListener(receive);
  port.postMessage({ id: "a" });
  port.disconnect();
  resolve({ id: "a" });
  await Promise.resolve();
  expect(receive).not.toHaveBeenCalled();
});
