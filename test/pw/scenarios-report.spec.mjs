// What the reader asks for and takes away: the selection card (closed while the host is
// still thinking, a selection read whole in passes), the copied report (passes, paragraph
// links, too little text, a close call), dense text planned on the engine's token counts,
// and the triage panel and the three keyboard commands.
//
//   npx playwright test scenarios-report
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, BADGE_SEL, SCORE, PAGE, KEY_PARA, KEY_TAGS, chipsSettle, toggleCounter } from "./kit.mjs";
import { fakeScore, fakeTokens } from "../fake-native.mjs";

// The self-test page's paragraph read in passes (~3750 characters; its seeded pass verdicts
// add up to a FLAGGED aggregate), as a paragraph and in a <textarea>, which passive capture
// never scores, so the only thing that can read it there is the selection card.
const WINDOWED_TEXT = readFileSync(join(import.meta.dirname, "..", "selftest.html"), "utf8")
  .match(/<section id="windowed">\s*<p>([\s\S]*?)<\/p>/)[1]
  .replace(/\s+/g, " ")
  .trim();
/** The blocks read the whole of `text` in passes, each starting after the one before, inside it, and reaching past it. */
const readWhole = (blocks, text) => {
  const at = blocks.map((t) => [text.indexOf(t), text.indexOf(t) + t.length]);
  return at.length > 1 && at[0][0] === 0 && at[at.length - 1][1] === text.length &&
    at.every(([from, to], i) => i === 0 || (from > at[i - 1][0] && from < at[i - 1][1] && to > at[i - 1][1]));
};
/** The blocks the host was sent that are pieces of `text`, in reading order. */
const piecesOf = (texts, text) => [...new Set(texts.filter((t) => t.length > 200 && text.includes(t)))].sort((a, b) => text.indexOf(a) - text.indexOf(b));

/** Select everything in the page's <textarea> and ask for it the way the context menu does. */
async function analyzeSelection(page, tell) {
  await page.bringToFront();
  await page.evaluate(() => {
    const ta = document.getElementById("draft");
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  });
  await tell(page, { action: "analyzeSelection" });
}
/** The selection card: a badge host appended to <body>, the only one holding a .close. */
const selectionCard = (page) =>
  page.evaluate((sel) => {
    const card = [...document.querySelectorAll(sel)].map((h) => h.shadowRoot?.querySelector(".card")).find((c) => c?.querySelector(".close"));
    if (!card) return null;
    return {
      verdict: card.querySelector(".verdict")?.textContent ?? "",
      read: !!card.querySelector(".dist"),
      rows: Object.fromEntries([...card.querySelectorAll(".row")].map((r) => [r.querySelector(".k")?.textContent, r.querySelector(".v")?.textContent])),
    };
  }, BADGE_SEL);

// The listener used to be attached after the await, so for as long as the host took the
// button did nothing. The marker text sits in a <textarea>, so the only request it can make is
// the card's own, and no cached verdict can rob the card of its "Analyzing…" state.
const STALL_MS = 15_000;
test("selection card: ✕ closes it while the fixture is still thinking", async ({ page, pages, nativeHost, tell }) => {
  nativeHost.setState({ rules: [{ contains: "SLOWPOKE", delayMs: STALL_MS }] });
  pages.serve({
    "/stall.html": PAGE("stall fixture", `<h1>Selection while the fixture stalls</h1>
<textarea id="draft" style="width:100%;height:150px">SLOWPOKE is the marker word this selection carries so the fake fixture knows to hold its answer back for a few seconds, which is exactly the state the close button used to be dead in: the request is in flight, the card says it is analyzing, and the one listener that could dismiss it had not been attached yet, because attaching it was the last statement of the function, so a reader who changed their mind had to wait for the answer before the card would go away.</textarea>`),
  });
  await page.goto(pages.url("/stall.html"), { waitUntil: "load" });
  const closes = "selection card: ✕ closes it while the fixture is still thinking";
  const t0 = Date.now();
  await analyzeSelection(page, tell);
  await expect.poll(async () => (await selectionCard(page))?.verdict, { message: `${closes} (analyzing)` }).toMatch(/Analyzing/);
  await page.locator(`div[data-anagram="host"] .close`).click();
  await expect.poll(() => selectionCard(page), { message: `${closes} (gone)` }).toBeNull();
  expect(Date.now() - t0, `${closes} (before the host answered)`).toBeLessThan(STALL_MS);
});

test("selection card: a long selection is analyzed whole, in overlapping passes — words analyzed = words selected", async ({ page, pages, nativeHost, tell }) => {
  pages.serve({
    "/longsel.html": PAGE("long selection fixture", `<h1>A selection longer than the model reads in one pass</h1>
<textarea id="draft" style="width:100%;height:420px">${WINDOWED_TEXT}</textarea>`),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/longsel.html"), { waitUntil: "load" });
  await analyzeSelection(page, tell);
  const whole = "selection card: a long selection is analyzed whole, in overlapping passes — words analyzed = words selected";
  await expect.poll(async () => (await selectionCard(page))?.read, { message: whole }).toBe(true);
  const { rows } = await selectionCard(page);
  const blocks = piecesOf(nativeHost.textsSince(mark), WINDOWED_TEXT);
  const note = `${whole}: ${JSON.stringify({ rows, blocks: blocks.map((t) => t.length) })}`;
  const passRow = Object.keys(rows).find((k) => /^Read in \d+ passes$/.test(k));
  expect.soft(Number(rows["Words selected"]), note).toBeGreaterThan(600);
  expect.soft(rows["Words analyzed"], note).toBe(rows["Words selected"]);
  expect.soft(passRow, note).toBe(`Read in ${blocks.length} passes`);
  expect.soft(rows[passRow], note).toMatch(new RegExp(`^(\\.\\d\\d|1\\.0)(,\\s(\\.\\d\\d|1\\.0)){${blocks.length - 1}}$`));
  expect.soft(Object.keys(rows), note).not.toContain("Model window");
  expect.soft(blocks.length, note).toBeGreaterThanOrEqual(3);
  expect.soft(readWhole(blocks, WINDOWED_TEXT), note).toBe(true);
});

// Whoever reads the report has no underline to look at.
test("copied report: a paragraph read in passes says so, with each pass's own number", async ({ page, pages, report }) => {
  pages.serve({ "/windows.html": PAGE("windows fixture", `<h1>One paragraph, several passes</h1>\n<p id="wp">${WINDOWED_TEXT}</p>`) });
  await page.goto(pages.url("/windows.html"), { waitUntil: "load" });
  const passes = "copied report: a paragraph read in passes says so, with each pass's own number";
  await expect(page.locator(`#wp ${BADGE_SEL} .num`), passes).toHaveText(SCORE);
  const line = (await report(page)).split("\n").find((l) => l.startsWith("1. ")) ?? "";
  expect(line, passes).toMatch(/; \d+ words; read in \d+ passes: (\.\d\d|1\.0)(, (\.\d\d|1\.0))+\)$/);
  expect(line, passes).not.toContain("not read");
});

// Two paragraphs the fake scores as AI-generated, far down a long page, each opening and
// closing on words of its own so a link can name it by them alone. The tags are found here
// rather than written down: the fake's verdict is a pure function of the text.
const LINK_PARA = (tag) => `${tag} opens this paragraph, written so that a copied report can point back to it: the link names its first words and its last, the browser finds them, scrolls the page until the paragraph is in view and marks it, and whoever opens the report later lands on the words it is about instead of the top of a long page, which is the whole point of giving a paragraph a link of its own, closing on ${tag}.`;
const LINK_TAGS = [];
for (let n = 1; LINK_TAGS.length < 2 && n < 1000; n++) if (fakeScore(LINK_PARA(`LINK-${n}`)).score >= 0.88) LINK_TAGS.push(`LINK-${n}`);

test("copied report: with the address and passage text included, each flagged paragraph links to the page scrolled to it; without either, no link", async ({ context, page, pages, storage, report }) => {
  pages.serve({
    "/links.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>links fixture</title></head><body style="max-width:720px;margin:0 auto;font:15px/1.6 system-ui">
<h1>Links to flagged paragraphs</h1>
${LINK_TAGS.map((t, i) => `<div style="height:1600px"></div>\n<p id="l${i + 1}">${LINK_PARA(t)}</p>`).join("\n")}
<div style="height:1600px"></div>
</body></html>`,
  });
  const links = "copied report: with the address and passage text included, each flagged paragraph links to the page scrolled to it; without either, no link";
  expect(LINK_TAGS, links).toHaveLength(2);
  const pageUrl = pages.url("/links.html");
  await page.goto(pageUrl, { waitUntil: "load" });
  for (const id of ["l1", "l2"]) await expect(page.locator(`#${id} ${BADGE_SEL} .num`), links).toHaveText(SCORE);
  const linksIn = (text) => [...text.matchAll(/^ {3}Open at this paragraph: (\S+)$/gm)].map((m) => m[1]);
  const copyWith = async (url, text) => {
    await storage.set({ reportIncludeUrl: url, reportIncludeText: text });
    return report(page);
  };
  const bare = await copyWith(false, false);
  expect.soft(bare, `${links} (neither)`).not.toContain(":~:");
  expect.soft(linksIn(bare), `${links} (neither)`).toEqual([]);
  const urlOnly = await copyWith(true, false);
  expect.soft(urlOnly, `${links} (the address alone)`).toContain(`Page: ${pageUrl}`);
  expect.soft(urlOnly, `${links} (the address alone)`).not.toContain(":~:");
  expect.soft(linksIn(urlOnly), `${links} (the address alone)`).toEqual([]);
  const full = await copyWith(true, true);
  expect.soft(full.split("\n").filter((l) => /^\d+\. \*\*/.test(l)), `${links} (both)`).toHaveLength(2);
  const found = linksIn(full);
  expect(found, `${links} (both)`).toHaveLength(2);
  expect(found.filter((l) => !l.startsWith(`${pageUrl}#:~:text=`)), `${links} (both)`).toEqual([]);
  // Each link, opened fresh, lands on its paragraph: the page is scrolled until it is on screen.
  const landed = [];
  for (const [i, link] of found.entries()) {
    const q = await context.newPage();
    await q.goto(link, { waitUntil: "load" });
    const at = () => q.evaluate((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { onScreen: r.top >= 0 && r.bottom <= innerHeight, y: Math.round(scrollY) };
    }, `l${i + 1}`);
    await expect.poll(async () => (await at()).onScreen, { message: `${links} (link ${i + 1} lands on its paragraph)` }).toBe(true);
    landed.push((await at()).y);
    await q.close();
  }
  expect(landed[0], `${links} (far down the page)`).toBeGreaterThan(1000);
  expect(landed[1], `${links} (the second further down)`).toBeGreaterThan(landed[0]);
});

// English written with Cyrillic and Greek look-alike letters, as RAID's homoglyph attack
// writes it: the engine reads it with its Latin letters back, and the card and the report
// say that it was disguised. Russian and Greek are no disguise: sent as written, refused.
const LOOK = { a: "а", e: "е", o: "о", i: "і", c: "с", p: "р", y: "у", x: "х", I: "Ι", T: "Τ", A: "Α", H: "Н", M: "М", B: "Β", N: "Ν", P: "Р", C: "С" };
const disguise = (s) => s.replace(/[aeoicpyxITAHMBNPC]/g, (ch) => LOOK[ch]);
const LOOK_PARA = (tag) => `${tag} This paragraph was written in plain English and then disguised letter by letter, the way a homoglyph attack does it: most of its vowels and several consonants were swapped for Cyrillic and Greek letters that look exactly the same on screen, so a reader notices nothing while a language detector sees Ukrainian and a detector of machine writing reads a text that nobody wrote. The extension has to give it its Latin letters back before the model reads it.`;
let LOOK_TAG = null;
for (let n = 1; !LOOK_TAG && n < 1000; n++) if (fakeScore(LOOK_PARA(`LOOK-${n}`)).score >= 0.88) LOOK_TAG = `LOOK-${n}`;
const RUSSIAN = "Вечером мы долго гуляли по старому городу. Узкие улицы были почти пустыми, только иногда мимо проезжал трамвай, и его звонок отражался от каменных стен. Мы зашли в маленькое кафе на углу площади, где пахло корицей и свежим хлебом. Хозяйка рассказала нам, что кафе открыл её дед сразу после войны, и с тех пор меню почти не изменилось. Мы заказали чай с вареньем и пирог с яблоками, а потом ещё долго сидели у окна и смотрели, как на площади зажигаются фонари. Домой вернулись поздно, уставшие, но очень довольные этим тихим вечером.";
const GREEK = "Το πρωί ξυπνήσαμε νωρίς για να προλάβουμε το πρώτο πλοίο για το νησί. Ο καιρός ήταν καθαρός και η θάλασσα ήρεμη, οπότε το ταξίδι κράτησε λιγότερο από δύο ώρες. Στο λιμάνι μας περίμενε ένας φίλος με το αυτοκίνητό του και μας πήγε στο χωριό του, ψηλά στο βουνό. Εκεί φάγαμε σε μια μικρή ταβέρνα με θέα τον κόλπο, ενώ ο ιδιοκτήτης μας έλεγε ιστορίες για τους ψαράδες που ζούσαν παλιά στο νησί. Το απόγευμα κατεβήκαμε στην παραλία και κολυμπήσαμε μέχρι να δύσει ο ήλιος πίσω από τα βράχια.";

test("look-alike letters: a disguised English paragraph is read with its Latin letters back and its card and the report say so; Russian and Greek are refused as written", async ({ page, pages, nativeHost, report }) => {
  const look = "look-alike letters: a disguised English paragraph is read with its Latin letters back and its card and the report say so; Russian and Greek are refused as written";
  expect(LOOK_TAG, look).not.toBeNull();
  const english = LOOK_PARA(LOOK_TAG);
  pages.serve({
    "/lookalikes.html": PAGE("look-alike letters fixture", `<h1>Look-alike letters</h1>
<p id="dis">${disguise(english)}</p>
<p id="ru" lang="ru">${RUSSIAN}</p>
<p id="el" lang="el">${GREEK}</p>`),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/lookalikes.html"), { waitUntil: "load" });
  await expect(page.locator(`#dis ${BADGE_SEL} .num`), look).toHaveText(SCORE);
  // What the engine was sent: the paragraph as it was written before the disguise.
  const sent = nativeHost.textsSince(mark);
  expect(sent, look).toContain(english);
  expect(sent.some((t) => /[а-яё]/i.test(t) && /[a-z]{3}/.test(t)), `${look} (no mixed text sent)`).toBe(false);
  const foot = (id) => page.evaluate((args) => document.querySelector(`#${args.id} ${args.sel}`)?.shadowRoot?.querySelector(".card .foot")?.textContent ?? null, { id, sel: BADGE_SEL });
  expect(await foot("dis"), look).toContain("Look-alike letters were replaced before scoring.");
  // The other two never reach the model, whichever gate refuses them (the browser's or the host's).
  for (const id of ["ru", "el"]) {
    await expect(page.locator(`#${id} ${BADGE_SEL} .pill.band-unsupported`), `${look} (${id})`).toHaveCount(1);
    expect(await foot(id), `${look} (${id})`).not.toContain("Look-alike");
  }
  expect(sent.filter((t) => t.includes("Вечером") || t.includes("πρωί")).every((t) => t === RUSSIAN || t === GREEK), `${look} (sent as written)`).toBe(true);
  const text = await report(page);
  expect(text, look).toMatch(/^1\. \*\*AI-generated, [^\n]*\n {3}Look-alike letters were replaced before scoring\.$/m);
});

// "Flagged: 0" on a page where nothing reached the floor is not a clean page, it is a page
// that was not judged.
test("copied report: a page with nothing long enough to judge says there was too little text, not that nothing was flagged", async ({ page, pages, report }) => {
  pages.serve({
    "/short.html": PAGE("short fixture", `<h1>A page of short notes</h1>
<p>The meeting moved to Thursday afternoon, after the budget review ran long again.</p>
<h2>Parking</h2>
<p>The north lot is closed for repaving until the end of the month, so please use the garage.</p>`),
  });
  await page.goto(pages.url("/short.html"), { waitUntil: "load" });
  const short = "copied report: a page with nothing long enough to judge says there was too little text, not that nothing was flagged";
  await expect(page.locator("#anagram-fab .count"), short).toBeAttached();
  // The ball is up before the first walk has run: copy until the report has the walk in it.
  let text = "";
  await expect(async () => {
    text = await report(page);
    expect(text).toMatch(/Analyzed: 0 units, Flagged: 0, Too short: [1-9]/);
  }, short).toPass({ timeout: 30_000 });
  // The floor is the reader's minimum length, 50 words unless Settings says otherwise.
  expect.soft(text, short).toContain("Too little text to judge: no passage reached the 50 words the model needs for a verdict.");
  expect.soft(text, short).not.toContain("No paragraphs were flagged");
  expect.soft(text, short).not.toContain("did not answer");
  expect.soft(text, short).toContain("high-stakes decisions");
});

test("copied report: a flagged verdict just over the cut is marked a close call, and a page of such verdicts is called mixed or uncertain", async ({ page, pages, report }) => {
  // A paragraph the fake scores AI-generated by a hair, within .05 of the cut at 5/6.
  let tag = null;
  for (let n = 1; !tag && n < 2000; n++) {
    const score = fakeScore(LINK_PARA(`CLOSE-${n}`)).score;
    if (score > 5 / 6 + 0.005 && score < 5 / 6 + 0.045) tag = `CLOSE-${n}`;
  }
  const close = "copied report: a flagged verdict just over the cut is marked a close call, and a page of such verdicts is called mixed or uncertain";
  expect(tag, close).not.toBeNull();
  pages.serve({ "/closecall.html": PAGE("close call fixture", `<h1>One close call</h1>\n<p id="cc">${LINK_PARA(tag)}</p>`) });
  await page.goto(pages.url("/closecall.html"), { waitUntil: "load" });
  await expect(page.locator(`#cc ${BADGE_SEL} .num`), close).toHaveText(SCORE);
  const text = await report(page);
  expect.soft(text, close).toContain("Mixed or uncertain: 1 of 1 verdicts is a close call");
  expect.soft(text, close).toMatch(/^1\. \*\*AI-generated, \.8\d\*\* \(close call; Human /m);
});

// A paragraph short in characters and long in tokens (figures, URLs, names) is not left
// half-read. DENSEPACK's figures are a token a digit, so its count says it is too long for one
// pass and it is planned into more; SOLIDPACK's count says it fits and the reading still comes
// back cut (the fixture's rule, 600 tokens), and every sentence carries the marker, so both
// halves of the re-read are cut too.
test("dense text: counted tokens plan a dense paragraph into passes; one the engine still cuts is re-read in two halves, and says so", async ({ page, pages, nativeHost }) => {
  const DENSE = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the DENSEPACK ledger lists 4471, 88310, 12480 and 30917 for that week, with the initials of whoever checked them.`).join(" ");
  const SOLID = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of the SOLIDPACK ledger lists the figures for that week, the running totals and the initials of whoever checked them.`).join(" ");
  nativeHost.setState({ rules: [{ contains: "SOLIDPACK", tokens: 600 }] });
  pages.serve({
    "/dense.html": PAGE("dense fixture", `<h1>Few enough characters for one pass, more tokens than the model takes</h1>
<p id="dense">${DENSE}</p>
<p id="solid">${SOLID}</p>`),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/dense.html"), { waitUntil: "load" });
  const cardOf = (id) =>
    page.evaluate(({ sel, id }) => {
      const root = document.querySelector(`#${id} ${sel}`)?.shadowRoot;
      if (!root?.querySelector(".card .head")) return null;
      return {
        rows: Object.fromEntries([...root.querySelectorAll(".card .row")].map((r) => [r.querySelector(".k").textContent, r.querySelector(".v").textContent])),
        foot: root.querySelector(".card .foot").textContent,
      };
    }, { sel: BADGE_SEL, id });
  const dense = "dense text: counted tokens plan a dense paragraph into passes; one the engine still cuts is re-read in two halves, and says so";
  await expect.poll(async () => !!(await cardOf("dense")) && !!(await cardOf("solid")), { message: dense }).toBe(true);
  const cards = { dense: await cardOf("dense"), solid: await cardOf("solid") };
  const inOrder = (texts, whole) => texts.sort((a, b) => whole.indexOf(a) - whole.indexOf(b));
  const texts = nativeHost.textsSince(mark);
  const sent = inOrder([...new Set(texts.filter((t) => t.includes("DENSEPACK")))], DENSE);
  const halves = inOrder([...new Set(texts.filter((t) => t.includes("SOLIDPACK") && t !== SOLID))], SOLID);
  const note = `${dense}: ${JSON.stringify({ dense: cards.dense.rows, solid: cards.solid.rows, sent: sent.map((t) => t.length), halves: halves.map((t) => t.length) })}`;
  expect.soft(Object.keys(cards.dense.rows), note).toContain(`Read in ${sent.length} passes`);
  expect.soft(Object.keys(cards.dense.rows), note).not.toContain("Passes cut short");
  expect.soft(cards.dense.foot, note).not.toMatch(/not read/);
  expect.soft(sent, note).not.toContain(DENSE);
  expect.soft(readWhole(sent, DENSE), note).toBe(true);
  expect.soft(sent.every((t) => fakeTokens(t) <= 510), note).toBe(true);
  expect.soft(texts, note).toContain(SOLID);
  expect.soft(halves.join(" "), note).toBe(SOLID);
  expect.soft(halves, note).toHaveLength(2);
  expect.soft(cards.solid.rows["Passes cut short"], note).toBe("2 of 2");
  expect.soft(cards.solid.foot, note).toMatch(/too dense for one pass of the model and was not read/);
});

// ---- the triage panel and the keyboard commands -------------------------------------------
// The chips are aria-hidden and unfocusable by design, so the panel is the accessible route to
// the verdicts: reachable, focusable and closable without a pointer, with three commands that
// work. Chrome swallows the real key combinations before the page sees them, so the commands
// arrive exactly as background.ts sends them: a message from the worker to the tab.
//
// Four flagged paragraphs spread far enough apart that "the next one" is a real scroll. The
// 900 px lead-in puts every paragraph BELOW the viewport's middle at scroll 0, which is what
// makes "previous" wrap to the last one.
const keyboard = test.extend({
  keys: async ({ page, pages }, use) => {
    pages.serve({
      "/keyboard.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>keyboard fixture</title></head><body style="max-width:720px;margin:0 auto;font:15px/1.6 system-ui">
<div style="height:900px"></div>
${KEY_TAGS.map((t, i) => `<p id="k${i + 1}">${KEY_PARA(t)}</p>\n<div style="height:700px"></div>`).join("\n")}
</body></html>`,
    });
    await page.bringToFront();
    await page.goto(pages.url("/keyboard.html"), { waitUntil: "load" });
    await chipsSettle(page, 4);
    await use(page);
  },
});

const panelState = (page) =>
  page.evaluate(() => {
    const host = document.getElementById("anagram-fab");
    const sr = host.shadowRoot;
    const panel = sr.querySelector(".panel");
    const count = sr.querySelector(".count");
    const named = panel.getAttribute("aria-labelledby");
    return {
      open: panel.classList.contains("open"),
      role: panel.getAttribute("role"),
      name: named ? sr.getElementById(named)?.textContent ?? null : null,
      inPanel: !!sr.activeElement && panel.contains(sr.activeElement),
      onCounter: document.activeElement === host && sr.activeElement === count,
      expanded: count.getAttribute("aria-expanded"),
      label: count.getAttribute("aria-label"),
      itemLabel: panel.querySelector(".pitem")?.getAttribute("aria-label") ?? null,
      untucked: !sr.querySelector(".stack.tucked"),
    };
  });

keyboard("the triage panel by keyboard: a focusable counter button, Enter opens it and takes focus, Escape gives it back; the names carry the counts and verdicts", async ({ keys: page }) => {
  const walk = "triage panel: focusable counter button, Enter opens and takes focus, Escape returns it";
  const counter = page.locator("#anagram-fab .count");
  expect(await counter.evaluate((el) => el.tagName), walk).toBe("BUTTON");
  await counter.focus();
  await expect.poll(() => panelState(page), { message: `${walk} (focused)` }).toMatchObject({ onCounter: true, untucked: true });
  const onCounter = await panelState(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => panelState(page), { message: `${walk} (Enter)` }).toMatchObject({ open: true, role: "dialog", inPanel: true, expanded: "true" });
  const opened = await panelState(page);
  expect(opened.name, `${walk} (the dialog is named)`).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect.poll(() => panelState(page), { message: `${walk} (Escape)` }).toMatchObject({ open: false, onCounter: true, expanded: "false" });

  const names = "accessible names carry the flagged count and each row's verdict";
  expect.soft(onCounter.label, names).toMatch(/\b4 flagged paragraphs\b/);
  expect.soft(opened.itemLabel, names).toMatch(/^(Heavily edited|AI-generated), (0\.\d\d|1\.0): \S/);
});

keyboard("open-panel command opens the triage panel and puts the keyboard in it", async ({ keys: page, tell }) => {
  await tell(page, { action: "openPanel" });
  await expect.poll(() => panelState(page), { message: "open-panel command opens the triage panel and puts the keyboard in it" }).toMatchObject({ open: true, inPanel: true });
});

/** Each flagged chip's position in the document is its identity; a jump flashes the chip it
 *  landed on, which is how the walk is read back. */
const flaggedAt = (page) =>
  page.evaluate((sel) =>
    [...document.querySelectorAll(sel)]
      .filter((h) => /band-(heavy|ai)\b/.test(h.shadowRoot?.querySelector(".pill")?.className ?? ""))
      .map((h) => Math.round(h.getBoundingClientRect().top + scrollY))
      .sort((a, b) => a - b), BADGE_SEL);
const flashedAt = (page) =>
  page.evaluate((sel) => {
    for (const h of document.querySelectorAll(sel)) if (h.shadowRoot?.querySelector(".pill.pg-flash")) return Math.round(h.getBoundingClientRect().top + scrollY);
    return null;
  }, BADGE_SEL);
async function jump(page, tell, action) {
  await expect.poll(() => flashedAt(page), { message: "the previous pulse is over" }).toBeNull();
  await tell(page, { action });
  await expect.poll(() => flashedAt(page), { message: `${action} lands on a chip` }).not.toBeNull();
  return flashedAt(page);
}

keyboard("next/prev-flagged walk the flagged paragraphs in document order and wrap around", async ({ keys: page, tell }) => {
  const at = await flaggedAt(page);
  const walk = "next/prev-flagged walk the flagged paragraphs in document order and wrap around";
  expect(at, walk).toHaveLength(4);
  await page.evaluate(() => scrollTo(0, 0));
  expect(await jump(page, tell, "prevFlagged"), `${walk} (previous from the top wraps to the last)`).toBe(at[3]);
  expect(await jump(page, tell, "nextFlagged"), `${walk} (next wraps to the first)`).toBe(at[0]);
  expect(await jump(page, tell, "nextFlagged"), `${walk} (next)`).toBe(at[1]);
  expect(await jump(page, tell, "prevFlagged"), `${walk} (previous)`).toBe(at[0]);
});

// A flagged paragraph found AFTER the others (a post a feed prepends, a reply inserted above)
// is listed, reported and walked where it stands, not after everything found before it.
keyboard("a flagged paragraph inserted above the others comes first in the panel, the copied report and the next-flagged walk", async ({ keys: page, tell, report }) => {
  const LATE_TAG = "LATE-1"; // AI-generated (.90) under the fake's scores
  await page.evaluate((html) => document.getElementById("k1").insertAdjacentHTML("beforebegin", html), `<p id="k0">${KEY_PARA(LATE_TAG)}</p>\n<div style="height:700px"></div>`);
  const first = "a flagged paragraph inserted above the others comes first in the panel, the copied report and the next-flagged walk";
  await expect(page.locator(`#k0 ${BADGE_SEL} .num`), first).toHaveText(SCORE);
  const pageScores = await page.evaluate((sel) => ["k0", "k1", "k2", "k3", "k4"].map((id) => document.querySelector(`#${id} ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent?.trim() ?? null), BADGE_SEL);
  await toggleCounter(page);
  await expect(page.locator("#anagram-fab .panel .pitem"), first).toHaveCount(5);
  const listed = await page.evaluate(() =>
    [...document.getElementById("anagram-fab").shadowRoot.querySelectorAll(".panel .pitem")].map((r) => /: (\S+) paragraph/.exec(r.getAttribute("aria-label") ?? "")?.[1] ?? null));
  expect.soft(listed, `${first} (the panel)`).toEqual([LATE_TAG, ...KEY_TAGS]);
  const reported = (await report(page)).split("\n").map((l) => /^\d+\. \*\*[^*]+, (\.\d\d|1\.0)\*\*/.exec(l)?.[1]).filter(Boolean);
  expect.soft(reported, `${first} (the report)`).toEqual(pageScores);
  await page.keyboard.press("Escape");
  const lateAt = await page.evaluate((sel) => Math.round(document.querySelector(`#k0 ${sel}`).getBoundingClientRect().top + scrollY), BADGE_SEL);
  await page.evaluate(() => scrollTo(0, 0));
  expect.soft(await jump(page, tell, "nextFlagged"), `${first} (the walk)`).toBe(lateAt);
});
