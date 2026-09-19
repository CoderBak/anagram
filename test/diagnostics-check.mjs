// test/diagnostics-check.mjs — "Copy page diagnostics", end to end in a real browser.
//
// The feature turns "nothing shows up on this site" into a fixture in a minute: the reader
// right-clicks, one entry copies an ANONYMOUS description of the page and of what Anagram
// did with it, and they paste that to whoever has to fix it. So what is checked here is
// exactly what a paste is worth:
//
//   the header   — version, browser, languages, HOSTNAME (never a path or a query), scope,
//                  merge, daemon state, frames;
//   the counts   — units, chips, coverage — against what is really on the page;
//   the silence  — one fixture holding every shape that goes quiet for a different reason
//                  (an article that IS scored, a feed of sub-floor posts, a link list, a
//                  code block, an aria-hidden column, a Chinese paragraph) and each one
//                  named with the reason the walk really had;
//   privacy      — not a word of the page, not a URL, not an attribute value on the
//                  clipboard (test/unit.mjs holds the strict four-character form of this);
//   the size cap — a report a chat will take;
//   switched off — a site turned off by rule still answers, and says so.
//
// The menu entry itself cannot be clicked from Playwright (it is native chrome), so the
// worker's own click handler is driven the way test/scenarios.mjs drives the page entry:
// the message it sends, to the frame it sends it to.
//
//   node test/diagnostics-check.mjs
//   node test/diagnostics-check.mjs --firefox      # …and the Firefox copy path as well
//   DIAG_PRINT=1 node test/diagnostics-check.mjs   # also print the report it read back
//
// The printed form is the point of the whole feature — what somebody pastes — so it is
// worth looking at whenever the wording or the fixture changes.
import { withFakeDaemon, serveHtml, requireBuild } from "./harness.mjs";

requireBuild();

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

// ---- the fixture ----------------------------------------------------------------------
//
// Every block below is here because it goes silent for a DIFFERENT reason, and the words
// in it are distinctive so the privacy assertion has something to look for.

const VOCAB =
  "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(
    " ",
  );
const words = (n, seed = 0) =>
  Array.from({ length: n }, (_, i) => VOCAB[(i * 7 + seed * 13) % VOCAB.length]).join(" ") + ".";

/** Strings that must never reach the clipboard, one per hiding place. */
const SECRETS = {
  author: "Wilhelmina Bracklethorpe",
  mail: "wilhelmina.bracklethorpe@heliotrope.example",
  url: "https://intranet.example/thread/9182?session=OTTERGLASS77",
  data: "Nightjar rehearsal schedule",
  alt: "Saltmarsh watercolour",
  title: "Pennyroyal annotation",
  value: "Cinnabarquill",
  json: "Thistledown",
  comment: "Waxwing editorial memo",
};

const POST = (i) =>
  `<div class="post"><div class="byline">${["Ada", "Grace", "Karen", "Barbara", "Jean"][i]} · ${i + 1}h</div>` +
  `<p>${words(22, i + 3)}</p></div>`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>
<style>body{max-width:760px;margin:20px auto;font:15px/1.6 system-ui}nav a{margin-right:8px}</style></head>
<body>
<!-- ${SECRETS.comment} -->
<script type="application/json">{"editor":"${SECRETS.json}","by":"${SECRETS.author}"}</script>
<nav class="site-nav">${Array.from({ length: 8 }, (_, i) => `<a href="${SECRETS.url}">${words(3, i)}</a>`).join(" ")}</nav>
<main>
  <article id="story" data-note="${SECRETS.data}">
    <h1 title="${SECRETS.title}">${words(5)}</h1>
    ${Array.from({ length: 6 }, (_, i) => `<p>${words(60, i)}</p>`).join("\n    ")}
  </article>

  <section class="feed">${Array.from({ length: 5 }, (_, i) => POST(i)).join("")}</section>

  <div class="link-list"><p>${Array.from({ length: 6 }, (_, i) => `<a href="${SECRETS.url}">${words(4, i + 9)}</a>`).join(" ")}</p></div>

  <pre><code>const ${SECRETS.json} = require("${SECRETS.value}");
function build(opts) { return opts.map((o) => o.id).filter(Boolean); }
if (!build([])) { throw new Error("empty"); }
module.exports = { build, ${SECRETS.json} };</code></pre>

  <p id="zh-long" lang="zh">这是一段用于测试的中文段落，它足够长，可以形成一个完整的分析单元。我们需要确认扩展程序能够正确地识别中文内容，并且在本地语言判定环节就把它挡下来，而不是把文字发送给后台的评分服务。段落里没有任何真实的个人信息，只有为了测试而写的普通句子。这样一来，报告里就可以准确地说明为什么这一段没有得到任何标记，以及是哪一条规则做出了这个判断。</p>

  <!-- A short Chinese paragraph with a heading on either side: a heading is a barrier, so
       it has nobody of its own voice to merge with and stays under the floor. -->
  <h2>${words(4, 31)}</h2>
  <p id="zh-short" lang="zh">这一段很短，不到五十个词的下限，因此不会形成任何单元，旁边也没有同一段落可以合并。</p>
  <h2>${words(4, 33)}</h2>

  <div id="behind" aria-hidden="true"><p>${words(60, 11)}</p></div>

  <address>${SECRETS.author} &lt;${SECRETS.mail}&gt;</address>
  <img alt="${SECRETS.alt}" src="${SECRETS.url}" width="40" height="40">
  <form><input value="${SECRETS.value}"></form>
</main>
<iframe src="/frame.html" width="640" height="360" title="embed"></iframe>
</body></html>`;

const FRAME = `<!doctype html><html lang="en"><body><p>${words(60, 21)}</p></body></html>`;

// ---- run --------------------------------------------------------------------------------

const server = await serveHtml({ "/diag.html": PAGE, "/frame.html": FRAME });
const { daemon, context, sw } = await withFakeDaemon({ viewport: { width: 1200, height: 900 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

/** Exactly what contextMenus.onClicked does for the diagnostics entry, plus the answer. */
const askForDiagnostics = (frameId = 0) =>
  sw.evaluate(async (fid) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { action: "copyDiagnostics", frameId: fid }, { frameId: 0 });
  }, frameId);

const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText().catch(() => null));

async function openAndCopy(path, { settle = 4000 } = {}) {
  const page = await context.newPage();
  await page.goto(server.url(path) + "?session=OTTERGLASS77#fragment", { waitUntil: "load" });
  await page.waitForTimeout(settle);
  await page.bringToFront();
  await page.evaluate(() => navigator.clipboard.writeText("NOTHING COPIED").catch(() => {}));
  const reply = await askForDiagnostics();
  const text = await readClipboard(page);
  return { page, reply, text };
}

// ---- A: a page Anagram is running on -----------------------------------------------------

{
  const { page, reply, text } = await openAndCopy("/diag.html");
  const dom = await page.evaluate(() => ({
    chips: document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)').length,
    elements: document.getElementsByTagName("*").length,
  }));
  if (process.env.DIAG_PRINT) console.log(text);

  record("the worker's click handler gets an answer and the text reaches the clipboard", reply?.ok === true && text !== "NOTHING COPIED" && text !== null, JSON.stringify(reply));

  const has = (re) => (typeof re === "string" ? text?.includes(re) : re.test(text ?? ""));

  // --- header ---
  record(
    "header: version, MV, browser, both languages",
    has(/^- Anagram \d+\.\d+\.\d+ \(MV3\) · Chrome [\d.]+ · UI language \S+ \(messages \S+\)$/m),
    (text ?? "").split("\n")[2],
  );
  record(
    "header: the HOSTNAME and nothing else of the address — no path, no query, no fragment",
    has("host `localhost`") && !has("OTTERGLASS77") && !has("/diag.html") && !has("fragment"),
    (text ?? "").split("\n").find((l) => l.startsWith("- host")) ?? "",
  );
  record("header: document language, viewport, element count, hydration marker", has("document language `en`") && has(/viewport \d+×\d+/) && has(`${dom.elements} elements`) && has("hydration marker: none"), "");
  record("header: scope, merge and display settings", has("scope `page` · merge short paragraphs on · show `all`"), "");
  record("header: the state and the daemon", has("state: running") && has("daemon: up ·"), (text ?? "").split("\n").find((l) => l.startsWith("- daemon")) ?? "");

  // --- counts ---
  const counts = (text ?? "").match(/- units (\d+) \((\d+) multi-part\) · windows (\d+) · chips on the page (\d+)/);
  record(
    "counts: units, windows and chips, and the chip count is the page's own",
    counts !== null && Number(counts[4]) === dom.chips && Number(counts[1]) > 0 && Number(counts[3]) >= Number(counts[1]),
    `report ${counts?.[0]} · DOM chips ${dom.chips}`,
  );
  const judged = (text ?? "").match(/- words judged (\d+) of (\d+) visible prose words \((\d+) %\)/);
  record(
    "counts: words judged against the page's visible prose, as a percentage",
    judged !== null && Number(judged[1]) > 100 && Number(judged[2]) > Number(judged[1]) && Number(judged[3]) > 0,
    judged?.[0] ?? "no coverage line",
  );

  // --- the silence, one shape at a time ---
  const silence = (text ?? "").split("## Why the rest is silent")[1]?.split("## Frames")[0] ?? "";
  const entryFor = (path) =>
    silence
      .split(/\n(?=\s*\d+\. )/)
      .find((block) => block.includes(path)) ?? "";

  record(
    "silent: a sub-floor post in a feed — under the 50-word floor, with its word count",
    /div\.post > p`/.test(silence) && /under the 50-word floor: longest paragraph 22 words/.test(entryFor("div.post > p")),
    entryFor("div.post > p").replace(/\s+/g, " ").slice(0, 160),
  );
  record(
    "silent: the nav — page chrome, named by the branch of the filter that fired",
    /page chrome nav\.site-nav — <nav> is chrome wherever it stands/.test(silence),
    entryFor("nav.site-nav").replace(/\s+/g, " ").slice(0, 160),
  );
  record(
    "silent: a list of links outside any landmark — link-dense, with the ratio",
    /link-dense: \d+\/\d+ blocks over the 0\.6 link-text ratio \(worst [\d.]+\)/.test(silence),
    entryFor("div.link-list").replace(/\s+/g, " ").slice(0, 160),
  );
  record(
    "silent: the code block — inside a <pre> of machine text",
    /inside a <pre> of machine text/.test(silence),
    entryFor("pre").replace(/\s+/g, " ").slice(0, 160),
  );
  record(
    // `x6` is the id: "behind" is not a word any of our detectors or layouts use, so the
    // report keeps its shape and drops the word (lib/diagnostics/vocabulary.ts). That is
    // the whole point — an id can carry a name — and the element is still named.
    "silent: the column behind an aria-hidden wrapper, named with the element",
    /aria-hidden div#x6 — hidden from assistive tech/.test(silence),
    entryFor("div#x6").replace(/\s+/g, " ").slice(0, 160),
  );
  record(
    "silent: the short Chinese paragraph carries the detected language beside its reason",
    /the language gate reads this as "zh"/.test(silence),
    entryFor("p#zh-short").replace(/\s+/g, " ").slice(0, 200),
  );
  record(
    "silent: the article that WAS scored is not in the list at all",
    !/article#story > p`/.test(silence),
    silence.replace(/\s+/g, " ").slice(0, 200),
  );
  record(
    "silent: at most fifteen stretches, biggest first",
    (() => {
      const nums = [...silence.matchAll(/^\s*\d+\. (\d+)w · /gm)].map((m) => Number(m[1]));
      return nums.length > 0 && nums.length <= 15 && nums.every((n, i) => i === 0 || nums[i - 1] >= n);
    })(),
    "",
  );

  // --- frames ---
  record(
    "frames: the subframe by hostname and size, and whether our content script runs there",
    has("1 subframe(s)") && /localhost · \d{3}×\d{3} · our content script runs there and passes the size gate/.test(text ?? ""),
    (text ?? "").split("## Frames")[1]?.split("\n").slice(0, 3).join(" ") ?? "",
  );

  // --- the structure ---
  record(
    "structure: the region is captured as anonymous HTML with its computed layout",
    has("## Structure, anonymised") && has("```html") && /<article[^>]*id="story"[^>]*style="display:block/.test(text ?? ""),
    "",
  );

  // --- privacy ---
  const leaked = Object.entries(SECRETS).filter(([, v]) => (text ?? "").includes(v));
  record("privacy: not one of the nine planted strings is on the clipboard", leaked.length === 0, JSON.stringify(leaked.map(([k]) => k)));
  const proseLeak = ["quick brown fox", "rooftops and children", "这是一段用于测试的中文段落"].filter((s) => (text ?? "").includes(s));
  record("privacy: no run of the page's own prose, in either script", proseLeak.length === 0, JSON.stringify(proseLeak));
  record(
    "privacy: no URL, no href, no alt, no title and no value survives",
    !has("href") && !has("intranet.example") && !has("alt=") && !has("title=") && !has('value="'),
    "",
  );

  // --- the size cap ---
  const bytes = Buffer.byteLength(text ?? "", "utf8");
  record("size: the report is under the 60 kB a chat will take, and the reply says how big it was", bytes > 0 && bytes <= 60_000 && reply?.bytes === bytes, `${bytes} bytes, reply said ${reply?.bytes}`);
  record("copy: the route it took is reported", reply?.via === "clipboard" || reply?.via === "execCommand", reply?.via ?? "none");

  // --- the region follows the right-click ---
  // A real contextmenu event, which is the only thing that tells the page WHERE the menu
  // was opened: the worker learns the frame and nothing finer.
  await page.click("section.feed div.post:nth-child(3) p", { button: "right" });
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => navigator.clipboard.writeText("NOTHING COPIED").catch(() => {}));
  const clicked = await askForDiagnostics();
  const afterClick = await readClipboard(page);
  // The capture climbs from the click to the smallest ancestor that still holds a body of
  // text: one 22-word post is too little to rebuild a feed from, and the section holding
  // all five of them is exactly the fixture somebody would want.
  record(
    "the structure captured follows the right-click, not the main region",
    clicked?.ok === true &&
      /## Structure, anonymised — the box you right-clicked in/.test(afterClick ?? "") &&
      /- `.*section\.feed` \(\d+ elements inside it\)/.test(afterClick ?? "") &&
      /<div class="post"/.test(afterClick ?? ""),
    (afterClick ?? "").split("## Structure")[1]?.split("\n").slice(0, 2).join(" ") ?? "",
  );

  await page.close();
}

// ---- B: a huge page — the cap holds and says so -------------------------------------------

{
  const big = `<!doctype html><html lang="en"><body><main>${Array.from({ length: 400 }, (_, i) => `<div class="card"><p>${words(60, i)}</p><p>${words(30, i + 1)}</p></div>`).join("")}</main></body></html>`;
  const bigServer = await serveHtml({ "/big.html": big });
  const page = await context.newPage();
  await page.goto(bigServer.url("/big.html"), { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.bringToFront();
  const reply = await askForDiagnostics();
  const text = await readClipboard(page);
  const bytes = Buffer.byteLength(text ?? "", "utf8");
  record(
    "a page far too big to describe whole is cut at the cap and says it was truncated",
    bytes <= 60_000 && bytes > 40_000 && /truncated/.test(text ?? ""),
    `${bytes} bytes`,
  );
  await page.close();
  await bigServer.close();
}

// ---- C: a site switched off by rule --------------------------------------------------------

{
  await sw.evaluate(
    () => new Promise((res) => chrome.storage.local.set({ siteOverrides: { localhost: "off" } }, res)),
  );
  const { page, reply, text } = await openAndCopy("/diag.html", { settle: 2500 });
  const chips = await page.evaluate(() => document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)').length);
  record(
    "a site switched off by rule still answers, and the report says which rule turned it off",
    reply?.ok === true && chips === 0 && /state: DISABLED for this site by rule `localhost`/.test(text ?? ""),
    (text ?? "").split("\n").find((l) => l.startsWith("- state")) ?? "no state line",
  );
  // The walk is what the report describes, and the walk does not need the extension to be
  // on: the units it would make are still counted, and the boxes it would refuse are still
  // named. What is missing is only the chips, which is what "DISABLED" above explains.
  record(
    "…and the walk still explains the page: units counted, no chips, the structural reasons still named",
    /chips on the page 0/.test(text ?? "") &&
      /- units [1-9]/.test(text ?? "") &&
      /under the 50-word floor/.test(text ?? "") &&
      /<nav> is chrome wherever it stands/.test(text ?? ""),
    ((text ?? "").split("## Why the rest is silent")[1] ?? "").replace(/\s+/g, " ").slice(0, 160),
  );
  await page.close();
  await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ siteOverrides: {} }, res)));
}

await context.close();
await server.close();
await daemon.close();

// ---- D: Firefox (opt-in) -------------------------------------------------------------------
//
// The copy is the one part of this that is not the same on both browsers. It happens when
// the worker's message reaches the page, which is NOT a user-input handler, and Firefox
// refuses a content script both clipboard routes outside one. `clipboardWrite` is
// therefore declared OPTIONAL in the Firefox manifest and asked for inside the menu click
// itself — a required clipboard permission would put "Input data to the clipboard" in
// front of every reader at install time for a menu entry most will never open.
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
// Opt-in because it wants a downloaded Firefox: `node test/diagnostics-check.mjs --firefox`.

if (process.argv.includes("--firefox")) {
  const ff = await import("./firefox-harness.mjs");
  const ffServer = await serveHtml({ "/diag.html": PAGE, "/frame.html": FRAME });
  const { daemon: ffDaemon, browser, extUrl } = await ff.withFakeDaemon({
    // No doorhanger may ever appear and block the run; BiDi could not dismiss one.
    extraPrefs: { "extensions.webextOptionalPermissionPrompts": false },
  });
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
  await browser.close();
  await ffServer.close();
  await ffDaemon.close();
}

// ---- summary --------------------------------------------------------------------------------

console.log("\n=== PAGE DIAGNOSTICS ===");
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
console.log(fails.length === 0 ? "✅ DIAGNOSTICS GREEN" : "❌ DIAGNOSTICS FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
