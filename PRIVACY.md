# Anagram Privacy Policy

Last updated: 2026-09-26. Applies to the Anagram browser extension and the local engine
it installs on your computer.

**The short version.** Anagram reads the text of pages you allow it to read, sends that
text to a program on your own computer, and shows the score next to the paragraph. Page
text never leaves your machine. There is no account, sign-in, analytics or telemetry.
The engine uses the network only to download model files and updates you request.
Opening an online PDF or a Google Doc re-reads that document from its source.

The full inventory of network calls, address literals and storage keys is in
[docs/footprint.md](docs/footprint.md), checked against the code by a test on every run.

## What is read

- **Paragraph text on sites you granted.** Anagram installs with access to no site.
  You grant sites from the popup or Settings and can revoke them there or at
  `chrome://extensions`. Open pages stop immediately when a grant is withdrawn. An e-book
  reader that shows its books from a second address — Google Play Books, Libby, VitalSource
  Bookshelf — is asked for together with that address, in the same browser prompt, because
  the book is in a frame from there.
- **One page, on your click, without a grant.** "Analyze this page", the right-click
  entries and the keyboard shortcuts use the browser's `activeTab` permission. The run
  is bound to that document and ends when you navigate away.
- **A PDF or Google Doc you opened in Anagram.** The original may be fetched again with
  your normal browser credentials so the reader can show it.
- **Text you paste** into the Analyze text page. It is scored locally and not saved.
- **Open tabs' addresses**, in memory, to apply per-site rules and recognize PDFs. No
  browsing history is stored or uploaded.

## Where it goes

To the local engine, over the browser's Native Messaging pipe. The engine is registered
for your exact extension ID and accepts a fixed list of operations, never file paths or
commands from a page. The scoring request carries paragraph IDs and text only: no URL,
no cookies, no account data. Inference runs from files on disk in Hugging Face offline
mode.

The engine runs with your ordinary user privileges. When you install, download models or
request an update, it contacts GitHub releases, the Astral Python and uv distributions,
PyPI, Hugging Face and its file CDN, and the fastText file host. Those requests carry
normal download metadata and never page text.

## What is stored

- **Settings** in `chrome.storage.local`: switches, per-site rules, marking style, scope,
  cache mode, report options, the ball's position. Nothing is synced.
- **The score cache** in IndexedDB, keyed by the model identity plus a 53-bit hash of the
  normalized text. No text is stored. Rows expire after 30 days, the store is capped at
  20 000 rows, and **Clear cached verdicts** in Settings empties it. **Memory only** mode
  keeps scores out of disk entirely. Private windows never write to disk. The hash is
  unsalted, so someone with access to the cache can test guesses about known text.
- **PDF viewer state** (`pdfjs.history`, `pdfjs.preferences`) in the extension's local
  storage: page, zoom and layout for recent documents. No text or password.
- **The local engine** under `~/.anagram` (macOS/Linux) or `%LOCALAPPDATA%\Anagram`
  (Windows): the runtime, model files, the saved configuration and registration records.
  A small registration manifest also lives in the browser's user-level
  NativeMessagingHosts location. Nothing from your browsing is written there.
- **Your clipboard**, only when you click Copy. Diagnostics reports replace every word
  of page text with same-shaped filler and drop URLs and titles.

## Permissions

| Permission | Why |
| --- | --- |
| `nativeMessaging` | Talk to the local engine. |
| `storage` | The settings above. |
| `activeTab` | One-off actions on the page in front of you. |
| `contextMenus` | The right-click entries. |
| `scripting` | Inject the packaged content script into granted sites or the one-off tab. On granted sites a second packaged script runs in the page's own context; it reads nothing and only tells the first when the page attaches a shadow root. |
| `webNavigation`, `webRequest` | Recognize PDF navigations. Reading still requires a grant. |
| `https://*/*`, `http://*/*` (optional) | The sites you choose. Never held at install. |
| `file:///*` (optional) | Open a local PDF already in a tab. Picking a file needs no grant. |

## Removal

**Uninstall** in Settings removes the engine, models and registration, then the extension.
Removing the extension from the browser alone leaves the engine on disk. Uninstall
removes the whole `~/.anagram` directory, including anything you put inside it.

## Contact

Open an issue at <https://github.com/CoderBak/anagram/issues>.
