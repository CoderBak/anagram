// A document nonce plus a live port binds messages on browsers without documentId.
import { browser } from "#imports";
import { SESSION_KEY, SESSION_PORT } from "./messages";

interface Connection {
  session: string;
  promise: Promise<string>;
  signal: AbortSignal;
  close(cancelled?: boolean): void;
}
let connected: Connection | undefined;

export function documentSessionId(): string {
  const world = globalThis as unknown as Record<string, unknown>;
  if (typeof world[SESSION_KEY] !== "string") world[SESSION_KEY] = crypto.randomUUID();
  return world[SESSION_KEY] as string;
}

function connection(): Connection {
  if (connected) return connected;
  const session = documentSessionId();
  const controller = new AbortController();
  let resolve!: (session: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((accept, fail) => { resolve = accept; reject = fail; });
  let port: ReturnType<typeof browser.runtime.connect> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const onPageHide = () => {
    if (connected === record) cancelDocumentSession();
    else record.close(true);
  };
  const record: Connection = {
    session, promise, signal: controller.signal,
    close(cancelled = false) {
      if (record.signal.aborted) return;
      const error = new Error(cancelled ? "Document session cancelled" : "Document connection unavailable");
      // A delayed disconnect from an old port must not discard a replacement.
      if (connected === record) connected = undefined;
      clearTimeout(timer);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
      controller.abort(error);
      if (!settled) { settled = true; reject(error); }
      try { port?.disconnect(); } catch { /* already disconnected */ }
    },
  };
  connected = record;
  try {
    port = browser.runtime.connect({ name: SESSION_PORT });
    timer = setTimeout(() => record.close(), 2000);
    port.onDisconnect.addListener(() => { void browser.runtime.lastError; record.close(); });
    port.onMessage.addListener((message) => {
      if (settled || record.signal.aborted || message?.session !== session) return;
      settled = true;
      clearTimeout(timer);
      resolve(session);
    });
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide, { once: true });
    port.postMessage({ session });
  } catch { record.close(); }
  return record;
}

export function connectDocument(): Promise<string> {
  return connection().promise;
}

/** Cancel this document's queued/in-flight requests; the next request gets a fresh port. */
export function cancelDocumentSession(): void {
  (globalThis as unknown as Record<string, unknown>)[SESSION_KEY] = crypto.randomUUID();
  connected?.close(true);
}

export async function sendDocumentMessage(message: object): Promise<unknown> {
  const current = connection();
  const session = await current.promise;
  if (current.signal.aborted) throw current.signal.reason;
  return new Promise((resolve, reject) => {
    const stopped = () => reject(current.signal.reason);
    current.signal.addEventListener("abort", stopped, { once: true });
    const cleanup = () => current.signal.removeEventListener("abort", stopped);
    try {
      Promise.resolve(browser.runtime.sendMessage({ ...message, session })).then(
        (reply) => { cleanup(); if (!current.signal.aborted) resolve(reply); },
        (error: unknown) => { cleanup(); reject(current.signal.aborted ? current.signal.reason : error); },
      );
    } catch (error) { cleanup(); reject(error); }
  });
}
