# Manual checks — native setup, lifecycle and website access

Use this checklist before publishing a matching browser/native release. **0.4.0 is prepared
locally; its release assets have not been published and the store listing has not been
submitted.** Windows x64 is implemented but still needs real Windows/CI and manual release
QA. A passing macOS browser fixture does not validate the Windows installer or worker.

Start with the [English guide](user-guide.en.md) or [简体中文指南](user-guide.zh-CN.md).
[PRIVACY.md](../PRIVACY.md) and [footprint](footprint.md) describe the data and file boundaries.
Use disposable browser profiles and an isolated component home for destructive checks;
record the OS, browser, extension/native versions and how the package was installed.

Build the **shipping** configuration, whose website access is optional:

```sh
npm run build          # → output/chrome-mv3
npm run build:firefox  # → output/firefox-mv2
```

Load `output/chrome-mv3` at `chrome://extensions` → *Load unpacked*. For Firefox, use
`about:debugging` → *This Firefox* → *Load Temporary Add-on* →
`output/firefox-mv2/manifest.json`; this temporary installation disappears on restart.
A durable Firefox installation requires a signed release package.

An ordinary source build deliberately shows the unpublished-installer notice and disables
Copy. `npm run release` prepares release-enabled browser packages and matching native
assets locally; it does not publish them. Do not distribute such a browser package until
its version-pinned assets are available. Test the released command only against those
matching assets; source/integration fixtures are a separate kind of evidence.

## Native setup and lifecycle

1. **Store and ZIP open the same landing page.**
   Check a clean install from each distribution route once available. The ZIP contains the
   browser extension only: extract it into a permanent folder, then load that folder.
   No website is granted. Setup shows the model footprint (about **4.07 GB**, plus runtime
   and temporary space), **View installation script**, and one OS-specific install command.
   The command uses the current extension's exact ID, browser, language and version-pinned
   release URLs. Confirm these against the native registration; do not paste an ID copied
   from another profile. Moving an unpacked folder can change its ID. Firefox uses
   `anagram@coderbak.dev`. Verify the command and visible text in English and Simplified Chinese.

2. **Install once; connect without a daily terminal command.**
   On each supported OS, run the page's command in Terminal or PowerShell as an ordinary
   user. Keep Setup open while it retries the connection. The installer creates the private
   runtime and registers `dev.coderbak.anagram`; the browser then launches the host.
   Close the terminal after the command succeeds and continue setup entirely in the page.
   Normal native use must not need a listening HTTP server, a port setting or a manual
   start command. Unsupported OS/architecture or an unpublished build must not offer a
   misleading working-install claim. Initial targets are Apple Silicon macOS, supported
   Linux x64/ARM64 and Windows x64; Windows ARM64 and custom browser profiles need separate support.

3. **The component owns automatic first download and persistent pauses.**
   A new component automatically downloads all required model variants. Observe file and
   byte progress; valid existing files are reused after verification. Opening both Setup
   and Settings must not start duplicate downloads or native hosts. Pause and wait for the
   download worker to settle; pause is cooperative, so a still-running read may finish.
   Close/reopen the browser and check that the deliberate pause persists. Resume from
   Settings. Interrupt the network and confirm a localized failure/retry path without
   fabricated completion. Resuming must verify completed files and recover partial work.

4. **First benchmark, recommendation and actual readiness are distinct.**
   After download, benchmarking begins automatically. Loading, warmup and measurement are
   separate phases. **30 seconds is the shared measurement budget**, not a wall-clock
   promise for the entire operation. Inputs are built-in examples, not current page text.
   Results show device/runtime/precision, single-text latency, batch throughput in texts/s,
   sampled process RAM and accelerator memory where available. Missing metrics say unavailable,
   not zero; sampled memory is not a guaranteed whole-device peak. Quality remains not
   evaluated, and INT8 remains experimental. An FP32 recommendation may be preselected,
   but the engine is not ready until the user clicks **Use selected configuration** and the
   selected model is actually active. Site access is optional; its absence cannot block this.

5. **Saved choice, rerun and cancellation.**
   Apply an available configuration and restart the browser. A compatible saved choice
   loads without rerunning the first benchmark. Change device/precision manually; distinguish
   the pending choice from the actually active configuration while loading. Rerun a benchmark
   and cancel it during loading or measurement. Cancellation may wait for native work to
   return; the UI must not promise immediate completion. A rerun must not silently replace
   the saved configuration. Incompatible/missing models or a corrupt saved report need an
   explicit recoverable state, not stale ready status or invented results.

6. **Stop, restart, and competing browser connections.**
   Stop the engine, then reopen the browser: it remains deliberately stopped until **Start
   engine** is chosen. Open another browser/profile against the same component home while
   the first owns it. The second shows that another browser is using the component, rather
   than treating it as missing installation or starting a second model/download. Disconnect
   the owner and retry.

7. **Component and extension updates have separate controls.**
   **Update local component** performs an explicit native update and reconnects to the new
   version after success. Compatible models and selection are reused. A failure remains a
   failure, with technical detail separate from the localized main explanation. Windows
   may open a separate system window and report *scheduled*: wait for that window's actual
   result; scheduling/disconnection does not mean updated. Verify that the next connection
   reports the installed version. Store extension updates are managed by the browser;
   a pending update offers **Reload extension** without forcing an interruption. ZIP users
   replace files in the same unpacked folder and reload the extension. Neither route should
   instruct users to run a terminal command for daily use or routine component updates.

8. **Delete models only after confirmation.**
   In a disposable component home, choose **Delete model files**. The confirmation identifies
   the local footprint/path, defaults focus to **Cancel**, and sends no delete request until
   confirmed. Cancel and inspect that files remain. Then confirm: completed weights and
   partial downloads are removed, the program remains, and the UI offers download again.
   Restart and verify deliberate deletion does not automatically redownload the models.

9. **Complete uninstall distinguishes cleanup from a scheduled job.**
   Cancel the confirmation first and verify nothing is removed. Then confirm in the disposable
   installation. On macOS/Linux, the extension requests removal of itself only after a
   completed native cleanup with a receipt. Verify the owned home and exact native registration
   are gone; modified/foreign registrations must not be removed as if they belonged to this
   installation. On Windows, *scheduled* starts a separate visible cleanup window and keeps
   the extension installed. Wait for successful cleanup there, then remove the extension
   manually. A closed native connection or started window is not proof of success.
   Direct browser **Remove** leaves native files because it cannot trigger native cleanup.
   Downloaded ZIPs, unpacked folders, system/browser logs, backups and unrelated temporary
   files are outside the complete-uninstall promise.

10. **Local text processing and native download traffic.**
    Inspect the browser's native frames and the native process separately. Scoring passes
    text to the local host in memory. Public model/runtime/release downloads must not carry
    browsing text, page hostnames, benchmark results or runtime choices. Browser `connect-src`
    constrains extension web requests; it does **not** sandbox the native program's OS or
    network privileges. Lifecycle requests must remain the fixed validated operation list,
    unavailable to web pages/content scripts, with no arbitrary command/path/URL facility.
    Check the required `nativeMessaging` permission and absence of `downloads`, `management`
    and required host access in the actual artifacts.

11. **English/Chinese, keyboard, narrow and dark layouts.**
    Repeat missing-component, downloading, paused, benchmarking, awaiting-selection, ready,
    stopped, error and scheduled-maintenance states in both UI locales. Main status/help
    should be localized; technical native errors may appear in the separate details area.
    Check light/dark contrast, a 400 px viewport without whole-page horizontal overflow,
    wrapped paths/commands, keyboard-reachable scrolling tables, dialog focus and Cancel.
    Read the download progress and runtime results with assistive technology as well as
    automated accessibility checks. Fixture screenshots show UI behavior, not real performance.

## Website access and reading surfaces

Use a fresh profile for the first check, and complete native setup for checks that expect
real scores. Access behavior itself does not depend on a ready engine: an unavailable
engine should show an honest unavailable state and a link to Setup/Settings.

These checks exercise actual browser prompts and toolbar/keyboard gestures. A test that
calls an extension API or clicks page DOM does not establish a real browser `activeTab`
grant. Existing automated suites cover many surrounding states, including shipping builds;
they do not replace manual review of the packaged installation and permission prompts.

1. **A fresh install requires native communication, with no website access.**
   Check that both manifests require `storage`, `activeTab`, `contextMenus`, `scripting`
   and `nativeMessaging`, with no required host patterns. Chrome's native permission
   warning is "Communicate with cooperating native applications"; no loopback or
   all-sites warning should be caused by required host permissions. Check Firefox's
   required permissions in `about:addons` as well. Unpacked and temporary loading may
   skip normal installation prompts; verify the packaged installation prompt before
   release. Neither a source build nor a skipped install prompt proves that the packaged
   install experience has been checked. No `downloads` or `management` permission is needed.
   Then open any article (e.g. `https://en.wikipedia.org/wiki/Alan_Turing`).
   Expected: **no chips, no underlines, no floating ball** — nothing at all. Chrome's
   *Details → Site access* for Anagram should read **"On specific sites"** with an empty
   list.

1b. **One page, with nothing granted.**
   Once the local engine is ready, open the popup on that same article. It opens with
   "Detection is off for this page." and, right under it, one filled button reading **Analyze this page** — and no second
   filled button anywhere. Press it.
   Expected: the popup closes, **no permission prompt appears**, and the article gets chips
   and the ball. Reload the page: it is bare again, and `chrome://extensions` → *Details →
   Site access* still lists no site. (Right-click → *Analyze this page with Anagram* and
   <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> do the same thing.)

2. **The popup switch asks for this site, and the page answers without a reload.**
   On that same article, open the popup. "This site" is **off**; the line under it names the
   host. Turn it **on**.
   Expected: the browser's own prompt appears ("Allow Anagram to read and change your data
   on en.wikipedia.org?"). Chrome closes the popup to show it — that is normal. Say **yes**.
   The article gets chips and the ball **without being reloaded**. Open the popup again:
   the switch is on and the status line counts analyzed paragraphs.

3. **All sites, from the first-run page.**
   Open the onboarding page (`chrome-extension://<id>/onboarding.html`, or reinstall).
   The optional **Site access** row reads "no sites" with an **Allow on all sites**
   button. Press it, accept the prompt.
   Expected: the row turns green and reads "all sites", the button disappears, and every
   already-open tab starts showing chips without a reload. A new tab on any site behaves as
   Anagram always has.

4. **Withdrawing stops everything, at once.**
   With all sites granted and a couple of article tabs open and chipped, go to
   `chrome://extensions` → Anagram → *Details* → **Site access** → "On click" (or the
   puzzle-piece menu → Anagram → "This can read and change site data" → *When you click the
   extension*).
   Expected: the chips, underlines and the ball **disappear from the open tabs** within a
   moment — no reload. The options page's Site access row goes back to "no sites".
   The *Per-site rules* table on the options page is **unchanged** (withdrawing access is
   not the same as forgetting your rules).

5. **Options page: grant and withdraw.**
   Options → Detection → **Site access**. It reads "no sites" / "N sites" / "all sites",
   with *Allow on all sites* and *Withdraw*. Both do what they say, and the row updates
   itself when access changes anywhere else (try it side by side with `chrome://extensions`).

6. **Analyze one page with no grant at all.**
   Withdraw everything (check 4), then open an article and right-click → **Analyze this
   page with Anagram**.
   Expected: that page — and only that page — gets chips. Open a second tab on the same
   site: nothing. Navigate the first tab away and back: nothing. Nothing was written to the
   rules, and `chrome://extensions` still shows no site access.

7. **The context menu on a page with no grant.**
   Same state. Right-click a paragraph → **Copy page diagnostics**: the toolbar badge blinks
   a tick and the clipboard holds the report (it says Anagram is not running on the page).
   Crucially, the page itself **stays clean** — no chips appear just because a report was
   made. Then select a sentence → right-click → **Analyze selection with Anagram**: the
   selection card appears, and still no chips anywhere else.

8. **Keyboard commands with no grant.**
   Still with nothing granted: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on an article
   analyzes that one page — the same single run the popup's *Analyze this page* does, with
   **no permission prompt**, and gone after a reload (`chrome://extensions` → *Details →
   Site access* still lists no site). Press it again on the analyzed page and it hides the
   marks, as it always did. After granting the site, it toggles the overlay as always.

9. **An update keeps the grant, and the script.**
   With all sites granted, press *Reload* on the extension card at `chrome://extensions`
   (this is what an update does to a dynamic registration: it wipes it). Open a new tab on
   any site.
   Expected: chips as before — the worker re-registers on `runtime.onInstalled`.
   Then quit the browser entirely and start it again: still chips (the registration is
   persisted, and re-asserted on `runtime.onStartup`).

10. **A PDF tab in Chromium, with the site granted.**
    With all sites granted, open a PDF (e.g. `https://arxiv.org/pdf/1706.03762`).
    Expected: the ball offers *Analyze PDF* as before, and "Open PDFs in Anagram" works if
    it is switched on. Both hand the tab to the reading mode showing that same PDF.

11. **A PDF tab in Chromium with NO grant — exercise a real toolbar click.**
    The reading mode is handed its bytes by the tab that is showing the PDF
    (`lib/pdf/handoff.ts`), so on a site you have granted nothing there is no content
    script to ask — and the click you make is what gives the extension `activeTab` to put
    one there for that one tab. A real click on real browser chrome is the whole point, so
    page-script automation does not establish that grant. `test/node/pdf-handoff.test.ts`
    pins the order (inject, then ask); this check covers the actual browser interaction.

    Withdraw every grant (`chrome://extensions`, or the options page's
    *Withdraw*). Open `https://arxiv.org/pdf/1706.03762`.
    Expected: no ball, no chips — the page is not being read.
    Now open the popup and press *Read this PDF*.
    Expected: the tab becomes the reading mode, showing the real pages of that same PDF,
    with chips on them. Nothing was granted and nothing was prompted for: the paper was
    read out of the tab that already had it.
    Then, from a page with links to PDFs, right-click one and choose *Open PDF with
    Anagram*: a new tab opens on the PDF and turns itself into the reading mode.
    And the automatic route stays quiet: with "Open PDFs in Anagram" on and no grant, a
    PDF tab you simply navigate to is left alone — no click, no `activeTab`, nothing to
    ask. That is the intended difference between a PDF you asked for and one you opened.

12. **A PDF on this computer stays in the browser's viewer.**
    Open a `file:///…/something.pdf`.
    Expected: nothing from Anagram, whatever the grants and whatever "Allow access to file
    URLs" says — the extension declares no access to the file scheme, and a page on it may
    not re-read itself in any case. The way in is the reading mode's own drop zone, and
    the popup offers it on that very tab: its one button reads **Read a PDF file…** (it
    says "Not available on this page." above it). Press it, then drop the PDF on the page
    that opens, or use its file picker; it is shown and scored. Options → Detection →
    **Read a PDF from this computer** → *Open* is the same door. This is also the only way
    to read a PDF in Firefox, where no tab can hand a PDF over — and there the popup says
    the same thing on a PDF tab on the web.

13. **Firefox.**
    Repeat 1, 2, 3 and 4 in Firefox. The prompts are Firefox's own; the popup stays open
    while the prompt is up (unlike Chrome). `about:addons` → Anagram → *Permissions* has
    the "Access your data for all websites" switch, which is check 4's equivalent.

## What the suites cover, and what remains manual

- `test/node/accessPatterns.test.ts`, `accessWorker.test.ts` and `permissions.test.ts`
  cover pattern construction, mocked grant/revocation behavior and shipping manifests.
  Many page-reading suites use `output-test/` with website patterns pregranted; this is
  distinct from the shipping suites below.
- `node test/native-browser.mjs` uses the shipping Chromium extension, a real Native
  Messaging stdio connection and deterministic component replies in an isolated profile.
  It passed English and Simplified Chinese setup/Settings sharing one process, pause/resume,
  no website grants, light/dark axe checks, 400 px width, Cancel-first delete confirmations
  and scheduled-uninstall retention. Its POSIX test launcher and fixture model status do
  **not** test Windows installation/maintenance, real downloads, benchmark accuracy or
  end-to-end removal of a production installation. Screenshots are in `test-results/native/`.
- `node test/runtime.mjs` tests the shared benchmark/results UI against the
  native component fixture: readiness, selection/apply, rerun/cancel, missing memory,
  light/dark accessibility and narrow layout. Fixture numbers are not measured performance.

Record actual outcomes for each target OS/browser. The packaged permission dialogs,
release-hosted one-time command, restart behavior in durable installations, real Windows
maintenance window, ownership-safe cleanup and assistive-technology reading still need
release QA beyond these automated UI fixtures.
