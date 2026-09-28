// What Anagram draws into a page, on test/ui-fixtures.html: the hover card at the edges of
// the screen and out of an overflow:hidden box, the chip in RTL, small, large, tight and
// vertical text, shadow DOM and slots, copying, a trailing link, dark sections, duplicates,
// KaTeX, the top layer (a modal dialog, a site overlay), the ball and its panel; the
// main-content scope's Defuddle chunk; the copied report's legend; and the host going away
// and coming back. Every test fails on an error the extension writes to the page's console.
//
//   npx playwright test scenarios-ui
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, BADGE_SEL, ABSENCE_MS, settledChips, chipCounts, toggleCounter } from "./kit.mjs";

const UI_FIXTURES = readFileSync(join(import.meta.dirname, "..", "ui-fixtures.html"), "utf8");
/** The units the page holds before anything is clicked, by the element they sit in (the
 *  shadow host holds two: its own root's paragraph and the slotted one). */
const UNITS = { topedge: 1, rightcol: 1, rtl: 1, tiny: 1, large: 1, tight: 1, shadowhost: 2, clipbox: 1, copysrc: 1, linkend: 1, darksection: 1, lightafter: 1, oklchdark: 1, dupes: 2, katex: 1, vertical: 1 };
/** A number where the chip's would be: ".42" or "1.0" standing alone. */
const CHIP_NUMBER = /(?:^|\s)(?:\.\d\d|1\.0)(?:\s|$)/;

const test = base.extend({
  /** What the extension's own scripts write to the page's console as errors.
   *  chrome-extension://invalid/ is a page-side detection probe, not our resource. */
  extensionErrors: [
    async ({ page }, use) => {
      const errors = [];
      page.on("console", (m) => {
        const u = m.location()?.url ?? "";
        if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid")) errors.push(m.text().slice(0, 160));
      });
      await use(errors);
      expect(errors, "no extension console errors on fixtures").toEqual([]);
    },
    { auto: true },
  ],

  fixturesUrl: async ({ pages }, use) => {
    pages.serve({ "/ui-fixtures.html": UI_FIXTURES, "/favicon.ico": (req, res) => res.writeHead(204).end() });
    await use(pages.url("/ui-fixtures.html"));
  },

  /** The fixture page, read: every unit it holds carries its verdict. */
  fixtures: async ({ page, fixturesUrl }, use) => {
    await page.goto(fixturesUrl, { waitUntil: "load" });
    for (const [id, n] of Object.entries(UNITS)) await expect(settledChips(page, `#${id}`), `#${id} is read`).toHaveCount(n);
    await use(page);
  },
});

/** The hover card of the chip in `scope`: open in the top layer, where it is, and whether it is on screen. */
const cardOf = (page, scope) =>
  page.evaluate(
    ({ sel, scope }) => {
      const host = document.querySelector(`${scope} ${sel}`);
      const card = host?.shadowRoot?.querySelector(".card");
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return {
        open: card.matches(":popover-open"),
        below: card.classList.contains("below"),
        inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
        fits: r.right <= innerWidth + 1 && r.left >= -1,
        visible: getComputedStyle(card).visibility === "visible",
      };
    },
    { sel: BADGE_SEL, scope },
  );

/** Put the pointer on the part of the ball that is on screen (a tucked ball hangs half off the edge). */
async function pointAtBall(page) {
  const box = await page.locator("#anagram-fab .fab").boundingBox();
  const size = page.viewportSize();
  const left = Math.max(box.x, 0), right = Math.min(box.x + box.width, size.width - 1);
  await page.mouse.move((left + right) / 2, box.y + box.height / 2);
}
const tucked = (page) => page.evaluate(() => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack.tucked"));

test("the hover card stays on screen: below the chip at the top edge, pinned at the right edge, out of an overflow:hidden box in the top layer", async ({ fixtures: page }) => {
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator(`#topedge ${BADGE_SEL}`).hover();
  await expect.poll(() => cardOf(page, "#topedge"), { message: "hover card flips BELOW at viewport top, fully visible" }).toMatchObject({ open: true, below: true, inViewport: true, visible: true });
  await page.mouse.move(5, 400);

  await page.locator(`#rightcol ${BADGE_SEL}`).hover();
  await expect.poll(() => cardOf(page, "#rightcol"), { message: "hover card pinned inside viewport at right edge" }).toMatchObject({ open: true, fits: true });
  await page.mouse.move(5, 400);

  const clipped = page.locator(`#clipbox ${BADGE_SEL}`);
  await clipped.scrollIntoViewIfNeeded();
  await clipped.hover();
  // The card must reach outside the clip box and still be the thing under the pointer there.
  const escape = () =>
    page.evaluate((sel) => {
      const host = document.querySelector(`#clipbox ${sel}`);
      const card = host.shadowRoot.querySelector(".card");
      const cr = card.getBoundingClientRect();
      const br = document.getElementById("clipbox").getBoundingClientRect();
      const outsideY = cr.top < br.top - 4 ? cr.top + 6 : cr.bottom > br.bottom + 4 ? cr.bottom - 6 : null;
      const hit = outsideY === null ? null : document.elementFromPoint(cr.left + cr.width / 2, outsideY);
      return {
        topLayer: card.matches(":popover-open"),
        extendsOutsideBox: outsideY !== null,
        paintedOutsideBox: hit === host, // retargeted to our host, not the page element behind
        visible: getComputedStyle(card).visibility === "visible",
      };
    }, BADGE_SEL);
  await expect.poll(escape, { message: "hover card escapes overflow:hidden (top layer)" }).toEqual({ topLayer: true, extendsOutsideBox: true, paintedOutsideBox: true, visible: true });
});

test("the chip sits in the text: at the inline end of an RTL line, scaled with the font, inside a tight line box, an overflow:hidden box and a vertical-rl column", async ({ fixtures: page }) => {
  // RTL: the inline end of the last line is visually LEFT of where its text ends, on that line.
  const rtl = await page.evaluate((sel) => {
    const host = document.querySelector(`#rtl ${sel}`);
    const range = document.createRange();
    range.selectNodeContents(host.closest("p"));
    range.setEndBefore(host);
    const rects = [...range.getClientRects()].filter((x) => x.width > 1);
    const lastLine = rects[rects.length - 1];
    const hr = host.getBoundingClientRect();
    return {
      sameLine: Math.abs(hr.top + hr.height / 2 - (lastLine.top + lastLine.height / 2)) < lastLine.height,
      leftOfTextEnd: hr.right <= lastLine.left + 4,
    };
  }, BADGE_SEL);
  expect.soft(rtl, "RTL: chip at inline end of last line (left of text end)").toEqual({ sameLine: true, leftOfTextEnd: true });

  const fonts = await page.evaluate((sel) => {
    const size = (scope) => parseFloat(getComputedStyle(document.querySelector(`${scope} ${sel}`).shadowRoot.querySelector(".pill")).fontSize);
    return { tiny: size("#tiny"), large: size("#large") };
  }, BADGE_SEL);
  const scales = "chip font scales with page text (tiny < large, clamped)";
  expect.soft(fonts.tiny, `${scales}: ${JSON.stringify(fonts)}`).toBeLessThan(fonts.large);
  expect.soft(fonts.tiny, `${scales}: ${JSON.stringify(fonts)}`).toBeGreaterThanOrEqual(8.5);
  expect.soft(fonts.large, `${scales}: ${JSON.stringify(fonts)}`).toBeLessThanOrEqual(12.5);

  const tight = await page.evaluate((sel) => {
    const host = document.querySelector(`#tight ${sel}`);
    const lh = parseFloat(getComputedStyle(host.closest("p")).lineHeight);
    const h = host.shadowRoot.querySelector(".pill").getBoundingClientRect().height;
    return { chipH: h, lineH: lh };
  }, BADGE_SEL);
  expect.soft(tight.chipH, `chip does not expand tight line boxes: ${JSON.stringify(tight)}`).toBeLessThanOrEqual(tight.lineH + 4);

  const boxed = await page.evaluate((sel) => {
    const hr = document.querySelector(`#clipbox ${sel}`).getBoundingClientRect();
    const br = document.getElementById("clipbox").getBoundingClientRect();
    return { inside: hr.top >= br.top - 1 && hr.bottom <= br.bottom + 1 && hr.right <= br.right + 1, visible: hr.width > 0 && hr.height > 0 };
  }, BADGE_SEL);
  expect.soft(boxed, "badge stays visible inside overflow:hidden box").toEqual({ inside: true, visible: true });

  const vertical = await page.evaluate((sel) => {
    const host = document.querySelector(`#vertical ${sel}`);
    const box = host.closest("div").getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    return hr.left >= box.left - 30 && hr.right <= box.right + 30;
  }, BADGE_SEL);
  expect.soft(vertical, "vertical-rl (Japanese) paragraph badged in-flow").toBe(true);
});

test("shadow DOM: an open root's own paragraph, a slotted one, and one appended into the root after the scan", async ({ fixtures: page }) => {
  const counts = () =>
    page.evaluate((sel) => ({
      inShadow: document.getElementById("shadowhost").shadowRoot.querySelectorAll(sel).length,
      slotted: document.querySelectorAll(`#slotted-src ${sel}`).length,
    }), BADGE_SEL);
  const before = await counts();
  expect.soft(before.inShadow, "open shadow root paragraph badged").toBeGreaterThanOrEqual(1);
  expect.soft(before.slotted, "slotted light-DOM paragraph badged").toBeGreaterThanOrEqual(1);

  // The observer watches each root the walker went into, not only the document.
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.id = "shadow-late";
    p.textContent = "SHADOWLATE paragraph was appended into the open shadow root well after the " +
      "initial scan finished, and it must still receive a badge because the observer has to " +
      "watch mutations inside every shadow root the walker descended into, not only the light " +
      "document tree where a subtree observer on the root element never sees this change. A " +
      "component that loads its content lazily, a comment thread that fills in after the page " +
      "settles, or a feed that grows as the reader scrolls all change a shadow tree this way.";
    document.getElementById("shadowhost").shadowRoot.querySelector("div").appendChild(p);
  });
  await expect.poll(async () => (await counts()).inShadow, { message: "paragraph appended inside a shadow root after the scan is badged" }).toBeGreaterThan(before.inShadow);
});

test("copying: a selection never carries the chip's number, and the card's Copy text puts the paragraph on the clipboard beside a four-bucket readout", async ({ fixtures: page, clipboard }) => {
  const copied = await page.evaluate(async () => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("copysrc"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.execCommand("copy");
    return navigator.clipboard.readText();
  });
  expect.soft(copied, "copy excludes badge text (clipboard)").toContain("COPYSRC paragraph exists");
  expect.soft(copied, "copy excludes badge text (clipboard)").not.toMatch(CHIP_NUMBER);

  const card = "hover card: distribution readout + working Copy text action";
  await clipboard.write(page, "NOTHING COPIED");
  await page.locator(`#copysrc ${BADGE_SEL}`).hover();
  await expect.poll(() => cardOf(page, "#copysrc"), { message: card }).toMatchObject({ open: true });
  const parts = await page.evaluate((sel) => {
    const card = document.querySelector(`#copysrc ${sel}`).shadowRoot.querySelector(".card");
    return { meter: !!card.querySelector(".dist .scale .marker") && card.querySelectorAll(".dist .drow").length === 4, hasCopy: !!card.querySelector(".act.copy") };
  }, BADGE_SEL);
  expect.soft(parts, card).toEqual({ meter: true, hasCopy: true });
  await page.locator(`#copysrc ${BADGE_SEL} .act.copy`).click();
  await expect.poll(() => clipboard.read(page), { message: card }).toContain("COPYSRC paragraph exists");
  expect.soft(await clipboard.read(page), card).not.toMatch(CHIP_NUMBER);
});

test("a chip after a paragraph's closing link sits outside it, and clicking it never navigates", async ({ fixtures: page }) => {
  const r = await page.evaluate((sel) => {
    const host = document.querySelector(`#linkend ${sel}`);
    const insideLink = !!host.closest("#lastlink");
    host.click();
    return { insideLink, hash: location.hash };
  }, BADGE_SEL);
  expect(r.insideLink, "badge escapes trailing <a>; click does not navigate").toBe(false);
  expect(r.hash, "badge escapes trailing <a>; click does not navigate").not.toBe("#never-navigate");
});

test("a chip on a dark card is dark and the next one on the light page is light, an oklch() background included", async ({ fixtures: page }) => {
  const r = await page.evaluate((sel) => {
    const dark = (scope) => document.querySelector(`${scope} ${sel}`).classList.contains("pg-dark");
    return { dark: dark("#darksection"), lightAfter: dark("#lightafter"), oklch: dark("#oklchdark"), computedBg: getComputedStyle(document.getElementById("oklchdark")).backgroundColor };
  }, BADGE_SEL);
  expect.soft({ dark: r.dark, light: !r.lightAfter }, "per-anchor dark detection (dark card vs light page)").toEqual({ dark: true, light: true });
  expect.soft(r.oklch, `oklch() background classified dark (CSS Color 4 parsing): ${r.computedBg}`).toBe(true);
});

test("duplicate paragraphs each get a chip with the same score", async ({ fixtures: page }) => {
  const nums = await page.locator(`#dupes ${BADGE_SEL} .num`).allTextContents();
  expect(nums, "duplicate paragraphs each badged with the same score").toHaveLength(2);
  expect(nums[0], "duplicate paragraphs each badged with the same score").toBe(nums[1]);
});

test("a KaTeX formula: one single-part unit, the formula counted in the card, and its text copied once", async ({ fixtures: page, clipboard }) => {
  const katex = "KaTeX-style math: one single-part unit, formula counted, no duplicated formula text";
  const badge = page.locator(`#katex ${BADGE_SEL}`);
  await expect(badge, katex).toHaveCount(1);
  expect.soft(await page.locator(`#katex ${BADGE_SEL} .num`).textContent(), `${katex} (single part)`).not.toMatch(/×/);
  await badge.scrollIntoViewIfNeeded();
  await badge.hover();
  await expect.poll(() => cardOf(page, "#katex"), { message: katex }).toMatchObject({ open: true });
  const rows = await page.locator(`#katex ${BADGE_SEL} .card .row`).allTextContents();
  expect.soft(rows.find((t) => t.startsWith("Formulas omitted")), `${katex} (the formula counted)`).toBe("Formulas omitted1");
  await clipboard.write(page, "NOTHING COPIED");
  await page.locator(`#katex ${BADGE_SEL} .act.copy`).click();
  await expect.poll(() => clipboard.read(page), { message: `${katex} (Copy text reaches the end)` }).toContain("KATEXTAIL");
  expect.soft(await clipboard.read(page), `${katex} (no duplicated formula text)`).not.toContain("KATEXDUP");
});

test("the top layer: a modal dialog's paragraph is read and the ball rides above it; a site overlay covers the chips behind it, not the ball", async ({ fixtures: page }) => {
  await page.locator("#openmodal").scrollIntoViewIfNeeded();
  await page.locator("#openmodal").click();
  await expect(settledChips(page, "#modal"), "paragraph inside showModal dialog badged").toHaveCount(1);
  // A manual popover where supported; the fallback path has no top layer to be in.
  await expect
    .poll(() => page.evaluate(() => {
      const fab = document.getElementById("anagram-fab");
      return !!fab && (!("showPopover" in fab) || fab.matches(":popover-open"));
    }), { message: "FAB promoted to top layer (popover)" })
    .toBe(true);
  await page.locator("#closemodal").click();

  // A chip is part of its paragraph, never floating chrome: an overlay the site opens covers
  // it (Zhihu's comment sheet used to show the article's chips scattered across it).
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator("#openoverlay").scrollIntoViewIfNeeded();
  const r = await page.evaluate((sel) => {
    // The centre of the on-screen part: an idle-tucked ball hangs half off the edge.
    const centreHit = (el) => {
      const b = el.getBoundingClientRect();
      const x = (Math.max(b.left, 0) + Math.min(b.right, innerWidth - 1)) / 2;
      const y = (Math.max(b.top, 0) + Math.min(b.bottom, innerHeight - 1)) / 2;
      return document.elementFromPoint(x, y);
    };
    const inView = [...document.querySelectorAll(sel)].filter((h) => {
      const r = h.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    });
    const before = inView.filter((h) => centreHit(h) === h).length;
    document.getElementById("openoverlay").click();
    const overlay = document.getElementById("siteoverlay");
    const covered = inView.filter((h) => overlay.contains(centreHit(h))).length;
    const fab = document.getElementById("anagram-fab");
    const fabOnTop = centreHit(fab.shadowRoot.querySelector(".fab")) === fab;
    document.getElementById("closeoverlay").click();
    return { chipsInView: inView.length, hitBefore: before, coveredByOverlay: covered, fabOnTop };
  }, BADGE_SEL);
  const overlay = `a site overlay covers the chips behind it; the ball stays above (top layer): ${JSON.stringify(r)}`;
  expect.soft(r.chipsInView, overlay).toBeGreaterThan(0);
  expect.soft(r.hitBefore, overlay).toBe(r.chipsInView);
  expect.soft(r.coveredByOverlay, overlay).toBe(r.chipsInView);
  expect.soft(r.fabOnTop, overlay).toBe(true);
});

test("every analyzing chip drains into a verdict, and a paragraph added while a counter ticks is read before the ticking stops", async ({ fixtures: page }) => {
  await expect.poll(async () => (await chipCounts(page)).pending, { message: "pending chips all drain into verdicts" }).toBe(0);
  // A trailing debounce alone would starve until the ticking stops: the counter ticks 60
  // times, every 80 ms, from the click on. The chip must come while it still ticks.
  await page.locator("#churnAdd").scrollIntoViewIfNeeded();
  await page.evaluate((sel) => {
    window.__tickAtChip = null;
    new MutationObserver(() => {
      if (window.__tickAtChip === null && document.querySelector(`#churn ${sel}`)) window.__tickAtChip = Number(document.getElementById("ticker").textContent);
    }).observe(document.getElementById("churn"), { childList: true, subtree: true });
  }, BADGE_SEL);
  await page.locator("#churnAdd").click();
  const debounce = "re-scan is not starved by continuous mutation (debounce max-wait)";
  await expect.poll(() => page.evaluate(() => window.__tickAtChip), { message: debounce }).not.toBeNull();
  expect(await page.evaluate(() => window.__tickAtChip), `${debounce}: the tick the chip came at, of 60`).toBeLessThan(60);
});

test("the triage panel opens from the counter and lists AI-generated paragraphs only, with no verdict filters", async ({ fixtures: page }) => {
  await toggleCounter(page);
  const panel = () =>
    page.evaluate(() => {
      const panel = document.getElementById("anagram-fab").shadowRoot.querySelector(".panel");
      return {
        open: panel.classList.contains("open"),
        items: panel.querySelectorAll(".pitem").length,
        others: panel.querySelectorAll(".pitem:not(.band-ai)").length,
        filters: panel.querySelectorAll(".pfilters, .fchip[aria-pressed]").length,
      };
    });
  const lists = "triage panel opens and lists AI-generated paragraphs only, with no verdict filters";
  await expect.poll(panel, { message: lists }).toMatchObject({ open: true, others: 0, filters: 0 });
  expect((await panel()).items, lists).toBeGreaterThan(0);
});

test("the ball: dragged, it snaps to the left edge; left alone, it tucks half away and comes back under the pointer", async ({ fixtures: page }) => {
  await pointAtBall(page); // untuck first: a tucked ball sits half off-screen
  await expect.poll(() => tucked(page), { message: "the ball comes out under the pointer" }).toBe(false);
  const box = await page.locator("#anagram-fab .fab").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(140, 300, { steps: 8 }); // dropped near the LEFT edge
  await page.mouse.up();
  const side = () => page.evaluate(() => {
    const stack = document.getElementById("anagram-fab").shadowRoot.querySelector(".stack");
    return { left: stack.style.left, sideLeft: stack.classList.contains("side-left") };
  });
  await expect.poll(side, { message: "FAB snaps to the left edge after drag" }).toEqual({ left: "12px", sideLeft: true });

  await page.mouse.move(600, 300); // the pointer far away, and nothing else happening
  await expect.poll(() => tucked(page), { message: "FAB tucks when idle and returns on hover", timeout: 15_000 }).toBe(true);
  await pointAtBall(page);
  await expect.poll(() => tucked(page), { message: "FAB tucks when idle and returns on hover" }).toBe(false);
});

test("the main-content scope loads the Defuddle chunk on demand, and the page is still read", async ({ page, fixturesUrl, storage }) => {
  await storage.set({ debug: true, analysisScope: "main" });
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto(fixturesUrl, { waitUntil: "load" });
  const chunk = "main-content scope loads the Defuddle vendor chunk on demand";
  await expect.poll(() => logs.find((l) => /Defuddle chunk (loaded|failed)/.test(l)) ?? null, { message: chunk }).toMatch(/Defuddle chunk loaded$/);
  await expect(settledChips(page).first(), chunk).toBeAttached();
});

test("the copied report gives bare 0-1 scores, the legend that explains them and the caveat that travels with them", async ({ fixtures: page, report }) => {
  const text = await report(page);
  const legend = "copied report: bare 0-1 scores plus the legend that explains them and the caveat that travels with them";
  expect.soft(text, legend).toMatch(/^# Anagram analysis report/);
  expect.soft(text, legend).not.toContain("% AI");
  // Every flagged entry opens "1. **AI-generated · .96** (…", never with a percentage.
  const entries = text.split("\n").filter((l) => /^\d+\. \*\*/.test(l));
  expect.soft(entries.filter((l) => !/^\d+\. \*\*[^*]+ · (\.\d\d|1\.0)\*\*/.test(l)), legend).toEqual([]);
  expect.soft(text, legend).toContain("not the fraction of AI-written words");
  expect.soft(text, legend).toContain("Scores are estimates, not proof of authorship. Do not use them for disciplinary or other high-stakes decisions.");
});

// The host goes away: the batch in flight renders "Unavailable", nothing new is dispatched,
// the ball's counter shows "!"; it comes back and everything is queued again by itself (no
// reload, no Rescan). Twice: a paragraph under 510 bytes meets the dead socket with its
// score request, one twice as long with its token count.
for (const [path, repeat] of [["score", 1], ["count", 2]]) {
  test(`the host goes away and comes back with a ${path} request in flight: Unavailable, then read again by itself`, async ({ page, fixturesUrl, nativeHost, storage }) => {
    await storage.set({ debug: true });
    const scans = [];
    page.on("console", (m) => {
      if (m.text().includes("dirty scan:")) scans.push(m.text());
    });
    await page.goto(fixturesUrl, { waitUntil: "load" });
    await expect(settledChips(page, "#topedge")).toHaveCount(1);
    const addPara = (id) =>
      page.evaluate(({ pid, times }) => {
        const el = document.createElement("p");
        el.id = pid;
        el.textContent = Array.from({ length: times }, () => `${pid.toUpperCase()} paragraph is appended while the scoring fixture is stopped, so ` +
          "the extension must not invent a verdict for it: the batch that hits the dead socket renders as " +
          "Unavailable and later paragraphs wait without any chip, until a health probe succeeds again and " +
          "every waiting or unavailable unit is queued once more without a reload or a manual rescan. " +
          "Till then, a reader has to be able to tell a unit that waits from one that was read, and a fault from a verdict.").join(" ");
        document.querySelector("main").prepend(el);
      }, { pid: `${id}${path}`, times: repeat });
    const pill = (id) => page.locator(`#${id}${path} ${BADGE_SEL} .pill`);
    const bubble = () => page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);

    const down = `fixture down (${path} request): in-flight batch renders Unavailable, later paragraphs get no chip, counter shows !`;
    await nativeHost.close(); // connection refused from here on
    await addPara("down1");
    // Settled: past "analyzing…" — the pending chip goes in at dispatch, BEFORE the reply
    // that puts the page in the down state.
    await expect(pill("down1"), down).toHaveClass(/band-unknown/);
    await expect(pill("down1"), down).not.toHaveClass(/pending/);
    await expect.poll(bubble, { message: down }).toBe("!");
    const scanned = scans.length;
    await addPara("down2");
    // The walk has the paragraph; nothing may dispatch it while the host is down.
    await expect.poll(() => scans.length, { message: `${down} (the walk saw it)` }).toBeGreaterThan(scanned);
    await page.waitForTimeout(ABSENCE_MS);
    await expect(page.locator(`#down2${path} ${BADGE_SEL}`), down).toHaveCount(0);
    expect(await bubble(), down).toBe("!");

    const back = `fixture back (${path} request): waiting + Unavailable units re-queued automatically`;
    await nativeHost.resume(); // the same native registration
    await expect(settledChips(page, `#down2${path}`), back).toHaveCount(1, { timeout: 30_000 });
    await expect(pill("down1"), back).not.toHaveClass(/band-unknown|pending/, { timeout: 30_000 });
    await expect.poll(bubble, { message: back }).not.toBe("!");
  });
}

// The in-browser engine loading its model says so, and holds what it is sent until the model is
// in (the fixture's `loadingWaits`): a page paused while the engine was away goes on as soon as
// its recheck hears the engine is loading, so its paragraphs are read the moment the model is.
// The local engine says "not ready" while it loads, and a page waits for ready (above).
test("the host comes back loading its model, as the in-browser engine does: the paused page is sent while it loads", async ({ page, fixturesUrl, nativeHost }) => {
  await page.goto(fixturesUrl, { waitUntil: "load" });
  await expect(settledChips(page, "#topedge")).toHaveCount(1);
  const bubble = () => page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);
  const pill = page.locator(`#loading1 ${BADGE_SEL} .pill`);
  await nativeHost.close();
  await page.evaluate(() => {
    const el = document.createElement("p");
    el.id = "loading1";
    el.textContent = "LOADING1 paragraph is appended while the scoring fixture is stopped, and it is still waiting when the " +
      "engine comes back and starts to load its model, which takes a while in the browser: the page must not wait for the " +
      "model to be ready before it sends the paragraph again, because the engine holds what it is sent until the model is in, " +
      "and a paragraph sent early is read the moment the model is.";
    document.querySelector("main").prepend(el);
  });
  const down = "fixture down: the paragraph is Unavailable and the ball shows !";
  await expect(pill, down).toHaveClass(/band-unknown/);
  await expect(pill, down).not.toHaveClass(/pending/);
  await expect.poll(bubble, { message: down }).toBe("!");

  nativeHost.setState({ startupMs: 12_000, loadingWaits: true });
  await nativeHost.resume();
  const sent = "fixture back and loading its model: the paused page sends the paragraph while the model loads";
  const sentWhileLoading = () => nativeHost.requests().some((r) => r.op === "score" && r.loading === true && r.payload.blocks.some((b) => b.text.includes("LOADING1")));
  await expect.poll(sentWhileLoading, { message: sent, timeout: 15_000 }).toBe(true);
  expect(await bubble(), sent).not.toBe("!");
  await expect(pill, "and it is read once the model is in").not.toHaveClass(/band-unknown|pending/, { timeout: 30_000 });
});
