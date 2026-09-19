# Anagram for Chrome

**Shows how heavily each paragraph appears to be AI-edited, scored on your own
computer.** Anagram is a Chrome extension that labels the text you read with a
small per-paragraph chip — think Immersive Translate, but instead of translating,
it answers *"how much of this did an AI write?"* — inline, live, on every site.

> **Scoring:** verdicts come from **EditLens** (`pangram/editlens_roberta-large`,
> Thai, Emi, Masrour & Iyyer, ICLR 2026), a 355M-parameter model that rates the
> *extent of AI editing* in a paragraph on four levels — human / lightly edited /
> heavily edited / AI-generated. It runs **on your machine** in a small local
> daemon (`anagramd/`, Apple-silicon GPU via MPS, ~30 ms for a short
> paragraph). There is no other scorer: without the daemon, paragraphs show as
> *Unavailable* and are retried automatically once it answers.

| Article pages | Dark mode + detail card |
| --- | --- |
| ![Wikipedia with per-paragraph chips](docs/screenshots/wikipedia.png) | ![Dark page with pinned detail card](docs/screenshots/dark-mode.png) |

| Google Docs — in-tab reading mode | Paper / abstract pages |
| --- | --- |
| ![Docs analyzed in an overlay without leaving the editor](docs/screenshots/google-docs-overlay.png) | ![HuggingFace paper page](docs/screenshots/article-page.png) |

| Toolbar popup | Triage panel |
| --- | --- |
| ![Popup with toggles, marking style and scope](docs/screenshots/popup.png) | ![Flagged-paragraph panel with verdict filters](docs/screenshots/triage-panel.png) |

## Install (one line, one folder)

```bash
curl -fsSL https://github.com/CoderBak/anagram/releases/latest/download/install.sh | sh
```

That puts **everything** — a private Python, the daemon and its packages, the EditLens
checkpoint, the built extension — under `~/.anagram/` and touches nothing else: no
sudo, no Homebrew, no system Python, no shell-profile edits, no launch agent. Then:

```bash
~/.anagram/bin/anagram start       # the scoring daemon, 127.0.0.1:8765, stays until you stop it
```

and load the extension: `chrome://extensions` → Developer mode → **Load unpacked** →
`~/.anagram/extension`. `anagram status | stop | logs | selftest` do what they say;
`anagram doctor` checks the folder, the private Python and its packages, both model
files against the checksums the installer pinned, the free space and the port, and
prints one line per check with the command that fixes what is wrong (it only reads —
nothing is written, moved or removed); `anagram update` re-runs the installer and
restarts the daemon if one was running, so the code in memory is the code on disk;
`anagram uninstall` deletes the folder, which is the only thing the
installer ever created. The checkpoint is gated on Hugging Face (CC BY-NC-SA): the
installer asks for a read token unless `ANAGRAM_HF_TOKEN` is set; `ANAGRAM_HOME`
relocates the folder; `ANAGRAM_SKIP_MODEL=1` defers the 1.4 GB download to
`anagram model`. Footprint about 2 GB, install time a few minutes, mostly the download.

## Quick start from source

```bash
# 1. the extension
npm install
npm run build                      # Chrome → output/chrome-mv3/   (load unpacked, see below)

# 2. the two models (the daemon downloads nothing itself — it loads what is on disk)
#    the checkpoint is gated on Hugging Face: accept the CC BY-NC-SA terms once, then
hf download pangram/editlens_roberta-large --local-dir ../models/editlens_roberta-large
curl -fsSL -o ../models/lid.176.ftz \
  https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz   # fastText, 1 MB

# 3. the scoring daemon (own venv from the lockfile; torch + transformers + fastapi + fasttext)
cd anagramd && uv sync --frozen && cd ..     # → anagramd/.venv
npm run serve                      # http://127.0.0.1:8765 — GET /health, POST /score
```

`npm run release` builds what the installer consumes (`dist/anagram.tar.gz` + checksum,
`dist/install.sh`, the store zip); pushing a `v*` tag publishes them as a GitHub Release.

The extension probes the daemon's `/health` and picks it up within seconds of it
starting; the popup names the model that is scoring, says *Daemon not running*
with a Retry, or — when something on that port answers with another contract
version — *Daemon version mismatch*. Options → *Scoring daemon* holds the URL,
which is restricted to loopback addresses. `sh anagramd/run.sh --selftest` scores
four sample paragraphs (one of them Chinese, which must come back unsupported),
prints PASS/FAIL per sample and exits non-zero if any of them is wrong.

## What you get

- **A chip after every analyzed paragraph** — `.38` on a scale of 0 to 1, the
  model's estimate of how far the text sits between untouched human writing and
  fully AI-generated prose (it is an extent of editing, never a percentage of
  anything), with a color-coded verdict (green = Human, yellow = Lightly edited,
  orange = Heavily edited, red = AI-generated, gray = Unavailable). What the
  number means is spelled out in the hover card and on the first-run page, not
  repeated on every line. Chips scale with the surrounding text, sit on its baseline,
  reflow with the page (RTL included — the label itself never bidi-flips), and
  appear in a subtle **"analyzing…" state** the moment a paragraph is actually
  sent for scoring, morphing in place when the verdict lands. Hover — or tap, on
  touch — for the full readout: the verdict, a **four-bucket probability bar**
  with a row per bucket, words analyzed, how a long paragraph was read
  (**"Scored in 3 windows"** with each window's own number), and a
  **Copy text** action — always with an *"estimate, not proof"* caveat.
- **Quiet verdict marks across what was read** (toggleable) — at rest the page is
  left as its author wrote it: nothing under human or lightly-edited text, and a
  thin solid line under the two flagged bands only (1 px heavily edited, 2 px
  AI-generated, so they differ by more than hue). Nothing is wavy and nothing is
  tinted. **Hover a chip** — or pin its card, or jump to it — and that one
  paragraph shows its full extent, tint included: a paragraph longer than the
  model reads in one pass is scored in consecutive windows and lights up **window
  by window, each in its own colour**, so a text that turns from human to AI
  halfway shows where. The options page can put the marks back on every
  paragraph, all the time. Dark-tuned palette on dark pages; screen-only, so
  marks never print.
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
- **Without a mouse.** The chips stay out of the tab order on purpose (hundreds
  of stops, percentages read out mid-sentence), so the panel is the accessible
  route to the verdicts and it is a real one: the counter is a labelled button
  ("3 flagged paragraphs — show list"), <kbd>Enter</kbd> opens a
  `role="dialog"` panel and moves focus into it, each row announces its verdict
  and percentage, <kbd>Esc</kbd> closes it and hands focus back.
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> opens the panel from anywhere, and
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> / <kbd>K</kbd> walk the flagged
  paragraphs forwards and backwards, wrapping around. All four shortcuts are
  rebindable at `chrome://extensions/shortcuts`.
- **"Flagged only" mode**: every paragraph is still analyzed, but chips and
  marks appear only on heavily-edited / AI-generated verdicts — calm pages by
  default if you prefer (popup → Show).
- **Analysis scope**: whole page (default) or **main content only** — a
  precision mode that lets **Mozilla Readability** (the Firefox Reader View
  extractor) decide what the article is, maps that back onto the live DOM, and
  skips comments, sidebars and widgets outside it (a text-mass probe covers
  pages Readability declines; whole-page when no clear region exists).
- **Analyze any selection**: select text → right-click →
  *Analyze selection with Anagram* — works in editors, comment boxes,
  **`<textarea>`/`<input>` fields** (which browsers hide from normal selection
  APIs) and fragments passive capture skips; below the 50-word floor it says
  "too short to judge" instead of pretending, and above the model window it says
  how many of the selected words were actually analyzed.
- **Analyze one page on a site you keep Anagram off for**: right-click →
  *Analyze this page with Anagram*. It runs in that tab only, frames included,
  until you leave the page — no setting and no site rule is written.
- **A page where nothing shows up?** Right-click → *Copy page diagnostics*.
  The toolbar badge blinks a tick and the clipboard holds a short description
  of what happened: the version, browser and settings; how many units, chips
  and words were judged out of the page's visible prose; the largest stretches
  of text that got nothing, each with the reason the segmenter really had
  (under the 50-word floor with its word count, link-dense with the ratio,
  page chrome with the class token that matched, a heading label, hidden,
  inside a code block, another language with the one detected, a unit nobody
  drew); the subframes; and the structure of the part of the page you clicked
  in — **anonymised**: every word replaced by filler of the same shape, so it
  segments the way the original did, with URLs, alt text, titles and values
  dropped, and class and id names kept only where they are words Anagram's own
  detectors use (`author-marla-quillgrove` reads `author-x5-x10` — the shape
  stays, the name does not). Nothing you or anybody else wrote is in it. It is English whatever
  the interface is in, because it is for whoever fixes the site, and it works
  on a site Anagram is switched off for — it says so. The badge shows "!"
  instead of a tick if nothing reached the clipboard. On Firefox the first use
  asks once for permission to write to the clipboard (Chrome asks for none);
  say yes and it never asks again.
- **Popup + options page**: per-site rules (with an add-rule form) that cover a
  whole site — a rule written on `example.com` holds on `news.example.com` too,
  the most specific rule wins and `www.` makes no difference — marking
  style, scope, display mode, "Open PDFs in Anagram" (off by default), live
  analyzed/flagged stats, the live backend, a
  scoring-backend section (daemon URL / status check), Rescan, "Clear cached
  verdicts"; a first-run page
  explains the verdicts and opens with a **live setup strip** — extension,
  scoring daemon, ready — that re-checks itself every few seconds while the
  daemon is down and hands over the one command that fixes it (`anagram start`,
  `anagram update`, or the install one-liner) in a copyable pill. A daemon that
  answers but speaks another contract version is reported as a **version
  mismatch** ("run `anagram update`"), not as "not running".
- **Google Docs support, in place.** The editor is a canvas, so the ball offers
  **"Analyze document"**: a **reading mode opens right in the tab** — the
  document fetched same-origin, rendered as a clean paper view with every
  paragraph analyzed — and <kbd>Esc</kbd> (or "Back to editor") returns
  instantly. No navigation, no state loss, and the doc itself is never touched.
  It is a snapshot, so **"Refresh"** reads the document again and swaps the page
  in place, chips and all, after an edit. Prefer a separate page? "Open as page"
  keeps the classic reading-view flow (also the automatic fallback if the in-tab
  fetch fails).
- **PDFs, shown as they are and annotated.** The browser's PDF viewer shows an
  image, not text, so Anagram opens the file in a **reading mode of its own** —
  and that mode shows **the real pages**, drawn by pdf.js: the figures, the
  mathematics, the fonts, the columns, exactly as the file was authored, on a
  neutral surface that follows light and dark while the pages stay as printed.
  A selectable text layer sits over every page (so Ctrl/Cmd+F works across the
  whole document), and the marks and chips lie over the document's own glyphs.
  The paragraph reconstruction is still there and is now **invisible**: it
  decides what the model reads as one paragraph (any number of columns, running
  heads and a paper's title block kept out, lists and footnotes held apart,
  broken words mended, a paragraph sewn back together across a page break) and
  where that paragraph ends on the page, so its chip lands in the white space
  after its last line — in its own column, never over the other one's text.
  A paper's **short paragraphs are read together** here exactly as a web page's
  are: the same evidence floor, the same window-sized groups, the same ×N chip
  after the last of them (one rule, one module, two callers). What a PDF has
  instead of markup is the reconstruction's own verdict on what stands beside
  what — nothing is ever grouped across a heading, a caption, a footnote, a
  paper's title block, a table row, a line of author names, or a column or page
  break, and a paragraph the reflow already sewed across a break is one
  paragraph. Turning off "Group short neighboring paragraphs" turns it off here
  too.
  Everything else is the ordinary pipeline: same chips, same marks, same panel,
  same report, which names the PDF and not the reader page. Zoom is fit-width by
  default, with −/+ and Cmd/Ctrl +/−/0. A scanned PDF with no text layer is
  still shown; there is simply nothing to score. A **password-protected** PDF
  asks for its password in the bar — one field, Enter to try it — and the
  password is never stored, never logged and never in the diagnostics. Three
  ways in: **"Analyze PDF"** on the ball of a PDF tab, **"Read this PDF"** in
  the popup, and **"Open PDF with Anagram"** on any link to one — or turn on
  **"Open PDFs in Anagram"** in the options and every PDF tab opens there by
  itself (off by default; Back still leaves it, and "Open original" still shows
  the file). Open the reader with nothing loaded and it takes a file from your
  computer by drop or picker. The bytes never leave the browser.
  Opening a PDF opens **that** PDF: Anagram asks no site anything first, and
  there is no address it could send you to instead of the document you were
  looking at. Where the paper also exists as a real HTML page — an arXiv paper
  does — the bar carries a quiet **HTML** link to it. It is a link: nothing is
  asked of anybody until you follow it.

  **Where the bytes come from.** The reading mode never fetches anything: it
  cannot, and that is the point (see *What leaves your computer*). The tab that
  is showing the PDF re-reads its own document — same address, same cookies,
  normally straight out of the browser cache — and hands the bytes over through
  the extension's worker under a one-time ticket. On a site you have not granted
  there is no content script to ask, so the click you just made is what lets
  Anagram put one in that one tab, for that one document. Two consequences worth
  knowing. **Local files** (`file://`) cannot be read this way at all — Anagram
  declares no access to the file scheme, and a page on it may not re-read itself
  either — so a local PDF stays in the browser's own viewer and the way into the
  reading mode is the drop zone or the picker. **Firefox** shows PDFs in a
  privileged viewer that no extension code can run in, so there is no tab to read
  from: on Firefox the reading mode takes dropped and picked files only, and none
  of the three ways in above is offered. A document larger than 50 MB is refused
  on this path (100 MB from the picker); reading stops at the cap rather than
  after it.

## The model

EditLens formalizes *scoring text by the extent of AI intervention* rather than
a binary human/AI call. Its target is a **change magnitude** between the original
and the edited text (1 − similarity, measured with sentence embeddings or soft
n-gram overlap); the four classes are threshold cuts of that magnitude, and the
model never sees the original at inference. The released `roberta-large`
checkpoint is a 4-way classifier trained on 60k texts across reviews, creative
writing, educational articles and news, edited by GPT-4.1 / Claude 4 Sonnet /
Gemini 2.5 Flash with 303 editing prompts; the daemon reports the argmax bucket
and the probability-weighted score (`Σ pᵢ·i / 3`, the reference script's
`score_pred`), shown as the chip's number.

**What the number is not.** `.38` is *not* "38 % of the words were written by
AI", and not a probability that the paragraph is AI: the paper explicitly rejects
token-level attribution for edited text. It is the model's estimate of how far the
paragraph sits, as a whole, between untouched human writing (`.00`) and fully
AI-generated text (`1.0`) — which is why it is written as a number on that scale
and never as a percentage. Two very different
distributions can share one number, which is why the card always shows all four
probabilities.

| Bucket | Verdict | Meaning |
| --- | --- | --- |
| 0 | Human | no detectable AI editing |
| 1 | Lightly edited | small AI touches (grammar, fluency, tone) |
| 2 | Heavily edited | substantial AI rewriting |
| 3 | AI-generated | written by a model |

**English only.** The model card declares `language: en`, every dataset source in
the paper is English, and the base model is RoBERTa. So non-English text is
gated twice: the content script asks the browser's built-in detector
(`browser.i18n.detectLanguage`, no download) and settles confidently non-English
paragraphs locally, so a Chinese page never wakes the model; everything else
goes to the daemon, which runs it through **fastText `lid.176`** (the standard
176-language identifier) before scoring and refuses anything whose top label is
not English. Those paragraphs get a gray **"Unsupported language"** chip showing
the detected code (`zh`, `ja`, `ar`…) with the language name in the card, no
number, no mark, and never count as flagged. The popup reports them as "N not
English".

Honest limits: a 512-token window. A longer paragraph is read completely, in
consecutive sentence-bounded windows of at most 1800 characters, and the chip
shows the length-weighted average of the windows' probabilities — an aggregation
EditLens was not evaluated with, and no window sees the sentences before or
after it. There is no cost cap on a paragraph: however long it is, every window of
it is read (a 4 000-word paragraph is some fourteen windows, a second or two on an
M-series Mac). Only a single node past 200 000 characters — a log or a data dump,
not writing — is cut there, and the card then says the end was not read.
Accuracy drops out-of-domain and on models unseen in training — Pangram's
[release post for the open models](https://www.pangram.com/blog/introducing-open-pangram)
reports, for this released `roberta-large` checkpoint, ternary macro-F1 **0.881**
in-domain → **0.673** on held-out Enron emails (binary human-vs-AI macro-F1 0.997
→ 0.966), with the decision thresholds calibrated on a validation set, and Anagram
shows the model's raw top bucket rather than those calibrated thresholds, so its
labels are not the ones those figures were measured with; light edits by
grammar tools mostly stay in the human bucket. The weights are **CC BY-NC-SA 4.0
— non-commercial**, and Pangram asks that they not be used to enforce AI-usage
policies. Every readout carries the *estimate, not proof* caveat for a reason.

## What it handles (the hard parts)

Text on the web is messy; the capture engine is built for it:

- **Visual paragraphs, not tags.** Layout is classified by computed style, so
  `<div>`-built sites (Zhihu, X-style apps), BR-separated prose, and
  pre-wrap chat transcripts segment the way they *look*. Inline markup —
  links, `code`, emphasis, drop caps, icons, images, formulas — never splits a
  sentence. **Formulas never split a paragraph**: raw MathML, MathJax, KaTeX
  and Wikipedia's math markup are skipped mid-sentence on every renderer (the
  card says "Formulas omitted: N"), and their hidden accessibility copies,
  footnote and citation marks (`[7]`, `[citation needed]`), page-number markers
  and author-list citation strings never reach the model.
- **An evidence floor with merging: one voice, one verdict.** Detection below ~50
  words is unreliable, so short neighboring paragraphs *of one voice* (the lines of
  a post written one sentence per line, list items, the short paragraphs of an
  article or of a single comment) are **analyzed together** instead of being
  skipped. A stretch of them is read to its end and then divided evenly, between
  paragraphs, into groups of at most one model window (about 300 words), each with
  its own chip (×N) — never cut the moment it reaches fifty words, and never one
  number for a thousand words. A short paragraph that cannot stand alone joins the
  full paragraph next to it when the two fit one window (×2) instead of going
  unjudged. A **post, comment or quotation that fits one model window** is read
  whole, its full paragraphs included: one post, one verdict — a status of twelve
  short paragraphs is one chip (×12), not three. Anything longer is an article and
  keeps a chip per full paragraph. What a post is, the markup says (`<article>`,
  `role="article"`, a quotation, a quoted card) or, where a site says nothing — a
  Zhihu answer, a GitHub or Hacker News comment, a forum post, a review card are
  plain `div`s and table rows — its structure shows: **one of several elements
  like it, each with a byline of its own**. Bullet items and the rows of a prose
  table repeat too, but carry no byline, and stay one author's text. A unit
  never crosses an authorship boundary to reach the floor — another post or
  comment, a quotation, a caption, a quoted post, the name row between two chat
  messages: text that is too short on its own simply gets no chip. Headings,
  navigation, link lists, ASCII art and column layouts are barriers that are never
  merged across either (inside a short post they are simply left out).
- **Boilerplate skipping, trafilatura-style.** Landmark roles, sectioning tags
  and a curated token list (share bars, related-article widgets, taboola/outbrain
  slots, bylines, cookie walls…) are pruned during the walk — with compound-token
  guards so a paper's `related-work` *section* stays content, and page-level
  containers (`body`, `main`, `article`) can never be misclassified by a skin's
  utility classes.
- **What a page SAYS it is, checked against what it is.** A tag is a claim, and
  sites make claims they don't keep, so each one is measured: an element that
  declares itself a heading is a barrier only while it reads like a label — a
  container of paragraphs that merely carries `role="heading"` (lobste.rs comment
  bodies, a whole teaser card wrapped in `<h2>`) is walked like the block it is;
  `notranslate` on a code sample or a brand name means "not prose", but on an
  application shell (Mastodon's app root) it only opts the app out of machine
  translation, so shells are walked; and a `<pre>` is machine text until the text
  in it reads as prose — RFCs published as HTML, man pages and mailing-list
  archives are read, while code, configuration, diffs, logs and tables of contents
  stay out.
- **Text behind "see more", with its chip where you can see it.** Feeds keep the
  whole post in the DOM and show three lines of it (LinkedIn, Substack Notes,
  Goodreads reviews). That text is one author's post and you can open it, so it is
  scored — you get the verdict at a glance instead of expanding every card. What
  moves is the chip: when a box keeps text of its own below its bottom edge (a line
  clamp, a fixed height, a card that cuts off its last paragraphs), **one** chip is
  inserted after that box, under the lines you can see — the chip of the first
  paragraph whose last line is out of sight. Every later paragraph of the same post keeps its chip at its own
  last word, which is where you find it the moment you open the post; a long clamped
  review would otherwise hand you a row of a dozen numbers under one box and no way
  to tell which paragraph each belongs to. Quotations and lists inside the clipped
  text are part of the post, not a boundary, so that one chip still comes out — what
  a chip never leaves is the post itself. Paragraphs still on screen keep their chip
  in place, and it **follows the text if the page reflows under it** — a review box
  is not clipping anything until its cover images and its web font arrive, and the
  chip is watched for as long as it is in the box, not rescued once and forgotten.
  Opening the post puts every chip back at its own paragraph; closing it parks the
  first hidden one again. Scroll containers, carousels, `<details>` and a page-level
  `overflow:hidden` under an open modal are not clipping, and nothing moves for them.
- **Living pages.** Infinite scroll, SPA navigations (pushState included, heard
  instantly through the Navigation API — no history patching, no polling), tab
  panels, accordions, `<details>`, **modal `<dialog>`s (top layer)**, edited and
  deleted text, content appended inside shadow roots, and even pages that
  **rewrite their own document** after load (`document.open()/write()`
  challenge interstitials) — badges appear, update, and disappear with the
  content. Very long pages (a whole novel) are scored to the end in the idle lane.
- **Fast and ahead of you.** Scoring is viewport-first with a 1.5-screen
  prefetch margin, then an **idle-time background lane** scores the rest of the
  page in document order while you read, one capped batch at a time so it never
  delays what's on screen. Batches are packed per lane (small for the viewport,
  large for prefetch) to keep the per-request overhead off the short paragraphs —
  batching amortises that overhead (round trip, tokenizer, language id), not the
  forward pass, and our own benchmark
  (`docs/benchmarks/editlens-m4-24gb-2026-09-14.json`, roberta-large) measures
  32.9 → 51.1 → 52.5 paragraphs/s at batch 1 / 8 / 32 for 60-word paragraphs
  (about 1.5×, flat after 8) and 8.2 → 8.4 → 8.2 for 400-word ones, i.e. nothing
  at all. The lane priority travels into the worker's queue, so a visible
  paragraph in any tab is scored before anyone's prefetch. Verdicts are
  cached three ways — per tab, in the service worker, and **persistently in
  IndexedDB** (hash + buckets only, keyed by the daemon's model version — which
  digests the weights, the tokenizer and config files, the window length, the
  dtype and the language-gate state, not the weights alone — pruned oldest-first
  through an index) — so revisits and worker restarts never re-score, and no two
  configurations that could disagree about a paragraph ever share an entry. All
  three go at once with **"Clear cached verdicts"** (options → Advanced), which
  says how many verdicts are stored beside the button; the pages keep what they
  are showing and ask again on their next scan. Nothing is kept longer than
  **30 days** (counted from when it was written — a revisit does not restart the
  clock), and nothing scored for a **private window** is ever written to disk: it
  may read the cache, what it produces stays in the worker's memory, and only an
  ordinary tab asking for the same text — which would have produced the same
  verdict itself — puts it there.
- **Everything, everywhere:** open shadow DOM and slots, same- and cross-origin
  iframes (webmail readers, embedded posts — ad slots are size-gated out; a
  frame follows the **top page's** site rule, asking the worker whose tab it
  sits in when it cannot read that itself), plain-text documents
  (`.txt`/`.log`/RFCs) and the same documents typeset in `<pre>` (RFCs as HTML,
  man pages, mail archives), pure-CJK, RTL, and **vertical writing modes**
  (`vertical-rl` novels).
- **One canonical text per paragraph.** Soft hyphens, zero-width and bidi
  control characters, non-breaking spaces and ligatures are normalized, LaTeX
  residue (`---`, ``` `` ``` quotes, `\%`) and typographic variants (curly
  quotes, `1–5`) are folded to one convention, and that canonical form is both
  what the model receives and what the caches key on — the same sentence
  scores identically however a site renders it. This matters: EditLens is
  surface-sensitive enough that a LaTeX `---` alone moved an abstract from
  55 % to 9 %; `node test/abs-vs-html.mjs` measures the agreement between
  arXiv's abstract page and its HTML rendering.
- **Zero page mutation** beyond inserting the chips themselves: no attributes, no
  inline styles on your DOM, marks via the CSS Custom Highlight API, copied
  text never includes badge labels, badges inside links never navigate. Hover
  cards, the selection card and the triage panel are placed by **Floating UI**
  (flip, shift, arrow), so they stay on screen at any edge; chip theming reads
  page backgrounds through **culori**, so `oklch()` / `display-p3` / `lab()`
  surfaces are classified correctly.
- **Graceful under failure.** If the extension is updated/reloaded while a tab
  is open (dead context), the page **freezes quietly** — verdicts stay readable,
  observers and timers stop, nothing spams the console. If the daemon goes away
  mid-session, the batch in flight renders "Unavailable" (never cached), nothing
  else is dispatched, the ball's counter shows "!", and the page re-checks every
  few seconds and re-queues everything the moment the daemon answers again — no
  reload, no Rescan. If it comes back as a *different* model, open tabs drop both
  their cached and their already-painted verdicts and derive the page again, so
  no tab can keep another model's answers. Forced-colors (High Contrast) keeps
  chips visible with semantic dots; `prefers-reduced-motion` is honored throughout.

## Languages

The interface speaks **English** and **Simplified Chinese**, and it follows the
**browser's** UI language — not the page's, and not `navigator.language`. There
is no setting and no picker: a browser running in `zh`, `zh-CN`, `zh-Hans*` or
`zh-SG` gets `_locales/zh_CN`, everything else falls back to `_locales/en`
(`default_locale`). `zh-TW` and `zh-HK` land wherever the platform's own fallback
puts them — we write no matching logic of our own, and the UI reads back which
file actually answered (the `localeTag` message) to set `<html lang>` and the
`lang` on the shadow roots we inject into other people's pages, so screen readers
and the CJK font fallback are told the truth.

Everything a user reads is translated: the chip's hover card and its four verdict
labels, the floating ball and its triage panel, the selection card, the Google
Docs reading bar, the **copied report** — it is what you paste to other people,
in your language — the four extension pages, the right-click entries and the
keyboard-command descriptions in the manifest. What is *not* translated: console
and debug logs, the daemon's own messages, the model id, the contract and version
strings, and the `~/.anagram/bin/anagram …` commands, which are commands.

Adding a language is one file. `public/_locales/<locale>/messages.json` with the
same keys as `en` (which carries a `description` on every message for context),
and nothing else: `lib/i18n.ts`'s `t(key, …)` / `tn(key, n)` is the only way any
of our code asks for a string, the key union is derived from the English file so
a typo is a type error, and `test/node/i18n.test.ts` fails on a key that is in
one file and not the other, a placeholder that moved, an empty message, a message
nobody uses and a key nobody wrote.

English is also compiled *into* the bundles, because `lib/` runs where there is no
extension API (the esbuild unit bundle, vitest) and where there is no longer one
(a content script whose extension context was invalidated). Each bundle carries
only the English it can actually show: the build scans the source files its own
entrypoint can reach and compiles in the messages they name — the content script
holds no options, onboarding, popup or reader string, and the background worker
holds its three menu titles. Nothing to do when adding a `t()` call; if the build
cannot see how a file was imported, or the key is not in `en/messages.json`, it
says so and stops. See `scripts/i18nSubset.ts`.

```bash
ANAGRAM_UI_LANG=zh-CN node test/pages.mjs <outDir>   # the pages, in Chinese
```

## Install (unpacked)

```bash
npm install
npm run build          # Chrome  → output/chrome-mv3/
npm run build:firefox  # Firefox → output/firefox-mv2/  (web-ext lint: 0 errors)
```

**Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** →
`output/chrome-mv3`.

**Firefox:** `about:debugging` → This Firefox → **Load Temporary Add-on…** →
`output/firefox-mv2/manifest.json`. (`npm run zip:firefox` builds the
AMO-submittable zip.)

> **Firefox 140 or newer** (the manifest says so). Before Gecko 140 a content script
> cannot give a shadow root a constructed stylesheet (`adoptedStyleSheets` throws
> "Accessing from Xray wrapper is not supported"), so no chip, ball or card would
> render at all; 140 is also where the CSS Custom Highlight API arrived.

Browse anywhere with prose. The ball sits bottom-right; the toolbar popup and
the options page hold the switches. Keep `npm run serve` running in a terminal —
see [`anagramd/README.md`](anagramd/README.md) for the API and its hardening.

## Testing

Ten suites. The browser suites that must not depend on the model point the
extension at `test/fake-daemon.mjs`, a test-only Node server that speaks the
daemon's contract with text-seeded, deterministic verdicts (nothing of it ships).

They also load a **test build**, not the shipping one: a permission prompt is
native browser UI that no automation can click, so `test/test-build.mjs` builds
the same code with the two optional site patterns REQUIRED instead
(`ANAGRAM_TEST_GRANT_ALL=1` → `output-test/`) and the harness builds it whenever
it is missing or stale. That is the "you granted all sites" state, which is the
one everything else is measured in. `npm run build` is untouched. The part no
suite can reach — the prompts themselves — is `docs/manual-checks.md`.

**No suite opens a window.** They run Chromium's new headless mode (it loads MV3
extensions) with a throwaway profile, so a run takes no focus, shows no Dock icon
and never touches your own Chrome. `HEADED=1 npm run test:e2e` brings the window
back when you want to watch; only `npm run browser` / `npm run play` always do.
The Firefox suite is headless with no way back: macOS reports its process as
`type="BackgroundOnly"`, and puppeteer's `--foreground` default argument — which
would make Firefox a foreground application — is stripped in the harness.

| Suite | Command | Checks | What it covers |
| --- | --- | --- | --- |
| Node | `npm run test:node` | 306 | vitest + `wxt/testing`: the grouping rules a page and a PDF share (every group over the evidence floor and inside one model window, no group across a barrier, a caption or a column break, order kept, nothing read twice, nothing droppable dropped — over a few hundred seeded sequences of blocks) and what a PDF's reconstruction makes of them (three short paragraphs under a heading read as one unit, nothing across the heading, strict per-paragraph mode reading none of them), PDF paragraph reconstruction on synthetic pages (one, two and three columns with full-width matter between them, and the tables, ragged indents and justified word spaces that are not gutters; front matter; indents; hyphenation branch by branch; running heads including a bound book's alternating pair; lists; footnotes and captions reached past; drop caps; headings; paragraphs continuing across a page or a column; CJK set solid; a rotated margin stamp; and the weight of a thirty-page paper), reading a long text in windows (every window in one call, a text that fits sent exactly as before, a window the daemon cut re-read in halves once, no verdict on a partial answer, one failed window → Unavailable), router invariants (keys snapshotted per request, keys reserved before the queue so a waiting batch absorbs later requests, a joined request reports the identity that actually answered it, results cached under the producing model, priority order and promotion), LRU eviction in both in-memory caches, scheduler idle/pause/upgrade and a long unit priced by all of its windows, wire validation (including that no redirect can carry a request away), the daemon client (loopback only, down TTL, another contract major reported as a version mismatch rather than an outage), per-site rules (a rule covering every subdomain of its site, the most specific one winning, `www.` folded away on both sides, the public-suffix guard, IP addresses and localhost matched exactly), what the popup's "This site" switch writes for every combination of an inherited rule and the global default, clearing the cached verdicts (both layers emptied, a paragraph sent to the daemon again afterwards, a request in flight over the clear still settling and nothing degraded cached), and which settings change ends a one-shot “Analyze this page” run (an off rule that was already there ends nothing; this site turned off during the run, or a more specific off rule, ends it); plus property runs over a few hundred seeded texts each (a seeded PRNG, no dependency) — the canonical scoring text is a fixed point, never grows beyond NFKC, has no edge or double whitespace, drops every invisible and folds soft hyphens / NBSP / curly quotes; window plans are consecutive, gapless, inside the budget and the minimum, capped and deterministic; and seeded scheduler programs (enqueue, upgrade, pause/resume, epoch bump, completion) never put a unit in flight twice, send it once per epoch, serve higher lanes first, drain to one idle signal and never render a superseded epoch; plus the two message files against each other and against the tree (same keys, same placeholders, no empty message, a description on every English one, both halves of every plural, no message nothing uses, no key nothing wrote) and `t()` itself — English with no extension API, its own $1…$9 substitution, the singular only for one, the platform preferred when it answers and fallen back on when it returns "" or throws, optional site access (the origin pattern for a tab — ports dropped, IDN in punycode, IPv6 and `file:`/`chrome:`/the store refused; the daemon's own loopback hosts never carrying a content script; and the worker's registration against faked permissions/scripting/tabs APIs: a grant registering on exactly those origins and injecting the tabs already open, a withdrawal unregistering and stopping every tab we may no longer read but not one running on `activeTab` alone, install/startup/wake re-asserting, doubled events changing nothing), what each shipping manifest asks for (the daemon's two hosts required, the all-sites pair optional, no content script declared), -Security-Policy, its `connect-src` list and its `web_accessible_resources` (those |
| Unit | `npm run test:unit` | 498 | walker/assembler/extraction (voice scopes and which short paragraphs may be scored together — thirty-four fixtures modelled on real post, thread, feed, answer, article, forum, review, RFC and mail-archive markup; posts that declare themselves and posts recognised by their structure — what counts as a byline and what is a control beside it, a lone reply, the opening post of a thread, lines of verse, a flat chat, one author's list and table, the cost of a hundred comments — a post read whole, a stretch of short paragraphs divided into model-sized groups, no orphan next to a full paragraph of its own voice, an article left per paragraph, and re-scans driven the way the orchestrator drives them; what the walk reaches: heading containers, notranslate application shells, boxes that clip their own text and where their chip goes — one chip under a clipped review and the other five at their own paragraphs, opened, closed and chipped in the order a daemon answers, a box that only starts clipping once its images arrive, a quotation inside the clipped text, a box that is the post itself, a page that reflows under a chip — prose in `<pre>` against code, configuration, diffs, logs and e-mail quotations — math, citation marks, hidden copies, out-of-flow markers, accordions, author lists), window planning (balance, sentence and CJK boundaries, a merged unit cut between two paragraphs, the no-boundary and at-budget cases, the cap, the regex fallback), the mapping from a window back to text nodes (inline markup, collapsed whitespace, merged parts, a skipped formula, a DOM that changed), aggregation arithmetic, per-window marks and the card's window row, canonical scoring text, band mapping, Readability-guided scope — in a real Chromium page (~5s) |
| E2E | `npm run test:e2e` | 33 | full extension on a 20-section fixture page against the fake daemon — including that non-English text never reaches it, that a post of mixed paragraphs sits under one ×N chip and is one chip again after it is opened in place, and that a three-window paragraph reaches it whole: three consecutive blocks, none past the token window, one chip, each window marked in its own band |
| Scenarios | `npm run test:scenarios` | 79 + 13 | UI edge cases (the PDF reading mode driven from PDFs the suite writes itself — the real pages drawn with a text layer over each, the paragraphs reaching the daemon in order with the running head still on the page and the hyphen mended, three short paragraphs under a heading reaching it as ONE unit under one ×3 chip with marks on all three and nothing grouped across the heading, a chip inside every page and over no glyph, marks on the paragraph's own letters, a zoom that rebuilds nothing and re-asks nothing, a thirty-page paper whose last page has its text long before its picture and a panel jump that brings both, the panel and a report that names the PDF; a scan shown with the no-text-layer line and the broken-file line; the ball's "Analyze PDF" on a PDF tab — hover card, panel filters, FAB snap/tuck, top-layer, KaTeX, vertical text, CSS Color 4 backgrounds, late shadow-root content, a post clipped to three lines whose chip sits under the visible text and returns to its own last line when the post is opened, a six-paragraph review clipped to a few lines that keeps ONE chip under the box and the rest at their paragraphs, a box that only starts clipping when its image arrives, mutation storms, on-demand Readability chunk, self-rewriting page, main-content scope honoured from the very first scan, the selection card's ✕ while the daemon is still thinking, a long selection analyzed whole in windows, the copied report's bare percentages and legend and its line for a paragraph scored in windows, dense text the daemon had to cut re-read in two halves, daemon down → Unavailable → daemon back → auto re-queue, a quoted mailing-list message keeping its chip through a mutation beside it, and the whole interface in Simplified Chinese — a SECOND browser launched with its UI language set to zh-CN, asserting the popup, the options page, a chip's card, the panel's title / filters / Copy report, the context-menu titles (read back through `chrome.i18n` in the worker, since `chrome.contextMenus` has none) and the copied report, with the first browser's English left untouched; where the platform will not switch the browser's language the check SKIPs loudly rather than passing against an English browser) + keyboard-only triage (focusable counter, Enter/Esc focus hand-off, accessible names, the three commands driven from the service worker) and a no-referrer cross-origin frame obeying the top page's site rule, the Google Docs reading overlay re-reading its document in place (new paragraphs chipped, the old ones gone, one bar, a failed re-read leaving the snapshot alone), the first-run page's setup strip (daemon running with its model and device; stopped → the start command, the install one-liner and a Copy button that puts exactly the command on the clipboard; started again → the rows follow without a reload; a contract-mismatched daemon → the update command), and the three small controls (a rescan answered from the worker cache and the daemon asked again once the verdicts are cleared; “Analyze this page” running once on a switched-off site, gone after a reload, with nothing written; the same run on an already-off site surviving an unrelated rule and ended by the panel's own “Turn off on …”), and what a page COSTS over time: one page built two ways — step by step under a watching extension (posts appended in batches, a paragraph inserted into a live post, text edited in place, a block wrapped and unwrapped) and all at once before the content script runs — ending with identical chips in identical places with identical numbers; a burst of 130 dirty nodes becoming at most ten walks; twenty `replaceState` rewrites costing no re-walk and no chip while a pushed entry is still refreshed once; and the insertion gate — a page carrying a hydration marker gets no chip into its tree before it has loaded (and gets them straight after, as verdicts, never as chips left analyzing), the same page without the marker is chipped long before `load` as it always was, and a run torn down while its chips are still held draws none of them afterwards, leaves no timer armed, and starts clean when it is switched back on + 13 live sites (bot-check interstitials count as skips) (`-- --local` skips the live sweep) |
| Firefox | `npm run test:firefox` | 34 | the **Firefox MV2 build in a real Firefox** — the only suite that is not Chromium. Playwright cannot load an extension into Firefox, so it drives headless Firefox through `puppeteer-core` over WebDriver BiDi (no geckodriver): `webExtension.install` puts the unpacked `output/firefox-mv2` in temporarily, and the profile pref `extensions.webextensions.uuids` fixes the internal origin so `moz-extension://…/options.html` is addressable. Covers the MV2 shape (background **page**, `browserAction` instead of `action`, and that `browserAction.setBadgeText` really applies a flagged count), chips across the self-test page (long paragraph = one chip, BR-split and short siblings merged, pure-CJK "unsupported" and no non-English text reaching the daemon), underlines when `CSS.highlights` exists (SKIP below Firefox 140), the ball + panel + toggle + hover card inside the viewport, the dynamic paths (tab reveal, `<details>`, removal, rapid insertion, a pushState route swap given ~6 s because Firefox may have no Navigation API), the popup / options / onboarding pages with a setting written in one reaching an open tab live, the PDF reading mode (Gecko drawing the real pages with a text layer over each, chips placed on them by the ordinary pipeline and marks on the glyphs, a dropped file read, and pdf.js parsing it in a module worker loaded from `moz-extension://` — watched at the Worker constructor, because Firefox reports no Resource Timing entry for a privileged page's own subresources), daemon down → "Unavailable" + "!" → daemon back → auto re-queue (`-- --quick` skips it), and no console errors. Ends with a **FIREFOX vs CHROMIUM** block naming every behavioural difference it found. Needs Firefox **135+** to run at all (that is when BiDi learned `webExtension.install`) and **140+** to pass; it is never installed system-wide — `npx @puppeteer/browsers install firefox@stable` drops a Mozilla build in `~/.cache/puppeteer`, or point `ANAGRAM_FIREFOX` at a binary |
| Server | `npm run test:server` | 39 | **the real model**: spawns `anagramd`, checks the API on human/AI/Chinese samples (the last one must come back unsupported via fastText), the request limits and the body cap counted on the bytes that arrive (a 2.1 MB chunked POST with no `Content-Length` is still 413), `application/json`-only on `/score`, the `Origin` allow-list (extensions and the daemon's own pass; `null` and a web origin are 403), the Host allow-list, the absence of CORS grants, and a model version that digests the whole pipeline, then drives the built extension — real verdicts on every English chip, the 4-bucket card, the "zh" unsupported chip, the popup's model line |
| Docs flow | `node test/docs-flow.mjs <public doc URL>` | 12 | in-tab overlay + classic page flow on a real public Google Doc — the original demo doc was deleted from Drive, so without a URL (or `ANAGRAM_DOC_URL`) the suite reports SKIP |
| Matrix | `npm run test:matrix` | 136 | the UI fixtures under **17 device profiles** — 360 px phones to a 3440 px ultrawide, pixel ratios 1 / 1.25 / 1.5 / 2 / 3 (Windows display scaling), classic layout-eating scrollbars, a 420 px-tall window, dark scheme, forced colours, reduced motion, touch, zh-CN and Arabic UI locales — asserting what must hold on every one: all chips reach a verdict, showing them adds no side-scroll and grows no paragraph by more than a line, no chip leaves its block, the detail card (hover, or tap on touch) and the panel open fully inside the viewport, the ball stays on top, the options, onboarding and PDF reader pages fit the width, no console errors. A screenshot per profile lands in the artifacts folder. `node test/matrix.mjs phone dark` runs a subset |
| Accessibility | `npm run test:a11y` | 107 | **axe-core** (WCAG 2.1 A + AA, best-practice rules on a line of their own) on the popup, options, onboarding and PDF reader pages in **light and dark** — options with two site rules and the add-rule error showing, onboarding with the daemon up and stopped (its setup strip's Copy pills and install line only exist in the second), the reader empty and with a PDF the suite writes itself — and then, scoped to OUR nodes only, on the ball with the panel closed, open with flagged rows, open with both verdict filters, open on a **dark page**, on a pinned chip card, the selection card and the daemon-down notice (axe descends into the open shadow roots; the suite proves it did by naming a node it could only have reached through one). Plus everything axe cannot do, asserted in code: Tab reaches the ball then the counter, Enter opens the panel as a named dialog and hands focus over, Tab walks its controls in DOM order with no positive tabindex, Escape closes it and gives focus back; an accessible name (a real word, not a glyph) and a visible `:focus-visible` change for every control; a **24x24 CSS-px target measured the way a pointer measures it** — `elementFromPoint` at the corners and centre of a 24 px box, put to the element's own root, so a control drawn smaller that carries an invisible hit area passes and one that does not fails; colour contrast computed from the RESOLVED colours for the chip number, card verdict, panel percentages and counter in light and dark — axe cannot always see through a top-layer popover in a shadow root, and nothing is measured until `document.getAnimations()` goes quiet, since a chip mid-`background-color` transition reads as a phantom failure; under `prefers-reduced-motion` **no node of ours may be left with a duration to run at all** (asked of the cascade, not of a synthetic hover, which proves nothing when it fails to land); forced colours keep a chip boundary and the verdict dot; and the three live regions are read back after the events they announce. Its **baseline is empty** — everything it found on the day it was written has been fixed — so any violation is a regression, and a baseline entry that stops firing fails the run. Deliberate exemptions (the chips are `aria-hidden` and unfocusable on purpose) are listed apart. JSON report in the artifacts folder |
| Perf | `npm run test:perf` | 17 | five pathological documents, each budgeted against what it already costs — the fifth is the PDF reader on a thirty-page two-column paper (first page drawn, every page's text layer, the long tasks that costs, and the canvases still held after a scroll to the end and back). A 3000-paragraph article: first badge <4 s (measured ~0.2 s), no long task >1 s, scoring keeps up with the scroll. A feed that re-renders 450 paragraphs eight times over: bounded long tasks. The same feed virtualized, 2000 posts through a 50-post DOM: heap growth <8 MB after a forced GC, chips bounded by the DOM, no highlight range over a node that left it. And sixty clamped review cards whose pictures arrive as you reach them — the shape that makes chip placement measure the page: the browser's own **LayoutCount** against the same page with no extension, at most 1.6 layouts per chip (measured 1.28; settling each box on its own cost 2.46), with one chip under every box and never two |

### The lab: a screen of its own

`npm run lab` drives a Linux container (OrbStack or Docker) that has **its own
display**. Browsers started there are windows on that display, not on your desktop:
they cannot take focus or move your pointer, and you can still see — and use —
them through one page you park wherever you like.

```bash
npm run lab -- up          # build (first time: a few minutes) and start; prints the viewer URL
npm run lab -- view        # open the viewer — put this window on a desktop of its own
npm run lab -- test        # sync, build and run node + unit + e2e + scenarios + matrix ON that screen
npm run lab -- test matrix --headless
npm run lab -- test --offline   # the same, in a throwaway container with no network at all
npm run lab -- show --size 390x844 --dark https://en.wikipedia.org/wiki/Alan_Turing
npm run lab -- show --real # score with the real daemon running on the Mac instead of the fake
npm run lab -- hide        # close what show opened
npm run lab -- shot        # picture of the lab's screen → test-results/lab/screen.png
npm run lab -- down
```

What the container can touch: the repository, **read-only**; one writable folder,
`test-results/lab` (screenshots, `matrix.json`, `summary.json`); and one port, the
viewer, bound to `127.0.0.1`. Dependencies and the build live inside it (Linux
binaries never land in your `node_modules`), CPU and memory are capped
(`LAB_CPUS`, `LAB_MEMORY`), and `up --hidpi` renders the screen at 2x for a Retina
display. The Chromium build is the one the repo's Playwright version pins; when
Playwright's CDN cannot be reached the image takes it from npmmirror's copy
(`PLAYWRIGHT_DOWNLOAD_HOST` overrides).

`test --offline` proves the deterministic suites need no network: it runs them —
sync and build included — in a **throwaway container started with `--network none`**,
which has the same read-only repository and writable `test-results/lab`, its own
screen, and nothing but loopback. The lab you may be watching keeps running, but the
offline container publishes no port, so **there is nothing to view while it runs**;
it is removed when the run ends, fails or is interrupted.

Platforms: the lab is Linux; macOS is covered by the headless runs on your machine;
CI runs everything (matrix included) on Linux **and Windows** on every push, plus
macOS on tags and manual runs, and keeps the screenshots as build artifacts.

`npm run test:verify` proves the chips come from the model: it reads each chip's
probabilities, sends the same paragraph text straight to the daemon's API, and
compares — then stops the daemon and shows that no verdict is rendered without
it and the popup says so.
`node test/survey.mjs` loads two dozen pages of different kinds (news, docs,
forums, papers, legal text, a whole novel, shops, government, plain text, wikis)
with the real daemon and reports, per page, chips by verdict, chips in page
chrome, paragraphs cut into several units, long paragraphs with no chip and stuck
chips, with a screenshot each — the magnifying glass that found the accordion,
page-number, author-list, prefetch and self-rewriting-page defects.
`node test/coverage.mjs --label before` asks the layer below that — the segmenter
alone, no extension and no daemon — the same question over the ~120 real pages of
`test/coverage.urls.json` (news, blogs, papers, docs, wikis, forums, social,
shops, video, long documents, AI surfaces, mail archives, EN and ZH): per page it
reports reachability (a login wall, a bot check or a timeout is a result), words
judged against words of visible prose, **silent** containers that hold 50 words
and produce no unit — each with a structural reason obtained by re-running the
walker's own predicates in the page (which ancestry test, which boilerplate class
token, link-dense, name-list, a `role="heading"` wrapper, a "show more" clamp) —
posts cut into several units, units spanning two voices, units in page chrome,
and the cost of `collectUnits`. `--diff before.json after.json` says what a
change to the grouping rules moved; reports go to the artifacts folder.
`node test/dynamics.mjs` asks the question both of those leave out — what the
whole extension does to a page **over time**: for each of the ~30 pages of
`test/dynamics.urls.json` (infinite and virtualized feeds, lazy comment sections,
"show more" expansions, a live blog that rewrites itself, SPA docs sites, a long
static page as the control) it runs a scripted 60–120 s session against the fake
daemon — scroll down screen by screen, back to the top, click the view-only
controls the entry names, follow one in-site link and come back, resize, toggle
the ball — sampling every 2 s, and reports chips that duplicate, pile up at one
anchor, flicker, blink, stay "analyzing…" or end up out of sight in a collapsed
post with no chip parked under it (a later paragraph of such a post is hidden by
design and counted apart, as is a chip that measures 0×0 only because the browser
is not rendering that part of the page yet), paragraphs sent to the daemon twice,
whether the page's own text survived us, and the cost in long tasks, layout and
heap **against a control run of the same page with no extension**.

`node test/pdf-survey.mjs --label before` does the same for the PDF side: it runs
the extractor and the reflow over a handful of public documents (a two-column
paper, a single-column one, an RFC) under Node and reports, per document, blocks
and headings, the share of paragraphs ending in no sentence punctuation and the
share opening in lower case — the two proxies for a paragraph cut in half and a
continuation never joined back on — hyphens left with a space in them, and the
five shortest and longest paragraphs. It is the magnifying glass that found the
gutter cut through a column's last word and a caption's second half left
standing alone. Downloads land outside the repository and `--diff` compares two
runs; not in CI, and no PDF or its text is ever committed.

The two live-site surveys also run **every Monday**
(`.github/workflows/surveys.yml`, or Actions → surveys → Run workflow for one
tool, one site or the whole dynamics list). The schedule runs all ~124 coverage
pages and the dozen dynamics pages marked `"weekly": true` — one of every shape
the list knows: a server-rendered thread, a virtualized feed, a feed that
prepends, a virtual scroller, a river of lazy cards, a page that rewrites
itself, two clamped-post shops, a long static control and an SPA. Both reports
are kept as build artifacts for 90 days, and
`node test/survey-gate.mjs baseline.json current.json` compares the new one with
the last green run's: per site it asks whether the segmentation collapsed,
coverage fell, posts started fragmenting or units started crossing, whether
chips began piling up, flickering, sticking, duplicating a unit or costing five
times the control run — each with a threshold measured from the run-to-run
spread of the same build, and none of them absolute, because the gate answers
"did this get worse", not "is this perfect". A site that was unreachable,
bot-walled or login-walled in either run is `skipped` and never a failure — the
runners sit in US data centres, so the Chinese half of the list is walled there
far more often than here — and a page that served a different body of text is
reported as drifted rather than judged on ratios measured against two different
articles. The number of skipped sites is printed either way, so a list quietly
rotting is visible. A regression fails the job; the red X on the Actions tab is
the whole notification.

`npm run browser` opens a live Chromium with the extension for manual poking;
`npm run play` opens a multi-tab playground; `node test/shots.mjs` regenerates
the README screenshots; `node test/genicons.mjs` regenerates the icon set.

## Architecture (one paragraph)

A content script segments the page (`lib/dom/walker.ts`) into scoreable units,
claims their text nodes for incremental re-scans, and observes viewport,
mutations, attribute reveals and URL changes (`lib/capture/`, Navigation API).
An optional precision scope narrows collection to the main-content region
(`lib/dom/mainContent.ts`, Readability-guided). Units are batched through a
3-lane priority scheduler (viewport / near / idle prefetch) to the MV3 service
worker, which dedups, caches (53-bit content hashes, keys carrying the producing
model's version — the daemon's digest of its whole scoring pipeline — memory +
IndexedDB via `idb`) and calls the local `anagramd` daemon over HTTP, redirects
refused, through a prioritised, bounded queue (`p-queue`) that tries a batch a
second time only when the first failure could answer differently — busy,
timed out, no transport — after a jittered wait (`lib/backend/retry.ts`);
every response is validated (`valibot`) before it can become a chip,
and failures become never-cached degraded results (`lib/backend/`). Confidently
non-English paragraphs are settled locally first (`browser.i18n.detectLanguage`).
Results render as inline shadow-DOM chips
and Highlight-API marks placed by Floating UI (`lib/render/`); the Google Docs
overlay (`lib/docsOverlay.ts`) sanitizes the fetched document with DOMPurify
and reuses the same pipeline inside a shadow-root reader. PDFs get a reading
mode of their own: the extension page `entrypoints/reader/` fetches the file and
shows its **real pages** — a canvas per page drawn lazily by pdf.js and released
again once the reader is well past it, under a text layer built eagerly for every
page and left in the DOM for the life of the document (`viewer.ts`). Zoom is one
CSS variable (`--scale-factor`), so no span is ever rebuilt. A pure reflow
rebuilds the paragraphs from their geometry and says which run of which page
every stretch of each one came from (`lib/pdf/reflow.ts`); `lib/pdf/units.ts`
turns those into ordinary `Unit`s over the text layer's own nodes, and the page
starts the same orchestrator directly. Four small hooks carry the difference and
nothing else does: `OrchestratorOptions.collect` (units from the document, not
from a DOM walk), `Unit.textFixed` (its text is the reconstruction, and its parts
are pieces of a page rather than voices), `createBadgeLayer({ place })` (a chip in
the page's own coordinates) and `setRangeLocator` (marks over the glyphs each
window was read from). Readability, DOMPurify and pdf.js are **on-demand vendor
chunks** (`scripts/vendor.mjs` → `public/vendor/`, loaded by `lib/lazy.ts`), so
the content script that runs on every page stays small — pdf.js, its 1.2 MB
worker and the data a faithful drawing needs (CMaps for CJK, the standard
fourteen fonts, the JPEG2000 and JBIG2 decoders) are fetched only when a PDF is
opened. The surface↔backend contract (`lib/contract.ts`, v2.1)
is exactly the daemon's IO: `{bucket, probs[4], score, lang}` per paragraph, or
`unsupported` for non-English text.

### Libraries doing the heavy lifting

| Concern | Library | Where |
| --- | --- | --- |
| HTTP API, validation, OpenAPI docs | FastAPI + uvicorn + pydantic | `anagramd/serve.py` |
| Model download (install/update only, never while serving) | huggingface_hub, curl | `install.sh`, `installer/anagram` |
| Language identification | fastText `lid.176` | `anagramd/serve.py` |
| Main-content extraction | @mozilla/readability (on demand) | `lib/dom/mainContent.ts` |
| HTML sanitizing (Docs reading mode) | DOMPurify (on demand) | `lib/docsOverlay.ts` |
| PDF rendering + text extraction (PDF reading mode) | pdf.js / pdfjs-dist (on demand) | `lib/pdf/extract.ts`, `entrypoints/reader/viewer.ts` |
| Popover placement | @floating-ui/dom | `lib/render/badge.ts`, `selectionCard.ts`, `fab.ts` |
| CSS colour parsing + luminance | culori | `lib/render/theme.ts` |
| Persistent score cache | idb (IndexedDB) | `lib/backend/swCache.ts` |
| Prioritised queue | p-queue | `lib/backend/router.ts` |
| Which failures are worth a second attempt | — | `lib/backend/retry.ts` |
| Wire validation | valibot | `lib/backend/httpClient.ts` |
| Local language pre-gate | `browser.i18n.detectLanguage` (built-in CLD) | `lib/capture/langGate.ts` |
| Daemon request limits + Host / Origin allow-lists | pydantic, Starlette TrustedHost | `anagramd/serve.py` |
| Extension pages + in-page design tokens | Basecoat (Vega) | `lib/ui/`, `lib/render/` |
| Node-level tests | vitest + `wxt/testing` | `test/node/` |

## Permissions

Anagram installs able to read **no site at all**, and asks for what it needs one
line at a time. This is the whole list:

| What it asks for | What it is for |
| --- | --- |
| `storage` | Your settings and per-site rules, on this computer. |
| `activeTab` | The one-off actions on a site you have granted nothing for: *Analyze this page*, *Analyze selection*, *Copy page diagnostics*, the keyboard commands. Lasts for that one tab, until you leave the page. |
| `contextMenus` | The three right-click entries. |
| `scripting` | Registers the content script for the sites you grant, and injects it for the one-off actions above. |
| `http://127.0.0.1/*`, `http://localhost/*` (required) | The local `anagramd` daemon that scores paragraphs. It is the only thing the extension may reach. |
| `https://*/*`, `http://*/*` (**optional**) | The sites Anagram reads. Grant them all in one click from the first-run page or the options page, grant one site at a time from the popup's "This site" switch, or grant none. Take them back whenever you like — from the options page, or `chrome://extensions` → *Site access*. |
| `clipboardWrite` (**optional**, Firefox only) | *Copy page diagnostics*, asked for the first time you use it. Chrome needs no permission for it. |

A grant and a withdrawal both take effect on the tabs you already have open, with
no reload. Withdrawing site access does not touch your per-site rules.

`docs/manual-checks.md` is the by-hand checklist for all of this: a permission
prompt is native browser UI that no automation can click, so the browser suites
run against a build where the sites are already granted
(`test/test-build.mjs`, `output-test/`) — `npm run build` is always the shipping
manifest.

## Privacy

**Anagram contacts no remote server, ever, and the browser is what stops it.**
The manifest declares a Content-Security-Policy whose `connect-src` is the
extension's own origin, the two loopback spellings the daemon-URL setting
accepts, and `file:` — so `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`
and `sendBeacon` from any extension page or from the service worker can reach
the local daemon and nothing else, whatever the code asks for. No telemetry, no
analytics, no error reporting, no update check, no remote font. Only three files
of the extension are web accessible at all, at an address Chrome rotates per
session and gives only to our own content script, so a page cannot detect
Anagram by loading one either.

Everything Anagram touches is written down, file by file and key by key, in
**[`docs/footprint.md`](docs/footprint.md)** — every network call site with its
purpose and destination, every address written into the source, every stored
key, what a cached verdict holds, and what each permission is for.
`test/node/footprint.test.ts` checks that page against the sources on every test
run, so a call added and not written down fails the build.

The rest is enforced the same way: the
daemon URL setting accepts only `http://127.0.0.1:<port>` and
`http://localhost:<port>` — the two addresses a content security policy can
name, so nothing can be configured that the manifest would not allow anyway —
and the extension refuses to follow a redirect off either endpoint (a 307 from whatever is listening on that
port would have forwarded the page text somewhere unvetted), the daemon binds
`127.0.0.1` or `localhost` — the two names a browser's CSP can express, and the
only two it answers to — unless told otherwise, refuses any other `Host` header (DNS
rebinding), sets no CORS headers (web pages cannot read it; the extension uses
host permissions), requires `POST /score` to be declared `application/json` —
which forces a CORS preflight a web page cannot pass — and refuses any `Origin`
that is not an extension's or its own, `null` included. Every request is bounded
(blocks, characters, unique ids, contract version) before anything is tokenized,
and the 2 MB body cap counts the bytes that actually arrive rather than the
declared length, so a chunked POST is cut off mid-stream. The batch envelope
carries only a hostname + language hint by design, and the persistent cache
stores hashes and bucket probabilities, never text. The Google Docs reading mode
fetches the document same-origin with your own cookies, and the PDF reading mode
fetches nothing at all: the tab that is showing a PDF re-reads its own document
(same address, same cookies, normally out of the browser cache) and hands the
bytes to the reading mode through the extension's worker, so no page of ours
ever asks the web for anything.

The daemon itself reaches no network at all: it switches the Hugging Face client
offline before importing it and loads the two model files from disk, so a missing
or half-written one is an error naming the command that fetches it rather than a
quiet download. Fetching happens in exactly two places — the installer, and
`anagram model` — and each verifies what arrives against a checksum pinned in
`install.sh` before it is renamed into place, so an interrupted download is never
something the daemon can load.
