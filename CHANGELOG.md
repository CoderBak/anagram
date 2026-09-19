# Changelog

Notable changes to Anagram, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). The extension, the
`anagramd` daemon and the installer all carry the same version.

## [Unreleased]

### Added

- The first-run page opens with a live **setup strip**: three rows — extension,
  scoring daemon, ready — each a status dot and a few words, so the one thing a
  new install is actually missing is the first thing on the page instead of a
  sentence in the footer. The daemon row says which way it is wrong and hands
  over the single command that fixes it in a copyable pill: `anagram start` when
  nothing answers (with the install one-liner underneath, for a computer where
  the daemon was never installed), `anagram update` when a daemon of another
  contract answers, and a link to the options page when the configured URL is not
  a local address. Running, it shows the model and device. The page re-checks
  every three seconds while the daemon is down — start it in a terminal and the
  rows follow within seconds, no reload — slows to a minute once it is up, and
  never polls a hidden tab. The colour never carries the meaning on its own: the
  dot only repeats what the words beside it say.
- `anagram doctor`: one command that says what is wrong with an installation
  instead of the single "Daemon not running" every failure used to look like. It
  checks, in order, the folder (marker, no symlinks, every sub-folder), the
  installed version against the version in `extension/manifest.json` (a mismatch
  is a half-finished update), the private Python and the daemon's imports in one
  invocation, `model.safetensors` and `lid.176.ftz` against the checksums the
  installer pinned, the free disk space, and the port — our daemon answering
  (model, version, device, language gate, contract), a stale pid file, or another
  program holding the port — plus the log's last lines when the daemon is not
  answering. One `ok`/`FAIL`/`warn` line per check with the command that fixes it,
  no colour when stdout is not a terminal, non-zero exit if anything FAILED. It
  changes nothing: no file is created, written, moved or removed, no process is
  started or signalled, and the Python probe runs under the scrubbed environment
  with no network and no bytecode written.
- `npm run lab -- test … --offline` runs the suites in a throwaway container
  started with `--network none` — the same read-only repository, the same writable
  `test-results/lab`, its own screen, and nothing but loopback — so the
  deterministic suites are proven to need no network. The lab keeps running, but
  that container publishes no port, so there is nothing to view while it does; it
  is removed when the run ends, fails or is interrupted.
- The Google Docs reading mode can be refreshed. Its bar has a "Refresh" button
  that reads the document again and swaps the page in place: the paragraphs that
  were there leave with their chips, the current text is analyzed, and the
  reading position is kept unless the document got shorter. The overlay is still
  a snapshot — it just no longer has to be closed and reopened after an edit.
- PDFs are read and analyzed. The browser's viewer hands extensions an image and
  no text, so Anagram opens the file in a reading mode of its own: pdf.js reads
  the text layer, the paragraphs are rebuilt from the page geometry — columns
  read column by column, running heads and page numbers left out, words the
  typesetter broke put back together, paragraphs sewn across page and column
  breaks — and the ordinary pipeline runs on the result, with the same chips,
  marks, ball, panel and report. The report names the PDF, not the reader page.
  Three ways in: "Analyze PDF" on the ball of a PDF tab, "Read this PDF" in the
  popup, and "Open PDF with Anagram" on a link to one; a reader opened with
  nothing loaded takes a file by drop or picker. A scanned PDF says it has no
  text layer, an encrypted or corrupt one says it cannot be read. The file's
  bytes never leave the browser, and nothing but paragraph text is ever sent.
  pdf.js and its worker are on-demand chunks, fetched only when a PDF is opened,
  so the content script that runs on every page is unchanged in size.
- The triage panel is reachable without a mouse. The ball's counter is a real
  button that says what it is ("3 flagged paragraphs — show list"), Enter opens
  the panel and moves the keyboard into it, Escape closes it and hands focus
  back, and each row announces its verdict and percentage instead of a bare
  snippet. Focus anywhere in the ball untucks it, and every control there now
  draws a focus ring.
- Three keyboard shortcuts, rebindable like the existing one:
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> opens the flagged-paragraph list
  and puts the keyboard in it, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> and
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> walk to the next and previous
  flagged paragraph, wrapping around.

### Changed

- `anagram update` restarts a daemon that was running. The installer replaces
  `app/` underneath it, so until now the old code kept serving until somebody
  restarted it by hand. The daemon is restarted only when it was ours and
  answering before the update; if the installer fails the running daemon is left
  alone and the command says so.
- `anagram version` prints in one line whether the running daemon is the installed
  build, and says "restart to run the updated daemon" when it is not.
- A per-site rule covers the whole site. Turning Anagram off on `www.zhihu.com`
  used to leave it on for `zhuanlan.zhihu.com`, and `x.com` and `www.x.com` were
  two unrelated rules. A rule is now looked up on the exact hostname first and
  then on each parent domain — the most specific rule wins, a leading `www.`
  counts as absent on both sides, and rules already saved keep working whichever
  spelling they carry. The climb stops before a bare public suffix (`co.uk`,
  `com.cn`, `github.io` and the like), and IP addresses and `localhost` match
  exactly. The options page's add-rule form takes a pasted address
  (`https://www.Example.com/path` → `example.com`).
- The popup's "This site" switch says which rule decides the page. It used to
  read and write the exact hostname only, so on `zhuanlan.zhihu.com` it showed
  "on" while a rule on `zhihu.com` kept the page off. The switch now shows the
  state of the rule that actually applies, the line under it names that rule's
  site ("on zhihu.com"), and flipping it ends with one rule saying what was
  asked: the parent's rule is removed when the global default already gives it,
  and otherwise this exact host gets its own rule, which wins for being more
  specific. The panel's "Turn off on <host>" still writes a rule for the host
  it names.
- A paragraph longer than the model reads in one pass is scored completely. It
  used to be judged by its opening — roughly the first 380 words — while the chip
  and the underline spoke for all of it. It is now cut at sentence boundaries into
  consecutive windows of at most 1800 characters, every window is scored, and the
  chip shows one aggregate: the length-weighted average of the windows'
  probabilities. The marks are per window, each in its own colour, so a text that
  turns from human to AI halfway shows where. The card says "Scored in 3 windows"
  with each window's own number, and the copied report carries the same line.
  Paragraphs that fit one window — nearly all of them — are sent, cached and
  shown exactly as before.
- "Analyze selection" reads a long selection the same way, so "Words analyzed"
  is the whole selection again rather than the first part of it.
- Dense text — figures, URLs, names — that overflows the model's window despite
  the character budget is read again in two halves instead of being cut. Should a
  half still overflow, the card says part of the text was not read.
- One paragraph gets at most eight windows (some 2 300 words). Past that the card
  says only the opening was scored, and the rest is left unmarked instead of
  being underlined in a colour nobody measured.
- One voice, one verdict. A group of short paragraphs no longer closes the moment
  it reaches fifty words — a status written as twelve short paragraphs got three
  arbitrary chips (×4, ×4, ×4), a 49-paragraph answer twenty. The stretch is now
  read to its end — a heading, a full paragraph, another post, the end of the
  comment — and divided evenly, between paragraphs, into groups of at most one
  model window (about 300 words), each with its own chip: as fine-grained as a
  paragraph chip, never one number for a thousand words.
- No orphans inside one voice. A short paragraph standing alone between full ones
  used to get no verdict at all — a quarter of the words of an ordinary newsletter
  article. It now joins the full paragraph next to it (the one before it by
  preference) when the two fit one model window, and that chip reads ×2. With a
  heading, a link row or another voice in between, or no room on either side, it
  stays unjudged as before.
- A short post is read whole. A post, comment or quotation whose own text fits one
  model window is one unit with every paragraph in it, the full ones included — a
  post of a short, a long, a short, a long and a short paragraph used to get two
  chips and three paragraphs nobody judged. Anything longer is an article and
  keeps a chip per full paragraph, as before. Headings, hashtag rows and "Show
  more" links inside such a post are left out without cutting it in two, and a
  name or headline set elsewhere in the card is not taken for its text.
- A post that changes while it is on screen — opened in place, a paragraph added,
  an answer still being written — is taken again as one unit and its old chip
  retired, instead of leaving the addition unjudged beside a chip that no longer
  speaks for the whole.
- A text of several paragraphs that is longer than the model's window — a long
  selection, mostly — is cut into windows between two paragraphs rather than in
  the middle of one.
- Short paragraphs are scored together only within one voice. Two posts by
  different authors, an author and the person they quote, a paragraph and a
  figure caption, a post and the post it quotes no longer share a verdict; a
  quotation or caption in the middle of an article pauses the author's group
  instead of ending it. Text that is too short on its own simply gets no chip.
- What joins a group is decided by what a line is, not by its length: a post
  written one short sentence per line is now covered, while a username, a
  timestamp or a "Reply · Share" row never becomes part of the scored text and,
  on pages with no semantic markup, ends the group instead of bridging two
  comments.
- A post is recognised where the site does not say `<article>`. Zhihu answers,
  GitHub comments, Hacker News and V2EX rows, Substack and old WordPress comments,
  phpBB posts, Telegram messages and Steam reviews are plain `div`s, table rows or
  list items, so none of the rules for posts applied to them: a comment of a
  short, a long, a short and a long paragraph got two chips instead of one, and
  only the byline rows that happen to stand between two comments kept their
  short texts apart. A post is now recognised by what it is — one of several
  elements like it, each with a byline of its own (a time, an avatar, a link to
  a person, a picture and a name that lead to the same place) — and read like a
  declared one: whole if it fits one model window, never together with its
  neighbour, the nearest container winning where replies nest. A lone reply is
  known by being shaped like the comment around it, the opening post of a thread
  by the thread that follows it. A bullet list, a prose table and an article
  with a byline at its head are still one author's text, and a single comment on
  a page of its own is read as before. LinkedIn's new feed
  (`div[role=listitem]` in a `div[role=list]`) and Bilibili's comments (nested
  shadow roots, where no structure can be seen) are named outright.
- Inside such a post, a bold one-liner or an unpunctuated line between two
  paragraphs is the author's own heading and no longer cuts the text in two, and
  a short paragraph next to a list set two levels deeper is read with it. A row
  of the card — "Recommended", "Posted: 12 September" — still ends what was read
  before it, so a site's counters never become the opening lines of a review.
- A post written one short line per paragraph, without punctuation, is read. Its
  longer lines were joined and its short ones taken for labels, so an answer of
  six such lines and 52 words got no verdict. Inside a post, short unpunctuated
  lines that stand beside other unpunctuated lines of the same text are lines of
  that text; a one-line heading between ordinary sentences still stays out.
- Top-level comments of a GitHub Discussion are recognised as posts. GitHub sets
  a comment's "…" menu before its header in the page, hidden; counted as text,
  it made the author line look like something in the middle of a paragraph, and
  only the replies were recognised — a comment that fits one model window was
  cut in two, shorter ones got nothing. Hidden elements, popovers, buttons, form
  controls and closed menus are no longer counted as text around a byline.

### Fixed

- Firefox: the idle prefetch lane never ran (a detached `requestIdleCallback` call throws in
  Gecko), so paragraphs below the fold were scored only when scrolled to — it is called on
  `window` now. The manifest's minimum Firefox is 140, the first version in which the chips
  can render at all.
- `anagram stop` really stops the daemon. `start` recorded the pid of the shell
  that wrapped it rather than the daemon's own, so `stop` killed the wrapper,
  reported success and left anagramd holding the port — and `restart` then found
  it answering and kept the old process alive. The daemon now replaces that shell
  (`exec`), so the pid in `run/anagramd.pid` is the process that serves.
- The Google Docs reading mode is analyzed again. Its full-screen layer was
  positioned on the element that carries the document, and the walk drops a small
  out-of-flow box as a decoration — a shadow host reports no text of its own,
  however much its shadow tree holds, so the whole document counted as empty and
  not one paragraph in the overlay was ever scored. The layer now sits one level
  in, where it always belonged.

- Chinese, Japanese or Arabic text that names a brand in Latin letters is read
  like any other. One capitalised word — "OpenAI" in a Chinese sentence — made
  the paragraph look like a title rather than running text, and short paragraphs
  of that kind were left out of their group: a 223-word Chinese post was judged
  by 135 of its words.

- Whole sites that produced no verdict at all now read. A survey of 124 real
  pages found four ways the walk never reached the text:
  - A container that merely **declares itself a heading** used to swallow
    everything inside it. lobste.rs marks every comment body
    `<div role="heading">`, and news and feed sites wrap a whole teaser card in
    an `<h2>` — a thread of 2 900 words gave nothing. A heading is a barrier
    only while it reads like a label: short, and holding no paragraph of its
    own. Real headings are still barriers and are still never scored.
  - A **`notranslate` application shell** used to blank a whole site. Mastodon's
    web client hangs under one, so every status on every instance was
    unreachable. The attribute is still honoured on code samples, brand names
    and widgets; on a shell — one holding the page's landmarks, or most of the
    page — it only means "do not machine-translate this app".
  - A post a site **clips with CSS** keeps its verdict, and the chip moves to
    where it can be seen. Feeds keep the whole post in the DOM and show three
    lines of it (LinkedIn, Substack Notes, Goodreads reviews); the text was
    scored, but the chip landed after its last word — inside the clipped box,
    out of sight. When a box clips its own text (a line clamp, or a fixed height
    with more than twice as much text inside), the chip of a paragraph whose last
    line is out of sight now goes right after that box, under the visible lines,
    and stays there when the post is opened. A quotation or a list inside the
    clipped text is part of the post and its chip comes out with the rest; the one
    thing a chip never leaves is the post itself. Paragraphs still on screen keep
    their chip where it is, and it follows the text when the page reflows under it
    — a Goodreads review grows as its images arrive — so no chip is left below the
    fold. Scroll containers, carousels, `<details>`, a page-level
    `overflow:hidden` under an open modal and a few pixels of overflow change
    nothing.
  - **Prose typeset in `<pre>`** is read: RFCs published as HTML, man pages and
    mailing-list archives, where every `<pre>` used to be skipped as code. A
    `<pre>` gets in only when nothing around it says code and the text itself
    reads as prose, so code, configuration, diffs, logs, stack traces, ASCII
    tables and tables of contents stay out, and the lines a mail quotes are
    never scored together with the reply to them.
- An embedded frame follows the site rule of the page it sits in. A frame that
  could read neither the top page nor a referrer — an embed with
  `referrerpolicy="no-referrer"`, or any site sending `Referrer-Policy:
  no-referrer` — used to fall back to its own hostname and keep scoring on a
  site Anagram was turned off on. It now asks the extension's worker, which
  knows the tab's page.

### Tests

- The pure text machinery is checked against properties rather than examples. A
  seeded generator (no new dependency) builds words, CJK, emoji, invisibles,
  non-breaking spaces, LaTeX residue, curly quotes, en-dashed figure ranges,
  blank lines and unbroken 300-character tokens, and a few hundred cases per
  property assert what the code documents: the canonical scoring text is a fixed
  point, never grows beyond what NFKC alone expands it to, carries no edge or
  double whitespace, drops every invisible and folds soft hyphens, non-breaking
  spaces and curly quotes to one form; a window plan is consecutive,
  non-overlapping, covers the read span exactly, stays inside the budget and the
  minimum, honours the eight-window cap and is deterministic; and the scheduler,
  driven by seeded programs of enqueues, upgrades, pause/resume, epoch bumps and
  completions, never has a unit in flight twice, sends a unit once per epoch,
  serves higher lanes first, drains to zero with a single idle signal and never
  renders a verdict from a superseded epoch. A failing case prints its seed.
- One known defect is pinned rather than papered over: removing an un-rendered
  LaTeX span can weld two quote characters into a digraph that only a second
  canonicalization pass folds, so the canonical form of `'$\alpha$'` is not yet
  a fixed point.
- `npm run test:firefox` runs the Firefox MV2 build in a real Firefox — 31 checks,
  the first time that build has been opened in a browser at all. Playwright cannot
  load an extension into Firefox, so the new `test/firefox-harness.mjs` drives
  headless Firefox through `puppeteer-core` over WebDriver BiDi (no geckodriver):
  `webExtension.install` installs the unpacked `output/firefox-mv2` temporarily, and
  the profile pref `extensions.webextensions.uuids` fixes the internal origin so the
  suite can open `moz-extension://…/options.html` and write settings the way the
  Chromium harness does. It covers the MV2 seam (background page, `browserAction`
  instead of `action`, the toolbar badge), chips and merges across the self-test
  page, the language gate, underlines where `CSS.highlights` exists, the ball,
  panel, toggle and hover card, the dynamic paths including a pushState swap, the
  popup/options/onboarding pages, the daemon down-and-back cycle, and console
  errors — then prints every Firefox-vs-Chromium difference it found. Firefox is
  never installed system-wide: `npx @puppeteer/browsers install firefox@stable`
  caches a Mozilla build in `~/.cache/puppeteer`. The suite is headless with no
  `HEADED` escape hatch, and strips puppeteer's macOS `--foreground` argument so
  the process stays `BackgroundOnly`. CI runs it on `ubuntu-latest` after the
  Chromium jobs.
- Two Firefox-only defects the Chromium suites cannot see are now caught. Below
  Firefox 140 nothing renders at all — `shadow.adoptedStyleSheets = [sheet()]` from
  a content script throws *"Accessing from Xray wrapper is not supported."*, so
  chips, the ball and the selection card die on their first render, rather than
  degrading to chips without underlines as the README promised. And on every
  Firefox the idle prefetch lane is dead: `window.requestIdleCallback` is read into
  a variable and called unbound, which Gecko rejects, so only what is scrolled into
  view is ever scored. Both are reported by the suite, not worked around.

## [0.3.2] — 2026-09-18

### Fixed

- Chips no longer float over a site's own overlays: a comment sheet, lightbox or
  cookie wall now covers the chips of the page behind it, while the ball and the
  hover card keep riding the browser's top layer.
- A chip is placed after a paragraph's trailing emoji or citation mark instead of
  in front of it.
- In a short window (a docked devtools pane, a half-height tile) the detail card
  slides over its chip instead of running off the top of the screen, and the
  triage panel takes the height there is and scrolls its list.
- The first scan waits for the settings you actually chose: "Main content only"
  no longer chips and sends paragraphs outside the article before correcting
  itself, and "Flagged only" no longer flashes "analyzing…" chips.
- A paragraph asked for twice while the queue is busy is scored once. A request
  now joins a batch that is still waiting for a slot rather than starting a
  second inference, and a visible paragraph that joins a background batch pulls
  that batch forward.
- A request that joined someone else's batch reports the model that actually
  answered it, not whatever the last health check happened to see.
- The selection card's ✕ closes it while the daemon is still thinking.
- The selection card tells the words you selected from the words that were sent:
  a long selection now says how many of them were analyzed.
- The Firefox build introduces itself to the daemon as Firefox instead of Chrome.
- `anagram start` rotates its log once it passes 5 MB, and never through a
  symbolic link.

### Changed

- A daemon that answers but speaks another contract version is reported as a
  **version mismatch** — "run `anagram update`" — in the popup, the options page
  and the first-run note, instead of being called "not running".
- The popup counts only real verdicts as analyzed and says how many paragraphs
  are unavailable.
- The copied report prints bare percentages with a legend explaining them,
  instead of "62% AI", and lists unavailable and non-English paragraphs apart
  from the analyzed ones.
- If the daemon comes back as a different model, open tabs drop their cached
  *and* their already-painted verdicts and derive the page again, so a tab of
  pure cache hits cannot keep another model's answers.
- The daemon's model version now identifies the whole scoring pipeline — the
  tokenizer and config files, the window length, the dtype and the language-gate
  state — not just the weights, so two configurations that could disagree about a
  paragraph never share a cache entry.
- The in-memory score caches are bounded LRUs (5000 entries in the service
  worker, 2000 per tab) rather than growing for the lifetime of the worker or the
  tab.
- `--selftest` asserts what its four samples should say, prints PASS/FAIL per
  line and exits non-zero when one of them is wrong; `--max-length`,
  `--batch-size` and `--port` are range-checked.
- The extension pages say "on this computer" instead of "on this Mac", since the
  installer supports Linux too.
- README: the batching figure, the model's reported accuracy and the suite counts
  now match the benchmark, Pangram's release post and the suites themselves.

### Security

- The extension refuses to follow a redirect on either daemon endpoint: the URL
  is checked to be loopback, but a 307 from whatever is listening on that port
  would have forwarded the POST body — the page text — somewhere unvetted.
- `POST /score` must be declared `application/json`, which forces a CORS
  preflight that then fails for want of CORS headers, so a web page cannot reach
  the endpoint at all.
- A request carrying an `Origin` must carry an extension's or the daemon's own;
  everything else, `null` included, is refused.
- The 2 MB body cap counts the bytes that actually arrive instead of trusting the
  declared `Content-Length`, so a chunked upload is cut off mid-stream rather
  than buffered and parsed whole.
- The daemon's `lang` field is validated as a language code before it can reach
  chip text or card markup.

### Tests

- No suite opens a window any more: every browser suite runs Chromium's new
  headless mode with a throwaway profile, so a run takes no focus, shows no Dock
  icon and never touches your own Chrome (`HEADED=1` brings the window back).
- `npm run lab` runs the suites on a Linux container's own display, viewed
  through one local page; `lab show` leaves a browser with the fresh build open
  there at any size, colour scheme or pixel ratio.
- `npm run test:matrix` checks the UI under 17 device profiles (360 px phone to
  3440 px ultrawide, pixel ratios 1–3, classic scrollbars, a 420 px-tall window,
  dark, forced colours, reduced motion, touch, zh-CN and Arabic locales); a
  profile whose browser dies mid-run is attempted once more and says so.
- CI runs everything, the matrix included, on Linux and Windows on every push,
  and on macOS for tags and manual runs.
- `node test/verify-backend.mjs` honours `ANAGRAMD_PORT` and points the extension
  at that port, so it can no longer test whatever happens to be on 8765.
- Suite counts: node 37, unit 103, e2e 23, scenarios 34 local + 13 live, server
  39, docs flow 12, matrix 136, perf 3.

## [0.3.1] — 2026-09-14

### Security

- The installer validates its target folder before downloading anything: an
  absolute path with no `.` or `..` segments, never `/`, `$HOME`, a system root
  or a symbolic link — and an existing non-empty folder must carry Anagram's own
  marker or it is refused untouched.
- Nothing outside that folder is ever removed or replaced: new trees are staged
  beside the old ones and swapped by rename, every deletion is checked against
  the validated path, and `uninstall` re-validates and refuses to run without a
  confirmation or an explicit `-y`.
- uv is no longer piped from the network into a shell: a pinned release tarball
  is verified against an embedded SHA-256, Python and the packages are pinned,
  and every child process runs in a scrubbed environment, so an inherited
  `UV_*`, `XDG_*` or `PYTHON*` variable cannot redirect a write, an import or a
  package index.

## [0.3.0] — 2026-06-30

### Added

- First release of the extension: a per-paragraph EditLens chip with a
  four-bucket detail card, verdict marks, the floating ball and its triage panel,
  right-click analysis of any selection, an in-tab reading mode for Google Docs,
  and the popup, options and first-run pages.
- The local `anagramd` scoring daemon (FastAPI, Apple-silicon GPU via MPS, a
  fastText language gate) and the one-line installer that puts the daemon, its
  private Python, the checkpoint and the built extension under `~/.anagram/`.
