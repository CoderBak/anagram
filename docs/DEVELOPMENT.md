# Development

Anagram is a browser extension (WXT, TypeScript) and a Python Native Messaging host.
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
| In-page rendering | `lib/render/scale.ts` (score to word, colour, doubt), `lib/render/badge.ts` (chips, card), `lib/render/highlight.ts` |
| Setup, popup, settings | `entrypoints/onboarding/`, `entrypoints/popup/`, `entrypoints/options/`; the engine panels and the rows they share are in `lib/ui/` (`engineCard.ts`, `inBrowserEngine.ts`, `componentSettings.ts`, `siteAccess.ts`, `pdfRows.ts`) |
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
nothing where the model does
not fit (the local engine alone where it installs). Where FP32 does not fit but FP16 does (`TIERS`, `affordable()`), the in-browser engine
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

`npm run check` runs every suite CI runs, in CI's order, and ends with a line per suite; one
this machine cannot run (no POSIX shell, no `ANAGRAMD_PYTHON`) is named and said why.
Commits marked `[skip ci]` never reach CI, so run it before handing work over. The suites
one at a time:

```sh
npm ci
npm run typecheck
npm run build
npm run test:node                  # vitest; the build checks skip, saying so, without a fresh build
npm run test:pw                    # every browser suite under test/pw (chromium)
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
node test/ui-screens.mjs <dir>       # screenshots of the setup page, Settings, popup and a page with chips, EN and ZH, light and dark, on stand-in devices with scripted engine states (test/pw/devices.mjs, test/webengine/scripted-engine.mjs)
npm run test:pdf-viewer            # upstream reader: find, zoom, recycling, file limits
npx playwright test                # the suites in test/pw/ (Playwright Test), no network; ANAGRAM_LIVE=1 adds the real sites; --repeat-each 10 hunts a flake, a failure keeps its trace
npm run test:pdf-install           # PDF setup and local-file access flow, EN and ZH
ANAGRAM_FIREFOX=<path to firefox> npm run test:firefox   # the Firefox build in Firefox 153+, e.g. the ESR in ~/anagram-bench/tools/firefox-esr/153.3.0esr/Firefox.app/Contents/MacOS/firefox, never installed
ANAGRAM_FIREFOX=<path to firefox> node test/webengine/firefox-extension.mjs   # the engine choice in Firefox, Native Messaging granted at run time; the in-browser engine's worker in the background page (--hf: 20 MB from Hugging Face)
npm run lint:firefox               # Mozilla's add-on linter on the Firefox build; accepted warnings in scripts/lintFirefox.mjs
npm run test:pdf-route             # PDF routing, handoff caps and privacy
npm run test:network-privacy       # the network promises in PRIVACY.md, for both engines
npm run bench:pdf -- run           # PDF reading benchmark, never in CI; ANAGRAM_PDF_BENCH is the corpus from test/pdf-bench/corpus.mjs, ~/anagram-bench/pdfbench/corpus when unset
ANAGRAM_PDF_BENCH=<corpus dir> node test/pdf-bench/bench.mjs structured <dumps>   # the shipping path, over test/pdf-bench/zotero-dump.mjs output; tune on --split dev, report --split test
node test/pdf-bench/olmocr.mjs <olmOCR-Bench bench_data> <out> --structure <dumps>   # olmOCR-Bench's column, page-furniture and small-print pages; scored by test/pdf-bench/olmocr-check.py with upstream's checks, never in CI
ANAGRAM_PDF_BENCH=<corpus dir> node test/pdf-bench/consistency.mjs <dumps> --features <structured run> --python <engine python> --modelkit <dir> --lid <file> --out <dir>   # the same papers' PDF and arXiv HTML verdicts with the real model, never in CI
npm run bench:web -- run   # web reading benchmark, never in CI; ANAGRAM_WEB_BENCH is the corpus from test/web-bench/corpus.mjs, ~/anagram-bench/webbench/corpus when unset; tune on --split dev, report --split test
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

## Safari

The Safari target is macOS only, Safari 27+ (WebAssembly JSPI). It uses the same setup
cards and Settings switch as Chrome and Firefox: recommended **One click** in the browser,
and optional **Terminal** for the separate engine on Apple Silicon Macs. Setup probes the
containing app without starting Python; temporary extensions and browser-only wrappers
have no XPC service, so they offer only the browser engine. Declaring `nativeMessaging`
does not select an engine. It is required in Safari, optional in Chrome/Firefox.

The browser engine checks the GPU and storage before downloading. It uses WebGPU without
a CPU fallback; FP16 is still chosen only where FP32 does not fit. A pinned extension tab
owns its worker while the service worker sleeps (`lib/webengine/safariTab.ts`). Local PDFs
use the reader's file picker because Safari cannot grant `file://` access.

The native bridge (`native/safari/`) routes request/reply Native Messaging through XPC to
the existing Python stdio host. Connections are scoped to Safari profiles; switching to
the browser engine closes the native connection and its child. The installer records
Safari inside the component home, without creating Chrome/Firefox host registrations.

```sh
npm run build:safari       # output/safari-mv3; does not launch Safari
npm run zip:safari         # Safari web resources ZIP under output/
npm run build:safari:app    # full local app with both engine paths; requires macOS/Xcode
npm run safari:project     # browser-only Xcode wrapper under dist/safari
```

Full app packaging generates a fresh project under `output/safari-app-*/`, archives it,
embeds the XPC service, signs locally, and prints the resulting app path. It never installs
or launches the app. The default is ad-hoc signing; set `ANAGRAM_APPLE_TEAM` and optionally
`ANAGRAM_SIGNING_IDENTITY` for a configured signing identity. No provisioning updates are
requested. Both the old converter/project.pbxproj and new packager/project.xcproj are
supported, with the extension's bundle ID explicitly prefixed by the app's ID.

The optional separate engine normally uses `~/.anagram`. To use a dedicated test home,
create an empty directory and set `ANAGRAM_SAFARI_HOME` to its absolute path when building
the app; its installer command will use that same home. Development builds keep the public
installer Copy button disabled: the next release must contain this updated installer and
component archive before the version-pinned command can be enabled. For an existing test
engine, point the app at its home. For a fresh install before publishing, create matching
release assets in a disposable checkout (`npm run release` replaces that checkout's
`dist/`), then run its `install.sh` with `ANAGRAM_BROWSER=safari`,
`ANAGRAM_EXTENSION_ID=dev.coderbak.Anagram.Extension`, `ANAGRAM_HOME` set to the same test
home, and `ANAGRAM_RELEASE_URL=file:///absolute/path/to/that/dist`.

`safari:project` only generates the browser-engine wrapper. It preserves existing Xcode
files; use `node scripts/safari.mjs --output dist/safari-next` for a new destination.
An ordinary Xcode Run of this generated project does not embed the optional XPC service;
use `build:safari:app` when verifying both engines, and rerun it after source changes.
[Apple's packaging instructions](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
cover the generated app and extension targets.

Real-Mac verification is pending. On a dedicated test Mac, run `npm run build:safari:app`,
open the app at the printed path, and enable Anagram in Safari's Extensions settings.
For ad-hoc development builds, enable Safari's developer option to allow unsigned
extensions. Then verify:

1. A fresh full-app install offers the shared One click / Terminal cards on Apple Silicon.
   One click downloads the pinned model and reaches Ready on WebGPU. A temporary extension
   offers only the browser engine. Unsupported adapters do not start a browser download.
2. Analyze an English article once, grant/revoke a site, and inspect paragraph chips,
   the toolbar result list, shortcuts, and settings in English and Chinese. Pin Anagram
   using the setup guide, reopen that guide from the popup, and use **Analyze document**
   on Google Docs. No floating button should appear on webpages.
3. Switch to another tab while scoring; allow the background to sleep; restart Safari;
   duplicate or close the engine tab. The next request recovers with one worker receiving
   requests, and cancelling a request does not affect another one.
4. Pause/resume a download, restart Safari during it, delete the model from Settings,
   and verify idle unload followed by a new score. An unavailable or lost GPU reports an
   error without starting a CPU provider.
5. Open an online PDF and a local PDF through the picker, use the Google Docs reader and
   Analyze text page, and confirm scoring still works offline after setup.
6. On Apple Silicon, use a separate test engine home to check Terminal setup, native
   scoring, and switching both ways in Settings. Leaving native mode must stop its Python
   process; leaving browser mode must close its engine tab. Check native update/removal
   and repeat the setup and switching checks in Chrome and Firefox with test profiles.

Record Mac/GPU, macOS/Safari versions, model tier, and any Safari extension-console error.
No runtime tests, model inference, or installation should be run in the developer's
local environment for this Safari work; final runtime testing is performed by the user
on real test computers.

## Release

`npm run bump <version>` rewrites the version in package files, `anagramd/pyproject.toml`
and `uv.lock`. `npm run release` builds both browser ZIPs, the component archive and
installers under `dist/` and runs `scripts/verify-release.py` on the ZIPs. Publishing is
manual. The install command shown in the extension is pinned to its own version, so a
release must ship matching assets. `npm run source-bundle` writes the source Firefox Add-ons
asks for, `dist/anagram-source-<version>.zip` (HEAD without `test/`, with its BUILDING.md).

## Open work

- PDF: whole-document reading (`lib/pdf/readAhead.ts`) works only with Zotero's structure;
  past its cap (`MOST_STRUCTURE_PAGES` in `entrypoints/reader/main.ts`: 2,500 pages; read
  without asking up to all of them at 8 GB of device memory, 600 at 4, 300 below or unknown,
  and past that when the menu's **Read the whole document** asks), or without it, the reflow
  reads the drawn pages alone, because its text depends on the run of pages reflowed together.
  Zotero reads a document past 1,000 pages in even ranges, a worker each, through a page-range
  view of the document in our entry (`vendor/document-worker/src/worker.js`): its own
  `getFullStructure` reads every page at once and holds them all, 2.7 GB of the reader's
  process at 2,445 pages. In ranges that book took 27.5 s to its structure, the process
  peaking at 2.0 GB, 680 MB of page memory falling to 310 MB as it was read, and one 0.3 s
  pause as the structure came, with no script in it (a collection of the large heap); an
  813-page book, 9.6 s and 270 MB, no pause over 150 ms (2026-10-04, M4). What Zotero works out
  over the document — running heads, reference lists, the outline's pages — it works out over
  a range; a link or outline entry to a page outside the range resolves to nothing.
- PDF: the rest of a paragraph Zotero set outside the body — under a figure it cut off
  (`auxiliary`), or at the foot of a page taken for its footer (`excluded`) — is read with its
  paragraph where it opens in lower case after a paragraph left open, is set at the body's
  dominant size (the size most of its characters are in), lies in the type area (the median of
  the pages' outermost body lines) and in no figure's or table's box (`carriesOnBody` in
  `lib/pdf/structured.ts`). The type area is what keeps out the arXiv stamp in the margin, which
  is lower case and at body size on nearly every preprint. A paragraph that opens with a formula
  and then lower case is sewn to the one before after assembly, when the formula is left out
  (`sewn`). Measured on the benchmark's dev and held-out test halves alike (2026-10-04):
  boundary precision 94.7 → 95.1% and 94.8 → 95.2%, leakage unchanged.
  The other tails the benchmark loses (`test/pdf-bench`, 46 of 15,089 paragraphs losing their
  last eight tokens, 2026-10-04) are mostly not losses: formulas the truth leaves out, and
  acronyms LaTeXML expands. The real ones left are Zotero's segmentation, one to three papers
  each: a line taken into the caption beside it ("Fig. 5: … (right). of our framework
  beyond…") or into a display equation. No rule from geometry tells those lines apart without
  misreading others: over the corpus, 853 captions and thousands of equations follow a
  paragraph left open, captions are often set at the body's size, and equations open with a
  line at it, so a split by size would cut far more captions and equations wrongly than it
  mends. The fix belongs to Zotero's segmentation model.
- Installer recovery on Windows: two component homes registering one browser race on
  the HKCU keys (`installer/native_registration.py`), and an interrupted uninstall is
  finished only by reinstalling or deleting the folder (`installer/maintenance.ps1`).
- Windows and Linux have not been exercised on real machines.
