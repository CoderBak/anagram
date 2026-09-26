// test/pdf-bench/anagram.mjs — run a PDF through the reader's extract → reflow → units path.
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR = join(ROOT, "public", "vendor");
const LEGACY = join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build");
/** The upstream viewer the reader ships (vendor/pdfjs/upstream.json). */
const PINNED = JSON.parse(readFileSync(join(ROOT, "vendor", "pdfjs", "upstream.json"), "utf8")).version;
/** The reader analyses no page past this (entrypoints/reader/main.ts MAX_ANALYSIS_PAGES). */
export const MAX_ANALYSIS_PAGES = 300;

let loaded = null;
/** The reader's pipeline and pdf.js, bundled and loaded once per process. */
export function loadPipeline() {
  loaded ??= bundle();
  return loaded;
}

/**
 * Bundle pipeline.ts for Node. lib/lazy.ts reaches pdf.js through the extension API; the
 * stub answers with the release the extension serves (pdfjs-dist, which scripts/vendor.mjs
 * copies into public/vendor/) in the legacy build pdf.js publishes for Node: the browser
 * build expects Chrome's baseline (DOMMatrix, Promise.try, Uint8Array.toHex), which Node
 * 22 lacks. Text extraction is the same code in both.
 */
async function bundle() {
  const dir = mkdtempSync(join(tmpdir(), "anagram-pdfbench-"));
  const outfile = join(dir, "pipeline.mjs");
  const stub = `import { pathToFileURL } from "node:url";
    const files = { "/vendor/pdfjs.min.mjs": ${JSON.stringify(join(LEGACY, "pdf.mjs"))} };
    export const browser = { runtime: { getURL: (p) => pathToFileURL(files[p] ?? ${JSON.stringify(join(ROOT, "public"))} + p).href } };`;
  await build({
    entryPoints: [join(ROOT, "test", "pdf-bench", "pipeline.ts")],
    bundle: true, format: "esm", platform: "node", outfile, logLevel: "error",
    plugins: [{
      name: "extension-api-stub",
      setup(b) {
        b.onResolve({ filter: /^#imports$/ }, () => ({ path: "imports", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
      },
    }],
  });
  const pipeline = await import(pathToFileURL(outfile).href);
  rmSync(dir, { recursive: true, force: true });
  const pdfjs = await pipeline.loadPdfjs();
  if (pdfjs.version !== PINNED) throw new Error(`pdf.js ${pdfjs.version}; the reader ships ${PINNED}`);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(LEGACY, "pdf.worker.mjs")).href;
  return { pipeline, pdfjs };
}

/** The document options the reader's viewer opens bytes with (entrypoints/reader/viewer.ts). */
export function documentOptions(data) {
  return {
    data, verbosity: 0, isEvalSupported: false, useWorkerFetch: false, enableXfa: false,
    cMapUrl: `${join(VENDOR, "cmaps")}/`, cMapPacked: true,
    standardFontDataUrl: `${join(VENDOR, "standard_fonts")}/`,
    wasmUrl: `${join(VENDOR, "wasm")}/`, iccUrl: `${join(VENDOR, "iccs")}/`,
  };
}

/**
 * One document as the reader would read it with every page rendered: each page extracted
 * as its text layer is, the whole run of pages reflowed at once, the units grouped with
 * the reader's default (short paragraphs read together). `window` > 0 instead reflows
 * runs of that many pages, the way a reader holding only a few pages sees the document.
 */
export async function runAnagram({ pipeline, pdfjs }, file, { window = 0 } = {}) {
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjs.getDocument(documentOptions(data)).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const numPages = doc.numPages;
  const count = Math.min(numPages, MAX_ANALYSIS_PAGES);
  const pages = [];
  const extractMs = [];
  for (let n = 1; n <= count; n++) {
    const began = performance.now();
    const page = await doc.getPage(n);
    pages.push(await pipeline.extractPageText(page));
    extractMs.push(performance.now() - began);
    page.cleanup();
  }
  await doc.destroy();
  const runs = [];
  if (window > 0) for (let i = 0; i < pages.length; i += window) runs.push(pages.slice(i, i + window));
  else runs.push(pages);
  const began = performance.now();
  const blocks = pipeline.reflowRuns(runs);
  const reflowMs = performance.now() - began;
  return {
    numPages,
    producer: meta?.info?.Producer ?? "",
    creator: meta?.info?.Creator ?? "",
    pages,
    blocks,
    words: pipeline.planWords(blocks),
    units: pipeline.unitsOf(blocks),
    timing: { extractMs, reflowMs, totalMs: extractMs.reduce((a, b) => a + b, 0) + reflowMs },
  };
}
