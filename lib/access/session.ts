// A document nonce plus a live port binds messages on browsers without documentId.
import { browser } from "#imports";
import { SESSION_HANDSHAKE_MS, SESSION_KEY, SESSION_PORT } from "./messages";

interface Connection {
  session: string;
  promise: Promise<string>;
  signal: AbortSignal;
  close(cancelled?: boolean): void;
  /** Post on the port now, if it is up (handshake done, not closed). */
  post(message: object): boolean;
}
let connected: Connection | undefined;
/** What the document says as it goes, said on its port before the port closes. */
const lastWords = new Set<() => void>();

/** Run `fn` as the document goes (pagehide), before its session's port closes: what it posts on
 *  the port then (postDocumentMessage) reaches the worker. Returns the way to stop. */
export function beforeDocumentLeaves(fn: () => void): () => void {
  lastWords.add(fn);
  return () => { lastWords.delete(fn); };
}

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
    for (const fn of [...lastWords]) { try { fn(); } catch { /* the rest still go */ } }
    if (connected === record) cancelDocumentSession();
    else record.close(true);
  };
  const record: Connection = {
    session, promise, signal: controller.signal,
    post(message) {
      if (!settled || controller.signal.aborted || !port) return false;
      try { port.postMessage({ ...message, session }); return true; } catch { return false; }
    },
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
    timer = setTimeout(() => record.close(), SESSION_HANDSHAKE_MS);
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

/**
 * Post `message` on this document's session port, now, and tell whether it went: for what a
 * page says as it goes (the reading log's last message of a visit). A port's messages reach the
 * worker before its disconnect does; a runtime message sent from `pagehide` can arrive after the
 * session's port has closed, and be refused. No reply comes back.
 */
export function postDocumentMessage(message: object): boolean {
  return connected?.post(message) ?? false;
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
