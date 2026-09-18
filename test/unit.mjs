// test/unit.mjs — fast unit tests for the walker/assembler + pure text utils.
//
// The walker classifies layout via getComputedStyle, which jsdom cannot fake —
// so the "unit" harness is a real Chromium page: esbuild bundles lib/dom (+ a few
// pure helpers) into an IIFE global `PW`, the bundle is injected into a blank
// page, and table-driven DOM cases run in-page. The structural fixtures in
// test/fixtures/ (real-site markup, synthetic text) are then opened one by one and
// checked for WHO is scored with whom. No extension load, no network: the whole
// suite runs in a few seconds.
//
//   node test/unit.mjs
import { launchPlain } from "./harness.mjs";
import { buildSync } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUNDLE = join(__dirname, ".unit-bundle.js");

// esbuild's JS API rather than node_modules/.bin/esbuild: the .bin shim is a shell script on
// macOS/Linux and a .cmd on Windows, and only one of those can be exec'd directly.
buildSync({ entryPoints: [join(__dirname, "unit-entry.ts")], bundle: true, format: "iife", globalName: "PW", outfile: BUNDLE, logLevel: "error" });

const browser = await launchPlain({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: BUNDLE });
// Readability is an on-demand vendor chunk in the extension; here the library's own
// browser globals stand in for it so the Readability-guided path is exercised too.
await page.addScriptTag({ path: join(ROOT, "node_modules", "@mozilla", "readability", "Readability.js") });
await page.addScriptTag({ path: join(ROOT, "node_modules", "@mozilla", "readability", "Readability-readerable.js") });
await page.evaluate(() => PW.useReadability({ Readability: window.Readability, isProbablyReaderable: window.isProbablyReaderable }));

const results = await page.evaluate(() => {
  const out = [];
  const check = (name, ok, note = "") => out.push({ name, ok: !!ok, note: String(note) });

  // n readable filler words ending in a period (countWords counts them exactly).
  const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(" ");
  const words = (n) => Array.from({ length: n }, (_, i) => VOCAB[i % VOCAB.length]).join(" ") + ".";

  const sandbox = document.createElement("div");
  document.body.appendChild(sandbox);
  const collect = (html, opts) => {
    sandbox.innerHTML = html;
    const units = PW.collectUnits(sandbox, opts);
    return units.map((u) => ({ parts: u.parts.length, words: u.wordCount, text: u.text }));
  };

  // ---- walker: unit formation -------------------------------------------------------
  let u = collect(`<p>${words(60)}</p>`);
  check("long paragraph → one 1-part unit", u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(60)}</p><p>${words(55)}</p>`);
  check("two long paragraphs → two units", u.length === 2);

  u = collect(`<h2>Title</h2><p>${words(20)}</p><h2>Title</h2>`);
  check("isolated short between headings → dropped", u.length === 0);

  u = collect(`<p>${words(20)}</p><p>${words(20)}</p><p>${words(20)}</p>`);
  check("three short siblings → one 3-part unit", u.length === 1 && u[0].parts === 3, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div>${words(25)}<br><br>${words(26)}</div>`);
  check("BR-split halves → one 2-part unit", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(20)}</p><p>${words(60)}</p><p>${words(20)}</p>`);
  check("short|LONG|short → only the long unit (orphans below floor)", u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(30)}</p><h3>Break</h3><p>${words(30)}</p>`);
  check("heading is a merge barrier", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(30)}</p><p>${words(30)}</p>`);
  check("two 30w shorts merge past the floor", u.length === 1 && u[0].words >= 50);

  u = collect(`<section><p>${words(30)}</p></section><section><p>${words(30)}</p></section>`);
  check("shorts in unrelated sections do NOT merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(30)} <code>npm install</code> ${words(25)}</p>`);
  check("inline <code> stays in the paragraph", u.length === 1 && u[0].text.includes("npm install"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<pre>${words(80)}</pre>`);
  check("<pre> block never scored", u.length === 0);

  u = collect(`<nav><p>${words(60)}</p></nav>`);
  check("<nav> subtree skipped (boilerplate)", u.length === 0);

  u = collect(`<div><a href="#">${words(30)}</a><br><a href="#">${words(30)}</a></div>`);
  check("link-dense runs are barriers, not units", u.length === 0);

  u = collect(`<div contenteditable="true">${words(60)}</div>`);
  check("contenteditable never scored", u.length === 0);

  u = collect(`<div aria-hidden="true">${words(60)}</div>`);
  check("aria-hidden never scored", u.length === 0);

  u = collect(`<div style="display:none">${words(60)}</div>`);
  check("display:none never scored", u.length === 0);

  u = collect(`<div style="visibility:hidden">${words(60)}</div>`);
  check("visibility:hidden never scored", u.length === 0);

  u = collect(`<div style="opacity:0">${words(60)}</div>`);
  check("opacity:0 never scored", u.length === 0);

  u = collect(`<div class="notranslate">${words(60)}</div>`);
  check("notranslate honored", u.length === 0);

  u = collect(`<div translate="no">${words(60)}</div>`);
  check("translate=no honored", u.length === 0);

  const cjk = "这是一个用来验证中文分词与字母检测的完整段落，其中完全没有任何拉丁字母出现，" +
    "但是包含了数量足够多的中文词语，可以顺利越过五十个词的最低门槛，从而形成一个可以被评分的单元，" +
    "并且证明统一码字母判断和中文分词统计都在按预期工作着。";
  u = collect(`<p>${cjk}</p>`);
  check("pure-CJK paragraph scored", u.length === 1, JSON.stringify(u.map(x => x.words)));

  u = collect(`<p>1 2 3 4 5 6 7 8 9 10 11 12</p>`);
  check("letterless run dropped", u.length === 0);

  u = collect(`<div style="white-space:pre">+----+----+\n| A  | B  |\n+----+----+</div><p>${words(30)}</p>`);
  check("ASCII-box run is a barrier; lone neighbor short dropped", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div style="white-space:pre-wrap">${words(30)}\n\n${words(30)}</div>`);
  check("pre-wrap blank-line gap splits then merges → 2 parts", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p><span style="float:left;font-size:2em">T</span>${words(60)}</p>`);
  check("floated drop-cap span stays inline", u.length === 1 && u[0].text.startsWith("T"), JSON.stringify(u.map(x => x.text.slice(0, 12))));

  u = collect(`<p>${words(30)}</p><div style="display:inline-block"><div>${words(9)}</div></div><p>${words(30)}</p>`);
  check("inline-block card with block children does not sever merging siblings", u.length >= 1, JSON.stringify(u.map(x => [x.parts, x.words])));

  sandbox.innerHTML = `<div id="sh"></div>`;
  const sh = sandbox.querySelector("#sh").attachShadow({ mode: "open" });
  sh.innerHTML = `<p>${words(60)}</p>`;
  u = PW.collectUnits(sandbox).map((x) => ({ parts: x.parts.length }));
  check("open shadow root content collected", u.length === 1, JSON.stringify(u));

  u = collect(`<p>${words(30)}<span style="position:absolute;width:1px;height:1px;overflow:hidden">SRONLY LEAK</span> ${words(25)}</p>`);
  check("sr-only inline text excluded mid-sentence", u.length === 1 && !u[0].text.includes("SRONLY"), JSON.stringify(u.map(x => x.parts)));

  sandbox.innerHTML = `<p>${words(60)}</p>`;
  const skipped = PW.collectUnits(sandbox, { claimFilter: () => "skip" });
  check("claimFilter skip suppresses owned runs", skipped.length === 0);

  // ---- inline whitespace fidelity ------------------------------------------------------
  // Whitespace-only text nodes BETWEEN inline elements are the spaces between words.
  u = collect(`<p>${Array.from({ length: 60 }, (_, i) => `<span>${VOCAB[i % VOCAB.length]}</span>`).join(" ")}.</p>`);
  check("span-per-word paragraph keeps its spaces (60 words, one unit)", u.length === 1 && u[0].words === 60, JSON.stringify(u.map(x => [x.words, x.text.slice(0, 30)])));
  u = collect(`<p><b>Alan Turing</b> <small>OBE</small> ${words(55)}</p>`);
  check("`<b>…</b> <small>…</small>` is not glued into one token", u.length === 1 && u[0].text.startsWith("Alan Turing OBE "), JSON.stringify(u.map(x => x.text.slice(0, 24))));
  {
    sandbox.innerHTML = `<p>\n  <span>${words(60)}</span>\n  </p>`;
    const [unit] = PW.collectUnits(sandbox);
    const nodes = unit?.parts[0].nodes ?? [];
    const edgesClean = nodes.length > 0 && nodes[0].textContent.trim() !== "" && nodes[nodes.length - 1].textContent.trim() !== "";
    check("leading/trailing whitespace nodes are not part of the run", edgesClean, JSON.stringify(nodes.map(n => JSON.stringify(n.textContent.slice(0, 8)))));
  }
  {
    sandbox.innerHTML = `<div id="sh2"></div>`;
    sandbox.querySelector("#sh2").attachShadow({ mode: "open" }).innerHTML = `<p>${words(60)}</p>`;
    const roots = [];
    const got = PW.collectUnits(sandbox, { onShadowRoot: (r) => roots.push(r) });
    check("walker reports each open shadow root it descends into", got.length === 1 && roots.length === 1 && roots[0] instanceof ShadowRoot, `${roots.length}`);
  }

  // ---- regression: review-workflow findings ------------------------------------------
  // 1) preserved-whitespace splitting must be IDEMPOTENT (no infinite observe loop).
  sandbox.innerHTML = `<div style="white-space:pre-wrap">${words(30)}\n\n${words(30)}</div>`;
  PW.collectUnits(sandbox);
  const nAfter1 = sandbox.firstElementChild.childNodes.length;
  PW.collectUnits(sandbox);
  PW.collectUnits(sandbox);
  const nAfter3 = sandbox.firstElementChild.childNodes.length;
  check("preserved-ws split is idempotent (no node growth on re-walk)", nAfter1 === nAfter3, `${nAfter1} -> ${nAfter3}`);

  // 2) SVG exclusion fires despite lowercase nodeName; embedded title/style never leak.
  u = collect(`<p>${words(30)} <svg viewBox="0 0 10 10"><title>SVGLEAK</title><style>.q{fill:red}</style><text x="0" y="9">42</text></svg> ${words(25)}</p>`);
  check("inline SVG excluded, title/style text never leaks, sentence intact",
    u.length === 1 && u[0].parts === 1 && !u[0].text.includes("SVGLEAK") && !u[0].text.includes("fill:red"),
    JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 40)])));
  u = collect(`<svg width="400" height="200"><text x="0" y="20">${words(60)}</text></svg>`);
  check("standalone SVG chart text never scored", u.length === 0);

  // 3) inline exclusions must not split the sentence around them.
  u = collect(`<p>${words(30)} <img alt="pic"> ${words(25)}</p>`);
  check("<img> mid-sentence does not split the run", u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${words(30)} <span aria-hidden="true">★</span> ${words(25)}</p>`);
  check("aria-hidden icon mid-sentence does not split the run", u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${words(30)} <span style="display:none">HIDDENLEAK</span> ${words(25)}</p>`);
  check("display:none span mid-sentence: no split, no leak",
    u.length === 1 && u[0].parts === 1 && !u[0].text.includes("HIDDENLEAK"), JSON.stringify(u.map(x => [x.parts, x.words])));

  // 4) column-gap barrier applies ONLY to preserved-whitespace runs.
  u = collect(`<p>${words(30)}          ${words(25)}</p>`);
  check("8+ source spaces in collapsed HTML do not drop prose", u.length === 1, JSON.stringify(u.map(x => x.words)));

  // 5a) strict per-paragraph mode (mergeShorts:false): sub-floor runs are skipped.
  sandbox.innerHTML = `<p>${words(20)}</p><p>${words(20)}</p><p>${words(20)}</p>`;
  const strict = PW.collectUnits(sandbox, { mergeShorts: false });
  check("mergeShorts:false — shorts never grouped", strict.length === 0, JSON.stringify(strict.length));
  sandbox.innerHTML = `<p>${words(60)}</p><p>${words(20)}</p>`;
  const strictLong = PW.collectUnits(sandbox, { mergeShorts: false });
  check("mergeShorts:false — full paragraphs still scored", strictLong.length === 1 && strictLong[0].parts.length === 1);

  // 5) shorts must not merge ACROSS an existing claimed unit.
  sandbox.innerHTML = `<p>${words(20)}</p><p>${words(60)}</p><p>${words(20)}</p>`;
  const first = PW.collectUnits(sandbox);
  const owned = new Set();
  for (const un of first) for (const part of un.parts) for (const n of part.nodes) owned.add(n);
  const second = PW.collectUnits(sandbox, { claimFilter: (nodes) => (nodes.some((n) => owned.has(n)) ? "skip" : "take") });
  check("no merging across a claimed unit on incremental re-scan", second.length === 0, JSON.stringify(second.map(x => [x.parts, x.words])));

  // ---- who may be scored together: voice scopes ----------------------------------------
  // `sent(n)` — n words ending in a full stop; `line(n)` — n words, no punctuation at all.
  const sent = words;
  const line = (n) => words(n).slice(0, -1);
  const partsOf = (x) => x.text.split("\n\n");

  u = collect(`<article><span class="by">alice</span> ${sent(30)}</article><article><span class="by">bob</span> ${sent(30)}</article>`);
  check("two sibling <article>s by different authors never merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div role="article">${sent(30)}</div><div role="article">${sent(30)}</div>`);
  check("…nor two [role=article] posts (Reddit comments)", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<article><p>${sent(30)}</p><p>${sent(30)}</p></article><article><p>${sent(30)}</p></article>`);
  check("the short paragraphs of ONE article still merge; the neighbour's stays out", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(30)}</p><blockquote>${sent(30)}</blockquote>`);
  check("an author and a bare <blockquote> never merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${sent(30)}</p><blockquote><p>${sent(30)}</p></blockquote>`);
  check("…nor with <blockquote><p>", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>AUTHOR-A ${sent(30)}</p><blockquote><p>QUOTED ${sent(30)}</p></blockquote><p>AUTHOR-B ${sent(30)}</p>`);
  check("a quotation interrupts the author's text, it does not end it: [p, p] without the quote",
    u.length === 1 && u[0].parts === 2 && u[0].text.includes("AUTHOR-A") && u[0].text.includes("AUTHOR-B") && !u[0].text.includes("QUOTED"),
    JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>AUTHOR-A ${sent(30)}</p><blockquote><p>QUOTED ${sent(60)}</p></blockquote><p>AUTHOR-B ${sent(30)}</p>`);
  check("a full-length quotation is its own unit; units come back in document order",
    u.length === 2 && u[0].parts === 2 && u[0].text.startsWith("AUTHOR-A") && u[1].parts === 1 && u[1].text.startsWith("QUOTED"),
    JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 10)])));
  {
    sandbox.innerHTML = `<p>${sent(30)}</p><blockquote><p>${sent(60)}</p></blockquote><p>${sent(30)}</p>`;
    const got = PW.collectUnits(sandbox);
    check("ids are unique and `order` ascends in document order", got.length === 2 && got[0].id !== got[1].id && got[0].order < got[1].order, JSON.stringify(got.map(x => [x.id, x.order])));
  }

  u = collect(`<p>${sent(30)}</p><blockquote><p>${sent(20)}</p><cite><a href="#s">The Source, 1931</a></cite></blockquote><p>${sent(30)}</p>`);
  check("a barrier INSIDE a quotation (its linked <cite>) does not end the author's text around it", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(30)}</p><h3>Break</h3><blockquote><p>${sent(30)}</p></blockquote><p>${sent(30)}</p>`);
  check("…while a heading in the author's own flow still does", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(30)}</p><figure><img alt=""><figcaption>CAPTION ${sent(14)}</figcaption></figure><p>${sent(30)}</p>`);
  check("a figure caption between two short paragraphs is not borrowed: [p, p] without it",
    u.length === 1 && u[0].parts === 2 && !u[0].text.includes("CAPTION"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<article><div class="t">${sent(30)}</div><div role="link" tabindex="0"><div class="t">${sent(30)}</div></div></article>`);
  check("a QUOTED post — div[role=link] inside the quoting post's <article> — never merges with it", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div role="link" tabindex="0"><div>${sent(30)}</div></div><div role="link" tabindex="0"><div>${sent(30)}</div></div>`);
  check("feed items that are div[role=link] cards (Bluesky) never merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(58)} <span role="link" tabindex="0">a scripted link</span> inside.</p>`);
  check("an inline span[role=link] is not a scope: the sentence stays whole", u.length === 1 && u[0].parts === 1 && u[0].text.includes("a scripted link inside."), JSON.stringify(u.map(x => [x.parts, x.words])));

  {
    sandbox.innerHTML = `<div id="host-a"></div>`;
    sandbox.querySelector("#host-a").attachShadow({ mode: "open" }).innerHTML = `<p>${sent(30)}</p><blockquote><p>${sent(30)}</p></blockquote>`;
    const inside = PW.collectUnits(sandbox);
    check("a scope inside a shadow root separates there too", inside.length === 0, JSON.stringify(inside.map(x => x.parts.length)));

    // The <article> is OUTSIDE the shadow tree the text lives in: closest() stops at the
    // shadow root, so the lookup has to climb through the host — otherwise this text
    // would count as bare-page text and the title row would cut it in two.
    sandbox.innerHTML = `<article><div id="host-b"></div></article>`;
    sandbox.querySelector("#host-b").attachShadow({ mode: "open" }).innerHTML = `<div><p>${sent(30)}</p><div class="ttl">Finish early</div><p>${sent(30)}</p></div>`;
    const climbed = PW.collectUnits(sandbox);
    check("scope lookup climbs through shadow hosts", climbed.length === 1 && climbed[0].parts.length === 2, JSON.stringify(climbed.map(x => x.parts.length)));
  }

  // ---- who may be scored together: role, not length --------------------------------------
  u = collect(Array.from({ length: 10 }, (_, i) => `<p>POST${i} ${sent(5)}</p>`).join(""));
  check("ten six-word one-sentence paragraphs of one post → ONE unit (the old 8-word floor dropped them all)",
    u.length === 1 && u[0].parts === 10 && u[0].words === 60, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div>${Array.from({ length: 10 }, (_, i) => `L${i} ${line(5)}`).join("<br>")}</div>`);
  check("BR-separated short lines of one block join with NO punctuation at all",
    u.length === 1 && u[0].parts === 10 && u[0].text.startsWith("L0 "), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div style="white-space:pre-wrap">${Array.from({ length: 10 }, (_, i) => `L${i} ${line(5)}`).join("\n\n")}</div>`);
  check("…and so do blank-line-separated lines of a pre-wrap block (X, LinkedIn)", u.length === 1 && u[0].parts === 10, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div>alice_92<br>2h ago<br>${Array.from({ length: 9 }, () => sent(6)).join("<br>")}<br>Reply · Share · Report</div>`);
  check("a handle, a timestamp and an action row set in the message's own block are skipped, never joined",
    u.length === 1 && !/alice_92|2h ago|Reply|Share/.test(u[0].text) && u[0].parts === 9, JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 30)])));

  {
    const thread = (rows) => rows.map(([who, text]) => `<div class="row head">${who} · 2h</div><div class="row msg">${text}</div><div class="row act">Reply · Share</div>`).join("");
    u = collect(`<div class="thread">${thread([["alice", sent(30)], ["bob", sent(30)], ["carol", sent(30)]])}</div>`);
    check("div-soup thread: short comments do NOT merge across the name / action rows between them", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<div class="thread"><div class="row head">alice · 2h</div><div class="row msg">A1 ${sent(30)}</div><div class="row msg">A2 ${sent(30)}</div><div class="row act">Reply · Share</div><div class="row head">bob · 1h</div><div class="row msg">B1 ${sent(20)}</div></div>`);
    check("…one speaker's consecutive messages do; the next speaker's orphan does not extend that unit",
      u.length === 1 && u[0].parts === 2 && !u[0].text.includes("B1") && !/alice|bob|Reply/.test(u[0].text), JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 12)])));
  }

  u = collect(`<article><div class="who">Alice Moreau</div><p>${sent(30)}</p><div class="meta">Edited 2h ago</div><p>${sent(30)}</p><div class="act">Reply · Share</div></article>`);
  check("name, 'Edited 2h ago' and action rows inside a post are transparent — and never part of its text",
    u.length === 1 && u[0].parts === 2 && !/Alice|Edited|Reply/.test(u[0].text), JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 20)])));

  u = collect(`<article><p>${sent(30)}</p><p><strong>2. One owner per decision</strong></p><p>${sent(30)}</p></article>`);
  check("inside an <article> a bold pseudo-heading is transparent: the sections still merge, without it",
    u.length === 1 && u[0].parts === 2 && !u[0].text.includes("owner"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div><div class="txt">${sent(30)}</div><div class="ttl">Finish early</div><div class="txt">${sent(30)}</div></div>`);
  check("on the bare page the same row is indistinguishable from a name row and ends the group (like a real heading)", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(30)}</p><div class="widget"><div class="bar"><div class="btns"><span style="display:block">Play</span></div></div></div><p>${sent(30)}</p>`);
  check("a label buried deeper than the text is a widget's crumb, not a boundary (MDN's live-sample 'Play')", u.length === 1 && u[0].parts === 2 && !u[0].text.includes("Play"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<ul><li>${line(12)}</li><li>Sea salt</li><li>${sent(20)}</li><li>Rest the dough</li><li>${line(20)}</li></ul>`);
  check("bullet items join with or without a full stop; a short item is skipped, never a boundary",
    u.length === 1 && u[0].parts === 3 && !/Sea salt|Rest the dough/.test(u[0].text), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<dl><dt>Brown butter</dt><dd>${sent(30)}</dd><dt>Rolled oats</dt><dd>${sent(30)}</dd></dl>`);
  check("a glossary <dt> is a term, not a boundary", u.length === 1 && u[0].parts === 2 && !u[0].text.includes("Brown"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(25)}</p><p>Can also be written as:</p><p>${sent(25)}</p>`);
  check("a lead-in sentence ending in a colon is the author's own and joins", u.length === 1 && u[0].parts === 3, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div class="log"><div>${sent(30)}</div><div>bob wrote:</div><div>${sent(30)}</div></div>`);
  check("…but 'bob wrote:' names somebody else: a label, and on the bare page a boundary", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(30)}</p><p>Yes.</p><p>${sent(30)}</p>`);
  check("a punctuated aside too short to be evidence ('Yes.') is skipped without consequence", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(30)}</p><p>Hodges 1983, p. 208.</p><p>Alice Moreau, Ph.D.</p><p>SIGN UP TODAY!</p><p>${sent(30)}</p>`);
  check("a citation, a name with a title and a shouting button end in punctuation but are not sentences",
    u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  {
    const zh = "我完全同意你的看法。";
    u = collect(Array.from({ length: 12 }, () => `<p>${zh}</p>`).join(""));
    check("short CJK sentences (。) are sentences too", u.length >= 1 && u[0].parts > 1, JSON.stringify(u.map(x => [x.parts, x.words])));
  }

  u = collect(`<div>${line(5)}<br>${Array.from({ length: 9 }, () => sent(6)).join("<br>")}</div>`);
  check("an unpunctuated FIRST line ('I quit my job') is adopted once the next line shows it opens a block",
    u.length === 1 && u[0].parts === 10, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div><div>${line(5)}</div><div>${sent(30)}</div><div>${sent(30)}</div></div>`);
  check("…and dropped when what follows is another block", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  sandbox.innerHTML = Array.from({ length: 10 }, () => `<p>${sent(6)}</p>`).join("");
  check("mergeShorts:false — one-sentence paragraphs are still skipped in strict mode", PW.collectUnits(sandbox, { mergeShorts: false }).length === 0);

  {
    // Incremental re-scan inside one article: the claimed unit is a barrier for ITS scope.
    sandbox.innerHTML = `<article><p>${sent(20)}</p><p>${sent(60)}</p><p>${sent(20)}</p></article>`;
    const firstScan = PW.collectUnits(sandbox);
    const ownedNodes = new Set();
    for (const un of firstScan) for (const part of un.parts) for (const n of part.nodes) ownedNodes.add(n);
    const again = PW.collectUnits(sandbox, { claimFilter: (nodes) => (nodes.some((n) => ownedNodes.has(n)) ? "skip" : "take") });
    check("claimed unit inside a scope: still no merging across it on re-scan", firstScan.length === 1 && again.length === 0, JSON.stringify(again.map(x => x.parts.length)));
  }

  check("endsLikeProse: sentence and clause ends, CJK, closers, trailing emoji — not names, times, colons",
    ["It stung.", "Really?", "Wait…", "Two roads diverged in a yellow wood,", "He said “no.”", "(see below.)", "太好了！", "Great work! 🎉"].every(PW.endsLikeProse) &&
    !["alice_92", "2h ago", "Reply · Share", "alice wrote:", "Ingredients:", "I would do it all again 🙂", "Start with the boring parts"].some(PW.endsLikeProse));
  check("endsInColon: lead-ins", PW.endsInColon("Can also be written as:") && PW.endsInColon("如下：") && !PW.endsInColon("10:42"));
  {
    const a = PW.wordShape("Hodges 1983, p. 208."), b = PW.wordShape("Alice Moreau, Ph.D."), c = PW.wordShape("I agree completely."), d = PW.wordShape("我完全同意你的看法。"), e = PW.wordShape("10:42 · Edited");
    check("wordShape: letter words and running text", a.letterWords === 2 && !b.running && c.letterWords === 3 && c.running && d.running && d.letterWords >= 3 && e.letterWords === 1,
      JSON.stringify([a, b, c, d, e]));
  }

  // ---- boilerplate token expansion (trafilatura-derived) ------------------------------
  u = collect(`<div class="social-share">${words(60)}</div>`);
  check("social-share widget skipped", u.length === 0);
  u = collect(`<div class="related-articles">${words(60)}</div>`);
  check("related-articles widget skipped", u.length === 0);
  u = collect(`<section class="related-work">${words(60)}</section>`);
  check("compound guard: 'related-work' prose section KEPT", u.length === 1);
  u = collect(`<div class="OUTBRAIN">${words(60)}</div>`);
  check("outbrain widget skipped", u.length === 0);
  u = collect(`<div role="complementary">${words(60)}</div>`);
  check("role=complementary skipped", u.length === 0);
  u = collect(`<div class="byline">${words(60)}</div>`);
  check("byline row skipped", u.length === 0);
  u = collect(`<div class="registration-info">${words(60)}</div>`);
  check("compound guard: 'registration-info' prose KEPT", u.length === 1);
  u = collect(`<div class="login-form">${words(60)}</div>`);
  check("login-form chrome skipped", u.length === 0);
  u = collect(`<div class="sharedwith">${words(60)}</div>`);
  check("token boundary: 'sharedwith' (no delimiter) KEPT", u.length === 1);
  {
    // Regression: Wikipedia Vector-2022 body classes ("…-toc-pinned-…") must
    // never classify a page-level container as chrome.
    const b = document.createElement("body");
    b.className = "skin-vector vector-toc-pinned-clientpref-1 vector-feature-limited-width";
    check("page-level guard: Wikipedia-style <body> never boilerplate", PW.isBoilerplate(b) === false);
    const m = document.createElement("main");
    m.className = "share"; // pathological but structural — must stay content
    check("page-level guard: <main> never boilerplate", PW.isBoilerplate(m) === false);
    const d = document.createElement("div");
    d.className = "vector-toc-pinned-clientpref-1";
    check("bare 'toc' token dropped (link-density owns TOC boxes)", PW.isBoilerplate(d) === false);
  }

  // ---- main-content detection ----------------------------------------------------------
  {
    sandbox.innerHTML =
      `<header>${words(20)}</header>` +
      `<main id="mc">${words(80)}<p>${words(60)}</p></main>` +
      `<footer>${words(20)}</footer>`;
    const mc = PW.findMainContent(document);
    // NOTE: findMainContent probes the whole document; the sandbox IS the page here.
    check("findMainContent picks <main>", mc && mc.id === "mc", mc && (mc.id || mc.tagName));
  }
  {
    sandbox.innerHTML =
      `<div>${words(10)}</div>` +
      `<div><div><div id="core">${"<p>" + words(60) + "</p>"}${"<p>" + words(60) + "</p>"}${"<p>" + words(60) + "</p>"}</div></div></div>`;
    const mc = PW.findMainContent(document);
    check(
      "findMainContent dominant-path descent finds the text-mass core",
      mc && (mc.id === "core" || mc.contains(document.getElementById("core")) || document.getElementById("core").contains(mc)),
      mc && (mc.id || mc.tagName),
    );
  }
  {
    sandbox.innerHTML = `<p>${words(10)}</p>`;
    const mc = PW.findMainContent(document);
    check("findMainContent honest null on tiny pages", mc === null, mc && mc.tagName);
  }
  {
    // Readability-guided: distinct paragraphs (so the sampled sentences are unique on
    // the page), chrome around them, and a teaser that echoes an opening sentence.
    const wordsFrom = (off, n) => Array.from({ length: n }, (_, i) => VOCAB[(off + i * 5) % VOCAB.length]).join(" ") + ".";
    const paras = [0, 7, 13, 19, 3].map((o) => `<p>${wordsFrom(o, 70)}</p>`).join("");
    sandbox.innerHTML =
      `<header><nav><a href="#">Home</a> <a href="#">About</a></nav></header>` +
      `<div class="teaser">${wordsFrom(0, 12)}</div>` +
      `<div><div><div id="art">${paras}</div></div></div>` +
      `<footer>${words(12)}</footer>`;
    const mc = PW.findMainContent(document);
    check("findMainContent (Readability) maps the article to its live container", mc && mc.id === "art", mc && (mc.id || mc.tagName));
    PW.useReadability(null);
    const mc2 = PW.findMainContent(document);
    check("findMainContent falls back to text mass without Readability", mc2 && (mc2.id === "art" || mc2.contains(document.getElementById("art"))), mc2 && (mc2.id || mc2.tagName));
  }

  // ---- math, markers, hidden copies: never split the sentence ------------------------------
  {
    sandbox.innerHTML = `<p>${words(30)} <math><mi>x</mi><mo>=</mo><mn>1</mn></math> ${words(30)}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    check("inline <math> (display:math) does not split the paragraph; formula counted, text excluded",
      unit && unit.parts.length === 1 && unit.formulas === 1 && !unit.text.includes("x=1") && unit.wordCount === 60,
      JSON.stringify(unit && [unit.parts.length, unit.formulas, unit.wordCount]));
  }
  {
    // Wikipedia: visible <img> fallback + a display:block, absolutely positioned, clipped MathML copy.
    sandbox.innerHTML = `<p>${words(30)} <span class="mwe-math-element"><span style="display:block;position:absolute;clip:rect(1px,1px,1px,1px);width:1px;height:1px;overflow:hidden"><math><mi>y</mi></math></span><img alt="y"></span> ${words(30)}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    check("Wikipedia math (hidden block MathML + img) does not split the paragraph", unit && unit.parts.length === 1 && unit.formulas === 1 && unit.wordCount === 60, JSON.stringify(unit && [unit.parts.length, unit.formulas]));
  }
  {
    // MathJax v3: inline-block container whose only block child is the hidden assistive copy.
    sandbox.innerHTML = `<p>${words(30)} <mjx-container style="display:inline-block"><mjx-math style="display:inline-block">GLYPHLEAK</mjx-math><mjx-assistive-mml style="display:block;position:absolute;clip:rect(1px,1px,1px,1px);width:1px;height:1px;overflow:hidden"><math><mi>z</mi></math></mjx-assistive-mml></mjx-container> ${words(30)}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    check("MathJax container does not split; its glyph text never leaks", unit && unit.parts.length === 1 && unit.formulas === 1 && !unit.text.includes("GLYPHLEAK"), JSON.stringify(unit && [unit.parts.length, unit.text.slice(-30)]));
  }
  {
    sandbox.innerHTML = `<p>${words(30)}</p><table class="ltx_equation"><tr><td><math display="block"><mi>E</mi></math></td><td>(1)</td></tr></table><p>${words(30)}</p>`;
    u = collect(sandbox.innerHTML);
    check("display equation between two short paragraphs is not a merge barrier", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));
  }
  {
    sandbox.innerHTML = `<p>${words(30)}</p><div>(3)</div><p>${words(30)}</p>`;
    u = collect(sandbox.innerHTML);
    check("a bare equation number '(3)' is transparent, not a barrier", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<p>${words(30)}</p><div>* * *</div><p>${words(30)}</p>`);
    check("'* * *' separator is still a barrier", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
  }
  u = collect(`<p>${words(60)}<sup class="reference"><a href="#c">[7]</a></sup> and<sup class="ltx_note_mark">1</sup> more<sup><a href="#f2">2</a></sup>.</p>`);
  check("citation / footnote marks never enter the text", u.length === 1 && !/\[7\]|\b1\b|\b2\b/.test(u[0].text.slice(-40)), JSON.stringify(u.map(x => x.text.slice(-40))));
  u = collect(`<p>${words(58)} area of 5 km<sup>2</sup>.</p>`);
  check("an unlinked exponent <sup>2</sup> is kept (km2)", u.length === 1 && /km2\.$/.test(u[0].text), JSON.stringify(u.map(x => x.text.slice(-12))));
  u = collect(`<p>${words(58)} shown in <cite class="ltx_cite">[<a href="#b">12</a>]</cite> below.</p>`);
  check("bracketed <cite> reference is skipped", u.length === 1 && !u[0].text.includes("[12]") && u[0].text.endsWith("shown in below."), JSON.stringify(u.map(x => x.text.slice(-24))));

  // ---- markers, accordions, name lists, page-level hints ------------------------------
  u = collect(`<p>${words(30)}<span style="position:absolute;right:0">[Pg 12]</span> ${words(30)}</p>`);
  check("absolutely positioned page-number span does not split the paragraph", u.length === 1 && u[0].parts === 1 && !u[0].text.includes("[Pg"), JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${words(30)}<div style="position:absolute;left:0">${words(20)}</div> ${words(30)}</p>`);
  check("a large out-of-flow box still behaves as its own block", u.length >= 1 && u.every(x => !x.text.includes(words(20).slice(0, 20)) || x.words >= 20), JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<div role="tablist"><div role="tab">Section 1</div><div role="tabpanel"><p>${words(60)}</p></div></div>`);
  check("role=tablist accordion content is scored; the tab label is chrome", u.length === 1 && !u[0].text.includes("Section 1"), JSON.stringify(u.map(x => [x.parts, x.words])));
  {
    const b = document.createElement("body"); b.className = "notranslate";
    const s = document.createElement("span"); s.className = "notranslate";
    check("notranslate is ignored at page level, honoured on spans", PW.isBoilerplate(b) === false && (() => { sandbox.innerHTML = `<p>${words(58)} <span class="notranslate">BRANDLEAK</span> end.</p>`; const [x] = PW.collectUnits(sandbox); return x && !x.text.includes("BRANDLEAK"); })());
  }
  {
    const names = "Pallarés-Carratalá V, Polo García J, Martín Rioboo E, Ruíz García A, Serrano-Cumplido A, Divisón-Garrote JA, Segura-Fragoso A, Cinza-Sanjurjo S, Prieto-Díaz MÁ, Barquilla-García A, Escobar-Cervantes C, Velilla-Zancada S, Micó-Pérez RM, Rey-Aldana D, Vitelli-Storelli F, Cebrián-Cuenca AM, Turégano-Yedro M.";
    check("looksLikeNameList: author list yes, prose no, German prose no",
      PW.looksLikeNameList(names) && !PW.looksLikeNameList(words(60)) && !PW.looksLikeNameList("Im März 1952 wurde Turing wegen seiner Homosexualität, die damals noch als Straftat verfolgt wurde, zu einer Hormonbehandlung verurteilt, und im Jahr 2009 sprach der britische Premierminister Gordon Brown eine offizielle Entschuldigung im Namen der Regierung aus."));
    u = collect(`<div class="docsum-citation">${names}</div>`);
    check("author-list block is never a unit", u.length === 0, JSON.stringify(u.map(x => x.words)));
  }

  // ---- where the chip is inserted ---------------------------------------------------------
  {
    const layer = PW.createBadgeLayer();
    const chipFor = (html) => {
      sandbox.innerHTML = html;
      const [unit] = PW.collectUnits(sandbox);
      if (!unit) return null;
      const result = { id: unit.id, bucket: 0, probs: [0.9, 0.06, 0.03, 0.01], score: 0.05 };
      layer.render(unit, PW.unitVerdict(unit.id, unit.text.length, [{ start: 0, end: unit.text.length, result }]));
      return sandbox.querySelector('[data-anagram="host"]');
    };
    const desc = (h) => h && `${h.previousElementSibling?.tagName ?? "#text"}|host|${h.nextElementSibling?.tagName ?? "-"}`;

    let host = chipFor(`<p>${words(60)} <img alt="emoji"></p>`);
    check("chip goes AFTER a trailing emoji image (end of the line, not mid-sentence)",
      host && host.previousElementSibling?.tagName === "IMG" && host.parentElement.lastElementChild === host, desc(host));

    host = chipFor(`<p><span>${words(60)} <img alt="emoji"></span></p>`);
    check("…also when the text and the emoji sit inside an inline wrapper",
      host && host.parentElement.tagName === "P" && host.parentElement.lastElementChild === host, desc(host));

    host = chipFor(`<p>${words(60)}<sup class="reference"><a href="#c">[7]</a></sup></p>`);
    check("chip goes after a trailing citation mark", host && host.previousElementSibling?.tagName === "SUP", desc(host));

    host = chipFor(`<p>${words(55)} and it ends with <a href="#x">a real link</a>.</p>`);
    check("a trailing link with words is NOT jumped; the chip stays outside the anchor",
      host && !host.closest("a") && host.parentElement.tagName === "P", desc(host));

    host = chipFor(`<p>${words(60)}<br></p>`);
    check("a trailing <br> is never jumped (the chip must not fall to the next line)",
      host && host.nextElementSibling?.tagName === "BR", desc(host));

    layer.teardownAll();
  }

  // ---- long texts: window planning --------------------------------------------------------
  // `prose(n)` — n distinct sentences of ~75 characters, each opening with a capital and
  // ending in a full stop, so a cut at a sentence boundary is recognisable from the text.
  const W = PW.WINDOW_CHARS;
  const sentenceNo = (i) => `Sentence number ${i} keeps walking through the quiet town while the rain falls on it.`;
  const prose = (n, from = 0) => Array.from({ length: n }, (_, i) => sentenceNo(from + i)).join(" ");
  const contiguous = (text, spans, end = text.length) =>
    spans.length > 0 && spans[0].start === 0 && spans[spans.length - 1].end === end && spans.every((s, i) => i === 0 || s.start === spans[i - 1].end);
  const lens = (spans) => spans.map((s) => s.end - s.start);
  {
    const short = prose(10);
    const one = PW.planWindows(short);
    check("a text that fits is ONE window over all of it, sent as its plain canonical form",
      one.length === 1 && one[0].start === 0 && one[0].end === short.length && PW.blockText(short, one[0]) === PW.canonicalForScoring(short), JSON.stringify(one));

    const exact = prose(40).slice(0, W - 1) + ".";
    check("exactly at the budget is still one window; one character more is two",
      exact.length === W && PW.planWindows(exact).length === 1 && PW.planWindows(exact + " A").length === 2, `${exact.length}`);

    const long = prose(60); // ~5000 characters → three windows
    const spans = PW.planWindows(long);
    const texts = spans.map((s) => long.slice(s.start, s.end));
    check("a long text is cut into consecutive, non-overlapping windows that cover all of it",
      spans.length === Math.ceil(long.length / W) && spans.length === 3 && contiguous(long, spans) && texts.join("") === long, JSON.stringify(spans));
    check("every cut falls on a sentence boundary: windows open on a capital and close on a full stop",
      texts.every((t) => /^Sentence number \d+ /.test(t) && /\.$/.test(t.trim())), JSON.stringify(texts.map((t) => [t.slice(0, 20), t.slice(-12)])));
    check("the cuts are balanced: no window above the budget, none more than a sentence off the even split",
      lens(spans).every((n) => n <= W && Math.abs(n - long.length / 3) <= 90), JSON.stringify(lens(spans)));

    const tail = prose(45).slice(0, 2 * W + 40); // two full windows and forty characters
    const tailSpans = PW.planWindows(tail);
    check("no tiny tail window: 2 budgets + 40 characters become three windows of a third each",
      tailSpans.length === 3 && contiguous(tail, tailSpans) && lens(tailSpans).every((n) => n >= PW.MIN_WINDOW_CHARS && n > 1000 && n <= W), JSON.stringify(lens(tailSpans)));

    const zh = Array.from({ length: 140 }, (_, i) => `第${i}句话讲的是一座安静的小城和落在屋顶上的雨，孩子们在窗边读书。`).join("");
    const zhSpans = PW.planWindows(zh);
    check("CJK sentence ends (。 with no space after it) are boundaries too",
      zhSpans.length >= 2 && contiguous(zh, zhSpans) && zhSpans.every((s) => zh[s.end - 1] === "。" && zh[s.start] === "第") && lens(zhSpans).every((n) => n <= W), JSON.stringify(lens(zhSpans)));

    const unpunctuated = Array.from({ length: 900 }, (_, i) => VOCAB[i % VOCAB.length]).join(" ");
    const upSpans = PW.planWindows(unpunctuated);
    check("one enormous sentence without a full stop is cut between two words",
      upSpans.length === Math.ceil(unpunctuated.length / W) && contiguous(unpunctuated, upSpans) && upSpans.slice(1).every((s) => unpunctuated[s.start - 1] === " " && unpunctuated[s.start] !== " ") && lens(upSpans).every((n) => n <= W && n >= PW.MIN_WINDOW_CHARS), JSON.stringify(lens(upSpans)));

    const solid = "😀".repeat(1500); // 3000 UTF-16 units, no space, no sentence
    const solidSpans = PW.planWindows(solid);
    check("…and a text with no space at all is cut hard, never inside a surrogate pair",
      solidSpans.length === 2 && contiguous(solid, solidSpans) && solidSpans.every((s) => s.start % 2 === 0) && lens(solidSpans).every((n) => n <= W), JSON.stringify(solidSpans));

    // Merged unit: twenty unpunctuated bullet items joined the way the walker joins parts.
    const items = Array.from({ length: 20 }, (_, i) => `ITEM${i} ` + Array.from({ length: 24 }, (_, j) => VOCAB[(i + j) % VOCAB.length]).join(" "));
    const merged = items.join("\n\n");
    const mSpans = PW.planWindows(merged);
    check("a merged multi-part unit is cut at a joint between two parts",
      mSpans.length >= 2 && contiguous(merged, mSpans) && mSpans.slice(1).every((s) => merged.slice(s.start - 2, s.start) === "\n\n" && merged.startsWith("ITEM", s.start)), JSON.stringify(mSpans));

    const dump = prose(250).slice(0, 20000);
    const dSpans = PW.planWindows(dump);
    const readEnd = dSpans[dSpans.length - 1].end;
    check("past the window cap the rest is left unread, and the reading stops at a sentence end",
      dSpans.length === PW.MAX_WINDOWS && contiguous(dump, dSpans, readEnd) && readEnd <= PW.MAX_READ_CHARS && readEnd > PW.MAX_READ_CHARS - W && dump.slice(0, readEnd).trim().endsWith(".") && lens(dSpans).every((n) => n <= W && n >= PW.MIN_WINDOW_CHARS), JSON.stringify([readEnd, lens(dSpans)]));

    const [h1, h2] = PW.halve(long, spans[1]);
    check("a window the daemon had to cut is halved at a sentence boundary near its middle",
      h1.start === spans[1].start && h1.end === h2.start && h2.end === spans[1].end && /^Sentence number/.test(long.slice(h2.start)) && Math.abs((h1.end - h1.start) - (h2.end - h2.start)) <= 90, JSON.stringify([h1, h2]));

    check("sentenceStarts: inside the text only, each on the first letter of a sentence",
      (() => { const st = PW.sentenceStarts("One. Two!\n\nThree? Four"); return JSON.stringify(st) === JSON.stringify([5, 11, 18]); })(), JSON.stringify(PW.sentenceStarts("One. Two!\n\nThree? Four")));
  }

  // ---- long texts: from a window back to the page ------------------------------------------
  const collapse = (t) => t.replace(/\s+/g, " ").trim();
  const located = (unit, spans) => PW.locateSpans(unit.parts, unit.text, spans);
  {
    // Inline markup everywhere, so window edges fall inside and between elements.
    sandbox.innerHTML = `<p>${Array.from({ length: 60 }, (_, i) => i % 3 === 0 ? `<em>Sentence number ${i}</em> keeps <a href="#x">walking through</a> the quiet town while the rain falls on it.` : i % 3 === 1 ? `Sentence number ${i} keeps walking <b>through the quiet town while the rain</b> falls on it.` : `<span>Sentence <code>number</code> ${i} keeps walking through the quiet town while the rain falls on it.</span>`).join(" ")}</p>`;
    const htmlBefore = sandbox.innerHTML;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const ranges = located(unit, spans);
    check("inline markup: every window resolves to one range whose text is the window's text",
      unit.parts.length === 1 && spans.length === 3 && ranges && ranges.every((r, i) => r.length === 1 && collapse(r[0].toString()) === unit.text.slice(spans[i].start, spans[i].end).trim()),
      JSON.stringify(ranges && ranges.map((r) => r.map((x) => collapse(x.toString()).slice(0, 24)))));
    check("…ranges start and end INSIDE text nodes, and consecutive windows leave no gap",
      ranges && ranges.every((r) => r[0].startContainer.nodeType === 3 && r[0].endContainer.nodeType === 3) &&
      ranges.slice(1).every((r, i) => r[0].startContainer === ranges[i][0].endContainer && r[0].startOffset === ranges[i][0].endOffset));
    check("…and resolving them leaves the page exactly as it was", sandbox.innerHTML === htmlBefore);
  }
  {
    // Source whitespace the walker collapses: newlines, indentation, runs of spaces, NBSP.
    const messy = Array.from({ length: 60 }, (_, i) => `Sentence   number\n      ${i}\u00a0keeps walking\tthrough the quiet town while the rain falls on it.`).join("\n   ");
    sandbox.innerHTML = `<p>\n     ${messy}\n   </p>`;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const ranges = located(unit, spans);
    check("collapsed whitespace: offsets in the collapsed text land on the right raw characters",
      spans.length >= 3 && ranges && ranges.every((r, i) => r.length === 1 && collapse(r[0].toString()) === unit.text.slice(spans[i].start, spans[i].end).trim() && /^S/.test(r[0].startContainer.data.slice(r[0].startOffset))),
      JSON.stringify(ranges && ranges.map((r) => r.map((x) => JSON.stringify(x.toString().slice(0, 16))))));
  }
  {
    // A merged unit closes as soon as it clears the fifty-word floor, so only absurdly long
    // words make one that outgrows a window: three list items of two dozen 30-letter words.
    const longWords = (n, from) => Array.from({ length: n }, (_, j) => VOCAB[(from + j) % VOCAB.length] + "abcdefghijklmnopqrstuvwxy").join(" ");
    sandbox.innerHTML = `<ul>${Array.from({ length: 3 }, (_, i) => `<li>ITEM${i} <i>${longWords(11, i)}.</i> Then ${longWords(11, i + 11)}.</li>`).join("")}</ul>`;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const ranges = located(unit, spans);
    const perWindow = ranges && ranges.map((r) => r.map((x) => collapse(x.toString())).join("\n\n"));
    check("merged parts: a window reaching over several parts is one range PER PART, none across two",
      unit.parts.length === 3 && spans.length === 2 && ranges && ranges.every((r) => r.length > 1) &&
      perWindow.every((t, i) => t === unit.text.slice(spans[i].start, spans[i].end).trim()) &&
      ranges.flat().every((x) => x.startContainer.parentElement.closest("li") === x.endContainer.parentElement.closest("li")),
      JSON.stringify(ranges && ranges.map((r) => r.length)));
    check("…and together the windows' ranges cover every part exactly once", ranges && ranges.flat().length === unit.parts.length + spans.filter((s, i) => i > 0 && unit.text.slice(s.start - 2, s.start) !== "\n\n").length, JSON.stringify(ranges && ranges.flat().length));
  }
  {
    // Formulas the walker skipped sit between two text nodes of the run — also right where
    // a window ends. They are in no part.nodes; the text and the mapping run across them.
    sandbox.innerHTML = `<p>${Array.from({ length: 60 }, (_, i) => `Sentence number ${i} keeps <math><mi>QQQ</mi></math> walking through the quiet town while the rain falls on it.`).join(" ")}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const ranges = located(unit, spans);
    check("a skipped formula in mid-sentence shifts nothing: windows still resolve to their own words",
      unit.formulas === 60 && !unit.text.includes("QQQ") && ranges && ranges.every((r, i) => r.length === 1 && collapse(r[0].toString().replace(/QQQ/g, " ")) === unit.text.slice(spans[i].start, spans[i].end).trim()),
      JSON.stringify(ranges && ranges.map((r) => r.map((x) => collapse(x.toString()).slice(0, 30)))));

    // The page changes under a verdict that is still in flight.
    unit.parts[0].nodes[4].data = "Sentence REWRITTEN keeps ";
    check("a DOM that no longer says what the unit says resolves to nothing (null), never to wrong words", located(unit, spans) === null);
  }

  // ---- long texts: one verdict from several windows ----------------------------------------
  const res = (probs, extra = {}) => ({ id: "w", bucket: probs.indexOf(Math.max(...probs)), probs, score: probs.reduce((a, p, i) => a + p * i, 0) / 3, ...extra });
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  {
    const human = res([0.9, 0.1, 0, 0], { tokens: 300 });
    const ai = res([0, 0, 0.2, 0.8], { tokens: 400 });
    const v = PW.unitVerdict("u1", 4000, [{ start: 0, end: 1000, result: human }, { start: 1000, end: 4000, result: ai }]);
    check("aggregate: length-weighted mean of the probability vectors, bucket = its argmax, score = Σ p̄ᵢ·i/3",
      v.id === "u1" && v.result.id === "u1" && [0.225, 0.025, 0.15, 0.6].every((p, i) => near(v.result.probs[i], p)) && v.result.bucket === 3 &&
      near(v.result.score, (0.025 + 2 * 0.15 + 3 * 0.6) / 3) && near(v.result.score, 0.25 * human.score + 0.75 * ai.score) && v.result.tokens === 700 && v.unreadChars === 0 && !v.result.truncated,
      JSON.stringify(v.result));

    const left = res([0.55, 0.45, 0, 0]);
    const right = res([0, 0.45, 0.55, 0]);
    const mid = PW.unitVerdict("u2", 2000, [{ start: 0, end: 1000, result: left }, { start: 1000, end: 2000, result: right }]);
    check("…which may be a bucket no single window chose (human + heavily edited → lightly edited overall)", mid.result.bucket === 1 && near(mid.result.score, 1 / 3), JSON.stringify(mid.result));

    const single = PW.unitVerdict("u3", 900, [{ start: 0, end: 900, result: human }]);
    check("one window: the unit's verdict IS the daemon's result, number for number", single.result.probs === human.probs && single.result.score === human.score && single.result.id === "u3" && single.windows.length === 1);

    const down = PW.unitVerdict("u4", 4000, [{ start: 0, end: 2000, result: ai }, { start: 2000, end: 4000, result: res([0.25, 0.25, 0.25, 0.25], { degraded: true }) }]);
    check("one degraded window makes the whole unit Unavailable — never flagged on half an answer", down.result.degraded === true && PW.band(down.result) === "unknown" && !PW.isFlagged(down.result));

    const fr = res([0.25, 0.25, 0.25, 0.25], { unsupported: true, lang: "fr", lang_prob: 0.97, score: 0 });
    const mixed = PW.unitVerdict("u5", 3000, [{ start: 0, end: 1000, result: ai }, { start: 1000, end: 2000, result: fr }, { start: 2000, end: 3000, result: ai }]);
    const allFr = PW.unitVerdict("u6", 2500, [{ start: 0, end: 1000, result: fr }, { start: 1000, end: 2500, result: { ...fr, lang: "de" } }]);
    check("a window the language gate refused stays out of the mean; all of them refused → Unsupported language",
      !mixed.result.unsupported && near(mixed.result.score, ai.score) && PW.windowReadout(mixed).skipped === 1 && PW.windowReadout(mixed).pcts.join("|") === "93%|fr|93%" &&
      allFr.result.unsupported === true && allFr.result.lang === "de", JSON.stringify([mixed.result, allFr.result]));

    const dense = PW.unitVerdict("u7", 5000, [{ start: 0, end: 2000, result: human }, { start: 2000, end: 4000, result: { ...ai, truncated: true } }]);
    check("a window still cut after the re-read and an unread tail are both carried by the verdict",
      dense.result.truncated === true && dense.unreadChars === 1000 && PW.windowReadout(dense).cutShort === 1 && /Only the opening/.test(PW.coverageNote(dense, "paragraph")) && /too dense/.test(PW.coverageNote(dense, "paragraph")));
    check("a unit read in one pass has no window readout and no coverage note", PW.windowReadout(single) === null && PW.coverageNote(single, "paragraph") === "");
  }

  // ---- long texts: what the marks and the card claim ----------------------------------------
  {
    const bandsOver = (el) => {
      const out = {};
      for (const [name, hl] of CSS.highlights) for (const r of hl) if (el.contains(r.startContainer)) (out[name] ??= []).push(collapse(r.toString()));
      return out;
    };
    sandbox.innerHTML = `<p>${prose(59)} The final TAILMARK sentence closes the paragraph.</p>`;
    const htmlBefore = sandbox.innerHTML;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const verdict = PW.unitVerdict(unit.id, unit.text.length, [
      { ...spans[0], result: res([0.9, 0.1, 0, 0]) },
      { ...spans[1], result: res([0.05, 0.15, 0.6, 0.2]) },
      { ...spans[2], result: res([0, 0, 0.1, 0.9]) },
    ]);
    PW.setHighlight(unit, verdict);
    let marks = bandsOver(sandbox);
    check("marks are per window: each window's text is underlined in ITS band, to the last sentence",
      spans.length === 3 && Object.keys(marks).sort().join() === "anagram-ai,anagram-heavy,anagram-human" &&
      marks["anagram-human"][0] === unit.text.slice(spans[0].start, spans[0].end).trim() && marks["anagram-heavy"][0] === unit.text.slice(spans[1].start, spans[1].end).trim() && marks["anagram-ai"][0].endsWith("TAILMARK sentence closes the paragraph."),
      JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v.map((t) => t.slice(-30))]))));
    check("…without touching the page", sandbox.innerHTML === htmlBefore);

    const layer = PW.createBadgeLayer();
    layer.render(unit, verdict);
    const cardText = () => sandbox.querySelector('[data-anagram="host"]').shadowRoot.querySelector(".card").textContent;
    const chips = sandbox.querySelectorAll('[data-anagram="host"]').length;
    check("the card says how it was read: 'Scored in 3 windows' with each window's number; ONE chip with the aggregate",
      chips === 1 && /Scored in 3 windows\s*3%\s*·\s*65%\s*·\s*97%/.test(cardText()) && /averaged by length/.test(cardText()) && !/Only the opening/.test(cardText()) && !/first \d+/.test(cardText()) &&
      sandbox.querySelector('[data-anagram="host"]').shadowRoot.querySelector(".num").textContent === `${PW.scorePct(verdict.result)}%`, cardText());

    // Two of three windows read (as under the window cap): the tail is neither marked nor claimed.
    const partial = PW.unitVerdict(unit.id, unit.text.length, verdict.windows.slice(0, 2));
    PW.setHighlight(unit, partial);
    layer.render(unit, partial);
    marks = bandsOver(sandbox);
    check("text no window covers gets no mark, and the card says only the opening was scored",
      !Object.values(marks).flat().some((t) => t.includes("TAILMARK")) && partial.unreadChars > 0 && /Only the opening of this paragraph was scored/.test(cardText()) && /Scored\s*first \d+ words/.test(cardText()), cardText());

    const gated = PW.unitVerdict(unit.id, unit.text.length, [verdict.windows[0], { ...spans[1], result: res([0.25, 0.25, 0.25, 0.25], { unsupported: true, lang: "fr", score: 0 }) }, verdict.windows[2]]);
    PW.setHighlight(unit, gated);
    marks = bandsOver(sandbox);
    check("a window the language gate refused is not marked", Object.keys(marks).sort().join() === "anagram-ai,anagram-human" && Object.values(marks).flat().length === 2, JSON.stringify(Object.keys(marks)));

    // The DOM moves on while the verdict is in flight: whole parts, aggregate band.
    unit.parts[0].nodes[0].data = "Edited " + unit.parts[0].nodes[0].data;
    PW.setHighlight(unit, verdict);
    marks = bandsOver(sandbox);
    const aggregate = `anagram-${PW.band(verdict.result)}`;
    check("a window that cannot be found falls back to the whole part in the aggregate band, never to nothing",
      Object.keys(marks).join() === aggregate && marks[aggregate].length === 1 && marks[aggregate][0].startsWith("Edited Sentence number 0") && marks[aggregate][0].endsWith("closes the paragraph."), JSON.stringify(Object.keys(marks)));

    // The common case stays what it was: one whole-part range, no offsets resolved.
    PW.clearHighlight(unit.id);
    sandbox.innerHTML = `<p>${words(60)}</p>`;
    const [small] = PW.collectUnits(sandbox);
    const smallVerdict = PW.unitVerdict(small.id, small.text.length, [{ start: 0, end: small.text.length, result: res([0, 0, 0.1, 0.9]) }]);
    PW.setHighlight(small, smallVerdict);
    layer.render(small, smallVerdict);
    marks = bandsOver(sandbox);
    check("a one-window unit is marked and carded exactly as before", Object.keys(marks).join() === "anagram-ai" && marks["anagram-ai"].length === 1 && marks["anagram-ai"][0] === small.text && !/Scored/.test(cardText()) && !/window/.test(cardText()), cardText());
    PW.clearHighlight(small.id);
    layer.teardownAll();
  }

  // ---- canonical scoring text ------------------------------------------------------------
  check("canonical: LaTeX residue and escapes", PW.canonicalForScoring("steps---prompting, 74.1\\% and ``quoted''") === 'steps—prompting, 74.1% and "quoted"', JSON.stringify(PW.canonicalForScoring("steps---prompting, 74.1\\% and ``quoted''")));
  check("canonical: typographic quotes, ranges, NBSP, ligatures → one convention", PW.canonicalForScoring("LLMs’ “rich” 1–5\u00a0ﬁnal") === `LLMs' "rich" 1-5 final`, JSON.stringify(PW.canonicalForScoring("LLMs’ “rich” 1–5\u00a0ﬁnal")));
  check("canonical: un-rendered LaTeX math dropped, dollar amounts kept", PW.canonicalForScoring("on the $\\tau^{2}$-bench costs $5 and $10") === "on the -bench costs $5 and $10", JSON.stringify(PW.canonicalForScoring("on the $\\tau^{2}$-bench costs $5 and $10")));
  check("cache key equals the canonical form of what is sent, and canonicalizing twice changes nothing",
    PW.normalizeText("a---b ‘c’") === PW.blockText("a---b ‘c’", { start: 0, end: 9 }) && PW.normalizeText(PW.normalizeText("a---b ‘c’ ``d''")) === PW.normalizeText("a---b ‘c’ ``d''"));
  check("isSeparatorRun: rules yes, numbers no", PW.isSeparatorRun("* * *") && PW.isSeparatorRun("———") && !PW.isSeparatorRun("(3)") && !PW.isSeparatorRun("12"));

  // ---- pure text utils ---------------------------------------------------------------
  check(
    "stripInvisibles removes SHY/ZWSP/bidi controls",
    PW.stripInvisibles("hy\u00ADphen\u200Bated \u202Ebidi\u202C \u2066iso\u2069") === "hyphenated bidi iso",
    JSON.stringify(PW.stripInvisibles("hy\u00ADphen\u200Bated")),
  );
  check(
    "normalizeText: soft-hyphenated text hashes like plain text",
    PW.normalizeText("news\u00ADpaper text") === PW.normalizeText("newspaper text"),
  );
  check(
    "blockText strips invisibles from the payload",
    !PW.blockText("soft\u00ADwrap sentence.", { start: 0, end: 19 }).includes("\u00AD"),
  );

  check("countWords counts CJK", PW.countWords("这是一个测试句子。") >= 4, PW.countWords("这是一个测试句子。"));
  check("symbolNoiseRatio flags box drawing", PW.symbolNoiseRatio("+----+----+ | cell |") > 0.2, PW.symbolNoiseRatio("+----+----+ | cell |").toFixed(2));
  check("symbolNoiseRatio passes prose", PW.symbolNoiseRatio("A well-known state-of-the-art result.") < 0.2, PW.symbolNoiseRatio("A well-known state-of-the-art result.").toFixed(2));
  check("hasColumnGaps: header layout", PW.hasColumnGaps("RFC 768          J. Postel") === true);
  check("hasColumnGaps: newline-guarded", PW.hasColumnGaps("end\n         start") === false);

  const d1 = PW.detectDocsPage(new URL("https://docs.google.com/document/u/0/d/abc-123/edit?tab=t.2"));
  const d2 = PW.detectDocsPage(new URL("https://docs.google.com/document/d/abc/mobilebasic"));
  const d3 = PW.detectDocsPage(new URL("https://docs.google.com/spreadsheets/d/abc/edit"));
  check("detectDocsPage editor/reading/none", d1?.kind === "editor" && d2?.kind === "reading" && d3 === null, JSON.stringify([d1, d2, d3]));

  // Contract v2 (EditLens): bucket → band; degraded → unknown; flagged = heavy/ai.
  const mk = (bucket, probs, extra = {}) => ({ id: "x", bucket, probs, score: probs.reduce((a, p, i) => a + p * i, 0) / 3, ...extra });
  check("band(): bucket 0 → human", PW.band(mk(0, [0.9, 0.06, 0.03, 0.01])) === "human");
  check("band(): bucket 1 → light", PW.band(mk(1, [0.2, 0.5, 0.2, 0.1])) === "light");
  check("band(): bucket 2 → heavy", PW.band(mk(2, [0.05, 0.2, 0.6, 0.15])) === "heavy");
  check("band(): bucket 3 → ai", PW.band(mk(3, [0.01, 0.02, 0.07, 0.9])) === "ai");
  check("band(): degraded fallback → unknown", PW.band(mk(0, [0.25, 0.25, 0.25, 0.25], { degraded: true })) === "unknown");
  check("band(): unsupported language → unsupported, never flagged", PW.band(mk(0, [0.25, 0.25, 0.25, 0.25], { unsupported: true, lang: "zh" })) === "unsupported" && !PW.isFlagged(mk(3, [0, 0, 0, 1], { unsupported: true })));
  check("isFlagged(): heavy + ai only", PW.isFlagged(mk(2, [0, 0.2, 0.6, 0.2])) && PW.isFlagged(mk(3, [0, 0, 0.1, 0.9])) && !PW.isFlagged(mk(1, [0.2, 0.6, 0.2, 0])) && !PW.isFlagged(mk(0, [0.9, 0.1, 0, 0])));
  check("scorePct(): probability-weighted extent", PW.scorePct(mk(3, [0, 0, 0, 1])) === 100 && PW.scorePct(mk(0, [1, 0, 0, 0])) === 0 && PW.scorePct(mk(1, [0.25, 0.25, 0.25, 0.25])) === 50);

  sandbox.remove();
  return out;
});

// ---- window cuts without Intl.Segmenter ---------------------------------------------------
// The sentence segmenter is cached per page, so its regex fallback needs a page of its own
// in which the API never existed.
{
  const fb = await browser.newPage();
  await fb.setContent("<!doctype html><html><body></body></html>");
  await fb.evaluate(() => { delete Intl.Segmenter; });
  await fb.addScriptTag({ path: BUNDLE });
  const r = await fb.evaluate(() => {
    const en = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} keeps walking through the quiet town while the rain falls on it.`).join(" ");
    const zh = Array.from({ length: 140 }, (_, i) => `第${i}句话讲的是一座安静的小城和落在屋顶上的雨，孩子们在窗边读书。`).join("");
    const cut = (t) => PW.planWindows(t).map((s) => t.slice(s.start, s.end));
    return { starts: PW.sentenceStarts('One. Two!\n\nThree? "Four." Five'), en: cut(en), zh: cut(zh), enLen: en.length, zhLen: zh.length };
  });
  await fb.close();
  results.push({
    name: "no Intl.Segmenter: the regex fallback finds the same sentence starts, Latin and CJK",
    ok: JSON.stringify(r.starts) === JSON.stringify([5, 11, 18, 26]) &&
      r.en.length === 3 && r.en.join("").length === r.enLen && r.en.every((t) => /^Sentence number \d+ /.test(t) && t.trim().endsWith(".")) &&
      r.zh.length >= 2 && r.zh.join("").length === r.zhLen && r.zh.every((t) => t.startsWith("第") && t.endsWith("。")),
    note: JSON.stringify([r.starts, r.en.map((t) => t.length), r.zh.map((t) => t.length)]),
  });
}

// ---- structural fixtures: who is scored with whom on real-site markup ------------------
// test/fixtures/*.html are reduced from the live DOM of the sites they name (each file says
// what was verified and what was modelled). Every text block is annotated with the voice it
// belongs to, so the checks are about AUTHORS, not about selectors:
//   data-voice="name"   nearest ancestor names the voice of a text node
//   data-chrome         name / handle / timestamp / action rows and pseudo-headings
//   data-expect         "unit": some unit covers text in here · "none": no unit does
const FIXTURES = join(__dirname, "fixtures");
/** [units, multi-part units] per fixture — a change here is a change of behaviour. */
const EXPECTED = {
  "chat-transcript": [2, 1],
  "discourse-thread": [2, 2],
  "hn-thread": [2, 1],
  "linkedin-feed": [2, 2],
  "listicle": [2, 2],
  "listicle-divsoup": [2, 1],
  "news-article": [4, 4],
  "recipe-faq": [5, 4],
  "reddit-thread": [3, 2],
  "wordpress-comments": [3, 1],
  "x-timeline": [2, 1],
};
const fixtureFiles = readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).sort();
results.push({ name: "every fixture has an expectation (and the other way round)", ok: JSON.stringify(fixtureFiles.map((f) => f.replace(".html", "")).sort()) === JSON.stringify(Object.keys(EXPECTED).sort()), note: fixtureFiles.join(",") });
for (const file of fixtureFiles) {
  const name = file.replace(".html", "");
  const fx = await browser.newPage();
  await fx.goto(pathToFileURL(join(FIXTURES, file)).href);
  await fx.addScriptTag({ path: BUNDLE });
  const r = await fx.evaluate(() => {
    const units = PW.collectUnits(document.body);
    const voiceOf = (part) => part.nodes[0].parentElement?.closest("[data-voice]")?.getAttribute("data-voice") ?? "(none)";
    const mixed = [];
    const chrome = [];
    const covered = new Set();
    for (const u of units) {
      const voices = [...new Set(u.parts.map(voiceOf))];
      if (voices.length > 1) mixed.push(voices.join("+"));
      for (const part of u.parts) for (const n of part.nodes) {
        if (n.parentElement?.closest("[data-chrome]")) chrome.push(n.textContent.trim().slice(0, 30));
        for (let e = n.parentElement; e; e = e.parentElement) covered.add(e);
      }
    }
    const wrong = [];
    for (const el of document.querySelectorAll("[data-expect]")) {
      const want = el.getAttribute("data-expect") === "unit";
      if (covered.has(el) !== want) wrong.push(`${want ? "no unit for" : "unexpected unit on"} "${el.textContent.trim().slice(0, 40)}"`);
    }
    return { units: units.length, merged: units.filter((u) => u.parts.length > 1).length, mixed, chrome, wrong, annotated: document.querySelectorAll("[data-expect]").length };
  });
  await fx.close();
  const [wantUnits, wantMerged] = EXPECTED[name] ?? [-1, -1];
  results.push({ name: `fixture ${name}: no unit mixes two voices`, ok: r.mixed.length === 0, note: r.mixed.join(" | ") });
  results.push({ name: `fixture ${name}: no name / time / action row inside a unit`, ok: r.chrome.length === 0, note: r.chrome.join(" | ") });
  results.push({ name: `fixture ${name}: covered exactly where expected (${r.annotated} annotated blocks)`, ok: r.annotated > 0 && r.wrong.length === 0, note: r.wrong.join(" | ") });
  results.push({ name: `fixture ${name}: ${wantUnits} units, ${wantMerged} of them multi-part`, ok: r.units === wantUnits && r.merged === wantMerged, note: `${r.units} units, ${r.merged} multi-part` });
}

await browser.close();

let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note && !r.ok ? `  —  ${r.note}` : ""}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} unit checks passed`);
process.exit(pass === results.length ? 0 : 1);
