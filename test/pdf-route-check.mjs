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
import { withFakeDaemon, requireBuild, BADGE_SEL } from "./harness.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";

requireBuild();

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

// ---- the fixtures ---------------------------------------------------------------------

/** Serve the PDFs. `/paper.pdf` stands in for a PDF with no twin at all. */
const files = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/ordinary.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html lang=en><body><p>an ordinary page</p></body></html>");
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

const { daemon, context, sw, extId } = await withFakeDaemon();

// Every address the extension asks for, so the checks below can say what was contacted and
// how often.
const requested = [];
context.on("request", (request) => requested.push(request.url()));

// arxiv.org answers here and nowhere else, so an arXiv paper can be opened without the
// real site being touched — and so that a probe, if one ever came back, would be recorded
// rather than quietly succeed against the live repository.
const asked = [];
await context.route("**arxiv.org/**", async (route) => {
  asked.push({ url: route.request().url(), kind: route.request().resourceType() });
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
      decodeURIComponent(page.url().split("src=")[1]) === "https://arxiv.org/pdf/2402.17764",
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
    decodeURIComponent(page.url().split("src=")[1] ?? "") === "https://arxiv.org/pdf/2402.17764v1",
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
  // A reload of the reading mode is the reader's own URL reloading — it stays the reader.
  const page = await visit(files.url("/reload.pdf"));
  await page.reload({ waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(2500);
  record(
    "on: reloading an automatically opened reading mode stays in the reading mode",
    page.url().startsWith(`${READER}?src=`),
    page.url().slice(0, 80),
  );
  await page.close();
}

{
  // A local PDF. Whether this can work at all is decided by one tick in chrome://extensions
  // ("Allow access to file URLs"), which governs BOTH the content script on a file: page
  // and the reader's own fetch of it — so where the first happens the second does too.
  //
  // SINCE OPTIONAL SITE ACCESS: the manifest no longer declares `file:///*` at all (it
  // asks for the daemon's two loopback hosts and offers the two http(s) patterns), and
  // that tick grants nothing an extension has not declared. So this SKIPs, and a local
  // PDF is read by dropping the file into the reading mode. Add `file:///*` to
  // host_permissions — it grants nothing by itself, the tick still gates it — and this
  // check comes back to life.
  const allowed = await sw
    .evaluate(
      async () =>
        (await chrome.extension.isAllowedFileSchemeAccess()) &&
        (await chrome.permissions.contains({ origins: ["file:///*"] })),
    )
    .catch(() => false);
  const page = await visit(`file://${LOCAL_PDF}`);
  await page.waitForTimeout(2000);
  const read = await page
    .evaluate(() => ({
      pages: document.querySelectorAll(".page").length,
      spans: document.querySelectorAll(".textLayer span").length,
      notice: document.getElementById("notice")?.textContent ?? null,
    }))
    .catch(() => ({ pages: 0, spans: 0, notice: null }));
  record(
    "on: a local PDF opens and is really read, where file access is allowed at all",
    allowed ? page.url().startsWith(`${READER}?src=file`) && read.pages === 2 && read.spans >= 29 : null,
    JSON.stringify({ allowed, url: page.url().slice(0, 60), ...read }),
  );
  await page.close();
}

{
  // An arXiv paper reached automatically takes the same route as the chip did: the PDF.
  const page = await visit("https://arxiv.org/pdf/2402.17764");
  record(
    "on: an arXiv PDF tab goes to the reading mode showing that same PDF",
    decodeURIComponent(page.url().split("src=")[1] ?? "") === "https://arxiv.org/pdf/2402.17764",
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

// ---- E: what left the machine ------------------------------------------------------------------

{
  // Every request the whole run made, checked against the only places anything may go: the
  // fixtures and the fake daemon, both on loopback. arxiv.org appears here only where a TAB
  // navigated to a paper the run opened on purpose, never as something the extension asked
  // for on its own — so a request to it that is not a `document` is a probe that came back.
  const stray = requested.filter((url) => {
    if (!/^https?:/.test(url)) return false; // chrome-extension:, file:, data:
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "arxiv.org";
  });
  record(
    "privacy: nothing but the fixtures and the daemon is ever contacted",
    stray.length === 0,
    JSON.stringify(stray.slice(0, 5)),
  );
  record(
    "privacy: every arxiv.org request was a tab going to a paper, not the extension asking",
    asked.every((a) => a.kind === "document"),
    JSON.stringify(asked.filter((a) => a.kind !== "document").slice(0, 5)),
  );
}

await context.close();
await daemon.close();
await files.close();

// ---- summary ------------------------------------------------------------------------------------

console.log("\n=== PDF ROUTING ===");
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length}/${results.length} checks passed${skips.length ? `, ${skips.length} skipped` : ""}`);
console.log(fails.length === 0 ? "✅ PDF ROUTING GREEN" : "❌ PDF ROUTING FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
