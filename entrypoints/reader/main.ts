import { browser } from "#imports";
import { cancelDocumentSession, sendDocumentMessage } from "../../lib/access/session";
import { t } from "../../lib/i18n";
import { createOrchestrator, type Orchestrator } from "../../lib/capture/orchestrator";
import { enabledForSite, settings } from "../../lib/settings/settings";
import { ACTIONS, type ControlMessage, type TabState } from "../../lib/messaging/protocol";
import { setHighlightSurface, setRangeLocator } from "../../lib/render/highlight";
import { extractPageText, nameFonts } from "../../lib/pdf/extract";
import { readScanBatch, stopScanWorker } from "../../lib/pdf/scanWorker";
import { ReflowScan, reflowRendered } from "../../lib/pdf/reflowScan";
import type { PdfPageText } from "../../lib/pdf/reflow";
import { createStructuredReaderInSlices, type StructuredBlock, type StructuredReader } from "../../lib/pdf/structured";
import { readStructure } from "../../lib/pdf/structureWorker";
import { createPdfUnitSource, documentParagraphs, planInSlices, type DocumentParagraph, type PdfUnitSource } from "../../lib/pdf/units";
import { createPacer, inScope, readingDistance, seedFor, takeBatch, type Pacer } from "../../lib/pdf/readAhead";
import { LOW_BATTERY, READER_INPUT } from "../../lib/capture/pace";
import { MIN_WORDS } from "../../lib/dom/text";
import { pdfFileName, pdfNameFromUrl, safePdfSource } from "../../lib/pdf/source";
import { claimPdfBytes } from "../../lib/pdf/handoff";
import { hasPdfMagic, PDF_HEADER_BYTES, type PdfReopenResult } from "../../lib/pdf/sourceTransfer";
import { startViewer, pageView, type PageView, type PdfApplication, type UpstreamPage } from "./viewer";
import { placeChip } from "./chips";
import "./style.css";

const MAX_FILE_MIB = 100;
const MAX_BYTES = MAX_FILE_MIB * 1024 * 1024;
/** Zotero's structure is read for documents up to this many pages, a thousand pages at a time
 *  (lib/pdf/structureWorker.ts). Longer documents use the geometry fallback. What grows
 *  with the document is what the page keeps while it is read — the structure's reading and
 *  every page's text: at 2,445 pages, 195 MB when the structure came, rising to 311 MB as the
 *  document was read (683 MB at first, falling, while the paragraphs not read yet kept their
 *  glyphs as objects: lib/pdf/structured.ts, packPieces), 11 ms a page to the structure, and
 *  one pause of the page, 0.3 s, as it came (2026-10-04, M4). */
const MOST_STRUCTURE_PAGES = 2500;
/** Read without asking: all of them where the browser says the device has 8 GB of memory or
 *  more, 600 pages where it says 4, 300 where it says less or nothing (Firefox and Safari do
 *  not say). A longer document, up to the most, is read whole when the menu's button asks. */
function autoStructurePages(): number {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  return testCaps()?.autoPages ?? (memory === undefined || memory < 4 ? 300 : memory < 8 ? 600 : MOST_STRUCTURE_PAGES);
}
/** Test builds only: smaller caps, set by the browser tests (test/pw/scenarios-pdf.spec.mjs). */
function testCaps(): { autoPages?: number; rangePages?: number } | undefined {
  return import.meta.env.ANAGRAM_TEST_BUILD === "1" ? (globalThis as { __anagramReaderCaps?: { autoPages?: number; rangePages?: number } }).__anagramReaderCaps : undefined;
}
/** sessionStorage: the source this tab's reader opened, so that a refresh or Back can show it
 *  again. An address that only names a source — pasted, or opened by anything else — reads
 *  nothing (lib/pdf/sourceTransfer.ts). */
const HELD_SOURCE_KEY = "anagram-reader-source";
function holdSource(src: string | null): void {
  try { if (src) sessionStorage.setItem(HELD_SOURCE_KEY, src); else sessionStorage.removeItem(HELD_SOURCE_KEY); } catch {}
}
function heldSource(): string | null {
  try { return sessionStorage.getItem(HELD_SOURCE_KEY); } catch { return null; }
}
const notice = document.getElementById("notice")!;
const drop = document.getElementById("drop")!;
const original = document.getElementById("original") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const analyze = document.getElementById("anagramAnalyze") as HTMLButtonElement;
let app: PdfApplication;
let documentPassword = "";
let structureFailed = false;
let orchestrator: Orchestrator | null = null;
let source: PdfUnitSource | null = null;

let originalUrl: string | null = null;
let site: string | null = null;
let generation = 0;
let controller: AbortController | null = null;
let started = false;
/** The structured reading takes over once the worker has found the paragraphs. */
let structure: StructuredReader | null = null;
let scan: ReflowScan | null = null;
let deferredStructure = false;
const pages = new Map<number, {view: PageView; text: PdfPageText; geometry: string}>();
/** Drawn and unseen page text used by the structured reader. The geometry
 *  fallback keeps completed paragraphs and their source offsets in ReflowScan. */
const texts = new Map<number, PdfPageText>();
/** Whether pages' texts are kept: until the structure is known not to come. */
let keepTexts = true;
/** Pages the read-ahead could not read: held as empty so that it goes on, and read again
 *  when drawn. */
const unread = new Set<number>();
const retryPages: number[] = [];
/** The document's paragraphs as the reader reads them, from all the pages it has the text of
 *  or the completed paragraph groups of a requested fallback scan. */
let plan: DocumentParagraph[] | null = null;
/** Their texts: a verdict kept on any other is of a paragraph read differently since. */
let planTexts: Set<string> | null = null;
/** One across documents: how fast a pass is here is the device's, not the document's. */
let pacer: Pacer = createPacer();
/** The menu asked for the whole document where only the pages around are read on their own. */
let whole = false;
/** Paragraphs the engine, up, answered without a verdict in the background: how often, and
 *  when they may be tried again (a minute later, then two); after three tries they wait for
 *  their page to be drawn, and count as read meanwhile. */
const tried = new Map<string, {times: number; after: number}>();
const RETRY_MS = 60_000;
const MAX_TRIES = 3;
const givenUp = (text: string): boolean => (tried.get(text)?.times ?? 0) >= MAX_TRIES;
/** When the reader last scrolled, zoomed, typed or clicked. */
let lastInput = 0;
let onBattery = false;
let lowBattery = false;
/** Wakes the read-ahead loop from its rest: the setting turned on, the menu's ask, another
 *  document. */
let wake: (() => void) | null = null;
/** Whether every page is known to have no selectable text. */
let textless = false;
let foundText = false;
const hasText = (text: PdfPageText): boolean => text.items.some((item) => item.str.trim() !== "");
const extracting = new WeakSet<Element>();

// A failed replacement shares the status line with the PDF still being read.
let rejectedFile = "";
function say(text: string): void {
  const message = rejectedFile || text;
  notice.textContent = message;
  notice.hidden = !message;
}
function rejectFile(message: string): void {
  rejectedFile = message;
  say(message);
  if (!app.pdfDocument) drop.hidden = false;
}
function failure(reason: string): void {
  say(reason === "large" ? t("readerTooLarge") : reason === "type" ? t("readerBadFile") : reason === "busy" ? t("readerBusy") : t("readerFetchFailed"));
  if (!app.pdfDocument) drop.hidden = false;
}
/** The site a document came from: the host of a web address, none for a local file. */
function siteOf(url: string | null): string | null {
  const parsed = url ? safePdfSource(url) : null;
  return parsed && parsed.protocol !== "file:" ? parsed.hostname : null;
}
function rebuild(): void {
  if (!source) return;
  for (const [n, record] of pages) {
    if (!record.view.layer.isConnected) { pages.delete(n); source.removePage(n); }
  }
  const began = performance.now();
  if (structure) {
    const reader = structure;
    const blocks = reader.blocks([...texts.values()].sort((a, b) => a.page - b.page));
    source.setBlocks(blocks);
    plan = documentParagraphs(blocks, (block) => reader.pagesOf(block as StructuredBlock));
    planTexts = new Set(plan.map((p) => p.text));
  } else {
    const drawn = [...pages.values()].map(({text}) => text).sort((a, b) => a.page - b.page);
    source.setBlocks(scan ? scan.visible(drawn) : reflowRendered(drawn));
    if (scan) { plan = scan.plan; planTexts = scan.done && !unread.size ? scan.texts : null; }
  }
  performance.measure(structure ? "anagram-structured" : "anagram-reflow", {start: began});
}
/** A cover may be an image even when the following pages contain paragraphs. */
function updateReadability(): void {
  if (!pages.size) return;
  if (foundText || plan?.length) {
    textless = false;
    say("");
    return;
  }
  const total = app.pdfDocument?.numPages;
  textless = !unread.size && (scan?.done === true || pages.size === total || texts.size === total);
  say(t(textless ? "readerNoText" : "readerNoPageText"));
}
/**
 * Ask the worker for the document's structure and switch to it when it comes. A paper
 * takes well under a second; a long book takes a few, during which the reflow's chips
 * are already up, and the switch re-collects the units — the verdicts of paragraphs
 * whose text did not change come straight back from the cache.
 */
async function readWholeDocument(count: number, owned: number, signal: AbortSignal, asked = false): Promise<boolean> {
  // The explicit whole-document action can still read the pages with the fallback.
  const without = (): false => {
    if (owned === generation) { keepTexts = false; askable = true; texts.clear(); unread.clear(); }
    return false;
  };
  if (count > MOST_STRUCTURE_PAGES || !(await settings.pdfStructure.getValue())) {
    if (owned === generation) documentPassword = "";
    return without();
  }
  if (count > autoStructurePages() && !asked) {
    // The menu offers to read it whole (scopeNote).
    if (owned === generation) deferredStructure = true;
    return without();
  }
  if (owned !== generation) return false;
  try {
    // Made, and every paragraph of the document read and planned a first time, a few
    // milliseconds at a time (lib/slices.ts): at 300 pages that was half a second of the main
    // thread in two pieces, as the reader started reading. The reader keeps the text of every
    // page it has read for as long as the document is open; the structure itself is let go as
    // soon as the reader is made, not kept here until the paragraphs are planned.
    const bytes = await app.pdfDocument!.getData();
    if (owned !== generation || signal.aborted) return false;
    const reader = await readStructure(bytes, count, signal, testCaps()?.rangePages, documentPassword)
      .then((result) => (owned === generation ? createStructuredReaderInSlices(result, {pagesStay: true}) : null));
    if (!reader || owned !== generation) return false;
    await readAround(pages.keys(), owned);
    if (owned !== generation) return false;
    await planInSlices(await reader.blocksInSlices([...texts.values()].sort((a, b) => a.page - b.page)), MIN_WORDS);
    if (owned !== generation) return false;
    structure = reader;
    rebuild();
    updateReadability();
    if (started) orchestrator?.refresh();
    return true;
  } catch {
    if (owned === generation && !signal.aborted) structureFailed = true;
    return without();
  } finally {
    if (owned === generation) documentPassword = "";
  }
}
/** Pages read in the background change the paragraphs of their neighbours on screen: read
 *  the paragraphs again. */
function replan(): void {
  rebuild();
  updateReadability();
  if (started) orchestrator?.refresh();
}

/** How much of the document has a verdict, in paragraphs: the structure names every one of
 *  them from the start, while a page of references or figures has none to count. */
function share(): { done: number; of: number; left: number } {
  if (!plan || !orchestrator) return { done: 0, of: 0, left: 0 };
  let done = 0, left = 0;
  for (const p of plan) {
    if (orchestrator.knows(p.text) || givenUp(p.text)) done++;
    else left += p.text.length;
  }
  return { done, of: plan.length, left };
}

/** The menu's report, while some of the document is not read: how much is, and, where only
 *  the pages around are read on their own, the button that reads the rest. */
function scopeNote(read: number): string {
  const total = app.pdfDocument?.numPages ?? 0;
  if (!plan) {
    // Asked for: the paragraphs of the whole document are on their way.
    if (askedWhole) return t("readerReading", "0");
    const ask = aheadOn && askable && total > 1 && (read < total || unread.size > 0);
    if (ask !== asking) {
      asking = ask;
      orchestrator?.setPageAction(ask ? t("readerReadWhole") : null, readWholeAsked);
    }
    if (structureFailed) return t("readerRenderedFallback", read, total);
    return read < total ? t("readerReportScope", read, total) : "";
  }
  if (scan && !scan.done) return t("readerPreparedPages", scan.scanned, total);
  if (retryPages.length) return t("readerPreparedPages", total - unread.size, total);
  const { done, of, left } = share();
  const limited = pacer.limited() && !whole;
  const offer = limited && aheadOn && done < of;
  if (offer !== offered) {
    offered = offer;
    orchestrator?.setPageAction(offer ? t("readerReadWhole") : null, () => { whole = true; offered = false; orchestrator?.setPageAction(null); wake?.(); });
  }
  if (scan && unread.size && done >= of) {
    if (asking !== aheadOn) {
      asking = aheadOn;
      orchestrator?.setPageAction(asking ? t("readerRetryPages") : null, () => {
        asking = false;
        orchestrator?.setPageAction(null);
        for (const n of unread) retryPages.push(n);
        wake?.();
      });
    }
    return t("readerUnreadPages", unread.size, total);
  }
  if (done >= of) return "";
  // The paragraphs are counted again as their pages are read, and a page read can add one: a
  // dip of a point or two is not shown, a real fall (a new model, read afresh) is.
  const now = Math.floor(done * 100 / Math.max(1, of));
  shownPercent = now >= shownPercent - 2 ? Math.max(shownPercent, now) : now;
  const percent = String(shownPercent);
  if (limited || !aheadOn) return t("readerReadShare", percent);
  // How long the rest will take, once the pace has been measured a few times.
  if (pacer.samples() < 3) return t("readerReading", percent);
  const minutes = Math.ceil(pacer.timeFor(left, onBattery, whole) / 60_000);
  return minutes <= 1 ? t("readerReadingSoon", percent) : t("readerReadingLeft", percent, String(minutes));
}

/** The fallback or a deferred structured reading is available on request. */
let askable = false;
/** The menu shows that button. */
let asking = false;
/** The requested whole-document reading is being prepared. */
let askedWhole = false;
/** The menu's button asked for the whole of a document past what is read without asking: the
 *  deferred structure is tried first when available. */
function readWholeAsked(): void {
  if (!aheadOn || !askable || !controller) return;
  askable = false; asking = false;
  orchestrator?.setPageAction(null);
  const owned = generation, signal = controller.signal, count = app.pdfDocument?.numPages ?? 0;
  const read = async (): Promise<boolean> => {
    askedWhole = true;
    try {
      if (deferredStructure) {
        keepTexts = true;
        if (await readWholeDocument(count, owned, signal, true)) return true;
      }
      if (owned !== generation || signal.aborted) return false;
      keepTexts = false;
      texts.clear();
      scan = new ReflowScan(count);
      replan();
      return true;
    } finally {
      if (owned === generation) { askedWhole = false; askable = false; }
    }
  };
  whole = true;
  void readAhead(owned, read());
}

let aheadOn = true;
/** The menu shows the button that reads the rest of the document. */
let offered = false;
/** The share of the document the menu said was read last. */
let shownPercent = 0;
void settings.pdfReadAhead.getValue().then((v) => { aheadOn = v; });
settings.pdfReadAhead.watch((v) => { aheadOn = v; wake?.(); });

/** Rest `ms`, or less if something wakes the loop. */
function nap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

/** Why the read-ahead may not run now, as how long to wait before asking again; 0 to run. */
function holdFor(): number {
  const live = orchestrator;
  if (!live || !started || (!structure && !scan) || !aheadOn || !pages.size) return 1000;
  // Hidden, on a low battery, or a scan: nothing to read that would be seen.
  if (document.hidden || lowBattery || (textless && !scan)) return 2000;
  if (live.busy()) return 250;
  const quiet = pacer.quiet() - (performance.now() - lastInput);
  return quiet > 0 ? quiet : 0;
}

/** The page the reader is on, and which way they are reading. */
function position(): { current: number; down: boolean } {
  const scroll = (app.pdfViewer as { scroll?: { down?: boolean } }).scroll;
  return { current: app.pdfDocument ? (app.pdfViewer.currentPageNumber || 1) : 1, down: scroll?.down !== false };
}

/** The next page whose text the reader has not got, nearest first in reading order. */
function nextPage(): number | null {
  const total = app.pdfDocument?.numPages ?? 0;
  const { current, down } = position();
  const limited = pacer.limited() && !whole;
  let best: number | null = null;
  for (let n = 1; n <= total; n++) {
    if (texts.has(n) || !inScope(n, current, limited)) continue;
    if (best === null || readingDistance(n, current, down) < readingDistance(best, current, down)) best = n;
  }
  return best;
}

async function extractUnseen(n: number, tables: boolean): Promise<PdfPageText> {
  const page = await app.pdfDocument!.getPage(n);
  try {
    const text = await extractPageText(page, tables);
    if (!nameFonts(page, text)) { await page.getOperatorList().catch(() => undefined); nameFonts(page, text); }
    return text;
  } finally {
    if (!pages.has(n)) page.cleanup();
  }
}

/** A page's text without drawing it, so that it reads as the drawn page will: a font no
 *  page before it loaded is loaded first (getOperatorList draws nothing, but builds the
 *  whole page, its images too — only where a font needs it). */
async function readPage(n: number, owned: number): Promise<void> {
  try {
    const text = await extractUnseen(n, false);
    if (owned !== generation || texts.has(n)) return;
    foundText ||= hasText(text);
    texts.set(n, text);
  } catch {
    // An unreadable page is held as one with no text, and read again when drawn.
    if (owned === generation && !texts.has(n)) {
      texts.set(n, { page: n, width: 0, height: 0, items: [], transform: [1, 0, 0, 1, 0, 0], fonts: {} } as unknown as PdfPageText);
      unread.add(n);
    }
  }
}

/** Pages being read, so that one is read once whoever asks. */
const pagesBeingRead = new Map<number, Promise<void>>();
function textOf(n: number, owned: number): Promise<void> {
  if (texts.has(n)) return Promise.resolve();
  let read = pagesBeingRead.get(n);
  if (!read) {
    read = readPage(n, owned).finally(() => { if (pagesBeingRead.get(n) === read) pagesBeingRead.delete(n); });
    pagesBeingRead.set(n, read);
  }
  return read;
}
/**
 * The pages either side of these, read where they are not yet: with the structure, a drawn
 * page's paragraph that runs on to the next page then reads as it will once that page is
 * drawn too — not first as the structure has it and again, its chip flickering and the
 * paragraph scored twice, when the read-ahead comes to the page.
 */
function readAround(drawn: Iterable<number>, owned: number): Promise<unknown> {
  const total = app.pdfDocument?.numPages ?? 0;
  const wanted = new Set<number>();
  for (const n of drawn) for (const k of [n - 1, n + 1]) if (k >= 1 && k <= total && !texts.has(k)) wanted.add(k);
  return Promise.all([...wanted].map((k) => textOf(k, owned)));
}

/** The next paragraphs to read in the background: on no page drawn, nearest first, up to the
 *  pace's batch — once the pages they lie on, and the pages either side, are read (how a
 *  paragraph is grouped depends on its neighbours). */
function nextBatch(): DocumentParagraph[] {
  const live = orchestrator;
  if (!plan || !live) return [];
  const total = app.pdfDocument?.numPages ?? 0;
  const { current, down } = position();
  const limited = pacer.limited() && !whole;
  const now = performance.now();
  const settled = (p: DocumentParagraph): boolean => {
    if (scan) return true;
    if (!p.pages.length) return false;
    for (let n = Math.max(1, Math.min(...p.pages) - 1), last = Math.min(total, Math.max(...p.pages) + 1); n <= last; n++) {
      if (!texts.has(n)) return false;
    }
    return true;
  };
  const due = (p: DocumentParagraph): boolean => { const t = tried.get(p.text); return !t || (t.times < MAX_TRIES && t.after <= now); };
  // Most of a long book can already be cached. Its map lookup avoids walking
  // the drawn units and the neighbouring pages of each finished paragraph.
  const ready = plan.filter((p) => inScope(p.page, current, limited) && !live.knows(p.text) &&
    due(p) && settled(p) && !live.onScreen(p.text));
  ready.sort((a, b) => readingDistance(a.page, current, down) - readingDistance(b.page, current, down) || a.order - b.order);
  return takeBatch(ready, pacer.budget());
}

/** Pages are read a few at a time, a fifth of a second at most, then the paragraphs again
 *  from them; and no further ahead of the paragraphs being read than this many pages. */
const PAGE_CHUNK = 4;
const PAGE_CHUNK_MS = 200;
const PAGES_AHEAD = 2;

/**
 * The read-ahead (lib/pdf/readAhead.ts): pages and paragraphs, nearest first and the pages a
 * little ahead, paced by how fast the engine is here and held while the reader is reading,
 * the page hidden, the battery low or the document a scan. Runs while its document is open,
 * where the structure came.
 */
async function readAhead(owned: number, structured: Promise<boolean>): Promise<void> {
  if (!(await structured) || owned !== generation) return;
  let stalls = 0;
  // Before anything is measured, the engine's device is the best guess of its pace.
  if (pacer.samples() === 0) {
    const status = await sendDocumentMessage({action: ACTIONS.GET_BACKEND_STATUS}).catch(() => null) as {server?: {device?: string}} | null;
    const seed = seedFor(status?.server?.device);
    if (seed !== null && owned === generation && pacer.samples() === 0) pacer = createPacer(seed);
  }
  while (owned === generation) {
    try {
      const hold = holdFor();
      if (hold > 0) { await nap(hold); continue; }
      const batch = nextBatch();
      if (scan && retryPages.length) {
        const n = retryPages.at(-1)!;
        const text = pages.get(n)?.text ?? await extractUnseen(n, true).catch(() => null);
        if (owned !== generation) return;
        retryPages.pop();
        if (text && unread.delete(n)) { foundText ||= hasText(text); scan.recover(text); replan(); }
        await nap(0);
        continue;
      }
      if (scan && !scan.done && !batch.length) {
        const began = performance.now();
        for (let i = 0; i < PAGE_CHUNK && !scan.done; i++) {
          const n = scan.scanned + 1;
          const text = pages.get(n)?.text ?? await extractUnseen(n, true).catch(() => null);
          if (owned !== generation) return;
          if (!text) unread.add(n);
          else foundText ||= hasText(text);
          const changed = await scan.add(text, readScanBatch);
          if (owned !== generation) return;
          if (scan.done) stopScanWorker();
          if (changed) { replan(); break; }
          if (performance.now() - began >= PAGE_CHUNK_MS || document.hidden || !aheadOn) break;
        }
        await nap(performance.now() - began);
        continue;
      }
      const n = scan ? null : nextPage();
      const { current, down } = position();
      if (n !== null && (batch.length === 0 || readingDistance(n, current, down) <= readingDistance(batch[0]!.page, current, down) + PAGES_AHEAD)) {
        const began = performance.now();
        for (let k = 0, next: number | null = n; next !== null && k < PAGE_CHUNK && performance.now() - began < PAGE_CHUNK_MS; k++, next = nextPage()) {
          await textOf(next, owned);
          if (owned !== generation) return;
        }
        replan();
        // pdf.js's worker and this page are the reader's too: half their time at most.
        await nap(performance.now() - began);
        continue;
      }
      if (batch.length === 0) { await nap(3000); continue; }
      const cost = await orchestrator!.scoreDetached(batch.map((p) => ({ page: p.page, order: p.order, text: p.text, wordCount: p.words })));
      if (owned !== generation) return;
      pacer.done(cost.ms, cost.chars);
      if (!cost.retired && !cost.down && cost.ms > 0) {
        for (const p of batch) {
          if (orchestrator?.knows(p.text)) continue;
          const times = (tried.get(p.text)?.times ?? 0) + 1;
          tried.set(p.text, {times, after: performance.now() + RETRY_MS * 2 ** (times - 1)});
        }
      }
      // Three batches that came back with nothing, the engine up: it is failing them; wait a minute.
      stalls = cost.scored > 0 || cost.ms === 0 || cost.down ? 0 : stalls + 1;
      if (stalls >= 3) { stalls = 0; await nap(60_000); continue; }
      await nap(pacer.restAfter(cost.ms, onBattery, whole));
    } catch {
      if (owned !== generation) return;
      // Whatever failed, the reading goes on, a little later.
      await nap(5000);
    }
  }
}

function prune(): void {
  if ([...pages.values()].some(({view}) => !view.layer.isConnected)) rebuild();
}
async function startAnalysis(owned: number): Promise<void> {
  if (!source || orchestrator) return;
  const currentSource = source;
  setRangeLocator((unit, spans) => currentSource.ranges(unit, spans));
  // The pages are paper-white whatever the viewer around them: marks in the light palette.
  setHighlightSurface(false);
  // A mutation burst walks several roots with one claim filter; the document answers the
  // first of them and the rest are the same document.
  let answered: unknown = null;
  orchestrator = createOrchestrator(null, {
    toolbarOwner: true,
    pageKind: () => "document",
    statsSurface: "pdf",
    statsRecorder: () => import("../../lib/stats/recorder"),
    statsPdf: () => ({ pages: app.pdfDocument?.numPages ?? 0, reader: structure ? "structure" : "reflow", drawn: pages.size }),
    // The report counts every page read so far (the orchestrator keeps what the viewer lets
    // go, and what the read-ahead reads): say how many that is while it is not all of them.
    reportScopeNote: scopeNote,
    revealPage: (page) => { app.pdfViewer.currentPageNumber = page; },
    documentTexts: () => planTexts,
    // The page's own paragraphs keep to the pace too: one at a time where it is not fast.
    oneUnitBatches: () => pacer.speed() !== "fast",
    // The read-ahead keeps its own pace, and waits for the page's own queue to empty.
    pacedBackground: false,
    collect: (_root, claim) => {
      if (answered === claim) return [];
      answered = claim;
      prune();
      return currentSource.collect(claim);
    },
    placeBadge: (unit, host) => placeChip({pageOf: (layer) => [...pages.values()].find(({view}) => view.layer === layer)?.view}, unit, host),
  });
  // A web document follows its site's rule, as the page it came from does; a file from
  // this computer has no site and follows the global switch.
  const enabled = site ? await enabledForSite(site) : await settings.enabled.getValue();
  if (owned !== generation) return;
  if (enabled || started) { started = true; orchestrator?.start(); }
}
async function rendered(page: UpstreamPage | undefined): Promise<void> {
  if (!page?.pdfPage || !source) return;
  const view = pageView(page);
  if (!view || extracting.has(view.layer)) return;
  const geometry = `${page.viewport.width}:${page.viewport.height}:${page.viewport.scale}`;
  const previous = pages.get(page.id);
  if (previous?.view.layer === view.layer) {
    if (previous.geometry !== geometry) {
      previous.geometry = geometry;
      previous.view = view;
      if (started) orchestrator?.refresh();
    }
    return;
  }
  const owned = generation, currentSource = source;
  extracting.add(view.layer);
  try {
    // A page read ahead keeps the text it was read with: its paragraphs' texts, and so their
    // cached verdicts, stay what they were.
    const text = (unread.has(page.id) ? undefined : texts.get(page.id)) ?? await extractPageText(page.pdfPage, !structure);
    if (owned !== generation || !view.layer.isConnected || page.textLayer?.div !== view.layer) return;
    if (scan && unread.has(page.id)) scan.recover(text);
    if (scan && unread.delete(page.id) && !unread.size && asking) {
      asking = false;
      orchestrator?.setPageAction(null);
    }
    if (keepTexts && (unread.delete(page.id) || !texts.has(page.id))) texts.set(page.id, text);
    if (structure) {
      await readAround([page.id], owned);
      if (owned !== generation || !view.layer.isConnected || page.textLayer?.div !== view.layer) return;
    }
    pages.set(page.id, {view, text, geometry});
    currentSource.setPage(page.id, {layer: view.layer, spans: view.spans});
    rebuild();
    foundText ||= hasText(text);
    updateReadability();
    if (!orchestrator && !textless) await startAnalysis(owned);
    else if (started) orchestrator?.refresh();
  } catch {
    // A malformed page does not prevent the upstream viewer showing other pages.
    if (owned === generation && !pages.size) say(t("readerPageReadFailed"));
  } finally { extracting.delete(view.layer); }
}
function beginLoad(): {owned: number; signal: AbortSignal; closing: Promise<void>} {
  rejectedFile = "";
  controller?.abort();
  stopScanWorker();
  documentPassword = "";
  structureFailed = false;
  controller = new AbortController();
  const owned = ++generation;
  orchestrator?.stop(); orchestrator = null; started = false;
  cancelDocumentSession();
  setRangeLocator(null);
  pages.clear(); source = null; structure = null; scan = null; deferredStructure = false; textless = false; foundText = false;
  texts.clear(); unread.clear(); retryPages.length = 0; pagesBeingRead.clear(); keepTexts = true; plan = null; planTexts = null; whole = false; offered = false; askable = false; asking = false; askedWhole = false; shownPercent = 0; tried.clear(); wake?.();
  pacer.newDocument();
  originalUrl = null; original.hidden = true;
  site = null;
  document.body.classList.remove("document-open");
  say(t("readerLoading")); drop.hidden = true;
  const closing = app.close().catch(() => undefined);
  return {owned, signal: controller.signal, closing};
}
async function openBytes(bytes: Uint8Array, name: string, url: string | null, load: ReturnType<typeof beginLoad>): Promise<void> {
  if (load.owned !== generation) return;
  if (bytes.byteLength > MAX_BYTES) { failure("large"); return; }
  await load.closing;
  if (load.owned !== generation) return;
  source = createPdfUnitSource();
  originalUrl = url; original.hidden = !url;
  site = siteOf(url);
  // Upstream controls the password dialog, rendering, navigation, find and printing.
  try {
    app.setTitleUsingUrl(name);
    await app.open({data: bytes, filename: name});
    if (load.owned !== generation) return;
    document.body.classList.add("document-open");
    drop.hidden = true;
    const count = app.pdfDocument?.numPages ?? 0;
    say("");
    void readAhead(load.owned, readWholeDocument(count, load.owned, load.signal));
  } catch {
    if (load.owned === generation) { documentPassword = ""; say(t("readerBadFile")); drop.hidden = false; }
  }
}
let fileChoice = 0;
async function openFile(file: File): Promise<void> {
  const choice = ++fileChoice;
  rejectedFile = "";
  if (file.size > MAX_BYTES) { rejectFile(t("readerTooLarge")); return; }
  // The extension and MIME type can be missing or wrong. Check the bytes before replacing the open PDF.
  try {
    const head = new Uint8Array(await file.slice(0, PDF_HEADER_BYTES).arrayBuffer());
    if (choice !== fileChoice) return;
    if (!hasPdfMagic(head)) { rejectFile(t("readerBadFile")); return; }
    say(t("readerLoading"));
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (choice !== fileChoice) return;
    const load = beginLoad();
    holdSource(null);
    history.replaceState(null, "", location.pathname);
    await openBytes(bytes, pdfFileName(file.name) ?? "document.pdf", null, load);
  } catch { if (choice === fileChoice) rejectFile(t("readerBadFile")); }
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
  // The name the server gave the file, else the address's: what Download saves it as.
  await openBytes(held.bytes, (held.name && pdfFileName(held.name)) || pdfNameFromUrl(src), src, load);
  if (load.owned === generation && app.pdfDocument) holdSource(src);
}
function documentAddress(raw: string | null): string | null {
  return raw ? safePdfSource(raw)?.href ?? null : null;
}
/** A refresh keeps the address and loses the document: read its source again, the private
 *  way every other route reads one (lib/pdf/sourceTransfer.ts), and move to the address
 *  that holds it. False when that cannot be: the reader then offers the original. */
async function reopen(src: string): Promise<boolean> {
  const owned = generation;
  say(t("readerLoading"));
  try {
    const reply = await sendDocumentMessage({action: ACTIONS.PDF_REOPEN, url: src}) as PdfReopenResult | undefined;
    if (owned !== generation) return true;
    if (reply?.ok && reply.reader.startsWith(`${browser.runtime.getURL("/reader.html")}?`)) {
      location.replace(reply.reader);
      return true;
    }
  } catch {}
  return owned !== generation;
}

async function main(): Promise<void> {
  document.getElementById("choose")!.textContent = t("readerChoose");
  document.getElementById("dropLabel")!.textContent = t("readerDrop");
  document.getElementById("dropNote")!.textContent = t("readerDropNote", MAX_FILE_MIB);
  original.querySelector("span")!.textContent = t("readerOpenOriginal");
  original.title = t("readerOpenOriginal"); original.setAttribute("aria-label", t("readerOpenOriginal"));
  analyze.title = t("readerOpenMenu"); analyze.setAttribute("aria-label", t("readerOpenMenu"));
  const chooseFile = (): void => fileInput.click();
  document.getElementById("choose")!.addEventListener("click", chooseFile);
  document.getElementById("anagramOpenFile")!.addEventListener("click", chooseFile);
  // Capture before the upstream file handlers, converting local files into bytes ourselves.
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !["file", "fileInput"].includes(input.id)) return;
    event.stopImmediatePropagation();
    const file = input.files?.[0]; input.value = "";
    if (file && app) void openFile(file);
  }, true);
  let dragDepth = 0;
  const endDrag = (): void => { dragDepth = 0; document.body.classList.remove("drag-file"); };
  document.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth++;
    document.body.classList.add("drag-file");
  }, true);
  document.addEventListener("dragleave", () => {
    if (dragDepth > 0 && --dragDepth === 0) endDrag();
  }, true);
  document.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer?.types.includes("Files")) {
      event.stopImmediatePropagation();
      event.dataTransfer.dropEffect = "copy";
    }
  }, true);
  document.addEventListener("drop", (event) => {
    event.preventDefault(); event.stopImmediatePropagation();
    endDrag();
    const files = event.dataTransfer?.files;
    if (!app || !files?.length) return;
    if (files.length > 1) { ++fileChoice; rejectFile(t("readerDropOne")); return; }
    void openFile(files[0]!);
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
  // The reader's Anagram button is the toolbar's: it opens the same menu, with this document's
  // results and controls. Where the browser cannot open that menu from a page, it reads the
  // document instead.
  analyze.addEventListener("click", () => {
    const readHere = (): void => { started = true; orchestrator?.rescan(); };
    const openMenu = (browser as { action?: { openPopup?: () => Promise<void> } }).action?.openPopup;
    if (openMenu) openMenu().catch(readHere);
    else readHere();
  });
  // The read-ahead waits for the reader to leave the page alone (lib/pdf/readAhead.ts).
  for (const type of READER_INPUT) {
    document.addEventListener(type, () => { lastInput = performance.now(); }, {capture: true, passive: true});
  }
  // On battery the read-ahead takes half its share; at LOW_BATTERY and falling it stops, as a
  // web page's background reading does (lib/capture/pace.ts).
  void (navigator as {getBattery?: () => Promise<{charging: boolean; level: number; addEventListener(type: string, listener: () => void): void}>})
    .getBattery?.().then((battery) => {
      const read = (): void => { onBattery = !battery.charging; lowBattery = !battery.charging && battery.level <= LOW_BATTERY; };
      read();
      battery.addEventListener("chargingchange", read);
      battery.addEventListener("levelchange", read);
    }).catch(() => undefined);
  app = await startViewer();
  const upstreamPicker = document.getElementById("fileInput") as HTMLInputElement | null;
  if (upstreamPicker) upstreamPicker.accept = fileInput.accept;
  const prompt = app.passwordPrompt;
  const setCallback = prompt.setUpdateCallback.bind(prompt);
  prompt.setUpdateCallback = (submit, reason) => {
    const owned = generation;
    documentPassword = "";
    return setCallback((value) => {
      if (owned === generation) documentPassword = typeof value === "string" ? value : "";
      submit(value);
    }, reason);
  };
  app.eventBus.on("textlayerrendered", (event) => { void rendered(event.source); });
  // Upstream find replaces text nodes inside item spans; rebuild ownership after its listeners finish.
  let refreshQueued = false;
  app.eventBus.on("updatetextlayermatches", () => {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; if (started) orchestrator?.refresh(); });
  });
  const params = new URL(location.href).searchParams;
  const src = documentAddress(params.get("src")), ticket = params.get("ticket");
  originalUrl = src; original.hidden = !src;
  // Only a reload, a step back, or a tab Chrome discarded to save memory and is loading again
  // (the reader looked empty on returning to it) reads this very source again.
  const arrival = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
  const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
  const returning = (arrival === "reload" || arrival === "back_forward" || discarded) && !!src && heldSource() === src;
  if (src && ticket) await openTicket(ticket, src);
  else if (src && returning && !params.has("err") && await reopen(src)) return;
  else {
    document.title = t("readerDrop");
    drop.hidden = false;
    if (params.has("err")) failure(params.get("err")!);
    else if (src) say(t("readerReloadRequired"));
  }
}
void main().catch(() => { say(t("readerBadFile")); drop.hidden = false; });
let resumeAfterPageShow = false;
window.addEventListener("pagehide", (event) => {
  ++fileChoice; ++generation; controller?.abort(); stopScanWorker(); wake?.(); orchestrator?.stop(); cancelDocumentSession();
  resumeAfterPageShow = event.persisted && started;
  if (!event.persisted) void app?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && resumeAfterPageShow) {
    controller = new AbortController();
    if (!structure && !scan) { askedWhole = false; askable = true; }
    orchestrator?.start();
    // pagehide ended the read-ahead with everything else of this document's; it goes on.
    if (structure || scan) void readAhead(generation, Promise.resolve(true));
  }
  resumeAfterPageShow = false;
});

void browser.tabs.getCurrent().then(tab => {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as ControlMessage & { readerTabId?: number };
    if (!msg || typeof msg !== "object" || sender.id !== browser.runtime.id) return;
    if (sender.tab && sender.url?.split(/[?#]/, 1)[0] !== browser.runtime.getURL("/popup.html")) return;
    if (msg.action === ACTIONS.CACHE_CLEARED) { orchestrator?.forgetCached(); return; }
    // An unrelated reader must release the message channel so the popup can query the active tab.
    if (tab?.id === undefined || tab.id !== msg.readerTabId) return;
    handleControl(msg, sendResponse);
  });
});

function handleControl(msg: ControlMessage, sendResponse: (response?: unknown) => void): void {
  const live = orchestrator;
  switch (msg.action) {
    case ACTIONS.RESCAN: case ACTIONS.ANALYZE_PAGE: started = true; live?.rescan(); break;
    case ACTIONS.SET_ENABLED: started = msg.value; if (msg.value) live?.start(); else live?.stop(); break;
    case ACTIONS.GET_TAB_STATE: {
      const state: TabState = {enabled: started, reader: true, ...(textless ? {noText: true} : {}), hostname: location.hostname, scored: live?.scoredCount() ?? 0,
        flagged: live?.flaggedCount() ?? 0, unsupported: live?.unsupportedCount() ?? 0, unavailable: live?.unavailableCount() ?? 0,
        ...(live && typeof msg.reportOffset === "number" ? { report: live.pageReport(msg.reportOffset) } : {})};
      sendResponse(state); return;
    }
    case ACTIONS.TOGGLE_OVERLAY:
      if (live) { started = true; live.toggle(); }
      break;
    case ACTIONS.JUMP_TO_RESULT: sendResponse({ ok: started && !!live?.jumpToResult(msg.documentId, msg.id) }); return;
    // The report's button: "Read the whole document" where only the pages around are read.
    case ACTIONS.RUN_PAGE_ACTION: sendResponse({ ok: !!live?.runPageAction(msg.documentId, msg.id) }); return;
    case ACTIONS.NEXT_FLAGGED: live?.jumpFlagged(1); break;
    case ACTIONS.PREV_FLAGGED: live?.jumpFlagged(-1); break;
    case ACTIONS.RETRY_BACKEND: live?.retryBackend(); break;
    case ACTIONS.CACHE_CLEARED: live?.forgetCached(); break;
    case ACTIONS.TEARDOWN: started = false; live?.stop(); break;
    default: sendResponse({ ok: false }); return;
  }
  sendResponse({ ok: true });
}
