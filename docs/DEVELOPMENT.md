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
| Page capture and scheduling | `entrypoints/content.ts` (a page's top frame; the frames below it from `entrypoints/frame.content.ts`, a stub that asks for it, `lib/dom/frameGate.ts`), `lib/capture/orchestrator.ts`, `lib/capture/scheduler.ts`, `lib/dom/walker.ts` |
| Sites the walk cannot read (Google Drive's preview, pdf.js viewers) | `lib/surfaces/` (an on-demand chunk; fixtures in `test/fixtures/surfaces/`) |
| In-page rendering | `lib/render/scale.ts` (score to word, colour, doubt), `lib/render/badge.ts` (chips, card), `lib/render/highlight.ts` |
| Setup, popup, settings | `entrypoints/onboarding/`, `entrypoints/popup/`, `entrypoints/options/`; the engine panels and the rows they share are in `lib/ui/` (`engineCard.ts`, `inBrowserEngine.ts`, `componentSettings.ts`, `siteAccess.ts`, `pdfRows.ts`) |
| PDF reader | `entrypoints/reader/`, `lib/pdf/structured.ts` (Zotero's structure onto pdf.js's text layer), `lib/pdf/reflow.ts` (the fallback), `lib/pdf/reading.ts` (what of either one's paragraphs is read), `lib/pdf/handoff.ts`, `vendor/pdfjs/`, `vendor/document-worker/` (pinned by `scripts/documentWorker.mjs`) |
| Native host: protocol, ownership, lifecycle | `anagramd/native_host.py`, `anagramd/native_component.py` |
| In-browser engine: the native host's contract in a Web Worker | `lib/webengine/engine.ts` (lifecycle, operations), `session.ts` (ONNX Runtime Web, WebGPU or WASM), `onnx.ts` (the graph whose weights are read from the file), `host.ts` (the worker as a port; ends it when idle), `download.ts` and `storage.ts` (resumable, verified downloads into OPFS), `autoSetup.ts` (the download started by itself), `tokenizer.ts`, `clean.ts`, `fasttext.ts`; `client.ts` (the transport the background uses), `entrypoints/engine/` (Chrome's offscreen document); `scripts/webengine.mjs` builds `public/vendor/engine/` |
| Inference and runtime selection | `anagramd/engine.py`, `anagramd/runtime_controller.py`, `anagramd/runtime_adapters.py`, `anagramd/model_plan.py` |
| Model download | `anagramd/download_modelkit.py`, `anagramd/hub_transfer.py`, `anagramd/prepare_models.py`, `anagramd/modelkit.json` |
| Install, update, uninstall | `install.sh`, `install.ps1`, `installer/native_registration.py`, `installer/anagram` |
| Reading statistics | `lib/stats/config.ts` (dimensions, layers, presets), `lib/stats/recorder.ts` (the page's half, a chunk loaded through `lib/stats/meter.ts`), `lib/stats/wire.ts` (its messages), `lib/stats/worker.ts` (what the worker keeps), `lib/stats/tabs.ts`, `lib/stats/store.ts`, `lib/stats/lens.ts` and `summary.ts` (what the page shows), `lib/stats/export.ts` and `dictionary.ts`, `entrypoints/stats/`; [statistics.md](statistics.md) |
| Localization | `public/_locales/en/`, `public/_locales/zh_CN/`, `scripts/i18nSubset.ts` |
| Every chosen value: thresholds, limits, timings, defaults | [hyperparameters.md](hyperparameters.md): each with where it is set, what it rests on and what moving it changes (a snapshot; the code wins) |

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
- The standard fonts are PDF.js's own, as its release ships them: since PDF.js 6 that includes
  Liberation Sans 1.07.4, under GPL-2.0 with Red Hat's font exceptions, not 2.x under the OFL
  (the maintainer's decision, 2026-10-10). THIRD_PARTY_NOTICES.md names the licence and the
  source.

## Engines

One extension carries both engines; the person's choice (`storage.local` `engine`) decides
at run time, and `engineTransport()` (`lib/backend/engines.ts`) is the one in use. Before
anything is chosen the setup page decides (`lib/device.ts`, `lib/ui/engineCard.ts`): the
choice on Apple Silicon and on Linux beside an NVIDIA GPU, the in-browser engine by itself elsewhere
(Windows beside an NVIDIA GPU included: PyPI's Windows Torch has no CUDA),
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
this machine cannot run (no POSIX shell, no `ANAGRAMD_PYTHON`, no `ANAGRAM_FIREFOX`) is named
and said why. It runs the Firefox suites where `ANAGRAM_FIREFOX` names a Firefox 153 or newer,
and the release-signature check (`test/release-signature.sh`) where PyPI answers.
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
npx @puppeteer/browsers install firefox@esr_153.3.0esr --path <dir>   # a Firefox ESR to drive, never installed (<dir>/firefox/mac_arm-esr_153.3.0esr/Firefox.app/Contents/MacOS/firefox on Apple Silicon; ~/anagram-bench/tools/firefox-esr/153.3.0esr/ has one); headless, temporary profile and HOME
ANAGRAM_FIREFOX=<path to firefox> npm run test:firefox   # the Firefox build in Firefox 153+: the full viewer, PDF routing, the shipping build on a granted site (test/shipping-firefox.mjs: closed chips, nothing announced, no icon reachable, frame partitions), the self-test page with what Firefox does its own way, and the diagnostics copy
ANAGRAM_FIREFOX=<path to firefox> node test/csp-firefox.mjs        # the extension's policy as Firefox applied it, and a page whose own policy refuses inline styles
ANAGRAM_FIREFOX=<path to firefox> node test/webengine/firefox-extension.mjs   # the engine choice in Firefox, Native Messaging granted at run time; the in-browser engine's worker in the background page (--hf: 20 MB from Hugging Face)
npm run lint:firefox               # Mozilla's add-on linter on the Firefox build; accepted warnings in scripts/lintFirefox.mjs
npm run test:pdf-route             # PDF routing, handoff caps and privacy
npm run test:network-privacy       # the network promises in PRIVACY.md, for both engines
npm run bench:pdf -- run           # PDF reading benchmark, never in CI; ANAGRAM_PDF_BENCH is the corpus from test/pdf-bench/corpus.mjs, ~/anagram-bench/pdfbench/corpus when unset
ANAGRAM_PDF_BENCH=<corpus dir> node test/pdf-bench/bench.mjs structured <dumps>   # the shipping path, over test/pdf-bench/zotero-dump.mjs output; tune on --split dev, report --split test
node test/pdf-bench/olmocr.mjs <olmOCR-Bench bench_data> <out> --structure <dumps>   # olmOCR-Bench's column, page-furniture and small-print pages; scored by test/pdf-bench/olmocr-check.py with upstream's checks, never in CI
ANAGRAM_PDF_BENCH=<corpus dir> node test/pdf-bench/consistency.mjs <dumps> --features <structured run> --python <engine python> --modelkit <dir> --lid <file> --out <dir>   # the same papers' PDF and arXiv HTML verdicts with the real model, never in CI
npm run bench:web -- run   # web reading benchmark, never in CI; ANAGRAM_WEB_BENCH is the corpus from test/web-bench/corpus.mjs, ~/anagram-bench/webbench/corpus when unset; tune on --split dev, report --split test
ANAGRAM_PERF_MATRIX=1 npx playwright test --project perf --no-deps perf-matrix   # what Anagram costs each kind of page against a plain browser (real corpus pages, a page left idle, a huge table, a chat, route changes, the menu, Analyze text), the browser's own work included; THROTTLE=4 for a slow machine; SAVE_PROFILE=<prefix> then node test/perf-profile.mjs <profile> says which code ran in the longest tasks
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
installers under `dist/` and runs `scripts/verify-release.py` on the ZIPs: a local check,
unsigned. A release is published by `.github/workflows/release.yml`, dispatched by hand from
its version tag, which runs the CI matrix, builds the same assets, signs each with Sigstore
(keyless, its certificate naming that workflow at that tag) and attaches them with their
`.sigstore.json` bundles. `install.sh` and `install.ps1` install a release fetched over
HTTPS only with that signature (`installer/verify_release.py`, with sigstore-python pinned
in `installer/sigstore.txt`; `node scripts/sigstoreLock.mjs` after changing
`installer/sigstore.in` or the script, and a newer sigstore-python whenever Sigstore rotates
its keys, since installers that cannot reach Sigstore verify against the trust root it
carries); a release given as a `file://` address is checked by its checksum alone. The
install command shown in the extension is pinned to its own version, so a release must ship
matching assets. `npm run source-bundle` writes the source Firefox Add-ons
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
  peaking at 2.0 GB, 195 MB of page memory as the structure came rising to 310 MB as it was
  read (the glyphs of the paragraphs not read yet are kept packed, `packPieces` in
  `lib/pdf/structured.ts`: 525 MB of them as objects; each is packed as it is drafted, and
  preparing a 2,448-page structure holds some 160 MB beside it, not 1 GB), and no frame over 150 ms as the
  structure came (the reader's preparation goes 32 blocks at a time; it was a 0.3 s pause in
  one piece); an 813-page book, 9.6 s and 270 MB, no pause over 150 ms (2026-10-04, M4). What Zotero works out
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
- In-browser engine on the processor: ONNX Runtime Web's published binaries use fixed-width
  WebAssembly SIMD only (none of the relaxed-SIMD opcodes, 0xFD 0x100–0x113, is in the 1.30.0
  binaries' code). Its build has `--enable_wasm_relaxed_simd` (`-mrelaxed-simd`, which MLAS's
  kernels can use for fused multiply-adds), but no published artefact is built with it; using
  it means building ONNX Runtime with Emscripten ourselves, shipping a binary that is not the
  pinned npm package's, and keeping the plain one for Safari, which has no relaxed SIMD.
- Security, still open (review of 2026-10-04):
  - A first install runs `install.sh` (or `install.ps1`) as the release serves it, before
    anything is verified: whoever can replace release assets can replace the installer too.
    Releases are signed now, and updates run the installed installer; the setup page's
    command could also carry the installer's SHA-256 (the extension is built from the same
    tree, `lib/ui/installationCommand.ts`).
  - The local engine parses page text (fastText, tokenizers, ONNX Runtime, MLX) in a process with
    the user's privileges; a sandboxed inference child (Seatbelt, seccomp and Landlock) would
    contain a parser bug.
  - A tab holds half the router's admission at most (`ROUTER_LIMITS`), so one page's frames
    cannot leave the other tabs Unavailable; two tabs of one hostile site still can, for as
    long as both are open.
  - `CSS.highlights` shows a page the marks on its own text, and so the flag level and whether
    underlines are on; a page can tell chips are there.
  - A getter of the page's own in the options it passes to `attachShadow` runs with the
    page-world script's frame under it (entrypoints/shadow.content.ts): in Chrome that frame
    names the extension's id; in Firefox it is "<anonymous code>". Any wrapper has a frame there.
  - The extension pages keep `style-src 'unsafe-inline'`. Dropping it needs the `<style>` blocks
    of the setup page, Settings, the popup and Analyze text moved into files, and the
    `style="…"` the setup page's legend and the reader's print dialog write turned into classes
    (the marks' rules are a constructed sheet already, and the card's marker and pending line no
    longer write a style attribute). It buys little: no script runs inline, and with `img-src`
    and `font-src` held to the extension, injected CSS has no address to send what it matches to.
- Performance, still open (traces of 2026-10-05, M4, against the same page without Anagram):
  - A changing page's frames: Chromium takes every registered highlight range out of the page's
    markers and puts it back at every change of the DOM or of style, and repaints every marked
    text (HighlightRegistry::ValidateHighlightMarkers). On the Reddit-like feed of budget G the
    marks cost ~230 ms of compositing inputs, ~240 ms of paint and ~150 ms of intersection
    observing a minute (a build without them). Registering only the marks on screen instead of
    within a screen of it saved some 50 and 100 ms and would draw marks a frame late on a fast
    scroll. Chips are not it: 400 chips with their paint layers (`position: relative`,
    `contain: layout`) or without, ten inserted or removed a second, cost the same frames.
  - A feed's walks: what the page's light DOM decides is kept between walks
    (`lib/dom/kept.ts`), but a feed changes it between any two drains (a class on the post
    entering view, a counter), so recognising its posts (`lib/dom/scope.ts`) is made again
    each time: half of what a drain costs there.
  - The content script is 242 KB, parsed and compiled at every load of a granted page's top
    frame: ~11.5 ms (V8's preparse 6 ms; content scripts get no code cache), ~17 ms over a plain
    browser on a page with nothing to read. V8's explicit compile hint
    (`//# allFunctionsCalledOnLoad`) made it 16 ms. The frames below the top run a 6 KB stub
    instead (`entrypoints/frame.content.ts`), which has the worker inject the content script
    (`readFrame`, `scripting.executeScript` into that document) once the frame is large enough
    and holds text. A top frame with nothing to read still pays it: told apart at
    document_end, Google Docs' canvas and pages whose text comes later or sits in shadow roots
    would be passed over.
- Hostile pages and documents (fuzzing of 2026-10-04: `test/unit.mjs` "pages built to break the
  reader", `test/pw/hostile-pages.spec.mjs`, `test/node/pdfStructuredProps.test.ts`, and the
  hostile-input cases in `test/native_host.py`). The limits are where they apply:
  `MAX_WALK_DEPTH` and `MOST_NODES_UNPAUSED` (`lib/dom/walker.ts`), `MOST_HELD`
  (`lib/capture/observers.ts`), `SEARCHES_PER_CHAR` (`lib/pdf/reading.ts`), `MAX_NESTING`
  (`lib/pdf/structured.ts`), `LONGEST_WORD` (`lib/pdf/reflow.ts`), `lib/pdf/arrays.ts` for
  spreads; a sweep of every regex in `lib/` over pumped strings found the ones made linear.
  Left as they are, each linear in what the page or the PDF holds: a paragraph is read in one
  step once the walk has reached its end, about 1 s of an M4's main thread for one of 10 MB or
  of a million inline elements (the page's own layout of it costs as much), and a stretch of a
  hundred thousand short paragraphs of one voice is divided in one step (1.6 s).
  A run of pdf.js's whose characters Zotero's glyphs do not match is searched from its start
  for each of them (`locate`), square in the run's length; no PDF has shown it. Chromium itself
  stops laying out a page at about 2,000 nested blocks, 20,000 nested inline elements, 1,000
  nested shadow roots of blocks or 500 nested positioned boxes, before any of it reaches Anagram.
- Dependency audit (2026-10-04). Every package in `package-lock.json` (586) and
  `anagramd/uv.lock` (68) was checked against OSV (`api.osv.dev/v1/querybatch`) and
  `npm audit --package-lock-only`, with what Zotero's worker bundles (its pdf.js fork, pako,
  fastest-levenshtein). The Python lock had no advisories. Of what ships, two have one each, and
  neither can be reached in Anagram: pdf.js 5.7.284 (GHSA-hq66-cqwq-w95j, fixed in 6.2.108)
  runs script through the PDF-scripting sandbox's bridge, and the reader sets
  `enableScripting: false`, never ships the sandbox (quickjs, left out by `scripts/vendor.mjs`)
  and allows no inline script or eval; DOMPurify 3.4.15 (GHSA-p98j-92pf-mc4p) needs an
  `afterSanitize` hook that removes nodes, and the Docs reading view registers no hook and
  sanitizes an inert `DOMParser` document. Zotero's pdf.js fork (f4d05ca, a 5.7 pre-release of
  2026-08-14) is past the font-eval fix of CVE-2024-4367: it builds glyph paths as number
  arrays, has no `isEvalSupported` and no scripting; its one `new Function` is ONNX Runtime
  Web's embind glue, which never sees the PDF and which the extension's CSP refuses like any
  eval (the worker is an extension resource, under that CSP). The rest are in tools that never
  ship (postcss and nanoid under Vite, node-forge under web-ext, vitest, esbuild's dev server on
  Windows). Both are upgraded since (2026-10-10): pdf.js to 6.4.299, its hash-pinned viewer
  and engine together (the document-worker keeps its fork's own image decoders, and the reader
  asks for `fontExtraProperties`, without which PDF.js 6 names no font), and DOMPurify to
  3.4.16. Run the same checks before a release that moves a lock.
- Windows and Linux have not been exercised on real machines.
