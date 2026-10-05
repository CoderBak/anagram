# Handoff

This file records where `dev` stands, what waits on a maintainer decision, and what to do next, in priority order. It was last updated 2026-10-05.

It is not a design document. Background lives in:

- [DEVELOPMENT.md](DEVELOPMENT.md), in particular Open work, Decisions that hold and Checks;
- [hyperparameters.md](hyperparameters.md), every chosen value and the problems found in it;
- [statistics.md](statistics.md), the statistics export.

Update this file, or delete an item, when it is done.

## Where `dev` stands

- **Release:** the last release is 0.8.2. Everything since sits under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).
  - Reading statistics: off by default, local only, exportable as JSON or CSV.
  - Security hardening against pages, other users and releases, plus a fuzzing pass over hostile pages, PDFs and engine input.
  - Firefox fixes: the page's CSP and the frame partition.
  - Performance work on live pages and long documents.
  - PDF reading of whole documents up to 2,500 pages.
  - A resumable Windows uninstall.
  - The local engine starts in 0.38 s.
- **Verified at a998acc (2026-10-05)** on an Apple Silicon Mac:
  - `npm run check` passed every suite (Playwright 267, vitest 1,155, walker 1,092).
  - `npm run test:firefox` passed with Firefox ESR 153 (`firefox.mjs` 49/49).
  - Performance budgets A–J passed on an idle machine, and so did the perf matrix (`ANAGRAM_PERF_MATRIX=1`).
  - The commits after it are documentation only.
- **Not verified:**
  - Windows and Linux on real machines.
  - `test/webengine/parity.mjs` in Firefox, and the in-browser engine end to end. Both need the 1.4 GB model.
  - Private-window exclusion from the statistics. It is unit-tested only, because Playwright cannot load an extension in an incognito context.

## Waiting on a maintainer decision

1. **Release signing.** Releases are checked only against a `.sha256` published beside them, so whoever can replace release assets can ship an update.
   - The choice: minisign (an offline Ed25519 key; recommended) or Sigstore keyless.
   - Either way, `install.sh`, `install.ps1` and `installer/native_registration.py` must carry the public key and verify.
   - See DEVELOPMENT.md, Security, still open.
2. **Statistics definitions for the study** ([hyperparameters.md](hyperparameters.md#for-the-reading-statistics)):
   - (a) `units` count a paragraph under the word its chip showed, not the most likely band.
   - (b) The headline is the AI-generated band only. "Flag from" defaults to heavily edited and up, so the headline does not follow it.
   - (c) A page record is kept per address per day, not per visit.
   - (d) Lowering the recording level offers to delete finer records, and keeps them by default.
3. **The minimum length.**
   - 0.7.0 moved it to 75 words because "at 50 words a quarter of human texts read as AI-edited". 0.8.0 made it a setting, 50 by default, to match Pangram's product.
   - Measure false positives on human web text at 50 and 75 before choosing. The walker fixtures still run at 75.
4. **Windows with an NVIDIA GPU.**
   - `lib/device.ts` offers "native PyTorch CUDA", but `anagramd/pyproject.toml` installs PyPI's CPU-only Windows torch.
   - Either ship the CUDA build (a larger install, never tested) or stop offering it.
5. **Content-script start-up.** A small registered script that has the worker inject the reader (`scripting.executeScript`) would save 17–45 ms per page load. It changes how every page starts (DEVELOPMENT.md, Performance, still open).
6. **The PDF reader's transient peak.** It reaches about 1 GB of heap while `prepare()` runs on a 2,500-page book. Removing it means reworking the line-number pass, which matches pieces by identity.

## Next, in order

### 1. Defects

Behaviour differs from what was intended. Details are in hyperparameters.md, Problems found.

- [ ] **Cache precision.** Cached verdicts are rounded to 3 decimals (`lib/backend/swCache.ts:103-104`), fresh ones to 4. Near a cut, a cached verdict can show another word. Store 4.
- [ ] **PDF rotation test.** `lib/pdf/extract.ts:19` compares the text matrix, font size included, with 0.02. Text skewed by about 0.1° is dropped. Test the angle instead.
- [ ] **Word count past the text cap.** Words past `MAX_UNIT_TEXT_CHARS` are counted in the statistics but never scored (the walker's `emit`). Count only the words of the text sent.
- [ ] **Merge short paragraphs off.** With `mergeShorts` off, short text is dropped without being reported to the statistics. The diagnostics re-walk also ignores `mergeShorts` (`lib/diagnostics/silence.ts`).
- [ ] **Statistics wording:**
  - the toolbar menu says "words read" for words scored;
  - "Opened" is the first send, not when the page opened;
  - the docs say "tab in front" where the code checks "not hidden";
  - `docs/statistics.md` says a day's exported level is "the finer" one (the code takes the coarser), and its idle and page-kind descriptions do not match the code.
- [ ] **Queued batches against the timeout.** The 30 s request timeout counts time spent queued in the engine, while 4 batches are in flight and engines score one at a time. Measure it on a processor engine. Then start the timer at dispatch, or send fewer batches at once.

### 2. Before the study

- [ ] Fix `minWords` and `mergeShorts` for every participant, and record `mergeShorts` per day in the store. Today only the export holds it.
- [ ] If sensitivity analyses are wanted, add a build or setting that logs each paragraph: words, probabilities, time on screen and visible share. The daily totals cannot be recomputed under other thresholds.
- [ ] Check the page-kind rules (`lib/stats/pageKind.ts`) on a labelled sample before comparing feeds with the rest.
- [ ] Attribute reading on single-page sites to the right address. Today up to 5 s before a route change is credited to the new address; flush on the route change instead.

### 3. Measurement debt

The tools exist; see DEVELOPMENT.md, Checks.

- [ ] **PDF:** about twenty structure-path rules were tuned on the PDF benchmark's dev split, and their test numbers were never reported. One `bench.mjs report <run> --split test` checks them all; the list is in hyperparameters.md, Overfitting risk.
- [ ] **Web reader:** sweep these on the web benchmark:
  - `MAX_LINK_RATIO` (0.6);
  - the symbol share (0.2);
  - the name-list thresholds;
  - the short-run thresholds (8, 3 and 4 words);
  - `SCRIPT_SHARE`.
- [ ] **Engines:**
  - the language gate's confidence: today fastText's top-1 guess decides at any confidence;
  - batch size and batches in flight against timeouts on processor engines.
- [ ] **Budget G:** it measured 7.7% against its 8% limit.
  - Half of that is Chromium re-validating every highlight range on each DOM change.
  - A cheaper way to mark text on changing pages would give headroom.

### 4. Hygiene

- [ ] Put coupled values in one place:
  - page-side batches × blocks against the router's per-document limit;
  - the 8 ms slice;
  - the 2 s port handshake;
  - the flash duration;
  - the engine contract, written in both Python and TypeScript.
- [ ] Rename constants that share a name but not a value: `RUNNING_TEXT_CHARS`, `MAX_WRAPPER_HOPS`, `YEAR`, `REACH`, `TOUCH`, `BATCH_CHAR_BUDGET`.
- [ ] Correct the stale comments and docs listed in hyperparameters.md, chiefly the "75-word floor" and `lib/capture/pace.ts`'s description of batches.
- [ ] At the next dependency refresh, take DOMPurify 3.4.16. Move pdf.js to 6 together with the hash-pinned viewer and engine.
- [ ] Add the Firefox suites to `npm run check` when a Firefox binary is given. Today neither the check nor CI runs them, and `test:firefox` leaves out `diagnostics-firefox`.

### 5. Security, still open

DEVELOPMENT.md, Security, still open, has the detail:

- a sandboxed inference child for the local engine;
- two tabs of one hostile site can still use up the router's admission;
- `style-src 'unsafe-inline'` on extension pages;
- what `CSS.highlights` and an `attachShadow` getter let a page learn.

## Working here

Follow [AGENTS.md](../AGENTS.md) and the guidance below.

- **Commits:** routine commits on `dev` end their subject with `[skip ci]`. Never push a tag.
- **Measuring timings:** measure on an idle machine. Agents' parallel test runs made the same build vary by 2–5×.
- **Comparing runs:**
  - for live pages, compare each drain's own cost (the orchestrator's debug lines) or Chrome traces, not whole-thread shares;
  - for the PDF reader, compare benchmark runs against `pdf-v5` on both splits.
- **Disk:** a full Playwright run, Firefox and the model together need several GB. Delete `output/`, `output-test/` and scratch builds after use.
