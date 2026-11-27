import { afterEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ensureOffscreenDocument, offscreenPort, webEngineRunning } from "../../lib/webengine/client";

afterEach(() => { vi.unstubAllGlobals(); fakeBrowser.reset(); });

it("shares an in-progress creation and rediscovers the engine on Chrome versions with getContexts", async () => {
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({ manifest_version: 3, name: "Anagram", version: "1.0" });
  const createDocument = vi.fn(async () => {});
  vi.stubGlobal("chrome", { offscreen: { createDocument } });
  const contexts = vi.spyOn(fakeBrowser.runtime, "getContexts").mockImplementation(async () => []);
  await Promise.all([ensureOffscreenDocument(), ensureOffscreenDocument()]);
  expect(contexts).toHaveBeenCalledWith({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  expect(createDocument).toHaveBeenCalledTimes(1);

  contexts.mockImplementation(async () => [{ contextType: "OFFSCREEN_DOCUMENT" }]);
  expect(await webEngineRunning()).toBe(true);
  await ensureOffscreenDocument();
  expect(createDocument).toHaveBeenCalledTimes(1);
});

it("disconnects pending engine requests when the runtime port cannot connect", async () => {
  vi.stubGlobal("chrome", { offscreen: {} });
  vi.spyOn(fakeBrowser.runtime, "getContexts").mockImplementation(async () => [{ contextType: "OFFSCREEN_DOCUMENT" }]);
  vi.spyOn(fakeBrowser.runtime, "connect").mockImplementation(() => { throw new Error("document closed"); });
  const port = offscreenPort();
  const disconnected = Promise.withResolvers<void>();
  port.onDisconnect.addListener(disconnected.resolve);
  port.postMessage({ id: "queued" });
  await disconnected.promise;
  expect(port.error?.message).toContain("document closed");
  expect(() => port.postMessage({ id: "another" })).toThrow("engine port closed");
});
