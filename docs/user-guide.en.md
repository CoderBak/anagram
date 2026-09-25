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

## Read

Grant a site with the switch in the popup, or allow all sites from Settings. Without a
grant, **Analyze this page** in the popup scores the page in front of you once.

- A chip after each paragraph shows the score. Hover it for where the score sits on the
  scale, the four-way breakdown and the word count. Non-English text gets a grey chip
  with the language code.
- The chip's dot and the underline share one colour scale, pale for human writing and
  dark red for AI-generated text. The word follows the number: Human below .17, Lightly
  edited below .50, Heavily edited below .83, AI-generated above. A full dot means the
  model is sure; the more its probabilities spread, the thinner the ring the dot becomes.
- Short paragraphs are scored together with their neighbours; a ×2 on a chip means it
  covers two paragraphs.
- The floating ball shows or hides marks. Its counter opens the list of flagged
  paragraphs, which can jump to each one and copy a report.
- Right-click a selection to score just that text. Alt+Shift+P toggles Anagram on the
  page, Alt+Shift+L opens the list, Alt+Shift+J and K walk flagged paragraphs.
- PDFs open in Anagram's reader from the popup, the floating ball or a right-click on a
  link. You can also drop a file into the reader. Google Docs get a reading view from
  the floating ball.

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
