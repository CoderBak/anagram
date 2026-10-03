import { browser } from "#imports";
import type { ControlMessage } from "./protocol";

/**
 * Extension reader pages receive runtime messages; web pages receive tab messages. A tab whose
 * address the browser does not tell (an extension page — the reader itself — or a site with no
 * grant) is first asked as a reader: only the reader in THAT tab answers a runtime message
 * naming it, and where there is none the page's own script is asked.
 */
export async function sendTabControl(tab: { id?: number; url?: string } | undefined, message: ControlMessage): Promise<unknown> {
  if (tab?.id == null) return undefined;
  const reader = browser.runtime.getURL("/reader.html");
  const asReader = (): Promise<unknown> => browser.runtime.sendMessage({ ...message, readerTabId: tab.id });
  if (tab.url?.split(/[?#]/, 1)[0] === reader) return asReader();
  if (tab.url === undefined) {
    const answer = await asReader().catch(() => undefined);
    if (answer !== undefined) return answer;
  }
  return browser.tabs.sendMessage(tab.id, message);
}
