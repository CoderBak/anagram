import { browser } from "#imports";
import { ACTIONS } from "../messaging/protocol";

/** Router invalidation is synchronous; page caches must clear even if disk work fails. */
export function invalidateAndNotify(operation: () => Promise<void>): Promise<void> {
  try { return operation(); }
  finally {
    void browser.tabs.query({}).then((tabs) => Promise.all(
      tabs.filter((tab) => tab.id !== undefined).map((tab) =>
        browser.tabs.sendMessage(tab.id!, { action: ACTIONS.CACHE_CLEARED }).catch(() => undefined)),
    )).catch(() => undefined);
  }
}
