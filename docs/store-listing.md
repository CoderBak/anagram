# The Chrome Web Store submission

Every field the Chrome Web Store developer dashboard asks for, written out so it can be
pasted, and every answer tied to a file a reviewer could open. It is the paperwork half of
[`docs/footprint.md`](footprint.md): that page is the inventory of what the extension
touches, this one is what the dashboard is told about it. Where the two could disagree,
the footprint page wins — it is the one a test reads on every `vitest` run.

Facts below were read from the SHIPPING build. `npm run build` writes
`output/chrome-mv3/manifest.json`; `npm run zip` makes the package to upload. The test
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

To a scoring service on your own computer, and nowhere else. Anagram cannot reach the
internet: the extension's Content-Security-Policy lets it open a connection to
127.0.0.1 and localhost only, so fetch, XMLHttpRequest, WebSocket, EventSource and
sendBeacon have nowhere else to go, whatever the code asks for. There is no account, no
sign-in, no telemetry, no analytics, no error reporting and no update check.

The scoring service is a separate program you install yourself (macOS and Linux). Until
it is running, paragraphs show a gray "Unavailable" chip and are scored automatically
the moment it answers.

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
than about fifty words is too little evidence to judge; short paragraphs by one author
are read together rather than skipped.

Source, the full list of everything the extension touches, and the privacy policy:
see the links on this listing.
```

### Category, language, and the rest of the tab

| Field | What to put |
| --- | --- |
| Category | Developer's choice; "Productivity → Tools" fits an annotation utility better than "Education". |
| Language | English (United States). Simplified Chinese is shipped as a UI locale, but the listing text above is English. |
| Screenshots | 1280×800 or 640×400, at least one, up to five. `docs/store/` holds the five, at exactly 1280×800 — `1-article`, `2-card`, `3-panel`, `4-pdf`, `5-first-run` — produced by `node test/store-shots.mjs` against the fake daemon, so they show real chips on a real page and no live site. Re-run it after any change to the chip, the panel, the reading mode or the first-run page. (`docs/screenshots/` are the README's, at 1180×780 and 300×470; none of those is a permitted size.) |
| Small promo tile (440×280) | `<< owner to fill in >>` — not in the repository. |
| Official URL / homepage | `<< owner to fill in >>` |
| Support URL | `<< owner to fill in >>` — the repository's issue tracker is the contact the privacy policy names. |
| Privacy policy URL | `<< owner to fill in >>` — a public address serving `PRIVACY.md`. The dashboard requires one because the extension handles user data. |

---

## 2. Privacy tab

### Single purpose

```text
Anagram annotates the text on a web page with a per-paragraph estimate of how heavily
it appears to have been edited by AI, computed by a scoring service running on the
user's own computer.
```

That is the whole extension. There is no second feature: the PDF and Google Docs
reading modes exist because those two surfaces have no readable text in the page for the
same annotation to attach to, and they produce the same chips from the same pipeline
(`lib/capture/orchestrator.ts` is entered from all three).

### Permission justifications

One paragraph each, for exactly what `output/chrome-mv3/manifest.json` declares:
`"permissions": ["storage", "activeTab", "contextMenus", "scripting"]`,
`"optional_host_permissions": ["https://*/*", "http://*/*"]` — and **no `host_permissions`
key at all**, which is why installing Anagram shows no permission warning.

**`storage`**

```text
Stores the user's own settings in chrome.storage.local: the scoring service's loopback
address, the master on/off switch, per-site on/off rules the user wrote, marking style,
display mode, analysis scope, whether short paragraphs are grouped, whether PDFs open
in the reading mode, debug logging, the position the user dragged the floating ball to,
and one flag recording that an obsolete cache was swept. lib/settings/settings.ts holds
the defaults and the validation; docs/footprint.md lists every key. Nothing is written
to storage.sync, storage.session or storage.managed, so no setting leaves the profile or
the computer. No page text, no URL history and no identifier of any kind is stored here.
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

**No required host permission — why the extension asks for none**

```text
Anagram declares no host_permissions. Its only network destination is a scoring service
the user installed on their own computer, reached over plain HTTP on loopback — GET
/health to see whether it is running, POST /score to have paragraphs scored — in
lib/backend/httpClient.ts. Two things keep it there, and neither is a permission: the
address setting accepts only http://127.0.0.1[:port] and http://localhost[:port]
(lib/settings/settings.ts, isLoopbackUrl), and the manifest's Content-Security-Policy
limits connect-src to those same two hosts plus the extension's own origin, so neither
a setting nor a bug can point it elsewhere. Reading the service's answer needs no
permission either, because the service answers CORS for extension origins and refuses
every other origin outright (anagramd/serve.py); a web page cannot read it whatever
this extension does. The extension therefore installs with access to nothing at all.
```

**Optional host permissions `https://*/*` and `http://*/*`**

```text
The websites whose text the user wants annotated. They are OPTIONAL and are not held at
install: the extension ships with access to no site, and asks for access only inside a
click the user made — "Turn on for all sites" on the first-run or options page, or the
"This site" switch in the popup, which asks for that one origin
(lib/access/grant.ts, requestAccess; lib/access/patterns.ts, sitePattern). Access is
used to read the text of paragraphs, to draw the chips next to them, and for nothing
else: no form is read, no keystroke is recorded, no cookie is read or written, no
request is made to the site, and the page itself is never modified beyond the chips the
extension inserts. The user can take every grant back from the options page or from
chrome://extensions → Site access, and open tabs stop immediately.
```

If the dashboard asks about `clipboardWrite`, it is not in the Chrome manifest. It is
declared optional on Firefox only, for "Copy page diagnostics", and is requested inside
that click (`wxt.config.ts`, `entrypoints/background.ts`).

### Are you using remote code?

**No. Select "No, I am not using remote code."** The evidence, if a reviewer asks:

- Everything the extension runs is in the uploaded package. `scripts/vendor.mjs` builds
  the three lazily-loaded chunks (Mozilla Readability, DOMPurify, and the extension's
  own page-diagnostics chunk) plus pdf.js into `public/vendor/` at build time, and
  `lib/lazy.ts` loads them with `import()` of a `chrome-extension://` URL. Nothing is
  fetched from a CDN.
- The manifest's `content_security_policy.extension_pages` is
  `script-src 'self' 'wasm-unsafe-eval'`, so no remote script and no `eval` can run at
  all. There is no `eval(`, no `new Function`, no `importScripts` and no `document.write`
  anywhere in `lib/` or `entrypoints/`.
- `connect-src 'self' http://127.0.0.1:* http://localhost:*` — the extension cannot even
  reach a remote host to download code. `node test/csp-check.mjs` proves this in a real
  browser rather than asserting it.
- **WebAssembly**: `'wasm-unsafe-eval'` is in the policy for two files that ship inside
  the package — `vendor/wasm/openjpeg.wasm` and `vendor/wasm/jbig2.wasm`, pdf.js's
  JPEG 2000 and JBIG2 image decoders. Without them a scanned PDF page in either format
  draws blank. They are never downloaded; `node test/pdf-codecs-check.mjs` opens a PDF of
  each kind in the packaged extension and measures the pixels.
- The EditLens model is downloaded once by the separate installer, not by the extension.
  The extension has no code that can fetch, load or run a model.

### Data usage

Google counts data as handled **even when it never leaves the device** — the User Data
FAQ says so explicitly. So the answer below is written from what the extension *touches*,
not from what it *transmits*.

| Dashboard category | Tick? | Why |
| --- | --- | --- |
| Personally identifiable information | **No** | Nothing identifying is read, derived or stored. There is no account, no sign-in, no identifier, and no field of a page is treated as a name, address or number. |
| Health information | **No** | Not read as such. Page text on a health site is handled as website content, below, and nothing marks it out. |
| Financial and payment information | **No** | Same. No payment flow, no form reading, no transaction data. |
| Authentication information | **No** | No credential is read. No cookie is read or written by the extension (`docs/footprint.md`, "Nothing else"). The two same-origin re-reads described below travel with the tab's own cookies because the browser attaches them; the extension never sees them. |
| Personal communications | **No** *(see the note)* | Anagram does not single out messages, mailboxes or chats, and stores none. It annotates prose on whatever site the user granted, which on a webmail or forum page is that page's text — handled as website content. See the note under this table. |
| Location | **No** | No geolocation API, no IP-based lookup, nothing. The extension makes no remote request from which a location could be inferred. |
| Web history | **No** | No list of visited pages is built or kept. The extension reads the current tab's URL in memory to decide which per-site rule applies, and to know whether a tab is one it may still read (`lib/access/worker.ts`). Two settings hold hostnames, and both are ones the user put there themselves: `siteOverrides` (rules the user wrote) and `fabPos` (where the user dragged the ball). Nothing records a visit, a page title or a time. |
| User activity | **No** | Nothing about the user's behaviour is recorded or sent. Scroll position and hover are observed only to decide which paragraph to score next and which card to open; neither is stored anywhere, and there is no click, mouse-position or keystroke logging of any kind. |
| **Website content** | **YES** | This is the one. On a site the user granted, the extension reads the text of the page's paragraphs, sends that text to the scoring service on 127.0.0.1, and draws the result next to the paragraph. It also reads a PDF the user opened in the reading mode, and a Google Doc the user asked to have analyzed. See the paragraph below for the exact handling. |

Note on **Personal communications**: the honest boundary is that Anagram handles whatever
prose is on a page the user granted, which can be an email in a webmail reader. It does
not seek out, classify, index or retain communications, and nothing it produces leaves the
computer, so "Website content" is the category that describes it. If the listing is ever
positioned around reading mail or chat, tick this box as well.

**What to say in the "Website content" explanation field:**

```text
Anagram reads the text of paragraphs on pages the user has explicitly granted access
to, and sends that text over loopback (127.0.0.1 / localhost) to a scoring service
running on the same computer, which returns a number and a verdict per paragraph. The
text is not transmitted anywhere else: the extension's Content-Security-Policy permits
connections to loopback and to the extension's own origin only, so it has no way to
reach a remote server. No page text is stored. The persistent cache
(IndexedDB "anagram-scores") holds a 53-bit hash of the normalized paragraph text as a
key and the numeric verdict as a value, for at most 30 days, and never the text itself;
the user can empty it at any time with "Clear cached verdicts" in the options page.
Nothing scored in a private/incognito window is written to disk at all. Besides the
text, the request carries only a scan id, which browser it is, the page's hostname, a
language hint and a priority (lib/contract.ts, ScoreBatchRequest) — never a full URL,
path or query.
```

### The three certifications

All three can be certified. Read the exact wording off the live dashboard before ticking;
the substance is:

| Certification | Why it holds |
| --- | --- |
| I do not sell or transfer user data to third parties, outside of the approved use cases. | There is no third party. The extension can open a connection to loopback and to its own origin, and to nothing else; that is enforced by the manifest's `connect-src` and measured by `node test/csp-check.mjs`. |
| I do not use or transfer user data for purposes unrelated to my item's single purpose. | The only use of page text is having it scored and showing the score next to the paragraph it came from. `docs/footprint.md` lists every call site and every stored key, and `test/node/footprint.test.ts` fails the build if a call site is added and not written down. |
| I do not use or transfer user data to determine creditworthiness or for lending purposes. | Nothing of the kind exists in the product. |

### Privacy policy URL

`<< owner to fill in >>`. The text to publish there is [`PRIVACY.md`](../PRIVACY.md) in
the repository root.

---

## 3. A reviewer's test guide

Include this, or a shortened version of it, in the "Notes for reviewers" / testing
instructions field. It matters because the scoring service is a separate install and the
extension shows nothing interesting without it.

### Without the scoring service — which is what a reviewer will see

The scoring service (`anagramd`) installs on **macOS and Linux only** (`install.sh`
refuses other platforms), so a reviewer may well not be able to run it. Everything below
is visible without it, and is enough to judge what the extension does:

1. **Install it.** A first-run page opens by itself
   (`entrypoints/background.ts`, `onInstalled`). Its setup strip shows three rows —
   extension, scoring daemon, ready — and re-checks itself every few seconds. The second
   row will say the daemon is not running, and offer the command that starts it.
2. **Note that no site is granted.** `chrome://extensions` → Anagram → *Details* →
   *Site access* shows that no site has been allowed, and the extension has injected a
   script nowhere. That is the state a fresh install is in, and nothing changes it but a
   grant the user makes.
3. **Grant one site, or all sites.** Either from the first-run page's one-click button or
   from the popup's "This site" switch on a page. Chrome's own prompt is what grants it.
   Take it back from the same places, or from *Site access*; open tabs stop at once.
4. **Open any article.** Chips appear after the paragraphs, in gray, reading
   *Unavailable*. Hovering one says: "The scoring daemon did not answer. Retried
   automatically once it is running." The popup leads with *Daemon not running*, the
   command that starts it and a Retry, and the triage panel carries the same notice. That is the whole
   failure mode: nothing is invented, nothing is cached, and everything is retried when
   the service answers.
5. **Try it on a page nothing was granted for.** Right-click → *Analyze this page with
   Anagram*, or open the popup and press *Analyze this page*. The extension runs in that
   one tab, writes no setting and no rule, and is gone when the tab navigates.

### With the scoring service

```bash
curl -fsSL https://github.com/CoderBak/anagram/releases/latest/download/install.sh | sh
~/.anagram/bin/anagram start      # 127.0.0.1:8765
```

The chips fill in within seconds: a number from `.00` to `1.0` and a colour-coded verdict.
Hover one for the four probabilities. The daemon is `anagramd/` in the repository, a
FastAPI server that binds loopback, refuses any other `Host`, speaks only to an extension
origin or its own, and answers CORS headers to extension origins alone — which is why this
extension needs no host permission to read it, and why a web page still cannot.

### How to verify it makes no network request

- **Read the inventory.** [`docs/footprint.md`](footprint.md) lists every call site in
  `lib/` and `entrypoints/` with its destination, every `http://`/`https://` literal in
  the source, and every stored key. `test/node/footprint.test.ts` reads that page against
  the sources on every test run and fails in both directions — a call nobody wrote down,
  and a line whose call site has gone.
- **Check the policy is real, not written.** `node test/csp-check.mjs` (needs a build)
  makes an extension page and the service worker reach for `https://example.com` over
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`, in Chrome and in
  Firefox, and requires all of them to be refused while the loopback service still
  answers. It also checks that only the three declared chunks are reachable from an
  ordinary web page.
- **Watch it by hand.** Open DevTools on the service worker and on any extension page,
  Network tab, and use the extension: the only requests are to `127.0.0.1` and to
  `chrome-extension://…`.

---

## 4. Things a reviewer may ask

**Why does an extension that "cannot reach the internet" ask for all sites?**
Because host access is how a browser lets an extension *read a page*, not only how it
lets it *call a server*. Anagram needs the text of the paragraphs in front of the reader;
it sends that text to loopback. The two are separate mechanisms, and the second one is
locked down independently by `connect-src`. The site access is also entirely optional and
absent at install: `optional_host_permissions` in the manifest, requested only inside a
user's click (`lib/access/grant.ts`), and revocable from `chrome://extensions`.

**Why is there no `http://127.0.0.1/*` host permission if it talks to a local server?**
Because it does not need one. A host permission is what lets an extension read a response
the server did not authorise it to read; the scoring service authorises it, by answering
CORS headers naming the extension's origin — and refusing every other origin with 403
before the question arises (`anagramd/serve.py`). So the extension requires no host at
all, the install dialog warns about nothing, and what the extension may CONNECT to is
still decided by `connect-src`, not by a permission. The trade is that the service must
be as new as the extension: when it is not, the extension says so and names
`~/.anagram/bin/anagram update`.

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

- `lib/pdf/handoff.ts` — the PDF reading mode may not fetch anything (`connect-src` does
  not allow a remote origin, and that is deliberate). So the tab that is *already
  displaying the PDF* re-reads its own document — same URL, same origin, same cookies,
  `cache: "force-cache"`, so the browser's cache normally answers and nothing leaves the
  machine — and streams the bytes to the service worker, which hands them to the reading
  mode under a one-time ticket bound to that tab. It stops at 50 MB and refuses anything
  whose first bytes are not `%PDF-`. The `?src=` in the reader's address is a name from
  then on — the title, the "Open original" link — and nothing fetches it.
- `lib/docsOverlay.ts` — a Google Doc's editor is a canvas with no text in the DOM to
  read, so the reading mode fetches the same document's own `mobilebasic` rendering,
  same-origin with the tab's own cookies, and analyzes that. The document is never
  modified; the overlay closes with Esc.

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

**Why does the extension need a local server at all?**
The model is a 355M-parameter classifier; it is not something a browser extension can
carry or run. The daemon is a small FastAPI process the user installs and starts, bound to
loopback. The model is downloaded once by that installer, never by the extension — the
extension has no code that can fetch or load a model.

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
| Listing screenshots at 1280×800 or 640×400 | **done** — `docs/store/1-article.png`, `2-card.png`, `3-panel.png`, `4-pdf.png`, `5-first-run.png`, regenerated by `node test/store-shots.mjs`. One judgement call is left to you: the article in the first three is `test/fixtures/substack-article.html`, whose body text is filler written for the walker tests and reads oddly if a reviewer stops to read it. Point the script at a page of real prose if that matters to you |
| Small promo tile 440×280 | `<< owner to fill in >>` |
| Official URL / homepage | `<< owner to fill in >>` |
| Support URL | `<< owner to fill in >>` |
| Developer account contact email (verified) | `<< owner to fill in >>` |
| The package | `npm run zip` → the Chrome zip from `output/chrome-mv3`. Never upload `output-test/`. |
