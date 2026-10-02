import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { sendTabControl } from "../../lib/messaging/tabControl";
import { ACTIONS } from "../../lib/messaging/protocol";

beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

describe("toolbar controls", () => {
  const request = { action: ACTIONS.GET_TAB_STATE, reportOffset: 50 } as const;
  it("asks an ordinary tab directly, including one-shot pages", async () => {
    const send = vi.spyOn(fakeBrowser.tabs, "sendMessage").mockResolvedValue(undefined);
    await sendTabControl({ id: 7, url: "https://example.test/article" }, request);
    expect(send).toHaveBeenCalledWith(7, request);
  });
  it("addresses one PDF reader by tab ID without sending to its content scripts", async () => {
    vi.spyOn(fakeBrowser.runtime, "getURL").mockImplementation((path) => `chrome-extension://anagram${path}`);
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined);
    const tabSend = vi.spyOn(fakeBrowser.tabs, "sendMessage");
    await sendTabControl({ id: 12, url: "chrome-extension://anagram/reader.html?source=fixture#page=2" }, request);
    expect(send).toHaveBeenCalledWith({ ...request, readerTabId: 12 });
    expect(tabSend).not.toHaveBeenCalled();
  });
  it("does not broadcast when there is no active tab", async () => {
    const send = vi.spyOn(fakeBrowser.runtime, "sendMessage");
    const tabSend = vi.spyOn(fakeBrowser.tabs, "sendMessage");
    expect(await sendTabControl(undefined, request)).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(tabSend).not.toHaveBeenCalled();
  });
});
