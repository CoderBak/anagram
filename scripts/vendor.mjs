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
import { copyFileSync, mkdirSync, statSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
