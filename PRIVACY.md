# Anagram Privacy Policy

Last updated: 2026-10-04. Applies to the Anagram browser extension and to the local engine
it can install on your computer. The extension scores with one of two engines, both on
your computer:

- **The in-browser engine** runs the pinned model inside the browser and installs nothing
  else.
- **The local engine** is a program you install with one terminal command, reached over the
  browser's Native Messaging pipe.

The setup page picks the in-browser engine by itself, or, on a computer where the local
engine is clearly faster, lets you choose; Settings switches between them. Choosing the
device is done in the browser from what it reports about itself (platform, graphics
adapter, memory, free storage) and is not sent anywhere.

The Safari version is Mac-only. Its in-browser engine uses WebGPU without a CPU fallback.
Full Safari app builds also offer the separate local engine on supported Macs, reached
through the app's Native Messaging handler and an XPC service that starts the stdio host.
Safari requires the Native Messaging permission in the app build; declaring it does not
choose or start the local engine. Temporary extensions offer only the browser engine.

**The short version.** Anagram reads the text of pages you allow it to read, scores it on
your own computer and shows the score next to the paragraph. Page text never leaves your
machine, and nothing is ever scored on a server. There is no account, sign-in, analytics or
telemetry. The in-browser engine downloads its model files once and uses the network for
nothing else; the local engine uses the network only to download model files and updates
you request. Opening an online PDF or a Google Doc re-reads that document from its source.

The full inventory of network calls, address literals and storage keys is in
[docs/footprint.md](docs/footprint.md), checked against the code by a test on every run.

## What is read

- **Paragraph text on sites you granted.** Anagram installs with access to no site.
  You grant sites from the popup or Settings and can revoke them there or at
  the browser's extension settings. Open pages stop immediately when a grant is withdrawn. An e-book
  reader that shows its books from a second address — Google Play Books, Libby, VitalSource
  Bookshelf — is asked for together with that address, in the same browser prompt, because
  the book is in a frame from there. In Chrome, frames a granted page writes itself (srcdoc,
  about:blank, blob:) take that page's address and are read with it; sandboxed frames are not.
  Frames that only hold a consent platform's cookie banner are skipped, and a page the
  browser has translated is paused until the original is shown again. A comment thread a
  granted page shows in a frame from another site — Disqus, Facebook's comments plugin,
  utterances, giscus — is read only if that site is granted too: the panel names the site
  and offers to allow it, and its button opens Settings, where your click makes the
  browser's request. Nothing is asked for on its own.
- **Text a document viewer has already put in the page**, on a granted site: Google Drive's
  file preview, a PDF shown by pdf.js inside a page (OneDrive, SharePoint and others),
  Kindle for the web and Webnovel. Nothing is fetched for it, and no page image is captured
  or sent anywhere.
- **One page, on your click, without a grant.** "Analyze this page", the right-click
  entries and the keyboard shortcuts use the browser's `activeTab` permission. The run
  is bound to that document and ends when you navigate away.
- **A PDF or Google Doc you opened in Anagram.** The original may be fetched again with
  your normal browser credentials so the reader can show it.
- **Text you paste** into the Analyze text page. It is scored locally and not saved.
- **Open tabs' addresses**, in memory, to apply per-site rules and recognize PDFs. No
  browsing history is stored or uploaded, unless you turn on reading statistics that keep
  addresses (below), which keeps one on your computer.

## Where it goes

To the engine you use, and to nothing else. The scoring request carries paragraph IDs and
text only: no URL, no cookies, no account data.

- **The in-browser engine** is inside the extension itself: a hidden extension page in
  Chrome, the background page in Firefox, or a pinned engine tab in Safari, running
  ONNX Runtime Web on the model files stored in your
  browser. When it is set up, the extension downloads the pinned model files from Hugging
  Face (`huggingface.co` and its file CDN under `hf.co`), once, or, only when `huggingface.co`
  cannot be reached, from `hf-mirror.com`, a public mirror of the same repositories, each file
  checked against its pinned SHA-256; fastText's language-ID file ships inside the extension. Those requests carry normal download metadata and never page
  text; after them, scoring needs no network.
- **The local engine** is reached over Native Messaging: a registered pipe in Chrome and
  Firefox, or the containing app's XPC-to-stdio bridge in Safari. It accepts a fixed list
  of operations, never file paths or commands from a page. Inference runs from files on
  disk in Hugging Face offline mode. Safari connections are separated by browser profile.

Deciding what to read happens inside the browser, with code that ships in the extension.
The PDF reader finds a document's paragraphs
with Zotero's document-worker, in a worker inside the reader's own tab that loads its
models and data from the extension; the document is not sent anywhere else. On granted
sites a tiny second script runs in the page's own context: it reads nothing and only tells
the content script when the page attaches a shadow root, so text a web component draws
later is read too. What Anagram draws in a page keeps its words from the page: the chips
and the selection card are closed shadow trees the page's scripts cannot read or change,
and no mark is drawn over text inside another component's closed tree. The page can still
see that chips are there, and the marks on its own text.

The local engine runs with your ordinary user privileges. When you install, download models or
request an update, it contacts GitHub releases, the Astral Python and uv distributions,
PyPI, Hugging Face and its file CDN, and the fastText file host. Only when `huggingface.co`
cannot be reached does it fall back to `hf-mirror.com`, a public mirror of the same
repositories, for the same files, each checked against its pinned SHA-256. Where your pip
or uv is set to a package or Python mirror, the installer fetches the packages and Python
from that mirror instead, each file still checked against the locked checksums. Those
requests carry normal download metadata and never page text.

## What is stored

- **Settings** in `chrome.storage.local`: switches, per-site rules, marking style, scope,
  cache mode. Nothing is synced.
- **The score cache** in IndexedDB, keyed by the model identity plus SHA-256 digests of
  where the text was read (the tab's site and the frame's origin) and of the normalized
  text. No text and no site name is stored. A verdict is reused only on the site it was
  read on, so a page cannot tell from how fast a verdict comes back what you read elsewhere,
  and a private window's verdicts are kept apart from the rest. Rows expire after 30 days,
  the store is capped at 20 000 rows, and **Clear cached verdicts** in Settings empties it.
  **Memory only** mode keeps scores out of disk entirely. Private windows never write to
  disk. The digests are unsalted, so someone with access to the cache can test guesses
  about known text and sites.
- **PDF viewer state** (`pdfjs.history`, `pdfjs.preferences`) in the extension's local
  storage: page, zoom and layout for recent documents. No text or password.
- **The local engine** under `~/.anagram` (macOS/Linux) or `%LOCALAPPDATA%\Anagram`
  (Windows): the runtime, model files, the saved configuration and registration records.
  Chrome and Firefox also have a small manifest in their user-level NativeMessagingHosts
  location; Safari keeps its installation receipt inside the engine folder. Nothing from
  your browsing is written there.
- **The in-browser engine's model files**, about 1.4 GB, in the extension's own storage in
  your browser profile. Nothing from your browsing is written with them. They stay when you
  switch to the local engine until you delete them there, in Settings.
- **Which engine you chose**, in `chrome.storage.local`.
- **Reading statistics, only if you turn them on** (Settings, Statistics; off by default), in
  IndexedDB in your browser profile. You choose what they keep: a preset (daily totals; daily
  totals and sites; every page; every paragraph; a research study; the full reading trace,
  with or without the text), or, field by field, how exactly each kind of thing is kept, from
  the most exact to not at all: times; durations; addresses (the full address down to the
  domain, or a salted hash of it); titles; the paragraphs' text (in full, the first twelve
  words, a near-duplicate sketch, a salted hash, or nothing); their lengths, verdicts and
  languages; how pages are built; where paragraphs stand; when each paragraph was on screen
  and how much of it; scrolling; input (clicks and the class of a key; the pointer's position,
  ten times a second, only at the finest choice); when the page was shown and the window
  focused; tabs and windows (random ids for this browser session); how you arrived at a page;
  which engine scored; your use of Anagram's chips, cards and menu; the device; and what could
  not be read, including how long a tab Anagram cannot read was in front (never its address
  or title). [statistics.md](docs/statistics.md) lists every field. Settings warns you where a
  choice keeps a reading history, full addresses, text, or the pointer: anyone who can use this
  browser profile could see them.

  Never recorded, at any choice: anything in a private window; a site you switched Anagram off
  for (not even a page of it you analyzed from the menu); the Analyze text page; what you type
  or which key (only whether it was a reading key, typing or a shortcut); the contents of form
  fields; what you select or copy (only how many characters). The site and the address are
  taken from the browser, not from the page. The salted hashes and sketches are made with a
  random key kept in the extension's storage, never exported, and made anew when you clear the
  statistics. Each part is deleted after the days you choose for it, and **Clear statistics**
  deletes everything. The statistics are never sent anywhere: **Export…** saves a file on your
  computer, no finer than what was kept, at the layers you choose, with ids and hashes keyed
  for that file unless you choose otherwise, and shows you what it holds before you save it;
  whether you share it is up to you. Anagram has no code that uploads it.
- **Your clipboard**, only when you click Copy: a paragraph and its readout from a card, the
  report of the Analyze text page, or a diagnostics report, which replaces every word of
  page text with same-shaped filler and drops URLs and titles.

## Permissions

| Permission | Why |
| --- | --- |
| `offscreen` (Chrome) | Run the in-browser engine in a hidden extension page. |
| `unlimitedStorage` | Keep the in-browser engine's model files without the browser evicting them. |
| `nativeMessaging` (optional, Chrome/Firefox) | Talk to the local engine. Asked for only when you pick it. |
| `nativeMessaging` (Safari) | Check the containing app's bridge and talk to the local engine only when you choose it. |
| `storage` | The settings above. |
| `activeTab` | One-off actions on the page in front of you. |
| `contextMenus` | The right-click entries. |
| `scripting` | Inject the packaged content script into granted sites or the one-off tab, and on granted sites the page-context script described above. |
| `webNavigation`, `webRequest` | Recognize PDF navigations. Reading still requires a grant. |
| `https://*/*`, `http://*/*` (optional) | The sites you choose. Never held at install. |
| `file:///*` (optional, Chrome/Firefox) | Open a local PDF already in a tab. Picking a file needs no grant; Safari uses the picker. |

## Removal

Removing the extension removes the in-browser engine's model files with it. For the local
engine, **Uninstall** in Settings removes the engine, models and registration, then the
extension; removing the extension from the browser alone leaves the engine on disk.
Uninstall removes the whole `~/.anagram` directory, including anything you put inside it.

## Contact

Open an issue at <https://github.com/CoderBak/anagram/issues>.
