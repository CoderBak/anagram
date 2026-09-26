// test/scenarios.mjs — the wide-net scenario matrix.
//
// Phase A (deterministic, local): UI behaviours on test/ui-fixtures.html —
// edge-aware hover card (top/right), RTL placement, font scaling, layout-shift
// bound, shadow DOM + slot capture, overflow containers, copy hygiene,
// badge-after-link isolation, per-anchor dark theme, duplicate fan-out — plus
// keyboard-only access to the triage panel and its commands on /keyboard.html,
// and a cross-origin no-referrer subframe obeying the top page's site rule.
//
// Phase B (live, soft): real-site sweep with per-site expectations — HF paper
// (the original bug), EN/AR/JA Wikipedia, MDN, paulgraham, arXiv, StackOverflow,
// GitHub, a text/plain RFC, and zero-badge aggregator pages. A site that fails
// to LOAD is SKIP (network flake), but a loaded site violating its expectation
// is FAIL. Only console errors originating from the extension count against us.
//
//   node test/scenarios.mjs            # full matrix
//   node test/scenarios.mjs --local    # phase A only
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import http from "node:http";
import { launchExtension, serveHtml, artifact, uiLanguage, uiLanguageOf, BADGE_SEL } from "./harness.mjs";
import { createNativeFixture, fakeTokens } from "./fake-native.mjs";
import { docsReadingHtml } from "./fixtures/docs-reading.mjs";
import {
  GROUPED_PARAS,
  GROUPED_UNIT_TEXT,
  PDF_HEAD,
  PDF_HEADING,
  PDF_PARAS,
  TEST_PDF,
  TALL_PDF,
  servePdfs,
  openPdfInReader,
  handOverPdf,
} from "./pdf-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_ONLY = process.argv.includes("--local");

const results = []; // { phase, name, status: PASS|FAIL|SKIP, note }
const record = (phase, name, ok, note = "") =>
  results.push({ phase, name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note });

// ---- fake fixture (deterministic verdicts) + server for the fixture page -------------
// Texts carrying the stall marker are answered only after STALL_MS — long enough to
// hold a selection card in its "Analyzing…" state while the test acts on it. Every
// other request keeps the fixture's ordinary latency.
const STALL_MARKER = "SLOWPOKE";
const STALL_MS = 4000;
// Texts carrying a density marker are LONGER to the fake's model than their characters
// suggest: DENSEPACK costs a token per two characters (a 1500-character paragraph overflows
// the 512-token window, each half of it fits), SOLIDPACK overflows whatever its length.
const DENSE_MARKER = "DENSEPACK";
const SOLID_MARKER = "SOLIDPACK";
const FIXTURE_OPTS = {
  rules: [{contains: STALL_MARKER, delayMs: STALL_MS}, {contains: SOLID_MARKER, tokens: 600}],
};
let fixture = await createNativeFixture(FIXTURE_OPTS);

const PARA = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a self-rewriting page must still end up with chips after it replaces its own document element, which is what legacy challenge pages and some old single-page frameworks do, and the extension then has to find the new document, walk it again from the top and read every paragraph in it as if the page had only just loaded.`;
const REWRITE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>rewrite fixture</title></head><body>
<p>Interstitial: checking your browser, please wait…</p>
<script>
  setTimeout(() => {
    document.open();
    document.write('<!doctype html><html><head><meta charset="utf-8"><title>rewritten</title></head><body><main><p id="rw1">${PARA("REWRITTEN-ONE")}</p><p id="rw2">${PARA("REWRITTEN-TWO")}</p></main></body></html>');
    document.close();
  }, 1500);
</script></body></html>`;
// Scope fixture: an article region both the text-mass probe and Readability land on,
// plus a long paragraph OUTSIDE it carrying a marker word. Under "Main content only"
// that paragraph must never be chipped and its text must never reach the fixture.
const SCOPE_MARKER = "ZORBLAX";
const OUTSIDE_PARA = `${SCOPE_MARKER} sits in a block outside the article region, and it is deliberately long enough to clear the evidence floor on its own, with well over seventy-five ordinary English words in it, so that nothing except the analysis scope can explain its absence: if the first scan ran under the default whole-page setting, this sentence would have been dispatched to the scoring fixture long before the stored setting ever arrived, and the fixture's log would show it among the very first texts it was sent.`;
const SCOPE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>scope fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<main id="article"><h1>The article region</h1>
<p id="s1">${PARA("SCOPED-ONE")}</p>
<p id="s2">${PARA("SCOPED-TWO")}</p>
<p id="s3">${PARA("SCOPED-THREE")}</p></main>
<div id="offmain"><p id="s4">${OUTSIDE_PARA}</p></div>
</body></html>`;
// Stall fixture: the marker text sits in a <textarea>, which passive capture never
// scores — so the only request it can ever produce is the selection card's own, and
// no cached verdict can rob that card of its "Analyzing…" state.
const STALL_TEXT = `${STALL_MARKER} is the marker word this selection carries so the fake fixture knows to hold its answer back for a few seconds, which is exactly the state the close button used to be dead in: the request is in flight, the card says it is analyzing, and the one listener that could dismiss it had not been attached yet, because attaching it was the last statement of the function, so a reader who changed their mind had to wait for the answer before the card would go away.`;
const STALL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>stall fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>Selection while the fixture stalls</h1>
<textarea id="draft" style="width:100%;height:150px">${STALL_TEXT}</textarea>
</body></html>`;
// Keyboard fixture: four paragraphs whose seeded verdicts all land in a FLAGGED band
// (fake-fixture's fakeScore is a pure function of the text — these markers were chosen
// for it), spread far enough apart that "the next one" is a real scroll. Nothing else
// on the page carries words, so no short run can merge into a paragraph and change the
// text the verdict is seeded from. The 900 px lead-in puts every paragraph BELOW the
// viewport's middle at scroll 0, which is what makes "previous" wrap to the last one.
const KEY_PARA = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a keyboard user must be able to walk the flagged paragraphs of a page without ever reaching for a mouse, which is what the next and previous commands are for, and each of them has to bring the next verdict into view and say which paragraph it belongs to before the reader moves on.`;
// Four flagged — AI-generated — paragraphs under the fake's text-seeded scores (.91–.95).
const KEY_TAGS = ["FLAG-3", "FLAG-2", "FLAG-22", "FLAG-37"];
// A fifth, inserted above them once they are chipped: AI-generated (.90) under the same scores.
const LATE_TAG = "LATE-1";
const KEYS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>keyboard fixture</title></head><body style="max-width:720px;margin:0 auto;font:15px/1.6 system-ui">
<div style="height:900px"></div>
${KEY_TAGS.map((t, i) => `<p id="k${i + 1}">${KEY_PARA(t)}</p>\n<div style="height:700px"></div>`).join("\n")}
</body></html>`;
// Frame fixture: the embedded page is served from 127.0.0.1 while its host page is on
// localhost — a different origin, so the frame cannot read window.top — and the embed
// forbids the referrer, which used to leave the frame keyed on its OWN hostname and
// therefore deaf to the rule written for the page it sits in.
const FRAME_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>framed article</title></head><body style="margin:12px;font:15px/1.6 system-ui">
<p id="fp">${PARA("FRAMED")}</p></body></html>`;
// Pass fixtures: the self-test page's paragraph read in passes (~3750 characters, its seeded
// pass verdicts add up to a FLAGGED aggregate — test/e2e.mjs prints them), once as a
// paragraph for the copied report and once in a <textarea>, which passive capture never
// scores, so the only thing that can read it is the selection card.
const WINDOWED_TEXT = readFileSync(join(__dirname, "selftest.html"), "utf8")
  .match(/<section id="windowed">\s*<p>([\s\S]*?)<\/p>/)[1]
  .replace(/\s+/g, " ")
  .trim();
// Blocks the fixture was sent that read the whole of `text` in passes, each starting after
// the one before, inside it, and reaching past it.
const readWhole = (blocks, text) => {
  const at = blocks.map((t) => [text.indexOf(t), text.indexOf(t) + t.length]);
  return at.length > 1 && at[0][0] === 0 && at[at.length - 1][1] === text.length &&
    at.every(([from, to], i) => i === 0 || (from > at[i - 1][0] && from < at[i - 1][1] && to > at[i - 1][1]));
};
const WINDOWS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>windows fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>One paragraph, several passes</h1>
<p id="wp">${WINDOWED_TEXT}</p>
</body></html>`;
const LONGSEL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>long selection fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>A selection longer than the model reads in one pass</h1>
<textarea id="draft" style="width:100%;height:420px">${WINDOWED_TEXT}</textarea>
</body></html>`;
// Dense fixture: two paragraphs short enough in characters for one pass. DENSEPACK's
// figures are a token a digit, so its count says it is too long for one and it is planned
// into more; SOLIDPACK's count says it fits and the reading still comes back cut (the
// fixture's rule), and every sentence carries the marker, so both halves of the re-read are
// cut too.
const DENSE_PARA = (marker) =>
  Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the ${marker} ledger lists 4471, 88310, 12480 and 30917 for that week, with the initials of whoever checked them.`).join(" ");
const SOLID_PARA = (marker) =>
  Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of the ${marker} ledger lists the figures for that week, the running totals and the initials of whoever checked them.`).join(" ");
const DENSE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dense fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>Few enough characters for one pass, more tokens than the model takes</h1>
<p id="dense">${DENSE_PARA(DENSE_MARKER)}</p>
<p id="solid">${SOLID_PARA(SOLID_MARKER)}</p>
</body></html>`;
// Clipped fixture: a feed post the site shows three lines of, with the rest in the DOM
// behind a "see more" control — the shape LinkedIn, Substack Notes and Goodreads use. The
// text is scored; the chip has to end up UNDER the visible lines, not inside the box.
const CLIPPED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>clipped fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>A post behind "see more"</h1>
<div id="post" style="border:1px solid #ddd;padding:12px">
  <div id="box" style="overflow:hidden;max-height:48px">${PARA("CLIPPEDPOST")} ${PARA("CLIPPEDPOST-MORE")}</div>
  <button id="more" type="button" aria-expanded="false" onclick="document.getElementById('box').style.maxHeight='none';this.setAttribute('aria-expanded','true')">…see more</button>
</div>
<p id="plain">${PARA("PLAINPOST")}</p>
</body></html>`;
const PAGES = {
  "/ui-fixtures.html": readFileSync(join(__dirname, "ui-fixtures.html"), "utf8"),
  "/clipped.html": CLIPPED_HTML,
  "/dense.html": DENSE_HTML,
  "/windows.html": WINDOWS_HTML,
  "/longsel.html": LONGSEL_HTML,
  "/rewrite.html": REWRITE_HTML,
  "/scope.html": SCOPE_HTML,
  "/stall.html": STALL_HTML,
  "/keyboard.html": KEYS_HTML,
  "/frame.html": FRAME_HTML,
};
const server = await serveHtml(PAGES);
// The host page can only be written once the port is known; the server reads PAGES per
// request, so adding it here is enough.
PAGES["/frame-top.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frame host</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<p id="topp">${PARA("FRAMEHOST")}</p>
<iframe id="embed" src="${server.base.replace("localhost", "127.0.0.1")}/frame.html" referrerpolicy="no-referrer" width="640" height="320" style="border:1px solid #ccc"></iframe>
</body></html>`;
const fixturesUrl = server.url("/ui-fixtures.html");

// The reader fetches BYTES, so the PDFs are served by a server of their own (the same
// helper the Firefox suite uses, so both open the same document).
const fileServer = await servePdfs();
const fileUrl = fileServer.url;

const { context, sw } = await launchExtension({ nativeFixture: fixture });
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
console.log("extension SW:", sw ? "loaded" : "NOT loaded", "· fake fixture at", fixture.label);

async function sweep(page, steps = 6) {
  await page
    .evaluate(async (n) => {
      const step = Math.round(window.innerHeight * 0.8);
      for (let i = 0; i < n; i++) {
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 300));
      }
      window.scrollTo(0, 0);
    }, steps)
    .catch(() => {});
}

// =====================================================================================
// PHASE A — deterministic UI fixtures
// =====================================================================================
{
  const page = await context.newPage();
  const extErrors = [];
  page.on("console", (m) => {
    const u = m.location()?.url ?? "";
    // chrome-extension://invalid/ is a page-side extension-detection probe (Google
    // Docs does this), not our resource.
    if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid"))
      extErrors.push(m.text().slice(0, 160));
  });
  await page.goto(fixturesUrl, { waitUntil: "load" });
  await page.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
  await sweep(page, 8);
  await page.waitForTimeout(2500);

  // A1: top-edge hover card flips below and stays in-viewport.
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    const badge = page.locator(`#topedge ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.hover();
      await page.waitForTimeout(450);
      const r = await page.evaluate((sel) => {
        const host = document.querySelector(`#topedge ${sel}`);
        const card = host.shadowRoot.querySelector(".card");
        const cr = card.getBoundingClientRect();
        return {
          below: card.classList.contains("below"),
          inViewport:
            cr.top >= 0 && cr.left >= 0 &&
            cr.bottom <= innerHeight && cr.right <= innerWidth,
          visible: getComputedStyle(card).visibility === "visible",
        };
      }, BADGE_SEL);
      ok = r.below && r.inViewport && r.visible;
      note = JSON.stringify(r);
      await page.screenshot({ path: artifact("scn-card-below.png") });
    }
    record("ui", "hover card flips BELOW at viewport top, fully visible", ok, note);
    await page.mouse.move(5, 400); // unhover
  }

  // A2: right-edge column card stays inside the viewport.
  {
    const badge = page.locator(`#rightcol ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.hover();
      await page.waitForTimeout(450);
      const r = await page.evaluate((sel) => {
        const host = document.querySelector(`#rightcol ${sel}`);
        const cr = host.shadowRoot.querySelector(".card").getBoundingClientRect();
        return { right: Math.round(cr.right), vw: innerWidth, fits: cr.right <= innerWidth + 1 && cr.left >= -1 };
      }, BADGE_SEL);
      ok = r.fits;
      note = JSON.stringify(r);
    }
    record("ui", "hover card pinned inside viewport at right edge", ok, note);
    await page.mouse.move(5, 400);
  }

  // A3: RTL — chip sits at the INLINE END of the last text line: in RTL that
  // means visually to the LEFT of where the last line's text ends, on that line.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#rtl ${sel}`);
      if (!host) return null;
      const range = document.createRange();
      range.selectNodeContents(host.closest("p"));
      range.setEndBefore(host);
      const rects = [...range.getClientRects()].filter((x) => x.width > 1);
      const lastLine = rects[rects.length - 1];
      const hr = host.getBoundingClientRect();
      const sameLine = Math.abs(hr.top + hr.height / 2 - (lastLine.top + lastLine.height / 2)) < lastLine.height;
      const leftOfTextEnd = hr.right <= lastLine.left + 4;
      return {
        badgeRight: Math.round(hr.right),
        textEndLeft: Math.round(lastLine.left),
        sameLine,
        leftOfTextEnd,
      };
    }, BADGE_SEL);
    record("ui", "RTL: chip at inline end of last line (left of text end)", r ? r.sameLine && r.leftOfTextEnd : false, JSON.stringify(r));
  }

  // A4: chip scales with surrounding font size (clamped 9–12px).
  {
    const r = await page.evaluate((sel) => {
      const fs = (scope) => {
        const host = document.querySelector(`${scope} ${sel}`);
        if (!host) return null;
        return parseFloat(getComputedStyle(host.shadowRoot.querySelector(".pill")).fontSize);
      };
      return { tiny: fs("#tiny"), large: fs("#large") };
    }, BADGE_SEL);
    const ok =
      r.tiny !== null && r.large !== null &&
      r.tiny < r.large && r.tiny >= 8.5 && r.large <= 12.5;
    record("ui", "chip font scales with page text (tiny < large, clamped)", ok, JSON.stringify(r));
  }

  // A5: tight line-height — chip height within line box + tolerance.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#tight ${sel}`);
      if (!host) return null;
      const p = host.closest("p");
      const lh = parseFloat(getComputedStyle(p).lineHeight);
      const h = host.shadowRoot.querySelector(".pill").getBoundingClientRect().height;
      return { chipH: Math.round(h * 10) / 10, lineH: Math.round(lh * 10) / 10, fits: h <= lh + 4 };
    }, BADGE_SEL);
    record("ui", "chip does not expand tight line boxes", r ? r.fits : false, JSON.stringify(r));
  }

  // A6: shadow DOM + slotted content both badged (composed traversal).
  {
    const r = await page.evaluate((sel) => {
      const root = document.getElementById("shadowhost")?.shadowRoot;
      const inShadow = root ? root.querySelectorAll(sel).length : -1;
      const slotted = document.querySelectorAll(`#slotted-src ${sel}`).length;
      return { inShadow, slotted };
    }, BADGE_SEL);
    record("ui", "open shadow root paragraph badged", r.inShadow >= 1, JSON.stringify(r));
    record("ui", "slotted light-DOM paragraph badged", r.slotted >= 1, JSON.stringify(r));
  }

  // A6b: content appended INSIDE the open shadow root after the first scan is still
  // picked up (the MutationObserver watches each discovered root, not just the document).
  {
    const before = await page.evaluate((sel) => document.getElementById("shadowhost")?.shadowRoot?.querySelectorAll(sel).length ?? -1, BADGE_SEL);
    await page.evaluate(() => {
      const root = document.getElementById("shadowhost").shadowRoot;
      const p = document.createElement("p");
      p.id = "shadow-late";
      p.textContent = "SHADOWLATE paragraph was appended into the open shadow root well after the " +
        "initial scan finished, and it must still receive a badge because the observer has to " +
        "watch mutations inside every shadow root the walker descended into, not only the light " +
        "document tree where a subtree observer on the root element never sees this change. A " +
        "component that loads its content lazily, a comment thread that fills in after the page " +
        "settles, or a feed that grows as the reader scrolls all change a shadow tree this way.";
      root.querySelector("div").appendChild(p);
    });
    const ok = await page
      .waitForFunction(({ sel, n }) => (document.getElementById("shadowhost")?.shadowRoot?.querySelectorAll(sel).length ?? 0) > n, { sel: BADGE_SEL, n: before }, { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    record("ui", "paragraph appended inside a shadow root after the scan is badged", ok, `before=${before}`);
  }

  // A7: overflow:hidden container — badge visible inside the box.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#clipbox ${sel}`);
      if (!host) return null;
      const hr = host.getBoundingClientRect();
      const br = document.getElementById("clipbox").getBoundingClientRect();
      return {
        inside: hr.top >= br.top - 1 && hr.bottom <= br.bottom + 1 && hr.right <= br.right + 1,
        visible: hr.width > 0 && hr.height > 0,
      };
    }, BADGE_SEL);
    record("ui", "badge stays visible inside overflow:hidden box", r ? r.inside && r.visible : false, JSON.stringify(r));
  }

  // A7b: the HOVER CARD escapes the overflow:hidden box (top layer). The card must
  // extend outside the clip box and still be the element under the pointer there.
  {
    const badge = page.locator(`#clipbox ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.scrollIntoViewIfNeeded();
      await badge.hover();
      await page.waitForTimeout(450);
      const r = await page.evaluate((sel) => {
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
      ok = r.topLayer && r.extendsOutsideBox && r.paintedOutsideBox && r.visible;
      note = JSON.stringify(r);
    }
    record("ui", "hover card escapes overflow:hidden (top layer)", ok, note);
    await page.mouse.move(5, 400);
  }

  // A7c: a post the site clips to three lines is scored, and its chip is inserted AFTER
  // the clipping box — under the lines the reader sees, not inside the box where it would
  // be painted out of sight. Opening the post hides nothing any more, so the chip goes back
  // to the end of its own text, which is now on the screen.
  {
    const p = await context.newPage();
    await p.goto(server.url("/clipped.html"), { waitUntil: "load" });
    const placed = await p
      .waitForFunction(
        (sel) => {
          const host = document.querySelector(`#post ${sel}`);
          if (!host?.shadowRoot?.querySelector(".card .head")) return null;
          const box = document.getElementById("box");
          const hr = host.getBoundingClientRect();
          const br = box.getBoundingClientRect();
          return {
            insideBox: box.contains(host),
            afterBox: host.previousElementSibling === box,
            onScreen: hr.height > 0 && hr.top < br.bottom + 60,
            clippedAway: hr.top >= br.bottom - 1 && box.contains(host),
          };
        },
        BADGE_SEL,
        { timeout: 12000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    await p.click("#more");
    await p.waitForTimeout(1200);
    const after = await p.evaluate((sel) => {
      const hosts = document.querySelectorAll(`#post ${sel}`);
      const host = hosts[0];
      const box = document.getElementById("box");
      const hr = host?.getBoundingClientRect();
      return {
        chips: hosts.length,
        backAtItsText: !!host && box.contains(host),
        drawn: !!hr && hr.height > 0 && hr.bottom <= box.getBoundingClientRect().bottom + 1,
        expanded: getComputedStyle(box).maxHeight === "none",
      };
    }, BADGE_SEL);
    const ok =
      !!placed && !placed.insideBox && placed.afterBox && placed.onScreen && !placed.clippedAway &&
      after.chips === 1 && after.backAtItsText && after.drawn && after.expanded;
    record("ui", "a post clipped to three lines is scored and its chip sits under the visible text, then returns to its own last line when the post is opened", ok, JSON.stringify({ placed, after }));
    await p.close();
  }

  // A8: copy hygiene — clipboard payload excludes the chip's number.
  {
    const r = await page.evaluate(async () => {
      const p = document.getElementById("copysrc");
      const range = document.createRange();
      range.selectNodeContents(p);
      const selObj = getSelection();
      selObj.removeAllRanges();
      selObj.addRange(range);
      const selText = selObj.toString();
      let clip = null;
      try {
        document.execCommand("copy");
        clip = await navigator.clipboard.readText();
      } catch {
        /* clipboard permission not granted — selection text is the proxy */
      }
      const probe = clip ?? selText;
      return {
        via: clip !== null ? "clipboard" : "selection",
        hasWords: probe.includes("COPYSRC paragraph exists"),
        leaked: /(?:^|\s)(?:\.\d\d|1\.0)(?:\s|$)/.test(probe),
      };
    });
    record("ui", `copy excludes badge text (${r.via})`, r.hasWords && !r.leaked, JSON.stringify(r));
  }

  // A9: badge after a trailing link — outside the anchor; clicking never navigates.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#linkend ${sel}`);
      if (!host) return null;
      const insideLink = !!host.closest("#lastlink");
      host.click();
      return { insideLink, hash: location.hash };
    }, BADGE_SEL);
    record(
      "ui",
      "badge escapes trailing <a>; click does not navigate",
      r ? !r.insideLink && r.hash !== "#never-navigate" : false,
      JSON.stringify(r),
    );
  }

  // A10: per-anchor dark theme — dark card chip dark, following light chip light.
  {
    const r = await page.evaluate((sel) => {
      const darkHost = document.querySelector(`#darksection ${sel}`);
      const lightHost = document.querySelector(`#lightafter ${sel}`);
      return {
        dark: darkHost ? darkHost.classList.contains("pg-dark") : null,
        light: lightHost ? !lightHost.classList.contains("pg-dark") : null,
      };
    }, BADGE_SEL);
    record("ui", "per-anchor dark detection (dark card vs light page)", r.dark === true && r.light === true, JSON.stringify(r));
  }

  // A10b: CSS Color 4 background (oklch) — computed style is not rgb(); still dark.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#oklchdark ${sel}`);
      return {
        computedBg: getComputedStyle(document.getElementById("oklchdark")).backgroundColor,
        dark: host ? host.classList.contains("pg-dark") : null,
      };
    }, BADGE_SEL);
    record("ui", "oklch() background classified dark (CSS Color 4 parsing)", r.dark === true, JSON.stringify(r));
  }

  // A11: exact duplicates — both badged, identical fanned-out score.
  {
    const r = await page.evaluate((sel) => {
      const hosts = [...document.querySelectorAll(`#dupes ${sel}`)];
      const nums = hosts.map((h) => h.shadowRoot.querySelector(".num").textContent);
      return { count: hosts.length, nums, same: nums.length === 2 && nums[0] === nums[1] };
    }, BADGE_SEL);
    record("ui", "duplicate paragraphs each badged with the same score", r.count === 2 && r.same, JSON.stringify(r));
  }

  // A12: KaTeX-shaped formula — ONE single-part unit (the formula never splits the
  // sentence), the formula counted in the card, and the unit text (Copy text) free of
  // the duplicated visual/accessible formula copies.
  {
    await page.locator("#katex").scrollIntoViewIfNeeded();
    const badge = page.locator(`#katex ${BADGE_SEL}`).first();
    let r = { badges: await badge.count() };
    if (r.badges === 1) {
      await badge.hover();
      await page.waitForTimeout(420);
      const info = await page.evaluate((sel) => {
        const host = document.querySelector(`#katex ${sel}`);
        const sr = host?.shadowRoot;
        const rows = [...(sr?.querySelectorAll(".card .row") ?? [])].map((x) => x.textContent);
        sr?.querySelector(".act.copy")?.click();
        return { num: sr?.querySelector(".num")?.textContent ?? "", formulasRow: rows.find((t) => t.startsWith("Formulas omitted")) ?? null };
      }, BADGE_SEL);
      await page.waitForTimeout(250);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      r = { ...r, ...info, singlePart: !/×/.test(info.num), dupLeak: clip === null ? null : clip.includes("KATEXDUP"), tail: clip === null ? null : clip.includes("KATEXTAIL") };
      await page.mouse.move(5, 400);
    }
    record("ui", "KaTeX-style math: one single-part unit, formula counted, no duplicated formula text", r.badges === 1 && r.singlePart && r.formulasRow === "Formulas omitted1" && r.dupLeak !== true && r.tail !== false, JSON.stringify(r));
  }

  // A13: modal <dialog> — top-layer prose is scored; the FAB rides the top layer
  // as a manual popover where supported.
  {
    await page.locator("#openmodal").scrollIntoViewIfNeeded();
    await page.locator("#openmodal").click();
    const badged = await page
      .waitForFunction(
        (sel) => document.querySelectorAll(`#modal ${sel}`).length >= 1,
        BADGE_SEL,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    const fabTop = await page.evaluate(() => {
      const fab = document.getElementById("anagram-fab");
      if (!fab) return { supported: false, open: false };
      if (!("showPopover" in fab)) return { supported: false, open: true }; // fallback path OK
      try {
        return { supported: true, open: fab.matches(":popover-open") };
      } catch {
        return { supported: true, open: false };
      }
    });
    await page.locator("#closemodal").click();
    record("ui", "paragraph inside showModal dialog badged", badged, "");
    record("ui", "FAB promoted to top layer (popover)", fabTop.open, JSON.stringify(fabTop));
  }

  // A13b: a site overlay covers the chips behind it (a chip is part of its paragraph,
  // never floating chrome), while our own ball keeps riding the top layer. Before the
  // fix every chip on the page bled THROUGH such overlays — Zhihu's comment sheet showed
  // the article's chips scattered across it.
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#openoverlay").scrollIntoViewIfNeeded();
    const r = await page.evaluate((sel) => {
      // Hit-test the centre of the on-screen part: an idle-tucked ball hangs half off
      // the edge, and a raw centre would fall outside the viewport.
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
      // The panel's own children answer the hit-test where they sit, so "covered" means
      // the overlay or anything inside it — anything but the chip.
      const covered = inView.filter((h) => overlay.contains(centreHit(h))).length;
      const fab = document.getElementById("anagram-fab");
      const ball = fab?.shadowRoot?.querySelector(".fab");
      const fabOnTop = ball ? centreHit(ball) === fab : null;
      document.getElementById("closeoverlay").click();
      return { chipsInView: inView.length, hitBefore: before, coveredByOverlay: covered, fabOnTop };
    }, BADGE_SEL);
    const ok = r.chipsInView > 0 && r.hitBefore === r.chipsInView && r.coveredByOverlay === r.chipsInView && r.fabOnTop === true;
    record("ui", "a site overlay covers the chips behind it; the ball stays above (top layer)", ok, JSON.stringify(r));
  }

  // A14: vertical writing mode — unit collected, chip present, column flow intact.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#vertical ${sel}`);
      if (!host) return null;
      const box = host.closest("div").getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      return { present: true, inside: hr.left >= box.left - 30 && hr.right <= box.right + 30 };
    }, BADGE_SEL);
    record("ui", "vertical-rl (Japanese) paragraph badged in-flow", !!r && r.present && r.inside, JSON.stringify(r));
  }

  // A15: "analyzing…" chips are transient — they must all DRAIN into verdicts.
  {
    const drained = await page
      .waitForFunction(
        (sel) => {
          for (const h of document.querySelectorAll(sel)) {
            if (h.shadowRoot?.querySelector(".pill.pending")) return false;
          }
          return true;
        },
        BADGE_SEL,
        { timeout: 6000 },
      )
      .then(() => true)
      .catch(() => false);
    record("ui", "pending chips all drain into verdicts", drained, "");
  }

  // A15b: a paragraph added while a nearby counter ticks every 80 ms must be badged
  // within a bounded wait — a trailing debounce alone would starve until the ticking stops.
  {
    await page.locator("#churnAdd").scrollIntoViewIfNeeded();
    const t0 = Date.now();
    await page.locator("#churnAdd").click();
    const ok = await page
      .waitForFunction((sel) => document.querySelectorAll(`#churn ${sel}`).length >= 1, BADGE_SEL, { timeout: 3500 })
      .then(() => true)
      .catch(() => false);
    record("ui", "re-scan is not starved by continuous mutation (debounce max-wait)", ok, `${Date.now() - t0} ms`);
  }

  // A16: hover card — 4-bucket distribution bar + Copy text action; copy puts the
  // paragraph (not the chip label) on the clipboard.
  {
    await page.locator("#copysrc").scrollIntoViewIfNeeded();
    const badge = page.locator(`#copysrc ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.hover();
      await page.waitForTimeout(420);
      const parts = await page.evaluate((sel) => {
        const host = document.querySelector(`#copysrc ${sel}`);
        const card = host?.shadowRoot?.querySelector(".card");
        if (!card) return null;
        const meter = !!card.querySelector(".dist .scale .marker") && card.querySelectorAll(".dist .drow").length === 4;
        const btn = card.querySelector(".act.copy");
        if (btn) btn.click();
        return { meter, hasCopy: !!btn };
      }, BADGE_SEL);
      await page.waitForTimeout(250);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      ok =
        !!parts && parts.meter && parts.hasCopy &&
        (clip === null || (clip.includes("COPYSRC paragraph exists") && !/(?:^|\s)(?:\.\d\d|1\.0)(?:\s|$)/.test(clip)));
      note = JSON.stringify({ ...parts, clip: clip?.slice(0, 40) });
    }
    record("ui", "hover card: distribution readout + working Copy text action", ok, note);
    await page.mouse.move(5, 400);
  }

  // A17: triage panel — opens from the counter and lists AI-generated paragraphs only.
  {
    const r = await page.evaluate(() => {
      const fab = document.getElementById("anagram-fab");
      const sr = fab?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const panel = sr?.querySelector(".panel");
      const open = !!panel?.classList.contains("open");
      const items = panel?.querySelectorAll(".pitem").length ?? 0;
      const others = panel?.querySelectorAll(".pitem:not(.band-ai)").length ?? -1;
      const chips = panel?.querySelectorAll(".pfilters, .fchip[aria-pressed]").length ?? -1;
      // close it again
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return { open, items, others, chips };
    });
    record("ui", "triage panel opens and lists AI-generated paragraphs only, with no verdict filters", r.open && r.items > 0 && r.others === 0 && r.chips === 0, JSON.stringify(r));
  }

  // A18: FAB drag → snaps to the nearest edge and remembers the side.
  {
    const ball = page.locator("#anagram-fab .fab").first();
    await ball.hover().catch(() => {}); // untuck first — a tucked ball sits half off-screen
    await page.waitForTimeout(350);
    const box = await ball.boundingBox();
    let r = null;
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(140, 300, { steps: 8 }); // drop near the LEFT edge
      await page.mouse.up();
      await page.waitForTimeout(400);
      r = await page.evaluate(() => {
        const stack = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack");
        return {
          left: stack?.style.left,
          sideLeft: stack?.classList.contains("side-left"),
        };
      });
    }
    record("ui", "FAB snaps to the left edge after drag", !!r && r.left === "12px" && r.sideLeft, JSON.stringify(r));
  }

  // A19: idle tuck — the ball slides half off the edge after a few seconds and
  // returns on hover.
  {
    await page.mouse.move(600, 300); // pointer far away, no interactions
    await page.waitForTimeout(4300);
    const tucked = await page.evaluate(
      () => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack.tucked"),
    );
    const ball = page.locator("#anagram-fab .fab").first();
    await ball.hover().catch(() => {});
    await page.waitForTimeout(350);
    const untucked = await page.evaluate(
      () => !document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack.tucked"),
    );
    record("ui", "FAB tucks when idle and returns on hover", tucked && untucked, JSON.stringify({ tucked, untucked }));
  }

  record("ui", "no extension console errors on fixtures", extErrors.length === 0, extErrors.join(" | "));
  await page.screenshot({ path: artifact("scn-ui-fixtures.png"), fullPage: true });
  await page.close();

  // A20: "main content" scope pulls Readability in as an on-demand vendor chunk —
  // import()ed by extension URL from the content script's isolated world (a
  // web-accessible resource). Debug logging on → the orchestrator says so.
  {
    const extId = sw ? new URL(sw.url()).host : null;
    let r = { loaded: false, failed: false, badges: 0 };
    if (extId) {
      const opt = await context.newPage();
      await opt.goto(`chrome-extension://${extId}/options.html`);
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: true, analysisScope: "main" }, res)));
      const p = await context.newPage();
      const logs = [];
      p.on("console", (m) => logs.push(m.text()));
      await p.goto(fixturesUrl, { waitUntil: "load" });
      await p.waitForFunction(() => false, null, { timeout: 2500 }).catch(() => {});
      await p.waitForSelector(BADGE_SEL, { timeout: 10000 }).catch(() => {});
      r = {
        loaded: logs.some((l) => l.includes("Readability chunk loaded")),
        failed: logs.some((l) => l.includes("Readability chunk failed")),
        badges: await p.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL),
      };
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: false, analysisScope: "page" }, res)));
      await p.close();
      await opt.close();
    }
    record("ui", "main-content scope loads the Readability vendor chunk on demand", r.loaded && !r.failed && r.badges > 0, JSON.stringify(r));
  }

  // A22: a page that replaces its own <html> after load (document.open()/write(),
  // as challenge interstitials and legacy frameworks do) — the extension must restart
  // on the new tree: chips on the new paragraphs, ball present, marks painted.
  {
    const p = await context.newPage();
    await p.goto(server.url("/rewrite.html"), { waitUntil: "load" });
    // Settled chips (not the "analyzing…" ones inserted at dispatch) — marks land with the verdict.
    const ok = await p.waitForFunction((sel) => {
      const hosts = [...document.querySelectorAll(`#rw1 ${sel}, #rw2 ${sel}`)];
      return hosts.length === 2 && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending")) && !!document.getElementById("anagram-fab") && document.title === "rewritten";
    }, BADGE_SEL, { timeout: 20000 }).then(() => true).catch(() => false);
    const marks = await p.evaluate(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; }).catch(() => -1);
    record("ui", "self-rewriting page (document.open/write): chips, ball and marks on the new tree", ok && marks >= 2, JSON.stringify({ ok, marks }));
    await p.close();
  }

  // A22b: the browser translates the page. Chrome's page translation replaces every text
  // node with <font> copies holding the translation and classes <html> `translated-ltr`;
  // "Show original" puts the nodes back and drops the class. Machine output is nobody's
  // writing: while the class is there nothing is sent, and no chip, mark or ball is left;
  // once it is gone the page is read again.
  {
    PAGES["/translated.html"] = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>translated fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<main><p id="t1">${PARA("ORIGINAL-ONE")}</p><p id="t2">${PARA("ORIGINAL-TWO")}</p></main>
<script>
  const saved = [];
  window.__translate = () => {
    for (const p of document.querySelectorAll("main p")) {
      const text = p.firstChild;
      saved.push([p, text]);
      const outer = document.createElement("font");
      const inner = document.createElement("font");
      outer.style.verticalAlign = inner.style.verticalAlign = "inherit";
      inner.textContent = text.data.replace("ORIGINAL", "MACHINE");
      outer.appendChild(inner);
      p.replaceChild(outer, text);
    }
    document.documentElement.classList.add("translated-ltr");
  };
  window.__revert = () => {
    for (const [p, text] of saved.splice(0)) p.replaceChildren(text);
    document.documentElement.classList.remove("translated-ltr");
  };
</script></body></html>`;
    const p = await context.newPage();
    await p.goto(server.url("/translated.html"), { waitUntil: "load" });
    const settled = (n) =>
      p.waitForFunction(({ sel, n }) => {
        const hosts = [...document.querySelectorAll(sel)];
        return hosts.length === n && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
      }, { sel: BADGE_SEL, n }, { timeout: 15000 }).then(() => true).catch(() => false);
    const look = () =>
      p.evaluate((sel) => {
        let marks = 0;
        for (const h of CSS.highlights.values()) marks += h.size;
        return { chips: document.querySelectorAll(sel).length, ball: !!document.getElementById("anagram-fab"), marks };
      }, BADGE_SEL);
    const tabState = () =>
      sw?.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        return tab ? chrome.tabs.sendMessage(tab.id, { action: "getTabState" }, { frameId: 0 }) : null;
      }, server.url("/translated.html")).catch(() => null);
    const before = (await settled(2)) ? await look() : null;
    await p.evaluate(() => window.__translate());
    await p.waitForTimeout(3000); // past the observers' debounce, the scheduler and the fixture
    const during = await look();
    const duringState = await tabState();
    const machineSent = fixture.stats.texts.some((t) => t.includes("MACHINE-"));
    await p.evaluate(() => window.__revert());
    await settled(2);
    const back = await look();
    record(
      "ui",
      "a page the browser translated: nothing is read or left on it while it is translated, and it is read again once the original is back",
      !!before && before.chips === 2 && before.ball &&
        during.chips === 0 && !during.ball && during.marks === 0 && !machineSent && duringState?.translated === true &&
        back.chips === 2 && back.ball && back.marks > 0,
      JSON.stringify({ before, during, duringState, machineSent, back }),
    );
    await p.close();
  }

  // A21: the fixture goes away → the batch in flight renders "Unavailable", nothing new
  // is dispatched, the ball's counter shows "!"; the fixture comes back → everything is
  // re-queued automatically (no reload, no Rescan). Twice: a paragraph under 510 bytes
  // meets the dead socket with its score request, a longer one with its token count.
  for (const [path, repeat] of [["score", 1], ["count", 2]]) {
    const p = await context.newPage();
    await p.goto(fixturesUrl, { waitUntil: "load" });
    await p.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
    // Over the floor and under 510 bytes once; twice that the second time, so the text
    // first asks the engine for a token count, and that request meets the dead socket.
    const addPara = (id) =>
      p.evaluate(({ pid, times }) => {
        const el = document.createElement("p");
        el.id = pid;
        el.textContent = Array.from({ length: times }, () => `${pid.toUpperCase()} paragraph is appended while the scoring fixture is stopped, so ` +
          "the extension must not invent a verdict for it: the batch that hits the dead socket renders as " +
          "Unavailable and later paragraphs wait without any chip, until a health probe succeeds again and " +
          "every waiting or unavailable unit is queued once more without a reload or a manual rescan. " +
          "Till then, a reader has to be able to tell a unit that waits from one that was read, and a fault from a verdict.").join(" ");
        document.querySelector("main").prepend(el);
      }, { pid: `${id}${path}`, times: repeat });
    const badgeIn = (id, timeout) =>
      p.waitForFunction(({ sel, pid }) => document.querySelectorAll(`#${pid} ${sel}`).length >= 1, { sel: BADGE_SEL, pid: id }, { timeout }).then(() => true).catch(() => false);
    // Settled = past the "analyzing…" state (the pending chip is inserted at dispatch,
    // BEFORE the reply that flips the page into the down state).
    const settledIn = (id, timeout) =>
      p.waitForFunction(({ sel, pid }) => {
        const pill = document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill");
        return !!pill && !pill.classList.contains("pending");
      }, { sel: BADGE_SEL, pid: id }, { timeout }).then(() => true).catch(() => false);
    const bandOf = (id) => p.evaluate(({ sel, pid }) => [...(document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill")?.classList ?? [])].find((c) => c.startsWith("band-")) ?? null, { sel: BADGE_SEL, pid: id });
    const bubble = () => p.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);

    await fixture.close(); // connection refused from here on
    await addPara("down1");
    const gotDown1 = (await badgeIn(`down1${path}`, 8000)) && (await settledIn(`down1${path}`, 8000));
    const band1 = await bandOf(`down1${path}`);
    await addPara("down2");
    await p.waitForTimeout(2000);
    const down2Chips = await p.evaluate(({ sel, pid }) => document.querySelectorAll(`#${pid} ${sel}`).length, { sel: BADGE_SEL, pid: `down2${path}` });
    const bubbleDown = await bubble();
    record("ui", `fixture down (${path} request): in-flight batch renders Unavailable, later paragraphs get no chip, counter shows !`, gotDown1 && band1 === "band-unknown" && down2Chips === 0 && bubbleDown === "!", JSON.stringify({ band1, down2Chips, bubbleDown }));

    await fixture.resume(); // same native registration
    const back1 = await badgeIn(`down2${path}`, 20000);
    const back2 = await p.waitForFunction(({ sel, pid }) => {
      const pill = document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill");
      return !!pill && !pill.classList.contains("band-unknown") && !pill.classList.contains("pending");
    }, { sel: BADGE_SEL, pid: `down1${path}` }, { timeout: 20000 }).then(() => true).catch(() => false);
    const bubbleUp = await bubble();
    record("ui", `fixture back (${path} request): waiting + Unavailable units re-queued automatically`, back1 && back2 && bubbleUp !== "!", JSON.stringify({ back1, back2, bubbleUp }));
    await p.close();
  }

  // A23: the FIRST scan already obeys the stored scope. With "Main content only" chosen
  // before the page opens, the paragraph outside the article must never be chipped —
  // and its text must never reach the fixture, not even during the few hundred
  // milliseconds the settings read used to leave the page scanning whole-page defaults.
  {
    const extId = sw ? new URL(sw.url()).host : null;
    let r = { inMain: 0, outside: 0, leaked: null };
    if (extId) {
      const opt = await context.newPage();
      await opt.goto(`chrome-extension://${extId}/options.html`);
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ analysisScope: "main" }, res)));
      const p = await context.newPage();
      await p.goto(server.url("/scope.html"), { waitUntil: "load" });
      await p.waitForSelector(`main ${BADGE_SEL}`, { timeout: 12000 }).catch(() => {});
      await sweep(p, 3);
      await p.waitForTimeout(2500);
      r = {
        inMain: await p.evaluate((sel) => document.querySelectorAll(`main ${sel}`).length, BADGE_SEL),
        outside: await p.evaluate((sel) => document.querySelectorAll(`#offmain ${sel}`).length, BADGE_SEL),
        // Read BEFORE the setting is restored — restoring re-scans the page whole.
        leaked: fixture.stats.texts.some((t) => t.includes(SCOPE_MARKER)),
      };
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ analysisScope: "page" }, res)));
      await p.close();
      await opt.close();
    }
    record("ui", "main-content scope holds from the first scan: nothing outside is chipped or sent", r.inMain > 0 && r.outside === 0 && r.leaked === false, JSON.stringify(r));
  }

  // A24: the selection card's ✕ closes it WHILE the request is in flight. The listener
  // used to be attached after the await, so for as long as the fixture took (up to 25 s)
  // the button did nothing.
  {
    const p = await context.newPage();
    await p.goto(server.url("/stall.html"), { waitUntil: "load" });
    await p.bringToFront();
    await p.evaluate(() => {
      const ta = document.getElementById("draft");
      ta.focus();
      ta.setSelectionRange(0, ta.value.length);
    });
    // Exactly what the context menu does: the service worker messages the active tab.
    const t0 = Date.now();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "analyzeSelection" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    // The card host is a plain badge host appended to <body>; only IT holds a .close.
    const analyzing = await p
      .waitForFunction(
        (sel) => {
          const host = [...document.querySelectorAll(sel)].find((h) => h.shadowRoot?.querySelector(".card .close"));
          return !!host && /Analyzing/.test(host.shadowRoot.querySelector(".verdict")?.textContent ?? "");
        },
        BADGE_SEL,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    const clicked = await p
      .locator(`div[data-anagram="host"] .close`)
      .click({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    const gone = await p
      .waitForFunction(
        (sel) => ![...document.querySelectorAll(sel)].some((h) => h.shadowRoot?.querySelector(".card .close")),
        BADGE_SEL,
        { timeout: 3000 },
      )
      .then(() => true)
      .catch(() => false);
    const elapsed = Date.now() - t0;
    record(
      "ui",
      "selection card: ✕ closes it while the fixture is still thinking",
      analyzing && clicked && gone && elapsed < STALL_MS,
      JSON.stringify({ analyzing, clicked, gone, elapsed }),
    );
    await p.close();
  }

  // A24b: a selection longer than the model reads in one pass is read COMPLETELY — in
  // windows, all in one request — so "Words analyzed" is the selection again, not the
  // "first N" of it. Runs before anything else has scored this text, so the blocks the
  // fixture saw are this card's own.
  {
    const p = await context.newPage();
    await p.goto(server.url("/longsel.html"), { waitUntil: "load" });
    await p.bringToFront();
    await p.evaluate(() => {
      const ta = document.getElementById("draft");
      ta.focus();
      ta.setSelectionRange(0, ta.value.length);
    });
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "analyzeSelection" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    const rows = await p
      .waitForFunction(
        (sel) => {
          const card = [...document.querySelectorAll(sel)].map((h) => h.shadowRoot?.querySelector(".card")).find((c) => c?.querySelector(".close"));
          if (!card?.querySelector(".dist")) return null;
          return Object.fromEntries([...card.querySelectorAll(".row")].map((r) => [r.querySelector(".k").textContent, r.querySelector(".v").textContent]));
        },
        BADGE_SEL,
        { timeout: 12000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    const blocks = [...new Set(fixture.stats.texts.filter((t) => t.length > 200 && WINDOWED_TEXT.includes(t)))]
      .sort((a, b) => WINDOWED_TEXT.indexOf(a) - WINDOWED_TEXT.indexOf(b));
    const passRow = rows && Object.keys(rows).find((k) => /^Read in \d+ passes$/.test(k));
    const ok =
      !!rows &&
      Number(rows["Words selected"]) > 600 &&
      rows["Words analyzed"] === rows["Words selected"] &&
      !!passRow && passRow === `Read in ${blocks.length} passes` &&
      new RegExp(`^(\\.\\d\\d|1\\.0)(\\s·\\s(\\.\\d\\d|1\\.0)){${blocks.length - 1}}$`).test(rows[passRow]) &&
      !("Model window" in rows) &&
      blocks.length >= 3 &&
      readWhole(blocks, WINDOWED_TEXT);
    record("ui", "selection card: a long selection is analyzed whole, in overlapping passes — words analyzed = words selected", ok, JSON.stringify({ rows, blocks: blocks.map((t) => t.length) }));
    await p.close();
  }

  // A25: the copied report carries no per cent sign on a score at all — the number is an
  // estimate of EDITING EXTENT on 0-1, not a share of AI-written words, and not a
  // probability — and it carries the legend that says so.
  {
    const p = await context.newPage();
    await p.goto(fixturesUrl, { waitUntil: "load" });
    await p.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
    await sweep(p, 6);
    await p.waitForTimeout(2500);
    await p.evaluate(() => navigator.clipboard.writeText("NO REPORT COPIED").catch(() => {}));
    const clicked = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const copy = sr?.querySelector(".pcopy");
      if (!copy) return false;
      copy.click();
      return true;
    });
    await p.waitForTimeout(500);
    const report = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
    const ok =
      clicked &&
      typeof report === "string" &&
      report.startsWith("# Anagram analysis report") &&
      !report.includes("% AI") &&
      // Every flagged entry opens "1. **AI-generated · .96** (…", never with a percentage.
      report.split(/\r?\n/).filter((l) => /^\d+\. \*\*/.test(l)).every((l) => /^\d+\. \*\*[^*]+ · (\.\d\d|1\.0)\*\*/.test(l)) &&
      report.includes("not the fraction of AI-written words");
    record("ui", "copied report: bare 0-1 scores plus the legend that explains them", ok, JSON.stringify({ clicked, head: report?.slice(0, 48) }));
    await p.close();
  }

  // A25b: a flagged paragraph that was read in passes says so in the report, with each
  // pass's own number — whoever reads the report has no underline to look at.
  {
    const p = await context.newPage();
    await p.goto(server.url("/windows.html"), { waitUntil: "load" });
    const chipped = await p
      .waitForFunction((sel) => /^(\.\d\d|1\.0)$/.test(document.querySelector(`#wp ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent ?? ""), BADGE_SEL, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    await p.evaluate(() => navigator.clipboard.writeText("NO REPORT COPIED").catch(() => {}));
    await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      sr?.querySelector(".pcopy")?.click();
    });
    await p.waitForTimeout(500);
    const report = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
    // Windows hands the clipboard back with CRLF line ends; the report itself is LF.
    const line = (report ?? "").split(/\r?\n/).find((l) => l.startsWith("1. ")) ?? "";
    const ok = chipped && /; \d+ words; read in \d+ passes: (\.\d\d|1\.0)( · (\.\d\d|1\.0))+\)$/.test(line) && !line.includes("not read");
    record("ui", "copied report: a paragraph read in passes says so, with each pass's own number", ok, JSON.stringify({ chipped, line }));
    await p.close();
  }

  // A25c: a paragraph short in characters and long in tokens (figures, URLs, names) is not
  // left half-read. The engine's count plans it into passes that fit; where the reading still
  // comes back `truncated`, both halves are sent back for a second reading, and when even a
  // half overflows, the card says so.
  {
    const p = await context.newPage();
    await p.goto(server.url("/dense.html"), { waitUntil: "load" });
    const cards = await p
      .waitForFunction(
        (sel) => {
          const read = (id) => {
            const root = document.querySelector(`#${id} ${sel}`)?.shadowRoot;
            if (!root?.querySelector(".card .head")) return null;
            const rows = Object.fromEntries([...root.querySelectorAll(".card .row")].map((r) => [r.querySelector(".k").textContent, r.querySelector(".v").textContent]));
            return { rows, foot: root.querySelector(".card .foot").textContent };
          };
          const dense = read("dense");
          const solid = read("solid");
          return dense && solid ? { dense, solid } : null;
        },
        BADGE_SEL,
        { timeout: 12000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    const inOrder = (texts, whole) => texts.sort((a, b) => whole.indexOf(a) - whole.indexOf(b));
    const dense = DENSE_PARA(DENSE_MARKER);
    const sent = inOrder([...new Set(fixture.stats.texts.filter((t) => t.includes(DENSE_MARKER)))], dense);
    const solid = SOLID_PARA(SOLID_MARKER);
    const halves = inOrder([...new Set(fixture.stats.texts.filter((t) => t.includes(SOLID_MARKER) && t !== solid))], solid);
    const ok =
      !!cards &&
      `Read in ${sent.length} passes` in cards.dense.rows &&
      !("Passes cut short" in cards.dense.rows) &&
      !/not read/.test(cards.dense.foot) &&
      !sent.includes(dense) && readWhole(sent, dense) && sent.every((t) => fakeTokens(t) <= 510) &&
      fixture.stats.texts.includes(solid) &&
      halves.length === 2 &&
      halves.join(" ") === solid &&
      cards.solid.rows["Passes cut short"] === "2 of 2" &&
      /too dense for one pass of the model and was not read/.test(cards.solid.foot);
    record("ui", "dense text: counted tokens plan a dense paragraph into passes; one the engine still cuts is re-read in two halves, and says so", ok, JSON.stringify({ cards: cards && { dense: cards.dense.rows, solid: cards.solid.rows }, sent: sent.map((t) => t.length), halves: halves.map((t) => t.length) }));
    await p.close();
  }

  // A26/A27: the chips are aria-hidden and unfocusable by design, so the panel is the
  // accessible route to the verdicts — it has to be reachable, focusable and closable
  // without a pointer, and the three commands have to work. Chrome swallows the real
  // key combinations before the page sees them, so the commands are driven exactly the
  // way background.ts drives them: a message from the service worker to the active tab.
  {
    const p = await context.newPage();
    await p.bringToFront();
    await p.goto(server.url("/keyboard.html"), { waitUntil: "load" });
    const settled = await p
      .waitForFunction(
        (sel) => {
          const hosts = [...document.querySelectorAll(sel)];
          return hosts.length >= 4 && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
        },
        BADGE_SEL,
        { timeout: 25000 },
      )
      .then(() => true)
      .catch(() => false);

    // A26: Tab-reachable button → Enter opens and hands over focus → Escape gives it back.
    const counter = p.locator("#anagram-fab .count");
    const tag = await counter.evaluate((el) => el.tagName).catch(() => null);
    await counter.focus().catch(() => {});
    const onCounter = await p.evaluate(() => {
      const host = document.getElementById("anagram-fab");
      const c = host?.shadowRoot?.querySelector(".count");
      return {
        focused: document.activeElement === host && host.shadowRoot.activeElement === c,
        label: c?.getAttribute("aria-label") ?? null,
        expanded: c?.getAttribute("aria-expanded") ?? null,
        untucked: !host?.shadowRoot?.querySelector(".stack.tucked"),
      };
    });
    await p.keyboard.press("Enter");
    await p.waitForTimeout(400);
    const opened = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      const panel = sr?.querySelector(".panel");
      const named = panel?.getAttribute("aria-labelledby");
      return {
        open: !!panel?.classList.contains("open"),
        role: panel?.getAttribute("role") ?? null,
        name: named ? (sr.getElementById(named)?.textContent ?? null) : null,
        inPanel: !!sr?.activeElement && panel.contains(sr.activeElement),
        expanded: sr?.querySelector(".count")?.getAttribute("aria-expanded") ?? null,
        itemLabel: panel?.querySelector(".pitem")?.getAttribute("aria-label") ?? null,
      };
    });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
    const closed = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      return {
        open: !!sr?.querySelector(".panel.open"),
        backOnCounter: sr?.activeElement === sr?.querySelector(".count"),
        expanded: sr?.querySelector(".count")?.getAttribute("aria-expanded") ?? null,
      };
    });
    record(
      "ui",
      "triage panel: focusable counter button, Enter opens and takes focus, Escape returns it",
      settled && tag === "BUTTON" && onCounter.focused && onCounter.untucked &&
        opened.open && opened.role === "dialog" && !!opened.name && opened.inPanel &&
        opened.expanded === "true" && !closed.open && closed.backOnCounter && closed.expanded === "false",
      JSON.stringify({ settled, tag, onCounter, opened, closed }),
    );
    record(
      "ui",
      "accessible names carry the flagged count and each row's verdict",
      /\b4 flagged paragraphs\b/.test(onCounter.label ?? "") &&
        /^(Heavily edited|AI-generated), (0\.\d\d|1\.0): \S/.test(opened.itemLabel ?? ""),
      JSON.stringify({ label: onCounter.label, itemLabel: opened.itemLabel?.slice(0, 60) }),
    );

    // A27: the three keyboard commands, driven from the service worker.
    const cmd = (action) =>
      sw.evaluate(async (a) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        try {
          await chrome.tabs.sendMessage(tab.id, { action: a });
        } catch {
          /* the content script answers nothing to these */
        }
      }, action);

    await p.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.activeElement?.blur());
    await cmd("openPanel");
    await p.waitForTimeout(400);
    const byCommand = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      const panel = sr?.querySelector(".panel");
      return { open: !!panel?.classList.contains("open"), inPanel: !!sr?.activeElement && panel.contains(sr.activeElement) };
    });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    record("ui", "open-panel command opens the triage panel and puts the keyboard in it", byCommand.open && byCommand.inPanel, JSON.stringify(byCommand));

    // Each flagged chip's position in the document is its identity; the jump flashes the
    // chip it landed on, which is how the walk is read back.
    const flaggedAt = await p.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)]
          .filter((h) => {
            const pill = h.shadowRoot?.querySelector(".pill");
            return !!pill && (pill.classList.contains("band-heavy") || pill.classList.contains("band-ai"));
          })
          .map((h) => Math.round(h.getBoundingClientRect().top + window.scrollY))
          .sort((a, b) => a - b),
      BADGE_SEL,
    );
    const flashing = (want) =>
      p
        .waitForFunction(
          ({ sel, w }) => [...document.querySelectorAll(sel)].some((h) => !!h.shadowRoot?.querySelector(".pill.pg-flash")) === w,
          { sel: BADGE_SEL, w: want },
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false);
    const jump = async (action) => {
      await flashing(false); // let the previous pulse finish, or the read below is stale
      await cmd(action);
      await flashing(true);
      return p.evaluate((sel) => {
        for (const h of document.querySelectorAll(sel)) {
          if (h.shadowRoot?.querySelector(".pill.pg-flash")) return Math.round(h.getBoundingClientRect().top + window.scrollY);
        }
        return null;
      }, BADGE_SEL);
    };
    await p.evaluate(() => window.scrollTo(0, 0));
    const walk = { last: await jump("prevFlagged"), first: await jump("nextFlagged"), second: await jump("nextFlagged"), back: await jump("prevFlagged") };
    record(
      "ui",
      "next/prev-flagged walk the flagged paragraphs in document order and wrap around",
      flaggedAt.length === 4 &&
        walk.last === flaggedAt[3] && walk.first === flaggedAt[0] &&
        walk.second === flaggedAt[1] && walk.back === flaggedAt[0],
      JSON.stringify({ flaggedAt, walk }),
    );

    // A flagged paragraph found AFTER the others — a post a feed prepends, a reply inserted
    // above — is listed, reported and walked where it stands, not after everything found
    // before it.
    await p.evaluate(
      (html) => document.getElementById("k1").insertAdjacentHTML("beforebegin", html),
      `<p id="k0">${KEY_PARA(LATE_TAG)}</p>\n<div style="height:700px"></div>`,
    );
    const late = await p
      .waitForFunction((sel) => /^(\.\d\d|1\.0)$/.test(document.querySelector(`#k0 ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent ?? ""), BADGE_SEL, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    const pageScores = await p.evaluate(
      (sel) => ["k0", "k1", "k2", "k3", "k4"].map((id) => document.querySelector(`#${id} ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent?.trim() ?? null),
      BADGE_SEL,
    );
    await p.evaluate(() => navigator.clipboard.writeText("NO REPORT COPIED").catch(() => {}));
    const listed = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const rows = [...(sr?.querySelectorAll(".panel .pitem") ?? [])].map((r) => /: (\S+) paragraph/.exec(r.getAttribute("aria-label") ?? "")?.[1] ?? null);
      sr?.querySelector(".pcopy")?.click();
      return rows;
    });
    await p.waitForTimeout(500);
    await p.keyboard.press("Escape");
    const report = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
    const reported = (report ?? "").split(/\r?\n/).map((l) => /^\d+\. \*\*[^*]+ · (\.\d\d|1\.0)\*\*/.exec(l)?.[1]).filter(Boolean);
    const lateAt = await p.evaluate((sel) => Math.round(document.querySelector(`#k0 ${sel}`).getBoundingClientRect().top + window.scrollY), BADGE_SEL).catch(() => null);
    await p.evaluate(() => window.scrollTo(0, 0));
    const fromTop = await jump("nextFlagged");
    record(
      "ui",
      "a flagged paragraph inserted above the others comes first in the panel, the copied report and the next-flagged walk",
      late && listed.join() === [LATE_TAG, ...KEY_TAGS].join() &&
        reported.join() === pageScores.join() && fromTop !== null && fromTop === lateAt,
      JSON.stringify({ late, listed, reported, pageScores, lateAt, fromTop }),
    );
    await p.screenshot({ path: artifact("scn-keyboard-panel.png") }).catch(() => {});
    await p.close();
  }

  // A28: a cross-origin subframe follows the TOP page's site rule. It cannot read
  // window.top, and the embed's no-referrer policy takes document.referrer away too, so
  // without the worker's answer the frame keys the rule on its own hostname and keeps
  // scoring a page the reader turned Anagram off on.
  {
    const extId = sw ? new URL(sw.url()).host : null;
    const topUrl = server.url("/frame-top.html");
    const chipsIn = async (page) => {
      const frame = page.frames().find((f) => f.url().includes("/frame.html"));
      return {
        top: await page.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL),
        frame: frame ? await frame.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL) : -1,
        // The proof that the old chain is dead here: no referrer, and the frame's own
        // host is 127.0.0.1, which the rule below never names.
        referrer: frame ? await frame.evaluate(() => document.referrer) : null,
      };
    };
    let r = { on: null, off: null };
    if (extId) {
      const opt = await context.newPage();
      await opt.goto(`chrome-extension://${extId}/options.html`);

      const open = await context.newPage();
      await open.goto(topUrl, { waitUntil: "load" });
      await open.waitForSelector(BADGE_SEL, { timeout: 15000 }).catch(() => {});
      await open.frameLocator("#embed").locator(BADGE_SEL).first().waitFor({ timeout: 15000 }).catch(() => {});
      r.on = await chipsIn(open);
      await open.close();

      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ siteOverrides: { localhost: "off" } }, res)));
      const ruled = await context.newPage();
      await ruled.goto(topUrl, { waitUntil: "load" });
      await ruled.waitForTimeout(4000); // long enough that a chip would have appeared
      r.off = await chipsIn(ruled);
      await ruled.close();

      // Every later fixture is served from localhost too — the rule must not outlive this.
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ siteOverrides: {} }, res)));
      await opt.close();
    }
    record(
      "ui",
      "a no-referrer cross-origin subframe follows the top page's site rule",
      !!r.on && r.on.top > 0 && r.on.frame > 0 && r.on.referrer === "" &&
        !!r.off && r.off.top === 0 && r.off.frame === 0 && r.off.referrer === "",
      JSON.stringify(r),
    );
  }

  // A29: the Google Docs reading overlay refreshes in place. The overlay shows a
  // snapshot of the document, so its Refresh button reads the static view again and
  // swaps the paper's content: the old paragraphs leave with their chips, the new ones
  // arrive and are analyzed, and none of the overlay's own chrome is rebuilt. A failed
  // re-read must leave the snapshot on screen and give the button back. docs.google.com
  // is served locally here — a real document needs an account, and nothing in this
  // check is about Google's own markup.
  {
    const DOC = "ANAGRAMREFRESHFIXTURE";
    const EDITOR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refresh fixture - Google Docs</title></head>
<body><canvas width="600" height="400"></canvas></body></html>`;
    const mobilebasic = (v) => docsReadingHtml([PARA(`DOCVERSION${v}ONE`), PARA(`DOCVERSION${v}TWO`)], v);
    let version = 1;
    let broken = false;
    await context.route("https://docs.google.com/**", (route) => {
      const isStatic = route.request().url().includes("/mobilebasic");
      if (isStatic && broken) return route.fulfill({ status: 500, contentType: "text/html", body: "no" });
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: isStatic ? mobilebasic(version) : EDITOR,
      });
    });

    const readOverlay = (page) =>
      page.evaluate((sel) => {
        const sr = document.getElementById("anagram-docs-overlay")?.shadowRoot;
        const paper = sr?.querySelector(".paper");
        const refresh = sr?.querySelector("#anagram-ovl-refresh");
        return {
          hosts: document.querySelectorAll("#anagram-docs-overlay").length,
          bars: sr ? sr.querySelectorAll(".bar").length : 0,
          // The bar and the notice carry the marker attribute too — only the paper's
          // own hosts are chips.
          chips: paper ? paper.querySelectorAll(sel).length : 0,
          v1: !!paper?.textContent.includes("DOCVERSION1"),
          v2: !!paper?.textContent.includes("DOCVERSION2"),
          title: sr?.querySelector(".bar .t")?.textContent ?? "",
          refreshable: refresh ? !refresh.disabled : false,
        };
      }, BADGE_SEL);
    const chipped = (page, marker) =>
      page.waitForFunction(
        ([sel, want]) => {
          const paper = document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector(".paper");
          return !!paper && paper.textContent.includes(want) && paper.querySelectorAll(sel).length >= 2;
        },
        [BADGE_SEL, marker],
        { timeout: 25000 },
      ).then(() => true).catch(() => false);

    const doc = await context.newPage();
    await doc.goto(`https://docs.google.com/document/d/${DOC}/edit`, { waitUntil: "load" });
    const clickFab = () =>
      doc.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.click());
    await doc
      .waitForFunction(
        () => document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.textContent === "Analyze document",
        null,
        { timeout: 20000 },
      )
      .catch(() => {});
    await clickFab();
    const opened = await chipped(doc, "DOCVERSION1");
    const before = await readOverlay(doc);

    version = 2;
    await doc.evaluate(() =>
      document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector("#anagram-ovl-refresh")?.click(),
    );
    const swapped = await chipped(doc, "DOCVERSION2");
    await doc.waitForTimeout(1500);
    const after = await readOverlay(doc);

    broken = true;
    await doc.evaluate(() =>
      document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector("#anagram-ovl-refresh")?.click(),
    );
    await doc.waitForTimeout(2500);
    const failed = await readOverlay(doc);
    await doc.screenshot({ path: artifact("scn-docs-refresh.png") }).catch(() => {});
    await doc.close();
    await context.unroute("https://docs.google.com/**");

    record(
      "ui",
      "the Docs reading overlay re-reads the document in place",
      opened && swapped && before.v1 && before.chips === 2 &&
        after.v2 && !after.v1 && after.chips === 2 && after.hosts === 1 && after.bars === 1 &&
        after.title.includes("v2") && after.refreshable,
      JSON.stringify({ before, after }),
    );
    record(
      "ui",
      "a failed re-read leaves the snapshot on screen",
      failed.v2 && !failed.v1 && failed.chips === 2 && failed.hosts === 1 && failed.refreshable,
      JSON.stringify(failed),
    );
  }
  // A30–A34: a real PDF is handed to the full PDF.js viewer and shown as-is, with the
  // ORDINARY pipeline over them: the same chips, the same underlines, the same ball and
  // panel, the same copied report. The reconstruction is invisible and is only asserted
  // through what it decides: what reaches the fixture, and where a chip lands.
  const extId = sw ? new URL(sw.url()).host : null;
  /** Use the normal source-tab handoff, including the source permission/ticket checks. */
  const openReader = (path) => openPdfInReader(context, fileUrl(path));
  const readerReady = (page) => page.waitForFunction(
    () => !!window.PDFViewerApplication?.pdfDocument && !!document.querySelector("#viewer .textLayer span"),
    null, { timeout: 30000 },
  );
  // The upstream viewer scrolls its own container and materializes nearby text layers.
  const visitPdfPage = async (page, number) => {
    await page.locator("#pageNumber").fill(String(number));
    await page.locator("#pageNumber").press("Enter");
    await page.waitForFunction((n) => window.PDFViewerApplication.page === n &&
      window.PDFViewerApplication.pdfViewer.getPageView(n - 1)?.renderingState === 3 &&
      !!document.querySelector(`#viewer .page[data-page-number="${n}"] .textLayer span`),
      number, { timeout: 30000 });
  };
  const visitShortPdf = async (page) => {
    await readerReady(page);
    const count = await page.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages);
    for (let number = 1; number <= count; number++) await visitPdfPage(page, number);
    await visitPdfPage(page, 1);
  };

  /** Everything about the reader page that a check below reads, in one pass. */
  const readReader = (p) =>
    p.evaluate((sel) => {
      const chips = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
      const spans = [...document.querySelectorAll(".textLayer span")];
      const rects = spans.map((s) => s.getBoundingClientRect());
      const placed = chips.map((h) => {
        const r = h.getBoundingClientRect();
        const box = h.closest(".page").getBoundingClientRect();
        return {
          page: Number(h.closest(".page").dataset.pageNumber),
          inPage:
            r.left >= box.left - 1 && r.right <= box.right + 1 &&
            r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
          // Half a pixel of tolerance: a chip that ends exactly where a span begins is
          // beside the text, not over it.
          overText: rects.some(
            (s) => s.width > 0 && r.left < s.right - 0.5 && s.left + 0.5 < r.right &&
                   r.top < s.bottom - 0.5 && s.top + 0.5 < r.bottom,
          ),
        };
      });
      let marks = 0;
      const marked = [];
      for (const h of CSS.highlights?.values() ?? []) {
        marks += h.size;
        for (const range of h) marked.push(range.toString());
      }
      return {
        pages: window.PDFViewerApplication.pdfDocument.numPages,
        spans: spans.length,
        // The pages that have been DRAWN: a released or never-drawn canvas has no bitmap.
        drawn: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0).length,
        text: spans.map((s) => s.textContent).join(" "),
        chips: chips.length,
        placed,
        marks,
        marked,
        scale: window.PDFViewerApplication.pdfViewer.currentScale,
        title: document.title,
        notice: document.getElementById("notice").textContent,
      };
    }, BADGE_SEL);

  if (extId) {
    const p = await context.newPage();
    const extErrors = [];
    p.on("console", (m) => {
      // Only what OUR page said. The tab starts on the PDF itself, and the browser's own
      // viewer asking the fixture server for a favicon it does not serve is not our news.
      if (m.type() === "error" && (m.location()?.url ?? "").startsWith("chrome-extension://")) {
        extErrors.push(m.text().slice(0, 140));
      }
    });
    const seen = fixture.stats.texts.length; // what THIS document sends, not the whole run
    await p.goto(fileUrl("/doc.pdf"), { waitUntil: "load" }).catch(() => {});
    await handOverPdf(p);
    await visitShortPdf(p);
    // The reader's own chrome (the bar, the notice, the pages) carries the same
    // data-anagram marker as a badge host, so a chip here is a host with a pill in it.
    await p
      .waitForFunction((sel) => {
        const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
        return pills.length >= 3 && !pills.some((h) => h.shadowRoot.querySelector(".pill.pending"));
      }, BADGE_SEL, { timeout: 20000 })
      .catch(() => {});

    const page = await readReader(p);
    const sent = fixture.stats.texts.slice(seen);
    const first = PDF_PARAS[0].join(" "), last = PDF_PARAS[3].join(" ");
    const continuation = PDF_PARAS[1].join(" ").replace("hyphen- ation", "hyphenation").replace("state-of-the- art", "state-of-the-art");
    const tail = PDF_PARAS[2].join(" ");
    // A rendered page may be scored before its neighbor arrives. Only these exact
    // source-derived units are valid; the final map must include the joined paragraph.
    const allowed = new Set([first, continuation, tail, `${continuation} ${tail}`, last]);

    record(
      "ui",
      "PDF reader: rendered paragraphs reach the fixture and adjacent pages join without invented text",
      sent.includes(first) && sent.includes(last) && sent.includes(`${continuation} ${tail}`) &&
        sent.every((text) => allowed.has(text)),
      JSON.stringify({ sent: sent.map((t) => t.slice(0, 32)) }),
    );
    record(
      "ui",
      "PDF reader: the running head and the page numbers never leave the page for the fixture",
      sent.every((t) => !t.includes(PDF_HEAD)) &&
        sent.every((t) => !/\s[12]\s/.test(t)) &&
        // …and they are still THERE, because the reader shows the document as it is.
        page.text.includes(PDF_HEAD),
      JSON.stringify({ inSent: sent.some((t) => t.includes(PDF_HEAD)), onPage: page.text.includes(PDF_HEAD) }),
    );
    record(
      "ui",
      "PDF reader: a broken word is mended and a real compound keeps its hyphen",
      sent.join(" ").includes("hyphenation mark is joined") &&
        !sent.join(" ").includes("hyphen- ation") &&
        sent.join(" ").includes("compound such as state-of-the-art keeps"),
      JSON.stringify({ sample: sent[1]?.slice(60, 210) }),
    );
    record(
      "ui",
      "PDF reader: the real pages are drawn, with a selectable text layer over every one",
      page.pages === 2 &&
        page.drawn === 2 &&
        page.spans > 0 &&
        PDF_PARAS.every((lines) => page.text.includes(lines[0])) &&
        page.text.includes(PDF_HEADING) &&
        page.title === "doc.pdf" &&
        extErrors.length === 0,
      JSON.stringify({ pages: page.pages, drawn: page.drawn, spans: page.spans, errors: extErrors.slice(0, 2) }),
    );
    record(
      "ui",
      "PDF reader: one chip per scored paragraph, inside its page and never over the text",
      page.chips === 3 &&
        page.placed.every((c) => c.inPage) &&
        page.placed.every((c) => !c.overText),
      JSON.stringify({ chips: page.chips, placed: page.placed }),
    );
    record(
      "ui",
      "PDF reader: the marks lie on the paragraph's own glyphs, not on the whole page",
      page.marks >= 20 &&
        page.marked.some((t) => t.startsWith("Anagram rebuilds this document")) &&
        page.marked.every((t) => !t.includes(PDF_HEAD)),
      JSON.stringify({ marks: page.marks, first: page.marked[0]?.slice(0, 40) }),
    );

    // Upstream may replace text nodes on zoom. Anagram must restore mapping and use cached scores.
    const requestsBefore = fixture.stats.requests;
    await p.locator("#zoomInButton").click();
    await visitShortPdf(p);
    await p.waitForFunction((sel) => [...document.querySelectorAll(sel)].filter((host) =>
      host.shadowRoot?.querySelector(".pill:not(.pending)")).length === 3, BADGE_SEL, { timeout: 15000 });
    const zoomed = await readReader(p);
    record(
      "ui",
      "PDF reader: zoom restores chips and mapped marks without requesting the same scores again",
      zoomed.scale > page.scale && zoomed.chips === page.chips &&
        zoomed.marks === page.marks &&
        zoomed.placed.every((c) => c.inPage && !c.overText) &&
        fixture.stats.requests === requestsBefore,
      JSON.stringify({ from: page.scale.toFixed(2), to: zoomed.scale.toFixed(2), chips: zoomed.chips, marks: zoomed.marks }),
    );

    // The ball, its panel, and the report — the report must name the PDF, not the
    // chrome-extension:// address of the page it happens to be rendered on.
    // PDF.js is still re-rendering pages after the zoom above, and the reader re-reads each
    // page it re-renders: for a moment that page's paragraphs are waiting for their (cached)
    // verdicts again. The panel is drawn when it opens and the report when it is copied, so
    // the two are compared once the reader has settled — the panel reopened each time.
    let panel = { open: false, items: -1 };
    let report = null;
    let flagged;
    for (let attempt = 0; attempt < 10; attempt++) {
      await p.evaluate(() => navigator.clipboard.writeText("NO REPORT COPIED").catch(() => {}));
      panel = await p.evaluate(async () => {
        const sr = document.getElementById("anagram-fab")?.shadowRoot;
        const toggle = () => sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        if (sr?.querySelector(".panel.open")) {
          toggle();
          await new Promise((r) => setTimeout(r, 200));
        }
        toggle();
        await new Promise((r) => setTimeout(r, 400));
        sr?.querySelector(".pcopy")?.click();
        await new Promise((r) => setTimeout(r, 300));
        return { open: !!sr?.querySelector(".panel.open"), items: sr?.querySelectorAll(".pitem").length ?? -1 };
      });
      report = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
      flagged = (report ?? "").match(/· Flagged: (\d+)/)?.[1];
      if (panel.items === Number(flagged)) break;
      await p.waitForTimeout(500);
    }
    record(
      "ui",
      "PDF reader: the panel lists the flagged paragraphs and Copy report carries the scope note",
      panel.open &&
        panel.items === Number(flagged) &&
        typeof report === "string" &&
        // Reports omit titles and URLs unless the user opts in, so the PDF is named by its scope note only.
        report.startsWith("# Anagram analysis report") &&
        report.includes("not a complete document assessment"),
      JSON.stringify({ panel, flagged, head: (report ?? "").slice(0, 60) }),
    );
    await p.screenshot({ path: artifact("scn-pdf-reader.png"), fullPage: false }).catch(() => {});
    await p.close();
  }

  // A30b: the SHORT paragraphs of a paper. On a web page three short paragraphs of one
  // voice are read together and the chip says ×3; in a PDF they used to be dropped one by
  // one. The rules are now the same ones (lib/plan/group.ts), with the reconstruction
  // supplying the barriers — so the three under the first heading are one unit and the two
  // under the second, 48 words with nothing of their section to join, are read by nobody.
  if (extId) {
    const seen = fixture.stats.texts.length;
    const p = await openReader("/grouped.pdf");
    await visitShortPdf(p);
    await p
      .waitForFunction((sel) => {
        const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
        return pills.length >= 1 && !pills.some((h) => h.shadowRoot.querySelector(".pill.pending"));
      }, BADGE_SEL, { timeout: 20000 })
      .catch(() => {});
    const grouped = await readReader(p);
    const groupedSent = fixture.stats.texts.slice(seen);
    const chipNum = await p.evaluate((sel) => {
      const host = [...document.querySelectorAll(sel)].find((h) => h.shadowRoot?.querySelector(".pill"));
      return host?.shadowRoot.querySelector(".num")?.textContent ?? null;
    }, BADGE_SEL);
    record(
      "ui",
      "PDF reader: three short paragraphs under a heading are read as ONE unit, and nothing crosses the heading",
      groupedSent.length === 1 && groupedSent[0] === GROUPED_UNIT_TEXT,
      JSON.stringify({ sent: groupedSent.map((t) => t.slice(0, 48)) }),
    );
    record(
      "ui",
      "PDF reader: the grouped chip says ×3, sits inside its page and never over the text",
      grouped.chips === 1 &&
        /×3$/.test(chipNum ?? "") &&
        grouped.placed.every((c) => c.inPage && !c.overText),
      JSON.stringify({ chips: grouped.chips, chipNum, placed: grouped.placed }),
    );
    record(
      "ui",
      "PDF reader: the marks lie on all three paragraphs of the group",
      GROUPED_PARAS.slice(0, 3).every((para) => grouped.marked.some((t) => t.includes(para[0]))),
      JSON.stringify({ marks: grouped.marks, marked: grouped.marked.slice(0, 4).map((t) => t.slice(0, 32)) }),
    );
    await p.close();
  }

  // A31: upstream materializes text and pixels near the viewport. Navigating to a
  // distant page must render it, and returning must restore recycled source mapping.
  if (extId) {
    const p = await openReader("/tall.pdf");
    await readerReady(p);
    const far = await p.evaluate(() => {
      const last = document.querySelector('#viewer .page[data-page-number="30"]');
      return {
        pages: window.PDFViewerApplication.pdfDocument.numPages,
        textOnLast: !!last?.querySelector(".textLayer span"),
        drawn: [...document.querySelectorAll("#viewer .page canvas")].filter((c) => c.width > 0).length,
        lastDrawn: (last?.querySelector("canvas")?.width ?? 0) > 0,
      };
    });
    await visitPdfPage(p, 30);
    const last = await p.evaluate(() => ({
      page: window.PDFViewerApplication.page,
      text: document.querySelector('#viewer .page[data-page-number="30"] .textLayer')?.textContent,
    }));
    await visitPdfPage(p, 1);
    await p.waitForFunction(() => [...document.querySelectorAll('.anagramPdfChips [data-anagram="host"]')]
      .some((el) => el.closest('.page')?.dataset.pageNumber === "1" && el.shadowRoot?.querySelector('.pill:not(.pending)')),
      null, { timeout: 20000 });
    const returned = await readReader(p);
    record(
      "ui",
      "PDF reader: distant pages do not eagerly allocate text layers or canvases",
      far.pages === 30 && !far.textOnLast && !far.lastDrawn && far.drawn > 0 && far.drawn <= 10,
      JSON.stringify(far),
    );
    record(
      "ui",
      "PDF reader: page navigation renders distant text and restores annotations on return",
      last.page === 30 && !!last.text && returned.placed.some((chip) => chip.page === 1) && returned.marks > 0,
      JSON.stringify({ last: last.page, restoredChips: returned.chips, restoredMarks: returned.marks }),
    );
    await p.close();
  }

  // A32: the two ways a PDF refuses to be read, each said in one line — and the scan,
  // which is now SHOWN rather than refused: its pages are the faithful thing to render.
  if (extId) {
    const stateFor = async (path) => {
      const p = await openReader(path);
      const state = await p
        .waitForFunction(() => {
          const n = document.getElementById("notice").textContent.trim();
          return n !== "Loading…" && n !== "";
        }, null, { timeout: 15000 })
        .then(() =>
          p.evaluate(() => ({
            notice: document.getElementById("notice").textContent,
            pages: document.querySelectorAll(".page").length,
            drawn: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0).length,
          })),
        )
        .catch(() => null);
      await p.close();
      return state;
    };
    const scanned = await stateFor("/scanned.pdf");
    const broken = await stateFor("/broken.pdf");
    record(
      "ui",
      "PDF reader: a scan is still shown and says it has no text; a corrupt file says so instead",
      scanned?.notice === "This PDF has no text layer." &&
        scanned.pages === 1 &&
        scanned.drawn === 1 &&
        broken?.notice === "This file could not be read as a PDF." &&
        broken.pages === 0,
      JSON.stringify({ scanned, broken }),
    );
  }

  // A33: a tab already showing a PDF. Chrome wraps its viewer in an outer document that
  // content scripts do run in, so the ball is there — and it is the ball that has to be
  // ABOVE the plugin's own chrome, or nothing about this way in works. The chip asks the
  // worker to swap the tab for the reader, which a content script cannot do itself.
  if (extId) {
    const p = await context.newPage();
    await p.goto(fileUrl("/doc.pdf"), { waitUntil: "load" }).catch(() => {});
    await p.waitForTimeout(3000);
    const chip = await p
      .evaluate(() => {
        const host = document.getElementById("anagram-fab");
        const el = host?.shadowRoot?.querySelector(".action");
        if (!el) return { contentType: document.contentType, label: null };
        const r = el.getBoundingClientRect();
        return {
          contentType: document.contentType,
          label: el.textContent,
          onTop: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === host,
        };
      })
      .catch(() => null);
    if (chip?.label) {
      await p.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".action").click());
      await p.waitForURL(/reader\.html/, { timeout: 10000 }).catch(() => {});
    }
    const landed = p.url();
    record(
      "ui",
      "PDF tab: the ball offers Analyze PDF above the viewer, and it swaps the tab for the reader",
      chip?.contentType === "application/pdf" &&
        chip.label === "Analyze PDF" &&
        chip.onTop === true &&
        landed.startsWith(`chrome-extension://${extId}/reader.html?src=`) &&
        new URL(landed).searchParams.get("src") === fileUrl("/doc.pdf"),
      JSON.stringify({ chip, landed: landed.slice(0, 70) }),
    );
    await p.close();
  }

  // A34: the drop zone — the reader opened with no source takes a file, and the document
  // it shows is scored like any other. This is also the only path a file:// PDF has when
  // the user has not allowed file access.
  if (extId) {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${extId}/reader.html`, { waitUntil: "load" });
    await p.waitForSelector("#drop:not([hidden])");
    const empty = await p.evaluate(() => ({
      drop: !document.getElementById("drop").hidden,
      pages: !!window.PDFViewerApplication.pdfDocument,
    }));
    await p.setInputFiles("#file", { name: "dropped.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
    await visitShortPdf(p);
    await p
      .waitForFunction((sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")).length >= 3, BADGE_SEL, { timeout: 20000 })
      .catch(() => {});
    const loaded = await p.evaluate((sel) => ({
      drop: !document.getElementById("drop").hidden,
      pages: document.querySelectorAll(".page").length,
      chips: [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill")).length,
      title: document.title,
    }), BADGE_SEL);
    record(
      "ui",
      "PDF reader: with no source it offers a drop zone, and a chosen file is shown and scored",
      empty.drop && !empty.pages && !loaded.drop && loaded.pages === 2 && loaded.chips === 3 && loaded.title === "dropped.pdf",
      JSON.stringify({ empty, loaded }),
    );
    await p.close();
  }

  // A34b: TWO documents, one after the other, in both completion orders. The second one
  // the reader is given owns the view from the moment it is given — a thirty-page book
  // that was still parsing when a two-page note replaced it must not come back and take
  // the pages, the title or an error line with it. This is the defect the audit found:
  // nothing used to own a load and nothing could be cancelled.
  if (extId) {
    const race = async (first, second) => {
      const p = await context.newPage();
      await p.goto(`chrome-extension://${extId}/reader.html`, { waitUntil: "load" });
      await p.waitForSelector("#drop:not([hidden])");
      await p.setInputFiles("#file", first);
      await p.setInputFiles("#file", second);
      // Long enough that the LOSER would certainly have finished by now.
      await p.waitForTimeout(12000);
      const state = await p.evaluate(() => ({
        title: document.title,
        pages: document.querySelectorAll(".page").length,
        notice: document.getElementById("notice").textContent,
        reading: !window.PDFViewerApplication.pdfDocument,
      }));
      await p.close();
      return state;
    };
    const big = { name: "book.pdf", mimeType: "application/pdf", buffer: TALL_PDF };
    const small = { name: "note.pdf", mimeType: "application/pdf", buffer: TEST_PDF };
    // The one that matters: the slow one was asked for FIRST, so it finishes LAST.
    const slowFirst = await race(big, small);
    const slowSecond = await race(small, big);
    record(
      "ui",
      "PDF reader: the document asked for last is the one on screen, whichever finishes first",
      slowFirst.title === "note.pdf" && slowFirst.pages === 2 && slowFirst.notice === "" &&
        slowSecond.title === "book.pdf" && slowSecond.pages === 30 && slowSecond.notice === "",
      JSON.stringify({ slowFirst, slowSecond }),
    );
  }

  // A33–A36: the setup page's status card follows the Native Messaging engine lifecycle.
  // Dedicated native-browser.mjs also covers install copying and destructive actions.
  if (extId) {
    const onboardingUrl = `chrome-extension://${extId}/onboarding.html`;
    const readCard = (page) => page.evaluate(() => {
      const txt = (sel) => document.querySelector(sel)?.textContent ?? null;
      for (const d of document.querySelectorAll("#manage, #advanced")) d.setAttribute("open", "");
      return {
        status: txt("#componentSettings .component-status"),
        active: txt('#runtimeSettings .runtime-row[data-active="true"]'),
        ready: document.getElementById("ready")?.hidden === false,
        grant: document.getElementById("access-grant")?.hidden === false,
        go: document.getElementById("go")?.hidden === false,
        install: document.getElementById("install")?.hidden === false ? txt("#install-cmd") : null,
        primary: document.getElementById("component-primary")?.hidden === false ? txt("#component-primary") : null,
        update: [...document.querySelectorAll("button")].some((b) => !b.hidden && b.textContent === "Update engine"),
        error: document.querySelector(".component-error")?.textContent ?? null,
      };
    });
    const waitStatus = (page, words, timeout = 15000) => page.waitForFunction(
      (w) => document.querySelector("#componentSettings .component-status")?.textContent === w, words, { timeout },
    ).then(() => true).catch(() => false);
    const p = await context.newPage();
    await p.goto(onboardingUrl, { waitUntil: "load" });
    const sawRunning = await waitStatus(p, "Ready");
    const up = await readCard(p);
    record("ui", "the setup page says Ready with the active configuration, the site grant and no install command",
      // The test build already grants every site, so the grant button gives way to the go line.
      sawRunning && up.status === "Ready" && up.active?.includes("Test CPU · FP32") && up.ready && (up.grant || up.go) &&
      up.install === null && up.primary === null && up.update && !up.error,
      JSON.stringify(up));
    await fixture.close();
    await p.reload({ waitUntil: "load" });
    const sawDown = await waitStatus(p, "Not installed");
    const down = await readCard(p);
    record("ui", "the setup page offers a scoped installer and does not claim Ready when disconnected",
      sawDown && !down.ready && down.install?.includes(extId) && down.install.includes("/releases/download/v") &&
      down.active === null && down.primary === null,
      JSON.stringify(down));
    await fixture.resume();
    const cameBack = await waitStatus(p, "Ready");
    const back = await readCard(p);
    record("ui", "the setup page follows engine recovery without a reload",
      cameBack && back.active?.includes("Test CPU · FP32") && back.ready && back.install === null, JSON.stringify(back));
    const healthy = fixture.state().component;
    fixture.setState({ component: { ...healthy, state: "error", error: { code: "incompatible", message: "Fixture component requires update" } } });
    // A ready page polls every 15 s, so the change is seen only on the next tick.
    const sawMismatch = await waitStatus(p, "Needs attention", 20000);
    const mismatch = await readCard(p);
    fixture.setState({ component: healthy });
    const restored = await waitStatus(p, "Ready");
    record("ui", "an engine error leaves setup incomplete, shows Retry and the Update engine action",
      sawMismatch && !mismatch.ready && mismatch.update && mismatch.error && mismatch.primary === "Retry" &&
      mismatch.install === null && restored, JSON.stringify({ ...mismatch, restored }));
    await p.close();
  }

  // ---- A37: the three small controls ---------------------------------------------------
  // Both checks read the fake fixture's counters, so they share one fixture shape: three
  // paragraphs nothing else in this run has scored, on a page of their own.
  const CONTROLS_PAGE = (tag) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${tag} fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<p id="p1">${PARA(`${tag}-ONE`)}</p>
<p id="p2">${PARA(`${tag}-TWO`)}</p>
<p id="p3">${PARA(`${tag}-THREE`)}</p>
</body></html>`;
  /** Three finished chips on the page, or false if they never arrive. */
  const threeChips = (p) =>
    p
      .waitForFunction(
        (sel) => {
          const pills = [...document.querySelectorAll(sel)].map((h) => h.shadowRoot?.querySelector(".pill")).filter(Boolean);
          return pills.length === 3 && !pills.some((x) => x.classList.contains("pending"));
        },
        BADGE_SEL,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
  /** What the fixture has been asked for so far. */
  const asked = () => ({ requests: fixture.stats.requests, blocks: fixture.stats.blocks });
  /** Exactly what the popup's Rescan does: the worker messages the active tab. */
  const rescan = async (p) => {
    await p.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "rescan" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    await threeChips(p);
    await p.waitForTimeout(800);
  };

  // A37a: "Clear cached verdicts" (options → Advanced). A rescan of an unchanged page is
  // normally answered from the worker's cache and the fixture never hears about it; once the
  // caches are cleared the very same rescan has to reach the fixture again.
  if (extId) {
    PAGES["/cached.html"] = CONTROLS_PAGE("CACHED");
    const p = await context.newPage();
    await p.goto(server.url("/cached.html"), { waitUntil: "load" });
    const scored = await threeChips(p);
    await p.waitForTimeout(800);
    const before = asked();
    await rescan(p);
    const fromCache = asked();

    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "load" });
    // How many verdicts are on the disk: a number, beside the button that empties them.
    const countedBefore = await opt
      .waitForFunction(() => /^[\d,]+ entr(y|ies)$/.test(document.getElementById("cacheCount").textContent ?? ""), null, { timeout: 8000 })
      .then(() => opt.$eval("#cacheCount", (el) => el.textContent))
      .catch(() => null);
    await opt.click("#clearCache");
    const said = await opt
      .waitForFunction(() => document.getElementById("cacheStatus").textContent.includes("Cleared"), null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    const countedAfter = await opt
      .waitForFunction(() => document.getElementById("cacheCount").textContent === "0 entries", null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    await opt.close();

    await rescan(p);
    const afterClear = asked();
    record(
      "ui",
      "cached verdicts: a rescan is answered from the worker cache, and asks the fixture again once cleared",
      scored &&
        fromCache.requests === before.requests &&
        fromCache.blocks === before.blocks &&
        said &&
        afterClear.requests > fromCache.requests &&
        afterClear.blocks >= fromCache.blocks + 3,
      JSON.stringify({ scored, before, fromCache, said, afterClear }),
    );
    record(
      "ui",
      "cached verdicts: the options page says how many are stored, and says zero once they are cleared",
      countedBefore !== null && countedBefore !== "0 entries" && countedAfter,
      JSON.stringify({ countedBefore, countedAfter }),
    );
    await p.close();
  }

  // A37b: "Analyze this page with Anagram". With Anagram off everywhere the page stays
  // bare; the menu's action analyzes it once, and because nothing is written, a reload is
  // bare again and the settings are exactly as they were.
  {
    PAGES["/oneshot.html"] = CONTROLS_PAGE("ONESHOT");
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: false }, res)));
    const p = await context.newPage();
    await p.goto(server.url("/oneshot.html"), { waitUntil: "load" });
    await p.waitForTimeout(2500);
    const chips = () => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill")).length, BADGE_SEL);
    const offAtFirst = await chips();
    // Exactly what the contextMenus.onClicked listener does for the page entry.
    await p.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "analyzePage" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    const analyzed = await threeChips(p);
    await p.reload({ waitUntil: "load" });
    await p.waitForTimeout(2500);
    const afterReload = await chips();
    const stored = await sw.evaluate(() => new Promise((res) => chrome.storage.local.get(["enabled", "siteOverrides"], res)));
    record(
      "ui",
      "analyze this page: one run on a switched-off site, gone after a reload, nothing written",
      offAtFirst === 0 &&
        analyzed &&
        afterReload === 0 &&
        stored.enabled === false &&
        Object.keys(stored.siteOverrides ?? {}).length === 0,
      JSON.stringify({ offAtFirst, analyzed, afterReload, stored }),
    );
    await p.close();
    // Phase B reads live sites with the shipped default — put it back.
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: true }, res)));
  }

  // A37d: the same run asked for from the POPUP's button. The popup cannot reach a page
  // that holds no content script (a site nothing was granted for), so it asks the worker,
  // which injects with `activeTab` and then says what the menu entry says. Sent here from
  // an extension page of ours, exactly as the popup sends it.
  {
    PAGES["/oneshot-popup.html"] = CONTROLS_PAGE("ONESHOTPOPUP");
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: false }, res)));
    const p = await context.newPage();
    await p.goto(server.url("/oneshot-popup.html"), { waitUntil: "load" });
    await p.waitForTimeout(2500);
    const chips = () => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill")).length, BADGE_SEL);
    const offAtFirst = await chips();
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id ?? null, server.url("/oneshot-popup.html"));
    const ours = await context.newPage();
    await ours.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`, { waitUntil: "load" });
    await ours.evaluate((id) => chrome.runtime.sendMessage({ action: "analyzeTab", tabId: id }), tabId);
    await ours.close();
    await p.bringToFront();
    const analyzed = await threeChips(p);
    const stored = await sw.evaluate(() => new Promise((res) => chrome.storage.local.get(["enabled", "siteOverrides"], res)));
    record(
      "ui",
      "analyze this page from the popup's button: the worker starts one run in the named tab, nothing written",
      offAtFirst === 0 && tabId !== null && analyzed && stored.enabled === false && Object.keys(stored.siteOverrides ?? {}).length === 0,
      JSON.stringify({ offAtFirst, tabId, analyzed, stored }),
    );
    await p.close();
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: true }, res)));
  }

  // A37e: the toggle shortcut on a page Anagram is off for. There is no overlay to show
  // or hide there, and the key used to do nothing whatsoever — on a fresh install, where
  // no site is granted, that is every page. It now starts the same single run the menu
  // entry and the popup's button start, and writes nothing either.
  {
    PAGES["/oneshot-key.html"] = CONTROLS_PAGE("ONESHOTKEY");
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: false }, res)));
    const p = await context.newPage();
    await p.goto(server.url("/oneshot-key.html"), { waitUntil: "load" });
    await p.waitForTimeout(2500);
    const chips = () => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill")).length, BADGE_SEL);
    const offAtFirst = await chips();
    // Exactly what commands.onCommand does for "toggle-overlay": the active tab, every frame.
    await p.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    const analyzed = await threeChips(p);
    const stored = await sw.evaluate(() => new Promise((res) => chrome.storage.local.get(["enabled", "siteOverrides"], res)));
    record(
      "ui",
      "the toggle shortcut analyzes a switched-off page once instead of doing nothing, and writes nothing",
      offAtFirst === 0 && analyzed && stored.enabled === false && Object.keys(stored.siteOverrides ?? {}).length === 0,
      JSON.stringify({ offAtFirst, analyzed, stored }),
    );
    await p.close();
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: true }, res)));
  }

  // A37f: the popup leads with ONE action, and it is the right one for the tab under it.
  // The popup reads the ACTIVE tab, so each state is produced the way the popup meets it:
  // the fixture is brought to the front and the popup — a background tab of the same
  // window — is reloaded, which is when it asks which tab is active. (Opened as its own
  // active tab it sees ITSELF, which is the "nothing can run here" state.)
  {
    PAGES["/popup-state.html"] = CONTROLS_PAGE("POPUPSTATE");
    // The popup decides a PDF tab from the tab's URL; what the tab actually holds is the
    // reading mode's problem, and a real PDF tab cannot be driven here.
    PAGES["/popup-state.pdf"] = CONTROLS_PAGE("POPUPPDF");
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    const lead = async (fixtureUrl, openSettings = false) => {
      const fixture = fixtureUrl ? await context.newPage() : null;
      if (fixture) {
        await fixture.goto(fixtureUrl, { waitUntil: "load" });
        await fixture.waitForTimeout(2000);
      }
      const popup = await context.newPage();
      await popup.goto(popupUrl, { waitUntil: "load" });
      // An idle native disconnect must invalidate the old Ready result even when
      // every paragraph is cached. Observe the ordinary status path, without probing.
      const disconnected = openSettings ? await popup.evaluate(async () =>
        (await chrome.runtime.sendMessage({ action: "getBackendStatus", probe: false }))?.active === "down",
      ) : undefined;
      if (fixture) {
        await fixture.bringToFront();
        await popup.reload({ waitUntil: "load" });
      }
      await popup.waitForTimeout(1200);
      const seen = await popup.evaluate(() => ({
        status: document.getElementById("status")?.textContent ?? "",
        button: document.getElementById("action")?.textContent ?? "",
        // The one filled button, or an outline one where the action is merely available.
        primary: document.getElementById("action")?.dataset.variant !== "outline",
        engine: document.getElementById("backend")?.hidden === false ? document.getElementById("backend")?.textContent : null,
        fabricatedCommand: /~\/.anagram\/bin\/anagram|curl -fsSL/.test(document.body.innerText),
        buttons: document.querySelectorAll("main .btn:not([data-variant])").length,
      }));
      if (openSettings) {
        seen.nativeDisconnected = disconnected;
        await popup.click("#action");
        // Settings runs in its own extension page, so native setup has a trusted
        // top-level sender. openOptionsPage may reuse an existing Settings tab.
        const settingsUrl = `chrome-extension://${extId}/options.html`;
        let options;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          options = context.pages().find((page) => page.url() === settingsUrl);
          if (options) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        seen.settingsUrl = options?.url() ?? null;
        seen.settingsOpen = options ? await options.locator("#componentCard > header h2")
          .waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false) : false;
        await options?.close();
      }
      if (!popup.isClosed()) await popup.close();
      await fixture?.close();
      return seen;
    };

    const running = await lead(server.url("/popup-state.html"));
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: false }, res)));
    const off = await lead(server.url("/popup-state.html"));
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: true }, res)));
    const pdf = await lead(server.url("/popup-state.pdf"));
    const nothing = await lead(null);
    // Break the native pipe, then recover through the same registration.
    await fixture.close();
    const down = await lead(server.url("/popup-state.html"), true);
    await fixture.resume();
    // Nothing after this may inherit a "down" verdict: wait until the worker has the
    // fixture back before the next check asks it for anything.
    {
      const probe = await context.newPage();
      await probe.goto(popupUrl, { waitUntil: "load" });
      await probe
        .waitForFunction(
          async () => (await chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }))?.active === "server",
          null,
          { timeout: 15000 },
        )
        .catch(() => {});
      await probe.close();
    }

    const seen = { running, off, pdf, nothing, down };
    record(
      "ui",
      "the popup offers one action per state, names the engine's state, and an unavailable engine opens Settings without a terminal command",
      running.button === "Rescan" && !running.primary && /paragraphs analyzed/.test(running.status) &&
        running.engine === "Local engine: Ready · fake" &&
        off.button === "Analyze this page" && off.primary && off.status === "Anagram is off for this page." &&
        pdf.button === "Read this PDF" && pdf.primary && pdf.status === "" &&
        nothing.button === "Read a PDF file…" && !nothing.primary && nothing.status === "Not available on this page." &&
        down.nativeDisconnected && down.button === "Open Settings" && down.primary && down.status === "Local engine is not ready" &&
        down.engine === null &&
        !down.fabricatedCommand && down.settingsUrl === `chrome-extension://${extId}/options.html` && down.settingsOpen &&
        // Never two main events at once: at most one filled button on the whole page.
        [running, off, pdf, nothing, down].every((s) => s.buttons <= 1),
      JSON.stringify(seen),
    );
  }

  // A37c: the same run on a site whose rule ALREADY says "off" — which is the likeliest
  // page to ask for one. An unrelated rule written while it runs must leave it alone, and
  // the panel's own "Turn off on <host>" must end it although it stores the value that is
  // already there, so no settings change ever reaches the page.
  {
    PAGES["/turnoff.html"] = CONTROLS_PAGE("TURNOFF");
    const fixtureHost = new URL(server.base).hostname;
    await sw.evaluate(
      (h) => new Promise((res) => chrome.storage.local.set({ enabled: true, siteOverrides: { [h]: "off" } }, res)),
      fixtureHost,
    );
    const p = await context.newPage();
    await p.goto(server.url("/turnoff.html"), { waitUntil: "load" });
    await p.waitForTimeout(2500);
    const chips = () => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((x) => x.shadowRoot?.querySelector(".pill")).length, BADGE_SEL);
    const offAtFirst = await chips();
    await p.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "analyzePage" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    const analyzed = await threeChips(p);
    // Someone else's rule: the watch fires, this site is still off by the same rule it was
    // off by when the run started, and the run must not notice.
    await sw.evaluate(
      (h) => new Promise((res) => chrome.storage.local.set({ siteOverrides: { [h]: "off", "example.org": "off" } }, res)),
      fixtureHost,
    );
    await p.waitForTimeout(1500);
    const afterUnrelated = await chips();
    // The panel's footer, reached the way a keyboard user reaches it.
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "openPanel" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    await p.waitForTimeout(600);
    const label = await p.evaluate(() => {
      const el = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".psiteoff");
      if (!el) return null;
      el.click();
      return el.textContent;
    });
    await p.waitForTimeout(1500);
    const afterTurnOff = await chips();
    const rules = await sw.evaluate(() => new Promise((res) => chrome.storage.local.get("siteOverrides", (v) => res(v.siteOverrides))));
    record(
      "ui",
      "analyze this page: an already-off site keeps its run through an unrelated rule, and the panel's own switch ends it",
      offAtFirst === 0 &&
        analyzed &&
        afterUnrelated === 3 &&
        label === `Turn off on ${fixtureHost}` &&
        afterTurnOff === 0 &&
        rules?.[fixtureHost] === "off",
      JSON.stringify({ offAtFirst, analyzed, afterUnrelated, label, afterTurnOff, rules }),
    );
    await p.close();
    await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ enabled: true, siteOverrides: {} }, res)));
  }

  // A38: a mailing-list quotation keeps its chip when the page moves around it. The "> "
  // markers of a quoted run are not part of the text the unit carries (lib/dom/text.ts), so
  // the orchestrator has to recompute that text the same way (partTextOf). Rebuilding it
  // from the nodes alone brought the markers back, `currentTextOf(unit) !== unit.text` was
  // true for ever, and ANY mutation whose scan root touches the <pre> — a paragraph
  // appended to the page, an empty <span>, a class toggled — threw the unit away, removed
  // its chip and read it again; only the per-tab cache kept the fixture out of it.
  {
    PAGES["/mailing-list.html"] = readFileSync(join(__dirname, "fixtures", "mailing-list.html"), "utf8");
    const p = await context.newPage();
    await p.goto(server.url("/mailing-list.html"), { waitUntil: "load" });
    const settled = await p
      .waitForFunction(
        (sel) => {
          const pills = [...document.querySelectorAll(sel)].map((h) => h.shadowRoot?.querySelector(".pill")).filter(Boolean);
          return pills.length === 3 && !pills.some((x) => x.classList.contains("pending"));
        },
        BADGE_SEL,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    // Every chip host is tagged, and the one belonging to the QUOTED unit is marked: it is
    // inserted right after the last quoted line, inside the <pre>.
    const before = await p.evaluate((sel) => {
      const hosts = [...document.querySelectorAll(sel)];
      hosts.forEach((h, i) => { h.__anagramTag = i; });
      const quoted = hosts.find((h) => (h.previousSibling?.textContent ?? "").includes("year it was typed"));
      if (quoted) quoted.__quoted = true;
      return { hosts: hosts.length, found: !!quoted, pills: hosts.map((h) => h.shadowRoot?.querySelector(".num")?.textContent ?? "") };
    }, BADGE_SEL);
    const timesAsked = () => fixture.stats.texts.filter((t) => t.includes("maintained by four people")).length;
    const askedBefore = timesAsked();
    // What the fixture was actually given: the quotation without its markers, while the page
    // still holds them — the difference this whole check is about.
    const sent = fixture.stats.texts.find((t) => t.includes("maintained by four people")) ?? "";
    const onPage = await p.evaluate(() => document.querySelector("pre").textContent.includes("> Right, so a package"));
    // Four mutations, not one character of the unit changed by any of them. The removal is
    // the one lib/dom/splits.ts reacts to: the <pre>'s text node was cut, with chips between
    // its pieces, and a cut must stay standing when something else leaves the page.
    await p.evaluate(() => {
      const pre = document.querySelector("pre");
      const note = document.createElement("p");
      note.textContent = "Archive index"; // a label: too short to be scored, and never merged
      document.body.appendChild(note);
      pre.appendChild(document.createElement("span"));
      pre.classList.toggle("touched");
      const gone = document.createElement("i");
      document.body.appendChild(gone);
      gone.remove();
    });
    await p.waitForTimeout(2500);
    const after = await p.evaluate((sel) => {
      const hosts = [...document.querySelectorAll(sel)];
      const quoted = hosts.find((h) => h.__quoted);
      return {
        hosts: hosts.length,
        tagged: hosts.filter((h) => typeof h.__anagramTag === "number").length,
        quotedAlive: !!quoted && quoted.isConnected,
        pills: hosts.map((h) => h.shadowRoot?.querySelector(".num")?.textContent ?? ""),
      };
    }, BADGE_SEL);
    record(
      "ui",
      "a quoted mail unit survives a mutation beside it: same chip node, no re-read, no new request",
      settled &&
        before.found &&
        onPage &&
        !sent.includes(">") &&
        after.quotedAlive &&
        after.hosts === before.hosts &&
        after.tagged === after.hosts &&
        JSON.stringify(after.pills) === JSON.stringify(before.pills) &&
        timesAsked() === askedBefore,
      JSON.stringify({ settled, before, after, askedBefore, askedAfter: timesAsked(), markersSent: sent.includes(">"), onPage }),
    );
    await p.close();
  }

  // ---- a script that owns a pre-wrap post rewrites it (X's "Show more") ------------------
  // The walker cuts preserved-whitespace text at its blank lines, and a framework writes to
  // the one node it created. X's "Show more" wrote the whole post into that node and the
  // pieces cut off it stayed on screen: the expanded post ended with a stale copy of its
  // preview, and that copy was scored with it. lib/dom/splits.ts puts the page back.
  {
    const P1 = "FWHEAD The keeper's log for that winter runs to nearly four hundred pages, and almost none of it is about the light. It is about weather, mostly, and about the small economies of a household cut off from the mainland: how much coal was left, which hens were still laying, when the supply boat was due and whether it came, and which books the children read by the stove.";
    const P2 = "He wrote in pencil because ink froze in the well, and he wrote every evening without exception, even on the night his youngest was born in the room below the lantern.";
    const P3 = "FWTAIL The entry for that night is eleven words long, and it gives the wind, the barometer and the hour the glass went before anything else.";
    const PREVIEW = `${P1}\n\n${P2.slice(0, 60)}`;
    const FULL = `${P1}\n\n${P2}\n\n${P3}`;
    PAGES["/framework-post.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>framework post fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<div id="post" style="white-space:pre-wrap"></div><button id="more">Show more</button>
<script>
  const node = document.createTextNode(${JSON.stringify(PREVIEW)});
  document.getElementById("post").append(node);
  document.getElementById("more").addEventListener("click", () => { node.nodeValue = ${JSON.stringify(FULL)}; });
  window.__dropPost = () => node.remove();
</script></body></html>`;
    const p = await context.newPage();
    await p.goto(server.url("/framework-post.html"), { waitUntil: "load" });
    const chipped = (sel) => [...document.querySelectorAll(`#post ${sel}`)].some((h) => h.shadowRoot?.querySelector(".pill:not(.pending)"));
    const settled = await p.waitForFunction(chipped, BADGE_SEL, { timeout: 15000 }).then(() => true).catch(() => false);
    const cut = await p.evaluate(() => [...document.getElementById("post").childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).length > 1);
    await p.evaluate(() => document.getElementById("more").click());
    const exact = await p
      .waitForFunction((full) => document.getElementById("post").textContent === full, FULL, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    // The old chip stays up until the new verdict replaces it, so wait for the request itself.
    const sentWhole = () => fixture.stats.texts.some((t) => t.includes("FWTAIL") && t.includes("FWHEAD"));
    for (let i = 0; i < 60 && !sentWhole(); i++) await p.waitForTimeout(250);
    const rescored = sentWhole() && (await p.waitForFunction(chipped, BADGE_SEL, { timeout: 15000 }).then(() => true).catch(() => false));
    const shown = await p.evaluate(() => document.getElementById("post").textContent);
    record(
      "ui",
      "a script rewriting the pre-wrap post it owns shows exactly its new text, and the new text is what gets scored",
      settled && cut && exact && rescored,
      JSON.stringify({ settled, cut, exact, rescored, tail: shown.slice(-70) }),
    );
    await p.evaluate(() => window.__dropPost());
    await p.waitForTimeout(1500);
    const after = await p.evaluate((sel) => ({ text: document.getElementById("post").textContent, chips: document.querySelectorAll(`#post ${sel}`).length }), BADGE_SEL);
    record("ui", "…and removing its node leaves no piece of the post and no chip behind", after.text === "" && after.chips === 0, JSON.stringify(after));
    await p.close();
  }

  // ---- A39: chips inside a box the site clips to a few lines ---------------------------
  // A 30-page session survey (2026-09) found the chips themselves stable and
  // their PLACEMENT wrong in exactly one shape of box: the "see more" review. Every unit of
  // a clamped review ends out of sight, so every chip was inserted after the box — 91 of
  // them at 16 anchors on one Goodreads page, twelve in a row at the worst. These two run
  // the whole extension over that markup, the second over a box that only starts clipping
  // once a late image arrives (which used to leave the chip out of sight for good).

  // A39a: a long review clipped to 96 px, opened and closed again.
  {
    PAGES["/clipped-reviews.html"] = readFileSync(join(__dirname, "fixtures", "clipped-reviews.html"), "utf8");
    const p = await context.newPage();
    await p.goto(server.url("/clipped-reviews.html"), { waitUntil: "load" });
    const read = () =>
      p.evaluate((sel) => {
        const box = document.getElementById("nadia-box");
        const card = box.closest("article");
        const all = [...card.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".card .head"));
        const num = (h) => h.shadowRoot.querySelector(".num").textContent;
        const br = box.getBoundingClientRect();
        return {
          after: all.filter((h) => !box.contains(h)).map(num),
          within: all.filter((h) => box.contains(h)).map(num),
          // Nothing the reader can see may be drawn with no box at all, and nothing inside
          // the collapsed review may be drawn over the lines that ARE on screen.
          undrawn: all.filter((h) => !box.contains(h) && h.getBoundingClientRect().height === 0).length,
          parkedBelow: all.filter((h) => !box.contains(h)).every((h) => h.getBoundingClientRect().top >= br.top),
        };
      }, BADGE_SEL);
    await p
      .waitForFunction((sel) => document.querySelectorAll(`#nadia-box ${sel}, article ${sel}`).length >= 6, BADGE_SEL, { timeout: 15000 })
      .catch(() => {});
    await p.waitForTimeout(1500);
    const collapsed = await read();
    await p.click("#nadia-more");
    await p.waitForTimeout(1200);
    const opened = await read();
    await p.click("#nadia-more");
    await p.waitForTimeout(1200);
    const closed = await read();
    const total = (r) => r.after.length + r.within.length;
    const ok =
      collapsed.after.length === 1 && collapsed.within.length === 5 && collapsed.undrawn === 0 && collapsed.parkedBelow &&
      opened.after.length === 0 && opened.within.length === 6 &&
      closed.after.length === 1 && closed.after[0] === collapsed.after[0] && closed.within.length === 5 &&
      total(collapsed) === 6 && total(opened) === 6 && total(closed) === 6;
    record(
      "ui",
      "a review clipped to a few lines: ONE chip under it, the other five at their own paragraphs, all six back in place when it is opened",
      ok,
      JSON.stringify({ collapsed, opened, closed }),
    );
    await p.close();
  }

  // A38b: a box that is NOT clipping when the verdicts land and starts clipping when the
  // cover image finally arrives — the Goodreads review whose images outlive the scan.
  {
    PAGES["/latecover.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>late cover fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>A review whose picture arrives last</h1>
<article id="post"><div id="box" style="max-height:420px;overflow:hidden">
<img id="cover" alt="" style="display:block;width:100%;height:0;background:#ddd">
<p id="lp1">${PARA("LATE-ONE")}</p>
<p id="lp2">${PARA("LATE-TWO")}</p>
</div></article>
</body></html>`;
    const p = await context.newPage();
    await p.goto(server.url("/latecover.html"), { waitUntil: "load" });
    await p.waitForFunction((sel) => document.querySelectorAll(`#post ${sel}`).length >= 2, BADGE_SEL, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(1200);
    const before = await p.evaluate((sel) => {
      const box = document.getElementById("box");
      return [...document.querySelectorAll(`#post ${sel}`)].filter((h) => !box.contains(h)).length;
    }, BADGE_SEL);
    await p.evaluate(() => (document.getElementById("cover").style.height = "700px"));
    await p.waitForTimeout(1500);
    const after = await p.evaluate((sel) => {
      const box = document.getElementById("box");
      const hosts = [...document.querySelectorAll(`#post ${sel}`)];
      const out = hosts.filter((h) => !box.contains(h));
      const br = box.getBoundingClientRect();
      return {
        chips: hosts.length,
        out: out.length,
        first: out[0] ? out[0].previousElementSibling === box : false,
        onScreen: out.every((h) => h.getBoundingClientRect().height > 0 && h.getBoundingClientRect().top >= br.bottom - 1),
        clips: box.scrollHeight > box.clientHeight + 32,
      };
    }, BADGE_SEL);
    record(
      "ui",
      "a box that only starts clipping when its image arrives still puts one chip where it can be seen, and only one",
      before === 0 && after.chips === 1 && after.out === 1 && after.first && after.onScreen && after.clips,
      JSON.stringify({ before, after }),
    );
    await p.close();
  }

  // A40: the whole interface in Simplified Chinese, in a SECOND browser whose UI language
  // is zh-CN. That is the browser's own language — not `navigator.language`, which is all
  // Playwright's `locale` option sets — so it is switched at launch, differently on every
  // platform (test/harness.mjs, uiLanguage()). The page under it stays English: EditLens
  // reads English, and the point is a Chinese reader looking at an English article.
  //
  // Where the language cannot be switched the checks SKIP, loudly, rather than passing
  // against a browser that is still in English — so getUILanguage() is asked first and is
  // the thing everything below hangs on.
  {
    PAGES["/zh.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chinese UI fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
${KEY_TAGS.map((t, i) => `<p id="z${i + 1}">${KEY_PARA(t)}</p>`).join("\n")}
</body></html>`;
    const zh = await launchExtension({ nativeFixture: fixture, ...uiLanguage("zh-CN") });
    await zh.context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const uiLang = await uiLanguageOf(zh.sw);
    const zhId = zh.sw ? new URL(zh.sw.url()).host : null;

    if (uiLang !== "zh-CN" || !zhId) {
      record(
        "i18n",
        `the interface speaks Chinese when the browser does (${process.platform})`,
        null,
        `could not switch the browser UI language: getUILanguage() = ${uiLang}`,
      );
    } else {
      // The worker: the context menus are created with t(), and chrome.contextMenus has no
      // way to read a title back — so the same lookup the worker made is asked for again.
      const menus = await zh.sw.evaluate(() =>
        ["menuAnalyzeSelection", "menuAnalyzePage", "menuOpenPdf", "cmdOpenPanel"].map((k) =>
          chrome.i18n.getMessage(k),
        ),
      );

      // The popup: plain text, an attribute, a group heading and the one action button,
      // whose label is chosen by the page rather than written in the markup. Opened as a
      // tab it is its own active tab — a page nothing can run on, so the action is the
      // reading mode with a file from this computer.
      const popup = await zh.context.newPage();
      await popup.goto(`chrome-extension://${zhId}/popup.html`, { waitUntil: "load" });
      await popup.waitForTimeout(800);
      const popupText = await popup.evaluate(() => ({
        lang: document.documentElement.lang,
        gear: document.getElementById("gear")?.getAttribute("aria-label") ?? "",
        site: document.querySelector('label[for="siteEnabled"]')?.textContent ?? "",
        action: document.getElementById("action")?.textContent ?? "",
        flagged: document.querySelector('[role="tab"][data-value="flagged"]')?.textContent ?? "",
      }));
      await popup.close();

      const opts = await zh.context.newPage();
      await opts.goto(`chrome-extension://${zhId}/options.html`, { waitUntil: "load" });
      await opts.waitForTimeout(400);
      const optionsText = await opts.evaluate(() => ({
        lang: document.documentElement.lang,
        componentCard: document.querySelector("#componentCard > header h2")?.textContent ?? "",
        componentStatus: document.querySelector(".component-status")?.textContent ?? "",
        update: [...document.querySelectorAll("button")].some((b) => !b.hidden && b.textContent === "更新引擎"),
        runtimeTitle: document.querySelector("#runtimeSettings h3")?.textContent ?? "",
        marks: document.querySelector('label[for="underline"]')?.textContent ?? "",
        fabricatedCommand: /~\/.anagram\/bin\/anagram|curl -fsSL/.test(document.body.innerText),
      }));
      await opts.close();

      // The in-page UI: a chip's card, the panel behind the ball, and the report.
      const p = await zh.context.newPage();
      await p.goto(server.url("/zh.html"), { waitUntil: "load" });
      const settled = await p
        .waitForFunction(
          (sel) => {
            const pills = [...document.querySelectorAll(sel)].map((h) => h.shadowRoot?.querySelector(".pill")).filter(Boolean);
            return pills.length === 4 && !pills.some((x) => x.classList.contains("pending"));
          },
          BADGE_SEL,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      const chip = await p.evaluate((sel) => {
        const root = document.querySelector(sel)?.shadowRoot;
        return {
          verdict: root?.querySelector(".card .verdict")?.textContent ?? "",
          words: root?.querySelector(".card .row .k")?.textContent ?? "",
          copy: root?.querySelector(".card .act.copy")?.textContent ?? "",
          // Our own chrome declares its language whatever the article is written in.
          lang: root?.querySelector(".pill")?.lang ?? "",
        };
      }, BADGE_SEL);

      await p.evaluate(() => navigator.clipboard.writeText("NO REPORT COPIED").catch(() => {}));
      const panel = await p.evaluate(() => {
        const sr = document.getElementById("anagram-fab")?.shadowRoot;
        sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return {
          lang: sr?.querySelector(".stack")?.lang ?? "",
          title: sr?.querySelector(".phead h2")?.textContent ?? "",
          filters: [...(sr?.querySelectorAll(".fchip") ?? [])].map((b) => b.textContent),
          cov: sr?.querySelector(".pcov")?.textContent ?? "",
          copy: sr?.querySelector(".pcopy")?.textContent ?? "",
          off: sr?.querySelector(".psiteoff")?.textContent ?? "",
        };
      });
      await p.evaluate(() => {
        document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".pcopy")?.click();
      });
      await p.waitForTimeout(600);
      const copied = await p.evaluate(
        () => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".pcopy")?.textContent ?? "",
      );
      const report = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
      await p.close();

      const seen = { uiLang, menus, popup: popupText, options: optionsText, chip, panel, copied, report: (report ?? "").slice(0, 120) };
      record(
        "i18n",
        "a zh-CN browser gets a Chinese popup, options page, chip card, triage panel, menu entries and report",
        settled &&
          menus[0] === "用 Anagram 分析所选文本" &&
          menus[1] === "用 Anagram 分析本页" &&
          menus[2] === "用 Anagram 打开 PDF" &&
          menus[3] === "打开存疑段落列表" &&
          popupText.lang === "zh-CN" &&
          popupText.gear === "设置" &&
          popupText.site === "在此网站运行" &&
          popupText.action === "阅读本机 PDF…" &&
          popupText.flagged === "仅存疑" &&
          optionsText.lang === "zh-CN" &&
          optionsText.componentCard === "本地引擎" &&
          optionsText.componentStatus === "就绪" && optionsText.update &&
          optionsText.runtimeTitle === "运行配置" && optionsText.marks === "下划线" && !optionsText.fabricatedCommand &&
          chip.lang === "zh-CN" &&
          ["人工撰写", "轻度 AI 编辑", "重度 AI 编辑", "AI 生成"].includes(chip.verdict) &&
          chip.words === "词数" &&
          chip.copy === "复制原文" &&
          panel.lang === "zh-CN" &&
          panel.title === "存疑段落（4）" &&
          // The coverage line is translated too — "已读 N", and nothing else on a page
          // where every paragraph was read.
          /^已读 \d+$/.test(panel.cov) &&
          panel.copy === "复制报告" &&
          panel.off === "在 localhost 关闭" &&
          copied === "已复制 ✓" &&
          typeof report === "string" &&
          report.startsWith("# Anagram 分析报告") &&
          report.includes("## 存疑段落（4）") &&
          report.includes("也不能证明作者身份"),
        JSON.stringify(seen),
      );

      // The English build is untouched by any of it: the same page in the FIRST browser,
      // whose UI language nothing changed, still says everything in English.
      const en = await context.newPage();
      await en.goto(server.url("/zh.html"), { waitUntil: "load" });
      await en.waitForSelector(BADGE_SEL, { timeout: 15000 }).catch(() => {});
      await en.waitForTimeout(2000);
      const enSeen = await en.evaluate((sel) => ({
        verdict: document.querySelector(sel)?.shadowRoot?.querySelector(".card .verdict")?.textContent ?? "",
        lang: document.querySelector(sel)?.shadowRoot?.querySelector(".pill")?.lang ?? "",
      }), BADGE_SEL);
      await en.close();
      record(
        "i18n",
        "an English browser is unaffected: the same page, the same chip, the English verdict",
        ["Human", "Lightly edited", "Heavily edited", "AI-generated"].includes(enSeen.verdict) &&
          enSeen.lang === "en",
        JSON.stringify(enSeen),
      );
    }
    await zh.context.close();
  }
}

// ---- A41: incremental scanning — the same page, built step by step or all at once -----
// The safety net under lib/capture/orchestrator.ts's scan-root rule. A page that grows
// and changes under the reader must end up with exactly the chips a single fresh scan of
// its FINAL DOM produces — same places, same numbers (the fake fixture's verdict is a pure
// function of the text, so a number that differs means the text or the grouping differs).
// One generator builds both pages: `?all` applies every step before the content script
// ever runs, the other applies them one at a time while the extension watches.
{
  const INC_STEPS = 6;
  const INC_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>incremental fixture</title>
<style>body{max-width:720px;margin:24px auto;font:15px/1.6 system-ui}.post{border-top:1px solid #ddd;padding:12px 0}
.row{display:flex;gap:8px;align-items:center;font-size:13px}img.avatar{width:22px;height:22px}</style></head><body>
<main id="feed"></main>
<article id="essay" data-home="essay"><h1>An essay with short paragraphs</h1></article>
<script>
const VOCAB="the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
const words=(seed,n)=>Array.from({length:n},(_,i)=>VOCAB[(seed*37+i*11)%VOCAB.length]).join(" ");
const para=(seed,n)=>"Item "+seed+": "+words(seed,n)+".";
let seq=0;
function post(){
  const i=seq++;
  const d=document.createElement("div");
  d.className="post";d.id="post-"+i;d.setAttribute("data-home","post-"+i);
  d.innerHTML='<div class="row"><a href="/user/u'+i+'"><img class="avatar" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>'+
    '<a href="/user/u'+i+'">Author '+i+'</a><time datetime="2026-09-1'+(i%9)+'T10:00:00Z">'+(i%23)+'h ago</time></div>'+
    '<p class="body">'+para(i,30)+'</p><p class="body">'+para(i+100,32)+'</p><p class="body">'+para(i+200,28)+'</p>';
  document.getElementById("feed").appendChild(d);
  return d;
}
const essay=document.getElementById("essay");
const add=(id,seed,n)=>{const p=document.createElement("p");p.id=id;p.textContent=para(seed,n);essay.appendChild(p);return p;};
for(let k=0;k<2;k++)post();
add("e1",900,30);add("e2",901,28);add("e3",902,26);add("e4",903,31);
const STEPS=[
  ()=>{for(let k=0;k<3;k++)post();},                                     // a batch of posts
  ()=>{for(let k=0;k<3;k++)post();},                                     // another batch
  ()=>{const p=document.createElement("p");p.className="body";p.textContent=para(300,25);
       document.getElementById("post-1").appendChild(p);},               // a paragraph into a live post
  ()=>{document.querySelector("#post-0 p.body").firstChild.data=para(400,27);}, // text edited in place
  ()=>{const p=document.getElementById("e2");const w=document.createElement("div");
       w.className="wrapped";p.replaceWith(w);w.appendChild(p);},        // wrap
  ()=>{const w=document.querySelector("#essay .wrapped");if(w&&w.firstElementChild!==document.getElementById("e2"))return;
       const p=document.getElementById("e3");const w2=document.createElement("div");p.replaceWith(w2);w2.appendChild(p);
       w2.replaceWith(p);},                                             // wrap and unwrap again
];
window.__step=(i)=>STEPS[i]();
if(location.search.includes("all"))for(const s of STEPS)s();
</script></body></html>`;
  PAGES["/incremental.html"] = INC_PAGE;

  /** Every chip as "where it sits : what it says" — stable across runs, and different the
   *  moment a unit's text or its grouping differs. */
  const chipSig = (p) =>
    p.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)]
          .map((h) => `${h.closest("[data-home]")?.getAttribute("data-home") ?? "page"}:${h.shadowRoot?.querySelector(".num")?.textContent?.trim() ?? "?"}`)
          .join(" | "),
      BADGE_SEL,
    );
  const chipsSettled = (p, timeout = 20000) =>
    p
      .waitForFunction(
        (sel) => {
          const hosts = [...document.querySelectorAll(sel)];
          return hosts.length > 0 && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
        },
        BADGE_SEL,
        { timeout },
      )
      .then(() => true)
      .catch(() => false);

  const grown = await context.newPage();
  await grown.goto(server.url("/incremental.html"), { waitUntil: "load" });
  await chipsSettled(grown);
  for (let i = 0; i < INC_STEPS; i++) {
    await grown.evaluate((n) => window.__step(n), i);
    await grown.waitForTimeout(1400); // past the observer's debounce and max wait
  }
  await chipsSettled(grown);
  await grown.waitForTimeout(1200);
  const incremental = await chipSig(grown);
  await grown.close();

  const whole = await context.newPage();
  await whole.goto(server.url("/incremental.html?all"), { waitUntil: "load" });
  await chipsSettled(whole);
  await whole.waitForTimeout(1200);
  const fresh = await chipSig(whole);
  await whole.close();

  record(
    "ui",
    "a page built step by step ends up with the chips one fresh scan of its final DOM gives",
    fresh.length > 0 && incremental === fresh,
    incremental === fresh ? `${fresh.split(" | ").length} chips` : `incremental ${incremental}\n   fresh       ${fresh}`,
  );

  // A42: the scan-root bound. One burst may become at most MAX_SCAN_ROOTS walks, however many
  // nodes it touched. Without it a page that re-renders its islands (dev.to) turned ~200
  // dirty nodes into ~200 walks, each paying a whole-document byline survey.
  await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: true }, res)));
  const noisy = await context.newPage();
  const drains = [];
  noisy.on("console", (m) => {
    const hit = /dirty scan: (\d+) dirty, \d+ removed, (\d+) planned, (\d+) roots,/.exec(m.text());
    if (hit) drains.push({ dirty: +hit[1], planned: +hit[2], roots: +hit[3] });
  });
  await noisy.goto(server.url("/incremental.html"), { waitUntil: "load" });
  await chipsSettled(noisy);
  await noisy.evaluate(() => {
    // 120 separate parents touched in one burst — what an island re-render looks like.
    for (const p of document.querySelectorAll("#feed p.body, #essay p")) {
      const span = document.createElement("span");
      span.textContent = " and then some more of it.";
      p.appendChild(span);
    }
    for (let k = 0; k < 60; k++) {
      const d = document.createElement("div");
      d.textContent = "row " + k;
      document.getElementById("essay").appendChild(d);
    }
  });
  await noisy.waitForTimeout(2500);
  await noisy.close();
  const burst = drains.filter((d) => d.dirty > 10);
  record(
    "ui",
    "a mutation burst is bounded to at most ten walks, whatever it touched",
    burst.length > 0 && burst.every((d) => d.planned <= 10),
    JSON.stringify(drains.slice(-6)),
  );

  // A43: a URL rewritten while the reader scrolls is not a route change. Discourse rewrites the
  // address with the post number on every scroll step — 51 whole-document re-walks in a
  // 90-second session — while a pushed entry still gets its refresh.
  const routed = await context.newPage();
  const refreshes = [];
  routed.on("console", (m) => {
    if (m.text().includes("url change refresh")) refreshes.push(m.text().slice(-60));
  });
  await routed.goto(server.url("/incremental.html"), { waitUntil: "load" });
  await chipsSettled(routed);
  const chipsBefore = await chipSig(routed);
  await routed.evaluate(() => {
    for (let i = 0; i < 20; i++) history.replaceState(null, "", `?post=${i}`);
  });
  await routed.waitForTimeout(2000);
  const afterRewrites = refreshes.length;
  const chipsAfter = await chipSig(routed);
  // A real route change: a pushed entry AND the content it brings.
  await routed.evaluate(() => {
    history.pushState(null, "", "/incremental.html?route=2");
    for (let i = 0; i < 3; i++) history.replaceState(null, "", `/incremental.html?route=2&t=${i}`);
  });
  await routed.waitForTimeout(2000);
  const afterRoute = refreshes.length;
  await routed.close();
  await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: false }, res)));
  record(
    "ui",
    "twenty URL rewrites cost no re-walk and no chip; a pushed entry is refreshed once",
    afterRewrites === 0 && chipsAfter === chipsBefore && afterRoute - afterRewrites === 1,
    JSON.stringify({ afterRewrites, afterRoute, chipsKept: chipsAfter === chipsBefore }),
  );

  // ---- A44-A46: the insertion gate — nothing enters a tree that has still to hydrate ---
  // Both pages carry an image the server holds back, so `load` is late enough for the
  // question to mean something: without a hydration marker the chips are in the page long
  // before it, with one they wait for it and the idle period after it.
  const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const slow = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "image/gif", "content-length": GIF.length });
      res.end(GIF);
    }, 900); // the page's own `load` waits for this
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  const slowGif = `http://localhost:${slow.address().port}/slow.gif`;
  const HYDRATING = (marked) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marked ? "hydrating" : "plain"} page</title></head>
<body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
${marked ? '<div id="__docusaurus">' : "<div id=\"plain\">"}
<p id="h1">${PARA("HYDRATE-ONE")}</p><p id="h2">${PARA("HYDRATE-TWO")}</p></div>
<img src="${slowGif}" width="1" height="1" alt="">
<script>
// What a framework sees in its own tree at the moment it would hydrate.
window.__loadAt=null;window.__seenAtLoad=null;
addEventListener("load",()=>{window.__loadAt=performance.now();
  window.__seenAtLoad=document.querySelectorAll('#__docusaurus [data-anagram], #plain [data-anagram]').length;});
</script></body></html>`;
  PAGES["/hydrating.html"] = HYDRATING(true);
  PAGES["/plainpage.html"] = HYDRATING(false);

  const firstHostWatcher = () => {
    window.__firstHostAt = null;
    new MutationObserver((recs) => {
      if (window.__firstHostAt !== null) return;
      for (const rec of recs) {
        for (const n of rec.addedNodes) {
          // The ball is ours and lives outside anything a framework hydrates; what this
          // watches for is a CHIP entering the page's own tree.
          if (n.nodeType === 1 && n.getAttribute?.("data-anagram") === "host" && n.id !== "anagram-fab") {
            window.__firstHostAt = performance.now();
            return;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true }); // `document`: at document_start there is no <html> yet
  };

  const openPage = async (path) => {
    const p = await context.newPage();
    const held = [];
    p.on("console", (m) => {
      const hit = /insertion gate open, (\d+) held/.exec(m.text());
      if (hit) held.push(+hit[1]);
    });
    await p.addInitScript(firstHostWatcher);
    await p.goto(server.url(path), { waitUntil: "load" });
    await chipsSettled(p);
    const t = await p.evaluate(() => ({
      loadAt: window.__loadAt,
      firstHostAt: window.__firstHostAt,
      seenAtLoad: window.__seenAtLoad,
    }));
    const shown = await p.evaluate(
      (sel) => [...document.querySelectorAll(sel)].map((h) => h.shadowRoot?.querySelector(".num")?.textContent?.trim() ?? "?"),
      BADGE_SEL,
    );
    await p.close();
    return { ...t, chips: shown.length, shown, held: held[0] ?? null };
  };

  await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: true }, res)));
  const marked = await openPage("/hydrating.html");
  const plain = await openPage("/plainpage.html");

  record(
    "ui",
    "a page that has still to hydrate gets no chip until it has, and still gets its chips",
    // The verdicts land while the gate is shut — the fixture answers in milliseconds and the
    // image holds `load` back — so this also says that a chip held back and then released
    // arrives as its VERDICT and never as a pending chip nobody comes back to.
    marked.chips === 2 &&
      marked.shown.every((n) => /^(\.\d\d|1\.0)$/.test(n)) &&
      marked.seenAtLoad === 0 &&
      marked.held > 0 &&
      marked.firstHostAt > marked.loadAt,
    JSON.stringify(marked),
  );
  record(
    "ui",
    "a page with no hydration marker is chipped as early as ever",
    plain.chips >= 2 && plain.held === 0 && plain.firstHostAt !== null && plain.firstHostAt < plain.loadAt,
    JSON.stringify(plain),
  );

  // Torn down while the chips were still waiting: nothing may be drawn into the page
  // afterwards, nothing may stay armed to draw it, and the next run starts clean.
  const torn = await context.newPage();
  const gateLines = [];
  torn.on("console", (m) => {
    if (m.text().includes("insertion gate open")) gateLines.push(m.text().slice(-40));
  });
  await torn.addInitScript(firstHostWatcher);
  await torn.goto(server.url("/hydrating.html"), { waitUntil: "domcontentloaded" });
  await torn.waitForTimeout(500); // scored by now; `load` is still waiting on the image
  await torn.bringToFront();
  const tellTab = async (msg) => {
    await sw.evaluate(async (m) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, m);
      } catch {
        /* the content script answers nothing to these */
      }
    }, msg);
  };
  await tellTab({ action: "teardown" });
  await torn.waitForTimeout(4000); // past `load` AND past the gate's own 2.5 s cap
  const afterTeardown = await torn.evaluate(
    (sel) => ({ chips: document.querySelectorAll(sel).length, firstHostAt: window.__firstHostAt }),
    BADGE_SEL,
  );
  const gatesWhileOff = gateLines.length;
  await tellTab({ action: "setEnabled", value: true });
  const cameBack = await chipsSettled(torn);
  const chipsBack = await torn.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL);
  await torn.close();
  await sw.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: false }, res)));

  record(
    "ui",
    "torn down while chips waited for hydration: none is drawn afterwards, nothing stays armed, the next run starts clean",
    afterTeardown.chips === 0 &&
      afterTeardown.firstHostAt === null &&
      gatesWhileOff === 0 &&
      cameBack &&
      chipsBack >= 2 &&
      gateLines.length === 1,
    JSON.stringify({ ...afterTeardown, gatesWhileOff, chipsBack, gates: gateLines.length }),
  );
  await new Promise((r) => slow.close(() => r()));
}

// =====================================================================================
// PHASE B — live sites (soft: unreachable → SKIP; loaded-but-wrong → FAIL)
// =====================================================================================
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

if (!LOCAL_ONLY) {
  for (const site of LIVE) {
    const page = await context.newPage();
    const extErrors = [];
    page.on("console", (m) => {
      const u = m.location()?.url ?? "";
      if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid"))
        extErrors.push(m.text().slice(0, 140));
    });
    let loaded = true;
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      loaded = false;
    }
    if (!loaded) {
      record("live", site.name, null, "goto failed — network/flake");
      await page.close();
      continue;
    }
    // Anti-bot interstitials (Cloudflare "Verifying you are human", "Just a moment…")
    // carry no prose; they say nothing about the extension.
    const botWall = await page
      .evaluate(() => /verifying you are human|just a moment|attention required|checking your browser/i.test(document.title + " " + (document.body?.innerText ?? "").slice(0, 600)))
      .catch(() => false);
    if (botWall) {
      record("live", site.name, null, "bot-check interstitial (Cloudflare) — not a page");
      await page.close();
      continue;
    }
    await page.waitForSelector(BADGE_SEL, { timeout: 10000 }).catch(() => {});
    // Lazy sections (HF community comments) need a patient sweep + settle.
    await sweep(page, 6);
    await page.waitForTimeout(3200);

    const stats = await page
      .evaluate((sel) => {
        const hosts = [...document.querySelectorAll(sel)];
        const anchors = hosts.map((h) => h.parentElement).filter(Boolean);
        let chrome = 0;
        let inPre = 0;
        for (const el of anchors) {
          if (el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]")) chrome++;
          if (el.closest("pre")) inPre++;
        }
        return { badges: hosts.length, chrome, inPre, sample: (anchors[0]?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60) };
      }, BADGE_SEL)
      .catch(() => null);

    await page.screenshot({ path: artifact(`scn-${site.name}.png`) }).catch(() => {});
    if (!stats) {
      record("live", site.name, null, "evaluate failed");
      await page.close();
      continue;
    }

    let ok = true;
    const notes = [`badges=${stats.badges}`, `chrome=${stats.chrome}`];
    if (site.min !== undefined && stats.badges < site.min) ok = false;
    if (site.max !== undefined && stats.badges > site.max) ok = false;
    if (site.chromeMax !== undefined && stats.chrome > site.chromeMax) ok = false;
    if (site.noPre && stats.inPre > 0) { ok = false; notes.push(`inPre=${stats.inPre}`); }
    if (extErrors.length > 0) { ok = false; notes.push(`extErrors=${extErrors.length}`); }
    if (stats.sample) notes.push(`“${stats.sample}”`);
    record("live", site.name, ok, notes.join("  "));
    await page.close();
  }
}

// ---- summary -------------------------------------------------------------------------
await context.close();
await server.close();
await fileServer.close();
await fixture.close();

console.log("\n=== SCENARIO RESULTS ===");
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  [${r.phase}]  ${r.name}${r.note ? `  —  ${r.note}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length} pass / ${fails.length} fail / ${skips.length} skip`);
console.log(fails.length === 0 ? "✅ SCENARIOS GREEN" : "❌ SCENARIO FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
