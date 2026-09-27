# Anagram user guide

[简体中文](user-guide.zh-CN.md)

## Install

1. Get the Chrome ZIP from the [latest release](https://github.com/CoderBak/anagram/releases).
   Extract it to a folder you will keep. Open `chrome://extensions`, turn on Developer
   mode, click **Load unpacked** and pick that folder. Do not move the folder later; its
   location is part of the extension's identity.
2. The setup page opens. Copy the command it shows and run it in Terminal. No
   administrator password or system Python is needed. The command installs the local
   engine under `~/.anagram`, registers it for this exact extension, and downloads the
   model files with progress in the terminal. If the download is interrupted, run
   `~/.anagram/bin/anagram download` to resume.
3. Go back to the browser. The engine detects your hardware, loads the best
   configuration, and the setup page says **Ready**.

The command shown in a development build is disabled because no matching release
exists for it yet.

Anagram also runs in Firefox 140 or later, ESR included, from its Firefox ZIP, with the
same setup. Firefox keeps an unsigned add-on only in ESR, Developer Edition and Nightly
with `xpinstall.signatures.required` set to false in `about:config`; elsewhere,
`about:debugging` loads it until Firefox restarts.

## Read

Grant a site with the switch in the popup, or allow all sites from Settings. Without a
grant, **Analyze this page** in the popup scores the page in front of you once. Google
Play Books, Libby and VitalSource Bookshelf show the book in a frame from a second
address, and the switch asks for both; a reader granted with an older version shows as
off until you switch it on again.

- A chip after each paragraph shows the score. Hover it for where the score sits on the
  scale, the four-way breakdown and the word count. Non-English text gets a grey chip
  with the language code.
- The chip's dot and the underline share one colour scale, pale for human writing and
  dark red for AI-generated text. The word follows the number: Human below .17, Lightly
  edited below .50, Heavily edited below .83, AI-generated above. A full dot means the
  word is likely right; the less likely, the thinner the ring the dot becomes.
- Professionally edited human writing, such as news and magazine articles, often reads
  as Lightly edited. The dot's likelihood comes from a small model fitted on the EditLens
  dataset, which mixes human, edited and AI text; on a page with no AI-edited text, a dot
  on Lightly or Heavily edited is fuller than it should be. The open EditLens model is a
  research baseline: scores are estimates, not proof of authorship, so do not use them
  for disciplinary or other high-stakes decisions.
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
- The model needs 75 words. Shorter paragraphs are scored together with their neighbours
  in the same section, never across a heading; a ×2 on a chip means it covers two
  paragraphs, and a short paragraph with nothing to join is not scored.
- Only the writing is scored. Reference marks such as [4] or a raised ¹, formulas inside a
  sentence and cookie banners are left out; author–year citations stay. A post the site
  has cut short behind "See more" is read once you open it. A page the browser has
  translated is paused until you show the original, and text a translation extension
  adds is skipped.
- Text in a frame is read where Anagram may read the frame, an EPUB reader's chapters
  included. Its chips are in the frame; the ball's list and report cover the page itself.
- The floating ball shows or hides marks. Its counter shows how many paragraphs read as
  AI-generated and opens their list, which can jump to each one and copy a report. When
  reports include both the page address and passage text, each flagged paragraph in a
  copied report links back to the page, scrolled to it.
- Right-click a selection to score just that text. Alt+Shift+P toggles Anagram on the
  page, Alt+Shift+L opens the list, Alt+Shift+J and K walk flagged paragraphs.
- PDFs open in Anagram's reader from the popup, the floating ball or a right-click on a
  link. You can also drop a file into the reader. The first chips come from a quick
  reading of each page; a moment later Zotero's document engine has worked out the
  paragraphs, leaving out captions, footnotes and reference lists, and the chips are
  redrawn on those. Past 300 pages every page is read by the quick reading alone.
  Google Docs get a reading view from the floating ball.

## Settings

The toolbar icon's gear opens Settings.

- **Local engine**: status, update, delete model files, uninstall. **Advanced** lists
  the configurations that work on this computer, lets you switch, and can run a
  benchmark to compare them. FP32 is always the automatic choice; FP16 is optional.
- **Marks**: whether text is marked in place, and whether chips appear on every
  paragraph or only on flagged ones.
- **Scope**: the whole page, or the main article only.
- **Sites**: grants and per-site rules.
- **Privacy**: score cache retention, clearing, and what copied reports include.

The engine unloads the model after five minutes without work and reloads on demand.
**Source code** in the footer opens the code of the exact version you are running.

## Update and remove

To update the extension, replace the files in the same folder and press Reload on
`chrome://extensions`. Update the local engine from Settings when it asks.

**Uninstall** in Settings removes the engine, the model files, the browser registration
and then the extension. Removing the extension from Chrome alone leaves the engine on
disk; reinstall the extension to reach Uninstall, or run
`~/.anagram/bin/anagram uninstall`. Keep `~/.anagram` for Anagram only: uninstall removes
everything inside it.

## Privacy

Scoring is local. The engine uses the network only to download models and updates.
Opening an online PDF or a Google Doc re-reads that document from its source. See
[PRIVACY.md](../PRIVACY.md) for the full data boundary.
