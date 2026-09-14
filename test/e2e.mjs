// test/e2e.mjs — Playwright end-to-end test for the Anagram MV3 extension (v2).
//
// Loads the built unpacked extension into a persistent Chromium context pointed at the
// test-only fake daemon (deterministic verdicts, no model needed), serves the
// self-test page over http (so the <all_urls> content script injects), scrolls the
// whole page (scoring is viewport-first BY DESIGN), then asserts the v2 behaviours:
// long paragraphs badge once and underline to the end (the HF regression),
// BR-split/short-sibling/pre-wrap content merges into single units, inline code
// does not fragment prose, pure-CJK text is scored, hidden tabs and <details>
// get badges when revealed, pushState swaps re-badge and purge, removals purge,
// never-score zones stay clean, and the page DOM carries no marker attributes.
//
//   node test/e2e.mjs            # headed (most reliable for MV3 extensions)
//   HEADLESS=1 node test/e2e.mjs # try new-headless
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { launchExtension, serveHtml, BADGE_SEL } from "./harness.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADLESS = process.env.HEADLESS === "1";

// 1) the fake daemon + a tiny static server for the self-contained self-test page.
const daemon = await startFakeDaemon();
const server = await serveHtml({ "/selftest.html": readFileSync(join(__dirname, "selftest.html"), "utf8") });
const url = server.url("/selftest.html");
console.log("serving self-test at", url, "· fake daemon at", daemon.url);

// 2) launch a persistent context with the unpacked extension pointed at the fake.
const { context, sw } = await launchExtension({ backendUrl: daemon.url, headless: HEADLESS, viewport: { width: 1280, height: 720 } });
console.log("extension service worker:", sw ? sw.url() : "NOT FOUND");

// 4) open the page; capture content-script console errors.
const consoleErrors = [];
const page = await context.newPage();
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push("console.error: " + m.text());
});
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1200);

// 5) scoring is viewport-first: scroll through the page so everything dispatches.
async function sweepScroll() {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 320));
    }
    window.scrollTo(0, 0);
  });
}
await sweepScroll();

// 6) wait until the badge count stabilizes.
async function badgeCount() {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL);
}
{
  let last = -1;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const n = await badgeCount();
    if (n > 0 && n === last) break;
    last = n;
    await page.waitForTimeout(1200);
  }
}

const visibleBadges = () =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].filter((h) => getComputedStyle(h).display !== "none")
        .length,
    BADGE_SEL,
  );

// 7) core snapshot.
const snapshot = await page.evaluate((sel) => {
  const inSection = (id) => document.querySelectorAll(`#${id} ${sel}`).length;
  const highlightTexts = (() => {
    if (typeof CSS === "undefined" || !CSS.highlights) return [];
    const out = [];
    for (const h of CSS.highlights.values()) for (const r of h) out.push(r.toString());
    return out;
  })();
  const hlHas = (marker) => highlightTexts.some((t) => t.includes(marker));
  const strayMarks = [...document.querySelectorAll("[data-anagram]")].filter(
    (el) => !["host", "style"].includes(el.getAttribute("data-anagram")),
  ).length;
  return {
    badgeTotal: document.querySelectorAll(sel).length,
    fabPresent: !!document.getElementById("anagram-fab"),
    highlightCount: highlightTexts.length,
    sections: {
      human: inSection("human"),
      aiwrap: inSection("aiwrap"),
      short: inSection("short"),
      quote: inSection("quote"),
      divbased: inSection("divbased"),
      longpara: inSection("longpara"),
      brsplit: inSection("brsplit"),
      mergeshorts: inSection("mergeshorts"),
      inlinecode: inSection("inlinecode"),
      purecjk: inSection("purecjk"),
      tabs: inSection("tabs"),
      detailswrap: inSection("detailswrap"),
      spa: inSection("spa"),
      never: inSection("never"),
    },
    prewrapBadges: document.querySelectorAll(`#prewrap ${sel}`).length,
    // With the real daemon behind Auto mode the Chinese paragraph is (correctly) an
    // "unsupported language" chip with no mark; with the stub it is scored + marked.
    cjkUnsupported: !!document.querySelector(`#purecjk ${sel}`)?.shadowRoot?.querySelector(".pill.band-unsupported"),
    hl: {
      longtail: hlHas("final LONGTAIL sentence"),
      br1: hlHas("BRPART-ONE"),
      br2: hlHas("BRPART-TWO"),
      ms1: hlHas("MS-ONE"),
      ms2: hlHas("MS-TWO"),
      ms3: hlHas("MS-THREE"),
      icode: hlHas("ICODE tail marker"),
      cjk: hlHas("纯中文标记"),
      pw1: hlHas("PREWRAP-ONE"),
      pw2: hlHas("PREWRAP-TWO"),
    },
    strayMarks,
  };
}, BADGE_SEL);
console.log("\nSNAPSHOT:");
console.log(JSON.stringify(snapshot, null, 2));

// 8) hidden-tab reveal (class flip → attribute observer).
await page.locator("#tabbtn").scrollIntoViewIfNeeded();
await page.locator("#tabbtn").click();
const tabBadged = await page
  .waitForFunction(
    (sel) => document.querySelectorAll(`#tabpanel ${sel}`).length >= 1,
    BADGE_SEL,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);

// 9) <details> open (open attribute → observer).
await page.locator("#details summary").scrollIntoViewIfNeeded();
await page.locator("#details summary").click();
const detailsBadged = await page
  .waitForFunction(
    (sel) => document.querySelectorAll(`#detailswrap ${sel}`).length >= 1,
    BADGE_SEL,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);

// 10) SPA pushState swap: new route content badged, stale unit purged.
await page.locator("#spaNav").scrollIntoViewIfNeeded();
await page.locator("#spaNav").click();
const spaBadged = await page
  .waitForFunction(
    (sel) => {
      const spa = document.getElementById("spa");
      return (
        spa &&
        spa.textContent.includes("SPA-SECOND") &&
        spa.querySelectorAll(sel).length === 1
      );
    },
    BADGE_SEL,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);

// 11) removal purge: removing a badged paragraph takes its badge with it.
await page.locator("#removeAi").scrollIntoViewIfNeeded();
const beforeRemove = await badgeCount();
await page.locator("#removeAi").click();
await page.waitForTimeout(900);
const afterRemove = await badgeCount();

// 12) RAPID dynamic insertion — N synchronous clicks with identical text (the
// fast-click race). Every added paragraph must get its own badge.
const beforeAdd = await badgeCount();
const RAPID = 5;
await page.evaluate((n) => {
  const b = document.getElementById("add");
  for (let i = 0; i < n; i++) b?.click();
}, RAPID);
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page
  .waitForFunction(
    ({ target, sel }) => document.querySelectorAll(sel).length >= target,
    { target: beforeAdd + RAPID, sel: BADGE_SEL },
    { timeout: 12000 },
  )
  .catch(() => {});
const afterAdd = await badgeCount();
console.log(`rapid add: badges ${beforeAdd} -> ${afterAdd} (clicked ${RAPID})`);

// 13) toggle test: FAB click → hidden → click → shown.
const clickFab = () =>
  page.evaluate(() =>
    document.getElementById("anagram-fab")?.shadowRoot?.querySelector("button.fab")?.click(),
  );
const shownN = await visibleBadges();
await clickFab();
await page.waitForTimeout(300);
const hiddenN = await visibleBadges();
await clickFab();
await page.waitForTimeout(300);
const reshownN = await visibleBadges();
console.log(`toggle: visible ${shownN} -> hidden ${hiddenN} -> visible ${reshownN}`);

// 14) screenshot (overlay shown).
const shot = join(__dirname, "e2e-screenshot.png");
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: shot, fullPage: true });
console.log("screenshot:", shot);

// 15) checks + summary.
const s = snapshot;
const checks = [
  ["extension loaded (service worker)", !!sw],
  ["badges rendered across the page", s.badgeTotal >= 11],
  ["floating toggle present", s.fabPresent],
  ["underlines present", s.highlightCount > 0],
  ["human/ai/quote/div-EN/div-ZH badged", s.sections.human === 1 && s.sections.aiwrap === 1 && s.sections.quote === 1 && s.sections.divbased === 2],
  ["LONG paragraph: exactly ONE badge (no 1000-char split)", s.sections.longpara === 1],
  ["LONG paragraph underline reaches the end (HF regression)", s.hl.longtail],
  ["BR-split halves merged into one unit", s.sections.brsplit === 1 && s.hl.br1 && s.hl.br2],
  ["three short siblings merged into one unit", s.sections.mergeshorts === 1 && s.hl.ms1 && s.hl.ms2 && s.hl.ms3],
  ["inline <code> does not fragment the paragraph", s.sections.inlinecode === 1 && s.hl.icode],
  ["pure-CJK paragraph badged as 'unsupported' (language gate)", s.sections.purecjk === 1 && s.cjkUnsupported],
  ["pre-wrap blank-line paragraphs split + merged", s.prewrapBadges === 1 && s.hl.pw1 && s.hl.pw2],
  ["short isolated paragraph skipped", s.sections.short === 0],
  ["never-score zone clean (code/nav-links/editor/aria-hidden)", s.sections.never === 0],
  ["page DOM carries no marker attributes", s.strayMarks === 0],
  ["hidden tab badged after class-flip reveal", tabBadged],
  ["<details> content badged after open", detailsBadged],
  ["pushState swap: new route badged, stale purged", spaBadged],
  ["removing a paragraph removes its badge", afterRemove === beforeRemove - 1],
  ["rapid insert: every added paragraph badged", afterAdd === beforeAdd + RAPID],
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
await server.close();
await daemon.close();
process.exit(pass ? 0 : 1);
