// Drive an unpacked, published Chrome ZIP with a real model and an isolated user profile.
// The hosted CI shell step runs the installer. This browser driver only reads its setup command.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const [mode, root] = process.argv.slice(2);
assert.ok(["inbrowser", "command", "native"].includes(mode) && root, "Expected inbrowser|command|native and a scratch directory containing extension/");
const browserOnly = mode === "inbrowser";
const original = join(root, "extension");
const extension = browserOnly ? original : join(root, "native-extension");
const home = join(root, browserOnly ? "browser-home" : "native-home");
const config = join(home, ".config");
await mkdir(config, { recursive: true });
const profile = browserOnly ? await mkdtemp(join(home, "profile-")) : join(config, "google-chrome");
if (mode === "command") {
  // Supply the optional grant a user accepts in Chrome, which headless Chromium cannot click.
  await cp(original, extension, { recursive: true, force: false, errorOnExist: true });
  const file = join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  assert.ok(manifest.optional_permissions.includes("nativeMessaging"));
  manifest.optional_permissions = manifest.optional_permissions.filter(p => p !== "nativeMessaging");
  manifest.permissions.push("nativeMessaging");
  await writeFile(file, JSON.stringify(manifest));
}

async function open() {
  return chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, locale: "en-US",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--disable-gpu", "--no-first-run"],
  });
}

async function onboarding(context) {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30000 });
  const id = new URL(worker.url()).hostname;
  const url = `chrome-extension://${id}/onboarding.html`;
  const page = context.pages().find(p => p.url() === url) ?? await context.newPage();
  if (page.url() !== url) await page.goto(url);
  return page;
}

async function waitForModel(page, allowDownload) {
  let lastProgress = "";
  const deadline = Date.now() + 15 * 60000;
  while (Date.now() < deadline) {
    const choice = page.locator("#engine-pick-inbrowser");
    if (browserOnly && allowDownload && await choice.isVisible() && await choice.isEnabled()) await choice.click();
    const response = await page.evaluate(() => chrome.runtime.sendMessage({ action: "anagram.nativeRequest", op: "status", payload: {} }));
    const state = response?.data;
    if (state?.state === "error" || state?.download?.status === "failed") throw new Error(JSON.stringify(state.error ?? state.download));
    if (state?.state === "ready") return state;
    const progress = [state?.state, state?.download?.status, Math.floor((state?.download?.bytes_received ?? 0) / 100000000) * 100 + " MB"].join(" ");
    if (progress !== lastProgress) { console.log(mode, progress); lastProgress = progress; }
    if (allowDownload && ["needs_models", "paused"].includes(state?.state)) {
      const primary = page.locator("#component-primary");
      if (await primary.isVisible() && await primary.isEnabled() && /^(?:download|resume download|install|set up)\b/i.test(await primary.innerText())) await primary.click();
    }
    await delay(1500);
  }
  throw new Error(`Model did not become ready. Last status: ${lastProgress}`);
}

const sample = "We met in the library on Tuesday to compare notes about the old bridge. Marta had brought the plans from the town archive, but the final drawing was missing. We measured the remaining stonework in the rain and wrote down each dimension twice. By the time the caretaker locked the gate we had agreed on three questions to ask the engineer when she returned the following week.";

async function score(context, setup, text) {
  const page = await context.newPage();
  await page.goto(new URL("paste.html", setup.url()).href);
  await page.locator("#text").fill(text);
  await page.locator("#analyze").click();
  await page.locator("#results").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(await page.locator("#reading .read:not(.unread)").count(), 1);
  assert.equal(await page.locator("#coverage").textContent(), await page.evaluate(() => chrome.i18n.getMessage("pasteOneRead")));
  console.log("Scored", await page.locator("#summary").innerText(), await page.locator("#score").textContent());
}

let context = await open();
try {
  let setup = await onboarding(context);
  if (mode === "command") {
    await setup.locator("#install-preview").click();
    const command = await setup.locator("#install-cmd").innerText();
    const { version } = JSON.parse(await readFile(join(original, "manifest.json"), "utf8"));
    const digest = createHash("sha256").update(await readFile(join(original, "installer-source", "install.sh"))).digest("hex");
    assert.ok(command.includes(`https://github.com/CoderBak/anagram/releases/download/v${version}/install.sh`) && command.includes(digest));
    assert.ok(command.includes(`ANAGRAM_EXTENSION_ID='${new URL(setup.url()).hostname}'`));
    await writeFile(join(root, "setup-command"), command + "\n", { flag: "wx", mode: 0o600 });
  } else {
    const response = await fetch("https://huggingface.co/api/models/CoderBak/anagram-detectors/revision/default");
    assert.ok(response.ok, `Anonymous default model lookup returned HTTP ${response.status}`);
    const ref = (await response.json()).sha;
    assert.match(ref, /^[a-f0-9]{40}$/);
    const installed = await waitForModel(setup, true);
    const health = await setup.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
    assert.equal(health?.engine, mode);
    assert.equal(health?.model?.calibration, "anagram-detector/1");
    assert.ok(health.model.ver.startsWith(ref), JSON.stringify(health.model));
    console.log(mode, health.model.id, health.model.ver, installed.runtime.active_id, installed.storage.models_bytes, "stored bytes");
    await score(context, setup, sample);
    await context.close();
    context = await open();
    await context.setOffline(true);
    setup = await onboarding(context);
    await waitForModel(setup, false);
    await score(context, setup, sample + " The caretaker later found the missing drawing folded inside a book.");
    console.log("PASS", mode, "scored new text after restart with browser networking offline");
  }
} finally {
  await context.close();
  if (browserOnly) await rm(profile, { recursive: true, force: true });
}
