# Reviewer and clean-profile verification

Use a matching released extension ZIP and native component version from
[Anagram releases](https://github.com/CoderBak/anagram/releases). A checkout with
unreleased changes is not the same as the published version. For source verification,
build the current checkout locally; do not install an older public native component
and assume it implements the checkout's new controls.

1. Install the Chrome package in a clean profile. It requires `storage`, `activeTab`,
   `contextMenus`, `scripting`, `nativeMessaging`, `webNavigation` and `webRequest`.
   The last two recognize PDF navigation and response metadata. Website and local-file
   access remain optional; neither is granted on installation. First-run setup opens automatically.
2. The first-run page explains the separate native component, a device-selected recommended model set
   (usually 1.43 GB including language detection) plus the private Python/runtime, installation location, and cleanup.
   Inspect the linked versioned script, then run the displayed command once. It includes
   this extension's ID. No administrator or Hugging Face account is required. The
   browser cannot install a native executable silently.
3. Check device detection, selected files/total, download progress and SHA-256 verification
   in the terminal. Wait for completion before closing it, then return to setup.
   Preparation bytes include reused verified files. Pause/resume keeps the plan; optional
   expanded comparison is an explicit action, and returning to recommended keeps extras.
   Available configurations are compared automatically after download, with about
   30 seconds of measured inference **plus** initialization, verification, loading and
   warmup. Each candidate runs in a separate process. Choose a configuration explicitly.
   FP32 recommendation and measured fastest are separate labels.
4. Open **Analyze text** from the popup. Paste at least 50 English words. Scores,
   four-class distributions, and window coverage appear without a website grant.
   Under-length input is left unscored. Other languages have an unsupported state.
5. On an ordinary website, choose **Analyze this page** for a document-bound run.
   Grant a site only when automatic analysis is wanted. Settings can revoke access;
   existing affected frames stop scoring. Display controls hide marks without revoking
   browser access. The global default can be overridden by individual site rules.
6. Settings can change the selected runtime, rerun/cancel the benchmark, stop/resume
   the engine, set idle unloading, clear scores, and select memory-only caching.
   Stopping is explicit; idle unloading resumes on the next scoring request. Status
   polling alone does not load the model or keep it loaded.
7. Reports include model/version/coverage and the score explanation. Raw excerpts,
   titles and URLs are excluded by default. Text-analysis reports have a separate
   visible opt-in for original text. Nothing uploads browsing text for inference.
8. Restart the browser/computer. The browser launches the native host as needed;
   a valid saved runtime choice is reused. No startup daemon or daily terminal command
   is required. ZIP installations require replacing/reloading their unpacked folder
   when updating; store-managed extensions use browser updates. The native component
   has its own update control.
9. Use **Remove Anagram and local files** in Settings for verified component/model
   cleanup and subsequent extension removal. Removing the extension directly in the
   browser does not remove native files. Downloads, unpacked ZIP directories, clipboard
   history and browser/OS logs are not promised erased. Paths and fallback cleanup
   instructions are in [the user guide](user-guide.en.md) and [footprint](footprint.md).

For PDFs, test both states of **Automatically open PDFs in Anagram**. It applies only
to authorized sources and newly opened documents. The full packaged PDF.js viewer also
accepts a chosen/dropped file without a file-origin grant. Chrome's local-file takeover
additionally requires its file-access switch. **Open original** bypasses auto-opening
for that navigation. Firefox's built-in reader cannot host our content-script prompt;
use the toolbar action. PDF analysis and reports identify the currently loaded page
scope rather than claiming a complete document assessment. See [network verification](network-privacy.md)
for original-source download exceptions and a fresh-text, real-engine offline check.

Local deterministic checks use temporary profiles and a Native Messaging fixture:

```sh
npm run typecheck
npm run test:node
npm run build
node test/runtime.mjs
node test/native-browser.mjs
node test/paste.mjs
node test/pdf-route-check.mjs
node test/pdf-viewer.mjs
node test/pdf-install-flow.mjs
node test/csp-check.mjs --chrome-only
```

The fixture verifies integration; it does not measure real-model accuracy or speed.
`scripts/release.mjs` checks the actual Chrome/Firefox ZIPs with
`scripts/verify-release.py` before calling the packaging run successful. Inspect the
final store-upload artifact, not `output-test`. All executable JS/WASM is packaged.
Native source and model downloads are disclosed separately from extension execution.

The model comes from Pangram's EditLens checkpoint. Modelkit variants retain
CC BY-NC-SA 4.0 and upstream attribution; the application license does not replace
those restrictions. A free listing is not a statement that commercial model use is
permitted. Store review timing and approval cannot be guaranteed by permissions alone.
