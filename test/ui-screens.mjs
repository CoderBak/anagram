// test/ui-screens.mjs — screenshots of the setup page, Settings, the toolbar menu over a page with
// chips, a page Anagram is off for, a PDF tab and the PDF reader, and of those pages themselves,
// for a reviewer: English and Chinese, light and dark, in a temporary profile each.
//
//   node test/ui-screens.mjs <output dir> [apple,linux,chips]   (LANGS=en SCHEMES=light narrow it)
//
// The setup page and Settings are shown on stand-in devices (test/pw/devices.mjs) with the
// in-browser engine's states scripted into them (test/webengine/scripted-engine.mjs).
// For the chips, point ANAGRAM_MODELKIT at the pinned detector snapshot.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchExtension, uiLanguage, uiLanguageOf, BADGE_SEL, serveHtml } from "./harness.mjs";
import { deviceBuild } from "./test-build.mjs";
import { DEVICES } from "./pw/devices.mjs";
import { scriptEngine } from "./webengine/scripted-engine.mjs";
import { NO_MODEL_HOSTS } from "./webengine/model-server.mjs";
import { withScreenshotDetector } from "./webengine/screenshot-detector.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";

const out = resolve(process.argv[2] ?? "ui-screens");
mkdirSync(out, { recursive: true });

const only = process.argv[3] ?? "";
const LANGS = (process.env.LANGS ?? "en,zh-CN").split(",").map((l) => [l, l === "en" ? "en" : "zh"]);
const SCHEMES = (process.env.SCHEMES ?? "light,dark").split(",");
const wanted = (group) => !only || only.split(",").includes(group);

// Sample passages give flagged entries distinct, readable excerpts in the toolbar menu.
const passages = [
  "The old ticket booth now serves the town on Saturdays as a book exchange. There is one shelf for books that people can take away and another for books they promise to bring back. The second shelf belongs to the children at the village school. They write their names inside the covers in pencil and leave a note for the next reader. The woman who unlocks the booth keeps a little stack of fresh paper beside the door.",
  "At high tide the lower steps disappear under the water. For years the boat crews marked the highest tide of each winter on a wooden post beside the ramp. When the post began to rot, a carpenter from the village took it home and cut the marked side into a thin plank. It now hangs just inside the waiting room door. People coming in out of the rain often pause beside it to find the year they were born.",
  "The first ferry leaves before sunrise. At the ticket window, the clerk keeps a little tin of chalk for the board that hangs beside the door. Each morning she walks down to the landing before she writes the time of the next crossing. A strong wind can push the boat well past the pier, and it takes a while to bring it back around. The regular passengers know to look at the board before they buy their tea.",
  "At the landing, the benches still face the water. They stood in pairs until the year the road was widened and the outside row had to go. On a clear day you can sit at the far end and watch the boat all the way across to the island. In winter the view seldom reaches that far. People come down anyway, carrying cups of tea from the shop and stopping to talk before they walk home.",
];
const SHORT_NOTE = "The last ferry leaves at six on Sundays.";
const MID_NOTE = "The harbor road closes at dusk, but the ferry keeps its own timetable through the winter. Locals buy bread early and post their letters before noon. The last crossing is usually quiet enough for the crew to sit on the steps and finish a cup of tea before they tie up the boat.";
const chipsHtml = (dark) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes from the harbor</title></head>
<body style="margin:0;${dark ? "background:#0d1117;color:#e6edf3" : "background:#fff;color:#1a1a1a"}"><div style="max-width:680px;margin:0 auto;padding:32px 24px;font:16px/1.65 Georgia,serif">
<h1 style="font:600 22px system-ui">Notes from the harbor</h1>
${passages.map((text) => `<p>${text}</p>`).join("\n")}
<h2 style="font:600 18px system-ui">Ferry times</h2>
<p>${SHORT_NOTE}</p>
<h2 style="font:600 18px system-ui">Winter crossings</h2>
<p>${MID_NOTE}</p></div></body></html>`;

async function painted(page) {
  await page.waitForFunction(() => {
    const s = document.querySelector("#componentSettings .component-status");
    const choice = document.querySelector(".engine-choice:not([hidden]) .engine-choice-card, .engine-cannot:not([hidden])");
    return (s && s.textContent && s.textContent !== "Starting…") || !!choice;
  }, null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(700);
}

async function run(build, lang, body) {
  const language = lang === "en" ? {} : uiLanguage(lang);
  const launched = await launchExtension({ extDir: build, ...language, args: [...(language.args ?? []), NO_MODEL_HOSTS] });
  try {
    if (lang !== "en") {
      const got = (await uiLanguageOf(launched.sw))?.replace("_", "-").toLowerCase();
      if (got !== lang.toLowerCase()) throw new Error(`the browser came up in ${got}, not ${lang}`);
    }
    await body(launched);
  } finally { await launched.context.close(); }
}

async function shot(ctx, { file, url, scheme, width, script, ready = painted, popup = false }) {
  const page = await ctx.context.newPage();
  await page.setViewportSize({ width, height: popup ? 600 : 900 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" });
  if (script) await script(page);
  await page.goto(url);
  await ready(page);
  if (popup) await capturePopup(page, file);
  else await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

// Chromium sizes the toolbar window to the popup document, up to its 600px height limit.
async function capturePopup(page, path) {
  await page.locator("html").screenshot({ path, animations: "disabled" });
}

/**
 * The toolbar menu as it opens over `target`: its page at native width, believing `target` is the
 * active tab — everything else (the page's answers, the worker's) is the real thing.
 */
async function popupOver(ctx, target, { file, scheme, breakdownFile, actionBesideTitle = false }) {
  // An extension page's address is one the menu is not told (the reader's): it gets the id alone.
  const own = target.url().startsWith("chrome-extension://");
  const url = own ? undefined : target.url();
  const tabId = own
    ? await target.evaluate(async () => (await chrome.tabs.getCurrent())?.id)
    : await ctx.sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, url);
  const popup = await ctx.context.newPage();
  await popup.setViewportSize({ width: 300, height: 600 });
  await popup.emulateMedia({ colorScheme: scheme });
  await popup.addInitScript(({ tabId, url }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (info, ...rest) => (info?.active ? Promise.resolve([{ id: tabId, url, active: true, windowId: -1, index: 0 }]) : query(info, ...rest));
  }, { tabId, url });
  await popup.goto(`chrome-extension://${ctx.extId}/popup.html`);
  await popup.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
  await popup.waitForTimeout(1500);
  if (actionBesideTitle) {
    const title = await popup.locator("h1").boundingBox();
    const action = await popup.locator(".page-actions > button:visible").boundingBox();
    if (!action || action.y >= title.y + title.height || action.y + action.height <= title.y) {
      throw new Error(`The page action is on a row by itself in ${file}`);
    }
  }
  await capturePopup(popup, file);
  if (breakdownFile) {
    await popup.locator("#pageReport summary").click();
    await capturePopup(popup, breakdownFile);
  }
  await popup.close();
}

const apple = deviceBuild("apple-silicon", DEVICES["apple-silicon"]);
const linux = deviceBuild("linux-cpu", DEVICES["linux-cpu"]);

for (const [lang, tag] of LANGS) {
  const filename = (what, scheme) => join(out, `${what}-${tag}-${scheme}.png`);
  for (const scheme of SCHEMES) {
    const name = (what) => filename(what, scheme);
    if (wanted("apple")) await run(apple, lang, async (ctx) => {
      const u = (p) => `chrome-extension://${ctx.extId}/${p}`;
      await shot(ctx, { file: name("landing-choice"), url: u("onboarding.html"), scheme, width: 900, script: (p) => scriptEngine(p, "needed", { engine: null }) });
      await shot(ctx, { file: name("settings-ready"), url: u("options.html"), scheme, width: 900, script: (p) => scriptEngine(p, "ready_gpu") });
    });
    if (wanted("linux")) await run(linux, lang, async (ctx) => {
      const u = (p) => `chrome-extension://${ctx.extId}/${p}`;
      await shot(ctx, { file: name("landing-downloading"), url: u("onboarding.html"), scheme, width: 900, script: (p) => scriptEngine(p, "downloading") });
      await shot(ctx, { file: name("landing-mirror"), url: u("onboarding.html"), scheme, width: 900, script: (p) => scriptEngine(p, "mirror") });
      await shot(ctx, { file: name("landing-ready"), url: u("onboarding.html"), scheme, width: 900, script: (p) => scriptEngine(p, "ready_gpu") });
      const popupReady = (page) => page.waitForFunction(() => !document.getElementById("action")?.disabled, null, { timeout: 10000 }).then(() => page.waitForTimeout(500));
      await shot(ctx, { file: name("popup-downloading"), url: u("popup.html"), scheme, width: 300, popup: true, script: (p) => scriptEngine(p, "downloading"), ready: popupReady });
      await shot(ctx, { file: name("popup-ready"), url: u("popup.html"), scheme, width: 300, popup: true, script: (p) => scriptEngine(p, "ready_gpu"), ready: popupReady });
    });
  }
  if (wanted("chips")) await withScreenshotDetector(lang, async (ctx) => {
    for (const scheme of SCHEMES) {
      const name = (what) => filename(what, scheme);
      const site = await serveHtml({ "/chips.html": chipsHtml(scheme === "dark"), "/doc.pdf": TEST_PDF });
      try {
        await ctx.sw.evaluate(() => chrome.storage.local.set({ autoOpenPdfs: false }));
        const page = await ctx.context.newPage();
        await page.setViewportSize({ width: 900, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(site.url("/chips.html"));
        await page.waitForFunction(({ selector, count }) => {
          const hosts = [...document.querySelectorAll(selector)];
          return hosts.filter(h => h.shadowRoot?.querySelector(".pill.scored")).length >= count &&
            hosts.every(h => !h.shadowRoot?.querySelector(".pill.pending"));
        }, { selector: BADGE_SEL, count: passages.length + 1 }, { timeout: 90_000 });
        // Pin the third score and show the model's sentence labels.
        const chip = page.locator(BADGE_SEL).filter({ has: page.locator(".pill.scored") }).nth(2);
        await chip.scrollIntoViewIfNeeded();
        await chip.locator(".pill").click();
        const card = chip.locator(".card");
        await card.waitFor({ state: "visible" });
        const labels = await ctx.sw.evaluate(() => ["bandHuman", "bandAssisted", "bandAi"].map(key => chrome.i18n.getMessage(key)));
        const rendered = await card.locator(".drow .dk").allTextContents();
        if (JSON.stringify(rendered) !== JSON.stringify(labels) || !await card.locator(".sentence-labels").count()) {
          throw new Error(`Unexpected paragraph breakdown: ${rendered.join(", ")}`);
        }
        await card.locator(".sentence-labels summary").click();
        await page.screenshot({ path: name("chips"), fullPage: true, animations: "disabled" });
        await chip.locator(".pill").click();
        await page.mouse.move(5, 5);
        // The toolbar menu over that page: everything Anagram offers on a page is in it.
        await popupOver(ctx, page, { file: name("popup-page"), breakdownFile: name("popup-breakdown"), scheme });
        // …over a page it is off for (a site rule), and over a PDF tab.
        await ctx.sw.evaluate((host) => chrome.storage.local.set({ siteOverrides: { [host]: "off" } }), new URL(site.url("/chips.html")).hostname);
        const off = await ctx.context.newPage();
        await off.goto(site.url("/chips.html"));
        await off.waitForTimeout(800);
        await popupOver(ctx, off, { file: name("popup-off"), scheme, actionBesideTitle: true });
        await off.close();
        await ctx.sw.evaluate(() => chrome.storage.local.set({ siteOverrides: {} }));
        const pdf = await ctx.context.newPage();
        await pdf.goto(site.url("/doc.pdf")).catch(() => {});
        await pdf.waitForTimeout(1500);
        await popupOver(ctx, pdf, { file: name("popup-pdf"), scheme, actionBesideTitle: true });
        await pdf.close();
        // The reader, with its chips, and the menu over it.
        await ctx.sw.evaluate(() => chrome.storage.local.set({ autoOpenPdfs: true }));
        const reader = await ctx.context.newPage();
        await reader.setViewportSize({ width: 1100, height: 800 });
        await reader.emulateMedia({ colorScheme: scheme });
        await reader.goto(site.url("/doc.pdf")).catch(() => {});
        await reader.waitForURL(/reader\.html/, { timeout: 20000 });
        await reader.waitForFunction((sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill.scored")).length >= 2, BADGE_SEL, { timeout: 90_000 });
        await reader.waitForTimeout(800);
        await reader.screenshot({ path: name("reader") });
        await popupOver(ctx, reader, { file: name("popup-reader"), scheme });
        await reader.close();
        await page.close();
      } finally { await site.close(); }
    }
  });
}

console.log("screenshots in", out);
