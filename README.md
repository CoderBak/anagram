# Anagram for Chrome

**See what's AI-written, right on the page.** Anagram is a Chrome extension that
labels the text you read with a small per-paragraph chip — think Immersive
Translate, but instead of translating, it answers *"how much of this did an AI
write?"* — inline, live, on every site.

> **Scoring:** verdicts come from **EditLens** (`pangram/editlens_roberta-large`,
> Thai, Emi, Masrour & Iyyer, ICLR 2026), a 355M-parameter model that rates the
> *extent of AI editing* in a paragraph on four levels — human / lightly edited /
> heavily edited / AI-generated. It runs **on your machine** in a small local
> daemon (`anagramd/`, Apple-silicon GPU via MPS, ~30 ms per paragraph in
> batches). Without the daemon the extension falls back to a clearly-labelled
> demo stub so the surface still works.

| Article pages | Dark mode + detail card |
| --- | --- |
| ![Wikipedia with per-paragraph chips](docs/screenshots/wikipedia.png) | ![Dark page with pinned detail card](docs/screenshots/dark-mode.png) |

| Google Docs — in-tab reading mode | Paper / abstract pages |
| --- | --- |
| ![Docs analyzed in an overlay without leaving the editor](docs/screenshots/google-docs-overlay.png) | ![HuggingFace paper page](docs/screenshots/article-page.png) |

| Toolbar popup | Triage panel |
| --- | --- |
| ![Popup with toggles, marking style and scope](docs/screenshots/popup.png) | ![Flagged-paragraph panel with verdict filters](docs/screenshots/triage-panel.png) |

## Quick start

```bash
# 1. the extension
npm install
npm run build                      # Chrome → output/chrome-mv3/   (load unpacked, see below)

# 2. the model (gated on Hugging Face: accept the CC BY-NC-SA terms once, then)
hf download pangram/editlens_roberta-large --local-dir ../models/editlens_roberta-large

# 3. the scoring daemon (own venv; torch + transformers + flask)
cd anagramd && uv venv .venv --python 3.13 && uv pip install --python .venv/bin/python -r requirements.txt && cd ..
npm run serve                      # http://127.0.0.1:8765 — GET /health, POST /score
```

The extension's default backend mode is **Auto**: it uses the daemon whenever
`/health` answers and the demo stub otherwise, and the popup always says which
one produced the scores. Options → *Scoring backend* switches modes or the URL.
`sh anagramd/run.sh --selftest` scores four sample paragraphs (one of them Chinese, which must come back unsupported) as a sanity check.

## What you get

- **A chip after every analyzed paragraph** — `38% AI`, the model's estimated
  extent of AI editing, with a color-coded verdict (green = Human, yellow =
  Lightly edited, orange = Heavily edited, red = AI-generated, gray =
  Unavailable). Chips scale with the surrounding text, sit on its baseline,
  reflow with the page (RTL included — the label itself never bidi-flips), and
  appear in a subtle **"analyzing…" state** the moment a paragraph is actually
  sent for scoring, morphing in place when the verdict lands. Hover — or tap, on
  touch — for the full readout: the verdict, a **four-bucket probability bar**
  with a row per bucket, words analyzed, whether the model window was cut, and a
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
  triage panel: every flagged paragraph (heavily edited or AI-generated) in
  order with **verdict filters** — click one to jump there and pulse its chip,
  **Copy report** for a markdown summary with each paragraph's bucket split and
  the model that produced it, or **turn Anagram off for the site** right from the
  panel. The toolbar icon shows the per-tab flagged count too.
- **"Flagged only" mode**: every paragraph is still analyzed, but chips and
  marks appear only on heavily-edited / AI-generated verdicts — calm pages by
  default if you prefer (popup → Show).
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
  style, scope, display mode, live analyzed/flagged stats, the live backend, a
  scoring-backend section (mode / daemon URL / check), Rescan; a first-run page
  explains the verdicts.
- **Google Docs support, in place.** The editor is a canvas, so the ball offers
  **"Analyze document"**: a **reading mode opens right in the tab** — the
  document fetched same-origin, rendered as a clean paper view with every
  paragraph analyzed — and <kbd>Esc</kbd> (or "Back to editor") returns
  instantly. No navigation, no state loss, and the doc itself is never touched.
  Prefer a separate page? "Open as page" keeps the classic reading-view flow
  (also the automatic fallback if the in-tab fetch fails).

## The model

EditLens formalizes *scoring text by the extent of AI intervention* rather than
a binary human/AI call. The released `roberta-large` checkpoint is a 4-way
classifier trained on 60k texts across reviews, creative writing, educational
articles and news, edited by GPT-4.1 / Claude 4 Sonnet / Gemini 2.5 Flash with
303 editing prompts; the daemon reports the argmax bucket and the
probability-weighted score (`Σ pᵢ·i / 3`, shown as `% AI`).

| Bucket | Verdict | Meaning |
| --- | --- | --- |
| 0 | Human | no detectable AI editing |
| 1 | Lightly edited | small AI touches (grammar, fluency, tone) |
| 2 | Heavily edited | substantial AI rewriting |
| 3 | AI-generated | written by a model |

**English only.** The model card declares `language: en`, every dataset source in
the paper is English, and the base model is RoBERTa. So the daemon runs every
paragraph through **fastText `lid.176`** (the standard 176-language identifier)
before scoring and refuses anything whose top label is not English: those
paragraphs get a gray **"Unsupported language"** chip showing the detected code
(`zh`, `ja`, `ar`…) with the language name in the card, no percentage, no mark,
and never count as flagged. The popup reports them as "N not English".

Honest limits: a 512-token window (longer paragraphs
are scored on their sentence-bounded prefix and the card says so); accuracy
drops out-of-domain and on models unseen in training (the paper reports ternary
macro-F1 0.904 in-domain → 0.866 on a held-out domain); light edits by
grammar tools mostly stay in the human bucket. The weights are **CC BY-NC-SA 4.0
— non-commercial**, and Pangram asks that they not be used to enforce AI-usage
policies. Every readout carries the *estimate, not proof* caveat for a reason.

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
  deleted text — badges appear, update, and disappear with the content.
- **Fast and ahead of you.** Scoring is viewport-first with a 1.5-screen
  prefetch margin, then an **idle-time background lane** scores the rest of the
  page in document order while you read, one capped batch at a time so it never
  delays what's on screen. Batches are packed per lane (small for the viewport,
  large for prefetch) because the model scores ~3× more paragraphs per second in
  batches of 12+. Verdicts are cached three ways — per tab, in the service
  worker, and **persistently in extension storage** (hash + buckets only, keyed
  by model version) — so revisits and worker restarts never re-score.
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
  observers and timers stop, nothing spams the console. If the daemon goes away
  mid-session, Auto mode falls back to the stub and the popup says so; transient
  failures render as "Unavailable" and are never cached. Forced-colors (High
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
the options page hold the switches. Keep `npm run serve` running in a terminal
for real scores — see [`anagramd/README.md`](anagramd/README.md) for the API.

## Testing

Six suites, all runnable headed on a normal machine:

| Suite | Command | Checks | What it covers |
| --- | --- | --- | --- |
| Unit | `npm run test:unit` | 72 | walker/assembler/extraction + band mapping in a real Chromium page (~5s) |
| E2E | `npm run test:e2e` | 22 | full extension on a 16-section fixture page (stub backend) |
| Scenarios | `npm run test:scenarios` | 35 | UI edge cases (hover card, panel filters, FAB snap/tuck, top-layer, KaTeX, vertical text) + 13 live sites (`-- --local` skips the live sweep) |
| Server | `npm run test:server` | 18 | **the real model**: spawns `anagramd`, checks the API on human/AI/Chinese samples (the last one must come back unsupported via fastText), drives the built extension in Auto mode — real verdicts on every English chip, the 4-bucket card, the "zh" unsupported chip, the popup's model line |
| Docs flow | `node test/docs-flow.mjs <public doc URL>` | 12 | in-tab overlay + classic page flow on a real public Google Doc — the original demo doc was deleted from Drive, so without a URL (or `ANAGRAM_DOC_URL`) the suite reports SKIP |
| Perf | `npm run test:perf` | 3 | 3000-paragraph budget: first badge <4s (measured ~0.3s), no long task >1s |

`npm run test:verify` proves the chips come from the model: it reads each chip's
probabilities, sends the same paragraph text straight to the daemon's API, and
compares — then stops the daemon and shows the popup flip to "demo stub".
`npm run browser` opens a live Chromium with the extension for manual poking;
`npm run play` opens a multi-tab playground; `node test/shots.mjs` regenerates
the README screenshots; `node test/genicons.mjs` regenerates the icon set.

## Architecture (one paragraph)

A content script segments the page (`lib/dom/walker.ts`) into scoreable units,
claims their text nodes for incremental re-scans, and observes viewport,
mutations, attribute reveals and URL changes (`lib/capture/`). An optional
precision scope narrows collection to the detected main-content region
(`lib/dom/mainContent.ts`). Units are batched through a 3-lane priority
scheduler (viewport / near / idle prefetch) to the MV3 service worker, which
dedups, caches (53-bit content hashes, model-versioned keys, memory +
persistent storage) and calls the active `ScoreClient` — the local `anagramd`
daemon over HTTP when it is up, the deterministic stub otherwise — with retry
and never-cached degraded fallbacks (`lib/backend/`). Results render as inline
shadow-DOM chips and Highlight-API marks (`lib/render/`); the Google Docs
overlay (`lib/docsOverlay.ts`) reuses the same pipeline inside a shadow-root
reader. The surface↔backend contract (`lib/contract.ts`, v2.1) is exactly the
daemon's IO: `{bucket, probs[4], score, lang}` per paragraph, or `unsupported` for
non-English text.

## Privacy

Nothing leaves your computer. Text goes from the page to the extension's
service worker and on to `anagramd` on `127.0.0.1`, which runs the model
locally; the batch envelope carries only a hostname + language hint by design,
and the persistent cache stores hashes and bucket probabilities, never text.
The Google Docs reading mode fetches the document same-origin with your own
cookies — Anagram itself contacts no remote server.
