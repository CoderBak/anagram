// Local PDFs: the optional file-access setup on the options page, in English and Chinese,
// and a file opened in the reader once the browser's own file-access switch is on.
//
//   npm run test:pdf-install          # builds output/ first; this loads the SHIPPING build
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "./fixtures.mjs";
import { TEST_PDF } from "../pdf-fixture.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const SHIPPING = join(ROOT, "output/chrome-mv3");

const test = base.extend({
  /** A PDF on this computer, under a name with spaces and Chinese in it. */
  localPdf: async ({}, use, testInfo) => {
    const path = testInfo.outputPath("本地 PDF example.pdf");
    writeFileSync(path, TEST_PDF);
    await use(pathToFileURL(path).href);
  },

  // The native permission prompt is not automatable in headless Chrome. This separately
  // marked build pregrants ONLY file origins so the actual browser file-access switch and
  // source-loader path can be exercised, without weakening the shipping manifest.
  fileGrantedBuild: [
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), "anagram-file-grant-"));
      const build = join(dir, "chrome-mv3");
      cpSync(SHIPPING, build, { recursive: true });
      const manifestPath = join(build, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.host_permissions, "the shipping manifest declares no host permissions").toBeUndefined();
      manifest.name += " — FILE GRANT TEST ONLY";
      manifest.host_permissions = ["file:///*"];
      manifest.optional_host_permissions = manifest.optional_host_permissions.filter((origin) => origin !== "file:///*");
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      await use(build);
      rmSync(dir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
});
test.use({ build: "shipping" });

for (const language of ["en", "zh-CN"]) {
  test.describe(language, () => {
    test.use({ uiLanguage: language });

    test("optional file access, preference, no forced tab switch, narrow layout and accessibility", async ({ page, context, extension, localPdf }, testInfo) => {
      await page.goto(extension.url("options.html"));
      await page.locator("#fileAccessState").filter({ hasNotText: "…" }).waitFor();
      expect(await page.locator("#fileAccessEnable").isVisible()).toBe(true);
      expect((await extension.sw.evaluate(() => chrome.permissions.getAll())).origins).toEqual([]);
      const pdf = await context.newPage();
      await pdf.goto(localPdf).catch(() => {});
      await page.locator("#autoOpenPdfs").check();
      await page.waitForFunction(async () => (await chrome.storage.local.get("autoOpenPdfs")).autoOpenPdfs === true);
      expect(pdf.url(), "Changing the preference does not navigate an already-open PDF").toBe(localPdf);
      await pdf.reload().catch(() => {});
      // Nothing signals a navigation that does not come: give it the time one would take.
      await pdf.waitForTimeout(400);
      expect(pdf.url(), "No file grant: retain the original reader").toBe(localPdf);
      await page.setViewportSize({ width: 400, height: 900 });
      await page.locator("#local-pdfs").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.locator("#local-pdfs").screenshot({ path: testInfo.outputPath(`file-access-${language}.png`) });
      await page.evaluate(readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8"));
      const a11y = await page.evaluate(async () => (await axe.run("#local-pdfs", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map((v) => v.id));
      expect(a11y).toEqual([]);
    });
  });
}

test.describe("with the browser's file access on", () => {
  test.use({ build: async ({ fileGrantedBuild }, use) => use(fileGrantedBuild) });

  test("a local file loads offline in the reader, Open original bypasses it once, and turning it off restores the file", async ({ context, extension, storage, localPdf }, testInfo) => {
    const manager = await context.newPage();
    await manager.goto(`chrome://extensions/?id=${extension.extId}`);
    await manager.waitForFunction(() => typeof chrome.developerPrivate?.updateExtensionConfiguration === "function");
    await manager.evaluate((id) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: true }), extension.extId);
    // File-switch changes may reload the extension and replace the worker.
    const settings = await context.newPage();
    await settings.goto(extension.url("options.html"));
    await settings.waitForFunction(async () => (await chrome.permissions.contains({ origins: ["file:///*"] })) && (await chrome.extension.isAllowedFileSchemeAccess()));
    await settings.locator("#autoOpenPdfs").check();
    await expect.poll(async () => (await storage.get("autoOpenPdfs")).autoOpenPdfs).toBe(true);
    const worker = extension.worker();
    await worker.evaluate(() => {
      globalThis.__pdfTrace = [];
      chrome.tabs.onUpdated.addListener((id, change) => globalThis.__pdfTrace.push({ type: "tab", id, change }));
      chrome.webNavigation.onBeforeNavigate.addListener((value) => globalThis.__pdfTrace.push({ type: "nav", value }));
      chrome.runtime.onConnect.addListener((port) => {
        if (!port.name.startsWith("anagram-pdf")) return;
        globalThis.__pdfTrace.push({ type: "port", name: port.name, sender: port.sender });
        port.onMessage.addListener((value) => globalThis.__pdfTrace.push({ type: "message", name: port.name, value }));
        port.onDisconnect.addListener(() => globalThis.__pdfTrace.push({ type: "disconnect", name: port.name }));
      });
    });
    const external = [];
    context.on("request", (request) => {
      if (/^https?:/.test(request.url())) external.push(request.url());
    });
    await context.setOffline(true);
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(localPdf).catch(() => {});
    await page.waitForURL(/reader\.html/, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10, null, { timeout: 20000 }).catch(async (error) => {
      const debug = {
        url: page.url(),
        trace: await worker.evaluate(() => globalThis.__pdfTrace),
        errors,
        body: (await page.locator("body").innerText()).slice(-1600),
        frames: page.frames().map((frame) => frame.url()),
        navigation: await settings.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          return Promise.all(tabs.map(async (tab) => ({ tab, frames: await chrome.webNavigation.getAllFrames({ tabId: tab.id }) })));
        }),
      };
      await testInfo.attach("file-debug.json", { body: JSON.stringify(debug, null, 2), contentType: "application/json" });
      throw error;
    });
    expect(page.url()).toContain(encodeURIComponent(localPdf));
    expect(await page.locator("#original").isVisible()).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("local-file-reader.png") });
    expect(external, "Local PDF and packaged viewer assets need no internet requests").toEqual([]);
    await page.locator("#original").click();
    await page.waitForURL(localPdf, { timeout: 10000 });
    // Nothing signals a navigation that does not come: give it the time one would take.
    await page.waitForTimeout(600);
    expect(page.url(), "Open original bypasses automatic interception once").toBe(localPdf);
    await settings.locator("#autoOpenPdfs").uncheck();
    await page.reload().catch(() => {});
    await page.waitForTimeout(500);
    expect(page.url(), "Turning automatic mode off restores normal file reading").toBe(localPdf);
  });
});
