// Shipping package, isolated Native Messaging fixture, no website grants.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension } from "./harness.mjs";
import { createNativeFixture } from "./fake-native.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await createNativeFixture();
const idle = () => {
  const component = fixture.state().component;
  fixture.setState({component:{...component,state:"idle",runtime:{...component.runtime,state:"idle",active_id:null}}});
};
idle();
let context;
try {
  const launched = await launchExtension({nativeFixture: fixture, extDir: join(root, "output/chrome-mv3")});
  context = launched.context;
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${launched.extId}/paste.html`);
  // Exactly 75 words, the evidence floor; the same text one word shorter is refused.
  const text = "The local library opens every morning and welcomes readers from across the town. Its staff help visitors find books, learn new skills, and share ideas with neighbors. Last week I borrowed a history book and spent the afternoon reading beside a sunny window. I plan to return tomorrow because the quiet room makes it easier to concentrate on difficult passages. On Saturdays the reading room fills with families, and a volunteer reads old stories aloud.";
  await page.locator("#text").fill(text.replace(/ aloud\.$/, "."));
  await page.locator("#analyze").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("75"));
  assert.equal(fixture.requests().filter((r) => r.op === "score").length, 0);
  assert.equal(fixture.state().component.state, "idle", "Health checks must not wake the idle model");
  await page.locator("#text").fill(text);
  await page.locator("#analyze").click();
  await page.locator("#results").waitFor({state: "visible"});
  assert.ok(fixture.requests().some((r) => r.op === "score"));
  assert.equal(fixture.state().component.state, "ready", "The first score wakes an idle model with no cached identity");
  assert.match(await page.locator("#coverage").innerText(), /1 of 1 passes analyzed/);
  assert.equal(await page.locator("#windows li").count(), 1);
  await page.evaluate(() => {
    window.__report = "";
    Object.defineProperty(navigator, "clipboard", {value:{writeText: async (text) => {window.__report = text;}}});
  });
  await page.locator("#copy").click();
  const sanitized = await page.evaluate(() => window.__report);
  assert.ok(sanitized.includes("fake-editlens"));
  assert.ok(!sanitized.includes(text));
  await page.locator("#includeText").check();
  await page.locator("#copy").click();
  assert.ok((await page.evaluate(() => window.__report)).includes(text));

  idle();
  const status = await page.evaluate(() => chrome.runtime.sendMessage({action:"getBackendStatus",probe:true,session:globalThis.__anagramDocumentSession}));
  assert.equal(status.active, "idle");
  assert.equal(status.server.ok, false);
  assert.equal(status.model.id, "fake-editlens");
  const beforeCached = fixture.stats.requests;
  await page.locator("#analyze").click();
  await page.locator("#results").waitFor({state:"visible"});
  assert.equal(fixture.stats.requests, beforeCached, "Known cached verdicts remain available while idle without waking inference");
  await page.locator("#copy").click();
  assert.ok((await page.evaluate(() => window.__report)).includes("fake-editlens"), "Cached results retain their real producing model");
  assert.equal(fixture.state().component.state, "idle");

  const slow = `Pending cancellation. ${text}`;
  fixture.setState({rules:[{contains:"Pending cancellation",delayMs:2500}]});
  await page.locator("#text").fill(slow);
  await page.locator("#analyze").click();
  const deadline = Date.now() + 10_000;
  while (!fixture.stats.texts.some((value) => value.includes("Pending cancellation")) && Date.now() < deadline) await page.waitForTimeout(25);
  assert.ok(fixture.stats.texts.some((value) => value.includes("Pending cancellation")), "The slow request entered inference before cancellation");
  await page.locator("#clear").click();
  assert.equal(await page.locator("#analyze").isEnabled(), true, "Clear immediately unlocks analysis");
  await page.locator("#text").fill(`${text} This is a fresh request after cancellation.`);
  await page.locator("#analyze").click();
  await page.locator("#results").waitFor({state:"visible"});
  await page.waitForTimeout(2700);
  assert.ok(!(await page.locator("#windows").innerText()).includes("Pending cancellation"));
  assert.equal(fixture.stats.texts.filter((value) => value.includes("Pending cancellation")).length, 1, "Cancelled text is never resent");
  await page.locator("#clear").click();
  assert.equal(await page.locator("#text").inputValue(), "");
  assert.equal(await page.locator("#results").isHidden(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => chrome.permissions.getAll()).then((p) => p.origins ?? []), []);
  console.log("PASS paste analysis: evidence floor, idle wake/cache provenance, coverage, opt-in export, in-flight cancellation, no host grants");
} finally { await context?.close(); fixture.dispose(); }
