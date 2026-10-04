// Pages built to break the reader, with the real extension (the test build). A page's script
// decides everything the content script reads: how deep its tree is, how long a text node,
// how much it changes and how fast. None of it may break Anagram on that page — the ordinary
// paragraphs beside it are read and keep their chips — or hold the page for long, or have
// the content script keep what the page threw away. The limits themselves are unit-tested in
// test/unit.mjs ("pages built to break the reader").
//
//   npx playwright test hostile-pages
import { test as base, expect, PAGE, PARA, settledChips } from "./kit.mjs";

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

/** The page's longest task while `during` runs, from its own long-task observer. */
async function longestTask(page, during) {
  await page.evaluate(() => {
    window.__longest = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longest = Math.max(window.__longest, e.duration);
    }).observe({ type: "longtask" });
  });
  await during();
  return page.evaluate(() => Math.round(window.__longest));
}

test("a tree nested thousands of levels deep, of elements and of shadow roots, leaves the page's other paragraphs read", async ({ page, pages }) => {
  pages.serve({
    "/deep.html": PAGE("deep", `<main><p id="first">${PARA("DEEP-A")}</p><div id="deep"></div></main>
<script>
  // Built by script: no parser nests this deep. Inline boxes, which Chromium lays out at this
  // depth (blocks this deep break its layout before they could break Anagram).
  let at = document.getElementById("deep");
  for (let i = 0; i < 4000; i++) at = at.appendChild(document.createElement("span"));
  at.append("deep text nobody reads: ${"word ".repeat(80)}");
  at = document.getElementById("deep");
  for (let i = 0; i < 1500; i++) at = at.appendChild(document.createElement("span")).attachShadow({ mode: "open" }).appendChild(document.createElement("span"));
  at.append("deep text nobody reads either: ${"word ".repeat(80)}");
</script>`),
  });
  await page.goto(pages.url("/deep.html"), { waitUntil: "load" });
  await expect(settledChips(page, "#first")).toHaveCount(1);
  // …and the page is still read as it changes.
  await page.evaluate((text) => document.querySelector("main").insertAdjacentHTML("beforeend", `<p id="later">${text}</p>`), PARA("DEEP-B"));
  await expect(settledChips(page, "#later")).toHaveCount(1);
});

test("a text node of 4 MB, eight thousand paragraphs, is read without holding the page: its paragraphs get their chips", async ({ page, pages }) => {
  pages.serve({ "/log.html": PAGE("log", `<p id="first">${PARA("LOG-A")}</p><div id="log" style="white-space:pre-wrap"></div>`) });
  await page.goto(pages.url("/log.html"), { waitUntil: "load" });
  await expect(settledChips(page, "#first")).toHaveCount(1);
  const longest = await longestTask(page, async () => {
    await page.evaluate((para) => {
      document.getElementById("log").textContent = Array.from({ length: 8000 }, (_, i) => para.replace("LOG-B", `LOG-${i}`)).join("\n\n");
    }, PARA("LOG-B"));
    await expect(settledChips(page, "#log").first()).toBeVisible({ timeout: 60_000 });
  });
  // Cut a paragraph at a time, this text held the page for minutes. Setting it, laying it out
  // and walking its paragraphs, the page's longest task is now its own layout's.
  expect(longest, "the longest task while the log was read, in ms").toBeLessThan(5000);
});

test("a storm of thousands of elements rebuilt every frame: the observers hold none of them, and the page is read after it", async ({ page, pages, drains }) => {
  pages.serve({ "/storm.html": PAGE("storm", `<p id="first">${PARA("STORM-A")}</p><div id="ticker"></div>`) });
  await page.goto(pages.url("/storm.html"), { waitUntil: "load" });
  await expect(settledChips(page, "#first")).toHaveCount(1);
  await page.evaluate(() => new Promise((done) => {
    const ticker = document.getElementById("ticker");
    const until = performance.now() + 3000;
    const frame = () => {
      const f = document.createDocumentFragment();
      for (let i = 0; i < 5000; i++) f.appendChild(document.createElement("b")).textContent = `${i} `;
      ticker.replaceChildren(); // five thousand removed…
      for (const b of [...f.children]) ticker.appendChild(b); // …and added, one record each
      if (performance.now() < until) requestAnimationFrame(frame);
      else { ticker.replaceChildren(); done(); }
    };
    frame();
  }));
  await page.evaluate((text) => document.body.insertAdjacentHTML("beforeend", `<p id="after">${text}</p>`), PARA("STORM-B"));
  await expect(settledChips(page, "#after")).toHaveCount(1);
  expect(drains.length, "the storm was drained").toBeGreaterThan(0);
  // A drain gets at most what the observers hold (MOST_HELD); past it, the whole page, once.
  const most = Math.max(...drains.map((d) => d.dirty + d.removed));
  expect(most, `the most nodes one drain was handed: ${JSON.stringify(drains)}`).toBeLessThanOrEqual(10_000);
});

test("a custom element that nests itself a thousand deep, each in a closed shadow root, leaves the page's other paragraphs read", async ({ page, pages }) => {
  pages.serve({
    "/nest.html": PAGE("nest", `<main><p id="first">${PARA("NEST-A")}</p><x-nest></x-nest></main>
<script>
  // Each instance, as it connects, gives itself a closed root and puts the next one in it a
  // microtask later (in the same call, Chromium's own stack ends the nesting at some forty
  // levels): the page's custom-element reactions grow the tree a level at a time, every
  // attachShadow announced to the content script, while it reads.
  let made = 0;
  customElements.define("x-nest", class extends HTMLElement {
    connectedCallback() {
      if (made >= 1000) { this.append("the innermost text, deeper than the walk goes: ${"word ".repeat(80)}"); return; }
      made++;
      const root = this.attachShadow({ mode: "closed" });
      queueMicrotask(() => root.append(document.createElement("x-nest")));
    }
  });
</script>`),
  });
  await page.goto(pages.url("/nest.html"), { waitUntil: "load" });
  await expect(settledChips(page, "#first")).toHaveCount(1);
  await page.evaluate((text) => document.querySelector("main").insertAdjacentHTML("beforeend", `<p id="later">${text}</p>`), PARA("NEST-B"));
  await expect(settledChips(page, "#later")).toHaveCount(1);
});
