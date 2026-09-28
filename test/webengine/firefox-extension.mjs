// test/webengine/firefox-extension.mjs — the oneclick Firefox build, started for real.
//
//   ANAGRAM_FIREFOX=<binary> node test/webengine/firefox-extension.mjs [--hf]
//
// Firefox MV2 has no offscreen documents: the background page hosts the engine's worker
// itself (lib/webengine/client.ts). This installs the oneclick Firefox test build
// temporarily into a headless Firefox with a temporary profile and HOME (the way
// test/firefox-harness.mjs does for the native build), asks the engine for its status
// through the background's bridge from the options page, and expects the worker to
// answer as it does on Chrome: the download started by itself at install, then, cancelled,
// no model files, the runtime not ready, and Settings offering the one-time download.
// Hugging Face resolves to this machine, where nothing answers, so nothing is downloaded;
// with --hf the download goes to Hugging Face for real, from the background page with no
// host permission (a copy of the test build asking for what the shipped one asks for: the
// test build holds every site), until 20 MB have arrived, and is cancelled. The oneclick package needs
// Firefox 153 (wxt.config.ts); an older binary is skipped, as that Firefox refuses to install it.
import { launch } from "puppeteer-core";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTestBuild } from "../test-build.mjs";
import { firefoxVersion } from "../firefox-harness.mjs";

const firefox = process.env.ANAGRAM_FIREFOX;
if (!firefox) { console.log("SKIP  oneclick Firefox — set ANAGRAM_FIREFOX to a Firefox 153+ binary"); process.exit(0); }
const { major, version } = firefoxVersion(firefox);
if (major < 153) { console.log(`SKIP  oneclick Firefox — it needs Firefox 153 or later, this is ${version}`); process.exit(0); }
process.env.ANAGRAM_FLAVOR = "oneclick";
const EXT = ensureTestBuild("oneclick-firefox-mv2");
const GECKO_ID = "anagram-oneclick@coderbak.dev";
const UUID = "7c1f3d2a-8b4e-4a6f-9d21-5e0c8a7b3f14";
const HF = process.argv.includes("--hf");
const home = mkdtempSync(join(tmpdir(), "anagram-oneclick-ff-"));
let extension = EXT;
if (HF) {
  extension = join(home, "extension");
  cpSync(EXT, extension, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
  manifest.permissions = manifest.permissions.filter((p) => !p.includes("://"));
  manifest.optional_permissions = ["clipboardWrite", "https://*/*", "http://*/*", "file:///*"];
  writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
}
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${note}`}`); };
const browser = await launch({
  browser: "firefox", protocol: "webDriverBiDi", executablePath: firefox, userDataDir: join(home, "profile"), headless: true,
  ignoreDefaultArgs: ["--foreground"], defaultViewport: null, protocolTimeout: 0,
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), MOZ_CRASHREPORTER_DISABLE: "1" },
  args: ["-remote-allow-system-access"],
  extraPrefsFirefox: {
    "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: UUID }),
    "xpinstall.signatures.required": false, "browser.shell.checkDefaultBrowser": false, "browser.startup.homepage_override.mstone": "ignore",
    "datareporting.policy.dataSubmissionEnabled": false, "toolkit.telemetry.enabled": false, "app.update.enabled": false, "browser.aboutwelcome.enabled": false,
    // Installing starts the model's download (lib/webengine/autoSetup.ts): here it goes nowhere.
    ...(HF ? {} : { "network.dns.localDomains": "huggingface.co" }),
  },
});
try {
  console.log(`Firefox ${await browser.version()}`);
  const installed = await browser.installExtension(extension);
  check("the oneclick build installs", installed === GECKO_ID, installed);
  const page = await browser.newPage();
  const url = `moz-extension://${UUID}/options.html`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => {});
  for (let i = 0; i < 100; i++) {
    const at = await page.evaluate(() => [location.href, document.readyState]).catch(() => null);
    if (at && at[0] === url && at[1] !== "loading") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const request = (op, payload = {}) => page.evaluate(([op, payload]) => browser.runtime.sendMessage({ action: "anagram.nativeRequest", op, payload }), [op, payload]);
  let reply;
  for (let i = 0; i < 60; i++) {
    reply = await request("status").catch((e) => ({ error: String(e) }));
    if (reply?.ok && ["running", "failed"].includes(reply.data?.download?.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check("installing started the model's download in the background page's worker", reply?.ok && ["running", "failed"].includes(reply.data?.download?.status) && reply.data?.home === "opfs:anagram-engine", JSON.stringify(reply).slice(0, 400));
  if (HF) {
    const granted = await page.evaluate(() => browser.permissions.getAll());
    check("no host is granted", (granted.origins ?? []).length === 0, JSON.stringify(granted));
    for (let i = 0; i < 120 && !(reply?.data?.download?.bytes_received > 20e6) && reply?.data?.download?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      reply = await request("status");
    }
    check("Hugging Face's bytes arrive by CORS, with no host permission", reply?.data?.download?.bytes_received > 20e6 && !reply.data.download.error, JSON.stringify(reply?.data?.download));
  }
  reply = await request("models.delete", { confirm: true });
  check("Cancel leaves the engine not set up", reply?.ok && reply.data?.state === "needs_models", JSON.stringify(reply).slice(0, 400));
  const runtime = await request("runtime");
  check("runtime says not_ready before the model", !runtime?.ok && runtime?.status === 503 && runtime?.error?.code === "not_ready", JSON.stringify(runtime).slice(0, 200));
  const settings = await request("engine.settings", { idle_unload_s: 600 });
  check("engine.settings is answered", settings?.ok && settings.data?.settings?.idle_unload_s === 600, JSON.stringify(settings).slice(0, 200));
  const status = await page.evaluate(() => browser.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
  check("the background reports scoring unavailable, not an error", status?.active === "down", JSON.stringify(status).slice(0, 200));
  // The panel reads the engine only while its page is shown: a tab opened behind another stays "Starting…".
  await page.bringToFront().catch(() => {});
  let seen;
  for (let i = 0; i < 80; i++) {
    seen = await page.evaluate(() => ({ line: document.querySelector("#componentSettings .component-status")?.textContent ?? "", button: document.getElementById("component-primary")?.textContent ?? "", visibility: document.visibilityState }));
    if (/Not set up yet|尚未设置/.test(seen.line)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("Settings says setup is needed and offers the download", /Not set up yet|尚未设置/.test(seen.line) && /1\.4 GB/.test(seen.button), JSON.stringify(seen));
} catch (error) {
  check("no exception", false, String(error?.stack ?? error));
} finally {
  await browser.close().catch(() => {});
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
