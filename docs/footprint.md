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

**Extension pages and the worker can request only packaged resources.**
`wxt.config.ts` declares their Content-Security-Policy:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self';
connect-src 'self';
img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline';
worker-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'
```

The policy blocks network connections from extension pages and the worker, including
loopback requests. `test/csp-check.mjs` exercises remote and loopback refusals in a browser
while native scoring and the packaged PDF reader remain usable.

**Native Messaging is the only scoring and component-management connection.** The fixed
host `dev.coderbak.anagram` exchanges bounded JSON frames over one multiplexed stdio port.
Only Anagram's top-level onboarding and Options pages may request lifecycle operations
through the background bridge. Content scripts cannot download, update or delete native
files. No URL or alternative transport setting can change this connection. Retired
`serverUrl` and `backendTransport` values are ignored and removed on worker initialization.

Native Messaging is outside `connect-src`; the local program has the user's normal OS
privileges. Its separate setup downloads and disk use are described below. Browser CSP is
not a sandbox for that process.

Content scripts can re-read the same-origin PDF or Google Doc their tab already shows.
Those requests use the tab's origin and cookies, and are not inference uploads. Local PDF
files enter through the reader's file picker or drop zone; no file-scheme grant is required.

### Every call site

| File | Call | What it is for | Where it goes |
| --- | --- | --- | --- |
| `lib/backend/nativeTransport.ts` | `connectNative(` | scoring and fixed local component operations over a single multiplexed port | the installed local host `dev.coderbak.anagram`, not an internet endpoint |
| `lib/docsOverlay.ts` | `fetch(` | re-reads the Google Doc the tab is already showing, in its `mobilebasic` rendering, because a Docs canvas has no text in the DOM to read | the same origin as the tab, with the reader's own cookies |
| `lib/pdf/handoff.ts` | `fetch(` | re-reads, from the content script in a PDF tab, the document that tab is already showing, so the reading mode can be handed its bytes instead of fetching them | the same URL the tab is already showing, same-origin, normally answered from the HTTP cache |
| `lib/lazy.ts` | `import(` | loads one of the vendored chunks that ship inside the extension (Readability, DOMPurify, the diagnostics chunk, pdf.js) | `chrome-extension://<this extension>/vendor/…` |

Nothing else in `lib/` or `entrypoints/` calls a network API. There is no `XMLHttpRequest`,
no `WebSocket`, no `EventSource`, no `sendBeacon`, no `importScripts`, no telemetry, no
analytics, no error reporting, no update check, no remote font and no remote stylesheet.

A remote PDF is re-read by its current tab with `cache: "force-cache"`, capped at 50 MB,
and checked for the `%PDF-` signature. The worker holds its chunks under a one-time ticket
bound to that tab; the reader claims them and the ticket is freed. The reader's `?src=`
value is used for labels and navigation, never fetched from the extension origin.

### Every address written in the source

`lib/` and `entrypoints/` hold these `http://` and `https://` literals and no others —
stylesheets included, since an `@import` or a webfont is a remote host as much as a
`fetch` is.

| File | URL | Why |
| --- | --- | --- |
| `lib/access/patterns.ts` | `http://localhost/*` | an example in the comment that explains why a match pattern carries no port. Nothing asks for it: the extension requires no host |
| `lib/access/patterns.ts` | `https://*/*` | the OPTIONAL site access the reader may grant, and which the extension installs without |
| `lib/access/patterns.ts` | `http://*/*` | the same, for plain http |
| `lib/pdf/source.ts` | `https://arxiv.org/html/` | builds the address of an arXiv paper's HTML rendering. Nothing fetches it; it is offered as a link somebody may follow |
| `lib/docs.ts` | `https://docs.google.com/document/d/` | builds the address of the document the tab is on |
| `lib/docsOverlay.ts` | `https://docs.google.com/document/d/` | the same address, for the same-origin read above |
| `lib/ui/installationCommand.ts` | `https://github.com/CoderBak/anagram/releases/download/v$` | builds a version-pinned script link and the command the user runs once; the extension does not fetch the script |
| `lib/ui/basecoat-vega.cdn.min.css` | `http://www.w3.org/2000/svg` | the SVG namespace, inside `url("data:image/svg+xml,…")` icons. A namespace is a name, not an address: nothing fetches it |
| `lib/ui/basecoat-vega.cdn.min.css` | `https://tailwindcss.com` | the licence banner of the vendored Basecoat (Vega) stylesheet |
| `lib/diagnostics/anonymise.ts` | `https://schema.org/Article` | an example in a comment about `itemtype` vocabularies |
| `entrypoints/options/main.ts` | `https://www.Example.com/path` | an example in a comment about parsing a hostname out of what was typed |
| `entrypoints/options/main.ts` | `https://` | the scheme prepended to a bare hostname before `new URL()` parses it |

## Storage

The native component also keeps `runtime.json` under its own installation folder. It stores the
chosen device/runtime/precision, a local hardware and model fingerprint, and benchmark
timings and memory measurements. Benchmark inputs are built-in sample prose; this file
contains no browsing text and is never uploaded. Restarting reuses a valid saved choice.

### `chrome.storage.local`

Reading preferences, an update notification and a cache housekeeping flag.
Nothing is written to `storage.sync`, `storage.session` or `storage.managed`. Retired
connection keys are deleted without reading their values; this does not change reading
preferences or site grants. No setting is synced to another computer.

| Key | What it holds |
| --- | --- |
| `extensionUpdatePending` | version of a browser extension update waiting for the user to reload |
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
| `k`, `x` | token count, and whether the model truncated the paragraph |
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

No cookies are read or written through the browser cookies API. No `localStorage` or
Cache Storage. Model downloads are made by the native component, not the browser downloads
API. No bookmark or history API is used. Reading the current document requires site access
or a user-initiated one-off action as described above.

## On disk, outside the browser

The component defaults to `~/.anagram` on macOS/Linux and `%LOCALAPPDATA%\Anagram` on
Windows. It contains the private Python/runtime packages, executable launcher, application
code, verified model files and partial downloads, runtime choice and measurements, local
component preferences, registration inventory, and operational state/receipts. The
browser launches the component when needed; no login service or shell-profile change is
installed. The ZIP extension directory remains wherever the user unpacked it.

Registration also needs one browser-owned location outside that directory. With host file
name `dev.coderbak.anagram.json`, the default user paths are:

- macOS Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`;
  Firefox: `~/Library/Application Support/Mozilla/NativeMessagingHosts/`.
- Linux Chrome: `~/.config/google-chrome/NativeMessagingHosts/`;
  Firefox: `~/.mozilla/native-messaging-hosts/`.
- Windows: a manifest under the component's `native/` directory, plus its path in
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.coderbak.anagram` or
  `HKCU\Software\Mozilla\NativeMessagingHosts\dev.coderbak.anagram`.

Only the exact extension ID is allowed. The installer records the exact registration and
its hash; cleanup refuses changed or foreign registrations. The component accepts a fixed
operation list, never caller-supplied filesystem paths, executable names or download URLs.
This is an application boundary, not an operating-system filesystem sandbox: the local
program runs with the user's ordinary privileges, outside browser CSP.

First connection downloads the pinned public modelkit and language model, verifies hashes,
and runs setup. Pause/stop/delete preferences persist across browser restarts. Inference
loads local files with Hugging Face offline mode. Downloading and explicit component
updates contact the model/release/dependency hosts; browsing text is never included. The
installer uses GitHub release assets, Astral Python/uv distributions and package indexes;
models use Hugging Face (including its file CDN) and Facebook's fastText file host.

Settings can delete models or request complete uninstall. POSIX completion is reported only
after removing owned registrations and the component root. On Windows a separate visible
cleanup worker waits for locked processes to exit; scheduling is not completion and the
user removes the extension after that window confirms success. Direct browser Remove does
not notify a native cleanup hook, so it leaves the component and model files. User-created
ZIPs, the manually unpacked extension folder, browser/OS logs and ordinary OS temporary
files are not promised erased. See the [English](user-guide.en.md) and
[中文](user-guide.zh-CN.md) lifecycle guides.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | the settings above |
| `activeTab` | the popup and the keyboard commands act on the tab in front of the reader |
| `contextMenus` | the four right-click entries |
| `scripting` | registers the content script for the origins the reader has granted, and injects it into one tab for a single action where they have granted nothing |
| `nativeMessaging` (**required**) | launches the registered local component and carries scoring, model download progress, runtime choice, update and cleanup controls |
| host access | **none.** The manifest has no `host_permissions` key at all |
| optional host access | `https://*/*` and `http://*/*` — the sites the reader grants, one at a time or all at once; see the popup's per-site switch |
| `clipboardWrite` (Firefox only, **optional**) | "Copy page diagnostics". Asked for at the moment it is used, never at install |

The required block is `storage, activeTab, contextMenus, scripting, nativeMessaging`,
with no required host and two optional site patterns. `test/node/permissions.test.ts`
checks both built manifests. Chrome describes the native permission as "Communicate
with cooperating native applications"; it does not grant website access.

No `management`, `downloads`, `tabs`, `webRequest`, `unlimitedStorage`, startup-service or
required website permission is added. Self-uninstall uses the browser's permission-free
`management.uninstallSelf` API after verified cleanup. Store submission still requires
release artifacts, supported-platform QA and accurate disclosures; permission minimization
does not guarantee a review outcome.
