// test/firefox.mjs — end-to-end test of the FIREFOX MV2 build, in a real Firefox.
//
// The Chromium suites (test/e2e.mjs, test/scenarios.mjs) drive Playwright; Playwright
// cannot load an extension into Firefox, so this one drives headless Firefox through
// puppeteer-core over WebDriver BiDi — see test/firefox-harness.mjs for the launch,
// the temporary install of output-test/firefox-mv2, and the fixed moz-extension:// origin.
//
// It runs against the same two things every other browser suite uses: the test-only fake
// fixture (test/fake-native.mjs, deterministic verdicts, no model) and the self-test page
// (test/selftest.html) served over http so the registered content script injects. What it
// asserts is what is DIFFERENT about Firefox, on top of "the product still works":
//
//   * MV2: a background PAGE, not a service worker, and browserAction instead of action;
//   * moz-extension:// pages (popup / options / onboarding) render and talk to it;
//   * Firefox 140 ESR, the manifest's floor, has no Navigation API, so a pushState route
//     swap is covered by the orchestrator's 2.5 s URL poll and is given ~6 s here;
//   * the Popover API (top-layer hover card) has a CSS fallback;
//   * the PDF reading mode is the one page where the whole pipeline runs on a
//     moz-extension: document, and it loads pdf.js and a MODULE WORKER from that origin;
//   * what the Chromium scenarios cover and Gecko could do its own way (10d): the MAIN-world
//     script and closed shadow roots, a really hidden tab, scroll order, Firefox's own
//     translation marks, consent frames, the surfaces and Defuddle chunks, the licences.
//
//   node test/firefox.mjs
//   node test/firefox.mjs --quick     # skip the fixture down/up cycle (~25 s)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { serveHtml, artifact } from "./harness.mjs";
import { createNativeFixture } from "./fake-native.mjs";
import {
  BADGE_SEL,
  EXT,
  EXT_UUID,
  GECKO_ID,
  launchFirefox,
  openExtensionPage,
  waitForExtensionPage,
  findPageByHref,
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

// ── 1) fake fixture + the self-test page over http ──────────────────────────────────
let fixture = await createNativeFixture();
// Served live: the checks in 10d) add their pages as they go.
const PAGES = { "/selftest.html": readFileSync(join(__dirname, "selftest.html"), "utf8") };
const server = await serveHtml(PAGES);
const pageUrl = server.url("/selftest.html");

// ── 2) headless Firefox + a temporary install of output-test/firefox-mv2 ───────────
const { browser, firefox, extId, extUrl } = await launchFirefox({ nativeFixture: fixture }).catch(async (e) => {
  console.error(e.message ?? e);
  await server.close();
  await fixture.close();
  process.exit(2);
});
console.log(`Firefox ${firefox.version} (${firefox.source})\n  ${firefox.executablePath}`);
console.log(`serving self-test at ${pageUrl} · fake fixture at ${fixture.label}`);
console.log(`installed ${extId} → moz-extension://${EXT_UUID}/`);
check("extension installs temporarily (BiDi webExtension.install)", extId === GECKO_ID, extId);

// The install fires runtime.onInstalled, which opens the onboarding tab itself — that is
// the first proof the MV2 background page ran at all.
const onboarding = await findPageByHref(browser, "onboarding.html", { timeout: 20000 });

// ── 3) options page: the background page answers, and the version string shows ─────

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
  /^v\d+\.\d+\.\d+ · Ready$/.test(versionText),
  versionText,
);

const backendStatus = await optionsPage
  .evaluate(() => browser.runtime.sendMessage({ action: "getBackendStatus", probe: true }))
  .catch((e) => ({ error: String(e).slice(0, 120) }));
check(
  "MV2 background page answers runtime.sendMessage (GET_BACKEND_STATUS)",
  !!backendStatus && backendStatus.active === "server" && backendStatus.server?.ok === true && backendStatus.model?.id === "fake-editlens",
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
  "non-English text never reaches the fixture (browser.i18n.detectLanguage gate)",
  fixture.stats.blocks > 5 && fixture.stats.nonEnglishBlocks === 0,
  `${fixture.stats.blocks} blocks, ${fixture.stats.nonEnglishBlocks} non-English`,
);

// ── 5) underlines: the CSS Custom Highlight API ────────────────────────────────────
check(
  "underlines: highlight ranges exist and cover the LONGTAIL marker",
  snapshot.highlightCount > 0 && snapshot.hl.longtail,
  `${snapshot.highlightCount} ranges, longtail=${snapshot.hl.longtail}`,
);

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
const underlineLive = await (async () => {
  const styleEl = () =>
    page.evaluate(() => {
      const el = document.querySelector('style[data-anagram="style"]');
      return el ? { disabled: el.disabled, css: el.textContent ?? "" } : null;
    });
  const before = await styleEl();
  // Underlines are all or nothing: switching them off disables the one stylesheet that
  // paints every mark, and switching them back on restores it, ranges and all.
  await optionsPage.evaluate(() => browser.storage.local.set({ showHighlights: false }));
  const off = await waitFor(page, () => document.querySelector('style[data-anagram="style"]')?.disabled === true, { timeout: 8000 });
  await optionsPage.evaluate(() => browser.storage.local.set({ showHighlights: true }));
  const on = await waitFor(page, () => document.querySelector('style[data-anagram="style"]')?.disabled === false, { timeout: 8000 });
  return { hadStyleEl: !!before, paintsTheScale: /::highlight\(anagram-s00\)/.test(before?.css ?? ""), off, on };
})();
check(
  "a setting written in the options page reaches an open tab live (underlines off and on)",
  underlineLive.hadStyleEl && underlineLive.paintsTheScale && underlineLive.off && underlineLive.on,
  JSON.stringify(underlineLive),
);

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
  .evaluate(async (url) => {
    const own = await browser.tabs.getCurrent();
    const before = await browser.browserAction.getBadgeText({ tabId: own.id });
    const rejected = await browser.runtime.sendMessage({ action: "updateBadge", flagged: 7 });
    const after = await browser.browserAction.getBadgeText({ tabId: own.id });
    const tab = (await browser.tabs.query({})).find((t) => t.url === url);
    const state = await browser.tabs.sendMessage(tab.id, { action: "getTabState" }, { frameId: 0 });
    const actual = await browser.browserAction.getBadgeText({ tabId: tab.id });
    return { before, after, rejected, actual, expected: state.flagged > 0 ? String(state.flagged) : "" };
  }, await page.evaluate(() => location.href)) // the pushState route swap above moved it
  .catch((e) => ({ error: String(e).slice(0, 200) }));
check(
  "MV2 toolbar badge follows the actual content frame and rejects Settings spoofing",
  badgeApi.rejected?.ok === false && badgeApi.before === badgeApi.after && badgeApi.actual === badgeApi.expected,
  JSON.stringify(badgeApi),
);

// ── 10b) the PDF reading mode ──────────────────────────────────────────────────────
// A browser hands a PDF to a viewer that exposes no DOM text, so the reader rebuilds the
// document on an extension page of its own and runs the ORDINARY pipeline over it. That
// is the only place where pdf.js, a module worker and the orchestrator all run on a
// moz-extension: document — three things Firefox could do differently, and the suite that
// would notice is this one. The PDF is the one test/scenarios.mjs opens in Chromium
// (test/pdf-fixture.mjs), supplied here as local File bytes.
const readerErrors = [];

/**
 * Exercise the document drop handler. BiDi cannot operate the native picker, so the
 * bytes travel as base64 and become a File in the extension page.
 */
const dropPdf = async (page, buffer, name) => {
  if (!await waitFor(page, () => document.getElementById("drop")?.hidden === false, { timeout: 25000 })) return false;
  return page
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
};
const renderPdfPages = async (page) => {
  if (!await waitFor(page, () => !!window.PDFViewerApplication?.pdfDocument, { timeout: 30000 })) return false;
  const count = await page.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages);
  for (const number of [...Array.from({ length: count }, (_, i) => i + 1), 1]) {
    await page.evaluate((n) => { window.PDFViewerApplication.page = n; }, number);
    if (!await waitFor(page, (n) => window.PDFViewerApplication.pdfViewer.getPageView(n - 1)?.renderingState === 3 &&
      !!document.querySelector(`#viewer .page[data-page-number="${n}"] .textLayer span`), { timeout: 30000, arg: number })) return false;
  }
  return true;
};
{
  // File/drop rendering is independent of source grants. Authorized online loading
  // through the popup/private loader is covered by pdf-source-firefox.mjs.
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
  const rendered = arrived && (await renderPdfPages(p));
  const scored = rendered &&
    (await waitFor(p, (sel) => {
      const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
      return pills.length > 0 && !pills.some((h) => h.shadowRoot.querySelector(".pill.pending"));
    }, { timeout: 30000, arg: BADGE_SEL }));
  // The paragraphs come from Zotero's document-worker once it has read the whole file: its
  // pdf.js, and an ONNX model run by onnxruntime-web's WebAssembly under the MV2 policy.
  const structured = rendered &&
    (await waitFor(p, () => performance.getEntriesByName("anagram-structured").length > 0, { timeout: 30000 }));
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
        };
      }, BADGE_SEL)
    : null;
  console.log("PDF READER:", JSON.stringify(pdf).slice(0, 400));
  check(
    "PDF reader: Gecko draws the real pages and builds a text layer over each of them",
    !!pdf &&
      pdf.pages === 2 &&
      pdf.drawn === 2 &&
      pdf.spans > 0 &&
      pdf.text.includes(PDF_HEADING) &&
      pdf.text.includes(PDF_HEAD),
    JSON.stringify({ pages: pdf?.pages, drawn: pdf?.drawn, spans: pdf?.spans, notice: pdf?.notice }),
  );
  check(
    "PDF reader: Zotero's document-worker reads the paragraphs (ONNX model in WebAssembly under the MV2 policy)",
    !!structured,
    JSON.stringify(await p.evaluate(() => performance.getEntriesByType("measure").map((e) => e.name)).catch(() => null)),
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
// document, so the constructor is watched instead — on a
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
  const read = dropped && (await renderPdfPages(p));
  const workers = arrived ? await p.evaluate(() => window.__workers ?? null).catch(() => null) : null;
  check(
    "PDF reader: a dropped file is read, and pdf.js parses it in a MODULE WORKER from moz-extension://",
    read &&
      Array.isArray(workers) &&
      workers.some((w) => w.startsWith(`moz-extension://${EXT_UUID}/vendor/start/pdf.worker.mjs`) && w.endsWith("|module")),
    JSON.stringify({ read, workers }),
  );
  await p.close();
}

// ── 10c) Firefox has a popup entry, but no content-script-dependent link menu ────────
// The popup/private loader handles authorized remote PDFs. The link context menu still
// uses the Chrome tab-script route, so it remains absent in Firefox. Probe its exact ID.
{
  const absent = await optionsPage
    .evaluate(
      () =>
        new Promise((resolve) => {
          browser.contextMenus.create({ id: "anagram-open-pdf", title: "probe", contexts: ["link"] }, () => {
            const clash = !!browser.runtime.lastError;
            if (!clash) Promise.resolve(browser.contextMenus.remove("anagram-open-pdf")).catch(() => undefined);
            resolve(!clash);
          });
        }),
    )
    .catch((e) => String(e));
  check(
    "Firefox uses the popup PDF entry rather than the Chrome tab-script link menu",
    absent === true,
    String(absent),
  );
}

// ── 10d) what the Chromium scenarios cover, where Firefox could differ ─────────────
// Each is a smaller copy of its case in test/scenarios.mjs, run on the Firefox build.
const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
/** A paragraph over the 75-word floor, its words set by `i` so that no two are alike. */
const para = (tag, i = 0) => `${tag}-${i} ` + Array.from({ length: 84 }, (_, k) => VOCAB[(i * 7 + k * 13) % VOCAB.length]).join(" ") + ".";
const html = (title, body, lang = "en") => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">${body}</body></html>`;
const sentSince = (n, marker) => fixture.stats.texts.slice(n).filter((t) => t.includes(marker)).length;
const chipsIn = (p, css) => p.evaluate(({ css, sel }) => document.querySelectorAll(`${css} ${sel}`).length, { css, sel: BADGE_SEL });

// The page-world script (entrypoints/shadow.content.ts) is registered in the MAIN world,
// and a shadow root attached after the walk — open, or closed — is read.
{
  const registered = await optionsPage
    .evaluate(async () => (await browser.scripting.getRegisteredContentScripts()).map((s) => `${s.id}:${s.world ?? "ISOLATED"}`))
    .catch((e) => [String(e)]);
  PAGES["/shadow.html"] = html("late and closed shadow roots", `<late-card id="lc"></late-card><closed-card id="cc"></closed-card><div id="cd"></div>
<script>
  window.__closed = {};
  customElements.define("closed-card", class extends HTMLElement {
    constructor() { super(); window.__closed.cc = this.attachShadow({ mode: "closed" }); window.__closed.cc.innerHTML = "<p>${para("CLOSEDCARD")}</p>"; }
  });
  setTimeout(() => customElements.define("late-card", class extends HTMLElement {
    connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<p>${para("LATECARD", 1)}</p>"; }
  }), 1500);
  setTimeout(() => {
    window.__closed.cd = document.getElementById("cd").attachShadow({ mode: "closed" });
    window.__closed.cd.innerHTML = "<p>${para("CLOSEDDIV", 2)}</p>";
  }, 2000);
</script>`);
  const p = await browser.newPage();
  await p.goto(server.url("/shadow.html"), { waitUntil: "load" });
  const count = () =>
    p.evaluate((sel) => ({
      lc: document.getElementById("lc")?.shadowRoot?.querySelectorAll(sel).length ?? -1,
      cc: window.__closed.cc?.querySelectorAll(sel).length ?? -1,
      cd: window.__closed.cd?.querySelectorAll(sel).length ?? -1,
    }), BADGE_SEL);
  await waitFor(p, (sel) => [document.getElementById("lc")?.shadowRoot, window.__closed.cc, window.__closed.cd].every((r) => (r?.querySelectorAll(sel).length ?? 0) > 0), { timeout: 15000, arg: BADGE_SEL });
  const r = await count();
  check(
    "the page-world script is registered in the MAIN world, and a shadow root attached after the walk is read",
    registered.includes("anagram-shadow:MAIN") && r.lc === 1,
    JSON.stringify({ registered, lc: r.lc }),
  );
  check("a closed shadow root is read (openOrClosedShadowRoot): a custom element's at load, a <div>'s attached later", r.cc === 1 && r.cd === 1, JSON.stringify(r));
  await p.close();
}

// A tab in the background sends nothing, not even the idle prefetch, and picks up where it
// was once it is shown. Here the tab is really hidden: another one is brought in front of it.
{
  PAGES["/hidden.html"] = html("hidden fixture", `<main id="top">${[0, 1].map((i) => `<p>${para("SHOWNFIRST", i)}</p>`).join("")}</main><div style="height:5000px"></div><div id="bottom"></div>`);
  const p = await browser.newPage();
  await p.goto(server.url("/hidden.html"), { waitUntil: "load" });
  await waitFor(p, (sel) => document.querySelectorAll(`#top ${sel}`).length === 2, { timeout: 15000, arg: BADGE_SEL });
  const front = await browser.newPage();
  const hidden = await waitFor(p, () => document.visibilityState === "hidden", { timeout: 5000 });
  const before = fixture.stats.texts.length;
  await p.evaluate(([onScreen, below]) => {
    const add = (where, id, text) => Object.assign(where.appendChild(document.createElement("p")), { id, textContent: text });
    add(document.getElementById("top"), "hid-top", onScreen);
    add(document.getElementById("bottom"), "hid-bottom", below);
  }, [para("WHILEHIDDEN", 3), para("WHILEHIDDEN", 4)]);
  await sleep(2500);
  const quiet = (await chipsIn(p, "#hid-top")) + (await chipsIn(p, "#hid-bottom"));
  const sent = sentSince(before, "WHILEHIDDEN");
  await front.close();
  await p.bringToFront();
  const shown = await waitFor(p, (sel) => document.querySelectorAll(`#hid-top ${sel}`).length === 1, { timeout: 10000, arg: BADGE_SEL });
  check(
    "a hidden tab dispatches nothing, not even the idle prefetch, and resumes when shown",
    hidden && quiet === 0 && sent === 0 && shown,
    JSON.stringify({ hidden, chipsWhileHidden: quiet, sentWhileHidden: sent, shown }),
  );
  await p.close();
}

// A reader flicks through ninety paragraphs while the engine is slow: what is on screen when
// the scroll stops is sent before anything scrolled far past.
{
  PAGES["/scroll.html"] = html("scroll fixture", Array.from({ length: 90 }, (_, i) => `<p id="sp${i}">${para("SCROLLPAST", i)}</p>`).join("\n"));
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(() => {
    window.__chipAt = {};
    new MutationObserver(() => {
      for (const host of document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)')) {
        const el = host.closest("p[id]");
        if (el && !(el.id in window.__chipAt)) window.__chipAt[el.id] = performance.now();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  fixture.setState({ latency: [700, 700] });
  await p.goto(server.url("/scroll.html"), { waitUntil: "load" });
  await waitFor(p, () => Object.keys(window.__chipAt ?? {}).length > 0, { timeout: 12000 });
  const end = await p.evaluate(async () => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const step = Math.round(innerHeight * 0.9);
    const bottom = document.documentElement.scrollHeight - innerHeight;
    for (let y = step; y < bottom; y += step) {
      scrollTo(0, y);
      await frames();
    }
    scrollTo(0, bottom);
    await frames();
    const rows = [...document.querySelectorAll("p[id]")].map((el) => ({ id: el.id, box: el.getBoundingClientRect() }));
    return {
      t0: performance.now(),
      onScreen: rows.filter((r) => r.box.bottom > 0 && r.box.top < innerHeight).map((r) => r.id),
      far: rows.filter((r) => r.box.bottom < -1500).map((r) => r.id),
    };
  });
  const allOnScreen = await waitFor(p, (ids) => ids.every((id) => id in window.__chipAt), { timeout: 40000, arg: end.onScreen });
  const r = await p.evaluate(({ onScreen, far, t0 }) => {
    const at = window.__chipAt;
    const last = Math.max(...onScreen.map((id) => at[id] ?? Infinity));
    const after = t0 + 100;
    return {
      onScreen: onScreen.length,
      far: far.length,
      farFirst: far.filter((id) => at[id] > after && at[id] < last).length,
      waitMs: Math.round(last - t0),
    };
  }, end);
  fixture.setState({ latency: [60, 160] });
  check(
    "a fast scroll: what is on screen when it stops is sent before anything scrolled far past",
    allOnScreen && r.onScreen > 0 && r.far > 20 && r.farFirst === 0,
    JSON.stringify(r),
  );
  await p.close();
}

// Firefox's full-page translation relabels <html lang> when it starts (the Firefox build
// alone reads that as a translation, lib/surface.ts) and numbers the elements of a block
// with data-moz-translations-id while it translates it. Modelled: the real one downloads
// its models from Mozilla.
for (const how of ["lang", "ids"]) {
  const path = `/translated-${how}.html`;
  PAGES[path] = html("translated fixture", `<main>${[0, 1].map((i) => `<p id="t${i}">ORIGINAL-${how} ${para("TRANSLATE", i + 5)}</p>`).join("")}</main>
<script>
  window.__translate = () => {
    ${how === "lang" ? `document.documentElement.lang = "en";` : ""}
    for (const p of document.querySelectorAll("main p")) {
      ${how === "ids" ? `p.dataset.mozTranslationsId = "1";` : ""}
      p.firstChild.data = p.firstChild.data.replace("ORIGINAL", "MACHINE");
      ${how === "ids" ? `delete p.dataset.mozTranslationsId;` : ""}
    }
  };
</script>`, "de");
  const p = await browser.newPage();
  await p.goto(server.url(path), { waitUntil: "load" });
  const settled = await waitFor(p, (sel) => {
    const hosts = [...document.querySelectorAll(sel)];
    return hosts.length === 2 && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
  }, { timeout: 15000, arg: BADGE_SEL });
  const before = fixture.stats.texts.length;
  await p.evaluate(() => window.__translate());
  await sleep(3000);
  const during = await p.evaluate((sel) => ({ chips: document.querySelectorAll(sel).length, ball: !!document.getElementById("anagram-fab") }), BADGE_SEL);
  const href = await p.evaluate(() => location.href);
  const state = await optionsPage
    .evaluate(async (url) => {
      const tab = (await browser.tabs.query({})).find((t) => t.url === url);
      return browser.tabs.sendMessage(tab.id, { action: "getTabState" }, { frameId: 0 });
    }, href)
    .catch(() => null);
  const machineSent = sentSince(before, "MACHINE-");
  check(
    `a page Firefox translates (${how === "lang" ? "<html lang> relabelled" : "data-moz-translations-id"}): nothing is read or left on it`,
    settled && during.chips === 0 && !during.ball && machineSent === 0 && state?.translated === true,
    JSON.stringify({ settled, during, machineSent, translated: state?.translated }),
  );
  await p.close();
}

// A consent platform's banner in a frame of its own is not read, while an ordinary frame
// from the same address is: Sourcepoint on the publisher's domain, known by its address.
{
  const cross = server.base.replace("localhost", "127.0.0.1");
  PAGES["/index.html"] = html("SP Consent Message", `<div id="notice" class="message type-modal" role="dialog" aria-label="Privacy notice"><p class="message-component">${para("SPFRAME", 6)}</p><button>Accept all</button></div>`);
  PAGES["/plain.html"] = html("an ordinary frame", `<p>${para("PLAINFRAME", 7)}</p>`);
  PAGES["/consent-top.html"] = html("consent frames", `<p id="topp">${para("CONSENTHOST", 8)}</p>
<div id="sp_message_container_1001"><iframe id="sp_message_iframe_1001" title="SP Consent Message" src="${cross}/index.html?message_id=1001&amp;requestUUID=00000000-0001" width="640" height="300"></iframe></div>
<iframe id="plain" src="${cross}/plain.html" width="640" height="300"></iframe>`);
  const before = fixture.stats.texts.length;
  const p = await browser.newPage();
  await p.goto(server.url("/consent-top.html"), { waitUntil: "load" });
  await waitFor(p, (sel) => document.querySelectorAll(`#topp ${sel}`).length > 0, { timeout: 15000, arg: BADGE_SEL });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && sentSince(before, "PLAINFRAME") === 0) await sleep(250);
  await sleep(1500);
  const r = { top: await chipsIn(p, "#topp"), plain: sentSince(before, "PLAINFRAME"), consent: sentSince(before, "SPFRAME") };
  check(
    "a consent platform's frame is not read, an ordinary frame from the same address and the page around it are",
    r.top === 1 && r.plain > 0 && r.consent === 0,
    JSON.stringify(r),
  );
  await p.close();
}

// A srcdoc frame (an EPUB reader's chapter), an about:blank frame and a blob: document take
// the page's origin and are read; a sandboxed frame has none and is left alone.
{
  const doc = (tag, i) => `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:12px;font:15px/1.6 system-ui"><p>${para(tag, i)}</p></body></html>`;
  const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  PAGES["/frames-local.html"] = html("frames without an address", `<iframe id="srcdoc" srcdoc="${attr(doc("SRCDOCFRAME", 17))}" width="640" height="300"></iframe>
<iframe id="blank" width="640" height="300"></iframe>
<iframe id="blob" width="640" height="300"></iframe>
<iframe id="sandboxed" sandbox srcdoc="${attr(doc("SANDBOXEDFRAME", 18))}" width="640" height="300"></iframe>
<script>
  document.getElementById("blank").contentDocument.body.innerHTML = ${JSON.stringify(`<p style="font:15px/1.6 system-ui">${para("BLANKFRAME", 19)}</p>`)};
  document.getElementById("blob").src = URL.createObjectURL(new Blob([${JSON.stringify(doc("BLOBFRAME", 20))}], { type: "text/html" }));
</script>`);
  const before = fixture.stats.texts.length;
  const p = await browser.newPage();
  await p.goto(server.url("/frames-local.html"), { waitUntil: "load" });
  const inFrame = (id) => p.evaluate(({ id, sel }) => document.getElementById(id)?.contentDocument?.querySelectorAll(sel).length ?? -1, { id, sel: BADGE_SEL });
  await waitFor(p, (sel) => ["srcdoc", "blank", "blob"].every((id) => (document.getElementById(id)?.contentDocument?.querySelectorAll(sel).length ?? 0) > 0), { timeout: 15000, arg: BADGE_SEL });
  await sleep(1500);
  const r = { srcdoc: await inFrame("srcdoc"), blank: await inFrame("blank"), blob: await inFrame("blob"), sandboxedSent: sentSince(before, "SANDBOXEDFRAME") };
  // Known on Firefox 140 (153 reads it): an about:blank frame the page fills while it is
  // still being parsed, still "uninitialized", is read only once something in it changes.
  const blankKnownMiss = firefox.major < 153 && r.blank === 0;
  check(
    "a srcdoc, an about:blank and a blob: frame are read by the page's origin, a sandboxed frame is left alone",
    r.srcdoc === 1 && (r.blank === 1 || blankKnownMiss) && r.blob === 1 && r.sandboxedSent === 0,
    JSON.stringify(r) + (blankKnownMiss ? " (Firefox 140: the about:blank frame filled during parsing is not read)" : ""),
  );
  await p.close();
}

// A PDF shown by pdf.js inside a web page is read by the surfaces chunk (lib/surfaces/),
// which the content script imports by its extension URL.
{
  PAGES["/pdfjs-viewer.html"] = readFileSync(join(__dirname, "fixtures", "surfaces", "pdfjs-viewer.html"), "utf8");
  const before = fixture.stats.texts.length;
  const p = await browser.newPage();
  await p.goto(server.url("/pdfjs-viewer.html"), { waitUntil: "load" });
  const chipped = await waitFor(p, (sel) => document.querySelectorAll(`.page > [data-anagram] > [data-chip] > ${sel}`).length >= 4, { timeout: 25000, arg: BADGE_SEL });
  const r = {
    chipped,
    inLayer: await p.evaluate((sel) => document.querySelectorAll(`.textLayer ${sel}, .textLayer [data-anagram]`).length, BADGE_SEL),
    mended: sentSince(before, "notice what is different about each one") > 0,
    acrossPages: sentSince(before, "by the afternoon boat. The new keeper") > 0,
  };
  check("a pdf.js viewer in a web page: paragraphs rebuilt across columns and pages, chips over the page", r.chipped && r.inLayer === 0 && r.mended && r.acrossPages, JSON.stringify(r));
  await p.close();
}

// "Main content only" finds the article with Defuddle, an on-demand chunk the content
// script imports. The comments below the post hold most of the page's text, so the
// text-mass probe Anagram falls back on without Defuddle would take them for the article;
// Defuddle leaves comments out. Its phrases are located on the page, so every paragraph
// here is its own draw of words: para()'s rotations would share them.
{
  const OTHER = "readers argued about harbours ferries lighthouses keepers storms gulls nets tides pilots moorings beacons fog horns charts compasses anchors decks masts sails ropes knots cargo crews ports quays".split(" ");
  const prose = (tag, i, words) => {
    let s = i * 7919 + 1;
    return `${tag}-${i} ` + Array.from({ length: 84 }, () => words[(s = (s * 48271) % 2147483647) % words.length]).join(" ") + ".";
  };
  PAGES["/scope-defuddle.html"] = html("A post and its comments", `<div id="post" class="entry-content"><h1>A post and its comments</h1>${[9, 10, 11].map((i) => `<p>${prose("POSTBODY", i, VOCAB)}</p>`).join("")}</div>
<div id="comments" class="comments"><h2>Comments</h2>${[12, 13, 14, 15, 16].map((i) => `<div class="comment"><p>${prose("COMMENTBODY", i, OTHER)}</p></div>`).join("")}</div>`);
  await optionsPage.evaluate(() => browser.storage.local.set({ analysisScope: "main" }));
  const before = fixture.stats.texts.length;
  const p = await browser.newPage();
  await p.goto(server.url("/scope-defuddle.html"), { waitUntil: "load" });
  await waitFor(p, (sel) => document.querySelectorAll(sel).length > 0, { timeout: 15000, arg: BADGE_SEL });
  await sweep(p, 3);
  await sleep(2000);
  const r = { post: await chipsIn(p, "#post"), comments: await chipsIn(p, "#comments"), commentsSent: sentSince(before, "COMMENTBODY") };
  await optionsPage.evaluate(() => browser.storage.local.set({ analysisScope: "page" }));
  check("main-content scope: Defuddle loads on demand and takes the post, not the comments", r.post === 3 && r.comments === 0 && r.commentsSent === 0, JSON.stringify(r));
  await p.close();
}

// Every licence the build owes is in it.
{
  const text = (path) => { try { return readFileSync(join(EXT, path), "utf8"); } catch { return ""; } };
  const missing = [
    ["LICENSE", "GNU AFFERO GENERAL PUBLIC LICENSE"],
    ["vendor/pdfjs/LICENSE", "Apache License"],
    ["vendor/document-worker/LICENSE.document-worker", "GNU AFFERO GENERAL PUBLIC LICENSE"],
    ["vendor/document-worker/LICENSE.pdfjs", "Apache License"],
    ["vendor/document-worker/LICENSE.onnxruntime-web", "MIT License"],
    ["vendor/wasm/LICENSE_OPENJPEG", "BSD License"],
    ["vendor/wasm/LICENSE_JBIG2", "PDFium Authors"],
    ["vendor/standard_fonts/LICENSE_FOXIT", "PDFium Authors"],
    ["vendor/standard_fonts/LICENSE_LIBERATION", "SIL Open Font License"],
    ["vendor/defuddle.min.mjs", "MIT License, Copyright (c) 2025 Steph Ango"],
  ].filter(([path, needle]) => !text(path).includes(needle)).map(([path]) => path);
  check("the Firefox build carries its own and every bundled component's licence", missing.length === 0, missing.join(", "));
}

// ── 11) screenshot ─────────────────────────────────────────────────────────────────
const shot = artifact("firefox-screenshot.png");
await page.evaluate(() => window.scrollTo(0, 0));
await page
  .screenshot({ path: shot, fullPage: true })
  .catch(() => page.screenshot({ path: shot }))
  .then(() => console.log("screenshot:", shot))
  .catch((e) => console.log("screenshot failed:", String(e).slice(0, 120)));

// ── 11b) the idle prefetch lane ────────────────────────────────────────────────────
// Scoring is viewport-first and everything else is drained by an idle-time background
// lane, so a page that is never scrolled still ends up fully scored. It once stopped at the
// first viewport here: Gecko refuses a requestIdleCallback called off `window`.
{
  const p = await browser.newPage();
  await setViewportSafe(p);
  await p.goto(pageUrl, { waitUntil: "load" });
  await sleep(7000); // no scrolling at all
  const n = await p.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL);
  await p.close();
  check("a page that is never scrolled is scored whole by the idle lane", n === snapshot.badgeTotal, `${n} of ${snapshot.badgeTotal}`);
}

// ── 12) fixture down → "Unavailable" + "!" counter; fixture back → re-queued ─────────
if (QUICK) {
  skip("fixture down → Unavailable chip + '!' counter; fixture back → re-queued", "--quick");
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
        `${pid.toUpperCase()} paragraph is appended while the scoring fixture is stopped, so ` +
        "the extension must not invent a verdict for it: the batch that hits the dead socket renders as " +
        "Unavailable and later paragraphs wait without any chip, until a health probe succeeds again and " +
        "every waiting or unavailable unit is queued once more without a reload or a manual rescan. " +
        "Till then, a reader has to be able to tell a unit that waits from one that was read, and a fault from a verdict.";
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

  await fixture.close(); // connection refused from here on
  await addPara("down1");
  const gotDown1 = await settledIn("down1", 12000);
  const band1 = await bandOf("down1");
  await addPara("down2");
  await sleep(2500);
  const down2Chips = await p.evaluate((sel) => document.querySelectorAll(`#down2 ${sel}`).length, BADGE_SEL);
  const counterDown = await counter();
  check(
    "fixture down: in-flight batch renders 'Unavailable', later paragraphs get no chip, counter shows '!'",
    gotDown1 && band1 === "band-unknown" && down2Chips === 0 && counterDown === "!",
    JSON.stringify({ band1, down2Chips, counterDown }),
  );

  await fixture.resume();
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
    "fixture back: waiting and 'Unavailable' units are re-queued automatically",
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
console.log("\n" + (fail === 0 ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED"));

await browser.close();
await server.close();
await fixture.close().catch(() => {});
process.exit(fail === 0 ? 0 : 1);
