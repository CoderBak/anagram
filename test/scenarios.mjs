// test/scenarios.mjs — the wide-net scenario matrix.
//
// Phase A (deterministic, local): what test/pw/scenarios-*.spec.mjs do not cover yet —
// keyboard-only access to the triage panel and its commands on /keyboard.html, a
// cross-origin no-referrer subframe obeying the top page's site rule, and more.
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
import { launchExtension, serveHtml, artifact, uiLanguage, uiLanguageOf, BADGE_SEL } from "./harness.mjs";
import { createNativeFixture, fakeScore, fakeTokens, EXTENSION_VERSION } from "./fake-native.mjs";
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
import { surfaceScenarios } from "./scenario-surfaces.mjs";
import { crashScenarios } from "./scenario-crash.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_ONLY = process.argv.includes("--local");

const results = []; // { phase, name, status: PASS|FAIL|SKIP, note }
const record = (phase, name, ok, note = "") =>
  results.push({ phase, name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note });

// ---- the panel's Copy report -----------------------------------------------------------
// The report is built before it is written — its paragraph links alone may take 1.5 s
// (lib/render/textFragment.ts) — so the clipboard is read once it holds something else
// than the sentinel put there first, never after a fixed pause.
const NO_REPORT = "NO REPORT COPIED";
const clearClipboard = (p) => p.evaluate((s) => navigator.clipboard.writeText(s).catch(() => {}), NO_REPORT);
const readCopiedReport = (p, { timeout = 10000 } = {}) =>
  p.evaluate(async ({ sentinel, timeout }) => {
    const end = Date.now() + timeout;
    for (;;) {
      const text = await navigator.clipboard.readText().catch(() => null);
      if ((text && text !== sentinel) || Date.now() > end) return text;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, { sentinel: NO_REPORT, timeout }).catch(() => null);

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
// Links fixture: two paragraphs the fake scores as AI-generated, far down a long page, each
// opening and closing on words of its own so a link can name it by them alone. The tags are
// found here rather than written down: the fake's verdict is a pure function of the text.
const LINK_PARA = (tag) => `${tag} opens this paragraph, written so that a copied report can point back to it: the link names its first words and its last, the browser finds them, scrolls the page until the paragraph is in view and marks it, and whoever opens the report later lands on the words it is about instead of the top of a long page, which is the whole point of giving a paragraph a link of its own, closing on ${tag}.`;
const LINK_TAGS = [];
for (let n = 1; LINK_TAGS.length < 2 && n < 1000; n++) if (fakeScore(LINK_PARA(`LINK-${n}`)).score >= 0.88) LINK_TAGS.push(`LINK-${n}`);
const LINKS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>links fixture</title></head><body style="max-width:720px;margin:0 auto;font:15px/1.6 system-ui">
<h1>Links to flagged paragraphs</h1>
${LINK_TAGS.map((t, i) => `<div style="height:1600px"></div>\n<p id="l${i + 1}">${LINK_PARA(t)}</p>`).join("\n")}
<div style="height:1600px"></div>
</body></html>`;
// A paragraph the fake scores AI-generated by a hair, within .05 of the cut at 5/6.
let CLOSE_TAG = null;
for (let n = 1; !CLOSE_TAG && n < 2000; n++) {
  const score = fakeScore(LINK_PARA(`CLOSE-${n}`)).score;
  if (score > 5 / 6 + 0.005 && score < 5 / 6 + 0.045) CLOSE_TAG = `CLOSE-${n}`;
}
const PAGES = {
  "/ui-fixtures.html": readFileSync(join(__dirname, "ui-fixtures.html"), "utf8"),
  "/links.html": LINKS_HTML,
  "/closecall.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>close call fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>One close call</h1>
<p id="cc">${LINK_PARA(CLOSE_TAG ?? "CLOSE-none")}</p>
</body></html>`,
  // Short fixture: prose, and none of it long enough to judge, alone or together.
  "/short.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>short fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>A page of short notes</h1>
<p>The meeting moved to Thursday afternoon, after the budget review ran long again.</p>
<h2>Parking</h2>
<p>The north lot is closed for repaving until the end of the month, so please use the garage.</p>
</body></html>`,
  "/dense.html": DENSE_HTML,
  "/windows.html": WINDOWS_HTML,
  "/longsel.html": LONGSEL_HTML,
  "/stall.html": STALL_HTML,
  "/keyboard.html": KEYS_HTML,
};
const server = await serveHtml(PAGES);
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
    const mark = fixture.textMark();
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
    const blocks = [...new Set(fixture.textsSince(mark).filter((t) => t.length > 200 && WINDOWED_TEXT.includes(t)))]
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

  // A25b: a flagged paragraph that was read in passes says so in the report, with each
  // pass's own number — whoever reads the report has no underline to look at.
  {
    const p = await context.newPage();
    await p.goto(server.url("/windows.html"), { waitUntil: "load" });
    const chipped = await p
      .waitForFunction((sel) => /^(\.\d\d|1\.0)$/.test(document.querySelector(`#wp ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent ?? ""), BADGE_SEL, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    await clearClipboard(p);
    await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      sr?.querySelector(".pcopy")?.click();
    });
    const report = await readCopiedReport(p);
    // Windows hands the clipboard back with CRLF line ends; the report itself is LF.
    const line = (report ?? "").split(/\r?\n/).find((l) => l.startsWith("1. ")) ?? "";
    const ok = chipped && /; \d+ words; read in \d+ passes: (\.\d\d|1\.0)( · (\.\d\d|1\.0))+\)$/.test(line) && !line.includes("not read");
    record("ui", "copied report: a paragraph read in passes says so, with each pass's own number", ok, JSON.stringify({ chipped, line }));
    await p.close();
  }

  // A25d: with the page's address and passage text both in the report, each flagged
  // paragraph gets a link that reopens the page at it — and the browser really goes there.
  // With either left out, no link: a link is the address plus words of the paragraph.
  {
    const setReport = (url, text) =>
      sw.evaluate((v) => new Promise((res) => chrome.storage.local.set({ reportIncludeUrl: v[0], reportIncludeText: v[1] }, res)), [url, text]);
    const p = await context.newPage();
    const pageUrl = server.url("/links.html");
    await p.goto(pageUrl, { waitUntil: "load" });
    const chipped = await p
      .waitForFunction(
        (sel) => ["l1", "l2"].every((id) => /^(\.\d\d|1\.0)$/.test(document.querySelector(`#${id} ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent ?? "")),
        BADGE_SEL,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    const copyReport = async () => {
      await clearClipboard(p);
      await p.evaluate(() => {
        const sr = document.getElementById("anagram-fab")?.shadowRoot;
        if (!sr?.querySelector(".panel.open")) sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        sr?.querySelector(".pcopy")?.click();
      });
      const text = await readCopiedReport(p);
      return text && text !== NO_REPORT ? text.replace(/\r\n/g, "\n") : null;
    };
    const linksIn = (report) => [...(report ?? "").matchAll(/^ {3}Open at this paragraph: (\S+)$/gm)].map((m) => m[1]);
    await setReport(false, false);
    const privateReport = await copyReport();
    await setReport(true, false);
    const urlOnly = await copyReport();
    await setReport(true, true);
    const full = await copyReport();
    await setReport(false, false);
    const links = linksIn(full);
    // Each link, opened fresh, lands on its paragraph: the page is scrolled far enough that
    // the paragraph is on screen.
    const landed = [];
    for (const [i, link] of links.entries()) {
      const q = await context.newPage();
      await q.goto(link, { waitUntil: "load" });
      await q.waitForTimeout(1200);
      landed.push(
        await q.evaluate((id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { y: Math.round(scrollY), onScreen: r.top >= 0 && r.bottom <= innerHeight };
        }, `l${i + 1}`),
      );
      await q.close();
    }
    const entries = (full ?? "").split("\n").filter((l) => /^\d+\. \*\*/.test(l)).length;
    record(
      "ui",
      "copied report: with the address and passage text included, each flagged paragraph links to the page scrolled to it; without either, no link",
      chipped && LINK_TAGS.length === 2 &&
        typeof privateReport === "string" && !privateReport.includes(":~:") && linksIn(privateReport).length === 0 &&
        typeof urlOnly === "string" && urlOnly.includes(`Page: ${pageUrl}`) && !urlOnly.includes(":~:") && linksIn(urlOnly).length === 0 &&
        entries === 2 && links.length === 2 && links.every((l) => l.startsWith(`${pageUrl}#:~:text=`)) &&
        landed.length === 2 && landed.every((l) => l.onScreen && l.y > 1000) && landed[1].y > landed[0].y,
      JSON.stringify({ chipped, tags: LINK_TAGS, links, landed, urlOnly: urlOnly?.slice(0, 160) }),
    );
    await p.close();
  }

  // A25e: a page where nothing reached the floor says so. "Flagged: 0" there is not a clean
  // page, it is a page that was not judged. And a page whose one verdict is AI-generated by a
  // hair, just over the cut at 5/6, is called uncertain, that paragraph a close call.
  {
    const p = await context.newPage();
    const copyFrom = async (path, ready) => {
      await p.goto(server.url(path), { waitUntil: "load" });
      await p.waitForFunction(ready, BADGE_SEL, { timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(1000); // the ball is up before the first walk has run
      await clearClipboard(p);
      await p.evaluate(() => {
        const sr = document.getElementById("anagram-fab")?.shadowRoot;
        sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        sr?.querySelector(".pcopy")?.click();
      });
      return readCopiedReport(p);
    };
    const report = await copyFrom("/short.html", () => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count"));
    record(
      "ui",
      "copied report: a page with nothing long enough to judge says there was too little text, not that nothing was flagged",
      typeof report === "string" &&
        /Analyzed: 0 units · Flagged: 0 · Too short: [1-9]/.test(report) &&
        report.includes("Too little text to judge: no passage reached the 75 words the model needs for a verdict.") &&
        !report.includes("No paragraphs were flagged") &&
        !report.includes("did not answer") &&
        report.includes("high-stakes decisions"),
      JSON.stringify({ report: report?.slice(0, 400) }),
    );
    const close = await copyFrom("/closecall.html", (sel) => /^(\.\d\d|1\.0)$/.test(document.querySelector(`#cc ${sel}`)?.shadowRoot?.querySelector(".num")?.textContent ?? ""));
    record(
      "ui",
      "copied report: a flagged verdict just over the cut is marked a close call, and a page of such verdicts is called mixed or uncertain",
      !!CLOSE_TAG && typeof close === "string" &&
        close.includes("Mixed or uncertain: 1 of 1 verdicts is a close call") &&
        /^1\. \*\*AI-generated · \.8\d\*\* \(close call; Human /m.test(close),
      JSON.stringify({ tag: CLOSE_TAG, report: close?.slice(0, 700) }),
    );
    await p.close();
  }

  // A25c: a paragraph short in characters and long in tokens (figures, URLs, names) is not
  // left half-read. The engine's count plans it into passes that fit; where the reading still
  // comes back `truncated`, both halves are sent back for a second reading, and when even a
  // half overflows, the card says so.
  {
    const mark = fixture.textMark();
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
    const texts = fixture.textsSince(mark);
    const sent = inOrder([...new Set(texts.filter((t) => t.includes(DENSE_MARKER)))], dense);
    const solid = SOLID_PARA(SOLID_MARKER);
    const halves = inOrder([...new Set(texts.filter((t) => t.includes(SOLID_MARKER) && t !== solid))], solid);
    const ok =
      !!cards &&
      `Read in ${sent.length} passes` in cards.dense.rows &&
      !("Passes cut short" in cards.dense.rows) &&
      !/not read/.test(cards.dense.foot) &&
      !sent.includes(dense) && readWhole(sent, dense) && sent.every((t) => fakeTokens(t) <= 510) &&
      texts.includes(solid) &&
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
    await clearClipboard(p);
    const listed = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const rows = [...(sr?.querySelectorAll(".panel .pitem") ?? [])].map((r) => /: (\S+) paragraph/.exec(r.getAttribute("aria-label") ?? "")?.[1] ?? null);
      sr?.querySelector(".pcopy")?.click();
      return rows;
    });
    const report = await readCopiedReport(p);
    await p.keyboard.press("Escape");
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
  // Reading surfaces: Google Drive's preview read in place, and an ordinary page left alone.
  await surfaceScenarios({ context, fixture, record, artifact, BADGE_SEL, fixturesDir: join(__dirname, "fixtures"), ordinaryUrl: fixturesUrl });

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
    const mark = fixture.textMark(); // what THIS document sends, not the whole run
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
    const sent = fixture.textsSince(mark);
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
      await clearClipboard(p);
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
        return { open: !!sr?.querySelector(".panel.open"), items: sr?.querySelectorAll(".pitem").length ?? -1 };
      });
      report = await readCopiedReport(p);
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
    const mark = fixture.textMark();
    const p = await openReader("/grouped.pdf");
    await visitShortPdf(p);
    await p
      .waitForFunction((sel) => {
        const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
        return pills.length >= 1 && !pills.some((h) => h.shadowRoot.querySelector(".pill.pending"));
      }, BADGE_SEL, { timeout: 20000 })
      .catch(() => {});
    const grouped = await readReader(p);
    const groupedSent = fixture.textsSince(mark);
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
    // "Ready" is painted from the component's status; the runtime panel it mounts then asks
    // for the configurations on its own (lib/ui/runtimeSettings.ts), so the active row
    // arrives a round trip later. The card is read once both are there.
    const waitReady = (page, timeout = 15000) => page.waitForFunction(
      () => document.querySelector("#componentSettings .component-status")?.textContent === "Ready" &&
        !!document.querySelector('#runtimeSettings .runtime-row[data-active="true"]'),
      null, { timeout },
    ).then(() => true).catch(() => false);
    const p = await context.newPage();
    await p.goto(onboardingUrl, { waitUntil: "load" });
    const sawRunning = await waitReady(p);
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
    const cameBack = await waitReady(p);
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
        // The footer's link to this version's source, next to the model credit.
        source: document.getElementById("sourceCode")?.textContent ?? "",
        sourceHref: document.getElementById("sourceCode")?.getAttribute("href") ?? "",
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

      await clearClipboard(p);
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
      const report = await readCopiedReport(p);
      const copied = await p.evaluate(
        () => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".pcopy")?.textContent ?? "",
      );
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
          optionsText.source === "源代码（AGPL-3.0）" &&
          optionsText.sourceHref === `https://github.com/CoderBak/anagram/tree/v${EXTENSION_VERSION}` &&
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
          report.includes("也不能证明作者身份") &&
          report.includes("请勿将其用于纪律处分或其他重大决定"),
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

// The engine dying under the pages' work, in a browser of its own (test/scenario-crash.mjs).
await crashScenarios({ record });

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
