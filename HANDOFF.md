# Pangram — Project Handoff

> Read this first. It is the single source of truth for **what we're building, what exists
> today, why it's built the way it is, and what to do next.** Written for an agent picking up
> the work cold.

Last updated: 2026-07-01 (v2 surface). Working dir: `/Users/coderbak/Code/pangram/extension`
(a git repo). Design docs live one level up in `/Users/coderbak/Code/pangram/` (see §12).

---

## 0. TL;DR — orient in 60 seconds

- **Product:** a real-time, in-page **AI-generated-text detector**. It labels text on a web
  page with an AI-confidence badge — think **Immersive Translate, but for "is this AI?"
  instead of translation.** Browser extension now; desktop app later.
- **Two halves, deliberately decoupled:**
  1. **Surface system** (capture text on screen → render badges/underlines). ← **this repo,
     now at v2.**
  2. **Detection backend** (the actual "is this AI?" model). ← **still a random stub, by
     design for this milestone.**
- **The seam between them is a stable contract** (`lib/contract.ts`). The surface calls a
  `ScoreClient.scoreBatch(blocks) → results`. Today that's `RandomStubScoreClient`. Swapping in
  the real detector changes **one file** (`lib/backend/getScoreClient.ts`) and nothing else.
- **v2 (this iteration) rebuilt the surface for robustness**: style-aware segmentation with
  short-paragraph merging, an ownership/invalidation model for dynamic pages, inline-flow
  badges with a hover card and dark mode, pushState SPA handling, revealed-content handling
  (tabs/accordions/details), Google Docs reading-view support, and a 22-check e2e suite.
- **The #1 next task remains:** wire a **real backend** so scores reflect content instead of
  random noise. See **§9**.

---

## 1. Product vision & goal

Users read AI-generated text everywhere and can't tell. Pangram overlays a **calibrated,
per-unit AI-confidence signal directly on the page**, non-destructively, the way Immersive
Translate overlays translations. Design tenets:

- **Paragraph-aligned, in-place.** A small inline chip at the end of each scored unit +
  a colored underline across the unit. Toggleable with a floating button; hiding and
  re-showing is instant and does **not** re-detect.
- **Calibrated, honest wording.** Never "98% AI." Bands are **Human / AI-Assisted / AI /
  Insufficient** derived from a statistical contract (credible interval + p-value); the hover
  card shows the interval, the p-value, the word count, and an "estimate, not proof" caveat.
- **Only judge what's judgeable.** Detection is unreliable below ~50 words, so a unit is only
  scored at ≥50 words — but v2 **merges adjacent short paragraphs into one unit** instead of
  silently skipping them (see §6), so chat threads/comments/listicles get covered.
- **Backend-agnostic.** The capture/annotation layer never assumes how detection works.

The eventual surface targets go beyond the browser (desktop app reading other apps via
Accessibility APIs / OCR); see `../surface-system-design.md`. **This repo is the browser
surface.**

---

## 2. The detection contract (the IO everything is built around)

Unchanged from M1 — `CONTRACT_VERSION = "1.0"`:

```ts
// lib/contract.ts
interface ScoreResult {
  id: string;                       // echoes the input block id (render keys off this)
  detected: boolean;                // is the block judged AI-generated?
  theta_interval: [number, number]; // calibrated AI-probability credible interval [lo,hi] ⊂ [0,1]
  e_theta: number;                  // point estimate of AI-probability θ ∈ [0,1]
  p_value: number;                  // p-value of the human-null hypothesis (small ⇒ strong AI)
  sentence_flags?: boolean[];       // optional per-sentence AI flags (unused by the UI — §6)
}
```

Request/response envelopes (`ScoreBatchRequest` / `ScoreBatchResponse`), `ScoreBlock`, and the
`ScoreClient` interface are all in `lib/contract.ts`. **Do not break this shape.** Bump
`CONTRACT_VERSION` if you must extend it.

**Band derivation** (`lib/render/band.ts`): unknown (wide interval + p≈1) → Insufficient;
detected → AI; e_theta ≥ 0.4 → AI-Assisted; else Human. Colors: green / amber / red / gray.

One v2 nuance: `ScoreBlock.text` for a very long paragraph is **truncated at a sentence
boundary near 4000 chars** (`truncateForScoring`); rendering always covers the full paragraph.
The unit is never split visually (that was the M1 HF-abstract bug).

---

## 3. Architecture & data flow (v2)

```
 content.ts (top frame only, document_end)
   ├─ Google Docs? → FAB action chip: editor ⇄ /mobilebasic reading view   lib/docs.ts
   └─ createOrchestrator().start()                        lib/capture/orchestrator.ts
        ├─ collectUnits(document.body, {claimFilter})     lib/dom/walker.ts  ← SEGMENTER
        │     walk: composed tree (shadow/slots), computed-display classification,
        │           boilerplate/notranslate/editable/hidden pruning, BR + blank-line
        │           paragraph breaks, sr-only skip                lib/dom/{style,tags,boilerplate}.ts
        │     asm:  runs ≥50w → unit; consecutive 8–49w runs MERGE until ≥50w;
        │           headings/nav/link-dense runs are barriers     lib/dom/text.ts
        ├─ OWNERSHIP: every text node of a live unit is claimed (WeakMap node→unit);
        │   re-scans skip exact-match runs, stale owners are invalidated + re-taken
        ├─ observers                                       lib/capture/observers.ts
        │     IntersectionObserver (viewport-first, rootMargin 500px, unit-id latches)
        │     MutationObserver (childList + characterData + attributes[class/style/
        │       hidden/open/aria-hidden], debounced drain, per-element attr rate limit)
        ├─ URL watcher (500ms poll + popstate + hashchange) → incremental refresh
        ├─ scheduler: 3 lanes + upgrade, batch, epoch guard  lib/capture/scheduler.ts
        │     └─ send(): cache-first, dedup misses by TEXT, fan one score to all ids
        │           └─ requestScores(req)                  lib/messaging/client.ts  (→ SW)
        │                 └─ background.ts → createRouter().handle()   lib/backend/router.ts
        │                       ├─ SW cache + in-flight dedup + micro-batch + retry/fallback
        │                       └─ getScoreClient().scoreBatch(blocks) ★ THE SEAM ★
        │                             = RandomStubScoreClient          lib/backend/randomStub.ts
        └─ render(results): per result →
              ├─ badges.render(unit, result)   lib/render/badge.ts   INLINE chip + hover card
              └─ setHighlight(unit, result)    lib/render/highlight.ts  one range PER PART
        + floating toggle (FAB) with flagged counter + action chip    lib/render/fab.ts
```

Key properties:
- **Viewport-first:** paragraphs score as they (nearly) enter the viewport. Tests must scroll.
- **Ownership + invalidation:** removed DOM purges its units; text edits invalidate and
  re-score; revealed content (tabs, accordions, `<details>`) is picked up via attribute
  observation. SPA pushState navigations refresh incrementally without flicker.
- **Zero page mutation policy:** v2 writes **no attributes and no inline styles on page
  elements**. The only page-DOM changes are (a) inserting inline badge hosts and (b) splitting
  text nodes at blank-line boundaries in preserved-whitespace contexts.
- **Two cache layers** keyed by normalized text hash; identical paragraphs score once.
- **Instant show/hide:** the FAB toggles CSS visibility only; results stay cached.

---

## 4. Current state — what's built and working (v2)

Working and covered by the 22-check e2e:
- ✅ **Long paragraphs are single units** — no 1000-char mid-paragraph split; underline runs to
  the end (this was the huggingface.co/papers "stops at a weird point" bug: a 1662-char
  abstract was split at 1000 chars and the tail silently dropped).
- ✅ **Short-paragraph merging**: BR-separated halves, consecutive short `<p>`/`<li>`/chat-div
  siblings, and blank-line paragraphs in pre-wrap text merge into one multi-part unit
  (badge after the last part, underline per part).
- ✅ **Inline markup never splits a sentence**: `<code>`, `<em>`, links, drop caps (floated
  spans), `<wbr>` are all inline flow. (M1 closed units at inline `<code>` — MDN-style prose
  fragmented into sub-minimum shards.)
- ✅ **Style-aware classification**: computed display decides block vs inline (div/span sites,
  display:contents, inline-block cards, table cells); composed-tree traversal (open shadow
  roots + slots).
- ✅ **Unicode letter check + CJK word counting** — pure-Chinese paragraphs score (M1's
  Latin-only regex dropped them).
- ✅ **Reveal handling**: display-none tab panels, class flips, `<details>` open, style/hidden/
  aria-hidden changes — attribute observation with a per-element rate limit.
- ✅ **Removal/edit handling**: removed nodes purge badge+underline+result+counter; edited
  paragraphs invalidate and re-score.
- ✅ **SPA navigation**: pushState/replacePath URL changes (500ms poll) + popstate + hashchange
  → incremental refresh; the popup Rescan stays the full reset.
- ✅ **Re-enable and rescan actually re-score** (M1 latched dispatched elements in a WeakSet —
  after toggle-off/on or Rescan, nothing ever scored again).
- ✅ **Inline-flow badges**: reflow with text (resize/fonts/floats/RTL), never clipped by
  overflow, never in a float gutter; the chip reads "38% AI" (number + unit tag), scales with
  the surrounding font (clamped 9–12px) and sits on the text baseline; the hover card is
  edge-aware (flips below near the viewport top, pins horizontally near the sides);
  per-anchor dark-background detection; the FAB is a compact ball with a count bubble that
  expands on hover; badges inside 1990s inline-wrapper essays place correctly.
- ✅ **Boilerplate filter** (trafilatura/Readability-inspired, conservative): nav/landmark
  roles, page-level header/footer/aside, cookie/consent/paywall/breadcrumb/ad class tokens.
  Plus the link-density barrier for menus/story lists.
- ✅ **Plain-text documents** (`text/plain` viewer): blank-line paragraphs are segmented,
  merged and badged.
- ✅ **Google Docs** (verified end-to-end on a real public doc, `test/docs-flow.mjs`):
  editor pages get a pulsing FAB action chip → opens the static-HTML `/mobilebasic`
  reading view (the Immersive Translate approach — the editor itself is canvas and has no
  DOM text). The doc TAB (`?tab=t.0`) is forwarded, our navigations carry a
  `#pangram-reading` fragment that opts the page into reading-mode typography (zoomed
  centered card — `zoom` preserves the doc's own heading hierarchy against its ~hundreds
  of inline font sizes), and "Back to editor" restores the EXACT saved editor URL
  (sessionStorage) including the tab. Note: Google Docs itself probes
  `chrome-extension://invalid/` — console noise, not ours.
- ✅ Popup (enable/disable + per-site + rescan), options scaffold, settings
  (`showHighlights` now respected live; default on).

**Not real yet:** the **scores** (random stub, deterministic per text). Everything else is
final surface behavior.

Verified on: selftest (22 checks), huggingface.co/papers (abstract + comments badge, zero
chrome), Wikipedia (19 units, all prose, inline placement beside the infobox float), MDN,
paulgraham.com (98 units, one per BR-paragraph, correctly placed), GitHub README, HN/BBC/
Substack ≈ 0 (correctly no prose), dark-mode fixture, pure-CJK fixture.

---

## 5. Repo layout (annotated, v2)

```
extension/
├─ HANDOFF.md                 ← you are here
├─ README.md                  build/load quickstart
├─ wxt.config.ts              WXT config; outDir: "output"
├─ entrypoints/
│   ├─ content.ts             start orchestrator; Google Docs FAB action; popup messages
│   ├─ background.ts          MV3 service worker: routes ScoreBatchRequest → router
│   ├─ popup/                 toolbar popup (enable/disable, rescan, scored count)
│   └─ options/               options page scaffold
├─ lib/
│   ├─ contract.ts            ★ the surface↔backend contract (ScoreBlock/Result, ScoreClient)
│   ├─ types.ts               Unit/UnitPart re-export, Lane, MARK_ATTR
│   ├─ docs.ts                Google Docs URL detection + reading-view/editor URLs
│   ├─ dom/
│   │   ├─ walker.ts          ★ THE SEGMENTER: composed-tree walk → runs → merge → Units
│   │   ├─ style.ts           computed-style cache, flow classification, sr-only detection
│   │   ├─ tags.ts            hard-exclusion tags + inline fallback set + heading check
│   │   ├─ boilerplate.ts     chrome filter (roles, page-level sectioning, class tokens)
│   │   ├─ text.ts            Unit/UnitPart, floors, countWords/splitSentences (cached
│   │   │                     Intl.Segmenter), truncateForScoring, linkTextRatio
│   │   └─ visibility.ts      geometric (rect) visibility cache
│   ├─ capture/
│   │   ├─ orchestrator.ts    ★ ownership/claims, invalidation, URL watcher, lifecycles
│   │   ├─ observers.ts       IO (unit-id latches) + MO (childList/charData/attributes)
│   │   ├─ scheduler.ts       lanes + upgrade, batching, epoch guard, scoring truncation
│   │   └─ cache.ts           content-script score cache (cyrb53)
│   ├─ backend/               (unchanged seam)
│   │   ├─ getScoreClient.ts  ★★ THE SEAM — swap here to go real
│   │   ├─ randomStub.ts      RandomStubScoreClient (deterministic per text)
│   │   ├─ router.ts          SW-side dedup/batch/retry/neutral-fallback/cache
│   │   └─ swCache.ts         SW-side cache
│   ├─ messaging/             requestScores() + protocol
│   ├─ render/
│   │   ├─ badge.ts           ★ inline-flow chip + hover card + dark detection
│   │   ├─ badge.css.ts       chip/card styles (constructable stylesheet)
│   │   ├─ highlight.ts       CSS Custom Highlight underline, one range per part
│   │   ├─ band.ts            ScoreResult → Band + labels
│   │   └─ fab.ts             floating toggle + counter + action chip (Docs)
│   ├─ settings/settings.ts   enabledForSite, showHighlights (default ON), debug
│   └─ log.ts                 gated logger
└─ test/
    ├─ selftest.html          16-section fixture page (all v2 edge cases)
    ├─ e2e.mjs                22-check suite — run after any change (npm run test:e2e)
    ├─ browser.mjs            persistent LIVE window for eyeballing (npm run browser)
    ├─ sites.mjs              8-real-site sweep incl. the HF papers page
    ├─ wiki.mjs               Wikipedia placement tester
    └─ zhihu.mjs              div-site structural diagnostic
```

---

## 6. Key design decisions & rationale (so you don't undo them)

- **Units are SEGMENTS, not raw paragraphs — the answer to "should detection be
  paragraph-level?"** The visual paragraph is still the alignment target (badges/underlines
  land on paragraphs), but the *scoring* unit is a paragraph-aligned segment with an evidence
  floor: a run ≥50 words stands alone; consecutive 8–49-word runs (same/sibling/cousin
  containers) merge until the floor is met; <8-word runs (bylines, timestamps) are
  transparent; headings, page chrome, link-dense and letterless runs are barriers no merge
  crosses. Full paragraphs never absorb orphans (kept pure). This buys coverage on comment
  threads/chat/listicles that M1 silently skipped, without ever scoring below the reliability
  floor, and without merging across topic boundaries. If you change the floors
  (`MIN_UNIT_WORDS=50`, `MIN_MERGE_WORDS=8` in `lib/dom/text.ts`), keep Pangram's ~50-word
  reliability policy in mind.
- **Layout classification is COMPUTED STYLE, tags are fallback.** Inline vs block comes from
  computed display (with tag-set fallback when style is unavailable). This is what makes
  div/span sites, display:contents wrappers, inline-block cards and table cells segment like
  they LOOK. Special cases handled in the walk: BR = paragraph break (merge rejoins), WBR =
  transparent, floated phrase tags = drop caps (inline), inline-block with block children =
  embedded card (boundary), visually-hidden inline (sr-only) skipped mid-sentence without
  closing the run, `visibility:hidden` respected per computed value.
- **No mid-paragraph size splits, ever.** M1's 1000-char cap chopped the HF abstract and the
  one-badge-per-block dedup dropped the tail. v2 keeps a unit whole for rendering and caps
  only the SCORED text at a sentence boundary (4000 chars). If a real backend needs shorter
  inputs, window internally at the backend — never at the surface.
- **Ownership model (claims) instead of DOM markers.** M1 marked scored blocks with
  `data-pangram="scored"` — which broke sites' attribute-sensitive CSS/JS risk-wise, swallowed
  mutations inside scored blocks (the observer treated them as self-mutations), and made
  one-badge-per-block dedup drop legitimate second paragraphs (BR case). v2 claims text NODES
  in a WeakMap; re-scans skip exact-match runs and invalidate stale owners. The page DOM
  carries zero Pangram attributes (only our own hosts do).
- **Inline-flow badges, not absolutely-positioned overlays.** M1 positioned badges by
  measuring the last line rect and injected `position:relative` into page blocks — which
  breaks sites whose absolutely-positioned descendants anchor to a further ancestor, drifts
  on reflow, and clips under overflow ancestors. The inline chip reflows with text by
  construction. The insertion point climbs out of inline ancestors ONLY while the node is the
  last meaningful child (a `<font>` wrapper spanning a whole BR-essay must not collect every
  badge at its end — paulgraham.com regression). Badges swallow clicks (a badge inside a link
  must not navigate).
- **Highlights are per-PART ranges.** A merged unit spans multiple paragraphs; one range
  across them would sweep up interstitial content (code blocks, images). Underline color =
  unit verdict; sentence-level marks remain intentionally unsupported (real detectors,
  Pangram included, cannot attribute below ~75 words — see the M1 note; don't resurrect
  sentence marks without a model that localizes).
- **trafilatura / resiliparse: adopted as HEURISTICS, not as libraries.** Those extractors
  (and Mozilla Readability) operate on a serialized/cloned document and return extracted
  text/HTML — but this surface must keep LIVE node references to render in place, and
  detection must ALSO cover user-generated content (comments, chat) that main-content
  extractors deliberately strip. So v2 ports their strongest safe signals into
  `lib/dom/boilerplate.ts` (landmark roles, page-level header/footer/aside outside
  article/main scope, strong class/id tokens like cookie/consent/paywall/breadcrumb/ad) +
  the link-density barrier. If the backend ever needs server-side extraction (e.g. for a
  "score this URL" API), trafilatura is the right tool THERE — not in the content script.
- **Google Docs = reading view, not canvas heroics.** The editor draws text on `<canvas>`;
  only the gated Annotated Canvas API could overlay it. Immersive Translate's answer (and
  ours): swap to the `/mobilebasic` static-HTML view via the FAB action chip and run the
  normal pipeline there; offer the way back (exact editor URL incl. tab, via
  sessionStorage). Reading-mode typography is GATED on the `#pangram-reading` fragment our
  button appends — organic mobilebasic visits stay untouched, consistent with the
  zero-mutation policy. Published docs (`/pub`) are plain HTML and just work.
- **Viewport-first is intentional.** Tests must scroll. Don't "fix" a below-fold no-badge.
- **Stub is deterministic per text** (`cyrb53 → mulberry32`), so badges are stable across
  re-scans and the e2e is reproducible. Scores are RANDOM by design until the real backend.
- **Attribute observation is rate-limited** (1.5s per element) so style-animation churn can't
  storm the drain loop; the debounced drain + claims make repeat scans cheap no-ops.

---

## 7. Build / load / run / test

```bash
npm install
npm run build          # → output/chrome-mv3/
npm run typecheck      # wxt prepare && tsc --noEmit
npm run test:e2e       # Playwright 22-check suite (headed) — run after every change
npm run browser        # persistent LIVE Chromium with the extension for eyeballing
node test/sites.mjs    # 8-real-site sweep (incl. HF papers) + screenshots
```

**Load into your own Chrome:** `chrome://extensions` → Developer mode → Load unpacked →
`output/chrome-mv3`. After a rebuild: reload the extension card, then refresh the page.

---

## 8. Testing harness (no framework, just Node + Playwright)

- **MV3 gotchas:** load unpacked via `launchPersistentContext("", {args:
  ["--disable-extensions-except=…","--load-extension=…"]})`, **headed**; use a **fresh `""`
  profile** each launch (a persistent profile caches a stale build — this burned us).
- `test/e2e.mjs` — 22 checks over `selftest.html` (served over http): long-paragraph
  wholeness (HF regression), BR/short-sibling/pre-wrap merging, inline-code integrity,
  pure CJK, isolated-short skip, never-score zones (code/nav/editable/aria-hidden), zero
  marker attributes, tab reveal, `<details>`, pushState swap + purge, removal purge, rapid
  insert, toggle, no console errors. **Keep it green.**
- `test/unit.mjs` — **38-check unit harness (~5s)**: esbuild-bundles the walker +
  pure helpers into a blank Chromium page (real computed styles) and runs
  table-driven DOM cases over merge rules, barriers, exclusions, CJK, pre-wrap,
  shadow DOM, sr-only, claimFilter, truncation, docs URLs, band mapping.
  `npm run test:unit` — run it FIRST; it is the fastest signal.
- `test/scenarios.mjs` — **the wide-net matrix (26 checks)**. Phase A (deterministic, on
  `test/ui-fixtures.html`): edge-aware hover card (top/right), RTL inline-end placement,
  chip font scaling + line-box bound, shadow DOM + slotted capture, overflow:hidden,
  clipboard hygiene, badge-after-link isolation, per-anchor dark theme, duplicate fan-out.
  Phase B (live, soft — unreachable site → SKIP, loaded-but-wrong → FAIL): HF paper, EN/AR/JA
  Wikipedia, MDN, paulgraham, arXiv, StackOverflow (no badges in <pre>), GitHub, a text/plain
  RFC, samaltman blog, and HN/BBC zero-badge expectations. `--local` runs phase A only.
- `test/sites.mjs` — quicker real-site sweep with per-site badge counts + screenshots.
- Scoring is viewport-first: all scripts scroll before asserting.

---

## 9. ★ THE next task: wire a real detection backend

Unchanged plan — the seam is `lib/backend/getScoreClient.ts` (returns
`RandomStubScoreClient`). Implement a new `ScoreClient` and return it there;
`scoreBatch(blocks) → Promise<ScoreResult[]>` (one result per block, by id). The router
gives you dedup, micro-batching, concurrency cap, retry + neutral fallback, and SW caching
for free.

Options (see `../survey-models.md`): on-device ONNX/transformers.js in the SW (private,
recommended first), local daemon over HTTP, native messaging, or a remote API (send only
`domain`/`lang` hints — never full URLs).

Must-dos when going real:
- Keep the `ScoreResult` shape; re-verify `band.ts` thresholds against the real calibration.
- Update the response `model` field (it also keys the SW cache — stale entries invalidate).
- Note `ScoreBlock.text` is sentence-truncated at ~4000 chars; window longer inputs
  backend-side if the model wants more.
- Leave `sentence_flags` empty unless the model reliably localizes (§6).
- Re-run `npm run test:e2e`; the structural checks hold regardless of scores.

---

## 10. Known issues & limitations

- **Google Docs editor remains canvas** — the reading-view chip is the supported path. A
  true in-editor overlay needs the gated Annotated Canvas partner API. The `/mobilebasic`
  view is read-only and mobile-styled (fine on desktop, just plain).
- **Ephemeral overlays** (toasts, tooltips) can transiently badge if they carry ≥50 words —
  rare; the purge removes the badge when they go.
- **Aggressive page CSS** using `!important` on descendants of body could theoretically
  affect host layout; critical host props are inline + `!important` in the shadow sheet
  (shadow !important wins), so this is belt-and-suspenders covered.
- **Very large pages**: the initial walk computes style per element once (cached per scan).
  Fine on Wikipedia/MDN-scale; profile before optimizing further (idle-chunked walking is
  the next lever if ever needed).
- **Copy/paste**: badge text lives in shadow DOM with `user-select:none`; Chrome excludes it
  from copied text. Other browsers unverified (Firefox port is M-next anyway).
- **No icons** (MV3 build intentionally ships without PNG icons).
- **Zhihu live feed** still unverified with a logged-in session (bots get 429). The synthetic
  div/span fixtures pass; verify on the real `/follow` feed when convenient.

---

## 11. Git state & housekeeping

- `e210321` M1 surface → `284f580` M1 follow-ups (div walker, output/ rename, HANDOFF) →
  **v2 refactor (this commit)**.
- Commit convention: author Haoxiang Sun; end messages with the `Co-Authored-By: Claude …`
  + `Claude-Session: …` trailers.
- `.gitignore` excludes `output/`, `node_modules/`, `.wxt/`, `test/*.png`, `test/.pw-profile/`.
- **Not pushed** — no remote configured. Parent `/Users/coderbak/Code/pangram/` is not a repo.

---

## 12. Roadmap (prioritized; assessed 2026-07-02)

**P0 — the product**
1. **Real detection backend** (§9). Everything above the seam is done and tested.
   Re-derive `band.ts` thresholds against the real calibration; update the response
   `model` field (keys the caches); leave `sentence_flags` empty unless the model
   localizes. On-device ONNX in the SW is the privacy-first option; check MV3
   memory limits (offscreen document if needed).
2. **Git remote + CI.** Local-only repo. Push to GitHub; Actions running
   `test:unit` + typecheck on every push, e2e (xvfb) nightly.

**P1 — before other users**
3. Backend-adjacent: IndexedDB L2 result cache; per-block language hints;
   optionally fill ctx_before/ctx_after.
4. Store submission: privacy policy (mandatory with any remote backend), listing
   copy, screenshots (test/ has them), version discipline. Icons/options/popup ✅
   (done 2026-07-02).
5. Comment-thread author boundaries (open DESIGN question — discuss with mentor):
   the merger combines short comments from different authors (compatible
   siblings). Fine for "is there AI here", wrong for attribution. Candidate fix:
   dropped metadata runs (bylines <8w) act as soft barriers — costs BR-prose
   merging; decide with real-model behavior in hand.

**P2 — quality ladder**
6. Infinite-feed stress with a real session (X/Twitter, Zhihu /follow, Discord).
7. Firefox port (WXT cross-build; Highlight API + `zoom` are in current FF).
8. Offline extraction-QA corpus (trafilatura reference diff over saved pages) —
   also makes the live scenario half CI-safe.
9. Polish: Docs reading-view scroll preservation, PDF story (pdf.js text layers),
   i18n, a11y pass (badges are aria-hidden; consider an SR-visible page summary).

**Deliberately not doing:** sentence-level rendering without a localizing model;
canvas heroics for the Docs editor (reading view is the answer).

Done this session (2026-07-02): icons + options page + popup status/underlines,
dark highlight palette, draggable FAB (per-site memory), tap-to-pin card,
iframe pipeline with size gates, 38-check unit harness, multi-agent adversarial
review (see git log for fixes).

---

## 13. Background reading (parent dir `/Users/coderbak/Code/pangram/`)

- `surface-system-design.md` — surface-system north star (browser + desktop AX/OCR).
- `extension-build-spec.md` — the original M1 build spec (superseded in walker/render
  details by this doc + the code, still right about the contract and the seam).
- `research.md`, `survey-*.md` — detection landscape. **Read `survey-models.md` before
  choosing a real backend.**

---

## 14. Suggested first moves for the continuing agent

1. Read this file; skim `lib/dom/walker.ts` and `lib/capture/orchestrator.ts` (the two
   files that define v2 behavior).
2. `npm install && npm run build && npm run test:e2e` — confirm 22/22 green.
3. `npm run browser` — eyeball Wikipedia, the HF papers page, paulgraham.com, a dark site.
4. Start the real backend (§9): pick an approach, implement a `ScoreClient`, wire it in
   `getScoreClient.ts`, keep the contract + bands honest, re-run the e2e.
