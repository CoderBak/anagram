# Footprint

Every network call site, every address literal and every storage key in the shipped
extension source. `test/node/footprint.test.ts` reads this file on every `vitest` run
and fails when the code and the tables disagree in either direction. The scanner covers
`lib/` and `entrypoints/`; it does not enumerate requests inside vendored libraries or
resources referenced by a displayed document.

## Network

The manifest Content-Security-Policy:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self';
connect-src 'self' http: https: file:;
img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline';
worker-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'
```

Every ordinary extension page tightens `connect-src` to `'self'` with a meta tag. The
wide manifest value exists only for the private PDF loader frame, which sets a policy
naming the exact authorized source right before its single read. Scoring goes over
Native Messaging, which is outside `connect-src`; the local component runs with the
user's ordinary OS privileges and is not sandboxed by browser CSP.

### Every call site

| File | Call | What it is for | Where it goes |
| --- | --- | --- | --- |
| `lib/backend/nativeTransport.ts` | `connectNative(` | scoring and fixed local component operations over a single multiplexed port | the installed local host `dev.coderbak.anagram`, not an internet endpoint |
| `lib/docsOverlay.ts` | `fetch(` | re-reads the Google Doc the tab is already showing, in its `mobilebasic` rendering, because a Docs canvas has no text in the DOM to read | the same origin as the tab, with the reader's own cookies |
| `lib/pdf/handoff.ts` | `fetch(` | re-reads, from the content script in a PDF tab, the document that tab is already showing, so the reader can be handed its bytes | the same URL the tab is already showing, same-origin, normally answered from the HTTP cache |
| `lib/pdf/loader.ts` | `fetch(` | reads an online PDF only after the private loader validates its one-use source ticket and current website access; rejects redirects | the exact authorized original HTTP(S) PDF URL, with normal browser credentials and no referrer |
| `lib/pdf/loader.ts` | `XMLHttpRequest` | reads bytes for an authorized local PDF after checking file access, size and PDF signature | the exact authorized local file URL; remote-host file URLs are rejected |
| `lib/lazy.ts` | `import(` | loads one of the vendored chunks that ship inside the extension (Readability, DOMPurify, the diagnostics chunk, pdf.js) | `chrome-extension://<this extension>/vendor/…` |

There is no analytics, error-reporting or telemetry endpoint. The component update
notice compares versions locally; it does not poll GitHub.

### Every address written in the source

| File | URL | Why |
| --- | --- | --- |
| `lib/access/patterns.ts` | `http://localhost/*` | an example in the comment that explains why a match pattern carries no port |
| `lib/access/patterns.ts` | `https://*/*` | the optional site access the user may grant |
| `lib/access/patterns.ts` | `http://*/*` | the same, for plain http |
| `lib/pdf/navigation.ts` | `http://*/*` | filters main-frame response observations used to recognize a PDF; does not initiate a request |
| `lib/pdf/navigation.ts` | `https://*/*` | the corresponding HTTPS response-observation filter |
| `lib/docs.ts` | `https://docs.google.com/document/d/` | builds the address of the document the tab is on |
| `lib/docsOverlay.ts` | `https://docs.google.com/document/d/` | the same address, for the same-origin read above |
| `lib/ui/installationCommand.ts` | `https://github.com/CoderBak/anagram/releases/download/v$` | builds the version-pinned install command the user runs once; the extension does not fetch it |
| `lib/ui/basecoat-vega.cdn.min.css` | `http://www.w3.org/2000/svg` | the SVG namespace inside data-URI icons; a name, not an address |
| `lib/ui/basecoat-vega.cdn.min.css` | `https://tailwindcss.com` | the licence banner of the vendored Basecoat stylesheet |
| `lib/diagnostics/anonymise.ts` | `https://schema.org/Article` | an example in a comment about `itemtype` vocabularies |
| `lib/dom/shadow.ts` | `https://github.com/mozilla-firefox/firefox` | the attribution of adapted Firefox code in a comment |
| `entrypoints/shadow.content.ts` | `https://github.com/FluentRead/FluentRead` | the attribution of adapted FluentRead code in a comment |
| `entrypoints/onboarding/index.html` | `https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.en.md` | the user-guide link on the setup page; opened only when clicked |
| `entrypoints/onboarding/main.ts` | `https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.zh-CN.md` | the same link for a Chinese browser |
| `entrypoints/options/index.html` | `https://github.com/CoderBak/anagram/blob/dev/PRIVACY.md` | the privacy-policy link on the settings page; opened only when clicked |
| `entrypoints/options/main.ts` | `https://www.Example.com/path` | an example in a comment about parsing a hostname |
| `entrypoints/options/main.ts` | `https://` | the scheme prepended to a bare hostname before `new URL()` parses it |
| `entrypoints/reader/index.html` | `http://www.apache.org/licenses/LICENSE-2.0` | the retained upstream PDF.js license notice in an HTML comment |
| `entrypoints/reader/index.html` | `https://github.com/adobe-type-tools/cmap-resources` | the retained upstream CMap attribution in an HTML comment |
| `entrypoints/reader/index.html` | `http://www.w3.org/2000/svg` | the namespace of an inline SVG in the upstream viewer template |
| `entrypoints/reader/index.html` | `https://support.mozilla.org/en-US/kb/pdf-alt-text` | an upstream help link in the viewer's alt-text template; alt-text tools are disabled |

## Storage

### `chrome.storage.local`

Nothing is written to `storage.sync`, `storage.session` or `storage.managed`.

| Key | What it holds |
| --- | --- |
| `extensionUpdatePending` | version of a browser extension update waiting for the user to reload |
| `enabled` | the master switch |
| `siteOverrides` | per-site on/off rules, as hostnames the user chose |
| `showHighlights` | whether analyzed text is underlined in place |
| `autoOpenPdfs` | whether a PDF tab opens in the reader by itself |
| `debug` | verbose logging |
| `cacheMode` | persistent scores (up to 30 days) or memory only |
| `reportIncludeText` | opt-in to include passage excerpts in copied reports |
| `reportIncludeUrl` | opt-in to include page titles and URLs in copied reports |
| `displayMode` | mark everything, or only flagged paragraphs |
| `mergeShorts` | group short paragraphs to reach the 75-word floor |
| `analysisScope` | the whole page, or its main content |
| `fabPos` | where the user dragged the ball, per hostname |

### IndexedDB `anagram-scores`

The persistent score cache. A row holds the model identity plus a 53-bit hash of the
text the model read, the verdict (bucket, four probabilities, score), token count, truncation
flag, detected language and write time. **No raw page text is stored in the score cache.**
An unsalted hash is not anonymous: someone with local cache access can test guesses about
known text. The store keeps at most 20 000 rows, pruned back to 15 000 oldest first, and
rows expire 30 days after they were written.

### Other browser storage

- `sessionStorage` key `anagram-docs-return` in a Google Docs tab: the editor address, so
  "Back to editor" returns to the exact view. It dies with the tab.
- The packaged PDF.js viewer uses `localStorage` keys `pdfjs.history` (up to 20 document
  fingerprints with view state, no text or password) and `pdfjs.preferences`. These are
  not erased by "Clear cached verdicts".

## On disk, outside the browser

The local engine lives in `~/.anagram` on macOS/Linux and `%LOCALAPPDATA%\Anagram` on
Windows: a private Python runtime, the application, verified model files and partial
downloads, the saved runtime choice, and registration records. Browser registration adds
one manifest named `dev.coderbak.anagram.json` in the browser's user-level
`NativeMessagingHosts` directory (or an `HKCU` registry pointer on Windows), allowing
only the exact extension ID. **Complete uninstall removes the entire component directory,
including anything a user later put inside it.**
