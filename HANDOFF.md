# Pangram — Project Handoff

> Read this first. It is the single source of truth for **what we're building, what exists
> today, why it's built the way it is, and what to do next.** Written for an agent picking up
> the work cold.

Last updated: 2026-07-01. Working dir: `/Users/coderbak/Code/pangram/extension` (a git repo).
Design docs live one level up in `/Users/coderbak/Code/pangram/` (see §12).

---

## 0. TL;DR — orient in 60 seconds

- **Product:** a real-time, in-page **AI-generated-text detector**. It labels each paragraph
  on a web page with an AI-confidence badge — think **Immersive Translate, but for "is this AI?"
  instead of translation.** Browser extension now; desktop app later.
- **Two halves, deliberately decoupled:**
  1. **Surface system** (capture text on screen → render badges/marks). ← **this repo, ~done (M1).**
  2. **Detection backend** (the actual "is this AI?" model). ← **still a random stub.**
- **The seam between them is a stable contract** (`lib/contract.ts`). The surface calls a
  `ScoreClient.scoreBatch(blocks) → results`. Today that's `RandomStubScoreClient`. Swapping in
  the real detector changes **one file** (`lib/backend/getScoreClient.ts`) and nothing else.
- **The #1 next task:** wire a **real backend** so scores reflect content instead of random
  noise. Everything above the socket is finished and tested. See **§9**.
- **Status:** M1 committed (`e210321`); working tree has uncommitted follow-ups (Zhihu/div
  walker fix + `output/` rename) — **commit them** (see §11).

---

## 1. Product vision & goal

Users read AI-generated text everywhere and can't tell. Pangram overlays a **calibrated,
per-paragraph AI-confidence signal directly on the page**, non-destructively, the way
Immersive Translate overlays translations. Design tenets:

- **Paragraph-level, in-place.** A small badge at the end of each substantive paragraph +
  an optional colored underline on the paragraph. Toggleable with a floating button; hiding
  and re-showing is instant and does **not** re-detect.
- **Calibrated, honest wording.** Never "98% AI." Bands are **Human / AI-Assisted / AI /
  Insufficient** derived from a statistical contract (credible interval + p-value), not a raw
  percentage presented as truth.
- **Only judge what's judgeable.** Short text is unreliable, so we enforce a **50-word minimum**
  (matches Pangram's own policy) and skip nav/titles/boilerplate.
- **Backend-agnostic.** The capture/annotation layer must never assume how detection works.
  Random stub today; on-device ONNX, local daemon, or remote API tomorrow — same contract.

The eventual surface targets go beyond the browser (desktop app reading other apps via
Accessibility APIs / OCR); see `../surface-system-design.md`. **This repo is the browser M1.**

---

## 2. The detection contract (the IO everything is built around)

The detector's contract (from the v2 system design). Input: `(text, alpha)` where `alpha` is a
significance level; output per block:

```ts
// lib/contract.ts  — CONTRACT_VERSION = "1.0"
interface ScoreResult {
  id: string;                       // echoes the input block id (render keys off this)
  detected: boolean;                // is the block judged AI-generated?
  theta_interval: [number, number]; // calibrated AI-probability credible interval [lo,hi] ⊂ [0,1]
  e_theta: number;                  // point estimate of AI-probability θ ∈ [0,1]
  p_value: number;                  // p-value of the human-null hypothesis (small ⇒ strong AI)
  sentence_flags?: boolean[];       // optional per-sentence AI flags (see caveat in §6)
}
```

Request/response envelopes (`ScoreBatchRequest` / `ScoreBatchResponse`), `ScoreBlock`, and the
`ScoreClient` interface are all in `lib/contract.ts`. **Do not break this shape** — it's the
whole point of the decoupling. Bump `CONTRACT_VERSION` if you must extend it.

**Band derivation** (`lib/render/band.ts`) — this is how a `ScoreResult` becomes a user-facing label:

```ts
if (p_value >= 0.99 && theta_interval width > 0.5) → "unknown"  // Insufficient
if (detected)                                      → "ai"       // AI
if (e_theta >= 0.4)                                → "mixed"    // AI-Assisted
else                                               → "human"    // Human
```

Badge colors: Human = green, AI-Assisted = amber, AI = red, Insufficient = gray.

---

## 3. Architecture & data flow

```
 content.ts (top frame only, document_end)
   └─ createOrchestrator().start()                         lib/capture/orchestrator.ts
        ├─ collectUnits(document.body)                     lib/dom/walker.ts   ← paragraph detection
        ├─ observers: IntersectionObserver (viewport-first, rootMargin 500px)
        │             + MutationObserver (dirty queue, debounced)   lib/capture/observers.ts
        ├─ scheduler: batch + dedup-by-id + concurrency cap + epoch guard  lib/capture/scheduler.ts
        │     └─ send(): cache-first, dedup misses by TEXT, fan one score to all ids
        │           └─ requestScores(req)                  lib/messaging/client.ts  (→ SW)
        │                 └─ background.ts → createRouter().handle()   lib/backend/router.ts
        │                       ├─ SW-side cache + in-flight dedup + micro-batch + retry/fallback
        │                       └─ getScoreClient().scoreBatch(blocks) ★ THE SEAM ★
        │                             = RandomStubScoreClient          lib/backend/randomStub.ts
        └─ render(results): per result →                   (badge + paragraph underline)
              ├─ badges.render(unit, result)               lib/render/badge.ts   (Shadow-DOM badge)
              └─ setHighlight(unit, result)                lib/render/highlight.ts (CSS Custom Highlight)
        + floating toggle (FAB) with flagged counter       lib/render/fab.ts
```

Key properties:
- **Viewport-first:** only paragraphs near the viewport are scored; below-the-fold content is
  scored **as it scrolls into view** (by design — not a bug).
- **Two cache layers:** content-script `send()` cache + SW-side router cache, both keyed by
  normalized text hash (cyrb53). Identical paragraphs are scored once and fanned out by id.
- **Instant show/hide:** the FAB toggles CSS visibility of badges + disables the highlight
  stylesheet; results stay cached — **no re-detection**.

---

## 4. Current state — what's built and working (M1)

**Framework:** WXT (wxt.dev) + Vite + TypeScript, Manifest V3, `matches: ["<all_urls>"]`,
`allFrames: false`.

Working and regression-tested:
- ✅ Paragraph detection incl. **`<div>`/`<span>`-based sites** (Zhihu, most React/Vue SPAs), not
  just semantic `<p>` — via computed-`display` block detection (see §6).
- ✅ **50-word minimum** (matches Pangram) + link-density filter → prose only; titles/nav/
  metadata/boilerplate skipped. **CJK word counting** works (Intl.Segmenter).
- ✅ Shadow-DOM **confidence badge** (colored dot + AI-involvement number), anchored to the end
  of the paragraph's **last text line** (correct on float/sidebar layouts like Wikipedia).
- ✅ **Paragraph-level colored underline** by verdict (green/amber/red; none when insufficient),
  via the CSS Custom Highlight API (zero DOM mutation).
- ✅ **Floating toggle** (FAB) with a flagged-paragraph counter; instant show/hide.
- ✅ Dynamic content (MutationObserver), SPA route changes (popstate/hashchange → rescan),
  viewport-first scheduling, dedup, retry/neutral-fallback.
- ✅ Popup (enable/disable + rescan) and options page scaffolds.

**Not real yet:** the **scores** (random stub). Everything else is final.

Verified on: the self-test page (12-check Playwright e2e, all pass), Wikipedia, MDN, Paul
Graham, Hacker News (0 — correctly no prose), BBC (0), Substack (0). Prose sites badge their
paragraphs; aggregator/nav pages stay clean.

---

## 5. Repo layout (annotated)

```
extension/
├─ HANDOFF.md                 ← you are here
├─ README.md                  build/load quickstart
├─ wxt.config.ts              WXT config; outDir: "output" (see §7)
├─ entrypoints/
│   ├─ content.ts             content script: start orchestrator if enabled; popup msg handling
│   ├─ background.ts          MV3 service worker: routes ScoreBatchRequest → router
│   ├─ popup/                 toolbar popup (enable/disable, rescan, scored count)
│   └─ options/               options page scaffold
├─ lib/
│   ├─ contract.ts            ★ the surface↔backend contract (ScoreBlock/Result, ScoreClient)
│   ├─ types.ts               Unit, Lane, MARK_ATTR, shared types
│   ├─ dom/
│   │   ├─ walker.ts          ★ paragraph detection (selectBlocks + getUnitsForBlock)
│   │   ├─ text.ts            isInvalidText (50-word floor), splitSentences, linkTextRatio, normalize
│   │   ├─ tags.ts            INLINE/BLOCK/NO_SCORE tag sets
│   │   └─ visibility.ts      isVisible
│   ├─ capture/
│   │   ├─ orchestrator.ts    ★ ties everything together (start/stop/rescan/toggle, send/render)
│   │   ├─ observers.ts       IntersectionObserver + MutationObserver
│   │   ├─ scheduler.ts       batch/dedup-by-id/concurrency/epoch
│   │   └─ cache.ts           content-script score cache (cyrb53)
│   ├─ backend/
│   │   ├─ getScoreClient.ts  ★★ THE SEAM — returns the active ScoreClient (change this to go real)
│   │   ├─ randomStub.ts      RandomStubScoreClient (deterministic per text)
│   │   ├─ router.ts          SW-side dedup/batch/retry/neutral-fallback/cache wrapper
│   │   └─ swCache.ts         SW-side cache
│   ├─ messaging/
│   │   ├─ client.ts          requestScores(): content script → SW round-trip
│   │   └─ protocol.ts        ACTIONS, ControlMessage, TabState
│   ├─ render/
│   │   ├─ badge.ts           Shadow-DOM badge + last-line-rect placement + setVisible
│   │   ├─ badge.css.ts       badge styles (constructable stylesheet)
│   │   ├─ highlight.ts       ★ paragraph-level CSS Custom Highlight underline
│   │   ├─ band.ts            ScoreResult → Band + labels/colors
│   │   └─ fab.ts             floating toggle button + counter
│   ├─ settings/settings.ts   enabledForSite, storage-backed settings
│   └─ log.ts                 gated logger
└─ test/                      Playwright harness (Node .mjs, no test runner) — see §8
    ├─ selftest.html          controlled fixture (human/AI/short/blockquote/code/div-EN/div-ZH/dynamic)
    ├─ e2e.mjs                12-check smoke test (run this after any change)
    ├─ browser.mjs            persistent LIVE window for eyeballing (npm run browser)
    ├─ wiki.mjs               Wikipedia tester (badge placement)
    ├─ sites.mjs              6-real-site sweep (over/under-badging regression)
    └─ zhihu.mjs              Zhihu/div-site structural diagnostic
```

---

## 6. Key design decisions & rationale (so you don't undo them)

- **Walker is generalized beyond semantic tags.** `selectBlocks` finds **any block-laid-out
  element (computed `display`) that directly holds text/inline content**, keeping the outermost
  ones; `getUnitsForBlock` then splits each into paragraph units. This is what makes Zhihu / X /
  Reddit / SPAs work. The 50-word floor + link-density filter keep it from over-badging. (The
  original M1 walker only queried `P, LI, H*, TABLE, OL, PRE` and found **nothing** on div-based
  sites.) Ported/inspired by old-immersive-translate + read-frog/kiss-translator.
- **50-word minimum**, not character count. Pangram's own policy ("can't attribute below ~75
  words"). Lives in `lib/dom/text.ts` (`MIN_WORDS=50`, `MIN_CHARS=200` secondary). Uses
  `Intl.Segmenter` so **CJK counts correctly**.
- **Highlighting is PARAGRAPH-LEVEL, not sentence-level.** We tried per-sentence coloring and
  reverted it: (a) the stub's `sentence_flags` are random noise, and (b) **real detectors
  (Pangram included) cannot attribute human-vs-AI below ~75 words**, so per-sentence marks
  over-claim precision. The whole paragraph gets one color matching its badge. `sentence_flags`
  stays in the contract for a *possible* future "deep scan" mode **only if** a model can reliably
  localize. Don't resurrect sentence-level marks without that.
- **Badge placement uses the last-line client rect** (`Range.getClientRects()`), not the block
  box — otherwise badges land in float gutters/sidebars (Wikipedia infobox bug).
- **Viewport-first is intentional.** Tests must **scroll** to score below-the-fold content
  (the e2e's rapid-insert test does this). Don't "fix" a below-fold no-badge as a bug.
- **Dedup is by unit `id`, then by text with fan-out** — fixes rapid-insert dropping identical
  paragraphs. Don't dedup the *scheduler* by text hash.
- **Stub is deterministic per text** (`cyrb53(text) → mulberry32`), so the same paragraph always
  gets the same score across runs — makes tests stable and demos coherent.

---

## 7. Build / load / run / test

```bash
npm install
npm run build          # → output/chrome-mv3/   (WXT; note: outDir is "output", not ".output")
npm run typecheck      # wxt prepare && tsc --noEmit
npm run test:e2e       # Playwright 12-check smoke test (headed) — run after every change
npm run browser        # opens a persistent LIVE Chromium with the extension for eyeballing
```

**Load into your own Chrome** (best for real-site/login testing — your profile is already
logged in):
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `/Users/coderbak/Code/pangram/extension/output/chrome-mv3`.
3. After a rebuild: click the **⟳ reload** icon on the card, then **refresh the page**.

> The build dir is `output/` (renamed from WXT's default `.output/` so it's visible in Finder).
> It's git-ignored and regenerated by `npm run build`.

---

## 8. Testing harness (important — no framework, just Node + Playwright)

- **Playwright + MV3 gotchas (learned the hard way):** load the unpacked extension via
  `chromium.launchPersistentContext("", { args: ["--disable-extensions-except=…","--load-extension=…"] })`,
  **headed** (MV3 service workers are unreliable in old headless). Use a **fresh `""` profile**
  each launch — a persistent profile **caches a stale extension build** and causes lock-race
  relaunch failures. (This burned us: a "fix didn't work" was actually a stale cached build.)
- `test/e2e.mjs` serves `selftest.html` over http and asserts **12 checks**: badges render,
  FAB present, highlights present + span whole sentences, `<pre>/<code>` skipped, short (<50w)
  skipped, **div-based EN + ZH badged**, rapid-insert (scroll!) badges all, toggle hides/reshows,
  no console errors. **Run it after every change; keep it green.**
- `test/sites.mjs` sweeps 6 real sites and prints badge counts + in-chrome(nav/header/footer)
  counts → catches over/under-badging regressions. Expected: prose sites badge, HN/BBC/Substack ≈ 0.
- `test/zhihu.mjs [url]` dumps, per largest text block, tag/chars/words/link/nearest-block — use
  it to diagnose any div-based site that shows nothing. (Note: Zhihu **rate-limits bots (429)**;
  `/explore` is a directory page with no prose — not representative of the `/follow` feed.)

---

## 9. ★ THE next task: wire a real detection backend

This is the highest-value work and the reason the surface was built backend-agnostic.

**Where it plugs in:** `lib/backend/getScoreClient.ts` — a one-function factory currently
returning `new RandomStubScoreClient()`. Implement a new `ScoreClient` and return it here.
`scoreBatch(blocks: ScoreBlock[]) → Promise<ScoreResult[]>` (one result per block, by id).

Everything else already exists around it: the SW **router** (`lib/backend/router.ts`) gives you
dedup, micro-batching (800-char budget), concurrency cap (4), single retry + backoff, neutral
fallback, and SW-side caching **for free** — a new client only has to score a small batch.

**Backend options** (the seam supports all — pick per product goals):
1. **On-device (recommended first):** ONNX / `transformers.js` model running **in the service
   worker**. No network, private. Must emit the calibrated `ScoreResult` (detected /
   theta_interval / e_theta / p_value). Watch MV3 SW memory/CPU limits; consider an offscreen
   document or WASM threads. See `../survey-models.md` for candidate detectors.
2. **Local daemon:** `HttpScoreClient` → `http://127.0.0.1:PORT` running the real "pangramd"
   statistical detector `(text, alpha) → result`.
3. **Native messaging:** `NativeScoreClient` via `chrome.runtime.connectNative` → `pangramd`.
4. **Remote API:** `HttpScoreClient` → hosted endpoint (adds privacy/latency considerations;
   `domain`/`lang` hints are sent, never full URLs — keep it that way).

**Must-dos when going real:**
- Keep the **exact `ScoreResult` shape** and the **band thresholds** (`band.ts`) meaningful, or
  fix `band.ts` to match the real calibration. The stub picks `detected = interval_lo > 0.5`;
  a real model defines its own — verify the band mapping still reads well.
- Update `STUB_MODEL` / the response `model` field to identify the real model.
- Real detectors have a **minimum input length** — the 50-word floor already respects Pangram's.
- Decide `sentence_flags`: leave `[]`/absent unless the model does reliable localization (see §6).
- Re-run `npm run test:e2e` — but note the self-test's *specific* colors are stub-driven; you may
  need to adjust fixtures once scores are real. The structural checks (what gets badged) still hold.

---

## 10. Known issues & limitations

- **Google Docs (and other canvas apps) don't work — and can't, with a DOM walker.** Docs renders
  text to a `<canvas>` (pixels, no DOM text). Real fix requires the **Annotated Canvas** partner
  API (what Grammarly uses) or the Google Docs API — a gated, separate track. Not a quick fix.
- **Zhihu `/follow`:** the div-walker fix is implemented and **verified on synthetic div EN+ZH
  content**, but **not confirmed on the live logged-in feed** (needs the user's session; bot gets
  429 / `/explore` has no prose). Verify by loading into the user's own Chrome and opening
  `/follow`. If still empty, likely feed cards are `<a>`-wrapped (link-density skip) or excerpts
  are <50 words — both tunable in `walker.ts` / `text.ts`.
- **No icons** (MV3 build intentionally ships without PNG icons for M1).
- Performance of the generalized walker on huge pages: `querySelectorAll("*")` + `getComputedStyle`
  for text-bearing elements. Fine so far; watch it on very large SPAs.

---

## 11. Git state & immediate housekeeping

- One commit: `e210321 feat: Pangram AI-detection browser extension (M1 surface)`.
- **Uncommitted working-tree changes that should be committed** (the session after M1):
  - `lib/dom/walker.ts` — the div/computed-display walker generalization (Zhihu fix).
  - `wxt.config.ts` + all `test/*.mjs` + `README.md` + `.gitignore` — `.output` → `output` rename.
  - `test/selftest.html` + `test/e2e.mjs` — div-based EN/ZH fixtures + checks.
  - `test/zhihu.mjs` — new diagnostic (untracked).
  - **Suggested:** commit these as "feat(walker): capture div/span-based sites + rename output/".
- Commit convention (from the repo): author Haoxiang Sun; end messages with the
  `Co-Authored-By: Claude …` + `Claude-Session: …` trailers (see the M1 commit).
- `.gitignore` excludes `output/`, `node_modules/`, `.wxt/`, `test/*.png`, `test/.pw-profile/`.
- **Not pushed** — no remote configured. Parent `/Users/coderbak/Code/pangram/` is **not** a repo.

---

## 12. Background reading (parent dir `/Users/coderbak/Code/pangram/`)

- `surface-system-design.md` — full surface-system design (browser-first + desktop AX/OCR,
  transport, privacy). **The architectural north star.**
- `extension-build-spec.md` — the paste-ready build spec this extension was built from (contract,
  walker algorithm, module list, stub design). **Most directly relevant to this repo.**
- `research.md` — original problem research.
- `survey-*.md` — landscape survey of AI-text detection: `survey-index.md` (start here),
  `survey-models.md`, `survey-datasets.md`, `survey-papers-benchmarks.md`,
  `survey-tools-landscape.md`, `survey-analysis.md`. **Read `survey-models.md` before choosing a
  real backend.**

---

## 13. Suggested first moves for the continuing agent

1. Read this file, then `../extension-build-spec.md` and `../surface-system-design.md`.
2. `npm install && npm run build && npm run test:e2e` — confirm green (12 checks).
3. `npm run browser` (or load unpacked) — see it live on Wikipedia/Zhihu.
4. **Commit the uncommitted walker/rename changes** (§11).
5. Start the real backend (§9): pick an approach, implement a `ScoreClient`, wire it in
   `getScoreClient.ts`, keep the contract + bands honest, re-run the e2e.
