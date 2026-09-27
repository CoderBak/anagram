// Where a PDF opens: the ball's chip and the popup's button, the automatic reading mode and
// its way back, the bounded handoff of the bytes, the reader's password dialog and site
// switch — and, after every test, that nothing was contacted but the fixtures.
//
//   npx playwright test pdf-route
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "./fixtures.mjs";
import {
  TEST_PDF, PDF_PASSWORD,
  openPdfInReader, readerReady, readerRead, readerState, pdfChipCount, pdfChips, pdfTabChip,
} from "../pdf-fixture.mjs";

/** How big the "too large" fixture below really is — comfortably over the 50 MiB cap. */
const OVERSIZED = 70 * 1024 * 1024;
/** How long a check that something does NOT happen watches for it: there is no signal
 *  for a navigation or a read that never comes. Everything that should happen is waited for. */
const ABSENCE_MS = 3000;
const ARXIV = "https://arxiv.org/pdf/2402.17764";

const test = base.extend({
  /** The PDFs, plus a page that is none, a page that only says it is one, and a PDF too
   *  big to read, which records how much of it each request took before letting go: the
   *  tab's own load reads all of it; the content script's re-read must stop at the cap. */
  files: async ({ pdfServer }, use) => {
    const oversizedSends = [];
    pdfServer.serve({
      "/ordinary.html": "<!doctype html><html lang=en><body><p>an ordinary page</p></body></html>",
      "/notreally.pdf": (req, res) => {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end("<!doctype html><html lang=en><body><p>Please sign in to read this paper.</p></body></html>");
      },
      "/huge.pdf": (req, res) => {
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
      },
    });
    await use({ url: pdfServer.url, oversizedSends });
  },

  /** A tab going to arxiv.org gets the fixture PDF, and whatever asked for it is recorded. */
  arxiv: async ({ context }, use) => {
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
    await use(asked);
  },

  /** Privacy, over everything the test did. */
  traffic: [
    async ({ context, arxiv }, use) => {
      const requested = [];
      /** …and what the READER PAGE asked for, which must be nothing at all. */
      const fromReader = [];
      context.on("request", (request) => {
        requested.push(request.url());
        let from = "";
        try {
          from = request.frame()?.url() ?? "";
        } catch {
          return;
        }
        if (from.includes("/reader.html") && request.resourceType() !== "document" && !request.url().startsWith("chrome-extension://")) {
          fromReader.push(`${request.resourceType()} ${request.url().slice(0, 100)}`);
        }
      });
      await use({ requested });
      const stray = requested.filter((url) => {
        if (!/^https?:/.test(url)) return false; // chrome-extension:, file:, data:
        const { hostname } = new URL(url);
        return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "arxiv.org";
      });
      expect(stray, "privacy: nothing but the fixtures and the fixture is ever contacted").toEqual([]);
      const unexplained = arxiv.filter((a) => a.kind !== "document" && !(a.kind === "fetch" && a.from === a.url));
      expect(unexplained, "privacy: arxiv.org was only ever the tab going to a paper, or that tab re-reading it").toEqual([]);
      expect(fromReader, "privacy: the reading mode itself requested nothing beyond the extension's own files").toEqual([]);
      expect(arxiv.filter((a) => a.url.includes("/html/")), "nothing asks arxiv.org whether a paper has an HTML rendering").toEqual([]);
    },
    { auto: true },
  ],
});

const READER = (extension) => extension.url("reader.html");
/** Open `url` in a tab of its own. */
async function visit(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" }).catch(() => {});
  return page;
}
/** What the ball is offering on this page, and what the page thinks it is showing. */
const tabState = (page) =>
  page
    .evaluate(() => ({
      contentType: document.contentType,
      chip: document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".action")?.textContent ?? null,
      navigationType: performance.getEntriesByType("navigation")[0]?.type ?? null,
    }))
    .catch(() => ({ contentType: null, chip: null, navigationType: null }));
/** The worker has moved this tab into the reader, showing `src`. */
const inReader = (page, extension, src) =>
  page
    .waitForURL((u) => u.href.startsWith(`${READER(extension)}?src=`) && (!src || u.searchParams.get("src") === src), { timeout: 15000 })
    .then(() => true, () => false);
/** The reader has settled on a page it will not load: its file picker is up. It is also the
 *  sign that the viewer has started — a file chosen before that is not taken. */
const pickerShown = (page) => page.locator("#drop:not([hidden])").waitFor({ timeout: 15000 }).then(() => true, () => false);
/**
 * An extension page to send the popup's message from. The worker cannot send itself a
 * runtime message (there is no receiving end). Only the popup is authorized to name
 * another tab and URL, so the test opens that packaged page in a regular browser tab.
 */
async function popupDriver(context, extension) {
  const driver = await context.newPage();
  await driver.goto(extension.url("popup.html"), { waitUntil: "load" });
  return driver;
}
/** Send the popup's "open in the reader" for the tab showing `url`. */
async function openFromPopup(context, extension, url) {
  const driver = await popupDriver(context, extension);
  const tabId = await extension.sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, url);
  await driver.evaluate(([u, id]) => chrome.runtime.sendMessage({ action: "openPdfReader", url: u, tabId: id }), [url, tabId]);
}
const sha256 = (page) =>
  page.evaluate(async () => {
    const bytes = await window.PDFViewerApplication.pdfDocument.getData();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return { hash: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""), chars: new TextDecoder().decode(bytes).length };
  });

test.describe("the way into the reader", () => {
  test("the ball's chip on a paper's PDF opens THAT PDF in the reading mode", async ({ context, extension }) => {
    const page = await visit(context, ARXIV);
    await pdfTabChip(page);
    const before = await tabState(page);
    await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".action").click()).catch(() => {});
    await page.waitForURL(/reader\.html/, { timeout: 10000 }).catch(() => {});
    expect(before.chip).toBe("Analyze PDF");
    expect(page.url().startsWith(`${READER(extension)}?src=`), page.url().slice(0, 100)).toBe(true);
    expect(new URL(page.url()).searchParams.get("src")).toBe(ARXIV);
  });

  test("the popup's button takes the same route, and the version in the address is kept", async ({ context, extension }) => {
    const url = `${ARXIV}v1`;
    const page = await visit(context, url);
    await pdfTabChip(page);
    await openFromPopup(context, extension, url);
    await inReader(page, extension, url);
    expect(new URL(page.url()).searchParams.get("src")).toBe(url);
  });

  test("nothing asks arxiv.org whether a paper has an HTML rendering — the probe is gone", async ({ context, extension, arxiv }) => {
    const page = await visit(context, ARXIV);
    await pdfTabChip(page);
    await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".action").click()).catch(() => {});
    await inReader(page, extension, ARXIV);
    await readerReady(page);
    // A probe would go out around the handoff; there is no signal for one that never comes.
    await page.waitForTimeout(ABSENCE_MS);
    const probes = arxiv.filter((a) => a.url.includes("/html/"));
    expect(probes).toEqual([]);
  });

  test("off (the default): a PDF tab stays a PDF tab, with the ball offering Analyze PDF", async ({ context, files }) => {
    const page = await visit(context, files.url("/doc.pdf"));
    await pdfTabChip(page);
    await page.waitForTimeout(ABSENCE_MS);
    const state = await tabState(page);
    expect({ url: page.url(), ...state }).toMatchObject({ url: files.url("/doc.pdf"), contentType: "application/pdf", chip: "Analyze PDF" });
  });
});

test.describe("reading mode on", () => {
  test.beforeEach(async ({ storage }) => {
    await storage.set({ autoOpenPdfs: true });
  });

  test("on: the same PDF lands in the reading mode, with its pages and chips", async ({ context, extension, files }) => {
    const page = await visit(context, files.url("/doc.pdf"));
    await inReader(page, extension);
    await readerRead(page).catch(() => {});
    const chips = await pdfChips(page);
    const reading = await page
      .evaluate(() => ({ pages: document.querySelectorAll(".page").length, spans: document.querySelectorAll(".textLayer span").length, title: document.title }))
      .catch(() => ({ pages: 0, spans: 0, title: null }));
    expect(page.url()).toBe(`${READER(extension)}?src=${encodeURIComponent(files.url("/doc.pdf"))}`);
    expect(reading.pages, JSON.stringify(reading)).toBe(2);
    expect(reading.spans).toBeGreaterThan(5);
    expect(chips).toBeGreaterThan(0);
  });

  test("on + Back: the tab stays on the PDF and the ball offers Analyze PDF again", async ({ context, extension, files }) => {
    const page = await visit(context, files.url("/doc.pdf"));
    await inReader(page, extension);
    await readerRead(page).catch(() => {});
    await page.goBack({ waitUntil: "load" }).catch(() => {});
    await pdfTabChip(page);
    await page.waitForTimeout(ABSENCE_MS);
    const back = await tabState(page);
    expect({ url: page.url(), ...back }).toMatchObject({ url: files.url("/doc.pdf"), navigationType: "back_forward", chip: "Analyze PDF" });
  });

  /** Open `/doc.pdf?original` in the reader and press Open original. */
  async function openOriginal(context, extension, files) {
    const page = await visit(context, files.url("/doc.pdf?original"));
    await inReader(page, extension);
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
    return { page, clicked };
  }

  test("on + Open original: the reader hands the tab back to the PDF and it stays there", async ({ context, extension, files }) => {
    const { page, clicked } = await openOriginal(context, extension, files);
    await page.waitForTimeout(ABSENCE_MS);
    const original = await tabState(page);
    expect(clicked).toBe("clicked");
    expect(page.url()).toBe(files.url("/doc.pdf?original"));
    expect(original.contentType).toBe("application/pdf");
  });

  test("on: the pass is spent — the same PDF opened again goes to the reading mode", async ({ context, extension, files }) => {
    const { page } = await openOriginal(context, extension, files);
    await page.goto(files.url("/ordinary.html"), { waitUntil: "load" }).catch(() => {});
    await page.goto(files.url("/doc.pdf?original"), { waitUntil: "load" }).catch(() => {});
    await inReader(page, extension);
    expect(page.url().startsWith(`${READER(extension)}?src=`), page.url().slice(0, 80)).toBe(true);
  });

  test("on: a PDF opened in a background tab moves THAT tab, and the foreground tab stays put", async ({ context, extension, files }) => {
    const front = await visit(context, files.url("/ordinary.html"));
    const background = await context.newPage();
    await background.goto(files.url("/background.pdf"), { waitUntil: "load" }).catch(() => {});
    await front.bringToFront();
    await inReader(background, extension);
    expect(background.url().startsWith(`${READER(extension)}?src=`), background.url().slice(0, 60)).toBe(true);
    expect(front.url()).toBe(files.url("/ordinary.html"));
  });

  test("refresh: a spent source stays in the reader with picker and explicit original recovery", async ({ context, extension, files }) => {
    const page = await visit(context, files.url("/reload.pdf"));
    await readerReady(page);
    await page.reload({ waitUntil: "load" });
    await page.locator("#drop:not([hidden])").waitFor();
    const state = await page.evaluate(() => ({ drop: !document.getElementById("drop").hidden, original: !document.getElementById("original").hidden }));
    expect(page.url().startsWith(`${READER(extension)}?src=`)).toBe(true);
    expect(state).toEqual({ drop: true, original: true });
  });

  test("on: a local PDF without its separate authorization remains in the native viewer", async ({ context, extension }, testInfo) => {
    const path = testInfo.outputPath("paper.pdf");
    writeFileSync(path, TEST_PDF);
    const local = pathToFileURL(path).href;
    const declared = await extension.sw
      .evaluate(async () => (await chrome.extension.isAllowedFileSchemeAccess()) && (await chrome.permissions.contains({ origins: ["file:///*"] })))
      .catch(() => false);
    const page = await visit(context, local);
    // Nothing on a file: page without file access can say it has been left alone.
    await page.waitForTimeout(ABSENCE_MS);
    expect(page.url(), JSON.stringify({ fileAccessDeclared: declared })).toBe(local);
  });

  test("on: an arXiv PDF tab goes to the reading mode showing that same PDF", async ({ context, extension }) => {
    const page = await visit(context, ARXIV);
    await inReader(page, extension, ARXIV);
    expect(new URL(page.url()).searchParams.get("src")).toBe(ARXIV);
  });

  test("off again: the very next PDF stays a PDF, with no restart of anything", async ({ context, extension, files, storage }) => {
    const on = await visit(context, files.url("/before-off.pdf"));
    expect(await inReader(on, extension), "the reading mode is on to begin with").toBe(true);
    await storage.set({ autoOpenPdfs: false });
    const page = await visit(context, files.url("/after-off.pdf"));
    await pdfTabChip(page);
    await page.waitForTimeout(ABSENCE_MS);
    const state = await tabState(page);
    expect(page.url()).toBe(files.url("/after-off.pdf"));
    expect(state.chip).toBe("Analyze PDF");
  });

  test("handoff: auto-open does not turn an arbitrary reader source query into a read permission", async ({ context, extension, files }) => {
    const src = files.url("/pasted-on.pdf");
    const page = await context.newPage();
    const visits = [];
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) visits.push(f.url());
    });
    await page.goto(`${READER(extension)}?src=${encodeURIComponent(src)}`, { waitUntil: "load" }).catch(() => {});
    await pickerShown(page);
    await page.waitForTimeout(ABSENCE_MS);
    const pages = await page.evaluate(() => document.querySelectorAll(".page").length).catch(() => 0);
    expect(page.url().startsWith(`${READER(extension)}?src=`)).toBe(true);
    expect(pages).toBe(0);
    expect(visits.filter((u) => u === src)).toHaveLength(0);
  });
});

test.describe("the handoff", () => {
  test("handoff: the document that arrives through the tab is the document, byte for byte", async ({ context, extension, files }) => {
    const page = await openPdfInReader(context, files.url("/exact.pdf"));
    await readerReady(page);
    const relayed = await sha256(page).catch(() => ({ hash: null, chars: 0 }));
    const dropped = await context.newPage();
    await dropped.goto(READER(extension), { waitUntil: "load" });
    await pickerShown(dropped);
    await dropped.setInputFiles("#file", { name: "exact.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
    await readerReady(dropped);
    const direct = await sha256(dropped).catch(() => ({ hash: null }));
    expect(relayed.hash).not.toBeNull();
    expect(relayed.hash).toBe(direct.hash);
    expect(relayed.chars).toBeGreaterThan(500);
  });

  test("handoff: the ticket is spent — the address keeps only the document's own name", async ({ context, extension, files }) => {
    const page = await openPdfInReader(context, files.url("/exact.pdf"));
    await readerReady(page);
    expect(page.url()).toBe(`${READER(extension)}?src=${encodeURIComponent(files.url("/exact.pdf"))}`);
  });

  test("handoff: an oversized document is stopped at the cap, not after it", async ({ context, files }) => {
    const page = await openPdfInReader(context, files.url("/huge.pdf"), { timeout: 40000 });
    await pickerShown(page);
    const state = await page
      .evaluate(() => ({ notice: document.getElementById("notice")?.textContent ?? null, drop: !document.getElementById("drop").hidden }))
      .catch(() => ({ notice: null, drop: false }));
    const megabytes = files.oversizedSends.map((n) => Math.round(n / 1048576));
    expect(state).toEqual({ notice: "This PDF is too large to read here.", drop: true });
    expect(megabytes.some((n) => n >= 40 && n <= 60), `megabytes per request: ${JSON.stringify(megabytes)}`).toBe(true);
  });

  test("handoff: a page that is not a PDF is refused on its first bytes, not on its content type", async ({ context, files }) => {
    const page = await openPdfInReader(context, files.url("/notreally.pdf"), { timeout: 40000 });
    await pickerShown(page);
    const notice = await page.evaluate(() => document.getElementById("notice")?.textContent ?? null).catch(() => null);
    expect(notice).toBe("This file could not be read as a PDF.");
  });

  test("handoff: a pasted source does not navigate or read anything automatically", async ({ context, extension, files, traffic }) => {
    const src = files.url("/pasted.pdf");
    const page = await context.newPage();
    const visits = [];
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) visits.push(f.url());
    });
    await page.goto(`${READER(extension)}?src=${encodeURIComponent(src)}`, { waitUntil: "load" }).catch(() => {});
    await pickerShown(page);
    await page.waitForTimeout(ABSENCE_MS);
    expect(page.url().startsWith(READER(extension))).toBe(true);
    expect(visits.every((url) => url.startsWith(READER(extension))), JSON.stringify(visits)).toBe(true);
    expect(traffic.requested.filter((url) => url === src)).toHaveLength(0);
    await expect(page.locator("#drop:not([hidden])")).toBeVisible();
  });

  test("handoff: a source that is not a document address is not an address to leave for", async ({ context, extension }) => {
    const page = await context.newPage();
    await page.goto(`${READER(extension)}?src=${encodeURIComponent("javascript:window.__ran=1")}`, { waitUntil: "load" }).catch(() => {});
    await pickerShown(page);
    const state = await page
      .evaluate(() => ({ ran: window.__ran ?? null, url: location.href, drop: !document.getElementById("drop").hidden, original: !document.getElementById("original").hidden }))
      .catch((e) => String(e));
    expect(state).toEqual({ ran: null, url: `${READER(extension)}?src=javascript%3Awindow.__ran%3D1`, drop: true, original: false });
  });
});

test.describe("a locked PDF", () => {
  /** Open the locked PDF through the tab and wait for the upstream password dialog. */
  async function openLocked(context, files) {
    const page = await openPdfInReader(context, files.url("/locked.pdf"), { timeout: 40000 });
    await page.waitForSelector("#passwordDialog[open]", { timeout: 25000 }).catch(() => {});
    return page;
  }
  /** Give it a wrong password and wait for the dialog to say so. */
  async function refuse(page) {
    await page.fill("#password", "not the password");
    await page.press("#password", "Enter");
    await page.waitForFunction(() => document.getElementById("passwordText").getAttribute("data-l10n-id") === "pdfjs-password-invalid", null, { timeout: 15000 }).catch(() => {});
  }

  test("password: the upstream reader asks before rendering the document", async ({ context, files }) => {
    const page = await openLocked(context, files);
    const asked = await page
      .evaluate(() => ({
        shown: document.getElementById("passwordDialog").open,
        invalid: document.getElementById("passwordText").getAttribute("data-l10n-id"),
        focused: document.activeElement?.id ?? null,
        pages: document.querySelectorAll("#viewer .page").length,
      }))
      .catch(() => ({ shown: false }));
    expect(asked.invalid).not.toBe("pdfjs-password-invalid");
    expect(asked).toMatchObject({ shown: true, focused: "password", pages: 0 });
  });

  test("password: a wrong one marks the field, empties it, and shows nothing of the document", async ({ context, files }) => {
    const page = await openLocked(context, files);
    await refuse(page);
    const refused = await page
      .evaluate(() => ({
        invalid: document.getElementById("passwordText").getAttribute("data-l10n-id"),
        value: document.getElementById("password").value,
        pages: document.querySelectorAll(".page").length,
      }))
      .catch(() => ({}));
    expect(refused).toEqual({ invalid: "pdfjs-password-invalid", value: "", pages: 0 });
  });

  test("password: the right one opens it, and the field goes away", async ({ context, files }) => {
    const page = await openLocked(context, files);
    await refuse(page);
    await page.fill("#password", PDF_PASSWORD);
    await page.press("#password", "Enter");
    await readerReady(page);
    const opened = await page
      .evaluate(() => ({ shown: document.getElementById("passwordDialog").open, pages: document.querySelectorAll(".page").length, spans: document.querySelectorAll(".textLayer span").length }))
      .catch(() => ({}));
    expect(opened).toMatchObject({ shown: false, pages: 1 });
    expect(opened.spans).toBeGreaterThanOrEqual(9);
  });
});

test.describe("the reader's site switch", () => {
  // The panel's switch turns off the site the PDF came from. The reader's own host is the
  // extension's id, which is no site: no rule may name it, and a local file has no switch.
  const panelSwitch = (p) =>
    p
      .evaluate(() => {
        const sr = document.getElementById("anagram-fab")?.shadowRoot;
        sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return { open: !!sr?.querySelector(".phead"), label: sr?.querySelector(".psiteoff")?.textContent ?? null };
      })
      .catch(() => ({ open: false, label: null }));

  test("reader: Turn off names the PDF's own site, writes the rule there, and stops the reader", async ({ context, extension, files }) => {
    const page = await openPdfInReader(context, files.url("/site-off.pdf"));
    // Counted once the structure worker's answer has re-laid the chips, not in the moment
    // between its rescan taking them down and the cache putting them back.
    await readerRead(page).catch(() => {});
    const before = await pdfChips(page);
    const reader = await readerState(page);
    const offered = await panelSwitch(page);
    await page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".psiteoff")?.click()).catch(() => {});
    // A stopped reader takes its ball down with its chips (lib/render/fab.ts unmount).
    await page.waitForFunction(() => !document.getElementById("anagram-fab"), null, { timeout: 10000 }).catch(() => {});
    const after = await pdfChipCount(page);
    // The rule as soon as the panel's write lands (it is not awaited before the reader stops).
    const written = await extension.sw.evaluate(() => new Promise((resolve) => {
      const read = () => chrome.storage.local.get("siteOverrides", (v) => {
        if (Object.keys(v.siteOverrides ?? {}).length) { chrome.storage.onChanged.removeListener(read); clearTimeout(timer); resolve(v.siteOverrides); }
      });
      const timer = setTimeout(() => { chrome.storage.onChanged.removeListener(read); chrome.storage.local.get("siteOverrides", (v) => resolve(v.siteOverrides ?? {})); }, 10000);
      chrome.storage.onChanged.addListener(read);
      read();
    }));
    const note = JSON.stringify({ before, offered, after, written, reader });
    expect(before, note).toBeGreaterThan(0);
    expect(offered.label, note).toBe("Turn off on localhost");
    expect(after, note).toBe(0);
    expect(written, note).toEqual({ localhost: "off" });
  });

  test("reader: the next PDF from a site turned off opens without being analyzed", async ({ context, extension, files, storage }) => {
    await storage.set({ siteOverrides: { localhost: "off" } });
    const url = files.url("/site-off-next.pdf");
    // No ball comes up on a site turned off, so there is no chip to wait for: the popup is
    // the way in, and it offers the reader once the tab has loaded.
    const next = await visit(context, url);
    await openFromPopup(context, extension, url);
    await next.waitForURL(/reader\.html/, { timeout: 10000 }).catch(() => {});
    await readerRead(next).catch(() => {});
    await next.waitForTimeout(ABSENCE_MS);
    expect(next.url().startsWith(`${READER(extension)}?src=`), next.url().slice(0, 60)).toBe(true);
    expect(await pdfChipCount(next)).toBe(0);
  });

  test("reader: a file from this computer has no site, so its panel offers no switch", async ({ context, extension }) => {
    const local = await context.newPage();
    await local.goto(READER(extension), { waitUntil: "load" });
    await pickerShown(local);
    await local.setInputFiles("#file", { name: "local.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
    await readerRead(local).catch(() => {});
    await pdfChips(local);
    const reader = await readerState(local);
    const localSwitch = await panelSwitch(local);
    expect(localSwitch, JSON.stringify(reader)).toEqual({ open: true, label: null });
  });
});
