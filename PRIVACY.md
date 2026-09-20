# Anagram — Privacy Policy

Last updated: 2026-09-20. Applies to the Anagram browser extension for Chrome and for
Firefox, and to the `anagramd` scoring service that runs on your own computer.

**The short version.** Anagram reads the text of pages you have allowed it to read, sends
that text to a program running on your own computer to be scored, and shows the score next
to the paragraph. Nothing is sent anywhere else — the extension is prevented by the
browser from reaching the internet at all. There is no account, no sign-in and no
telemetry, and no text is ever stored.

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

To one place: **a scoring service listening on your own computer**, at
`http://127.0.0.1:<port>` or `http://localhost:<port>`. Paragraph text is sent there to be
scored and the verdict comes back. That request never leaves your machine.

This is not a promise you have to take on trust — **the browser enforces it.** The
extension's manifest declares a Content-Security-Policy whose `connect-src` is the
extension's own origin plus those two loopback hosts, and nothing else:

```
connect-src 'self' http://127.0.0.1:* http://localhost:*
```

So `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` from any page of
the extension or from its background worker can reach the local service and nothing else,
whatever the code asks for. `node test/csp-check.mjs` proves it in a real browser: it tries
all five APIs against a remote address, from an extension page and from the worker, and
requires every attempt to be refused while the local service still answers.

The address is a setting, and the setting is constrained the same way: it accepts only
`http://127.0.0.1[:port]` and `http://localhost[:port]` — no HTTPS, no other host, no
credentials, no path (`lib/settings/settings.ts`, `isLoopbackUrl`). The extension also
refuses to follow a redirect away from that endpoint.

What the extension sends alongside the paragraph text is an id for the current scan, which
browser it is (`chrome-ext` / `firefox-ext`), the page's hostname (for example
`en.wikipedia.org` — never the full URL, never a path or a query), a language hint and a
priority (`lib/contract.ts`, `ScoreBatchRequest`; the hostname comes from
`location.hostname` in `lib/capture/orchestrator.ts`).

The scoring service reaches no network of its own: it loads its model files from disk and
refuses to start without them. The model is downloaded once by the separate installer,
never by the extension.

## What is stored

### Settings, in the browser's extension storage

These are the things you set, in `chrome.storage.local` — nothing is written to
`storage.sync`, so nothing here leaves this browser profile or this computer:

`serverUrl` (the loopback address), `enabled` (the master switch), `siteOverrides` (the
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

### Nothing else

No cookies. No `localStorage`. No Cache Storage. No downloaded files. Nothing at all
outside the browser, except the scoring service's own folder described below.

### The clipboard, when you ask

Three actions copy something to your clipboard and nowhere else: *Copy text* on a chip's
card, *Copy report* in the triage panel, and *Copy page diagnostics*. The diagnostics
report is deliberately **anonymised** — every word of page text is replaced by filler of
the same shape, and URLs, alt text, titles and field values are dropped — so that it
describes the structure of a page without carrying anything anyone wrote. Nothing is
transmitted; it goes to your clipboard for you to paste where you choose.

## What is never collected

- **No account, no sign-in, no identifier.** Anagram has no notion of a user.
- **No telemetry, no analytics, no error or crash reporting, no update check.** Not
  disabled by a setting — impossible, because the extension cannot reach a remote host.
- **No page text, ever stored**, by the extension or by the scoring service.
- **No remote fonts, no remote stylesheets, no remote scripts, no advertising, no
  trackers.** Everything the extension runs is inside the package.
- **Nothing is sold, shared or transferred to anyone.** There is no third party to
  transfer anything to.

## Permissions, and what each is for

| Permission | What it is for |
| --- | --- |
| `storage` | The settings listed above, on this computer. |
| `activeTab` | One-off actions on the tab in front of you, on a site you granted nothing for. Lasts for that one page. |
| `contextMenus` | The right-click entries. |
| `scripting` | Registers the content script for exactly the sites you granted, and injects it for the one-off actions above. Only the extension's own packaged files are injected; no code is downloaded or evaluated. |
| `https://*/*`, `http://*/*` (**optional**) | The sites you choose to let Anagram read. Not held at install; asked for inside your click; revocable. |
| `clipboardWrite` (**optional**, Firefox only) | *Copy page diagnostics*. Asked for the first time you use it. Chrome needs no permission for it. |

**No host permission at all.** Anagram used to require `http://127.0.0.1/*` and
`http://localhost/*` — not to reach the local scoring service, which the policy above
allows in any case, but to *read* what it answered, because the service sent no CORS
headers. It sends them now, and only to extensions (`anagramd/serve.py`), so the permission
bought nothing and cost you the one sentence your browser had to warn you about at install.
Nothing the extension can reach changed: `connect-src` is the same list, and a web page is
still refused outright by the service before the question of reading it arises. The price is
that the service and the extension must move together — if the extension updates and the
service does not, the popup says so and names the one command that fixes it,
`~/.anagram/bin/anagram update`.

## How to remove everything

- **The extension**: remove it from `chrome://extensions` (or `about:addons` on Firefox).
  The browser deletes its storage and its IndexedDB cache with it. To clear the cache
  without uninstalling, use Options → Advanced → *Clear cached verdicts*.
- **The scoring service**: run `~/.anagram/bin/anagram uninstall`. That deletes
  `~/.anagram`, which is the only thing the installer ever created — no system files, no
  launch agent, no shell-profile edits. Uninstalling the extension does not remove it, and
  removing it does not remove the extension.

## Children

Anagram is not directed at children and collects nothing from anybody.

## Changes to this policy

Changes are made in the repository, in this file, and are visible in its history. The
"last updated" date at the top says when it last changed.

## Contact

Questions, or anything on this page that does not match what the code does: open an issue
on the repository's issue tracker, <https://github.com/CoderBak/anagram/issues>.
