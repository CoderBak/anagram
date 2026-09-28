// test/webengine/firefox-extension.mjs — both engines in a real Firefox, started for real.
//
//   ANAGRAM_FIREFOX=<binary> node test/webengine/firefox-extension.mjs [--hf]
//
// Copies of the Firefox test build that stand in for devices (test/test-build.mjs
// deviceBuild: Native Messaging optional, as shipped) are installed temporarily into a
// headless Firefox with a temporary profile and HOME, the way test/firefox-harness.mjs does,
// with Hugging Face resolving to this machine, where nothing answers (--hf lets the one
// download below reach Hugging Face for real, 20 MB, with no host permission):
//
//   - this machine as it is: Firefox 140 has no WebAssembly JSPI, so the setup page offers the
//     local engine alone, saying Firefox 153 runs the in-browser one; picking it asks for
//     Native Messaging, granted here without the prompt (the profile's
//     extensions.webextOptionalPermissionPrompts), and the page shows the install command;
//     runtime.connectNative is there once granted, with no reload, and reaches no host (none is
//     registered by that name). On macOS Firefox looks for hosts in the real Application
//     Support folder, whatever HOME says: where a real registration is there, the pick is skipped;
//   - Firefox 153+, a device with no choice: the background page hosts the engine's worker,
//     which the setup page started downloading at install, and which answers the contract after
//     Cancel; a device with a choice downloads nothing before a pick.
import { launch } from "puppeteer-core";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deviceBuild } from "../test-build.mjs";
import { DEVICES } from "../pw/devices.mjs";
import { firefoxVersion } from "../firefox-harness.mjs";

const firefox = process.env.ANAGRAM_FIREFOX;
if (!firefox) { console.log("SKIP  Firefox engines — set ANAGRAM_FIREFOX to a Firefox 140+ binary"); process.exit(0); }
const { major, version } = firefoxVersion(firefox);
if (major < 140) { console.log(`SKIP  Firefox engines — the extension needs Firefox 140 or later, this is ${version}`); process.exit(0); }
const GECKO_ID = "anagram@coderbak.dev";
const UUID = "7c1f3d2a-8b4e-4a6f-9d21-5e0c8a7b3f14";
const HF = process.argv.includes("--hf");
const REAL_HOSTS = join(homedir(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts", "dev.coderbak.anagram.json");

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${note}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 20000, step = 250) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value || Date.now() > end) return value;
    await sleep(step);
  }
};

/** Firefox with `extension` installed temporarily; `run(open)` gets a way to open its pages. */
async function withFirefox(extension, run, { hf = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "anagram-ff-engines-"));
  const browser = await launch({
    browser: "firefox", protocol: "webDriverBiDi", executablePath: firefox, userDataDir: join(home, "profile"), headless: true,
    ignoreDefaultArgs: ["--foreground"], defaultViewport: null, protocolTimeout: 0,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), MOZ_CRASHREPORTER_DISABLE: "1" },
    args: ["-remote-allow-system-access"],
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: UUID }),
      "xpinstall.signatures.required": false, "browser.shell.checkDefaultBrowser": false, "browser.startup.homepage_override.mstone": "ignore",
      "datareporting.policy.dataSubmissionEnabled": false, "toolkit.telemetry.enabled": false, "app.update.enabled": false, "browser.aboutwelcome.enabled": false,
      // The browser's answer to an optional permission, which no automation can click: yes.
      "extensions.webextOptionalPermissionPrompts": false,
      // A setup page that starts a download sends it nowhere.
      ...(hf ? {} : { "network.dns.localDomains": "huggingface.co" }),
    },
  });
  try {
    check(`Firefox ${await browser.version()}: the extension installs`, (await browser.installExtension(extension)) === GECKO_ID);
    const open = async (path) => {
      const page = await browser.newPage();
      const url = `moz-extension://${UUID}/${path}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => {});
      await until(async () => { const at = await page.evaluate(() => [location.href, document.readyState]); return at[0] === url && at[1] !== "loading"; });
      await page.bringToFront().catch(() => {});
      return page;
    };
    await run(open, browser);
  } catch (error) {
    check("no exception", false, String(error?.stack ?? error));
  } finally {
    await browser.close().catch(() => {});
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const shown = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; }, selector);
const text = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
const engineOf = async (page) => (await page.evaluate(() => browser.runtime.sendMessage({ action: "getEngine" })))?.engine ?? null;

// ---- this machine, as it is --------------------------------------------------------------------

await withFirefox(deviceBuild("real", {}, { browser: "firefox" }), async (open) => {
  const setup = await open("onboarding.html");
  const offered = await until(async () => (await shown(setup, "#engine-pick-native")) || (await shown(setup, ".engine-cannot")));
  const seen = await setup.evaluate(() => ({ title: document.getElementById("engineTitle")?.textContent,
    oneClick: !!document.querySelector('.engine-choice-card[data-engine="inbrowser"]')?.getClientRects().length,
    note: [...document.querySelectorAll(".engine-choice .engine-note")].filter((n) => n.getClientRects().length).map((n) => n.textContent) }));
  if (major < 153) {
    check("Firefox 140: the local engine alone, with a line that Firefox 153 runs the in-browser one", offered && !seen.oneClick &&
      seen.title === "Local engine" && seen.note.includes("Firefox 153 or later also runs the one-click engine."), JSON.stringify(seen));
  } else {
    check("Firefox 153+: this machine is offered the in-browser engine", offered && seen.oneClick, JSON.stringify(seen));
  }
  check("nothing chosen, and Native Messaging not granted, before a pick",
    (await engineOf(setup)) === null && !(await setup.evaluate(() => browser.permissions.contains({ permissions: ["nativeMessaging"] }))));
  if (process.platform === "darwin" && existsSync(REAL_HOSTS)) {
    console.log(`SKIP  the local engine's pick — Firefox would reach the host registered in ${REAL_HOSTS}`);
    return;
  }
  await setup.click("#engine-pick-native");
  const command = await until(() => text(setup, "#install-cmd"));
  check("picking the local engine grants Native Messaging at run time and shows the install command for Firefox",
    /ANAGRAM_EXTENSION_ID='anagram@coderbak\.dev' ANAGRAM_BROWSER='firefox'/.test(command ?? "") && (await engineOf(setup)) === "native", command);
  const port = await setup.evaluate(async () => {
    const page = await browser.runtime.getBackgroundPage();
    const granted = await browser.permissions.contains({ permissions: ["nativeMessaging"] });
    const type = typeof page.browser.runtime.connectNative;
    // A host nobody registered: the call is answered by the browser, and reaches nothing.
    const error = await new Promise((resolve) => {
      try {
        const p = page.browser.runtime.connectNative("dev.coderbak.anagram.absent_test_host");
        p.onDisconnect.addListener((q) => resolve(q.error?.message ?? "disconnected"));
      } catch (e) { resolve(`threw: ${e.message}`); }
      setTimeout(() => resolve("no answer"), 5000);
    });
    return { granted, type, error };
  });
  check("after the grant, with no reload, the background page has runtime.connectNative and the browser answers it",
    port.granted && port.type === "function" && /No such native application|not found/i.test(port.error), JSON.stringify(port));
});

// ---- Firefox 153+: the in-browser engine ---------------------------------------------------------

if (major < 153) {
  console.log(`SKIP  the in-browser engine — it needs Firefox 153 or later, this is ${version}`);
} else {
  // A device with no choice: the setup page starts the download at install.
  let auto = deviceBuild("linux-cpu", DEVICES["linux-cpu"], { browser: "firefox" });
  const home = mkdtempSync(join(tmpdir(), "anagram-ff-shipped-"));
  if (HF) {
    // What the shipped package asks for: no host at all (the test build requires every site).
    const copy = join(home, "extension");
    cpSync(auto, copy, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
    manifest.permissions = manifest.permissions.filter((p) => !p.includes("://"));
    manifest.optional_permissions = ["clipboardWrite", "nativeMessaging", "https://*/*", "http://*/*", "file:///*"];
    writeFileSync(join(copy, "manifest.json"), JSON.stringify(manifest));
    auto = copy;
  }
  await withFirefox(auto, async (open) => {
    const page = await open("options.html");
    const request = (op, payload = {}) => page.evaluate(([op, payload]) => browser.runtime.sendMessage({ action: "anagram.nativeRequest", op, payload }), [op, payload]);
    const reply = await until(async () => { const r = await request("status"); return r?.ok && ["running", "failed"].includes(r.data?.download?.status) ? r : null; }, 30000, 500);
    check("a device with no choice: installing started the model's download in the background page's worker",
      reply?.data?.home === "opfs:anagram-engine" && (await engineOf(page)) === "inbrowser", JSON.stringify(reply).slice(0, 400));
    if (HF) {
      const granted = await page.evaluate(() => browser.permissions.getAll());
      check("no host is granted", (granted.origins ?? []).length === 0, JSON.stringify(granted));
      const far = await until(async () => { const r = await request("status"); return r?.data?.download?.bytes_received > 20e6 ? r : null; }, 60000, 500);
      check("Hugging Face's bytes arrive by CORS, with no host permission", far && !far.data.download.error, JSON.stringify(far?.data?.download));
    }
    const cancelled = await request("models.delete", { confirm: true });
    check("Cancel leaves the engine not set up", cancelled?.ok && cancelled.data?.state === "needs_models", JSON.stringify(cancelled).slice(0, 400));
    const runtime = await request("runtime");
    check("runtime says not_ready before the model", !runtime?.ok && runtime?.status === 503 && runtime?.error?.code === "not_ready", JSON.stringify(runtime).slice(0, 200));
    const settings = await request("engine.settings", { idle_unload_s: 600 });
    check("engine.settings is answered", settings?.ok && settings.data?.settings?.idle_unload_s === 600, JSON.stringify(settings).slice(0, 200));
    const status = await page.evaluate(() => browser.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
    check("the background reports scoring unavailable, for want of setup", status?.active === "down" && status.engine === "inbrowser" && status.setup?.state === "needed", JSON.stringify(status).slice(0, 200));
    const again = await open("options.html");
    const seen = await until(async () => {
      const s = await again.evaluate(() => ({ line: document.querySelector("#componentSettings .component-status")?.textContent ?? "", button: document.getElementById("component-primary")?.textContent ?? "" }));
      return /Not set up yet/.test(s.line) ? s : null;
    });
    check("Settings says setup is needed and offers the download", /1\.4 GB/.test(seen?.button ?? ""), JSON.stringify(seen));
  }, { hf: HF });
  rmSync(home, { recursive: true, force: true });

  // A device with a choice: nothing downloads before a pick.
  await withFirefox(deviceBuild("apple-silicon", DEVICES["apple-silicon"], { browser: "firefox" }), async (open) => {
    const setup = await open("onboarding.html");
    const offered = await until(async () => (await shown(setup, "#engine-pick-inbrowser")) && (await shown(setup, "#engine-pick-native")));
    await sleep(2000);
    const status = await setup.evaluate(() => browser.runtime.sendMessage({ action: "anagram.nativeRequest", op: "status", payload: {} }));
    check("a device with a choice: both engines offered, and nothing chosen or downloaded before a pick",
      offered && (await engineOf(setup)) === null && !status?.ok, JSON.stringify(status).slice(0, 200));
  });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
