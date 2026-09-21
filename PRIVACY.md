# Anagram — Privacy Policy

Last updated: 2026-09-21. Applies to the Anagram browser extension for Chrome and for
Firefox, and to the local component that runs on your own computer.

**The short version.** Anagram reads the text of pages you have allowed it to read, sends
that text to a program running on your own computer to be scored, and shows the score next
to the paragraph. Browsing text stays on your computer. There is no account, sign-in or
telemetry, and page text is not persisted. Installing models and updating the local
component downloads public files; those requests do not carry your browsing text.

Every claim on this page is checkable in the source. The full inventory — every network
call site, every address written into the code, every stored key — is
[`docs/footprint.md`](docs/footprint.md), and a test reads that page against the sources
on every test run, so it cannot quietly drift away from the code.

## What is read

- **The text of paragraphs on sites you have granted access to.** Anagram installs able
  to read **no site at all**. You grant sites yourself: every site in one click from the
  first-run page or the options page, or one site at a time from the popup's "This site"
  switch, or none. You can take any grant back from the options page or from
  `chrome://extensions` → *Site access*, and pages you have open stop immediately.
- **The text of one page, on your click, on a site you granted nothing for.** The
  right-click entries (*Analyze this page*, *Analyze selection*, *Copy page diagnostics*),
  the keyboard shortcuts and the popup's *Analyze this page* button work through the
  browser's `activeTab` permission: your click gives the extension access to that one tab,
  it ends when the tab navigates, and no setting, rule or permission is written.
- **A PDF you opened in Anagram's reading mode**, and **a Google Doc you asked it to
  analyze**. In both cases the document is the one already open in front of you; the
  extension re-reads it from the same address, on the same origin, with the browser's own
  cookies, and never modifies it.
- **The current tab's address**, held in memory only, to decide which of your per-site
  rules applies and whether the tab is one the extension may still read. No list of pages
  you visited is built, kept or sent.

Anagram reads nothing else. It does not read forms, does not record clicks, mouse
movement, scrolling or keystrokes, does not read or write cookies, and does not read your
bookmarks, your history or the contents of other tabs.

## Where it goes

To **the Anagram local component on your computer**, through the browser's
Native Messaging pipe. The browser starts the registered `dev.coderbak.anagram` host;
its registration permits your exact extension ID. The extension's management bridge
accepts only its own top-level setup and Settings pages and a fixed list of operations,
not arbitrary file paths or shell commands. Page text is used in memory for inference.

There is no HTTP inference endpoint or alternate developer transport. The extension's
web requests are restricted by:

```
connect-src 'self'
```

This policy does not constrain native programs. Native model downloads and user-requested
component updates contact Hugging Face and its file CDN, the fastText download host,
GitHub releases and runtime/package distribution hosts. They transmit ordinary download
metadata, such as the IP address seen by those hosts, but no page text, page hostname,
benchmark results or saved runtime choice. Same-origin re-reads of the open Google Doc or
PDF are made with the browser's normal cookies; the extension never reads those cookies.

The scoring wire request carries the contract version, paragraph IDs and text
(`lib/backend/nativeScoreClient.ts`). It does not
include the page's full URL, cookies, browser history or account credentials. The richer
internal page-to-background scan envelope is not forwarded as the native scoring payload.

Inference uses verified files from disk with Hugging Face offline mode. Model downloading
is a separate operation managed through the extension. The native program runs with the
user's ordinary OS privileges; browser CSP is not an OS sandbox for it.

## What is stored

### Settings, in the browser's extension storage

These are the things you set, in `chrome.storage.local` — nothing is written to
`storage.sync`, so nothing here leaves this browser profile or this computer:

`extensionUpdatePending` (a browser update awaiting reload), `enabled` (the master switch), `siteOverrides` (the
per-site on/off rules you wrote, as hostnames), `showHighlights`, `autoOpenPdfs`, `debug`,
`displayMode`, `mergeShorts`, `markStyle`, `analysisScope`, `fabPos` (where you dragged
the floating ball, per hostname), and `scLegacySwept` (a one-shot housekeeping flag).

### The score cache, in IndexedDB

A database named `anagram-scores`, so that revisiting a page does not re-score it. **No
page text is stored in it.** Each row is keyed by the model's identity plus a 53-bit hash
of the normalized paragraph text (`lib/hash.ts`) — a hash, never the text — and the value
is numbers: the bucket, the four probabilities, the score, a token count, the detected
language code and the time the row was written.

- **Retention: 30 days**, counted from when the row was written; revisiting a page does
  not restart the clock.
- **Bounded**: at most 20 000 rows, pruned oldest-first back to 15 000.
- **You can empty it at any time.** Options → Advanced → *Clear cached verdicts* empties
  all three layers (the tab's, the worker's and the database's) and tells you how many
  verdicts are stored next to the button.
- **Nothing scored in a private or incognito window is ever written to disk.** Such a tab
  may read the cache, but what it produces stays in the worker's memory and goes when the
  worker does.

### Two keys in a tab's own session storage

When you open the Google Docs reading mode, one key is written into that tab's
`sessionStorage` so that "Back to editor" returns you to the exact view you came from.
The PDF reading mode writes one of its own, holding the address of a PDF it has already
sent you back to, so a file it cannot read cannot bounce the tab back and forth. Each
lives in its tab and dies with it.

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

- **No account, no sign-in, no identifier.** Anagram has no notion of a user.
- **No telemetry, analytics or remote error reporting.** The browser manages extension
  updates; the local component updates only when requested. Model setup downloads public
  files without uploading browsing data.
- **No page text, ever stored**, by the extension or by the scoring service.
- **No remote fonts, no remote stylesheets, no remote scripts, no advertising, no
  trackers.** Everything the extension runs is inside the package.
- **Browsing content and model results are never sold or transferred to third parties.**
  Public download hosts receive normal network request metadata during installation or
  updates, as described above.

## Permissions, and what each is for

| Permission | What it is for |
| --- | --- |
| `nativeMessaging` (**required**) | Starts and communicates with the local component for inference, setup, runtime choice and explicit update/cleanup actions. |
| `storage` | The settings listed above, on this computer. |
| `activeTab` | One-off actions on the tab in front of you, on a site you granted nothing for. Lasts for that one page. |
| `contextMenus` | The right-click entries. |
| `scripting` | Registers the content script for exactly the sites you granted, and injects it for the one-off actions above. Only the extension's own packaged files are injected; no code is downloaded or evaluated. |
| `https://*/*`, `http://*/*` (**optional**) | The sites you choose to let Anagram read. Not held at install; asked for inside your click; revocable. |
| `clipboardWrite` (**optional**, Firefox only) | *Copy page diagnostics*. Asked for the first time you use it. Chrome needs no permission for it. |

There is **no required website access**. Native Messaging has its own browser permission
warning. No downloads, management, history, cookies or required tabs permission is added.

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
