# Anagram user guide

[简体中文](user-guide.zh-CN.md)

## Install

**Safari on Mac:** the Safari build requires Safari 27+. **One click** uses WebGPU inside
the browser; keep its pinned Anagram engine tab open while analyzing. A full Safari app
build also offers the optional **Terminal** engine on Apple Silicon, with the same Settings
switch as Chrome and Firefox. Temporary extensions offer only the browser engine, which
requires a compatible GPU and never falls back to CPU inference. Open local PDFs with the
reader's file picker. This version is awaiting real-Mac verification; see
[Development](DEVELOPMENT.md#safari) for packaging and verification steps.

Download **anagram-chrome-&lt;version&gt;.zip** from the
[latest release](https://github.com/CoderBak/anagram/releases) (Chrome 137 or later); the
other files there are the optional local engine, which its installer fetches itself. Extract
it to a folder you will keep. Open `chrome://extensions`, turn on **Developer mode** (top
right), click **Load unpacked** and pick that folder. Do not move the folder
later; its location is part of the extension's identity.

The setup page opens with three numbered steps, and each number turns into a tick when its
step is done: 1. set up the engine, 2. where Anagram reads (**Allow all sites** and the two
PDF switches), 3. keep Anagram in the toolbar. One step is open at a time, the first one not
done; click a step's title to open or close it. **Reading the marks** under them shows the
three authorship classes with their colours and example scores.

Step 1 decides how Anagram runs its model. Either way the model runs on this computer:

- **On most computers** it runs inside the browser, and its model starts downloading at once:
  1.58 GB, one time, from Hugging Face into the browser's own storage (from its mirror
  hf-mirror.com where Hugging Face cannot be reached, as in mainland China). With Data Saver on, or
  too little disk space, it waits for **Download model (1.58 GB)** instead.
- **On an Apple Silicon Mac, or a Linux PC with an NVIDIA graphics card**, the
  page asks first, and nothing downloads until you pick:
  **One click** runs in the browser as above. **Terminal** asks the browser to let Anagram
  talk to a local engine. Open **View command** to see what you would run. **Copy command** copies it to your clipboard.
  **Read installer source** opens the script that ships with your extension. You can read it offline before granting permission. To install, paste the command into Terminal and press Enter. Setup detects the engine when you return. The command runs the
  installer only if it is the very file this extension was built with. No administrator
  password or system Python is needed. It installs the engine under `~/.anagram`, registers
  it for this exact extension, and downloads the model files with progress in the terminal
  (`~/.anagram/bin/anagram download` resumes an interrupted download). Where pip or uv is
  set to a mirror (`PIP_INDEX_URL`, `UV_DEFAULT_INDEX`, `pip.conf`, `uv.toml`,
  `UV_PYTHON_INSTALL_MIRROR`), the command downloads the packages and Python from it, still
  checking each file against the locked checksums, and goes back to the original source if
  the mirror fails.
- **A computer with less than 4 GB of memory**, or too little free disk space, is told so,
  and nothing is downloaded; with exactly 4 GB it runs, and may slow down while it scores.

The in-browser download shows a bar with the percentage, the bytes, time left and speed, with
Pause, Resume and Cancel, and asks you to keep the browser open until it finishes (if the
browser closes, the download carries on the next time Anagram starts); a download that stops
says why, and **Retry** continues where it left off. The model runs on
the graphics card through WebGPU, or on the processor, much more slowly, where the browser
offers no usable GPU. The terminal engine uses ONNX Runtime on the CPU. When step 1 says **Ready**, allow sites in step 2 or as described below.

Settings switches between the two engines later. Switching to the local engine keeps the
in-browser engine's model files until you delete them there. If the local engine keeps
stopping unexpectedly, the setup page and the toolbar menu offer the in-browser engine
beside Retry.

The command shown in a development build is disabled because no matching release exists
for it yet.

Anagram also runs in Firefox 153 or later, ESR included, from its Firefox ZIP. Firefox keeps an
unsigned add-on only in ESR, Developer Edition and Nightly with
`xpinstall.signatures.required` set to false in `about:config`; elsewhere, `about:debugging`
loads it until Firefox restarts.

## Read

Grant a site with **Scan this site automatically** in the toolbar menu, or allow all sites on the setup
page or in Settings. Without a grant, **Analyze this page** in the toolbar menu scores the
page in front of you once. Google Play Books, Libby and VitalSource Bookshelf show the book
in a frame from a second address, and the switch asks for both; a reader granted with an
older version shows as off until you switch it on again.

- A chip shows the dominant authorship class. Hover over it to see the shares of text labeled human, AI-assisted and AI-generated. The score adds the AI-generated share and half the AI-assisted share. Expand **Sentence labels** to see the classifications in reading order. On mixed passages, underlines follow the aligned sentences. For a passage read in overlapping passes, each pass has its own numbered list.
- The current release assesses English prose with at least 50 words. Anagram groups short neighboring paragraphs from the same voice when possible.
- Under **Settings → Paragraph marks**, choose whether to flag AI-generated paragraphs alone or include AI-assisted paragraphs.

- Only the writing is scored. Reference marks such as [4] or a raised ¹, formulas inside a
  sentence and cookie banners are left out; author–year citations stay. A post the site
  has cut short behind "See more" is read once you open it. A page the browser has
  translated is paused until you show the original, and text a translation extension
  adds is skipped. On review pages each customer review is read by itself, never with
  another one, and the reviewer's name, stars, date and "Helpful" row are left out.
- Text in a frame is read where Anagram may read the frame, an EPUB reader's chapters
  included. Its chips are in the frame; the toolbar menu's counts and list cover the page
  itself.
- To pin Anagram beside the address bar, follow the steps for your browser in Setup.
- Open the toolbar menu to see the flagged paragraphs on the current page. Click a passage
  to jump to it, or select **Rescan** to read the page again. **Score breakdown** shows the
  verdict counts and coverage details. Use **Scan this site automatically** to apply the same choice on future visits.
  Choose which paragraphs show score labels under **Paragraph marks** in Settings.
  The toolbar icon shows the flagged count.
- Right-click a selection to score just that text. Alt+Shift+P shows or hides the marks
  on the page, Alt+Shift+L opens the toolbar menu, Alt+Shift+J and K walk flagged
  paragraphs.
- PDFs open in Anagram's reader from the toolbar menu (**Read this PDF**) or a right-click
  on a link; **Open a PDF…** at the foot of the toolbar menu opens the reader empty,
  and **Analyze text** accepts English text of at least 50 words. Blank lines separate paragraphs.
  The headline gives the overall verdict. Expand **Score breakdown** for the class shares.
  When the detector gives different sentences different labels, each marked sentence uses its
  own label’s color. **Paragraph marks** in Settings controls which underlines appear. To read a file from your computer,
  choose it in the reader or drop it onto the page. **Open** lets you switch files, and
  **Save** downloads the current PDF with its filename. In narrow windows, look in the
  reader’s **Tools** menu for actions that do not fit. To open local PDF links automatically,
  enable **PDFs on this computer** (the setup page or Settings) and
  Chrome's own "Allow access to file URLs" on the extension's page in `chrome://extensions`,
  which no extension can turn on: while it is off, turning the switch on opens that page.
  The reader reads the whole document in the background, nearest pages first, so a page's
  chips are there when you scroll to it; how much of the computer it takes follows how fast
  it scores, and on a slow one it reads only the pages around yours until you choose **Read
  the whole document** in the toolbar menu (Settings, PDFs, turns it off).
  The first chips come from a quick reading of each page; a moment later Zotero's document
  engine has worked out the paragraphs, leaving out captions, footnotes and reference
  lists, and the chips are redrawn on those. A document of up to 2,500 pages is worked out
  whole; past 600 pages on a computer with 4 GB of memory, and past 300 where the browser does
  not say how much it has (Firefox, Safari), the toolbar menu first offers **Read the whole
  document**, and until you choose it each page is read by the quick reading as you reach it.
  For image-only scans, open a copy saved with text recognition (OCR).
  For longer PDFs, or when structured reading is unavailable or switched off, choose
  **Read the whole document** to analyze unseen pages with the quick reader. The menu
  reports any pages it could not read and offers to retry them. A chip stands right after its paragraph's last line, and in the
  page margin only when that line is full. The **Anagram** button in the reader's toolbar
  opens the toolbar menu, whose report is the document read so far, pages scrolled past
  included, and says how many pages that is; a row of its list takes you back to its page.
  Where the browser does not allow opening the menu, the button reads the document. Refreshing a reader tab that
  shows a document keeps it: it is read again from its source.
  On Google Docs, choose **Analyze document** in the toolbar menu to open the reading
  view. The toolbar menu also offers **Close reading mode** or **Back to editor**.

## Settings

**Settings** in the toolbar menu opens the settings page. The section index jumps to each
section. In a narrow window, open it with **Jump to**. Changes save automatically.

- **Websites** controls website access, automatic scanning and per-site rules.
- **PDFs** controls automatic opening, background reading and access to files on this computer.
- **Paragraph marks** controls which ratings to flag, which paragraphs show score labels and which receive underlines.
- **Reading history** lets you choose what to record and how long to keep it. Recording is off by default.
- **Saved scores** uses memory by default. Choose **Keep 30 days** to reuse website scores after a restart. Analyze text always keeps its scores in memory.
- **Engine and models** shows the active engine and detector. Use **Manage** to switch engines or change when a model unloads. **Check for models** lists detector releases. The link beside the selection opens its exact revision on Hugging Face. The local engine also supports update, stop and uninstall.

The engine unloads the model after five minutes without work by default and reloads on demand.
**Source code** in the footer opens the code of the exact version you are running.

## Statistics

The default headline is the estimated AI-generated share of scored reading. Under **How it counts**, choose **AI-assisted or AI-generated** to include both. Dates with older readings also offer the historical heavy-editing measure.

Anagram can keep a record of how much of what you read reads as AI-generated. It is off until
you choose what to keep, in Settings under Reading history (the menu explains what the selected choice keeps), or
on the statistics page:

- **Daily totals**: each day's words read, how they read from human to AI-generated, and on
  what kind of page (feeds, articles, forums, documents, other).
- **Daily totals and sites**: the same, and each site's share of the day.
- **Every page**: the same, and each page you read, with its address, title, when you first
  read it and for how long. This is a reading history.
- **Every paragraph**: each visit and each paragraph you read, its length, verdict and time on
  screen, and a salted hash of its text to tell when you read it again. No addresses, no text.
- **Research study**: every visit, paragraph and scroll, timed to a tenth of a second, with
  domains but no addresses and no text: what a study of reading asks for.
- **Full reading trace**, with or without the text: everything, to the millisecond, the
  pointer's track included.

A choice made field by field in an earlier version shows as **Your own**. Below the menu,
Settings explains what someone with access to this browser profile could see. Open **Retention periods**
to change how long to keep detailed events (7, 30 or 90 days), paragraphs and visits (30, 90 or 365 days),
or daily totals (a year or until cleared). Choosing to keep less asks
whether to delete what the new choice would not have kept; it stays unless you say so.

Never kept, whatever you choose: anything in a private window, on a site you switched Anagram
off for, or in Analyze text; what you type; what you select or copy.

A paragraph counts as read once it has been on screen for a second with some of it in the
middle of the window, and once per visit however often you scroll back to it. The share shown uses expected words. A passage with both human and AI-generated sentences contributes to each class in proportion to its labeled text. Daily totals support changing the headline and choosing the chip or most likely verdict. Where
paragraphs are kept, **How it counts** on the statistics page counts them another way: after
another time on screen, by how much of a paragraph was shown, in a focused window only, once a
day or once ever, and by paragraphs or time. If some history has only totals, the page shows how many baseline words the new rule leaves out.

The statistics page opens to the last seven days. The toolbar’s **Today** link opens the current day.
Select the displayed dates to choose a month or a custom range. **Reading activity** shows the
scored total and daily volume. Choose **Share** to compare verdict percentages on days with
different volumes. Select a bar or a date in **View table** to inspect that day. **Back to range** restores the period.
**Verdict distribution** shows the selected period’s shares. **Scoring details** includes
coverage and skipped text. **Reading breakdown** offers tabs for the detail your settings recorded,
including sites, page types, pages and visits. Selecting a site filters the report. Select **Show all** to clear the filter.
Under **Visits**, open **Visit details** for the furthest point shown on the page and the number of passages that came into view or appeared more than once. The facts depend on what the visit recorded. Expand **Reading timeline** to see the saved visibility intervals and scroll positions. With a site selected, the export includes that site by default. Choose **All sites** in the export dialog to include the others. **Export…** saves a file of the
period. Each export starts with paragraph text and excerpts excluded, including when you recorded them. You can include them for an individual file. It exports each kind of thing at the layer you choose (field
by field if you like, addresses and titles as salted hashes), as JSON or as CSV tables in a zip,
and shows you what it holds first. Its ids and hashes are that file's own unless you choose
to make them the same in every file (a study that collects several of your files asks for
that). Anagram never uploads it. [statistics.md](statistics.md) describes the file.
**Clear statistics** deletes everything.

## Update and remove

When the browser has an extension update ready, select **Apply extension update** at the top of Setup or Settings.
For an unpacked Chrome extension, replace the files in the same folder and press Reload on
`chrome://extensions`. When the installed local engine is older, Settings shows both versions.
Select **Update engine** there. Settings confirms the new version after the engine reconnects. Removing the
extension removes the in-browser engine's model files with it.

**Uninstall** in Settings removes the engine, the model files, the browser registration
and then the extension. Removing the extension from Chrome alone leaves the engine on
disk; reinstall the extension to reach Uninstall, or run
`~/.anagram/bin/anagram uninstall`. On Windows, run this in Command Prompt:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Anagram\app\maintenance.ps1" -Operation uninstall -ComponentHome "%LOCALAPPDATA%\Anagram"
```

The same command finishes an uninstall that stopped partway, for example because a file was
in use. Keep `~/.anagram` (`%LOCALAPPDATA%\Anagram` on Windows) for Anagram only: uninstall
removes everything inside it.

## Privacy

Scoring is local, in either engine; nothing is scored on a server. The engines use the
network only to download the model and, for the local engine, updates.
Opening an online PDF or a Google Doc re-reads that document from its source. The reading
statistics, when you turn them on, stay in this browser profile. See
[PRIVACY.md](../PRIVACY.md) for the full data boundary.
