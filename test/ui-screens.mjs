// test/ui-screens.mjs — screenshots of the setup page, Settings, popup and a page with chips,
// for a reviewer: English and Chinese, light and dark, in a temporary profile each.
//
//   node test/ui-screens.mjs <output dir> [apple,linux,chips]   (LANGS=en SCHEMES=light narrow it)
//
// The setup page and Settings are shown on stand-in devices (test/pw/devices.mjs) with the
// in-browser engine's states scripted into them (test/webengine/scripted-engine.mjs); the chips
// come from the test build's fake host, so the four scores are the ones asked for.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchExtension, uiLanguage, uiLanguageOf, waitForRegistration, BADGE_SEL, serveHtml } from "./harness.mjs";
import { deviceBuild } from "./test-build.mjs";
import { DEVICES } from "./pw/devices.mjs";
import { scriptEngine, scriptDevice } from "./webengine/scripted-engine.mjs";
import { NO_MODEL_HOSTS } from "./webengine/model-server.mjs";

const out = resolve(process.argv[2] ?? "ui-screens");
mkdirSync(out, { recursive: true });

const only = process.argv[3] ?? "";
const LANGS = (process.env.LANGS ?? "en,zh-CN").split(",").map((l) => [l, l === "en" ? "en" : "zh"]);
const SCHEMES = (process.env.SCHEMES ?? "light,dark").split(",");
const wanted = (group) => !only || only.split(",").includes(group);

const PARA = (tag) =>
  `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary ` +
  "English words describing nothing in particular except the fact that a reader who never touches a mouse " +
  "must still be able to reach every verdict this extension produces, which is what the floating ball, its " +
  "counter and the triage panel behind them exist for on a page like this one, where every verdict has to " +
  "be one key press away and read out in words rather than shown only as a colour.";
// Tags whose fixture scores are .05, .30, .60 and .95 (test/fake-native.mjs fakeScore).
const CHIP_TAGS = ["S2197", "S366", "S1643", "S1430"];
// One paragraph under the reader's 50 words (not scored) and one of 60 (scored, "less reliable").
const SHORT_NOTE = "The committee met on Thursday and agreed to move the review to the following week.";
const MID_NOTE = "The harbor road closes at dusk, and the ferry keeps its own timetable through the winter months, which surprises most visitors. " + "Locals plan around it: they buy bread early, post letters before noon and leave the last crossing for emergencies. ".repeat(2) + "Nobody complains.";
const chipsHtml = (dark) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chips</title></head>
<body style="margin:0;${dark ? "background:#0d1117;color:#e6edf3" : "background:#fff;color:#1a1a1a"}"><div style="max-width:680px;margin:0 auto;padding:32px 24px;font:16px/1.65 Georgia,serif">
<h1 style="font:600 22px system-ui">A page read by Anagram</h1>
${CHIP_TAGS.map((t) => `<p>${PARA(t)}</p>`).join("\n")}
<h2 style="font:600 18px system-ui">Notes</h2>
<p>${SHORT_NOTE}</p>
<h2 style="font:600 18px system-ui">Shorter than the model's minimum</h2>
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

async function shot(ctx, { file, url, scheme, width, script, ready, tall }) {
  const page = await ctx.context.newPage();
  await page.setViewportSize({ width, height: tall ?? 900 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" });
  if (script) await script(page);
  await page.goto(url);
  await (ready ?? painted)(page);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

const apple = deviceBuild("apple-silicon", DEVICES["apple-silicon"]);
const linux = deviceBuild("linux-cpu", DEVICES["linux-cpu"]);

for (const [lang, tag] of LANGS) {
  for (const scheme of SCHEMES) {
    const name = (what) => join(out, `${what}-${tag}-${scheme}.png`);
    if (wanted("apple")) await run(apple, lang, async (ctx) => {
      const u = (p) => `chrome-extension://${ctx.extId}/${p}`;
      await shot(ctx, { file: name("landing-choice"), url: u("onboarding.html"), scheme, width: 900, script: (p) => scriptEngine(p, "needed", { engine: null }) });
      await shot(ctx, { file: name("settings-ready"), url: u("options.html"), scheme, width: 900, script: (p) => scriptEngine(p, "ready_gpu") });
    });
    if (wanted("linux")) await run(linux, lang, async (ctx) => {
      const u = (p) => `chrome-extension://${ctx.extId}/${p}`;
      await shot(ctx, { file: name("landing-downloading"), url: u("onboarding.html"), scheme, width: 900, script: (p) => scriptEngine(p, "downloading") });
      await shot(ctx, { file: name("landing-ready"), url: u("onboarding.html"), scheme, width: 900, script: (p) => scriptEngine(p, "ready_gpu") });
      const popupReady = (page) => page.waitForFunction(() => !document.getElementById("action")?.disabled, null, { timeout: 10000 }).then(() => page.waitForTimeout(500));
      await shot(ctx, { file: name("popup-downloading"), url: u("popup.html"), scheme, width: 300, tall: 400, script: (p) => scriptEngine(p, "downloading"), ready: popupReady });
      await shot(ctx, { file: name("popup-ready"), url: u("popup.html"), scheme, width: 300, tall: 400, script: (p) => scriptEngine(p, "ready_gpu"), ready: popupReady });
    });
    if (wanted("chips")) await run(undefined, lang, async (ctx) => {
      const site = await serveHtml({ "/chips.html": chipsHtml(scheme === "dark") });
      try {
        await waitForRegistration(ctx.sw);
        const page = await ctx.context.newPage();
        await page.setViewportSize({ width: 900, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(site.url("/chips.html"));
        await page.waitForFunction((sel) => document.querySelectorAll(sel).length >= 4 && [...document.querySelectorAll(sel)].every((h) => h.shadowRoot?.querySelector(".pill.scored")), BADGE_SEL, { timeout: 20000 });
        // Hover the third chip: its card opens beside the others.
        const chip = page.locator(BADGE_SEL).nth(2);
        await chip.scrollIntoViewIfNeeded();
        await chip.hover();
        await page.waitForTimeout(900);
        await page.screenshot({ path: name("chips"), fullPage: true });
        // The ball, and the panel open beside it (flagged out of read, then what was too short).
        await page.mouse.move(5, 5);
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForTimeout(400);
        const stack = page.locator("#anagram-fab .stack");
        const box = await stack.boundingBox();
        await page.screenshot({ path: name("ball"), clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } });
        await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".count").click());
        await page.waitForTimeout(600);
        await page.screenshot({ path: name("panel"), fullPage: false });
        await page.close();
      } finally { await site.close(); }
    });
  }
}

// The count badge on the ball, close up at 1, 12 and 99+ (the cap): the numbers are set the way
// setCount writes them, and the ball is shot at 3x.
if (wanted("badge")) {
  const [lang] = LANGS[0];
  for (const scheme of SCHEMES) {
    await run(undefined, lang, async (ctx) => {
      const site = await serveHtml({ "/chips.html": chipsHtml(scheme === "dark") });
      try {
        await waitForRegistration(ctx.sw);
        const page = await ctx.context.newPage();
        await page.setViewportSize({ width: 900, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        const cdp = await ctx.context.newCDPSession(page);
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 3, mobile: false });
        await page.goto(site.url("/chips.html"));
        await page.waitForFunction((sel) => document.querySelectorAll(sel).length >= 4 && [...document.querySelectorAll(sel)].every((h) => h.shadowRoot?.querySelector(".pill.scored")), BADGE_SEL, { timeout: 20000 });
        // A hostile page style: the badge must not take any of it.
        await page.addStyleTag({ content: "* { font-family: 'Times New Roman', serif !important; font-style: italic !important; letter-spacing: 3px !important; text-transform: uppercase !important; }" });
        await page.mouse.move(5, 5);
        const shots = [];
        for (const text of ["1", "12", "99+"]) {
          await page.evaluate((text) => { document.getElementById("anagram-fab").shadowRoot.querySelector(".count").textContent = text; }, text);
          await page.waitForTimeout(300);
          const box = await page.locator("#anagram-fab .stack").boundingBox();
          shots.push((await page.screenshot({ clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 } })).toString("base64"));
        }
        const sheet = await ctx.context.newPage();
        await sheet.setViewportSize({ width: 700, height: 240 });
        await sheet.setContent(`<body style="margin:0;display:flex;gap:16px;padding:12px;background:${scheme === "dark" ? "#0d1117" : "#fff"}">${shots.map((b) => `<img style="height:198px" src="data:image/png;base64,${b}">`).join("")}</body>`);
        await sheet.screenshot({ path: join(out, `badge-${scheme}.png`), fullPage: true });
        await sheet.close();
        await page.close();
      } finally { await site.close(); }
    });
  }
}
console.log("screenshots in", out);
