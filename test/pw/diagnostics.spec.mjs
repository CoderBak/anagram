// "Copy page diagnostics", end to end in a real browser.
//
// The feature turns "nothing shows up on this site" into a fixture in a minute: the reader
// right-clicks, one entry copies an ANONYMOUS description of the page and of what Anagram
// did with it, and they paste that to whoever has to fix it. So what is checked here is
// exactly what a paste is worth:
//
//   the header   — version, browser, languages, HOSTNAME (never a path or a query), scope,
//                  merge, fixture state, frames;
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
// worker's own click handler is driven the way test/pw/scenarios-controls.spec.mjs drives the page entry:
// the message it sends, to the frame it sends it to. The Firefox copy path is
// test/diagnostics-firefox.mjs.
//
//   npm run test:diagnostics
//   DIAG_PRINT=1 npx playwright test diagnostics   # also print the report it read back
//
// The printed form is the point of the whole feature — what somebody pastes — so it is
// worth looking at whenever the wording or the fixture changes.
import { test as base, expect } from "./fixtures.mjs";
import { PAGE, FRAME, SECRETS, words } from "../diagnostics-page.mjs";

/** Exactly what contextMenus.onClicked does for the diagnostics entry, plus the answer. */
const askForDiagnostics = (sw, frameId = 0) =>
  sw.evaluate(async (fid) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { action: "copyDiagnostics", frameId: fid }, { frameId: 0 });
  }, frameId);

/** The content script of the active tab answers the worker's own probe (lib/access/worker.ts). */
const contentScriptUp = (sw) =>
  expect
    .poll(
      () =>
        sw
          .evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            try {
              return (await chrome.tabs.sendMessage(tab.id, { action: "ping" }, { frameId: 0 }))?.ok === true;
            } catch {
              return false;
            }
          })
          .catch(() => false),
      { message: "the content script answers", timeout: 15000, intervals: [100] },
    )
    .toBe(true);

/** Every paragraph of the article carries its verdict: the page has been read. */
const articleRead = (page) =>
  page.waitForFunction(() => {
    const paragraphs = [...document.querySelectorAll("#story p")];
    return paragraphs.length > 0 && paragraphs.every((p) =>
      [...p.querySelectorAll('[data-anagram="host"]')].some((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")));
  }, null, { timeout: 20000 });

const test = base.extend({
  /** Open the fixture page, and copy its diagnostics once `ready` says it has been read. */
  copyDiagnostics: async ({ context, extension, pages, clipboard }, use) => {
    pages.serve({ "/diag.html": PAGE, "/frame.html": FRAME });
    await use(async (path, { ready } = {}) => {
      const page = await context.newPage();
      await page.goto(pages.url(path) + "?session=OTTERGLASS77#fragment", { waitUntil: "load" });
      await page.bringToFront();
      await contentScriptUp(extension.sw);
      await ready?.(page);
      await clipboard.write(page, "NOTHING COPIED");
      const reply = await askForDiagnostics(extension.sw);
      const text = await clipboard.read(page);
      if (process.env.DIAG_PRINT) console.log(text);
      return { page, reply, text };
    });
  },

  /** The report of the page Anagram is running on, and what the page itself holds. */
  report: async ({ copyDiagnostics }, use) => {
    const { page, reply, text } = await copyDiagnostics("/diag.html", { ready: articleRead });
    const dom = await page.evaluate(() => ({
      chips: document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)').length,
      elements: document.getElementsByTagName("*").length,
    }));
    const has = (re) => (typeof re === "string" ? text?.includes(re) : re.test(text ?? ""));
    const line = (start) => (text ?? "").split("\n").find((l) => l.startsWith(start)) ?? "";
    await use({ page, reply, text: text ?? "", dom, has, line });
  },
});
test.use({ launch: { viewport: { width: 1200, height: 900 } } });

test("the copy: the worker's click handler gets an answer, the text reaches the clipboard, the route and the size are reported", async ({ report }) => {
  const { reply, text } = report;
  expect(reply?.ok, JSON.stringify(reply)).toBe(true);
  expect(text, "the text reaches the clipboard").not.toMatch(/^(NOTHING COPIED)?$/);
  const bytes = Buffer.byteLength(text, "utf8");
  expect.soft(bytes, "size: the report is under the 60 kB a chat will take").toBeGreaterThan(0);
  expect.soft(bytes, "size: the report is under the 60 kB a chat will take").toBeLessThanOrEqual(60_000);
  expect.soft(reply?.bytes, "size: the reply says how big it was").toBe(bytes);
  // The async clipboard, never a <textarea> in the page (lib/diagnostics/index.ts copyText).
  expect.soft(reply?.via, "copy: through the clipboard API, never through the page").toBe("clipboard");
});

test("the header: version, browser, languages, the hostname alone, the page, the settings and the fixture", async ({ report }) => {
  const { has, line, dom, text } = report;
  expect.soft(text, "header: version, MV, browser, both languages").toMatch(/^- Anagram \d+\.\d+\.\d+ \(MV3\) · Chrome [\d.]+ · UI language \S+ \(messages \S+\)$/m);
  expect.soft(
    has("host `localhost`") && !has("OTTERGLASS77") && !has("/diag.html") && !has("fragment"),
    `header: the HOSTNAME and nothing else of the address — no path, no query, no fragment: ${line("- host")}`,
  ).toBe(true);
  expect.soft(
    has("document language `en`") && has(/viewport \d+×\d+/) && has(`${dom.elements} elements`) && has("hydration marker: none"),
    "header: document language, viewport, element count, hydration marker",
  ).toBe(true);
  expect.soft(text, "header: minimum length and display settings").toContain("- minimum 50 words · show `all`");
  expect.soft(has("state: running") && has("daemon: up ·"), `header: the state and the fixture: ${line("- daemon")}`).toBe(true);
});

test("the counts: units and chips against the page's own, and the words judged", async ({ report }) => {
  const { text, dom } = report;
  const counts = text.match(/- units (\d+) \((\d+) multi-part\) · chips on the page (\d+)/);
  expect.soft(
    counts !== null && Number(counts[3]) === dom.chips && Number(counts[1]) > 0,
    `counts: units and chips, and the chip count is the page's own: report ${counts?.[0]} · DOM chips ${dom.chips}`,
  ).toBe(true);
  const judged = text.match(/- words judged (\d+) of (\d+) visible prose words \((\d+) %\)/);
  expect.soft(
    judged !== null && Number(judged[1]) > 100 && Number(judged[2]) > Number(judged[1]) && Number(judged[3]) > 0,
    `counts: words judged against the page's visible prose, as a percentage: ${judged?.[0] ?? "no coverage line"}`,
  ).toBe(true);
});

test("the silence: every quiet shape named with the reason the walk had", async ({ report }) => {
  const silence = report.text.split("## Why the rest is silent")[1]?.split("## Frames")[0] ?? "";
  const entryFor = (path) => (silence.split(/\n(?=\s*\d+\. )/).find((block) => block.includes(path)) ?? "").replace(/\s+/g, " ").slice(0, 200);
  expect.soft(
    /div\.post > p`/.test(silence) && /under the 50-word floor: longest paragraph 22 words/.test(entryFor("div.post > p")),
    `silent: a sub-floor post in a feed — under the 50-word floor, with its word count: ${entryFor("div.post > p")}`,
  ).toBe(true);
  expect.soft(silence, "silent: the nav — page chrome, named by the branch of the filter that fired").toMatch(/page chrome nav\.site-nav — <nav> is chrome wherever it stands/);
  expect.soft(silence, "silent: a list of links outside any landmark — link-dense, with the ratio").toMatch(/link-dense: \d+\/\d+ blocks over the 0\.6 link-text ratio \(worst [\d.]+\)/);
  expect.soft(silence, "silent: the code block — inside a <pre> of machine text").toMatch(/inside a <pre> of machine text/);
  // `x6` is the id: "behind" is not a word any of our detectors or layouts use, so the
  // report keeps its shape and drops the word (lib/diagnostics/vocabulary.ts). That is
  // the whole point — an id can carry a name — and the element is still named.
  expect.soft(silence, "silent: the column behind an aria-hidden wrapper, named with the element").toMatch(/aria-hidden div#x6 — hidden from assistive tech/);
  expect.soft(silence, "silent: the short Chinese paragraph carries the detected language beside its reason").toMatch(/the language gate reads this as "zh"/);
  expect.soft(silence, "silent: the article that WAS scored is not in the list at all").not.toMatch(/article#story > p`/);
  const sizes = [...silence.matchAll(/^\s*\d+\. (\d+)w · /gm)].map((m) => Number(m[1]));
  expect.soft(
    sizes.length > 0 && sizes.length <= 15 && sizes.every((n, i) => i === 0 || sizes[i - 1] >= n),
    `silent: at most fifteen stretches, biggest first: ${JSON.stringify(sizes)}`,
  ).toBe(true);
});

test("frames and structure: the subframe by hostname and size, the region as anonymous HTML", async ({ report }) => {
  const { has, text } = report;
  expect.soft(
    has("1 subframe(s)") && /localhost · \d{3}×\d{3} · our content script runs there and passes the size gate/.test(text),
    `frames: the subframe by hostname and size, and whether our content script runs there: ${text.split("## Frames")[1]?.split("\n").slice(0, 3).join(" ")}`,
  ).toBe(true);
  expect.soft(
    has("## Structure, anonymised") && has("```html") && /<article[^>]*id="story"[^>]*style="display:block/.test(text),
    "structure: the region is captured as anonymous HTML with its computed layout",
  ).toBe(true);
});

test("privacy: no planted string, no run of the page's prose, no URL or attribute value", async ({ report }) => {
  const { has, text } = report;
  const leaked = Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([k]) => k);
  expect.soft(leaked, "privacy: not one of the nine planted strings is on the clipboard").toEqual([]);
  const proseLeak = ["quick brown fox", "rooftops and children", "这是一段用于测试的中文段落"].filter((s) => text.includes(s));
  expect.soft(proseLeak, "privacy: no run of the page's own prose, in either script").toEqual([]);
  expect.soft(
    !has("href") && !has("intranet.example") && !has("alt=") && !has("title=") && !has('value="'),
    "privacy: no URL, no href, no alt, no title and no value survives",
  ).toBe(true);
});

test("the structure captured follows the right-click, not the main region", async ({ report, extension, clipboard }) => {
  const { page } = report;
  // A real contextmenu event, which is the only thing that tells the page WHERE the menu
  // was opened: the worker learns the frame and nothing finer.
  await page.click("section.feed div.post:nth-child(3) p", { button: "right" });
  await page.keyboard.press("Escape").catch(() => {});
  await clipboard.write(page, "NOTHING COPIED");
  const clicked = await askForDiagnostics(extension.sw);
  const afterClick = (await clipboard.read(page)) ?? "";
  // The capture climbs from the click to the smallest ancestor that still holds a body of
  // text: one 22-word post is too little to rebuild a feed from, and the section holding
  // all five of them is exactly the fixture somebody would want.
  expect(clicked?.ok).toBe(true);
  expect(afterClick, afterClick.split("## Structure")[1]?.split("\n").slice(0, 2).join(" ")).toMatch(/## Structure, anonymised — the box you right-clicked in/);
  expect(afterClick).toMatch(/- `.*section\.feed` \(\d+ elements inside it\)/);
  expect(afterClick).toMatch(/<div class="post"/);
});

test("a page far too big to describe whole is cut at the cap and says it was truncated", async ({ context, extension, pages, clipboard }) => {
  pages.serve({
    "/big.html": `<!doctype html><html lang="en"><body><main>${Array.from({ length: 400 }, (_, i) => `<div class="card"><p>${words(80, i)}</p><p>${words(30, i + 1)}</p></div>`).join("")}</main></body></html>`,
  });
  const page = await context.newPage();
  await page.goto(pages.url("/big.html"), { waitUntil: "load" });
  await page.bringToFront();
  await contentScriptUp(extension.sw);
  await askForDiagnostics(extension.sw);
  const text = (await clipboard.read(page)) ?? "";
  const bytes = Buffer.byteLength(text, "utf8");
  expect(bytes, `${bytes} bytes`).toBeLessThanOrEqual(60_000);
  expect(bytes, `${bytes} bytes`).toBeGreaterThan(40_000);
  expect(text).toMatch(/truncated/);
});

test("a site switched off by rule still answers, says which rule, and the walk still explains the page", async ({ copyDiagnostics, storage }) => {
  await storage.set({ siteOverrides: { localhost: "off" } });
  const { page, reply, text } = await copyDiagnostics("/diag.html");
  const chips = await page.evaluate(() => document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)').length);
  expect.soft(
    reply?.ok === true && chips === 0 && /state: DISABLED for this site by rule `localhost`/.test(text ?? ""),
    `a site switched off by rule still answers, and the report says which rule turned it off: ${(text ?? "").split("\n").find((l) => l.startsWith("- state")) ?? "no state line"}`,
  ).toBe(true);
  // The walk is what the report describes, and the walk does not need the extension to be
  // on: the units it would make are still counted, and the boxes it would refuse are still
  // named. What is missing is only the chips, which is what "DISABLED" above explains.
  expect.soft(
    /chips on the page 0/.test(text ?? "") && /- units [1-9]/.test(text ?? "") && /under the 50-word floor/.test(text ?? "") && /<nav> is chrome wherever it stands/.test(text ?? ""),
    `…and the walk still explains the page: units counted, no chips, the structural reasons still named: ${((text ?? "").split("## Why the rest is silent")[1] ?? "").replace(/\s+/g, " ").slice(0, 160)}`,
  ).toBe(true);
});
