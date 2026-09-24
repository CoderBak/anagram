// Isolated Chrome installation flows; never touches the user's browser or native host.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchExtension, uiLanguage } from "./harness.mjs";
import { TEST_PDF } from "./pdf-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPING = join(ROOT, "output/chrome-mv3");
const OUT = join(ROOT, "test-results/pdf-install");
mkdirSync(OUT, {recursive:true});
const localPdf = join(OUT, "本地 PDF example.pdf");
writeFileSync(localPdf, TEST_PDF);
const localUrl = pathToFileURL(localPdf).href;

for (const language of (process.argv.includes("--file-only") ? [] : ["en", "zh-CN"])) {
  const launched = await launchExtension({extDir:SHIPPING,...uiLanguage(language)});
  const {context, sw, extId} = launched;
  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/options.html`);
    await page.locator("#fileAccessState").filter({hasNotText:"…"}).waitFor();
    assert.equal(await page.locator("#fileAccessEnable").isVisible(),true);
    assert.deepEqual((await sw.evaluate(() => chrome.permissions.getAll())).origins,[]);
    const pdf = await context.newPage();
    await pdf.goto(localUrl).catch(() => {});
    await page.locator("#autoOpenPdfs").check();
    await page.waitForFunction(async () => (await chrome.storage.local.get("autoOpenPdfs")).autoOpenPdfs === true);
    assert.equal(pdf.url(),localUrl,"Changing the preference does not navigate an already-open PDF");
    await pdf.reload().catch(() => {});
    await pdf.waitForTimeout(400);
    assert.equal(pdf.url(),localUrl,"No file grant: retain the original reader");
    await page.setViewportSize({width:400,height:900});
    await page.locator("#local-pdfs").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
    await page.locator("#local-pdfs").screenshot({path:join(OUT,`file-access-${language}.png`)});
    await page.evaluate(readFileSync(join(ROOT,"node_modules/axe-core/axe.min.js"),"utf8"));
    const a11y = await page.evaluate(async () => (await axe.run("#local-pdfs",{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map((v) => v.id));
    assert.deepEqual(a11y,[]);
    console.log(`PASS ${language}: optional file access, preference, no forced tab switch, narrow layout and accessibility`);
  } finally { await context.close(); }
}

// The native permission prompt is not automatable in headless Chrome. This separately
// marked fixture pregrants ONLY file origins so the actual browser file-access switch
// and source-loader path can be exercised, without weakening the shipping manifest.
const grantedBuild = join(OUT,"file-granted-test-extension");
cpSync(SHIPPING,grantedBuild,{recursive:true});
const manifestPath = join(grantedBuild,"manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath,"utf8"));
assert.equal(manifest.host_permissions,undefined);
manifest.name += " — FILE GRANT TEST ONLY";
manifest.host_permissions = ["file:///*"];
manifest.optional_host_permissions = manifest.optional_host_permissions.filter((origin) => origin !== "file:///*");
writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
const {context, extId} = await launchExtension({extDir:grantedBuild});
try {
  const manager = await context.newPage();
  await manager.goto(`chrome://extensions/?id=${extId}`);
  await manager.waitForFunction(() => typeof chrome.developerPrivate?.updateExtensionConfiguration === "function");
  await manager.evaluate((id) => chrome.developerPrivate.updateExtensionConfiguration({extensionId:id,fileAccess:true}),extId);
  // File-switch changes may reload the extension and replace the worker.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extId}/options.html`);
  await settings.waitForFunction(async () => (await chrome.permissions.contains({origins:["file:///*"]})) && (await chrome.extension.isAllowedFileSchemeAccess()));
  await settings.locator("#autoOpenPdfs").check();
  await settings.waitForFunction(async () => (await chrome.storage.local.get("autoOpenPdfs")).autoOpenPdfs === true);
  const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${extId}/`));
  await worker.evaluate(() => {
    globalThis.__pdfTrace = [];
    chrome.tabs.onUpdated.addListener((id, change) => globalThis.__pdfTrace.push({type:"tab",id,change}));
    chrome.webNavigation.onBeforeNavigate.addListener((value) => globalThis.__pdfTrace.push({type:"nav",value}));
    chrome.runtime.onConnect.addListener((port) => {
      if (!port.name.startsWith("anagram-pdf")) return;
      globalThis.__pdfTrace.push({type:"port",name:port.name,sender:port.sender});
      port.onMessage.addListener((value) => globalThis.__pdfTrace.push({type:"message",name:port.name,value}));
      port.onDisconnect.addListener(() => globalThis.__pdfTrace.push({type:"disconnect",name:port.name}));
    });
  });
  const external = [];
  context.on("request", (request) => {if (/^https?:/.test(request.url())) external.push(request.url());});
  await context.setOffline(true);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(localUrl).catch(() => {});
  await page.waitForURL(/reader\.html/,{timeout:20000});
  await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 10, null, {timeout:20000}).catch(async (error) => {
    const debug = {url:page.url(), trace:await worker.evaluate(() => globalThis.__pdfTrace), errors, body:(await page.locator("body").innerText()).slice(-1600), frames:page.frames().map((frame) => frame.url()), navigation:await settings.evaluate(async () => { const tabs=await chrome.tabs.query({}); return Promise.all(tabs.map(async (tab) => ({tab, frames:await chrome.webNavigation.getAllFrames({tabId:tab.id})}))); })};
    console.log(JSON.stringify(debug,null,2));
    writeFileSync(join(OUT,"file-debug.json"),JSON.stringify(debug,null,2));
    throw error;
  });
  assert.ok(page.url().includes(encodeURIComponent(localUrl)));
  assert.equal(await page.locator("#original").isVisible(),true);
  await page.screenshot({path:join(OUT,"local-file-reader.png")});
  assert.deepEqual(external,[],"Local PDF and packaged viewer assets need no internet requests");
  await page.locator("#original").click();
  await page.waitForURL(localUrl,{timeout:10000});
  await page.waitForTimeout(600);
  assert.equal(page.url(),localUrl,"Open original bypasses automatic interception once");
  await settings.locator("#autoOpenPdfs").uncheck();
  await page.reload().catch(() => {});
  await page.waitForTimeout(500);
  assert.equal(page.url(),localUrl,"Turning automatic mode off restores normal file reading");
  console.log("PASS local file: real Chrome access switch, offline automatic loading, original-reader bypass, disable preference");
} finally { await context.close(); }
