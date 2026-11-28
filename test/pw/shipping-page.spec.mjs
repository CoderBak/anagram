// A web page as the shipping build meets it (test/test-build.mjs shippingWithSites): what the
// page can see of Anagram is what a page would see of it in the field. The chips are closed
// shadow trees (lib/render/shadowMode.ts): the page sees that a chip is there, and nothing of
// what it says — the test build keeps them open for the other suites to read.
//
//   npx playwright test shipping-page        # builds output/ first
import { test, expect } from "./fixtures.mjs";
import { shippingWithSites } from "../test-build.mjs";
import { PAGE, PARA } from "./kit.mjs";

test.use({ build: shippingWithSites() });

test.describe("Chrome's back/forward cache", () => {
  test.use({ launch: { ignoreDefaultArgs: ["--disable-back-forward-cache"] }, tracing: false });

  test("a cached page gets a fresh document port without an unchecked disconnect error", async ({ page, pages, extension }) => {
    const first = pages.url("/first.html");
    pages.serve({
      "/first.html": `<a href="/next.html">Next</a><script>addEventListener("pageshow", e => document.body.dataset.persisted = e.persisted)</script>`,
      "/next.html": "<p>Next page</p>",
    });
    const settings = await extension.context.newPage();
    await settings.goto("chrome://extensions");
    await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    await settings.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true }), extension.extId);

    // Hold a real document port across pagehide so Chrome closes the worker's end itself.
    const connect = () => extension.worker().evaluate(async url => {
      const [tab] = await chrome.tabs.query({ url });
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => new Promise(resolve => {
          const port = chrome.runtime.connect({ name: "anagram-document" });
          const session = crypto.randomUUID();
          port.onDisconnect.addListener(() => { void chrome.runtime.lastError; resolve(false); });
          port.onMessage.addListener(reply => resolve(reply.session === session));
          port.postMessage({ session });
        }),
      });
      return frame.result;
    }, first);
    await page.goto(first);
    expect(await connect()).toBe(true);
    await page.getByRole("link", { name: "Next" }).click();
    await page.waitForURL(pages.url("/next.html"));
    await page.goBack({ waitUntil: "commit" });
    await expect(page.locator("body")).toHaveAttribute("data-persisted", "true");
    expect(await connect()).toBe(true);
    const errors = await settings.evaluate(async id => {
      const info = await chrome.developerPrivate.getExtensionInfo(id);
      return info.runtimeErrors.map(e => e.message).filter(message => /Unchecked runtime\.lastError.*back\/forward cache/i.test(message));
    }, extension.extId);
    expect(errors).toEqual([]);
  });
});

test("as shipped, a page sees that chips are there and nothing of what they say", async ({ page, pages }) => {
  pages.serve({ "/shipped.html": PAGE("shipped", ["SHIPPEDONE", "SHIPPEDTWO", "SHIPPEDTHREE"].map((tag) => `<p>${PARA(tag)}</p>`).join("\n")) });
  await page.goto(pages.url("/shipped.html"), { waitUntil: "load" });
  const hosts = () => page.evaluate(() => [...document.querySelectorAll('[data-anagram="host"]')].map((h) => ({ open: h.shadowRoot !== null, drawn: h.getBoundingClientRect().width > 0, text: h.textContent })));
  await expect.poll(async () => (await hosts()).filter((h) => h.drawn).length, { message: "chips are drawn as shipped", timeout: 20_000 }).toBe(3);
  const seen = await hosts();
  expect.soft(seen.filter((h) => h.open), "as shipped, no chip's shadow root is open to the page").toEqual([]);
  expect.soft(seen.map((h) => h.text).join(""), "the page reads nothing from a chip's host").toBe("");
  // Inside, where only the browser's own tools reach: every chip says its verdict, drawn
  // without ever reading host.shadowRoot (rootOf in lib/render/badge.ts).
  const cdp = await page.context().newCDPSession(page);
  const scored = async () => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    let n = 0;
    const walk = (node) => {
      const at = node.attributes ?? [];
      for (let i = 0; i < at.length; i += 2) if (at[i] === "class" && /\bpill\b/.test(at[i + 1]) && /\bscored\b/.test(at[i + 1])) n++;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };
    walk(root);
    return n;
  };
  await expect.poll(scored, { message: "every closed chip says its verdict", timeout: 20_000 }).toBe(3);
});

test.describe("Sentence-level detector", () => {
  test.use({ nativeFixtureOptions: {
    model: { id: "fake-detector", ver: "test", calibration: "anagram-detector/1" },
    rules: [{ contains: "MIXED", result: {
      bucket: 2, probs: [0.4, 0, 0.6], score: 0.6, sentenceLabels: [0, 2],
      lang: "en", lang_prob: 0.99, tokens: 200, truncated: false,
    } }],
  } });

  test("sibling paragraphs share context and an inserted heading separates them on the next scan", async ({ page, pages, nativeHost }) => {
    const a = "MIXED first paragraph describes the morning walk down to the river.", b = PARA("MIXED second");
    pages.serve({ "/siblings.html": PAGE("Sibling context", `<article><div><p id="a">${a}</p></div><div id="wrap"><p id="b">${b}</p></div></article>`) });
    await page.goto(pages.url("/siblings.html"));
    await expect.poll(() => nativeHost.textsSince(), { timeout: 20_000 }).toContain(a + "\n\n" + b);
    await expect(page.locator('article [data-anagram="host"]')).toHaveCount(1);
    const mark = nativeHost.textMark();
    await page.evaluate(() => {
      const heading = document.createElement("h2");
      heading.textContent = "Another author";
      document.getElementById("wrap").before(heading);
    });
    await expect.poll(() => nativeHost.textsSince(mark), { timeout: 20_000 }).toContain(b);
    expect(nativeHost.textsSince(mark)).not.toContain(a);
    await expect(page.locator('article [data-anagram="host"]')).toHaveCount(1);
    const secondMarked = () => page.evaluate(() => {
      const second = document.getElementById("b");
      return [...CSS.highlights.values()].some(marks => [...marks].some(r => second.contains(r.startContainer)));
    });
    await expect.poll(secondMarked).toBe(false);
    // The previous mixed passage can come from cache when the heading is removed.
    await page.locator("article h2").evaluate(h => h.remove());
    await expect.poll(secondMarked, { timeout: 20_000 }).toBe(true);
  });

  test("Sentence labels opens and closes inside a pinned shipping chip", async ({ page, pages, extension }) => {
    pages.serve({ "/mixed.html": PAGE("Mixed verdict", `<p>${PARA("MIXED")} ${PARA("SECOND")}</p>`) });
    await page.goto(pages.url("/mixed.html"));
    const readCard = () => extension.worker().evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const host = document.querySelector('[data-anagram="host"]');
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          const details = root?.querySelector(".sentence-labels");
          if (!details) return null;
          const summary = details.querySelector("summary");
          const rect = summary.getBoundingClientRect();
          const classes = [...root.querySelectorAll(".drow .dk")].map(label => label.textContent);
          return { mode: root.mode, pinned: !!root.querySelector(".card.open"), open: details.open, classes,
            inert: root.querySelector(".card").inert, hiddenAncestor: !!host.closest('[aria-hidden="true"]'),
            x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, focused: root.activeElement?.localName };
        },
      });
      return frame.result;
    }, page.url());
    await expect.poll(() => readCard(), {timeout: 20_000}).toMatchObject({
      mode: "closed", open: false, inert: true, classes: ["Human", "AI-assisted", "AI-generated"],
    });
    await page.locator('[data-anagram="host"]').click();
    await expect.poll(readCard).toMatchObject({ pinned: true, inert: false, hiddenAncestor: false });
    const {x, y} = await readCard();
    await page.mouse.click(x, y);
    await expect.poll(readCard).toMatchObject({ pinned: true, open: true, focused: "summary" });
    await page.keyboard.press("Space");
    await expect.poll(readCard).toMatchObject({ pinned: true, open: false, focused: "summary" });
    await page.keyboard.press("Tab");
    await expect.poll(readCard).toMatchObject({ focused: "button" });
    await page.keyboard.press("Escape");
    await expect.poll(readCard).toMatchObject({ pinned: false, inert: true });
  });
});
