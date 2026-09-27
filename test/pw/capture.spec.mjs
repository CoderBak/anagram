// What a page's own changes cost: text the page rewrites in place without changing its
// shape (a like count, a relative time) is no reason to read the page again, but it is
// when it belongs to a paragraph that was read, and text that grows is read as before
// (lib/capture/observers.ts, "quiet" text).
//
//   npx playwright test capture
import { test as base, expect } from "./fixtures.mjs";
import { BADGE_SEL } from "../harness.mjs";

const WORDS = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(" ");
const words = (n, from = 0) => Array.from({ length: n }, (_, i) => WORDS[(i + from) % WORDS.length]).join(" ");

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>a page with counters</title></head>
<body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<main>
  <p id="body">${words(90)}.</p>
  <h2>Another part</h2>
  <p id="short">${words(20, 5)}.</p>
</main>
<aside><span id="likes">1,204</span> likes · <span id="replies">17</span> replies · <time id="age">3 min. ago</time></aside>
</body></html>`;

const test = base.extend({
  /** The orchestrator's "dirty scan" lines, from the content script's own console. */
  drains: async ({ page, storage }, use) => {
    await storage.set({ debug: true });
    const cdp = await page.context().newCDPSession(page);
    const drains = [];
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.consoleAPICalled", (e) => {
      const args = e.args.map((a) => a.value ?? a.description ?? "");
      if (args[1] !== "dirty scan:") return;
      const v = {};
      for (let i = 2; i + 1 < args.length; i += 2) v[String(args[i + 1]).replace(/,$/, "")] = Number(args[i]);
      drains.push(v);
    });
    await use(drains);
  },
});

/** The post, read: its long paragraph carries a settled chip. */
async function openPost(page, pages) {
  pages.serve({ "/post.html": PAGE });
  await page.goto(pages.url("/post.html"), { waitUntil: "load" });
  await page.waitForFunction(() => !!document.querySelector('#body [data-anagram="host"]')?.shadowRoot?.querySelector(".pill:not(.pending)"));
}

test("counts and times rewritten in place cost no walk; the same length of new text in a read paragraph is read again", async ({ page, pages, nativeHost, drains }) => {
  await openPost(page, pages);
  const before = drains.length;
  // A feed's ticks: the counters on screen every few hundred ms, the time now and then,
  // each by `textContent`, which swaps the text node for a new one.
  for (let i = 0; i < 8; i++) {
    await page.evaluate((i) => {
      document.getElementById("likes").textContent = (1205 + i).toLocaleString("en");
      document.getElementById("replies").textContent = String(18 + i);
      if (i % 3 === 0) document.getElementById("age").textContent = `${4 + i} min. ago`;
    }, i);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1500); // past the observer's debounce and its max wait
  const ticks = drains.slice(before);
  expect(ticks.length, "the ticks were seen").toBeGreaterThan(0);
  expect(ticks.filter((d) => d.roots > 0), `drains during the ticks that walked the page: ${JSON.stringify(ticks)}`).toEqual([]);
  expect(ticks.reduce((n, d) => n + d.quiet, 0)).toBeGreaterThan(0);

  // The paragraph that was read, edited in place to text of the same length: its old
  // verdict describes text that is not there any more.
  const mark = nativeHost.textMark();
  await page.evaluate((text) => { document.getElementById("body").firstChild.data = text; }, `${words(89)} zeppelin.`);
  await expect.poll(() => nativeHost.textsSince(mark).some((t) => t.includes("zeppelin")), { message: "the edited paragraph is scored again" }).toBe(true);

  // …and replaced whole, by `textContent`, again the same length.
  const next = nativeHost.textMark();
  await page.evaluate((text) => { document.getElementById("body").textContent = text; }, `${words(89, 1)} dirigible.`);
  await expect.poll(() => nativeHost.textsSince(next).some((t) => t.includes("dirigible")), { message: "the replaced paragraph is scored again" }).toBe(true);
  await expect(page.locator(`#body ${BADGE_SEL}`)).toHaveCount(1);
});

test("text that grows is read as before: a short paragraph written over the floor gets its chip", async ({ page, pages }) => {
  await openPost(page, pages);
  await expect(page.locator(`#short ${BADGE_SEL}`)).toHaveCount(0);
  await page.evaluate((text) => { document.getElementById("short").textContent = text; }, `${words(95, 7)}.`);
  await expect(page.locator(`#short ${BADGE_SEL}`)).toHaveCount(1);
});
