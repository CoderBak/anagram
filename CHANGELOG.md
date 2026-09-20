# Changelog

Notable changes to Anagram, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). The extension, the
`anagramd` daemon and the installer all carry the same version.

## [Unreleased]

### Added

- **A door to the reading mode for a PDF on your computer.** Options → Detection → *Read
  a PDF from this computer* opens the PDF view with no document, where a file can be
  dropped or picked. It was reachable only from a PDF tab before — and a `file:` tab can
  no longer hand itself over (the extension asks for no access to the file scheme), while
  Firefox never had a tab that could. The first-run page says so too.
- **The store paperwork, written from the code.** `docs/store-listing.md` is every field
  the Chrome Web Store dashboard asks for, ready to paste and each answer tied to a file a
  reviewer could open: the single-purpose statement, the short description (which is the
  manifest's own `extDescription`, kept identical) and a detailed one that says what the
  number is and — as plainly — what it is not, a justification per permission the SHIPPING
  manifest declares (`storage`, `activeTab`, `contextMenus`, `scripting`, the two loopback
  hosts, the two optional site patterns) saying what each is for, where it is used and what
  is never done with it, "no remote code" with its evidence (the CSP, the vendored chunks,
  the two pdf.js wasm decoders that ship in the package), the data-usage disclosures in the
  dashboard's own categories — website content is the one that applies, because Google
  counts data as handled even when it never leaves the device — and a reviewer's guide to
  seeing the extension work, and to checking that it reaches nothing, **without** the local
  daemon, which installs on macOS and Linux only. `PRIVACY.md` is the policy that listing
  links to. Both are checked against `docs/footprint.md` line by line; neither promises
  anything the code does not do.

- **"Analyze this page" from the popup, with nothing granted.** On a page Anagram is off
  for — by a rule, or because no access was ever granted for its site, which is every
  page on a fresh install — the popup's button reads **Analyze this page** instead of
  "Rescan page" and runs the page once: no setting written, no permission asked. Opening
  the popup is what gives the extension `activeTab`, so the popup asks the worker, which
  injects the content script into that one tab and says what the context-menu entry has
  always said. A new user can see what Anagram does before granting it a single site.
- **A PDF's short paragraphs are read, under the same rule a web page's are.** On
  a page a paragraph below the fifty-word evidence floor is not thrown away:
  short neighbours of one voice are read together in window-sized groups (the
  chip says ×N) and a short text that cannot stand alone joins the full paragraph
  beside it. In the PDF reading mode none of that happened — every reconstructed
  paragraph under the floor was dropped, so a paper's short paragraphs were
  silently unread. The rules were never the walk's own, so they now live in one
  source-independent module (`lib/plan/group.ts`): the evidence floor, the
  division of a stretch into groups of at most one model window, and the
  orphan-joins-its-neighbour rule with its one-window bound. The DOM walker calls
  it — its behaviour is unchanged, to the letter, and the 477 segmentation checks
  pass with no expectation touched — and `lib/pdf/units.ts` calls the same module.
  What a PDF has instead of markup is the reconstruction's own verdict on what
  stands beside what: nothing is grouped across a heading, a caption, a footnote,
  a paper's title block, a table row, a line of author names, a separator or a
  column or page break, and a paragraph already sewn across a page break is one
  paragraph. A grouped unit carries every part's provenance, so the marks land on
  all of its paragraphs and its chip sits after the last one and reads ×N; the
  chip's footprint in the reader reserves the room those characters need, so it
  still never covers a glyph. Nothing that was scored before stops being scored:
  above the floor every block is read exactly as it was. "Group short neighboring
  paragraphs" turns this off for PDFs as it does for pages.
- **Anagram installs with access to no site; you grant it.** The manifest used
  to require `<all_urls>` and to inject the content script into every frame of
  every page — the one line in an install dialog that asks for everything. It
  now requires only the local daemon's two loopback patterns
  (`http://127.0.0.1/*`, `http://localhost/*`), declares no content script at
  all, and offers every site as an OPTIONAL grant: all of them in one click from
  the first-run page or the options page, one at a time from the popup's "This
  site" switch, or none at all — the context menu's *Analyze this page with
  Anagram*, *Analyze selection* and *Copy page diagnostics* still work on a page
  nothing was granted for, because opening the popup or a menu gives the
  extension `activeTab` for that one tab. A page reached that way behaves
  exactly as a site you have switched off does: present, answering, and
  analyzing nothing until asked. The registration follows the grant — one
  dynamically registered content script whose match patterns are the granted
  origins, re-asserted on install, on browser start, on every grant and on every
  withdrawal — and both take effect at once: a grant injects the tabs that are
  already open (no reload), and a withdrawal, from the popup, the options page
  or `chrome://extensions`, stops every affected tab dead. Granting all sites
  gives exactly the experience Anagram always had. Firefox has the same model
  (MV2 carries the two patterns in `optional_permissions`). Per-site rules are
  untouched by any of it — they are settings, not access.

- **The PDF reading mode shows the real pages.** It used to rebuild a PDF as
  plain `<h2>`/`<p>` on a sheet of its own, which makes the document text-only
  and breaks its format — figures, mathematics, columns, fonts, all gone.
  Anagram annotates the original; it never replaces or reformats it. So the
  reader is now a small pdf.js viewer: the pages themselves, drawn faithfully,
  on a neutral surface that follows light and dark while the paper stays white
  as printed. Each page's canvas is drawn when the reader comes near it and its
  memory is given back once they are well past, so a 300-page book stays
  bounded; the text layer over every page is built up front and left in the DOM,
  so Ctrl/Cmd+F finds text anywhere in the document. Zoom is fit-width by
  default with −/+, the percentage (which fits again) and Cmd/Ctrl +/−/0 — and
  it is one CSS variable, so no span and no chip is ever rebuilt by it.

  The paragraph reconstruction stays and becomes **invisible**. It still decides
  what the model reads as one paragraph — columns in reading order, running
  heads and page numbers out, lists and footnotes apart, broken words mended, a
  paragraph sewn back together across a page break — and it now also says which
  run of which page every stretch of that text was set in. That is what puts the
  marks on the document's own glyphs and the chip in the white space after the
  paragraph's last line, inside its own column, never over the other column's
  text. Everything else is unchanged: the same chips, the same hover card, the
  same panel, the same jump-to-flagged, the same copied report naming the PDF.

  A scanned PDF with no text layer is now **shown** rather than refused — that
  is the faithful thing to do — with the same one-line notice; there is simply
  nothing in it to score. Encrypted, oversized and corrupt files answer exactly
  as before. Drawing a page faithfully needs data pdf.js fetches while it works,
  so the CMaps (CJK), the standard fourteen fonts and the JPEG2000/JBIG2 image
  decoders are vendored beside it: the extension grows from 2.6 MB to 4.9 MB,
  none of which the content script on an ordinary page ever loads.

- **An arXiv paper opens as the paper.** arXiv publishes an HTML rendering
  (LaTeXML) of most papers at `arxiv.org/html/<id>` beside the PDF, and that
  markup has real paragraphs, real headings and formulas that say they are
  formulas — strictly better than anything the reading mode can rebuild out of
  glyph positions. So all three ways into the reading mode — the ball's "Analyze
  PDF", the popup's "Read this PDF", the context menu's "Open PDF with Anagram"
  — now open the paper's own page instead, at the version the PDF named, and the
  ordinary page walker analyzes it like any other page. A paper arXiv never
  converted gets the reading mode exactly as before.

  Existence is checked rather than assumed: the worker asks arxiv.org for the
  first 4 kB of the page and accepts it only as a 200/206 `text/html` whose
  first bytes carry LaTeXML's own marker — today a missing paper is a 404, but a
  "no HTML here" page served as 200 would otherwise land a reader on an error
  page. The request is time-boxed to 2.5 s, carries no cookies, and every answer
  is remembered for the worker's life, so a paper is asked about once. On a
  timeout, a network error or anything ambiguous the reading mode opens, as
  before. arxiv.org is the only site ever contacted, only for a paper being
  opened at that moment; there is no UI for any of this and no setting.

- **"Open PDFs in Anagram"** (options → Detection, **off by default**): a PDF
  tab opens in the reading mode by itself — or, for an arXiv paper, at the
  paper's HTML page, since both go through the worker's single route. Chrome
  only: the content script inside Chrome's PDF tab is what notices the PDF and
  asks the worker to move the tab, and Firefox's viewer is a privileged page no
  content script reaches, so the switch is not shown there.

  The ways it could have become a trap, and what it does instead: pressing
  **Back** out of the reading mode lands on the PDF and stays there (a
  `back_forward` navigation never auto-opens), **"Open original"** and the way
  out of every "could not be read" line hand the tab a one-shot pass so it is
  not sent straight back, a PDF opened in a **background tab** moves that tab
  and never the one being read, **reloading** the reading mode keeps it, and
  turning the switch off takes effect on the next PDF with no restart. A
  `blob:`/`data:` PDF exists only in the tab showing it and is left alone; a PDF
  served as an attachment never becomes a document and never reaches this at
  all.

- **Copy page diagnostics** — a right-click entry, next to "Analyze this page
  with Anagram", for the page where nothing shows up. It puts a short
  description on the clipboard: the extension version, the browser, both
  languages, the page's HOSTNAME (never its path, query or fragment), the
  document language, the viewport, the scope and merge settings, the daemon's
  state, whether the page carries a framework hydration marker, and the
  subframes by origin and size; the counts (units, multi-part units, windows,
  chips, flagged, unavailable, unsupported) and how many words were judged out
  of the page's visible prose; the largest stretches of prose that got nothing,
  each with the reason — under the 50-word floor with its word count,
  link-dense with the ratio, page chrome with the class token that matched, a
  heading label, hidden or clipped, inside a `<pre>` of machine text,
  contenteditable, `aria-hidden`, another language with the one detected, or a
  unit nobody drew; and the structure of the region that was right-clicked.

  The reasons are not a second copy of the rules: the walk's own
  `isExcludedByAncestry` decides whether a stretch was refused at all, the
  shipped `isBoilerplate` is probed one class token at a time to say which
  branch of it fired, and the link ratio, the symbol-noise and name-list tests
  and the word floors are the ones the product runs. A copy would drift within
  a release and the report would then explain a page by a walk that no longer
  happens.

  Nothing a person wrote leaves the page. Every word in the captured structure
  becomes filler of the same length, script and capitalisation — so it counts,
  breaks and merges exactly as the original does and a fixture rebuilt from it
  reproduces the bug — while URLs, alt text, titles, input values, `datetime`
  values, free-form `aria-*` values, comments and inline scripts are dropped
  outright and only a whitelist of attributes survives. `test/unit.mjs` proves
  it the hard way: a page of planted secrets whose prose is consonant clusters
  no English text contains, and not one four-character run of any of its text
  nodes may appear in the report, measured against a control report of the same
  page with different words so the report's own vocabulary cannot mask a leak.

  The interface is one menu entry and no new pixel on the page: the toolbar
  badge shows a tick for a second and a half and then the flagged count again.
  It answers on a site Anagram is switched off for — "DISABLED for this site by
  rule `<host>`" is one of the things people are trying to find out — and it is
  in English whatever the interface is in, because it is written for whoever
  has to fix the site. The report is capped at 60 kB so it can be pasted into a
  chat, and says when it was cut.

  Underneath, it is an on-demand chunk (`public/vendor/diagnostics.min.mjs`,
  46 kB, built from the tree before every build and on install, never
  committed) rather than twenty kilobytes added to the content script that runs
  on every page — which grows by 2.9 kB, the menu entry and the glue.

  It asks for no new permission on Chrome: the copy happens when the worker's
  menu message reaches the page, which is no longer a user-input handler, and
  that is all the async clipboard API wants of a content script whose tab is
  focused — which the click has just made it. Firefox refuses a content script
  both clipboard routes outside a user-input handler, so the Firefox manifest
  declares `clipboardWrite` **optional** and the worker asks for it from inside
  the menu click itself, once; granted, it sticks and is never asked for again.
  It is not a required permission because a clipboard permission is a sentence
  in the install dialog ("Input data to the clipboard"; Chrome words it "Modify
  data you copy and paste") and, added to a published extension, it disables it
  until every user re-accepts — too much for a menu entry most readers will
  never open. Declined, or refused for any other reason, nothing is copied and
  the badge flashes "!" instead of "✓" rather than leaving the reader to paste
  whatever they cut last.

- **Simplified Chinese**, following the browser's UI language. There is no
  setting and no picker: a browser running in `zh`, `zh-CN`, `zh-Hans*` or
  `zh-SG` gets `_locales/zh_CN`, everything else falls back to `_locales/en`,
  and `zh-TW` / `zh-HK` land wherever the platform's own fallback puts them —
  there is no matching logic of ours for them to disagree with. Everything a
  user reads is translated: the chip's hover card and its four verdict labels
  (人工撰写 / 轻度 AI 编辑 / 重度 AI 编辑 / AI 生成), the ball and its triage
  panel, the selection card, the Google Docs reading bar, the four extension
  pages, the right-click entries, the keyboard-command descriptions in the
  manifest, and the **copied report** — it is what you paste to other people, so
  it is in your language too. Console logs, the daemon's own messages, the model
  id, the contract strings and the `anagram …` commands are not translated,
  because none of them is a sentence. Our shadow roots and the extension pages
  declare the language they are actually in, so screen readers and the CJK font
  fallback are told the truth on an English page.

  Underneath: `lib/i18n.ts` is the only way any of our code asks for a string,
  its key union is derived from the English file so a typo is a type error, and
  `tn(key, n)` covers the `_one`/`_other` pairs English needs where the code used
  to append an "s". The extension pages keep their English **in the HTML** —
  nothing flashes, they read correctly with the script off — and name their key
  in `data-i18n`; a sentence with a `<code>`, a `<kbd>` or an emphasised word in
  it stays one message with $1…$9 where those elements go, and the substitution
  can only ever put back an element the page already had, so no message is ever
  parsed as markup. Adding the next language is one file.

- Three things the interface only ever showed are now also said. The selection
  card is a polite status region, so a verdict reached from the right-click menu
  is announced when it lands instead of appearing in silence; the floating ball
  carries one visually-hidden live region that says the flagged count once it has
  stopped moving (1.5 s of quiet, only when the number changed and found
  something — a zero and the daemon-down "!" stay silent, and no increment is ever
  read out on its own); and the panel's "Copy report", which used to confirm
  itself only by swapping its own label to "Copied ✓", goes through the same
  region. None of it adds a word of visible chrome.

- "Analyze this page with Anagram" in the right-click menu. A page on a site
  Anagram is switched off for (or with "All websites" off) could only be analyzed
  by switching the site on and back off again. The menu entry runs the analysis
  once in that tab — the top frame and its frames, each still size-gated — and
  writes nothing: no setting, no site rule. It lasts until the tab leaves the
  page: a settings change elsewhere does not stop it, and neither does the rule
  that was already switching this site off when it started — only turning this
  site off during the run does, from the popup or from the panel's own "Turn off
  on <host>", which now ends the page's run whether or not the rule it writes is
  a change. On a page Anagram is already on it is a Rescan. The popup keeps
  telling the truth about such a tab: "This site" stays off, and the counts are
  there.
- "Clear cached verdicts" (options → Advanced). Verdicts are cached three ways —
  per tab, in the service worker's memory and in IndexedDB — and there was no way
  to empty them: a paragraph the daemon answered for once was never asked about
  again. The button clears all three, in every open tab as well, and confirms on
  itself. Nothing is rescanned or repainted — what is on a page stays until its
  next scan, which asks the daemon again.
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
  the text layer, the paragraphs are rebuilt from the page geometry — any number
  of columns read one after another, running heads and page numbers left out
  (including the two alternating heads of a bound book), a paper's title block
  read as front matter rather than as headings welded to its abstract, every item
  of a list kept apart, footnotes and captions held out of the flow so the
  paragraph they interrupt can be sewn back together across the break, words the
  typesetter broke put back together against the document's own spelling of them,
  a drop cap put back at the head of the paragraph it opens, and CJK set solid —
  and the ordinary pipeline runs on the result, with the same chips,
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

- **The triage panel says how much of the page was read.** One quiet line of
  numbers under the title — `18 read · 7 short · 3 not English`, with `pending`
  and `unavailable` when they are not zero. "0 flagged" on its own reads as "all
  clear", when it can equally mean that nothing on the page was long enough to
  judge, or that none of it was English. "Short" is prose the walk found and
  gave up on: under the 50-word evidence floor with no neighbour of its own
  voice to join. The walk reports each such stretch as it decides
  (`CollectOptions.onShortText`), which is the only moment the answer exists —
  nothing is read twice for this. The line is drawn, never announced: the
  panel's live region still belongs to the flagged count alone.
- **`docs/footprint.md`** — the page somebody auditing this extension reads: every
  network call site in `lib/` and `entrypoints/` with its purpose and its
  destination, every `http(s)://` literal written into the source, every
  `chrome.storage.local` key, what a row of the IndexedDB score cache holds and
  what bounds it, what is written outside the browser, and what each permission
  is for. `test/node/footprint.test.ts` reads that page and checks it against
  the sources on every `vitest` run, in both directions: a network call nobody
  wrote down fails it, and so does a line whose call site has gone.

- **A password-protected PDF now opens.** The reading mode used to say "this PDF
  is password-protected" and stop. It asks instead: one field in the bar, Enter
  to try it, a refused password marking the field and emptying it, and nothing
  said that the lock has not already said. The password is never stored, never
  logged and never in the page diagnostics — it travels from the field to pdf.js
  and no further.

- **An arXiv paper's HTML page is offered as a link in the reading mode.** A
  quiet `HTML` beside "Open original", for the papers arXiv has converted. It is
  a link and nothing else: no probe, no request, nothing asked of anybody until
  it is clicked.

### Changed

- **`npm run zip` refuses to package the test build.** The suites load a variant of the
  extension where the two optional site patterns are REQUIRED instead
  (`ANAGRAM_TEST_GRANT_ALL=1`), and that variable also moves the whole build to
  `output-test/` — which `wxt zip` would have followed, producing a store package that
  demands access to every site a reader visits and is otherwise identical to the real one.
  `wxt.config.ts` now refuses the `zip` command outright with that variable set (`wxt
  build` is untouched, since building the variant is what `scripts/buildTest.mjs` does),
  and `test/node/permissions.test.ts` gains three cases: the variant's manifest carries the
  site patterns as required and offers none, the two manifests therefore cannot read alike,
  and the refusal is still in the config.

- **`anagram update` no longer pipes an unread script into a shell, and `bench.py` no
  longer ships.** When a folder had no `app/install.sh`, `update` fetched `install.sh`
  from GitHub and piped it straight into `sh` with this folder's name in its environment —
  an unverified script, run by a command the user asked to update something they already
  had. It now refuses and prints the one-line install from the README, which is the same
  download made by somebody who chose it and can read it first (`npm run test:installer`
  gains the case, 43 checks). Separately, `anagramd/bench.py` is out of the release tarball:
  it needs three packages from the `bench` extra that the installer never installs and
  looks for its checkpoints beside the repository, so in an installation it was a file that
  could not run; the copy in the repository now switches the Hugging Face client offline
  before importing it, as `serve.py` does, with `--online` to opt out — run on the LoRA
  spec with a missing local directory it would otherwise have downloaded a 6 GB base model
  mid-benchmark. The README now also says plainly what the release tarball's `.sha256` is
  worth: it comes from the same address as the tarball, so it catches corruption and not a
  compromised host — unlike `uv`'s and both models' checksums, which are pinned inside
  `install.sh`.

- **A release waits for the whole test matrix.** The release workflow used to run the type check and
  the Node tests and then publish; it now calls the CI workflow as its first job (`gate`) and
  publishes only after the same suites as every push have passed on Linux, Windows and macOS, and
  the Firefox build in a real Firefox. CI's `push` trigger is held to branches so that a tag does
  not run the matrix twice. (Day-to-day CI on pushes is switched off in the repository settings
  until the public release — switch it back on before the first tag.)
- **A score is written `.93`, never `63%`.** EditLens answers with an EXTENT of
  AI editing on a scale of 0 to 1 — an edit distance from a human original — and
  a per cent sign made every surface of the product read as "63 % sure this is
  AI", which is the one thing the number does not say. One formatter
  (`lib/render/score.ts`) now writes it the way a correlation is written: two
  decimals, no leading zero, no per cent sign, with `1.0` at the top of the
  scale, in the chip, the chip's card, the selection card, each window's own
  number, the panel rows, the PDF view's chips and the copied report. Anything
  SPOKEN — a panel row's accessible name — says the leading zero out loud,
  because a screen reader reads a bare ".93" badly. Numbers that really are
  probabilities (the four-bucket distribution, the language gate's confidence)
  keep their per cent sign and do not go through it. The `×N` suffix is
  unchanged: `.93 ×4`.
- **The marks are quiet, and nothing is wavy.** Every read unit used to carry its
  band's tint and underline all the time, with a WAVY line under the two flagged
  bands — the spell-checker's "this is wrong" — and a tint over the page's own
  words changes how the author's text looks, which is the one thing Anagram must
  never do. At rest the page is now left as it was: nothing under human or
  lightly-edited text (its chip has already said it was read), and a thin SOLID
  line under the two flagged bands only, 1 px for heavily edited and 2 px for
  AI-generated so the two differ by more than hue. Hover a chip, pin its card,
  or land on it from the panel or the next/previous-flagged keys, and that ONE
  paragraph shows its whole extent, tint and all, window by window in each
  window's own band, until you leave — the reader sees exactly what was read and
  where it changed band, without the page wearing it permanently. Nothing
  animates (a highlight pseudo-element takes no transition), the dark palette is
  unchanged, and the PDF view paints through the same module and follows the
  same rules.
- **`markStyle` is two honest choices.** "Underline + tint", "underline only" and
  "tint only" all meant "mark every paragraph, all the time"; the setting is now
  `quiet` (the default — the rules above) and `always` (every unit marked, as
  before minus the waves). A profile holding an old CHOICE ("underline only",
  "tint only") reads as `always`; one holding the old DEFAULT ("underline + tint")
  reads as the new default, `quiet` — otherwise the people who never asked for
  anything would be the only ones not to get it. Nothing is migrated, so an old
  profile still opens and this build writes nothing an older one cannot read. `showHighlights` is still the master switch, and
  `displayMode: "flagged"` still means what it meant.
- **The store description says what the extension does.** `package.json`, both
  locales and the README tagline claimed "per-paragraph AI-generated-text
  confidence badges" — a claim EditLens does not make. They now say: shows how
  heavily each paragraph appears to be AI-edited, scored on your own computer.

- **A private window leaves nothing on the disk.** Nothing looked at
  `sender.tab.incognito`, so a paragraph read in a private window was hashed
  into the same IndexedDB store as any other. It holds no text — a 53-bit hash
  and four probabilities — but a row is still a trace of something somebody read
  privately. The rule now: nothing that exists ONLY because of a private tab is
  ever written down. Such a tab may READ the cache (a hit writes nothing, not
  even a timestamp), and what its batches produce stays in the service worker's
  memory until an ordinary tab asks for the same text, which would have produced
  the identical verdict itself; a batch a private and an ordinary tab both wait
  for is written, because the ordinary one asked for it.
- **Cached verdicts are kept 30 days, and the options page says how many there
  are.** The store was bounded by entry count alone, so a verdict from a year ago
  was still there. The clock starts when a row is written and a revisit does not
  restart it — refreshing a row on a lookup would make reading write to the disk,
  which is exactly what a private tab may not do. The sweep runs on the first use
  of the cache in a worker's life and on the prune that already happens every 500
  writes. Beside "Clear cached verdicts" there is now a number (`1,284 entries`),
  re-read after clearing.
- **The daemon URL can only be what the policy can express.** The setting used to
  accept http and https, `localhost`, `::1` and any `127.x.y.z`; a content
  security policy can name neither an address range nor an IPv6 literal, so half
  of those would have been accepted here and then blocked at the fetch. It is now
  exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`, port optional
  and completed with the daemon's own, and credentials, a path, a query or a
  fragment are refused with it — `${url}/health` can do nothing with any of them.
  A setting an older build stored is served by the default rather than leaving
  somebody with an extension that scores nothing, and the options page marks the
  field invalid so correcting it stays theirs.
- **A failed batch is only sent again when a second attempt could answer
  differently** — a busy daemon (429, 502, 503, 504), a dead transport, our own
  25-second cut-off — after a jittered wait, honouring `Retry-After` up to five
  seconds. A 4xx, a response that failed validation and a contract mismatch are
  answered "Unavailable" at once: they would have come back identical, at twice
  the load on a daemon that is already saying no.
- **"Copy page diagnostics" now says only words we can point at.** It kept any
  alphabetic part of a class, an id or a test id, and an identifier is written by
  the page's author — `div.author-marla-quillgrove`. An atom survives only if it
  is in a vocabulary the build ships: the tokens our own detectors test for
  (derived from the chrome, main-content, reply-form and skip-destination
  patterns, so a token added there turns up in the report by itself), the
  framework markers the hydration gate looks for, and a list of structural
  English. Everything else becomes a placeholder of its own length, so that class
  reads `author-x5-x10` — the shape a fixture is rebuilt from survives and the
  name does not.
- Every bundle now carries only the English it can actually show, and the content
  script is **13 kB smaller** for it (197 → 184 kB raw, 67 → 63 kB gzipped); the
  background worker is **18 kB smaller** (74 → 55 kB raw), and the shared page
  chunk 1.7 kB. Nothing a user sees changes. The English messages travel in the
  code because `lib/` also runs where there is no extension API (the esbuild unit
  bundle, vitest) and where there is no longer one — a content script whose
  extension context has just been invalidated gets nothing from the platform —
  but the whole file went into all six bundles, so every web page paid for the
  options page's 71 strings and the onboarding page's 54, which a content script
  can never show. WXT builds the background, the content script and the extension
  pages separately, so each build is now answered with the messages the source
  files ITS entrypoint can reach actually name: 96 of 287 for the content script,
  four for the worker. The set comes from the source, never from the key's
  prefix, so a key held in a table (the verdict labels) or picked out of a `const`
  array is found as surely as a `t("…")` call; and two build assertions keep it
  honest — a key no message file has fails the build, and so does a source file
  the bundler pulled in that the scan did not read. In a real extension the
  platform still answers from the complete `_locales/`, so the trimmed fallback
  is only ever what stands in for it.
- The triage panel adapts to a dark page. The chips and the detail card have done
  so since v4; the panel had not, so the one piece of chrome a keyboard reader
  lives in was a white rectangle in the middle of a dark article. It uses the same
  theme probe and the same surface, ink and border values as the card — no new
  colour — and its focus ring turns light, since two pixels of near-black on a
  near-black panel is no ring at all.
- Every control that was drawn smaller than 24x24 CSS pixels now accepts a
  pointer over at least that much (WCAG 2.2 target size, minimum) without being
  redrawn: the ball's counter bubble, the selection card's close glyph, the
  switches in the popup and on the options page and the popup's segmented tabs
  keep their exact appearance and gain an invisible hit area. The panel's verdict
  filters, "Copy report" and "Turn off on <host>" took two or three pixels of
  padding instead. The open panel also sits 4 px further from the ball, because
  the counter bubble overhangs it and the panel used to lie across the top of the
  one control that opens it.
- A page that does not hold still costs a fraction of what it did. Every re-scan
  pays a price over the whole document — the byline survey that decides who wrote
  what runs once per walk — so a mutation burst is now bounded to at most ten
  walks, its roots merged upward one level at a time until it fits. On dev.to,
  which re-renders its Preact islands continuously, a 60-second session spent 33 s
  scanning in 4 528 walks and froze the main thread for up to 2.0 s at a time; it
  now spends 3.3 s in 64 walks with a worst task of 137 ms. Over a scripted
  90-second session the same page went from 22.9 s of scripting to 3.0 s, and
  YouTube from 14.3 s to 3.9 s — less than the page's own — while both pages let
  the reader scroll the full 58 screens the browser manages without us instead of
  44 and 49.

- A URL rewritten while you scroll no longer re-reads the page. Discourse rewrites
  the address with the number of the post in view on every scroll step, and each
  one was answered with a whole-document walk — 71 of them in a 60-second session
  on one topic, now 3. A rewrite of the current entry that leaves every live
  paragraph where it was and the main region unchanged is answered by the purge
  alone; a pushed entry or a traversal still gets the full refresh, and a burst of
  them gets one. Nothing is missed by this: real DOM swaps are the mutation
  observer's job, and the survey found no route change it failed to see.

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
- A paragraph is read to its end, however long. The cost cap of eight windows
  (some 2 300 words) is gone — a forward pass is about a tenth of a second on the
  hardware this runs on, and a 4 220-word answer Gemini wrote as one paragraph was
  being judged on its first half. The only bound left is 200 000 characters for a
  single unit (a log or a data dump in one node, not writing); past it the card
  says the end was not read, and that part stays unmarked.
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
- **The daemon no longer downloads anything, and cannot.** It used to fetch both
  models on first start: the checkpoint through `huggingface_hub`, under whatever
  Hugging Face token it found on the machine, and the fastText language model with
  a bare `urlretrieve` — no checksum, no staging, so an interrupted start left a
  truncated `.ftz` that the next start loaded as though it were real. Both are
  gone. Serving reads what is on disk, and a missing file is an error naming the
  command that fetches it (`anagram doctor` reports both files and their
  checksums). `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `HF_HUB_DISABLE_TELEMETRY`
  and `HF_HUB_DISABLE_IMPLICIT_TOKEN` are set at the top of `serve.py`, above every
  import, because the Hub client reads them once when it is imported and ignores a
  value set afterwards — so a file that goes missing under a running daemon is a
  loud local error rather than a quiet re-download.
- Downloading is two explicit commands, and both are staged. `install.sh` and
  `anagram model` fetch into a name beside the file they replace, check it against
  the checksum pinned in `install.sh`, and rename it into place only if it matches:
  an interrupted or tampered download is never something the daemon can load, and a
  re-run resumes instead of starting the 1.4 GB again. `anagram model` now verifies
  the checkpoint it downloaded (it did not before), skips a file that is already
  there and already correct, and re-fetches one whose checksum has drifted. A
  staging directory is kept only while it can still be resumed.
- The daemon answers to exactly the two names the extension can be pointed at.
  `127.0.0.1` and `localhost` are all a browser's content-security policy can
  express, but `--host` took any loopback address, so a daemon on `127.0.0.2` or
  `[::1]` bound happily and then refused every request with 400 from its own Host
  allow-list. `--host` now takes those two and refuses the rest with a message
  (`--allow-remote` is still the deliberate way out, and says what it costs), and
  one list feeds both the Host allow-list and the Origin guard's own origins, so
  they cannot drift apart.
- The version the extension keys its cache by now covers everything that can change
  a verdict, not only the weights, the tokenizer files, the window, the dtype and
  whether the gate is on. Added: the **sha256 of the fastText model itself** — it
  decides whether a paragraph is scored at all — the languages it lets through, the
  bucket labels and their schema, and a hash of the preprocessing source, so an
  edit to `clean_text` cannot go on sharing cache entries with the version before
  it because nobody remembered to bump `PIPELINE_REV` by hand.
- Responses carry `label_schema` beside `calibration` — the same string under the
  name that describes it (these are the bucket edges, not a fitted calibration of
  the probabilities). Additive: `calibration` is what contract 2.x clients read and
  it is unchanged, so an installed daemon and a new extension, or the reverse, go
  on working.

- **The extension can no longer reach the internet, and the browser is what
  stops it.** `wxt.config.ts` now declares a Content-Security-Policy for the
  extension's pages and its service worker whose `connect-src` is `'self'`, the
  two loopback spellings the daemon-URL setting accepts, and `file:` — so
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` can
  reach the local daemon and nothing else, whatever the code asks for and
  whatever host permission the extension holds. The rest of the policy is a
  tightening of Chrome's default: `default-src 'self'`, `object-src 'self'`,
  `img-src 'self' data: blob:`, `font-src 'self' data:`, `worker-src 'self'`,
  `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`. `style-src`
  keeps `'unsafe-inline'`, which the four extension pages need for their own
  `<style>` block and which Chrome's default allows anyway. Firefox takes the
  same policy as an MV2 string and enforces it identically.
- **`script-src` carries `'wasm-unsafe-eval'`, and it turns out to have been
  load-bearing all along.** pdf.js ships its JPEG 2000 and JBIG2 decoders as
  WebAssembly and `scripts/vendor.mjs` deliberately leaves out the library's
  no-WebAssembly fallbacks, so with no policy declared — which is how this
  extension shipped until now — Chrome refused to compile either decoder and a
  PDF page made of a JPEG 2000 or JBIG2 image drew **completely blank, with
  nothing logged anywhere**. Measured, not reasoned about: `test/pdf-codecs-check.mjs`
  opens one document of each kind in the packaged extension and reads the
  canvas back.
- **`web_accessible_resources` is three files instead of three megabytes.** It
  declared `vendor/*` for `<all_urls>`, which since the PDF view landed had been
  offering every website on the internet pdf.js, its worker, the CMaps, the
  standard fourteen fonts and the WebAssembly decoders — none of which a web page
  has any use for, all of which let a page detect that this extension is
  installed. Only the three chunks a content script really `import()`s are
  declared now (Readability, DOMPurify, the diagnostics chunk), and with
  `use_dynamic_url`, so Chrome serves even those at a per-session address given
  only to our own content script. The reader is an extension page and needs
  nothing web accessible at all.
- **Anagram makes no remote request, at all.** It made exactly one: the service
  worker asked arxiv.org whether a paper had an HTML rendering, so that an arXiv
  PDF could open as the paper rather than as its PDF. The probe, its cache and
  the automatic re-routing are gone, and "Open in Anagram" on any PDF now opens
  **that** PDF — which is also the document you were looking at. `htmlTwinOf()`
  stays in `lib/pdf/source.ts`: it says which address an arXiv paper's HTML
  would have, for a link somebody may follow themselves.

- **The PDF reading mode no longer fetches anything.** It used to fetch its own
  `?src=` from the extension's origin with the reader's cookies — a page of ours
  asking the open web for a document, which is precisely the request this
  extension must not be able to make. The bytes now come from the tab you are
  looking at: the PDF tab re-reads its own document (same address, same cookies,
  normally answered out of the browser's cache without touching the network),
  streams it to the extension's worker a chunk at a time, and the worker holds it
  under a one-time ticket and turns that same tab into the reading mode. The
  address keeps `?src=` only as a NAME — the title, "Open original", the HTML
  link — and nothing of ours ever fetches it.

  Three things follow, and two of them are losses worth stating plainly.
  A **local PDF** (`file://`) can no longer be opened from its tab: a page on the
  file scheme is not permitted to re-read itself (both `fetch` and
  `XMLHttpRequest` are refused, whatever the extension is allowed), so a local
  PDF is now left in the browser's own viewer and the drop zone or the file
  picker is the way into the reading mode. On **Firefox**, whose PDF viewer is a
  privileged page no extension code runs in, there is no tab to read from at all:
  the "Read this PDF" button and the "Open PDF with Anagram" menu entry are no
  longer offered there, and the reading mode takes dropped and picked files only.
  And a **reader address with no bytes behind it** — pasted, reloaded, or opened
  after the worker was evicted — hands the tab back to the document rather than
  fetching it, once, so it can never ping-pong; with "Open PDFs in Anagram" on,
  the ordinary route brings it straight back with real bytes.

  Measured on this machine (Chromium 141): a 45 MB document takes 735 ms to read
  out of the tab and relay to the worker and 110 ms to reach the reading mode,
  peaking at 126 MB in the reader page and settling back to 4 MB. Chunk size
  makes no difference between 64 KiB and 1 MiB, because the cost is the base64
  the browser's JSON messaging forces, so it is 256 KiB. The cap on this path is
  50 MB, against 100 MB for a file you hand the reader yourself.

- **Loading a PDF is bounded, owned and cancellable.** Three defects an audit
  found, all of them the same shape: the 100 MB cap was checked only after the
  whole file had been bought (a file's size is now read before its bytes, and a
  document arriving over the wire is cut off AT the cap rather than after it);
  a slow older load could finish after a newer one and take the view, the title
  or an error line from it (every way in now takes a load id and an abort at its
  first line, ownership is re-checked after every await, and a superseded load
  destroys its pdf.js loading task and worker instead of finishing into the
  void); and nothing could be cancelled at all.

### Fixed

- **The popup's "All websites" switch said ON on an extension that could read nothing.**
  It was painted from the setting alone, and a fresh install has the setting on and
  access to no site. It is now painted from both, like "This site": on means the
  setting is on AND every site is granted, and turning it on where they are not is what
  asks the browser for them — inside the click, as the browser requires. The popup's
  subtitle no longer calls Anagram an "AI text detector", which is the claim the new
  description stopped making.
- **The English first-run and options pages had stopped matching the product.** An
  English UI leaves a page's markup untouched, so what `entrypoints/*/index.html`
  says is what an English reader sees — and nothing held it to the messages. After
  the score became `.93` and the marks went quiet, both pages still said "0% …
  100%" and "a matching underline, quiet on human text", and the first-run page
  still described the PDF view as a rebuilt page. `test/node/pageCopy.test.ts` now
  reads every page the way the localiser does and fails when the two disagree. The
  first-run page's **Ready** row also waits for site access as well as for the
  daemon: on a fresh install "open any article" was not yet true.
- Gemini conversations were silent. Gemini wraps every conversation in
  `<div id="xap-skip-link-target" class="main-content">`; the page-chrome filter
  read that id — the place a "Skip to content" link LANDS — as the skip link
  itself and discarded everything inside it. A name that says where a skip link
  lands is no longer a skip link, and an element that calls itself the page's main
  content (as a whole class name or its id) is, like `<main>`, never chrome on the
  strength of a name.

- A page of clamped review cards lays itself out half as often. Keeping one chip
  under each collapsed post means measuring the box and the last line of each of
  its paragraphs, and every box was doing that on its own — once per chip as it
  landed, and again on every tick of its observers — so the browser laid the page
  out again between every pair of measurements: on sixty cards holding 180 chips,
  443 layouts more than the same page without the extension. A wake now only
  marks a box dirty; one frame later every dirty box is read, and only then is
  anything moved. The same page costs 230. What ends up where is unchanged, and
  `npm run test:perf` now holds it there.
- Accessibility, throughout, with the suite below now guarding each one. A pinned
  chip card put a focusable "Copy text" button inside the deliberately
  aria-hidden chip host, so a keyboard user landed on a control that announces
  nothing — one per pinned card. The selection card's close button announced as
  the glyph "✕", because a button's own text wins the name computation and its
  title was never used. Five pieces of text a reader is meant to read — the
  panel's "Turn off on <host>" and its empty state, the chip card's and the
  selection card's footnotes saying the number is an estimate rather than proof —
  were #8a8a8a on white, 3.45:1 against the 4.5:1 body text needs. Inline `code`
  and the keyboard hints were 4.34:1 on all three extension pages, which is the
  text somebody reads while fixing a broken install; the options page wrote
  "Always on" in a green picked for a white card, 3.97:1 on the dark one. Neither
  the options page nor the first-run page had a `<main>`, so nothing on either sat
  in a landmark. The per-site rules table's action column had an empty header. The
  PDF reading mode had no level-one heading. And every hover card still faded in
  under `prefers-reduced-motion`, because the rule that turned the transition off
  was outranked by the one that set it, along with the ball's own colour fade and
  its sliding label.

- Only ONE chip is left under a post the site clips to a few lines. Every
  paragraph of such a post ends out of sight, so every one of their chips was
  inserted after the box: a 30-page session survey found 91 chips of different
  paragraphs piled at 16 anchors on one Goodreads book page — twelve in a row at
  the worst of them, reading 12%/85%/57%/23%/78%/55% with nothing to say which
  paragraph was which — 52 on a Steam review page and 4 on an Amazon product
  page. The box now has exactly one slot, held by the first paragraph in reading
  order whose own last line is out of sight, and every later paragraph keeps its
  chip at its own last word: out of sight while the post is collapsed, and
  exactly where it belongs the moment the post is opened. Opening the post brings
  the parked chip home too, and closing it parks the first hidden one again.
- A chip that goes out of sight is rescued however late it happens. A post is
  watched for as long as its chips are in it, instead of once: the watcher used
  to stop watching a chip before it re-checked it, so a single moment in which
  the box was not clipping — and a Goodreads review box is not clipping at all
  until its cover images and its web font arrive — left that chip behind the
  fold for good (25 chips on one Steam page, 6 on Goodreads, 3 on a live blog).
  A box that caps its own height is now watched from the start, whether or not
  it is hiding anything yet.
- A chip is placed by what the reader can see, not by whether the box around it
  looks like a "see more" post. Placement borrowed the rule that decides whether
  a clamped post is worth scoring at all, which insists on twice as much text as
  box; a Steam review card 663 px tall holding 771 px of review is nothing like
  that, and the 108 px it cut off still held whole paragraphs and the chips that
  closed them — 25 chips out of sight on one page. The placement layer now asks
  only whether a box keeps text of its own below its bottom edge, and each chip's
  own last line decides whether that chip is one of the hidden ones. Scoring is
  unchanged, and so is everything a reader can see: a page-tall box, a scroll
  container and a box that trims a line still move nothing.
- Anagram no longer puts a React hydration error in a page's console. On a page
  rendered by a server and hydrated in the browser, the first chips landed in the
  server's markup before React had checked it, and React logged its recoverable
  #418 and rendered that part of the page again — jestjs.io in three runs of
  three, nextjs.org in two, and never on the same page without us. Nothing
  visible broke, and nothing about the analysis changes: scoring starts as early
  as it ever did. Only the INSERTION waits, and only on a page carrying one of the
  markers those frameworks leave behind (`#__next`, `#__docusaurus`, `#___gatsby`,
  `#__nuxt`, `[data-reactroot]`, `astro-island` and a few more), where it waits
  for the page to finish loading plus one idle moment, and at most 2.5 seconds in
  any case. Every other page — every article, every wiki, every forum — is chipped
  exactly as early as before.
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
- The Firefox suite opens the **PDF reading mode**. It is the one page where pdf.js,
  a module worker and the whole scoring pipeline run on a `moz-extension:`
  document, and nothing had ever opened it in Gecko: it reads the same PDF the
  Chromium scenarios open (now a shared fixture), and it holds — paragraphs in
  reading order, chips from the ordinary pipeline, a dropped file read, the worker
  loaded from the extension's own origin, no page errors.
- `npm run bump -- --check` also checks the **contract major**. The extension's
  `CONTRACT_VERSION`, the daemon's copy of it and the `CONTRACT_MAJOR` the shipped
  CLI compares a daemon against are three declarations of one thing, and nothing
  held them together: a CLI left behind on an older major would have called a
  healthy daemon broken. The check is read-only and names every file when they
  disagree.
- The installer replaces the running command instead of overwriting it. `anagram
  update` runs the installer, and the installer copied the new `bin/anagram` onto
  the script that was executing — a truncate-and-rewrite under the shell still
  reading it. Every file it puts in place is now written beside its name inside
  the folder and renamed over the old one, which is atomic and leaves whoever has
  the old file open reading it: the command, the `uv` binary, `VERSION` and the
  language model.
- Comments on 博客园 (cnblogs) are read. The site wraps its comment LIST in boxes
  whose class and id carry `comment_form`, the token that marks WordPress' reply
  form, and every comment on the page went out with it. A box carrying that token
  is the reply form only when it holds something to type in and is not a list of
  comments.
- A `<form>` with fields to fill in is chrome. A paragraph of consent text among
  the fields of a job application got a chip of its own on a Greenhouse board.
  The page's own shell is not one — ASP.NET wraps whole sites in a single
  `<form>` — and prose beside a search box is untouched.
- A mailing-list quotation is scored without its **quote markers**. Prose in a
  `<pre>` is read now, and the `>` at the head of every quoted line went to the
  model with it — the frame a mail client draws the quotation with, which nobody
  wrote. The markers are stripped from the text of a quoted run, and from nowhere
  else: a `>` at the start of ordinary prose is a shell prompt or a quotation
  somebody typed. The underline still covers the quoted lines exactly, and the
  chip stays where it is when the page moves around it: the text a unit carries
  has ONE definition now, which the walker writes, the orchestrator recomputes to
  tell whether a unit changed, and the locator maps offsets in — and the boundary
  between a quotation and the reply around it is drawn on a re-scan too, not only
  on the first one.
- The canonical scoring text is a **fixed point**: canonicalizing it again changes
  nothing. An un-rendered LaTeX span was dropped after the quote digraphs were
  folded, so a span removed from between two quotes ("the constant '$\alpha$' is")
  left an `''` that only a second pass folded — one paragraph, two cache keys, and
  a different text sent depending on which of the two the caller had. Everything
  that welds two characters together now runs before the folds, and the quote fold
  settles on its own.
- Text inside an out-of-flow **shadow host** is read. The rule that drops a small
  absolutely or fixed positioned box as a decoration ("[Pg 12]", a corner badge)
  measured `textContent`, which a host reports as empty however much its shadow
  tree holds — so a fixed host with a whole document inside was skipped whole. It
  measures the composed text now, shadow trees and slots included, and a short
  label in a shadow tree is still a decoration.

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
- `anagram status`, `version` and `doctor` reported the daemon down on any machine
  with `http_proxy` set. curl has no built-in exception for loopback, so a request
  for `http://127.0.0.1:8765/health` went to the proxy — which cannot reach a port
  on this laptop — and, on the way, told that proxy which ports somebody is asking
  about. The probes this script makes about its own daemon now say `--noproxy
  127.0.0.1,localhost`; the two real downloads still go through a proxy, because
  they have to.

### Tests

- **The release gate runs every check there is.** `.github/workflows/ci.yml` is what
  `release.yml` calls before it publishes an asset, and four checks that each answer one
  question a suite would bury were not in it: `test/diagnostics-check.mjs`,
  `test/pdf-route-check.mjs`, `test/csp-check.mjs` and `test/pdf-codecs-check.mjs`. All
  four now run on every platform leg, together with `npm run test:daemon` — what anagramd
  promises about itself without the model, which degrades to the checks a bare interpreter
  can make. Two of them are gated and the comment beside each says why: the PDF-route check
  skips Windows (one case spells a local file's address `file://` + a temporary path, which
  is not how Windows spells one), and the policy check runs `--chrome-only` everywhere and
  in full in the Firefox job, which is the only machine with a Firefox on it.

- **The two real-daemon suites no longer borrow a daemon they did not start.**
  `test/server.mjs` and `test/verify-backend.mjs` took whatever was answering on 8765,
  which is where an installed Anagram listens: a run meant to exercise the build sent its
  test paragraphs through somebody's own daemon, and `test:verify` — which stops the
  daemon to prove the extension shows nothing without one — came within a step of
  stopping it. Both now start a daemon of their OWN on a port the system picked and stop
  only that one. Borrowing a running daemon is asked for (`ANAGRAMD_REUSE=1`, with
  `ANAGRAMD_PORT` to name it); a busy `ANAGRAMD_PORT` without that flag, and a reuse with
  nothing answering, are refusals that say what to run instead. The decision is a pure
  function in `test/daemon-port.mjs` with its own vitest table
  (`test/node/daemonPort.test.ts`, 12 cases), because the suites themselves cannot be run
  without the 1.4 GB model and a rule about somebody else's daemon is worth nothing if it
  is only ever checked by hand.

- The score's shape and the quiet marks, in `test/unit.mjs`: `formatScore` /
  `spokenScore` at both ends of the scale, which `::highlight()` rules exist at
  rest in each mark style, that nothing anywhere is wavy, and that an active
  unit's ranges move into the active highlight set and back — including that
  clearing a unit while it is active leaves nothing behind in either set. Every
  suite that expected `<n>%` on a chip, in a card, in a panel row's accessible
  name or in the copied report now expects the 0-1 number instead.

- The PDF handoff, at three levels. `test/node/pdf-handoff.test.ts` (16 cases)
  pins the bytes-as-JSON encoding both hops use, what counts as a PDF (the header
  anywhere in the first kilobyte, and a sign-in page that says it is one refused),
  the read out of a tab over an injected `fetch` — every byte in order, a stated
  length over the cap refused before the body is touched, a body that never ends
  cut off at the cap with the rest never read — and the worker's ticket store
  (bound to the tab it was read for, spendable once, dropped on a timer, released
  with the tab). `test/pdf-route-check.mjs` is 27 checks in a real
  browser: the document that arrives through the tab hashes the same as the one
  dropped straight on the reader, the oversized one is proved to have stopped by
  what the SERVER was asked for, a pasted reader address goes back to the PDF and
  stays, the password is asked for and refused and accepted, and — watched at the
  browser level — the reading mode requests no subresource outside the extension
  while a remote PDF is opened. And in `test/scenarios.mjs`, two documents given
  to the reader one after the other in both completion orders.

- The reflow and the last hop of the handoff carry user-timing marks and a perf
  budget. Measured on a 300-page book, which is the reader's own page cap: the
  reflow runs 13 times over everything read so far, 647 ms in total, 83 ms for
  the worst single run, and the worst main-thread task anywhere in the read is
  82-126 ms. Nothing was changed as a result.

- Twelve cases over the per-surface English fallback, in `test/node/i18n.test.ts`:
  the scan that decides a bundle's keys (WXT's two build shapes; our imports
  followed to the files that name messages and not to the English file itself; a
  key held only in a table; a plural expanded from the base `tn()` is given; a
  misspelt key reported; a module the bundler reached that the scan did not), and
  the last build on disk (each of the three bundles carrying every key its own
  sources can name, no `opt*`/`onb*`/`popup*`/`reader*` string in the content
  script, and the worker down to its three menu titles) — those skip rather than
  fail where nothing has been built. Plus `t()` answering a content script whose
  extension context was invalidated out of its own trimmed fallback, and
  returning the key name rather than throwing if it ever has neither.
- **The two live-site surveys run every Monday** and fail when a site got
  worse: `.github/workflows/surveys.yml` runs all ~124 coverage pages and the
  dozen dynamics pages marked `"weekly": true` — one of every shape that list
  knows, chosen so the whole thing fits in an hour instead of the three the full
  list needs — keeps both reports and every screenshot as build artifacts for 90
  days, downloads the last green run's report as the baseline, and runs
  `test/survey-gate.mjs` over the pair. Its Markdown goes to the run summary and
  a regression fails the job; the red X on the Actions tab is the whole
  notification, because nothing here is worth an issue nobody closes. Manual
  runs pick a tool, a site filter, and the weekly dozen or the whole list. The
  gate's thresholds are measurements, not guesses: each one carries the
  run-to-run spread of the same build over the same pages that set it, and every
  one of them is a comparison, since the question is "did this get worse", not
  "is this perfect". Three things are never a failure — a site that was
  unreachable, bot-walled or login-walled in either run (the runners sit in US
  data centres, where the Chinese half of the list is walled far more often than
  it is here), a page that served a different body of text, and a defect that was
  already in the baseline — and the count of each is printed, so a list quietly
  rotting away is visible even in a week when nothing failed.
- The two live-site surveys stopped printing numbers that were not true, and
  stopped writing into the repository. Their reports defaulted to `test/`, which
  the header had always said they must never do: a run left
  `coverage-<label>.json/.md` and two esbuild bundles in the tree. Both tools now
  default to `$ANAGRAM_ARTIFACTS`, or to `<tmpdir>/anagram-surveys/<label>` when
  that is unset, and print the folder. **Silent containers are named after their
  BODY.** "link-dense" fired whenever half a container's blocks were link-dense —
  but half a social card's blocks ARE the byline, the action row and the link
  preview, while the post itself is silent for a different reason. Each block is
  now classified on its own and the container takes the reason of its largest
  block of prose, with the link-dense siblings named after it: Telegram's
  messages report bodies of 28–52 words against the 50-word floor, Bluesky's
  43–48, instead of "link-dense: 5/8 blocks". **"Piled" is a question about
  placement, so it is asked of the DOM**: two or more chip hosts standing
  together as siblings with nothing but whitespace between them and reading
  different numbers. It used to mean "same parent, same preceding 100 characters,
  different numbers", which called two teaser cards printing the same copy a
  pile-up (theverge.com, on a page with no clipping box at all) and counted any
  two chips that were still "analyzing…" as one, since a pending chip carries no
  number — and these are maxima over a session, so that number could only go up.
  **Coverage is a share of the same words on both sides of the division.** Units
  found inside page chrome counted in the numerator while the denominator zeroed
  those subtrees, which had `ai-perplexity` — a page that answers a logged-out
  reader with a dialog — reporting 57 judged words over 6 of prose: 950 %
  coverage. Judged words are now split into prose and chrome and only the first
  is divided. **`hn-front-thread` opens a thread.** It opened the Hacker News
  front page, which has no paragraph over 50 words and produced no chips of its
  own: every chip in that row came from the page the navigation step visited. It
  now opens an archived 2016 thread (967 comments, 454 of them over 50 words) and
  the navigation step walks thread → front page → back.
- An automated accessibility suite: `npm run test:a11y`. It runs **axe-core**
  (WCAG 2.1 A + AA, with axe's best-practice rules reported on a line of their
  own) over the popup, options, onboarding and PDF reader pages in light and
  dark — the options page with two site rules and the add-rule error showing,
  onboarding with the daemon running and stopped, the reader empty and with a
  PDF the suite writes itself — and then over our own injected UI, scoped to our
  nodes so the host page's problems are not counted as ours: the ball with the
  panel closed, open with flagged rows, open with both verdict filters, a
  pinned chip card, the selection card and the daemon-down notice. axe reaches
  into the open shadow roots, and the suite proves it did by naming a node it
  could only have found through one. Extension pages reject an injected inline
  script under the MV3 page CSP, so the library's source is evaluated through
  the debugger instead of added as a `<script>`. On top of that, the checks axe
  cannot make, asserted in code: Tab reaches the ball and then the counter,
  Enter opens the panel as a named dialog and moves focus into it, Tab walks its
  controls in DOM order with no positive tabindex, Escape closes it and gives
  focus back; every control has an accessible name that is a word rather than a
  glyph, a visible focus indicator and a 24x24 CSS-pixel hit target; colour
  contrast is computed from the resolved colours for the chip number, the card
  verdict, the panel percentages and the counter, in light and dark, because axe
  cannot always see through a top-layer popover inside a shadow root; nothing of
  ours animates under `prefers-reduced-motion`; and chips keep a visible
  boundary under forced colours. Because the suite would otherwise be born red,
  it carries an explicit baseline of the debt that existed the day it was
  written — 29 axe rules and 19 code-level findings, each with the node and one
  line on what it costs — and fails only on what is not in it, printing the
  known count every run. Deliberate exemptions (the per-paragraph chips are
  `aria-hidden` and unfocusable on purpose) are listed separately from the
  debts. A JSON report lands in the artifacts folder, and the suite runs on
  every OS leg in CI. Both baselines are now EMPTY: everything it found on the
  day it was written has been fixed, so anything it reports from here is a
  regression — and an entry that stops firing fails the run, which is how the
  last of them were found and deleted rather than left to fossilise.
- `test/dynamics.mjs` reads two of its own columns against what the extension
  means to do. A chip out of sight inside a collapsed post is now only a defect
  when NOTHING is parked under that post — a later paragraph of a clamped review
  is hidden by design, since one chip stands under the box for all of them — and
  those are counted and named apart. And a chip measuring 0×0 is read for what it
  is: every one of the 26 the survey found on theverge.com and the 9 on
  kotlinlang.org turned out to sit in a subtree the PAGE hides — a code tab that
  is not the selected one, a view the site had just swapped out — with the text
  they judge hidden alongside them, and a chip in a part of the page the browser
  has not rendered yet (`content-visibility: auto` below the fold) measures the
  same. Both are counted apart from a chip that really has no box, and
  `checkVisibility` separates them without scrolling the page, which would have
  spoiled the flicker comparison run in the same sample. The clipped
  review the survey found the pile-up on is now a fixture
  (`test/fixtures/clipped-reviews.html`), driven by the unit suite through the
  badge layer and by the scenarios suite through the whole extension: one chip
  under a collapsed review and five at their own paragraphs, all six back in
  place when it is opened, parked again when it is closed, and one more page on
  which a box only starts clipping once its image arrives.
- The incremental scanner has an equivalence net under it. One generator builds
  the same page two ways — step by step under a watching extension (posts
  appended in batches, a paragraph inserted into a live post, text edited in
  place, a block wrapped and unwrapped) and all at once before the content script
  ever runs — and the scenario asserts the chips end up identical: same places,
  same numbers, and since the fake daemon's verdict is a pure function of the
  text, a different number means a different text or a different grouping. A
  second check holds the scan-root bound: one burst, however many nodes it
  touched, becomes at most ten walks.
- `test/perf.mjs` budgets a page that does not hold still: 150 posts re-rendering
  themselves eight times over, 450 dirty nodes a burst. Unbounded that costs
  4.5 s of long tasks with single bursts over 600 ms; the budget is 3 s total and
  500 ms for the worst task.
- Two scenario checks hold the insertion gate: a fixture with a hydration marker
  and a slow image gets no chip into its tree before the page has loaded (and
  still gets its chips), while the same fixture without the marker is chipped
  long before `load`, as it always was.
- `test/perf.mjs` also budgets a VIRTUALIZED feed — 50 posts in, the oldest 50
  out, forty times over, 2 000 posts through a DOM that never holds more than 50 —
  and reads the heap through CDP after a forced collection. What survives must be
  what the DOM holds: the growth is 0.8 MB, there is one chip per post on screen
  and none for a post that has gone, and no highlight range points at a node that
  left the page.
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
- `npm run test:daemon` — 49 checks on what the daemon promises about itself, none
  of which need the 1.4 GB checkpoint or a port: that importing `serve.py` sets the
  Hub's offline flags (overruling an inherited `HF_HUB_OFFLINE=0`) and that neither
  `transformers` nor `huggingface_hub` is imported before they are set; that no name
  that fetches anything survives in its code (tokenized, so the comments explaining
  the removal are not mistaken for it); that a missing model file exits with the
  command that fetches it while a guard fails the test on any socket at all; that
  the served version moves when the language model, the gate, the window, the
  dtype, the tokenizer, the weights or the preprocessing does, one at a time; the
  `Host`, `Origin` and `--host` names against each other through FastAPI's
  TestClient over a stub engine; and both `calibration` and `label_schema` on
  `/health` and `/score`. It runs under `anagramd/.venv` when there is one and skips
  loudly on an interpreter without fastapi.
- A proxy in the environment does not hide the daemon: a dead `http_proxy` with a
  live daemon on 127.0.0.1, and `anagram status` still finds it.
- Five more installer cases (36 → 41), all offline: `anagram model` downloads
  nothing when both files already match their pinned checksums; a checkpoint that
  verifies is renamed into place and the staging directory it came down into is
  gone; a staging directory that can no longer be resumed is cleaned up; one that
  does not verify leaves the folder alone and stays aside so the next attempt
  resumes; and the same for `install.sh`, which stops there rather than going on
  to fetch the language model.

- `test/csp-check.mjs` — the policy, in both browsers. Every surface is opened
  for real (popup, options, onboarding, the reader empty and with a PDF in it,
  and an ordinary page with its chips and its panel) while
  `securitypolicyviolation` and the console are listened to, and any violation
  fails; then a page and the service worker are made to reach for a remote host
  over `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`,
  and every one has to be refused while the daemon still answers. 15 checks on
  Chrome, 9 more on Firefox — which measures slightly different things, because
  WebDriver BiDi cannot put a listener into a `moz-extension:` document before
  it loads: there it is what each page rendered, plus an inline `<script>` that
  must not run and a remote host and WebSocket that must be refused while the
  daemon answers. The Firefox half reports SKIP where there is no Firefox to
  drive. Not in CI yet.
- `test/pdf-codecs-check.mjs` — a JPEG 2000 document and a JBIG2 document opened
  in the packaged extension, with the canvas read back to prove the image drew.
  The two codestreams are carried as base64 rather than as binary fixtures, and
  were generated on this machine with Pillow/OpenJPEG and jbig2enc. 5 checks;
  not in CI yet.
- `test/node/footprint.test.ts` — 16 checks that hold `docs/footprint.md` and the
  sources to each other, plus the shipping manifest's exact policy, its
  `connect-src` list and its `web_accessible_resources` (those skip when the
  build on disk is older than `wxt.config.ts`).

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
