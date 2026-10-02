import { browser } from "#imports";
import type { ControlMessage } from "./protocol";

/** Extension reader pages receive runtime messages; web pages receive tab messages. */
export function sendTabControl(tab: { id?: number; url?: string } | undefined, message: ControlMessage): Promise<unknown> {
  if (tab?.id == null) return Promise.resolve(undefined);
  if (tab.url?.split(/[?#]/, 1)[0] === browser.runtime.getURL("/reader.html")) {
    return browser.runtime.sendMessage({ ...message, readerTabId: tab.id });
  }
  return browser.tabs.sendMessage(tab.id, message);
}
