# Changelog

Notable changes to Anagram, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). The extension, the
local component and the installer all carry the same version.

## [Unreleased]

### Added

- Google Drive's file preview is read in place. A PDF or Word file opened in Drive, embedded
  from Drive in another page, or shown by Google's document viewer is drawn as page images
  with an invisible line of text over each printed line; Anagram used to read those lines as
  paragraphs of their own, dropped the short ones and left hyphenated words in two pieces.
  It now rebuilds the document's paragraphs from the lines' positions with the PDF reader's
  own reconstruction — lines joined, hyphens mended, headings and page numbers left out, a
  paragraph that runs onto the next page read as one — reads each page as Drive loads it,
  and draws the underlines and chips over the printed words. Nothing is fetched: the text is
  the viewer's own. The approach follows Read Aloud's Drive adapters (MIT).
- A PDF shown by pdf.js inside a web page is read in place the same way: OneDrive's and
  SharePoint's preview of a PDF, and any page that carries pdf.js's own viewer. Its text
  layer is one transparent span per run of the PDF's text, which Anagram used to read as a
  heap of short paragraphs running down both columns at once; the paragraphs are now
  rebuilt in reading order across columns and pages, and chips are kept off the print.
- Webnovel chapters are read. Every paragraph there is a box of its own, which Anagram
  treats as it treats two strangers' comments, so short paragraphs were never read together
  and most of a chapter went unread; each chapter's paragraphs are now grouped as they are
  on any page, never across a chapter heading, and the reader-comment counters are left out.
- Books in Google Play Books, Libby and VitalSource Bookshelf can be read with the site
  granted on its own. Each shows the book in a frame from a second address, and a site
  grant never reached it; turning Anagram on for the reader now asks for that address in
  the same prompt, and a reader whose site was granted before shows as off until it is.
- The setup page mentions that most arXiv papers also have an HTML version, which Anagram
  reads most precisely. Nothing redirects there; PDFs are read as before.

### Changed

- "Main content only" now finds the article with Defuddle (MIT) instead of Mozilla
  Readability. On 3,437 saved pages from four public web-extraction benchmarks it reads
  about one point more of the main content with the same leakage, and it keeps the replies
  of a forum or discussion thread in the region: on those pages 6 to 7 points more of the
  thread is read. Defuddle works on a copy of the page and only its offline extraction is
  used; nothing it could fetch is ever called. The extension grows by about 290 kB.
- The PDF reader's paragraphs now come from Zotero's document-worker (AGPL-3.0), the
  engine behind Zotero 10's reading mode, run inside the extension in a Web Worker with
  its block-segmentation model, and translated onto the pages pdf.js draws. On a corpus of
  198 papers with ground truth it scores 90% of the body text (85% before) with a tenth of
  the leakage: reference lists, captions, footnotes, table and figure text and running
  heads stay out, columns are read in the right order, and a paragraph cut in two by an
  equation, a column or a page is one paragraph again. Inline formulas — glyphs set in a
  mathematics font — are left out of the text that is scored, as they are on arXiv's HTML.
  The reader's own reflow still reads the pages while the worker works (well under a
  second for a paper, a few seconds for a 300-page book), and on its own if the worker
  fails or the document is over the 300-page cap. The extension grows by about 24 MB: the
  worker, its models and the ONNX runtime, all shipped inside it and never downloaded.

### Changed

- Anagram's code is now licensed under the GNU AGPL v3.0 or later. The licence text ships
  in the extension and in the local component. The model keeps its CC BY-NC-SA 4.0 licence.

### Fixed

- In Kindle for the web, a chip is now put after the paragraph's last printed word. It
  used to go after the first line of the paragraph's accessibility text, which is the whole
  column wide, so a right-hand column's chips were cut off at the edge of the page.
- Cookie banners are no longer analyzed as page text when their consent platform names
  them after itself: Cookiebot, Didomi, Quantcast, Usercentrics, iubenda, Complianz,
  Osano, consentmanager, the cookieconsent library and some twenty more. Their containers
  are taken from DuckDuckGo's autoconsent rules (MPL-2.0).
- A blog post is no longer skipped whole because of what it is filed under. WordPress
  writes a post's categories and tags on the box that holds it (`category-newsletter`,
  `tag-cookies`, `category-sponsored`), and those names read as a newsletter box, a cookie
  banner or an advert. They are ignored now, and a box that holds more than 40% of the
  page's text is never taken for page chrome, whatever it is called (a guard adapted from
  Unclutter, AGPL-3.0).
- On Wikipedia and other MediaWiki sites, the Notes, References, bibliography and Further
  reading lists are no longer analyzed, and a hatnote ("Not to be confused with …") is no
  longer read as the first line of the section under it. On Alan Turing's article such
  lists made up 30 of the 95 stretches analyzed.
- A page the browser has translated is no longer analyzed: its text is the translator's,
  not anybody's writing. While Chrome's translation is on, chips, underlines and the ball
  go away and the popup says why; the page is read again once the original is shown. A
  paragraph Read Frog translates in place is skipped the same way; the copies that Read
  Frog, KISS Translator and FluentRead add beside the original were already skipped.
- A fast scroll no longer keeps the reader waiting for what they scrolled past. A paragraph
  that was on screen for a moment goes back behind the one the reader stopped at, and one
  that leaves the screen for the margin just around it waits behind what is on screen;
  whatever was already sent to the engine is finished, not recalled. With an engine taking
  0.7 s a batch, the paragraphs at the end of a page of ninety flicked through in one go
  were sent after 0.35 s instead of 4.5 s.
- A tab in the background asks the engine for nothing, neither the paragraphs that were
  on screen there nor the rest of the page, and carries on where it was when it is shown
  again. The PDF reader's tab behaves the same.
- Text a web component renders into a shadow root after the page was read is found. A
  small script in the page's own context tells the content script whenever the page
  attaches a shadow root, so an element the page defines late (its upgrade attaches the
  root and renders into it) is read; it reads nothing itself. Shadow roots in a part of
  the page added later, and ones that were empty when the page was first read, such as a
  fixed panel filled when it opens, are watched as well.
- Text in a closed shadow root is read too. A closed root keeps the page's other scripts
  out, not the extension, which reads it through the browser's extension API: on any
  custom element, and on any other element the page is seen attaching one to. A closed
  root written into the markup of a built-in element such as a `<div>` is still missed.
- In Chrome, frames with no address of their own are read on a site Anagram is on: a
  srcdoc frame (an EPUB reader shows each chapter in one), an about:blank frame a page
  writes into, a blob: document. Each takes its origin from the page that made it, and the
  worker answers it for that origin. A sandboxed frame has no origin a grant could cover
  and is left alone. As in any frame, the chips are in the frame; the ball, the list and
  the counts are the page's own. Firefox tells an extension no such origin, so these
  frames are still not read there.
- The PDF reader no longer reads a two-column page line by line across both columns when
  one column is plain prose and the other is full of formulas (arXiv 2004.04906, page 2).
  A column's share of the page is now measured in characters, not in the text runs a PDF
  happens to cut it into.
- Subscripts and superscripts in a column stay on the line they belong to. Each column's
  lines are grouped on their own, so a column printed a few points lower than its
  neighbour no longer splits a formula's subscripts off into a line of their own, which
  broke the paragraph around it into pieces too short to score.
- A sidenote or margin note floated beside a paragraph (tufte-css pages and others like
  them) is no longer read into the middle of the sentence it annotates. It is read as a
  paragraph of its own after that paragraph, and a short note is scored with it. Only a
  floated initial of one word is still read as a drop cap.
- A reply and the messages it quotes are scored apart in webmail and mail archives when
  the quoted history is not a quotation block: Outlook's From / Sent / To / Subject block
  and its reply markers, Gmail's and Yahoo's quote boxes and Zimbra's divider now start a
  voice of their own that runs to the end of the message. The header block and the
  "On …, … wrote:" line above a quotation are no longer scored as anybody's text.
- The edge between two passes of a long text no longer moves to a "sentence start" right
  after an abbreviation such as "Mr.", "Dr.", "p." or "the U.S.", where Chrome's sentence
  segmenter starts one. CLDR's English abbreviations and pySBD's titles and page and
  number abbreviations now keep the name or number with the word before it.
- The reference list at the end of a paper served as a web page is no longer analyzed.
  One punctuated citation after another read as a list of sentences, and the lists on
  PubMed Central and Wiley merged into units of their own. The lists of arXiv's HTML
  papers, PubMed Central, bioRxiv and medRxiv, Springer Nature, Wiley, ScienceDirect and
  anything a CSL processor such as Pandoc writes are skipped by the names those platforms
  give them, and so is any list marked `role="doc-bibliography"`.
- On AMP pages, the consent prompt (`amp-consent`) is no longer analyzed, and neither are
  the notification bar, sidebar, app and push banners, ad and embed slots and share
  buttons AMP draws around an article.
- A cookie banner a consent platform shows in a frame of its own is no longer analyzed:
  Sourcepoint's message frames (on its own servers or the publisher's domain), TrustArc's
  consent manager, LiveRamp's privacy manager, AppConsent, Piano's banner and Google's
  consent messages on AMP pages. With access to all sites the frame was read like any
  other, and its paragraph of consent text got a chip.
- A page Edge's translator or Firefox's full-page translation has translated is no longer
  analyzed, the same as a page Chrome translates: nothing is read and no chip stays up while
  the translation is on, and in Edge the page is read again once the original is shown.
  Immersive Translate's bilingual copies of a paragraph are skipped too.
- A Facebook post of several short paragraphs is read as one post. Facebook sets each
  paragraph in a wrapper of its own, and the paragraphs were never read together, so such a
  post got no verdict at all; the posts of the logged-in feed, which Facebook marks only by
  their place in the feed, are now voices of their own as well. A text cut to one line with
  an ellipsis is no longer read: Discord repeats the message a reply answers above it that
  way, and that message was scored a second time.
- A post or comment the site has cut to a preview is no longer analyzed as if it were the
  whole text. Facebook's "… See more", Weibo's "... 全文", Quora's "… (more)", a "…see more"
  that no CSS clamp explains and any other link or button of that kind right after a text
  that ends in an ellipsis mark a preview; it is read, whole, once the reader opens it.
  Posts whose whole text is in the page behind a clamp, as on LinkedIn and YouTube, are read
  as before.
- In Firefox 140 ESR, the oldest Firefox Anagram supports, pages were read but nothing was
  shown on them: no chip, no ball and no selection card, because that version refuses the
  stylesheet an extension gives them the usual way. They are drawn there now.
- The PDF reader opens files in Firefox 140 ESR again. The bundled PDF.js and the paragraph
  reader both use two JavaScript methods that arrived in later versions, so every PDF was
  refused as "not a PDF"; the reader now brings them itself where the browser has none.
- In Firefox, a book whose chapters are shown in a frame with no address of its own (an
  EPUB reader's srcdoc frame), and text in about:blank frames and blob: documents, is now
  read on a site Anagram is on, as it already was in Chrome.

## [0.7.0] — 2026-09-26

macOS Chrome release. Firefox, Linux and Windows are built from the same source but
are not published or validated in this version. The local engine speaks contract 3.0,
so 0.6.0 engines must be updated with this release.

### Changed

- A verdict's word follows its score. EditLens's four equal buckets meet at 1/6, 1/2
  and 5/6, and the word is the bucket whose range holds the score instead of the most
  likely bucket, which could contradict the number next to it and flip on a one-point
  change.
- Chips, underlines, the panel and the cards colour every verdict on one continuous
  scale, pale for human writing and dark red for AI-generated text. The dot thins to a
  ring the less likely its word is to be right, as estimated by a small model fitted on
  the EditLens validation data and checked on held-out and out-of-domain sets; no number
  is shown for it. The card shades the range the probabilities cover.
- Only AI-generated paragraphs are flagged: the ball's counter, the toolbar badge, the
  list and the next/previous commands no longer count heavily edited ones, which are
  right under a third of the time against what the model is trained to measure. The
  list's AI / Heavily edited filter is gone with them.
- Underlines are on for every analyzed paragraph or off; the flagged-only mode is gone.
  The card shows where the score sits on the scale instead of a stacked bar.
- A text longer than the model reads at once is divided into halves of equal token count
  and read in passes of two neighbouring halves each, instead of in consecutive windows of
  about 1,800 characters. Every half but the first and the last is read twice, once with
  what comes before it and once with what comes after, and the two readings count alike;
  the underline follows the halves, so a verdict no longer changes at an arbitrary cut. An
  edge between halves moves to a sentence start when one is within about a sentence.
  Cards, the paste page and copied reports count passes.
- The local engine counts every word's tokens with the model's own tokenizer, and passes
  are planned on those counts; a text too short to overflow one pass is not counted. The
  contract is now 3.0, so an older engine has to be updated.
- A PDF from the web opens analyzed or not by its own site's rule, as the page it came
  from would, and the reader's panel turns off that site. A file from this computer
  follows the global switch.
- The engine is called "Local engine" (本地引擎) everywhere, including card and selection
  footnotes, the counter's tooltip and copied reports.
- The model reads text as it was written, as the official EditLens pipeline does: quotes,
  dashes, ellipses and line breaks are no longer rewritten before scoring.
- Paragraphs under 75 words are no longer scored by themselves, and a selection or pasted
  text needs 75 words, up from 50; short paragraphs are still read with their neighbours.
  The open EditLens model was trained only on texts of at least 75 words and scores shorter
  ones unreliably: at 50 words a quarter of human texts read as AI-edited.

### Fixed

- Automatic PDF opening no longer adds its webRequest listener before any site is
  granted. Chrome refused it with "You need to request host permissions in the manifest
  file…" and the listener stayed dead until the worker restarted, even after a grant.
- Clicking Copy text in a chip's card no longer moves focus into the chip, which is hidden
  from screen readers; Chrome reported it as "Blocked aria-hidden on an element because
  its descendant retained focus".
- A page that rewrites text it renders itself no longer ends up with a stale copy of the
  old text. On X, "Show more" left the expanded post ending in its old preview, which was
  then scored with it. Anagram now puts back any text node it split as soon as the page
  writes to it, removes it or moves it, and every one when it leaves the page.
- The PDF reader no longer breaks an abstract that is set narrower than the body text into
  pieces mid-sentence (single-column papers such as arXiv 2609.20794 and LoRA). A line is
  now measured against the stretch of prose it is set in, not the whole column.

Pages and the background worker:
- Waking the background worker no longer tells every tab the cache was cleared, which
  abandoned their scoring in flight and, in memory-only mode, emptied the cache again.
- Clearing cached verdicts or changing the cache mode no longer paints "Unavailable"
  chips; the paragraphs are scored again, those on screen first.
- A native connection that dropped, or one request that timed out, is retried once and no
  longer marks the local engine down for every tab. Changing the idle timeout or pausing
  a download no longer throws away scoring in progress.
- A paragraph the extension cannot send shows as Unavailable instead of being retried
  forever. Very long paragraphs and whole-page selections go in parts, so they are never
  refused.
- Turning Anagram off on a page stops the engine's queued work for it.
- The triage panel, the copied report and next/previous-flagged follow the page's order,
  so a post or reply that appears above earlier ones is listed where it stands.
- Under "Main content only", pages that rewrite their address as you scroll no longer
  rerun main-content detection on every change.
- Settings: the one-minute idle option reads "1 minute"; a switch, select or site rule
  that could not be saved goes back to the stored value, and a failed site-rule add says
  so. The Chinese text-analysis coverage line counts windows (窗口), not paragraphs.

PDF reader:
- A page deep in a document is no longer read as a title page, which cut its opening
  lines into one block each.
- An oversized PDF picked or dropped into the reader no longer closes the one on screen.
- A local or Firefox PDF that cannot be opened says why: too large, or not a PDF.
- A PDF waiting for other tabs' PDFs to be handed over is no longer called too large,
  and the relay never holds more memory than its budget.
- The reader's panel no longer saves the extension's own id as a site in Settings.

Local engine:
- Resuming the engine, downloading or deleting models, updating and uninstalling wait
  for scoring in progress instead of failing with "busy".
- The first score after the engine unloads for being idle no longer sometimes fails with
  "busy", and after a slow batch the engine no longer spends time on requests the
  extension has already given up on.
- Starting the engine is faster: the model weights are checksummed once per connection
  instead of twice.
- A component that fails to start (for example, a symlinked settings file) no longer
  blocks the terminal commands and the installer from repairing it.

Installer:
- Updating the local engine from Settings installs the release that matches the
  extension, not the latest one.
- `anagram download --profile recommended|expanded` prepares the chosen model set instead
  of ignoring the option.
- An installation interrupted by Ctrl-C, a closed terminal or the update timeout rolls
  back under dash as well, and the next installer or `anagram update` recovers a folder a
  killed installer left locked; the engine says so instead of "installation in progress".
- An interrupted uninstall can be finished with `anagram uninstall -y`.
- Two component homes registering with the same browser can no longer both claim its
  native registration.
- The Windows installer no longer downloads uv again on every run and never builds
  packages from source (not yet run on Windows).

## [0.6.0] — 2026-09-22

macOS Chrome release. Firefox, Linux and Windows are built from the same source but
are not published or validated in this version.

### Changed

- Setup is automatic. After the terminal installer prepares the model files, the local
  engine detects the hardware and activates the best FP32 configuration itself. The
  benchmark and configuration switch moved to an Advanced section in Settings.
- The setup page, popup and Settings were rewritten with far less copy. One term,
  "Local engine", replaces "local component" and "daemon".
- The expanded comparison model set is no longer offered in the extension; the terminal
  `anagram download --profile expanded` command remains.

### Removed

- Research and survey tooling, screenshot generators, the Docker lab, benchmark reports,
  the audit record and most of `docs/`. The repository keeps a README, this changelog,
  the privacy policy, two user guides, the footprint inventory and one development doc.
- Dead code: 0.3-era settings and cache migrations, the unused installer version string,
  the legacy pid-file migration that ran on every host start, the unreachable Windows
  tree helper and unread maintenance receipt.

## [0.5.0] — 2026-09-22

### Added

- The complete packaged PDF.js viewer: search, thumbnails, outline, zoom, rotation,
  passwords, print and download, with optional automatic takeover of authorized PDFs and
  local file picking and dropping.
- Device-aware model downloads with resumable terminal preparation, and isolated
  per-configuration benchmarks with explicit memory and sample reporting.
- Paste-text analysis and memory-only score caching.

### Fixed

- Message authorization, permission revocation, canonicalization, cache expiry and model
  provenance consistency.
- Installer rollback, runtime configuration persistence, download resumption and
  maintenance locking. macOS uses a prebuilt language-identification wheel.

## [0.4.1] — 2026-09-21

### Fixed

- The macOS/Linux installer now shows six numbered stages, download transfer
  statistics, and uv's Python and dependency installation progress. English and
  Simplified Chinese prompts explain that model downloads continue in the extension.

## [0.4.0] — 2026-09-21

### Added

- English and Simplified Chinese first-run setup for Chrome and Firefox, with a
  one-time native-component installation command and browser-managed model setup.
- Anonymous, verified downloads of the public EditLens modelkit: original weights
  and FP32/FP16/INT8 ONNX variants. Upstream attribution and CC BY-NC-SA 4.0 apply;
  INT8 is experimental and conversion parity is not a task-accuracy evaluation.
- Device discovery, a shared 30-second benchmark measurement budget, explicit runtime
  selection, saved choices, manual switching and benchmark reruns.
- Controls for download pause/resume, engine stop/start, model deletion, component
  updates and complete uninstall, with ownership checks and completion receipts.
- Native launchers and installers for Apple Silicon macOS, supported Linux x64/ARM64
  and Windows x64. Windows maintenance reports completion separately from scheduling.
- PDF reading with original page rendering, text selection, local-file input, zoom,
  short-paragraph grouping and annotations aligned with the text.
- Optional website access and one-page analysis through activeTab, plus reading and
  navigation controls, diagnostics, accessibility checks and bilingual user guides.

### Changed

- All inference and component management use Native Messaging. Tabs and windows in
  one browser profile share the local component; no daily terminal session is needed.
- Extension pages and the background use `connect-src 'self'`. Website access remains
  optional; `nativeMessaging` is required on both browsers.
- Browser tests use isolated stdio hosts. Release bundles exclude research helpers,
  test outputs and machine metadata.

### Fixed

- Native disconnects invalidate cached readiness immediately, including idle hosts.
- Model/runtime selection and lifecycle state survive browser restarts without
  undoing explicit pauses, model deletion or engine stops.
- Native dependencies write relative diagnostic files inside the owned component home.

### Removed

- HTTP inference server/client, developer transport switch, endpoint/port settings,
  terminal server controls, duplicate terminal model downloads and HTTP-only dependencies.
- Obsolete HTTP test services and lab bridges, stale setup text and redundant comments.

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
