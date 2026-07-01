// test/zhihu.mjs — diagnose why the extension shows nothing on Zhihu-style feed pages.
// Loads a public Zhihu page (default /explore, the public equivalent of /follow) and dumps,
// for the largest text blocks, exactly why each is or isn't captured: tag, chars, word count
// (via Intl.Segmenter — important for Chinese), whether it sits inside an <a>, and the
// nearest block-tag ancestor the walker can select.
//   node test/zhihu.mjs [url]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "output", "chrome-mv3");
const URL = process.argv[2] || "https://www.zhihu.com/explore";
const BADGE_SEL = '[data-pangram="host"]:not(#pangram-fab)';

if (!existsSync(join(EXT, "manifest.json"))) { console.error("Build first: npm run build"); process.exit(2); }

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);

const errors = [];
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });

console.log("loading", URL);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("goto:", String(e).slice(0, 100)));
await page.waitForTimeout(5000); // SPA: let the feed render + the extension scan

const diag = await page.evaluate((sel) => {
  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
  const words = (s) => (seg ? [...seg.segment(s)].filter((x) => x.isWordLike).length : s.split(/\s+/).filter(Boolean).length);
  const BLOCK = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "OL", "P", "LI", "PRE"]);
  const nearestBlock = (el) => { let e = el; while (e && e !== document.body) { if (BLOCK.has(e.nodeName)) return e.nodeName; e = e.parentElement; } return "(none)"; };

  // Largest visible text blocks on the page.
  const rows = [...document.querySelectorAll("p, li, div, span, blockquote, article, section")]
    .map((el) => ({ el, t: (el.innerText || "").replace(/\s+/g, " ").trim() }))
    .filter((r) => r.t.length > 60)
    .sort((a, b) => b.t.length - a.t.length)
    .slice(0, 10)
    .map((r) => ({
      tag: r.el.nodeName,
      cls: String(r.el.className || "").slice(0, 38),
      chars: r.t.length,
      words: words(r.t),
      inLink: !!r.el.closest("a"),
      nearestBlock: nearestBlock(r.el),
      hasInnerP: !!r.el.querySelector("p"),
      badged: !!(r.el.querySelector('[data-pangram="host"]') || (r.el.closest && [...document.querySelectorAll('[data-pangram="host"]')].some((h) => r.el.contains(h) || h.parentElement?.contains(r.el)))),
      sample: r.t.slice(0, 46),
    }));

  return {
    url: location.href,
    loginWall: !!document.querySelector('.Modal, .SignFlow, [class*="SignFlow"], .Login') || /signin|login/i.test(location.href),
    badges: document.querySelectorAll(sel).length,
    fab: !!document.getElementById("pangram-fab"),
    pTags: document.querySelectorAll("p").length,
    richText: document.querySelectorAll('.RichText, [class*="RichText"]').length,
    topBlocks: rows,
  };
}, BADGE_SEL);

console.log("\nDIAG:");
console.log(JSON.stringify(diag, null, 2));
await page.screenshot({ path: join(__dirname, "zhihu.png") }).catch(() => {});
console.log("\nsaved zhihu.png");
console.log(errors.length ? "console errors:\n  " + errors.slice(0, 8).join("\n  ") : "no console errors");

await context.close();
process.exit(0);
