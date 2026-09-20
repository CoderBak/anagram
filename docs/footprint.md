# Anagram's footprint

What this extension touches, in full: every place it can send a byte, every place it keeps
one, and everything it asks the browser for. It is written for somebody auditing the
extension before installing it — or before putting it in a shop — so it lists the code,
not the intentions.

`test/node/footprint.test.ts` reads this page and checks it against the source on every
`vitest` run. A network call added anywhere in `lib/` or `entrypoints/` that is not written
down here fails that test, and so does a line here whose call site has gone. The page and
the code cannot drift apart without somebody noticing.

## Network

**Anagram cannot reach the internet, and the browser is what stops it.** `wxt.config.ts`
declares a Content-Security-Policy for the extension's own pages and its service worker:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self';
connect-src 'self' http://127.0.0.1:* http://localhost:*;
img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline';
worker-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'
```

`connect-src` is the line that matters. `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource` and `sendBeacon` from an extension page or from the service worker can reach
the extension's own origin, the loopback daemon and a file on this computer — nothing else,
whatever the code asks for and whatever host permission the extension holds. That is
measured rather than asserted: `test/csp-check.mjs` makes a page and the worker reach for
`https://example.com` over all five APIs, in Chrome and in Firefox, and requires every one
of them to be refused while the daemon still answers.

Two things the policy does **not** cover, stated so the picture is complete:

- **Content scripts** run under the *page's* policy, not this one. Two of the call sites
  below are in one: the same-origin re-read of the Google Doc the tab is already showing,
  and the `import()` of our own vendored chunks. A third one added tomorrow would not be
  stopped by the CSP, which is why the inventory below is enforced by a test rather than
  left to the policy alone.
- **The daemon URL** is a setting, and a setting can be edited. `lib/settings/settings.ts`
  refuses anything but `http://127.0.0.1:<port>` and `http://localhost:<port>` — no https,
  no IPv6, no other `127.x.y.z`, no path or credentials — which are exactly the two spellings
  the CSP can express, so the setting and the policy have to agree before a request leaves
  at all.

Since 2026-09-20 the extension holds **no host permission for the daemon either**. It used
to require `http://127.0.0.1/*` and `http://localhost/*` — not to reach the daemon, which
`connect-src` allows anyway, but to READ its answers, because the daemon sent no CORS
headers. The daemon sends them now, for extension origins only (`anagramd/serve.py`), so
scoring is an ordinary cross-origin request that the daemon chooses to answer. Nothing about
what the extension can reach changed: `connect-src` is the same list it was, and a web page
is still refused 403 by the daemon's Origin guard before CORS is ever considered. What
changed is that installing Anagram now warns about nothing at all — and that a daemon older
than the extension cannot answer it, which the pages say plainly and fix with
`~/.anagram/bin/anagram update`.

### Every call site

| File | Call | What it is for | Where it goes |
| --- | --- | --- | --- |
| `lib/backend/httpClient.ts` | `fetch(` | `GET /health` — is the daemon up? | the loopback daemon |
| `lib/backend/httpClient.ts` | `fetch(` | `POST /score` — the paragraphs to be scored | the loopback daemon |
| `lib/backend/httpClient.ts` | `fetch(` | `GET /health` again, in `no-cors` mode, only when the one above never came back: is ANYTHING listening there? It sends a bodyless GET with credentials omitted and reads nothing — an opaque response cannot be read — so that it answered at all is the whole result, and it is what tells a closed port from a daemon too old to answer this extension | the same loopback daemon |
| `lib/docsOverlay.ts` | `fetch(` | re-reads the Google Doc the tab is already showing, in its `mobilebasic` rendering, because a Docs canvas has no text in the DOM to read | the same origin as the tab, with the reader's own cookies |
| `lib/pdf/handoff.ts` | `fetch(` | re-reads, from the content script in a PDF tab, the document that tab is already showing, so the reading mode can be handed its bytes instead of fetching them | the same URL the tab is already showing, same-origin, normally answered from the HTTP cache |
| `lib/lazy.ts` | `import(` | loads one of the vendored chunks that ship inside the extension (Readability, DOMPurify, the diagnostics chunk, pdf.js) | `chrome-extension://<this extension>/vendor/…` |

Nothing else in `lib/` or `entrypoints/` calls a network API. There is no `XMLHttpRequest`,
no `WebSocket`, no `EventSource`, no `sendBeacon`, no `importScripts`, no telemetry, no
analytics, no error reporting, no update check, no remote font and no remote stylesheet.

Until 2026-09-20 there were two more, and both are gone.

The service worker asked `arxiv.org` whether a paper had an HTML rendering, so that an
arXiv PDF could open as the paper instead of as its PDF. It was the extension's only remote
request. "Open in Anagram" on a PDF now opens that PDF.

And the reading mode fetched its own `?src=` — an extension page asking the open web for a
document, with the reader's cookies. **How a remote PDF's bytes reach the reading mode
now:** the tab that is showing the PDF re-reads its own document (`lib/pdf/handoff.ts`,
the row above) — same URL, same origin, same cookies, `cache: "force-cache"`, so the
browser's own cache normally answers and nothing goes out at all — and streams it to the
service worker a chunk at a time, stopping at 50 MB and refusing anything whose first bytes
are not `%PDF-`. The worker holds those bytes under a one-time ticket, bound to that one
tab, and navigates the tab to the reading mode, which pulls them and frees the ticket. The
`?src=` in the reading mode's address is a NAME from then on — the title, "Open original",
the HTML link — and nothing of ours ever fetches it. `connect-src` above is what makes that
a rule rather than a promise: the reading mode could not fetch a remote address if it tried.

A PDF on this computer (`file://`) cannot come in that way: nothing declares access to the
file scheme, and a page on it may not re-read itself in any case. Such a PDF is opened by
dropping it on the reading mode, which is a file the reader hands over rather than one
anything here went and got.

### Every address written in the source

`lib/` and `entrypoints/` hold these `http://` and `https://` literals and no others —
stylesheets included, since an `@import` or a webfont is a remote host as much as a
`fetch` is.

| File | URL | Why |
| --- | --- | --- |
| `lib/settings/settings.ts` | `http://127.0.0.1` | the default daemon address, whose port is interpolated; and, with and without a port, the examples in the comment that explains what the validator accepts |
| `lib/settings/settings.ts` | `http://localhost` | the second spelling the validator accepts, in that same comment |
| `lib/settings/settings.ts` | `http://127.0.0.2:8765` | an example in that comment of a loopback address the validator REFUSES |
| `lib/settings/settings.ts` | `http://[::1]:8765` | the same, for the IPv6 spelling |
| `lib/settings/settings.ts` | `https://localhost:8765` | the same, for a scheme that is not `http:` |
| `lib/settings/settings.ts` | `http://$` | the accepted URL rebuilt from its own parsed host and port, so only the two shapes above can come out |
| `lib/access/patterns.ts` | `http://localhost/*` | an example in the comment that explains why a match pattern carries no port. Nothing asks for it: the extension requires no host |
| `lib/access/patterns.ts` | `https://*/*` | the OPTIONAL site access the reader may grant, and which the extension installs without |
| `lib/access/patterns.ts` | `http://*/*` | the same, for plain http |
| `entrypoints/options/index.html` | `http://127.0.0.1:8765` | the same address, as the field's placeholder |
| `lib/pdf/source.ts` | `https://arxiv.org/html/` | builds the address of an arXiv paper's HTML rendering. Nothing fetches it; it is offered as a link somebody may follow |
| `lib/docs.ts` | `https://docs.google.com/document/d/` | builds the address of the document the tab is on |
| `lib/docsOverlay.ts` | `https://docs.google.com/document/d/` | the same address, for the same-origin read above |
| `entrypoints/onboarding/index.html` | `https://github.com/CoderBak/anagram/releases/latest/download/install.sh` | shown as text in the install command a reader copies; nothing fetches it |
| `lib/ui/basecoat-vega.cdn.min.css` | `http://www.w3.org/2000/svg` | the SVG namespace, inside `url("data:image/svg+xml,…")` icons. A namespace is a name, not an address: nothing fetches it |
| `lib/ui/basecoat-vega.cdn.min.css` | `https://tailwindcss.com` | the licence banner of the vendored Basecoat (Vega) stylesheet |
| `lib/diagnostics/anonymise.ts` | `https://schema.org/Article` | an example in a comment about `itemtype` vocabularies |
| `entrypoints/options/main.ts` | `https://www.Example.com/path` | an example in a comment about parsing a hostname out of what was typed |
| `entrypoints/options/main.ts` | `https://` | the scheme prepended to a bare hostname before `new URL()` parses it |

## Storage

### `chrome.storage.local`

Settings only — every one of them something the reader set — and one housekeeping flag.
Nothing is written to `storage.sync`, `storage.session` or `storage.managed`, so nothing
here leaves this profile or this computer.

| Key | What it holds |
| --- | --- |
| `serverUrl` | the daemon's address; loopback only |
| `enabled` | the master switch |
| `siteOverrides` | per-site on/off rules, as hostnames the reader chose |
| `showHighlights` | whether analyzed text is marked in place |
| `autoOpenPdfs` | whether a PDF tab opens in the reading mode by itself |
| `debug` | verbose logging |
| `displayMode` | mark everything, or only flagged paragraphs |
| `mergeShorts` | group short paragraphs to reach the 50-word floor |
| `markStyle` | how a mark is drawn: quiet, or always on (a profile written before this build may still hold one of the three styles those replaced) |
| `analysisScope` | the whole page, or its main content |
| `fabPos` | where the reader dragged the ball, per hostname |
| `scLegacySwept` | a one-shot flag: the pre-IndexedDB score cache has been cleaned out |

### IndexedDB — `anagram-scores`

The persistent score cache, in one object store (`scores`). A row is:

| Field | What it holds |
| --- | --- |
| `key` | `"<model id>@<version>:<hash>"` — a 53-bit hash (`lib/hash.ts`) of the NORMALIZED paragraph text, never the text |
| `b`, `p`, `s` | the verdict: bucket, the four probabilities, the score |
| `k`, `x` | token count, and whether the daemon truncated the paragraph |
| `l`, `lp` | the language the local pre-gate detected, and its confidence |
| `u` | set when the result is "unavailable" rather than a verdict |
| `t` | when the row was written, so the oldest can be pruned |

**No page text is ever stored.** The key is a hash and the value is numbers. The store is
bounded: 20 000 rows, pruned back to 15 000 oldest-first, with 5 000 in front of it in the
worker's memory. "Clear cached verdicts" in the options page empties all three layers.

### `sessionStorage`

Two keys, each written into the tab it belongs to, each gone when that tab is.

| Key | Where | What it holds |
| --- | --- | --- |
| `anagram-docs-return` | the Google Doc's own page, written by the content script | the editor address, so "Back to editor" returns to the exact document view the reader came from |
| `anagram.pdfBounce` | the reading mode's own page | the one PDF address this tab has already been sent back to, so a handoff that keeps failing cannot ping-pong the tab between two addresses |

### Nothing else

No cookies are read or written. No `localStorage`. No Cache Storage. No files are
downloaded. No bookmark, history or tab content is read beyond the tab's own URL, which the
extension needs to know which site rules apply.

## On disk, outside the browser

`~/.anagram`, and only that — the daemon's own directory, created by `install.sh`. The
model is downloaded by the INSTALLER, not by the extension; the extension has no way to
fetch a model and no way to start, stop or update anything on disk. Uninstalling the
extension leaves `~/.anagram`; removing that directory removes the daemon entirely.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | the settings above |
| `activeTab` | the popup and the keyboard commands act on the tab in front of the reader |
| `contextMenus` | the four right-click entries |
| `scripting` | registers the content script for the origins the reader has granted, and injects it into one tab for a single action where they have granted nothing |
| host access | **none.** The manifest has no `host_permissions` key at all |
| optional host access | `https://*/*` and `http://*/*` — the sites the reader grants, one at a time or all at once; see the popup's per-site switch |
| `clipboardWrite` (Firefox only, **optional**) | "Copy page diagnostics". Asked for at the moment it is used, never at install |

That is the whole manifest block — `storage, activeTab, contextMenus, scripting`, no host at
all, two optional patterns — and `test/node/permissions.test.ts` reads the built manifest and
pins it. None of those four shows a warning at install, and with no host among them the
install dialog has nothing to warn about: Anagram arrives able to read no page and to reach
nothing but the local daemon its policy allows.
