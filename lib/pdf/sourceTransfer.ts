import { browser } from "#imports";
import { safePdfSource, samePdfSource, looksLikePdfUrl } from "./source";
import { hasPdfSourceAccess } from "./sourceAccess";

export const SOURCE_CLAIM_PORT = "anagram-pdf-source-claim";
export const SOURCE_LOADER_PORT = "anagram-pdf-source-loader";
export const LOADER_PAGE = "/pdf-loader.html";
export const SOURCE_CAP = 50 * 1024 * 1024;
export const SOURCE_TIMEOUT = 45_000;
const SOURCE_TICKET = /^s-[a-f0-9]{32}$/;
const LOADER_TICKET = /^[a-f0-9]{32}$/;
export type PdfOpenResult = {ok: true} | {ok: false; error: "busy" | "forbidden" | "read"};
type Port = ReturnType<typeof browser.runtime.connect>;
function ticket(): string { return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function post(port: Port, value: unknown): boolean { try { port.postMessage(value); return true; } catch { return false; } }
function disconnect(port?: Port): void { try { port?.disconnect(); } catch {} }
function page(value: string | undefined, path: "/reader.html" | typeof LOADER_PAGE): boolean {
  return !!value && value.split(/[?#]/)[0] === browser.runtime.getURL(path);
}
export function sourceHasMagic(bytes: Uint8Array): boolean {
  return new TextDecoder("iso-8859-1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
}
interface Transfer {
  tabId: number; source: string; reader: string; navigating: boolean; loadingSeen: boolean; complete: boolean;
  documentId?: string; owner?: Port; loader?: Port; loaderTicket?: string; proof?: string; claiming?: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** A source address is disclosed only to an iframe of the same live reader document. */
export function createSourceBroker(readerUrl: (source: string) => string) {
  const held = new Map<string, Transfer>();
  let accessVersion = 0;
  const epochs = new Map<number, number>();
  const drop = (key: string) => {
    const transfer = held.get(key); if (!transfer) return;
    held.delete(key); clearTimeout(transfer.timer);
    disconnect(transfer.loader); disconnect(transfer.owner);
  };
  const forget = (tabId: number) => {
    epochs.delete(tabId);
    for (const [key, transfer] of held) if (transfer.tabId === tabId) drop(key);
  };
  const currentReader = async (entry: Transfer): Promise<boolean> => {
    try {
      const tab = await browser.tabs.get(entry.tabId);
      if ((tab.url && tab.url !== entry.reader) || (tab.pendingUrl && tab.pendingUrl !== entry.reader)) return false;
      // Chromium hides extension-page URL/frame data without broad tabs access. The
      // browser-authenticated owner port remains the document identity in that case.
      const frame = await browser.webNavigation.getFrame({tabId: entry.tabId, frameId: 0}).catch(() => null);
      if (frame && frame.url !== entry.reader) return false;
      const actual = (frame as {documentId?: string} | null)?.documentId;
      return !actual || !entry.owner?.sender?.documentId || actual === entry.owner.sender.documentId;
    } catch { return false; }
  };
  return {
    forget,
    serve() {
      browser.tabs.onUpdated.addListener((tabId, change) => {
        if (change.status === "loading") epochs.set(tabId, (epochs.get(tabId) ?? 0) + 1);
        for (const [key, entry] of held) if (entry.tabId === tabId && !entry.owner) {
          // Chrome can emit multiple loading events for one extension navigation and
          // hides its frame metadata. Only a load after completion proves a new load;
          // before the first claim/commit, those events cannot identify a document.
          if (change.status === "loading") {
            if (entry.complete || (change.url && change.url !== entry.reader)) drop(key);
            else entry.loadingSeen = true;
          } else if (change.status === "complete" && entry.loadingSeen) entry.complete = true;
        }
      });
      browser.webNavigation.onBeforeNavigate.addListener((details) => {
        if (details.frameId !== 0) return;
        epochs.set(details.tabId, (epochs.get(details.tabId) ?? 0) + 1);
        for (const [key, entry] of held) if (entry.tabId === details.tabId) {
          if (!entry.navigating || details.url !== entry.reader) drop(key);
        }
      });
      browser.webNavigation.onCommitted.addListener((details) => {
        if (details.frameId !== 0) return;
        for (const [key, entry] of held) if (entry.tabId === details.tabId) {
          const documentId = (details as {documentId?: string}).documentId;
          if (details.url !== entry.reader || (entry.documentId && documentId && entry.documentId !== documentId)) drop(key);
          else { entry.navigating = false; entry.documentId ??= documentId; }
        }
      });
      browser.permissions.onRemoved.addListener(() => {
        accessVersion++;
        for (const [key, entry] of held) void hasPdfSourceAccess(entry.source).then((allowed) => { if (!allowed) drop(key); });
      });
      browser.runtime.onConnect.addListener((port) => {
        if (port.name !== SOURCE_CLAIM_PORT && port.name !== SOURCE_LOADER_PORT) return;
        const sender = port.sender;
        if (sender?.id !== browser.runtime.id || !Number.isInteger(sender.tab?.id) ||
            (sender.documentLifecycle && sender.documentLifecycle !== "active")) { disconnect(port); return; }
        const claim = port.name === SOURCE_CLAIM_PORT;
        if (!page(sender.url, claim ? "/reader.html" : LOADER_PAGE) ||
            (claim ? sender.frameId !== 0 : !sender.frameId || sender.frameId < 1)) { disconnect(port); return; }
        let used = false;
        const idle = setTimeout(() => disconnect(port), 5000);
        port.onDisconnect.addListener(() => clearTimeout(idle));
        port.onMessage.addListener((message) => {
          if (used) { disconnect(port); return; }
          used = true; clearTimeout(idle);
          void (async () => {
            if (!message || Object.keys(message).length !== (claim ? 1 : 2) || typeof message.ticket !== "string") { disconnect(port); return; }
            const key = message.ticket as string;
            if (new URL(sender.url!).searchParams.get("ticket") !== key) { disconnect(port); return; }
            if (claim) {
              const entry = held.get(key);
              if (!SOURCE_TICKET.test(key) || !entry || entry.claiming || entry.owner || entry.tabId !== sender.tab!.id || entry.reader !== sender.url || (entry.documentId && sender.documentId && entry.documentId !== sender.documentId)) { disconnect(port); return; }
              entry.claiming = true; entry.owner = port; entry.navigating = false; entry.documentId ??= sender.documentId;
              port.onDisconnect.addListener(() => drop(key));
              if (!await currentReader(entry) || !await hasPdfSourceAccess(entry.source) || held.get(key) !== entry) { drop(key); return; }
              entry.loaderTicket = ticket(); entry.proof = ticket();
              if (!post(port, {load: entry.loaderTicket, proof: entry.proof})) drop(key);
            } else {
              const found = [...held].find(([, entry]) => entry.loaderTicket === key);
              if (!LOADER_TICKET.test(key) || !found) { disconnect(port); return; }
              const [sourceKey, entry] = found;
              if (!entry.owner || entry.loader || typeof message.proof !== "string" || message.proof !== entry.proof || entry.tabId !== sender.tab!.id || sender.url !== `${browser.runtime.getURL(LOADER_PAGE)}?ticket=${key}`) { disconnect(port); return; }
              entry.loader = port;
              port.onDisconnect.addListener(() => drop(sourceKey));
              const frame = await browser.webNavigation.getFrame({tabId: entry.tabId, frameId: sender.frameId!}).catch(() => null);
              const documentId = (frame as {documentId?: string} | null)?.documentId;
              if ((frame && (frame.parentFrameId !== 0 || frame.url !== sender.url)) ||
                  (documentId && sender.documentId && documentId !== sender.documentId) ||
                  !await currentReader(entry) || !await hasPdfSourceAccess(entry.source) || held.get(sourceKey) !== entry) { drop(sourceKey); return; }
              if (!post(port, {source: entry.source, cap: SOURCE_CAP})) drop(sourceKey);
            }
          })().catch(() => disconnect(port));
        });
      });
    },
    async open(tabId: number, source: string): Promise<PdfOpenResult> {
      const url = safePdfSource(source);
      if (!url || (url.protocol === "file:" && !looksLikePdfUrl(source))) return {ok: false, error: "forbidden"};
      const epoch = epochs.get(tabId) ?? 0, accessEpoch = accessVersion;
      if (!await hasPdfSourceAccess(source)) return {ok: false, error: "forbidden"};
      let tab;
      try { tab = await browser.tabs.get(tabId); } catch { return {ok: false, error: "read"}; }
      if (accessVersion !== accessEpoch || (epochs.get(tabId) ?? 0) !== epoch || !samePdfSource(tab.url, source) || (tab.pendingUrl && !samePdfSource(tab.pendingUrl, source))) return {ok: false, error: "forbidden"};
      forget(tabId);
      // One private source read at a time, capped at 50 MiB (separate from the byte relay budget).
      if (held.size >= 1) return {ok: false, error: "busy"};
      const key = `s-${ticket()}`, reader = `${readerUrl(source)}&ticket=${key}`;
      const entry: Transfer = {tabId, source, reader, navigating: true, loadingSeen: false, complete: false, timer: setTimeout(() => drop(key), SOURCE_TIMEOUT)};
      held.set(key, entry);
      try { await browser.tabs.update(tabId, {url: reader}); return {ok: true}; } catch { drop(key); return {ok: false, error: "read"}; }
    },
  };
}

/** Reader-side private iframe. `src` query parameters never enter this protocol. */
export async function claimSourceBytes(key: string, signal?: AbortSignal): Promise<{bytes: Uint8Array} | null> {
  if (!SOURCE_TICKET.test(key) || signal?.aborted) return null;
  let port: Port;
  try { port = browser.runtime.connect({name: SOURCE_CLAIM_PORT}); } catch { return null; }
  return new Promise((resolve) => {
    let iframe: HTMLIFrameElement | undefined, loaderTicket: string | undefined, parentProof: string | undefined, done = false;
    const finish = (bytes: Uint8Array | null) => {
      if (done) return; done = true; clearTimeout(timer);
      signal?.removeEventListener("abort", abort); window.removeEventListener("message", receive);
      iframe?.remove(); disconnect(port); resolve(bytes ? {bytes} : null);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, SOURCE_TIMEOUT);
    const receive = (event: MessageEvent) => {
      if (!iframe || event.source !== iframe.contentWindow || event.origin !== location.origin || event.data?.ticket !== loaderTicket) return;
      if (event.data?.kind === "anagram-pdf-loader-ready") {
        const target = location.origin === "null" ? "*" : location.origin;
        iframe.contentWindow!.postMessage({kind: "anagram-pdf-loader-authorize", ticket: loaderTicket, proof: parentProof}, target);
        return;
      }
      if (event.data?.kind !== "anagram-pdf-loaded") return;
      const buffer = event.data.bytes;
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1 || buffer.byteLength > SOURCE_CAP) { abort(); return; }
      const bytes = new Uint8Array(buffer); finish(sourceHasMagic(bytes) ? bytes : null);
    };
    signal?.addEventListener("abort", abort, {once: true}); window.addEventListener("message", receive);
    port.onDisconnect.addListener(abort);
    port.onMessage.addListener((value) => {
      if (done || iframe || !value || Object.keys(value).length !== 2 || typeof value.load !== "string" || !LOADER_TICKET.test(value.load) || typeof value.proof !== "string" || !LOADER_TICKET.test(value.proof)) { abort(); return; }
      loaderTicket = value.load; parentProof = value.proof;
      iframe = document.createElement("iframe"); iframe.hidden = true;
      iframe.src = `${browser.runtime.getURL(LOADER_PAGE)}?ticket=${loaderTicket}`;
      document.body.append(iframe);
    });
    if (!post(port, {ticket: key})) abort();
  });
}
