// Review pages: every review is read by itself, however short, and gets a chip of its own;
// the reviewer's name, stars and date, the site's disclaimer and a preview cut behind "More"
// get none. The fixtures and what each one guards are described in their own headers
// (test/fixtures/reviews-*.html); test/unit.mjs checks WHO is read with whom on them, and this
// checks what the reader sees: the chips, and the line a short review's card carries.
//
//   npx playwright test scenarios-reviews
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, BADGE_SEL, chipsSettle } from "./kit.mjs";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Per annotated review text: whether it should be read, and how many settled chips it holds. */
const perReview = (page) =>
  page.evaluate((sel) =>
    [...document.querySelectorAll("[data-voice][data-expect]")].map((el) => ({
      who: el.getAttribute("data-voice"),
      want: el.getAttribute("data-expect") === "unit" ? 1 : 0,
      chips: [...el.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")).length,
      short: [...el.querySelectorAll(sel)].some((h) => !!h.shadowRoot?.querySelector(".card .short")),
    })), BADGE_SEL);

for (const [site, chips] of [["trustpilot", 4], ["googlemaps", 5], ["tripadvisor", 4], ["amazon", 4]]) {
  test(`${site} reviews: one chip on every review of 50 words or more, none on the shorter ones or on the site's own words`, async ({ page, pages }) => {
    pages.serve({ [`/reviews-${site}.html`]: readFileSync(join(FIXTURES, `reviews-${site}.html`), "utf8") });
    await page.goto(pages.url(`/reviews-${site}.html`), { waitUntil: "load" });
    await chipsSettle(page, chips);
    const got = await perReview(page);
    expect(got.map((r) => `${r.who}:${r.chips}`), `${site}: a chip per review read`).toEqual(got.map((r) => `${r.who}:${r.want}`));
    // 58 words is under the model's training minimum: its card says so; 96 is not.
    expect(got.find((r) => r.who === "reviewer-3")?.short, `${site}: the 58-word review's card says it is short`).toBe(true);
    expect(got.find((r) => r.who === "reviewer-1")?.short, `${site}: the 96-word review's card does not`).toBe(false);
  });
}

test("the minimum length re-reads an open review page: at 25 words the 32-word review gets its chip, and back at 75 only the long ones keep theirs", async ({ page, pages, storage }) => {
  pages.serve({ "/reviews-trustpilot.html": readFileSync(join(FIXTURES, "reviews-trustpilot.html"), "utf8") });
  await page.goto(pages.url("/reviews-trustpilot.html"), { waitUntil: "load" });
  await chipsSettle(page, 4);
  const chipOf = async (who) => (await perReview(page)).find((r) => r.who === who)?.chips;
  await storage.set({ minWords: 25 });
  await chipsSettle(page, 5);
  expect(await chipOf("reviewer-4"), "at 25 words the 32-word review is read").toBe(1);
  expect(await chipOf("reviewer-2"), "…and the 18-word one still is not").toBe(0);
  await storage.set({ minWords: 75 });
  await chipsSettle(page, 2);
  expect((await perReview(page)).filter((r) => r.chips > 0).map((r) => r.who), "at 75 words: the 96- and 140-word reviews").toEqual(["reviewer-1", "reviewer-6"]);
});
