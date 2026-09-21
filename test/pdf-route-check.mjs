// test/pdf-route-check.mjs — where a PDF opens, in a real browser.
//
// Two things are checked here, because they share one path through the service worker:
//
//   "Open in Anagram" — every way in (the ball's chip, the popup's button, the automatic
//                       route) opens THE PDF THE READER WAS LOOKING AT, in the reading
//                       mode. Nothing is asked of any remote site first;
//   "Open PDFs in Anagram" — a PDF tab becomes the reading mode by itself.
//
// The second is the one with the traps in it, and each trap gets a check of its own: Back
// out of the reading mode must stay on the PDF, "Open original" must stay on the PDF, a
// PDF opened in a BACKGROUND tab must move that tab and not the one being read, and the
// switch turned off again must take effect on the very next PDF with no restart.
//
// arxiv.org IS NOT CALLED, and this suite is where that is proved. Until 2026-09-20 the
// worker asked arxiv.org whether a paper had an HTML rendering and sent the reader there
// instead; the probe and the re-routing are gone (see docs/footprint.md). arXiv PDFs are
// still opened here — served by Playwright's router rather than by arXiv — and every
// request the run makes is collected, so a probe that came back would fail section E.
//
//   node test/pdf-route-check.mjs
import http from "node:http";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFakeNative, requireBuild, BADGE_SEL } from "./harness.mjs";
import { TEST_PDF, LOCKED_PDF, PDF_PASSWORD, openPdfInReader } from "./pdf-fixture.mjs";

requireBuild();

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

// ---- the fixtures ---------------------------------------------------------------------

/** How big the "too large" fixture below really is — comfortably over the 50 MiB cap. */
const OVERSIZED = 70 * 1024 * 1024;
/** How much of it each request took before letting go. The tab's own load reads all of
 *  it; the content script's re-read must stop at the cap, which is what this shows. */
const oversizedSends = [];

/** Serve the PDFs. `/paper.pdf` stands in for a PDF with no twin at all. */
const files = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/ordinary.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html lang=en><body><p>an ordinary page</p></body></html>");
      return;
    }
    // A document that says it is a PDF and goes on for ever: served in megabyte pieces,
    // with NO content-length, so the only thing that can stop it is the reader's own
    // running total. `oversizedSends` is how the check knows it really stopped.
    if (path === "/huge.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      const piece = Buffer.alloc(1024 * 1024, 0x20);
      Buffer.from("%PDF-1.7\n", "latin1").copy(piece);
      const slot = oversizedSends.push(0) - 1;
      let open = true;
      res.on("close", () => {
        open = false;
      });
      const pump = () => {
        while (open && oversizedSends[slot] < OVERSIZED) {
          oversizedSends[slot] += piece.length;
          if (!res.write(piece)) {
            res.once("drain", pump);
            return;
          }
        }
        if (open) res.end();
      };
      pump();
      return;
    }
    // A sign-in page served under a .pdf address, which is what a paper behind a library
    // login really answers with. Nothing but the first bytes can tell the two apart.
    if (path === "/notreally.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("<!doctype html><html lang=en><body><p>Please sign in to read this paper.</p></body></html>");
      return;
    }
    if (path === "/locked.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": LOCKED_PDF.length });
      res.end(LOCKED_PDF);
      return;
    }
    if (!path.endsWith(".pdf")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/pdf", "content-length": TEST_PDF.length });
    res.end(TEST_PDF);
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    resolve({
      url: (path) => `http://localhost:${port}${path}`,
      close: () => new Promise((r) => server.close(() => r())),
    });
  });
});

/** A local PDF, for the one protocol whose answer had to be found out rather than assumed. */
const LOCAL_PDF = join(tmpdir(), "anagram-pdf-route.pdf");
writeFileSync(LOCAL_PDF, TEST_PDF);

const { fixture, context, sw, extId } = await withFakeNative();

// Every address the extension asks for, so the checks below can say what was contacted and
// how often.
const requested = [];
/** …and what the READER PAGE asked for, which after this change must be nothing at all. */
const fromReader = [];
context.on("request", (request) => {
  requested.push(request.url());
  // A service worker's requests have no frame at all, and Playwright throws rather than
  // saying so — which is itself the answer: they did not come from the reading mode.
  let from = "";
  try {
    from = request.frame()?.url() ?? "";
  } catch {
    return;
  }
  // A NAVIGATION is not a fetch: the reading mode handing its tab back to the document is
  // the whole point of the dead-ticket rule. What must never appear is a subresource — a
  // fetch, an XHR, an image, a font — from the reading mode to anywhere but ourselves.
  if (
    from.includes("/reader.html") &&
    request.resourceType() !== "document" &&
    !request.url().startsWith("chrome-extension://")
  ) {
    fromReader.push(`${request.resourceType()} ${request.url().slice(0, 100)}`);
  }
});

// arxiv.org answers here and nowhere else, so an arXiv paper can be opened without the
// real site being touched — and so that a probe, if one ever came back, would be recorded
// rather than quietly succeed against the live repository.
const asked = [];
await context.route("**arxiv.org/**", async (route) => {
  // WHO asked, as well as what for. A service worker's request has no frame and Playwright
  // throws rather than saying so, which is itself the answer worth recording: nothing that
  // reaches arxiv.org may come from the extension's own side of the world.
  let from;
  try {
    from = route.request().frame()?.url() ?? "(no frame)";
  } catch {
    from = "service worker";
  }
  asked.push({ url: route.request().url(), kind: route.request().resourceType(), from });
  return route.fulfill({ status: 200, contentType: "application/pdf", body: TEST_PDF });
});

const READER = `chrome-extension://${extId}/reader.html`;
/**
 * An extension page to send the popup's message from. The worker cannot send itself a
 * runtime message (there is no receiving end), and the popup closes the moment anything
 * else takes focus — the options page is the same kind of sender the popup is: an
 * extension page whose message names the tab and the URL rather than being read off it.
 */
const driver = await context.newPage();
await driver.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "load" });

const setAutoOpen = (value) =>
  sw.evaluate((v) => new Promise((r) => chrome.storage.local.set({ autoOpenPdfs: v }, r)), value);

/** What the ball is offering on this page, and what the page thinks it is showing. */
const tabState = (page) =>
  page
    .evaluate(() => ({
      contentType: document.contentType,
      chip: document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".action")?.textContent ?? null,
      navigationType: performance.getEntriesByType("navigation")[0]?.type ?? null,
    }))
    .catch(() => ({ contentType: null, chip: null, navigationType: null }));

/** Open `url` in a tab of its own and give the worker time to move it if it means to. */
async function visit(url, { settle = 4000 } = {}) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(settle);
  return page;
}

// ---- A: "Open in Anagram" opens THAT PDF ---------------------------------------------------
//
// Two of the three entry points can be driven from here, and both have to land on the
// reading mode showing the very address the reader was looking at — an arXiv paper
// included. Until 2026-09-20 an arXiv PDF was sent to arxiv.org/html/<id> instead, after
// the worker had asked arxiv.org whether that page existed; there is no such question any
// more, which is what the `asked` list at the end of this section checks.

{
  const page = await visit("https://arxiv.org/pdf/2402.17764");
  const before = await tabState(page);
  await page
    .evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".action").click())
    .catch(() => {});
  await page.waitForURL(/reader\.html/, { timeout: 10000 }).catch(() => {});
  record(
    "the ball's chip on a paper's PDF opens THAT PDF in the reading mode",
    before.chip === "Analyze PDF" &&
      page.url().startsWith(`${READER}?src=`) &&
      new URL(page.url()).searchParams.get("src") === "https://arxiv.org/pdf/2402.17764",
    JSON.stringify({ chip: before.chip, landed: page.url().slice(0, 100) }),
  );
  await page.close();
}

{
  // The popup's button, which names the tab and the URL rather than letting the worker
  // read them off the sender. It is the same message and therefore the same one place.
  const page = await visit("https://arxiv.org/pdf/2402.17764v1", { settle: 2500 });
  const tabId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, "https://arxiv.org/pdf/2402.17764v1");
  await driver.evaluate(
    ([url, id]) => chrome.runtime.sendMessage({ action: "openPdfReader", url, tabId: id }),
    ["https://arxiv.org/pdf/2402.17764v1", tabId],
  );
  await page.waitForTimeout(3000);
  record(
    "the popup's button takes the same route, and the version in the address is kept",
    new URL(page.url()).searchParams.get("src") === "https://arxiv.org/pdf/2402.17764v1",
    page.url().slice(0, 100),
  );
  await page.close();
}

// The THIRD entry point, "Open PDF with Anagram" on a link, cannot be driven from here:
// the menu is native browser chrome and `contextMenus.onClicked` has nothing that fires it
// (test/diagnostics-check.mjs has the same problem and solves it the same way — by driving
// the message the handler sends). What it shares with the two above is the worker's single
// `readerUrl`, which is the whole point of deciding in one place; what is its own is
// opening BESIDE the tab rather than replacing it, and test/scenarios.mjs already pins that.

{
  // Nothing was asked ABOUT a paper — only the papers themselves were fetched, by tabs
  // that were navigating to them anyway. `/html/` is the address the old probe used.
  const probes = asked.filter((a) => a.url.includes("/html/"));
  record(
    "nothing asks arxiv.org whether a paper has an HTML rendering — the probe is gone",
    probes.length === 0,
    JSON.stringify(probes.slice(0, 3)),
  );
}

// ---- B: the switch, off ---------------------------------------------------------------------

{
  const page = await visit(files.url("/doc.pdf"), { settle: 3500 });
  const state = await tabState(page);
  record(
    "off (the default): a PDF tab stays a PDF tab, with the ball offering Analyze PDF",
    page.url() === files.url("/doc.pdf") && state.contentType === "application/pdf" && state.chip === "Analyze PDF",
    JSON.stringify({ url: page.url(), ...state }),
  );
  await page.close();
}

// ---- C: the switch, on ------------------------------------------------------------------------

await setAutoOpen(true);

{
  const page = await visit(files.url("/doc.pdf"));
  await page.waitForSelector("#pages:not(.reading)", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // The reading mode shows the document's own PAGES, so what proves it read them is the
  // text layer over them and the chips on it, not a rebuilt paragraph element.
  const reading = await page
    .evaluate((sel) => ({
      pages: document.querySelectorAll(".page").length,
      spans: document.querySelectorAll(".textLayer span").length,
      chips: document.querySelectorAll(sel).length,
      title: document.getElementById("title").textContent,
    }), BADGE_SEL)
    .catch(() => ({ pages: 0, spans: 0, chips: 0, title: null }));
  record(
    "on: the same PDF lands in the reading mode, with its pages and chips",
    page.url() === `${READER}?src=${encodeURIComponent(files.url("/doc.pdf"))}` &&
      reading.pages === 2 &&
      reading.spans >= 29 &&
      reading.chips > 0,
    JSON.stringify({ url: page.url().slice(0, 60), ...reading }),
  );

  // (a) BACK. The reading mode replaced the tab, so the PDF is still in history; landing
  // on it again must not bounce forward, or Back stops working on this tab for good.
  await page.goBack({ waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(3500);
  const back = await tabState(page);
  record(
    "on + Back: the tab stays on the PDF and the ball offers Analyze PDF again",
    page.url() === files.url("/doc.pdf") &&
      back.navigationType === "back_forward" &&
      back.chip === "Analyze PDF",
    JSON.stringify({ url: page.url(), ...back }),
  );
  await page.close();
}

{
  // (b) OPEN ORIGINAL. The reader asks the worker for a one-shot pass, then navigates.
  const page = await visit(files.url("/doc.pdf?original"));
  await page.waitForTimeout(2000);
  const clicked = await page
    .evaluate(() => {
      const button = document.getElementById("original");
      if (!button || button.hidden) return "no button";
      button.click();
      return "clicked";
    })
    .catch((e) => String(e));
  await page.waitForTimeout(3500);
  const original = await tabState(page);
  record(
    "on + Open original: the reader hands the tab back to the PDF and it stays there",
    clicked === "clicked" &&
      page.url() === files.url("/doc.pdf?original") &&
      original.contentType === "application/pdf",
    JSON.stringify({ clicked, url: page.url(), ...original }),
  );

  // …and the pass really is one shot: the next visit to that very PDF opens the reader.
  await page.goto(files.url("/ordinary.html"), { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(800);
  await page.goto(files.url("/doc.pdf?original"), { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(3500);
  record(
    "on: the pass is spent — the same PDF opened again goes to the reading mode",
    page.url().startsWith(`${READER}?src=`),
    page.url().slice(0, 80),
  );
  await page.close();
}

{
  // (c) A BACKGROUND tab (a middle click). The worker must move the SENDER's tab, and the
  // tab the reader is actually looking at must not move at all.
  const front = await visit(files.url("/ordinary.html"), { settle: 1000 });
  const background = await context.newPage();
  await background.goto(files.url("/background.pdf"), { waitUntil: "load" }).catch(() => {});
  await front.bringToFront();
  await background.waitForTimeout(4000);
  record(
    "on: a PDF opened in a background tab moves THAT tab, and the foreground tab stays put",
    background.url().startsWith(`${READER}?src=`) && front.url() === files.url("/ordinary.html"),
    JSON.stringify({ background: background.url().slice(0, 60), front: front.url() }),
  );
  await background.close();
  await front.close();
}

{
  // A reload of the reading mode. The ticket it opened with is spent, so the page has no
  // bytes and does not fetch any: it goes back to the document, and the automatic route
  // brings it here again with a fresh handoff. One round trip, and no ping-pong.
  const page = await visit(files.url("/reload.pdf"));
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(6000);
  const reloaded = await page
    .evaluate(() => ({ pages: document.querySelectorAll(".page").length, url: location.href }))
    .catch(() => ({ pages: 0, url: null }));
  record(
    "on: reloading an automatically opened reading mode comes back to it, with the document",
    page.url().startsWith(`${READER}?src=`) && reloaded.pages === 2,
    JSON.stringify({ url: page.url().slice(0, 70), pages: reloaded.pages }),
  );
  await page.close();
}

{
  // A LOCAL PDF, which the reading mode can no longer open at all — for two reasons now,
  // either of which would be enough on its own.
  //
  // Since optional site access, the manifest declares no `file:///*` at all (it asks for
  // the fixture's two loopback hosts and offers the two http(s) patterns), and the tick in
  // chrome://extensions grants nothing an extension has not declared — so no content
  // script runs on a file: page. And since the reading mode is handed its bytes by the tab
  // showing the document, even a script that DID run there could not help: a page on the
  // file scheme may not re-read itself, `fetch` and XMLHttpRequest both refused (verified
  // in Chromium 141 on 2026-09-20).
  //
  // So the tab is left exactly as it was: the local PDF, in the browser's own viewer,
  // which is what the reader would be looking at anyway. The drop zone is the way in.
  const declared = await sw
    .evaluate(
      async () =>
        (await chrome.extension.isAllowedFileSchemeAccess()) &&
        (await chrome.permissions.contains({ origins: ["file:///*"] })),
    )
    .catch(() => false);
  const page = await visit(`file://${LOCAL_PDF}`);
  await page.waitForTimeout(2000);
  record(
    "on: a local PDF is left alone — nothing here can read it, so nothing pretends to",
    page.url() === `file://${LOCAL_PDF}`,
    JSON.stringify({ fileAccessDeclared: declared, url: page.url().slice(-40) }),
  );
  await page.close();
}

{
  // An arXiv paper reached automatically takes the same route as the chip did: the PDF.
  const page = await visit("https://arxiv.org/pdf/2402.17764");
  record(
    "on: an arXiv PDF tab goes to the reading mode showing that same PDF",
    new URL(page.url()).searchParams.get("src") === "https://arxiv.org/pdf/2402.17764",
    page.url().slice(0, 100),
  );
  await page.close();
}

// ---- D: (d) the switch off again, no restart ---------------------------------------------------

await setAutoOpen(false);

{
  const page = await visit(files.url("/after-off.pdf"), { settle: 3500 });
  const state = await tabState(page);
  record(
    "off again: the very next PDF stays a PDF, with no restart of anything",
    page.url() === files.url("/after-off.pdf") && state.chip === "Analyze PDF",
    JSON.stringify({ url: page.url(), ...state }),
  );
  await page.close();
}

// ---- E: the handoff — where the bytes come from, and what stops them --------------------------
//
// The reading mode fetches nothing. The tab that is showing the PDF re-reads it, the worker
// holds it under a one-time ticket, and only then does the tab become the reader. Each of
// the ways that can go wrong gets a check, because each of them used to be a defect: an
// unbounded buffer, a load nobody owned, and a page on the extension's own origin asking
// the open web for a document.

await setAutoOpen(false);

{
  // THE HAPPY PATH, byte for byte. The reader's own copy is hashed in the page and
  // compared with the file this suite served — a relay that dropped, duplicated or
  // reordered a chunk would still very likely render, and would still be wrong.
  const page = await openPdfInReader(context, files.url("/exact.pdf"));
  await page.waitForSelector("#pages:not(.reading)", { timeout: 25000 }).catch(() => {});
  const digest = await page
    .evaluate(async () => {
      // The document is gone from the page by now (pdf.js transfers the buffer to its
      // worker), so what is hashed is the text layer — every glyph of every page, in
      // order, which is the only thing the bytes were wanted for.
      const text = [...document.querySelectorAll(".textLayer span")].map((s) => s.textContent).join("");
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return { hash: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""), chars: text.length };
    })
    .catch(() => ({ hash: null, chars: 0 }));
  // …and the same document dropped straight onto the reader as a FILE, which is the one
  // path that never went near the relay. Two routes, one document: if they agree, every
  // byte survived the trip.
  const dropped = await context.newPage();
  await dropped.goto(READER, { waitUntil: "load" });
  await dropped.setInputFiles("#file", { name: "exact.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
  await dropped.waitForSelector("#pages:not(.reading)", { timeout: 25000 }).catch(() => {});
  const direct = await dropped
    .evaluate(async () => {
      const text = [...document.querySelectorAll(".textLayer span")].map((s) => s.textContent).join("");
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })
    .catch(() => null);
  record(
    "handoff: the document that arrives through the tab is the document, byte for byte",
    digest.hash !== null && digest.hash === direct && digest.chars > 500,
    JSON.stringify({ relayed: digest.hash?.slice(0, 16), direct: direct?.slice(0, 16), chars: digest.chars }),
  );
  // The ticket is spent as soon as it is claimed: the address it arrived on no longer
  // carries one, and nothing of the document is left in the worker.
  record(
    "handoff: the ticket is spent — the address keeps only the document's own name",
    page.url() === `${READER}?src=${encodeURIComponent(files.url("/exact.pdf"))}`,
    page.url().slice(0, 90),
  );
  await dropped.close();
  await page.close();
}

{
  // A DOCUMENT THAT NEVER ENDS. No content-length, so the only thing that can stop it is
  // the running total — and it has to stop long before the end, or the cap is a cap on
  // what has already been bought.
  const page = await openPdfInReader(context, files.url("/huge.pdf"), { timeout: 40000 });
  await page.waitForTimeout(3000);
  const state = await page
    .evaluate(() => ({ notice: document.getElementById("notice")?.textContent ?? null, drop: !document.getElementById("drop").hidden }))
    .catch(() => ({ notice: null, drop: false }));
  const megabytes = oversizedSends.map((n) => Math.round(n / 1048576));
  record(
    "handoff: an oversized document is stopped at the cap, not after it",
    state.notice === "This PDF is too large to read here." &&
      state.drop &&
      megabytes.some((n) => n >= 40 && n <= 60),
    JSON.stringify({ ...state, megabytesPerRequest: megabytes }),
  );
  await page.close();
}

{
  // A SIGN-IN PAGE UNDER A .pdf ADDRESS, served as application/pdf. Only the first bytes
  // can tell them apart, and handing this to pdf.js would say "could not be read" about a
  // file that is not a PDF at all.
  const page = await openPdfInReader(context, files.url("/notreally.pdf"), { timeout: 40000 });
  await page.waitForTimeout(2500);
  const notice = await page.evaluate(() => document.getElementById("notice")?.textContent ?? null).catch(() => null);
  record(
    "handoff: a page that is not a PDF is refused on its first bytes, not on its content type",
    notice === "This file could not be read as a PDF.",
    String(notice),
  );
  await page.close();
}

{
  // A DEAD TICKET: the address pasted into a fresh tab, with nothing behind it. The reading
  // mode does not fetch, so it goes back to the document — once. A second landing on the
  // same source is a handoff that keeps failing, and the tab must not ping-pong.
  const src = files.url("/pasted.pdf");
  const page = await context.newPage();
  const visits = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visits.push(f.url());
  });
  await page.goto(`${READER}?src=${encodeURIComponent(src)}`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(5000);
  const reader = visits.filter((u) => u.startsWith(READER)).length;
  record(
    "handoff: a pasted reader address goes back to the PDF, and stays there",
    page.url() === src && reader === 1,
    JSON.stringify({ landed: page.url().slice(-20), visits: visits.length, reader }),
  );
  await page.close();
}

{
  // …and only to an address the browser would have shown by itself. The reading mode hands
  // its tab back WITHOUT anybody clicking anything, so the one thing it must never be
  // talked into is `javascript:` on the extension's own origin.
  const page = await context.newPage();
  await page.goto(`${READER}?src=${encodeURIComponent("javascript:window.__ran=1")}`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(2500);
  const state = await page
    .evaluate(() => ({
      ran: window.__ran ?? null,
      url: location.href,
      drop: !document.getElementById("drop").hidden,
      original: !document.getElementById("original").hidden,
    }))
    .catch((e) => String(e));
  record(
    "handoff: a source that is not a document address is not an address to leave for",
    state.ran === null && state.url === `${READER}?src=javascript%3Awindow.__ran%3D1` && state.drop && !state.original,
    JSON.stringify(state),
  );
  await page.close();
}

{
  // The same, with the switch ON: the ordinary route picks the tab back up and this time
  // there really are bytes. Still no ping-pong — the reader is reached once more, not
  // over and over.
  await setAutoOpen(true);
  const src = files.url("/pasted-on.pdf");
  const page = await context.newPage();
  const visits = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visits.push(f.url());
  });
  await page.goto(`${READER}?src=${encodeURIComponent(src)}`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(8000);
  const pages = await page.evaluate(() => document.querySelectorAll(".page").length).catch(() => 0);
  // The tab goes to the PDF exactly ONCE. Twice would be the ping-pong this rule exists
  // to prevent; the reader's own address appears more than once only because spending a
  // ticket rewrites it in place.
  record(
    "handoff: with the switch on, the way back brings the document — and settles",
    page.url().startsWith(`${READER}?src=`) && pages === 2 && visits.filter((u) => u === src).length === 1,
    JSON.stringify({ url: page.url().slice(0, 60), pages, visits: visits.map((u) => (u === src ? "pdf" : "reader")) }),
  );
  await page.close();
  await setAutoOpen(false);
}

{
  // AN ENCRYPTED PDF. The reading mode used to say "this is password-protected" and stop;
  // now it asks, in the bar, and a wrong answer marks the field and empties it.
  const page = await openPdfInReader(context, files.url("/locked.pdf"), { timeout: 40000 });
  await page.waitForSelector("#password:not([hidden])", { timeout: 25000 }).catch(() => {});
  const asked = await page
    .evaluate(() => ({
      shown: !document.getElementById("password").hidden,
      invalid: document.getElementById("passwordInput").getAttribute("aria-invalid"),
      focused: document.activeElement?.id ?? null,
      notice: document.getElementById("notice").textContent,
    }))
    .catch(() => ({ shown: false }));
  await page.fill("#passwordInput", "not the password");
  await page.press("#passwordInput", "Enter");
  await page.waitForFunction(() => document.getElementById("passwordInput").getAttribute("aria-invalid") === "true", null, { timeout: 15000 }).catch(() => {});
  const refused = await page
    .evaluate(() => ({
      invalid: document.getElementById("passwordInput").getAttribute("aria-invalid"),
      value: document.getElementById("passwordInput").value,
      pages: document.querySelectorAll(".page").length,
    }))
    .catch(() => ({}));
  await page.fill("#passwordInput", PDF_PASSWORD);
  await page.press("#passwordInput", "Enter");
  await page.waitForSelector("#pages:not(.reading)", { timeout: 25000 }).catch(() => {});
  const opened = await page
    .evaluate(() => ({
      shown: !document.getElementById("password").hidden,
      pages: document.querySelectorAll(".page").length,
      spans: document.querySelectorAll(".textLayer span").length,
    }))
    .catch(() => ({}));
  record(
    "password: the reader asks in the bar, with nothing to read yet and the field ready",
    asked.shown === true && asked.invalid === null && asked.focused === "passwordInput" && asked.notice === "",
    JSON.stringify(asked),
  );
  record(
    "password: a wrong one marks the field, empties it, and shows nothing of the document",
    refused.invalid === "true" && refused.value === "" && refused.pages === 0,
    JSON.stringify(refused),
  );
  record(
    "password: the right one opens it, and the field goes away",
    opened.shown === false && opened.pages === 1 && opened.spans >= 9,
    JSON.stringify(opened),
  );
  await page.close();
}

{
  // THE ARXIV LINK. A quiet link in the bar, to the page this paper also exists as. It is
  // a link and nothing else: no probe, no request, until somebody clicks it.
  // Opened on the line that says the document could not be read, because that is the one
  // state where the bar is up and the page is going nowhere — a reader address with no
  // bytes behind it otherwise hands the tab straight back to the PDF, as it should.
  const before = asked.length;
  const page = await context.newPage();
  await page
    .goto(`${READER}?src=${encodeURIComponent("https://arxiv.org/pdf/2402.17764")}&err=read`, { waitUntil: "load" })
    .catch(() => {});
  await page.waitForTimeout(1200);
  const link = await page
    .evaluate(() => {
      const a = document.getElementById("twin");
      return { hidden: a.hidden, href: a.getAttribute("href"), label: a.textContent };
    })
    .catch(() => ({ hidden: true }));
  record(
    "arXiv: the reader offers the paper's HTML page as a link, having asked nobody about it",
    link.hidden === false &&
      link.href === "https://arxiv.org/html/2402.17764" &&
      link.label === "HTML" &&
      asked.length === before,
    JSON.stringify({ ...link, newRequests: asked.length - before }),
  );
  await page.close();
}

// ---- F: what left the machine ------------------------------------------------------------------

{
  // Every request the whole run made, checked against the only places anything may go: the
  // fixtures and the fake fixture, both on loopback. arxiv.org appears here only because the
  // run opened papers there on purpose, and never as something the extension asked for on
  // its own account.
  const stray = requested.filter((url) => {
    if (!/^https?:/.test(url)) return false; // chrome-extension:, file:, data:
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "arxiv.org";
  });
  record(
    "privacy: nothing but the fixtures and the fixture is ever contacted",
    stray.length === 0,
    JSON.stringify(stray.slice(0, 5)),
  );
  // Two shapes are allowed and no third. A TAB NAVIGATING to a paper is the reader opening
  // it. And the PDF tab RE-READING ITS OWN ADDRESS is the handoff: the content script in
  // that tab asking for the document the tab is already showing, from the tab's own origin
  // and with the tab's own cookies (lib/pdf/handoff.ts). Anything else — a request from the
  // service worker, from an extension page, or for an address other than the one that frame
  // is on — is the extension asking arxiv.org something, which is what this suite is for.
  const unexplained = asked.filter(
    (a) => a.kind !== "document" && !(a.kind === "fetch" && a.from === a.url),
  );
  record(
    "privacy: arxiv.org was only ever the tab going to a paper, or that tab re-reading it",
    unexplained.length === 0,
    JSON.stringify(unexplained.slice(0, 5)),
  );
}

{
  // AND THE ONE THAT MATTERS MOST: while a remote PDF was being opened, did the READER
  // PAGE itself ask for anything outside the extension? Playwright reports the frame each
  // request came from, so this is watched at the browser level rather than taken on
  // trust from the page — the old code's `fetch(src, {credentials:"include"})` would be
  // sitting in this list.
  record(
    "privacy: the reading mode itself requested nothing beyond the extension's own files",
    fromReader.length === 0,
    JSON.stringify(fromReader.slice(0, 5)),
  );
}

await context.close();
await fixture.close();
await files.close();

// ---- summary ------------------------------------------------------------------------------------

console.log("\n=== PDF ROUTING ===");
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length}/${results.length} checks passed${skips.length ? `, ${skips.length} skipped` : ""}`);
console.log(fails.length === 0 ? "✅ PDF ROUTING GREEN" : "❌ PDF ROUTING FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
