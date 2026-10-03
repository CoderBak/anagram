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
PDF switches), 3. keep Anagram in the toolbar. **Reading the marks** under them shows the
four words, their colours and the scale.

Step 1 decides how Anagram runs its model. Either way the model runs on this computer:

- **On most computers** it runs inside the browser, and its model starts downloading at once:
  1.4 GB, one time, from Hugging Face into the browser's own storage (from its mirror
  hf-mirror.com where Hugging Face cannot be reached, as in mainland China). With Data Saver on, or
  too little disk space, it waits for **Set up (one-time 1.4 GB download)** instead.
- **On an Apple Silicon Mac, or a Windows or Linux PC with an NVIDIA graphics card**, the
  page asks first, and nothing downloads until you pick:
  **One click** runs in the browser as above. **Terminal** asks the browser to let Anagram
  talk to a local engine, then shows one command: run it in Terminal. No administrator
  password or system Python is needed. It installs the engine under `~/.anagram`, registers
  it for this exact extension, and downloads the model files with progress in the terminal
  (`~/.anagram/bin/anagram download` resumes an interrupted download).
- **A computer with less than 4 GB of memory**, or too little free disk space, is told so,
  and nothing is downloaded; with exactly 4 GB it runs, and may slow down while it scores.
  Where the graphics card supports 16-bit maths, that computer, or one short of disk space
  for the full model, gets a lighter version of the model instead (a 715 MB download), whose
  verdicts match the full model's on 99.8% of texts; the setup page and Settings say so.

The in-browser download shows a bar with the percentage, the bytes, time left and speed, with
Pause, Resume and Cancel, and asks you to keep the browser open until it finishes (if the
browser closes, the download carries on the next time Anagram starts); a download that stops
says why, and **Retry** continues where it left off. The model runs on
the graphics card through WebGPU, or on the processor, much more slowly, where the browser
offers no usable GPU. The local engine detects your hardware and loads the best
configuration itself. When step 1 says **Ready**, allow sites in step 2 or as described below.

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

Grant a site with **Run on this site** in the toolbar menu, or allow all sites on the setup
page or in Settings. Without a grant, **Analyze this page** in the toolbar menu scores the
page in front of you once. Google Play Books, Libby and VitalSource Bookshelf show the book
in a frame from a second address, and the switch asks for both; a reader granted with an
older version shows as off until you switch it on again.

- A chip after each paragraph shows the score. Hover it for where the score sits on the
  scale, the four-way breakdown and the word count. Non-English text gets a grey chip
  with the language code.
- The chip and the underline take one colour per word: green for Human, gold for
  Lightly edited, orange for Heavily edited and deep crimson for AI-generated, brighter on
  dark pages. The chip is filled with it; Human's chip and underline are lighter, so a mostly
  human page stays calm. The word follows the number: Human below .17, Lightly edited below .50,
  Heavily edited below .83, AI-generated above. When the word is likely wrong, the card
  names the word it is close to: "Unsure: close to Heavily edited".
- Professionally edited human writing, such as news and magazine articles, often reads
  as Lightly edited. Whether a word is likely wrong comes from a small model fitted on the
  EditLens dataset, which mixes human, edited and AI text; on a page with no AI-edited
  text, Lightly or Heavily edited is called Unsure less often than it should be. The open
  EditLens model is a research baseline: scores are estimates, not proof of authorship, so
  do not use them for disciplinary or other high-stakes decisions.
- On [RAID](https://github.com/liamdugan/raid), a public benchmark of English writing by
  people and by 11 language models in eight genres, 21,000 of its texts were each scored
  whole, as a pasted text. Of 2,400 human texts, 3 (0.1%) read as AI-generated, and about
  1 paragraph in 300 when they were read paragraph by paragraph; 7% read as Lightly or
  Heavily edited, most often arXiv abstracts and book passages. About half of what chat
  assistants wrote read as AI-generated (22% for Cohere's, 72% for ChatGPT's), but only 1%
  of what plain completion models such as GPT-2 wrote; recipes were almost never flagged
  and poems seldom. Changing letter case or adding spaces, zero-width spaces or paragraph
  breaks changed nothing, and British spellings, altered numbers, dropped articles and
  misspellings lowered detection by 2 points at most. Swapping in synonyms lowered it from
  29% to 18%, and paraphrasing with another model to 6%. Text whose letters were replaced
  with look-alike Cyrillic ones gets no verdict: it shows as another language.
- A paragraph needs 50 words to be scored; **Minimum words** in Settings offers 25, 50,
  75, 100 or 150. Shorter paragraphs are scored together with their neighbours in the same
  section, never across a heading; a ×2 on a chip means it covers two paragraphs, and a
  short paragraph with nothing to join is not scored. The open model was trained on texts
  of 75 words or more, so the card of a verdict on fewer says "Short text: less reliable".
  On EditLens test texts cut to length, the word was right for 67% of texts of
  25–49 words, 72% of 50–74 and 79% of 75–149, and 2% of human texts under 75 words read
  as AI-generated, against 0.8% at 75–149 words.
- Only the writing is scored. Reference marks such as [4] or a raised ¹, formulas inside a
  sentence and cookie banners are left out; author–year citations stay. A post the site
  has cut short behind "See more" is read once you open it. A page the browser has
  translated is paused until you show the original, and text a translation extension
  adds is skipped. On review pages each customer review is read by itself, never with
  another one, and the reviewer's name, stars, date and "Helpful" row are left out.
- Text in a frame is read where Anagram may read the frame, an EPUB reader's chapters
  included. Its chips are in the frame; the toolbar menu's counts and list cover the page
  itself.
- Pin Anagram beside the address bar for quick access. Setup shows instructions for
  Chrome, Firefox or Safari; while Anagram is not pinned, **How to keep Anagram in the
  toolbar** at the foot of the toolbar menu opens them again in Settings.
- Click the toolbar icon to open the toolbar menu. It starts with the page in front of
  you: a bar of the paragraphs read, split by colour, with a count for each word; a grey
  line for what was not scored (too short, less reliable, not English, pending,
  unavailable); and the flagged paragraphs. Click one to jump to it; the menu closes so
  you can read the paragraph. Open it again to continue through the list. Below them are
  the page's one main button, such as **Rescan** or **Analyze this page**, the **Run on
  this site** switch, and **Show**: **All chips** or **Flagged only**. The toolbar icon's
  badge shows the flagged count.
- Right-click a selection to score just that text. Alt+Shift+P shows or hides the marks
  on the page, Alt+Shift+L opens the toolbar menu, Alt+Shift+J and K walk flagged
  paragraphs.
- PDFs open in Anagram's reader from the toolbar menu (**Read this PDF**) or a right-click
  on a link; **Read a PDF file…** at the foot of the toolbar menu opens the reader empty,
  and **Analyze text** opens a page for pasted text. You can also drop a file into the
  reader. Local PDFs need "Allow access to file URLs" on the extension's page in
  `chrome://extensions`; the setup page and Settings have a button that takes you there.
  The reader reads the whole document in the background, nearest pages first, so a page's
  chips are there when you scroll to it; how much of the computer it takes follows how fast
  it scores, and on a slow one it reads only the pages around yours until you choose **Read
  the whole document** in the toolbar menu (Settings, PDFs, turns it off).
  The first chips come from a quick reading of each page; a moment later Zotero's document
  engine has worked out the paragraphs, leaving out captions, footnotes and reference
  lists, and the chips are redrawn on those. Past 300 pages every page is read by the
  quick reading alone. A chip stands right after its paragraph's last line, and in the
  page margin only when that line is full. The **Anagram** button in the reader's toolbar
  opens the toolbar menu, whose report is the document read so far, pages scrolled past
  included, and says how many pages that is; a row of its list takes you back to its page.
  Where the browser does not allow opening the menu, the button reads the document. Refreshing a reader tab that
  shows a document keeps it: it is read again from its source.
  On Google Docs, choose **Analyze document** in the toolbar menu to open the reading
  view. The toolbar menu also offers **Close reading mode** or **Back to editor**.

## Settings

The toolbar icon's gear opens Settings, one list of rows.

- **Engine**: its status in words, the switch to the other engine, delete model files and
  when the model is unloaded. The local engine adds update, stop and uninstall. FP32 is
  always the automatic choice; FP16 is used only where FP32 does not fit.
- **Sites**: allow all sites or remove that access, run on granted sites by default, and per-site rules.
- **PDFs**: open PDFs in Anagram automatically, and PDFs on this computer.
- **Marks**: chips on every paragraph or only flagged ones, and underlines.
- **Length**: the minimum words, and grouping short paragraphs.
- **Cache**: how long verdicts are kept, and clearing them.

The engine unloads the model after five minutes without work by default and reloads on demand.
**Source code** in the footer opens the code of the exact version you are running.

## Update and remove

To update the extension, replace the files in the same folder and press Reload on
`chrome://extensions`. Update the local engine from Settings when it asks. Removing the
extension removes the in-browser engine's model files with it.

**Uninstall** in Settings removes the engine, the model files, the browser registration
and then the extension. Removing the extension from Chrome alone leaves the engine on
disk; reinstall the extension to reach Uninstall, or run
`~/.anagram/bin/anagram uninstall`. Keep `~/.anagram` for Anagram only: uninstall removes
everything inside it.

## Privacy

Scoring is local, in either engine; nothing is scored on a server. The engines use the
network only to download the model and, for the local engine, updates.
Opening an online PDF or a Google Doc re-reads that document from its source. See
[PRIVACY.md](../PRIVACY.md) for the full data boundary.
