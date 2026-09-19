# Manual checks — optional site access

Everything below needs a **real browser and a real pair of hands**: a permission prompt is
native browser UI, so neither Playwright nor WebDriver can click it, and `activeTab` cannot
be granted synthetically at all. The automated suites therefore load a build where the site
patterns are already granted (`output-test/`, see `test/test-build.mjs`); what follows is
the part of the feature no suite can reach.

Run them against the **shipping** build:

```sh
npm run build          # → output/chrome-mv3   (the real manifest: no site access)
npm run build:firefox  # → output/firefox-mv2
```

Load it at `chrome://extensions` → *Load unpacked* → `output/chrome-mv3` (Firefox:
`about:debugging` → *This Firefox* → *Load Temporary Add-on* → `output/firefox-mv2/manifest.json`).
Use a **fresh profile** for check 1 — an old profile may still hold grants.

The local daemon should be running (`~/.anagram/bin/anagram start`) or every chip will read
"Unavailable"; the access behaviour itself does not depend on it.

---

1. **A fresh install reads nothing.**
   After loading the extension, open any article (e.g. `https://en.wikipedia.org/wiki/Alan_Turing`).
   Expected: **no chips, no underlines, no floating ball** — nothing at all. Chrome's
   *Details → Site access* for Anagram should read **"On specific sites"** with an empty
   list, and `chrome://extensions` should show no "Read and change your data" warning
   beyond `127.0.0.1` and `localhost`.

1b. **One page, with nothing granted.**
   On that same article, open the popup. The status line reads "Detection is off for this
   page." and the button under it reads **Analyze this page**. Press it.
   Expected: the popup closes, **no permission prompt appears**, and the article gets chips
   and the ball. Reload the page: it is bare again, and `chrome://extensions` → *Details →
   Site access* still lists no site. (Right-click → *Analyze this page with Anagram* does
   the same thing.)

2. **The popup switch asks for this site, and the page answers without a reload.**
   On that same article, open the popup. "This site" is **off**; the line under it names the
   host. Turn it **on**.
   Expected: the browser's own prompt appears ("Allow Anagram to read and change your data
   on en.wikipedia.org?"). Chrome closes the popup to show it — that is normal. Say **yes**.
   The article gets chips and the ball **without being reloaded**. Open the popup again:
   the switch is on and the status line counts analyzed paragraphs.

3. **All sites, from the first-run page.**
   Open the onboarding page (`chrome-extension://<id>/onboarding.html`, or reinstall).
   The *Setup* strip has a **Site access** row reading "no sites" with an **Allow on all
   sites** button. Press it, accept the prompt.
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
   does nothing visible (there is nothing to toggle — the same as on a site you have
   switched off). After granting the site, it toggles the overlay as always.

9. **An update keeps the grant, and the script.**
   With all sites granted, press *Reload* on the extension card at `chrome://extensions`
   (this is what an update does to a dynamic registration: it wipes it). Open a new tab on
   any site.
   Expected: chips as before — the worker re-registers on `runtime.onInstalled`.
   Then quit the browser entirely and start it again: still chips (the registration is
   persisted, and re-asserted on `runtime.onStartup`).

10. **A PDF tab, with the site granted.**
    With all sites granted, open a PDF (e.g. `https://arxiv.org/pdf/1706.03762`).
    Expected: the ball offers *Analyze PDF* as before, and "Open PDFs in Anagram" works if
    it is switched on. Both hand the tab to the reading mode showing that same PDF.

11. **A PDF tab with NO grant — the one case no suite can drive.**
    The reading mode is handed its bytes by the tab that is showing the PDF
    (`lib/pdf/handoff.ts`), so on a site you have granted nothing there is no content
    script to ask — and the click you make is what gives the extension `activeTab` to put
    one there for that one tab. A real click on real browser chrome is the whole point, so
    this cannot be automated; `test/node/pdf-handoff.test.ts` pins the order (inject, then
    ask) and this is the rest of it.

    Withdraw every grant (`about:addons` / `chrome://extensions`, or the options page's
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
    not re-read itself in any case. The way in is the reading mode's own drop zone:
    Options → Detection → **Read a PDF from this computer** → *Open*, then drop the PDF on
    the page that opens (or use its file picker). It opens and is scored. This is also the
    only way to read a PDF in Firefox, where no tab can hand a PDF over.

13. **Firefox.**
    Repeat 1, 2, 3 and 4 in Firefox. The prompts are Firefox's own; the popup stays open
    while the prompt is up (unlike Chrome). `about:addons` → Anagram → *Permissions* has
    the "Access your data for all websites" switch, which is check 4's equivalent.

---

## What the suites do cover

`npx vitest run test/node/accessPatterns.test.ts test/node/accessWorker.test.ts` proves the
pattern building and the worker's registration/injection/teardown against faked
`permissions`, `scripting` and `tabs` APIs, and `test/node/permissions.test.ts` pins what
the shipping manifests ask for. Every browser suite runs against the test build, which is
the "all sites granted" state — so the ambient experience after check 3 is the one the
whole suite already measures.
