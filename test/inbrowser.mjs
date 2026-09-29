// test/inbrowser.mjs — the in-browser engine of the test build, set up the way a person sets it up.
//
// One extension carries both engines, and the setup page decides which a device runs
// (lib/device.ts, lib/ui/engineCard.ts). This starts copies of the test build that stand in
// for devices (test/test-build.mjs deviceBuild: Native Messaging optional, as shipped) for
// real, in English and in Chinese, each in a temporary profile, with Hugging Face answered on
// this machine (test/webengine/model-server.mjs: Chromium resolves its names to a local HTTPS
// server that answers CORS as Hugging Face does, and nothing else resolves at all):
//
//   - on an Apple Silicon Mac the setup page offers both engines, the in-browser one
//     highlighted, and nothing downloads until one is picked; picking it starts the download;
//     picking the local engine asks for Native Messaging and shows the install command, and a
//     refusal comes back to the choice saying so (a permission prompt is browser UI no
//     automation can click: the browser's answer is stood in for, in the page and the worker);
//   - where the model does not fit nothing downloads and the page says why; on 4 GB it runs
//     with a note;
//   - Native Messaging is accepted as optional and kept across an update from a release that
//     required it, with the local host reached after it (Chrome cannot be granted it at run
//     time without its prompt; test/webengine/firefox-extension.mjs grants it in Firefox);
//   - on a device with no choice installing is setting up: the model's download starts by
//     itself and the setup page opens on it running, with Pause and Cancel; the manifest
//     names no model host, and with the shipped permissions (no host at all) the download
//     goes by CORS alone; the package carries lid.176.ftz;
//   - the download with progress, speed and time left, the popup's and the panel's progress
//     line (pushed as it moves, the same figure in both), a dropped connection retried by
//     itself, Pause and Resume from the bytes on disk, and Cancel;
//   - not set up: every page shows the in-browser block and no install command, the popup and
//     the in-page panel say setup is needed and open the setup page, Save-Data and a disk too
//     full say why the download waits, a server error and Retry;
//   - a disk that fills up mid-download, both ways Chrome says so (the engine worker's writes
//     made to fail over the DevTools protocol): stopped at once, the room to make said, the
//     bytes kept, and Retry carries on from them;
//   - an engine gone mid-download is not started again by itself; an update resumes the
//     download, unless the browser asks to save data; after a Cancel neither an update nor a
//     browser relaunch starts it;
//   - the states that take a finished download, a GPU or a failure to reach (ready on the
//     graphics card or the processor, loading, each kind of failure, a model that would not
//     load, an engine that kept crashing) scripted into the page (test/webengine/scripted-engine.mjs);
//   - every extension page is cross-origin isolated under the manifest's keys, and the
//     reader still opens a PDF;
//   - Settings switches to the local engine and back, and offers to delete what the
//     in-browser engine left.
//
// The downloads are zeros from the local server: a paused, cancelled or failed download is
// never verified. `--real` adds one run with the real files, the whole way to Ready and a
// score without a click (ANAGRAM_MODELKIT, or ~/anagram-bench's copy): 1.4 GB into a
// temporary profile that is deleted after; never in CI.
//
//   npm run test:inbrowser             # builds output-test/chrome-mv3 when stale
//   node test/inbrowser.mjs --real     # and the real download, load and score
//   ANAGRAM_CHROME=<binary> npm run test:inbrowser   # the Native Messaging checks in that Chrome
//                                      # too, e.g. Chrome for Testing 137, the manifest's minimum
import { chromium } from "playwright";
import puppeteer from "puppeteer-core";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { serveHtml, uiLanguage } from "./harness.mjs";
import { deviceBuild } from "./test-build.mjs";
import { DEVICES } from "./pw/devices.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";
import { DOWNLOAD_BYTES, DOWNLOAD_BYTES_FP16, modelServer, realFiles } from "./webengine/model-server.mjs";
import { STATES, scriptEngine } from "./webengine/scripted-engine.mjs";
import { LID } from "../scripts/webengine.mjs";
/** The numbers the choice describes the engines by (lib/device.ts MEASURED, measured on an M4). */
const MEASURED = { inbrowser: { ms: 92, gb: 2.5 }, native: { ms: 43, gb: 1.8 } };

/** A device with no choice: the in-browser engine, set up from install. */
const EXT = deviceBuild("linux-cpu", DEVICES["linux-cpu"]);
const REAL = process.argv.includes("--real");
const HUGGING_FACE = /^(huggingface\.co|[\w.-]+\.hf\.co)$/;

const results = [];
const check = (name, ok, note = "") => {
  results.push({ name, ok: !!ok, note: String(note) });
  if (!ok) console.log(`FAIL  ${name}  — ${String(note).slice(0, 400)}`);
};

/** The build's own words, as chrome.i18n fills them in. */
const MESSAGES = {
  en: JSON.parse(readFileSync(join(EXT, "_locales", "en", "messages.json"), "utf8")),
  "zh-CN": JSON.parse(readFileSync(join(EXT, "_locales", "zh_CN", "messages.json"), "utf8")),
};
const words = (lang) => (key, ...subs) => {
  const entry = MESSAGES[lang][key] ?? MESSAGES.en[key];
  if (!entry) throw new Error(`no message ${key}`);
  return entry.message.replace(/\$([1-9])/g, (whole, d) => String(subs[Number(d) - 1] ?? whole));
};
/** formatSize() of lib/ui/inBrowserEngine.ts. */
const size = (n) => n >= 1e9 ? `${(n / 1e9).toLocaleString("en", { maximumFractionDigits: 1 })} GB` : `${Math.round(n / 1e6)} MB`;
/** A message with its numbers left open, to find it in a line. */
const pattern = (lang, key) => new RegExp(MESSAGES[lang][key].message.replace(/[.*+?^()[\]{}|\\]/g, "\\$&").replace(/\$[1-9]/g, "\\d+"));

const PARA = (n) => `Paragraph ${n} of this page is long enough to be scored on its own, because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that the in-browser engine has not been set up yet, which the floating ball has to say plainly and offer the one thing that fixes it, which is the setup page, before any of the words on this page can be read and given a verdict of any kind.`;
const site = await serveHtml({
  "/article.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>article</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">${[1, 2, 3].map((n) => `<p>${PARA(n)}</p>`).join("\n")}</body></html>`,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 15000, step = 200) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(step);
  }
};

/** A browser on `profile` (a new temporary one unless given), with the extension loaded;
 *  close() keeps the profile only when asked, for a restart. */
async function launch(lang, server, profile = mkdtempSync(join(tmpdir(), "anagram-inbrowser-")), extension = EXT, executablePath = undefined, args = []) {
  const localized = lang === "en" ? {} : uiLanguage(lang);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, ...(executablePath ? { executablePath } : { channel: "chromium" }), ...localized, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check", ...server.args, ...(localized.args ?? []), ...args],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  return {
    context, sw, profile,
    close: async ({ keep = false } = {}) => {
      await context.close().catch(() => {});
      if (!keep) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** The in-browser engine's worker, which Playwright does not reach, over the DevTools protocol
 *  of a browser launched with DEVTOOLS_PORT: evaluate(expression) in it. */
const DEVTOOLS_PORT = "--remote-debugging-port=0";
async function engineWorker(profile) {
  const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  const target = await browser.waitForTarget((t) => t.url().endsWith("/vendor/engine/worker.min.mjs"), { timeout: 20000 });
  const session = await target.createCDPSession();
  return {
    evaluate: async (expression) => (await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value,
    close: () => browser.disconnect(),
  };
}

/** A page of the extension, failing the run on any uncaught error in it. */
async function extPage(context, extId, path, problems, script) {
  const page = await context.newPage();
  watch(page, path, problems);
  if (script) await script(page);
  await page.goto(`chrome-extension://${extId}/${path}`);
  return page;
}
function watch(page, name, problems) {
  page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${name}: ${m.text()}`); });
}
const statusOf = (page) => page.evaluate(() => document.querySelector("#componentSettings .component-status")?.textContent ?? "");
const textOf = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); return el && !el.hidden ? el.textContent : null; }, selector);
const engine = (page, op, payload = {}) => page.evaluate(([op, payload]) => chrome.runtime.sendMessage({ action: "anagram.nativeRequest", op, payload }), [op, payload]);
/** onInstalled as the browser fires it on an extension update, into the extension's worker. */
const updated = (sw) => sw.evaluate(() => chrome.runtime.onInstalled.dispatch({ reason: "update", previousVersion: "0.0.1" }));
/** The worker as the browser asks sites to save data. Chromium has no switch for Save-Data,
 *  so its answer is stood in for, where the worker reads it. */
const saveData = (sw, on) => sw.evaluate((on) => Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: on } }), on);

// ---- as shipped: no host granted at all -----------------------------------------------------------

// The test build requires every site (test/test-build.mjs), which lets the extension read any
// host without CORS. The shipped one holds no host: this copy of the test build asks for what
// the shipped manifest asks for, so the download has only Hugging Face's CORS answer to go on.
{
  const server = await modelServer({ rate: 15e6 });
  const copy = mkdtempSync(join(tmpdir(), "anagram-inbrowser-shipped-"));
  cpSync(EXT, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
  delete manifest.host_permissions;
  manifest.optional_host_permissions = ["https://*/*", "http://*/*", "file:///*"];
  writeFileSync(join(copy, "manifest.json"), JSON.stringify(manifest));
  const run = await launch("en", server, undefined, copy);
  try {
    const extId = new URL(run.sw.url()).host;
    const granted = await run.sw.evaluate(() => chrome.permissions.getAll());
    check("shipped: nothing is granted but the required permissions, no host at all", (granted.origins ?? []).length === 0, JSON.stringify(granted));
    const first = await until(async () => server.requests.find((r) => !r.preflight && r.file === "model.onnx"), 20000);
    check("shipped: the download starts by itself, a CORS request from the extension's own origin", first?.host === "huggingface.co" && first.origin === `chrome-extension://${extId}`, JSON.stringify(first));
    const cdn = await until(async () => server.requests.find((r) => r.host.endsWith(".hf.co") && r.file === "model.onnx"));
    check("shipped: the redirect to Hugging Face's CDN is followed with an opaque origin, which it answers with *", cdn?.origin === "null", JSON.stringify(cdn));
    const setup = run.context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
      await run.context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 20000 }).catch(() => null);
    const bytes = setup && await until(async () => {
      const reply = await engine(setup, "status");
      return reply?.data?.download?.status === "running" && reply.data.download.bytes_received > 20e6 ? reply.data.download.bytes_received : null;
    }, 20000);
    check("shipped: the bytes arrive, under the pages' cross-origin isolation", bytes > 20e6 && (await setup.evaluate(() => crossOriginIsolated)), bytes);
    await setup?.evaluate(() => chrome.runtime.sendMessage({ action: "anagram.nativeRequest", op: "models.delete", payload: { confirm: true } }));
  } finally {
    await run.close();
    await server.close();
    rmSync(copy, { recursive: true, force: true });
  }
}

// ---- a device with a choice: nothing downloads until one is picked --------------------------------

/** The browser's answer to the Native Messaging prompt, which no automation can click, stood
 *  in for: in the page that asks, and in the worker that checks before it switches. */
const answerPrompt = (page, yes) => page.addInitScript((yes) => {
  chrome.permissions.request = async () => yes;
}, yes);
const grantInWorker = (sw) => sw.evaluate(() => { chrome.permissions.contains = async () => true; });
const engineOf = async (page) => (await page.evaluate(() => chrome.runtime.sendMessage({ action: "getEngine" })))?.engine ?? null;
const shown = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.getClientRects().length > 0; }, selector);

const CHOICE = deviceBuild("apple-silicon", DEVICES["apple-silicon"]);
for (const lang of ["en", "zh-CN"]) {
  const w = words(lang);
  const server = await modelServer({ rate: 15e6 });
  const run = await launch(lang, server, undefined, CHOICE);
  const problems = [];
  try {
    const { context, sw } = run;
    const extId = new URL(sw.url()).host;
    const language = await sw.evaluate(() => chrome.i18n.getUILanguage());
    if (!language.toLowerCase().startsWith(lang.split("-")[0])) { console.log(`SKIP  ${lang}: the browser came up in ${language}`); continue; }
    const setup = context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
      await context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 20000 }).catch(() => null);
    check(`${lang} choice: installing opens the setup page`, setup);
    if (!setup) continue;
    watch(setup, "onboarding.html", problems);
    await setup.bringToFront();
    const offered = await until(() => shown(setup, "#engine-pick-inbrowser"), 15000);
    const seen = await setup.evaluate(() => {
      const card = (engine) => document.querySelector(`.engine-choice-card[data-engine="${engine}"]`);
      const text = (el) => el?.innerText.replace(/\s+/g, " ").trim() ?? "";
      return { title: document.getElementById("engineTitle")?.textContent, oneClick: text(card("inbrowser")), terminal: text(card("native")),
        highlighted: card("inbrowser")?.hasAttribute("data-recommended") && !card("native")?.hasAttribute("data-recommended"),
        filled: !document.getElementById("engine-pick-inbrowser")?.dataset.variant, outline: document.getElementById("engine-pick-native")?.dataset.variant === "outline",
        panel: !document.getElementById("componentSettings")?.hidden };
    });
    check(`${lang} choice: an Apple Silicon Mac is offered both engines, the in-browser one highlighted`, offered && seen.title === w("engineChooseTitle") &&
      seen.highlighted && seen.filled && seen.outline && !seen.panel, JSON.stringify(seen));
    check(`${lang} choice: each card says what it is, its speed and its memory`,
      seen.oneClick.includes(w("engineOneClickWhat")) && seen.oneClick.includes(w("engineOneClickCost", MEASURED.inbrowser.ms, MEASURED.inbrowser.gb)) &&
      seen.oneClick.includes(w("engineOneClickButton", size(DOWNLOAD_BYTES))) && seen.oneClick.includes(w("engineRecommended")) &&
      seen.terminal.includes(w("engineTerminalWhat")) && seen.terminal.includes(w("engineTerminalCost", MEASURED.native.ms, MEASURED.native.gb)) &&
      seen.terminal.includes(w("engineTerminalButton")), JSON.stringify(seen));
    await sleep(3000);
    check(`${lang} choice: nothing downloads before a pick, and no engine is in use`, server.requests.length === 0 && (await engineOf(setup)) === null,
      JSON.stringify(server.requests.slice(0, 3)));
    const popup = await extPage(context, extId, "popup.html", problems);
    await until(() => popup.evaluate((want) => !document.getElementById("action").disabled && document.getElementById("status").textContent === want, w("popupSetupNeeded")));
    check(`${lang} choice: the popup says setup is needed and offers it`, (await popup.evaluate(() => document.getElementById("action").textContent)) === w("engineSetUp"));
    await popup.close();

    // The local engine, refused: back to the choice, saying why; nothing changed.
    const refusing = await extPage(context, extId, "onboarding.html", problems, (p) => answerPrompt(p, false));
    await until(() => shown(refusing, "#engine-pick-native"));
    await refusing.click("#engine-pick-native");
    const reason = await until(() => textOf(refusing, ".engine-choice .engine-error"));
    check(`${lang} choice: a refused permission comes back to the choice with a line saying so`, reason === w("engineNativeRefused") &&
      (await shown(refusing, "#engine-pick-inbrowser")) && (await engineOf(refusing)) === null && server.requests.length === 0, reason);
    await refusing.close();

    // The in-browser engine: its download starts, and its panel follows it.
    await setup.bringToFront();
    await setup.click("#engine-pick-inbrowser");
    const started = await until(async () => server.requests.find((r) => !r.preflight && r.file === "model.onnx"), 20000);
    const running = await until(async () => (await statusOf(setup)) === w("engineDownloading"), 20000);
    check(`${lang} choice: picking the in-browser engine starts its download, with Pause and Cancel`, started && running &&
      (await textOf(setup, "#component-primary")) === w("componentPauseDownload") && (await engineOf(setup)) === "inbrowser" &&
      (await setup.evaluate(() => document.getElementById("engineTitle")?.textContent)) === w("engineTitle"), await statusOf(setup));
    await engine(setup, "models.delete", { confirm: true });
    check(`${lang} choice: no errors in the pages`, problems.length === 0, problems.join(" | "));
  } finally {
    await run.close();
    await server.close();
  }
}

// The local engine, granted: its panel with the install command, and the engine in use.
{
  const w = words("en");
  const server = await modelServer({ rate: 15e6 });
  const run = await launch("en", server, undefined, CHOICE);
  try {
    const extId = new URL(run.sw.url()).host;
    const page = await extPage(run.context, extId, "onboarding.html", [], (p) => answerPrompt(p, true));
    await until(() => shown(page, "#engine-pick-native"));
    // Granted once the choice is up: a grant nobody chose for makes the local engine the one in use.
    await grantInWorker(run.sw);
    await page.click("#engine-pick-native");
    const command = await until(() => textOf(page, "#install-cmd"), 15000);
    check("choice: picking the local engine with the permission granted shows its install command", /^curl -fsSL '.*install\.sh'/.test(command ?? "") &&
      (await engineOf(page)) === "native" && (await page.evaluate(() => document.getElementById("engineTitle")?.textContent)) === w("componentTitle") &&
      !(await shown(page, ".engine-choice")), command);
    await sleep(1000);
    check("choice: and downloads nothing into the browser", server.requests.length === 0, JSON.stringify(server.requests.slice(0, 3)));
  } finally {
    await run.close();
    await server.close();
  }
}

// ---- what the device can afford --------------------------------------

for (const [name, want] of [["windows-nvidia", "nvidia"], ["linux-2gb", "cannot"], ["linux-4gb", "tight"], ["linux-4gb-f16", "lighter"]]) {
  const w = words("en");
  const server = await modelServer({ rate: 15e6 });
  const run = await launch("en", server, undefined, deviceBuild(name, DEVICES[name]));
  try {
    const setup = run.context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
      await run.context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 20000 }).catch(() => null);
    if (want === "nvidia") {
      await until(() => shown(setup, "#engine-pick-native"), 15000);
      await sleep(2000);
      const seen = await setup.evaluate(() => ({
        terminal: document.querySelector('.engine-choice-card[data-engine="native"]')?.innerText.replace(/\s+/g, " ").trim() ?? "",
        figures: [...document.querySelectorAll(".engine-choice .engine-cost, .engine-choice > .engine-note")].filter((el) => !el.hidden).map((el) => el.textContent) }));
      check("NVIDIA on Windows: the choice, the local engine said to run on the NVIDIA card, and no M4 figures", seen.terminal.includes(w("engineTerminalWhatNvidiaWindows")) &&
        seen.figures.length === 0 && server.requests.length === 0, JSON.stringify(seen));
    } else if (want === "cannot") {
      const said = await until(() => textOf(setup, ".engine-cannot"), 15000);
      await sleep(2000);
      check("too little memory: the setup page says so plainly and downloads nothing", said === w("engineCannotRun") &&
        (await setup.evaluate(() => document.getElementById("engineTitle")?.textContent)) === w("engineCannotTitle") &&
        server.requests.length === 0 && (await engineOf(setup)) === null && !(await shown(setup, ".engine-choice")), said);
    } else if (want === "tight") {
      const note = await until(() => textOf(setup, ".engine-tight"), 20000);
      check("4 GB: the in-browser engine sets up, with a line that the computer may slow down", note === w("engineTight") &&
        (await until(async () => server.requests.find((r) => !r.preflight && r.file === "model.onnx"), 20000)), note);
      await engine(setup, "models.delete", { confirm: true });
    } else if (want === "lighter") {
      // 4 GB and a card with shader-f16: FP32 does not fit, so the modelkit's FP16 file is what downloads.
      const line = await until(() => textOf(setup, ".engine-lighter"), 20000);
      const asked = await until(async () => server.requests.find((r) => !r.preflight && r.file === "model_fp16.onnx"), 20000);
      const progress = await until(() => textOf(setup, ".engine-progress"), 20000);
      const status = await engine(setup, "status");
      check("4 GB with an f16 GPU: the lighter model's line, and no note that the computer may slow down", line === w("engineLighter") && !(await shown(setup, ".engine-tight")), line);
      check("4 GB with an f16 GPU: model_fp16.onnx downloads, not model.onnx, and the progress counts its 715 MB", !!asked && !server.requests.some((r) => r.file === "model.onnx") &&
        progress?.includes(size(DOWNLOAD_BYTES_FP16)) && status?.data?.tier === "fp16" && status.data.download.total_bytes === DOWNLOAD_BYTES_FP16, JSON.stringify([asked, progress, status?.data?.tier]));
      await engine(setup, "models.delete", { confirm: true });
    }
  } finally {
    await run.close();
    await server.close();
  }
}

// ---- Native Messaging: optional, and kept across an update from a release that required it -------

// A profile installs the test build as it was (Native Messaging required, as 0.7.0 shipped it),
// then the browser comes back with the same extension where it is optional: the browser takes
// it as optional without a warning, the grant is kept, the local engine stays the one in use,
// and its host answers. Taken back, it is gone: the local engine cannot be reached, and asking
// again is the browser's prompt. In Playwright's Chromium, and in ANAGRAM_CHROME when set.
async function nativeOptional(label, executablePath) {
  const { createNativeFixture, HOST_NAME } = await import("./fake-native.mjs");
  const { blockNativeHostInProfile, registerTestHost } = await import("./native-test-host.mjs");
  const fixture = await createNativeFixture();
  const server = await modelServer({ rate: 15e6 });
  const dir = mkdtempSync(join(tmpdir(), "anagram-update-"));
  const extension = join(dir, "extension");
  const profile = join(dir, "profile");
  mkdirSync(profile);
  blockNativeHostInProfile(profile);
  const manifestOf = (required) => {
    const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
    manifest.permissions = manifest.permissions.filter((p) => p !== "nativeMessaging");
    if (required) { manifest.permissions.push("nativeMessaging"); manifest.optional_permissions = []; manifest.version = "0.6.9"; }
    else manifest.optional_permissions = ["nativeMessaging"];
    return JSON.stringify(manifest);
  };
  cpSync(EXT, extension, { recursive: true });
  rmSync(join(extension, "test-device.json"));
  writeFileSync(join(extension, "manifest.json"), manifestOf(true));
  let run = await launch("en", server, profile, extension, executablePath);
  try {
    const extId = new URL(run.sw.url()).host;
    const version = await run.sw.evaluate(() => /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "?");
    label = `${label} (Chrome ${version})`;
    registerTestHost(join(run.profile, "NativeMessagingHosts", `${HOST_NAME}.json`), fixture, "chrome", extId);
    const before = await run.sw.evaluate(async () => await chrome.permissions.contains({ permissions: ["nativeMessaging"] }));
    await run.close({ keep: true });
    writeFileSync(join(extension, "manifest.json"), manifestOf(false));
    run = await launch("en", server, run.profile, extension, executablePath);
    const after = await run.sw.evaluate(async () => ({ granted: await chrome.permissions.contains({ permissions: ["nativeMessaging"] }), optional: chrome.runtime.getManifest().optional_permissions }));
    // What chrome://extensions lists under the extension's errors: an optional permission the
    // browser does not take as one is dropped with a warning there.
    const manager = await run.context.newPage();
    await manager.goto(`chrome://extensions/?id=${extId}`);
    await manager.waitForFunction(() => typeof chrome.developerPrivate?.getExtensionInfo === "function");
    const warnings = await manager.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id).then((info) => [...(info.installWarnings ?? []), ...(info.manifestErrors ?? []).map((e) => e.message)]), extId);
    await manager.close();
    check(`${label}: nativeMessaging is taken as an optional permission, without a warning`, after.optional.includes("nativeMessaging") && warnings.length === 0, JSON.stringify(warnings));
    const page = await extPage(run.context, extId, "options.html", []);
    const health = await until(async () => { const s = await page.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true })); return s?.active === "server" ? s : null; }, 20000);
    check(`${label}: an update keeps Native Messaging granted, the local engine stays in use and connectNative reaches its host`,
      before === true && after.granted === true && (await engineOf(page)) === "native" && health?.engine === "native",
      JSON.stringify({ before, after, health }));
    const removed = await page.evaluate(async () => chrome.permissions.remove({ permissions: ["nativeMessaging"] }));
    const gone = await until(async () => (await engineOf(page)) === null, 10000);
    const status = await page.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
    check(`${label}: taken back, the local engine cannot be reached, and setup asks again which engine`, removed && gone && status?.active === "down" && status.setup?.state === "needed", JSON.stringify(status));
    await page.close();
  } finally {
    await run.close();
    await server.close();
    fixture.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}
await nativeOptional("Chromium");
if (process.env.ANAGRAM_CHROME) await nativeOptional("ANAGRAM_CHROME", process.env.ANAGRAM_CHROME);

// ---- Settings: to the local engine and back ------------------------------------------------------

{
  const w = words("en");
  const server = await modelServer({ rate: 15e6 });
  const run = await launch("en", server);
  const problems = [];
  try {
    const extId = new URL(run.sw.url()).host;
    const setup = run.context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
      await run.context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 20000 });
    await until(async () => (await engine(setup, "status"))?.data?.download?.bytes_received > 5e6, 20000);
    await engine(setup, "models.pause");
    await setup.close();
    await grantInWorker(run.sw);
    const settings = await extPage(run.context, extId, "options.html", problems, (p) => answerPrompt(p, true));
    const offer = await until(async () => (await shown(settings, "#engine-switch")) && textOf(settings, "#engine-switch"), 15000);
    check("Settings: the in-browser engine in use offers the local engine", offer === w("engineSwitchToNative"), offer);
    await settings.click("#engine-switch");
    const command = await until(() => textOf(settings, "#install-cmd"), 15000);
    const left = await until(() => textOf(settings, ".engine-leftover"), 10000);
    check("Settings: switching asks for the permission, then shows the install command, and the engine in use is the local one",
      /^curl /.test(command ?? "") && (await engineOf(settings)) === "native" && (await settings.evaluate(() => document.getElementById("engineTitle")?.textContent)) === w("componentTitle"), command);
    check("Settings: it offers to delete what the in-browser engine left, and deletes nothing by itself",
      /^The in-browser engine's model files still take \d+ MB\.$/.test(left ?? "") && (await textOf(settings, "#engine-delete-leftover")) === w("engineLeftoverDelete") &&
      (await settings.evaluate(async () => { try { await (await navigator.storage.getDirectory()).getDirectoryHandle("anagram-engine"); return true; } catch { return false; } })), left);
    await settings.click("#engine-delete-leftover");
    const deleted = await until(async () => (await textOf(settings, ".engine-leftover")) === null &&
      settings.evaluate(async () => { try { await (await navigator.storage.getDirectory()).getDirectoryHandle("anagram-engine"); return false; } catch { return true; } }), 10000);
    check("Settings: Delete them removes the in-browser engine's files", deleted);
    const back = await until(async () => (await shown(settings, "#engine-switch")) && textOf(settings, "#engine-switch"));
    check("Settings: the local engine in use offers the in-browser one", back === w("engineSwitchToInBrowser"), back);
    const before = server.requests.length;
    await settings.click("#engine-switch");
    const downloading = await until(async () => (await statusOf(settings)) === w("engineDownloading"), 20000);
    check("Settings: switching back starts the in-browser engine's setup", downloading && (await engineOf(settings)) === "inbrowser" &&
      server.requests.slice(before).some((r) => r.file === "model.onnx" && !r.preflight) &&
      (await settings.evaluate(() => document.getElementById("engineTitle")?.textContent)) === w("engineTitle"), await statusOf(settings));
    await engine(settings, "models.delete", { confirm: true });
    check("Settings: no errors in the pages", problems.length === 0, problems.join(" | "));
  } finally {
    await run.close();
    await server.close();
  }
}

// ---- the flow, in each language ---------------------------------------------------------------

for (const lang of ["en", "zh-CN"]) {
  const w = words(lang);
  const server = await modelServer({ rate: 15e6 });
  let run = await launch(lang, server);
  const problems = [];
  try {
    const { context, sw } = run;
    check(`${lang}: the background worker starts`, sw);
    if (!sw) continue;
    sw.on("console", (m) => { if (m.type() === "error") problems.push(`worker: ${m.text()}`); });
    const extId = new URL(sw.url()).host;
    const language = await sw.evaluate(() => chrome.i18n.getUILanguage());
    if (!language.toLowerCase().startsWith(lang.split("-")[0])) { console.log(`SKIP  ${lang}: the browser came up in ${language}`); continue; }

    const worker = await sw.evaluate(async () => ({ manifest: chrome.runtime.getManifest(), connectNative: typeof chrome.runtime.connectNative,
      granted: await chrome.permissions.contains({ permissions: ["nativeMessaging"] }) }));
    check(`${lang}: Native Messaging is optional and not granted, and there is no connectNative to call`,
      !worker.manifest.permissions.includes("nativeMessaging") && worker.manifest.optional_permissions.includes("nativeMessaging") &&
      !worker.granted && worker.connectNative === "undefined", JSON.stringify(worker.manifest.permissions));
    check(`${lang}: the manifest names no model host`, !/huggingface|hf\.co|fbaipublicfiles/.test(JSON.stringify(worker.manifest)), JSON.stringify(worker.manifest.optional_host_permissions));

    // Installed: the download started by itself, and the setup page opened on it.
    const setup = context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
      await context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 20000 }).catch(() => null);
    check(`${lang}: installing opens the setup page`, setup, context.pages().map((p) => p.url()).join(" "));
    if (!setup) continue;
    watch(setup, "onboarding.html", problems);
    await setup.bringToFront();
    const running = await until(async () => (await statusOf(setup)) === w("engineDownloading"), 20000);
    check(`${lang}: the setup page opens on the download already running, with Pause and Cancel`, running &&
      (await textOf(setup, "#component-primary")) === w("componentPauseDownload") && (await textOf(setup, "#engine-cancel")) === w("engineCancelDownload"),
      `${await statusOf(setup)} · ${await textOf(setup, "#component-primary")} · ${await textOf(setup, "#engine-cancel")}`);
    check(`${lang}: its card is the in-browser engine's`, (await setup.evaluate(() => document.querySelector("#componentSettings")?.closest(".card")?.querySelector("h2")?.textContent)) === w("engineTitle"));
    const first = server.requests.find((r) => !r.preflight);
    check(`${lang}: the first request is the model, without a click`, first?.host === "huggingface.co" && first.file === "model.onnx", JSON.stringify(first));
    const cdn = await until(async () => server.requests.find((r) => r.host.endsWith(".hf.co") && r.file === "model.onnx"));
    check(`${lang}: Hugging Face's redirect to its CDN is followed`, cdn, JSON.stringify(server.requests.slice(0, 4)));
    check(`${lang}: nothing is asked of any host but Hugging Face's`, server.requests.every((r) => HUGGING_FACE.test(r.host) && r.file !== "lid.176.ftz"),
      JSON.stringify(server.requests.filter((r) => !HUGGING_FACE.test(r.host))));
    const lid = await setup.evaluate(async (path) => {
      const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL(path))).arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
      return { size: bytes.length, hash };
    }, "vendor/engine/lid.176.ftz");
    check(`${lang}: the package carries the pinned lid.176.ftz`, lid.size === LID.size_bytes && lid.hash === LID.sha256, JSON.stringify(lid));

    // The download: progress, speed, time left, in the popup and the panel too.
    const withSpeed = await until(async () => {
      const line = await textOf(setup, "#engine-progress");
      return line && line.includes(w("engineSpeed", "").trim()) ? line : null;
    }, 15000);
    const left = ["engineLeftUnderMinute", "engineLeftMinutes_one", "engineLeftMinutes_other", "engineLeftHours"].map((key) => pattern(lang, key));
    check(`${lang}: the progress line has percent, bytes, speed and time left`,
      withSpeed && /^\d+% · /.test(withSpeed) && withSpeed.includes(size(DOWNLOAD_BYTES)) && left.some((re) => re.test(withSpeed)), withSpeed);
    check(`${lang}: the progress bar moves`, await setup.evaluate(() => { const p = document.querySelector("#componentSettings progress"); return !p.hidden && p.value > 0 && p.max > p.value; }));
    const popup = await extPage(context, extId, "popup.html", problems);
    const popupLine = await until(async () => {
      const line = await popup.evaluate(() => document.getElementById("status").textContent);
      return /\d/.test(line) ? line : null;
    });
    const percent = Number(/(\d+)%/.exec(popupLine ?? "")?.[1]);
    check(`${lang}: the popup shows the download's progress`, popupLine === w("popupSetupDownloading", percent) &&
      (await popup.evaluate(() => document.getElementById("action").textContent)) === w("engineShowProgress"), popupLine);
    await popup.close();
    const article = await context.newPage();
    article.on("pageerror", (e) => problems.push(`article: ${e.message}`));
    await article.goto(site.url("/article.html"));
    const down = await until(() => article.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent === "!"), 30000);
    check(`${lang}: the ball shows the engine is not ready yet`, down);
    const panelNotice = () => article.evaluate(() => {
      const root = document.getElementById("anagram-fab")?.shadowRoot;
      if (!root?.querySelector(".panel.open")) root?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const notice = root?.querySelector(".panel .pnotice");
      return notice ? { text: notice.querySelector("span")?.textContent, button: notice.querySelector("button")?.textContent } : null;
    });
    const panelLine = await until(async () => { const n = await panelNotice(); return n && /\d/.test(n.text ?? "") ? n : null; }, 15000);
    const panelPercent = Number(/(\d+)%/.exec(panelLine?.text ?? "")?.[1]);
    check(`${lang}: the panel shows the download's progress`, panelLine?.text === w("panelSetupDownloading", panelPercent) && panelLine?.button === w("engineShowProgress"), JSON.stringify(panelLine));

    // Pushed, not polled (lib/backend/setupFeed.ts): the popup and the panel move with the
    // download together, each figure within a second of the engine's own; the panel used to ask
    // every five seconds, and the popup not at all.
    const live = await extPage(context, extId, "popup.html", problems);
    await live.evaluate(() => { window.__pushes = 0; chrome.runtime.onMessage.addListener((m) => { if (m?.action === "engineSetup") window.__pushes++; }); });
    const firstSeen = { engine: new Map(), popup: new Map(), panel: new Map() };
    const saw = (which) => (text) => { const p = /(\d+)%/.exec(text ?? "")?.[1]; if (p !== undefined && !firstSeen[which].has(p)) firstSeen[which].set(p, Date.now()); };
    for (const end = Date.now() + 6000; Date.now() < end; await sleep(40)) {
      await Promise.all([
        engine(setup, "status").then((s) => { const d = s?.data?.download; if (d?.status === "running") saw("engine")(`${Math.floor((d.bytes_received * 100) / d.total_bytes)}%`); }),
        live.evaluate(() => document.getElementById("status").textContent).then(saw("popup")),
        panelNotice().then((n) => saw("panel")(n?.text)),
      ]);
    }
    // Figures the engine reached while it was watched: the first one it was already showing.
    const reached = [...firstSeen.engine.keys()].slice(1);
    const lag = (which) => reached.filter((p) => firstSeen[which].has(p)).map((p) => firstSeen[which].get(p) - firstSeen.engine.get(p));
    const [panelLag, popupLag] = [lag("panel"), lag("popup")];
    const apart = reached.filter((p) => firstSeen.panel.has(p) && firstSeen.popup.has(p)).map((p) => Math.abs(firstSeen.panel.get(p) - firstSeen.popup.get(p)));
    const pushNote = JSON.stringify({ reached, panelLag, popupLag, apart });
    console.log(`${lang}: pushed progress, ms after the engine: panel ${panelLag.join(" ")}; popup ${popupLag.join(" ")}; apart ${apart.join(" ")}`);
    check(`${lang}: the popup and the panel follow the download together, each new figure within a second of the engine's`,
      reached.length >= 3 && panelLag.length >= reached.length - 1 && popupLag.length >= reached.length - 1 &&
      Math.max(...panelLag, ...popupLag) <= 1000 && Math.max(...apart) <= 1000, pushNote);

    // A connection that drops is retried by the engine on its own.
    await setup.bringToFront();
    server.set({ status: 503 });
    server.drop();
    const retrying = await until(async () => (await textOf(setup, "#engine-progress"))?.includes(w("engineRetrying")), 15000);
    check(`${lang}: a dropped connection says it is trying again`, retrying, await textOf(setup, "#engine-progress"));
    server.set({ status: 0 });
    const recovered = await until(async () => {
      const line = await textOf(setup, "#engine-progress");
      return line && !line.includes(w("engineRetrying")) && (await statusOf(setup)) === w("engineDownloading");
    }, 20000);
    check(`${lang}: …and carries on when the connection is back`, recovered, await textOf(setup, "#engine-progress"));

    // Pause, then Resume from the bytes on disk.
    await setup.click("#component-primary");
    const paused = await until(async () => (await statusOf(setup)) === w("enginePaused"), 15000);
    const pausedLine = await textOf(setup, "#engine-progress");
    check(`${lang}: Pause stops the download and keeps its progress`, paused && /^\d+% · /.test(pausedLine ?? "") && !pausedLine.includes(w("engineSpeed", "").trim()) &&
      (await textOf(setup, "#component-primary")) === w("componentResumeDownload"), pausedLine);
    const pausedAt = Date.now();
    const panelPaused = await until(async () => pattern(lang, "panelSetupPaused").test((await panelNotice())?.text ?? ""), 5000, 50);
    const panelPausedMs = Date.now() - pausedAt;
    const popupPaused = await until(async () => pattern(lang, "popupSetupPaused").test(await live.evaluate(() => document.getElementById("status").textContent)), 5000, 50);
    const pushes = await live.evaluate(() => window.__pushes);
    await sleep(3000);
    check(`${lang}: the panel and the popup say paused at once, and nothing is pushed while no download runs`,
      panelPaused && panelPausedMs <= 1500 && popupPaused && (await live.evaluate(() => window.__pushes)) === pushes, `${panelPausedMs} ms, ${pushes} pushes`);
    await live.close();
    let before = server.requests.length;
    await setup.click("#component-primary");
    await until(async () => (await statusOf(setup)) === w("engineDownloading"), 15000);
    const resumedAt = await until(async () => server.requests.slice(before).find((r) => r.file === "model.onnx" && !r.preflight)?.range);
    check(`${lang}: Resume asks for the rest of the file`, /^bytes=[1-9]\d*-$/.test(resumedAt ?? ""), resumedAt);

    // Cancel: a confirmation, then the parts go and setup starts over.
    await setup.click("#engine-cancel");
    const dialog = await until(() => setup.evaluate(() => { const d = document.querySelector("#componentSettings dialog"); return d?.open ? d.textContent : null; }));
    check(`${lang}: Cancel asks first, saying what is deleted`, dialog?.includes(w("engineKeepDownloading")) && dialog.includes(w("engineCancelDownload")), dialog);
    await setup.click("#engine-confirm");
    const cancelled = await until(async () => (await statusOf(setup)) === w("engineNotSetUp"), 20000);
    const after = await engine(setup, "status");
    check(`${lang}: Cancel deletes what arrived and setup starts over`, cancelled && after?.data?.state === "needs_models" && after.data.storage.models_bytes < 10000,
      JSON.stringify(after?.data?.storage));
    // An update after a Cancel does not start it again.
    before = server.requests.length;
    await updated(sw);
    await sleep(3000);
    check(`${lang}: after Cancel, an update does not start the download again`,
      server.requests.length === before && (await engine(setup, "status"))?.data?.state === "needs_models", JSON.stringify(server.requests.slice(before)));
    await setup.close();

    // Not set up: the setup page and Settings show the in-browser block, what it needs, and no command.
    for (const name of ["onboarding", "options"]) {
      const page = await extPage(context, extId, `${name}.html`, problems);
      await until(async () => (await statusOf(page)) === w("engineNotSetUp"), 15000);
      const seen = await page.evaluate(() => ({
        block: !!document.querySelector('#componentSettings[data-engine="in-browser"]'),
        installUi: !!document.querySelector("#install, #install-cmd, #install-copy"),
        text: document.body.innerText,
        version: document.getElementById("version")?.textContent ?? "",
        primary: document.getElementById("component-primary")?.textContent ?? "",
        note: (e => e && !e.hidden ? e.textContent : null)(document.querySelector("#componentSettings .engine-note")),
        isolated: crossOriginIsolated,
      }));
      check(`${lang}: ${name} shows the in-browser engine block, not set up`, seen.block && (await statusOf(page)) === w("engineNotSetUp"), await statusOf(page));
      check(`${lang}: ${name} offers the one-time download by its size, with no word of a permission`, seen.primary === w("engineSetUpButton", size(DOWNLOAD_BYTES)) &&
        seen.text.includes(w("engineSetUpIntro", size(DOWNLOAD_BYTES))) && seen.note === null && !/huggingface|dl\.fbaipublicfiles/.test(seen.text), seen.primary);
      check(`${lang}: ${name} shows the in-browser engine in use, and ${name === "options" ? "offers the local engine" : "no switch"}`,
        (await page.evaluate(() => chrome.runtime.sendMessage({ action: "getEngine" })))?.engine === "inbrowser" &&
        (name === "options" ? (await shown(page, "#engine-switch")) && (await textOf(page, "#engine-switch")) === w("engineSwitchToNative") : !(await shown(page, "#engine-switch"))));
      check(`${lang}: ${name} shows no install command, update, uninstall or benchmark`,
        !seen.installUi && !/curl|Invoke-RestMethod|install\.sh|Terminal|终端/.test(seen.text) &&
        ![w("componentUpdate"), w("componentUninstall"), w("runtimeBenchmark")].some((label) => seen.text.includes(label)), seen.text.slice(0, 300));
      check(`${lang}: ${name} is cross-origin isolated (the manifest's keys)`, seen.isolated === true);
      if (name === "options") check(`${lang}: Settings' version line carries the engine state`, seen.version.includes(w("engineNotSetUp")), seen.version);
      if (name === "onboarding") {
        const reply = await engine(page, "status");
        check(`${lang}: a contract request reaches the in-browser engine through the offscreen document`,
          reply?.ok === true && reply.data?.state === "needs_models" && reply.data?.home === "opfs:anagram-engine", JSON.stringify(reply).slice(0, 300));
        const status = await page.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
        check(`${lang}: the worker reports scoring down for want of setup`, status?.active === "down" && status.setup?.state === "needed", JSON.stringify(status));
      }
      await page.close();
    }

    // The popup: not set up, one button, and it opens setup.
    const popup2 = await extPage(context, extId, "popup.html", problems);
    // The popup paints the tab's own state first and the engine's once the worker answers.
    await until(() => popup2.evaluate((want) => !document.getElementById("action").disabled && document.getElementById("status").textContent === want, w("popupSetupNeeded")));
    const popupSeen = await popup2.evaluate(() => ({ status: document.getElementById("status").textContent, action: document.getElementById("action").textContent, text: document.body.innerText }));
    check(`${lang}: the popup says setup is needed, with one button for it`, popupSeen.status === w("popupSetupNeeded") && popupSeen.action === w("engineSetUp"), JSON.stringify(popupSeen));
    check(`${lang}: the popup shows no install command`, !/curl|Invoke-RestMethod|install\.sh/.test(popupSeen.text));
    const opened = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await popup2.click("#action");
    const setupTab = await opened;
    check(`${lang}: the popup's button opens the setup page`, setupTab?.url().endsWith("/onboarding.html"), setupTab?.url());
    await setupTab?.close();
    if (!popup2.isClosed()) await popup2.close();

    // The panel on the article: set up needed now, and its button to setup.
    await article.bringToFront();
    const notice = await until(async () => { const n = await panelNotice(); return n?.text === w("panelSetupNeeded") ? n : null; }, 20000);
    check(`${lang}: the panel says setup is needed and offers it`, notice?.button === w("engineSetUp"), JSON.stringify(await panelNotice()));
    const fromPanel = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await article.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".panel .pnotice button").click());
    const panelTab = await fromPanel;
    check(`${lang}: the panel's button opens the setup page beside the article`, panelTab?.url().endsWith("/onboarding.html"), panelTab?.url());
    await panelTab?.close();
    await article.close();

    // Save-Data: the setup page says why the download waits, beside Set up.
    const saving = await extPage(context, extId, "onboarding.html", problems, (p) => p.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    }));
    await until(async () => (await statusOf(saving)) === w("engineNotSetUp"));
    check(`${lang}: with Save-Data on, the setup page says the download waits, and offers Set up`,
      (await until(() => textOf(saving, "#componentSettings .engine-note"))) === w("engineSaveData") &&
      (await textOf(saving, "#component-primary")) === w("engineSetUpButton", size(DOWNLOAD_BYTES)), await textOf(saving, "#componentSettings .engine-note"));
    await saving.close();

    // A disk too full to start: said as the page opens, and a click downloads nothing.
    before = server.requests.length;
    const full = await extPage(context, extId, "onboarding.html", problems, (p) => p.addInitScript(() => {
      navigator.storage.estimate = () => Promise.resolve({ quota: 500e6, usage: 100e6 });
    }));
    await until(async () => (await statusOf(full)) === w("engineNotSetUp"));
    const fullText = await until(() => textOf(full, "#componentSettings .component-error"));
    await full.click("#component-primary");
    await sleep(500);
    check(`${lang}: a disk too full to start says how much room to make, and downloads nothing`,
      fullText === w("engineDiskFull", size(DOWNLOAD_BYTES - 400e6)) && (lang !== "en" || fullText.endsWith("then click Retry.")) && (await textOf(full, "#component-primary")) === w("panelRetry") &&
      (await textOf(full, "#componentSettings .component-error")) === fullText && server.requests.length === before, fullText);
    await full.close();

    // Set up against a server that fails: a failed setup, with what to do and Retry; Retry downloads.
    server.set({ status: 404 });
    const again = await extPage(context, extId, "onboarding.html", problems);
    await until(async () => (await statusOf(again)) === w("engineNotSetUp"));
    await again.click("#component-primary");
    const failed = await until(async () => (await statusOf(again)) === w("engineSetupFailed"), 20000);
    check(`${lang}: a server that refuses the download is a failed setup, with what to do and Retry`, failed &&
      (await textOf(again, "#componentSettings .component-error")) === w("engineServerDown") && (await textOf(again, "#component-primary")) === w("panelRetry") &&
      !!(await textOf(again, "#componentSettings .component-details")), await textOf(again, "#componentSettings .component-error"));
    server.set({ status: 0 });
    await again.click("#component-primary");
    const downloading = await until(async () => (await statusOf(again)) === w("engineDownloading") && (await textOf(again, "#engine-progress"))?.match(/^[1-9]\d*% /), 20000);
    check(`${lang}: Retry downloads`, downloading, await statusOf(again));
    await again.close();

    // The engine goes away during the download Retry started, as it does when the browser
    // closes: its offscreen document is closed. Nothing starts it again by itself. On an
    // update the background resumes the download, unless the browser asks to save data.
    // (A relaunch with --load-extension fires onInstalled "install" every time, which a
    // browser that installed the extension once never does; so the worker's own events
    // stand in for the restart and the update.)
    const bytesOnDisk = await (async () => {
      const page = await extPage(context, extId, "options.html", problems);
      const s = await until(async () => { const r = await engine(page, "status"); return r?.data?.download?.bytes_received > 0 ? r.data : null; });
      await page.close();
      return s?.download?.bytes_received ?? 0;
    })();
    await sw.evaluate(() => chrome.offscreen.closeDocument());
    await sleep(1500);
    const restartAt = server.requests.length;
    await sleep(2500);
    check(`${lang}: with the engine gone mid-download, nothing starts it again by itself`, server.requests.length === restartAt, JSON.stringify(server.requests.slice(restartAt)));
    // Nor a page Anagram would read starting to open in the tab in front: the warm-up asks only
    // an engine that is running (lib/backend/warmup.ts). This one never arrives, so no content
    // script asks either.
    const opening = await context.newPage();
    await opening.bringToFront();
    await opening.goto("http://unreachable.test/").catch(() => {});
    await sleep(3000);
    check(`${lang}: …nor a page starting to open in the tab in front`, server.requests.length === restartAt, JSON.stringify(server.requests.slice(restartAt)));
    await opening.close();
    await saveData(sw, true);
    await updated(sw);
    await sleep(3000);
    check(`${lang}: an update while the browser asks to save data does not start the download`, server.requests.length === restartAt, JSON.stringify(server.requests.slice(restartAt)));
    await saveData(sw, false);
    await updated(sw);
    const resumed = await until(async () => server.requests.slice(restartAt).find((r) => r.file === "model.onnx" && !r.preflight && r.range), 20000);
    check(`${lang}: an update resumes a download that was under way, from the bytes on disk`,
      bytesOnDisk > 0 && Number(/^bytes=(\d+)-$/.exec(resumed?.range ?? "")?.[1]) > 0, JSON.stringify(resumed));
    // Cancelled, nothing starts it again: not an update (above), not a relaunch of the browser.
    const settings = await extPage(context, extId, "options.html", problems);
    const gone = await engine(settings, "models.delete", { confirm: true });
    check(`${lang}: cancelled again`, gone?.data?.state === "needs_models", JSON.stringify(gone?.data).slice(0, 200));
    await settings.close();
    await run.close({ keep: true });
    const lastAt = server.requests.length;
    run = await launch(lang, server, run.profile);
    check(`${lang}: the browser comes back, with the same extension`, run.sw && new URL(run.sw.url()).host === extId, run.sw?.url());
    await sleep(3000);
    const last = await extPage(run.context, extId, "options.html", problems);
    const state = await until(async () => (await engine(last, "status"))?.data?.state);
    check(`${lang}: after a Cancel, a browser relaunch does not start the download again`,
      state === "needs_models" && server.requests.length === lastAt, `${state} · ${JSON.stringify(server.requests.slice(lastAt))}`);
    await last.close();

    // States the local server cannot reach quickly, in this language's words.
    const scripted = async (name, options = {}) => {
      const page = await extPage(run.context, extId, "options.html", problems, (p) => scriptEngine(p, name, options));
      await until(async () => { const s = await statusOf(page); return s && s !== w("componentStarting"); });
      await page.waitForTimeout(200);
      const seen = await page.evaluate(() => ({
        status: document.querySelector("#componentSettings .component-status")?.textContent,
        error: (e => e && !e.hidden ? e.textContent : null)(document.querySelector("#componentSettings .component-error")),
        where: (e => e && !e.hidden ? e.textContent : null)(document.querySelector("#componentSettings .engine-where")),
        stored: (e => e && !e.hidden ? e.textContent : null)(document.querySelector("#componentSettings .engine-stored")),
        primary: (e => e && !e.hidden ? e.textContent : null)(document.getElementById("component-primary")),
        manage: !document.getElementById("manage")?.hidden,
        idle: !!document.getElementById("idleUnload"),
      }));
      await page.close();
      return seen;
    };
    for (const [name, key] of [["network", "engineNetworkLost"], ["storage", "engineDiskFull"], ["server", "engineServerDown"], ["damaged", "engineDamaged"], ["stopped_download", "engineDownloadStopped"]]) {
      const seen = await scripted(name);
      const want = key === "engineDiskFull" ? w(key, size(STATES.storage.download.total_bytes - STATES.storage.download.bytes_received)) : w(key);
      check(`${lang}: a download stopped by ${name} says what to do, with Retry`,
        seen.status === w("engineSetupFailed") && seen.error === want && seen.primary === w("panelRetry"), JSON.stringify(seen));
    }
    const gpu = await scripted("ready_gpu");
    check(`${lang}: ready on the GPU, in plain words, with the storage used and idle unloading`,
      gpu.status === w("componentReady") && gpu.where === w("engineOnGpu") && gpu.stored === w("componentStorage", "1.4 GB") && gpu.manage && gpu.idle && !gpu.primary, JSON.stringify(gpu));
    const cpu = await scripted("ready_cpu");
    check(`${lang}: ready on the CPU says it is slower and how to get the GPU`, cpu.where === w("engineOnCpu"), cpu.where);
    const loading = await scripted("loading");
    check(`${lang}: a model loading says so`, loading.status === w("engineLoading") && !loading.error, JSON.stringify(loading));
    const broken = await scripted("load_failed");
    check(`${lang}: a model that will not load says what to do, with Retry`, broken.error === w("engineLoadFailed") && broken.primary === w("panelRetry"), JSON.stringify(broken));
    const crashed = await scripted("ready_gpu", { crashed: true });
    check(`${lang}: an engine given up on for crashing says so, with Retry`, crashed.error === w("componentEngineCrashed") && crashed.primary === w("panelRetry"), JSON.stringify(crashed));
    const loadingPopup = await extPage(run.context, extId, "popup.html", problems, (p) => scriptEngine(p, "loading"));
    await until(() => loadingPopup.evaluate(() => !document.getElementById("action").disabled));
    const loadingSeen = await loadingPopup.evaluate(() => ({ status: document.getElementById("status").textContent, action: document.getElementById("action").textContent }));
    check(`${lang}: while the model starts, the popup says so rather than "not ready"`,
      loadingSeen.status === w("engineLoading") && loadingSeen.action === w("engineShowProgress"), JSON.stringify(loadingSeen));
    await loadingPopup.close();

    // The rest of the extension's pages under cross-origin isolation: the reader opens a PDF.
    const reader = await extPage(run.context, extId, "reader.html", problems);
    await reader.locator("#drop:not([hidden])").waitFor({ timeout: 15000 }).catch(() => {});
    await reader.setInputFiles("#file", { name: "document.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
    const rendered = await until(() => reader.evaluate(() => document.querySelectorAll(".textLayer span").length > 0), 20000);
    check(`${lang}: the reader opens a PDF, isolated`, rendered && (await reader.evaluate(() => crossOriginIsolated)), "");
    await reader.close();
    for (const name of ["popup", "paste"]) {
      const page = await extPage(run.context, extId, `${name}.html`, problems);
      check(`${lang}: the ${name} page is cross-origin isolated`, await until(() => page.evaluate(() => crossOriginIsolated)));
      await page.close();
    }
    check(`${lang}: no errors in the worker or the pages`, problems.length === 0, problems.join(" | "));
  } finally {
    await run.close();
    await server.close();
  }
}

// ---- a disk that fills up mid-download -------------------------------------------------------------

// The storage estimate Set up checks can promise room that is not there, so the write that finds
// the disk full is what stops the download. The engine worker's writes to the origin-private file
// system are made to fail over the DevTools protocol (nothing of the extension changes), both ways
// a full disk fails them: a quota's end throws QuotaExceededError, and a disk that is itself full
// under unlimitedStorage answers Chrome's FILE_ERROR_NO_SPACE (-8) as the count written, 2^32 - 8
// (Chrome 149 on a 400 MB disk image). Each time, Retry with room again carries on.
{
  const w = words("en");
  const server = await modelServer({ rate: 40e6 });
  const run = await launch("en", server, undefined, EXT, undefined, [DEVTOOLS_PORT]);
  const problems = [];
  let worker;
  try {
    const setup = run.context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
      await run.context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 20000 });
    watch(setup, "onboarding.html", problems);
    let onDisk = 0;
    for (const refusal of ["thrown", "counted"]) {
      await until(async () => (await engine(setup, "status"))?.data?.download?.bytes_received > onDisk + 40e6, 30000);
      worker ??= await engineWorker(run.profile);
      await worker.evaluate(`(() => {
        if (!self.__write) {
          self.__write = FileSystemSyncAccessHandle.prototype.write;
          FileSystemSyncAccessHandle.prototype.write = function (buffer, options) {
            if (self.__diskFull === "thrown") throw new DOMException("No space available for this operation", "QuotaExceededError");
            if (self.__diskFull === "counted") return 2 ** 32 - 8;
            return self.__write.call(this, buffer, options);
          };
        }
        self.__diskFull = ${JSON.stringify(refusal)};
      })()`);
      const filledAt = Date.now();
      const failed = await until(async () => (await engine(setup, "status"))?.data?.download?.status === "failed", 10000, 50);
      const stoppedMs = Date.now() - filledAt;
      const requests = server.requests.length;
      const shown = await until(async () => (await statusOf(setup)) === w("engineSetupFailed") && textOf(setup, "#componentSettings .component-error"), 10000);
      await sleep(3000);
      const { data } = await engine(setup, "status");
      const received = Math.min(data.download.total_bytes, Math.max(data.download.bytes_received, data.storage.models_bytes));
      console.log(`full disk (${refusal}): stopped ${stoppedMs} ms after the disk filled, at ${data.storage.models_bytes} bytes; "${shown}"`);
      check(`full disk (${refusal}): a write that finds the disk full stops the download at once, without a retry`,
        failed && stoppedMs < 2000 && server.requests.length === requests && data.download.error === "There is not enough free disk space for model.onnx",
        JSON.stringify({ stoppedMs, error: data.download.error, after: server.requests.slice(requests) }));
      check(`full disk (${refusal}): the setup page says how much room to make, from what is left to download, with Retry`,
        shown === w("engineDiskFull", size(DOWNLOAD_BYTES - received)) && (await textOf(setup, "#component-primary")) === w("panelRetry"), shown);
      check(`full disk (${refusal}): what arrived stays on disk`, data.storage.models_bytes > onDisk + 40e6 && data.storage.models_bytes === data.download.bytes_received,
        JSON.stringify(data.storage));
      onDisk = data.storage.models_bytes;
      // Room again: Retry asks for the rest of the file, from the bytes on disk.
      await worker.evaluate("self.__diskFull = null");
      const before = server.requests.length;
      await setup.click("#component-primary");
      const resumed = await until(async () => server.requests.slice(before).find((r) => r.file === "model.onnx" && !r.preflight)?.range, 15000);
      const running = await until(async () => (await statusOf(setup)) === w("engineDownloading"), 15000);
      check(`full disk (${refusal}): with room again, Retry carries on from the bytes on disk`, resumed === `bytes=${onDisk}-` && running, resumed);
    }
    await engine(setup, "models.delete", { confirm: true });
    check("full disk: no errors in the pages", problems.length === 0, problems.join(" | "));
  } finally {
    await worker?.close();
    await run.close();
    await server.close();
  }
}

// ---- once, with the real files: the whole way to Ready, a score and deletion --------------------

if (REAL) {
  const files = realFiles(process.env.ANAGRAM_MODELKIT ?? join(homedir(), "anagram-bench", "bench", "model"));
  if (process.env.CI || !files) console.log("SKIP  the real download — set ANAGRAM_MODELKIT to the pinned modelkit");
  else await realRun(files);
}

async function realRun(files) {
  const w = words("en");
  const server = await modelServer({ files });
  const run = await launch("en", server);
  const problems = [];
  try {
    const began = Date.now();
    const extId = new URL(run.sw.url()).host;
    const setup = run.context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
      await run.context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 20000 });
    watch(setup, "onboarding.html", problems);
    await setup.bringToFront();
    const ready = await until(async () => {
      const s = await statusOf(setup);
      return s === w("componentReady") || s === w("engineSetupFailed") || s === w("componentNeedsAttention") ? s : null;
    }, 15 * 60_000, 1000);
    console.log(`real: ${ready} after ${((Date.now() - began) / 1000).toFixed(0)} s`);
    check("real: from install alone, the pinned files download, verify and load to Ready", ready === w("componentReady"), `${ready}: ${await textOf(setup, "#componentSettings .component-error")}`);
    check("real: the language identifier came from the package, not the network", server.requests.every((r) => HUGGING_FACE.test(r.host) && r.file !== "lid.176.ftz"),
      JSON.stringify(server.requests.map((r) => `${r.host}${r.path}`)));
    const where = await textOf(setup, "#componentSettings .engine-where");
    check("real: the model runs on the GPU, said in plain words", where === w("engineOnGpu"), where);
    check("real: the storage used is the model's", (await textOf(setup, "#componentSettings .engine-stored")) === w("componentStorage", size(DOWNLOAD_BYTES)));
    const status = await engine(setup, "status");
    const wasm = status?.data?.runtime?.candidates?.find((c) => c.id === "wasm:fp32");
    check("real: the offscreen document is cross-origin isolated (WASM threads)", /\b[2-9] threads\b/.test(wasm?.label ?? ""), wasm?.label);
    check("real: the setup page offers the site grant once ready", await setup.evaluate(() => !document.getElementById("ready").hidden));
    // A score through the ordinary pipeline.
    const paste = await extPage(run.context, extId, "paste.html", problems);
    await paste.fill("#text", `${PARA(1)} ${PARA(2)}`);
    await paste.click("#analyze");
    const verdict = await until(() => paste.evaluate(() => !document.getElementById("results").hidden && document.getElementById("summary").textContent), 120_000, 500);
    check("real: the paste page scores with the downloaded model", !!verdict, verdict);
    await paste.close();
    // Delete, from Manage.
    await setup.evaluate(() => { document.getElementById("manage").open = true; });
    await setup.click("#engine-delete");
    await setup.click("#engine-confirm");
    const gone = await until(async () => (await statusOf(setup)) === w("engineNotSetUp"), 60_000);
    const after = await engine(setup, "status");
    check("real: Delete model files empties the engine's storage", gone && after?.data?.storage?.models_bytes < 10000, JSON.stringify(after?.data?.storage));
    check("real: no errors in the pages", problems.length === 0, problems.join(" | "));
  } finally {
    await run.close();
    await server.close();
  }
}

await site.close();
for (const r of results) if (r.ok) console.log(`PASS  ${r.name}`);
const failedCount = results.filter((r) => !r.ok).length;
console.log(failedCount ? `❌ ${failedCount} IN-BROWSER CHECKS FAILED` : `✅ ${results.length} IN-BROWSER CHECKS GREEN`);
process.exit(failedCount ? 1 : 0);
