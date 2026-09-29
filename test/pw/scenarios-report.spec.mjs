// What the reader asks for and takes away: the selection card (closed while the host is
// still thinking, a selection read whole in passes), look-alike letters, dense text planned on
// the engine's token counts, and the triage panel (its title, its coverage line, how it opens
// and closes) and the three keyboard commands.
//
//   npx playwright test scenarios-report
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, BADGE_SEL, SCORE, PAGE, KEY_PARA, KEY_TAGS, ABSENCE_MS, chipsSettle, toggleCounter } from "./kit.mjs";
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

// English written with Cyrillic and Greek look-alike letters, as RAID's homoglyph attack
// writes it: the engine reads it with its Latin letters back, and the card says that it was
// disguised. Russian and Greek are no disguise: sent as written, refused.
const LOOK = { a: "а", e: "е", o: "о", i: "і", c: "с", p: "р", y: "у", x: "х", I: "Ι", T: "Τ", A: "Α", H: "Н", M: "М", B: "Β", N: "Ν", P: "Р", C: "С" };
const disguise = (s) => s.replace(/[aeoicpyxITAHMBNPC]/g, (ch) => LOOK[ch]);
const LOOK_PARA = (tag) => `${tag} This paragraph was written in plain English and then disguised letter by letter, the way a homoglyph attack does it: most of its vowels and several consonants were swapped for Cyrillic and Greek letters that look exactly the same on screen, so a reader notices nothing while a language detector sees Ukrainian and a detector of machine writing reads a text that nobody wrote. The extension has to give it its Latin letters back before the model reads it.`;
let LOOK_TAG = null;
for (let n = 1; !LOOK_TAG && n < 1000; n++) if (fakeScore(LOOK_PARA(`LOOK-${n}`)).score >= 0.88) LOOK_TAG = `LOOK-${n}`;
const RUSSIAN = "Вечером мы долго гуляли по старому городу. Узкие улицы были почти пустыми, только иногда мимо проезжал трамвай, и его звонок отражался от каменных стен. Мы зашли в маленькое кафе на углу площади, где пахло корицей и свежим хлебом. Хозяйка рассказала нам, что кафе открыл её дед сразу после войны, и с тех пор меню почти не изменилось. Мы заказали чай с вареньем и пирог с яблоками, а потом ещё долго сидели у окна и смотрели, как на площади зажигаются фонари. Домой вернулись поздно, уставшие, но очень довольные этим тихим вечером.";
const GREEK = "Το πρωί ξυπνήσαμε νωρίς για να προλάβουμε το πρώτο πλοίο για το νησί. Ο καιρός ήταν καθαρός και η θάλασσα ήρεμη, οπότε το ταξίδι κράτησε λιγότερο από δύο ώρες. Στο λιμάνι μας περίμενε ένας φίλος με το αυτοκίνητό του και μας πήγε στο χωριό του, ψηλά στο βουνό. Εκεί φάγαμε σε μια μικρή ταβέρνα με θέα τον κόλπο, ενώ ο ιδιοκτήτης μας έλεγε ιστορίες για τους ψαράδες που ζούσαν παλιά στο νησί. Το απόγευμα κατεβήκαμε στην παραλία και κολυμπήσαμε μέχρι να δύσει ο ήλιος πίσω από τα βράχια.";

test("look-alike letters: a disguised English paragraph is read with its Latin letters back and its card says so; Russian and Greek are refused as written", async ({ page, pages, nativeHost }) => {
  const look = "look-alike letters: a disguised English paragraph is read with its Latin letters back and its card says so; Russian and Greek are refused as written";
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
// is listed and walked where it stands, not after everything found before it.
keyboard("a flagged paragraph inserted above the others comes first in the panel and the next-flagged walk", async ({ keys: page, tell }) => {
  const LATE_TAG = "LATE-1"; // AI-generated (.90) under the fake's scores
  await page.evaluate((html) => document.getElementById("k1").insertAdjacentHTML("beforebegin", html), `<p id="k0">${KEY_PARA(LATE_TAG)}</p>\n<div style="height:700px"></div>`);
  const first = "a flagged paragraph inserted above the others comes first in the panel and the next-flagged walk";
  await expect(page.locator(`#k0 ${BADGE_SEL} .num`), first).toHaveText(SCORE);
  await toggleCounter(page);
  await expect(page.locator("#anagram-fab .panel .pitem"), first).toHaveCount(5);
  const listed = await page.evaluate(() =>
    [...document.getElementById("anagram-fab").shadowRoot.querySelectorAll(".panel .pitem")].map((r) => /: (\S+) paragraph/.exec(r.getAttribute("aria-label") ?? "")?.[1] ?? null));
  expect.soft(listed, `${first} (the panel)`).toEqual([LATE_TAG, ...KEY_TAGS]);
  await page.keyboard.press("Escape");
  const lateAt = await page.evaluate((sel) => Math.round(document.querySelector(`#k0 ${sel}`).getBoundingClientRect().top + scrollY), BADGE_SEL);
  await page.evaluate(() => scrollTo(0, 0));
  expect.soft(await jump(page, tell, "nextFlagged"), `${first} (the walk)`).toBe(lateAt);
});

// ---- the panel's title, coverage line, buttons and lifetime -------------------------------
const panelText = (page) =>
  page.evaluate(() => {
    const panel = document.getElementById("anagram-fab").shadowRoot.querySelector(".panel");
    return {
      open: panel.classList.contains("open"),
      title: panel.querySelector(".phead h2")?.textContent ?? "",
      coverage: panel.querySelector(".pcov:not(.pscope)")?.textContent ?? null,
      buttons: [...panel.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent.trim()),
      text: panel.textContent,
    };
  });

keyboard("the panel's title says flagged out of read, and it has a Close button and no Copy report or Turn off button", async ({ keys: page }) => {
  const title = "the panel's title says flagged out of read, and it has a Close button and no Copy report or Turn off button";
  await toggleCounter(page);
  await expect.poll(async () => (await panelText(page)).open, { message: title }).toBe(true);
  const shown = await panelText(page);
  // Four flagged, every paragraph of the page read: "(4/4)". Nothing on the page is short.
  expect.soft(shown.title, title).toBe("Flagged paragraphs (4/4)");
  expect.soft(shown.coverage, `${title} (nothing short: no coverage line)`).toBeNull();
  expect.soft(shown.buttons.filter((b) => !/^(Heavily edited|AI-generated),/.test(b)), title).toEqual(["Close"]);
  expect.soft(shown.text, title).not.toMatch(/Copy report|Turn off on/);
});

test("the panel's coverage line: what was too short to score, and what was scored under 75 words is less reliable", async ({ page, pages }) => {
  const words = (n, tag) => `${tag} ` + Array.from({ length: n - 1 }, (_, i) => ["river", "stone", "lantern", "window", "orchard", "letter", "harbor", "ladder"][i % 8]).join(" ") + ".";
  pages.serve({
    "/coverage.html": PAGE("coverage fixture", `<h1>Three lengths</h1>
<p id="tiny">${words(12, "Tiny")}</p>
<h2>Under the floor</h2>
<p id="mid">${words(60, "Middle")}</p>
<h2>Over the model's minimum</h2>
<p id="full">${words(90, "Full")}</p>`),
  });
  await page.goto(pages.url("/coverage.html"), { waitUntil: "load" });
  const cov = "the panel's coverage line: what was too short to score, and what was scored under 75 words is less reliable";
  await expect(page.locator(`#full ${BADGE_SEL} .num`), cov).toHaveText(SCORE);
  await expect(page.locator(`#mid ${BADGE_SEL} .num`), cov).toHaveText(SCORE);
  await toggleCounter(page);
  // Read: the 60-word and the 90-word paragraph. The 12-word one was not scored at all.
  await expect.poll(async () => (await panelText(page)).title, { message: cov }).toMatch(/^Flagged paragraphs \(\d\/2\)$/);
  const shown = await panelText(page);
  expect.soft(shown.coverage, cov).toBe("1 too short to score, 1 less reliable (under 75 words)");
  expect.soft(shown.coverage, cov).not.toMatch(/\bread\b/);
});

keyboard("a click or a scroll on the page leaves the panel open; the counter, Escape and the Close button close it", async ({ keys: page }) => {
  const life = "a click or a scroll on the page leaves the panel open; the counter, Escape and the Close button close it";
  const open = async () => {
    await toggleCounter(page);
    await expect.poll(async () => (await panelText(page)).open, { message: `${life} (opens)` }).toBe(true);
  };
  const isOpen = async () => (await panelText(page)).open;
  await open();
  // The page still gets its clicks: a listener on the document sees this one.
  await page.evaluate(() => { window.__pageClicks = 0; document.addEventListener("click", () => window.__pageClicks++); });
  await page.mouse.click(20, 300);
  await expect.poll(() => page.evaluate(() => window.__pageClicks), { message: `${life} (the page got the click)` }).toBe(1);
  // ...and it scrolls under the open panel.
  const before = await page.evaluate(() => scrollY);
  await page.mouse.move(200, 300);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => scrollY), { message: `${life} (the page scrolled)` }).toBeGreaterThan(before);
  await page.waitForTimeout(ABSENCE_MS);
  expect(await isOpen(), `${life} (still open after a click and a scroll)`).toBe(true);
  // A row jumps to its paragraph and the panel stays for the next one.
  await page.locator("#anagram-fab .panel .pitem").first().click();
  expect(await isOpen(), `${life} (still open after a jump)`).toBe(true);
  // The counter toggles it.
  await toggleCounter(page);
  await expect.poll(isOpen, { message: `${life} (the counter closes it)` }).toBe(false);
  // Escape closes it, wherever the focus is: here, on the page.
  await open();
  await page.keyboard.press("Escape");
  await expect.poll(isOpen, { message: `${life} (Escape closes it)` }).toBe(false);
  // The Close button closes it and hands the keyboard back to the counter.
  await open();
  await page.locator("#anagram-fab .panel .pclose").click();
  await expect.poll(isOpen, { message: `${life} (Close closes it)` }).toBe(false);
  await expect.poll(() => panelState(page), { message: `${life} (focus back on the counter)` }).toMatchObject({ open: false, expanded: "false" });
});
