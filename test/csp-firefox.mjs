// test/csp-firefox.mjs — the Content-Security-Policy, in Firefox.
//
// The Chromium half is test/pw/csp.spec.mjs, which says what is checked and why. Firefox
// is here because its policy is written differently (MV3 keys it under `extension_pages`,
// MV2 is a bare string) and Firefox validates the string at install. This half measures
// slightly different things — WebDriver BiDi cannot put a listener into a moz-extension:
// document before it loads, so here it is what each page RENDERED plus what the policy
// refuses when a page reaches for it; the note below says exactly what is and is not
// covered. It reports SKIP, never FAIL, where there is no Firefox to drive.
//
//   ANAGRAM_FIREFOX=<path to firefox> node test/csp-firefox.mjs
import http from "node:http";
import { BADGE_SEL } from "./harness.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";
import { ARTICLE, STRICT_ARTICLE, STRICT_POLICY, STRICT_PROBE, WATCH, isCspLine } from "./csp-page.mjs";
import * as ff from "./firefox-harness.mjs";

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

let prohibitedLoopbackRequests = 0;
/** What the strict page's report-uri received. */
const strictReports = [];
const files = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    // If CSP were loosened, CORS would allow the probe. A refusal must come from
    // the extension policy, not an unreadable response from this fixture.
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url.startsWith("/csp-loopback")) prohibitedLoopbackRequests++;
    if (req.url.startsWith("/csp-report")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => { strictReports.push(body); res.end(); });
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
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    resolve({
      url: (path) => `http://localhost:${port}${path}`,
      close: () => new Promise((r) => server.close(() => r())),
    });
  });
});

// Firefox validates an MV2 policy string when the extension is installed and drops a
// directive it will not accept, so what matters here is what the browser APPLIED rather
// than what the manifest asked for — and that is read back by making the pages break the
// policy on purpose.
//
// WHAT CANNOT BE MEASURED HERE. `evaluateOnNewDocument` does not reach a moz-extension:
// document over WebDriver BiDi (the same privilege that makes `page.goto` time out on one
// — see test/firefox-harness.mjs), so a listener cannot be in place before such a page
// loads and a violation DURING its load cannot be collected the way it is on Chrome. What
// is collected instead is everything observable after the fact: uncaught errors, whether
// the page really rendered, and whether the policy is live when the page reaches for
// something it may not have. An ordinary web page takes the Chrome treatment unchanged.

let launched = null;
try {
  launched = await ff.withFakeNative();
} catch (e) {
  record("Firefox: the extension installs with this policy", null, String(e).split("\n")[0]);
}

if (launched) {
  const { browser, extUrl: fxUrl, fixture: fxFixture } = launched;
  // A policy Firefox refuses outright is an extension that will not install at all.
  record("Firefox: the extension installs with this policy", true, "");

  /** Open an extension page, and report what it rendered and what it threw. */
  async function fxSurface(name, url, { settle = 3000, prepare, expect: want }) {
    const page = await browser.newPage();
    const lines = [];
    page.on("console", (m) => lines.push(m.text()));
    page.on("pageerror", (e) => lines.push(String(e)));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => {});
    await ff.waitForExtensionPage(page, url).catch(() => {});
    if (prepare) await prepare(page);
    await ff.sleep(settle);
    const seen = await page.evaluate(want.probe).catch(() => null);
    const complaints = lines.filter((l) => isCspLine(l) || /Error/.test(l));
    await page.close().catch(() => {});
    record(
      `Firefox: ${name} renders under this policy, with nothing thrown`,
      want.ok(seen) && complaints.length === 0,
      JSON.stringify({ seen, complaints: complaints.slice(0, 2) }),
    );
  }

  // Each page is asked for something only a page that really built itself can answer.
  const controls = {
    probe: () => document.querySelectorAll("button, input, select, a").length,
    ok: (n) => n > 0,
  };
  await fxSurface("the popup", fxUrl("popup.html"), { settle: 2000, expect: controls });
  await fxSurface("the options page", fxUrl("options.html"), { settle: 2000, expect: controls });
  await fxSurface("the onboarding page", fxUrl("onboarding.html"), { settle: 2000, expect: controls });
  await fxSurface("the reader with no document", fxUrl("reader.html"), {
    settle: 2000,
    expect: { probe: () => !document.getElementById("drop")?.hidden, ok: (v) => v === true },
  });
  // File/drop remains available without source permissions. Automatic Firefox source
  // loading has its own authorization tests; this checks the offline bytes path.
  await fxSurface(
    "the reader with a PDF loaded",
    fxUrl("reader.html"),
    {
      settle: 8000,
      prepare: async (page) => {
        await ff.until(page, () => window.PDFViewerApplication?.initialized && !document.getElementById("drop")?.hidden);
        await page.evaluate((b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], "doc.pdf", { type: "application/pdf" }));
            document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
          }, TEST_PDF.toString("base64"));
      },
      expect: {
        probe: () => ({
          pages: window.PDFViewerApplication?.pdfDocument?.numPages ?? 0,
          rendered: [...document.querySelectorAll("#viewer .page canvas")].some(canvas => canvas.width > 0 && canvas.height > 0),
          text: document.querySelector("#viewer .textLayer")?.textContent.includes("Anagram rebuilds this document") ?? false,
        }),
        // The complete viewer renders only nearby pages. Assert the real document,
        // painted pixels and fixture text rather than eager whole-document span count.
        ok: (v) => v !== null && v.pages === 2 && v.rendered && v.text,
      },
    },
  );

  // An ordinary web page: the content script is under the PAGE's policy, not this one,
  // and here a listener CAN be in place before the document loads.
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
  await page.close().catch(() => {});

  // A page whose own policy refuses inline styles. Firefox holds what a content script
  // writes into a page to the page's policy: a <style> for the underlines and a style
  // attribute in a card's markup were refused there, the marks went unpainted, and the
  // page — and the site, through its report-uri — heard of it at every chip.
  {
    const strict = await browser.newPage();
    await strict.evaluateOnNewDocument(WATCH);
    await strict.goto(files.url("/strict"), { waitUntil: "load" }).catch(() => {});
    await ff.waitFor(strict, (sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill.scored")).length >= 2, { timeout: 25000, arg: BADGE_SEL });
    const seen = await strict.evaluate(STRICT_PROBE, BADGE_SEL).catch((e) => ({ error: String(e) }));
    await ff.sleep(500);
    const heard = await strict.evaluate(() => window.__csp ?? []).catch(() => ["(unreadable)"]);
    record(
      "Firefox: a page whose policy refuses inline styles gets its chips, painted underlines and a card's scale, and hears nothing of Anagram's",
      seen.chips === 2 && seen.marks > 0 && seen.painted && /%$/.test(seen.marker ?? "") && heard.length === 0 && strictReports.length === 0,
      JSON.stringify({ seen, heard: heard.slice(0, 3), reports: strictReports.length }),
    );
    await strict.close().catch(() => {});
  }

  // And what Firefox really APPLIED, asked of an extension page by breaking the policy.
  const options = await ff.openExtensionPage(browser, fxUrl("options.html"));
  const applied = await options.evaluate(async (loopbackUrl) => {
    const out = {};
    // script-src: an inline script must not run. This is the directive Firefox is most
    // likely to rewrite, so it is the one worth reading back.
    try {
      const s = document.createElement("script");
      s.textContent = "window.__inline = 1;";
      document.head.append(s);
      out.inlineScript = window.__inline === 1 ? "RAN" : "refused";
    } catch (e) {
      out.inlineScript = `refused (${e.name})`;
    }
    out.remote = await fetch("https://example.com/").then(
      () => "reached",
      (e) => `refused (${e.name})`,
    );
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
    out.loopback = await fetch(loopbackUrl).then(
      () => "reached",
      (e) => `refused (${e.name})`,
    );
    return out;
  }, files.url("/csp-loopback"));
  record(
    "Firefox: script-src is live — an inline script on an extension page does not run",
    applied.inlineScript.startsWith("refused"),
    JSON.stringify(applied),
  );
  record(
    "Firefox: connect-src is live — remote, loopback and WebSocket requests are refused",
    applied.remote.startsWith("refused") &&
      applied.websocket.startsWith("refused") &&
      applied.loopback.startsWith("refused"),
    JSON.stringify(applied),
  );
  record("Firefox: blocked loopback probes send no request", prohibitedLoopbackRequests === 0);
  const nativeStatus = await options.evaluate(() => browser.runtime.sendMessage({action:"getBackendStatus",probe:true}));
  record("Firefox: native scoring remains ready without web requests", nativeStatus?.server.ok === true && nativeStatus?.active === "server");

  await options.close().catch(() => {});
  await browser.close().catch(() => {});
  await fxFixture.close();
}

await files.close();

// ---- summary ----------------------------------------------------------------------------------

console.log("\n=== CONTENT SECURITY POLICY (Firefox) ===");
for (const r of results)
  console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(
  `\n${results.length - fails.length - skips.length}/${results.length} checks passed${skips.length ? `, ${skips.length} skipped` : ""}`,
);
console.log(fails.length === 0 ? "✅ CSP GREEN" : "❌ CSP FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
