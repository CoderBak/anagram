# Anagram

**See what's AI-written, right on the page.** Anagram is a browser extension that labels
every paragraph you read with a small chip — the estimated *extent of AI editing*, from
untouched human writing (0 %) to fully AI-generated text (100 %) — scored by
[EditLens](https://arxiv.org/abs/2510.03154) running **entirely on your own computer**.
Nothing leaves your machine.

## Install

macOS (Apple Silicon recommended) or Linux, one line, no sudo:

```bash
curl -fsSL https://github.com/CoderBak/anagram/releases/latest/download/install.sh | sh
```

That puts **everything** under one folder, `~/.anagram/`, and touches nothing else on your
computer — no system Python, no Homebrew, no PATH or shell-profile edits, nothing that
starts at login:

| `~/.anagram/…` | |
| --- | --- |
| `bin/anagram` | the command below (plus a private `uv`) |
| `python/`, `venv/` | a private Python and the scoring daemon's packages, from a lockfile |
| `app/` | the scoring daemon |
| `extension/` | the browser extension, ready to load |
| `models/` | the EditLens checkpoint (1.4 GB, checksum-verified) and the language model |
| `logs/`, `hf/`, `run/` | logs, model cache, pid file |

About 2 GB in total; a few minutes, mostly the download.

## Use

1. Start the scoring daemon (a background process of your user, listening on `127.0.0.1:8765` only):

   ```bash
   ~/.anagram/bin/anagram start
   ```

2. Load the extension in Chrome: open `chrome://extensions`, switch on **Developer mode**,
   click **Load unpacked** and choose `~/.anagram/extension`.

3. Browse. Chips appear after each analyzed paragraph; hover one for the full readout.
   The popup shows which model is scoring; if the daemon is not running it says so and
   paragraphs wait until it is.

```
anagram start       start the daemon
anagram stop        stop it
anagram status      is it running, which model, how many paragraphs scored
anagram logs        follow the log
anagram selftest    score four sample paragraphs and exit
anagram update      update in place
anagram uninstall   remove ~/.anagram — the only thing the installer ever created
```

Add `~/.anagram/bin` to your `PATH` yourself if you want the bare `anagram` command.

## Uninstall

```bash
~/.anagram/bin/anagram uninstall
```

Then remove the extension from `chrome://extensions`. Nothing else was installed.

## Notes

- **Privacy.** Page text goes from the extension to the daemon on your own machine and
  nowhere else. The daemon accepts connections from `127.0.0.1` only.
- **What the number means.** It is EditLens's estimate of how far a paragraph sits between
  human and AI-generated writing — an estimate, not proof, and not a share of words.
  English only; other languages get a gray chip with the detected language code.
- **Model license.** The EditLens checkpoint is released by Pangram Labs under
  CC BY-NC-SA 4.0 (non-commercial).
- **Options.** `ANAGRAM_HOME=…` installs elsewhere; `ANAGRAM_SKIP_MODEL=1` defers the
  checkpoint download to `anagram model`.

Source code lives on the [`dev`](https://github.com/CoderBak/anagram/tree/dev) branch.
