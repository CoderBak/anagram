// lib/pdf/extract.ts — pdf.js, reduced to "give me this page's text runs".
//
// The reader needs nothing else from pdf.js: no canvas, no annotations, no forms, no
// embedded files, no link actions. A PDF is an untrusted document from the open web, and
// the narrower the surface we ask the library for, the less of it can matter. pdf.js 5
// needs no eval either, which is what makes it usable under the MV3 page CSP at all.
//
// The library and its worker are on-demand vendor chunks (scripts/vendor.mjs,
// lib/lazy.ts), so nothing of pdf.js is linked into the content script that runs on
// every page — only the reader page pays for it, and only once it is opened.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { loadPdfjs, type PdfJsModule } from "../lazy";
import type { PdfPageText, PdfTextItem } from "./reflow";

/** A rotated run is one whose matrix has any shear/rotation at all, beyond rounding. */
const ROTATION_EPSILON = 0.02;

/** Why a file could not be opened, in the three ways a reader can act on. */
export type PdfOpenFailure = "password" | "invalid" | "failed";

export class PdfOpenError extends Error {
  readonly failure: PdfOpenFailure;
  constructor(failure: PdfOpenFailure, cause?: unknown) {
    super(`PDF could not be opened: ${failure}`, { cause });
    this.name = "PdfOpenError";
    this.failure = failure;
  }
}

export interface PdfDocument {
  numPages: number;
  /** The /Title entry of the document info dictionary, when it holds a usable one. */
  title: string | null;
  /** One page's text runs, in the coordinate space lib/pdf/reflow.ts expects. */
  page(n: number): Promise<PdfPageText>;
  close(): void;
}

let configured = false;

/** Point pdf.js at the worker we ship. Same origin as the reader page, so no wrapper. */
function configure(pdfjs: PdfJsModule): void {
  if (configured) return;
  pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL(
    "/vendor/pdf.worker.mjs" as PublicPath,
  );
  configured = true;
}

/** pdf.js names its exceptions rather than subclassing across the worker boundary. */
function failureOf(e: unknown): PdfOpenFailure {
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "PasswordException") return "password";
  if (name === "InvalidPDFException") return "invalid";
  return "failed";
}

/**
 * Open a PDF held in memory. `data` is transferred to the worker, so the caller must not
 * keep using the buffer afterwards.
 */
export async function openPdf(data: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs();
  configure(pdfjs);

  let doc: Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]>;
  try {
    doc = await pdfjs.getDocument({
      data,
      // Nothing is rendered, so nothing needs a face installed in the document.
      disableFontFace: true,
      useSystemFonts: false,
      // The image codecs and the colour-management module are WebAssembly files we do
      // not ship; a document that would reach for them must fail quietly, not fetch.
      useWasm: false,
      useWorkerFetch: false,
      // Warnings about the font data we deliberately do not ship would fill the console
      // of every PDF opened; errors still come through as rejections.
      verbosity: 0,
    }).promise;
  } catch (e) {
    throw new PdfOpenError(failureOf(e), e);
  }

  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const t = (meta.info as { Title?: unknown } | undefined)?.Title;
    if (typeof t === "string" && t.trim() !== "") title = t.trim();
  } catch {
    /* a document without an info dictionary is perfectly ordinary */
  }

  async function page(n: number): Promise<PdfPageText> {
    const p = await doc.getPage(n);
    // The viewport transform flips pdf.js's bottom-up user space onto the top-down space
    // the reflow works in, and folds in the page's own /Rotate — so a landscape scan
    // arrives already the right way up.
    const viewport = p.getViewport({ scale: 1 });
    const content = await p.getTextContent();
    const items: PdfTextItem[] = [];
    for (const it of content.items) {
      if (!("str" in it)) continue; // marked-content markers carry no text
      const m = pdfjs.Util.transform(viewport.transform, it.transform);
      items.push({
        str: it.str,
        x: m[4],
        y: m[5],
        width: it.width,
        height: it.height,
        fontName: it.fontName,
        hasEOL: it.hasEOL,
        rotated: Math.abs(m[1]) > ROTATION_EPSILON || Math.abs(m[2]) > ROTATION_EPSILON,
      });
    }
    p.cleanup();
    return { page: n, width: viewport.width, height: viewport.height, items };
  }

  return {
    numPages: doc.numPages,
    title,
    page,
    close: () => void doc.destroy(),
  };
}
