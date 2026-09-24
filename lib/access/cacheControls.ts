import { browser } from "#imports";
import { ACTIONS } from "../messaging/protocol";
import type { BackendRouter } from "../backend/router";
import type { ScoreCacheMode } from "../cachePolicy";

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

/** Only a real change of mode clears the caches and tells the tabs. The mode a worker wakes
 *  in is the one it slept in: tabs keep their verdicts and their batches in flight. */
export function applyCacheMode(router: Pick<BackendRouter, "setCacheMode">, mode: ScoreCacheMode, restored: boolean): Promise<void> {
  return restored ? router.setCacheMode(mode, true) : invalidateAndNotify(() => router.setCacheMode(mode));
}
