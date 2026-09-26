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
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import type { SdtStructure } from "./structured";

/** Reading takes about 20 ms a page on an Apple Silicon Mac; ten times that is a hang. */
const TIMEOUT_BASE_MS = 20_000;
const TIMEOUT_PER_PAGE_MS = 250;

const asset = (path: string): string => browser.runtime.getURL(`/vendor/${path}` as PublicPath);

/**
 * Zotero's reading of the document, or a rejection: the worker failed, took too long, or
 * `signal` was aborted. `bytes` must be the caller's own copy — the viewer hands its copy
 * to pdf.js, which may transfer it away — and is transferred to the worker, not copied
 * again: a large PDF is held three times over otherwise.
 */
export function readStructure(bytes: Uint8Array, pages: number, signal?: AbortSignal): Promise<SdtStructure> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const began = performance.now();
    const worker = new Worker(asset("start/document-worker.js"));
    let done = false;
    const finish = (error: Error | null, structure?: SdtStructure): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      performance.measure("anagram-structure", { start: began });
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
      id: 1, buf, password: "", sourceHash: "0".repeat(32),
      roots: {
        cmaps: asset("cmaps/"), standard_fonts: asset("standard_fonts/"), wasm: asset("wasm/"),
        onnx: asset("document-worker/onnx/"), "block-seg": asset("document-worker/block-seg/"),
      },
    }, [buf]);
  });
}
