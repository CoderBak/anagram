// entrypoints/reader/main.ts — the PDF reading mode.
//
// Browsers hand a PDF to a built-in viewer that exposes no DOM text, so there is
// nothing for the walker to walk. The answer is the same one Google Docs gets
// (lib/docsOverlay.ts): rebuild the document as ordinary HTML on a page of our own and
// run the NORMAL pipeline over it — same chips, same underlines, same ball, same panel,
// same report. pdf.js supplies the text runs, lib/pdf/reflow.ts puts the paragraphs back
// together, and this file is only the page: fetch, render, and start the orchestrator.
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
import { MARK_ATTR } from "../../lib/types";
import { openPdf, PdfOpenError, type PdfDocument } from "../../lib/pdf/extract";
import { reflowPdf, type PdfPageText, type ReflowBlock } from "../../lib/pdf/reflow";
import { pdfNameFromUrl } from "../../lib/pdf/source";
import { createLogger } from "../../lib/log";

const log = createLogger("reader");

/** A PDF larger than this is a scan or a book of images — not something to read here. */
const MAX_BYTES = 100 * 1024 * 1024;
/** Beyond this many pages the reader stops and says so; nothing here is worth a freeze. */
const MAX_PAGES = 300;
/**
 * Pages extracted before the first paint. Large enough that running heads have repeated
 * often enough to be recognised (so the opening pages are not rendered with furniture in
 * them), small enough that a book is on screen in well under a second.
 */
const FIRST_BATCH = 24;
/** Blocks appended per idle slice — a long document arrives without ever blocking. */
const RENDER_SLICE = 25;

const titleEl = document.getElementById("title") as HTMLElement;
const subtitleEl = document.getElementById("subtitle") as HTMLElement;
const originalEl = document.getElementById("original") as HTMLButtonElement;
const noticeEl = document.getElementById("notice") as HTMLElement;
const dropEl = document.getElementById("drop") as HTMLElement;
const chooseEl = document.getElementById("choose") as HTMLButtonElement;
const fileEl = document.getElementById("file") as HTMLInputElement;
const paperEl = document.getElementById("paper") as HTMLElement;

let orchestrator: Orchestrator | null = null;
/** The blocks currently on the paper, so a later flush can reconcile against them. */
let rendered: { block: ReflowBlock; el: HTMLElement }[] = [];
/** Bumped by every new document so a slow render of the previous one stops painting. */
let generation = 0;

function say(text: string): void {
  noticeEl.textContent = text;
}

function idle(run: () => void): void {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === "function") ric(run, { timeout: 500 });
  else setTimeout(run, 0);
}

// ---- rendering ------------------------------------------------------------------------

/**
 * One block as an element. Text is set with textContent and never as markup: the file is
 * untrusted, and the only thing the reader takes from it is words.
 */
function elementFor(block: ReflowBlock): HTMLElement {
  const el = document.createElement(block.kind === "heading" ? "h2" : "p");
  el.textContent = block.text;
  return el;
}

/** The "— 3 —" rule between pages. Marked as ours, so it is never a scored paragraph. */
function pageMark(page: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "pagemark";
  el.setAttribute(MARK_ATTR, "host");
  el.textContent = `— ${page} —`;
  return el;
}

/**
 * Put `blocks` on the paper, reconciling with what is already there. Re-running the
 * reflow over more pages can extend the last paragraph (it continued onto a page we had
 * not read yet) or reclassify a block, so blocks that changed have their element updated
 * — the orchestrator then re-scores those and only those — and the rest are left alone,
 * chips and all. Appending happens in idle slices so a 300-page book never blocks.
 */
function paint(blocks: ReflowBlock[], seq: number): void {
  for (let i = 0; i < rendered.length && i < blocks.length; i++) {
    const was = rendered[i].block;
    const now = blocks[i];
    if (was.text === now.text && was.kind === now.kind) continue;
    const el = elementFor(now);
    rendered[i].el.replaceWith(el);
    rendered[i] = { block: now, el };
  }
  for (const extra of rendered.slice(blocks.length)) extra.el.remove();
  rendered = rendered.slice(0, blocks.length);

  const append = (): void => {
    if (seq !== generation) return;
    const until = Math.min(rendered.length + RENDER_SLICE, blocks.length);
    const frag = document.createDocumentFragment();
    for (let i = rendered.length; i < until; i++) {
      const block = blocks[i];
      const previous = i > 0 ? blocks[i - 1].page : block.page;
      if (block.page > previous) frag.append(pageMark(block.page));
      const el = elementFor(block);
      frag.append(el);
      rendered.push({ block, el });
    }
    paperEl.append(frag);
    if (rendered.length < blocks.length) idle(append);
  };
  append();
}

// ---- reading a document ----------------------------------------------------------------

/** Start (or restart) the pipeline over the paper. */
async function startPipeline(reportUrl: string): Promise<void> {
  orchestrator?.stop();
  orchestrator = createOrchestrator(null, { mountFab: true, reportUrl });
  // A reader who turned Anagram off everywhere did not ask for this page to be scored.
  if (await enabledForSite(location.hostname)) orchestrator.start();
}

/**
 * Read a document end to end: extract, reflow, render. The first pages are painted as
 * soon as they are out, and the rest join as they are extracted — the reflow is re-run
 * over everything read so far each time, because running heads and paragraphs that
 * continue across a page break can only be judged with the neighbouring pages in hand.
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
  paperEl.hidden = false;
  paperEl.replaceChildren();
  rendered = [];
  say(capped ? t("readerCapped", MAX_PAGES) : "");

  const pages: PdfPageText[] = [];
  let started = false;
  for (let n = 1; n <= pageCount; n++) {
    if (seq !== generation) return;
    try {
      pages.push(await doc.page(n));
    } catch (e) {
      log.warn("page", n, "could not be read", e);
    }
    const last = n === pageCount;
    if (!last && (n < FIRST_BATCH || n % FIRST_BATCH !== 0)) continue;

    const blocks = reflowPdf(pages);
    paint(blocks, seq);
    if (!started && blocks.length > 0) {
      started = true;
      await startPipeline(source.url ?? name);
    }
  }
  if (seq !== generation) return;

  if (rendered.length === 0) {
    say(t("readerNoText"));
    paperEl.hidden = true;
  }
}

/** Open bytes we already hold. Everything that can go wrong ends in one short line. */
async function open(bytes: Uint8Array, source: { name: string; url: string | null }): Promise<void> {
  if (bytes.byteLength > MAX_BYTES) {
    say(t("readerTooLarge"));
    return;
  }
  say("");
  let doc: PdfDocument;
  try {
    doc = await openPdf(bytes);
  } catch (e) {
    const failure = e instanceof PdfOpenError ? e.failure : "failed";
    say(failure === "password" ? t("readerEncrypted") : t("readerBadFile"));
    dropEl.hidden = false;
    return;
  }
  try {
    await read(doc, source);
  } finally {
    doc.close();
  }
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

function wire(src: string | null): void {
  originalEl.addEventListener("click", () => {
    if (src) location.href = src;
  });
  chooseEl.addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", () => {
    const file = fileEl.files?.[0];
    if (file) void openFromFile(file);
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
