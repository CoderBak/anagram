// entrypoints/reader/main.ts — the PDF reading mode.
//
// Browsers hand a PDF to a built-in viewer that exposes no DOM text, so there is nothing
// for the walker to walk. The answer is a page of our own that shows THE REAL PAGES —
// drawn by pdf.js, with their figures, mathematics, fonts and layout intact — and runs the
// NORMAL pipeline over them: same chips, same underlines, same ball, same panel, same
// report. Anagram annotates the original; it never replaces or reformats it.
//
// Three pieces meet here and none of them knows about the others:
//   entrypoints/reader/viewer.ts draws the pages and owns the zoom;
//   lib/pdf/reflow.ts rebuilds the paragraphs and says where each of them was set;
//   lib/pdf/units.ts turns those into ordinary Units over the text layer's own nodes.
// The reconstruction is INVISIBLE. Its only jobs are to decide what the model reads as one
// paragraph and where that paragraph ends on the page.
//
// Content scripts are not injected into extension pages, so the orchestrator is created
// here directly. Everything it needs works from an extension page: runtime messaging to
// the service worker, the settings watches, the language gate, the CSS Highlight styles
// and the floating ball.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { t, tn } from "../../lib/i18n";
import { createOrchestrator, type Orchestrator } from "../../lib/capture/orchestrator";
import { enabledForSite } from "../../lib/settings/settings";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { ControlMessage, TabState } from "../../lib/messaging/protocol";
import type { Unit } from "../../lib/types";
import { setRangeLocator } from "../../lib/render/highlight";
import { openPdf, PdfOpenError, type PdfDocument } from "../../lib/pdf/extract";
import { reflowPdf, type PdfPageText } from "../../lib/pdf/reflow";
import { createPdfUnitSource, type PdfUnitSource } from "../../lib/pdf/units";
import { pdfNameFromUrl } from "../../lib/pdf/source";
import { createViewer, type PageView, type Viewer } from "./viewer";
import { placeChip } from "./chips";
import { createLogger } from "../../lib/log";

const log = createLogger("reader");

/** A PDF larger than this is a scan or a book of images — not something to read here. */
const MAX_BYTES = 100 * 1024 * 1024;
/** Beyond this many pages the reader stops and says so; nothing here is worth a freeze. */
const MAX_PAGES = 300;
/**
 * Pages read before the paragraphs are rebuilt for the first time. Large enough that
 * running heads have repeated often enough to be recognised (so the opening pages are not
 * scored with furniture in them), small enough that a book is being read in under a second.
 */
const FIRST_BATCH = 24;

const titleEl = document.getElementById("title") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
const originalEl = document.getElementById("original") as HTMLButtonElement;
const noticeEl = document.getElementById("notice") as HTMLElement;
const dropEl = document.getElementById("drop") as HTMLElement;
const chooseEl = document.getElementById("choose") as HTMLButtonElement;
const fileEl = document.getElementById("file") as HTMLInputElement;
const pagesEl = document.getElementById("pages") as HTMLElement;
const zoomEl = document.getElementById("zoom") as HTMLElement;
const zoomInEl = document.getElementById("zoomIn") as HTMLButtonElement;
const zoomOutEl = document.getElementById("zoomOut") as HTMLButtonElement;
const zoomLevelEl = document.getElementById("zoomLevel") as HTMLButtonElement;

let orchestrator: Orchestrator | null = null;
let viewer: Viewer | null = null;
/** The document on screen. It stays open: every canvas drawn is a question to its worker. */
let current: PdfDocument | null = null;
/** Bumped by every new document so a slow read of the previous one stops painting. */
let generation = 0;
/** The document's paragraphs have been handed out already in this task (see collect). */
let answered = false;

function say(text: string): void {
  noticeEl.textContent = text;
}

function idle(run: () => void): void {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === "function") ric.call(window, run, { timeout: 500 });
  else setTimeout(run, 0);
}

/** Give the browser the main thread back between two pages. */
const breathe = (): Promise<void> => new Promise((r) => idle(() => r()));

// ---- reading a document ----------------------------------------------------------------

/**
 * Start (or restart) the pipeline over the document. The units come from the
 * reconstruction rather than from a DOM walk, the marks from the runs each paragraph was
 * set in, and the chips from the white space at the end of its last line — three hooks,
 * and the rest of the pipeline never learns that this is a PDF at all.
 */
async function startPipeline(reportUrl: string, source: PdfUnitSource, view: Viewer): Promise<void> {
  orchestrator?.stop();
  setRangeLocator((unit, spans) => source.ranges(unit, spans));
  orchestrator = createOrchestrator(null, {
    mountFab: true,
    reportUrl,
    // A PDF's units come from the DOCUMENT, not from a subtree, so the first answer of a
    // mutation burst is the whole answer: the orchestrator asks once per scan root and
    // rebuilding the document's paragraphs ten times over would say the same thing ten
    // times. The rest of the task is answered with nothing; the next task starts fresh.
    collect: (_root, claimFilter) => {
      if (answered) return [];
      answered = true;
      queueMicrotask(() => {
        answered = false;
      });
      return source.collect(claimFilter);
    },
    placeBadge: (unit: Unit, host: HTMLElement) => placeChip(view, unit, host),
  });
  // A reader who turned Anagram off everywhere did not ask for this page to be scored.
  if (await enabledForSite(location.hostname)) orchestrator.start();
}

/**
 * Read a document end to end: page by page, each one shown as soon as it is out and its
 * text layer built before the next is asked for. The reflow is re-run over everything read
 * so far at each batch boundary, because running heads and paragraphs that continue across
 * a page break can only be judged with the neighbouring pages in hand — and a paragraph
 * that comes back unchanged keeps the unit, the chip and the verdict it already had.
 */
async function read(doc: PdfDocument, source: { name: string; url: string | null }): Promise<void> {
  const seq = ++generation;
  // The tab, and therefore the copied report's heading, is named after the DOCUMENT —
  // the reader page's own address says nothing to whoever reads the report.
  const name = doc.title ?? source.name;
  document.title = name;
  titleEl.textContent = name;
  titleEl.title = name;
  const capped = doc.numPages > MAX_PAGES;
  const pageCount = capped ? MAX_PAGES : doc.numPages;
  subtitleEl.textContent = tn("readerPages", doc.numPages);
  originalEl.hidden = source.url === null;
  dropEl.hidden = true;
  pagesEl.hidden = false;
  pagesEl.classList.add("reading");
  zoomEl.hidden = false;
  say(capped ? t("readerCapped", MAX_PAGES) : "");

  const view = createViewer(pagesEl);
  viewer = view;
  view.onScale((s) => {
    zoomLevelEl.textContent = `${Math.round(s * 100)}%`;
  });
  const unitSource = createPdfUnitSource();

  const texts: PdfPageText[] = [];
  let started = false;
  let fitted = false;
  for (let n = 1; n <= pageCount; n++) {
    if (seq !== generation) return;
    let added: PageView | null = null;
    try {
      const page = await doc.page(n);
      added = await view.add(page);
      texts.push(page.text);
    } catch (e) {
      log.warn("page", n, "could not be read", e);
    }
    if (seq !== generation) return;
    if (added) {
      unitSource.setPage(n, { layer: added.layer, spans: added.spans });
      // The first page decides the zoom, so the document is at its reading size from the
      // moment anything of it is on screen.
      if (!fitted) {
        fitted = true;
        view.fitWidth();
      }
    }

    const last = n === pageCount;
    if (!last && (n < FIRST_BATCH || n % FIRST_BATCH !== 0)) {
      await breathe();
      continue;
    }
    unitSource.setBlocks(reflowPdf(texts));
    if (!started && texts.some((p) => p.items.length > 0)) {
      started = true;
      await startPipeline(source.url ?? name, unitSource, view);
    }
    await breathe();
  }
  if (seq !== generation) return;
  // The document is read to the end, and that is a state worth saying out loud: it is how
  // a reader (and a test) knows the paragraph count will not change again, and the class
  // change is also the mutation that has the pipeline take in whatever the LAST reflow
  // added — the pages arriving under it are what does that for every batch before it.
  pagesEl.classList.remove("reading");
  if (!started) say(t("readerNoText"));
}

/** Open bytes we already hold. Everything that can go wrong ends in one short line. */
async function open(bytes: Uint8Array, source: { name: string; url: string | null }): Promise<void> {
  if (bytes.byteLength > MAX_BYTES) {
    say(t("readerTooLarge"));
    return;
  }
  say("");
  reset();
  let doc: PdfDocument;
  try {
    doc = await openPdf(bytes);
  } catch (e) {
    const failure = e instanceof PdfOpenError ? e.failure : "failed";
    say(failure === "password" ? t("readerEncrypted") : t("readerBadFile"));
    dropEl.hidden = false;
    return;
  }
  // The document stays OPEN for as long as its pages are on screen: a canvas is drawn
  // when the reader scrolls to it and again at every zoom, and both ask the worker. It is
  // closed when another document replaces it (reset, below).
  current = doc;
  await read(doc, source);
}

/** Take down whatever the previous document left on screen. */
function reset(): void {
  generation++;
  orchestrator?.stop();
  orchestrator = null;
  setRangeLocator(null);
  viewer?.destroy();
  viewer = null;
  current?.close();
  current = null;
  pagesEl.hidden = true;
  pagesEl.classList.remove("reading");
  zoomEl.hidden = true;
}

/**
 * Fetch the PDF the reader was opened for. The <all_urls> host permission makes the
 * cross-origin request possible and `credentials: "include"` carries the reader's own
 * cookies, so a paper behind a library login loads exactly as it does in a tab. A
 * file:// URL only works where the user ticked "Allow access to file URLs"; where they
 * did not, the fetch simply fails and the drop zone is the way in.
 */
async function openFromUrl(src: string): Promise<void> {
  say(t("readerLoading"));
  titleEl.textContent = pdfNameFromUrl(src);
  originalEl.hidden = false;
  try {
    const resp = await fetch(src, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    await open(bytes, { name: pdfNameFromUrl(src), url: src });
  } catch (e) {
    log.warn("could not fetch", src, e);
    say(t("readerFetchFailed"));
    dropEl.hidden = false;
  }
}

async function openFromFile(file: File): Promise<void> {
  say("");
  const bytes = new Uint8Array(await file.arrayBuffer());
  await open(bytes, { name: file.name, url: null });
}

// ---- the page ---------------------------------------------------------------------------

/**
 * Leave for the PDF itself — the button in the bar, and the way out of every line below
 * that says the file could not be read. With "Open PDFs in Anagram" on, the tab we are
 * about to send there would be sent straight back here, so the worker is asked first to
 * let this one load through, and only then does the tab go.
 */
async function openOriginal(src: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ action: ACTIONS.PDF_PASS_ONCE, url: src });
  } catch {
    // The worker did not answer. The navigation still happens: at worst the reading mode
    // opens again, which is where the reader already is.
  }
  location.href = src;
}

function wire(src: string | null): void {
  originalEl.addEventListener("click", () => {
    if (src) void openOriginal(src);
  });
  chooseEl.addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", () => {
    const file = fileEl.files?.[0];
    if (file) void openFromFile(file);
  });
  zoomInEl.addEventListener("click", () => viewer?.step(1));
  zoomOutEl.addEventListener("click", () => viewer?.step(-1));
  zoomLevelEl.addEventListener("click", () => viewer?.fitWidth());
  // The browser's own zoom keys, answered by the document rather than by the window: a
  // PDF's "bigger" means a bigger page, not a bigger user interface.
  window.addEventListener("keydown", (e) => {
    if (!viewer || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "+" || e.key === "=") viewer.step(1);
    else if (e.key === "-" || e.key === "_") viewer.step(-1);
    else if (e.key === "0") viewer.fitWidth();
    else return;
    e.preventDefault();
  });
  // Dropping onto a document that is already loaded replaces it — the same gesture
  // either way, so there is nothing to learn.
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropEl.classList.add("over");
  });
  document.addEventListener("dragleave", () => dropEl.classList.remove("over"));
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (file) void openFromFile(file);
  });
}

function main(): void {
  localizePage();
  followSystemTheme();
  const src = new URL(location.href).searchParams.get("src");
  wire(src);
  if (src) {
    void openFromUrl(src);
  } else {
    subtitleEl.textContent = "";
    dropEl.hidden = false;
  }
}

main();

// The popup and the keyboard commands address the ACTIVE TAB, and an extension page
// sitting in a tab receives those messages itself — so the reader answers them exactly
// as a content script would, and the popup's counts, Rescan and the flagged walk work
// here too.
browser.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response?: unknown) => void): boolean | undefined => {
    const msg = message as ControlMessage;
    if (!msg || typeof msg !== "object" || !("action" in msg)) return;
    const live = orchestrator;

    switch (msg.action) {
      case ACTIONS.RESCAN:
        live?.rescan();
        return;

      case ACTIONS.SET_ENABLED:
        if (msg.value) live?.start();
        else live?.stop();
        return;

      case ACTIONS.GET_TAB_STATE: {
        const state: TabState = {
          enabled: live !== null,
          hostname: location.hostname,
          scored: live?.scoredCount() ?? 0,
          flagged: live?.flaggedCount() ?? 0,
          unsupported: live?.unsupportedCount() ?? 0,
          unavailable: live?.unavailableCount() ?? 0,
        };
        sendResponse(state);
        return; // synchronous response
      }

      case ACTIONS.TOGGLE_OVERLAY:
        live?.toggle();
        return;

      case ACTIONS.OPEN_PANEL:
        live?.openPanel();
        return;

      case ACTIONS.NEXT_FLAGGED:
        live?.jumpFlagged(1);
        return;

      case ACTIONS.PREV_FLAGGED:
        live?.jumpFlagged(-1);
        return;

      case ACTIONS.RETRY_BACKEND:
        live?.retryBackend();
        return;

      case ACTIONS.CACHE_CLEARED:
        live?.forgetCached();
        return;

      case ACTIONS.ANALYZE_PAGE:
        // The reader keeps its orchestrator even where a site rule stopped it, and rescan()
        // starts a stopped one — so this one call covers "analyze it here" and "again".
        live?.rescan();
        return;

      case ACTIONS.TEARDOWN:
        live?.stop();
        return;

      default:
        return;
    }
  },
);
