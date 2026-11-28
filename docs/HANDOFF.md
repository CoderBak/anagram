# Handoff

This file records where `dev` stands, what waits on a maintainer, and what is still open, in priority order. It was last updated 2026-11-28.

Anagram 0.12.2 fixes focus in open annotation cards, Chrome port cleanup on Back navigation
and repeated Qwen startup warnings. Both browser ZIPs were published directly and matched
their SHA-256 checksums after anonymous download. The packaged PDF reader opened the reported
26-page paper in Chromium and a two-page document in Firefox ESR 153.3. The README links
to these ZIPs. GitHub’s Latest pointer serves v0.12.0 for the signed native installer.
[Browser release and downloads](https://github.com/CoderBak/anagram/releases/tag/v0.12.2)

Anagram 0.12.1 moved reading preferences onto the setup page and aligned the model download
controls. Both public browser ZIPs matched their SHA-256 files.
[Browser release and downloads](https://github.com/CoderBak/anagram/releases/tag/v0.12.1)

Anagram 0.12.0 is the latest signed GitHub release. It adds Google Docs tab support, reads short
paragraphs together within a section, clears stale chat results and makes original PDF links
easier to open. The requested release skipped the macOS CI suite. All six public downloads
matched their SHA-256 files and carried signature bundles naming the v0.12.0 tag.
[Release and downloads](https://github.com/CoderBak/anagram/releases/tag/v0.12.0) · [Signing run](https://github.com/CoderBak/anagram/actions/runs/46166350376)

Anagram 0.11.0 introduced the choice of Ettin 400M and Qwen3.5 0.8B.
The macOS release tests passed. Linux, Windows and Firefox CI also passed for the tagged source.
All six public downloads passed SHA-256 and tag-bound Sigstore verification. Both browser ZIPs
passed the packaging checks, and both native archives contain the runtime files from the tag.
In a temporary Chromium profile, the published Chrome ZIP downloaded the recommended Ettin checkpoint,
scored pasted text, then scored fresh text after an offline restart.
[Release and downloads](https://github.com/CoderBak/anagram/releases/tag/v0.11.0) · [Signing run](https://github.com/CoderBak/anagram/actions/runs/46138531538) · [Desktop and Firefox CI](https://github.com/CoderBak/anagram/actions/runs/46135570597)

For 0.10.2, the tagged source passed the full Chromium job on macOS, Linux and Windows. Each runner passed
320 browser tests and 119 checks across 17 device profiles. Windows passed on its second attempt
after one browser startup timed out. The published Firefox ZIP opened a two-page PDF offline on
Firefox 160.0.1. Firefox test automation now supports the current browser's launch setting and
waits for the scoring requests it needs before checking the results or disconnecting the test engine.
The Firefox 160 job passed all 49 self-tests, six diagnostics checks and 12 content security policy checks.
[Desktop CI](https://github.com/CoderBak/anagram/actions/runs/46006892345) · [Firefox CI](https://github.com/CoderBak/anagram/actions/runs/46019392405)

Statistics distinguishes current AI-assisted text from historical editing bands and links model terms to
the selected revision. The packaged installer lifecycle check lives in `test/packaged-install.py`.

It is not a design document. Background lives in:

- [DEVELOPMENT.md](DEVELOPMENT.md), in particular Open work, Decisions that hold and Checks;
- [hyperparameters.md](hyperparameters.md), every chosen value and the problems found in it;
- [statistics.md](statistics.md), the reading log and its export.

Update this file, or delete an item, when it is done.

## Where `dev` stands

- **Reading history and PDFs, 2026-11-25.** Reducing retention detail preserves hashed page totals when a retained visit supplies the coarser address. Dashboard recounts and exports handle overnight visits, retained read flags and categorical verdicts. The fallback PDF reader keeps confirmed grid cells in row order and excludes those rows from prose scoring. On RFC 9110 page 14, all nine titles remain paired with their references. All 21 rows in an untagged borderless measurement table remain in row order. Table 4 in arXiv 2004.04906 also stays out of prose scoring, as do the date grammar definitions on RFC 9110 page 39. The toolbar can request a background reading when structured extraction is unavailable. The fallback reuses those scores when pages are drawn and offers a retry for unreadable pages. Both readers find text beyond image-only covers.
- The fallback reads the twelve-row title, genre and country table across its rows. The same fields painted down independent columns retain their column order. PDF table tags also preserve wrapped cells, and prose beside a tagged or boxed table remains eligible for scoring. At 320 px the viewer keeps its toolbar controls accessible and places multi-line notices below the document.
- Firefox ESR 153.3 scored 120 paragraphs in a 30-page fallback document without scrolling. An eight-page document also scored through the real native FP32 engine and displayed its last paragraph’s chip when that page was opened. On Chromium, a later visit to page 25 reused the verdicts, and retrying a failed page fetched only that page. RFC 9110’s repeated author, status and page-number footer had appeared in eight scored passages. The fallback now omits it across all 194 pages.
- The fallback keeps the document’s font measurements across batches and checks tentative line-break spellings against the document’s vocabulary. It restores literal hyphens and removes typesetting hyphens, including when the evidence appears over a hundred pages later. All 1,038 scored passages of RFC 9110 and five arXiv papers (1512.03385, 1706.03762, 1810.04805, 2004.04906 and 2507.01297) matched a single reconstruction in reading order, word count, page numbers and offsets into the original text. Every page’s on-screen passages matched its background verdicts, with zero overlapping source spans across 283 pages. Chromium replaced the provisional verdict after finding the spelling on page 17 and counted the corrected passage once. The native CPU and browser WASM engines each displayed .05 and .03 on its two scored pages. With full-text history enabled, correcting the visible passage had counted 285 words for a single read. Each engine now records 142 words once if the passage was read before correction. A first read after correction records 143 words. A retried page keeps its position in reading order, including when it recovers during worker preparation.
- The Linux suite passed all 1,263 unit tests with portable PowerShell on the path and all 298 Chromium tests. All 207 pseudo-locale checks and the Firefox viewer, source routing, shipping, browser and diagnostics suites also passed. The Safari web resources build on Linux. Its project checks and 29 portable tests pass, with the macOS stdio check reported separately.
- A Chromium incognito window displayed verdicts with the full-text reading log enabled. The ordinary-window control added a visit and paragraph text. The private window added no visit, paragraph, text, or daily word count.
- On Linux, native ONNX CPU and in-browser WASM both scored pasted text, webpages, PDFs and fresh offline input with the pinned FP32 model. A separate check using ONNX Runtime's CUDA provider on an NVIDIA H100, the CPU provider, and Firefox WASM returned identical four-place probabilities and token counts on one sample. Firefox ESR 153.3 WASM and native CPU also agreed on every reported probability, verdict and token count for 24 passages sampled across lengths from RFC 9110 and the two arXiv placement papers. Inputs reached the model’s 512-token limit. The portable PowerShell 7.7 installer-command suite passed all 17 checks, including the matching and mismatched digests.

- The native FP32 model identity now survives a change in CPU affinity. The Linux CPU testbed passed the pinned-model stop, resume and process-restart checks in `test/native-real.py`.

- **UI, 2026-11-17 (unreleased):** Settings puts reading appearance, websites and PDFs first,
  with links to each section. Statistics uses one preset menu, preserving custom configurations,
  retention and deletion choices. The popup names its Settings button, uses plain labels and
  gives PDF/text actions their own rows; engine recovery opens the engine section directly.
  English and Chinese UI and guides agree. The statistics trend table is keyboard-scrollable.
  The pseudo-locale runner now preserves the machine-readable locale tag, bounds waits and
  reports progress and page errors; accenting the locale tag previously broke the statistics
  page and left the runner waiting indefinitely.
- **Verified on 2026-11-17** in the isolated `/data/anagram-testbed` on Linux CPU:
  - TypeScript, Chrome and Firefox builds; vitest 1,228; walker 1,158; Python backend 192;
    installer 75; release signature 11; native setup 6; Chromium 274 (four external-PDF
    corpus checks skipped); pseudo-locale 207. `npm run check` was followed by successful
    reruns after installing its missing headless browser, updating the Chinese button
    expectation and fixing the pseudo-locale harness. Firefox runtime was skipped.
  - Real pinned FP32 weights through both native ONNX CPU and in-browser WASM: setup,
    Analyze text, webpage annotations, PDF paragraphs and uncached offline scoring.
    English/Chinese, light/dark, desktop/narrow UI screenshots were also inspected.
- **Earlier release:** 0.9.2 (2026-10-12), for Chrome on macOS only, like 0.9.1 the same day: `release.yml` run with `assets: chrome-macos` lists the Chrome extension, `install.sh` and `anagram.tar.gz`, leaving out Windows' engine and the Firefox build. 0.9.0 (2026-10-11) was the first signed release and lists everything. Since the handoff of 2026-10-05, every item it listed has been done or decided:
  - the reading log, kept field by field at layers the reader chooses and worked out again under any rule (`lib/stats/`);
  - the minimum length fixed at 50 words, short paragraphs always grouped;
  - Windows with an NVIDIA GPU set up with the in-browser engine;
  - a 6 KB stub in frames, which has the worker inject the content script only where a frame is large enough and holds text;
  - the PDF reader's peak while preparing a long document's structure, 1 GB → 162 MB at 2,448 pages;
  - releases signed with Sigstore by `.github/workflows/release.yml`, and installed only with that signature;
  - a request's timeout counted from its turn in the engine, and a slow engine's batches sized by its measured pace;
  - pdf.js 6.4.299 and DOMPurify 3.4.16;
  - the cache's precision, the PDF rotation test, the words past the text cap, the statistics wording, single-page-site attribution;
  - coupled values put in one place, look-alike constants renamed, stale comments corrected.
- **Verified on 2026-10-10** on an Apple Silicon Mac, by `npm run check` with `ANAGRAMD_PYTHON` and `ANAGRAM_FIREFOX` set (Firefox ESR 153.3), and the three suites it failed run again after their fixes:
  - typecheck and build; vitest 1,213; walker 1,154 (68 of them the kept scope survey held to a new one); Python 40 and 152 more; installer 75; release signature 11; native setup in the browser 6; Playwright 276; pseudo-locale 201;
  - Firefox: the viewer, as shipped 5, `firefox.mjs` 49, diagnostics 6;
  - performance budgets A–J, with the reading log off and on (hyperparameters.md, Performance budgets).
- **Not verified:**
  - Installation on end-user machines, physical browser WebGPU inference, and the Safari app build. The Windows native launcher, installation and removal passed on a disposable GitHub Windows runner. The macOS release workflow tested the UI on Apple Silicon.
  - The official 200-text Firefox parity check, which also requires the gated reference sample. The local browser did not expose a hardware WebGPU adapter.
  - Installing 0.9.0 from the release on a clean machine. Its assets were checked after publishing: each `.sigstore.json` verifies with `installer/verify_release.py` on the installer's Python 3.12.13 (a changed `install.sh` does not), and both extension ZIPs carry the published installers' SHA-256.

## Public model access

On 2026-11-27 the detector repository enabled anonymous downloads. The `default` revision was
`7ab191a18cd77354d0462d9ad2c1335d1ad1580e`. A fresh Chromium profile downloaded and
verified 1,582,812,701 bytes for the recommended detector and reached Ready.
[Detector repository](https://huggingface.co/CoderBak/anagram-detectors)

## Open, in order

Image-only PDFs require a text layer from an OCR tool. The reader explains this after checking all pages. For scanned pages with an existing text layer, it uses that text.

### 1. Measurement

The tools exist; see DEVELOPMENT.md, Checks.

- [ ] **Feeds.** The page-kind rules were checked on the web benchmark's labelled articles, forums and other pages (0.80 held out, from 0.65). The benchmark has no real feeds; label a sample of feed pages before comparing feeds with the rest.
- [ ] **`SCRIPT_SHARE`.** Sweeping it changes nothing on the web benchmark, because its pages are in Latin script. It needs pages in other scripts, and mixed ones.
- [ ] **The minimum length on web text.** On EditLens human prefixes, 5.1% are flagged at 50 words against 2.2% at 75 (hyperparameters.md, Recommendations, 2); 50 stays by the maintainer's decision. A labelled set of human web paragraphs would measure it where Anagram reads.
- [ ] **Scheduling with a real engine:** `ROOT_MARGIN`, the lanes' batch sizes, `PAGE_IN_FLIGHT`, the background pace (`DUTY`, `SESSION_MS`), `HYDRATION_MAX_MS`, and the drain pacing (`DRAIN_COST_SPACING`, `MAX_SCAN_ROOTS`) against how late a new post is read. Seven isolated posts on a Linux Chromium feed reached a verdict in a median 93 ms on native CPU and 335 ms with in-browser WASM, from 368 and 699 ms before the scheduling change. Both used the pinned FP32 model. In a separate scrolling run, 24 new posts arrived at half-second intervals. Every verdict appeared before its post left the viewport. Median insertion-to-verdict time was 323 ms on native CPU and 565 ms in browser WASM, with 95th percentiles of 364 and 566 ms. More devices, real feeds and faster arrival rates remain unmeasured.
- [ ] **Cache sizes against their hit rate**, which needs real browsing; **the engines on NVIDIA and plain processors**, and **FP16 on 2 GB devices**, which need that hardware.

The web reader's thresholds were swept on 2026-10-09 (hyperparameters.md, Recommendations); only the link share moved, to 0.7. The language gate was measured and stays. The PDF reader's dev-fitted rules were reported on the held-out split on 2026-10-10: coverage 95.7% against 96.2% on dev, leakage 4.6% against 3.3%, spread over kinds with no one rule failing. That split is now spent for them. The reflow's core was swept on the dev split on 2026-10-10: only `BASELINE_TOL` moved (0.55 → 0.7, confirmed held out and on olmOCR-Bench); the structured path's single-page rules and the four rules that group a page's voices (`THREAD_LEVELS`, `LAYOUT_WRAPPER_HOPS`, `EDGE_CHARS`, `ONE_LINE_BOX_LEVELS`) change nothing when moved a step either way.

### 2. Security, still open

- A sandboxed inference child for the local engine: left open by the maintainer's decision (2026-10-10); DEVELOPMENT.md, Security, has why.

Closed on 2026-10-10: the first install's installer is checked against the SHA-256 the extension was built with; a site's tabs share one tab's part of the router; the extension pages allow no inline style; and what `CSS.highlights` and an `attachShadow` getter let a page learn is accepted and written down in PRIVACY.md (DEVELOPMENT.md, Security, closed).

### 3. Performance, still open

DEVELOPMENT.md, Performance, still open, has the traces. The budgets all pass (hyperparameters.md, Performance budgets). A feed's posts are no longer recognised again at each change (2026-10-10). What is left is Chromium's own work on marked text at every DOM change, the quoted-mail and review surveys made again after any change (about 60 ms a minute on a busy feed), and the reading log's intersection observers when it is on.

## Working here

Follow [AGENTS.md](../AGENTS.md) and the guidance below.

- **Commits:** routine commits on `dev` end their subject with `[skip ci]`. Never push a tag.
- **Measuring timings:** measure on an idle machine. Agents' parallel test runs made the same build vary by 2–5×.
- **Profiling the content script:** take a CPU profile (CDP `Profiler`, sampling), not a timeline trace: a trace records every call from the browser into JavaScript, and made a 1 ms walk over a page's elements with a `NodeFilter` look like 115 ms (2026-10-10). Time what a trace shows with `performance.now()` before acting on it. Budget G is held to the mean of two pairs of runs (`ANAGRAM_G_RUNS`).
- **Comparing runs:**
  - for live pages, compare each drain's own cost (the orchestrator's debug lines) or Chrome traces, not whole-thread shares;
  - for the PDF reader, compare benchmark runs against `pdf-v5` on both splits;
  - for the reading log's cost, run the budgets with `ANAGRAM_PERF_STATS=full`.
- **Disk:** a full Playwright run, Firefox and the model together need several GB. Delete `output/`, `output-test/` and scratch builds after use.
