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
connect-src 'self' http://127.0.0.1:* http://localhost:* file:;
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
  refuses anything but `http(s)://localhost`, `::1` or `127.x.y.z`, and the CSP refuses
  anything but the two spellings it can express — so the two have to agree before a request
  leaves at all.

### Every call site

| File | Call | What it is for | Where it goes |
| --- | --- | --- | --- |
| `lib/backend/httpClient.ts` | `fetch(` | `GET /health` — is the daemon up? | the loopback daemon |
| `lib/backend/httpClient.ts` | `fetch(` | `POST /score` — the paragraphs to be scored | the loopback daemon |
| `lib/docsOverlay.ts` | `fetch(` | re-reads the Google Doc the tab is already showing, in its `mobilebasic` rendering, because a Docs canvas has no text in the DOM to read | the same origin as the tab, with the reader's own cookies |
| `entrypoints/reader/main.ts` | `fetch(` | the bytes of the PDF the reading mode was opened for | under the policy above: the loopback fixtures and `file:` only — a PDF on a remote site has to be handed over by the tab that already has it |
| `lib/lazy.ts` | `import(` | loads one of the vendored chunks that ship inside the extension (Readability, DOMPurify, the diagnostics chunk, pdf.js) | `chrome-extension://<this extension>/vendor/…` |

Nothing else in `lib/` or `entrypoints/` calls a network API. There is no `XMLHttpRequest`,
no `WebSocket`, no `EventSource`, no `sendBeacon`, no `importScripts`, no telemetry, no
analytics, no error reporting, no update check, no remote font and no remote stylesheet.

Until 2026-09-20 there was one more: the service worker asked `arxiv.org` whether a paper
had an HTML rendering, so that an arXiv PDF could open as the paper instead of as its PDF.
It was the extension's only remote request and it has been removed along with the automatic
re-routing that depended on it. "Open in Anagram" on a PDF now opens that PDF.

### Every address written in the source

`lib/` and `entrypoints/` hold these `http://` and `https://` literals and no others —
stylesheets included, since an `@import` or a webfont is a remote host as much as a
`fetch` is.

| File | URL | Why |
| --- | --- | --- |
| `lib/settings/settings.ts` | `http://127.0.0.1:8765` | the default daemon address |
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
| `markStyle` | underline, tint, or both |
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

### `sessionStorage`, on the Google Doc's own page

One key, written by the content script into the tab it is running in, so that "Back to
editor" can return to the exact document view the reader came from. It lives in that tab
and dies with it.

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
| `scripting` | runs the content script in a tab the reader has just granted access to |
| host access | the loopback daemon, plus the sites the reader grants — see the popup's per-site switch |
| `clipboardWrite` (Firefox only, **optional**) | "Copy page diagnostics". Asked for at the moment it is used, never at install |

The manifest's permission block is the `access` agent's to write; the table above describes
the state it is moving to, and `test/node/permissions.test.ts` is where it is pinned.
