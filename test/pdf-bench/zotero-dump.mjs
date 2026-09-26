// test/pdf-bench/zotero-dump.mjs — Zotero's document-worker reads the same PDFs.
//
// Run from a built checkout of https://github.com/zotero/document-worker (AGPL-3.0, with
// its pdf.js fork as a submodule; `npm ci && npm run build`), the way its own Node tests
// run it:
//
//   cd <document-worker> && node --import ./scripts/pdfjs-setup.js --import tsx \
//     <anagram>/test/pdf-bench/zotero-dump.mjs <corpus dir> <raw out dir> [--only <id,…>]
//
// For each PDF this calls the public getStructuredDocumentText — what Zotero runs in
// production — unpacks the result and writes the content tree (anchors cut down to page
// rects) with the wall time, one JSON per document. bench.mjs zotero turns those into a
// run the report can put beside Anagram's.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const [corpus, out] = process.argv.slice(2);
const at = process.argv.indexOf("--only");
const only = at >= 0 ? process.argv[at + 1].split(",") : null;
const worker = resolve(".");
const { getStructuredDocumentText } = await import(pathToFileURL(join(worker, "src", "index.js")).href);
const { openStructuredDocumentTextPack } = await import(pathToFileURL(join(worker, "structured-document-text", "src", "pack", "reader.js")).href);
const dataProvider = (path) => readFileSync(join(worker, "build", path));
const version = JSON.parse(readFileSync(join(worker, "build", "metadata.json"), "utf8"));

/** Keep what the benchmark reads: block types, text, flow class, parts and pages. */
function slim(node) {
  if (Array.isArray(node)) return node.map(slim);
  if (!node || typeof node !== "object") return node;
  const outNode = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "anchor") { if (v?.pageRects) outNode.pageRects = v.pageRects; continue; }
    if (k === "refs" || k === "backRefs" || k === "target" || k === "style") continue;
    outNode[k] = slim(v);
  }
  return outNode;
}

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
    const result = await getStructuredDocumentText(buf, {
      contentType: "application/pdf", password: "", dataProvider,
      sourceHash: createHash("md5").update(bytes).digest("hex"),
    });
    const ms = performance.now() - began;
    const reader = await openStructuredDocumentTextPack(result.buf, { inflate: (b) => new Uint8Array(inflateRawSync(b)) });
    const structure = await reader.materialize();
    const degraded = structure.catalog.pages.filter((p) => p.extractionDegraded).length;
    writeFileSync(target, JSON.stringify({ id: doc.id, ms, version, pages: structure.catalog.pages.length, degraded, content: slim(structure.content) }));
    console.log(`${doc.id} ${structure.catalog.pages.length}p ${(ms / 1000).toFixed(1)}s`);
  } catch (error) {
    writeFileSync(target, JSON.stringify({ id: doc.id, error: String(error?.stack ?? error) }));
    console.log(`${doc.id} FAILED ${error?.message ?? error}`);
  }
}
