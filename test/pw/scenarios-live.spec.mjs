// Real sites, read with the test build: the HF paper (the original bug), EN/AR/JA Wikipedia,
// MDN, paulgraham, arXiv, StackOverflow, GitHub, a text/plain RFC, and aggregator pages that
// must stay (nearly) bare. A site that fails to LOAD, or answers with a bot check, is skipped:
// that says nothing about the extension. A loaded site that breaks its expectation fails, and
// so does any console error from the extension. These are the only tests that go to the
// network; their project exists only with ANAGRAM_LIVE=1 (playwright.config.mjs), which
// `npm run test:scenarios` sets.
//
//   ANAGRAM_LIVE=1 npx playwright test --project live
import { test, expect, BADGE_SEL, chipCounts } from "./kit.mjs";

const LIVE = [
  // Two chips: the abstract's 65-word paragraph, under the 75-word floor, is read with the one before it.
  { name: "hf-paper", url: "https://huggingface.co/papers/2606.12385", min: 2, chromeMax: 0 },
  { name: "wiki-en", url: "https://en.wikipedia.org/wiki/Alan_Turing", min: 10, chromeMax: 0 },
  { name: "wiki-ar-rtl", url: "https://ar.wikipedia.org/wiki/%D8%A2%D9%84%D8%A7%D9%86_%D8%AA%D9%88%D8%B1%D9%86%D8%BA", min: 3 },
  { name: "wiki-ja-cjk", url: "https://ja.wikipedia.org/wiki/%E3%82%A2%E3%83%A9%E3%83%B3%E3%83%BB%E3%83%81%E3%83%A5%E3%83%BC%E3%83%AA%E3%83%B3%E3%82%B0", min: 3 },
  { name: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview", min: 5, chromeMax: 0 },
  { name: "paulgraham", url: "https://www.paulgraham.com/greatwork.html", min: 50 },
  { name: "arxiv-abs", url: "https://arxiv.org/abs/2301.10226", min: 1 },
  { name: "stackoverflow", url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array", min: 1, noPre: true },
  { name: "github-readme", url: "https://github.com/nodejs/node", min: 1, noPre: true },
  { name: "rfc-txt", url: "https://www.rfc-editor.org/rfc/rfc768.txt", min: 1 },
  { name: "samaltman-blog", url: "https://blog.samaltman.com/", min: 1 },
  { name: "hackernews-zero", url: "https://news.ycombinator.com/", max: 0 },
  { name: "bbc-near-zero", url: "https://www.bbc.com/news", max: 2 },
];

for (const site of LIVE) {
  test(site.name, async ({ page }) => {
    const extErrors = [];
    page.on("console", (m) => {
      const u = m.location()?.url ?? "";
      if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid")) extErrors.push(m.text().slice(0, 140));
    });
    const loaded = await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).then(() => true, () => false);
    test.skip(!loaded, "the site did not load: network");
    // Anti-bot interstitials (Cloudflare "Verifying you are human", "Just a moment…") carry no prose.
    const botWall = await page
      .evaluate(() => /verifying you are human|just a moment|attention required|checking your browser/i.test(document.title + " " + (document.body?.innerText ?? "").slice(0, 600)))
      .catch(() => false);
    test.skip(botWall, "a bot-check interstitial, not the page");

    // Lazy sections (HF community comments) come as the reader scrolls: scroll through, then
    // wait until no chip is still analyzing and their number has held for a second.
    await page.evaluate(async () => {
      const step = Math.round(innerHeight * 0.8);
      for (let i = 0; i < 6; i++) {
        scrollBy(0, step);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300)));
      }
      scrollTo(0, 0);
    }).catch(() => {});
    let last = -1;
    await expect
      .poll(async () => {
        const { chips, pending } = await chipCounts(page);
        const held = chips === last;
        last = chips;
        return pending === 0 && held;
      }, { message: "the page has settled", timeout: 30_000, intervals: [1000] })
      .toBe(true);

    const stats = await page.evaluate((sel) => {
      const anchors = [...document.querySelectorAll(sel)].map((h) => h.parentElement).filter(Boolean);
      return {
        chips: anchors.length,
        chrome: anchors.filter((el) => el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]")).length,
        inPre: anchors.filter((el) => el.closest("pre")).length,
        sample: (anchors[0]?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
      };
    }, BADGE_SEL);
    const note = `${site.name}: ${JSON.stringify(stats)}`;
    if (site.min !== undefined) expect.soft(stats.chips, note).toBeGreaterThanOrEqual(site.min);
    if (site.max !== undefined) expect.soft(stats.chips, note).toBeLessThanOrEqual(site.max);
    if (site.chromeMax !== undefined) expect.soft(stats.chrome, `${note} (chips in page chrome)`).toBeLessThanOrEqual(site.chromeMax);
    if (site.noPre) expect.soft(stats.inPre, `${note} (chips in <pre>)`).toBe(0);
    expect.soft(extErrors, `${note} (extension console errors)`).toEqual([]);
  });
}
