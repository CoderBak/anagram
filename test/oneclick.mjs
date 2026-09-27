// test/oneclick.mjs — the oneclick flavor's test build, set up the way a person sets it up.
//
// The flavor swaps the engine transport and the setup/Settings engine panel
// (scripts/flavor.mjs). This starts the test build for real, in English and in Chinese, each
// in a temporary profile, with the model's download hosts answered on this machine
// (test/webengine/model-server.mjs: Chromium resolves huggingface.co and
// dl.fbaipublicfiles.com to a local HTTPS server, and nothing else resolves at all):
//
//   - the worker starts without Native Messaging, a contract request reaches the in-browser
//     engine in its offscreen document, and every page shows the in-browser block and no
//     install command;
//   - the popup and the in-page panel say setup is needed and open the setup page;
//   - setup from its one button: the browser's permission for the download hosts first
//     (refused, then granted), a server error and Retry, the download with progress, speed
//     and time left, the popup's and the panel's progress line, Pause and Resume from the
//     bytes on disk, a dropped connection retried by itself, Cancel, and a disk too full
//     to start;
//   - the states that take a finished download, a GPU or a failure to reach (ready on the
//     graphics card or the processor, loading, each kind of failure, a model that would not
//     load, an engine that kept crashing) scripted into the page (test/webengine/scripted-engine.mjs);
//   - every extension page is cross-origin isolated under the manifest's keys, and the
//     reader still opens a PDF.
//
// The downloads are zeros from the local server: a paused, cancelled or failed download is
// never verified. `--real` adds one run with the real files, the whole way to Ready and a
// score (ANAGRAM_MODELKIT and ANAGRAM_LID_MODEL, or ~/anagram-bench's copies): 1.4 GB into a
// temporary profile that is deleted after; never in CI.
//
//   npm run test:oneclick              # builds output-test/oneclick-chrome-mv3 when stale
//   node test/oneclick.mjs --real      # and the real download, load and score
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { serveHtml, uiLanguage } from "./harness.mjs";
import { ensureTestBuild } from "./test-build.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";
import { DOWNLOAD_BYTES, modelServer, realFiles } from "./webengine/model-server.mjs";
import { STATES, scriptEngine } from "./webengine/scripted-engine.mjs";

const EXT = ensureTestBuild("oneclick-chrome-mv3");
const REAL = process.argv.includes("--real");
const MODEL_HOSTS = ["https://huggingface.co/*", "https://*.hf.co/*", "https://dl.fbaipublicfiles.com/*"];

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

const until = async (fn, timeout = 15000, step = 200) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, step));
  }
};

async function launch(lang, server) {
  const profile = mkdtempSync(join(tmpdir(), "anagram-oneclick-"));
  const localized = lang === "en" ? {} : uiLanguage(lang);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: "chromium", ...localized, viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check", ...server.args, ...(localized.args ?? [])],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  return { context, sw, profile, close: async () => { await context.close().catch(() => {}); rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

/** A page of the extension, failing the run on any uncaught error in it. */
async function extPage(context, extId, path, problems, script) {
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`${path}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${path}: ${m.text()}`); });
  if (script) await script(page);
  await page.goto(`chrome-extension://${extId}/${path}`);
  return page;
}
const statusOf = (page) => page.evaluate(() => document.querySelector("#componentSettings .component-status")?.textContent ?? "");
const textOf = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); return el && !el.hidden ? el.textContent : null; }, selector);
const engine = (page, op, payload = {}) => page.evaluate(([op, payload]) => chrome.runtime.sendMessage({ action: "anagram.nativeRequest", op, payload }), [op, payload]);

// ---- the flow, in each language ---------------------------------------------------------------

for (const lang of ["en", "zh-CN"]) {
  const w = words(lang);
  const server = await modelServer({ rate: 15e6 });
  const run = await launch(lang, server);
  const { context, sw } = run;
  const problems = [];
  try {
    check(`${lang}: the background worker starts`, sw);
    if (!sw) continue;
    sw.on("console", (m) => { if (m.type() === "error") problems.push(`worker: ${m.text()}`); });
    const extId = new URL(sw.url()).host;
    const language = await sw.evaluate(() => chrome.i18n.getUILanguage());
    if (!language.toLowerCase().startsWith(lang.split("-")[0])) { console.log(`SKIP  ${lang}: the browser came up in ${language}`); continue; }

    const worker = await sw.evaluate(() => ({ manifest: chrome.runtime.getManifest(), connectNative: typeof chrome.runtime.connectNative }));
    check(`${lang}: no nativeMessaging permission, and no connectNative to call`,
      !worker.manifest.permissions.includes("nativeMessaging") && worker.connectNative === "undefined", JSON.stringify(worker.manifest.permissions));

    // The setup page and Settings: the in-browser block, what it needs, and no command.
    for (const name of ["onboarding", "options"]) {
      const page = await extPage(context, extId, `${name}.html`, problems);
      await until(async () => (await statusOf(page)) === w("engineNotSetUp"), 15000);
      const seen = await page.evaluate(() => ({
        block: !!document.querySelector('#componentSettings[data-engine="in-browser"]'),
        installUi: !!document.querySelector("#install, #install-cmd, #install-copy"),
        text: document.body.innerText,
        version: document.getElementById("version")?.textContent ?? "",
        primary: document.getElementById("component-primary")?.textContent ?? "",
        isolated: crossOriginIsolated,
      }));
      check(`${lang}: ${name} shows the in-browser engine block, not set up`, seen.block && (await statusOf(page)) === w("engineNotSetUp"), await statusOf(page));
      check(`${lang}: ${name} offers the one-time download by its size`, seen.primary === w("engineSetUpButton", size(DOWNLOAD_BYTES)) &&
        seen.text.includes(w("engineSetUpIntro", size(DOWNLOAD_BYTES))) && seen.text.includes(w("engineSetUpHosts")), seen.primary);
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
    const popup = await extPage(context, extId, "popup.html", problems);
    await until(() => popup.evaluate(() => !document.getElementById("action").disabled));
    const popupSeen = await popup.evaluate(() => ({ status: document.getElementById("status").textContent, action: document.getElementById("action").textContent, text: document.body.innerText }));
    check(`${lang}: the popup says setup is needed, with one button for it`, popupSeen.status === w("popupSetupNeeded") && popupSeen.action === w("engineSetUp"), JSON.stringify(popupSeen));
    check(`${lang}: the popup shows no install command`, !/curl|Invoke-RestMethod|install\.sh/.test(popupSeen.text));
    const opened = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await popup.click("#action");
    const setupTab = await opened;
    check(`${lang}: the popup's button opens the setup page`, setupTab?.url().endsWith("/onboarding.html"), setupTab?.url());
    await setupTab?.close();
    if (!popup.isClosed()) await popup.close();

    // The panel on a web page: the ball's "!", the notice, and its button to setup.
    const article = await context.newPage();
    article.on("pageerror", (e) => problems.push(`article: ${e.message}`));
    await article.goto(site.url("/article.html"));
    const down = await until(() => article.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent === "!"), 30000);
    check(`${lang}: the ball shows the engine is not ready`, down);
    const panelNotice = () => article.evaluate(() => {
      const root = document.getElementById("anagram-fab")?.shadowRoot;
      if (!root?.querySelector(".panel.open")) root?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const notice = root?.querySelector(".panel .pnotice");
      return notice ? { text: notice.querySelector("span")?.textContent, button: notice.querySelector("button")?.textContent } : null;
    });
    const notice = await until(async () => { const n = await panelNotice(); return n?.text === w("panelSetupNeeded") ? n : null; }, 15000);
    check(`${lang}: the panel says setup is needed and offers it`, notice?.button === w("engineSetUp"), JSON.stringify(await panelNotice()));
    const fromPanel = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await article.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".panel .pnotice button").click());
    const panelTab = await fromPanel;
    check(`${lang}: the panel's button opens the setup page beside the article`, panelTab?.url().endsWith("/onboarding.html"), panelTab?.url());
    await panelTab?.close();

    // Setup, refused: the browser's question is asked, the answer is no, nothing downloads.
    const refused = await extPage(context, extId, "onboarding.html", problems, (p) => p.addInitScript(() => {
      window.__asked = [];
      chrome.permissions.request = (request) => { window.__asked.push(request.origins); return Promise.resolve(false); };
    }));
    await until(async () => (await statusOf(refused)) === w("engineNotSetUp"));
    await refused.click("#component-primary");
    const refusal = await until(() => textOf(refused, "#componentSettings .component-error"));
    check(`${lang}: a refused permission says how to fix it, and downloads nothing`,
      refusal === w("enginePermissionRefused") && server.requests.length === 0, `${refusal} · ${server.requests.length} requests`);
    check(`${lang}: the question named exactly the download hosts`, JSON.stringify(await refused.evaluate(() => window.__asked)) === JSON.stringify([MODEL_HOSTS]));
    check(`${lang}: the button still offers setup after a refusal`, (await textOf(refused, "#component-primary")) === w("engineSetUpButton", size(DOWNLOAD_BYTES)));
    await refused.close();

    // A disk too full to start: the browser's estimate is short, and nothing downloads.
    const full = await extPage(context, extId, "onboarding.html", problems, (p) => p.addInitScript(() => {
      navigator.storage.estimate = () => Promise.resolve({ quota: 500e6, usage: 100e6 });
    }));
    await until(async () => (await statusOf(full)) === w("engineNotSetUp"));
    await full.click("#component-primary");
    const fullText = await until(() => textOf(full, "#componentSettings .component-error"));
    check(`${lang}: a disk too full to start says how much room to make`, fullText === w("engineDiskFull", size(DOWNLOAD_BYTES - 400e6)) && server.requests.length === 0, fullText);
    await full.close();

    // Setup, granted, against a server that fails: the permission comes first, then the download; Retry.
    server.set({ status: 404 });
    const setup = await extPage(context, extId, "onboarding.html", problems, (p) => p.addInitScript(() => {
      window.__order = [];
      const request = chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request = (r) => { window.__order.push("permissions.request"); return request(r); };
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m, ...rest) => { if (m?.op && m.op !== "status") window.__order.push(m.op); return send(m, ...rest); };
    }));
    await until(async () => (await statusOf(setup)) === w("engineNotSetUp"));
    await setup.click("#component-primary");
    const failed = await until(async () => (await statusOf(setup)) === w("engineSetupFailed"), 20000);
    check(`${lang}: the permission is asked for before the download starts`,
      JSON.stringify(await setup.evaluate(() => window.__order)) === JSON.stringify(["permissions.request", "models.download"]), JSON.stringify(await setup.evaluate(() => window.__order)));
    check(`${lang}: a server that refuses the download is a failed setup, with what to do and Retry`, failed &&
      (await textOf(setup, "#componentSettings .component-error")) === w("engineServerDown") && (await textOf(setup, "#component-primary")) === w("panelRetry") &&
      !!(await textOf(setup, "#componentSettings .component-details")), await textOf(setup, "#componentSettings .component-error"));

    // Retry, and the download runs: progress, speed, time left, in the popup and the panel too.
    server.set({ status: 0 });
    await setup.click("#component-primary");
    const downloading = await until(async () => (await statusOf(setup)) === w("engineDownloading"), 15000);
    check(`${lang}: Retry downloads`, downloading, await statusOf(setup));
    const withSpeed = await until(async () => {
      const line = await textOf(setup, "#engine-progress");
      return line && line.includes(w("engineSpeed", "").trim()) ? line : null;
    }, 15000);
    const left = ["engineLeftUnderMinute", "engineLeftMinutes_one", "engineLeftMinutes_other", "engineLeftHours"].map((key) => pattern(lang, key));
    check(`${lang}: the progress line has percent, bytes, speed and time left`,
      withSpeed && /^\d+% · /.test(withSpeed) && withSpeed.includes(size(DOWNLOAD_BYTES)) && left.some((re) => re.test(withSpeed)), withSpeed);
    check(`${lang}: the progress bar moves`, await setup.evaluate(() => { const p = document.querySelector("#componentSettings progress"); return !p.hidden && p.value > 0 && p.max > p.value; }));
    check(`${lang}: while it downloads, Pause and Cancel`, (await textOf(setup, "#component-primary")) === w("componentPauseDownload") && (await textOf(setup, "#engine-cancel")) === w("engineCancelDownload"));
    const popup2 = await extPage(context, extId, "popup.html", problems);
    const popupLine = await until(async () => {
      const line = await popup2.evaluate(() => document.getElementById("status").textContent);
      return /\d/.test(line) ? line : null;
    });
    const percent = Number(/(\d+)%/.exec(popupLine ?? "")?.[1]);
    check(`${lang}: the popup shows the download's progress`, popupLine === w("popupSetupDownloading", percent) &&
      (await popup2.evaluate(() => document.getElementById("action").textContent)) === w("engineShowProgress"), popupLine);
    await popup2.close();
    const panelLine = await until(async () => { const n = await panelNotice(); return n && /\d/.test(n.text ?? "") ? n : null; }, 15000);
    const panelPercent = Number(/(\d+)%/.exec(panelLine?.text ?? "")?.[1]);
    check(`${lang}: the panel shows the download's progress`, panelLine?.text === w("panelSetupDownloading", panelPercent) && panelLine?.button === w("engineShowProgress"), JSON.stringify(panelLine));

    // A connection that drops is retried by the engine on its own.
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
    const before = server.requests.length;
    await setup.click("#component-primary");
    await until(async () => (await statusOf(setup)) === w("engineDownloading"), 15000);
    const resumedAt = await until(async () => server.requests.slice(before).find((r) => r.file === "model.onnx")?.range);
    check(`${lang}: Resume asks for the rest of the file`, /^bytes=[1-9]\d*-$/.test(resumedAt ?? ""), resumedAt);

    // Cancel: a confirmation, then the parts go and setup starts over.
    await setup.click("#engine-cancel");
    const dialog = await until(() => setup.evaluate(() => { const d = document.querySelector("#componentSettings dialog"); return d?.open ? d.textContent : null; }));
    check(`${lang}: Cancel asks first, saying what is deleted`, dialog?.includes(w("engineKeepDownloading")) && dialog.includes(w("engineCancelDownload")), dialog);
    await setup.click("#componentSettings dialog .btn[data-variant=destructive]");
    const cancelled = await until(async () => (await statusOf(setup)) === w("engineNotSetUp"), 20000);
    const after = await engine(setup, "status");
    check(`${lang}: Cancel deletes what arrived and setup starts over`, cancelled && after?.data?.state === "needs_models" && after.data.storage.models_bytes < 10000,
      JSON.stringify(after?.data?.storage));
    await setup.close();
    await article.close();

    // States the local server cannot reach quickly, in this language's words.
    const scripted = async (name, options = {}) => {
      const page = await extPage(context, extId, "options.html", problems, (p) => scriptEngine(p, name, options));
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
    const lost = await scripted("network", { permission: false });
    check(`${lang}: a failed download without the host grant asks for it again`, lost.error === w("enginePermissionRefused"), lost.error);
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

    // The rest of the extension's pages under cross-origin isolation: the reader opens a PDF.
    const reader = await extPage(context, extId, "reader.html", problems);
    await reader.locator("#drop:not([hidden])").waitFor({ timeout: 15000 }).catch(() => {});
    await reader.setInputFiles("#file", { name: "document.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
    const rendered = await until(() => reader.evaluate(() => document.querySelectorAll(".textLayer span").length > 0), 20000);
    check(`${lang}: the reader opens a PDF, isolated`, rendered && (await reader.evaluate(() => crossOriginIsolated)), "");
    await reader.close();
    for (const name of ["popup", "paste"]) {
      const page = await extPage(context, extId, `${name}.html`, problems);
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
  const files = realFiles(process.env.ANAGRAM_MODELKIT ?? join(homedir(), "anagram-bench", "bench", "model"),
    process.env.ANAGRAM_LID_MODEL ?? join(homedir(), "anagram-bench", "bench", "lid", "lid.176.ftz"));
  if (process.env.CI || !files) console.log("SKIP  the real download — set ANAGRAM_MODELKIT and ANAGRAM_LID_MODEL to the pinned files");
  else await realRun(files);
}

async function realRun(files) {
  const w = words("en");
  const server = await modelServer({ files });
  const run = await launch("en", server);
  const problems = [];
  try {
    const extId = new URL(run.sw.url()).host;
    const setup = await extPage(run.context, extId, "onboarding.html", problems);
    await until(async () => (await statusOf(setup)) === w("engineNotSetUp"));
    const began = Date.now();
    await setup.click("#component-primary");
    const ready = await until(async () => {
      const s = await statusOf(setup);
      return s === w("componentReady") || s === w("engineSetupFailed") || s === w("componentNeedsAttention") ? s : null;
    }, 15 * 60_000, 1000);
    console.log(`real: ${ready} after ${((Date.now() - began) / 1000).toFixed(0)} s`);
    check("real: the pinned files download, verify and load to Ready", ready === w("componentReady"), `${ready}: ${await textOf(setup, "#componentSettings .component-error")}`);
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
    await setup.click("#componentSettings dialog .btn[data-variant=destructive]");
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
