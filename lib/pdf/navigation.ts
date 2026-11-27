import { browser } from "#imports";
import { browsingOrigins } from "../access/patterns";
import { hasPdfSourceAccess } from "./sourceAccess";
import { isInlinePdfResponse, shouldAutoOpen } from "./route";
import { looksLikePdfUrl, safePdfSource, samePdfSource } from "./source";

interface DocumentState {
  url: string; pdf: boolean; allowedMethod: boolean; committed: boolean;
  suppressed: boolean; opening: boolean; wanted?: boolean; documentId?: string;
}
export interface PdfStatus { pdf: boolean; source: string | null; local: boolean; authorized: boolean }
interface Dependencies {
  setting(): Promise<boolean>;
  open(tabId: number, source: string, opts: {auto: boolean}): Promise<unknown>;
  access?(source: string): Promise<boolean>;
}
/** Navigation state is independent of content scripts, including Firefox's native viewer. */
export function createPdfNavigation(deps: Dependencies) {
  const documents = new Map<number, DocumentState>();
  const intentKey = (tabId: number) => `pdfNavigationIntent:${tabId}`;
  const documentKey = (tabId: number) => `pdfDocument:${tabId}`;
  type Intent = { action: "pass" | "open"; url: string; expires?: number };
  const recordIntent = (tabId: number, url: string, action: Intent["action"]) =>
    browser.storage.session.set({ [intentKey(tabId)]: { action, url, ...(action === "pass" && { expires: Date.now() + 60_000 }) } satisfies Intent });
  function rememberPdf(tabId: number, entry: DocumentState): void {
    // A document ID identifies an extensionless PDF across worker sleeps. A reload gets a new ID.
    if (entry.committed && entry.pdf && entry.documentId && !looksLikePdfUrl(entry.url)) {
      void browser.storage.session.set({ [documentKey(tabId)]: entry.documentId }).catch(() => {});
    }
  }
  const access = deps.access ?? hasPdfSourceAccess;
  const current = async (tabId: number, entry: DocumentState) => {
    if (documents.get(tabId) !== entry) return false;
    try {
      const tab = await browser.tabs.get(tabId);
      return documents.get(tabId) === entry && samePdfSource(tab.url, entry.url) &&
        (!tab.pendingUrl || samePdfSource(tab.pendingUrl, entry.url));
    } catch { return false; }
  };
  const attempt = async (tabId: number, entry: DocumentState, navigationType = "navigate") => {
    if (!entry.pdf || !entry.committed || !entry.allowedMethod || entry.opening || entry.suppressed) return;
    entry.opening = true;
    try {
      const source = safePdfSource(entry.url);
      if (!source || !await access(entry.url) || !await current(tabId, entry)) return;
      const wanted = entry.wanted === true;
      const setting = wanted || await deps.setting();
      if (!await current(tabId, entry) || !shouldAutoOpen({setting, contentType: "application/pdf", protocol: source.protocol, navigationType, frame: 0, pass: entry.suppressed})) return;
      entry.wanted = false;
      await deps.open(tabId, entry.url, {auto: !wanted});
    } catch { /* Navigation or permission may disappear while the document loads. */ }
    finally { entry.opening = false; }
  };
  return {
    serve() {
      browser.webNavigation.onBeforeNavigate.addListener((details) => {
        if (details.frameId !== 0) return;
        // Firefox sometimes announces a navigation again after the response's headers
        // now and then: the same address, not yet committed, is the same navigation, and
        // what its headers said stands.
        const same = documents.get(details.tabId);
        if (same && !same.committed && same.url === details.url) return;
        documents.set(details.tabId, {url: details.url, pdf: false, allowedMethod: false, committed: false, opening: false, suppressed: false});
      });
      // Chrome rejects a webRequest listener while the extension holds no host permission
      // ("You need to request host permissions in the manifest file…") and never retries it.
      // Site access is optional, so the listener waits for the first http(s) grant.
      let watching = false;
      const watchHeaders = (origins: readonly string[] | undefined) => {
        if (watching || !browsingOrigins(origins).length) return;
        watching = true;
        browser.webRequest.onHeadersReceived.addListener((details) => {
          if (details.tabId < 0 || details.type !== "main_frame" || !safePdfSource(details.url)) return;
          let entry = documents.get(details.tabId);
          if (!entry || !samePdfSource(entry.url, details.url)) {
            entry = {url: details.url, pdf: false, allowedMethod: false, committed: false, suppressed: false, opening: false};
            documents.set(details.tabId, entry);
          }
          entry.pdf = isInlinePdfResponse(details);
          entry.allowedMethod = details.method === "GET" && entry.pdf;
          rememberPdf(details.tabId, entry);
          void attempt(details.tabId, entry);
          return undefined;
        }, {urls: ["http://*/*", "https://*/*"], types: ["main_frame"]}, ["responseHeaders"]);
      };
      browser.permissions.onAdded.addListener((added) => watchHeaders(added.origins));
      void browser.permissions.getAll().then((granted) => watchHeaders(granted.origins), () => undefined);
      browser.webNavigation.onCommitted.addListener(async (details) => {
        if (details.frameId !== 0) return;
        let entry = documents.get(details.tabId);
        if (!entry || !samePdfSource(entry.url, details.url)) {
          entry = {url: details.url, pdf: false, allowedMethod: false, committed: false, suppressed: false, opening: false};
          documents.set(details.tabId, entry);
        }
        entry.url = details.url;
        entry.documentId = details.documentId;
        entry.suppressed ||= details.transitionQualifiers?.includes("forward_back") ?? false;
        if (safePdfSource(details.url)?.protocol === "file:" && looksLikePdfUrl(details.url)) { entry.pdf = true; entry.allowedMethod = true; }
        if (details.url !== "about:blank") {
          // The first real commit spends the tab's request, even if the link returned HTML.
          const key = intentKey(details.tabId);
          const intent = (await browser.storage.session.get(key).catch(() => ({})) as Record<string, Intent>)[key];
          if (documents.get(details.tabId) !== entry) return;
          if (intent) {
            const same = samePdfSource(intent.url, details.url);
            entry.wanted = intent.action === "open" && (same || details.transitionQualifiers?.includes("server_redirect"));
            entry.suppressed ||= intent.action === "pass" && same && (intent.expires ?? 0) > Date.now();
            await browser.storage.session.remove(key).catch(() => {});
          }
        }
        if (documents.get(details.tabId) !== entry) return;
        entry.committed = true;
        rememberPdf(details.tabId, entry);
        void attempt(details.tabId, entry);
      });
      browser.webNavigation.onCompleted.addListener((details) => {
        if (details.frameId !== 0) return;
        const entry = documents.get(details.tabId);
        if (entry && samePdfSource(entry.url, details.url)) void attempt(details.tabId, entry);
      });
    },
    forget(tabId: number) {
      documents.delete(tabId);
      void browser.storage.session.remove([intentKey(tabId), documentKey(tabId)]).catch(() => {});
    },
    pass(tabId: number, url: string) { return recordIntent(tabId, url, "pass"); },
    want(tabId: number, url: string) { return recordIntent(tabId, url, "open"); },
    async contentPdf(tabId: number, source: string, navigationType: string) {
      const entry = documents.get(tabId);
      // MIME observation establishes GET semantics. No speculative replay of POST PDFs.
      if (!entry || !samePdfSource(entry.url, source)) return;
      await attempt(tabId, entry, navigationType);
    },
    async status(tabId: number): Promise<PdfStatus> {
      const no: PdfStatus = {pdf: false, source: null, local: false, authorized: false};
      try {
        const tab = await browser.tabs.get(tabId), url = tab.url && safePdfSource(tab.url);
        if (!url) return no;
        const entry = documents.get(tabId), local = url.protocol === "file:";
        const observed = entry?.pdf && samePdfSource(entry.url, url.href);
        let pdf = !!observed || looksLikePdfUrl(url.href);
        if (!pdf && !entry) {
          const key = documentKey(tabId);
          const id = (await browser.storage.session.get(key))[key];
          if (typeof id === "string") {
            const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
            pdf = frame?.documentId === id && samePdfSource(frame.url, url.href);
          }
        }
        if (!pdf) return no;
        return {pdf, source: url.href, local, authorized: await access(url.href)};
      } catch { return no; }
    },
  };
}
