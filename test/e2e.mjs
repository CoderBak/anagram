// test/e2e.mjs — Playwright end-to-end test for the Anagram MV3 extension (v2).
//
// Loads the built unpacked extension into a persistent Chromium context pointed at the
// test-only fake fixture (deterministic verdicts, no model needed), serves the
// self-test page over http (so the registered content script injects), scrolls the
// whole page (scoring is viewport-first BY DESIGN), then asserts the v2 behaviours:
// long paragraphs badge once and underline to the end (the HF regression), a paragraph
// longer than the model reads in one pass is scored completely — in overlapping passes
// planned on the engine's token counts, one chip, each stretch marked in the colour of the
// passes that read it —
// BR-split/short-sibling/pre-wrap content merges into single units, a post written one
// short sentence per line is one unit while two voices never share one, a post of mixed
// paragraphs (X markup) sits under ONE chip reading ×N and is one chip again after it is
// opened in place, inline code
// does not fragment prose, pure-CJK text is settled by the local language gate
// instead of being scored (the fixture never sees it), hidden tabs and <details>
// get badges when revealed, pushState swaps re-badge and purge, removals purge,
// never-score zones stay clean, and the page DOM carries no marker attributes.
//
//   node test/e2e.mjs            # headless — no window (see test/harness.mjs)
//   HEADED=1 node test/e2e.mjs   # watch it run
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { launchExtension, serveHtml, artifact, BADGE_SEL } from "./harness.mjs";
import { createNativeFixture, fakeScore } from "./fake-native.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 1) the fake fixture + a tiny static server for the self-contained self-test page.
const fixture = await createNativeFixture();
const server = await serveHtml({ "/selftest.html": readFileSync(join(__dirname, "selftest.html"), "utf8") });
const url = server.url("/selftest.html");
console.log("serving self-test at", url, "· fake fixture at", fixture.label);

// 2) launch a persistent context with the unpacked extension pointed at the fake.
const { context, sw } = await launchExtension({ nativeFixture: fixture, viewport: { width: 1280, height: 720 } });
console.log("extension service worker:", sw ? sw.url() : "NOT FOUND");

// 4) open the page; capture content-script console errors.
const consoleErrors = [];
const page = await context.newPage();
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push("console.error: " + m.text());
});
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1200);

// 5) scoring is viewport-first: scroll through the page so everything dispatches.
async function sweepScroll() {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 320));
    }
    window.scrollTo(0, 0);
  });
}
await sweepScroll();

// 6) wait until the badge count stabilizes.
async function badgeCount() {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL);
}
{
  let last = -1;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const n = await badgeCount();
    if (n > 0 && n === last) break;
    last = n;
    await page.waitForTimeout(1200);
  }
}

const visibleBadges = () =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].filter((h) => getComputedStyle(h).display !== "none")
        .length,
    BADGE_SEL,
  );

// 7) core snapshot.
const snapshot = await page.evaluate((sel) => {
  const inSection = (id) => document.querySelectorAll(`#${id} ${sel}`).length;
  const highlightTexts = (() => {
    if (typeof CSS === "undefined" || !CSS.highlights) return [];
    const out = [];
    for (const h of CSS.highlights.values()) for (const r of h) out.push(r.toString());
    return out;
  })();
  const hlHas = (marker) => highlightTexts.some((t) => t.includes(marker));
  const strayMarks = [...document.querySelectorAll("[data-anagram]")].filter(
    (el) => !["host", "style"].includes(el.getAttribute("data-anagram")),
  ).length;
  return {
    badgeTotal: document.querySelectorAll(sel).length,
    fabPresent: !!document.getElementById("anagram-fab"),
    highlightCount: highlightTexts.length,
    sections: {
      human: inSection("human"),
      aiwrap: inSection("aiwrap"),
      short: inSection("short"),
      quote: inSection("quote"),
      divbased: inSection("divbased"),
      longpara: inSection("longpara"),
      windowed: inSection("windowed"),
      brsplit: inSection("brsplit"),
      mergeshorts: inSection("mergeshorts"),
      postlines: inSection("postlines"),
      postwhole: inSection("postwhole"),
      twovoices: inSection("twovoices"),
      inlinecode: inSection("inlinecode"),
      purecjk: inSection("purecjk"),
      tabs: inSection("tabs"),
      detailswrap: inSection("detailswrap"),
      spa: inSection("spa"),
      never: inSection("never"),
    },
    prewrapBadges: document.querySelectorAll(`#prewrap ${sel}`).length,
    postwholeChip: document.querySelector(`#postwhole ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent ?? "",
    // The Chinese paragraph never reaches a backend at all: the content script's local
    // language gate settles it and renders an "unsupported language" chip with no number
    // and no mark. The fake fixture is asserted below to have seen no non-English block.
    cjkUnsupported: !!document.querySelector(`#purecjk ${sel}`)?.shadowRoot?.querySelector(".pill.band-unsupported"),
    // The paragraph read in passes: its own text (what the fixture's blocks must cover),
    // the chip and card it got, and the band of every range laid over it.
    windowed: (() => {
      const p = document.querySelector("#windowed p");
      const root = document.querySelector(`#windowed ${sel}`)?.shadowRoot;
      const bands = new Set();
      for (const [name, h] of CSS.highlights ?? []) for (const r of h) if (p.contains(r.startContainer)) bands.add(name.replace("anagram-", ""));
      return {
        text: p.textContent.replace(/\s+/g, " ").trim(),
        chip: root?.querySelector(".num")?.textContent ?? "",
        card: root?.querySelector(".card")?.textContent ?? "",
        bands: [...bands].sort(),
      };
    })(),
    hl: {
      longtail: hlHas("final LONGTAIL sentence"),
      windowtail: hlHas("final WINDOWTAIL sentence"),
      br1: hlHas("BRPART-ONE"),
      br2: hlHas("BRPART-TWO"),
      ms1: hlHas("MS-ONE"),
      ms2: hlHas("MS-TWO"),
      ms3: hlHas("MS-THREE"),
      post1: hlHas("POSTLINE-ONE"),
      postN: hlHas("POSTLINE-LAST"),
      posterName: hlHas("Poster Name"),
      postwhole: ["POSTW-ONE", "POSTW-TWO", "POSTW-THREE", "POSTW-FOUR"].every(hlHas),
      postwholeChrome: hlHas("Another Poster") || hlHas("Show more"),
      voices: ["VOICE-ONE", "VOICE-TWO", "VOICE-THREE", "VOICE-FOUR"].some(hlHas),
      icode: hlHas("ICODE tail marker"),
      cjk: hlHas("纯中文标记"),
      pw1: hlHas("PREWRAP-ONE"),
      pw2: hlHas("PREWRAP-TWO"),
    },
    strayMarks,
  };
}, BADGE_SEL);
const snapshotCardOf = {
  longpara: await page.evaluate((sel) => document.querySelector(`#longpara ${sel}`)?.shadowRoot?.querySelector(".card")?.textContent ?? "", BADGE_SEL),
};
console.log("\nSNAPSHOT:");
console.log(JSON.stringify(snapshot, null, 2));

// 7b) a post opened in place: the text is re-rendered with two more paragraphs. The old
// unit's nodes are gone; the re-scan starts inside the post and must come back with ONE unit.
await page.locator("#postmore").scrollIntoViewIfNeeded();
await page.locator("#postmore").click();
const postReopened = await page
  .waitForFunction(
    (sel) => {
      const hosts = document.querySelectorAll(`#postwhole ${sel}`);
      return hosts.length === 1 && /×6$/.test(hosts[0].shadowRoot?.querySelector(".num")?.textContent ?? "");
    },
    BADGE_SEL,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);
const postReopenedMarks = await page.evaluate(() => {
  const texts = [];
  for (const h of CSS.highlights.values()) for (const r of h) texts.push(r.toString());
  return ["POSTW-ONE", "POSTW-TWO", "POSTW-THREE", "POSTW-FOUR", "POSTW-FIVE", "POSTW-SIX"].every((m) => texts.some((t) => t.includes(m)));
});

// 8) hidden-tab reveal (class flip → attribute observer).
await page.locator("#tabbtn").scrollIntoViewIfNeeded();
await page.locator("#tabbtn").click();
const tabBadged = await page
  .waitForFunction(
    (sel) => document.querySelectorAll(`#tabpanel ${sel}`).length >= 1,
    BADGE_SEL,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);

// 9) <details> open (open attribute → observer).
await page.locator("#details summary").scrollIntoViewIfNeeded();
await page.locator("#details summary").click();
const detailsBadged = await page
  .waitForFunction(
    (sel) => document.querySelectorAll(`#detailswrap ${sel}`).length >= 1,
    BADGE_SEL,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);

// 10) SPA pushState swap: new route content badged, stale unit purged.
await page.locator("#spaNav").scrollIntoViewIfNeeded();
await page.locator("#spaNav").click();
const spaBadged = await page
  .waitForFunction(
    (sel) => {
      const spa = document.getElementById("spa");
      return (
        spa &&
        spa.textContent.includes("SPA-SECOND") &&
        spa.querySelectorAll(sel).length === 1
      );
    },
    BADGE_SEL,
    { timeout: 8000 },
  )
  .then(() => true)
  .catch(() => false);

// 11) removal purge: removing a badged paragraph takes its badge with it.
await page.locator("#removeAi").scrollIntoViewIfNeeded();
const beforeRemove = await badgeCount();
await page.locator("#removeAi").click();
await page.waitForTimeout(900);
const afterRemove = await badgeCount();

// 12) RAPID dynamic insertion — N synchronous clicks with identical text (the
// fast-click race). Every added paragraph must get its own badge.
const beforeAdd = await badgeCount();
const RAPID = 5;
await page.evaluate((n) => {
  const b = document.getElementById("add");
  for (let i = 0; i < n; i++) b?.click();
}, RAPID);
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page
  .waitForFunction(
    ({ target, sel }) => document.querySelectorAll(sel).length >= target,
    { target: beforeAdd + RAPID, sel: BADGE_SEL },
    { timeout: 12000 },
  )
  .catch(() => {});
const afterAdd = await badgeCount();
console.log(`rapid add: badges ${beforeAdd} -> ${afterAdd} (clicked ${RAPID})`);

// 13) toggle test: FAB click → hidden → click → shown.
const clickFab = () =>
  page.evaluate(() =>
    document.getElementById("anagram-fab")?.shadowRoot?.querySelector("button.fab")?.click(),
  );
const shownN = await visibleBadges();
await clickFab();
await page.waitForTimeout(300);
const hiddenN = await visibleBadges();
await clickFab();
await page.waitForTimeout(300);
const reshownN = await visibleBadges();
console.log(`toggle: visible ${shownN} -> hidden ${hiddenN} -> visible ${reshownN}`);

// 14) screenshot (overlay shown).
const shot = artifact("e2e-screenshot.png");
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: shot, fullPage: true });
console.log("screenshot:", shot);

// 15) checks + summary.
const s = snapshot;
// What the fixture was asked about the windowed paragraph: every block that is a piece of
// it, in reading order, and where each lies in it. The fake's verdict is a pure function of
// the text, so what the page must show is known here without asking the page. The opening
// is read by the first pass alone and the close by the last alone, so those two stretches
// carry exactly their pass's step of the scale (lib/render/scale.ts, twenty steps); every
// stretch between is a weighted mean, so its step lies between the passes' own.
const stepOf = (score) => `s${String(Math.round(Math.min(Math.max(score, 0), 1) * 20)).padStart(2, "0")}`;
const windowBlocks = [...new Set(fixture.stats.texts.filter((t) => t.length > 200 && s.windowed.text.includes(t)))]
  .sort((a, b) => s.windowed.text.indexOf(a) - s.windowed.text.indexOf(b));
const windowAt = windowBlocks.map((t) => [s.windowed.text.indexOf(t), s.windowed.text.indexOf(t) + t.length]);
const windowVerdicts = windowBlocks.map((t) => fakeScore(t));
const passSteps = windowVerdicts.map((v) => stepOf(v.score));
const drawnSteps = s.windowed.bands;
const windowCounted = fixture.requests().some((r) => r.op === "tokens" && r.payload.texts.some((t) => s.windowed.text.includes(t)));
// What lib/render/score.ts writes, in four lines, so the expectation is spelled out here
// rather than imported out of a TypeScript module this suite cannot load.
const formatScore = (score) => (Math.round(score * 100) >= 100 ? "1.0" : `.${String(Math.round(score * 100)).padStart(2, "0")}`);
const expectedScores = windowVerdicts.map((v) => formatScore(v.score));
console.log(`windowed paragraph: ${s.windowed.text.length} chars → ${windowBlocks.length} passes at ${JSON.stringify(windowAt)} → ${expectedScores.join(" · ")} (${passSteps.join(", ")}; drawn ${drawnSteps.join(", ")})`);
const checks = [
  ["extension loaded (service worker)", !!sw],
  ["badges rendered across the page", s.badgeTotal >= 11],
  ["floating toggle present", s.fabPresent],
  ["underlines present", s.highlightCount > 0],
  ["human/ai/quote/div-EN/div-ZH badged", s.sections.human === 1 && s.sections.aiwrap === 1 && s.sections.quote === 1 && s.sections.divbased === 2],
  ["LONG paragraph: exactly ONE badge (no 1000-char split)", s.sections.longpara === 1],
  ["LONG paragraph underline reaches the end (HF regression)", s.hl.longtail],
  ["LONG paragraph is still one pass: no pass row in its card", !/Scored|Read in/.test(snapshotCardOf.longpara)],
  ["WINDOWED paragraph: exactly ONE chip, showing one score and no per cent sign", s.sections.windowed === 1 && /^(\.\d\d|1\.0)$/.test(s.windowed.chip)],
  ["WINDOWED paragraph: counted by the engine, then read whole in passes over two neighbouring halves each, none past its token window",
    windowCounted && windowBlocks.length >= 3 && windowAt[0][0] === 0 && windowAt[windowAt.length - 1][1] === s.windowed.text.length &&
    windowAt.every(([from, to], i) => i === 0 || (from > windowAt[i - 1][0] && from < windowAt[i - 1][1] && to > windowAt[i - 1][1])) &&
    windowAt.every(([, to], i) => i + 2 >= windowAt.length || s.windowed.text.slice(to).trimStart() === s.windowed.text.slice(windowAt[i + 2][0])) &&
    windowVerdicts.every((v) => v.truncated === false)],
  ["WINDOWED paragraph: underline reaches the final sentence", s.hl.windowtail],
  ["WINDOWED paragraph: marked stretch by stretch — the opening in the first pass's colour, the close in the last's, the rest between",
    passSteps[0] !== passSteps.at(-1) && drawnSteps.includes(passSteps[0]) && drawnSteps.includes(passSteps.at(-1)) &&
    drawnSteps.every((b) => b >= [...passSteps].sort()[0] && b <= [...passSteps].sort().at(-1))],
  ["WINDOWED paragraph: the card reads 'Read in N passes' with each pass's number, and claims no prefix",
    s.windowed.card.includes(`Read in ${windowBlocks.length} passes${expectedScores.join("\u00a0· ")}`) && !/Only the opening|first \d+/.test(s.windowed.card)],
  ["BR-split halves merged into one unit", s.sections.brsplit === 1 && s.hl.br1 && s.hl.br2],
  ["three short siblings merged into one unit", s.sections.mergeshorts === 1 && s.hl.ms1 && s.hl.ms2 && s.hl.ms3],
  ["one-sentence-per-line post: one unit from the first line to the last, without the name row", s.sections.postlines === 1 && s.hl.post1 && s.hl.postN && !s.hl.posterName],
  ["two posts / an author and a quotation are never added up", s.sections.twovoices === 0 && !s.hl.voices],
  ["a post of mixed paragraphs: ONE chip reading ×4, marks on every paragraph, none on the name or 'Show more'",
    s.sections.postwhole === 1 && /^(\.\d\d|1\.0) ×4$/.test(s.postwholeChip) && s.hl.postwhole && !s.hl.postwholeChrome],
  ["…opened in place (text re-rendered, two more paragraphs): still ONE chip, now ×6, marks on all six", postReopened && postReopenedMarks],
  ["inline <code> does not fragment the paragraph", s.sections.inlinecode === 1 && s.hl.icode],
  ["pure-CJK paragraph badged as 'unsupported' (language gate)", s.sections.purecjk === 1 && s.cjkUnsupported],
  ["pre-wrap blank-line paragraphs split + merged", s.prewrapBadges === 1 && s.hl.pw1 && s.hl.pw2],
  ["short isolated paragraph skipped", s.sections.short === 0],
  ["never-score zone clean (code/nav-links/editor/aria-hidden)", s.sections.never === 0],
  ["page DOM carries no marker attributes", s.strayMarks === 0],
  ["hidden tab badged after class-flip reveal", tabBadged],
  ["<details> content badged after open", detailsBadged],
  ["the engine reads the page as written: a merged unit's paragraphs on lines of their own, em dashes untouched",
    fixture.stats.texts.some((t) => t.includes("happened to be written.\nMS-TWO") && t.includes("too brief to judge.\nMS-THREE")) &&
    fixture.stats.texts.some((t) => t.includes("this paragraph — long enough to clear every floor — must be"))],
  ["pushState swap: new route badged, stale purged", spaBadged],
  ["removing a paragraph removes its badge", afterRemove === beforeRemove - 1],
  ["rapid insert: every added paragraph badged", afterAdd === beforeAdd + RAPID],
  ["toggle hides + re-shows badges", hiddenN === 0 && reshownN === shownN && shownN > 0],
  ["no console errors", consoleErrors.length === 0],
  ["non-English text is gated locally (the fixture received none)", fixture.stats.blocks > 5 && fixture.stats.nonEnglishBlocks === 0],
];
console.log(`fake fixture saw ${fixture.stats.requests} requests / ${fixture.stats.blocks} blocks (${fixture.stats.nonEnglishBlocks} non-English)`);
console.log("\n=== CHECKS ===");
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (consoleErrors.length) {
  console.log("\nconsole errors:");
  for (const e of consoleErrors.slice(0, 20)) console.log("  -", e);
}
const pass = checks.every(([, ok]) => ok);
console.log("\n" + (pass ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED"));

await context.close();
await server.close();
await fixture.close();
process.exit(pass ? 0 : 1);
