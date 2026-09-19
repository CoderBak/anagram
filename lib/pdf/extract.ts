// lib/pdf/extract.ts — pdf.js, reduced to "show me this page, and tell me its text runs".
//
// The reader shows the REAL pages: Anagram annotates a document, it never replaces or
// reformats it. So this asks pdf.js for the two things a faithful view needs — the page
// drawn into a canvas exactly as any pdf.js viewer would draw it, and the text layer of
// transparent spans that sits over it — plus the same text runs the reflow has always
// worked from. Everything else the library can do is still left alone: no annotations, no
// forms, no scripting, no embedded files, no link actions. A PDF is an untrusted document
// from the open web, and the narrower the surface we ask the library for, the less of it
// can matter. pdf.js 5 needs no eval either, which is what makes it usable under the MV3
// page CSP at all.
//
// The library and its worker are on-demand vendor chunks (scripts/vendor.mjs,
// lib/lazy.ts), so nothing of pdf.js is linked into the content script that runs on
// every page — only the reader page pays for it, and only once it is opened. The DATA the
// library fetches while it draws (CMaps, the standard fourteen fonts, the image decoders)
// is vendored beside it: without those a Japanese paper comes out with no glyphs, a report
// set in "Times" with the wrong ones, and a scanned form with blank pages.
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

/** A drawing in flight, so a page that scrolls away stops costing anything. */
export interface PageRender {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfPage {
  /** 1-based page number. */
  n: number;
  /** The page box at scale 1, in CSS pixels, with the page's own /Rotate folded in. */
  width: number;
  height: number;
  /** The page's text runs, in the coordinate space lib/pdf/reflow.ts works in. */
  text: PdfPageText;
  /** Draw the page into `canvas` at `scale` — fonts, figures, maths and all. */
  render(canvas: HTMLCanvasElement, scale: number, pixelScale: number): PageRender;
  /**
   * Build pdf.js's own text layer into `container` and hand back the span it made for
   * every item of `text.items`, in that order — see the correspondence below.
   */
  textLayer(container: HTMLElement): Promise<(HTMLElement | undefined)[]>;
}

export interface PdfDocument {
  numPages: number;
  /** The /Title entry of the document info dictionary, when it holds a usable one. */
  title: string | null;
  page(n: number): Promise<PdfPage>;
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

/** An extension URL for one of the vendored asset folders, with its trailing slash. */
function assets(folder: string): string {
  return browser.runtime.getURL(`/vendor/${folder}/` as PublicPath);
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
      // Everything below is what "faithful" costs. A document whose CMaps are predefined
      // rather than embedded (nearly every CJK PDF) has no glyphs without cMapUrl; one
      // that leans on the standard fourteen fonts is set in whatever the browser guesses
      // without standardFontDataUrl; a scanned report is a page of blanks without the
      // JPEG2000 and JBIG2 decoders. All three are files we ship (scripts/vendor.mjs).
      cMapUrl: assets("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assets("standard_fonts"),
      iccUrl: assets("iccs"),
      wasmUrl: assets("wasm"),
      useWasm: true,
      // The MAIN thread fetches those files and posts the bytes across, rather than the
      // worker fetching them itself: one code path for Chrome and for Firefox, and no
      // question about what a privileged worker origin may request.
      useWorkerFetch: false,
      // Warnings about a font substitution or an unsupported feature would fill the
      // console of every PDF opened; errors still come through as rejections.
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

  async function page(n: number): Promise<PdfPage> {
    const p = await doc.getPage(n);
    // The viewport transform flips pdf.js's bottom-up user space onto the top-down space
    // the reflow works in, and folds in the page's own /Rotate — so a landscape scan
    // arrives already the right way up.
    const viewport = p.getViewport({ scale: 1 });
    const content = await p.getTextContent();
    const items: PdfTextItem[] = [];
    for (const it of content.items) {
      // Marked-content markers carry no text — and pdf.js's text layer makes no span for
      // them either, which is exactly why dropping them here keeps the two arrays in step.
      if (!("str" in it)) continue;
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

    return {
      n,
      width: viewport.width,
      height: viewport.height,
      text: { page: n, width: viewport.width, height: viewport.height, items },
      render(canvas, scale, pixelScale) {
        const at = p.getViewport({ scale });
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return { promise: Promise.resolve(), cancel: () => undefined };
        const task = p.render({
          canvas,
          canvasContext: ctx,
          viewport: at,
          transform: pixelScale === 1 ? undefined : [pixelScale, 0, 0, pixelScale, 0, 0],
        });
        return { promise: task.promise.then(() => undefined), cancel: () => task.cancel() };
      },
      async textLayer(container) {
        // The layer is built ONCE, at scale 1, and never rebuilt: pdf.js places every span
        // as a percentage of the page box and sizes it in --total-scale-factor units, so
        // zoom is a CSS variable and the spans — which are the document's text nodes as
        // far as the rest of Anagram is concerned — never move house.
        const layer = new pdfjs.TextLayer({ textContentSource: content, container, viewport });
        await layer.render();
        // THE CORRESPONDENCE the whole PDF view rests on, verified against pdf.js 5.7.284:
        // TextLayer pushes exactly one span per item that carries a `str`, in order, and
        // none at all for a marked-content marker — so textDivs[i] is the span for the
        // i-th item we kept above. An item whose `str` is empty still gets a span, but it
        // is never appended to the container; the reflow drops those runs anyway, so no
        // paragraph ever points at one. A `<br>` for an item's hasEOL is appended beside
        // the span and is not in textDivs, so it shifts nothing. Past pdf.js's own limit
        // of 100 000 spans the array simply stops, which is why the tail is `undefined`
        // rather than assumed.
        const divs = layer.textDivs;
        return items.map((_, i) => divs[i]);
      },
    };
  }

  return {
    numPages: doc.numPages,
    title,
    page,
    close: () => void doc.destroy(),
  };
}
