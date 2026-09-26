// test/pdf-bench/zotero-dump.mjs — Zotero's document-worker reads the same PDFs.
//
// Run from a built checkout of https://github.com/zotero/document-worker (AGPL-3.0, with
// its pdf.js fork as a submodule; `npm ci && npm run build`), the way its own Node tests
// run it — scripts/documentWorker.mjs leaves exactly such a checkout in its cache:
//
//   cd <document-worker> && node --import ./scripts/pdfjs-setup.js --import tsx \
//     <anagram>/test/pdf-bench/zotero-dump.mjs <corpus dir> <raw out dir> [--only <id,…>]
//
// For each PDF this calls getStructure — what the reader's worker calls
// (vendor/document-worker/worker.js) — and writes the structure with the wall time, one
// JSON per document, glyph maps and all. bench.mjs `zotero` scores Zotero's own body flow
// from it and bench.mjs `structured` runs the reader's whole path over it
// (lib/pdf/structured.ts, then the grouping), so the two can be set beside Anagram's.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [corpus, out] = process.argv.slice(2);
const at = process.argv.indexOf("--only");
const only = at >= 0 ? process.argv[at + 1].split(",") : null;
const worker = resolve(".");
const { getStructure } = await import(pathToFileURL(join(worker, "src", "pdf", "index.js")).href);
const dataProvider = (path) => readFileSync(join(worker, "build", path));
const version = JSON.parse(readFileSync(join(worker, "build", "metadata.json"), "utf8"));

mkdirSync(out, { recursive: true });
const docs = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
for (const doc of docs) {
  if (only && !only.includes(doc.id)) continue;
  const file = join(corpus, doc.file);
  const target = join(out, `${doc.id.replace(/[^\w.-]+/g, "_")}.json`);
  if (!existsSync(file) || existsSync(target)) continue;
  const bytes = readFileSync(file);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const began = performance.now();
  try {
    // The source hash only labels the output; the reader passes a zero hash too.
    const structure = await getStructure(buf, "", dataProvider, { sourceHash: "0".repeat(32) });
    const ms = performance.now() - began;
    const degraded = structure.catalog.pages.filter((p) => p.extractionDegraded).length;
    writeFileSync(target, JSON.stringify({ id: doc.id, ms, version, pages: structure.catalog.pages.length, degraded, structure }));
    console.log(`${doc.id} ${structure.catalog.pages.length}p ${(ms / 1000).toFixed(1)}s`);
  } catch (error) {
    writeFileSync(target, JSON.stringify({ id: doc.id, error: String(error?.stack ?? error) }));
    console.log(`${doc.id} FAILED ${error?.message ?? error}`);
  }
}
