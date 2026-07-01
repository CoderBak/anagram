// test/wiki.mjs — load the extension on a real Wikipedia article and capture how it does.
//   node test/wiki.mjs [url]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "output", "chrome-mv3");
const URL = process.argv[2] || "https://en.wikipedia.org/wiki/Alan_Turing";
const BADGE_SEL = '[data-pangram="host"]:not(#pangram-fab)';

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);

const errors = [];
const page = await context.newPage();
page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

console.log("loading", URL);
const t0 = Date.now();
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("goto:", String(e)));
await page.waitForSelector(BADGE_SEL, { timeout: 20000 }).catch(() => console.log("(no badge appeared within 20s)"));
await page.waitForTimeout(3500); // let viewport scoring settle

const stats = await page.evaluate((sel) => {
  const hosts = [...document.querySelectorAll(sel)];
  // v2: no marker attributes on page DOM — a unit's anchor is the badge host's parent.
  const scored = hosts.map((h) => h.parentElement).filter(Boolean);
  const where = { content: 0, infobox: 0, refs: 0, nav: 0, table: 0, other: 0 };
  for (const el of scored) {
    if (el.closest(".infobox")) where.infobox++;
    else if (el.closest(".references, .reflist, ol.references")) where.refs++;
    else if (el.closest("nav, .navbox, .vector-menu, #mw-navigation, .sidebar")) where.nav++;
    else if (el.closest("table")) where.table++;
    else if (el.closest("#mw-content-text, .mw-parser-output")) where.content++;
    else where.other++;
  }
  const tally = {};
  for (const el of scored) tally[el.nodeName] = (tally[el.nodeName] || 0) + 1;
  return {
    badgeCount: hosts.length,
    scoredCount: scored.length,
    tagTally: tally,
    placement: where,
    fab: document.getElementById("pangram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? "?",
    samples: scored.slice(0, 14).map((el) => ({
      tag: el.nodeName,
      loc: el.closest(".infobox") ? "INFOBOX"
         : el.closest(".references, .reflist") ? "REFS"
         : el.closest("nav, .navbox, .vector-menu, #mw-navigation, .sidebar") ? "NAV"
         : el.closest("table") ? "TABLE"
         : el.closest(".mw-parser-output") ? "content" : "other",
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70),
    })),
  };
}, BADGE_SEL);
console.log("\nSTATS:\n" + JSON.stringify(stats, null, 2));
console.log(`load+scan ≈ ${Date.now() - t0} ms`);

await page.screenshot({ path: join(__dirname, "wiki-top.png") });
console.log("saved wiki-top.png");

await page.evaluate(() => window.scrollBy(0, 1500));
await page.waitForTimeout(2500);
await page.screenshot({ path: join(__dirname, "wiki-scrolled.png") });
console.log("saved wiki-scrolled.png");

console.log(errors.length ? "console errors:\n  " + errors.slice(0, 12).join("\n  ") : "no console errors");

await context.close();
process.exit(0);
