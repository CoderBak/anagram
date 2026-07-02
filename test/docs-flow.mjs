// test/docs-flow.mjs — verify the Google Docs editor ⇄ mobilebasic reading-view flow
// on a real public document.
//   node test/docs-flow.mjs [docUrlBase]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "output", "chrome-mv3");
const BADGE_SEL = '[data-pangram="host"]:not(#pangram-fab)';
const DOC =
  process.argv[2] ??
  "https://docs.google.com/document/d/1gRLkVx985SLnysZvrkm8PQolykP-rRWxBtxFoywXXRo";

const context = await chromium.launchPersistentContext("", {
  headless: false, viewport: { width: 1280, height: 850 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  const u = m.location()?.url ?? "";
  // chrome-extension://invalid/ is GOOGLE's own extension-detection probe, not us.
  if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid"))
    errors.push(m.text().slice(0, 140));
});

// 1) editor page (no login — public doc)
await page.goto(`${DOC}/edit?usp=sharing`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(6000); // editor bootstraps slowly
const editorState = await page.evaluate(() => {
  const fab = document.getElementById("pangram-fab");
  const action = fab?.shadowRoot?.querySelector("#pangram-action");
  return {
    url: location.href.slice(0, 100),
    fab: !!fab,
    actionShown: action ? getComputedStyle(action).display !== "none" : false,
    actionLabel: action?.textContent ?? null,
    hasCanvas: !!document.querySelector("canvas"),
  };
});
console.log("EDITOR:", JSON.stringify(editorState, null, 2));
await page.screenshot({ path: join(__dirname, "docs-editor.png") });

// 2) click "Open reading view"
await page.evaluate(() => {
  document.getElementById("pangram-fab")?.shadowRoot?.querySelector("#pangram-action")?.click();
});
await page.waitForURL(/mobilebasic/, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
await page.evaluate(async () => {
  for (let i = 0; i < 8; i++) { window.scrollBy(0, innerHeight * 0.8); await new Promise(r => setTimeout(r, 300)); }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(3000);
const readingState = await page.evaluate((sel) => {
  const fab = document.getElementById("pangram-fab");
  const action = fab?.shadowRoot?.querySelector("#pangram-action");
  const hosts = [...document.querySelectorAll(sel)];
  const content = document.querySelector(".doc .doc-content");
  return {
    url: location.href.slice(0, 120),
    badges: hosts.length,
    actionLabel: action?.textContent ?? null,
    actionShown: action ? getComputedStyle(action).display !== "none" : false,
    fabCount: fab?.shadowRoot?.querySelector(".count")?.textContent ?? "?",
    readingMarker: location.hash.includes("pangram-reading"),
    readingStyle: !!document.querySelector('style[data-pangram="style"]'),
    contentMaxWidth: content ? getComputedStyle(content).maxWidth : null,
    sample: hosts.slice(0, 3).map((h) => (h.parentElement?.textContent ?? "").trim().slice(0, 60)),
  };
}, BADGE_SEL);
console.log("READING:", JSON.stringify(readingState, null, 2));
await page.screenshot({ path: join(__dirname, "docs-reading.png") });

// 3) back to editor
await page.evaluate(() => {
  document.getElementById("pangram-fab")?.shadowRoot?.querySelector("#pangram-action")?.click();
});
await page.waitForURL(/\/edit/, { timeout: 20000 }).catch(() => {});
const backUrl = page.url();
console.log("BACK →", backUrl.slice(0, 110));
console.log("tab preserved on return:", /[?&]tab=/.test(backUrl));
console.log("ext errors:", errors.length ? JSON.stringify(errors) : "none");
await context.close();
