// Browser PDF routing, bounded handoff, and explicit source authorization.
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFakeNative, requireBuild, closeServer } from "./harness.mjs";
import {
  TEST_PDF, LOCKED_PDF, PDF_PASSWORD,
  openPdfInReader, readerReady, readerRead, readerState, pdfChipCount, pdfChips, pdfTabChip,
} from "./pdf-fixture.mjs";

requireBuild();

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });


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
    if (path === "/huge.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
      const piece = Buffer.alloc(1024 * 1024, 0x20);
      Buffer.from("%PDF-1.7\n", "latin1").copy(piece);
      const slot = oversizedSends.push(0) - 1;
      let open = true;
      let next;
      res.on("close", () => {
        open = false;
        clearTimeout(next);
      });
      const pump = () => {
        if (!open) return;
        if (oversizedSends[slot] >= OVERSIZED) return void res.end();
        oversizedSends[slot] += piece.length;
        const schedule = () => { next = setTimeout(pump, 200); };
        if (res.write(piece)) schedule();
        else res.once("drain", schedule);
      };
      pump();
      return;
    }
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
      close: () => closeServer(server),
    });
  });
});

/** A local PDF, for the one protocol whose answer had to be found out rather than assumed. */
const localHome = mkdtempSync(join(tmpdir(), "anagram-pdf-route-"));
const LOCAL_PDF = join(localHome, "paper.pdf");
writeFileSync(LOCAL_PDF, TEST_PDF);

const { fixture, context, sw, extId } = await withFakeNative();

try {
const requested = [];
/** …and what the READER PAGE asked for, which after this change must be nothing at all. */
const fromReader = [];
context.on("request", (request) => {
  requested.push(request.url());
  let from = "";
  try {
    from = request.frame()?.url() ?? "";
  } catch {
    return;
  }
  if (
    from.includes("/reader.html") &&
    request.resourceType() !== "document" &&
    !request.url().startsWith("chrome-extension://")
  ) {
    fromReader.push(`${request.resourceType()} ${request.url().slice(0, 100)}`);
  }
});

const asked = [];
await context.route("**arxiv.org/**", async (route) => {
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
 * runtime message (there is no receiving end). Only the popup is authorized to name
 * another tab and URL, so the test opens that packaged page in a regular browser tab.
 */
const driver = await context.newPage();
await driver.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });

const ready = (page) => readerReady(page);

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

/** Open `url` in a tab of its own. */
async function visit(url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" }).catch(() => {});
  return page;
}
/** The worker has moved this tab into the reader, showing `src`. */
const inReader = (page, src) =>
  page
    .waitForURL((u) => u.href.startsWith(`${READER}?src=`) && (!src || u.searchParams.get("src") === src), { timeout: 15000 })
    .then(() => true, () => false);
/** How long a check that something does NOT happen watches for it: there is no signal
 *  for a navigation or a read that never comes. Everything that should happen is waited for. */
const ABSENCE_MS = 3000;
/** The reader has settled on a page it will not load: its file picker is up. It is also the
 *  sign that the viewer has started — a file chosen before that is not taken. */
const pickerShown = (page) => page.locator("#drop:not([hidden])").waitFor({ timeout: 15000 }).then(() => true, () => false);


{
  const page = await visit("https://arxiv.org/pdf/2402.17764");
  await pdfTabChip(page);
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
  const page = await visit("https://arxiv.org/pdf/2402.17764v1");
  await pdfTabChip(page);
  const tabId = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? null;
  }, "https://arxiv.org/pdf/2402.17764v1");
  await driver.evaluate(
    ([url, id]) => chrome.runtime.sendMessage({ action: "openPdfReader", url, tabId: id }),
    ["https://arxiv.org/pdf/2402.17764v1", tabId],
  );
  await inReader(page, "https://arxiv.org/pdf/2402.17764v1");
  record(
    "the popup's button takes the same route, and the version in the address is kept",
    new URL(page.url()).searchParams.get("src") === "https://arxiv.org/pdf/2402.17764v1",
    page.url().slice(0, 100),
  );
  await page.close();
}


{
  const probes = asked.filter((a) => a.url.includes("/html/"));
  record(
    "nothing asks arxiv.org whether a paper has an HTML rendering — the probe is gone",
    probes.length === 0,
    JSON.stringify(probes.slice(0, 3)),
  );
}


{
  const page = await visit(files.url("/doc.pdf"));
  await pdfTabChip(page);
  await page.waitForTimeout(ABSENCE_MS);
  const state = await tabState(page);
  record(
    "off (the default): a PDF tab stays a PDF tab, with the ball offering Analyze PDF",
    page.url() === files.url("/doc.pdf") && state.contentType === "application/pdf" && state.chip === "Analyze PDF",
    JSON.stringify({ url: page.url(), ...state }),
  );
  await page.close();
}


await setAutoOpen(true);

{
  const page = await visit(files.url("/doc.pdf"));
  await inReader(page);
  await readerRead(page).catch(() => {});
  const chips = await pdfChips(page);
  const reading = await page
    .evaluate(() => ({
      pages: document.querySelectorAll(".page").length,
      spans: document.querySelectorAll(".textLayer span").length,
      title: document.title,
    }))
    .catch(() => ({ pages: 0, spans: 0, title: null }));
  reading.chips = chips;
  record(
    "on: the same PDF lands in the reading mode, with its pages and chips",
    page.url() === `${READER}?src=${encodeURIComponent(files.url("/doc.pdf"))}` &&
      reading.pages === 2 &&
      reading.spans > 5 &&
      reading.chips > 0,
    JSON.stringify({ url: page.url().slice(0, 60), ...reading }),
  );

  await page.goBack({ waitUntil: "load" }).catch(() => {});
  await pdfTabChip(page);
  await page.waitForTimeout(ABSENCE_MS);
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
  const page = await visit(files.url("/doc.pdf?original"));
  await inReader(page);
  await page.locator("#original:not([hidden])").waitFor({ timeout: 15000 }).catch(() => {});
  const clicked = await page
    .evaluate(() => {
      const button = document.getElementById("original");
      if (!button || button.hidden) return "no button";
      button.click();
      return "clicked";
    })
    .catch((e) => String(e));
  await page.waitForURL(files.url("/doc.pdf?original"), { timeout: 15000 }).catch(() => {});
  await pdfTabChip(page);
  await page.waitForTimeout(ABSENCE_MS);
  const original = await tabState(page);
  record(
    "on + Open original: the reader hands the tab back to the PDF and it stays there",
    clicked === "clicked" &&
      page.url() === files.url("/doc.pdf?original") &&
      original.contentType === "application/pdf",
    JSON.stringify({ clicked, url: page.url(), ...original }),
  );

  await page.goto(files.url("/ordinary.html"), { waitUntil: "load" }).catch(() => {});
  await page.goto(files.url("/doc.pdf?original"), { waitUntil: "load" }).catch(() => {});
  await inReader(page);
  record(
    "on: the pass is spent — the same PDF opened again goes to the reading mode",
    page.url().startsWith(`${READER}?src=`),
    page.url().slice(0, 80),
  );
  await page.close();
}

{
  const front = await visit(files.url("/ordinary.html"));
  const background = await context.newPage();
  await background.goto(files.url("/background.pdf"), { waitUntil: "load" }).catch(() => {});
  await front.bringToFront();
  await inReader(background);
  record(
    "on: a PDF opened in a background tab moves THAT tab, and the foreground tab stays put",
    background.url().startsWith(`${READER}?src=`) && front.url() === files.url("/ordinary.html"),
    JSON.stringify({ background: background.url().slice(0, 60), front: front.url() }),
  );
  await background.close();
  await front.close();
}

{
  const page = await visit(files.url("/reload.pdf"));
  await ready(page);
  await page.reload({waitUntil:"load"});
  await page.locator("#drop:not([hidden])").waitFor();
  const state = await page.evaluate(() => ({drop: !document.getElementById("drop").hidden, original: !document.getElementById("original").hidden}));
  record("refresh: a spent source stays in the reader with picker and explicit original recovery",
    page.url().startsWith(`${READER}?src=`) && state.drop && state.original, JSON.stringify(state));
  await page.close();
}

{
  const declared = await sw
    .evaluate(
      async () =>
        (await chrome.extension.isAllowedFileSchemeAccess()) &&
        (await chrome.permissions.contains({ origins: ["file:///*"] })),
    )
    .catch(() => false);
  const page = await visit(`file://${LOCAL_PDF}`);
  // Nothing on a file: page without file access can say it has been left alone.
  await page.waitForTimeout(ABSENCE_MS);
  record(
    "on: a local PDF without its separate authorization remains in the native viewer",
    page.url() === `file://${LOCAL_PDF}`,
    JSON.stringify({ fileAccessDeclared: declared, url: page.url().slice(-40) }),
  );
  await page.close();
}

{
  const page = await visit("https://arxiv.org/pdf/2402.17764");
  await inReader(page, "https://arxiv.org/pdf/2402.17764");
  record(
    "on: an arXiv PDF tab goes to the reading mode showing that same PDF",
    new URL(page.url()).searchParams.get("src") === "https://arxiv.org/pdf/2402.17764",
    page.url().slice(0, 100),
  );
  await page.close();
}


await setAutoOpen(false);

{
  const page = await visit(files.url("/after-off.pdf"));
  await pdfTabChip(page);
  await page.waitForTimeout(ABSENCE_MS);
  const state = await tabState(page);
  record(
    "off again: the very next PDF stays a PDF, with no restart of anything",
    page.url() === files.url("/after-off.pdf") && state.chip === "Analyze PDF",
    JSON.stringify({ url: page.url(), ...state }),
  );
  await page.close();
}


await setAutoOpen(false);

{
  const page = await openPdfInReader(context, files.url("/exact.pdf"));
  await ready(page);
  const digest = await page
    .evaluate(async () => {
      const bytes = await window.PDFViewerApplication.pdfDocument.getData();
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const text = new TextDecoder().decode(bytes);
      return { hash: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""), chars: text.length };
    })
    .catch(() => ({ hash: null, chars: 0 }));
  const dropped = await context.newPage();
  await dropped.goto(READER, { waitUntil: "load" });
  await pickerShown(dropped);
  await dropped.setInputFiles("#file", { name: "exact.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
  await ready(dropped);
  const direct = await dropped
    .evaluate(async () => {
      const bytes = await window.PDFViewerApplication.pdfDocument.getData();
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })
    .catch(() => null);
  record(
    "handoff: the document that arrives through the tab is the document, byte for byte",
    digest.hash !== null && digest.hash === direct && digest.chars > 500,
    JSON.stringify({ relayed: digest.hash?.slice(0, 16), direct: direct?.slice(0, 16), chars: digest.chars }),
  );
  record(
    "handoff: the ticket is spent — the address keeps only the document's own name",
    page.url() === `${READER}?src=${encodeURIComponent(files.url("/exact.pdf"))}`,
    page.url().slice(0, 90),
  );
  await dropped.close();
  await page.close();
}

{
  const page = await openPdfInReader(context, files.url("/huge.pdf"), { timeout: 40000 });
  await pickerShown(page);
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
  const page = await openPdfInReader(context, files.url("/notreally.pdf"), { timeout: 40000 });
  await pickerShown(page);
  const notice = await page.evaluate(() => document.getElementById("notice")?.textContent ?? null).catch(() => null);
  record(
    "handoff: a page that is not a PDF is refused on its first bytes, not on its content type",
    notice === "This file could not be read as a PDF.",
    String(notice),
  );
  await page.close();
}

{
  const src = files.url("/pasted.pdf");
  const requestsBefore = requested.filter((url) => url === src).length;
  const page = await context.newPage();
  const visits = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visits.push(f.url());
  });
  await page.goto(`${READER}?src=${encodeURIComponent(src)}`, { waitUntil: "load" }).catch(() => {});
  await pickerShown(page);
  await page.waitForTimeout(ABSENCE_MS);
  const reader = visits.filter((u) => u.startsWith(READER)).length;
  record(
    "handoff: a pasted source does not navigate or read anything automatically",
    page.url().startsWith(READER) && visits.every((url) => url.startsWith(READER)) &&
      requested.filter((url) => url === src).length === requestsBefore &&
      await page.locator("#drop:not([hidden])").isVisible(),
    JSON.stringify({ landed: page.url().slice(-20), visits: visits.length, reader }),
  );
  await page.close();
}

{
  const page = await context.newPage();
  await page.goto(`${READER}?src=${encodeURIComponent("javascript:window.__ran=1")}`, { waitUntil: "load" }).catch(() => {});
  await pickerShown(page);
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
  await setAutoOpen(true);
  const src = files.url("/pasted-on.pdf");
  const page = await context.newPage();
  const visits = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) visits.push(f.url());
  });
  await page.goto(`${READER}?src=${encodeURIComponent(src)}`, { waitUntil: "load" }).catch(() => {});
  await pickerShown(page);
  await page.waitForTimeout(ABSENCE_MS);
  const pages = await page.evaluate(() => document.querySelectorAll(".page").length).catch(() => 0);
  record(
    "handoff: auto-open does not turn an arbitrary reader source query into a read permission",
    page.url().startsWith(`${READER}?src=`) && pages === 0 && visits.filter((u) => u === src).length === 0,
    JSON.stringify({ url: page.url().slice(0, 60), pages, visits: visits.map((u) => (u === src ? "pdf" : "reader")) }),
  );
  await page.close();
  await setAutoOpen(false);
}

{
  const page = await openPdfInReader(context, files.url("/locked.pdf"), { timeout: 40000 });
  await page.waitForSelector("#passwordDialog[open]", { timeout: 25000 }).catch(() => {});
  const asked = await page
    .evaluate(() => ({
      shown: document.getElementById("passwordDialog").open,
      invalid: document.getElementById("passwordText").getAttribute("data-l10n-id"),
      focused: document.activeElement?.id ?? null,
      notice: document.getElementById("notice").textContent,
      pages: document.querySelectorAll("#viewer .page").length,
    }))
    .catch(() => ({ shown: false }));
  await page.fill("#password", "not the password");
  await page.press("#password", "Enter");
  await page.waitForFunction(() => document.getElementById("passwordText").getAttribute("data-l10n-id") === "pdfjs-password-invalid", null, { timeout: 15000 }).catch(() => {});
  const refused = await page
    .evaluate(() => ({
      invalid: document.getElementById("passwordText").getAttribute("data-l10n-id"),
      value: document.getElementById("password").value,
      pages: document.querySelectorAll(".page").length,
    }))
    .catch(() => ({}));
  await page.fill("#password", PDF_PASSWORD);
  await page.press("#password", "Enter");
  await ready(page);
  const opened = await page
    .evaluate(() => ({
      shown: document.getElementById("passwordDialog").open,
      pages: document.querySelectorAll(".page").length,
      spans: document.querySelectorAll(".textLayer span").length,
    }))
    .catch(() => ({}));
  record(
    "password: the upstream reader asks before rendering the document",
    asked.shown === true && asked.invalid !== "pdfjs-password-invalid" && asked.focused === "password" && asked.pages === 0,
    JSON.stringify(asked),
  );
  record(
    "password: a wrong one marks the field, empties it, and shows nothing of the document",
    refused.invalid === "pdfjs-password-invalid" && refused.value === "" && refused.pages === 0,
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
  // The panel's switch turns off the site the PDF came from. The reader's own host is the
  // extension's id, which is no site: no rule may name it, and a local file has no switch.
  // The rule as soon as the panel's write lands (it is not awaited before the reader stops).
  const ruleWritten = () => sw.evaluate(() => new Promise((resolve) => {
    const read = () => chrome.storage.local.get("siteOverrides", (v) => {
      if (Object.keys(v.siteOverrides ?? {}).length) { chrome.storage.onChanged.removeListener(read); clearTimeout(timer); resolve(v.siteOverrides); }
    });
    const timer = setTimeout(() => { chrome.storage.onChanged.removeListener(read); chrome.storage.local.get("siteOverrides", (v) => resolve(v.siteOverrides ?? {})); }, 10000);
    chrome.storage.onChanged.addListener(read);
    read();
  }));
  const chips = pdfChipCount;
  const panelSwitch = (p) => p.evaluate(() => {
    const sr = document.getElementById("anagram-fab")?.shadowRoot;
    sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { open: !!sr?.querySelector(".phead"), label: sr?.querySelector(".psiteoff")?.textContent ?? null };
  }).catch(() => ({ open: false, label: null }));

  const page = await openPdfInReader(context, files.url("/site-off.pdf"));
  // Counted once the structure worker's answer has re-laid the chips, not in the moment
  // between its rescan taking them down and the cache putting them back.
  await readerRead(page).catch(() => {});
  const before = await pdfChips(page);
  const beforeState = await readerState(page);
  const visibility = await page.evaluate(() => document.visibilityState).catch(() => null);
  const offered = await panelSwitch(page);
  await page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".psiteoff")?.click()).catch(() => {});
  // A stopped reader takes its ball down with its chips (lib/render/fab.ts unmount).
  await page.waitForFunction(() => !document.getElementById("anagram-fab"), null, { timeout: 10000 }).catch(() => {});
  const after = await chips(page);
  const written = await ruleWritten();
  record(
    "reader: Turn off names the PDF's own site, writes the rule there, and stops the reader",
    before > 0 && offered.label === "Turn off on localhost" && after === 0 && JSON.stringify(written) === JSON.stringify({ localhost: "off" }),
    JSON.stringify({ before, visibility, offered, after, written, reader: beforeState }),
  );

  const next = await visit(files.url("/site-off-next.pdf"));
  await pdfTabChip(next);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id ?? null, files.url("/site-off-next.pdf"));
  await driver.evaluate(([url, id]) => chrome.runtime.sendMessage({ action: "openPdfReader", url, tabId: id }), [files.url("/site-off-next.pdf"), tabId]);
  await next.waitForURL(/reader\.html/, { timeout: 10000 }).catch(() => {});
  await readerRead(next).catch(() => {});
  await next.waitForTimeout(ABSENCE_MS);
  record(
    "reader: the next PDF from a site turned off opens without being analyzed",
    next.url().startsWith(`${READER}?src=`) && (await chips(next)) === 0,
    JSON.stringify({ url: next.url().slice(0, 60), chips: await chips(next) }),
  );
  await sw.evaluate(() => new Promise((r) => chrome.storage.local.set({ siteOverrides: {} }, r)));

  const local = await context.newPage();
  await local.goto(READER, { waitUntil: "load" });
  await pickerShown(local);
  await local.setInputFiles("#file", { name: "local.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
  await readerRead(local).catch(() => {});
  await pdfChips(local);
  const localState = await readerState(local);
  const localSwitch = await panelSwitch(local);
  record(
    "reader: a file from this computer has no site, so its panel offers no switch",
    localSwitch.open && localSwitch.label === null,
    JSON.stringify({ ...localSwitch, reader: localState }),
  );
  await local.close();
  await next.close();
  await page.close();
}

{
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
  record(
    "privacy: the reading mode itself requested nothing beyond the extension's own files",
    fromReader.length === 0,
    JSON.stringify(fromReader.slice(0, 5)),
  );
}

} finally {
  await context.close();
  await fixture.close();
  await files.close();
  rmSync(localHome, {recursive:true, force:true});
}


console.log("\n=== PDF ROUTING ===");
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length}/${results.length} checks passed${skips.length ? `, ${skips.length} skipped` : ""}`);
console.log(fails.length === 0 ? "✅ PDF ROUTING GREEN" : "❌ PDF ROUTING FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
