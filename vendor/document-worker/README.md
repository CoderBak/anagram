# Pinned Zotero document-worker

The PDF reader's paragraphs come from Zotero's
[document-worker](https://github.com/zotero/document-worker) (AGPL-3.0): its pdf.js fork
(Apache-2.0), its structured-document-text library (AGPL-3.0) and its block-segmentation
models, run in a Web Worker with onnxruntime-web (MIT). `upstream.json` records the exact
commits, the archive hashes, the SHA-256 of every file here and of the ONNX runtime's wasm
that `scripts/vendor.mjs` takes from the pinned npm package at build time. The models
carry no licence of their own in the repository; they are distributed as part of it.

`worker.js` is built from `src/worker.js` — Anagram's entry, one `getStructure` call —
by the worker's own webpack build, then minified. `scripts/documentWorker.mjs` regenerates
everything from the pinned sources and rewrites the hashes; `scripts/vendor.mjs` verifies
them on every build and copies what the reader loads into `public/vendor/document-worker/`.
The reader loads it lazily, in the reader page only, and the worker fetches its data from
the extension's own URLs. Nothing is downloaded at build time or at run time.

To upgrade, change the commits in `upstream.json`, run `node scripts/documentWorker.mjs`,
run the PDF benchmark (`test/pdf-bench`) and the reader suites, and commit the result.
