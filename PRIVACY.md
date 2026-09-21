# Anagram — Privacy Policy

Last updated: 2026-09-21. Applies to the Anagram browser extension for Chrome and for
Firefox, and to the local component that runs on your own computer.

**The short version.** Anagram reads the text of pages you have allowed it to read, sends
that text to a program running on your own computer to be scored, and shows the score next
to the paragraph. Browsing text stays on your computer. There is no account, sign-in or
telemetry, and raw input is not saved by the scoring path. Reading an original PDF or
Google Doc can make a request to its source. Installation, model downloads and requested
component updates also use the network; those downloads do not carry your browsing text.

The source inventory is in [`docs/footprint.md`](docs/footprint.md). Regression tests check
named browser APIs, URL literals and storage keys against that inventory; they are not
a complete audit of every dependency. [Network verification](docs/network-privacy.md)
lists the destinations, exceptions, offline test and monitoring steps you can repeat.

## What is read

- **The text of paragraphs on sites you have granted access to.** Anagram installs able
  to read **no site at all**. You grant sites yourself: every site in one click from the
  first-run page or the options page, or one site at a time from the popup's "This site"
  switch, or none. You can take any grant back from the options page or from
  `chrome://extensions` → *Site access*, and pages you have open stop immediately.
- **The text of one page, on your click, on a site you granted nothing for.** The
  right-click entries (*Analyze this page*, *Analyze selection*, *Copy page diagnostics*),
  the keyboard shortcuts and the popup's *Analyze this page* button work through the
  browser's `activeTab` permission. Anagram binds that one-off run to the current document,
  not just the tab or origin. Reloading or navigating to a new document ends the run, even
  within the same origin; a same-document history change does not. No setting, rule or
  persistent site permission is written.
- **A PDF you opened in Anagram's reading mode**, and **a Google Doc you asked it to
  analyze**. The original document may be fetched again with the browser's normal
  credentials. A local PDF comes from your file selection or the authorized local
  `file:///` document. Google Docs uses the open document's static reading view, whose
  pictures and styles may also refer to original-document resources.
- **Open tabs' current addresses and navigation metadata**, held in memory to apply
  per-site rules and recognize PDF navigation. Browser navigation events can expose a
  tab's address before a website grant; reading its content still requires authorization.
  Response metadata helps identify PDFs where the browser permits that observation.
  This is current-tab routing state, not a persisted or uploaded browsing-history log.
- **Text you paste or explicitly choose as a UTF-8 text file** in the Analyze text page.
  That page needs no website grant and does not save raw input. The same local scoring
  and cache policy apply.

Anagram does not collect interaction analytics or use the browser's bookmarks, history
or cookies APIs. It observes page changes and reading interactions to update its local
interface, and accepts text explicitly entered in its own analysis page. Ordinary browser
requests can include cookies without the extension reading cookie values. Authorized
open tabs can each be analyzed; no browsing-history record is built.

## Where it goes

To **the Anagram local component on your computer**, through the browser's
Native Messaging pipe. The browser starts the registered `dev.coderbak.anagram` host;
its registration permits your exact extension ID. The extension's management bridge
accepts only its own top-level setup and Settings pages and a fixed list of operations,
not arbitrary file paths or shell commands. Page text is used in memory for inference.

There is no HTTP inference endpoint or alternate developer transport. Executable viewer
code, workers, fonts and decoding assets are packaged locally; PDF scripting is disabled.
Ordinary extension pages restrict connections to packaged resources. A private PDF loader
can read the authorized original document, subject to a single-use ticket, current access
and a narrower source policy. The manifest therefore permits document-source connections;
it is not a blanket ban on HTTP, HTTPS or file reads.

Browser policy does not constrain native programs. Native model downloads and user-requested
component updates contact Hugging Face and its file CDN, the fastText download host,
GitHub releases and runtime/package distribution hosts. They transmit ordinary download
metadata, such as the IP address seen by those hosts, but no page text, page hostname,
benchmark results or saved runtime choice. Original-document reads can send the source
URL, normal request headers and cookies to that source. Google Docs rendering may also
request the document's referenced images/style resources. These requests are distinct
from scoring; the original website and browser may make their own unrelated requests.

The scoring wire request carries the contract version, paragraph IDs and text
(`lib/backend/nativeScoreClient.ts`). It does not
include the page's full URL, cookies, browser history or account credentials. The richer
internal page-to-background scan envelope is not forwarded as the native scoring payload.

Inference uses verified files from disk with Hugging Face offline mode and remote model
code disabled. ONNX Runtime telemetry is disabled before its sessions and hardware probes.
Model downloading is a separate operation managed through the extension. The native
program runs with the user's ordinary OS privileges; browser CSP is not an OS sandbox
for it. Once the selected models are installed, fresh scoring works without the internet.

## What is stored

### Settings, in the browser's extension storage

These are the things you set, in `chrome.storage.local` — nothing is written to
`storage.sync`, so nothing here leaves this browser profile or this computer:

`extensionUpdatePending` (a browser update awaiting reload), `enabled` (the master switch), `siteOverrides` (the
per-site on/off rules you wrote, as hostnames), `showHighlights`, `autoOpenPdfs`, `debug`,
`displayMode`, `mergeShorts`, `markStyle`, `analysisScope`, `fabPos` (where you dragged
the floating ball, per hostname), `cacheMode` (persistent or memory only),
`reportIncludeText` and `reportIncludeUrl` (explicit report-export choices), and
`scLegacySwept` (a one-shot housekeeping flag).

### The score cache, in IndexedDB

A database named `anagram-scores`, so that revisiting a page does not re-score it. **No
page text is stored in it.** Each row is keyed by the model's identity plus a 53-bit hash
of the normalized paragraph text (`lib/hash.ts`) — a hash, never the text — and the value
is numbers: the bucket, the four probabilities, the score, a token count, the detected
language code and the time the row was written.
The unsalted hash is not anonymous: someone with cache access can test guesses about
known text. It does not store a readable original paragraph.

- **Retention: 30 days**, counted from when the row was written; revisiting a page does
  not restart the clock.
- **Bounded**: at most 20 000 rows, pruned oldest-first back to 15 000.
- **You can empty it at any time.** Options → Advanced → *Clear cached verdicts* empties
  all three layers (the tab's, the worker's and the database's) and tells you how many
  verdicts are stored next to the button. Pending earlier requests cannot repopulate
  the cache after clearing. A persistent deletion failure is reported, not shown as success.
- **Memory-only mode** deletes saved score rows and prevents new persistent reads or
  writes. Memory can be lost when the browser closes or its background worker restarts.
- **Nothing scored in a private or incognito window is ever written to disk.** Such a tab
  may read the cache, but what it produces stays in the worker's memory and goes when the
  worker does.

Copied reports include scores and technical metadata. Page titles, URLs and excerpts
are excluded by default, with separate opt-ins in Settings; the text-analysis page has
its own original-text checkbox. Clipboard history and exports the user saves are under
the operating system's control and are not removed by clearing Anagram's cache.

### One key in a Google Docs tab's session storage

When you open the Google Docs reading mode, one key is written into that tab's
`sessionStorage` so that "Back to editor" returns you to the exact view you came from.
It lives in that tab and dies with it.

### PDF viewer state, in the extension's local storage

The packaged PDF.js viewer uses `localStorage` for `pdfjs.history`: document fingerprints
and view state such as page, zoom, scroll position, rotation and sidebar layout, for up to
20 documents. It also reads `pdfjs.preferences`; some viewer preference actions may write
that key. Stored preferences cannot override Anagram's viewer safety configuration.
These keys contain no PDF text or password and are not uploaded. A document fingerprint
can nevertheless identify a known PDF to someone with local storage access.

This is separate from the score cache: **Clear cached verdicts** and memory-only scoring
do not erase PDF.js view history or preferences. They remain in browser-managed extension
storage until removed there or with the extension. Signature, comment and editing tools
that would introduce other PDF.js stores are disabled.

### The local component

The default root is `~/.anagram` on macOS/Linux or `%LOCALAPPDATA%\Anagram` on Windows.
It contains the private runtime, application, model weights and incomplete downloads,
saved device/precision choice, benchmark timings and resource measurements, component
preferences, ownership/registration records, and operational state. Built-in benchmark
samples contain no browsing text. These measurements are never uploaded. Browser host
registration also creates a small manifest in its user-level NativeMessagingHosts folder,
or a manifest and HKCU registry pointer on Windows. Exact paths are listed in
[footprint](docs/footprint.md). No system Python, login service or shell-profile edit is
required. Normal installer temporary files and OS/browser logs may also exist.

### The clipboard, when you ask

User-initiated actions copy to your clipboard and nowhere else: the installation
command, *Copy text* on a chip's
card, *Copy report* in the triage panel, and *Copy page diagnostics*. The diagnostics
report is deliberately **anonymised** — every word of page text is replaced by filler of
the same shape, and URLs, alt text, titles and field values are dropped — so that it
describes the structure of a page without carrying anything anyone wrote. Nothing is
transmitted; it goes to your clipboard for you to paste where you choose.

## What is never collected

- **No account, sign-in or analytics user ID.** Local document fingerprints and score
  hashes serve the storage purposes described above; they are not sent as tracking IDs.
- **No telemetry, analytics or remote error reporting.** The browser manages extension
  updates; the local component updates only when requested. Model setup downloads public
  files without uploading browsing data.
- **No raw input persisted by the scoring path.** Explicit clipboard exports and saved
  documents are separate user actions; browser/OS caches and logs are outside this promise.
- **No remotely hosted extension scripts, viewer code, fonts or stylesheets.** Anagram's
  interface assets ship in the extension. This does not block the original website's
  resources, or images/styles belonging to a Google Doc being displayed.
- **Browsing content and model results are never sold or transferred to third parties.**
  Public download hosts receive normal network request metadata during installation or
  updates, as described above.

## Permissions, and what each is for

| Permission | What it is for |
| --- | --- |
| `nativeMessaging` (**required**) | Starts and communicates with the local component for inference, setup, runtime choice and explicit update/cleanup actions. |
| `storage` | The settings listed above, on this computer. |
| `activeTab` | One-off actions on the tab in front of you, on a site you granted nothing for. Anagram binds the run to that document, including on same-origin navigation. |
| `contextMenus` | The right-click entries. |
| `scripting` | Registers the content script for exactly the sites you granted, and injects it for the one-off actions above. Only the extension's own packaged files are injected; no code is downloaded or evaluated. |
| `webNavigation`, `webRequest` | Observes top-level navigation and available response metadata to recognize PDFs; opening/reading a source still requires authorization. No browsing-history log is persisted or uploaded. |
| `https://*/*`, `http://*/*` (**optional**) | The sites you choose to let Anagram read. Not held at install; asked for inside your click; revocable. |
| `file:///*` (**optional**) | Opens an authorized local PDF already in a tab. Chrome also requires its “Allow access to file URLs” switch; browser-specific controls may apply in Firefox. Selecting a file in the reader remains an alternative. |
| `clipboardWrite` (**optional**, Firefox only) | *Copy page diagnostics*. Asked for the first time you use it. Chrome needs no permission for it. |

There is **no required website access**. Native Messaging has its own browser permission
warning. No downloads, management, history, cookies or required tabs permission is added.
File and website grants can be revoked in the browser's extension settings.

## How to remove everything

Use Settings → **Uninstall Anagram completely** before removing the extension. On
macOS/Linux it removes owned model/runtime files and exact native registrations, then
requests browser self-uninstall only after cleanup is confirmed. On Windows a visible
cleanup window waits for open files to be released; after it confirms success, remove the
extension manually. A scheduled operation or disconnected host is never reported as a
completed cleanup.

If you remove the extension directly through Chrome/Firefox, its local browser storage
and IndexedDB are removed, but the native component and models remain: browsers do not
provide a native uninstall hook. Reinstall the same extension to reach cleanup, or use
the component's documented manual uninstall. **Delete model files** in Settings frees
weights without removing the component; a later download requires your action. Manually
downloaded ZIPs and the user-chosen unpacked extension folder are not deleted automatically.
OS/browser logs and filesystem backups are outside this cleanup promise.

## Children

Anagram is not directed at children and collects nothing from anybody.

## Changes to this policy

Changes are made in the repository, in this file, and are visible in its history. The
"last updated" date at the top says when it last changed.

## Contact

Questions, or anything on this page that does not match what the code does: open an issue
on the repository's issue tracker, <https://github.com/CoderBak/anagram/issues>.
