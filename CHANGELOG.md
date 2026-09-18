# Changelog

Notable changes to Anagram, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). The extension, the
`anagramd` daemon and the installer all carry the same version.

## [Unreleased]

### Added

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

### Fixed

- An embedded frame follows the site rule of the page it sits in. A frame that
  could read neither the top page nor a referrer — an embed with
  `referrerpolicy="no-referrer"`, or any site sending `Referrer-Policy:
  no-referrer` — used to fall back to its own hostname and keep scoring on a
  site Anagram was turned off on. It now asks the extension's worker, which
  knows the tab's page.

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
