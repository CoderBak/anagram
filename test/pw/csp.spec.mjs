// The Content-Security-Policy, in Chromium (test/csp-firefox.mjs is the Firefox half).
//
// Ordinary UI pages restrict connections to packaged resources. The isolated PDF loader
// may read an authorized document source. Native inference uses the separate browser
// pipe; its OS privileges are outside this policy. This checks both ways the browser
// policy could be wrong:
//
//   too loose  — the point of the exercise. Ordinary UI pages are made to
//                reach for a remote host, a WebSocket and a beacon, and every one of them
//                has to be refused, including loopback, while native scoring works;
//   too tight  — the way a policy quietly breaks a product. So every surface the extension
//                has is opened for real — popup, options, onboarding, the reader empty and
//                with a PDF in it, and an ordinary web page with the chips on it, which the
//                toolbar menu reports — while `securitypolicyviolation` and the console are listened to, and
//                ANY violation fails.
//
//   npm run test:csp
import { readFileSync } from "node:fs";
import { test as base, expect } from "./fixtures.mjs";
import { EXT, BADGE_SEL, popupOver, menuReport } from "../harness.mjs";
import { TEST_PDF, pdfTabChip } from "../pdf-fixture.mjs";
import { ARTICLE, STRICT_ARTICLE, STRICT_POLICY, STRICT_PROBE, WATCH, isCspLine } from "../csp-page.mjs";

const manifest = () => JSON.parse(readFileSync(`${EXT}/manifest.json`, "utf8"));

const test = base.extend({
  /** The article everywhere, the PDF at /doc.pdf, and a count of the loopback probes that
   *  got through. If CSP were loosened, CORS would allow the probe: a refusal must come
   *  from the extension policy, not from an unreadable response. */
  files: async ({ pages }, use) => {
    const loopback = { requests: 0 };
    const reports = [];
    pages.serve({
      "*": (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (req.url.startsWith("/csp-loopback")) loopback.requests++;
        if (req.url.startsWith("/csp-report")) {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => { reports.push(body); res.end(); });
          return;
        }
        if (req.url.split("?")[0] === "/strict") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": STRICT_POLICY });
          return void res.end(STRICT_ARTICLE);
        }
        if (req.url.split("?")[0] === "/doc.pdf") {
          res.writeHead(200, { "content-type": "application/pdf", "content-length": TEST_PDF.length });
          return void res.end(TEST_PDF);
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(ARTICLE);
      },
    });
    await use({ url: pages.url, loopback, reports });
  },

  /**
   * Open one surface, let it settle, and hand back everything that was refused on it.
   * `prepare` gives a surface what it needs before the settle; `after` drives it after.
   */
  surface: async ({ context }, use) => {
    await use(async (url, { settle = 3000, prepare, after } = {}) => {
      const page = await context.newPage();
      const console_ = [];
      page.on("console", (m) => console_.push(m.text()));
      page.on("pageerror", (e) => console_.push(String(e)));
      await page.addInitScript(WATCH);
      await page.goto(url, { waitUntil: "load" }).catch(() => {});
      if (prepare) await prepare(page);
      // Nothing signals a refusal that does not come: the settle is how long it is given.
      await page.waitForTimeout(settle);
      const extra = after ? await after(page) : null;
      const violations = await page.evaluate(() => window.__csp ?? []).catch(() => []);
      await page.close();
      return { refused: [...violations, ...console_.filter(isCspLine)], extra };
    });
  },

  /** An extension page to reach out from, with the refusals it collects. */
  driver: async ({ context, extension }, use) => {
    const driver = await context.newPage();
    await driver.addInitScript(WATCH);
    await driver.goto(extension.url("options.html"), { waitUntil: "load" });
    await use(driver);
  },
});

const fromPage = (driver, url) => driver.evaluate((u) => fetch(u).then(() => "reached", (e) => `refused (${e.name})`), url);

test("the built manifest declares a policy for its own pages", () => {
  const csp = manifest().content_security_policy?.extension_pages ?? "";
  expect(csp).not.toBe("");
});

for (const [name, path] of [["the popup", "popup.html"], ["the options page", "options.html"], ["the onboarding page", "onboarding.html"], ["the reader with no document", "reader.html"]]) {
  test(`${name} loads with nothing refused`, async ({ surface, extension }) => {
    const { refused } = await surface(extension.url(path), { settle: 2000 });
    expect(refused).toEqual([]);
  });
}

// THE WHOLE HANDOFF, under the policy: the tab shows the PDF, the page's Analyze PDF in the
// toolbar menu hands it to the worker, and the tab becomes the reading mode. The re-read the content script makes is
// governed by the PAGE's policy and not this one — which is the point of doing it there —
// so this is where a `connect-src` that broke the reading mode would show itself.
test("the reader with a PDF loaded loads with nothing refused, and really drew its pages, its text layer and its chips", async ({ surface, files }) => {
  const { refused, extra: reader } = await surface(files.url("/doc.pdf"), {
    settle: 6000,
    prepare: async (page) => {
      await pdfTabChip(page, { timeout: 20000, click: true });
      await page.waitForURL(/reader\.html/, { timeout: 20000 }).catch(() => {});
    },
    after: (page) =>
      page
        .evaluate(() => ({
          pages: window.PDFViewerApplication?.pdfDocument?.numPages ?? 0,
          rendered: [...document.querySelectorAll("#viewer .page canvas")].some((canvas) => canvas.width > 0 && canvas.height > 0),
          text: document.querySelector("#viewer .textLayer")?.textContent.includes("Anagram rebuilds this document") ?? false,
          chips: [...document.querySelectorAll('.anagramPdfChips [data-anagram="host"]')].filter((host) => host.shadowRoot?.querySelector(".pill")).length,
        }))
        .catch(() => ({ pages: 0, rendered: false, text: false, chips: 0 })),
  });
  expect.soft(refused).toEqual([]);
  expect(reader, JSON.stringify(reader)).toMatchObject({ pages: 2, rendered: true, text: true });
  expect(reader.chips).toBeGreaterThan(0);
});

test("an ordinary web page with the chips loads with nothing refused, really got them, and the toolbar menu reports them", async ({ surface, files }) => {
  const { refused, extra: state } = await surface(files.url("/a"), {
    settle: 6000,
    after: async (page) => {
      const chips = await page.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL).catch(() => 0);
      const menu = await popupOver(page);
      const report = await expect.poll(() => menuReport(menu), { timeout: 10000 }).not.toBeNull().then(() => true, () => false);
      await menu.close();
      return { chips, report };
    },
  });
  expect.soft(refused).toEqual([]);
  expect(state.chips, JSON.stringify(state)).toBeGreaterThan(0);
  expect(state.report, JSON.stringify(state)).toBe(true);
});

// The PAGE's own policy, refusing every inline style (test/csp-page.mjs STRICT_POLICY): what
// Anagram draws into a page must draw anyway, and leave the page and its report-uri nothing to
// hear. Chromium never held a content script to it; Firefox did (test/csp-firefox.mjs).
test("a page whose own policy refuses inline styles gets its chips, painted underlines and a card's scale, and hears nothing of Anagram's", async ({ surface, files }) => {
  const { refused, extra: seen } = await surface(files.url("/strict"), {
    settle: 1000,
    prepare: (page) => page.waitForFunction((sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill.scored")).length >= 2, BADGE_SEL, { timeout: 20000 }).catch(() => {}),
    after: (page) => page.evaluate(STRICT_PROBE, BADGE_SEL),
  });
  expect.soft(refused).toEqual([]);
  expect.soft(files.reports, "nothing reaches the page's report-uri").toEqual([]);
  expect(seen, JSON.stringify(seen)).toMatchObject({ chips: 2, painted: true, marker: expect.stringMatching(/%$/) });
  expect(seen.marks, JSON.stringify(seen)).toBeGreaterThan(0);
});

// ---- what connect-src actually permits ------------------------------------------------------
//
// The policy is only worth having if it refuses things, so this asks for them. An extension
// page has a stricter meta policy than the private source loader.

test("an extension page cannot fetch loopback, by name or by number, and no request goes out", async ({ driver, files }) => {
  const local = files.url("/csp-loopback");
  expect(await fromPage(driver, local)).toMatch(/^refused/);
  expect(await fromPage(driver, local.replace("localhost", "127.0.0.1")), "numeric loopback is also blocked").toMatch(/^refused/);
  expect(files.loopback.requests, "blocked loopback probes send no request").toBe(0);
});

test("native scoring remains ready without web requests", async ({ driver }) => {
  const status = await driver.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
  expect(status?.server.ok).toBe(true);
  expect(status?.active).toBe("server");
});

test("ordinary UI pages cannot connect to remote hosts, nor fetch an arbitrary PDF source", async ({ driver }) => {
  const remote = {
    "an extension page → https://arxiv.org": await fromPage(driver, "https://arxiv.org/html/2402.17764"),
    "an extension page → https://example.com": await fromPage(driver, "https://example.com/"),
    "an extension page → http://example.com": await fromPage(driver, "http://example.com/"),
  };
  expect(Object.values(remote).every((r) => r.startsWith("refused")), JSON.stringify(remote)).toBe(true);
  // The full viewer cannot fetch an arbitrary source itself. Authorized file/Firefox
  // source reads go through the separate private loader and its one-use broker ticket,
  // which the PDF loader tests cover.
  expect(await fromPage(driver, "https://example.com/paper.pdf"), "ordinary UI cannot fetch an arbitrary PDF source").toMatch(/^refused/);
});

test("WebSocket, sendBeacon, EventSource and XHR are refused the same way fetch is", async ({ driver }) => {
  const other = await driver.evaluate(async () => {
    const out = {};
    out.websocket = await new Promise((res) => {
      try {
        const ws = new WebSocket("wss://example.com/socket");
        ws.onerror = () => res("refused");
        ws.onopen = () => res("OPENED");
        setTimeout(() => res("refused (no answer)"), 2500);
      } catch (e) {
        res(`refused (${e.name})`);
      }
    });
    // sendBeacon answers `true` for "queued" before the policy is consulted, so the
    // violation event is what says whether anything really went out.
    const before = window.__csp.length;
    navigator.sendBeacon("https://example.com/beacon", "x");
    await new Promise((r) => setTimeout(r, 300));
    out.beacon = window.__csp.length > before ? "refused" : "SENT";
    out.eventSource = await new Promise((res) => {
      try {
        const es = new EventSource("https://example.com/stream");
        es.onerror = () => res("refused");
        es.onopen = () => res("OPENED");
        setTimeout(() => res("refused (no answer)"), 2000);
      } catch (e) {
        res(`refused (${e.name})`);
      }
    });
    out.xhr = await new Promise((res) => {
      const x = new XMLHttpRequest();
      x.onerror = () => res("refused");
      x.onload = () => res("OPENED");
      try {
        x.open("GET", "https://example.com/x");
        x.send();
      } catch (e) {
        res(`refused (${e.name})`);
      }
      setTimeout(() => res("refused (no answer)"), 2000);
    });
    return out;
  });
  expect(Object.values(other).every((r) => r.startsWith("refused")), JSON.stringify(other)).toBe(true);
});

// web_accessible_resources, asked from where it matters: an ordinary web page. Until
// 2026-09-20 `vendor/*` was declared for <all_urls>, which handed every site three
// megabytes of the reader's pdf.js, CMaps, fonts and decoders — and handed any site that
// cared a reliable way to tell that this extension is installed. What is declared now is
// the four chunks a content script import()s, at a per-session address Chrome gives only
// to that content script, so not even those answer a page that guesses the extension id.
//
// That they still load for the content script is not measured here but next door:
// test/pw/diagnostics.spec.mjs loads the diagnostics chunk, the surface scenarios the
// surfaces chunk (test/pw/scenarios-surfaces.spec.mjs), and DOMPurify goes through the same
// lib/lazy.ts call as all of them.
test("a web page can load nothing of this extension, the lazy chunks included", async ({ context, extension, files }) => {
  const declared = manifest().web_accessible_resources;
  const web = await context.newPage();
  await web.goto(files.url("/a"), { waitUntil: "load" }).catch(() => {});
  const reachable = await web
    .evaluate(
      async ([id, paths]) => {
        const out = [];
        for (const p of paths) {
          const ok = await fetch(`chrome-extension://${id}/${p}`).then((r) => r.ok, () => false);
          if (ok) out.push(p);
        }
        return out;
      },
      [extension.extId, [...declared[0].resources, "vendor/pdfjs.min.mjs", "vendor/pdf.worker.mjs", "vendor/wasm/openjpeg.wasm", "reader.html", "manifest.json"]],
    )
    .catch((e) => [`(could not ask: ${e})`]);
  expect(reachable, JSON.stringify({ declared })).toEqual([]);
});
