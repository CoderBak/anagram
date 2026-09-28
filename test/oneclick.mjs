// test/oneclick.mjs — the oneclick flavor's test build, set up the way a person sets it up.
//
// The flavor swaps the engine transport and the setup/Settings engine panel
// (scripts/flavor.mjs). This starts the test build for real, in English and in Chinese, each
// in a temporary profile, with Hugging Face answered on this machine
// (test/webengine/model-server.mjs: Chromium resolves its names to a local HTTPS server that
// answers CORS as Hugging Face does, and nothing else resolves at all):
//
//   - installing is setting up: the model's download starts by itself and the setup page
//     opens on it running, with Pause and Cancel; the manifest names no model host, and with
//     the shipped permissions (no host at all) the download goes by CORS alone; the package
//     carries lid.176.ftz;
//   - the download with progress, speed and time left, the popup's and the panel's progress
//     line, a dropped connection retried by itself, Pause and Resume from the bytes on disk,
//     and Cancel;
//   - not set up: every page shows the in-browser block and no install command, the popup and
//     the in-page panel say setup is needed and open the setup page, Save-Data and a disk too
//     full say why the download waits, a server error and Retry;
//   - an engine gone mid-download is not started again by itself; an update resumes the
//     download, unless the browser asks to save data; after a Cancel neither an update nor a
//     browser relaunch starts it;
//   - the states that take a finished download, a GPU or a failure to reach (ready on the
//     graphics card or the processor, loading, each kind of failure, a model that would not
//     load, an engine that kept crashing) scripted into the page (test/webengine/scripted-engine.mjs);
//   - every extension page is cross-origin isolated under the manifest's keys, and the
//     reader still opens a PDF.
//
// The downloads are zeros from the local server: a paused, cancelled or failed download is
// never verified. `--real` adds one run with the real files, the whole way to Ready and a
// score without a click (ANAGRAM_MODELKIT, or ~/anagram-bench's copy): 1.4 GB into a
// temporary profile that is deleted after; never in CI.
//
//   npm run test:oneclick              # builds output-test/oneclick-chrome-mv3 when stale
//   node test/oneclick.mjs --real      # and the real download, load and score
import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { serveHtml, uiLanguage } from "./harness.mjs";
import { ensureTestBuild } from "./test-build.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";
import { DOWNLOAD_BYTES, modelServer, realFiles } from "./webengine/model-server.mjs";
import { STATES, scriptEngine } from "./webengine/scripted-engine.mjs";
import { LID } from "../scripts/webengine.mjs";

const EXT = ensureTestBuild("oneclick-chrome-mv3");
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
async function launch(lang, server, profile = mkdtempSync(join(tmpdir(), "anagram-oneclick-")), extension = EXT) {
  const localized = lang === "en" ? {} : uiLanguage(lang);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: "chromium", ...localized, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check", ...server.args, ...(localized.args ?? [])],
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
  const copy = mkdtempSync(join(tmpdir(), "anagram-oneclick-shipped-"));
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

    const worker = await sw.evaluate(() => ({ manifest: chrome.runtime.getManifest(), connectNative: typeof chrome.runtime.connectNative }));
    check(`${lang}: no nativeMessaging permission, and no connectNative to call`,
      !worker.manifest.permissions.includes("nativeMessaging") && worker.connectNative === "undefined", JSON.stringify(worker.manifest.permissions));
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
    await until(() => popup2.evaluate(() => !document.getElementById("action").disabled && /\S/.test(document.getElementById("status").textContent)));
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
      fullText === w("engineDiskFull", size(DOWNLOAD_BYTES - 400e6)) && (await textOf(full, "#componentSettings .component-error")) === fullText && server.requests.length === before, fullText);
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
console.log(failedCount ? `❌ ${failedCount} ONECLICK CHECKS FAILED` : `✅ ${results.length} ONECLICK CHECKS GREEN`);
process.exit(failedCount ? 1 : 0);
