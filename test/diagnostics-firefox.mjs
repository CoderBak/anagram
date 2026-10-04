// test/diagnostics-firefox.mjs — "Copy page diagnostics" in Firefox: the copy path.
//
// The copy is the one part of the feature that is not the same on both browsers (the rest
// is test/pw/diagnostics.spec.mjs, in Chromium). It happens when the worker's message
// reaches the page, which is NOT a user-input handler, and Firefox refuses a content
// script both clipboard routes outside one. `clipboardWrite` is therefore declared
// OPTIONAL in the Firefox manifest and asked for inside the menu click itself — a required
// clipboard permission would put "Input data to the clipboard" in front of every reader at
// install time for a menu entry most will never open.
//
// So both halves are checked here: WITHOUT the clipboard the copy has to fail cleanly and
// say so, and WITH it the report has to arrive.
//
// WHAT CANNOT BE DRIVEN: the grant itself. Firefox accepts `permissions.request` only from
// inside a user-input handler — `contextMenus.onClicked` is one, which is why the worker
// asks there — and WebDriver BiDi refuses to deliver input to a privileged document
// (`input.performActions` → "unsupported operation" on a moz-extension: page), while its
// own script-level user activation does not satisfy Gecko's check. Turning the doorhanger
// off with `extensions.webextOptionalPermissionPrompts` does not help: the gesture rule is
// checked first. It is set anyway so a prompt can never block a run. What the second half
// therefore does is give the PAGE user activation, which is exactly the thing the granted
// permission buys the content script, and check that the copy then goes through. The
// manifest wiring itself — clipboardWrite optional on Firefox, absent on Chrome — is
// asserted in test/node/permissions.test.ts.
//
//   ANAGRAM_FIREFOX=<path to firefox> node test/diagnostics-firefox.mjs
import { serveHtml } from "./harness.mjs";
import * as ff from "./firefox-harness.mjs";
import { PAGE, FRAME, SECRETS } from "./diagnostics-page.mjs";

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

const ffServer = await serveHtml({ "/diag.html": PAGE, "/frame.html": FRAME });
const { fixture: ffFixture, browser, extUrl } = await ff.withFakeNative({
  // No doorhanger may ever appear and block the run; BiDi could not dismiss one.
  extraPrefs: { "extensions.webextOptionalPermissionPrompts": false },
});
try {
  const page = await browser.newPage();
  await page.goto(ffServer.url("/diag.html"), { waitUntil: "load" });
  await ff.sleep(4000);
  // The worker is a background PAGE in MV2 and BiDi will not drive it; the options page
  // has the same tabs and permissions APIs and sends the same message to the same frame.
  const driver = await ff.openExtensionPage(browser, extUrl("options.html"));

  // NOTHING may run in the fixture page before the first ask. WebDriver BiDi evaluates
  // page scripts WITH user activation, and a document that has activation may write to the
  // clipboard whatever the extension's permissions say — one stray `page.evaluate` here
  // and the half of this that matters most passes for the wrong reason. (It did, once.)
  const ask = async () => {
    await page.bringToFront().catch(() => {});
    await ff.sleep(400);
    return driver.evaluate(async (needle) => {
      const tabs = await browser.tabs.query({});
      const tab = tabs.find((t) => (t.url || "").includes(needle));
      if (!tab) return { error: "tab not found" };
      try {
        return await browser.tabs.sendMessage(tab.id, { action: "copyDiagnostics", frameId: 0 }, { frameId: 0 });
      } catch (e) {
        return { error: String(e) };
      }
    }, "/diag.html");
  };

  // --- without the permission: a clean refusal, not a throw and not a lie ---
  // The clipboard is deliberately NOT read here. Firefox asks the user before letting a
  // document read what another one put there, which no test can answer — and the reply is
  // the better witness anyway: it is exactly what the worker flashes the badge from.
  await driver.evaluate(() => browser.permissions.remove({ permissions: ["clipboardWrite"] }));
  const denied = await ask();
  record(
    "Firefox without clipboardWrite: the report is built, nothing is copied, and the reply says so",
    denied?.ok === false && denied.via === "none" && denied.bytes > 0,
    JSON.stringify(denied),
  );

  // --- and the permission really is optional, and really is not granted yet ---
  const permissionState = await driver.evaluate(async () => {
    let refusal = "";
    try {
      await browser.permissions.request({ permissions: ["clipboardWrite"] });
    } catch (e) {
      refusal = String(e.message ?? e);
    }
    return { has: await browser.permissions.contains({ permissions: ["clipboardWrite"] }), refusal };
  });
  record(
    "Firefox: clipboardWrite starts ungranted, and asking outside a user-input handler is refused — which is why the worker asks inside the menu click",
    permissionState.has === false && /user input handler/.test(permissionState.refusal),
    JSON.stringify(permissionState),
  );

  // --- and once the clipboard IS allowed, the report arrives ---
  // This one line does both halves of what the granted permission does: it seeds the
  // clipboard with a sentinel so a silent failure cannot pass, and, because BiDi evaluates
  // it with user activation, it leaves the document holding the transient activation
  // Firefox otherwise demands of the content script.
  await page.evaluate(() => navigator.clipboard.writeText("NOTHING COPIED"));
  const ok = await ask();
  // Reading is free now: the clipboard holds what this very document put there, which is
  // the one case Firefox does not ask the user about.
  const text = await page.evaluate(() => navigator.clipboard.readText().then((t) => t, () => null));
  record(
    "Firefox once the clipboard is allowed: the on-demand chunk loads from moz-extension: and the report reaches the clipboard",
    ok?.ok === true && ok.via === "clipboard" && /^# Anagram page diagnostics/.test(text ?? ""),
    JSON.stringify(ok),
  );
  record(
    "Firefox: the report knows it is MV2 and which browser it came from",
    /- Anagram [\d.]+ \(MV2\) · Firefox [\d.]+ ·/.test(text ?? ""),
    (text ?? "").split("\n")[2] ?? "",
  );
  record(
    "Firefox: the same privacy bar holds",
    text !== null && Object.values(SECRETS).every((s) => !text.includes(s)),
    "",
  );
  // The chunk was imported twice by its moz-extension address, which in Firefox names this
  // installation; asked only now, as page.evaluate gives the page user activation.
  const timeline = await page.evaluate(() => performance.getEntries().map((e) => `${e.entryType} ${e.name}`));
  record(
    "Firefox: importing the chunk leaves the page no Resource Timing entry naming the installation",
    timeline.length > 0 && !timeline.some((name) => name.includes("moz-extension")),
    JSON.stringify(timeline.filter((name) => name.includes("moz-extension"))),
  );
} finally {
  await browser.close();
  await ffServer.close();
  await ffFixture.close();
}

console.log("\n=== PAGE DIAGNOSTICS (Firefox) ===");
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
console.log(fails.length === 0 ? "✅ DIAGNOSTICS GREEN" : "❌ DIAGNOSTICS FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
