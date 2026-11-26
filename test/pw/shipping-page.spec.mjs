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

test("Sentence labels opens and closes inside a pinned shipping chip", async ({ page, pages, extension, nativeHost }) => {
  nativeHost.setState({ model: { id: "fake-detector", ver: "test", calibration: "anagram-detector/1" }, rules: [{ contains: "MIXED", result: {
    bucket: 2, probs: [0.4, 0, 0.6], score: 0.6, sentenceLabels: [0, 2],
    lang: "en", lang_prob: 0.99, tokens: 200, truncated: false,
  } }] });
  pages.serve({ "/mixed.html": PAGE("Mixed verdict", `<p>${PARA("MIXED")} ${PARA("SECOND")}</p>`) });
  await page.goto(pages.url("/mixed.html"));
  const readCard = () => extension.worker().evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const host = document.querySelector('[data-anagram="host"]');
        const root = host && chrome.dom.openOrClosedShadowRoot(host);
        const details = root?.querySelector(".sentence-labels");
        if (!details) return null;
        const bounds = details.querySelector("summary").getBoundingClientRect();
        return { mode: root.mode, pinned: !!root.querySelector(".card.open"), open: details.open,
          x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      },
    });
    return frame.result;
  }, page.url());
  await expect.poll(readCard, {timeout: 20_000}).toMatchObject({ mode: "closed", open: false });
  await page.locator('[data-anagram="host"]').click();
  await expect.poll(readCard).toMatchObject({ pinned: true });
  for (const open of [true, false]) {
    const { x, y } = await readCard();
    await page.mouse.click(x, y);
    await expect.poll(readCard).toMatchObject({ pinned: true, open });
  }
});
