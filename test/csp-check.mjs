// test/csp-check.mjs — the Content-Security-Policy, in both browsers.
//
// wxt.config.ts declares a policy that is meant to make "this extension cannot reach the
// internet" a thing the BROWSER enforces rather than a thing the README says. A policy
// like that has two ways to be wrong, and this checks for both:
//
//   too loose  — the point of the exercise. So a page and the service worker are made to
//                reach for a remote host, a WebSocket and a beacon, and every one of them
//                has to be refused, while the loopback daemon still answers;
//   too tight  — the way a policy quietly breaks a product. So every surface the extension
//                has is opened for real — popup, options, onboarding, the reader empty and
//                with a PDF in it, and an ordinary web page with the chips and the panel on
//                it — while `securitypolicyviolation` and the console are listened to, and
//                ANY violation fails.
//
// Both browsers, because their policies are written differently (MV3 keys it under
// `extension_pages`, MV2 is a bare string) and Firefox validates the string at install.
// The Firefox half reports SKIP, never FAIL, where there is no Firefox to drive.
//
//   node test/csp-check.mjs
//   node test/csp-check.mjs --chrome-only
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withFakeDaemon, requireBuild, EXT, BADGE_SEL } from "./harness.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";
import * as ff from "./firefox-harness.mjs";

requireBuild();

const CHROME_ONLY = process.argv.includes("--chrome-only");
const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

/** A page with enough prose for the pipeline to chip and the panel to list. */
const PARA =
  "A language model trained on ordinary prose will produce sentences that read as though " +
  "somebody wrote them on purpose, and the whole question this extension asks of a paragraph " +
  "is how far the writing has moved away from that, measured against text that nobody edited " +
  "at all, which is what the local daemon on this computer was trained to answer for any " +
  "paragraph of this length or longer.";
const ARTICLE =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>An article</title></head>` +
  `<body><article><h1>An article</h1>${[1, 2, 3, 4]
    .map((n) => `<p>${PARA} This is paragraph number ${n} of it.</p>`)
    .join("")}</article></body></html>`;

const files = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] === "/doc.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": TEST_PDF.length });
      return void res.end(TEST_PDF);
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(ARTICLE);
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    resolve({
      url: (path) => `http://localhost:${port}${path}`,
      close: () => new Promise((r) => server.close(() => r())),
    });
  });
});

/** Runs in every page before its own scripts do: collect refusals as they happen. */
const WATCH = () => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__csp.push(`${e.violatedDirective} → ${e.blockedURI || "inline"}`),
  );
};

/** A console line that is the browser complaining about this policy. */
const isCspLine = (text) =>
  /Content Security Policy|Refused to (connect|load|execute|apply)|violates the following Content Security/i.test(
    text,
  );

// ---- what the two manifests say -------------------------------------------------------------

const chromeCsp =
  JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).content_security_policy
    ?.extension_pages ?? "";
record("Chrome: the built manifest declares a policy for its own pages", chromeCsp !== "", chromeCsp);

// ---- Chrome ---------------------------------------------------------------------------------

const { daemon, context, sw, extId } = await withFakeDaemon();
const extUrl = (path) => `chrome-extension://${extId}/${path}`;

/**
 * Open one surface, let it settle, and hand back everything that was refused on it.
 * `after` is where a surface that needs driving (the panel) is driven.
 */
async function surface(name, url, { settle = 3000, after } = {}) {
  const page = await context.newPage();
  const console_ = [];
  page.on("console", (m) => console_.push(m.text()));
  page.on("pageerror", (e) => console_.push(String(e)));
  await page.addInitScript(WATCH);
  await page.goto(url, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(settle);
  const extra = after ? await after(page) : "";
  const violations = await page.evaluate(() => window.__csp ?? []).catch(() => []);
  const complaints = console_.filter(isCspLine);
  await page.close();
  record(
    `Chrome: ${name} loads with nothing refused`,
    violations.length === 0 && complaints.length === 0,
    JSON.stringify([...violations, ...complaints].slice(0, 3)),
  );
  return extra;
}

await surface("the popup", extUrl("popup.html"), { settle: 2000 });
await surface("the options page", extUrl("options.html"), { settle: 2000 });
await surface("the onboarding page", extUrl("onboarding.html"), { settle: 2000 });
await surface("the reader with no document", extUrl("reader.html"), { settle: 2000 });

const readerState = await surface(
  "the reader with a PDF loaded",
  `${extUrl("reader.html")}?src=${encodeURIComponent(files.url("/doc.pdf"))}`,
  {
    settle: 6000,
    after: (page) =>
      page
        .evaluate((sel) => ({
          pages: document.querySelectorAll(".page").length,
          spans: document.querySelectorAll(".textLayer span").length,
          chips: document.querySelectorAll(sel).length,
        }), BADGE_SEL)
        .catch(() => ({ pages: 0, spans: 0, chips: 0 })),
  },
);
record(
  "Chrome: and that reader really drew its pages, its text layer and its chips",
  readerState.pages === 2 && readerState.spans >= 29 && readerState.chips > 0,
  JSON.stringify(readerState),
);

const pageState = await surface("an ordinary web page with the chips and the panel", files.url("/a"), {
  settle: 6000,
  after: async (page) => {
    await page
      .evaluate(() =>
        document
          .getElementById("anagram-fab")
          ?.shadowRoot?.querySelector(".count")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      )
      .catch(() => {});
    await page.waitForTimeout(1200);
    return page
      .evaluate((sel) => ({
        chips: document.querySelectorAll(sel).length,
        panel:
          document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".panel")?.classList
            .contains("open") ?? false,
      }), BADGE_SEL)
      .catch(() => ({ chips: 0, panel: false }));
  },
});
record(
  "Chrome: and that page really got its chips and opened its panel",
  pageState.chips > 0 && pageState.panel,
  JSON.stringify(pageState),
);

// ---- Chrome: what connect-src actually permits ------------------------------------------------
//
// The policy is only worth having if it refuses things, so this asks for them. An extension
// page and the service worker are the two places that could talk to the world.

const driver = await context.newPage();
await driver.addInitScript(WATCH);
await driver.goto(extUrl("options.html"), { waitUntil: "load" });

const fromPage = (url) =>
  driver.evaluate(
    (u) => fetch(u).then(() => "reached", (e) => `refused (${e.name})`),
    url,
  );
const fromWorker = (url) =>
  sw.evaluate((u) => fetch(u).then(() => "reached", (e) => `refused (${e.name})`), url);

record(
  "Chrome: an extension page still reaches the local daemon",
  (await fromPage(`${daemon.url}/health`)) === "reached",
  daemon.url,
);
record(
  "Chrome: the service worker still reaches the local daemon",
  (await fromWorker(`${daemon.url}/health`)) === "reached",
  daemon.url,
);

const remote = {
  "an extension page → https://arxiv.org": await fromPage("https://arxiv.org/html/2402.17764"),
  "an extension page → https://example.com": await fromPage("https://example.com/"),
  "the service worker → https://example.com": await fromWorker("https://example.com/"),
  "the service worker → http://example.com": await fromWorker("http://example.com/"),
};
record(
  "Chrome: neither a page nor the worker can reach ANY remote host",
  Object.values(remote).every((r) => r.startsWith("refused")),
  JSON.stringify(remote),
);

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
record(
  "Chrome: WebSocket, sendBeacon, EventSource and XHR are refused the same way fetch is",
  Object.values(other).every((r) => r.startsWith("refused")),
  JSON.stringify(other),
);

/**
 * THE ONE THING THIS POLICY COSTS, stated so it cannot be discovered by surprise: the
 * reader page can no longer fetch a PDF from the site it is on. That is the intended
 * consequence — a remote origin is a remote origin, whoever asks — and it is why the bytes
 * of a PDF being read have to be handed over by the tab that already has them rather than
 * fetched again. `file:` is allowed, so a PDF on this computer still opens by itself.
 */
record(
  "Chrome: the reader cannot re-fetch a PDF from a remote origin (the bytes must come from the tab)",
  (await fromPage("https://example.com/paper.pdf")).startsWith("refused"),
  "intended: see docs/footprint.md",
);

// web_accessible_resources, asked from where it matters: an ordinary web page. Until
// 2026-09-20 `vendor/*` was declared for <all_urls>, which handed every site three
// megabytes of the reader's pdf.js, CMaps, fonts and decoders — and handed any site that
// cared a reliable way to tell that this extension is installed. What is declared now is
// the three chunks a content script import()s, at a per-session address Chrome gives only
// to that content script, so not even those answer a page that guesses the extension id.
//
// That they still load for the content script is not measured here but next door:
// test/diagnostics-check.mjs loads the diagnostics chunk, the main-content scenarios load
// Readability, and DOMPurify goes through the same lib/lazy.ts call as both.
const narrow = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).web_accessible_resources;
{
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
      [
        extId,
        [
          ...narrow[0].resources,
          "vendor/pdfjs.min.mjs",
          "vendor/pdf.worker.mjs",
          "vendor/wasm/openjpeg.wasm",
          "reader.html",
          "manifest.json",
        ],
      ],
    )
    .catch((e) => [`(could not ask: ${e})`]);
  record(
    "Chrome: a web page can load nothing of this extension, the lazy chunks included",
    reachable.length === 0,
    JSON.stringify({ reachable, declared: narrow }),
  );
  await web.close();
}

await context.close();
await daemon.close();

// ---- Firefox ---------------------------------------------------------------------------------
//
// Firefox validates an MV2 policy string when the extension is installed and simply drops
// a directive it does not accept, so "the pages load with nothing refused" is only half
// the answer here: what the browser really applied is read back as well.

if (!CHROME_ONLY) {
  let launched = null;
  try {
    launched = await ff.withFakeDaemon();
  } catch (e) {
    record("Firefox: the extension installs with this policy", null, String(e).split("\n")[0]);
  }

  if (launched) {
    const { browser, extUrl: fxUrl, daemon: fxDaemon } = launched;
    record("Firefox: the extension installs with this policy", true, "");

    async function fxSurface(name, url, settle = 3000) {
      const page = await browser.newPage();
      const lines = [];
      page.on("console", (m) => lines.push(m.text()));
      page.on("pageerror", (e) => lines.push(String(e)));
      await page.evaluateOnNewDocument(WATCH);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => {});
      await ff.waitForExtensionPage(page, url).catch(() => {});
      await ff.sleep(settle);
      const violations = await page.evaluate(() => window.__csp ?? []).catch(() => []);
      const complaints = lines.filter(isCspLine);
      await page.close().catch(() => {});
      record(
        `Firefox: ${name} loads with nothing refused`,
        violations.length === 0 && complaints.length === 0,
        JSON.stringify([...violations, ...complaints].slice(0, 3)),
      );
    }

    await fxSurface("the popup", fxUrl("popup.html"), 2000);
    await fxSurface("the options page", fxUrl("options.html"), 2000);
    await fxSurface("the onboarding page", fxUrl("onboarding.html"), 2000);
    await fxSurface("the reader with no document", fxUrl("reader.html"), 2000);
    await fxSurface(
      "the reader with a PDF loaded",
      `${fxUrl("reader.html")}?src=${encodeURIComponent(files.url("/doc.pdf"))}`,
      7000,
    );

    // An ordinary page, with the chips and the panel. The content script is not under the
    // extension's policy at all — it is under the PAGE's — so this is the half that would
    // catch a policy written as if it were.
    const page = await browser.newPage();
    const lines = [];
    page.on("console", (m) => lines.push(m.text()));
    await page.evaluateOnNewDocument(WATCH);
    await page.goto(files.url("/a"), { waitUntil: "domcontentloaded" }).catch(() => {});
    const chipped = await ff.waitFor(page, (sel) => document.querySelectorAll(sel).length > 0, {
      timeout: 25000,
      arg: BADGE_SEL,
    });
    const violations = await page.evaluate(() => window.__csp ?? []).catch(() => []);
    record(
      "Firefox: an ordinary web page gets its chips with nothing refused",
      chipped && violations.length === 0 && lines.filter(isCspLine).length === 0,
      JSON.stringify({ chipped, violations: violations.slice(0, 3) }),
    );

    // What Firefox APPLIED, not what the manifest asked for: an extension page is made to
    // reach for a remote host, exactly as on Chrome.
    const options = await browser.newPage();
    await options.evaluateOnNewDocument(WATCH);
    await options
      .goto(fxUrl("options.html"), { waitUntil: "domcontentloaded", timeout: 2500 })
      .catch(() => {});
    await ff.waitForExtensionPage(options, fxUrl("options.html"));
    const fxReach = await options.evaluate(async () => ({
      remote: await fetch("https://example.com/").then(() => "reached", (e) => `refused (${e.name})`),
    }));
    const fxLoopback = await options.evaluate(
      (u) => fetch(`${u}/health`).then(() => "reached", (e) => `refused (${e.name})`),
      fxDaemon.url,
    );
    // …and it was the POLICY that refused it, not a server that happened not to answer:
    // the page's own violation events name the directive that stopped it.
    const fxWhy = await options.evaluate(() => window.__csp ?? []).catch(() => []);
    record(
      "Firefox: a remote host is refused by connect-src while the local daemon still answers",
      fxReach.remote.startsWith("refused") &&
        fxLoopback === "reached" &&
        fxWhy.some((v) => v.startsWith("connect-src")),
      JSON.stringify({ ...fxReach, loopback: fxLoopback, why: fxWhy.slice(0, 2) }),
    );

    await options.close().catch(() => {});
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await fxDaemon.close();
  }
}

await files.close();

// ---- summary ----------------------------------------------------------------------------------

console.log("\n=== CONTENT SECURITY POLICY ===");
for (const r of results)
  console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(
  `\n${results.length - fails.length - skips.length}/${results.length} checks passed${skips.length ? `, ${skips.length} skipped` : ""}`,
);
console.log(fails.length === 0 ? "✅ CSP GREEN" : "❌ CSP FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
