# Anagram for Chrome

**See what's AI-written, right on the page.** Anagram is a Chrome extension that
labels the text you read with a small per-paragraph confidence chip — think
Immersive Translate, but instead of translating, it answers *"did a human write
this?"* — inline, live, on every site.

> **Scoring status:** the detection backend is currently a development stub that
> produces deterministic pseudo-random scores (the same paragraph always gets the
> same number). The entire surface — capture, merging, rendering, caching — is
> final; the real detector plugs into one file (`lib/backend/getScoreClient.ts`)
> behind a stable contract (`lib/contract.ts`).

| Article pages | Dark mode + detail card |
| --- | --- |
| ![Wikipedia with per-paragraph chips](docs/screenshots/wikipedia.png) | ![Dark page with pinned detail card](docs/screenshots/dark-mode.png) |

| Google Docs — in-tab reading mode | Paper / abstract pages |
| --- | --- |
| ![Docs analyzed in an overlay without leaving the editor](docs/screenshots/google-docs-overlay.png) | ![HuggingFace paper page](docs/screenshots/article-page.png) |

| Toolbar popup | Triage panel |
| --- | --- |
| ![Popup with toggles, marking style and scope](docs/screenshots/popup.png) | ![Flagged-paragraph panel with verdict filters](docs/screenshots/triage-panel.png) |

## What you get

- **A chip after every analyzed paragraph** — `38% AI` with a color-coded verdict
  (green = Human, amber = AI-Assisted, red = AI, gray = Insufficient). Chips scale
  with the surrounding text, sit on its baseline, reflow with the page (RTL
  included — the label itself never bidi-flips), and appear in a subtle
  **"analyzing…" state** the moment a paragraph is actually sent for scoring,
  morphing in place when the verdict lands. Hover — or tap, on touch — for the
  full calibrated readout: verdict, a **credible-interval meter**, p-value, words
  analyzed, a **per-sentence signal strip** on flagged paragraphs, and a
  **Copy text** action — always with an *"estimate, not proof"* caveat.
- **Verdict marks across each analyzed unit** (toggleable) — underline + tint,
  underline only, or tint only (options), with a dark-tuned palette on dark
  pages. Marks are screen-only: they never print.
- **A floating ball** like Immersive Translate's: drag it anywhere — it **snaps
  to the nearest edge**, remembers its spot per site, and **tucks itself
  half-away when idle** (hover brings it back). It hides in fullscreen video and
  rides the browser **top layer**, so cookie walls and modals never bury it.
  Click to show/hide everything instantly (no re-analysis) or press
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>. **Click the counter** to open the
  triage panel: every flagged paragraph in order with **verdict filters**
  (All / AI / Assisted) — click one to jump there and pulse its chip, **Copy
  report** for a markdown summary, or **turn Anagram off for the site** right
  from the panel. The toolbar icon shows the per-tab flagged count too.
- **"Flagged only" mode**: every paragraph is still analyzed, but chips and
  marks appear only on AI / AI-Assisted verdicts — calm pages by default if you
  prefer (popup → Show).
- **Analysis scope**: whole page (default) or **main content only** — a
  trafilatura-style precision mode that detects the article region and skips
  comments, sidebars and widgets outside it (falls back to whole-page when no
  clear region exists).
- **Analyze any selection**: select text → right-click →
  *Analyze selection with Anagram* — works in editors, comment boxes,
  **`<textarea>`/`<input>` fields** (which browsers hide from normal selection
  APIs) and fragments passive capture skips; below the 50-word floor it says
  "too short to judge" instead of pretending.
- **Popup + options page**: per-site rules (with an add-rule form), marking
  style, scope, display mode, live analyzed/flagged stats, Rescan; a first-run
  page explains the verdicts.
- **Google Docs support, in place.** The editor is a canvas, so the ball offers
  **"Analyze document"**: a **reading mode opens right in the tab** — the
  document fetched same-origin, rendered as a clean paper view with every
  paragraph analyzed — and <kbd>Esc</kbd> (or "Back to editor") returns
  instantly. No navigation, no state loss, and the doc itself is never touched.
  Prefer a separate page? "Open as page" keeps the classic reading-view flow
  (also the automatic fallback if the in-tab fetch fails).

## What it handles (the hard parts)

Text on the web is messy; the capture engine is built for it:

- **Visual paragraphs, not tags.** Layout is classified by computed style, so
  `<div>`-built sites (Zhihu, X-style apps), BR-separated prose, and
  pre-wrap chat transcripts segment the way they *look*. Inline markup —
  links, `code`, emphasis, drop caps, icons, images, formulas — never splits a
  sentence, and KaTeX/MathJax-style **duplicated math markup** (visual +
  accessible copies) is never counted twice.
- **An evidence floor with merging.** Detection below ~50 words is unreliable, so
  short neighboring paragraphs (chat messages, list items, comment threads) are
  **analyzed together** as one unit instead of being skipped — while headings,
  navigation, link lists, ASCII art and column layouts act as barriers that are
  never merged across.
- **Boilerplate skipping, trafilatura-style.** Landmark roles, sectioning tags
  and a curated token list (share bars, related-article widgets, taboola/outbrain
  slots, bylines, cookie walls…) are pruned during the walk — with compound-token
  guards so a paper's `related-work` *section* stays content, and page-level
  containers (`body`, `main`, `article`) can never be misclassified by a skin's
  utility classes.
- **Living pages.** Infinite scroll, SPA navigations (pushState included), tab
  panels, accordions, `<details>`, **modal `<dialog>`s (top layer)**, edited and
  deleted text — badges appear, update, and disappear with the content. Scoring
  is viewport-first, so pages stay fast.
- **Everything, everywhere:** open shadow DOM and slots, same- and cross-origin
  iframes (webmail readers, embedded posts — ad slots are size-gated out),
  plain-text documents (`.txt`/`.log`/RFCs), pure-CJK, RTL, and
  **vertical writing modes** (`vertical-rl` novels).
- **Invisible characters, normalized.** Soft hyphens, zero-width and bidi
  control characters are stripped from scoring payloads and cache keys — the
  same visible sentence scores identically on every site that renders it.
- **Zero page mutation** beyond inserting the chips themselves: no attributes, no
  inline styles on your DOM, marks via the CSS Custom Highlight API, copied
  text never includes badge labels, badges inside links never navigate.
- **Graceful under failure.** If the extension is updated/reloaded while a tab
  is open (dead context), the page **freezes quietly** — verdicts stay readable,
  observers and timers stop, nothing spams the console. Transient backend
  failures render as "Insufficient" and are never cached. Forced-colors (High
  Contrast) keeps chips visible with semantic dots; `prefers-reduced-motion` is
  honored throughout.

## Install (unpacked)

```bash
npm install
npm run build          # Chrome  → output/chrome-mv3/
npm run build:firefox  # Firefox → output/firefox-mv2/  (web-ext lint: 0 errors)
```

**Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** →
`output/chrome-mv3`.

**Firefox (128+):** `about:debugging` → This Firefox → **Load Temporary
Add-on…** → `output/firefox-mv2/manifest.json`. (Underlines need Firefox 140+;
older versions degrade gracefully to chips-only. `npm run zip:firefox` builds
the AMO-submittable zip.)

Browse anywhere with prose. The ball sits bottom-right; the toolbar popup and
the options page hold the switches.

## Testing

Five suites, all runnable headed on a normal machine:

| Suite | Command | Checks | What it covers |
| --- | --- | --- | --- |
| Unit | `npm run test:unit` | 66 | walker/assembler/extraction logic in a real Chromium page (~5s) |
| E2E | `npm run test:e2e` | 22 | full extension on a 16-section fixture page |
| Scenarios | `npm run test:scenarios` | 35 | UI edge cases (hover card, panel filters, FAB snap/tuck, top-layer, KaTeX, vertical text) + 13 live sites (EN/AR/JA Wikipedia, HF, StackOverflow, RFC txt…) |
| Docs flow | `node test/docs-flow.mjs` | 12 | in-tab overlay + classic page flow on a real public doc |
| Perf | `npm run test:perf` | 3 | 3000-paragraph budget: first badge <4s (measured ~0.4s), no long task >1s |

`npm run browser` opens a live Chromium with the extension for manual poking;
`node test/shots.mjs` regenerates the README screenshots;
`node test/genicons.mjs` regenerates the icon set.

## Architecture (one paragraph)

A content script segments the page (`lib/dom/walker.ts`) into scoreable units,
claims their text nodes for incremental re-scans, and observes viewport,
mutations, attribute reveals and URL changes (`lib/capture/`). An optional
precision scope narrows collection to the detected main-content region
(`lib/dom/mainContent.ts`). Units are batched through a 3-lane priority
scheduler to the MV3 service worker, which dedups, caches (53-bit content
hashes, model-versioned keys) and calls the active `ScoreClient` — today
`RandomStubScoreClient`, tomorrow a real detector, with retry and never-cached
degraded fallbacks (`lib/backend/`). Results render as inline shadow-DOM chips
and Highlight-API marks (`lib/render/`); the Google Docs overlay
(`lib/docsOverlay.ts`) reuses the same pipeline inside a shadow-root reader.
The surface↔backend contract lives in `lib/contract.ts`; swapping in a real
model touches exactly one factory function.

## Privacy

Nothing leaves the browser. Text goes from the page to the extension's own
service worker and back; the stub scores locally. The batch envelope carries only
a hostname + language hint by design — if a remote backend is ever added, that
contract keeps full URLs and page identity out of every request. The Google Docs
reading mode fetches the document same-origin with your own cookies — Anagram
itself contacts no server.
