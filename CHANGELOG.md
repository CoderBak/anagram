# Changelog

Notable changes to Anagram, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). The extension, the
local component and the installer all carry the same version.

## [0.8.1] — 2026-09-29

The first official release of the 0.8 line. It follows the 0.8.0 pre-release with a compact
setup page and Settings, clearer verdict colours, PDF chips on the right lines and an
installer that falls back to hf-mirror.com. Published for Chrome on macOS and Linux; Windows
is not validated.

### Added

- The local engine's installer downloads the model from hf-mirror.com when huggingface.co cannot be reached (mainland China, for one); every file is still checked against its pinned SHA-256.

### Changed

- The setup page and Settings are one compact page and one list each, with fewer words and
  no folds. The setup page puts where Anagram reads (all sites, PDFs) first, then the
  engine and its download, then how to read a verdict and the model's licence notice. The
  download shows a rounded striped bar with its percentage, one line of bytes, time left
  and speed, and asks you to keep the browser open while it runs. The engine choice no
  longer quotes speeds or memory.
- Settings drops the Scope setting (analysis is always the whole page, and the
  main-content extractor with it), the report and debug switches, the shortcuts list, the
  engine's configuration list and benchmark, and every heading and fold. The PDF reader
  and Analyze text moved to the popup.
- Verdict colours use the highest chroma sRGB allows, from a vivid green through amber to
  red; the chip's dot is larger, the chip is tinted with its colour and the underline is
  thicker. The card no longer explains the number and says only "Only English text is
  scored." for other languages. No message or status line uses a middle dot.

### Fixed

- In the PDF reader a paragraph's verdict chip stands on the paragraph's last line again:
  it was placed against the page's outer edge instead of the page itself, up to 9 px off
  (half a line on a paper's tight leading, beside the next paragraph), and a left column's
  chip went to the far margin beside the right column's text; it now goes to the margin on
  the column's own side.

## [0.8.0] — 2026-09-29

One extension with two engines. Where the local engine is faster (Apple Silicon Macs,
NVIDIA graphics cards) the setup page offers the choice; everywhere else the model runs
inside the browser and downloads by itself, with nothing to install. Tested on Chrome 137+
on macOS; the automated suites also ran the in-browser engine on Linux (x86-64 and arm64,
in containers) and in Firefox 153 ESR. Windows is not validated. Local-engine users update
it with the command the setup page shows.

### Added

- One extension, two engines: Anagram can now run the same pinned model inside the browser
  (ONNX Runtime Web on WebGPU, in an offscreen document) with nothing else to install,
  beside the local engine. The setup page decides from what the browser says about the
  computer. On an Apple Silicon Mac, or a Windows or Linux PC with an NVIDIA graphics
  card, it offers both, the in-browser one highlighted, each with its speed and memory (on
  an M4, 92 ms a paragraph and up to 2.5 GB in the browser, 43 ms and about 1.8 GB for the
  local engine), and nothing downloads until you pick. Elsewhere the in-browser engine's
  model downloads by itself, once, from Hugging Face into the browser's storage, with no
  permission to grant (fastText's language file ships in the package); a computer with
  under 4 GB of memory or too little disk is told so and downloads nothing, and 4 GB runs
  with a note that it may slow down. Picking the local engine asks for Native Messaging,
  now an optional permission (an update keeps the grant 0.7.0 had), then shows the install
  command; a refusal goes back to the choice. The in-browser setup shows progress, speed
  and time left, Pause, Resume and Cancel, says why a download stopped and resumes where
  it left off; when ready, Settings says whether the model runs on the graphics card or
  the processor, and holds the idle unload and **Delete model files**. Settings switches
  engines both ways and offers to delete what the in-browser engine left; the popup and
  the panel name the engine in use; a local engine that keeps crashing is offered the
  in-browser one beside Retry. The model's weights are read from the browser's storage a
  tensor at a time, straight onto the graphics card: on an M4 the browser takes 2.3 GB
  while the model loads and at most 2.5 GB while scoring (2.0 GB on the processor, on up
  to eight threads under the pages' cross-origin isolation), and an idle model's worker
  ends and gives the memory back. Anagram now needs Chrome 137; Firefox needs 153. The
  engine runs on ONNX Runtime Web 1.30 (MIT).
- A page whose comments come from another site's frame — Disqus, Facebook's comments
  plugin, utterances, giscus — says so in the panel and offers to allow that site. Anagram
  reads a frame only with access to its own site, so those threads went unread without a
  word. The panel's button opens Settings at a row that names the site; the browser asks
  there, on your click, and nothing is requested otherwise. Once allowed, the open pages
  that show the thread read it without a reload.
- THIRD_PARTY_NOTICES.md ships next to LICENSE in both browser packages and in the local
  component. It lists every third-party library, font, data file and model Anagram contains,
  and the code and word lists its own source adapts, each with its version, licence,
  copyright and licence text; the minified bundles strip those notices, so they now travel
  here. ONNX Runtime's own notices for the libraries its WebAssembly build links ship beside
  it in the reader's worker folder.
- Settings and the setup page link to Anagram's source code in their footer, next to the
  model credit: the release tag of the version that is running.
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
- A copied report links each flagged paragraph to its place on the page. When reports
  include both the page's address and passage text (Settings, Privacy), every flagged
  paragraph gets a link that reopens the page scrolled to it and highlighted: a text
  fragment (`#:~:text=`), which Chrome and Firefox 140 follow. The link names the
  paragraph's first and last words, checked to match nothing else on the page, with the
  fragment generation of GoogleChromeLabs' text-fragments-polyfill (Apache-2.0). A paragraph
  whose words the page repeats around it, one inside a shadow root or an editable field, and
  whatever the PDF reader or a document viewer shows get no link, and so does anything the
  report has not linked within a second and a half.
- A copied report says what its counts add up to where they would mislead on their own. A
  page where no passage reached the 75-word floor says "Too little text to judge" instead of
  "No paragraphs were flagged", and no longer claims the local engine did not answer when
  nothing was sent to it; a page with nothing in English, no answer from the engine or no
  verdict yet says that. The report can now be copied with nothing flagged, to say so. When
  half or more of the verdicts are close calls — within .05 of a place where the word
  changes, or more likely wrong than right by the confidence dot's model — the report calls
  them mixed or uncertain, and marks each flagged paragraph that is one. Every report, the
  Analyze text page's included, carries the caveat "Scores are estimates, not proof of
  authorship. Do not use them for disciplinary or other high-stakes decisions." The idea of
  stated result states and a caveat that travels with the result comes from
  lynote-ai/ai-text-detector (MIT).
- The in-browser engine runs the modelkit's FP16 model (715 MB, on WebGPU only) where FP32
  does not fit: on 4 GB of memory, where the free disk cannot take the 1.4 GB but can take
  715 MB, or where the graphics card can bind FP16's largest tensor but not FP32's, and only
  with `shader-f16`. Its verdict word matches FP32's on 99.82% of the EditLens test split (6,100
  of 6,111 texts); the setup page and Settings say so, its scores carry a model id of their
  own, and if it does not run on a device it is deleted and FP32 takes its place on the
  processor where that fits. FP32 stays the automatic pick everywhere else; INT8 is never used.

### Changed

- Firefox 153 is the minimum (it was 140, an ESR whose support has ended and which lacks
  WebAssembly JSPI): the in-browser engine now runs in every supported Firefox.
- The PDF reader's paragraph worker runs on ONNX Runtime Web 1.30, the same build and the
  same WebAssembly binary as the in-browser engine, instead of a second copy of 1.27: the
  package is 3.4 MB smaller (11 MB unpacked).
- Customer reviews are read one by one: the stars a review card shows mark it as a voice
  of its own (Google Maps and Google Play cards carried nothing else), a review declared
  in schema.org microdata, RDFa or the page's JSON-LD is read without its name, stars and
  date, and a sentence every card of a list repeats, such as Tripadvisor's disclaimer, is
  left out.
- **Minimum length** in Settings: 25, 50, 75, 100 or 150 words, 50 by default (it was a
  fixed 75), for pages, PDFs, selections and pasted text; a verdict on under 75 words, the
  model's training minimum, says "Short text: less reliable" and its dot is thinner.
- The small script Anagram runs in a page's own context no longer gives it away: its event
  is named at random for each page, told to the extension before the page's first script,
  and the attachShadow it watches, and Function.prototype.toString, answer the usual
  checks as the browser's own functions do.
- Linux installs PyTorch and its CUDA libraries only beside an NVIDIA GPU (ONNX Runtime ran
  the processor anyway): the installation shrinks from 6.9 GB to 1.7 GB, and an update removes them.
- On Apple silicon the local engine runs the model in MLX (MIT) on the GPU instead of
  PyTorch, still in FP32 from the same model.safetensors, and PyTorch and Transformers are
  no longer installed there: the engine's Python packages shrink from 780 MB to 340 MB.
  On 200 texts of the EditLens test split every probability stays within 0.00001 of
  PyTorch's on the GPU, with the same words. One paragraph scores a tenth faster, a page's
  worth 5–7% faster, and a new engine is ready in 2.6 seconds instead of 4.2. ONNX Runtime
  on the CPU remains the fallback on a Mac whose GPU MLX cannot use; Linux and Windows keep
  PyTorch. Every runtime now tokenizes with the tokenizers library directly, from the same
  tokenizer.json. The half-precision GPU choice goes with PyTorch on the Mac.
- The model behind a verdict's dot is refitted on the EditLens validation data read
  through Anagram's current pipeline (passes, grouping, accents composed). Its
  coefficients move by a few hundredths and its calibration on the test, Enron and Llama
  sets holds (error 0.044, 0.037, 0.041). Checked on two sets it had never seen, 300 news
  articles and 91 learners' essays, each wholly human or wholly AI-generated: a verdict
  rated 0.9 or more was right 99.6–100% of the time, but where no text is AI-edited the
  two middle words are never right and their dots still stay a third to a half full. The dot
  keeps depending on a page's mix of human and AI text, which is why it shows no number.
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
- A PDF of more than 300 pages is read on every page, by the reader's own reflow as each
  page is drawn; only its first 300 pages were read before. Zotero's structure is still
  asked for up to 300 pages: on 336- to 816-page documents the worker took 9–17 seconds and
  its tab 0.7–0.9 GB at its peak, and its reading would stay in the tab at about 0.3 MB a
  page for as long as the document is open, while the reflow holds only the pages drawn.
- The verdict colours run from a soft green for human writing through amber to red for
  AI-generated text: one continuous scale, whose lightness still orders it for a reader who
  cannot tell red from green (the dark-page scale spans more lightness, as reds darken for
  protanopes).
- Anagram's code is now licensed under the GNU AGPL v3.0 or later. The licence text ships
  in the extension and in the local component. The model keeps its CC BY-NC-SA 4.0 licence.
- While the in-browser engine's model downloads, the popup and the panel on a page move
  with it and show the same figure, each within about half a second of the download; the
  panel used to catch up every five seconds, and the popup kept the figure it opened with.
- When a page Anagram reads starts opening in the tab in front, an in-browser engine that
  let its model go while idle starts loading it right away, beside the page, instead of
  when the page first asks for a verdict: the reload (about 3 seconds on an M4) overlaps
  the page's own loading, which on a page that opens at once saves 0.2 s (3.0 to 2.8 s to
  the first verdict) and on a slower page up to the whole reload. A tab switch, a tab in
  the background or a site Anagram does not read warms nothing, and a model warmed for
  nothing is let go after the idle time as before.

### Fixed

- English disguised with Cyrillic or Greek look-alike letters gets a verdict: they are
  turned back into Latin letters before scoring (Unicode's confusables), and the card and
  the report say so; on RAID's homoglyph texts no verdict becomes the verdicts of the
  undisguised texts.
- A PDF manuscript with numbered lines, as preprints and papers under review are set, is
  read without its line numbers. Word's line numbering and LaTeX's lineno put a number
  beside every line, and both of the reader's readings took it for a word: "84 Vertical
  land motion (VLM), defined as … 85 represents", which also hid every paragraph's indent.
  Zotero's reader took each numbered line for the item of a numbered list and set whole
  pages of such prose aside as tables. The numbers are now told by where they stand — a
  bare number at the edge of each line, in a column clear of the text, counting on line by
  line — and left out; the lines Zotero read one by one are joined into the paragraphs
  their indents and last lines show (in a manuscript set ragged right, where nearly every
  line stops short of the margin, by their indents), a paragraph carried over a page is
  one; a page it took for a table is read,
  and so are numbered lines it took for the entries of a bibliography before the
  manuscript's own References heading. On 18 EarthArXiv manuscripts, those whose PDF
  carries its own paragraphs read 81% of their text instead of 60%, the paragraphs are
  found (boundary F1 82% instead of 58%), and the 6% of scored words that were line
  numbers are gone.
- A report's footnotes are no longer read as its text. Government and agency reports set
  each note as a raised number run into the note ("¹⁷DOD civilian personnel are funded …"),
  and Zotero's reader took the notes at the foot of a page for the items of a numbered list
  in the body. A block the text's raised mark links to, opening with a raised number, is now
  the note it is, and so are the others of its list. On five reports the share of scored
  text that is not the body falls from 22% to 9%.
- The PDF reader's own reflow, which reads a document before Zotero's structure arrives, a
  long one past its 300 pages, and Google Drive's and OneDrive's previews, reads the columns
  of a page that has them in one stretch only: under a first page's title and abstract, or
  beside a figure set across the page, and of a page whose gutter is no wider than an em,
  as many conference templates and small books set it. It read such a page line by line
  across both columns. On olmOCR-Bench's pages it passes 65% of the checks instead of 58%,
  and on two-column arXiv papers it puts 9 paragraphs out of order where it put 118.
- In Firefox, a web PDF without ".pdf" in its address now and then stayed in Firefox's own
  viewer instead of opening in Anagram's reader, and a PDF the reader opened by itself, as
  it does when one loads or is reloaded, could land on "This PDF could not be loaded". Both
  happened on a busy computer, where Firefox reports a tab's loading, its navigation and the
  response that says "PDF" out of order: a navigation announced a second time after its
  response was taken for a new one that had said nothing yet, and the PDF tab's own late
  "loading" for the tab moving on, which withdrew the reader's permission to read the file.
- In Google Drive's preview and in a pdf.js viewer in a page (OneDrive, SharePoint,
  Overleaf), a page drawn after the pages before it were read no longer leaves paragraphs
  unread. The first half of a paragraph running onto the new page had been read with the
  short paragraphs before it; joining the halves let go of that group, and the paragraphs
  it held stayed unread, with no chip, until something else on the page changed. They are
  read again as soon as the page is drawn, and a paragraph the page does not change keeps
  its verdict.
- When the local engine stops unexpectedly in the middle of a page, as it does when the
  Apple GPU throws away MLX's work and takes the engine's process with it, it is started
  again and asked once more for what it was scoring, once it has loaded its model. The
  chips end with their verdicts instead of reading "Unavailable", nothing already answered
  is asked again, and the PDF reader and the paste page carry on the same way. An engine
  that keeps stopping (four times within two minutes with nothing scored in between) is no
  longer started over and over: pages show that the engine is down until Retry, and the
  panel and Settings say that it kept stopping rather than that it is not ready, each with
  its Retry.
- A GPU failure MLX reports instead of aborting on (a command buffer that did not complete,
  memory it could not get) no longer counts as a broken engine: the batch is answered as
  one that may be asked again, MLX's cached buffers are dropped, and the engine stays
  loaded. Before, it was an internal error and the extension declared the engine down.
- A configuration that takes the engine down twice in a row while it starts, or before it
  has scored its first batch, is passed over: the engine picks ONNX Runtime on the CPU in
  FP32 by itself, with no comparison and nothing to choose, and Settings says which
  configuration was passed over and why; choosing it again tries it again. Where no other
  configuration is installed (the recommended download on a Mac has only MLX), the engine
  stops and says so, and Retry tries again. A death after batches were scored is not held
  against the configuration: the next start loads and warms it up again, as every start does.
- A consent box a publisher builds itself, such as the Daily Mail's, is no longer read. No
  platform's name is on it; it is recognised by what it holds: a list of third parties, each
  linking to its own privacy policy, beside buttons that give or refuse consent. Its
  explanations were read on four Daily Mail pages of the web benchmark, 319 words each.
  Buttons in Chinese (全部接受, 拒绝, 保存设置) count as well as English ones, and "Copy page
  diagnostics" names such a box as the page chrome it is and counts its words with the
  chrome, where it gave a wrong reason, such as the word floor, and counted them as prose.
- A cookie banner a consent platform draws inside a shadow root of its own is no longer
  analyzed; only banners in the page itself were recognised.
- Immersive Translate's "translation only" mode is recognised: the translation it shows in
  place of a paragraph is marked `data-imt-translation-only`, as the stylesheet the
  extension publishes says, and is no longer read as the page's own text.
- The PHP warnings a forum running in debug mode prints above its pages ("[phpBB Debug] PHP
  Warning: in file … on line 483") are no longer read as a text; neither is the warning
  output of any PHP site. Two phpBB topics in the web benchmark lost 750 words each to them.
- Overleaf's PDF preview is read like any other pdf.js viewer. Overleaf builds the viewer
  once the project has loaded and compiled, after Anagram had looked for one, so its text
  layer was walked as a page: every run of the PDF's text a fragment, citations and broken
  words left as printed, and chips drawn inside the layer. A project's page is now known by
  its address, and the preview's paragraphs are rebuilt from the text layer as they are for
  OneDrive's.
- In a pdf.js viewer in a page, text set at an angle is left out of the paragraphs again,
  such as the identifier arXiv stamps up the margin of a paper's first page. pdf.js turns
  such a run with a style property of its own since version 4, which Anagram did not read,
  so the stamp was read into the first paragraph beside it.
- Stopping, resuming, updating or removing the local engine no longer waits forever for a
  forward pass that does not end. It waits as long as the extension waits for any answer,
  30 seconds, then reports that inference is still running and can be tried again.
- A local engine that could not start, because the installation was unfinished, another
  browser held it or its folder needed repair, kept giving the same answer until the
  browser was restarted. It now answers once and exits, and the next request starts a
  fresh one that tries again.
- A long session on a feed that keeps every post it shows, as Reddit's does, no longer costs
  more with every minute. Counts and times a page rewrites in place (likes, scores, "5 hr.
  ago") no longer make Anagram read the page again, and the page is read again only as often
  as it can afford: reading a long page costs as much as the page is long, so after each
  reading Anagram now waits in proportion to what it cost, which keeps it under a twentieth
  of the page's time. On a Reddit-like test feed scrolled for five minutes to 800 posts, the
  time spent on the page's changes in the last minute fell from 9% to under 5% and stopped
  growing, the content script's time fell by a third and its longest pause from 160 to 80 ms.
  The batching follows uBlock Origin's DOM watcher (GPL-3.0).
- The Copy report button in the panel keeps to one line when the panel's title needs more
  room, as it does in a longer translation; the title wraps instead.
- The legal fine print a site sets under its text or its offer is no longer read: boxes
  named as disclaimers or fine print, such as the numbered footnotes under a phone's product
  page or the fee and risk notices under a bank's calculator. On the web benchmark's
  development pages this removes 3% of the words read that are not the page's content: a
  third of them on product pages and a tenth on service pages.
- The author's bio box beside or under an article is no longer read as part of the page:
  boxes named as an author box, an author bio or "about the author". A box of authors that
  holds the article itself is still the article. On the web benchmark's development pages
  this removes a further 2% of the words read that are not the page's content, on 32 pages.
- A code block marked up for SyntaxHighlighter (`class="brush: xml; gutter: true"`) is no
  longer read as prose. Its settings were not recognised as a highlighter's, and a security
  advisory's exploit code was read as a 2,500-word paragraph.
- A heading written in capitals over a paragraph ("COLOR AND WEIGHT", "THE CHOICE OF YOUR
  FRISBEE") no longer cuts a text into sections too short to read, and is no longer read as
  the first line of the paragraph under it. A shop's product description set as four short
  paragraphs under such headings got nothing and is now read as one text, as a text under
  bold headings inside an article already was. Real headings still end a section.
- A page footer built from a `<div>` or a `<section>` is no longer read when it names itself
  the footer (`footer`, `site-footer`, `footer-wrapper`), as a `<footer>` element outside the
  article never was: Project Gutenberg's licence under every book, a blog's footer widgets,
  a news site's advertising notice. A component's own footer (a card's, a banner's) and a
  footer box inside the article or the main region are still read.
- Text after a named anchor on an older page is read. `<a name="…">` marks a place to link
  to, and a page that leaves it open holds the whole section after it inside the element;
  every paragraph there was taken for link text, like a menu, and a North Carolina extension
  bulletin of 1,900 words got nothing. Only an `<a>` that goes somewhere is a link now.
- A paragraph inside a card that is one big link is read when it is prose: a sentence of
  twenty words or more, in a block of its own inside the link. The excerpts on a blog's front
  page were taken for menu items, because every word of the card is link text. A menu whose
  items are block links is still not read.
- A WordPress page whose page builder is gone no longer has its layout read as prose. It
  shows its shortcodes as text (`[vc_row type="in_container" …]`), and a row of them with all
  their settings cleared the floor. A template's `[audience]` or a `[sic]` in a sentence is
  still read.
- A phrase a page repeats over and over, such as a scrolling "Book Now * Book Now * …"
  banner or a notice printed once per item, is no longer read as a paragraph: thirty words or
  more that use no more than eight different ones.
- More boxes of other articles are recognised by their names and left out: related cards,
  resources, guides and videos, "you may also like", "more like this", "more stories", and
  YARPP's related posts.
- A section of a page is no longer skipped because of the words in its anchor. PostgreSQL's
  reference section on the locking clause is `SQL-FOR-UPDATE-SHARE`, Flask's documentation
  names its section on cookies `cookies`, and those ids read as a share bar and a cookie
  banner. An id that a link on the page points at, or one of more than four words, names a
  place in the document, and is no longer looked in for the names of page chrome.
- An `<aside>` in the middle of the text is read. Every aside used to be skipped as a
  sidebar or a pull quote, and with it the callouts writers set between their paragraphs
  and the post a XenForo reply quotes. One that stands among the text and holds prose of
  its own is read now; sidebars, pull quotes, signatures and boxes of other articles stay
  out, and so does an aside floated beside the text. An aside a site never closed, and
  that holds the whole article, no longer hides it.
- A shop's product page that sits inside its add-to-cart form is read. osCommerce and Zen
  Cart set the whole page, description and all, in that form, and a form with a field to
  fill in was taken for a sign-up box. A form that holds most of the page's text, on a page
  that declares no main text elsewhere, is now read as the page.
- The panels of an accordion whose items are marked as tabs are read. Bootstrap and Drupal
  accordions put `role="tab"` on each item, header and panel together, and carousels on
  each slide; a tab is the label of a panel, and one that holds a panel, a heading or a
  paragraph is no longer taken for one.
- Code and names marked not-to-translate in the middle of a sentence are read with it.
  Sphinx marks every inline code literal in Python's, Django's and Flask's documentation
  that way; left out, they holed the sentence the model read, and a 76-word paragraph
  counted 73 words and was not analyzed at all.
- Short paragraphs around and inside a list are read together. A list's items (`ul > li >
  p`, a definition list) stood apart from the paragraphs around them and from each other,
  so a lead-in, the items and the sentence after them, each too short alone, went unread.
  A list no longer separates the text of one section; a heading still does.
- Short paragraphs that a site sets each in a box of its own are read together when the
  boxes come from one template, side by side (Asciidoctor's `div.paragraph`, a CMS's
  paragraph block). Two different boxes side by side, a column and a sidebar, are still
  read apart, and a name row between two such boxes still ends the text.
- A link drawn as an inline flex box, a label beside an icon, no longer cuts its sentence
  in three. On aaa.com every paragraph with a link was split at the link and left unread.
- The PDF reader works better with a screen reader, a keyboard and zoom. The page declares
  its language (the one the viewer's toolbar is drawn in, with Anagram's own controls in
  Anagram's), no longer stops pinch zoom, and puts the toolbar, the pages and the scope note
  in landmarks. The page field and the zoom menu are labelled with the words of their
  tooltips, and the scrolling page area has a name and a visible focus outline when the
  keyboard reaches it. The accessibility suite now passes on every reader state.
- The model no longer reads the space Anagram leaves where it skips a formula or a citation
  mark before a full stop or a comma ("the bases [4]." read as "the bases ."). That space
  made arXiv's HTML read as more human than the PDF of the same paper: on 1,464 paragraphs
  read from both, it lowered the HTML's score by 0.04 on average and by 0.10 where
  citations were. The web page reader and the PDF reader both close it up where they skip
  something, and nowhere else: a space the author typed before punctuation reaches the model
  as written. Earlier verdicts are not reused for the texts this changes.
- An author–year citation is read with its sentence on every page. Anagram left out any
  citation of 40 characters or fewer, so on arXiv's HTML "Smith et al. (2020) showed" reached
  the model as "showed" while the same paper's PDF read the names, and a longer citation was
  read whatever it was. What a citation holds now decides, as it does in the PDF reader: a
  mark that only points to the bibliography or to a note is left out however long it is —
  "[4]", "[4, 7–9]", a superscript "1, 2", Wikipedia's "[7]" and its ":p. 7", a footnote
  number that is a link — and names with a year, or a name alone, are read. With the PDF
  reader's changes below, on 50 arXiv papers read both as PDF and as HTML the paragraphs whose
  two readings differ only in citations fell from 334 to 102, and the two give a paragraph
  the same verdict 96.2% of the time (95.9% before).
- The PDF reader leaves out a citation printed as a raised number after its word
  ("errors¹⁻⁴", the style of Nature and many journals), as it already left out "[4]" and as
  the web walker skips the same mark: the model read "errors1–4." where the paper's HTML
  reads "errors.". Zotero's document-worker tells which raised numbers name entries of the
  bibliography; one after a unit or a formula's letter ("cm²") is still read as an exponent.
- The PDF reader also leaves out a bracketed citation that carries a locator or a note,
  "[16, Section 4]" or "[e.g., 17, 18]", or names an alphabetic key, "[Kir08, Theorem 3.9]",
  as the web walker does with the same marks on the paper's HTML. A bracket that names a
  year ("[Higham, 2002]") is read as an author–year citation, and one with no reference in
  it ("[sic]") as the writer's own.
- The PDF reader's own reconstruction leaves out the same bracketed citation marks. It reads
  a document until Zotero's structure is ready and wherever that is not used, and it reads
  the PDFs that Google Drive and OneDrive preview; "[4]" and "[19], [20]" reached the model
  from all of these. The label that opens an entry of a reference list stays.
- The PDF reader leaves out what a formula is made of in any face, the way BabelDOC
  (AGPL-3.0) tells a formula's characters from the text's: an "=" or "+" standing apart and
  an upright capital Greek letter, which TeX takes from the text's face ("$18 = 324$", the Λ
  of "$\Lambda$CDM"), an accent that is no letter's (a \hat or a \bar), and a formula's
  letter the PDF does not map, which Zotero runs into the word before it ("Thusθ is"). A
  symbol TeX draws from a mathematics face is typed text when it is set in the text's face
  and stays ("2048 × 2048", "an α-helix"), and so do an operator with no space around it
  ("J1351+0039", "C++") and the μ of a unit ("14 μm"). On the development papers of the PDF
  benchmark, the paragraphs whose reading still held formula text fell from 3,798 to 3,391.
- The PDF reader leaves out a letter set alone in a bold face, a formula's \mathbf ("the
  state **h**", "**J**₀"). A phrase in that face, a label ("(A1)", "(B)", "Appendix C") and
  an italic letter stay: the text's italic sets the writer's \textit as often as a formula's
  letter, and on the development papers leaving italic letters out as well cost about 190
  words of prose for almost no formula text. With bold letters out, the formula tokens left
  in the PDF's reading of those papers fell from 3,500 to 2,460.
- The PDF reader leaves out what a page sets in a face it uses only for formulas. A paper
  set in Times takes "$300$", "\mathrm{km}" and "\operatorname{var}(" from Computer Modern,
  which sets none of its words; a numeral, a symbol, a word of up to three letters, an
  operator name or a function applied in such a face now goes with the formulas. A longer
  word, a sans-serif heading and code stay. On the development papers the formula tokens
  left in the PDF's reading fell from 2,460 to 2,044, and the numbers of formulas it read
  from 3,590 to 3,027.
- The PDF reader keeps a number set right against the relation that ends a formula:
  "recorded at a $\geq$10 kHz rate" and "($\sim$50%)" lost their numbers, which arXiv's HTML
  reads. TeX puts a thick space after a relation inside a formula, outside a sub- or
  superscript, so a number with none before it was typed after the formula; pdf.js's runs
  keep that space where Zotero's glyphs lose it. On the development papers the prose numbers
  the HTML reads and the PDF left out fell from 1,392 to 1,346.
- The PDF reader keeps the number a cross-reference names when a formula follows it with no
  comma between: "by Proposition 1 $f$ is bounded" and "Eq. (3) $x$" lost the "1" and the
  "(3)".
- The PDF reader leaves out a name set against the bracket of a formula's argument, a
  function applied to it: "\mathrm{Aug}(\mathcal{G})" read "Aug(" and "\operatorname{KL}(p\|q)"
  read "KL(". On the development papers the paragraphs whose reading still held formula
  text fell from 2,819 to 2,639.
- The PDF reader leaves out the end of a formula that a hyphen joins to a word:
  "$(2+1)$-dimensional" read "1)-dimensional" and "$(1-\alpha)$-quantile" read ")-quantile".
  The word is kept from its hyphen on, as arXiv's HTML reads it ("-dimensional"); a number the
  text hyphens to a word ("a 3-dimensional space") stays.
- The PDF reader leaves out a formula's letter set in the text's italic, where a paper's
  mathematics has no face of its own for letters (Times with mathptmx, Palatino with mathpazo,
  Word's MathType): a lone italic letter beside a formula ("$R = $ Er"), with a script of its
  own ("$D_i$", "$M_\odot$") or hyphened to a word ("the $g$-band", which reads "the -band" as
  on arXiv's HTML). An italic word, an italic letter nothing marks ("plan *B*"), an italic
  statement's "a", and every italic letter of a paper whose formulas take their letters from a
  mathematics face stay. The words after a script that Word sets in the script's own run are
  no longer taken for the script. On the benchmark's papers, against their HTML with the
  formulas taken out, the formula tokens left in the reading fell by 546 on the development
  papers and 208 on the held-out ones, and the prose read rose by 38 and 29 tokens.
- The PDF reader's own reflow now reads a paragraph by the same rules as Zotero's structure:
  a formula, what TeX sets of one in the text's face and a raised citation or footnote
  number after a word are left out, a display equation is passed over and the sentence it
  cuts in two read as one paragraph, and an accent pdf.js spells before its letter ("Tom´as",
  "Fran¸cois") is written on the letter. The reflow reads a PDF until the structure is ready,
  every page of one over 300 pages and every page when the worker fails; in the previews of
  Google Drive, OneDrive and Overleaf, which name no fonts and set every line at one size,
  only the accents change. On the PDF benchmark's papers the reflow's scored text that is
  not their prose fell from 23% to 13% (development) and from 26% to 16% (held out), against
  their HTML with the formulas taken out, and the prose it scores rose from 85% to 90% and
  from 84% to 88%.
- The PDF reader keeps a number the text writes next to an inline formula: "pores of 11.3 μm"
  read as "pores of m", "by Theorem 2, x is" as "by Theorem, is", and "(Federer, 1969,
  3.2.12)" lost its year. A number beside a formula went with it, because TeX sets a formula's
  digits in the text's face; but it sets a formula's decimal point and comma in the
  mathematics face, so a number whose point or comma is the text's, or one that closes its
  clause before the formula starts, is read now, as arXiv's HTML reads it.
- A raised number right after a word is left out of a web page's text even when it is not a
  link: an author's own superscript citation on arXiv ("change¹⁻⁴"), a footnote number on an
  older page ("report⁴"). After a unit or a variable it is still read as an exponent ("km²",
  "3x²"), as in the PDF reader.
- The PDF reader reads the sentence that leads into a display equation ("…can be written
  equivalently as") with the paragraphs around it. Such a piece does not end in a full
  stop, so it was taken for a label, and a label ends the run of short paragraphs being read
  together: in a paper full of formulas most of the text between two equations went unread.
  A page break no longer ends that run either where the sentence before it goes on over the
  page. On 50 arXiv papers read both as PDF and as HTML, the prose the HTML reads and the PDF
  left unscored fell from 19,000 words to 3,000, and the two readings give a paragraph the
  same verdict 95.0% of the time (93.6% before).
- The PDF reader leaves out more of a paper's inline formulas, as arXiv's HTML does: those
  set in mathematics fonts it did not know (mathabx, MnSymbol, kpfonts, newtx's Libertine
  and XCharter faces, the Type 1 build of Latin Modern, fdsymbol, blackboard bold), and the
  parts of a formula TeX takes from the text font — an operator name such as "log" or "sup",
  an upright capital Greek letter, the "init" of x_init.
- The PDF reader keeps the hyphen of a compound broken at the end of a line where the
  document's own usage says so ("near-equilibrium", "self-attention"). Zotero's text joins
  every such word, and the reader took those joins for the document spelling the compound
  as one word, so the hyphen always went. A word broken right after a bracket or a quote
  ("(Ta-/ble 1)") is mended now instead of keeping its hyphen.
- An accented letter reaches the model as one character however the page encoded it: a PDF
  gives "e" and a combining acute where a web page writes "é", and the model read the two as
  different words. The PDF reader also puts an accent back on the letter it is printed over
  ("Alfven´" and "Garcıá" read "Alfvén" and "García" again). Earlier verdicts are not reused
  for the texts this changes.
- On arXiv's HTML papers, short paragraphs are read together with their neighbours, as on
  any other page and as the PDF reader reads them. Each paragraph there sits in a box of
  its own, so none under the 75-word floor was ever grouped: proofs, definitions and short
  remarks, some 12% of a paper's prose, went unread.
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
- In Firefox, "Open original" in the PDF reader no longer sends the PDF straight back to
  the reader about half the time when PDFs are set to open in the reader. Firefox reports
  that one navigation twice, and the first report used up the pass it was given.
- The PDF reader's paragraph worker no longer contains folder paths of the machine it was
  built on, and the component archive no longer records the builder's user name.
- Ctrl-C during `anagram update` no longer leaves the local engine locked. The installer
  put the old engine back, but the command's own Python processes killed it a quarter of
  a second into that, before it released its lock, and Anagram would not start until the
  update was run again. They now wait for the installer to finish.
- The PDF reader no longer scores a thesis's or report's table of contents and lists of
  figures and tables, whose entries repeat every caption: an entry ending in a dot leader
  and a page number ends the writing, as a bibliography does; on the theses of the PDF
  benchmark the scored text that is not prose fell from 9.3% to 6.2%.
- The PDF reader no longer scores a figure's or table's caption that its paragraph engine
  took for body text, told by the label it opens with ("Table S7:", "FIG. 1.", "Figure 8
  Difference of…") and never a sentence that names a figure ("Figure 3 compares…", "…as
  shown in Figure 6.32. Notice…"); on the benchmark's development papers the scored text
  that is not prose fell from 4.44% to 4.13%.
- The PDF reader no longer scores the bibliography of a physics paper set with no
  References heading (REVTeX, JHEP): a list whose entries open with a bracketed number and
  cite a year is taken for the references and ends the writing; on the benchmark's
  development papers the scored text that is not prose fell from 4.13% to 3.76%.
- The PDF reader no longer scores the rest of a caption that its paragraph engine cut off
  from the caption and took for body text ("…Each dot is one system;" / "the horizontal
  line in each column marks the median…"): a paragraph set right under a caption, where
  the caption's next line would be, is read as the caption's; on the benchmark's
  development papers the scored text that is not prose fell from 3.76% to 3.67%.
- In a manuscript with numbered lines the PDF reader leaves out a caption of any length,
  told by the label it opens with as elsewhere ("Figure 8 Difference of density plots…",
  154 words, was read), and no longer drops a short paragraph that opens by naming a
  figure ("Figure 3 compares…"); on the benchmark's line-numbered manuscripts the scored
  text that is not prose fell from 7.5% to 4.3%.
- The PDF reader no longer reads a paper's author list and affiliations as paragraphs of
  its first page: a line with a raised mark after every name or two ("Ann Author¹, Bob
  Writer², …") and one that opens with its mark and names an institution or an address
  ("¹Department of Physics, University of …", "∗Corresponding author: …") are left out,
  where they were read beside the abstract; on the benchmark's development papers the
  scored text that is not prose fell from 3.67% to 3.59%.
- The PDF reader reads a magazine's or a newsletter's page in the order of its columns:
  under a photograph set across the page it read the middle and right columns before the
  left one, and a framed article before the boxes to its left, the lower box before the
  upper. A column is now read before any column it stands left of in the same band of the
  page, and from the top; a paper's pages, which were already read so, do not change. On
  olmOCR-Bench's multi-column pages the passages read in the wrong order fell from 23 to
  4.
- The PDF reader no longer scores the note set under a table ("BC, bounded coalescent; SC,
  standard coalescent; …", "Notes. Columns: (1) …"), which its paragraph engine read as
  body text: a paragraph set smaller than the body, a little way under a table, is read as
  the table's; on the benchmark's development papers the scored text that is not prose
  fell from 3.59% to 3.53%.
- The PDF reader no longer scores code, JSON records and prompts quoted as typed, set in a
  typewriter face, that its paragraph engine read as body text; a document whose
  paragraphs are mostly typed, such as a screenplay or a typed filing, is read as before.
  On the benchmark's development papers the scored text that is not prose fell from 3.53%
  to 3.45%.
- A disk that fills up while the in-browser engine's model downloads stops the download at
  once and says how much room to make, keeping what arrived for Retry, and says so again
  after a restart. Chrome reports a really full disk to it as an odd byte count rather
  than an error, and the download used to retry for half a minute and then say only that
  it had stopped.
- A teaser of another page is no longer read as prose: an excerpt under 75 words that the
  site cut with "…", "[…]" or "… Read more", in a small card titled by a link to that page
  (a blog's related posts, a list of events), got a verdict on a text nobody wrote to end
  there once the minimum length went down to 50 words.
- An author's bio box named the BEM way (`author__bio`, `author-row__bio`,
  `ala-author__description`, `author_desc`) is left out like the `author-box` and
  `author-bio` boxes already were.
- A forum's list of site notices over every thread (XenForo's and vBulletin's "If this is
  your first visit…", "Please be sure to read the rules", a scam alert) is no longer read
  beside the posts; a box named `notices` that holds a paragraph, such as a documentation
  theme's call-out, still is.
- Legal fine print is also recognised by a box named for the legal text it is
  (`copy-legal`, `game_area_legal`, `legal-text`), such as the footnotes under a price
  list or a game's licence terms; a law firm's `legal-services` section is still read.
- The PDF reader finds TeX's ℓ in its own run: Zotero reads it as an "l", and where the
  glyph stood left of its run it was looked for in the word before it, so "the areal ℓ in
  place of" read "the areall in place of", a word of its own that no formula rule could
  take out. On the benchmark's development papers the scored text that is not prose fell
  from 3.45% to 3.44%.
- The PDF reader leaves out the sub- and superscripts that TeX sets in the text's face,
  and the letter they stand under: "the proton injection luminosity L_inj" read
  "luminosity L inj", "above T_N" read "above T N". A word whose letters are all set at a
  script's size (an ordinal's "th" excepted), and the single letter before it, are
  formula; a number, a unit or a year is never touched. On the benchmark's development
  papers the scored text that is not prose fell from 3.44% to 3.33%, and the reader's own
  reflow, which reads the same way, from 16.29% to 16.22%.
- The PDF reader finds the line numbers of a manuscript whose numbers and text Zotero ran
  together: where Word's line numbering is set with a tab, Zotero's reading puts the text
  where the number ends and writes no space, so "21As the basic" and "32smallholder" were
  words and the numbers stayed in the paragraphs. A number that begins a run of Zotero's
  glyphs, before a word, is now a number of its own, counted as a line number on a page
  with 16 of them, and elsewhere where it stands in line with those. On four EarthArXiv
  manuscripts the numbers left in the scored text fell from 919 to 18.
- The PDF reader also finds TeX's ℓ where the run beside it holds no "l" at all ("where ℓ
  cannot be measured" read "wherel cannot be measured", the glyph taking the face of ",
  where"), and reads it as the formula's. On the benchmark's development papers the scored
  text that is not prose fell from 3.334% to 3.327%.
- The PDF reader reads a magazine page's two-column article after its kicker in the order
  of the columns: a headline set across both columns and over half of the right one took
  the right column's paragraphs for its own, and they were read before the left column's.
  A block under a headline is now the headline's column only where it lies within the
  headline's width; no page of a paper in the benchmark reads any differently.

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
