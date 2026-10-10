# Handoff

This file records where `dev` stands, what waits on a maintainer, and what is still open, in priority order. It was last updated 2026-10-10.

It is not a design document. Background lives in:

- [DEVELOPMENT.md](DEVELOPMENT.md), in particular Open work, Decisions that hold and Checks;
- [hyperparameters.md](hyperparameters.md), every chosen value and the problems found in it;
- [statistics.md](statistics.md), the reading log and its export.

Update this file, or delete an item, when it is done.

## Where `dev` stands

- **Release:** the last release is 0.8.2. Everything since sits under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md). Since the handoff of 2026-10-05, every item it listed has been done or decided:
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
  - typecheck and build; vitest 1,213; walker 1,086; Python 40 and 152 more; installer 75; release signature 11; native setup in the browser 6; Playwright 276; pseudo-locale 201;
  - Firefox: the viewer, as shipped 5, `firefox.mjs` 49, diagnostics 6;
  - performance budgets A–J, with the reading log off and on (hyperparameters.md, Performance budgets).
- **Not verified:**
  - Windows and Linux on real machines, and the Safari build (no Xcode here).
  - `test/webengine/parity.mjs` in Firefox, and the in-browser engine end to end. Both need the 1.4 GB model.
  - Private-window exclusion from the reading log. It is unit-tested only, because Playwright cannot load an extension in an incognito context.
  - A signed release end to end. The signing and verifying are tested against fixtures (`test/release-signature.sh`), but no release has been made by the workflow yet.

## Waiting on the maintainer

1. **The first signed release.** Dispatch `.github/workflows/release.yml` from a version tag. Agents never push tags or run workflows. The installers on `dev` refuse an HTTPS release without a signature, so the next release has to come from the workflow.
2. **The first install's installer.** A first install runs `install.sh` or `install.ps1` as the release serves it, before anything is verified. The setup page's command could carry the installer's SHA-256, since the extension is built from the same tree (`lib/ui/installationCommand.ts`). Left open on purpose (DEVELOPMENT.md, Security, still open).

## Open, in order

### 1. Measurement

The tools exist; see DEVELOPMENT.md, Checks.

- [ ] **Feeds.** The page-kind rules were checked on the web benchmark's labelled articles, forums and other pages (0.80 held out, from 0.65). The benchmark has no real feeds; label a sample of feed pages before comparing feeds with the rest.
- [ ] **`SCRIPT_SHARE`.** Sweeping it changes nothing on the web benchmark, because its pages are in Latin script. It needs pages in other scripts, and mixed ones.
- [ ] **The minimum length on web text.** On EditLens human prefixes, 5.1% are flagged at 50 words against 2.2% at 75 (hyperparameters.md, Recommendations, 2); 50 stays by the maintainer's decision. A labelled set of human web paragraphs would measure it where Anagram reads.
- [ ] **The PDF reflow core** (`PARA_GAP`, `INDENT`, `SHORT_LINE` and the rest, set on synthetic pages): sweep it on the dev split with `bench.mjs run`.

The web reader's thresholds were swept on 2026-10-09 (hyperparameters.md, Recommendations); only the link share moved, to 0.7. The language gate was measured and stays. The PDF reader's dev-fitted rules were reported on the held-out split on 2026-10-10: coverage 95.7% against 96.2% on dev, leakage 4.6% against 3.3%, spread over kinds with no one rule failing. That split is now spent for them.

### 2. Security, still open

DEVELOPMENT.md, Security, still open, has the detail:

- the first install's installer (above);
- a sandboxed inference child for the local engine;
- two tabs of one hostile site can still use up the router's admission;
- `style-src 'unsafe-inline'` on extension pages;
- what `CSS.highlights` and an `attachShadow` getter let a page learn.

### 3. Performance, still open

DEVELOPMENT.md, Performance, still open, has the traces. The budgets all pass with room (hyperparameters.md, Performance budgets); what is left is Chromium's own work on marked text at every DOM change, and a feed's posts recognised again at each drain.

## Working here

Follow [AGENTS.md](../AGENTS.md) and the guidance below.

- **Commits:** routine commits on `dev` end their subject with `[skip ci]`. Never push a tag.
- **Measuring timings:** measure on an idle machine. Agents' parallel test runs made the same build vary by 2–5×.
- **Comparing runs:**
  - for live pages, compare each drain's own cost (the orchestrator's debug lines) or Chrome traces, not whole-thread shares;
  - for the PDF reader, compare benchmark runs against `pdf-v5` on both splits;
  - for the reading log's cost, run the budgets with `ANAGRAM_PERF_STATS=full`.
- **Disk:** a full Playwright run, Firefox and the model together need several GB. Delete `output/`, `output-test/` and scratch builds after use.
