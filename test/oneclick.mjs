// test/oneclick.mjs — the oneclick flavor's test build, started for real (scripts/flavor.mjs).
//
// The flavor swaps the engine transport and the setup/Settings engine panel; this checks
// the swap in a browser: the worker starts and answers without Native Messaging (it has no
// such permission, and nothing asks for it), a contract request reaches the in-browser
// engine (its offscreen document and worker, which find no model files in a fresh profile
// and download nothing by themselves), and the setup page and Settings show the in-browser engine block and
// no install command, in English and Chinese. A temporary profile; no native host exists.
//
//   npm run test:oneclick        # builds output-test/oneclick-chrome-mv3 when stale
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiLanguage } from "./harness.mjs";
import { ensureTestBuild } from "./test-build.mjs";

process.env.ANAGRAM_FLAVOR = "oneclick";
const EXT = ensureTestBuild("oneclick-chrome-mv3");

const results = [];
const check = (name, ok, note = "") => results.push({ name, ok: !!ok, note: String(note) });

for (const lang of ["en", "zh-CN"]) {
  const profile = mkdtempSync(join(tmpdir(), "anagram-oneclick-"));
  const localized = uiLanguage(lang);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: "chromium", ...localized,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check", ...(localized.args ?? [])],
  });
  try {
    const problems = [];
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
    check(`${lang}: the background worker starts`, sw);
    if (!sw) continue;
    sw.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`worker: ${m.text()}`); });
    const extId = new URL(sw.url()).host;
    const language = await sw.evaluate(() => chrome.i18n.getUILanguage());
    if (!language.toLowerCase().startsWith(lang.split("-")[0])) {
      console.log(`SKIP  ${lang}: the browser came up in ${language}`);
      continue;
    }

    const worker = await sw.evaluate(() => ({
      permissions: chrome.runtime.getManifest().permissions,
      connectNative: typeof chrome.runtime.connectNative,
    }));
    check(`${lang}: no nativeMessaging permission, and no connectNative to call`,
      !worker.permissions.includes("nativeMessaging") && worker.connectNative === "undefined", JSON.stringify(worker));

    for (const name of ["onboarding", "options"]) {
      const page = await context.newPage();
      page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error") problems.push(`${name}: ${m.text()}`); });
      await page.goto(`chrome-extension://${extId}/${name}.html`);
      const block = page.locator('#componentSettings[data-engine="in-browser"]');
      await block.waitFor({ timeout: 10000 }).catch(() => undefined);
      // The first status poll has answered once the line says something other than "Starting".
      await page.waitForFunction(() => {
        const line = document.querySelector("#componentSettings .component-status")?.textContent ?? "";
        return line && !/Starting|正在启动/.test(line);
      }, undefined, { timeout: 10000 }).catch(() => undefined);
      const seen = await page.evaluate(() => ({
        block: !!document.querySelector('#componentSettings[data-engine="in-browser"]'),
        status: document.querySelector("#componentSettings .component-status")?.textContent ?? "",
        installUi: !!document.querySelector("#install, #install-cmd, #install-copy"),
        text: document.body.innerText,
        version: document.getElementById("version")?.textContent ?? "",
      }));
      check(`${lang}: ${name} shows the in-browser engine block`, seen.block, seen.status);
      // A fresh profile holds no model files: the engine says so through the same
      // `status` operation the native host answers.
      check(`${lang}: ${name} reads "model files needed" from the in-browser engine`,
        seen.status === (lang === "en" ? "Model files needed" : "需要模型文件"), seen.status);
      check(`${lang}: ${name} shows no install command`,
        !seen.installUi && !/curl|Invoke-RestMethod|install\.sh|Terminal|终端/.test(seen.text), seen.text.slice(0, 200));
      if (name === "options") check(`${lang}: Settings' version line carries the engine state`, seen.version.includes(seen.status), seen.version);
      if (name === "onboarding") {
        // The page's contract request goes through the worker's bridge to the in-browser
        // engine's transport, which answers for itself.
        const reply = await page.evaluate(() => chrome.runtime.sendMessage({ action: "anagram.nativeRequest", op: "status", payload: {} }));
        check(`${lang}: a contract request reaches the in-browser engine through the offscreen document`,
          reply?.ok === true && reply.data?.state === "needs_models" && reply.data?.home === "opfs:anagram-engine", JSON.stringify(reply).slice(0, 300));
        const status = await page.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
        check(`${lang}: the worker reports scoring unavailable, not an error`, status?.active === "down", JSON.stringify(status));
      }
      await page.close();
    }

    const popup = await context.newPage();
    popup.on("pageerror", (e) => problems.push(`popup: ${e.message}`));
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(500);
    const popupText = await popup.evaluate(() => document.body.innerText);
    check(`${lang}: the popup shows no install command`, !/curl|Invoke-RestMethod|install\.sh/.test(popupText), popupText.slice(0, 200));
    await popup.close();

    check(`${lang}: no errors in the worker or the pages`, problems.length === 0, problems.join(" | "));
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.note}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `❌ ${failed} ONECLICK CHECKS FAILED` : `✅ ${results.length} ONECLICK CHECKS GREEN`);
process.exit(failed ? 1 : 0);
