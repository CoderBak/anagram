import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { lazyVendor, loadPdfjs } from "../../lib/lazy";
import { messageLocale, t } from "../../lib/i18n";

/** The small upstream API surface the Anagram adapter uses. Rendering stays upstream. */
export interface UpstreamPage {
  id: number;
  div: HTMLDivElement;
  pdfPage: PDFPageProxy | null;
  viewport: { scale: number; width: number; height: number };
  textLayer: {div: HTMLDivElement; highlighter: {textDivs: HTMLElement[] | null} | null} | null;
}
export interface PdfApplication {
  initializedPromise: Promise<void>;
  pdfDocument: PDFDocumentProxy | null;
  pdfLoadingTask: {destroy(): Promise<void>} | null;
  pdfViewer: {getPageView(index: number): UpstreamPage; currentScaleValue: string};
  eventBus: {on(name: string, listener: (event: {source?: UpstreamPage; pageNumber?: number; pageIndex?: number}) => void): void};
  open(args: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  _initializeAutoPrint(): Promise<void>;
  setTitleUsingUrl(url: string): void;
  downloadManager: {openOrDownloadData(data: Uint8Array, filename: string): void; downloadData(data: Uint8Array, filename: string, type: string): void};
}
interface Options {setAll(options: Record<string, unknown>): void}
interface ViewerModule {PDFViewerApplication: PdfApplication; PDFViewerApplicationOptions: Options}
const asset = (path: string): string => browser.runtime.getURL(`/vendor/${path}` as PublicPath);

export const VIEWER_OPTIONS = {
  defaultUrl: "", disablePreferences: true, disableHistory: true,
  enableScripting: false, pdfBugEnabled: false, pdfBug: false,
  enableAltText: false, enableAltTextModelDownload: false, enableGuessAltText: false,
  enableNewAltTextWhenAddingImage: false, enableFakeMLManager: false,
  enableXfa: false, annotationEditorMode: -1, enableSignatureEditor: false,
  enableComment: false, enableMerge: false, enableSplitMerge: false,
  externalLinkTarget: 2, externalLinkRel: "noopener noreferrer",
  defaultZoomValue: "", maxCanvasPixels: 16 * 1024 * 1024,
} as const;

/**
 * What the upstream page leaves unsaid for assistive technology. The page is in the
 * language pdf.js draws its toolbar in, which is the browser's; Anagram's own controls are
 * in Anagram's, English where it has no translation. The scrolling page area takes focus,
 * so it is named (it is the page's main landmark, scripts/pdfjsViewer.mjs). The page field
 * and the zoom menu are named only by a tooltip that pdf.js localizes: each gets the same
 * words as its label, in whatever language pdf.js chose, whenever pdf.js sets them.
 */
function describeViewer(lang: string): void {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>('[data-anagram="host"]')) el.lang = messageLocale();
  document.getElementById("viewerContainer")?.setAttribute("aria-label", t("readerPages"));
  for (const id of ["pageNumber", "scaleSelect"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const label = (): void => { if (el.title) el.setAttribute("aria-label", el.title); };
    new MutationObserver(label).observe(el, { attributeFilter: ["title"] });
    label();
  }
}

/** Configure before upstream run() reads options or opens its default/query-string URL. */
export async function startViewer(): Promise<PdfApplication> {
  const lang = browser.i18n.getUILanguage();
  describeViewer(lang);
  const url = new URL(location.href);
  // Generic PDF.js accepts ?file=. Only verified tickets and user-picked bytes may open here.
  url.searchParams.delete("file");
  history.replaceState(null, "", url);
  await loadPdfjs();
  document.addEventListener("webviewerloaded", () => {
    const globals = window as unknown as ViewerModule;
    globals.PDFViewerApplicationOptions.setAll({
      ...VIEWER_OPTIONS,
      localeProperties: {lang},
      workerSrc: asset("pdf.worker.mjs"), imageResourcesPath: asset("pdfjs/web/images/"),
      cMapUrl: asset("cmaps/"), cMapPacked: true,
      standardFontDataUrl: asset("standard_fonts/"), wasmUrl: asset("wasm/"), iccUrl: asset("iccs/"),
    });
    const app = globals.PDFViewerApplication;
    // Opening untrusted bytes must never trigger printing through an OpenAction or JS heuristic.
    app._initializeAutoPrint = async () => undefined;
    const open = app.open.bind(app);
    app.open = async (args) => {
      if (!(args.data instanceof Uint8Array) || "url" in args) throw new Error("PDF viewer accepts verified bytes only");
      await open({...args, isEvalSupported: false, useWorkerFetch: false, verbosity: 0});
    };
  }, {once: true});
  const {PDFViewerApplication: app} = await lazyVendor<ViewerModule>("pdfjs/web/viewer.mjs");
  await app.initializedPromise;
  // Attachments are explicit downloads; never open a generic viewer URL with an unchecked source.
  app.downloadManager.openOrDownloadData = (data, name) => app.downloadManager.downloadData(data, name, "application/octet-stream");
  return app;
}

export interface PageView {
  n: number;
  box: HTMLElement;
  layer: HTMLElement;
  chips: HTMLElement;
  spans: (HTMLElement | undefined)[];
}
export interface Viewer {pageOf(layer: Element): PageView | undefined}

export function pageView(page: UpstreamPage): PageView | null {
  const text = page.textLayer;
  if (!text?.div.isConnected || !page.pdfPage || !Array.isArray(text.highlighter?.textDivs)) return null;
  let chips = page.div.querySelector<HTMLElement>(":scope > .anagramPdfChips");
  if (!chips) {
    chips = document.createElement("div");
    chips.className = "anagramPdfChips";
    chips.dataset.anagram = "host";
    page.div.append(chips);
  }
  return {n: page.id, box: page.div, layer: text.div, chips, spans: text.highlighter.textDivs};
}
