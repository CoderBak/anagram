// Run the previous and candidate Chrome packages from the same path and browser profile.
// Usage: node test/packaged-browser.mjs dist /path/to/previous/release
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { seedStats, statsRecords, presetConfig } from "./stats-fixture.mjs";
import { modelServer } from "./webengine/model-server.mjs";

const [candidatePath, previousPath] = process.argv.slice(2);
if (!candidatePath || !previousPath) throw new Error("Provide the candidate and previous release directories.");
const candidate = resolve(candidatePath);
const previous = resolve(previousPath);
const {version} = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const pin = JSON.parse(await readFile(new URL("../anagramd/detector-release.json", import.meta.url), "utf8"));
const server = await modelServer({status: 404});
const root = await mkdtemp(join(tmpdir(), "anagram-browser-upgrade-"));
const extension = join(root, "extension");
let context;

async function launch() {
  context = await chromium.launchPersistentContext(join(root, "profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-proxy-server", ...server.args],
  });
  return context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
}

try {
  await mkdir(extension);
  execFileSync("tar", ["-xzf", join(previous, "anagram.tar.gz"), "-C", extension, "--strip-components=2", "anagram/extension"]);
  const oldWorker = await launch();
  const id = new URL(oldWorker.url()).host;
  const oldVersion = await oldWorker.evaluate(() => chrome.runtime.getManifest().version);
  const config = await presetConfig("daily");
  await oldWorker.evaluate(statsConfig => chrome.storage.local.set({statsConfig, engine: "inbrowser"}), config);
  await seedStats(oldWorker, statsRecords(), 3);
  await context.close();

  await rm(extension, {recursive: true});
  await mkdir(extension);
  execFileSync("unzip", ["-q", join(candidate, `anagram-chrome-${version}.zip`), "-d", extension]);
  const worker = await launch();
  assert.equal(new URL(worker.url()).host, id);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), version);
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get("statsConfig")).statsConfig), config);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/stats.html#today`);
  await expect(page.locator("#heroShare")).toHaveText("14%");
  assert.deepEqual(await page.locator("#lensHeadline option").evaluateAll(options => options.map(o => o.value)), ["ai", "heavyAndAi"]);
  await page.locator("#lens summary").click();
  await page.selectOption("#lensHeadline", "heavyAndAi");
  await expect(page.locator("#heroShare")).toHaveText(/^(23|22\.6)%$/);
  console.log(`PASS packaged Chrome ${oldVersion} → ${version}, preserved settings, reading history and extension identity`);

  await page.goto(`chrome-extension://${id}/options.html#engine`);
  await expect(page.locator(".detector-name")).toHaveAttribute("href", `https://huggingface.co/${pin.repository}/tree/${pin.revision}`);
  const request = op => page.evaluate(op => chrome.runtime.sendMessage({action: "anagram.nativeRequest", op, payload: {}}), op);
  await request("models.download");
  const requests = () => server.requests.filter(r => r.path.startsWith(`/${pin.repository}/resolve/${pin.revision}/`)).length;
  await expect.poll(requests, {timeout: 15000}).toBeGreaterThan(0);
  await expect.poll(async () => (await request("status")).data?.download?.status, {timeout: 15000}).toBe("failed");
  const before = requests();
  await page.getByRole("button", {name: "Retry", exact: true}).click();
  await expect.poll(requests, {timeout: 15000}).toBeGreaterThan(before);
  console.log("PASS packaged browser engine retries the selected commit when a local fixture returns 404");
} finally {
  try { await context?.close(); } finally {
    await server.close();
    await rm(root, {recursive: true, force: true});
  }
}
