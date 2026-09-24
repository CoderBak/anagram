import { browser } from "#imports";
import { browsingOrigins } from "../access/patterns";
import { hasPdfSourceAccess } from "./sourceAccess";
import { isInlinePdfResponse, shouldAutoOpen } from "./route";
import { looksLikePdfUrl, safePdfSource, samePdfSource } from "./source";

interface DocumentState {
  url: string; pdf: boolean; allowedMethod: boolean; committed: boolean;
  suppressed: boolean; opening: boolean;
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
  const passes = new Map<number, {url: string; expires: number}>();
  const access = deps.access ?? hasPdfSourceAccess;
  const current = async (tabId: number, entry: DocumentState) => {
    if (documents.get(tabId) !== entry) return false;
    try {
      const tab = await browser.tabs.get(tabId);
      return documents.get(tabId) === entry && samePdfSource(tab.url, entry.url) &&
        (!tab.pendingUrl || samePdfSource(tab.pendingUrl, entry.url));
    } catch { return false; }
  };
  const attempt = async (tabId: number, entry: DocumentState, wanted = false, navigationType = "navigate") => {
    if (!entry.pdf || !entry.committed || !entry.allowedMethod || entry.opening || entry.suppressed) return;
    entry.opening = true;
    try {
      const source = safePdfSource(entry.url);
      if (!source || !await access(entry.url) || !await current(tabId, entry)) return;
      const setting = wanted || await deps.setting();
      if (!await current(tabId, entry) || !shouldAutoOpen({setting, contentType: "application/pdf", protocol: source.protocol, navigationType, frame: 0, pass: entry.suppressed})) return;
      await deps.open(tabId, entry.url, {auto: !wanted});
    } catch { /* Navigation or permission may disappear while the document loads. */ }
    finally { entry.opening = false; }
  };
  return {
    serve() {
      browser.webNavigation.onBeforeNavigate.addListener((details) => {
        if (details.frameId !== 0) return;
        const pass = passes.get(details.tabId); passes.delete(details.tabId);
        documents.set(details.tabId, {url: details.url, pdf: false, allowedMethod: false, committed: false, opening: false,
          suppressed: !!pass && pass.expires > Date.now() && samePdfSource(pass.url, details.url)});
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
          void attempt(details.tabId, entry);
          return undefined;
        }, {urls: ["http://*/*", "https://*/*"], types: ["main_frame"]}, ["responseHeaders"]);
      };
      browser.permissions.onAdded.addListener((added) => watchHeaders(added.origins));
      void browser.permissions.getAll().then((granted) => watchHeaders(granted.origins), () => undefined);
      browser.webNavigation.onCommitted.addListener((details) => {
        if (details.frameId !== 0) return;
        let entry = documents.get(details.tabId);
        if (!entry || !samePdfSource(entry.url, details.url)) {
          entry = {url: details.url, pdf: false, allowedMethod: false, committed: false, suppressed: false, opening: false};
          documents.set(details.tabId, entry);
        }
        entry.url = details.url; entry.committed = true;
        entry.suppressed ||= details.transitionQualifiers?.includes("forward_back") ?? false;
        if (safePdfSource(details.url)?.protocol === "file:" && looksLikePdfUrl(details.url)) { entry.pdf = true; entry.allowedMethod = true; }
        void attempt(details.tabId, entry);
      });
      browser.webNavigation.onCompleted.addListener((details) => {
        if (details.frameId !== 0) return;
        const entry = documents.get(details.tabId);
        if (entry && samePdfSource(entry.url, details.url)) void attempt(details.tabId, entry);
      });
    },
    forget(tabId: number) { documents.delete(tabId); passes.delete(tabId); },
    pass(tabId: number, url: string) { passes.set(tabId, {url, expires: Date.now() + 60_000}); },
    async contentPdf(tabId: number, source: string, navigationType: string, wanted = false) {
      const entry = documents.get(tabId);
      // MIME observation establishes GET semantics. No speculative replay of POST PDFs.
      if (!entry || !samePdfSource(entry.url, source)) return;
      await attempt(tabId, entry, wanted, navigationType);
    },
    async status(tabId: number): Promise<PdfStatus> {
      const no: PdfStatus = {pdf: false, source: null, local: false, authorized: false};
      try {
        const tab = await browser.tabs.get(tabId), url = tab.url && safePdfSource(tab.url);
        if (!url) return no;
        const entry = documents.get(tabId), local = url.protocol === "file:";
        const observed = entry?.pdf && samePdfSource(entry.url, url.href);
        const pdf = !!observed || looksLikePdfUrl(url.href);
        if (!pdf) return no;
        return {pdf, source: url.href, local, authorized: await access(url.href)};
      } catch { return no; }
    },
  };
}
