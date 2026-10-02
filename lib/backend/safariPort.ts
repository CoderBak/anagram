import { browser } from "#imports";
import type { NativePort } from "./portTransport";

/** Safari exposes request/reply Native Messaging, not Chrome's long-lived native port. */
export function safariPort(): NativePort {
  let closed = false;
  const client = crypto.randomUUID();
  const messages = new Set<(value: unknown) => void>();
  const disconnects = new Set<() => void>();
  const send = (message: object): Promise<unknown> => browser.runtime.sendNativeMessage("dev.coderbak.Anagram", { ...message, client });
  const release = (): void => { void send({ anagram: "disconnect" }).catch(() => {}); };
  // Register this connection before sending requests. A late message from an old
  // background worker cannot reopen its process or close its replacement.
  const connected = send({ anagram: "connect" });
  const fail = (error: unknown): void => {
    if (closed) return;
    port.error = { message: error instanceof Error ? error.message : String(error) };
    closed = true;
    release();
    for (const listener of disconnects) listener();
    messages.clear(); disconnects.clear();
  };
  const port: NativePort = {
    postMessage(message) {
      if (closed) throw new Error("Safari native connection closed");
      if (!message || typeof message !== "object") throw new Error("Invalid native request");
      void connected.then((value) => {
        if (closed) return;
        if (!(value as { connected?: boolean } | null)?.connected) throw new Error("Safari native bridge did not connect");
        return send({ anagram: "request", message });
      }).then((reply) => {
        if (!closed) for (const listener of messages) listener(reply);
      }, fail);
    },
    disconnect() {
      if (closed) return;
      closed = true; messages.clear(); disconnects.clear();
      // Also covers switching engines while the connect request is in flight.
      void connected.then(release, () => {});
    },
    onMessage: { addListener(listener) { messages.add(listener); } },
    onDisconnect: { addListener(listener) { disconnects.add(listener); } },
  };
  void connected.catch(fail);
  return port;
}
