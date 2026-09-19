// test/firefox.mjs — end-to-end test of the FIREFOX MV2 build, in a real Firefox.
//
// The Chromium suites (test/e2e.mjs, test/scenarios.mjs) drive Playwright; Playwright
// cannot load an extension into Firefox, so this one drives headless Firefox through
// puppeteer-core over WebDriver BiDi — see test/firefox-harness.mjs for the launch,
// the temporary install of output/firefox-mv2, and the fixed moz-extension:// origin.
//
// It runs against the same two things every other browser suite uses: the test-only fake
// daemon (test/fake-daemon.mjs, deterministic verdicts, no model) and the self-test page
// (test/selftest.html) served over http so the registered content script injects. What it
// asserts is what is DIFFERENT about Firefox, on top of "the product still works":
//
//   * MV2: a background PAGE, not a service worker, and browserAction instead of action;
//   * moz-extension:// pages (popup / options / onboarding) render and talk to it;
//   * the CSS Custom Highlight API is Firefox 140+; below that the DOCUMENTED behaviour
//     is chips without underlines, so that check reports SKIP rather than failing —
//     what actually happens below 140 is in the FINDINGS block at the end of a run;
//   * there is no Navigation API in older Firefox, so a pushState route swap is covered
//     by the orchestrator's 2.5 s URL poll and is given ~6 s here;
//   * the Popover API (top-layer hover card) has a CSS fallback;
//   * the PDF reading mode is the one page where the whole pipeline runs on a
//     moz-extension: document, and it loads pdf.js and a MODULE WORKER from that origin.
//
//   npm run build:firefox && npm run test:firefox
//   npm run test:firefox -- --quick     # skip the daemon down/up cycle (~25 s)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { serveHtml, artifact } from "./harness.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";
import {
  BADGE_SEL,
  EXT_UUID,
  GECKO_ID,
  launchFirefox,
  openExtensionPage,
  waitForExtensionPage,
  findPageByHref,
  setServerUrl,
  setViewportSafe,
  sleep,
  sweep,
  waitFor,
} from "./firefox-harness.mjs";
import { PDF_HEADING, PDF_HEAD, TEST_PDF } from "./pdf-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUICK = process.argv.includes("--quick");

// ── results ────────────────────────────────────────────────────────────────────────
const results = [];
const check = (name, ok, note = "") => results.push({ name, state: ok ? "PASS" : "FAIL", note });
const skip = (name, why) => results.push({ name, state: "SKIP", note: why });

// ── 1) fake daemon + the self-test page over http ──────────────────────────────────
let daemon = await startFakeDaemon();
const daemonPort = daemon.port;
const server = await serveHtml({ "/selftest.html": readFileSync(join(__dirname, "selftest.html"), "utf8") });
const pageUrl = server.url("/selftest.html");

// ── 2) headless Firefox + a temporary install of output/firefox-mv2 ────────────────
const { browser, firefox, extId, extUrl } = await launchFirefox().catch(async (e) => {
  console.error(e.message ?? e);
  await server.close();
  await daemon.close();
  process.exit(2);
});
console.log(`Firefox ${firefox.version} (${firefox.source})\n  ${firefox.executablePath}`);
console.log(`serving self-test at ${pageUrl} · fake daemon at ${daemon.url}`);
console.log(`installed ${extId} → moz-extension://${EXT_UUID}/`);
check("extension installs temporarily (BiDi webExtension.install)", extId === GECKO_ID, extId);

// The install fires runtime.onInstalled, which opens the onboarding tab itself — that is
// the first proof the MV2 background page ran at all.
const onboarding = await findPageByHref(browser, "onboarding.html", { timeout: 20000 });

// ── 3) options page: the background page answers, and the version string shows ─────
await setServerUrl(browser, extUrl, daemon.url);
const optionsPage = await openExtensionPage(browser, extUrl("options.html"));
const extPageErrors = [];
for (const [label, p] of [["options", optionsPage], ["onboarding", onboarding.page]]) {
  if (!p) continue;
  p.on("pageerror", (e) => extPageErrors.push(`${label} pageerror: ${String(e).slice(0, 200)}`));
  p.on("console", (m) => {
    if (m.type() === "error") extPageErrors.push(`${label} console.error: ${m.text().slice(0, 200)}`);
  });
}
await sleep(1200);

const versionText = await optionsPage.evaluate(() => document.getElementById("version")?.textContent ?? "");
check(
  "options page renders and shows the version (background page reachable)",
  /^v\d+\.\d+\.\d+ · contract \d/.test(versionText),
  versionText,
);

const backendStatus = await optionsPage
  .evaluate(() => browser.runtime.sendMessage({ action: "getBackendStatus", probe: true }))
  .catch((e) => ({ error: String(e).slice(0, 120) }));
check(
  "MV2 background page answers runtime.sendMessage (GET_BACKEND_STATUS)",
  !!backendStatus && backendStatus.active === "server" && backendStatus.server?.ok === true && backendStatus.serverUrl === daemon.url,
  JSON.stringify(backendStatus).slice(0, 180),
);

// MV2 exposes browserAction, MV3 exposes action — background.ts picks whichever exists.
const apiShape = await optionsPage.evaluate(() => ({
  browserAction: typeof browser.browserAction,
  action: typeof browser.action,
  detectLanguage: typeof browser.i18n?.detectLanguage,
  manifestVersion: browser.runtime.getManifest().manifest_version,
}));
check(
  "MV2 shape: manifest_version 2, browserAction present, action absent, i18n.detectLanguage present",
  apiShape.manifestVersion === 2 &&
    apiShape.browserAction === "object" &&
    apiShape.action === "undefined" &&
    apiShape.detectLanguage === "function",
  JSON.stringify(apiShape),
);

// ── 4) the page under test ─────────────────────────────────────────────────────────
const consoleErrors = [];
const page = await browser.newPage();
await setViewportSafe(page);
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push("console.error: " + m.text().slice(0, 200));
});
await page.goto(pageUrl, { waitUntil: "load" });
await sleep(1200);
await sweep(page);

const badgeCount = () => page.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL);
{
  let last = -1;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const n = await badgeCount();
    if (n > 0 && n === last) break;
    last = n;
    await sleep(1200);
  }
}

const features = await page.evaluate(() => ({
  highlights: typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined",
  popover: "showPopover" in HTMLElement.prototype,
  navigation: typeof window.navigation === "object" && window.navigation !== null,
  segmenter: typeof Intl.Segmenter === "function",
}));
console.log("platform features:", JSON.stringify(features));

const snapshot = await page.evaluate((sel) => {
  const inSection = (id) => document.querySelectorAll(`#${id} ${sel}`).length;
  const highlightTexts = (() => {
    if (typeof CSS === "undefined" || !CSS.highlights) return [];
    const out = [];
    for (const h of CSS.highlights.values()) for (const r of h) out.push(r.toString());
    return out;
  })();
  const hlHas = (marker) => highlightTexts.some((t) => t.includes(marker));
  return {
    badgeTotal: document.querySelectorAll(sel).length,
    fabPresent: !!document.getElementById("anagram-fab"),
    highlightCount: highlightTexts.length,
    strayMarks: [...document.querySelectorAll("[data-anagram]")].filter(
      (el) => !["host", "style"].includes(el.getAttribute("data-anagram")),
    ).length,
    sections: {
      human: inSection("human"),
      short: inSection("short"),
      longpara: inSection("longpara"),
      windowed: inSection("windowed"),
      brsplit: inSection("brsplit"),
      mergeshorts: inSection("mergeshorts"),
      purecjk: inSection("purecjk"),
      never: inSection("never"),
    },
    cjkUnsupported: !!document
      .querySelector(`#purecjk ${sel}`)
      ?.shadowRoot?.querySelector(".pill.band-unsupported"),
    hl: { longtail: hlHas("final LONGTAIL sentence"), br1: hlHas("BRPART-ONE"), br2: hlHas("BRPART-TWO") },
  };
}, BADGE_SEL);
console.log("SNAPSHOT:", JSON.stringify(snapshot));

check("chips render across the self-test page", snapshot.badgeTotal >= 11, `${snapshot.badgeTotal} chips`);
check("LONG paragraph is exactly ONE chip", snapshot.sections.longpara === 1, String(snapshot.sections.longpara));
check("BR-split halves merge into one unit", snapshot.sections.brsplit === 1, String(snapshot.sections.brsplit));
check("three short siblings merge into one unit", snapshot.sections.mergeshorts === 1, String(snapshot.sections.mergeshorts));
check("short isolated paragraph stays unbadged", snapshot.sections.short === 0, String(snapshot.sections.short));
check("never-score zone stays clean", snapshot.sections.never === 0, String(snapshot.sections.never));
check("page DOM carries no marker attributes", snapshot.strayMarks === 0, String(snapshot.strayMarks));
check(
  "pure-CJK paragraph is an 'unsupported' chip (local language gate)",
  snapshot.sections.purecjk === 1 && snapshot.cjkUnsupported,
  JSON.stringify({ chips: snapshot.sections.purecjk, unsupported: snapshot.cjkUnsupported }),
);
check(
  "non-English text never reaches the daemon (browser.i18n.detectLanguage gate)",
  daemon.stats.blocks > 5 && daemon.stats.nonEnglishBlocks === 0,
  `${daemon.stats.blocks} blocks, ${daemon.stats.nonEnglishBlocks} non-English`,
);

// ── 5) underlines: CSS Custom Highlight API is Firefox 140+ ────────────────────────
if (features.highlights) {
  check(
    "underlines: highlight ranges exist and cover the LONGTAIL marker",
    snapshot.highlightCount > 0 && snapshot.hl.longtail,
    `${snapshot.highlightCount} ranges, longtail=${snapshot.hl.longtail}`,
  );
} else {
  skip(
    "underlines: highlight ranges exist and cover the LONGTAIL marker",
    `CSS.highlights missing in Firefox ${firefox.version} (needs 140+) — documented degradation to chips only`,
  );
  check(
    "…degrades gracefully: chips still render without CSS.highlights",
    snapshot.badgeTotal >= 11 && snapshot.highlightCount === 0,
    `${snapshot.badgeTotal} chips, ${snapshot.highlightCount} ranges`,
  );
}

// ── 6) the floating ball, its counter, the panel, the toggle ───────────────────────
const fab = await page.evaluate(() => {
  const sr = document.getElementById("anagram-fab")?.shadowRoot;
  return {
    present: !!sr,
    counter: sr?.querySelector(".count")?.textContent ?? null,
    ball: !!sr?.querySelector("button.fab"),
  };
});
check("floating ball is present with a counter", fab.present && fab.ball, JSON.stringify(fab));

const panel = await page.evaluate(() => {
  const sr = document.getElementById("anagram-fab")?.shadowRoot;
  sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const p = sr?.querySelector(".panel");
  const out = {
    open: !!p?.classList.contains("open"),
    items: p?.querySelectorAll(".pitem").length ?? 0,
    counter: sr?.querySelector(".count")?.textContent ?? null,
  };
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  return out;
});
check(
  "counter button opens the panel and it lists the flagged items",
  panel.open && panel.items > 0 && panel.items === Number(panel.counter),
  JSON.stringify(panel),
);

const visibleBadges = () =>
  page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].filter((h) => getComputedStyle(h).display !== "none").length,
    BADGE_SEL,
  );
const clickFab = () =>
  page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector("button.fab")?.click());
const shownN = await visibleBadges();
await clickFab();
await sleep(400);
const hiddenN = await visibleBadges();
await clickFab();
await sleep(400);
const reshownN = await visibleBadges();
check(
  "toggle hides and re-shows the chips",
  shownN > 0 && hiddenN === 0 && reshownN === shownN,
  `${shownN} → ${hiddenN} → ${reshownN}`,
);

// Hover card: top-layer popover where it exists, CSS fallback where it does not. Either
// way the card must be visible AND inside the viewport.
const card = await page.evaluate(async (sel) => {
  const host = [...document.querySelectorAll(sel)].find((h) => {
    const r = h.getBoundingClientRect();
    return r.top > 40 && r.bottom < window.innerHeight - 40;
  });
  if (!host) return { found: false };
  host.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  await new Promise((r) => setTimeout(r, 600));
  const c = host.shadowRoot?.querySelector(".card");
  if (!c) return { found: false };
  const r = c.getBoundingClientRect();
  return {
    found: true,
    popover: c.hasAttribute("popover"),
    popoverOpen: c.hasAttribute("popover") ? c.matches(":popover-open") : null,
    showing: c.classList.contains("showing"),
    visible: r.width > 40 && r.height > 20 && getComputedStyle(c).visibility !== "hidden",
    inViewport: r.top >= -1 && r.left >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
    rect: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
  };
}, BADGE_SEL);
check(
  `hover card is visible and inside the viewport (${card.popover ? "top-layer popover" : "CSS fallback"} path)`,
  card.found && card.visible && card.inViewport && (card.popover ? card.popoverOpen : card.showing),
  JSON.stringify(card),
);
await page.evaluate((sel) => {
  for (const h of document.querySelectorAll(sel)) h.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
}, BADGE_SEL);

// ── 7) dynamic behaviour ───────────────────────────────────────────────────────────
const clickIn = (id) =>
  page.evaluate((i) => {
    const el = document.querySelector(i);
    el?.scrollIntoView({ block: "center" });
    el?.click();
  }, id);

await clickIn("#tabbtn");
check(
  "hidden tab is chipped after the class-flip reveal",
  await waitFor(page, (sel) => document.querySelectorAll(`#tabpanel ${sel}`).length >= 1, { timeout: 10000, arg: BADGE_SEL }),
);

await clickIn("#details summary");
check(
  "<details> content is chipped after it is opened",
  await waitFor(page, (sel) => document.querySelectorAll(`#detailswrap ${sel}`).length >= 1, { timeout: 10000, arg: BADGE_SEL }),
);

const beforeRemove = await badgeCount();
await clickIn("#removeAi");
await sleep(1200);
const afterRemove = await badgeCount();
check("removing a paragraph removes its chip", afterRemove === beforeRemove - 1, `${beforeRemove} → ${afterRemove}`);

const beforeAdd = await badgeCount();
const RAPID = 5;
await page.evaluate((n) => {
  const b = document.getElementById("add");
  for (let i = 0; i < n; i++) b?.click();
}, RAPID);
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await waitFor(page, ({ target, sel }) => document.querySelectorAll(sel).length >= target, {
  timeout: 15000,
  arg: { target: beforeAdd + RAPID, sel: BADGE_SEL },
});
const afterAdd = await badgeCount();
check("rapid insertion: every added paragraph is chipped", afterAdd === beforeAdd + RAPID, `${beforeAdd} → ${afterAdd} (+${RAPID})`);

// The pushState swap. Chrome uses the Navigation API; where it is missing the
// orchestrator falls back to a 2.5 s URL poll, so this is given ~6 s either way.
await clickIn("#spaNav");
const spaStart = Date.now();
const spaOk = await waitFor(
  page,
  (sel) => {
    const spa = document.getElementById("spa");
    return !!spa && spa.textContent.includes("SPA-SECOND") && spa.querySelectorAll(sel).length === 1;
  },
  { timeout: 9000, arg: BADGE_SEL },
);
const spaMs = Date.now() - spaStart;
check(
  "pushState route swap: the new route is chipped and the stale unit purged",
  spaOk && spaMs <= 6500,
  `${spaMs} ms (Navigation API ${features.navigation ? "present" : "absent — 2.5 s URL poll"})`,
);

// ── 8) a setting written in the options page reaches the open tab live ─────────────
const markStyleLive = await (async () => {
  const styleCss = () =>
    page.evaluate(() => document.querySelector('style[data-anagram="style"]')?.textContent ?? "");
  const before = await styleCss();
  // "always" marks every band at rest, so the resting human rule gains a tint; "quiet"
  // (the default) leaves human text alone and that rule disappears again.
  await optionsPage.evaluate(() => browser.storage.local.set({ markStyle: "always" }));
  const flipped = await waitFor(page, () => {
    const css = document.querySelector('style[data-anagram="style"]')?.textContent ?? "";
    return /::highlight\(anagram-human\)\s*\{[^}]*background-color/.test(css);
  }, { timeout: 8000 });
  await optionsPage.evaluate(() => browser.storage.local.set({ markStyle: "quiet" }));
  const restored = await waitFor(page, () => {
    const css = document.querySelector('style[data-anagram="style"]')?.textContent ?? "";
    return !/::highlight\(anagram-human\)/.test(css) && /::highlight\(anagram-ai\)/.test(css);
  }, { timeout: 8000 });
  return { hadStyleEl: before.length > 0, flipped, restored };
})();
if (features.highlights) {
  check(
    "a setting written in the options page reaches an open tab live (markStyle)",
    markStyleLive.hadStyleEl && markStyleLive.flipped && markStyleLive.restored,
    JSON.stringify(markStyleLive),
  );
} else {
  skip(
    "a setting written in the options page reaches an open tab live (markStyle)",
    "no ::highlight() stylesheet is injected without CSS.highlights",
  );
}

// ── 9) extension pages render: popup, options, onboarding ──────────────────────────
const popupPage = await openExtensionPage(browser, extUrl("popup.html")).catch(() => null);
popupPage?.on("pageerror", (e) => extPageErrors.push("popup pageerror: " + String(e).slice(0, 200)));
popupPage?.on("console", (m) => {
  if (m.type() === "error") extPageErrors.push("popup console.error: " + m.text().slice(0, 200));
});
await sleep(1200);
const popupInfo = popupPage
  ? await popupPage.evaluate(() => ({
      buttons: document.querySelectorAll("button").length,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
      height: document.body.getBoundingClientRect().height,
    }))
  : null;
check("popup page renders", !!popupInfo && popupInfo.buttons > 0 && popupInfo.height > 40, JSON.stringify(popupInfo));

const onboardingInfo = onboarding.page
  ? await onboarding.page
      .evaluate(() => ({
        href: location.href,
        text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
        height: document.body.getBoundingClientRect().height,
      }))
      .catch(() => null)
  : null;
check(
  "onboarding page opens itself on install and renders",
  !!onboardingInfo && onboardingInfo.href.endsWith("/onboarding.html") && onboardingInfo.height > 100,
  JSON.stringify(onboardingInfo),
);

// ── 10) the MV2 toolbar badge path (browserAction.setBadgeText) ────────────────────
const badgeApi = await optionsPage
  .evaluate(async () => {
    const tab = await browser.tabs.getCurrent();
    const before = await browser.browserAction.getBadgeText({ tabId: tab.id });
    await browser.runtime.sendMessage({ action: "updateBadge", flagged: 7 });
    await new Promise((r) => setTimeout(r, 600));
    const after = await browser.browserAction.getBadgeText({ tabId: tab.id });
    await browser.runtime.sendMessage({ action: "updateBadge", flagged: 0 });
    await new Promise((r) => setTimeout(r, 600));
    const cleared = await browser.browserAction.getBadgeText({ tabId: tab.id });
    return { before, after, cleared };
  })
  .catch((e) => ({ error: String(e).slice(0, 200) }));
check(
  "MV2 toolbar badge: browserAction.setBadgeText applies the flagged count",
  badgeApi.after === "7" && badgeApi.cleared === "",
  JSON.stringify(badgeApi),
);

// ── 10b) the PDF reading mode ──────────────────────────────────────────────────────
// A browser hands a PDF to a viewer that exposes no DOM text, so the reader rebuilds the
// document on an extension page of its own and runs the ORDINARY pipeline over it. That
// is the only place where pdf.js, a module worker and the orchestrator all run on a
// moz-extension: document — three things Firefox could do differently, and the suite that
// would notice is this one. The PDF is the one test/scenarios.mjs opens in Chromium
// (test/pdf-fixture.mjs), served over http as application/pdf.
const readerErrors = [];

/**
 * Put a PDF into the reading mode the only way Firefox has: a real drop. BiDi cannot
 * carry a file to an input, so the bytes travel as base64 and become a File in the page.
 */
const dropPdf = (page, buffer, name) =>
  page
    .evaluate(
      ([b64, fileName]) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], fileName, { type: "application/pdf" }));
        document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
      },
      [buffer.toString("base64"), name],
    )
    .catch(() => false);
/** What Resource Timing reported on the reader page — evidence for a finding below. */
let pdfResources = [];
{
  // A DROPPED FILE, not a `?src=` address. The reading mode is handed its bytes by the tab
  // that is showing the PDF (lib/pdf/handoff.ts), and Firefox's viewer is a privileged
  // page no content script reaches — so on Firefox there IS no such tab, no remote PDF is
  // ever offered, and the drop zone is the whole feature. What this suite is for is the
  // rest of it: pdf.js, a module worker and the orchestrator on a moz-extension: document.
  const readerUrl = extUrl("reader.html");
  const p = await browser.newPage();
  p.on("pageerror", (e) => readerErrors.push("pageerror: " + String(e).slice(0, 200)));
  p.on("console", (m) => {
    if (m.type() === "error") readerErrors.push("console.error: " + m.text().slice(0, 200));
  });
  await p.goto(readerUrl, { waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => {});
  const arrived = await waitForExtensionPage(p, readerUrl, 25000)
    .then(() => true)
    .catch(() => false);
  if (arrived) await dropPdf(p, TEST_PDF, "doc.pdf");
  const rendered = arrived && (await waitFor(p, () => document.querySelectorAll(".page .textLayer span").length >= 20, { timeout: 30000 }));
  const scored = rendered &&
    (await waitFor(p, (sel) => {
      const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
      return pills.length > 0 && !pills.some((h) => h.shadowRoot.querySelector(".pill.pending"));
    }, { timeout: 30000, arg: BADGE_SEL }));
  const pdf = arrived
    ? await p.evaluate((sel) => {
        const chips = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
        const spans = [...document.querySelectorAll(".textLayer span")];
        const rects = spans.map((s) => s.getBoundingClientRect());
        let marks = 0;
        for (const h of CSS.highlights?.values() ?? []) marks += h.size;
        return {
          pages: document.querySelectorAll(".page").length,
          // Gecko draws into the same canvases: a page with pixels is the whole point.
          drawn: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0).length,
          spans: spans.length,
          text: spans.map((s) => s.textContent).join(" ").replace(/\s+/g, " "),
          chips: chips.length,
          chipsPlaced: chips.every((h) => {
            const r = h.getBoundingClientRect();
            const box = h.closest(".page").getBoundingClientRect();
            return (
              r.left >= box.left - 1 && r.right <= box.right + 1 &&
              r.top >= box.top - 1 && r.bottom <= box.bottom + 1 &&
              !rects.some((s) => s.width > 0 && r.left < s.right - 0.5 && s.left + 0.5 < r.right && r.top < s.bottom - 0.5 && s.top + 0.5 < r.bottom)
            );
          }),
          marks,
          notice: document.getElementById("notice")?.textContent ?? "",
          title: document.title,
          // What Resource Timing reports on a privileged document — nothing of the page's
          // own origin here, which is why the worker is watched by its constructor below.
          resources: performance.getEntriesByType("resource").map((e) => e.name.split("/").pop()),
        };
      }, BADGE_SEL)
    : null;
  console.log("PDF READER:", JSON.stringify(pdf).slice(0, 400));
  pdfResources = pdf?.resources ?? [];
  check(
    "PDF reader: Gecko draws the real pages and builds a text layer over each of them",
    !!pdf &&
      pdf.pages === 2 &&
      pdf.drawn === 2 &&
      pdf.spans >= 29 &&
      pdf.text.includes(PDF_HEADING) &&
      pdf.text.includes(PDF_HEAD),
    JSON.stringify({ pages: pdf?.pages, drawn: pdf?.drawn, spans: pdf?.spans, notice: pdf?.notice }),
  );
  check(
    "PDF reader: the ordinary pipeline scores the reconstruction — chips on the page, marks, no errors",
    !!scored &&
      pdf?.chips === 3 &&
      pdf?.chipsPlaced === true &&
      (pdf?.marks ?? 0) >= 20 &&
      pdf?.title === "doc.pdf" &&
      readerErrors.length === 0,
    JSON.stringify({ chips: pdf?.chips, placed: pdf?.chipsPlaced, marks: pdf?.marks, errors: readerErrors.slice(0, 3) }),
  );
  await p.close();
}

// Did pdf.js really run its parser in a WORKER? A document that comes out right proves
// nothing on its own: when the worker cannot be created pdf.js falls back to a "fake
// worker" on the main thread and parses it anyway. Firefox reports no Resource Timing
// entry for a moz-extension: subresource and BiDi runs no preload script on a privileged
// document (see the findings at the end), so the constructor is watched instead — on a
// reader opened with NO source, which loads nothing until a file arrives.
{
  const readerUrl = extUrl("reader.html");
  const p = await browser.newPage();
  p.on("pageerror", (e) => readerErrors.push("pageerror: " + String(e).slice(0, 200)));
  await p.goto(readerUrl, { waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => {});
  const arrived = await waitForExtensionPage(p, readerUrl, 25000)
    .then(() => true)
    .catch(() => false);
  if (arrived) {
    // The constructor is wrapped BEFORE the drop, because the worker is created while the
    // document is being opened and there is no other way to see it from here.
    await p.evaluate(() => {
      const W = window.Worker;
      window.__workers = [];
      window.Worker = function (url, opts) {
        window.__workers.push(`${String(url)}|${(opts && opts.type) || "classic"}`);
        return new W(url, opts);
      };
      window.Worker.prototype = W.prototype;
    });
  }
  const dropped = arrived && (await dropPdf(p, TEST_PDF, "dropped.pdf"));
  const read = dropped && (await waitFor(p, () => document.querySelectorAll(".page .textLayer span").length >= 20, { timeout: 30000 }));
  const workers = arrived ? await p.evaluate(() => window.__workers ?? null).catch(() => null) : null;
  check(
    "PDF reader: a dropped file is read, and pdf.js parses it in a MODULE WORKER from moz-extension://",
    read &&
      Array.isArray(workers) &&
      workers.some((w) => w.startsWith(`moz-extension://${EXT_UUID}/vendor/pdf.worker.mjs`) && w.endsWith("|module")),
    JSON.stringify({ read, workers }),
  );
  await p.close();
}

// ── 11) screenshot ─────────────────────────────────────────────────────────────────
const shot = artifact("firefox-screenshot.png");
await page.evaluate(() => window.scrollTo(0, 0));
await page
  .screenshot({ path: shot, fullPage: true })
  .catch(() => page.screenshot({ path: shot }))
  .then(() => console.log("screenshot:", shot))
  .catch((e) => console.log("screenshot failed:", String(e).slice(0, 120)));

// ── 11b) diagnostic (no assertion): does the idle prefetch lane run at all? ────────
// Scoring is viewport-first and everything else is drained by an idle-time background
// lane, so a page that is never scrolled should still end up fully scored. Chromium
// does; if Firefox stops at the first viewport, the lane never ran.
const prefetched = await (async () => {
  const p = await browser.newPage();
  await setViewportSafe(p);
  await p.goto(pageUrl, { waitUntil: "load" });
  await sleep(7000); // no scrolling at all
  const n = await p.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL);
  await p.close();
  return n;
})();

// ── 12) daemon down → "Unavailable" + "!" counter; daemon back → re-queued ─────────
if (QUICK) {
  skip("daemon down → Unavailable chip + '!' counter; daemon back → re-queued", "--quick");
} else {
  const p = await browser.newPage();
  await setViewportSafe(p);
  await p.goto(pageUrl, { waitUntil: "load" });
  await waitFor(p, (sel) => document.querySelectorAll(sel).length > 0, { timeout: 15000, arg: BADGE_SEL });
  const addPara = (id) =>
    p.evaluate((pid) => {
      const el = document.createElement("p");
      el.id = pid;
      el.textContent =
        `${pid.toUpperCase()} paragraph is appended while the scoring daemon is stopped, so ` +
        "the extension must not invent a verdict for it: the batch that hits the dead socket renders as " +
        "Unavailable and later paragraphs wait without any chip, until a health probe succeeds again and " +
        "every waiting or unavailable unit is queued once more without a reload or a manual rescan.";
      document.body.prepend(el);
      window.scrollTo(0, 0);
    }, id);
  const settledIn = (id, timeout) =>
    waitFor(p, ({ sel, pid }) => {
      const pill = document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill");
      return !!pill && !pill.classList.contains("pending");
    }, { timeout, arg: { sel: BADGE_SEL, pid: id } });
  const bandOf = (id) =>
    p.evaluate(
      ({ sel, pid }) =>
        [...(document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill")?.classList ?? [])].find((c) =>
          c.startsWith("band-"),
        ) ?? null,
      { sel: BADGE_SEL, pid: id },
    );
  const counter = () =>
    p.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);

  await daemon.close(); // connection refused from here on
  await addPara("down1");
  const gotDown1 = await settledIn("down1", 12000);
  const band1 = await bandOf("down1");
  await addPara("down2");
  await sleep(2500);
  const down2Chips = await p.evaluate((sel) => document.querySelectorAll(`#down2 ${sel}`).length, BADGE_SEL);
  const counterDown = await counter();
  check(
    "daemon down: in-flight batch renders 'Unavailable', later paragraphs get no chip, counter shows '!'",
    gotDown1 && band1 === "band-unknown" && down2Chips === 0 && counterDown === "!",
    JSON.stringify({ band1, down2Chips, counterDown }),
  );

  daemon = await startFakeDaemon({ port: daemonPort }); // same URL the extension holds
  const back1 = await waitFor(p, ({ sel, pid }) => document.querySelectorAll(`#${pid} ${sel}`).length >= 1, {
    timeout: 25000,
    arg: { sel: BADGE_SEL, pid: "down2" },
  });
  const back2 = await waitFor(p, ({ sel, pid }) => {
    const pill = document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill");
    return !!pill && !pill.classList.contains("band-unknown") && !pill.classList.contains("pending");
  }, { timeout: 25000, arg: { sel: BADGE_SEL, pid: "down1" } });
  const counterUp = await counter();
  check(
    "daemon back: waiting and 'Unavailable' units are re-queued automatically",
    back1 && back2 && counterUp !== "!",
    JSON.stringify({ back1, back2, counterUp }),
  );
  await p.close();
}

// ── 13) console errors ─────────────────────────────────────────────────────────────
check("no console errors on the page under test", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
check("no console errors on the extension pages", extPageErrors.length === 0, extPageErrors.slice(0, 5).join(" | "));

// ── summary ────────────────────────────────────────────────────────────────────────
console.log("\n=== CHECKS (Firefox " + firefox.version + ") ===");
for (const r of results) console.log(`${r.state}  ${r.name}${r.note ? `  — ${r.note}` : ""}`);
const pass = results.filter((r) => r.state === "PASS").length;
const fail = results.filter((r) => r.state === "FAIL").length;
const skipped = results.filter((r) => r.state === "SKIP").length;
console.log(`\n${pass} passed · ${fail} failed · ${skipped} skipped`);

// ── Firefox-vs-Chromium findings ───────────────────────────────────────────────────
// Differences this suite has established. Product code is NOT worked around here: a
// difference that breaks a behaviour is a FAIL above, and what it is stands below.
console.log("\n=== FIREFOX vs CHROMIUM ===");
const xrayBug = consoleErrors.some((e) => e.includes("Accessing from Xray wrapper"));
if (xrayBug || (snapshot.badgeTotal === 0 && !features.highlights)) {
  console.log(
    "FINDING · nothing renders at all on this Firefox. Assigning a constructed stylesheet to a\n" +
      "  shadow root from a CONTENT SCRIPT — lib/render/badge.ts:200, lib/render/fab.ts:600,\n" +
      "  lib/render/selectionCard.ts:151, lib/docsOverlay.ts:233, all `shadow.adoptedStyleSheets = [sheet()]` —\n" +
      "  throws in Gecko before 140:\n" +
      "    Error: Accessing from Xray wrapper is not supported.\n" +
      "  Cross-compartment adoptedStyleSheets only became usable from a content script in Firefox 140,\n" +
      "  the same release that brought CSS.highlights. Every chip and the floating ball die on the\n" +
      "  first render, so the extension does nothing — it does NOT degrade to chips without\n" +
      "  underlines. The manifest's strict_min_version is 128.0 (wxt.config.ts:21) and README's\n" +
      "  'Install (unpacked)' says older versions degrade gracefully; the real floor is 140.\n" +
      "  Reproduce: `ANAGRAM_FIREFOX=<firefox 139> npm run test:firefox`.",
  );
}
const ricBug = consoleErrors.some((e) => e.includes("requestIdleCallback"));
if (ricBug) {
  console.log(
    "FINDING · lib/capture/orchestrator.ts:486 reads `const ric = window.requestIdleCallback`\n" +
      "  and calls it unbound. Firefox's WebIDL binding rejects the undefined receiver:\n" +
      '    TypeError: \'requestIdleCallback\' called on an object that does not implement interface Window.\n' +
      "  The throw escapes schedulePrefetch() -> ingestUnits() -> start(), so the tail of the\n" +
      "  content script's boot (watchUrl() and the late-Readability re-derive) never runs, and\n" +
      "  because `prefetchScheduled` was already set to true the idle prefetch lane is dead for\n" +
      "  the life of the frame — it throws exactly once and is then skipped by its own guard.\n" +
      `  Measured here: ${prefetched} of ${snapshot.badgeTotal} units are scored on a page that is\n` +
      "  never scrolled (Chromium scores all of them from the idle lane). Chromium accepts the\n" +
      "  unbound call, which is why no existing suite sees this.",
  );
} else {
  console.log(`idle prefetch: ${prefetched} of ${snapshot.badgeTotal} units scored without scrolling.`);
}
console.log(
  `NOTE · window.navigation is ${features.navigation ? "PRESENT" : "absent"} in Firefox ${firefox.version}. ` +
    "lib/capture/orchestrator.ts:59-62 still says the Navigation API is a Chrome-only path and that\n" +
    "  Firefox falls back to the 2.5 s URL poll; on this build the Navigation API branch is taken.",
);
console.log(
  "NOTE · a moz-extension: document reports NO Resource Timing entry for its own subresources in\n" +
    "  Firefox: on the PDF reader page, `performance.getEntriesByType(\"resource\")` lists nothing at all —\n" +
    "  not the on-demand pdf.js chunk and not its worker\n" +
    `  (this run: ${JSON.stringify(pdfResources)}). Chromium lists both. BiDi also runs no preload\n` +
    "  script on a privileged document (`evaluateOnNewDocument` installs and never fires) and\n" +
    "  surfaces no dedicated workers (`page.workers()` is empty), so the suite watches the Worker\n" +
    "  constructor from inside the page instead.",
);
console.log(
  "NOTE · test infrastructure: Firefox's WebDriver BiDi reports neither a URL nor a load event for a\n" +
    "  moz-extension: document (page.url() stays \"about:blank\", page.goto always times out), and it\n" +
    "  refuses script evaluation there unless the browser was started with -remote-allow-system-access.\n" +
    "  Content-script console.log output is not relayed to the page's log either — only uncaught\n" +
    "  content-script exceptions surface, as page errors. See test/firefox-harness.mjs.",
);

console.log("\n" + (fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED"));

await browser.close();
await server.close();
await daemon.close().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
