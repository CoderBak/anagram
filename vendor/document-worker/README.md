# Pinned Zotero document-worker

The PDF reader's paragraphs come from Zotero's
[document-worker](https://github.com/zotero/document-worker) (AGPL-3.0): its pdf.js fork
(Apache-2.0), its structured-document-text library (AGPL-3.0) and its block-segmentation
models, run in a Web Worker with onnxruntime-web (MIT). `upstream.json` records the exact
commits, the archive hashes, the SHA-256 of every file here and of the ONNX runtime's wasm.
That wasm is not here: the extension ships one ONNX Runtime, the JSPI build of the pinned npm
package that the in-browser engine runs (`public/vendor/engine/`), and the worker's bundle
is built from that package's JSPI entry and reads that binary. The models carry no licence
of their own in the repository; they are distributed as part of it. The ONNX runtime's npm
package carries no licence file, so its MIT licence is kept here and pinned with the rest
(the notices of the libraries its WebAssembly links ship with the binary).

`worker.js` is built from `src/worker.js` — Anagram's entry, one `getStructure` call, or
for a long document Zotero's `getFullStructure` over a page range, numbered back into the
whole document — by the worker's own webpack build, then minified. `scripts/documentWorker.mjs` regenerates
everything from the pinned sources and rewrites the hashes; `scripts/vendor.mjs` verifies
them on every build and copies what the reader loads into `public/vendor/document-worker/`.
The reader loads it lazily, in the reader page only, and the worker fetches its data from
the extension's own URLs: the reader's CMaps and fonts, which the pin holds identical to the
fork's, and its own image decoders (`wasm/`, the fork's build of them, of an older PDF.js than
the reader's). Nothing is downloaded at build time or at run time.

To upgrade, change the commits in `upstream.json`, run `node scripts/documentWorker.mjs`,
run the PDF benchmark (`test/pdf-bench`) and the reader suites, and commit the result.
