// lib/pdf/structureWorker.ts — Zotero's document-worker, run over the open document.
//
// The worker (vendor/document-worker/, built from a pinned commit by
// scripts/documentWorker.mjs) reads the WHOLE document at once: its pdf.js fork extracts
// every glyph, an ONNX model cuts each page into blocks, and its rules decide what is body
// text, in what order, and what carries on where. It answers with the structure once, at
// the end; the progress messages on the way are ignored here because the reader has
// nothing to show for them — its own reflow is already chipping the pages on screen, and
// the structure replaces it when it arrives (entrypoints/reader/main.ts).
//
// One worker per document, terminated when it has answered, failed, timed out or been
// cancelled: it holds a second copy of the PDF, the runtime and the models, which no open
// document should keep alive. Everything it loads comes from the extension by URL — the
// reader hands it the roots — and the PDF's bytes never leave this process.
//
// What the worker needs grows with the document: it holds every page's glyphs until it
// answers (1.4 GB of the reader's process at its peak for 813 pages, 2.7 GB for 2,445), and the
// answer arrives in one message whose unpacking held the page for 0.4 s at 2,445 pages. A
// document longer than RANGE_PAGES is read in even ranges of at most that many pages, one
// worker after another, each answering in the whole document's numbering
// (vendor/document-worker/src/worker.js); their contents laid end to end are the structure.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import type { SdtStructure } from "./structured";

/** Reading takes about 20 ms a page on an Apple Silicon Mac; ten times that is a hang. */
const TIMEOUT_BASE_MS = 20_000;
const TIMEOUT_PER_PAGE_MS = 250;
/** The most pages one worker reads: a book's length, whose peak and answer were measured. */
export const RANGE_PAGES = 1000;

const asset = (path: string): string => browser.runtime.getURL(`/vendor/${path}` as PublicPath);

/** The ranges a document of `pages` pages is read in: as even as can be, none longer than
 *  `most` pages. */
export function pageRanges(pages: number, most = RANGE_PAGES): [number, number][] {
  if (pages <= most) return [[0, pages]];
  const count = Math.ceil(pages / most);
  const size = Math.ceil(pages / count);
  const ranges: [number, number][] = [];
  for (let start = 0; start < pages; start += size) ranges.push([start, Math.min(pages, start + size)]);
  return ranges;
}

/**
 * Zotero's reading of the document, or a rejection: the worker failed, took too long, or
 * `signal` was aborted. `bytes` must be the caller's own copy — the viewer hands its copy
 * to pdf.js, which may transfer it away — and is transferred to the (last) worker, not copied
 * again: a large PDF is held three times over otherwise. `rangePages`: the most pages one
 * worker reads (tests make it small).
 */
export async function readStructure(bytes: Uint8Array, pages: number, signal?: AbortSignal, rangePages = RANGE_PAGES): Promise<SdtStructure> {
  const began = performance.now();
  const ranges = pageRanges(pages, rangePages);
  try {
    if (ranges.length === 1) return await readOne(bytes, pages, null, 0, signal);
    const whole: SdtStructure = { catalog: { pages: [] }, content: [] };
    for (const [k, range] of ranges.entries()) {
      // Every worker but the last gets a copy: the last can have the caller's own.
      const part = await readOne(k === ranges.length - 1 ? bytes : bytes.slice(), range[1] - range[0], range, whole.content.length, signal);
      whole.catalog.pages.push(...part.catalog.pages);
      for (const block of part.content) whole.content.push(block);
    }
    return whole;
  } finally {
    // Answered or given up, either way (test/pdf-fixture.mjs waits for it).
    performance.measure("anagram-structure", { start: began });
  }
}

/** One worker's reading: of the whole document, or of `range` numbered into it. */
function readOne(bytes: Uint8Array, pages: number, range: [number, number] | null, contentBase: number, signal?: AbortSignal): Promise<SdtStructure> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const worker = new Worker(asset("start/document-worker.js"));
    let done = false;
    const finish = (error: Error | null, structure?: SdtStructure): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      if (error) reject(error);
      else resolve(structure!);
    };
    const onAbort = (): void => finish(new Error("aborted"));
    const timer = setTimeout(() => finish(new Error("timeout")), TIMEOUT_BASE_MS + TIMEOUT_PER_PAGE_MS * pages);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "worker error"));
    worker.onmessage = (event: MessageEvent<{ id: number; structure?: SdtStructure; error?: string; progress?: number }>) => {
      const message = event.data;
      if (message.structure) finish(null, message.structure);
      else if (message.error !== undefined) finish(new Error(message.error));
    };
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const buf = (whole ? bytes : bytes.slice()).buffer as ArrayBuffer;
    worker.postMessage({
      id: 1, buf, password: "", sourceHash: "0".repeat(32), ...(range ? { range, contentBase } : {}),
      roots: {
        cmaps: asset("cmaps/"), standard_fonts: asset("standard_fonts/"), wasm: asset("wasm/"),
        onnx: asset("engine/"), "block-seg": asset("document-worker/block-seg/"),
      },
    }, [buf]);
  });
}
