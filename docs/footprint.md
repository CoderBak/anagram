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
img-src 'self' data: blob:; font-src 'self' data:; style-src 'self';
worker-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'
```

Every ordinary extension page tightens `connect-src` to `'self'` with a meta tag. The
wide manifest value exists only for the private PDF loader frame, which sets a policy
naming the exact authorized source right before its single read. Scoring goes over
Native Messaging when the local engine is the one in use, which is outside `connect-src`;
the local component runs with the user's ordinary OS privileges and is not sandboxed by
browser CSP. The in-browser engine scores inside the browser (`lib/webengine/`), and its
only requests are the one-time model downloads from Hugging Face (`lib/webengine/pin.ts`
below), which answers them with CORS headers, so no host permission is held for them, or from
`hf-mirror.com` where huggingface.co answers nothing (a network error, no answer in 20 s, a
5xx); the language-ID file ships in the package. Its engine page (`engine.html`, Chrome's offscreen
document) keeps the manifest's `connect-src`: the worker it hosts is what performs those
downloads, into the extension's own storage.

### Every call site

| File | Call | What it is for | Where it goes |
| --- | --- | --- | --- |
| `lib/backend/nativeTransport.ts` | `connectNative(` | scoring and fixed local component operations over a single multiplexed port | the installed local host `dev.coderbak.anagram`, not an internet endpoint |
| `lib/docsOverlay.ts` | `fetch(` | re-reads the Google Doc the tab is already showing, in its `mobilebasic` rendering, because a Docs canvas has no text in the DOM to read | the same origin as the tab, with the reader's own cookies |
| `lib/pdf/handoff.ts` | `fetch(` | re-reads, from the content script in a PDF tab, the document that tab is already showing, so the reader can be handed its bytes | the same URL the tab is already showing, same-origin, normally answered from the HTTP cache |
| `lib/pdf/loader.ts` | `fetch(` | reads an online PDF only after the private loader validates its one-use source ticket and current website access; rejects redirects | the exact authorized original HTTP(S) PDF URL, with normal browser credentials and no referrer |
| `lib/pdf/loader.ts` | `XMLHttpRequest` | reads bytes for an authorized local PDF after checking file access, size and PDF signature | the exact authorized local file URL; remote-host file URLs are rejected |
| `lib/lazy.ts` | `import(` | loads one of the vendored chunks that ship inside the extension (DOMPurify, the diagnostics chunk, the surfaces chunk, pdf.js) | `chrome-extension://<this extension>/vendor/…` |
| `lib/webengine/download.ts` | `fetch(` | downloads the pinned model files once, resumably, verifying each against its pinned SHA-256 as it streams; anonymous, no credentials, no referrer; and reads lid.176.ftz, which the package ships, checking it against its pinned SHA-256 whenever the model loads (the in-browser engine only) | the exact pinned addresses in `lib/webengine/pin.ts`: the modelkit on huggingface.co (following its redirect to its storage) or, where huggingface.co is unreachable, the same paths on hf-mirror.com, and `chrome-extension://<this extension>/vendor/engine/lid.176.ftz` |
| `lib/ui/deviceInputs.ts` | `fetch(` | the test build only (absent from the shipping bundles): reads the stand-in device a suite put beside the pages | `chrome-extension://<this extension>/test-device.json` |
| `lib/webengine/session.ts` | `import(` | loads ONNX Runtime Web, which ships inside the extension, into the engine's worker | `chrome-extension://<this extension>/vendor/engine/ort.jspi.min.mjs` |

The local component's installer (`anagramd/download_modelkit.py`) downloads the same
pinned files, checked by SHA-256, from huggingface.co and from dl.fbaipublicfiles.com for
lid.176.ftz. `hf-mirror.com`, a mirror of the same Hugging Face repositories, is a fallback
download host for those files, contacted only when huggingface.co is unreachable; a
missing file or a checksum mismatch never triggers it.

Before it opens a release fetched over HTTPS, the installer (`install.sh`, `install.ps1`)
checks its Sigstore signature with sigstore-python, installed from PyPI (or the configured
mirror) into a throwaway environment in its temporary folder, every file's hash pinned
(`installer/sigstore.txt`). sigstore-python asks `tuf-repo-cdn.sigstore.dev` for Sigstore's
current trust root, and uses the one it carries where that host does not answer. Its cache
stays in the temporary folder, except on Windows, where sigstore-python keeps it under
`%LOCALAPPDATA%\sigstore\sigstore-python`.

There is no analytics, error-reporting or telemetry endpoint. The component update
notice compares versions locally; it does not poll GitHub. ONNX Runtime, which the component
imports to probe the hardware (and to score, where it is the engine), has telemetry of its
own, on by default on macOS and Linux since 1.30: events to `mobile.events.data.microsoft.com`
and a device identifier under the home folder. The component sets `ORT_DISABLE_TELEMETRY=1`
before ONNX Runtime loads (`anagramd/runtime_controller.py`, `import_onnxruntime`), which keeps
it from starting either.

The PDF reader starts one Web Worker per open document (`lib/pdf/structureWorker.ts`,
running the vendored Zotero document-worker, `vendor/document-worker/`). The worker's own
`fetch` calls read the CMaps, standard fonts, image decoders, ONNX runtime and models that
ship inside the extension, by the `chrome-extension://<this extension>/vendor/…` URLs the
reader hands it; the document's bytes are copied into it and nowhere else.

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
| `lib/ui/installationCommand.ts` | `https://github.com/CoderBak/anagram/releases/download/v$` | builds the version-pinned install command the user runs once, which runs the installer only with the SHA-256 the extension was built with; the extension does not fetch it |
| `lib/ui/sourceCode.ts` | `https://github.com/CoderBak/anagram/tree/v$` | the "Source code" link in the Settings and setup footers, to the running version's release tag; opened only when clicked |
| `lib/ui/basecoat-vega.cdn.min.css` | `http://www.w3.org/2000/svg` | the SVG namespace inside data-URI icons; a name, not an address |
| `lib/ui/basecoat-vega.cdn.min.css` | `https://tailwindcss.com` | the licence banner of the vendored Basecoat stylesheet |
| `lib/diagnostics/anonymise.ts` | `https://schema.org/Article` | an example in a comment about `itemtype` vocabularies |
| `lib/hash.ts` | `https://github.com/bryc/code` | the attribution of the cyrb53 hash, in a comment |
| `lib/capture/observers.ts` | `https://github.com/gorhill/uBlock` | the attribution of the batched mutation handling adapted from uBlock Origin's DOM watcher, in a comment |
| `lib/dom/scope.ts` | `https://github.com/mailgun/talon` | attribution of the quoted-mail markers, in a comment |
| `lib/dom/scope.ts` | `https://github.com/lever/planer` | the same attribution, for the JavaScript port |
| `lib/dom/text.ts` | `https://github.com/mailgun/talon` | attribution of the "On … wrote:" pattern, in a comment |
| `lib/dom/text.ts` | `https://github.com/unicode-org/cldr` | attribution of the English sentence-break suppressions, in a comment |
| `lib/dom/text.ts` | `https://github.com/nipunsadvilkar/pySBD` | attribution of the abbreviations set before a name or a number, in a comment |
| `lib/dom/consentBanners.ts` | `https://mozilla.org/MPL/2.0/` | the MPL-2.0 notice of the consent-banner selector list, in a comment |
| `lib/dom/consentBanners.ts` | `https://github.com/duckduckgo/autoconsent` | where that selector list comes from, in a comment |
| `lib/dom/boilerplate.ts` | `https://github.com/lindylearn/unclutter` | the attribution of the page-text guard on the chrome filter, in a comment |
| `lib/dom/boilerplate.ts` | `https://gitlab.wikimedia.org/repos/research/html-dumps` | the attribution of the MediaWiki classes the walk skips, in a comment |
| `lib/dom/translation.ts` | `https://github.com/mengxi-ream/read-frog` | where Read Frog's attribute name was looked up, in a comment |
| `lib/dom/shadow.ts` | `https://github.com/mozilla-firefox/firefox` | the attribution of adapted Firefox code in a comment |
| `lib/pdf/structured.ts` | `https://github.com/zotero/document-worker` | the attribution of Zotero's document-worker, whose reading of a PDF this translates, in a comment |
| `lib/pdf/structured.ts` | `https://github.com/zotero/structured-document-text` | the attribution of the glyph-map decoding adapted from Zotero's library, in a comment |
| `lib/webengine/pin.ts` | `https://huggingface.co/` | builds the pinned modelkit files' download addresses (`anagramd/modelkit.json`'s repository and revision), the native installer's |
| `lib/webengine/pin.ts` | `https://hf-mirror.com/` | the same files' addresses on hf-mirror.com, a mirror of Hugging Face's repositories under the same paths, tried only where huggingface.co answers nothing (lib/webengine/download.ts) |
| `lib/webengine/emoji.ts` | `https://github.com/carpedm20/emoji` | the attribution of the emoji tokenizer port, in a comment |
| `lib/webengine/fasttext.ts` | `https://github.com/facebookresearch/fastText` | the attribution of the fastText prediction port, in a comment |
| `lib/pdf/reading.ts` | `https://github.com/funstory-ai/BabelDOC` | the attribution of the formula-character rules adapted from BabelDOC, in a comment |
| `entrypoints/shadow.content.ts` | `https://github.com/FluentRead/FluentRead` | the attribution of adapted FluentRead code in a comment |
| `entrypoints/shadow.content.ts` | `https://github.com/gorhill/uBlock` | the attribution of the masked Function.prototype.toString adapted from uBlock Origin, in a comment |
| `lib/surfaces/drive.ts` | `https://github.com/ken107/read-aloud` | the attribution of Read Aloud's Google Drive adapters, which the Drive preview surface follows, in a comment |
| `lib/surfaces/pdfjs.ts` | `https://github.com/ken107/read-aloud` | the attribution of Read Aloud's OneDrive adapter, whose pdf.js selectors the pdf.js surface starts from, in a comment |
| `lib/surfaces/kindle.ts` | `https://github.com/ken107/read-aloud` | the attribution of Read Aloud's Kindle adapter, in a comment |
| `lib/surfaces/paragraphs.ts` | `https://github.com/ken107/read-aloud` | the attribution of Read Aloud's Webnovel adapter, whose selectors the Webnovel source uses, in a comment |
| `lib/surfaces/frames.ts` | `https://github.com/ken107/read-aloud` | the attribution of Read Aloud's content handlers, which name the frames below, in a comment |
| `lib/surfaces/frames.ts` | `https://play.google.com/*` | a Google Play Books tab, reached when the frame its books are shown in is granted; does not initiate a request |
| `lib/surfaces/frames.ts` | `https://books.google.com/*` | the same, for Google Books |
| `lib/surfaces/frames.ts` | `https://books.googleusercontent.com/*` | the frame Play Books shows a book in, asked for with the site so the book can be read; does not initiate a request |
| `lib/surfaces/frames.ts` | `https://libbyapp.com/*` | a Libby tab, reached when the frames its books are shown in are granted; does not initiate a request |
| `lib/surfaces/frames.ts` | `https://*.read.libbyapp.com/*` | the frames Libby shows a book's chapters in, asked for with the site; does not initiate a request |
| `lib/surfaces/frames.ts` | `https://*.vitalsource.com/*` | a VitalSource Bookshelf tab, reached when the frame its books are shown in is granted; does not initiate a request |
| `lib/surfaces/frames.ts` | `https://jigsaw.vitalsource.com/*` | the frame VitalSource shows a book in, asked for with the site; does not initiate a request |
| `lib/access/commentFrames.ts` | `https://disqus.com/*` | the site a page's Disqus comment thread is framed from, offered in the panel for the reader to allow; does not initiate a request |
| `lib/access/commentFrames.ts` | `https://www.facebook.com/*` | the same, for Facebook's comments plugin |
| `lib/access/commentFrames.ts` | `https://utteranc.es/*` | the same, for utterances |
| `lib/access/commentFrames.ts` | `https://giscus.app/*` | the same, for giscus |
| `entrypoints/onboarding/index.html` | `https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.en.md` | the user-guide link on the setup page; opened only when clicked |
| `entrypoints/onboarding/main.ts` | `https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.zh-CN.md` | the same link for a Chinese browser |
| `entrypoints/options/index.html` | `https://github.com/CoderBak/anagram/blob/dev/PRIVACY.md` | the privacy-policy link on the settings page; opened only when clicked |
| `entrypoints/stats/index.html` | `https://github.com/CoderBak/anagram/blob/dev/PRIVACY.md` | the privacy-policy link on the statistics page; opened only when clicked |
| `entrypoints/stats/main.ts` | `http://www.w3.org/2000/svg` | the SVG namespace the trend chart is drawn in; a name, not an address |
| `entrypoints/options/main.ts` | `https://www.Example.com/path` | an example in a comment about parsing a hostname |
| `entrypoints/options/main.ts` | `https://` | the scheme prepended to a bare hostname before `new URL()` parses it |
| `entrypoints/reader/index.html` | `http://www.apache.org/licenses/LICENSE-2.0` | the retained upstream PDF.js license notice in an HTML comment |
| `entrypoints/reader/index.html` | `https://github.com/adobe-type-tools/cmap-resources` | the retained upstream CMap attribution in an HTML comment |
| `entrypoints/reader/index.html` | `http://www.w3.org/2000/svg` | the namespace of an inline SVG in the upstream viewer template |
| `entrypoints/reader/index.html` | `https://support.mozilla.org/en-US/kb/pdf-alt-text` | an upstream help link in the viewer's alt-text template; alt-text tools are disabled |

## Storage

### `chrome.storage.local`

Nothing is written to `storage.sync` or `storage.managed`. `storage.session` holds one key,
`statsIds`, only while statistics keep tabs and windows: the random ids the worker gives them
for the browser session (lib/stats/tabs.ts). It dies with the browser session.

| Key | What it holds |
| --- | --- |
| `extensionUpdatePending` | version of a browser extension update waiting for the user to reload |
| `engine` | the engine the user chose, `native` or `inbrowser`; unset until the setup page or Settings has one |
| `engineTier` | the in-browser engine's model tier the setup page decided (`fp16` where FP32 does not fit, and whether FP32 fits as a fallback); unset means FP32 |
| `enabled` | the master switch |
| `siteOverrides` | per-site on/off rules, as hostnames the user chose |
| `showHighlights` | whether analyzed text is underlined in place |
| `autoOpenPdfs` | whether a PDF tab opens in the reader by itself |
| `pdfStructure` | whether the reader's paragraphs come from the vendored Zotero document-worker (default) or from its own geometric reflow; no control in the UI |
| `pdfReadAhead` | whether the reader also reads the pages it has not drawn, in the background, paced by how fast the engine is (default on; Settings, PDFs) |
| `debug` | verbose logging |
| `cacheMode` | persistent scores (up to 30 days) or memory only |
| `displayMode` | mark everything, or only flagged paragraphs |
| `flagFrom` | the word paragraphs are flagged from: lightly edited, heavily edited (default) or AI-generated |
| `underlineScope` | underlines on the flagged paragraphs (default) or on every paragraph read |
| `statsConfig` | what the reading statistics keep: off (default), or a layer for each dimension and how long each part is kept ([statistics.md](statistics.md)) |
| `statsSecret` | the random key the statistics' hashes and sketches are made with; never exported, made anew when the statistics are cleared |

### IndexedDB `anagram-scores`

The persistent score cache. A row holds the model identity, a 128-bit SHA-256 digest of
where the text was read (the tab's top-level site, the frame's origin) and one of the text the
model read, the verdict (bucket, four probabilities, score), token count, truncation flag,
detected language and write time. **No raw page text is stored in the score cache.** Nor is
any site's name. A verdict is shared only within the site it was read on: one that came back at
once would tell a page the user had read the same text elsewhere. A private window's verdicts
are kept in memory, apart from the rest. An unsalted digest is not anonymous: someone with
local cache access can test guesses about known text and sites. The store keeps at most 20 000 rows, pruned back to 15 000 oldest first, and
rows expire 30 days after they were written.

### IndexedDB `anagram-stats`

The reading log, only once the user has chosen what to keep in Settings, Statistics (off by
default); [statistics.md](statistics.md) describes it, each choice, and the file it exports
to. Stores: `visits` (one per page, frame or document read), `units` (one per paragraph of a
visit), `events` (a visit's scroll, input and on-screen steps), `texts` (a paragraph's text,
only where the user chose to keep it), `totals` (per day, kind of page, site and page),
`tabs` (window and tab events, and time in front of pages Anagram cannot read, with no address),
`context` (the configuration, device, engine and settings it was recorded under) and `meta`.
What each holds is what the user chose: a layer for each dimension, from exact to none;
addresses, titles and texts can be kept as salted hashes instead. Nothing is recorded from a
private window, from a site the user switched Anagram off for, or from Analyze text, and never
what is typed or what is selected or copied. Each part is deleted after the days the user chose
for it, at most once a day; "Clear statistics" deletes everything and makes a new hashing key.
Only the extension's own pages read the database, and nothing in it is sent anywhere: an export
is a file the user saves.

### Other browser storage

- `sessionStorage` key `anagram-docs-return` in a Google Docs tab: the editor address, so
  "Back to editor" returns to the exact view. It dies with the tab.
- `sessionStorage` key `anagram-reader-source` in a PDF reader tab: the address of the PDF
  that tab opened, so a refresh or Back reads it again from its source. It dies with the tab.
- The packaged PDF.js viewer uses `localStorage` keys `pdfjs.history` (up to 20 document
  fingerprints with view state, no text or password) and `pdfjs.preferences`. These are
  not erased by "Clear cached verdicts".
- The in-browser engine keeps its model files in the extension origin's private file
  system (OPFS), directory `anagram-engine`: the verified model and tokenizer files, `.part`
  files of an unfinished download, and `state.json` (the engine's preferences and which
  files were verified). Deleted by "Delete model files", or in Settings once the local
  engine is in use; never page text.

## On disk, outside the browser

The local engine lives in `~/.anagram` on macOS/Linux and `%LOCALAPPDATA%\Anagram` on
Windows: a private Python runtime, the application, verified model files and partial
downloads, the saved runtime choice, and registration records. Browser registration adds
one manifest named `dev.coderbak.anagram.json` in the browser's user-level
`NativeMessagingHosts` directory (or an `HKCU` registry pointer on Windows), allowing
only the exact extension ID. **Complete uninstall removes the entire component directory,
including anything a user later put inside it.**
