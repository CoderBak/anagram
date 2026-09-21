// lib/pdf/handoff.ts — how a PDF's bytes reach the reading mode.
//
// Extension pages cannot fetch remote documents under their connect-src policy. The reader
// therefore receives bytes from the existing tab rather than fetching its own `?src=`.
// This browser policy does not govern the native component's separate setup downloads.
//
// So nothing is fetched from here. The bytes come from THE TAB THE READER IS LOOKING AT.
// Chrome wraps its PDF viewer in an ordinary document that content scripts do run in, so
// that content script re-reads the document its own tab is showing — same origin, same
// cookies, normally answered out of the HTTP cache without touching the network at all —
// and hands the bytes over. Three hops, each one chunked so no copy of a large file has
// to exist twice at once:
//
//   the PDF tab  --PDF_BYTES_PORT-->  the service worker  --PDF_CLAIM_PORT-->  the reader
//
// The worker holds the chunks under a one-time ticket, navigates that same tab to
// `reader.html?src=…&ticket=…`, and frees them the moment the reader has pulled them or
// the ticket goes stale. `src` is left in the address only as a NAME — the title, "Open
// original", the HTML link — and is never fetched by anything on the extension's origin.
//
// WHY BASE64. Chrome serialises extension messages as JSON: a Uint8Array posted across a
// port arrives as `{"0":37,"1":80,…}`, which is thirty times the size and no longer a
// buffer. Base64 costs a third more than the bytes and is the same code on both browsers.
//
// Firefox has no such tab: its viewer is a privileged page no content script reaches (see
// lib/surface.ts). There, nothing offers to open a REMOTE PDF at all, and the reading
// mode is what a file dropped on it makes of it.
import { browser } from "#imports";

/** The PDF tab → the worker: the document this tab is showing, in chunks. */
export const PDF_BYTES_PORT = "anagram-pdf-bytes";
/** The reader → the worker: the bytes held under this ticket. */
export const PDF_CLAIM_PORT = "anagram-pdf-claim";

/**
 * Raw bytes per relayed chunk. Measured on a 45 MB document (Chromium 141, this machine,
 * 2026-09-20) at 64 KiB, 256 KiB and 1 MiB: the tab's leg is 727–740 ms and the reader's
 * 110–170 ms whichever it is, because the cost is the base64 encode and decode and not the
 * number of messages. A quarter of a megabyte is ~180 messages for a file that size —
 * small enough that no single one is a long task, large enough that the per-message
 * overhead has disappeared.
 */
export const CHUNK_BYTES = 256 * 1024;

/**
 * The cap on the TAB path, lower than the reader's own 100 MiB cap on a file picked off
 * the disk, because a file from the disk makes one hop and one copy and a document coming
 * through here does not. Measured at 45 MB: the reader page peaks at 126 MB — the decoded
 * document, plus the base64 of it as garbage the collector has not caught up with — and
 * the worker holds another ~60 MB of base64 until the reader has pulled it. 50 MiB puts
 * the worst instant around 200 MB across the two, which is a lot to ask for a PDF and far
 * too little to be in any danger. Above that a PDF is a scan or a book of images: a
 * document with almost no text in it, which is the one kind this extension has nothing to
 * say about anyway.
 */
export const MAX_HANDOFF_BYTES = 50 * 1024 * 1024;

/** How long held bytes wait for their reader before they are dropped. */
export const TICKET_TTL_MS = 30_000;

/** How long the worker waits for a tab to hand over the document. */
export const READ_TIMEOUT_MS = 30_000;

/** How long the reader waits for the worker to answer its ticket. */
export const CLAIM_TIMEOUT_MS = 15_000;

/**
 * Why a handoff produced nothing, in the three ways the reader can say it out loud:
 * the document is over the cap, it is not a PDF at all, or it could not be read.
 */
export type HandoffFailure = "large" | "type" | "read";

/** How far into the file the `%PDF-` header may sit. pdf.js itself looks this far. */
const MAGIC_WINDOW = 1024;

/** `String.fromCharCode` takes an argument list, and a long one overflows the stack. */
const BINARY_STEP = 0x8000;

// ---- bytes as JSON ------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += BINARY_STEP) {
    binary += String.fromCharCode(...bytes.subarray(at, at + BINARY_STEP));
  }
  return btoa(binary);
}

/** Decode `text` into `into` at `at`, and say how many bytes that was. */
export function fromBase64(text: string, into: Uint8Array, at: number): number {
  const binary = atob(text);
  for (let i = 0; i < binary.length; i++) into[at + i] = binary.charCodeAt(i);
  return binary.length;
}

/** How many bytes a base64 string stands for, without decoding it. */
export function base64Bytes(text: string): number {
  if (text.length === 0) return 0;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/**
 * Is this the start of a PDF? The content type is not evidence: a login page, an error
 * page and a redirect landing page are all served as whatever the server felt like, and
 * handing one of those to pdf.js is how a reader ends up looking at "could not be read"
 * instead of at the sign-in form that is really in the way.
 */
export function hasPdfMagic(head: Uint8Array): boolean {
  const text = new TextDecoder("iso-8859-1").decode(head.subarray(0, MAGIC_WINDOW));
  return text.includes("%PDF-");
}

// ---- the tab: re-read the document it is showing --------------------------------------------

export type StreamResult = { ok: true; bytes: number } | { ok: false; failure: HandoffFailure };

/**
 * Read `url` from this page's own origin and hand it over a chunk at a time. Everything
 * about it is bounded: the body is STREAMED rather than buffered, the running total stops
 * at the cap without the rest of the file ever being read, a document that does not begin
 * with `%PDF-` is refused as soon as the first chunk is in hand, and an abort ends it.
 *
 * `cache: "force-cache"` is what keeps this from being a second download: the tab has
 * just fetched this very document, so the cache normally answers and the network is never
 * touched. Where it cannot (a no-store header, a POST result), the request goes out from
 * the PAGE's own origin with its own cookies, which is the request the reader already made
 * by opening the tab — not a new one from ours.
 */
export async function streamPdfBytes(
  url: string,
  send: (chunk: string) => void,
  opts: { cap: number; signal?: AbortSignal },
): Promise<StreamResult> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "force-cache", signal: opts.signal });
  } catch {
    return { ok: false, failure: "read" };
  }
  if (!response.ok || !response.body) return { ok: false, failure: "read" };
  // A server that states a length over the cap is answered before a byte of it is read.
  const stated = Number(response.headers.get("content-length"));
  if (Number.isFinite(stated) && stated > opts.cap) {
    await response.body.cancel().catch(() => undefined);
    return { ok: false, failure: "large" };
  }

  const reader = response.body.getReader();
  const pending = new Uint8Array(CHUNK_BYTES);
  let held = 0;
  let total = 0;
  let checked = false;
  /** Hand over what is in `pending`, checking the first one for the header. */
  const flush = (): HandoffFailure | null => {
    if (held === 0) return checked ? null : "type";
    if (!checked) {
      checked = true;
      if (!hasPdfMagic(pending.subarray(0, held))) return "type";
    }
    send(toBase64(pending.subarray(0, held)));
    held = 0;
    return null;
  };
  const stop = async (failure: HandoffFailure): Promise<StreamResult> => {
    await reader.cancel().catch(() => undefined);
    return { ok: false, failure };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.cap) return await stop("large");
      let at = 0;
      while (at < value.byteLength) {
        const take = Math.min(CHUNK_BYTES - held, value.byteLength - at);
        pending.set(value.subarray(at, at + take), held);
        held += take;
        at += take;
        if (held === CHUNK_BYTES) {
          // flush() copies out of the buffer, so the same one is filled again: one
          // quarter-megabyte allocation for a document of any size.
          const bad = flush();
          if (bad) return await stop(bad);
        }
      }
    }
  } catch {
    return { ok: false, failure: "read" };
  }
  const bad = flush();
  if (bad) return { ok: false, failure: bad };
  return { ok: true, bytes: total };
}

/**
 * Answer the worker when it asks this tab for the document it is showing. Registered by
 * the content script in a PDF tab and nowhere else — the port name is ours and every
 * other connection is left for whoever it belongs to.
 */
export function serveTabPdfBytes(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PDF_BYTES_PORT) return;
    const stopped = new AbortController();
    port.onDisconnect.addListener(() => stopped.abort());
    /** A port the worker has already let go throws rather than queueing. */
    const post = (message: unknown): boolean => {
      try {
        port.postMessage(message);
        return true;
      } catch {
        stopped.abort();
        return false;
      }
    };
    port.onMessage.addListener((message) => {
      const ask = message as { want?: string; cap?: number };
      // The tab may have moved on since the worker decided to ask. Only the document
      // this page is REALLY showing is ever read.
      if (ask.want !== location.href) {
        post({ failure: "read" });
        return;
      }
      void streamPdfBytes(location.href, (chunk) => post({ chunk }), {
        cap: ask.cap ?? MAX_HANDOFF_BYTES,
        signal: stopped.signal,
      }).then((result) => {
        post(result.ok ? { done: true, bytes: result.bytes } : { failure: result.failure });
      });
    });
  });
}

// ---- the worker: hold the bytes under a ticket ------------------------------------------------

/** A document waiting for the reader that was opened for it. */
interface Held {
  tabId: number;
  chunks: string[];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

/** 128 bits of randomness as hex — a ticket nobody can guess and nobody reuses. */
export function newTicket(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TicketStore {
  hold(tabId: number, chunks: string[], bytes: number): string;
  /** The bytes for this ticket, IF the tab claiming them is the one they were read for. */
  take(ticket: string, tabId: number | undefined): Held | null;
  /** Everything held for a tab that has gone away. */
  forget(tabId: number): void;
  size(): number;
}

export function createTicketStore(ttlMs = TICKET_TTL_MS): TicketStore {
  const held = new Map<string, Held>();
  const drop = (ticket: string): void => {
    const entry = held.get(ticket);
    if (!entry) return;
    clearTimeout(entry.timer);
    held.delete(ticket);
  };
  return {
    hold(tabId, chunks, bytes) {
      const ticket = newTicket();
      // A reader that never arrives — the tab was closed mid-navigation, the worker was
      // woken for something else — must not leave fifty megabytes behind it.
      const timer = setTimeout(() => drop(ticket), ttlMs);
      held.set(ticket, { tabId, chunks, bytes, timer });
      return ticket;
    },
    take(ticket, tabId) {
      const entry = held.get(ticket);
      if (!entry) return null;
      // The ticket was written for ONE tab: the one the worker navigated. A ticket that
      // leaked somewhere else still opens nothing.
      if (tabId !== undefined && tabId !== entry.tabId) return null;
      drop(ticket);
      return entry;
    },
    forget(tabId) {
      for (const [ticket, entry] of held) if (entry.tabId === tabId) drop(ticket);
    },
    size: () => held.size,
  };
}

export type ReadResult =
  | { ok: true; chunks: string[]; bytes: number }
  | { ok: false; failure: HandoffFailure };

/**
 * Ask `tabId` for the document it is showing. The tab does the reading; this only counts
 * what arrives, so a content script that went wrong cannot make the worker hold more than
 * the cap, and a tab that stops answering ends at the deadline rather than never.
 */
export async function readPdfFromTab(
  tabId: number,
  src: string,
  opts: { cap?: number; timeoutMs?: number } = {},
): Promise<ReadResult> {
  const cap = opts.cap ?? MAX_HANDOFF_BYTES;
  let port: ReturnType<typeof browser.tabs.connect>;
  try {
    port = browser.tabs.connect(tabId, { name: PDF_BYTES_PORT, frameId: 0 });
  } catch {
    return { ok: false, failure: "read" };
  }
  return await new Promise<ReadResult>((resolve) => {
    const chunks: string[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: ReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, failure: "read" }), opts.timeoutMs ?? READ_TIMEOUT_MS);
    port.onMessage.addListener((message) => {
      const m = message as { chunk?: string; done?: boolean; bytes?: number; failure?: HandoffFailure };
      if (typeof m.chunk === "string") {
        bytes += base64Bytes(m.chunk);
        if (bytes > cap) {
          finish({ ok: false, failure: "large" });
          return;
        }
        chunks.push(m.chunk);
        return;
      }
      if (m.done) finish({ ok: true, chunks, bytes });
      else finish({ ok: false, failure: m.failure ?? "read" });
    });
    // No content script on the other end, or the tab navigated away mid-read.
    port.onDisconnect.addListener(() => finish({ ok: false, failure: "read" }));
    try {
      port.postMessage({ want: src, cap });
    } catch {
      finish({ ok: false, failure: "read" });
    }
  });
}

export interface HandoffDeps {
  /** `reader.html?src=…` for a document — the worker's own, so this file builds no URL. */
  readerUrl(src: string): string;
  /**
   * Make sure the tab really has our content script before it is asked for bytes. Site
   * access is optional (lib/access/worker.ts): on a site with no grant there is nobody to
   * answer the port, and the click that started this is what gives us `activeTab` to put
   * a script there for this one tab.
   */
  ensureInjected?(tabId: number): Promise<boolean>;
}

export interface PdfHandoff {
  /** Register the reader's claim port. Called at the worker's top level, as MV3 needs. */
  serve(): void;
  /** Read the PDF `tabId` is showing and turn that tab into the reading mode. */
  open(tabId: number, src: string, opts: { auto: boolean }): Promise<void>;
  /** A tab has gone: whatever was held for it goes with it. */
  forget(tabId: number): void;
}

export function createPdfHandoff(deps: HandoffDeps): PdfHandoff {
  const store = createTicketStore();
  /**
   * Tabs whose document is being read right now. Two things can ask for the same tab in
   * the same second and used to get two reads of the same file: injecting a content script
   * into a PDF tab for an explicit "open it with Anagram" makes that script announce the
   * tab, which is the automatic route's cue as well. Whoever asked first is answered.
   */
  const reading = new Set<number>();

  return {
    serve() {
      browser.runtime.onConnect.addListener((port) => {
        if (port.name !== PDF_CLAIM_PORT) return;
        const tabId = port.sender?.tab?.id;
        port.onMessage.addListener((message) => {
          const ticket = (message as { ticket?: string }).ticket;
          const entry = typeof ticket === "string" ? store.take(ticket, tabId) : null;
          try {
            if (!entry) {
              port.postMessage({ gone: true });
              return;
            }
            port.postMessage({ bytes: entry.bytes });
            for (const chunk of entry.chunks) port.postMessage({ chunk });
            port.postMessage({ done: true });
          } catch {
            /* the reader closed mid-hand-over; the ticket is spent either way */
          }
        });
      });
    },

    async open(tabId, src, { auto }) {
      if (reading.has(tabId)) return;
      reading.add(tabId);
      try {
        await read(tabId, src, auto);
      } finally {
        reading.delete(tabId);
      }
    },

    forget: (tabId) => store.forget(tabId),
  };

  /** The read itself, so `open` is only about who is allowed to start one. */
  async function read(tabId: number, src: string, auto: boolean): Promise<void> {
    // Site access is optional, so a tab may hold no content script at all. The click that
    // brought us here carries `activeTab`, which is enough to put one there — and a script
    // that arrives that way analyzes nothing, but it still answers this. Its answer is not
    // waited on: lib/access/worker.ts says a page it could not inject into may be
    // listening on its own account, and a tab with nobody on the other end disconnects the
    // port at once anyway.
    if (deps.ensureInjected) await deps.ensureInjected(tabId).catch(() => false);
    const got = await readPdfFromTab(tabId, src);
    if (!got.ok) {
      // The AUTOMATIC route leaves the tab exactly as it was. A PDF we could not read
      // is still the PDF the reader asked for, and swapping it for a page that says so
      // would be changing what they see in order to apologise for not helping.
      // An explicit click has to be answered, so the reading mode opens and says it.
      if (!auto) {
        await browser.tabs
          .update(tabId, { url: `${deps.readerUrl(src)}&err=${got.failure}` })
          .catch(() => undefined);
      }
      return;
    }
    const ticket = store.hold(tabId, got.chunks, got.bytes);
    try {
      await browser.tabs.update(tabId, { url: `${deps.readerUrl(src)}&ticket=${ticket}` });
    } catch {
      // The tab closed between the read and the navigation: free the bytes now rather
      // than leaving them to the timer.
      store.take(ticket, tabId);
    }
  }
}

// ---- the reader: pull the bytes it was opened for -----------------------------------------------

export interface ClaimedPdf {
  bytes: Uint8Array;
}

/**
 * Collect the document held under `ticket`. Null means there is nothing there — a worker
 * that restarted, a reloaded tab, a pasted address — and the reader answers that by going
 * back to the document itself rather than by fetching anything.
 */
export async function claimPdfBytes(ticket: string, signal?: AbortSignal): Promise<ClaimedPdf | null> {
  let port: ReturnType<typeof browser.runtime.connect>;
  try {
    port = browser.runtime.connect({ name: PDF_CLAIM_PORT });
  } catch {
    return null;
  }
  return await new Promise<ClaimedPdf | null>((resolve) => {
    let out: Uint8Array | null = null;
    let at = 0;
    let settled = false;
    const finish = (result: ClaimedPdf | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const onAbort = (): void => finish(null);
    const timer = setTimeout(() => finish(null), CLAIM_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    port.onMessage.addListener((message) => {
      const m = message as { bytes?: number; chunk?: string; done?: boolean; gone?: boolean };
      if (m.gone) {
        finish(null);
        return;
      }
      if (typeof m.bytes === "number") {
        // One allocation for the whole document: the size is known before the first chunk.
        out = new Uint8Array(m.bytes);
        return;
      }
      if (typeof m.chunk === "string" && out) {
        at += fromBase64(m.chunk, out, at);
        return;
      }
      if (m.done) finish(out && at === out.byteLength ? { bytes: out } : null);
    });
    port.onDisconnect.addListener(() => finish(null));
    try {
      port.postMessage({ ticket });
    } catch {
      finish(null);
    }
  });
}
