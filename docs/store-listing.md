# The Chrome Web Store submission

**0.5.0 submission draft — not submitted or published.** Native Messaging is implemented
and is the normal scoring/setup path. Matching native component archives, version-pinned
installers and browser packages must be published together before reviewers can use the
installation command. Windows x64 has an implementation, but still needs real Windows/CI
and manual release QA. Refresh the screenshots and complete the owner-supplied fields
below before submission; implementation alone is not a claim of store approval.

Every field the Chrome Web Store developer dashboard asks for, written out so it can be
pasted, and every answer tied to a file a reviewer could open. It is the paperwork half of
[`docs/footprint.md`](footprint.md): that page is the inventory of what the extension
touches, this one is what the dashboard is told about it. Where the two could disagree,
the footprint page wins — it is the one a test reads on every `vitest` run.

Implementation facts below describe the 0.5.0 shipping configuration; verify the final
release artifacts before uploading. `npm run build` writes
`output/chrome-mv3/manifest.json`. Use `npm run release` to prepare the matching release
assets, including the browser ZIP; a local `npm run zip` alone is not the complete release. The test
build (`output-test/`) has the two optional site patterns REQUIRED instead and must never
be uploaded — see `wxt.config.ts`.

---

## 1. Store listing

### Item name

`Anagram for Chrome` — the `name` in the built manifest (`wxt.config.ts` builds it from
the target). The dashboard takes the name from the package, so nothing is typed here.

### Short description (132 characters maximum)

This is the manifest's `extDescription` and must stay identical to it, because the
manifest is what the store shows next to the icon. Source of truth:
`public/_locales/en/messages.json` → `extDescription`. It is 78 characters.

```text
Shows how heavily each paragraph looks AI-edited. Scored on your own computer.
```

If this line is ever reworded, change `public/_locales/en/messages.json` first, then
`public/_locales/zh_CN/messages.json`, then this file — not the dashboard on its own.

### Detailed description

Plain, no superlatives, and no claim the code does not make. Paste as is.

```text
Anagram puts a small chip after each paragraph you read. The chip is a number between
.00 and 1.0 with one of four verdicts beside it — Human, Lightly edited, Heavily
edited, AI-generated.

WHAT THE NUMBER IS

The number is an estimate of the EXTENT of AI editing in that paragraph: how far the
text sits, as a whole, between untouched human writing (.00) and fully AI-generated
prose (1.0). It comes from EditLens (Thai, Emi, Masrour & Iyyer, ICLR 2026), a model
that was trained to rate the size of the change between an original text and an edited
one, and which never sees the original when it runs.

WHAT THE NUMBER IS NOT

.93 does not mean "93% of the words were written by AI", and it is not the probability
that the paragraph is AI. It is a position on a scale, which is why it is written as a
number on that scale and never as a percentage. Two paragraphs whose four-way
distributions look nothing alike can end up with the same number, so hovering a chip
shows all four probabilities, not just the one. Every readout carries the same
sentence: an estimate, not proof. Anagram is not a detector, it produces no verdict
about a person, and it should not be used to enforce anything.

WHERE THE TEXT GOES

To the Anagram local component on your own computer, through the browser's Native
Messaging connection. Browsing text is used in memory for scoring and is not sent to
an online analysis service. There is no account, sign-in, telemetry, analytics or remote
error reporting.

Model setup and explicit local-component updates download public files from model,
release and runtime distribution hosts. Those downloads carry ordinary network metadata,
but no browsing text. The native program runs with your ordinary OS privileges; the
browser extension's web-request policy is not a sandbox for the native program.

FIRST SETUP

The store extension and ZIP both open the same setup page. It detects your OS and shows
one version-matched installation command with your exact extension ID. Run it once in
Terminal or PowerShell. After connection, close the terminal and manage everything in
Settings: device-selected model preparation (usually 1.43 GB including language detection, plus runtime and temporary space), pause/resume,
benchmarking, device and precision choice, updates, and cleanup. The model is available
without an account; its CC BY-NC-SA 4.0 attribution and noncommercial terms still apply.

Settings shows detected devices, selected files and preparation bytes, including reused
verified files. Extra compatible models and experimental CPU INT8 are available through
an explicit expanded-comparison download. Returning to recommended keeps existing extras.

The first benchmark starts automatically after preparation. About 30 seconds is the shared
measurement budget; loading and warmup take extra time. Review the results and explicitly
apply a configuration. FP32 is recommended; FP16 is optional and INT8 is experimental.
These measurements compare speed and memory, not detection quality. The browser reuses a
valid saved choice on restart. No daily terminal command is needed.

Until the engine is ready, paragraphs show Unavailable and are retried when it answers.
The local installer targets Apple Silicon macOS, supported Linux x64/ARM64 and Windows
x64. Check the linked guide for platform limitations and current validation status.

WHAT IT READS

Nothing, until you say so. Anagram installs with access to no website at all. You can
grant every site in one click from the first-run page or the options page, grant one
site at a time from the popup, or grant none and use the right-click entries on a
single page when you want them.

WHAT YOU GET

- A chip after every analyzed paragraph, with a hover card showing the verdict, all
  four probabilities, how many words were read, and a Copy text action.
- Quiet marks under the flagged paragraphs only, or under everything, or under nothing.
- A floating ball with a flagged counter; click it for a list of the flagged
  paragraphs, jump between them, copy a report, or switch Anagram off for the site.
- Right-click to analyze a selection — including text in a text box — or to analyze one
  page on a site you keep Anagram off for.
- A reading mode for PDFs that draws the real pages and puts the chips over them, and
  one for Google Docs that opens in the same tab.
- Keyboard shortcuts for all of it, and a triage panel that works without a mouse.
- English and Simplified Chinese interface, following your browser's language.

ENGLISH ONLY

The model is English-only, so text in another language is detected and left alone: it
gets a gray "Unsupported language" chip, no number and no mark. A paragraph shorter
than about fifty words is too little evidence to judge; eligible neighboring short
paragraphs within one text context are read together rather than skipped. Separate posts
and quoted text keep their boundaries.

Source, the full list of everything the extension touches, and the privacy policy:
see the links on this listing.
```

### Category, language, and the rest of the tab

| Field | What to put |
| --- | --- |
| Category | Developer's choice; "Productivity → Tools" fits an annotation utility better than "Education". |
| Language | English (United States). Simplified Chinese is shipped as a UI locale, but the listing text above is English. |
| Screenshots | The existing five files in `docs/store/` are 1280×800 (`1-article` through `5-first-run`), but are **not current 0.5.0 submission assets**. In particular, the first-run and popup images predate native setup. Refresh them using the shipping UI and a disclosed fixture, verify all visible copy, and do not present fixture timing/memory values as measured model performance. `test/store-shots.mjs` is the existing capture harness and may need its setup fixture updated. README images in `docs/screenshots/` have different dimensions and are not substitutes. |
| Small promo tile (440×280) | `<< owner to fill in >>` — not in the repository. |
| Official URL / homepage | `<< owner to fill in >>` |
| Support URL | `<< owner to fill in >>` — the repository's issue tracker is the contact the privacy policy names. |
| Privacy policy URL | `<< owner to fill in >>` — a public address serving `PRIVACY.md`. The dashboard requires one because the extension handles user data. |

---

## 2. Privacy tab

### Single purpose

```text
Anagram annotates the text on a web page with a per-paragraph estimate of how heavily
it appears to have been edited by AI, computed by the local component running on the
user's own computer.
```

That is the whole extension. There is no second feature: the PDF and Google Docs
reading modes exist because those two surfaces have no readable text in the page for the
same annotation to attach to, and they produce the same chips from the same pipeline
(`lib/capture/orchestrator.ts` is entered from all three).

### Permission justifications

One paragraph each, for exactly what `output/chrome-mv3/manifest.json` declares:
`"permissions": ["storage", "activeTab", "contextMenus", "scripting", "nativeMessaging", "webNavigation", "webRequest"]`,
`"optional_host_permissions": ["https://*/*", "http://*/*", "file:///*"]` — and **no `host_permissions`
key at all**. The native permission carries its own install warning; absence of required
host access does not mean installation has no permission warning.

**`storage`**

```text
Stores settings in chrome.storage.local: master and per-site switches, marking/display/scope
preferences, short-paragraph grouping, PDF routing, debug logging and floating-ball
positions. It also records a cache-migration flag and an extension-update version awaiting
explicit reload. lib/settings/settings.ts and entrypoints/background.ts contain the
writes; docs/footprint.md lists every key. Nothing is written to storage.sync,
storage.session or storage.managed. No page text or browsing-history list is stored here.
The local native component separately stores its setup state, model files, saved runtime
choice and benchmark results, as disclosed in PRIVACY.md.
```

**`activeTab`**

```text
Gives one-off access to the tab the user is looking at, at the moment they ask for
something, on a site they have granted nothing for. It is what makes the right-click
entries, the keyboard shortcuts and the popup's "Analyze this page" work without the
user having to grant the site first: the click itself is the grant, it covers that one
tab, and it ends when the tab navigates. lib/access/worker.ts (ensureInjected) is the
only code that uses it, and it does one thing — put the extension's own packaged content
script into that tab. Nothing is read from the tab beyond the page text the user just
asked to have analyzed, and no rule, setting or permission is written as a side effect.
```

**`contextMenus`**

```text
Creates the extension's right-click entries, once, on install: "Analyze selection with
Anagram" (on a selection), "Analyze this page with Anagram" and "Copy page diagnostics"
(on a page), and "Open PDF with Anagram" (on a link ending in .pdf). They are created in
entrypoints/background.ts from fixed, translated titles; nothing about the page is read
to build them and no menu is created dynamically from page content.
```

**`scripting`**

```text
Two uses, both of the extension's own packaged files. First, the content script is not
declared in the manifest at all: it is registered at runtime with its match patterns set
to exactly the origins the user has granted, and re-registered whenever that set changes
(lib/access/worker.ts, syncRegistration). That is what lets the extension install with
access to no site. Second, chrome.scripting.executeScript injects that same content
script file into one tab for the one-off actions described under activeTab. The only
other thing injected is a three-line function (markOnDemand) that sets a flag so the
injected script knows it was invited for a single action. No code is ever fetched,
assembled from a string, or evaluated: the file injected is content-scripts/content.js
from inside the package.
```

**`nativeMessaging`**

```text
Required for Anagram's core local scoring path. The browser launches and communicates
with the installed dev.coderbak.anagram host, whose registration allows this exact
extension ID. It carries paragraph-scoring requests and local setup/status operations:
model download and pause/resume, runtime benchmarking and explicit device/precision
selection, engine stop/start, component update and confirmed cleanup. The extension's
background bridge admits lifecycle operations only from its own top-level setup and
Settings pages; web pages and content scripts cannot invoke them. Operations are a fixed,
validated list, not caller-supplied paths, programs or shell commands. Implementation:
lib/backend/nativeTransport.ts, nativeBridge.ts and nativeProtocol.ts; the native host is
in anagramd/native_host.py and native_component.py. One OS-specific command on the setup
page installs/registers the component; the browser starts it for later use.
```

Native Messaging is outside `connect-src`. The host uses ordinary user OS privileges and
downloads model/runtime/release files as disclosed; it does not upload browsing text.
No `downloads` or `management` permission is required. Native code owns its downloads and
cleanup; the extension uses its own `management.uninstallSelf` only after verified cleanup.

**No required host permission — why the extension asks for none**

```text
Native Messaging is the only inference connection. The extension installs with no
website access; persistent website access is an independent optional grant. Extension
pages add connect-src 'self', while the manifest permits HTTP(S) and local-file sources
for a private PDF loader. That loader validates a one-use ticket for the exact authorized
document and narrows its connection policy. The native component does not listen on a
network port. Browser CSP does not govern its separate model and update downloads.
```

**`webNavigation` and `webRequest`**

```text
Observes top-level navigation and available response metadata to recognize PDF documents,
including browser PDF surfaces where content-script detection is unavailable. Navigation
events can expose a current tab address before a site grant; reading/opening the document
still requires authorization. Current-tab state is kept in memory, not a persisted history
log. It does not modify network requests or send navigation data to inference.
```

**Optional host permission `file:///*`**

```text
Allows an explicitly authorized local PDF tab to open in Anagram. Browser-level file
access controls also apply. The private loader validates the source ticket and local
file URL; it is not a native arbitrary-file-read API. File selection/drop remains an
alternative without a general local-file grant.
```

**Optional host permissions `https://*/*` and `http://*/*`**

```text
The websites whose text the user wants annotated. They are OPTIONAL and are not held at
install: the extension ships with access to no site, and asks for access only inside a
click the user made — "Allow on all sites" on the first-run or options page, or the
"This site" switch in the popup, which asks for that one origin
(lib/access/grant.ts, requestAccess; lib/access/patterns.ts, sitePattern). Access is
used to read the text of paragraphs, to draw the chips next to them, and for nothing
else: no form is read automatically, no keystroke is recorded, and no cookie is read or
written by the extension. Explicit selection analysis can include text selected in an
editable field. Original PDF/Google Docs reads are disclosed separately below.
Page changes are the extension’s annotation controls and marks. The user can take every
grant back from the options page or from chrome://extensions → Site access, and open tabs stop immediately.
```

If the dashboard asks about `clipboardWrite`, it is not in the Chrome manifest. It is
declared optional on Firefox only, for "Copy page diagnostics", and is requested inside
that click (`wxt.config.ts`, `entrypoints/background.ts`).

### Are you using remote code?

**Draft answer: no remotely hosted code executes inside the extension.** Verify the
live dashboard wording before selecting its answer, and disclose the separate native
installation/update mechanism. The evidence for the browser package:

- Everything the extension runs is in the uploaded package. `scripts/vendor.mjs` builds
  the three lazily-loaded chunks (Mozilla Readability, DOMPurify, and the extension's
  own page-diagnostics chunk) plus pdf.js into `public/vendor/` at build time, and
  `lib/lazy.ts` loads them with `import()` of a `chrome-extension://` URL. Nothing is
  fetched from a CDN.
- The manifest's `content_security_policy.extension_pages` is
  `script-src 'self' 'wasm-unsafe-eval'`, so no remote script and no `eval` can run at
  all. There is no `eval(`, no `new Function`, no `importScripts` and no `document.write`
  anywhere in `lib/` or `entrypoints/`.
- The manifest allows original PDF source connections; ordinary extension pages add a
  stricter `connect-src 'self'` policy, and the private loader narrows access to its
  authorized source. `node test/csp-check.mjs` checks browser policy behavior separately
  from the document-ticket tests. None of these policies sandboxes the native process
  or prevents the original webpage from loading its own resources.
- **WebAssembly**: `'wasm-unsafe-eval'` is in the policy for two files that ship inside
  the package — `vendor/wasm/openjpeg.wasm` and `vendor/wasm/jbig2.wasm`, pdf.js's
  JPEG 2000 and JBIG2 image decoders. Without them a scanned PDF page in either format
  draws blank. They are never downloaded; `node test/pdf-codecs-check.mjs` opens a PDF of
  each kind in the packaged extension and measures the pixels.
- The native component downloads verified model files during first setup or an explicit
  resume/redownload, and downloads component releases only on an explicit update. The
  one-time installer obtains its private runtime and dependencies. These executable native
  files do not execute in the extension renderer, and no native response is evaluated as
  browser code. Model inference loads local files with remote-code loading disabled.

### Data usage

Google counts data as handled **even when it never leaves the device** — the User Data
FAQ says so explicitly. So the answer below is written from what the extension *touches*,
not from what it *transmits*.

| Dashboard category | Tick? | Why |
| --- | --- | --- |
| Personally identifiable information | **No** | No account, identity profile or dedicated identifying field is collected. Arbitrary page prose can contain names or other personal information and is handled as Website content. |
| Health information | **No** | Not read as such. Page text on a health site is handled as website content, below, and nothing marks it out. |
| Financial and payment information | **No** | Same. No payment flow, no form reading, no transaction data. |
| Authentication information | **No** | The extension does not use the browser cookies API. Original-document requests can include cookies attached by the browser without exposing them to the scoring payload. A password typed to unlock a PDF is processed locally by PDF.js and is not stored or uploaded. |
| Personal communications | **No** *(see the note)* | Anagram does not single out messages, mailboxes or chats, and stores none. It annotates prose on whatever site the user granted, which on a webmail or forum page is that page's text — handled as website content. See the note under this table. |
| Location | **No** | No geolocation API or location lookup. Native download hosts receive the ordinary source IP of installation/update requests; browsing content is not included. |
| Web history | **Review current dashboard wording before submission** | No general visited-page log is kept. Site preferences hold hostnames; the packaged PDF viewer separately keeps up to 20 local document fingerprints and view state in `pdfjs.history`. It does not upload them. Disclose this local document history instead of claiming no document history exists. |
| User activity | **Review current dashboard wording before submission** | No interaction analytics is uploaded. Reading interactions drive local scoring/UI; PDF.js additionally saves local page/zoom/scroll/sidebar state and viewer preferences. Do not claim that scroll position is never stored. |
| **Website content** | **YES** | This is the one. On a site the user granted, the extension reads the text of the page's paragraphs, sends that text to the local component through Native Messaging, and draws the result next to the paragraph. It also reads a PDF the user opened in the reading mode, and a Google Doc the user asked to have analyzed. See the paragraph below for the exact handling. |

Note on **Personal communications**: the honest boundary is that Anagram handles whatever
prose is on a page the user granted, which can be an email in a webmail reader. It does
not seek out, classify, index or retain communications, and nothing it produces leaves the
computer, so "Website content" is the category that describes it. If the listing is ever
positioned around reading mail or chat, tick this box as well.

**What to say in the "Website content" explanation field:**

```text
Anagram reads paragraph text on pages the user allowed, or on a user-initiated one-off
analysis, and sends it through Native Messaging to dev.coderbak.anagram on the same
computer. The component returns numeric verdicts and uses the text in memory only.
Browsing text is not uploaded. Model/runtime installation and explicit component updates
make separate public download requests carrying ordinary network metadata, not page text,
page hostnames, benchmark results or saved runtime choices. Browser CSP restricts extension
web requests, not the native program's OS/network access.

Opening a PDF or Google Doc can fetch its original document again with normal browser
credentials. Displaying a Google Doc can also load images/style resources belonging to
that document. Local files are read only through user selection or an authorized file
route. These source requests are separate from local inference.

No page text is persisted. The IndexedDB anagram-scores cache holds a model identity,
53-bit hash of normalized text and numeric verdict metadata for at most 30 days; it never
holds the text itself. Clear cached verdicts in Settings empties it. Private/incognito
results are not written to disk. Native scoring requests contain the contract version,
block IDs and text. The internal page-to-worker envelope is not forwarded to the native
component; it does not receive page URLs, hostnames, cookies or browsing history.
```

### The three certifications

The implementation supports the following draft answers. The submitting owner must read
the exact live dashboard wording and make the certifications before submission:

| Certification | Why it holds |
| --- | --- |
| I do not sell or transfer user data to third parties, outside of the approved use cases. | Browsing text and model results are not sold or uploaded. Public native download hosts receive ordinary request metadata during installation and explicit updates, as disclosed in PRIVACY.md; browser CSP is not the reason the native program keeps browsing text local. |
| I do not use or transfer user data for purposes unrelated to my item's single purpose. | The only use of page text is having it scored and showing the score next to the paragraph it came from. `docs/footprint.md` lists every call site and every stored key, and `test/node/footprint.test.ts` fails the build if a call site is added and not written down. |
| I do not use or transfer user data to determine creditworthiness or for lending purposes. | Nothing of the kind exists in the product. |

### Privacy policy URL

`<< owner to fill in >>`. The text to publish there is [`PRIVACY.md`](../PRIVACY.md) in
the repository root.

---

## 3. A reviewer's test guide

Include this, or a shortened version of it, in the "Notes for reviewers" / testing
instructions field. Real scores require the separate native component, verified model
files and an explicitly applied runtime choice.

### Release prerequisites

Do not send an unpublished development package to reviewers with a nonworking installation
command. Publish the matching `v0.5.0` native archives, checksums and `install.sh` /
`install.ps1` assets first, and distribute the matching browser package. Ordinary source
builds intentionally show an unpublished-installer notice with Copy disabled. Windows x64
release approval also needs Windows execution/CI and manual QA; macOS tests do not provide
that evidence. See the [English](user-guide.en.md) and [中文](user-guide.zh-CN.md) guides.

### Install and connect the native component

1. Install the shipping extension in a clean profile. The same full-page onboarding opens
   for store and ZIP installations. Chrome's required Native Messaging warning is separate
   from optional website access; no website is initially granted.
2. Read the setup size disclosure (usually 1.43 GB for the recommended set including language detection,
   plus runtime/temporary space). Use **View installation script**, then **Copy installation command**. Run the
   page's command once in Terminal on macOS/Linux or PowerShell on Windows. It contains
   this extension's actual ID and version-pinned release URLs; do not substitute a generic
   command or somebody else's unpacked ID. Firefox authorizes `anagram@coderbak.dev`.
3. Keep the setup page open until connection succeeds, then close the terminal. The browser
   launches `dev.coderbak.anagram` automatically afterward. No listening HTTP server or
   manual daily start is needed. Inspect the native registration's exact allowed ID and
   the paths listed in [footprint](footprint.md).
4. Observe automatic model download, byte/file progress, Pause and Resume, then loading,
   warmup and measurement. The 30-second budget is shared measurement time, not a promise
   that the whole setup takes 30 seconds. Missing resource metrics read Not available.
5. After benchmarking, an FP32 recommendation may be preselected, but inference is not ready
   until **Use selected configuration** is clicked and that selection is actually loaded.
   Compare FP16/INT8 options without treating timings as a detection-quality evaluation.
6. With no website grant, use a one-off Analyze action on an article, or grant one/all sites
   explicitly. Chips then show real model results. Try a PDF and Google Docs reading mode.
   Revoke access and verify annotations stop. An unavailable model produces no invented
   verdict; the popup offers **Open setup and Settings**, not a terminal start command.
7. Restart the browser. A compatible saved selection is reused without another benchmark.
   Deliberate Stop/Pause remain in force. Opening a second browser against the same component
   shows an in-use explanation rather than installing or loading a duplicate model.
8. In Settings, try a configuration change, rerun/cancel, Stop/Start, and Delete model files.
   Deletion requires confirmation with the footprint and does not trigger redownload on
   the next launch. Component updates are explicit; extension updates are managed by the
   browser/store or by replacing and reloading the ZIP installation. A pending browser
   update has an explicit **Reload extension** action.
9. Test complete uninstall in a disposable profile/root. macOS/Linux self-uninstall is
   requested only after confirmed native cleanup. Windows may return **scheduled** and
   open a progress window: wait for that window's successful result before manually removing
   the extension. A disconnected host is not proof of cleanup. Direct browser Remove leaves
   native files; manually downloaded ZIPs and unpacked extension folders are not erased.

### Without a connected component

Setup shows a missing/interrupted connection and the appropriate one-time installation or
retry guidance; a host-lock conflict is identified as another Anagram instance. Website
access remains optional, and normal settings/demo content can still be inspected. A real
inference demonstration needs installed model files and an applied runtime selection.
Do not use fixture scores or timings as evidence of real-model performance.

### Verify the data boundary

- Read [footprint](footprint.md), [network verification](network-privacy.md) and
  [PRIVACY.md](../PRIVACY.md): native scoring/management,
  authorized PDF/Docs original-source reads, storage and public native downloads are
  separate entries.
- Inspect extension-page/worker Network requests and Native Messaging frames. Scoring uses
  the native pipe; there must be no HTTP scoring requests. Page text is
  handled in memory, and lifecycle frames contain fixed operations rather than commands.
- Observe the native process's network activity separately during install/download/update.
  Those requests fetch model/runtime/release files and must not contain browsing text,
  page hostnames, benchmarks or runtime choices. Browser DevTools and CSP cannot establish
  an OS sandbox for that process.
- `node test/csp-check.mjs` checks extension web-request APIs in Chrome and Firefox. It is
  useful evidence for those APIs, not a claim that native programs cannot access the network.

---

## 4. Things a reviewer may ask

**Why optional all-sites access alongside required Native Messaging?**
Site access lets Anagram read and annotate the pages the user chooses. Native Messaging
lets it ask the installed local component to score that text. These are separate browser
capabilities. No website is granted at install; each persistent grant comes from the user's
click and can be withdrawn. Native Messaging is required because local inference is the
core function, not a future or optional feature.

**Why no required localhost host permission?**
Inference uses Native Messaging exclusively. There is no HTTP inference server; the
manifest's HTTP allowance serves authorized original PDFs, not a scoring backend.
The native program retains ordinary user
OS privileges for loading models and downloading installation/update files.

**Why `<all_urls>`-shaped patterns rather than a list of sites?**
Anagram is not about particular websites — it annotates prose wherever the reader finds
it. A fixed list would be wrong for everybody. The user picks: all sites in one click, or
one site at a time from the popup, which asks for that single origin
(`sitePattern` in `lib/access/patterns.ts` builds `https://host/*` from the tab's URL).

**Why `scripting`, when the extension could declare a content script?**
Precisely so that it does not have to. A declared content script needs its match patterns
in the manifest, which means asking for site access at install. Registering it at runtime
(`lib/access/worker.ts`) means the match patterns are exactly what the user has granted,
and the registration is re-asserted on install, on browser start, on every grant and on
every withdrawal. The same permission injects the extension's own content script for the
one-off `activeTab` actions. No code is fetched or evaluated.

**Why does a content script `fetch` the URL its own tab is already showing?**
Two places, both same-origin re-reads of the document already in front of the user, and
both are in the inventory:

- `lib/pdf/handoff.ts` — Chrome's online PDF tab can re-read its own document with normal
  credentials and `cache: "force-cache"`, then stream bytes through a bounded, one-time
  ticket. Cache preference does not guarantee no network request. Firefox and local-file
  routes use a private loader for the exact authorized source. The reader's `?src=` alone
  cannot authorize a read; the generic viewer receives bytes, not an arbitrary URL.
- `lib/docsOverlay.ts` — a Google Doc's editor is a canvas with no text in the DOM to
  read, so the reading mode fetches the same document's own `mobilebasic` rendering,
  same-origin with the tab's own cookies, and analyzes that. The document is never
  modified; the overlay closes with Esc. Images and CSS references in that original
  document can produce additional resource requests when it is displayed.

**What is `use_dynamic_url` doing on the web-accessible resources?**
Three files are web-accessible because a *content script* importing an extension URL
performs that load in the page's world, so the file has to be declared:
`vendor/readability.min.mjs`, `vendor/purify.min.mjs`, `vendor/diagnostics.min.mjs`.
`use_dynamic_url: true` makes Chrome serve them at an address that rotates per session and
is handed only to the extension's own content script, so a web page cannot fetch them by
guessing the extension id — which would be a reliable way to detect that Anagram is
installed. The rest of `public/vendor/` (pdf.js, its worker, CMaps, fonts, the two wasm
decoders — about three megabytes) is **not** web-accessible: the reading mode is an
extension page and loads them as its own origin.

**Why install a local component?**
The 355M-parameter EditLens classifier and its runtime stay outside the small browser
package. The browser starts the exact-ID registered host; model files are verified and
loaded locally. Settings manages the native lifecycle, so a user does not keep a terminal
or a manual HTTP service running. The ZIP contains the extension only. A native update
downloads native application files, not scripts to execute in the browser extension.

**Why no `downloads` or `management` permission for setup and removal?**
The native component performs its own downloads and owned-file cleanup. After verified
cleanup, the extension can request removal of itself with `management.uninstallSelf`; it does
not inspect, modify or remove other extensions. Scheduled Windows cleanup requires the
user to wait for the system window's final result before removing the extension manually.

**Is the score a detection claim about a person?**
No, and the product is careful not to word it that way. It is EditLens's estimate of the
extent of AI editing in one paragraph, on a scale from `.00` to `1.0`; the README's
"What the number is not" section spells out that it is neither a share of words nor a
probability that the text is AI. Every card carries an "estimate, not proof" caveat.

---

## 5. Still to be produced

| Item | State |
| --- | --- |
| Privacy policy at a public URL | `PRIVACY.md` is written; the hosting address is `<< owner to fill in >>` |
| Listing screenshots at 1280×800 or 640×400 | **Refresh required for 0.5.0.** Existing `docs/store/*.png` and capture fixtures predate native onboarding. Verify current popup/setup copy, label any fixture benchmark values honestly, and use readable prose rather than walker-test filler. |
| Small promo tile 440×280 | `<< owner to fill in >>` |
| Official URL / homepage | `<< owner to fill in >>` |
| Support URL | `<< owner to fill in >>` |
| Developer account contact email (verified) | `<< owner to fill in >>` |
| Matching published native assets | **v0.5.0 published.** Terminal-first preparation on `dev` is unreleased; publish matching installers, native archives and checksums with the next authorized release before distributing its browser ZIP. |
| Windows x64 validation | **Pending real Windows/CI and manual release QA.** Implementation or macOS fixture tests alone do not establish Windows support. |
| The package | `npm run release` prepares matching assets; review the Chrome ZIP from `output/chrome-mv3`. Never upload `output-test/`. Packaging does not submit a store listing. |
