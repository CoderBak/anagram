# Anagram's footprint

The extension's browser API calls, storage and permissions, plus the native component's
download and disk footprint. This is a source review inventory for users and reviewers;
it is not a claim that static scanning can enumerate every request inside a dependency
or original document.

`test/node/footprint.test.ts` reads this page and checks it against the source on every
`vitest` run. An added use of a network API that the scanner recognizes in `lib/` or
`entrypoints/` must be documented, and stale rows fail too. This does not cover all
vendored/native code or declarative requests from inserted HTML/CSS. See
[network verification](network-privacy.md) for the full workflow inventory and a
repeatable offline/traffic check.

## Network

**The manifest allows original-document reads, while executable code stays local.**
`wxt.config.ts` declares this Content-Security-Policy:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self';
connect-src 'self' http: https: file:;
img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline';
worker-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'
```

Ordinary extension pages, including the reader, add a stricter meta policy with
`connect-src 'self'`. The private PDF-loader frame restricts its connection policy to the
authorized original source. The broader manifest policy is needed for HTTP(S) and local
file documents; it does not itself enforce the application's exact-document authorization.
Scripts and workers remain packaged. CSP behavior and the source-ticket boundary have
separate browser/unit checks; the worker's connection policy must not be described as
a universal network firewall.

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
Those requests use normal browser credentials and are not inference uploads. Google Docs
content can additionally load its own image and CSS resources when rendered; DOMPurify
removes active markup but does not make a document network-inert. Other PDF routes use an
isolated loader for the exact authorized source. Local PDFs can also enter through a file
picker/drop zone; reading an existing `file:///` tab requires the applicable browser grant.

### Every call site

| File | Call | What it is for | Where it goes |
| --- | --- | --- | --- |
| `lib/backend/nativeTransport.ts` | `connectNative(` | scoring and fixed local component operations over a single multiplexed port | the installed local host `dev.coderbak.anagram`, not an internet endpoint |
| `lib/docsOverlay.ts` | `fetch(` | re-reads the Google Doc the tab is already showing, in its `mobilebasic` rendering, because a Docs canvas has no text in the DOM to read | the same origin as the tab, with the reader's own cookies |
| `lib/pdf/handoff.ts` | `fetch(` | re-reads, from the content script in a PDF tab, the document that tab is already showing, so the reading mode can be handed its bytes instead of fetching them | the same URL the tab is already showing, same-origin, normally answered from the HTTP cache |
| `lib/pdf/loader.ts` | `fetch(` | reads an online PDF only after the private loader validates its one-use source ticket and current website access; rejects redirects | the exact authorized original HTTP(S) PDF URL, with normal browser credentials, cache preference and no referrer |
| `lib/pdf/loader.ts` | `XMLHttpRequest` | reads bytes for an authorized local PDF after checking file access, size and PDF signature | the exact authorized local file URL; remote-host file URLs are rejected |
| `lib/lazy.ts` | `import(` | loads one of the vendored chunks that ship inside the extension (Readability, DOMPurify, the diagnostics chunk, pdf.js) | `chrome-extension://<this extension>/vendor/…` |

The table records direct calls recognized by the source scanner. It does not enumerate
requests made by packaged libraries or resources referenced by the displayed document.
There is no analytics, remote error-reporting or telemetry endpoint. The component update
notice compares the installed component and extension versions locally; it does not poll
GitHub. Interface fonts, styles, scripts and PDF viewer assets ship locally.

For the current-tab relay, a PDF is re-read with `cache: "force-cache"`, capped at 50 MiB,
and checked for the `%PDF-` signature. The worker permits two active transfers and holds
at most 64 MiB of raw document bytes across reads, tickets and claims. Base64 representation
and reader decoding use additional memory. Each 256 KiB chunk waits for acknowledgment;
sequence, encoding and final length are validated. Unclaimed tickets expire after 30 seconds.
Only this extension's top-level reader in the designated tab, at the ticket's reader URL,
may claim bytes. Missing sender identity is refused. A tab that navigates during a read
is not replaced. An address in `?src=` is not sufficient authorization to fetch a document.
The private loader requires a separate, single-use source ticket bound to the live reader
and checked against current permissions. It reads source bytes; the full PDF.js viewer
is given those bytes, with URL loading and PDF scripting disabled. Original-source reads
can reach the network even when caching is preferred.

`lib/pdf/sourceTransfer.ts` binds source tickets to the live reader port and tab. An
independent, private DOM proof binds the loader to that reader; browser frame and document
metadata are checked additionally when the browser exposes them. `entrypoints/pdf-loader/main.ts` obtains that source over
the private port, checks access again and installs the source-origin connection policy
before calling `lib/pdf/loader.ts`. HTTP redirects are refused; local files use a GET XHR
with final URL/size/signature checks. The source-loader route has its own 50 MiB per-file
cap, one concurrent transfer and a 45-second deadline; it does not use the relay's 64 MiB
worker buffer. This is a byte-transfer limit, not a process-memory limit: assembling chunks
can briefly hold two copies, and rendering has its own memory cost.
Only local-form `file:///` URLs are accepted, not remote file-server hostnames. A file on
an OS-mounted network volume can still involve that filesystem's network traffic.

Content and reader requests use an in-memory `anagram-document` port. The worker binds
its random document key to the browser's tab, frame, origin and document ID; Firefox uses
the live port plus an isolated-world nonce where a document ID is absent. Closing that
connection cancels its requests. Site revocation cancels affected frames independently,
including cross-origin frames inside a still-granted tab. A one-off run is bound to its
document, ending on reload or new-document navigation even within the same origin.
These sessions are never stored. Only Settings can clear or change persistence of verdicts;
content scripts cannot choose another tab for analysis or PDF navigation.

### Every address written in the source

`lib/` and `entrypoints/` hold these `http://` and `https://` literals and no others —
stylesheets included, since an `@import` or a webfont is a remote host as much as a
`fetch` is.

| File | URL | Why |
| --- | --- | --- |
| `lib/access/patterns.ts` | `http://localhost/*` | an example in the comment that explains why a match pattern carries no port. Nothing asks for it: the extension requires no host |
| `lib/access/patterns.ts` | `https://*/*` | the OPTIONAL site access the reader may grant, and which the extension installs without |
| `lib/access/patterns.ts` | `http://*/*` | the same, for plain http |
| `lib/pdf/navigation.ts` | `http://*/*` | filters main-frame response observations used to identify an authorized PDF; the pattern does not initiate a request or grant access |
| `lib/pdf/navigation.ts` | `https://*/*` | the corresponding HTTPS response-observation filter, subject to website access |
| `lib/docs.ts` | `https://docs.google.com/document/d/` | builds the address of the document the tab is on |
| `lib/docsOverlay.ts` | `https://docs.google.com/document/d/` | the same address, for the same-origin read above |
| `lib/ui/installationCommand.ts` | `https://github.com/CoderBak/anagram/releases/download/v$` | builds a version-pinned script link and the command the user runs once; the extension does not fetch the script |
| `lib/ui/basecoat-vega.cdn.min.css` | `http://www.w3.org/2000/svg` | the SVG namespace, inside `url("data:image/svg+xml,…")` icons. A namespace is a name, not an address: nothing fetches it |
| `lib/ui/basecoat-vega.cdn.min.css` | `https://tailwindcss.com` | the licence banner of the vendored Basecoat (Vega) stylesheet |
| `lib/diagnostics/anonymise.ts` | `https://schema.org/Article` | an example in a comment about `itemtype` vocabularies |
| `entrypoints/options/main.ts` | `https://www.Example.com/path` | an example in a comment about parsing a hostname out of what was typed |
| `entrypoints/options/main.ts` | `https://` | the scheme prepended to a bare hostname before `new URL()` parses it |
| `entrypoints/reader/index.html` | `http://www.apache.org/licenses/LICENSE-2.0` | the retained upstream PDF.js license notice in an HTML comment; not a resource request |
| `entrypoints/reader/index.html` | `https://github.com/adobe-type-tools/cmap-resources` | the retained upstream CMap attribution in an HTML comment; not a resource request |
| `entrypoints/reader/index.html` | `http://www.w3.org/2000/svg` | the namespace of an inline SVG in the upstream viewer template; not a resource request |
| `entrypoints/reader/index.html` | `https://support.mozilla.org/en-US/kb/pdf-alt-text` | an upstream help hyperlink in the viewer's alt-text UI template; alt-text tools are disabled and it is not fetched automatically |

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
| `cacheMode` | persistent scores (up to 30 days) or memory only |
| `reportIncludeText` | opt-in to include passage excerpts in copied reports; false by default |
| `reportIncludeUrl` | opt-in to include page titles and URLs in copied reports; false by default |
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
| `key` | normalization version and full model identity (id/version/calibration), followed by a 53-bit hash (`lib/hash.ts`) of canonical text, never the text |
| `b`, `p`, `s` | the verdict: bucket, the four probabilities, the score |
| `k`, `x` | token count, and whether the model truncated the paragraph |
| `l`, `lp` | the language the local pre-gate detected, and its confidence |
| `u` | set when the language is unsupported (temporary inference failures are never cached) |
| `t` | when the row was written, so the oldest can be pruned |

**No raw page text is stored in the score cache.** An unsalted text hash is not anonymous:
someone with local cache access can test guesses about known text. The store is
bounded: 20 000 rows, pruned back to 15 000 oldest-first, with 5 000 in front of it in the
worker's memory. Expiry is checked at lookup in each layer. "Clear cached verdicts"
invalidates pending reads and prevents pre-clear work from saving results; deletion
failure is reported. Memory-only mode disables persistent reads/writes and deletes
saved rows. Worker termination may clear memory before the browser session ends.

The text-analysis page holds pasted text or an explicitly chosen UTF-8 file in page
memory, with a 1 MiB file / 200,000-character limit. It uses the same local scoring and
cache policy. Raw text is not saved by that page. Copied reports include model identity,
scores and coverage; text, titles and URLs require explicit opt-in. Clipboard contents
are managed by the operating system and may outlive this extension.

### `sessionStorage`

One key, written into its Google Docs tab and gone when that tab is.

| Key | Where | What it holds |
| --- | --- | --- |
| `anagram-docs-return` | the Google Doc's own page, written by the content script | the editor address, so "Back to editor" returns to the exact document view the reader came from |

### PDF viewer localStorage and remaining APIs

The packaged generic PDF.js viewer additionally uses `localStorage`:

| Key | What it holds |
| --- | --- |
| `pdfjs.history` | Up to 20 document fingerprints with page, zoom, scroll, rotation, sidebar/scroll/spread view state. No PDF text or password. A fingerprint may identify a known document. |
| `pdfjs.preferences` | Viewer preferences. Upstream reads this key and some viewer preference actions may write it; Anagram disables preference overrides of its safety configuration. |

These local-only viewer keys are not part of the verdict cache and are not erased by
**Clear cached verdicts** or memory-only scoring. Upstream signature/comment/editor tools
are disabled, including the `pdfjs.signature` storage entry point. This vendored storage
is documented explicitly; the scanner of our `lib/`/`entrypoints/` is not sufficient to
discover it.

No cookies are read or written through the browser cookies API. No Cache Storage API is
used by Anagram. Model downloads are made by the native component, not the browser downloads
API. No bookmark or history API is used. Reading the current document requires site access
or a user-initiated one-off action as described above.

## On disk, outside the browser

The [filesystem and lifecycle audit](filesystem-audit.md) describes user-data boundaries,
failure recovery limits and the current pre-release hardening status.

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

First connection detects usable devices and prepares a recommended subset of the pinned
public modelkit plus the language model, usually about 1.43 GB. Working Torch GPUs share
one safetensors checkpoint across CPU FP32 and GPU FP32/FP16; CPU-only systems prefer available
ONNX Runtime FP32 and otherwise use Torch FP32. Settings lists the selected files and
exact total; preparation bytes include verified reused files, not only network downloads.
An explicit expanded profile adds compatible backends and experimental CPU INT8. CPU ONNX
FP16, CoreML and MLX are excluded. The selected profile is a native component preference;
resume retains it, and returning to recommended preserves verified extra files already on
disk. Preparation verifies hashes before setup. Pause/stop/delete preferences persist across browser restarts. Inference
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

**Complete uninstall removes the entire verified component directory, including personal
files a user later put inside it.** Keep that directory dedicated to Anagram; an unpacked
extension or other files placed inside it are also within the deletion boundary. Model-only
deletion is a separate operation.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | the settings above |
| `activeTab` | the popup and the keyboard commands act on the tab in front of the reader |
| `contextMenus` | the four right-click entries |
| `scripting` | registers the content script for the origins the reader has granted, and injects it into one tab for a single action where they have granted nothing |
| `nativeMessaging` (**required**) | launches the registered local component and carries scoring, model download progress, runtime choice, update and cleanup controls |
| `webNavigation`, `webRequest` | observes top-level navigation and available response metadata to recognize PDFs; content reads require authorization, and navigation data is not sent to inference |
| host access | **none.** The manifest has no `host_permissions` key at all |
| optional host access | `https://*/*` and `http://*/*` — the sites the reader grants, one at a time or all at once; see the popup's per-site switch |
| `file:///*` (**optional**) | reads an authorized local PDF tab; browser file-access controls also apply. File picker/drop remains available without a general file grant |
| `clipboardWrite` (Firefox only, **optional**) | "Copy page diagnostics". Asked for at the moment it is used, never at install |

The required block is `storage, activeTab, contextMenus, scripting, nativeMessaging,
webNavigation, webRequest`, with no required host, two optional website patterns and an
optional local-file pattern. `test/node/permissions.test.ts`
checks both built manifests. Chrome describes the native permission as "Communicate
with cooperating native applications"; it does not grant website access.

Navigation events can expose open tabs' addresses before a site grant. The PDF router
keeps current-tab state in memory and discards it when the tab closes; it does not write
a browsing-history log. Website/file access is checked before opening and reading a
source document. A metadata-observation permission is not permission to analyze its text.

No `management`, `downloads`, `tabs`, `unlimitedStorage`, startup-service or
required website permission is added. Self-uninstall uses the browser's permission-free
`management.uninstallSelf` API after verified cleanup. Store submission still requires
release artifacts, supported-platform QA and accurate disclosures; permission minimization
does not guarantee a review outcome.
