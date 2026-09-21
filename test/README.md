# Local download-plan UI check

After `npm run build`, run `node test/download-plan.mjs`. This uses isolated Chromium
profiles and a deterministic Native Messaging fixture; it does not download models or
touch the user's local component. It checks English/Chinese detection and verification
progress, explicit profile actions, resume compatibility, safe text rendering, light/dark
accessibility and 400 px layout. Screenshots are under `test-results/download-plan/`.

# Local extraction benchmark

Run `node test/extraction-benchmark.mjs` from the extension directory after `npm ci` and installing the Playwright Chromium browser used by the existing suites. It launches a disposable headless browser, uses only local fixtures, blocks network requests, and writes JSON under the ignored `test-results/extraction/` directory. No extension installation, native host or model weights are needed.

Use `node test/extraction-benchmark.mjs --runs 30 --warmup 3` to change the sample count. Defaults are 15 measured runs and two warmups. This is an observational benchmark with no timing thresholds. Compare reports from the same machine/browser and avoid concurrent browser or model tests.

The report includes raw samples and p50/p90 milliseconds for whole-page DOM collection, `findMainContent` (with the installed Mozilla Readability implementation, including its live-DOM mapping/fallback), and collection within the selected main region. Article, X, LinkedIn, Docs static-reading and 100-comment fixtures are reused; the large case copies those comments to 1,000, and the deep case wraps the article in 128 nested elements. Docs uses the local scenario's reading-view shape, not an authenticated Google document or its canvas editor.

Each scope reports units, words, source-node/range counts and the fraction of planned scoring windows that map to nonempty ranges over connected source nodes. This measures provenance availability, not extraction precision/recall or detector accuracy. The report also records whether output counts stayed stable across samples, the fixture hash, revision, browser, Node and CPU. Document creation, warmups and source-range verification are excluded from the measured extraction durations.

PDF results are a separate `structured-pdf` layer: existing test paragraphs and placed glyph geometry enter the real `reflowPdf` and `createPdfUnitSource` pipelines. Reflow and unit construction are timed separately; the actual PDF source-range mapper is measured for coverage. The report explicitly excludes PDF byte parsing, font decoding, rendering, OCR and model inference. It does not claim an end-to-end PDF load benchmark; the existing PDF browser/performance suites cover that flow. Inserted reflow spaces may have no source glyph, so `source_run_chars` need not equal `reflow_chars`.

# Full PDF.js viewer

After `npm run build`, run `node test/pdf-viewer.mjs`. It loads the shipping extension
in a temporary Chromium profile with the isolated native fixture, switches offline, and
opens local PDF bytes. Checks cover the upstream viewer controls, password replacement,
search and recycled text-layer mapping, visible-page analysis, scope notices, zoom,
rotation, source-byte preservation, download, and the print rendering pipeline. The
native print call is replaced in the test; no printer or OS print dialog is exercised.
Screenshots and the downloaded fixture are under `test-results/pdf-viewer/`.

After `npm run build:firefox`, `node test/pdf-viewer-firefox.mjs` runs a smaller local
Firefox check with the same fixture isolation. Firefox BiDi cannot operate the native
file picker or input actions in privileged extension pages, so this test supplies a
real `File` through `DataTransfer` and dispatches the normal input/control events.
This checks the product handlers and PDF.js, not the OS picker. No CI, installed user
profile, real model, or user component is involved in either script.

`node test/pdf-install-flow.mjs` verifies the English/Chinese local-file settings in
fresh Chrome profiles. Its separately marked file-access fixture pregrants only the
file origin because the native permission prompt is not automated; the browser's
actual file-access switch, offline auto-opening and original-reader bypass are tested.
The shipping extension retains optional file access. `node test/pdf-source-firefox.mjs`
checks authorized online handoff using only a local HTTP fixture, including MIME-based
routing, cookies, original-reader bypass and forged-ticket rejection.

`node test/csp-check.mjs --chrome-only` exercises actual browser connection restrictions.
The native fixtures are deterministic: these PDF tests establish integration behavior,
not model accuracy or real-model offline inference. See [network verification](../docs/network-privacy.md)
for the separate fresh-text, real-engine offline check.

`node test/pdf-codecs-check.mjs` uses the existing shipping Chrome build to verify
packaged JPEG 2000 and JBIG2 WASM decoders. It waits for completed page rendering and
checks fixture pixels plus CSP/console errors, without a rebuild or source-site grant.
The PDF section of `test/perf.mjs` measures the first rendered page/text layer, initial
visible-page reflow, and retained canvases after scrolling; it does not measure complete
document analysis or reuse the former eager full-document extraction metric.
