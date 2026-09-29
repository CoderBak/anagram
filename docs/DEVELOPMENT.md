# Development

Anagram is a Chrome extension (WXT, TypeScript) and a Python Native Messaging host.
Content scripts extract prose, the background worker authorizes and batches requests,
and one of two engines scores them with EditLens: the same model inside the browser, or
the local engine under `~/.anagram` (Engines, below). There is no HTTP service anywhere.
Work on `dev`; `main` holds the published README only.

## Code map

| Area | Start here |
| --- | --- |
| Manifest, CSP, builds | `wxt.config.ts`, `scripts/release.mjs`, `scripts/verify-release.py` |
| Engines: which one a device runs, and the switch | `lib/device.ts`, `lib/ui/engineCard.ts`, `lib/backend/engines.ts`, `lib/backend/transport.ts` |
| Third-party notices | `scripts/notices.mjs` writes `THIRD_PARTY_NOTICES.md`; the build and `test/node/notices.test.ts` refuse what it does not list |
| Background: authorization, site access, message ACL | `entrypoints/background.ts`, `lib/access/`, `lib/messaging/protocol.ts` |
| Scoring router and cache | `lib/backend/router.ts`, `lib/backend/swCache.ts`, `lib/backend/nativeTransport.ts` |
| Page capture and scheduling | `entrypoints/content.ts`, `lib/capture/orchestrator.ts`, `lib/capture/scheduler.ts`, `lib/dom/walker.ts` |
| Sites the walk cannot read (Google Drive's preview, pdf.js viewers) | `lib/surfaces/` (an on-demand chunk; fixtures in `test/fixtures/surfaces/`) |
| In-page rendering | `lib/render/scale.ts` (score to word, colour, doubt), `lib/render/badge.ts` (chips, card), `lib/render/fab.ts` (ball, panel), `lib/render/highlight.ts`, `lib/render/report.ts` and `lib/render/textFragment.ts` (the copied report's states and paragraph links; it is written in `lib/capture/orchestrator.ts`) |
| Setup, popup, settings | `entrypoints/onboarding/`, `entrypoints/popup/`, `entrypoints/options/`, `lib/ui/componentSettings.ts` |
| PDF reader | `entrypoints/reader/`, `lib/pdf/structured.ts` (Zotero's structure onto pdf.js's text layer), `lib/pdf/reflow.ts` (the fallback), `lib/pdf/reading.ts` (what of either one's paragraphs is read), `lib/pdf/handoff.ts`, `vendor/pdfjs/`, `vendor/document-worker/` (pinned by `scripts/documentWorker.mjs`) |
| Native host: protocol, ownership, lifecycle | `anagramd/native_host.py`, `anagramd/native_component.py` |
| In-browser engine: the native host's contract in a Web Worker | `lib/webengine/engine.ts` (lifecycle, operations), `session.ts` (ONNX Runtime Web, WebGPU or WASM), `onnx.ts` (the graph whose weights are read from the file), `host.ts` (the worker as a port; ends it when idle), `download.ts` and `storage.ts` (resumable, verified downloads into OPFS), `autoSetup.ts` (the download started by itself), `tokenizer.ts`, `clean.ts`, `fasttext.ts`; `client.ts` (the transport the background uses), `entrypoints/engine/` (Chrome's offscreen document); `scripts/webengine.mjs` builds `public/vendor/engine/` |
| Inference and runtime selection | `anagramd/engine.py`, `anagramd/runtime_controller.py`, `anagramd/runtime_adapters.py`, `anagramd/model_plan.py` |
| Model download | `anagramd/download_modelkit.py`, `anagramd/hub_transfer.py`, `anagramd/prepare_models.py`, `anagramd/modelkit.json` |
| Install, update, uninstall | `install.sh`, `install.ps1`, `installer/native_registration.py`, `installer/anagram` |
| Localization | `public/_locales/en/`, `public/_locales/zh_CN/`, `scripts/i18nSubset.ts` |

## Decisions that hold

- Setup is automatic. After model files are prepared the engine detects devices and
  activates the best FP32 configuration itself. Benchmarking and switching are optional.
- The browser starts a per-profile host over stdio. One component home has one owner.
- Model weights are the pinned public modelkit in `anagramd/modelkit.json`, downloaded
  anonymously with SHA-256 verification. License is CC BY-NC-SA 4.0.
- Website access is optional and granted by the user. The shipping manifest declares no
  host permissions; the content script is registered at runtime from grants.
- The complete upstream PDF.js viewer ships unmodified and hash-pinned, and so does the
  build of Zotero's document-worker that reads the PDF's paragraphs (`vendor/document-worker/`,
  regenerated from the pinned commits by `scripts/documentWorker.mjs`). The reader's own
  reflow stays as the fallback while the worker runs and where it cannot.

## Engines

One extension carries both engines; the person's choice (`storage.local` `engine`) decides
at run time, and `engineTransport()` (`lib/backend/engines.ts`) is the one in use. Before
anything is chosen the setup page decides (`lib/device.ts`, `lib/ui/engineCard.ts`): the
choice on Apple Silicon and beside an NVIDIA GPU, the in-browser engine by itself elsewhere,
the local engine alone without WebAssembly JSPI (Firefox 140), nothing where the model does
not fit. Where FP32 does not fit but FP16 does (`TIERS`, `affordable()`), the in-browser engine
runs the modelkit's FP16 model on WebGPU; the page's tier travels with `setEngine` into
`local:engineTier` and to the engine in its pin (`lib/webengine/tier.ts`). Native Messaging is optional and asked for when the local engine is picked; where
it is granted and nothing was chosen (an update from 0.7.0, which required it) the local
engine is the one in use. The test build requires it, so the fake-host suites drive the
local engine; the suites stand in for other devices with copies of the test build carrying
`test-device.json` (`test/test-build.mjs` `deviceBuild`, `test/pw/devices.mjs`), which only
the test build reads.

## Checks

Node 22 and Python 3.12. Build before browser suites; the test build grants all
sites and lands in `output-test/`, the shipping build in `output/`.

```sh
npm ci
npm run typecheck
npm run build
npm run test:node                  # vitest; some suites skip without a fresh build
npx playwright install chromium
npm run test:unit                  # DOM walker cases in a blank page
npm run test:e2e                   # extension against a deterministic fake host
npm run test:scenarios             # the scenario matrix over fixture pages, the PDF reader and real sites
npm run test:scenarios -- --project chromium   # the same without the real sites: no network
npm run test:a11y
npm run test:native                # real stdio host fixture, EN and ZH setup
npm run test:inbrowser             # the engine choice per device and the in-browser engine's setup, with Hugging Face served locally (test/webengine/model-server.mjs), EN and ZH; --real downloads the real files to Ready
npm run test:paste                 # the paste page, pass readout and report
npm run test:pseudo-locale         # every page in a stretched pseudo-locale, Chinese and English: nothing cut off, off-page or overlapping
npm run test:pdf-viewer            # upstream reader: find, zoom, recycling, file limits
npx playwright test                # the suites in test/pw/ (Playwright Test), no network; ANAGRAM_LIVE=1 adds the real sites; --repeat-each 10 hunts a flake, a failure keeps its trace
npm run test:pdf-install           # PDF setup and local-file access flow, EN and ZH
ANAGRAM_FIREFOX=<path to firefox> npm run test:firefox   # the Firefox build in Firefox 140+, e.g. an ESR from archive.mozilla.org, never installed
ANAGRAM_FIREFOX=<path to firefox> node test/webengine/firefox-extension.mjs   # the engine choice in Firefox, Native Messaging granted at run time; in 153+ the in-browser engine's worker in the background page (--hf: 20 MB from Hugging Face)
npm run lint:firefox               # Mozilla's add-on linter on the Firefox build; accepted warnings in scripts/lintFirefox.mjs
npm run test:pdf-route             # PDF routing, handoff caps and privacy
npm run test:network-privacy       # the network promises in PRIVACY.md, for both engines
npm run bench:pdf -- run           # PDF reading benchmark, never in CI; ANAGRAM_PDF_BENCH is the corpus from test/pdf-bench/corpus.mjs, ~/anagram-bench/pdfbench/corpus when unset
ANAGRAM_PDF_BENCH=<corpus dir> node test/pdf-bench/bench.mjs structured <dumps>   # the shipping path, over test/pdf-bench/zotero-dump.mjs output; tune on --split dev, report --split test
node test/pdf-bench/olmocr.mjs <olmOCR-Bench bench_data> <out> --structure <dumps>   # olmOCR-Bench's column, page-furniture and small-print pages; scored by test/pdf-bench/olmocr-check.py with upstream's checks, never in CI
ANAGRAM_PDF_BENCH=<corpus dir> node test/pdf-bench/consistency.mjs <dumps> --features <structured run> --python <engine python> --modelkit <dir> --lid <file> --out <dir>   # the same papers' PDF and arXiv HTML verdicts with the real model, never in CI
npm run bench:web -- run --scope page   # web reading benchmark (or --scope main), never in CI; ANAGRAM_WEB_BENCH is the corpus from test/web-bench/corpus.mjs, ~/anagram-bench/webbench/corpus when unset; tune on --split dev, report --split test
ANAGRAM_EDITLENS_DATA=<EditLens checkout + data> ANAGRAM_MODELKIT=<modelkit> ANAGRAM_LID_MODEL=<lid.176.ftz> python test/editlens-parity.py   # the native host against Pangram's official inference, never in CI
node test/webengine/engine-browser.mjs   # the in-browser engine's worker build on a tiny model in a temporary Chromium, under the extension's CSP: download, WebGPU and WASM, idle unload, restart, deletion
ANAGRAM_MODELKIT=<modelkit> ANAGRAM_LID_MODEL=<lid.176.ftz> ANAGRAM_PARITY_SAMPLE=<sample.json> node test/webengine/parity.mjs   # the in-browser engine (WebGPU and WASM) against the official probabilities and the native counts, with speed and memory, in a Chromium profile under the temp directory (--clean removes it; --firefox <binary> for a Firefox ESR); the sample comes from test/webengine/parity-sample.py; never in CI
ANAGRAM_MODELKIT=<modelkit> node test/webengine/extension.mjs   # the in-browser engine scoring for real through background, offscreen document and worker, model files seeded into OPFS from a local server, with the browser's peak memory; --idle waits out the idle unload and checks the memory is given back; --warm times the first verdict after it, with and without the warm-up a page opening in front gives the engine; never in CI
```

Backend and installer tests need a Python venv with the test dependencies only:

```sh
uv venv --python 3.12 /tmp/anagram-venv
uv pip install --python /tmp/anagram-venv/bin/python numpy 'pydantic>=2' emoji filelock psutil 'huggingface_hub==1.31.0'
ANAGRAMD_PYTHON=/tmp/anagram-venv/bin/python npm run test:backend
npm run test:installer
```

Every suite uses temporary homes and temporary browser profiles. Never point a test at
the real `~/.anagram`. Fixture scores are a pure function of the text and say nothing
about model quality. `test/native-real.py` and `test/editlens-parity.py` are the
real-model checks; they need existing verified weights and `(cd anagramd && uv sync --frozen)`.

## Release

`npm run bump <version>` rewrites the version in package files, `anagramd/pyproject.toml`
and `uv.lock`. `npm run release` builds both browser ZIPs, the component archive and
installers under `dist/` and runs `scripts/verify-release.py` on the ZIPs. Publishing is
manual. The install command shown in the extension is pinned to its own version, so a
release must ship matching assets. `npm run source-bundle` writes the source Firefox Add-ons
asks for, `dist/anagram-source-<version>.zip` (HEAD without `test/`, with its BUILDING.md).

## Open work

- Follow the reader: score what is on screen after a short dwell, skip fast scrolling,
  bound queued work per document. Hooks are in `lib/capture/observers.ts` and
  `lib/capture/scheduler.ts`.
- PDF: keep results across PDF.js page recycling (`entrypoints/reader/main.ts`,
  `lib/pdf/units.ts`), and raise the 300-page cap on Zotero's structure by decoding a
  block's glyphs only while its pages are rendered (`lib/pdf/structured.ts` keeps them all).
- Installer recovery on Windows: two component homes registering one browser race on
  the HKCU keys (`installer/native_registration.py`), and an interrupted uninstall is
  finished only by reinstalling or deleting the folder (`installer/maintenance.ps1`).
- Windows and Linux have not been exercised on real machines.
