// test/e2e.mjs — Playwright end-to-end smoke test for the Pangram MV3 extension.
//
// Loads the built unpacked extension into a persistent Chromium context, serves the
// self-test page over http (so the <all_urls> content script injects), waits for badges,
// verifies the AI-sentence highlights and the floating toggle, exercises dynamic insertion
// and the show/hide toggle, screenshots, and asserts the core behaviours.
//
//   node test/e2e.mjs            # headed (most reliable for MV3 extensions)
//   HEADLESS=1 node test/e2e.mjs # try new-headless
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", ".output", "chrome-mv3");
const SELFTEST = join(__dirname, "selftest.html");
const HEADLESS = process.env.HEADLESS === "1";

// Badge hosts share data-pangram="host" with the FAB host — exclude the FAB by id.
const BADGE_SEL = '[data-pangram="host"]:not(#pangram-fab)';

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error("Built extension not found at", EXT, "- run `npm run build` first.");
  process.exit(2);
}

// 1) tiny static server for the self-contained self-test page.
const html = readFileSync(SELFTEST, "utf8");
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://localhost:${port}/selftest.html`;
console.log("serving self-test at", url);

// 2) launch a persistent context with the unpacked extension loaded.
const launchOpts = {
  headless: HEADLESS,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
};
if (HEADLESS) launchOpts.channel = "chromium";
const context = await chromium.launchPersistentContext("", launchOpts);

// 3) confirm the MV3 background service worker registered.
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
console.log("extension service worker:", sw ? sw.url() : "NOT FOUND");

// 4) open the page; capture content-script console errors.
const consoleErrors = [];
const page = await context.newPage();
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push("console.error: " + m.text());
});
await page.goto(url, { waitUntil: "load" });

// 5) wait for the first badge, then settle.
await page.waitForSelector(BADGE_SEL, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2000);

const visibleBadges = () =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].filter((h) => getComputedStyle(h).display !== "none").length,
    BADGE_SEL,
  );

const snapshot = await page.evaluate((sel) => {
  const scored = [...document.querySelectorAll('[data-pangram="scored"]')];
  const tally = {};
  for (const el of scored) tally[el.nodeName] = (tally[el.nodeName] || 0) + 1;
  return {
    badgeCount: document.querySelectorAll(sel).length,
    fabPresent: !!document.getElementById("pangram-fab"),
    highlightCount: typeof CSS !== "undefined" && CSS.highlights ? CSS.highlights.size : -1,
    highlightedTexts: (() => {
      if (typeof CSS === "undefined" || !CSS.highlights) return [];
      const out = [];
      for (const h of CSS.highlights.values()) for (const r of h) out.push(r.toString());
      return out;
    })(),
    labels: [...document.querySelectorAll(sel)].map(
      (h) => h.shadowRoot?.querySelector(".label")?.textContent || "?",
    ),
    scoredTagTally: tally,
    preScored: scored.some((el) => el.closest("pre") || el.nodeName === "PRE"),
    codeScored: scored.some((el) => el.closest("code")),
    shortScored: scored.some((el) => (el.textContent || "").includes("well under fifty words")),
  };
}, BADGE_SEL);
console.log("\nSNAPSHOT:");
console.log(JSON.stringify(snapshot, null, 2));

// 6) RAPID dynamic insertion — fire N clicks synchronously (identical text each time, the
// real fast-click race). Every added paragraph must get its own badge.
const before = snapshot.badgeCount;
const RAPID = 5;
await page.evaluate((n) => {
  const b = document.getElementById("add");
  for (let i = 0; i < n; i++) b?.click();
}, RAPID);
// The new (tall) paragraphs land below the fold; the extension scores viewport-first by
// design, so scroll them into view to exercise the full add→score→badge path.
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page
  .waitForFunction(
    (target, sel) => document.querySelectorAll(sel).length >= target,
    before + RAPID,
    BADGE_SEL,
    { timeout: 12000 },
  )
  .catch(() => {});
const afterAdd = await page.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL);
console.log(`rapid add: badges ${before} -> ${afterAdd} (clicked ${RAPID})`);

// 7) toggle test: click the FAB → badges hidden → click again → shown.
const clickFab = () =>
  page.evaluate(() => document.getElementById("pangram-fab")?.shadowRoot?.querySelector("button")?.click());
const shownN = await visibleBadges();
await clickFab();
await page.waitForTimeout(300);
const hiddenN = await visibleBadges();
await clickFab();
await page.waitForTimeout(300);
const reshownN = await visibleBadges();
console.log(`toggle: visible ${shownN} -> hidden ${hiddenN} -> visible ${reshownN}`);

// 8) screenshot (overlay shown).
const shot = join(__dirname, "e2e-screenshot.png");
await page.screenshot({ path: shot, fullPage: true });
console.log("screenshot:", shot);

// 9) checks + summary.
const checks = [
  ["extension loaded (service worker)", !!sw],
  ["badges rendered (3 long paragraphs)", snapshot.badgeCount >= 3],
  ["floating toggle present", snapshot.fabPresent],
  ["AI-sentence highlights present", snapshot.highlightCount > 0],
  [
    "underlines span whole sentences (source-newline split not fragmenting)",
    snapshot.highlightedTexts.some((t) => t.trim().length > 40),
  ],
  ["<pre>/<code> NOT scored", !snapshot.preScored && !snapshot.codeScored],
  ["short paragraph (< 50 words) is skipped", !snapshot.shortScored],
  ["rapid insert: every added paragraph badged", afterAdd === before + RAPID],
  ["toggle hides + re-shows badges", hiddenN === 0 && reshownN === shownN && shownN > 0],
  ["no console errors", consoleErrors.length === 0],
];
console.log("\n=== CHECKS ===");
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (consoleErrors.length) {
  console.log("\nconsole errors:");
  for (const e of consoleErrors.slice(0, 20)) console.log("  -", e);
}
const pass = checks.every(([, ok]) => ok);
console.log("\n" + (pass ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED"));

await context.close();
server.close();
process.exit(pass ? 0 : 1);
