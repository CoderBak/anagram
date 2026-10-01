import { browser } from "#imports";
import type { NativePort } from "./portTransport";

/** Safari exposes request/reply Native Messaging, not Chrome's long-lived native port. */
export function safariPort(): NativePort {
  let closed = false;
  const messages = new Set<(value: unknown) => void>();
  const disconnects = new Set<() => void>();
  const port: NativePort = {
    postMessage(message) {
      if (closed) throw new Error("Safari native connection closed");
      if (!message || typeof message !== "object") throw new Error("Invalid native request");
      void browser.runtime.sendNativeMessage("dev.coderbak.Anagram", message).then((reply) => {
        if (!closed) for (const listener of messages) listener(reply);
      }, (error: unknown) => {
        if (closed) return;
        port.error = { message: error instanceof Error ? error.message : String(error) };
        closed = true;
        for (const listener of disconnects) listener();
      });
    },
    disconnect() { closed = true; messages.clear(); disconnects.clear(); },
    onMessage: { addListener(listener) { messages.add(listener); } },
    onDisconnect: { addListener(listener) { disconnects.add(listener); } },
  };
  return port;
}
