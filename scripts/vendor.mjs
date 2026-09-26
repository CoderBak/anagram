// scripts/vendor.mjs — prebuild the on-demand vendor chunks into public/vendor/.
//
// Readability (main-content scope), DOMPurify (Google Docs reading mode) and pdf.js
// (the PDF reader) are only needed on demand, so they are NOT bundled into the content
// script that runs on every page. They are built here as minified ESM files, shipped as
// web-accessible resources, and loaded with a dynamic import() of their extension URL
// (lib/lazy.ts) the first time a feature needs them. Runs on postinstall and before
// every build, for both the Chrome and the Firefox target — public/ is copied verbatim
// into each output, so one prebuild serves both.
//
// One chunk is OUR OWN code: the page diagnostics (lib/diagnostics/chunk.ts), which carry
// a copy of the segmentation modules because the report re-runs the walk to explain it.
// That copy is generated here, on every build and on install, and is NOT committed — a
// checked-in copy of lib/dom/ would go stale the first time somebody changed a rule and
// the report would then explain pages by a walk the product no longer performs.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { vendorPdfViewer } from "./pdfjsViewer.mjs";
import { vendorDocumentWorker } from "./documentWorker.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
vendorPdfViewer(ROOT);
const OUT = join(ROOT, "public", "vendor");
mkdirSync(OUT, { recursive: true });

const chunks = {
  // @mozilla/readability is CommonJS; a tiny ESM wrapper gives it named exports.
  "readability.min.mjs": `
    import mod from "@mozilla/readability";
    export const Readability = mod.Readability;
    export const isProbablyReaderable = mod.isProbablyReaderable;
  `,
  "purify.min.mjs": `export { default } from "dompurify";`,
};

// pdf.js ships its own minified ESM builds, and the worker has to stay a SEPARATE file:
// pdf.js starts it with `new Worker(workerSrc, { type: "module" })`, so it must exist at
// an extension URL of its own. Both are copied verbatim rather than rebuilt — bundling
// Mozilla's output again buys nothing and risks breaking a library that ships exactly
// the artefacts it wants to be loaded.
const copies = {
  "pdfjs.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "pdf.worker.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
};

// The DATA pdf.js reaches for while it draws a page. None of it is code we call: the
// library fetches these by URL from the packaged asset URLs in entrypoints/reader/viewer.ts, and without
// them whole classes of document come out wrong rather than merely unstyled — a Japanese
// paper with no glyphs at all (its CMaps are predefined, not embedded), a report set in
// "Times" with no font file in it, a scanned form whose pages are JPEG2000 or JBIG2
// images. Copied verbatim like the library itself, and committed for the same reason:
// they are a published artefact of a pinned version, not something generated from our own
// source. Two folders are left out on purpose — `wasm/` carries quickjs (the PDF-scripting
// sandbox, which we never enable) and the `*_nowasm_fallback.js` builds (only reached when
// a wasm module fails to instantiate), so the decoders are named file by file instead.
const trees = {
  cmaps: { from: "pdfjs-dist/cmaps" },
  "standard_fonts": { from: "pdfjs-dist/standard_fonts" },
  iccs: { from: "pdfjs-dist/iccs" },
  wasm: {
    from: "pdfjs-dist/wasm",
    only: [
      "openjpeg.wasm",
      "jbig2.wasm",
      "LICENSE_OPENJPEG",
      "LICENSE_JBIG2",
      "LICENSE_PDFJS_OPENJPEG",
      "LICENSE_PDFJS_JBIG2",
    ],
  },
};

for (const [file, contents] of Object.entries(chunks)) {
  await build({
    stdin: { contents, resolveDir: ROOT, loader: "js" },
    bundle: true,
    format: "esm",
    minify: true,
    target: ["chrome110", "firefox128"],
    outfile: join(OUT, file),
    logLevel: "error",
  });
  console.log(`vendor/${file}  ${(statSync(join(OUT, file)).size / 1024).toFixed(1)} kB`);
}

// The diagnostics chunk is bundled from the tree the way the content script is. It must
// import no extension API at all — everything the platform knows is handed to it by
// lib/diagnostics/index.ts — and esbuild enforces that here: a stray `#imports` has no
// resolver outside WXT and fails this build rather than the browser.
await build({
  entryPoints: [join(ROOT, "lib", "diagnostics", "chunk.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  target: ["chrome110", "firefox128"],
  outfile: join(OUT, "diagnostics.min.mjs"),
  logLevel: "error",
});
console.log(`vendor/diagnostics.min.mjs  ${(statSync(join(OUT, "diagnostics.min.mjs")).size / 1024).toFixed(1)} kB`);

for (const [file, from] of Object.entries(copies)) {
  copyFileSync(join(ROOT, "node_modules", from), join(OUT, file));
  console.log(`vendor/${file}  ${(statSync(join(OUT, file)).size / 1024).toFixed(1)} kB`);
}

for (const [name, { from, only }] of Object.entries(trees)) {
  const src = join(ROOT, "node_modules", from);
  const dest = join(OUT, name);
  // Replaced outright rather than merged: a file the library stopped shipping must not
  // live on here because it once did.
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const files = only ?? readdirSync(src);
  let bytes = 0;
  for (const file of files) {
    // A named file that has gone is a version bump we have not read: fail the build
    // rather than ship a viewer that silently cannot decode a scan.
    cpSync(join(src, file), join(dest, file), { recursive: true });
    bytes += statSync(join(dest, file)).size;
  }
  console.log(`vendor/${name}/  ${files.length} files, ${(bytes / 1024).toFixed(1)} kB`);
}

// Zotero's document-worker for the PDF reader's paragraphs: the committed, hash-pinned build
// under vendor/document-worker/ (scripts/documentWorker.mjs), plus the ONNX runtime's wasm
// from its npm package. After the trees above, because the worker reads the CMaps, fonts
// and decoders from those copies and the check that they are the fork's own files runs here.
vendorDocumentWorker(ROOT);
