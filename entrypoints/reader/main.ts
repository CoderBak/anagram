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
import { openPdf, PdfOpenError, type PdfDocument, type PdfPasswordReason } from "../../lib/pdf/extract";
import { reflowPdf, type PdfPageText } from "../../lib/pdf/reflow";
import { createPdfUnitSource, type PdfUnitSource } from "../../lib/pdf/units";
import { pdfNameFromUrl, htmlTwinOf } from "../../lib/pdf/source";
import { claimPdfBytes, type HandoffFailure } from "../../lib/pdf/handoff";
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
const twinEl = document.getElementById("twin") as HTMLAnchorElement;
const passwordEl = document.getElementById("password") as HTMLFormElement;
const passwordInputEl = document.getElementById("passwordInput") as HTMLInputElement;
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
/** The document's paragraphs have been handed out already in this task (see collect). */
let answered = false;

function say(text: string): void {
  noticeEl.textContent = text;
}

// ---- who owns the view -------------------------------------------------------------------
//
// Every way into a document — a ticket, the file picker, a drop — takes a Load at its very
// FIRST line, and that Load is the only thing allowed to touch the view until the next one
// starts. Ownership is re-checked after every await, because a 300-page book on a slow disk
// can easily still be arriving when the reader drops a second file on top of it, and the
// older read must not then take the view, the title or the error line back.

interface Load {
  /** Still the current one? False from the moment another load begins. */
  owns(): boolean;
  /** Aborted when a newer load starts — the pdf.js loading task and its worker go with it. */
  signal: AbortSignal;
}

let loads = 0;
let running: AbortController | null = null;

function beginLoad(): Load {
  running?.abort();
  const controller = new AbortController();
  running = controller;
  const seq = ++loads;
  return { owns: () => seq === loads, signal: controller.signal };
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
    collect: (_root, claimFilter, options) => {
      if (answered) return [];
      answered = true;
      queueMicrotask(() => {
        answered = false;
      });
      // Grouping short paragraphs is the reader's setting as much as the page's: off, a
      // paragraph under the floor is read by nobody here either.
      return source.collect(claimFilter, options.mergeShorts);
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
async function read(doc: PdfDocument, source: { name: string; url: string | null }, load: Load): Promise<void> {
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
  if (source.url === null) twinEl.hidden = true;
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
    if (!load.owns()) return;
    let added: PageView | null = null;
    try {
      const page = await doc.page(n);
      added = await view.add(page);
      texts.push(page.text);
    } catch (e) {
      // A document closed underneath us (a newer load) ends here, quietly.
      if (!load.owns()) return;
      log.warn("page", n, "could not be read", e);
    }
    if (!load.owns()) return;
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
    // Marked, because this is the one piece of the reader whose cost grows with the
    // document: it runs over EVERYTHING read so far, once per batch. test/perf.mjs reads
    // these entries and holds the total and the worst single run to a budget.
    const startedAt = performance.now();
    unitSource.setBlocks(reflowPdf(texts));
    performance.measure("anagram-reflow", { start: startedAt });
    if (!started && texts.some((p) => p.items.length > 0)) {
      started = true;
      await startPipeline(source.url ?? name, unitSource, view);
    }
    await breathe();
  }
  if (!load.owns()) return;
  // The document is read to the end, and that is a state worth saying out loud: it is how
  // a reader (and a test) knows the paragraph count will not change again, and the class
  // change is also the mutation that has the pipeline take in whatever the LAST reflow
  // added — the pages arriving under it are what does that for every batch before it.
  pagesEl.classList.remove("reading");
  if (!started) say(t("readerNoText"));
}

/** Open bytes we already hold. Everything that can go wrong ends in one short line. */
async function open(bytes: Uint8Array, source: { name: string; url: string | null }, load: Load): Promise<void> {
  if (bytes.byteLength > MAX_BYTES) {
    fail("large");
    return;
  }
  say("");
  reset();
  let doc: PdfDocument;
  try {
    doc = await openPdf(bytes, { signal: load.signal, password: askPassword });
  } catch (e) {
    // A superseded load says nothing and touches nothing — not even the password field,
    // which by now may be the NEW load's question waiting for an answer.
    if (!load.owns()) return;
    hidePassword();
    const failure = e instanceof PdfOpenError ? e.failure : "failed";
    // An aborted open is a load somebody replaced on purpose: it says nothing at all.
    if (failure === "aborted") return;
    say(failure === "password" ? t("readerEncrypted") : t("readerBadFile"));
    dropEl.hidden = false;
    return;
  }
  if (!load.owns()) {
    // A newer load arrived while pdf.js was parsing. It already tore the view down; this
    // document has nowhere to go, so it is closed rather than left holding a worker.
    doc.close();
    return;
  }
  hidePassword();
  // The document stays OPEN for as long as its pages are on screen: a canvas is drawn
  // when the reader scrolls to it and again at every zoom, and both ask the worker. It is
  // closed when another document replaces it (reset, below).
  current = doc;
  await read(doc, source, load);
}

/** Take down whatever the previous document left on screen. */
function reset(): void {
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
 * The three ways a handoff can produce nothing, each in the line that already exists.
 * The drop zone comes with it, since handing the file over is the way past all three —
 * but not over a document already on screen: a file that was too large to open is no
 * reason to clutter the one the reader is in the middle of.
 */
function fail(failure: HandoffFailure | string): void {
  say(failure === "large" ? t("readerTooLarge") : failure === "type" ? t("readerBadFile") : t("readerFetchFailed"));
  if (current === null) dropEl.hidden = false;
}

/**
 * Take the bytes the service worker is holding for this tab. NOTHING is fetched here: the
 * document was re-read by the tab that was showing it and relayed through the worker
 * (lib/pdf/handoff.ts), so the reading mode never makes a request of its own — which is
 * what lets the extension be unable to reach anything but the local daemon.
 */
async function openFromTicket(ticket: string, src: string): Promise<void> {
  const load = beginLoad();
  say(t("readerLoading"));
  // Marked for the same reason the reflow is: this is where a large document's bytes
  // cross the last hop, and it is the number to look at if opening one ever feels slow.
  const startedAt = performance.now();
  const held = await claimPdfBytes(ticket, load.signal);
  performance.measure("anagram-handoff", { start: startedAt });
  if (!load.owns()) return;
  // The ticket is spent, and a spent one in the address bar only invites a reload that
  // cannot work. What stays is the document's own address, which is all `src` is for.
  forgetTicket(src);
  if (!held) {
    leaveForOriginal(src);
    return;
  }
  clearBounce();
  await open(held.bytes, { name: pdfNameFromUrl(src), url: src }, load);
}

/** Drop the ticket from the address without touching anything else about it. */
function forgetTicket(src: string): void {
  try {
    history.replaceState(null, "", `${location.pathname}?src=${encodeURIComponent(src)}`);
  } catch {
    /* an address bar that will not be rewritten changes nothing that matters */
  }
}

/**
 * A reader page with a source and no bytes: the address was pasted, the tab was reloaded,
 * or the worker was evicted before the ticket could be claimed. There is nothing to fetch
 * — so the honest answer is the document itself, which is what this tab would be showing
 * if Anagram were not installed. With "Open PDFs in Anagram" on, the ordinary route brings
 * it straight back here with real bytes.
 *
 * ONCE per source, though. If the same document lands here twice the second time is a
 * handoff that keeps failing, and a tab that ping-pongs between two addresses is worse
 * than a quiet line and the drop zone. sessionStorage is the right memory for it: per tab,
 * and gone when the tab is.
 */
const BOUNCE_KEY = "anagram.pdfBounce";

function leaveForOriginal(src: string): void {
  let last: string | null = null;
  try {
    last = sessionStorage.getItem(BOUNCE_KEY);
  } catch {
    /* no session storage — one bounce is then all there ever is */
  }
  if (last === src) {
    fail("read");
    return;
  }
  try {
    sessionStorage.setItem(BOUNCE_KEY, src);
  } catch {
    /* as above */
  }
  location.replace(src);
}

function clearBounce(): void {
  try {
    sessionStorage.removeItem(BOUNCE_KEY);
  } catch {
    /* nothing was written either */
  }
}

async function openFromFile(file: File): Promise<void> {
  const load = beginLoad();
  say("");
  // BEFORE the read, not after it: a two-gigabyte file must not be pulled into memory to
  // discover that it is too big for this page.
  if (file.size > MAX_BYTES) {
    fail("large");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!load.owns()) return;
  await open(bytes, { name: file.name, url: null }, load);
}

// ---- an encrypted document ------------------------------------------------------------------

/** Resolves the password pdf.js is waiting for, or rejects when the reader gives up. */
let pending: { resolve(password: string): void; reject(): void } | null = null;

/**
 * pdf.js stops on an encrypted file and calls back. The answer is the field in the bar:
 * type it, press Enter, and it goes straight to the library. A password the file refuses
 * marks the field invalid and empties it, and nothing else is said — the lock belongs to
 * the document, and explaining it would be our sentence on somebody else's page.
 *
 * It is never stored, never logged and never in the diagnostics: the value exists as an
 * argument on its way to pdf.js and as the field's own contents until the next keystroke.
 */
function askPassword(reason: PdfPasswordReason): Promise<string> {
  pending?.reject();
  say("");
  passwordEl.hidden = false;
  passwordInputEl.value = "";
  if (reason === "wrong") passwordInputEl.setAttribute("aria-invalid", "true");
  else passwordInputEl.removeAttribute("aria-invalid");
  passwordInputEl.focus();
  return new Promise<string>((resolve, reject) => {
    pending = { resolve, reject: () => reject(new Error("no password")) };
  });
}

function hidePassword(): void {
  pending = null;
  passwordEl.hidden = true;
  passwordInputEl.value = "";
  passwordInputEl.removeAttribute("aria-invalid");
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
  passwordEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const typed = passwordInputEl.value;
    if (typed === "" || !pending) return;
    const answer = pending;
    pending = null;
    passwordInputEl.value = "";
    answer.resolve(typed);
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

/**
 * Addresses this page may hand its tab back to. `src` only ever comes from our own worker,
 * and reader.html is not web accessible — but "the tab goes there without anybody clicking
 * anything" is a sentence that deserves a list, and `javascript:` on an extension page is
 * what the list is for.
 */
const LEAVEABLE = new Set(["http:", "https:", "file:"]);

function documentAddress(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return LEAVEABLE.has(new URL(raw).protocol) ? raw : null;
  } catch {
    return null;
  }
}

function main(): void {
  localizePage();
  followSystemTheme();
  const params = new URL(location.href).searchParams;
  const src = documentAddress(params.get("src"));
  const ticket = params.get("ticket");
  const failure = params.get("err");
  wire(src);
  if (src) {
    // `src` is a NAME here, and nothing else: the title, the way back to the document,
    // and the address of its HTML rendering where one exists. It is never fetched.
    originalEl.hidden = false;
    titleEl.textContent = pdfNameFromUrl(src);
    const twin = htmlTwinOf(src);
    if (twin) {
      twinEl.href = twin;
      twinEl.hidden = false;
    }
  }
  if (src && failure) {
    fail(failure);
  } else if (src && ticket) {
    void openFromTicket(ticket, src);
  } else if (src) {
    leaveForOriginal(src);
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
