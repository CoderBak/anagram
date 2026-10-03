// The self-test page (test/selftest.html), end to end, against the deterministic fake host:
// long paragraphs badge once and underline to the end (the HF regression), a paragraph
// longer than the model reads in one pass is scored completely — in overlapping passes
// planned on the engine's token counts, one chip, each stretch marked in the colour of the
// passes that read it — BR-split/short-sibling/pre-wrap content merges into single units, a
// post written one short sentence per line is one unit while two voices never share one, a
// post of mixed paragraphs (X markup) sits under ONE chip reading ×N and is one chip again
// after it is opened in place, inline code does not fragment prose, pure-CJK text is
// settled by the local language gate instead of being scored (the host never sees it),
// hidden tabs and <details> get badges when revealed, pushState swaps re-badge and purge,
// removals purge, never-score zones stay clean, and the page DOM carries no marker
// attributes. Every test fails on a console error of the page or the content script.
//
//   npm run test:e2e
//   HEADED=1 npm run test:e2e   # watch it run
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, BADGE_SEL, SCORE, settledChips, marked } from "./kit.mjs";
import { fakeScore } from "../fake-native.mjs";

const SELFTEST = readFileSync(join(import.meta.dirname, "..", "selftest.html"), "utf8");

/** Every unit the page holds before anything is clicked, by the section it sits in. */
const UNITS = { human: 1, aiwrap: 1, quote: 1, divbased: 2, longpara: 1, windowed: 1, brsplit: 1, mergeshorts: 1, postlines: 1, postwhole: 1, inlinecode: 1, purecjk: 1, prewrap: 1, spa: 1 };

const test = base.extend({
  /** "no console errors": whatever the page or the content script writes as an error. */
  consoleErrors: [
    async ({ page }, use) => {
      const errors = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await use(errors);
      expect(errors, "no console errors").toEqual([]);
    },
    { auto: true },
  ],

  /** The self-test page, read: every unit it holds carries its verdict. The page is not
   *  scrolled — what is off screen is read by the idle prefetch, in reading order. */
  selftest: async ({ page, pages }, use) => {
    // A favicon too: the browser asks for one, and a 404 is a console error.
    pages.serve({ "/selftest.html": SELFTEST, "/favicon.ico": (req, res) => res.writeHead(204).end() });
    await page.goto(pages.url("/selftest.html"), { waitUntil: "load" });
    for (const [id, n] of Object.entries(UNITS)) await expect(settledChips(page, `#${id}`), `#${id} is read`).toHaveCount(n);
    await use(page);
  },
});
test.use({ launch: { viewport: { width: 1280, height: 720 } } });

const chipsIn = (page, id) => page.locator(`#${id} ${BADGE_SEL}`);
const numOf = (page, id) => page.locator(`#${id} ${BADGE_SEL} .num`).textContent();
const cardOf = (page, id) => page.locator(`#${id} ${BADGE_SEL} .card`).textContent();
const hasMark = (texts, marker) => texts.some((t) => t.includes(marker));

test("the page is read: a chip on every unit, underlines, no floating button, and no marker attribute in the page's own DOM", async ({ selftest: page }) => {
  expect.soft(await page.locator(BADGE_SEL).count(), "badges rendered across the page").toBeGreaterThanOrEqual(11);
  await expect.soft(page.locator("#anagram-fab"), "no floating toolbar on the page").toHaveCount(0);
  expect.soft((await marked(page)).length, "underlines present").toBeGreaterThan(0);
  for (const id of ["human", "aiwrap", "quote"]) await expect.soft(chipsIn(page, id), "human/ai/quote/div-EN/div-ZH badged").toHaveCount(1);
  await expect.soft(chipsIn(page, "divbased"), "human/ai/quote/div-EN/div-ZH badged").toHaveCount(2);
  const inline = await marked(page);
  await expect.soft(chipsIn(page, "inlinecode"), "inline <code> does not fragment the paragraph").toHaveCount(1);
  expect.soft(hasMark(inline, "ICODE tail marker"), "inline <code> does not fragment the paragraph").toBe(true);
  const strayMarks = await page.evaluate(() => [...document.querySelectorAll("[data-anagram]")].filter((el) => !["host", "style"].includes(el.getAttribute("data-anagram"))).length);
  expect.soft(strayMarks, "page DOM carries no marker attributes").toBe(0);
});

test("what is not read: a short isolated paragraph, the never-score zones, and Chinese text, which the local language gate settles", async ({ selftest: page, nativeHost }) => {
  await expect.soft(chipsIn(page, "short"), "short isolated paragraph skipped").toHaveCount(0);
  await expect.soft(chipsIn(page, "never"), "never-score zone clean (code/nav-links/editor/aria-hidden)").toHaveCount(0);
  // The Chinese paragraph never reaches a backend: the content script's language gate
  // renders an "unsupported language" chip with no number and no mark.
  await expect.soft(chipsIn(page, "purecjk"), "pure-CJK paragraph badged as 'unsupported' (language gate)").toHaveCount(1);
  await expect.soft(page.locator(`#purecjk ${BADGE_SEL} .pill.band-unsupported`), "pure-CJK paragraph badged as 'unsupported' (language gate)").toHaveCount(1);
  const stats = nativeHost.stats;
  expect.soft(stats.blocks, "non-English text is gated locally (the fixture received none)").toBeGreaterThan(5);
  expect.soft(stats.nonEnglishBlocks, "non-English text is gated locally (the fixture received none)").toBe(0);
});

test("a long paragraph is one chip and one pass, and its underline reaches the end (the HF regression)", async ({ selftest: page }) => {
  await expect.soft(chipsIn(page, "longpara"), "LONG paragraph: exactly ONE badge (no 1000-char split)").toHaveCount(1);
  expect.soft(hasMark(await marked(page), "final LONGTAIL sentence"), "LONG paragraph underline reaches the end (HF regression)").toBe(true);
  expect.soft(await cardOf(page, "longpara"), "LONG paragraph is still one pass: no pass row in its card").not.toMatch(/Scored|Read in/);
});

test("a paragraph longer than the model reads in one pass is counted, read whole in overlapping passes, marked pass by pass under one chip", async ({ selftest: page, nativeHost }) => {
  const text = (await page.locator("#windowed p").textContent()).replace(/\s+/g, " ").trim();
  // What the host was asked about it: every block that is a piece of it, in reading order,
  // and where each lies. The fake's verdict is a pure function of the text, so what the page
  // must show is known here without asking the page.
  const blocks = [...new Set(nativeHost.textsSince().filter((t) => t.length > 200 && text.includes(t)))].sort((a, b) => text.indexOf(a) - text.indexOf(b));
  const at = blocks.map((t) => [text.indexOf(t), text.indexOf(t) + t.length]);
  const verdicts = blocks.map((t) => fakeScore(t));
  const counted = nativeHost.requests().some((r) => r.op === "tokens" && r.payload.texts.some((t) => text.includes(t)));

  await expect.soft(chipsIn(page, "windowed"), "WINDOWED paragraph: exactly ONE chip, showing one score and no per cent sign").toHaveCount(1);
  expect.soft(await numOf(page, "windowed"), "WINDOWED paragraph: exactly ONE chip, showing one score and no per cent sign").toMatch(SCORE);

  const whole = "WINDOWED paragraph: counted by the engine, then read whole in passes over two neighbouring halves each, none past its token window";
  expect.soft(counted, `${whole} (counted)`).toBe(true);
  expect.soft(blocks.length, `${whole} (passes: ${JSON.stringify(at)})`).toBeGreaterThanOrEqual(3);
  expect.soft(at[0]?.[0], `${whole} (from the first character)`).toBe(0);
  expect.soft(at.at(-1)?.[1], `${whole} (to the last)`).toBe(text.length);
  expect.soft(at.every(([from, to], i) => i === 0 || (from > at[i - 1][0] && from < at[i - 1][1] && to > at[i - 1][1])), `${whole} (each overlaps the one before and reaches past it)`).toBe(true);
  expect.soft(at.every(([, to], i) => i + 2 >= at.length || text.slice(to).trimStart() === text.slice(at[i + 2][0])), `${whole} (a pass ends where the one after next begins)`).toBe(true);
  expect.soft(verdicts.every((v) => v.truncated === false), `${whole} (none truncated)`).toBe(true);

  expect.soft(hasMark(await marked(page), "final WINDOWTAIL sentence"), "WINDOWED paragraph: underline reaches the final sentence").toBe(true);

  // The opening is read by the first pass alone and the close by the last alone, so those
  // two stretches carry exactly their pass's word (lib/render/scale.ts, one step per word);
  // every stretch between is a weighted mean, so its word lies between the passes'.
  const stepOf = (score) => `s0${score < 1 / 6 ? 0 : score < 1 / 2 ? 1 : score < 5 / 6 ? 2 : 3}`;
  const steps = verdicts.map((v) => stepOf(v.score));
  const bands = await page.evaluate(() => {
    const p = document.querySelector("#windowed p");
    const out = new Set();
    for (const [name, h] of CSS.highlights ?? []) for (const r of h) if (p.contains(r.startContainer)) out.add(name.replace("anagram-", ""));
    return [...out].sort();
  });
  const stretch = `WINDOWED paragraph: marked stretch by stretch — the opening in the first pass's colour, the close in the last's, the rest between (${steps.join(", ")}; drawn ${bands.join(", ")})`;
  expect.soft(bands, stretch).toEqual(expect.arrayContaining([steps[0], steps.at(-1)]));
  const sorted = [...steps].sort();
  expect.soft(bands.every((b) => b >= sorted[0] && b <= sorted.at(-1)), stretch).toBe(true);

  // What lib/render/score.ts writes, spelled out here rather than imported from TypeScript.
  const formatScore = (score) => (Math.round(score * 100) >= 100 ? "1.0" : `.${String(Math.round(score * 100)).padStart(2, "0")}`);
  const card = await cardOf(page, "windowed");
  const passes = "WINDOWED paragraph: the card reads 'Read in N passes' with each pass's number, and claims no prefix";
  expect.soft(card, passes).toContain(`Read in ${blocks.length} passes${verdicts.map((v) => formatScore(v.score)).join(", ")}`);
  expect.soft(card, passes).not.toMatch(/Only the opening|first \d+/);
});

test("short pieces of one voice are one unit, two voices never, and the engine gets the page as it is written", async ({ selftest: page, nativeHost }) => {
  const marks = await marked(page);
  await expect.soft(chipsIn(page, "brsplit"), "BR-split halves merged into one unit").toHaveCount(1);
  expect.soft(hasMark(marks, "BRPART-ONE") && hasMark(marks, "BRPART-TWO"), "BR-split halves merged into one unit").toBe(true);
  await expect.soft(chipsIn(page, "mergeshorts"), "three short siblings merged into one unit").toHaveCount(1);
  expect.soft(["MS-ONE", "MS-TWO", "MS-THREE"].every((m) => hasMark(marks, m)), "three short siblings merged into one unit").toBe(true);
  const post = "one-sentence-per-line post: one unit from the first line to the last, without the name row";
  await expect.soft(chipsIn(page, "postlines"), post).toHaveCount(1);
  expect.soft(hasMark(marks, "POSTLINE-ONE") && hasMark(marks, "POSTLINE-LAST") && !hasMark(marks, "Poster Name"), post).toBe(true);
  await expect.soft(chipsIn(page, "twovoices"), "two posts / an author and a quotation are never added up").toHaveCount(0);
  expect.soft(["VOICE-ONE", "VOICE-TWO", "VOICE-THREE", "VOICE-FOUR"].some((m) => hasMark(marks, m)), "two posts / an author and a quotation are never added up").toBe(false);
  await expect.soft(page.locator(`#prewrap ${BADGE_SEL}`), "pre-wrap blank-line paragraphs split + merged").toHaveCount(1);
  expect.soft(hasMark(marks, "PREWRAP-ONE") && hasMark(marks, "PREWRAP-TWO"), "pre-wrap blank-line paragraphs split + merged").toBe(true);
  expect
    .soft(
      nativeHost.textsSince().some((t) => t.includes("happened to be written.\nMS-TWO") && t.includes("too brief to judge.\nMS-THREE")),
      "the engine reads the page as written: a merged unit's paragraphs on lines of their own",
    )
    .toBe(true);
});

test("a post of mixed paragraphs is ONE chip reading ×4, and still one, ×6, once it is opened in place", async ({ selftest: page }) => {
  const one = "a post of mixed paragraphs: ONE chip reading ×4, marks on every paragraph, none on the name or 'Show more'";
  await expect.soft(chipsIn(page, "postwhole"), one).toHaveCount(1);
  expect.soft(await numOf(page, "postwhole"), one).toMatch(/^(\.\d\d|1\.0) ×4$/);
  const marks = await marked(page);
  expect.soft(["POSTW-ONE", "POSTW-TWO", "POSTW-THREE", "POSTW-FOUR"].every((m) => hasMark(marks, m)), one).toBe(true);
  expect.soft(hasMark(marks, "Another Poster") || hasMark(marks, "Show more"), one).toBe(false);

  // Opened in place: the text is re-rendered with two more paragraphs. The old unit's nodes
  // are gone; the re-scan starts inside the post and must come back with ONE unit.
  await page.locator("#postmore").click();
  const opened = "…opened in place (text re-rendered, two more paragraphs): still ONE chip, now ×6, marks on all six";
  await expect(page.locator(`#postwhole ${BADGE_SEL} .num`), opened).toHaveText(/×6$/);
  await expect(chipsIn(page, "postwhole"), opened).toHaveCount(1);
  await expect
    .poll(async () => {
      const now = await marked(page);
      return ["POSTW-ONE", "POSTW-TWO", "POSTW-THREE", "POSTW-FOUR", "POSTW-FIVE", "POSTW-SIX"].filter((m) => !hasMark(now, m));
    }, { message: opened })
    .toEqual([]);
});

test("what the page reveals later is read: a hidden tab shown by a class flip, a <details> opened", async ({ selftest: page, nativeHost }) => {
  await page.locator("#tabbtn").click();
  await expect(chipsIn(page, "tabpanel"), "hidden tab badged after class-flip reveal").toHaveCount(1);
  await page.locator("#details summary").click();
  await expect(chipsIn(page, "detailswrap"), "<details> content badged after open").toHaveCount(1);
  await expect
    .poll(() => nativeHost.textsSince().some((t) => t.includes("this paragraph — long enough to clear every floor — must be")), {
      message: "the engine reads the page as written: em dashes untouched",
    })
    .toBe(true);
});

test("the page changing under the reader: a pushState swap, a removed paragraph, five paragraphs added at once", async ({ selftest: page }) => {
  await page.locator("#spaNav").click();
  await expect(page.locator("#spa"), "pushState swap: new route badged, stale purged").toContainText("SPA-SECOND");
  await expect(settledChips(page, "#spa"), "pushState swap: new route badged, stale purged").toHaveCount(1);
  await expect(chipsIn(page, "spa"), "pushState swap: new route badged, stale purged").toHaveCount(1);

  const all = page.locator(BADGE_SEL);
  const beforeRemove = await all.count();
  await page.locator("#removeAi").click();
  await expect(all, "removing a paragraph removes its badge").toHaveCount(beforeRemove - 1);

  // The fast-click race: five synchronous clicks, five identical paragraphs, five chips.
  const RAPID = 5;
  const beforeAdd = await all.count();
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) document.getElementById("add").click();
  }, RAPID);
  await expect(settledChips(page, "#sink"), "rapid insert: every added paragraph badged").toHaveCount(RAPID);
  await expect(all, "rapid insert: every added paragraph badged").toHaveCount(beforeAdd + RAPID);
});

test("the toolbar control hides every chip and shows them again", async ({ selftest: page, tell }) => {
  const visible = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((h) => getComputedStyle(h).display !== "none").length, BADGE_SEL);
  const toggleMarks = () => tell(page, { action: "toggleOverlay" });
  const shown = await visible();
  expect(shown, "toggle hides + re-shows badges").toBeGreaterThan(0);
  await toggleMarks();
  await expect.poll(visible, { message: "toggle hides + re-shows badges" }).toBe(0);
  await toggleMarks();
  await expect.poll(visible, { message: "toggle hides + re-shows badges" }).toBe(shown);
});
