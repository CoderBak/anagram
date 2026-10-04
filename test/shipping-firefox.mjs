// test/shipping-firefox.mjs — a web page as the SHIPPING Firefox build meets it.
//
// The Chromium half is test/pw/shipping-page.spec.mjs. Everything else in Firefox runs the
// test build (test/test-build.mjs), whose chips stay open for the suites to read; this one
// installs the build `npm run build:firefox` makes, with this machine's own name granted as a
// person grants a site — http://localhost/*, nothing else — and asks what a page can learn
// of Anagram there, where Firefox differs from Chromium:
//
//   * the chips are closed shadow trees (lib/render/shadowMode.ts): drawn, closed to the
//     page, and each one saying its verdict, which only an extension can see —
//     Element.openOrClosedShadowRoot, in a script run by tabs.executeScript;
//   * no content script announces itself (WXT's "content-script-started", lib/quietContext.ts);
//   * the moz-extension address names this very installation, so the page can load no icon
//     from it even knowing it;
//   * a frame of the granted site in a page of one not granted: Firefox leaves the page's
//     address off the message (sender.tab.url), and the frame's verdicts must still not be
//     shared with the same frame in another site's page (partitionOf in
//     entrypoints/background.ts). 127.0.0.1 and [::1] stand in for two sites not granted.
//
//   npm run build:firefox && ANAGRAM_FIREFOX=<path to firefox> node test/shipping-firefox.mjs
import http from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ff from "./firefox-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = join(ROOT, "output", "firefox-mv2");
if (!existsSync(join(SHIPPED, "manifest.json"))) {
  console.error("no shipping Firefox build: npm run build:firefox");
  process.exit(2);
}

const results = [];
const record = (name, ok, note = "") => results.push({ name, status: ok ? "PASS" : "FAIL", note: String(note) });

const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
/** A paragraph over the floor, its words set by `i` so that no two are alike. */
const para = (tag, i = 0) => `${tag}-${i} ` + Array.from({ length: 84 }, (_, k) => VOCAB[(i * 7 + k * 13) % VOCAB.length]).join(" ") + ".";
const html = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">${body}</body></html>`;

// What the page hears from the very start: any message, and WXT's announcement by its names.
const LISTEN = `<script>
  window.__heard = [];
  addEventListener("message", (e) => window.__heard.push("message " + JSON.stringify(e.data).slice(0, 120)));
  for (const entry of ["content", "shadow", "shadowPort"]) {
    document.addEventListener("${ff.GECKO_ID}:" + entry + ":wxt:content-script-started", () => window.__heard.push(entry));
  }
</script>`;
const PAGES = {
  "/shipped.html": html("shipped", LISTEN + [0, 1, 2].map((i) => `<p>${para("SHIPPED", i)}</p>`).join("\n")),
  "/inner.html": html("a granted frame", `<p>${para("PARTITIONED", 9)}</p>`),
};
const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  // The page around the frame, on whichever name it was asked by.
  const body = path === "/top.html" ? html("a page not granted", `<p>${para("TOPNOTGRANTED", 8)}</p><iframe src="${base("localhost")}/inner.html" width="720" height="420"></iframe>`) : PAGES[path];
  if (!body) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
// Both stacks: localhost, 127.0.0.1 and [::1] all reach it.
await new Promise((resolve) => server.listen(0, "::", resolve));
const base = (host) => `http://${host}:${server.address().port}`;

const staging = mkdtempSync(join(tmpdir(), "anagram-firefox-shipping-"));
const extension = join(staging, "extension");
cpSync(SHIPPED, extension, { recursive: true });
const manifestPath = join(extension, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// This machine's name granted, as a person grants a site; Native Messaging as picking the
// local engine grants it. Nothing else differs from what ships.
manifest.permissions.push("http://localhost/*", "nativeMessaging");
writeFileSync(manifestPath, JSON.stringify(manifest));

const { browser, extUrl, fixture } = await ff.launchFirefox({ extDir: extension }).catch((e) => {
  console.error(e.message ?? e);
  server.close();
  process.exit(2);
});
try {
  const driver = await ff.openExtensionPage(browser, extUrl("options.html"));
  // The grant is registered at run time (lib/access/worker.ts); a page opened before that
  // would get no content script.
  await ff.until(driver, async () => (await browser.scripting.getRegisteredContentScripts()).some((s) => s.id === "anagram-content"), { timeout: 15000 });
  // Every message the background is sent to score a text, with what Firefox says of its tab.
  await driver.evaluate(async () => {
    const bg = await browser.runtime.getBackgroundPage();
    bg.__senders = [];
    bg.browser.runtime.onMessage.addListener((message, sender) => {
      if (message?.action === "scoreBatch") bg.__senders.push({ url: sender.url, tabUrl: sender.tab?.url ?? null });
    });
  });

  // ---- closed chips ------------------------------------------------------------------------
  const page = await browser.newPage();
  await page.goto(`${base("localhost")}/shipped.html`, { waitUntil: "load" });
  await ff.waitFor(page, (sel) => [...document.querySelectorAll(sel)].filter((h) => h.getBoundingClientRect().width > 0).length >= 3, { timeout: 20000, arg: ff.BADGE_SEL });
  const hosts = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((h) => ({ open: h.shadowRoot !== null, drawn: h.getBoundingClientRect().width > 0, text: h.textContent })), ff.BADGE_SEL);
  record(
    "as shipped, a page sees that chips are there and nothing of what they say: drawn, their shadow roots closed, no text on their hosts",
    hosts.length === 3 && hosts.every((h) => h.drawn && !h.open && h.text === ""),
    JSON.stringify(hosts),
  );
  // Inside, where only an extension reaches: every chip says its verdict, drawn without
  // ever reading host.shadowRoot (rootOf in lib/render/badge.ts).
  const inside = async () =>
    driver.evaluate(async (url) => {
      const tab = (await browser.tabs.query({})).find((t) => t.url === url);
      const [chips] = await browser.tabs.executeScript(tab.id, {
        code: `[...document.querySelectorAll('[data-anagram="host"]')].map((h) => { const r = h.openOrClosedShadowRoot; return { mode: r?.mode ?? null, pill: r?.querySelector(".pill")?.className ?? "", num: r?.querySelector(".num")?.textContent ?? "" }; })`,
      });
      return chips;
    }, `${base("localhost")}/shipped.html`).catch((e) => [{ error: String(e).slice(0, 200) }]);
  let chips = [];
  for (const deadline = Date.now() + 20000; Date.now() < deadline; await ff.sleep(250)) {
    chips = await inside();
    if (chips.length === 3 && chips.every((c) => /\bscored\b/.test(c.pill))) break;
  }
  record(
    "every closed chip says its verdict (seen through openOrClosedShadowRoot, as only an extension can)",
    chips.length === 3 && chips.every((c) => c.mode === "closed" && /\bscored\b/.test(c.pill) && /^(\.\d\d|1\.0)$/.test(c.num)),
    JSON.stringify(chips),
  );
  const heard = await page.evaluate(() => window.__heard);
  record("the page hears no content script start: no WXT announcement, no message", heard.length === 0, JSON.stringify(heard));

  // ---- no icon is web accessible -----------------------------------------------------------
  // The page is told the installation's address here (the suite seeds it): a page that has
  // it can load what is web accessible, as the control shows, and must find no icon there.
  const reach = await page.evaluate(async (origin) => {
    const load = (path) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve("loaded");
      img.onerror = () => resolve("refused");
      img.src = `${origin}/${path}`;
    });
    const fetched = (path) => fetch(`${origin}/${path}`).then((r) => (r.ok ? "loaded" : `status ${r.status}`), () => "refused");
    return { icon: await load("icons/icon-48.png"), iconFetch: await fetched("icons/icon-48.png"), chunk: await fetched("vendor/purify.min.mjs") };
  }, `moz-extension://${ff.EXT_UUID}`);
  record(
    "no icon is web accessible: a page that knows the installation's address loads none (a web-accessible chunk, the control, loads)",
    reach.icon === "refused" && reach.iconFetch === "refused" && reach.chunk === "loaded",
    JSON.stringify(reach),
  );
  await page.close();

  // ---- a granted frame in two pages not granted --------------------------------------------
  /** The frame at `top`'s chips, once its paragraph has a verdict. */
  const visit = async (host) => {
    const top = await browser.newPage();
    await top.goto(`${base(host)}/top.html`, { waitUntil: "load" });
    let scored = false;
    for (const deadline = Date.now() + 20000; !scored && Date.now() < deadline; await ff.sleep(250)) {
      const frame = top.frames().find((f) => f.url().includes("/inner.html"));
      scored = !!(await frame?.evaluate(() => document.querySelector('[data-anagram="host"]')?.getBoundingClientRect().width > 0).catch(() => false));
    }
    await top.close();
    return scored;
  };
  const mark = fixture.textMark();
  const first = await visit("127.0.0.1");
  const second = await visit("[::1]");
  const sent = fixture.textsSince(mark).filter((t) => t.includes("PARTITIONED-9")).length;
  const senders = (await driver.evaluate(async () => (await browser.runtime.getBackgroundPage()).__senders)).filter((s) => s.url?.includes("/inner.html"));
  record(
    "a frame of a granted site in the pages of two sites not granted: Firefox gives no page address, and the frame's verdict is not shared between them",
    first && second && senders.length > 0 && senders.every((s) => s.tabUrl === null) && sent === 2,
    JSON.stringify({ first, second, sent, senders }),
  );
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(staging, { recursive: true, force: true });
}

console.log("\n=== AS SHIPPED (Firefox) ===");
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
console.log(fails.length === 0 ? "✅ SHIPPING GREEN" : "❌ SHIPPING FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
