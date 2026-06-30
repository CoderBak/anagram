// test/sites.mjs — load the extension across a spread of common sites; capture stats + a
// screenshot per site. Screenshots: test/site-<name>.png
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", ".output", "chrome-mv3");
const BADGE_SEL = '[data-pangram="host"]:not(#pangram-fab)';

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const SITES = [
  ["mdn", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview"],
  ["paulgraham", "https://www.paulgraham.com/greatwork.html"],
  ["hackernews", "https://news.ycombinator.com/"],
  ["github", "https://github.com/nodejs/node"],
  ["bbc", "https://www.bbc.com/news"],
  ["substack", "https://astralcodexten.substack.com/"],
];

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
console.log("extension SW:", sw ? "loaded" : "NOT loaded", "\n");

for (const [name, url] of SITES) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });

  let loaded = true;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    loaded = false;
    console.log(`### ${name}  — GOTO FAILED: ${String(e).slice(0, 80)}`);
  }
  if (loaded) {
    await page.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  const stats = await page.evaluate((sel) => {
    const scored = [...document.querySelectorAll('[data-pangram="scored"]')];
    const hosts = [...document.querySelectorAll(sel)];
    let chrome = 0;
    for (const el of scored) {
      if (el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]")) chrome++;
    }
    return {
      badges: hosts.length,
      chromeBadges: chrome,
      fab: document.getElementById("pangram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? "?",
      samples: scored.slice(0, 6).map((el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 55)),
    };
  }, BADGE_SEL).catch(() => ({ badges: 0, chromeBadges: 0, fab: "?", samples: [] }));

  await page.screenshot({ path: join(__dirname, `site-${name}.png`) }).catch(() => {});

  console.log(`### ${name}  (${url})`);
  console.log(`   badges=${stats.badges}  in-chrome(nav/header/footer/aside)=${stats.chromeBadges}  fab=${stats.fab}  errors=${errors.length}`);
  for (const s of stats.samples) console.log(`     · ${s}`);
  if (errors.length) console.log(`   ERR: ${errors.slice(0, 3).join(" | ")}`);
  console.log("");
  await page.close();
}

await context.close();
process.exit(0);
