import { browser } from "#imports";
import { cancelDocumentSession, sendDocumentMessage } from "../../lib/access/session";
import { t } from "../../lib/i18n";
import { createOrchestrator, type Orchestrator } from "../../lib/capture/orchestrator";
import { enabledForSite } from "../../lib/settings/settings";
import { ACTIONS, type ControlMessage, type TabState } from "../../lib/messaging/protocol";
import { setRangeLocator } from "../../lib/render/highlight";
import { extractPageText } from "../../lib/pdf/extract";
import { reflowPdf, type PdfPageText, type ReflowBlock } from "../../lib/pdf/reflow";
import { createPdfUnitSource, type PdfUnitSource } from "../../lib/pdf/units";
import { pdfNameFromUrl, safePdfSource } from "../../lib/pdf/source";
import { claimPdfBytes } from "../../lib/pdf/handoff";
import { startViewer, pageView, type PageView, type PdfApplication, type UpstreamPage } from "./viewer";
import { placeChip } from "./chips";
import "./style.css";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ANALYSIS_PAGES = 300;
const notice = document.getElementById("notice")!;
const drop = document.getElementById("drop")!;
const scopeLabel = document.getElementById("analysisScope")!;
const original = document.getElementById("original") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const analyze = document.getElementById("anagramAnalyze") as HTMLButtonElement;
let app: PdfApplication;
let orchestrator: Orchestrator | null = null;
let source: PdfUnitSource | null = null;
let reportUrl = "";
let originalUrl: string | null = null;
let generation = 0;
let controller: AbortController | null = null;
let started = false;
const pages = new Map<number, {view: PageView; text: PdfPageText; geometry: string}>();
const extracting = new WeakSet<Element>();

function say(text: string): void {
  notice.textContent = text;
  notice.hidden = !text;
}
function failure(reason: string): void {
  say(reason === "large" ? t("readerTooLarge") : reason === "type" ? t("readerBadFile") : reason === "busy" ? t("readerBusy") : t("readerFetchFailed"));
  if (!app.pdfDocument) drop.hidden = false;
}
function scopeCount(): number { return [...pages.values()].filter(({view}) => view.layer.isConnected).length; }
function updateScope(): void {
  const total = app?.pdfDocument?.numPages ?? 0;
  scopeLabel.hidden = total === 0;
  scopeLabel.textContent = total ? t("readerAnalysisScope", scopeCount(), total) : "";
}
function rebuild(): void {
  if (!source) return;
  for (const [n, record] of pages) {
    if (!record.view.layer.isConnected) { pages.delete(n); source.removePage(n); }
  }
  // A recycled/unrendered page is a real gap, never join prose across it.
  const groups: PdfPageText[][] = [];
  for (const {text} of [...pages.values()].sort((a, b) => a.text.page - b.text.page)) {
    const previous = groups.at(-1);
    if (previous && previous.at(-1)!.page + 1 === text.page) previous.push(text);
    else groups.push([text]);
  }
  const began = performance.now();
  const blocks: ReflowBlock[] = [];
  for (const group of groups) {
    const reflow = reflowPdf(group);
    if (reflow[0] && blocks.length) reflow[0].columnBreak = true;
    blocks.push(...reflow);
  }
  source.setBlocks(blocks);
  performance.measure("anagram-reflow", {start: began});
  updateScope();
}
function prune(): void {
  if ([...pages.values()].some(({view}) => !view.layer.isConnected)) rebuild();
}
async function startAnalysis(owned: number): Promise<void> {
  if (!source || orchestrator) return;
  const currentSource = source;
  setRangeLocator((unit, spans) => currentSource.ranges(unit, spans));
  let answered = false;
  orchestrator = createOrchestrator(null, {
    mountFab: true, lockScope: "page", reportUrl,
    reportScopeNote: () => t("readerReportScope", scopeCount(), app.pdfDocument?.numPages ?? 0),
    collect: (_root, claim, options) => {
      if (answered) return [];
      answered = true;
      queueMicrotask(() => { answered = false; });
      prune();
      return currentSource.collect(claim, options.mergeShorts);
    },
    placeBadge: (unit, host) => placeChip({pageOf: (layer) => [...pages.values()].find(({view}) => view.layer === layer)?.view}, unit, host),
  });
  const enabled = await enabledForSite(location.hostname);
  if (owned !== generation) return;
  if (enabled || started) { started = true; orchestrator?.start(); }
}
async function rendered(page: UpstreamPage | undefined): Promise<void> {
  if (!page?.pdfPage || !source || page.id > MAX_ANALYSIS_PAGES) return;
  const view = pageView(page);
  if (!view || extracting.has(view.layer)) return;
  const geometry = `${page.viewport.width}:${page.viewport.height}:${page.viewport.scale}`;
  const previous = pages.get(page.id);
  if (previous?.view.layer === view.layer) {
    if (previous.geometry !== geometry) {
      previous.geometry = geometry;
      previous.view = view;
      if (started) orchestrator?.rescan();
    }
    return;
  }
  const owned = generation, currentSource = source;
  extracting.add(view.layer);
  try {
    const text = await extractPageText(page.pdfPage);
    if (owned !== generation || !view.layer.isConnected || page.textLayer?.div !== view.layer) return;
    pages.set(page.id, {view, text, geometry});
    currentSource.setPage(page.id, {layer: view.layer, spans: view.spans});
    rebuild();
    if (text.items.some((item) => item.str.trim())) {
      if (app.pdfDocument!.numPages <= MAX_ANALYSIS_PAGES) say("");
      if (!orchestrator) await startAnalysis(owned);
      else if (started) orchestrator.rescan();
    } else if (app.pdfDocument?.numPages === 1) say(t("readerNoText"));
  } catch {
    // A malformed page does not prevent the upstream viewer showing other pages.
    if (owned === generation && !pages.size) say(t("readerNoText"));
  } finally { extracting.delete(view.layer); }
}
function beginLoad(): {owned: number; signal: AbortSignal; closing: Promise<void>} {
  controller?.abort();
  controller = new AbortController();
  const owned = ++generation;
  orchestrator?.stop(); orchestrator = null; started = false;
  cancelDocumentSession();
  setRangeLocator(null);
  pages.clear(); source = null; scopeLabel.hidden = true;
  originalUrl = null; original.hidden = true;
  say(t("readerLoading")); drop.hidden = true;
  const closing = app.close().catch(() => undefined);
  return {owned, signal: controller.signal, closing};
}
async function openBytes(bytes: Uint8Array, name: string, url: string | null, load: ReturnType<typeof beginLoad>): Promise<void> {
  if (load.owned !== generation) return;
  if (bytes.byteLength > MAX_BYTES) { failure("large"); return; }
  await load.closing;
  if (load.owned !== generation) return;
  source = createPdfUnitSource(); reportUrl = url ?? name;
  originalUrl = url; original.hidden = !url;
  // Upstream controls the password dialog, rendering, navigation, find and printing.
  try {
    app.setTitleUsingUrl(name);
    await app.open({data: bytes});
    if (load.owned !== generation) return;
    drop.hidden = true;
    const count = app.pdfDocument?.numPages ?? 0;
    updateScope();
    say(count > MAX_ANALYSIS_PAGES ? t("readerAnalysisCapped", MAX_ANALYSIS_PAGES) : "");
  } catch {
    if (load.owned === generation) { say(t("readerBadFile")); drop.hidden = false; }
  }
}
async function openFile(file: File): Promise<void> {
  // Refused before the load begins, so the document already open stays open.
  if (file.size > MAX_BYTES) { failure("large"); return; }
  const load = beginLoad();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(bytes, file.name, null, load);
  } catch { if (load.owned === generation) failure("type"); }
}
async function openTicket(ticket: string, src: string): Promise<void> {
  const load = beginLoad(), began = performance.now();
  const held = await claimPdfBytes(ticket, load.signal);
  performance.measure("anagram-handoff", {start: began});
  if (load.owned !== generation) return;
  const url = new URL(location.href); url.searchParams.delete("ticket");
  history.replaceState(null, "", url);
  originalUrl = src; original.hidden = false;
  if ("failure" in held) { failure(held.failure); return; }
  await openBytes(held.bytes, pdfNameFromUrl(src), src, load);
}
function documentAddress(raw: string | null): string | null {
  return raw ? safePdfSource(raw)?.href ?? null : null;
}

async function main(): Promise<void> {
  document.getElementById("choose")!.textContent = t("readerChoose");
  document.getElementById("dropLabel")!.textContent = t("readerDrop");
  original.querySelector("span")!.textContent = t("readerOpenOriginal");
  original.title = t("readerOpenOriginal"); original.setAttribute("aria-label", t("readerOpenOriginal"));
  analyze.title = t("actionAnalyzePdf"); analyze.setAttribute("aria-label", t("actionAnalyzePdf"));
  document.getElementById("choose")!.addEventListener("click", () => fileInput.click());
  // Capture before the upstream file handlers, converting local files into bytes ourselves.
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !["file", "fileInput"].includes(input.id)) return;
    event.stopImmediatePropagation();
    const file = input.files?.[0]; input.value = "";
    if (file && app) void openFile(file);
  }, true);
  document.addEventListener("dragover", (event) => { event.preventDefault(); }, true);
  document.addEventListener("drop", (event) => {
    event.preventDefault(); event.stopImmediatePropagation();
    const file = event.dataTransfer?.files?.[0];
    if (file && app) void openFile(file);
  }, true);
  original.addEventListener("click", async () => {
    const url = originalUrl;
    if (!url) return;
    try {
      const reply = await sendDocumentMessage({action: ACTIONS.PDF_PASS_ONCE, url});
      if (reply && typeof reply === "object" && "ok" in reply && reply.ok === true && originalUrl === url) location.href = url;
      else failure("read");
    } catch { failure("read"); }
  });
  analyze.addEventListener("click", () => { started = true; orchestrator?.rescan(); orchestrator?.openPanel(); });
  app = await startViewer();
  app.eventBus.on("textlayerrendered", (event) => { void rendered(event.source); });
  // Upstream find replaces text nodes inside item spans; rebuild ownership after its listeners finish.
  let refreshQueued = false;
  app.eventBus.on("updatetextlayermatches", () => {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; if (started) orchestrator?.rescan(); });
  });
  const params = new URL(location.href).searchParams;
  const src = documentAddress(params.get("src")), ticket = params.get("ticket");
  originalUrl = src; original.hidden = !src;
  if (src && ticket) await openTicket(ticket, src);
  else {
    drop.hidden = false;
    if (params.has("err")) failure(params.get("err")!);
    else if (src) say(t("readerReloadRequired"));
  }
}
void main().catch(() => { say(t("readerBadFile")); drop.hidden = false; });
let resumeAfterPageShow = false;
window.addEventListener("pagehide", (event) => {
  ++generation; controller?.abort(); orchestrator?.stop(); cancelDocumentSession();
  resumeAfterPageShow = event.persisted && started;
  if (!event.persisted) void app?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && resumeAfterPageShow) orchestrator?.start();
  resumeAfterPageShow = false;
});

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse): undefined => {
  const msg = message as ControlMessage;
  if (!msg || typeof msg !== "object") return;
  const live = orchestrator;
  switch (msg.action) {
    case ACTIONS.RESCAN: case ACTIONS.ANALYZE_PAGE: started = true; live?.rescan(); break;
    case ACTIONS.SET_ENABLED: started = msg.value; if (msg.value) live?.start(); else live?.stop(); break;
    case ACTIONS.GET_TAB_STATE: {
      const state: TabState = {enabled: started, hostname: location.hostname, scored: live?.scoredCount() ?? 0,
        flagged: live?.flaggedCount() ?? 0, unsupported: live?.unsupportedCount() ?? 0, unavailable: live?.unavailableCount() ?? 0};
      sendResponse(state); break;
    }
    case ACTIONS.TOGGLE_OVERLAY: live?.toggle(); break;
    case ACTIONS.OPEN_PANEL: live?.openPanel(); break;
    case ACTIONS.NEXT_FLAGGED: live?.jumpFlagged(1); break;
    case ACTIONS.PREV_FLAGGED: live?.jumpFlagged(-1); break;
    case ACTIONS.RETRY_BACKEND: live?.retryBackend(); break;
    case ACTIONS.CACHE_CLEARED: live?.forgetCached(); break;
    case ACTIONS.TEARDOWN: started = false; live?.stop(); break;
  }
});
