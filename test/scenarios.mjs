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
import http from "node:http";
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
const REWRITE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>rewrite fixture</title></head><body>
<p>Interstitial: checking your browser, please wait…</p>
<script>
  setTimeout(() => {
    document.open();
    document.write('<!doctype html><html><head><meta charset="utf-8"><title>rewritten</title></head><body><main><p id="rw1">${PARA("REWRITTEN-ONE")}</p><p id="rw2">${PARA("REWRITTEN-TWO")}</p></main></body></html>');
    document.close();
  }, 1500);
</script></body></html>`;
// Scope fixture: an article region both the text-mass probe and Defuddle land on,
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
    const mark = fixture.textMark();
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
    const machineSent = fixture.textsSince(mark).some((t) => t.includes("MACHINE-"));
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

  // A22c: the same for Edge's translator and Firefox's full-page translation, which mark the
  // page their own ways (lib/dom/translation.ts), both modelled here. Edge gives every element
  // it rewrites `_msttexthash` and `_msthash`, and takes them away with the translation.
  // Firefox relabels <html lang> and numbers the elements inside a block it is translating
  // with `data-moz-translations-id` until the translation is in; its "Show original" reloads
  // the page, so there is no way back to check. And Immersive Translate's bilingual copy,
  // `font.immersive-translate-target-wrapper`, is never read beside the original.
  for (const browser of ["edge", "firefox"]) {
    const path = `/translated-${browser}.html`;
    PAGES[path] = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>translated fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<main><p id="t1">${PARA("ORIGINAL-ONE")} <a href="#one">Mehr dazu</a></p><p id="t2">${PARA("ORIGINAL-TWO")} <a href="#two">Mehr dazu</a></p></main>
<script>
  const saved = [];
  window.__translate = ${browser === "edge"
    ? `() => {
    let n = 0;
    for (const p of document.querySelectorAll("main p")) {
      const text = p.firstChild;
      saved.push([p, text.data]);
      p.setAttribute("_msttexthash", String(1000 + n));
      p.setAttribute("_msthash", String(++n));
      text.data = text.data.replace("ORIGINAL", "MACHINE");
    }
  }`
    : `() => {
    document.documentElement.lang = "en";
    for (const p of document.querySelectorAll("main p")) {
      p.querySelectorAll("*").forEach((el, i) => { el.dataset.mozTranslationsId = String(i); });
      p.firstChild.data = p.firstChild.data.replace("ORIGINAL", "MACHINE");
      p.querySelectorAll("*").forEach((el) => { delete el.dataset.mozTranslationsId; });
    }
  }`};
  window.__revert = () => {
    for (const [p, data] of saved.splice(0)) {
      p.removeAttribute("_msttexthash");
      p.removeAttribute("_msthash");
      p.firstChild.data = data;
    }
  };
</script></body></html>`;
    const p = await context.newPage();
    await p.goto(server.url(path), { waitUntil: "load" });
    const settled = (n) =>
      p.waitForFunction(({ sel, n }) => {
        const hosts = [...document.querySelectorAll(sel)];
        return hosts.length === n && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
      }, { sel: BADGE_SEL, n }, { timeout: 15000 }).then(() => true).catch(() => false);
    const look = () => p.evaluate((sel) => ({ chips: document.querySelectorAll(sel).length, ball: !!document.getElementById("anagram-fab") }), BADGE_SEL);
    const mark = fixture.textMark();
    const before = (await settled(2)) ? await look() : null;
    await p.evaluate(() => window.__translate());
    await p.waitForTimeout(3000); // past the observers' debounce, the scheduler and the fixture
    const during = await look();
    const machineSent = fixture.textsSince(mark).some((t) => t.includes("MACHINE-"));
    let back = null;
    if (browser === "edge") {
      await p.evaluate(() => window.__revert());
      back = (await settled(2)) ? await look() : await look();
    }
    record(
      "ui",
      `a page ${browser === "edge" ? "Edge's translator" : "Firefox's full-page translation"} translated: nothing is read or left on it while it is translated${browser === "edge" ? ", and it is read again once the original is back" : ""}`,
      !!before && before.chips === 2 && before.ball && during.chips === 0 && !during.ball && !machineSent &&
        (browser !== "edge" || (back.chips === 2 && back.ball)),
      JSON.stringify({ before, during, machineSent, back }),
    );
    await p.close();
  }
  {
    PAGES["/immersive.html"] = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>bilingual fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<main><p id="i1">${PARA("ORIGINAL-IMT")}<font class="immersive-translate-target-wrapper" lang="en"><br><font class="immersive-translate-target-inner">${PARA("MACHINE-IMT")}</font></font></p></main>
</body></html>`;
    const mark = fixture.textMark();
    const p = await context.newPage();
    await p.goto(server.url("/immersive.html"), { waitUntil: "load" });
    await p.waitForSelector(`#i1 ${BADGE_SEL}`, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(1500);
    const sent = fixture.textsSince(mark).filter((t) => t.includes("-IMT"));
    record(
      "ui",
      "Immersive Translate's bilingual copy is never read, the original beside it is",
      sent.length > 0 && sent.every((t) => t.includes("ORIGINAL-IMT") && !t.includes("MACHINE-IMT")),
      JSON.stringify(sent.map((t) => t.slice(0, 40))),
    );
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
      const mark = fixture.textMark();
      const p = await context.newPage();
      await p.goto(server.url("/scope.html"), { waitUntil: "load" });
      await p.waitForSelector(`main ${BADGE_SEL}`, { timeout: 12000 }).catch(() => {});
      await sweep(p, 3);
      await p.waitForTimeout(2500);
      r = {
        inMain: await p.evaluate((sel) => document.querySelectorAll(`main ${sel}`).length, BADGE_SEL),
        outside: await p.evaluate((sel) => document.querySelectorAll(`#offmain ${sel}`).length, BADGE_SEL),
        // Read BEFORE the setting is restored — restoring re-scans the page whole.
        leaked: fixture.textsSince(mark).some((t) => t.includes(SCOPE_MARKER)),
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

  // A28b: a consent platform's banner in a frame of its own is not read. With every site
  // granted the content script runs in each frame, and Sourcepoint's message frame holds a
  // paragraph of consent text as long as any article's. The hosts are served locally (the
  // frames' markup is modelled); the third frame is a Sourcepoint message on the publisher's
  // own domain, known only by its address.
  {
    const CONSENT = (tag) => `${tag} We and our partners store and access information on your device, such as cookies and unique identifiers, and process personal data such as browsing data, to show you personalised advertising and content, to measure how advertising and content perform, to understand our audiences and to develop our services. Some partners rely on their legitimate interest for this, which you can object to. You can accept, reject or choose purpose by purpose, and change your mind at any time from the privacy settings link in the footer of every page.`;
    const message = (tag) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SP Consent Message</title></head><body style="margin:0;font:14px/1.4 sans-serif">
<div id="notice" class="message type-modal" role="dialog" aria-label="Privacy notice" tabindex="0">
  <div class="message-component message-row"><p class="message-component">${CONSENT(tag)}</p></div>
  <div class="message-component message-row"><button class="message-component message-button sp_choice_type_11" title="Accept all">Accept all</button><button class="message-component message-button sp_choice_type_12" title="Settings">Settings</button></div>
</div></body></html>`;
    const trustarc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TrustArc Cookie Consent Manager</title></head><body style="margin:0;font:14px/1.4 sans-serif">
<div class="banner"><div class="banner-content"><h2>How we use your data</h2><p>${CONSENT("TRUSTEFRAME")}</p><button class="call">Agree and proceed</button></div></div></body></html>`;
    await context.route("https://cdn.privacy-mgmt.com/**", (route) => route.fulfill({ contentType: "text/html", body: message("SPCDNFRAME") }));
    await context.route("https://consent-pref.trustarc.com/**", (route) => route.fulfill({ contentType: "text/html", body: trustarc }));
    PAGES["/index.html"] = message("SPCNAMEFRAME");
    PAGES["/consent-top.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>consent frames</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<p id="topp">${PARA("CONSENTHOST")}</p>
<div id="sp_message_container_1000"><iframe id="sp_message_iframe_1000" title="SP Consent Message" src="https://cdn.privacy-mgmt.com/index.html?message_id=1000&amp;consentUUID=00000000-0000&amp;preload_message=true" width="640" height="300"></iframe></div>
<div id="sp_message_container_1001"><iframe id="sp_message_iframe_1001" title="SP Consent Message" src="${server.base.replace("localhost", "127.0.0.1")}/index.html?message_id=1001&amp;requestUUID=00000000-0001" width="640" height="300"></iframe></div>
<div class="truste_box_overlay"><iframe class="truste_popframe" title="TrustArc Cookie Consent Manager" src="https://consent-pref.trustarc.com/?type=example&amp;site=example.com&amp;action=notice&amp;country=gb&amp;locale=en" width="640" height="300"></iframe></div>
</body></html>`;
    const mark = fixture.textMark();
    const p = await context.newPage();
    await p.goto(server.url("/consent-top.html"), { waitUntil: "load" });
    await p.waitForSelector(`#topp ${BADGE_SEL}`, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(4000); // long enough for a frame's chip to have appeared
    const frames = [];
    for (const f of p.frames()) {
      if (f !== p.mainFrame()) frames.push(await f.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL).catch(() => -1));
    }
    const r = {
      top: await p.evaluate((sel) => document.querySelectorAll(`#topp ${sel}`).length, BADGE_SEL),
      frames,
      sent: ["SPCDNFRAME", "SPCNAMEFRAME", "TRUSTEFRAME"].filter((t) => fixture.textsSince(mark).some((s) => s.includes(t))),
    };
    record(
      "ui",
      "a consent platform's banner in a frame of its own (Sourcepoint, on its CDN or the publisher's domain; TrustArc) is not read, the page around it is",
      r.top > 0 && frames.length === 3 && frames.every((n) => n === 0) && r.sent.length === 0,
      JSON.stringify(r),
    );
    await p.close();
    await context.unroute("https://cdn.privacy-mgmt.com/**");
    await context.unroute("https://consent-pref.trustarc.com/**");
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

// ---- A47: following the reader — a fast scroll, a hidden tab ---------------------------
// Every paragraph is its own unit and every text is new to the caches, so each one is
// dispatched by the content script exactly once, and the moment its "analyzing…" chip is
// inserted is the moment it was dispatched.
{
  const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
  const para = (tag, i) => `${tag}-${i} ` + Array.from({ length: 84 }, (_, k) => VOCAB[(i * 7 + k * 13) % VOCAB.length]).join(" ") + ".";
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">${body}</body></html>`;
  PAGES["/scroll.html"] = page("scroll fixture", Array.from({ length: 90 }, (_, i) => `<p id="sp${i}">${para("SCROLLPAST", i)}</p>`).join("\n"));
  PAGES["/hidden.html"] = page("hidden fixture", `<main id="top">${[0, 1].map((i) => `<p>${para("SHOWNFIRST", i)}</p>`).join("")}</main><div style="height:5000px"></div><div id="bottom"></div>`);
  const chipClock = () => {
    window.__chipAt = {};
    new MutationObserver(() => {
      for (const host of document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)')) {
        const p = host.closest("p[id]");
        if (p && !(p.id in window.__chipAt)) window.__chipAt[p.id] = performance.now();
      }
    }).observe(document, { childList: true, subtree: true });
  };

  // A reader flicks through ninety paragraphs to the end of the page while the engine is
  // slow. What was on screen for a moment and is far behind now must wait for what the
  // reader stopped at, not the other way round.
  {
    const p = await context.newPage();
    await p.addInitScript(chipClock);
    fixture.setState({ latency: [700, 700] });
    await p.goto(server.url("/scroll.html"), { waitUntil: "load" });
    await p.waitForFunction(() => Object.keys(window.__chipAt).length > 0, null, { timeout: 12000 }).catch(() => {});
    const end = await p.evaluate(async () => {
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const step = Math.round(innerHeight * 0.9);
      const bottom = document.documentElement.scrollHeight - innerHeight;
      for (let y = step; y < bottom; y += step) {
        scrollTo(0, y);
        await frames();
      }
      scrollTo(0, bottom);
      await frames();
      const rows = [...document.querySelectorAll("p[id]")].map((el) => ({ id: el.id, box: el.getBoundingClientRect() }));
      return {
        t0: performance.now(),
        onScreen: rows.filter((r) => r.box.bottom > 0 && r.box.top < innerHeight).map((r) => r.id),
        // Well outside the 1200 px the prefetch margin reaches above the viewport.
        far: rows.filter((r) => r.box.bottom < -1500).map((r) => r.id),
      };
    });
    const allOnScreen = await p
      .waitForFunction((ids) => ids.every((id) => id in window.__chipAt), end.onScreen, { timeout: 40000 })
      .then(() => true)
      .catch(() => false);
    const r = await p.evaluate(({ onScreen, far, t0 }) => {
      const at = window.__chipAt;
      const last = Math.max(...onScreen.map((id) => at[id] ?? Infinity));
      // A batch dispatched as the scroll stopped may put its chips up a moment later.
      const after = t0 + 100;
      return {
        onScreen: onScreen.length,
        far: far.length,
        farBefore: far.filter((id) => at[id] <= after).length,
        farFirst: far.filter((id) => at[id] > after && at[id] < last).length,
        waitMs: Math.round(last - t0),
      };
    }, end);
    fixture.setState({ latency: [60, 160] });
    record("ui", "a fast scroll: what is on screen when it stops is sent before anything scrolled far past", allOnScreen && r.onScreen > 0 && r.far > 20 && r.farFirst === 0, JSON.stringify(r));
    await p.close();
  }

  // A tab in the background sends nothing — neither what the reader would see there nor
  // the idle prefetch — and picks up where it was the moment it is shown again. Headless
  // Chromium never hides a page, so the content script's own world is told it is hidden,
  // exactly as the browser would tell it: visibilityState and a visibilitychange event.
  {
    const mark = fixture.textMark();
    const p = await context.newPage();
    await p.goto(server.url("/hidden.html"), { waitUntil: "load" });
    await p.waitForFunction((sel) => document.querySelectorAll(`#top ${sel}`).length === 2, BADGE_SEL, { timeout: 12000 }).catch(() => {});
    const cdp = await context.newCDPSession(p);
    const worlds = [];
    cdp.on("Runtime.executionContextCreated", ({ context: c }) => worlds.push(c));
    await cdp.send("Runtime.enable");
    const { frameTree } = await cdp.send("Page.getFrameTree");
    await p.waitForTimeout(200);
    const isolated = worlds.find((c) => c.auxData?.frameId === frameTree.frame.id && c.auxData?.type === "isolated" && c.origin.startsWith("chrome-extension://"));
    const setHidden = (hidden) =>
      cdp.send("Runtime.evaluate", {
        contextId: isolated.id,
        expression: `(() => {
          for (const [key, value] of [["visibilityState", ${hidden} ? "hidden" : "visible"], ["hidden", ${hidden}]])
            Object.defineProperty(document, key, { configurable: true, get: () => value });
          document.dispatchEvent(new Event("visibilitychange"));
        })()`,
      });
    let r = { world: !!isolated };
    if (isolated) {
      await setHidden(true);
      await p.evaluate(([onScreen, below]) => {
        const add = (where, id, text) => {
          const el = document.createElement("p");
          el.id = id;
          el.textContent = text;
          where.append(el);
        };
        add(document.getElementById("top"), "hid-top", onScreen);
        add(document.getElementById("bottom"), "hid-bottom", below);
      }, [para("WHILEHIDDEN", 0), para("WHILEHIDDEN", 1)]);
      await p.waitForTimeout(2500);
      const quiet = await p.evaluate((sel) => document.querySelectorAll(`#hid-top ${sel}, #hid-bottom ${sel}`).length, BADGE_SEL);
      const sent = fixture.textsSince(mark).filter((t) => t.includes("WHILEHIDDEN")).length;
      await setHidden(false);
      const shown = await p
        .waitForFunction((sel) => document.querySelectorAll(`#hid-top ${sel}`).length === 1, BADGE_SEL, { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      r = { world: true, chipsWhileHidden: quiet, sentWhileHidden: sent, shown };
    }
    record("ui", "a hidden tab dispatches nothing, not even the idle prefetch, and resumes when shown", r.world && r.chipsWhileHidden === 0 && r.sentWhileHidden === 0 && r.shown, JSON.stringify(r));
    await cdp.detach().catch(() => {});
    await p.close();
  }
}

// ---- A48: shadow roots the first walk could not see ------------------------------------
// Nothing of these is in the light DOM: a shadow root attached, or filled, after the walk
// passed its host changes no node the document's own observer watches.
//  - #lc: an element the page defines late; its upgrade attaches the root and renders.
//  - #panel: a fixed panel with an empty root when the page is walked — too small then
//    to be read, so the walk never goes in — filled later.
//  - #panel2: the same panel added after the walk, its root attached before it was added.
{
  const LONG = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a web component may attach its shadow root or render into it long after the extension walked past its host, and the text it shows the reader there has to be found all the same, without a reload and without anything in the light document changing at the same moment to point at it.`;
  PAGES["/shadow-late.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>late shadow roots</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>Late shadow roots</h1>
<late-card id="lc"></late-card>
<script>
  const LONG = ${LONG.toString()};
  const panel = (id, bottom) => {
    const el = document.createElement("div");
    el.id = id;
    el.style.cssText = "position:fixed;right:8px;bottom:" + bottom + "px;width:420px;max-height:40vh;overflow:auto;background:#fff;font:14px/1.5 system-ui";
    window["__" + id] = el.attachShadow({ mode: "open" });
    document.body.append(el);
  };
  panel("panel", 8);
  // Apart in time: adding a node to the body has the body walked again, and that walk
  // would find a root attached just before it.
  setTimeout(() => panel("panel2", 260), 1200);
  setTimeout(() => customElements.define("late-card", class extends HTMLElement {
    connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<p>" + LONG("LATECARD") + "</p>"; }
  }), 2400);
  setTimeout(() => {
    __panel.innerHTML = "<p>" + LONG("LATEPANEL") + "</p>";
    __panel2.innerHTML = "<p>" + LONG("LATEPANELTWO") + "</p>";
  }, 3200);
</script></body></html>`;
  const p = await context.newPage();
  await p.goto(server.url("/shadow-late.html"), { waitUntil: "load" });
  const chipsIn = (id) => p.evaluate(({ id, sel }) => document.getElementById(id)?.shadowRoot?.querySelectorAll(sel).length ?? -1, { id, sel: BADGE_SEL });
  const settled = await p
    .waitForFunction((sel) => ["lc", "panel", "panel2"].every((id) => (document.getElementById(id)?.shadowRoot?.querySelectorAll(sel).length ?? 0) > 0), BADGE_SEL, { timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  const r = { settled, defined: await chipsIn("lc"), filled: await chipsIn("panel"), added: await chipsIn("panel2") };
  record("ui", "a shadow root attached after the walk (a late custom element) is read", r.defined === 1, JSON.stringify(r));
  record("ui", "a shadow root the walk passed empty, filled later, is read — on the page from the start or added after", r.filled === 1 && r.added === 1, JSON.stringify(r));
  await p.close();
}

// ---- A49: closed shadow roots ------------------------------------------------------------
// A closed root keeps the page's other scripts out, not the extension: Chrome gives a content
// script every root through chrome.dom.openOrClosedShadowRoot. The page keeps its own
// references in window.__closed, which is how this test looks inside.
//  - #cc: a custom element whose closed root is there when the page is walked.
//  - #cd: a plain <div> given a closed root after the walk, announced by the page-world script.
{
  const LONG = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a component may keep its shadow root closed to the scripts of the page it sits in, which is its own business, while the reader who asked for the page to be analyzed still sees every word it renders there and expects a verdict for them like for any other paragraph.`;
  PAGES["/shadow-closed.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>closed shadow roots</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>Closed shadow roots</h1>
<closed-card id="cc"></closed-card>
<div id="cd"></div>
<script>
  const LONG = ${LONG.toString()};
  window.__closed = {};
  customElements.define("closed-card", class extends HTMLElement {
    constructor() { super(); window.__closed.cc = this.attachShadow({ mode: "closed" }); window.__closed.cc.innerHTML = "<p>" + LONG("CLOSEDCARD") + "</p>"; }
  });
  setTimeout(() => {
    window.__closed.cd = document.getElementById("cd").attachShadow({ mode: "closed" });
    window.__closed.cd.innerHTML = "<p>" + LONG("CLOSEDDIV") + "</p>";
  }, 2000);
</script></body></html>`;
  const p = await context.newPage();
  await p.goto(server.url("/shadow-closed.html"), { waitUntil: "load" });
  const count = () => p.evaluate((sel) => Object.fromEntries(["cc", "cd"].map((id) => [id, window.__closed[id]?.querySelectorAll(sel).length ?? -1])), BADGE_SEL);
  await p.waitForFunction((sel) => ["cc", "cd"].every((id) => (window.__closed[id]?.querySelectorAll(sel).length ?? 0) > 0), BADGE_SEL, { timeout: 12000 }).catch(() => {});
  const r = await count();
  record("ui", "a closed shadow root is read: a custom element's at load, a <div>'s attached later", r.cc === 1 && r.cd === 1, JSON.stringify(r));
  await p.close();
}

// ---- A50: frames with no address of their own --------------------------------------------
// An EPUB reader shows each chapter in a srcdoc frame (epub.js), editors and embeds write
// into about:blank frames, and some pages show a blob: document. Each has its parent's
// origin, which is granted, and gets the content script through it. A sandboxed frame has
// no origin at all — the worker could not tell whose it is — and is left alone.
{
  const LONG = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a chapter of a book may be shown in a frame that has no address of its own, only the origin of the page that wrote it, and the reader of that page still expects every paragraph of the chapter to be read like any other paragraph on the site they turned the extension on for.`;
  const doc = (tag) => `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:12px;font:15px/1.6 system-ui"><p>${LONG(tag)}</p></body></html>`;
  const attr = (html) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  PAGES["/frames-local.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frames without an address</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<iframe id="srcdoc" srcdoc="${attr(doc("SRCDOCFRAME"))}" width="640" height="300"></iframe>
<iframe id="blank" width="640" height="300"></iframe>
<iframe id="blob" width="640" height="300"></iframe>
<iframe id="sandboxed" sandbox srcdoc="${attr(doc("SANDBOXEDFRAME"))}" width="640" height="300"></iframe>
<script>
  document.getElementById("blank").contentDocument.body.innerHTML = ${JSON.stringify(`<p style="font:15px/1.6 system-ui">${LONG("BLANKFRAME")}</p>`)};
  document.getElementById("blob").src = URL.createObjectURL(new Blob([${JSON.stringify(doc("BLOBFRAME"))}], { type: "text/html" }));
</script></body></html>`;
  const mark = fixture.textMark();
  const p = await context.newPage();
  await p.goto(server.url("/frames-local.html"), { waitUntil: "load" });
  // The sandboxed frame is out of the page's reach but not of the test's: every chip host
  // ever inserted there is counted, the "analyzing…" ones a refused request takes down too.
  const quietFrame = [];
  for (const f of p.frames()) {
    if (f === p.mainFrame()) continue;
    const isSandboxed = await f.evaluate(() => window.origin === "null").catch(() => false);
    if (!isSandboxed) continue;
    quietFrame.push(f);
    await f.evaluate(() => {
      window.__hosts = document.querySelectorAll('[data-anagram="host"]').length;
      new MutationObserver((records) => {
        for (const rec of records) for (const n of rec.addedNodes) if (n.nodeType === 1 && n.matches('[data-anagram="host"]')) window.__hosts++;
      }).observe(document, { childList: true, subtree: true });
    });
  }
  const inFrame = (id) => p.evaluate(({ id, sel }) => document.getElementById(id)?.contentDocument?.querySelectorAll(sel).length ?? -1, { id, sel: BADGE_SEL });
  await p.waitForFunction((sel) => ["srcdoc", "blank", "blob"].every((id) => (document.getElementById(id)?.contentDocument?.querySelectorAll(sel).length ?? 0) > 0), BADGE_SEL, { timeout: 12000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const r = {
    srcdoc: await inFrame("srcdoc"),
    blank: await inFrame("blank"),
    blob: await inFrame("blob"),
    sandboxedFrames: quietFrame.length,
    sandboxedChips: quietFrame.length ? await quietFrame[0].evaluate(() => window.__hosts).catch(() => -1) : -1,
    sandboxedSent: fixture.textsSince(mark).some((t) => t.includes("SANDBOXEDFRAME")),
  };
  record("ui", "a srcdoc, an about:blank and a blob: frame on a granted page are read, each in its own frame", r.srcdoc === 1 && r.blank === 1 && r.blob === 1, JSON.stringify(r));
  record("ui", "a sandboxed frame, whose origin the worker cannot know, is left alone", r.sandboxedFrames === 1 && r.sandboxedChips === 0 && !r.sandboxedSent, JSON.stringify(r));
  await p.close();
}

// ---- A51: a comment thread in another site's frame ------------------------------------------
// Disqus shows a page's comments in a frame of disqus.com, which a content script reaches only
// once that site is granted too. The test build grants every site, so this runs a copy of it
// that grants localhost ALONE — the page's own site — and leaves the rest optional, as a
// reader's per-site grant does (the way test/pw/pdf-install.spec.mjs grants file access alone).
// A permission prompt is native UI no automation can answer: what is checked is that the
// panel names the site and offers it, that nothing is ever asked for by itself, and that the
// offer's button opens Settings at the one row that can ask.
{
  const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { EXT, waitForRegistration } = await import("./harness.mjs");
  const dir = mkdtempSync(join(tmpdir(), "anagram-localhost-grant-"));
  const ext = join(dir, "chrome-mv3");
  cpSync(EXT, ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  manifest.name += " — LOCALHOST GRANT TEST ONLY";
  manifest.host_permissions = ["http://localhost/*"];
  manifest.optional_host_permissions = ["https://*/*", "http://*/*", "file:///*"];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));
  const one = await launchExtension({ nativeFixture: fixture, extDir: ext });
  try {
    if (one.sw) await waitForRegistration(one.sw);
    await one.context.route("https://disqus.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html lang="en"><body><p>${KEY_PARA("DISQUSCOMMENT")}</p></body></html>` }),
    );
    PAGES["/comments.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>comments from another site</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
${KEY_TAGS.slice(0, 2).map((t) => `<p>${KEY_PARA(t)}</p>`).join("\n")}
<div id="disqus_thread"><iframe id="dsq-app1" src="https://disqus.com/embed/comments/?base=default&f=fixture&t_u=http%3A%2F%2Flocalhost%2Fcomments.html" width="680" height="400"></iframe></div>
</body></html>`;
    const granted = () => one.sw.evaluate(() => chrome.permissions.contains({ origins: ["https://disqus.com/*"] }));
    const mark = fixture.textMark();
    const p = await one.context.newPage();
    await p.goto(server.url("/comments.html"), { waitUntil: "load" });
    await p.waitForFunction((sel) => document.querySelectorAll(sel).length >= 2, BADGE_SEL, { timeout: 12000 }).catch(() => {});
    await p.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const offer = await p
      .waitForFunction(() => {
        const row = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".panel.open .pcomments");
        const button = row?.querySelector("button");
        return row && button ? { text: row.textContent, label: button.getAttribute("aria-label") } : null;
      }, null, { timeout: 8000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    const before = await granted();
    const frameRead = fixture.textsSince(mark).some((t) => t.includes("DISQUSCOMMENT"));
    const opened = one.context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
    await p.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".pcomments button")?.click());
    const settingsPage = await opened;
    let row = null;
    if (settingsPage) {
      await settingsPage.waitForLoadState("load").catch(() => {});
      row = await settingsPage
        .waitForFunction(() => {
          const el = document.getElementById("comments");
          const button = document.getElementById("commentsAllow");
          return el && !el.hidden && button && !button.hidden && button.textContent ? { text: document.getElementById("commentsState")?.textContent, button: button.textContent, url: location.hash, focused: document.activeElement === button } : null;
        }, null, { timeout: 8000 })
        .then((h) => h.jsonValue())
        .catch(() => null);
    }
    const after = await granted();
    record("ui", "a comment thread in another site's frame is not read; the panel names that site and offers to allow it",
      !!offer && offer.text.includes("disqus.com") && offer.label.includes("disqus.com") && !frameRead, JSON.stringify({ offer, frameRead }));
    record("ui", "…the offer asks for nothing by itself: its button opens Settings at the one row that can, and the site stays ungranted until the reader says yes there",
      before === false && after === false && !!row && row.text.includes("disqus.com") && row.button.includes("disqus.com") && row.url === "#comments=disqus.com" && row.focused,
      JSON.stringify({ before, after, row }));
    const forged = await one.context.newPage();
    await forged.goto(`chrome-extension://${new URL(one.sw.url()).host}/options.html#comments=bank.example`, { waitUntil: "load" });
    await forged.waitForTimeout(400);
    const forgedShown = await forged.evaluate(() => !document.getElementById("comments")?.hidden);
    record("ui", "…and Settings offers only a comment provider, whatever its address names", forgedShown === false, JSON.stringify({ forgedShown }));
    await forged.close();
    await settingsPage?.close();
    await p.close();
  } finally {
    await one.context.close();
    rmSync(dir, { recursive: true, force: true });
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
