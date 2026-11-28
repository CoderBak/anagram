import { browser } from "#imports";

/** Chrome exposes the reason only during the callback, including when a document enters BFCache. */
export function onPortDisconnect(port: ReturnType<typeof browser.runtime.connect>, cleanup: () => void): void {
  port.onDisconnect.addListener(() => {
    void browser.runtime.lastError;
    cleanup();
  });
}
