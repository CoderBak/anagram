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
import { surfaceChecks } from "./unit-surfaces.mjs";

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
// Defuddle is an on-demand vendor chunk in the extension; here the library's own browser
// build (it sets a `Defuddle` global) stands in for it so the Defuddle-guided path is
// exercised too.
await page.addScriptTag({ path: join(ROOT, "node_modules", "defuddle", "dist", "index.js") });
await page.evaluate(() => PW.useDefuddle({ Defuddle: window.Defuddle }));

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
  let u = collect(`<p>${words(80)}</p>`);
  check("long paragraph → one 1-part unit", u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));

  {
    const below = collect(`<p>${words(74)}</p>`);
    const at = collect(`<p>${words(75)}</p>`);
    check("the floor is the open model's training minimum: 74 words alone are not read, 75 are",
      PW.MIN_UNIT_WORDS === 75 && below.length === 0 && at.length === 1 && at[0].words === 75, JSON.stringify([below.length, at.map(x => x.words)]));
  }

  u = collect(`<p>${words(80)}</p><p>${words(85)}</p>`);
  check("two long paragraphs → two units", u.length === 2);

  u = collect(`<h2>Title</h2><p>${words(20)}</p><h2>Title</h2>`);
  check("isolated short between headings → dropped", u.length === 0);

  u = collect(`<p>${words(30)}</p><p>${words(30)}</p><p>${words(30)}</p>`);
  check("three short siblings → one 3-part unit", u.length === 1 && u[0].parts === 3, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div>${words(40)}<br><br>${words(41)}</div>`);
  check("BR-split halves → one 2-part unit", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(20)}</p><p>${words(80)}</p><p>${words(20)}</p>`);
  check("short|LONG|short → ONE unit of three parts: a short text that cannot stand alone joins the full paragraph beside it", u.length === 1 && u[0].parts === 3 && u[0].words === 120, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(40)}</p><h3>Break</h3><p>${words(40)}</p>`);
  check("heading is a merge barrier", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(40)}</p><p>${words(40)}</p>`);
  check("two 40w shorts merge past the floor", u.length === 1 && u[0].words >= 75);

  u = collect(`<section><p>${words(40)}</p></section><section><p>${words(40)}</p></section>`);
  check("shorts in unrelated sections do NOT merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${words(40)} <code>npm install</code> ${words(35)}</p>`);
  check("inline <code> stays in the paragraph", u.length === 1 && u[0].text.includes("npm install"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<pre>${words(80)}</pre>`);
  check("<pre> block never scored", u.length === 0);

  u = collect(`<nav><p>${words(80)}</p></nav>`);
  check("<nav> subtree skipped (boilerplate)", u.length === 0);

  u = collect(`<div><a href="#">${words(30)}</a><br><a href="#">${words(30)}</a></div>`);
  check("link-dense runs are barriers, not units", u.length === 0);

  u = collect(`<div contenteditable="true">${words(80)}</div>`);
  check("contenteditable never scored", u.length === 0);

  u = collect(`<div aria-hidden="true">${words(80)}</div>`);
  check("aria-hidden never scored", u.length === 0);

  u = collect(`<div style="display:none">${words(80)}</div>`);
  check("display:none never scored", u.length === 0);

  u = collect(`<div style="visibility:hidden">${words(80)}</div>`);
  check("visibility:hidden never scored", u.length === 0);

  u = collect(`<div style="opacity:0">${words(80)}</div>`);
  check("opacity:0 never scored", u.length === 0);

  u = collect(`<div class="notranslate">${words(80)}</div>`);
  check("notranslate honored", u.length === 0);

  u = collect(`<div translate="no">${words(80)}</div>`);
  check("translate=no honored", u.length === 0);

  const cjk = "这是一个用来验证中文分词与字母检测的完整段落，其中完全没有任何拉丁字母出现，" +
    "但是包含了数量足够多的中文词语，可以顺利越过七十五个词的最低门槛，从而形成一个可以被评分的单元，" +
    "并且证明统一码字母判断和中文分词统计都在按预期工作着，" +
    "就算换了一种分词方法，这一段的词数也仍然留有足够的余量，不会恰好落在门槛的下面。";
  u = collect(`<p>${cjk}</p>`);
  check("pure-CJK paragraph scored", u.length === 1, JSON.stringify(u.map(x => x.words)));

  u = collect(`<p>1 2 3 4 5 6 7 8 9 10 11 12</p>`);
  check("letterless run dropped", u.length === 0);

  u = collect(`<div style="white-space:pre">+----+----+\n| A  | B  |\n+----+----+</div><p>${words(40)}</p>`);
  check("ASCII-box run is a barrier; lone neighbor short dropped", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div style="white-space:pre-wrap">${words(40)}\n\n${words(40)}</div>`);
  check("pre-wrap blank-line gap splits then merges → 2 parts", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p><span style="float:left;font-size:2em">T</span>${words(80)}</p>`);
  check("floated drop-cap span stays inline", u.length === 1 && u[0].text.startsWith("T"), JSON.stringify(u.map(x => x.text.slice(0, 12))));

  // A sidenote or a margin note (tufte-css: `span.sidenote { float: right }` in the middle of
  // a sentence) is the author's text, but not the sentence it floats beside: it is read after
  // that paragraph, as a paragraph of its own.
  u = collect(`<p>AAA ${words(40)} <span style="float:right;width:30%">SIDENOTE ${words(20)}</span> BBB ${words(40)}</p>`);
  check("a floated sidenote in mid-sentence is a run of its own after its paragraph, which reads on across it",
    u.length === 1 && u[0].parts === 2 && u[0].text === `AAA ${words(40)} BBB ${words(40)}\n\nSIDENOTE ${words(20)}`,
    JSON.stringify(u.map(x => [x.parts, x.text.split("\n\n").map((t) => t.slice(0, 12))])));
  u = collect(`<p>P0 ${words(80)}</p><p>P1 ${words(40)}<span style="float:right;width:30%">SIDENOTE ${words(20)}</span> ${words(40)}</p><p>P2 ${words(80)}</p>`);
  check("…and a short one joins the paragraph it floats beside, not the one before it",
    u.length === 3 && u[0].parts === 1 && u[1].parts === 2 && u[1].text.startsWith("P1 ") && u[1].text.includes("\n\nSIDENOTE ") && u[2].parts === 1,
    JSON.stringify(u.map(x => [x.parts, x.text.split("\n\n").map((t) => t.slice(0, 12))])));
  u = collect(`<p><span style="float:left;font-size:3em">“T</span>he ${words(80)}</p>`);
  check("…while a floated initial with its opening quote is still a drop cap", u.length === 1 && u[0].parts === 1 && u[0].text.startsWith("“The "), JSON.stringify(u.map(x => x.text.slice(0, 12))));

  u = collect(`<p>${words(40)}</p><div style="display:inline-block"><div>${words(9)}</div></div><p>${words(40)}</p>`);
  check("inline-block card with block children does not sever merging siblings", u.length >= 1, JSON.stringify(u.map(x => [x.parts, x.words])));

  sandbox.innerHTML = `<div id="sh"></div>`;
  const sh = sandbox.querySelector("#sh").attachShadow({ mode: "open" });
  sh.innerHTML = `<p>${words(80)}</p>`;
  u = PW.collectUnits(sandbox).map((x) => ({ parts: x.parts.length }));
  check("open shadow root content collected", u.length === 1, JSON.stringify(u));

  u = collect(`<p>${words(40)}<span style="position:absolute;width:1px;height:1px;overflow:hidden">SRONLY LEAK</span> ${words(40)}</p>`);
  check("sr-only inline text excluded mid-sentence", u.length === 1 && !u[0].text.includes("SRONLY"), JSON.stringify(u.map(x => x.parts)));

  sandbox.innerHTML = `<p>${words(80)}</p>`;
  const skipped = PW.collectUnits(sandbox, { claimFilter: () => "skip" });
  check("claimFilter skip suppresses owned runs", skipped.length === 0);

  // ---- inline whitespace fidelity ------------------------------------------------------
  // Whitespace-only text nodes BETWEEN inline elements are the spaces between words.
  u = collect(`<p>${Array.from({ length: 80 }, (_, i) => `<span>${VOCAB[i % VOCAB.length]}</span>`).join(" ")}.</p>`);
  check("span-per-word paragraph keeps its spaces (80 words, one unit)", u.length === 1 && u[0].words === 80, JSON.stringify(u.map(x => [x.words, x.text.slice(0, 30)])));
  u = collect(`<p><b>Alan Turing</b> <small>OBE</small> ${words(80)}</p>`);
  check("`<b>…</b> <small>…</small>` is not glued into one token", u.length === 1 && u[0].text.startsWith("Alan Turing OBE "), JSON.stringify(u.map(x => x.text.slice(0, 24))));
  {
    sandbox.innerHTML = `<p>\n  <span>${words(80)}</span>\n  </p>`;
    const [unit] = PW.collectUnits(sandbox);
    const nodes = unit?.parts[0].nodes ?? [];
    const edgesClean = nodes.length > 0 && nodes[0].textContent.trim() !== "" && nodes[nodes.length - 1].textContent.trim() !== "";
    check("leading/trailing whitespace nodes are not part of the run", edgesClean, JSON.stringify(nodes.map(n => JSON.stringify(n.textContent.slice(0, 8)))));
  }
  {
    sandbox.innerHTML = `<div id="sh2"></div>`;
    sandbox.querySelector("#sh2").attachShadow({ mode: "open" }).innerHTML = `<p>${words(80)}</p>`;
    const roots = [];
    const got = PW.collectUnits(sandbox, { onShadowRoot: (r) => roots.push(r) });
    check("walker reports each open shadow root it descends into", got.length === 1 && roots.length === 1 && roots[0] instanceof ShadowRoot, `${roots.length}`);
  }
  {
    // A closed root is out of reach of the page's other scripts, not of the extension:
    // Chrome hands it to a content script through chrome.dom.openOrClosedShadowRoot, which
    // this plain page stands in for with the roots it attached itself.
    const closed = new Map();
    const hadChrome = "chrome" in window;
    window.chrome ??= {};
    const hadDom = "dom" in window.chrome;
    window.chrome.dom = { openOrClosedShadowRoot: (el) => closed.get(el) ?? null };
    sandbox.innerHTML = `<closed-card id="cc"></closed-card><div id="cd"></div>`;
    const card = sandbox.querySelector("#cc");
    closed.set(card, card.attachShadow({ mode: "closed" }));
    closed.get(card).innerHTML = `<p>${words(80)}</p>`;
    const div = sandbox.querySelector("#cd");
    closed.set(div, div.attachShadow({ mode: "closed" }));
    closed.get(div).innerHTML = `<p>${words(85)}</p>`;
    const roots = [];
    const got = PW.collectUnits(sandbox, { onShadowRoot: (r) => roots.push(r) });
    const inCard = got.filter((u) => closed.get(card).contains(u.container));
    check("a closed root on a custom element is walked through the extension API, and reported for observation",
      got.length === 1 && inCard.length === 1 && roots.length === 1 && roots[0] === closed.get(card), JSON.stringify({ units: got.length, roots: roots.length }));
    // The page saying it attached one (entrypoints/shadow.content.ts) is what opens a
    // built-in element's closed root: asking every element costs every walk a call each.
    PW.noteShadowHost(div);
    const after = PW.collectUnits(sandbox);
    check("a closed root on a built-in element is walked once the page has announced it",
      after.length === 2 && after.some((u) => closed.get(div).contains(u.container)), JSON.stringify({ units: after.length }));
    if (hadDom) delete window.chrome.dom;
    if (!hadChrome) delete window.chrome;
  }

  // ---- regression: review-workflow findings ------------------------------------------
  // 1) preserved-whitespace splitting must be IDEMPOTENT (no infinite observe loop).
  sandbox.innerHTML = `<div style="white-space:pre-wrap">${words(40)}\n\n${words(40)}</div>`;
  PW.collectUnits(sandbox);
  const nAfter1 = sandbox.firstElementChild.childNodes.length;
  PW.collectUnits(sandbox);
  PW.collectUnits(sandbox);
  const nAfter3 = sandbox.firstElementChild.childNodes.length;
  check("preserved-ws split is idempotent (no node growth on re-walk)", nAfter1 === nAfter3, `${nAfter1} -> ${nAfter3}`);

  // 1b) The page keeps its own text node (lib/dom/splits.ts). A script that renders the page
  //     writes to the node IT created; on X, "Show more" wrote the whole post into it while
  //     the pieces the walker had cut off stayed on screen as a stale copy of the preview.
  {
    const textNodes = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).length;
    const watch = () => {
      const mo = new MutationObserver(() => {});
      mo.observe(sandbox, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
      return () => { const records = mo.takeRecords(); mo.disconnect(); return records; };
    };
    const preview = `${words(30)}\n\n${words(12)} and replies`;
    const full = `${words(30)}\n\n${words(40)}\n\nFWTAIL ${words(20)}`;
    const setUp = () => {
      sandbox.innerHTML = `<div style="white-space:pre-wrap"><span id="own"></span></div><div id="elsewhere"></div>`;
      const node = document.createTextNode(preview);
      sandbox.querySelector("#own").append(node);
      return { node, own: sandbox.querySelector("#own") };
    };

    let { node, own } = setUp();
    let take = watch();
    PW.collectUnits(sandbox);
    PW.repairSplits(take());
    check("the walker's own cut is left standing: the page's node is cut and reads the same",
      textNodes(own) > 1 && own.textContent === preview, `${textNodes(own)} nodes`);

    take = watch();
    node.nodeValue = full; // what a framework does: write the new text into ITS node
    PW.repairSplits(take());
    check("a page writing to a node the walker cut shows exactly what it wrote, no stale piece of the old text",
      own.textContent === full && textNodes(own) === 1 && own.firstChild === node, JSON.stringify(own.textContent.slice(-50)));

    PW.collectUnits(sandbox);
    take = watch();
    node.nodeValue = node.data;
    PW.repairSplits(take());
    check("…even when it writes back the very text the cut left in it",
      textNodes(own) === 1 && own.textContent === node.data, `${textNodes(own)} nodes`);

    ({ node, own } = setUp());
    PW.collectUnits(sandbox);
    take = watch();
    node.remove();
    PW.repairSplits(take());
    check("a page removing its node takes the pieces with it", own.textContent === "" && textNodes(own) === 0, JSON.stringify(own.textContent.slice(0, 40)));

    ({ node, own } = setUp());
    PW.collectUnits(sandbox);
    const chip = document.createElement("span");
    chip.setAttribute("data-anagram", "host");
    node.after(chip); // a chip after the first paragraph, between the cut pieces
    take = watch();
    sandbox.querySelector("#elsewhere").append(document.createElement("i"));
    sandbox.querySelector("#elsewhere").firstChild.remove(); // anything removed anywhere on the page
    PW.repairSplits(take());
    check("an unrelated removal leaves a cut standing, with our own chip between its pieces",
      textNodes(own) > 1 && own.textContent === preview && own.contains(chip), `${textNodes(own)} nodes`);
    chip.remove();

    ({ node, own } = setUp());
    PW.collectUnits(sandbox);
    take = watch();
    sandbox.querySelector("#elsewhere").append(node);
    PW.repairSplits(take());
    check("a page moving its node away gets its whole text back in it, and nothing stays behind",
      node.data === preview && own.textContent === "" && sandbox.querySelector("#elsewhere").textContent === preview,
      JSON.stringify([own.textContent.slice(0, 30), node.data.slice(-20)]));

    ({ node, own } = setUp());
    const before = sandbox.innerHTML;
    PW.collectUnits(sandbox);
    const wasCut = textNodes(own) > 1;
    PW.restoreSplits();
    check("when Anagram leaves a page, every node it cut is whole again",
      wasCut && sandbox.innerHTML === before && own.firstChild === node && node.data === preview, `${textNodes(own)} nodes`);
  }

  // 2) SVG exclusion fires despite lowercase nodeName; embedded title/style never leak.
  u = collect(`<p>${words(40)} <svg viewBox="0 0 10 10"><title>SVGLEAK</title><style>.q{fill:red}</style><text x="0" y="9">42</text></svg> ${words(40)}</p>`);
  check("inline SVG excluded, title/style text never leaks, sentence intact",
    u.length === 1 && u[0].parts === 1 && !u[0].text.includes("SVGLEAK") && !u[0].text.includes("fill:red"),
    JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 40)])));
  u = collect(`<svg width="400" height="200"><text x="0" y="20">${words(80)}</text></svg>`);
  check("standalone SVG chart text never scored", u.length === 0);

  // 3) inline exclusions must not split the sentence around them.
  u = collect(`<p>${words(40)} <img alt="pic"> ${words(40)}</p>`);
  check("<img> mid-sentence does not split the run", u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${words(40)} <span aria-hidden="true">★</span> ${words(40)}</p>`);
  check("aria-hidden icon mid-sentence does not split the run", u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${words(40)} <span style="display:none">HIDDENLEAK</span> ${words(40)}</p>`);
  check("display:none span mid-sentence: no split, no leak",
    u.length === 1 && u[0].parts === 1 && !u[0].text.includes("HIDDENLEAK"), JSON.stringify(u.map(x => [x.parts, x.words])));

  // 4) column-gap barrier applies ONLY to preserved-whitespace runs.
  u = collect(`<p>${words(40)}          ${words(40)}</p>`);
  check("8+ source spaces in collapsed HTML do not drop prose", u.length === 1, JSON.stringify(u.map(x => x.words)));

  // 5a) strict per-paragraph mode (mergeShorts:false): sub-floor runs are skipped.
  sandbox.innerHTML = `<p>${words(30)}</p><p>${words(30)}</p><p>${words(30)}</p>`;
  const strict = PW.collectUnits(sandbox, { mergeShorts: false });
  check("mergeShorts:false — shorts never grouped", strict.length === 0, JSON.stringify(strict.length));
  sandbox.innerHTML = `<p>${words(80)}</p><p>${words(20)}</p>`;
  const strictLong = PW.collectUnits(sandbox, { mergeShorts: false });
  check("mergeShorts:false — full paragraphs still scored", strictLong.length === 1 && strictLong[0].parts.length === 1);

  // 5) shorts must not merge ACROSS an existing claimed unit.
  sandbox.innerHTML = `<p>${words(20)}</p><p>${words(80)}</p><p>${words(20)}</p>`;
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

  u = collect(`<article><span class="by">alice</span> ${sent(40)}</article><article><span class="by">bob</span> ${sent(40)}</article>`);
  check("two sibling <article>s by different authors never merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div role="article">${sent(40)}</div><div role="article">${sent(40)}</div>`);
  check("…nor two [role=article] posts (Reddit comments)", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<article><p>${sent(40)}</p><p>${sent(40)}</p></article><article><p>${sent(40)}</p></article>`);
  check("the short paragraphs of ONE article still merge; the neighbour's stays out", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(40)}</p><blockquote>${sent(40)}</blockquote>`);
  check("an author and a bare <blockquote> never merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${sent(40)}</p><blockquote><p>${sent(40)}</p></blockquote>`);
  check("…nor with <blockquote><p>", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>AUTHOR-A ${sent(40)}</p><blockquote><p>QUOTED ${sent(40)}</p></blockquote><p>AUTHOR-B ${sent(40)}</p>`);
  check("a quotation interrupts the author's text, it does not end it: [p, p] without the quote",
    u.length === 1 && u[0].parts === 2 && u[0].text.includes("AUTHOR-A") && u[0].text.includes("AUTHOR-B") && !u[0].text.includes("QUOTED"),
    JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>AUTHOR-A ${sent(40)}</p><blockquote><p>QUOTED ${sent(80)}</p></blockquote><p>AUTHOR-B ${sent(40)}</p>`);
  check("a full-length quotation is its own unit; units come back in document order",
    u.length === 2 && u[0].parts === 2 && u[0].text.startsWith("AUTHOR-A") && u[1].parts === 1 && u[1].text.startsWith("QUOTED"),
    JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 10)])));
  {
    sandbox.innerHTML = `<p>${sent(40)}</p><blockquote><p>${sent(80)}</p></blockquote><p>${sent(40)}</p>`;
    const got = PW.collectUnits(sandbox);
    check("ids are unique and `order` ascends in document order", got.length === 2 && got[0].id !== got[1].id && got[0].order < got[1].order, JSON.stringify(got.map(x => [x.id, x.order])));
  }
  {
    // A later walk numbers its units after every earlier one, wherever they are: a post
    // prepended to a feed, a reply inserted above, text in a shadow tree or a slot. Their
    // place on the page is asked of the page, across the shadow boundary the walk crosses.
    sandbox.innerHTML = `<p id="old">OLD ${sent(80)}</p>`;
    const owned = new Set();
    const walk = (root) => {
      const got = PW.collectUnits(root, { claimFilter: (nodes) => (nodes.every((n) => owned.has(n)) ? "skip" : "take") });
      for (const u of got) for (const p of u.parts) for (const n of p.nodes) owned.add(n);
      return got;
    };
    const units = walk(sandbox);
    const top = document.createElement("p");
    top.textContent = `TOP ${sent(80)}`;
    sandbox.prepend(top);
    units.push(...walk(sandbox));
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML = `<p>SHADOW ${sent(80)}</p><slot></slot>`;
    host.innerHTML = `<p>SLOTTED ${sent(80)}</p>`;
    sandbox.insertBefore(host, document.getElementById("old"));
    units.push(...walk(sandbox));
    const found = units.map((x) => x.text.split(" ")[0]);
    const shown = PW.inPageOrder(units).map((x) => x.text.split(" ")[0]);
    check("units found by later walks are put where they stand on the page, shadow and slotted text included",
      found.join() === "OLD,TOP,SHADOW,SLOTTED" && shown.join() === "TOP,SHADOW,SLOTTED,OLD",
      JSON.stringify({ found, shown }));
  }

  u = collect(`<p>${sent(40)}</p><blockquote><p>${sent(20)}</p><cite><a href="#s">The Source, 1931</a></cite></blockquote><p>${sent(40)}</p>`);
  check("a barrier INSIDE a quotation (its linked <cite>) does not end the author's text around it", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(40)}</p><h3>Break</h3><blockquote><p>${sent(40)}</p></blockquote><p>${sent(40)}</p>`);
  check("…while a heading in the author's own flow still does", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  // QUOTED HISTORY in a mail message without a <blockquote> (talon's markers, lib/dom/scope.ts):
  // the reply and the history are two voices, and neither the header block nor the
  // "On … wrote:" line is anybody's text. The full webmail pages are fixtures (webmail-*.html).
  {
    const REPLY = `<div>REPLY-A ${sent(40)}</div><div>REPLY-B ${sent(40)}</div>`;
    const QUOTED = `<div>QUOTED-A ${sent(40)}</div><div>QUOTED-B ${sent(40)}</div>`;
    const HEADER = `<b>From:</b> Alice Moreau &lt;alice@example.org&gt;<br><b>Sent:</b> Monday, September 14, 2026 9:12 AM<br><b>To:</b> Bob Nowak<br><b>Subject:</b> Hall roof`;
    const apart = (html) => {
      const got = collect(`<div class="msg">${html}</div>`);
      const ok = got.length === 2 && /^REPLY-A .*\n\nREPLY-B /s.test(got[0].text) && /^QUOTED-A .*\n\nQUOTED-B /s.test(got[1].text) &&
        got.every((x) => x.parts === 2 && !/wrote|Sent:|Subject:|Alice Moreau/.test(x.text));
      return [ok, JSON.stringify(got.map((x) => x.text.split("\n\n").map((t) => t.slice(0, 16))))];
    };
    check("mail: Yahoo's div.yahoo_quoted and its \"On … wrote:\" line are not the reply's",
      ...apart(`${REPLY}<div class="yahoo_quoted" id="yahoo_quoted_0033794750"><div>On Tuesday, June 4, 2019, 5:41:43 PM PDT, John Smith &lt;jsmith@example.com&gt; wrote:</div>${QUOTED}</div>`));
    check("mail: Outlook 2007's splitter (#B5C4DF, cm) starts a history that runs through its later siblings",
      ...apart(`${REPLY}<div style="border:none;border-top:solid #B5C4DF 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal">${HEADER}</p></div>${QUOTED}`));
    check("mail: Windows Mail's splitter too",
      ...apart(`${REPLY}<div style="padding-top: 5px; border-top-color: rgb(229, 229, 229); border-top-width: 1px; border-top-style: solid;"><div><font>${HEADER}</font></div></div>${QUOTED}`));
    check("mail: Outlook for Mac's #OLK_SRC_BODY_SECTION",
      ...apart(`${REPLY}<span id="OLK_SRC_BODY_SECTION"><div style="font-family:Calibri; font-size:11pt; BORDER-TOP: #b5c4df 1pt solid; PADDING-TOP: 3pt"><span style="font-weight:bold">From: </span>Alice Moreau<br><span style="font-weight:bold">Date: </span>Monday, 14 September 2026 at 09:12<br></div><div><br></div>${QUOTED}</span>`));
    check("mail: Zimbra's divider and header block",
      ...apart(`${REPLY}<hr id="zwchr" data-marker="__DIVIDER__"><div data-marker="__HEADERS__"><b>From: </b>"Alice Moreau" &lt;alice@example.org&gt;<br><b>To: </b>bob@example.org<br><b>Sent: </b>Monday, September 14, 2026 9:12:00 AM<br><b>Subject: </b>Hall roof<br></div><br><div data-marker="__QUOTED_TEXT__">${QUOTED}</div>`));
    check("mail: a From / Sent / To / Subject block alone (Outlook 2010, a forward)",
      ...apart(`${REPLY}<p class="MsoNormal">${HEADER}</p><p class="MsoNormal">&nbsp;</p>${QUOTED}`));
    check("mail: Thunderbird's div.moz-cite-prefix line is not the reply's",
      ...apart(`${REPLY}<div class="moz-cite-prefix">On 14/09/2026 09:12, Alice Moreau wrote:<br></div><blockquote type="cite" cite="mid:1@example.org">${QUOTED}</blockquote>`));
    check("mail: a quotation inside the history interrupts it without ending it",
      ...apart(`${REPLY}<div id="x_divRplyFwdMsg" dir="ltr"><font>${HEADER}</font></div><div>QUOTED-A ${sent(40)}</div><blockquote><p>INNER ${sent(20)}</p></blockquote><div>QUOTED-B ${sent(40)}</div>`));
    // …and what is no mail history stays one voice.
    u = collect(`<div class="msg">${REPLY}<div style="border-top:1px solid #e1e1e1;padding-top:8px">${QUOTED}</div></div>`);
    check("mail: a page's own light-grey rule in pixels is no Outlook splitter", u.length === 1 && u[0].parts === 4, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<div class="msg">${REPLY}<div><b>From:</b> the minutes of the March meeting, which the secretary has now circulated to everyone.</div>${QUOTED}</div>`);
    check("mail: a bold \"From:\" without the rest of a header is somebody's sentence", u.length === 1 && u[0].parts === 5 && u[0].text.includes("From: the minutes"), JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<article><p>AUTHOR ${sent(40)}</p><p>On 3 March 1931 the editor of the Gazette wrote:</p><blockquote><p>${sent(40)}</p></blockquote><p>AUTHOR ${sent(40)}</p></article>`);
    check("mail: an author's own \"On 3 March 1931 … wrote:\" is still the author's sentence", u.length === 1 && u[0].parts === 3 && u[0].text.includes("the editor of the Gazette wrote:"), JSON.stringify(u.map(x => [x.parts, x.words])));
  }

  u = collect(`<p>${sent(40)}</p><figure><img alt=""><figcaption>CAPTION ${sent(14)}</figcaption></figure><p>${sent(40)}</p>`);
  check("a figure caption between two short paragraphs is not borrowed: [p, p] without it",
    u.length === 1 && u[0].parts === 2 && !u[0].text.includes("CAPTION"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<article><div class="t">${sent(40)}</div><div role="link" tabindex="0"><div class="t">${sent(40)}</div></div></article>`);
  check("a QUOTED post — div[role=link] inside the quoting post's <article> — never merges with it", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div role="link" tabindex="0"><div>${sent(40)}</div></div><div role="link" tabindex="0"><div>${sent(40)}</div></div>`);
  check("feed items that are div[role=link] cards (Bluesky) never merge", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(78)} <span role="link" tabindex="0">a scripted link</span> inside.</p>`);
  check("an inline span[role=link] is not a scope: the sentence stays whole", u.length === 1 && u[0].parts === 1 && u[0].text.includes("a scripted link inside."), JSON.stringify(u.map(x => [x.parts, x.words])));

  {
    sandbox.innerHTML = `<div id="host-a"></div>`;
    sandbox.querySelector("#host-a").attachShadow({ mode: "open" }).innerHTML = `<p>${sent(40)}</p><blockquote><p>${sent(40)}</p></blockquote>`;
    const inside = PW.collectUnits(sandbox);
    check("a scope inside a shadow root separates there too", inside.length === 0, JSON.stringify(inside.map(x => x.parts.length)));

    // The <article> is OUTSIDE the shadow tree the text lives in: closest() stops at the
    // shadow root, so the lookup has to climb through the host — otherwise this text
    // would count as bare-page text and the title row would cut it in two.
    sandbox.innerHTML = `<article><div id="host-b"></div></article>`;
    sandbox.querySelector("#host-b").attachShadow({ mode: "open" }).innerHTML = `<div><p>${sent(40)}</p><div class="ttl">Finish early</div><p>${sent(40)}</p></div>`;
    const climbed = PW.collectUnits(sandbox);
    check("scope lookup climbs through shadow hosts", climbed.length === 1 && climbed[0].parts.length === 2, JSON.stringify(climbed.map(x => x.parts.length)));
  }

  // ---- who may be scored together: role, not length --------------------------------------
  u = collect(Array.from({ length: 13 }, (_, i) => `<p>POST${i} ${sent(5)}</p>`).join(""));
  check("thirteen six-word one-sentence paragraphs of one post → ONE unit (the old 8-word floor dropped them all)",
    u.length === 1 && u[0].parts === 13 && u[0].words === 78, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div>${Array.from({ length: 13 }, (_, i) => `L${i} ${line(5)}`).join("<br>")}</div>`);
  check("BR-separated short lines of one block join with NO punctuation at all",
    u.length === 1 && u[0].parts === 13 && u[0].text.startsWith("L0 "), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div style="white-space:pre-wrap">${Array.from({ length: 13 }, (_, i) => `L${i} ${line(5)}`).join("\n\n")}</div>`);
  check("…and so do blank-line-separated lines of a pre-wrap block (X, LinkedIn)", u.length === 1 && u[0].parts === 13, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div>alice_92<br>2h ago<br>${Array.from({ length: 13 }, () => sent(6)).join("<br>")}<br>Reply · Share · Report</div>`);
  check("a handle, a timestamp and an action row set in the message's own block are skipped, never joined",
    u.length === 1 && !/alice_92|2h ago|Reply|Share/.test(u[0].text) && u[0].parts === 13, JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 30)])));

  {
    const thread = (rows) => rows.map(([who, text]) => `<div class="row head">${who} · 2h</div><div class="row msg">${text}</div><div class="row act">Reply · Share</div>`).join("");
    u = collect(`<div class="thread">${thread([["alice", sent(40)], ["bob", sent(40)], ["carol", sent(40)]])}</div>`);
    check("div-soup thread: short comments do NOT merge across the name / action rows between them", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<div class="thread"><div class="row head">alice · 2h</div><div class="row msg">A1 ${sent(40)}</div><div class="row msg">A2 ${sent(40)}</div><div class="row act">Reply · Share</div><div class="row head">bob · 1h</div><div class="row msg">B1 ${sent(20)}</div></div>`);
    check("…one speaker's consecutive messages do; the next speaker's orphan does not extend that unit",
      u.length === 1 && u[0].parts === 2 && !u[0].text.includes("B1") && !/alice|bob|Reply/.test(u[0].text), JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 12)])));
  }

  u = collect(`<article><div class="who">Alice Moreau</div><p>${sent(40)}</p><div class="meta">Edited 2h ago</div><p>${sent(40)}</p><div class="act">Reply · Share</div></article>`);
  check("name, 'Edited 2h ago' and action rows inside a post are transparent — and never part of its text",
    u.length === 1 && u[0].parts === 2 && !/Alice|Edited|Reply/.test(u[0].text), JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 20)])));

  u = collect(`<article><p>${sent(40)}</p><p><strong>2. One owner per decision</strong></p><p>${sent(40)}</p></article>`);
  check("inside an <article> a bold pseudo-heading is transparent: the sections still merge, without it",
    u.length === 1 && u[0].parts === 2 && !u[0].text.includes("owner"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div><div class="txt">${sent(40)}</div><div class="ttl">Finish early</div><div class="txt">${sent(40)}</div></div>`);
  check("on the bare page the same row is indistinguishable from a name row and ends the group (like a real heading)", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(40)}</p><div class="widget"><div class="bar"><div class="btns"><span style="display:block">Play</span></div></div></div><p>${sent(40)}</p>`);
  check("a label buried deeper than the text is a widget's crumb, not a boundary (MDN's live-sample 'Play')", u.length === 1 && u[0].parts === 2 && !u[0].text.includes("Play"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<ul><li>${line(20)}</li><li>Sea salt</li><li>${sent(30)}</li><li>Rest the dough</li><li>${line(30)}</li></ul>`);
  check("bullet items join with or without a full stop; a short item is skipped, never a boundary",
    u.length === 1 && u[0].parts === 3 && !/Sea salt|Rest the dough/.test(u[0].text), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<dl><dt>Brown butter</dt><dd>${sent(40)}</dd><dt>Rolled oats</dt><dd>${sent(40)}</dd></dl>`);
  check("a glossary <dt> is a term, not a boundary", u.length === 1 && u[0].parts === 2 && !u[0].text.includes("Brown"), JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(40)}</p><p>Can also be written as:</p><p>${sent(40)}</p>`);
  check("a lead-in sentence ending in a colon is the author's own and joins", u.length === 1 && u[0].parts === 3, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div class="log"><div>${sent(40)}</div><div>bob wrote:</div><div>${sent(40)}</div></div>`);
  check("…but 'bob wrote:' names somebody else: a label, and on the bare page a boundary", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(40)}</p><p>Yes.</p><p>${sent(40)}</p>`);
  check("a punctuated aside too short to be evidence ('Yes.') is skipped without consequence", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<p>${sent(40)}</p><p>Hodges 1983, p. 208.</p><p>Alice Moreau, Ph.D.</p><p>SIGN UP TODAY!</p><p>${sent(40)}</p>`);
  check("a citation, a name with a title and a shouting button end in punctuation but are not sentences",
    u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  {
    const zh = "我完全同意你的看法。";
    u = collect(Array.from({ length: 16 }, () => `<p>${zh}</p>`).join(""));
    check("short CJK sentences (。) are sentences too", u.length >= 1 && u[0].parts > 1, JSON.stringify(u.map(x => [x.parts, x.words])));
  }

  u = collect(`<div>${line(5)}<br>${Array.from({ length: 13 }, () => sent(6)).join("<br>")}</div>`);
  check("an unpunctuated FIRST line ('I quit my job') is adopted once the next line shows it opens a block",
    u.length === 1 && u[0].parts === 14, JSON.stringify(u.map(x => [x.parts, x.words])));

  u = collect(`<div><div>${line(5)}</div><div>${sent(40)}</div><div>${sent(40)}</div></div>`);
  check("…and dropped when what follows is another block", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

  sandbox.innerHTML = Array.from({ length: 13 }, () => `<p>${sent(6)}</p>`).join("");
  check("mergeShorts:false — one-sentence paragraphs are still skipped in strict mode", PW.collectUnits(sandbox, { mergeShorts: false }).length === 0);

  {
    // Incremental re-scan of an ARTICLE (longer than a window): the full paragraph a live
    // unit owns still ends the group before it, and nothing is emitted a second time.
    sandbox.innerHTML = `<article><p>${sent(40)}</p><p>${sent(320)}</p><p>${sent(40)}</p><p>${sent(320)}</p></article>`;
    const firstScan = PW.collectUnits(sandbox);
    const ownedNodes = new Set();
    for (const un of firstScan) for (const part of un.parts) for (const n of part.nodes) ownedNodes.add(n);
    const again = PW.collectUnits(sandbox, { claimFilter: (nodes) => (nodes.some((n) => ownedNodes.has(n)) ? "skip" : "take") });
    check("claimed unit inside a scope: still no merging across it on re-scan", firstScan.length === 2 && firstScan.every((x) => x.parts.length === 1) && again.length === 0, JSON.stringify([firstScan.map(x => x.parts.length), again.map(x => x.parts.length)]));
  }

  // ---- one voice, one verdict: posts are read whole, groups stay open until the voice ends ----
  // X as measured: article[role=article] → flex wrappers → div[data-testid=tweetText]
  // (display:block, white-space:pre-wrap) → ONE inline span whose text node is the whole
  // post, paragraphs separated by blank lines.
  const xPost = (paras, { who = "Some Name", after = "" } = {}) =>
    `<article role="article" tabindex="0"><div style="display:flex;flex-direction:column"><div style="display:flex;flex-direction:row">` +
    `<div data-testid="User-Name"><a href="#u" role="link"><div><span>${who}</span></div></a></div></div>` +
    `<div style="display:flex;flex-direction:column"><div data-testid="tweetText" dir="auto" lang="en" style="display:block;white-space:pre-wrap"><span>${paras.join("\n\n")}</span></div>${after}</div>` +
    `<div role="group" style="display:flex"><button><div><span>12</span></div></button><button><div><span>3</span></div></button></div></div></article>`;
  const shape = (units) => JSON.stringify(units.map((x) => [x.parts, x.words]));
  {
    const TWELVE = [14, 10, 22, 22, 12, 13, 11, 14, 17, 14, 16, 16]; // 181 words, as measured on x.com
    u = collect(xPost(TWELVE.map((n, i) => `P${i} ${sent(n - 1)}`)));
    check("X: a 181-word post of twelve short paragraphs is ONE unit of twelve parts (it was ×4 / ×4 / ×4)",
      u.length === 1 && u[0].parts === 12 && u[0].words === 181 && partsOf(u[0]).every((t, i) => t.startsWith(`P${i} `)), shape(u));

    u = collect(xPost([`A ${sent(29)}`, `B ${sent(54)}`, `C ${sent(19)}`, `D ${sent(59)}`, `E ${sent(24)}`]));
    check("X: a post of mixed paragraphs [30][55][20][60][25] is ONE unit, in document order (it was two chips and three paragraphs nobody judged)",
      u.length === 1 && u[0].parts === 5 && u[0].words === 190 && partsOf(u[0]).map((t) => t[0]).join("") === "ABCDE", shape(u));

    const tags = `<span><a href="#h1" role="link">#oncall</a></span> <span><a href="#h2" role="link">#sre</a></span>`;
    u = collect(xPost([`A ${sent(29)}`, tags, `B ${sent(54)}`, "* * *", `C ${sent(19)}`]));
    check("…a line of hashtags and a row of asterisks inside a post are left out of it and end nothing",
      u.length === 1 && u[0].parts === 3 && !/#oncall|\*/.test(u[0].text), shape(u));

    u = collect(`<article><h2>A heading inside a forum post</h2><p>A ${sent(39)}</p><h3>Another one</h3><p>B ${sent(39)}</p></article>`);
    check("…and so is a heading: inside a post it is no boundary", u.length === 1 && u[0].parts === 2 && !u[0].text.includes("heading"), shape(u));

    // Just above one window: an article. Full paragraphs keep their chip, shorts group.
    const over = [`A ${sent(39)}`, `B ${sent(39)}`, `C ${sent(79)}`, `D ${sent(29)}`, `E ${sent(29)}`, `F ${sent(29)}`, `G ${sent(79)}`];
    u = collect(xPost(over));
    const overChars = over.join("\n\n").length;
    check("a post just ABOVE one window is an article: a unit per full paragraph, the short ones grouped between them",
      overChars > PW.WINDOW_CHARS && overChars < PW.WINDOW_CHARS * 1.2 && shape(u) === JSON.stringify([[2, 80], [1, 80], [3, 90], [1, 80]]), `${overChars} chars ${shape(u)}`);
    const under = [`A ${sent(39)}`, `B ${sent(39)}`, `C ${sent(79)}`, `D ${sent(29)}`, `E ${sent(29)}`, `F ${sent(29)}`, `G ${sent(69)}`];
    u = collect(xPost(under));
    check("…and the same post a sentence shorter, inside the window, is one unit", under.join("\n\n").length <= PW.WINDOW_CHARS && u.length === 1 && u[0].parts === 7, `${under.join("\n\n").length} chars ${shape(u)}`);

    u = collect(xPost([`ALICE ${sent(44)}`], { who: "Alice" }) + xPost([`BOB ${sent(44)}`], { who: "Bob" }));
    check("two adjacent posts by different authors, each under the floor: nothing, never added up", u.length === 0, shape(u));

    const more = `<a href="#status" role="link" dir="ltr" style="display:block" data-testid="tweet-text-show-more-link">Show more</a>`;
    u = collect(xPost([`${sent(30)} ${sent(13).slice(0, -1)}…`], { after: more }));
    check("a post the timeline cut at 280 characters (44 visible words and 'Show more') gets nothing until it is opened", u.length === 0, shape(u));

    const quoted = (text) => `<div><div role="link" tabindex="0" style="display:flex;flex-direction:column"><div data-testid="User-Name"><div><span>Quoted Person</span></div></div><div data-testid="tweetText" style="display:block;white-space:pre-wrap"><span>${text}</span></div></div></div>`;
    u = collect(xPost([`OUTER-A ${sent(39)}`, `OUTER-B ${sent(39)}`], { after: quoted(`QUOTED ${sent(39)}`) }));
    check("a quoted post (div[role=link] inside the quoting post) is excluded from the post's unit",
      u.length === 1 && u[0].parts === 2 && u[0].text.includes("OUTER-A") && u[0].text.includes("OUTER-B") && !u[0].text.includes("QUOTED"), shape(u));
    u = collect(xPost([`OUTER-A ${sent(39)}`, `OUTER-B ${sent(39)}`], { after: quoted(`QUOTED ${sent(79)}`) }));
    check("…and one long enough to be judged is a unit of its own: two voices, two verdicts",
      u.length === 2 && u[0].parts === 2 && !u[0].text.includes("QUOTED") && u[1].parts === 1 && u[1].text.startsWith("QUOTED"), shape(u));

    u = collect(`<article><div class="lockup"><div><a href="#a">Alice Moreau</a></div><p>${line(11)}</p></div><div class="text"><p>TEXT ${sent(39)}</p><p>${sent(40)}</p></div></article>`);
    check("what stands elsewhere in the card (LinkedIn's headline row, running text by its looks) is not the post",
      u.length === 1 && u[0].parts === 2 && u[0].text.startsWith("TEXT"), shape(u));

    u = collect(`<article><p>${sent(40)}</p><ul><li><p>ITEM ${sent(11)}</p></li><li><p>ITEM ${sent(11)}</p></li></ul><p>LAST ${sent(39)}</p></article>`);
    check("the paragraphs on both sides of a list set a level deeper still belong together", u.length === 1 && u[0].parts === 2 && u[0].text.includes("LAST") && !u[0].text.includes("ITEM"), shape(u));

    sandbox.innerHTML = xPost([`A ${sent(29)}`, `B ${sent(79)}`, `C ${sent(19)}`]);
    const strictPost = PW.collectUnits(sandbox, { mergeShorts: false });
    check("mergeShorts:false — a post is NOT read whole: strict per-paragraph mode", strictPost.length === 1 && strictPost[0].parts.length === 1 && strictPost[0].wordCount === 80, JSON.stringify(strictPost.map((x) => [x.parts.length, x.wordCount])));
  }
  {
    // Groups no longer close at the floor — on the bare page and in articles alike.
    u = collect(Array.from({ length: 6 }, (_, i) => `<p>P${i} ${sent(24)}</p>`).join(""));
    check("six 25-word paragraphs of one voice on the bare page → ONE unit of six parts (they were ×2 / ×2 / ×2)", u.length === 1 && u[0].parts === 6 && u[0].words === 150, shape(u));

    u = collect(`<p>${sent(30)}</p><p>${sent(30)}</p><p>${sent(30)}</p><p>FULL ${sent(79)}</p><p>${sent(40)}</p><p>${sent(40)}</p>`);
    check("a full paragraph still ends the group before it and stays a unit of its own", shape(u) === JSON.stringify([[3, 90], [1, 80], [2, 80]]), shape(u));

    u = collect(`<p>${sent(30)}</p><p>${sent(30)}</p><p>${sent(30)}</p><h3>Next topic</h3><p>${sent(30)}</p><p>${sent(30)}</p><p>${sent(25)}</p>`);
    check("…and so does a heading", shape(u) === JSON.stringify([[3, 90], [3, 85]]), shape(u));

    // A thousand words of 20-word lines, one voice: neither a chip every three lines nor one
    // number for the lot — model-sized groups, cut between lines, even, nothing dropped.
    const lines = (n) => Array.from({ length: n }, (_, i) => `<p>L${i} ${sent(9)} ${sent(10)}</p>`).join("");
    sandbox.innerHTML = lines(50);
    let got = PW.collectUnits(sandbox);
    const sized = (units) => JSON.stringify(units.map((x) => [x.parts.length, x.wordCount, x.text.length]));
    check("a 1000-word run of 20-word lines → three groups of one model window each (they were sixteen of ×3), every line in one of them",
      got.length === 3 && got.reduce((n, x) => n + x.parts.length, 0) === 50 && got.reduce((n, x) => n + x.wordCount, 0) === 1000 &&
      got.every((x) => x.text.length <= PW.WINDOW_CHARS && PW.planWindows(x.text).length === 1 && Math.abs(x.parts.length - 50 / 3) < 1), sized(got));

    sandbox.innerHTML = lines(300);
    got = PW.collectUnits(sandbox);
    check("a 6000-word run → ceil(length / window) groups, none above a window, none below the floor, as even as the lines allow",
      got.length === Math.ceil((got.reduce((n, x) => n + x.text.length, 0) + 2 * (got.length - 1)) / PW.WINDOW_CHARS) && got.reduce((n, x) => n + x.parts.length, 0) === 300 && got.reduce((n, x) => n + x.wordCount, 0) === 6000 &&
      got.every((x) => x.text.length <= PW.WINDOW_CHARS && x.wordCount >= PW.MIN_UNIT_WORDS && Math.abs(x.parts.length - 300 / got.length) <= 1), sized(got));

    u = collect(Array.from({ length: 7 }, (_, i) => `<p>P${i} ${sent(79)}</p>`).join("").replace(/<p>P3 [^<]*<\/p>/, `<p>P3 ${sent(19)}</p>`));
    check("full paragraphs are never grouped with each other, however short", u.length === 6 && u.filter((x) => x.parts === 2).length === 1, shape(u));
  }
  {
    // No orphans inside one voice: a short text that cannot stand alone joins the full
    // paragraph beside it — the one before it by preference — if the two fit one window.
    u = collect(`<p>FULL ${sent(79)}</p><p>TAIL ${sent(19)}</p>`);
    check("[80][20] → one unit ×2: the tail joins the paragraph before it", u.length === 1 && u[0].parts === 2 && u[0].words === 100 && u[0].text.startsWith("FULL"), shape(u));
    u = collect(`<p>LEAD ${sent(12)}</p><p>FULL ${sent(76)}</p>`);
    check("[13][77] → one unit ×2: a lead-in with nothing before it joins the paragraph after it (Zhihu)", u.length === 1 && u[0].parts === 2 && u[0].words === 90 && u[0].text.startsWith("LEAD"), shape(u));
    u = collect(`<p>A ${sent(79)}</p><p>MID ${sent(19)}</p><p>B ${sent(79)}</p>`);
    check("[80][20][80] → the paragraph BEFORE it is preferred", shape(u) === JSON.stringify([[2, 100], [1, 80]]) && u[0].text.includes("MID"), shape(u));
    u = collect(`<p>${sent(39)}</p><p>${sent(121)}</p><p>${sent(226)}</p><p>${sent(120)}</p>`);
    check("[39][121][226][120] → the 39-word opening is judged with the paragraph after it (Zhihu)", shape(u) === JSON.stringify([[2, 160], [1, 226], [1, 120]]), shape(u));
    u = collect(`<p>${sent(80)}</p><p>${sent(108)}</p><p>${sent(118)}</p><p>${sent(82)}</p><p>${sent(40)}</p>`);
    check("[80][108][118][82][40] → the 40-word close is judged with the paragraph before it (Zhihu)", shape(u) === JSON.stringify([[1, 80], [1, 108], [1, 118], [2, 122]]), shape(u));

    const brim = sent(300); // a paragraph that nearly fills a window by itself
    u = collect(`<p>A ${brim}</p><p>MID ${sent(39)}</p><p>B ${sent(79)}</p>`);
    check("no room in the paragraph before it (the two would not fit one window) → it joins the one after",
      `A ${brim}`.length <= PW.WINDOW_CHARS && `A ${brim}\n\nMID ${sent(39)}`.length > PW.WINDOW_CHARS && shape(u) === JSON.stringify([[1, 301], [2, 120]]) && u[1].text.startsWith("MID"), shape(u));
    u = collect(`<p>A ${brim}</p><p>MID ${sent(39)}</p><p>B ${brim}</p>`);
    check("no room on either side → it stays unjudged, as before", shape(u) === JSON.stringify([[1, 301], [1, 301]]), shape(u));

    u = collect(`<p>${sent(80)}</p><h3>Next topic</h3><p>${sent(20)}</p>`);
    check("a heading between them: not joined", shape(u) === JSON.stringify([[1, 80]]), shape(u));
    u = collect(`<p>${sent(80)}</p><div><a href="#a">One</a> · <a href="#b">Two</a> · <a href="#c">Three</a></div><p>${sent(20)}</p>`);
    check("a link row between them: not joined", shape(u) === JSON.stringify([[1, 80]]), shape(u));
    u = collect(`<section><p>${sent(80)}</p></section><section><p>${sent(20)}</p></section>`);
    check("standing in another section: not joined", shape(u) === JSON.stringify([[1, 80]]), shape(u));
    u = collect(`<article><p>${sent(80)}</p></article><article><p>${sent(20)}</p></article>`);
    check("another post: never joined", shape(u) === JSON.stringify([[1, 80]]), shape(u));
    u = collect(`<p>${sent(80)}</p><blockquote><p>QUOTED ${sent(19)}</p></blockquote><figure><img alt=""><figcaption>CAPTION ${sent(14)}</figcaption></figure>`);
    check("a short quotation or a caption after a full paragraph is another voice: never joined", shape(u) === JSON.stringify([[1, 80]]) && !/QUOTED|CAPTION/.test(u[0].text), shape(u));
    u = collect(`<div class="thread"><div class="row head">alice · 2h</div><div class="row msg">ALICE ${sent(79)}</div><div class="row act">Reply · Share</div><div class="row head">bob · 1h</div><div class="row msg">BOB ${sent(19)}</div></div>`);
    check("div-soup thread: the next speaker's short message does NOT join the full message before it — the name row lets it go", shape(u) === JSON.stringify([[1, 80]]) && !u[0].text.includes("BOB"), shape(u));
    u = collect(`<p>${sent(250)}</p><p>${sent(40)}</p><p>${sent(40)}</p>`);
    check("shorts that reach the floor together stand by themselves; only an orphan joins", shape(u) === JSON.stringify([[1, 250], [2, 80]]), shape(u));
    sandbox.innerHTML = `<p>${sent(80)}</p><p>${sent(20)}</p>`;
    check("mergeShorts:false — nothing joins anything", JSON.stringify(PW.collectUnits(sandbox, { mergeShorts: false }).map((x) => [x.parts.length, x.wordCount])) === "[[1,80]]");

    u = collect(xPost([`FULL ${sent(79)}`, `Here is what happened next`, `LAST ${sent(29)}`]));
    check("X: an unpunctuated line after a FULL paragraph of the same text block is still a line of that post", u.length === 1 && u[0].parts === 3 && u[0].text.includes("Here is what happened next"), shape(u));
    u = collect(`<div>${sent(80)}<br>Posted by alice on March 3</div>`);
    check("…on the bare page it is not: that is where a forum sets 'Posted by alice on March 3' under a message", u.length === 1 && u[0].parts === 1 && !u[0].text.includes("Posted"), shape(u));
    u = collect(xPost([51, 30, 35, 51, 46, 75].map((n, i) => `P${i} ${sent(n - 1)}`)));
    check("X: a 288-word post in six blank-line paragraphs is ONE unit (it was four: 51, 65, 51, 75 words, 46 unjudged)", u.length === 1 && u[0].parts === 6 && u[0].words === 288 && u[0].text.length <= PW.WINDOW_CHARS, `${shape(u)} ${u[0]?.text.length}`);
  }
  {
    // ONE grouping rule, two roads to it. The walker reads a page and decides what stands
    // beside what; the arithmetic underneath it — the floor, the window, the even division,
    // the orphan rule — is source-free (lib/plan/group.ts) and is what the PDF reader calls
    // with no DOM anywhere (lib/pdf/units.ts). The same paragraphs, expressed as <p>s and as
    // bare word/character counts, must come out grouped the same way; if they ever did not,
    // a paper and a web page would be read by two different rules.
    const asPlan = (ns) => ns.map((n) => ({ words: n, chars: words(n).length }));
    const planShape = (ns) =>
      JSON.stringify(PW.groupBlocks(asPlan(ns)).map((g) => [g.length, g.reduce((sum, i) => sum + ns[i], 0)]));
    const walkShape = (ns) => shape(collect(ns.map((n) => `<p>${words(n)}</p>`).join("")));
    for (const ns of [
      [30, 30, 30],
      [20, 80, 20],
      [80, 20],
      [13, 77],
      [80, 20, 80],
      [39, 121, 226, 120],
      [80, 108, 118, 82, 40],
      [30, 30, 30, 80, 40, 40],
      [250, 40, 40],
      Array.from({ length: 12 }, () => 45),
      Array.from({ length: 50 }, () => 20),
    ]) {
      const label = ns.length > 6 ? `${ns.length}×${ns[0]} words` : `[${ns}]`;
      check(`the walker and the source-free rule group ${label} the same way`, walkShape(ns) === planShape(ns),
        `walker ${walkShape(ns)} · plan ${planShape(ns)}`);
    }
  }
  {
    // Papers and articles: a unit per full paragraph, in an <article> and on the bare page alike.
    const body = [120, 80, 200, 95, 150, 110].map((n, i) => `<p>PARA${i} ${sent(n - 1)}</p>`).join("");
    const bare = collect(`<h1>Title</h1>${body}`);
    const inArticle = collect(`<article><h1>Title</h1>${body}</article>`);
    check("an article of 80–200-word paragraphs: one single-part unit per paragraph, with or without <article>",
      shape(bare) === JSON.stringify([[1, 120], [1, 80], [1, 200], [1, 95], [1, 150], [1, 110]]) && shape(inArticle) === shape(bare), `${shape(bare)} ${shape(inArticle)}`);
    u = collect(`<article><h1>Title</h1>${body}<p>${sent(30)}</p><p>${sent(30)}</p><p>${sent(30)}</p></article>`);
    check("…its short paragraphs group among themselves and never into a full one", u.length === 7 && u[6].parts === 3 && u.slice(0, 6).every((x) => x.parts === 1), shape(u));
  }
  // ---- who may be scored together: posts that do not declare themselves ------------------
  // A post is ONE OF SEVERAL LIKE IT, EACH WITH ITS OWN BYLINE (lib/dom/scope.ts). `by` is a
  // byline as most sites set it: a picture and a name that link to the same person, a <time>.
  {
    const by = (who) => `<div class="meta"><a href="/u/${who}"><img class="avatar" alt=""></a> <a href="/u/${who}">${who}</a> <time datetime="2026-09-18T08:00:00Z">2h</time></div>`;
    const post = (who, ...paras) => `<div class="c">${by(who)}<div class="b">${paras.map((t) => `<p>${t}</p>`).join("")}</div></div>`;

    u = collect(post("alice", `A ${sent(29)}`, `B ${sent(54)}`, `C ${sent(19)}`, `D ${sent(59)}`) + post("bob", sent(30)));
    check("an undeclared comment of mixed paragraphs [30][55][20][60] is ONE unit, in order (it was two: ×3, ×1), the byline in none of it",
      u.length === 1 && u[0].parts === 4 && u[0].words === 165 && partsOf(u[0]).map((t) => t[0]).join("") === "ABCD" && !/alice|2h/.test(u[0].text), shape(u));

    u = collect(`<ul>${["alice", "bob", "carol"].map((who) => `<li><img class="avatar" alt=""> ${who.toUpperCase()} ${sent(24)}</li>`).join("")}</ul>`);
    check("three short notes, siblings, with NOTHING but an avatar between them: never added up (proximity alone made them one unit of three voices)", u.length === 0, shape(u));
    u = collect(`<ul>${["ALICE", "BOB", "CAROL"].map((who) => `<li>${who} ${sent(24)}</li>`).join("")}</ul>`);
    check("…while the same items without a byline are one author's bullets, and merge as ever", u.length === 1 && u[0].parts === 3, shape(u));

    u = collect(post("alice", `PARENT ${sent(39)}`).replace(/<\/div>$/, `<div class="replies">${post("bob", `REPLY ${sent(39)}`)}</div></div>`) + post("carol", sent(20)));
    check("a reply standing ALONE under its parent has no sibling like it: it is a post by being shaped like the post around it — never read with its parent", u.length === 0, shape(u));
    u = collect(post("alice", `PARENT ${sent(79)}`).replace(/<\/div>$/, `<div class="replies">${post("bob", `REPLY-A ${sent(39)}`, `REPLY-B ${sent(39)}`)}</div></div>`) + post("carol", sent(20)));
    check("…and gets a verdict of its own when it has the words: [parent ×1][reply ×2]",
      u.length === 2 && u[0].parts === 1 && u[0].text.startsWith("PARENT") && u[1].parts === 2 && u[1].text.startsWith("REPLY-A") && !u[0].text.includes("REPLY"), shape(u));

    u = collect(`<div class="one">${by("alice")}<div class="b"><p>A ${sent(29)}</p><p>B ${sent(79)}</p><p>C ${sent(19)}</p><p>D ${sent(79)}</p></div></div>`);
    check("ONE comment on its page has nobody like it and is not recognised: read as the bare page always was (×3, ×1) — a stated limit", shape(u) === JSON.stringify([[3, 130], [1, 80]]), shape(u));

    // The chat transcript whose name rows carry avatars: every such row is "one of several
    // like it, with a byline" and is recognised — as a post of no text. It must still END the
    // group around it, as the row did on the bare page, or two voices are read together.
    const row = (who, ...msgs) => `<div class="row head"><img class="avatar" alt=""> <span>${who}</span></div>` + msgs.map((t) => `<div class="row msg">${t}</div>`).join("");
    u = collect(`<div class="log">${row("alice", `ALICE ${sent(29)}`)}${row("bob", `BOB ${sent(29)}`)}${row("carol", `CAROL ${sent(29)}`)}</div>`);
    check("a flat chat whose name rows carry avatars: the recognised rows END the group, the voices are never added up", u.length === 0, shape(u));
    u = collect(`<div class="log">${row("alice", `A1 ${sent(39)}`, `A2 ${sent(39)}`)}${row("bob", `BOB ${sent(19)}`)}</div>`);
    check("…and one speaker's consecutive messages still are", u.length === 1 && u[0].parts === 2 && !u[0].text.includes("BOB"), shape(u));

    // A label inside a recognised post: among the text it is the author's pseudo-heading and
    // cuts nothing; as a row of the card it concludes what was read, as the bare page did.
    u = collect(post("alice", `A ${sent(29)}`, "What went wrong with it", `B ${sent(29)}`, "Where we ended up", `C ${sent(29)}`) + post("bob", sent(20)));
    check("a label AMONG THE TEXT of a recognised post (V2EX's unpunctuated <p>s, Zhihu's bold <p>) cuts nothing and is in no unit",
      u.length === 1 && u[0].parts === 3 && !/wrong|ended/.test(u[0].text), shape(u));
    const card = (who, text) => `<div class="card"><div class="main"><div class="stats">26 people found this review helpful<br>3 people found this review funny</div><div class="vote"><div class="t">Recommended</div></div><div class="text"><div class="date">Posted: 12 September</div>${text}</div></div><div class="author"><a href="/id/${who}"><img alt="" src="https://avatars.example.invalid/${who}.jpg"></a><a href="/id/${who}">${who}</a></div></div>`;
    u = collect(card("alice", `REVIEW ${sent(79)}`) + card("bob", sent(20)));
    check("a label that is a ROW OF THE CARD (Steam: 'Posted: …' between the counters and the review) concludes what was read: the site's counter lines are never the opening lines of a review",
      u.length === 1 && u[0].parts === 1 && u[0].text.startsWith("REVIEW") && !/found this review/.test(u[0].text), shape(u));

    // Lines of verse: one unpunctuated line per block. The short ones used to be "labels".
    {
      const VERSE = [4, 6, 13, 9, 13, 7, 5, 12, 6, 7]; // a Zhihu answer as measured (the first six lines), four lines longer: no line ends in punctuation
      const verse = VERSE.map((n, i) => `V${i} ${line(n - 1)}`);
      u = collect(post("alice", ...verse) + post("bob", sent(20)));
      check("a recognised answer written one unpunctuated line per <p> — 4, 6, 13, 9, 13, 7, 5, 12, 6, 7 words — is ONE unit of ten lines, 82 words (only the four long lines joined: 47 words, nothing)",
        u.length === 1 && u[0].parts === 10 && u[0].words === 82 && partsOf(u[0]).every((t, i) => t.startsWith(`V${i} `)), shape(u));
      u = collect(`<article>${verse.map((t) => `<p>${t}</p>`).join("")}</article>`);
      check("…and so is a declared post of that shape", u.length === 1 && u[0].parts === 10 && u[0].words === 82, shape(u));
      u = collect(verse.map((t) => `<p>${t}</p>`).join(""));
      check("…while on the bare page nothing changes: there a short unpunctuated line may be the next person's name row", u.length === 0, shape(u));

      u = collect(post("alice", `A ${sent(34)}`, "What went wrong with it", `B ${sent(34)}`, `C ${line(9)}`) + post("bob", sent(20)));
      check("a pseudo-heading is still in no unit: it introduces sentences, and a line of verse stands beside lines that read on without a stop",
        u.length === 1 && u[0].parts === 3 && !u[0].text.includes("wrong"), shape(u));
      u = collect(post("alice", `A ${sent(39)}`, "Where We Ended Up", `B ${line(12)}`, `C ${line(13)}`, `D ${line(12)}`) + post("bob", sent(20)));
      check("…nor is a Title In Title Case before unstopped lines: a line of verse is running text", u.length === 1 && !u[0].text.includes("Ended"), shape(u));
      const stats = `<div class="stat">26 people found this review helpful</div><div class="stat">3 people found this review funny</div>`;
      u = collect(`<div class="c">${by("alice")}<div class="b">${stats}<div class="text">REVIEW ${sent(79)}</div></div></div>` + post("bob", sent(20)));
      check("two counter rows of a card, side by side above a punctuated review, are no verse and stay out of it", u.length === 1 && u[0].parts === 1 && !/found this review/.test(u[0].text), shape(u));
      u = collect(`<div class="c">${by("alice")}<div class="b">${stats}<div class="text">REVIEW ${line(80)}</div></div></div>` + post("bob", sent(20)));
      check("…even above a review that has no full stop itself: they are not blocks of the text's body (another class)", u.length === 1 && u[0].parts === 1 && !/found this review/.test(u[0].text), shape(u));

      u = collect(`<article><ul><li>ITEM-A ${line(24)}</li><li>two spoons of brown sugar</li><li>ITEM-B ${line(26)}</li><li>ITEM-C ${line(26)}</li></ul></article>`);
      check("list items keep their own rule inside a post too: a five-word item beside long unpunctuated ones is skipped, not a line of verse (Google's terms, an sspai article)",
        u.length === 1 && u[0].parts === 3 && !u[0].text.includes("spoons"), shape(u));

      // LinkedIn as measured on the live page, longer: prose three words short of the floor and a line
      // that is all hashtags.
      const tags = `<a href="/feed/hashtag/?keywords=oncall">#oncall</a> <a href="/feed/hashtag/?keywords=sre">#sre</a> <a href="/feed/hashtag/?keywords=reliability">#reliability</a>`;
      u = collect(`<div role="list"><div><div role="listitem"><div class="hd">${by("alice")}</div><p><span data-testid="expandable-text-box">${sent(35)}<br><br>${sent(35)}<br><br>${tags}</span></p></div></div><div><div role="listitem"><div class="hd">${by("bob")}</div><p><span>${sent(30)}</span></p></div></div></div>`);
      check("LinkedIn: 72 words of prose and an all-link hashtag line stay unjudged — the hashtags are never what lifts a post over the floor", u.length === 0, shape(u));
    }

    // One text body: deeper because of LIST markup, never because of a layout box.
    u = collect(post("alice", `LEAD ${sent(34)}`).replace("</p></div>", `</p><ol><li><p>ITEM-A ${sent(14)}</p></li><li><p>ITEM-B ${sent(14)}</p></li></ol><p>LAST ${sent(14)}</p></div>`) + post("bob", sent(20)));
    check("inside a recognised post a paragraph and `ol > li > p` items two levels down are one text (a Zhihu answer lost such paragraphs: no neighbour by proximity)",
      u.length === 1 && u[0].parts === 4 && u[0].text.includes("ITEM-A") && u[0].text.includes("LAST"), shape(u));
    u = collect(post("alice", `REVIEW ${sent(79)}`).replace(/<\/div><\/div>$/, `</div><hr><div class="ask"><div class="q">Was this review helpful?</div></div></div>`) + post("bob", sent(20)));
    check("…while a sentence of the SITE in a layout box under the text (Steam: 'Was this review helpful?') never joins it, byline between them or not",
      u.length === 1 && u[0].parts === 1 && !u[0].text.includes("helpful"), shape(u));
    u = collect(`<article><p>LEAD ${sent(39)}</p><ol><li><p>ITEM-A ${sent(14)}</p></li><li><p>ITEM-B ${sent(14)}</p></li></ol><p>LAST ${sent(39)}</p></article>`);
    check("…and a DECLARED post is read exactly as before: the items a level deeper stay out", u.length === 1 && u[0].parts === 2 && !u[0].text.includes("ITEM"), shape(u));

    // The opening post: no sibling like it, but the thread that answers it follows it.
    const opening = (inner) => `<div class="box"><div class="hd">${by("alice")}</div><div class="cell">${inner}</div></div><div class="box"><div class="cell">${by("bob")}<p>${sent(20)}</p></div><div class="cell">${by("carol")}<p>${sent(20)}</p></div></div>`;
    u = collect(opening(`<p>A ${sent(34)}</p><p>What we tried first</p><ul><li>${line(9)}</li><li>${line(9)}</li></ul><p>B ${sent(34)}</p>`));
    check("the post a thread answers (V2EX's topic box) is a post: its label <p> cuts nothing → paragraphs and list items are ONE unit (the label ended the group: nothing)",
      u.length === 1 && u[0].parts === 4 && !u[0].text.includes("tried"), shape(u));
    u = collect(opening(`<h2>Summary</h2><p>SUMMARY ${sent(23)}</p><h2>Abstract</h2><p>ABSTRACT ${sent(79)}</p>`));
    check("…but an ARTICLE with section headings and comments under it is none: its headings stay boundaries (a paper page read its AI summary with its abstract)",
      u.length === 1 && u[0].parts === 1 && u[0].text.startsWith("ABSTRACT"), shape(u));

    // What is evidence of a byline, and what is a sentence that happens to mention somebody.
    const recognised = (html, sel) => { sandbox.innerHTML = html; const s = PW.createScopes(); return [...sandbox.querySelectorAll(sel)].map((el) => s.of(el) === el && s.recognised(el)); };
    const two = (inner) => `<div class="x">${inner}<p>${sent(20)}</p></div><div class="x">${inner}<p>${sent(20)}</p></div>`;
    check("byline evidence: <time>, [datetime], a title that spells out a moment, an avatar the site calls one, a link to a person, a picture and a name to the same place",
      [`<time>2h</time>`, `<relative-time datetime="2026-09-18T08:00:00Z">2h</relative-time>`, `<span title="2026-09-18T07:00:00">2h</span>`, `<a title="Sep 12, 2026, 3:04 PM" href="/c/1">2h</a>`,
        `<img class="Avatar" alt="">`, `<img alt="" src="https://avatars.example.invalid/u/1">`, `<a href="/member/alice">alice</a>`, `<a href="user?id=alice">alice</a>`, `<a href="./memberlist.php?mode=viewprofile&amp;u=7">alice</a>`,
        `<a href="/in/alice?x=1"><img alt=""></a><a href="/in/alice?y=2">Alice Moreau</a>`]
        .every((ev) => recognised(two(`<div class="m">${ev}</div>`), ".x").every(Boolean)));
    check("…and what is none: evidence in the middle of a sentence, an avatar-sized icon, a book number in a title, a link to a person on another site",
      [`<p>On <time>3 March</time> the council voted to keep the ferry and to pay for it.</p>`, `<p>Fixed in the spring release by <a href="/u/bob">@bob</a>, with thanks from all of us.</p>`,
        `<img alt="" width="27" height="27">`, `<a title="Special:BookSources/978-0-19-825079-1" href="/b">ISBN</a>`, `<span title="John 3:16">verse</span>`, `<a href="https://web.archive.org/web/2020/https://example.org/author/alice">Archived</a>`]
        .every((ev) => recognised(two(`<div class="m">${ev}</div>`), ".x").every((r) => !r)));

    // A pure function of the page: whichever element is asked first, the answers are the same.
    {
      const html = post("alice", sent(30)).replace(/<\/div>$/, `<div class="replies">${post("bob", sent(30))}</div></div>`) + post("carol", sent(30)) + post("dan", sent(30));
      sandbox.innerHTML = html;
      const all = [...sandbox.querySelectorAll("*")];
      const answers = (order) => { const s = PW.createScopes(); const got = new Map(); for (const el of order) got.set(el, s.of(el)); return all.map((el) => all.indexOf(got.get(el))); };
      const forward = answers(all), backward = answers([...all].reverse()), inside = answers([...sandbox.querySelectorAll(".replies p"), ...all]);
      const posts = [...sandbox.querySelectorAll(".c")].map((el) => all.indexOf(el));
      check("scopes are a pure function of the page: asked top-down, bottom-up or from inside a reply first, every element gets the same scope — the four comments, and nothing else",
        JSON.stringify(forward) === JSON.stringify(backward) && JSON.stringify(forward) === JSON.stringify(inside) && JSON.stringify([...new Set(forward)]) === JSON.stringify(posts), JSON.stringify([[...new Set(forward)], posts]));
    }
  }

  {
    // Incremental re-scan, the way lib/capture/orchestrator.ts does it: nodes are owned by
    // live units; a run that is exactly a live part is skipped, any other node list retires
    // its owners and queues the containers they release; dirty roots are the PARENT of what
    // was added, scanned round by round.
    const orchestrator = () => {
      const owner = new Map();
      const live = new Map();
      const retired = [];
      const invalidate = (unit, queue) => {
        for (const part of unit.parts) {
          for (const n of part.nodes) if (owner.get(n) === unit) owner.delete(n);
          if (queue && part.container.isConnected) queue.add(part.container);
        }
        live.delete(unit.id);
        retired.push(unit.id);
      };
      const filterFor = (queue) => (nodes) => {
        const owners = new Set(nodes.map((n) => owner.get(n)).filter(Boolean));
        if (owners.size === 0) return "take";
        if (owners.size === 1) {
          const [only] = owners;
          const part = only.parts.find((x) => x.nodes.includes(nodes[0]));
          if (live.has(only.id) && part && part.nodes.length === nodes.length && part.nodes.every((n, i) => n === nodes[i])) return "skip";
        }
        for (const unit of owners) if (live.has(unit.id)) invalidate(unit, queue);
        return "take";
      };
      const ingest = (units) => { for (const unit of units) { live.set(unit.id, unit); for (const part of unit.parts) for (const n of part.nodes) owner.set(n, unit); } };
      const scan = (roots) => {
        for (const unit of [...live.values()]) if (unit.parts.some((part) => part.nodes.some((n) => !n.isConnected))) invalidate(unit, null);
        const scanned = new Set();
        let queue = roots;
        for (let round = 0; round < 4 && queue.length > 0; round++) {
          const extra = new Set();
          const filter = filterFor(extra);
          for (const root of queue) {
            if (scanned.has(root) || !root.isConnected) continue;
            scanned.add(root);
            ingest(PW.collectUnits(root, { claimFilter: filter }));
          }
          queue = [...extra].filter((r) => !scanned.has(r));
        }
      };
      // Every text node of `el` that a live unit owns, per unit — and the ones owned twice.
      const census = (el) => {
        const seen = new Map();
        let twice = 0;
        for (const unit of live.values()) for (const part of unit.parts) for (const n of part.nodes) {
          if (!el.contains(n)) continue;
          if (seen.has(n)) twice++;
          seen.set(n, unit.id);
        }
        return { units: [...live.values()].filter((x) => x.parts.some((part) => el.contains(part.container))).map((x) => [x.parts.length, x.wordCount]), twice, text: [...seen.keys()].map((n) => n.data).join(" ") };
      };
      return { scan, live, retired, census };
    };

    // 1) a forum post that gains a paragraph while it is on screen
    sandbox.innerHTML = `<article><header><a href="#a">alice</a></header><div class="body"><p>ONE ${sent(29)}</p><p>TWO ${sent(54)}</p><p>THREE ${sent(19)}</p></div><footer><a href="#r">Reply</a></footer></article>`;
    let o = orchestrator();
    o.scan([sandbox]);
    const before = o.census(sandbox);
    const firstId = [...o.live.keys()][0];
    const p = document.createElement("p");
    p.textContent = `FOUR ${sent(24)}`;
    sandbox.querySelector(".body").appendChild(p);
    o.scan([sandbox.querySelector(".body")]); // computeScanRoots: the parent of what was added
    let after = o.census(sandbox);
    check("re-scan: a one-unit post that gains a paragraph is re-taken as ONE unit — the old one retired, no duplicate, no orphan",
      JSON.stringify(before.units) === "[[3,105]]" && JSON.stringify(after.units) === "[[4,130]]" && after.twice === 0 && o.retired.includes(firstId) && !o.live.has(firstId) &&
      ["ONE", "TWO", "THREE", "FOUR"].every((k) => after.text.includes(k)), JSON.stringify([before.units, after.units, after.twice, o.retired]));
    o.scan([sandbox.querySelector(".body")]);
    const settled = o.census(sandbox);
    check("…and scanning it again changes nothing (a unit of owned runs only is the live one)", JSON.stringify(settled.units) === "[[4,130]]" && o.retired.length === 1, JSON.stringify([settled.units, o.retired]));

    // 2) the released paragraphs are re-scanned ONE BY ONE, and the root is a single <p>:
    //    each of them, read by itself, would be a short text with nobody to join.
    sandbox.innerHTML = `<article><div class="body"><p>ONE ${sent(39)}</p><p id="grow">TWO ${sent(19)}</p><p>THREE ${sent(19)}</p></div></article>`;
    o = orchestrator();
    o.scan([sandbox]);
    sandbox.querySelector("#grow").insertAdjacentHTML("beforeend", ` <em>ADDED ${sent(9)}</em>`);
    o.scan([sandbox.querySelector("#grow")]);
    after = o.census(sandbox);
    check("re-scan from INSIDE a post starts at the post: a paragraph that grew is re-read with its neighbours",
      JSON.stringify(after.units) === "[[3,90]]" && after.twice === 0 && after.text.includes("ADDED") && o.retired.length === 1, JSON.stringify([after.units, after.twice, o.retired]));

    // 3) a post whose text changes in place: X's tweetText span has ONE string child, so
    //    React sets its text anew and the nodes the walker split are gone.
    sandbox.innerHTML = xPost([`A ${sent(29)}`, `B ${sent(29)}`, `C ${sent(29)}`]);
    o = orchestrator();
    o.scan([sandbox]);
    const span = sandbox.querySelector('[data-testid="tweetText"] > span');
    span.textContent = [`A ${sent(29)}`, `B ${sent(29)}`, `C ${sent(29)}`, `D ${sent(79)}`, `E ${sent(19)}`].join("\n\n");
    o.scan([span.parentElement]);
    after = o.census(sandbox);
    check("re-scan: an X-shaped post whose text is re-rendered in place is ONE unit again, full paragraph included",
      JSON.stringify(after.units) === "[[5,190]]" && after.twice === 0 && o.retired.length === 1, JSON.stringify([after.units, o.retired]));

    // 4) an answer streamed into its <article> outgrows the window: the post becomes an article.
    sandbox.innerHTML = `<article><div class="md"><p>ONE ${sent(79)}</p><p>TWO ${sent(19)}</p><p>THREE ${sent(84)}</p></div></article>`;
    o = orchestrator();
    o.scan([sandbox]);
    const whole = o.census(sandbox).units;
    sandbox.querySelector(".md").insertAdjacentHTML("beforeend", `<p>FOUR ${sent(299)}</p>`);
    o.scan([sandbox.querySelector(".md")]);
    after = o.census(sandbox);
    check("re-scan: a post that outgrows the window is retired whole and re-taken per paragraph — no stale ×3 next to the new chips",
      JSON.stringify(whole) === "[[3,185]]" && JSON.stringify(after.units) === "[[2,100],[1,85],[1,300]]" && after.twice === 0, JSON.stringify([whole, after.units, o.retired]));

    // 5) the bare page: a list of short items that gets one more.
    sandbox.innerHTML = `<ul>${Array.from({ length: 4 }, (_, i) => `<li>ITEM${i} ${sent(19)}</li>`).join("")}</ul>`;
    o = orchestrator();
    o.scan([sandbox]);
    sandbox.querySelector("ul").insertAdjacentHTML("beforeend", `<li>ITEM4 ${sent(19)}</li>`);
    o.scan([sandbox.querySelector("ul")]);
    after = o.census(sandbox);
    check("re-scan: a group on the bare page that gains an item is one unit again (it used to leave the new item out)",
      JSON.stringify(after.units) === "[[5,100]]" && after.twice === 0 && after.text.includes("ITEM4"), JSON.stringify([after.units, o.retired]));

    // 5b) owned runs are not even READ unless something new comes to stand beside them:
    //     a re-scan of a page where nothing changed counts no words at all.
    {
      sandbox.innerHTML = `<article><p>${sent(40)}</p><p>${sent(40)}</p></article>` + Array.from({ length: 40 }, (_, i) => `<p>BODY${i} ${sent(79)}</p>`).join("") + `<ul><li>${sent(40)}</li><li>${sent(40)}</li></ul>`;
      o = orchestrator();
      o.scan([sandbox]);
      const segment = Intl.Segmenter.prototype.segment;
      let reads = 0;
      Intl.Segmenter.prototype.segment = function (...args) { reads++; return segment.apply(this, args); };
      o.scan([sandbox]);
      Intl.Segmenter.prototype.segment = segment;
      check("re-scan of an unchanged page: 44 owned runs walked past, none of them read, nothing retired", o.live.size === 42 && o.retired.length === 0 && reads === 0, `${o.live.size} units, ${reads} reads`);
    }

    // 5c) a heading between what a unit owns and what is new keeps its place: in an article
    //     it still ends the group; in a post it never did.
    sandbox.innerHTML = `<article><div class="b"><p>ONE ${sent(39)}</p><p>TWO ${sent(39)}</p><h3>Next topic</h3><p>LONG ${sent(339)}</p></div></article>`;
    o = orchestrator();
    o.scan([sandbox]);
    sandbox.querySelector("h3").insertAdjacentHTML("afterend", `<p>NEW ${sent(39)}</p>`);
    o.scan([sandbox.querySelector(".b")]);
    after = o.census(sandbox);
    check("re-scan of an article: a new short paragraph BEHIND a heading does not reach across it into an owned group",
      JSON.stringify(after.units) === "[[2,80],[1,340]]" && o.retired.length === 0 && !after.text.includes("NEW"), JSON.stringify([after.units, o.retired]));
    sandbox.innerHTML = `<article><div class="b"><p>ONE ${sent(39)}</p><p>TWO ${sent(39)}</p><h3>Next topic</h3><p>LONG ${sent(299)}</p></div></article>`;
    o = orchestrator();
    o.scan([sandbox]);
    sandbox.querySelector("h3").insertAdjacentHTML("afterend", `<p>NEW ${sent(19)}</p>`);
    o.scan([sandbox.querySelector(".b")]);
    after = o.census(sandbox);
    check("…it joins the owned full paragraph after it instead, whose unit is retired and re-taken as ×2",
      JSON.stringify(after.units) === "[[2,80],[2,320]]" && o.retired.length === 1 && after.twice === 0 && after.text.includes("NEW"), JSON.stringify([after.units, o.retired]));
    sandbox.innerHTML = `<article><div class="b"><p>ONE ${sent(39)}</p><p>TWO ${sent(39)}</p><h3>Next topic</h3></div></article>`;
    o = orchestrator();
    o.scan([sandbox]);
    sandbox.querySelector("h3").insertAdjacentHTML("afterend", `<p>NEW ${sent(19)}</p>`);
    o.scan([sandbox.querySelector(".b")]);
    after = o.census(sandbox);
    check("…while in a post the same paragraph joins the post", JSON.stringify(after.units) === "[[3,100]]" && o.retired.length === 1 && after.twice === 0, JSON.stringify([after.units, o.retired]));

    // 6) inside a LONG article the walk stays where it was asked to start, and what it sees
    //    there is never mistaken for a post: the full paragraphs keep their own units.
    sandbox.innerHTML = `<article><section id="sec"><p>S1 ${sent(79)}</p><p>S2 ${sent(19)}</p><p>S3 ${sent(89)}</p></section>${Array.from({ length: 8 }, (_, i) => `<p>BODY${i} ${sent(119)}</p>`).join("")}</article>`;
    o = orchestrator();
    o.scan([sandbox]);
    const articleBefore = o.census(sandbox).units;
    sandbox.querySelector("#sec").insertAdjacentHTML("beforeend", `<p>S4 ${sent(39)}</p><p>S5 ${sent(39)}</p>`);
    o.scan([sandbox.querySelector("#sec")]);
    after = o.census(sandbox);
    check("re-scan inside a long article: its section is not taken for a post — every unit untouched, the new shorts a group of their own",
      JSON.stringify(articleBefore.slice(0, 2)) === "[[2,100],[1,90]]" && articleBefore.length === 10 && o.retired.length === 0 && JSON.stringify(after.units.slice(0, 10)) === JSON.stringify(articleBefore) && JSON.stringify(after.units[10]) === "[2,80]" && after.twice === 0 && after.text.includes("S5"),
      JSON.stringify([articleBefore, after.units, o.retired]));

    // 7) RECOGNISED posts (lib/dom/scope.ts) under the same re-scans. `thread` is a list of
    //    undeclared comments, each with a byline of its own.
    const byline = (who) => `<div class="meta"><a href="/u/${who}"><img class="avatar" alt=""></a> <a href="/u/${who}">${who}</a> <time datetime="2026-09-18T08:00:00Z">2h</time></div>`;
    const comment = (who, ...paras) => `<div class="c" id="c-${who}">${byline(who)}<div class="b">${paras.map((t) => `<p>${t}</p>`).join("")}</div></div>`;
    const mixed = (tag) => [`${tag}1 ${sent(29)}`, `${tag}2 ${sent(79)}`, `${tag}3 ${sent(19)}`, `${tag}4 ${sent(79)}`];

    sandbox.innerHTML = `<div class="thread">${comment("alice", ...mixed("A"))}${comment("bob", `B ${sent(29)}`)}${comment("carol", `C ${sent(79)}`)}</div>`;
    o = orchestrator();
    o.scan([sandbox]);
    const threadBefore = o.census(sandbox).units;
    sandbox.querySelector(".thread").insertAdjacentHTML("beforeend", comment("dave", ...mixed("D")));
    o.scan([sandbox.querySelector(".thread")]); // computeScanRoots: the parent of what was added
    after = o.census(sandbox);
    check("re-scan: a comment APPENDED to a thread of recognised posts is one unit ×4 of its own — nobody else's chip retired, nothing owned twice, nothing borrowed from bob's short comment next to it",
      JSON.stringify(threadBefore) === "[[4,210],[1,80]]" && JSON.stringify(after.units) === "[[4,210],[1,80],[4,210]]" && o.retired.length === 0 && after.twice === 0 && JSON.stringify(o.census(sandbox.querySelector("#c-dave")).units) === "[[4,210]]",
      JSON.stringify([threadBefore, after.units, o.retired]));

    // 7b) The thread had ONE comment — nobody like it, read as the bare page (×3, ×1). The
    //     second comment makes both of them posts. The newcomer is read as one; the first
    //     keeps the chips it has: its runs are owned, and nothing new came to stand beside them.
    sandbox.innerHTML = `<div class="thread">${comment("alice", ...mixed("A"))}</div>`;
    o = orchestrator();
    o.scan([sandbox]);
    const lone = o.census(sandbox).units;
    sandbox.querySelector(".thread").insertAdjacentHTML("beforeend", comment("dave", ...mixed("D")));
    o.scan([sandbox.querySelector(".thread")]);
    after = o.census(sandbox);
    check("re-scan: a second comment arrives next to a LONE one — the newcomer is a post (×4); the first keeps its two chips, none retired, none doubled, the two never mixed",
      JSON.stringify(lone) === "[[3,130],[1,80]]" && JSON.stringify(after.units) === "[[3,130],[1,80],[4,210]]" && o.retired.length === 0 && after.twice === 0 &&
      [...o.live.values()].every((x) => new Set(x.parts.map((part) => part.container.closest(".c").id)).size === 1), JSON.stringify([lone, after.units, o.retired]));

    // 8) A comment EDITED in place: the framework sets the paragraph's text anew, the old
    //    node is gone, and the root of the re-scan is the comment's body — inside the post.
    sandbox.innerHTML = `<div class="thread">${comment("alice", `A1 ${sent(39)}`, `A2 ${sent(39)}`)}${comment("bob", `B ${sent(29)}`)}</div>`;
    o = orchestrator();
    o.scan([sandbox]);
    const unedited = o.census(sandbox).units;
    sandbox.querySelector("#c-alice .b p").textContent = `EDITED ${sent(44)}`;
    o.scan([sandbox.querySelector("#c-alice .b")]);
    after = o.census(sandbox);
    check("re-scan: a recognised comment edited in place is re-taken WHOLE as one unit — the walk asked to start at its body starts at the post",
      JSON.stringify(unedited) === "[[2,80]]" && JSON.stringify(after.units) === "[[2,85]]" && after.twice === 0 && o.retired.length === 1 && after.text.includes("EDITED") && after.text.includes("A2"), JSON.stringify([unedited, after.units, o.retired]));

    // 9) A partial walk that starts INSIDE a recognised post finds the scope the full walk
    //    found: one paragraph of it, read by itself, would be a short text with nobody to join.
    sandbox.innerHTML = `<div class="thread">${comment("alice", `ONE ${sent(39)}`, `TWO ${sent(19)}`, `THREE ${sent(19)}`)}${comment("bob", `B ${sent(29)}`)}</div>`;
    o = orchestrator();
    o.scan([sandbox]);
    sandbox.querySelector("#c-alice .b p:nth-child(2)").insertAdjacentHTML("beforeend", ` <em>ADDED ${sent(9)}</em>`);
    o.scan([sandbox.querySelector("#c-alice .b p:nth-child(2)")]);
    after = o.census(sandbox);
    check("re-scan from INSIDE a recognised post starts at the post: a paragraph that grew is re-read with its neighbours (×3), bob's comment not touched",
      JSON.stringify(after.units) === "[[3,90]]" && after.twice === 0 && after.text.includes("ADDED") && o.retired.length === 1 && !after.text.includes("B "), JSON.stringify([after.units, after.twice, o.retired]));
    {
      // …and the same question asked of the scopes directly: from any element inside, the same post.
      const scopes = PW.createScopes();
      const alice = sandbox.querySelector("#c-alice");
      const insideOut = [...alice.querySelectorAll("*")].reverse();
      check("…every element inside the comment, asked deepest first, belongs to that comment — and to no other", insideOut.every((el) => scopes.of(el) === alice) && scopes.recognised(alice) && scopes.of(sandbox.querySelector("#c-bob p")) === sandbox.querySelector("#c-bob"));
    }

    // 10) Inside a LONG recognised answer the walk stays where it was asked to start, exactly
    //     as inside a long <article>: nothing is re-read, nothing is taken for a small post.
    sandbox.innerHTML = `<div class="thread">${comment("alice", `S1 ${sent(79)}`, `S2 ${sent(19)}`, `S3 ${sent(89)}`, ...Array.from({ length: 8 }, (_, i) => `BODY${i} ${sent(119)}`))}${comment("bob", `B ${sent(29)}`)}</div>`;
    o = orchestrator();
    o.scan([sandbox]);
    const answerBefore = o.census(sandbox).units;
    sandbox.querySelector("#c-alice .b").insertAdjacentHTML("beforeend", `<p>S4 ${sent(39)}</p><p>S5 ${sent(39)}</p>`);
    o.scan([sandbox.querySelector("#c-alice .b")]);
    after = o.census(sandbox);
    check("re-scan inside a long recognised answer: every unit untouched, the two new short paragraphs a group of their own",
      answerBefore.length === 10 && o.retired.length === 0 && JSON.stringify(after.units.slice(0, 10)) === JSON.stringify(answerBefore) && JSON.stringify(after.units[10]) === "[2,80]" && after.twice === 0, JSON.stringify([answerBefore, after.units, o.retired]));
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
  {
    // A caseless script with a cased brand name in it: one "OpenAI" used to defeat the
    // all-caseless fallback, and the sentence was "punctuated but not prose".
    const zh = PW.wordShape("我觉得OpenAI的新模型确实很厉害。"), ar = PW.wordShape("أعتقد أن نموذج OpenAI الجديد مثير للإعجاب حقا."), name = PW.wordShape("Alice Moreau 博士"), brand = PW.wordShape("OpenAI");
    check("wordShape: mostly caseless words are running text whatever brand they name; a cased name with one CJK word is not",
      zh.running && ar.running && !name.running && !brand.running, JSON.stringify([zh, ar, name, brand]));
    u = collect(Array.from({ length: 12 }, (_, i) => `<p>第${i}段，我觉得OpenAI的新模型确实很厉害。</p>`).join(""));
    check("short Chinese paragraphs that each name OpenAI are read together (every one of them used to be skipped)",
      u.length === 1 && u[0].parts === 12, JSON.stringify(u.map(x => [x.parts, x.words])));
  }

  // ---- boilerplate token expansion (trafilatura-derived) ------------------------------
  u = collect(`<div class="social-share">${words(80)}</div>`);
  check("social-share widget skipped", u.length === 0);
  u = collect(`<div class="related-articles">${words(80)}</div>`);
  check("related-articles widget skipped", u.length === 0);
  u = collect(`<section class="related-work">${words(80)}</section>`);
  check("compound guard: 'related-work' prose section KEPT", u.length === 1);
  u = collect(`<div class="OUTBRAIN">${words(80)}</div>`);
  check("outbrain widget skipped", u.length === 0);
  u = collect(`<div role="complementary">${words(80)}</div>`);
  check("role=complementary skipped", u.length === 0);
  u = collect(`<div class="byline">${words(80)}</div>`);
  check("byline row skipped", u.length === 0);
  u = collect(`<div class="registration-info">${words(80)}</div>`);
  check("compound guard: 'registration-info' prose KEPT", u.length === 1);
  u = collect(`<div class="login-form">${words(80)}</div>`);
  check("login-form chrome skipped", u.length === 0);
  u = collect(`<div class="sharedwith">${words(80)}</div>`);
  check("token boundary: 'sharedwith' (no delimiter) KEPT", u.length === 1);
  {
    // The reply FORM is chrome; the comments are not. 博客园 wraps its comment LIST in boxes
    // carrying the same token, and a Greenhouse job application sets consent text among its
    // fields.
    u = collect(`<div class="comment-form"><p class="comment-notes">${words(80)}</p><textarea></textarea></div>`);
    check("a reply form is still chrome", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<div id="comment_form_container">${Array.from({ length: 3 }, (_, i) => `<div class="feedbackItem">${words(80)}</div>`).join("")}</div>`);
    check("a comment LIST carrying the same token is read (博客园)", u.length === 3, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<div class="comment_form_wrap">${Array.from({ length: 3 }, () => `<div class="feedbackItem">${words(80)}</div>`).join("")}<div class="comment_form"><p>${words(80)}</p><textarea></textarea></div></div>`);
    check("…even where the reply form stands inside the same box, which is chrome by itself", u.length === 3, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<div class="comment_form_list"><p>${words(80)}</p></div>`);
    check("a box carrying the token with nothing to type in is not a form", u.length === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<article><p>${words(80)}</p></article><form><p>CONSENT ${words(80)}</p><input type="email"><button type="submit">Apply</button></form>`);
    check("a <form> with fields to fill in is chrome, legal paragraph and all", u.length === 1 && !u[0].text.includes("CONSENT"), JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<main><form><input type="search"></form><p>${words(80)}</p></main>`);
    check("…while the prose around a search box inside <main> is untouched", u.length === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<form id="form1"><input type="text"><main><p>${words(80)}</p></main></form>`);
    check("…and a page wrapped in one <form> (ASP.NET WebForms) is not a sign-up box", u.length === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
  }
  {
    // A consent platform that names its banner after itself (lib/dom/consentBanners.ts) is
    // found once per walk; a re-scan that starts INSIDE the banner asks the element itself.
    sandbox.innerHTML = `<p>${words(80)}</p><div id="didomi-host"><div class="didomi-notice-text"><p>${words(80)}</p></div></div><div class="osano-cm-window"><span>${words(80)}</span></div>`;
    const whole = PW.collectUnits(sandbox);
    const inside = PW.collectUnits(sandbox.querySelector(".didomi-notice-text"));
    check("consent banners named after their platform are skipped, whole walk and re-scan alike",
      whole.length === 1 && inside.length === 0 && PW.isConsentBanner(sandbox.querySelector(".osano-cm-window")) && !PW.isConsentBanner(sandbox.querySelector("p")),
      JSON.stringify([whole.length, inside.length]));
  }
  {
    // A consent platform's banner in a frame of its own is known by the frame's address
    // (the frame itself is exercised in test/scenarios.mjs).
    const frame = (href) => PW.isConsentFrame(new URL(href));
    const yes = [
      "https://cdn.privacy-mgmt.com/index.html?message_id=1000&consentUUID=x",
      "https://sourcepoint.example-news.co.uk/index.html?message_id=1000",
      "https://example-news.com/privacy-manager/index.html?consentUUID=x",
      "https://ccpa-notice.sp-prod.net/?message_id=1",
      "https://cmp-consent-tool.privacymanager.io/latest/index.html",
      "https://consent-pref.trustarc.com/?type=x&site=example.com",
      "https://cdn.appconsent.io/tcf2-clear/current/index.html",
    ];
    const no = [
      "https://example-news.com/index.html",
      "https://example-news.com/2026/09/article.html?message_id=1",
      "https://www.trustarc.com/blog/",
      "https://www.youtube.com/embed/abc",
    ];
    check("a frame is a consent platform's by its host, or by Sourcepoint's path and message id",
      yes.every(frame) && !no.some(frame), JSON.stringify([yes.filter((h) => !frame(h)), no.filter(frame)]));
    sandbox.innerHTML = `<div id="piano-cookie_banner"><p>${words(80)}</p></div>`;
    check("…or, where the platform gives it no address of its own, by what it draws (Piano)",
      PW.isConsentFrame(new URL("https://example-news.com/frame"), document), "");
    sandbox.innerHTML = "";
  }
  {
    // Text laid out on one line that a box cuts off with an ellipsis is a preview of a text
    // shown in full elsewhere (Discord's reply context, an inbox snippet); a line that merely
    // does not wrap, in a box the reader can scroll, is still read.
    u = collect(`<div style="width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><div>${words(80)}</div></div>`);
    check("a text cut to one line with an ellipsis is a preview, never read", u.length === 0, JSON.stringify(u.map(x => x.words)));
    u = collect(`<div style="width:300px;overflow-x:auto;white-space:nowrap">${words(80)}</div>`);
    check("…while a line that does not wrap in a box the reader can scroll is read", u.length === 1, JSON.stringify(u.map(x => x.words)));
  }
  {
    // A text the SITE cut to a preview — an ellipsis and the control that brings the rest —
    // is not read as the whole text; once the site writes the rest in, it is read whole.
    const cut = (tail) => `<div role="article"><div dir="auto">${words(40)}</div><div dir="auto" id="last">${words(45).slice(0, -1)}${tail}</div></div>`;
    u = collect(cut(`…<div role="button" tabindex="0" style="display:inline">See more</div>`));
    check("a post cut after '…' with an inline 'See more' (Facebook) is not read", u.length === 0, JSON.stringify(u.map(x => x.words)));
    const whole = collect(cut(` and then the rest of it, which the site wrote in when the reader asked for it.`));
    check("…and the same post opened is read whole, the control gone", whole.length === 1 && whole[0].parts === 2 && !whole[0].text.includes("See more"), JSON.stringify(whole.map(x => [x.parts, x.words])));
    u = collect(`<p>${words(80).slice(0, -1)} ...<a href="#status">全文</a></p><p>OTHER ${words(80)}</p>`);
    check("a paragraph cut after ' ...' with a link '全文' (Weibo) is not read, the next one is", u.length === 1 && u[0].text.startsWith("OTHER"), JSON.stringify(u.map(x => x.text.slice(0, 12))));
    u = collect(`<article><div><p>${words(80).slice(0, -1)}</p></div><button type="button">…see more</button></article>`);
    check("a text followed by a '…see more' button in a block of its own, with nothing clamping it, is not read", u.length === 0, JSON.stringify(u.map(x => x.words)));
    u = collect(`<article><div style="overflow:hidden;max-height:40px"><p>${words(80)}</p></div><button type="button">…see more</button></article>`);
    check("…while the same button under a clamped box, the whole text in the page, is read", u.length === 1, JSON.stringify(u.map(x => x.words)));
    u = collect(`<article><div style="overflow:hidden;max-height:40px"><span>${words(80).slice(0, -1)}...</span></div><div role="button" tabindex="0">Read more</div></article>`);
    check("…and so is a clamped comment that ends in an ellipsis of its own (YouTube's 'Read more')", u.length === 1, JSON.stringify(u.map(x => x.words)));
    u = collect(`<p>${words(80).slice(0, -1)}…</p><p><a href="#next">Read more</a></p>`);
    check("an excerpt cut after '…' with 'Read more' under it is not read", u.length === 0, JSON.stringify(u.map(x => x.words)));
    u = collect(`<p>${words(80)}</p><p><a href="#next">Read more</a></p>`);
    check("a complete teaser followed by 'Read more' is read", u.length === 1, JSON.stringify(u.map(x => x.words)));
  }
  {
    // A post's own wrapper carries the terms it is filed under (WordPress post_class):
    // `category-newsletter`, `tag-cookies`. Those are what the post is about, not what the box is.
    const post = (cls) => { const e = document.createElement("div"); e.className = cls; return e; };
    check("a post's category and tag classes (WordPress post_class) never make it chrome, its other names still do",
      PW.isBoilerplate(post("post-41 post type-post status-publish format-standard hentry category-newsletter tag-cookies tag-share")) === false &&
      PW.isBoilerplate(post("type-sponsored status-publish format-aside")) === false &&
      PW.isBoilerplate(post("hentry tag-recipes newsletter-box")) === true);
    sandbox.innerHTML = `<div class="post-52 post hentry series-newsletter"><p>${words(90)}</p><p>${words(90)}</p></div><p>${words(40)}</p>`;
    const most = PW.collectUnits(sandbox);
    sandbox.innerHTML = `<p>${words(90)}</p><p>${words(90)}</p><div class="newsletter-signup"><p>${words(80)}</p></div>`;
    const box = PW.collectUnits(sandbox);
    check("a box holding most of the page's text is the page, whatever it is called; a smaller one keeps its name (Unclutter's guard)",
      most.length === 2 && box.length === 2 && box.every((x) => x.wordCount === 90), JSON.stringify([most.map((x) => x.wordCount), box.map((x) => x.wordCount)]));
  }
  {
    // Read Frog's "translation only" mode writes the translation into the paragraph's own
    // text nodes and marks the paragraph (lib/dom/translation.ts).
    sandbox.innerHTML = `<p lang="en" dir="ltr" data-read-frog-translation-only="">MACHINE ${words(80)}</p><p>${words(80)}</p>`;
    const u = PW.collectUnits(sandbox);
    check("a paragraph a translator extension rewrote in place is not read; the one beside it is", u.length === 1 && !u[0].text.includes("MACHINE"), JSON.stringify(u.map((x) => x.text.slice(0, 20))));
  }
  {
    // MediaWiki's furniture is its own only inside a wiki's content box: a list classed
    // `references` on another site is judged like any other list.
    const list = `<ol class="references">${Array.from({ length: 4 }, () => `<li>${words(25)}</li>`).join("")}</ol>`;
    sandbox.innerHTML = `<div class="mw-parser-output">${list}</div>`;
    const inWiki = PW.collectUnits(sandbox);
    sandbox.innerHTML = `<div class="page">${list}</div>`;
    const elsewhere = PW.collectUnits(sandbox);
    check("a wiki's reference list is never read, a list of the same name elsewhere still is", inWiki.length === 0 && elsewhere.length === 1, JSON.stringify([inWiki.length, elsewhere.length]));
  }
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
  {
    // Gemini wraps every conversation in <div id="xap-skip-link-target" class="main-content">.
    // The id names where the skip link LANDS; read as the link itself it made the whole app
    // chrome, and a 4,000-word answer got no chip at all.
    const mk = (tag, id, cls) => { const e = document.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; return e; };
    check("a skip link's DESTINATION is not the skip link (Gemini)", PW.isBoilerplate(mk("div", "xap-skip-link-target", "main-content")) === false);
    check("…nor without the main-content class beside it", PW.isBoilerplate(mk("div", "skip-link-target", "wrapper")) === false && PW.isBoilerplate(mk("div", "", "skip-to-content-target")) === false);
    check("…while the skip link itself is still chrome", PW.isBoilerplate(mk("a", "", "skip-link")) === true && PW.isBoilerplate(mk("div", "", "skip-to-content")) === true);
    check("…and another chrome name beside a skip destination still counts", PW.isBoilerplate(mk("div", "skip-link-target", "cookie-banner")) === true);
    check("an element that calls itself the main content is never chrome by a token", PW.isBoilerplate(mk("div", "", "main-content share")) === false && PW.isBoilerplate(mk("div", "main_content", "social")) === false);
    check("…but a longer name that merely starts that way is judged as usual", PW.isBoilerplate(mk("div", "", "main-content-share")) === true && PW.isBoilerplate(mk("div", "", "main-content-newsletter")) === true);
    sandbox.innerHTML = `<chat-app><main class="chat-app"><side-navigation-v2 class="content"><bard-sidenav-container><bard-sidenav-content><div class="content-wrapper"><div id="xap-skip-link-target" class="main-content"><div class="conversation-container message-actions-hover-boundary"><model-response><message-content><div class="markdown markdown-main-panel" aria-live="polite"><p>${words(400)}</p></div></message-content></model-response></div></div></div></bard-sidenav-content></bard-sidenav-container></side-navigation-v2></main></chat-app>`;
    const u = PW.collectUnits(sandbox);
    check("Gemini's conversation markup: the answer is read", u.length === 1 && u[0].wordCount >= 400, JSON.stringify(u.map((x) => x.wordCount)));
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
    // Defuddle-guided: distinct paragraphs (so the sampled sentences are unique on
    // the page), chrome around them, and a teaser that echoes an opening sentence.
    const wordsFrom = (off, n) => Array.from({ length: n }, (_, i) => VOCAB[(off + i * 5) % VOCAB.length]).join(" ") + ".";
    const paras = [0, 7, 13, 19, 3].map((o) => `<p>${wordsFrom(o, 70)}</p>`).join("");
    sandbox.innerHTML =
      `<header><nav><a href="#">Home</a> <a href="#">About</a></nav></header>` +
      `<div class="teaser">${wordsFrom(0, 12)}</div>` +
      `<div><div><div id="art">${paras}</div></div></div>` +
      `<footer>${words(12)}</footer>`;
    const mc = PW.findMainContent(document);
    check("findMainContent (Defuddle) maps the article to its live container", mc && mc.id === "art", mc && (mc.id || mc.tagName));
    PW.useDefuddle(null);
    const mc2 = PW.findMainContent(document);
    check("findMainContent falls back to text mass without Defuddle", mc2 && (mc2.id === "art" || mc2.contains(document.getElementById("art"))), mc2 && (mc2.id || mc2.tagName));
  }

  // ---- math, markers, hidden copies: never split the sentence ------------------------------
  {
    sandbox.innerHTML = `<p>${words(40)} <math><mi>x</mi><mo>=</mo><mn>1</mn></math> ${words(40)}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    check("inline <math> (display:math) does not split the paragraph; formula counted, text excluded",
      unit && unit.parts.length === 1 && unit.formulas === 1 && !unit.text.includes("x=1") && unit.wordCount === 80,
      JSON.stringify(unit && [unit.parts.length, unit.formulas, unit.wordCount]));
  }
  {
    // Wikipedia: visible <img> fallback + a display:block, absolutely positioned, clipped MathML copy.
    sandbox.innerHTML = `<p>${words(40)} <span class="mwe-math-element"><span style="display:block;position:absolute;clip:rect(1px,1px,1px,1px);width:1px;height:1px;overflow:hidden"><math><mi>y</mi></math></span><img alt="y"></span> ${words(40)}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    check("Wikipedia math (hidden block MathML + img) does not split the paragraph", unit && unit.parts.length === 1 && unit.formulas === 1 && unit.wordCount === 80, JSON.stringify(unit && [unit.parts.length, unit.formulas]));
  }
  {
    // MathJax v3: inline-block container whose only block child is the hidden assistive copy.
    sandbox.innerHTML = `<p>${words(40)} <mjx-container style="display:inline-block"><mjx-math style="display:inline-block">GLYPHLEAK</mjx-math><mjx-assistive-mml style="display:block;position:absolute;clip:rect(1px,1px,1px,1px);width:1px;height:1px;overflow:hidden"><math><mi>z</mi></math></mjx-assistive-mml></mjx-container> ${words(40)}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    check("MathJax container does not split; its glyph text never leaks", unit && unit.parts.length === 1 && unit.formulas === 1 && !unit.text.includes("GLYPHLEAK"), JSON.stringify(unit && [unit.parts.length, unit.text.slice(-30)]));
  }
  {
    sandbox.innerHTML = `<p>${words(40)}</p><table class="ltx_equation"><tr><td><math display="block"><mi>E</mi></math></td><td>(1)</td></tr></table><p>${words(40)}</p>`;
    u = collect(sandbox.innerHTML);
    check("display equation between two short paragraphs is not a merge barrier", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));
  }
  {
    sandbox.innerHTML = `<p>${words(40)}</p><div>(3)</div><p>${words(40)}</p>`;
    u = collect(sandbox.innerHTML);
    check("a bare equation number '(3)' is transparent, not a barrier", u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));
    u = collect(`<p>${words(40)}</p><div>* * *</div><p>${words(40)}</p>`);
    check("'* * *' separator is still a barrier", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
  }
  u = collect(`<p>${words(80)}<sup class="reference"><a href="#c">[7]</a></sup> and<sup class="ltx_note_mark">1</sup> more<sup><a href="#f2">2</a></sup>.</p>`);
  check("citation / footnote marks never enter the text", u.length === 1 && !/\[7\]|\b1\b|\b2\b/.test(u[0].text.slice(-40)), JSON.stringify(u.map(x => x.text.slice(-40))));
  u = collect(`<p>${words(78)} area of 5 km<sup>2</sup>.</p>`);
  check("an unlinked exponent <sup>2</sup> is kept (km2)", u.length === 1 && /km2\.$/.test(u[0].text), JSON.stringify(u.map(x => x.text.slice(-12))));
  u = collect(`<p>${words(78)} shown in <cite class="ltx_cite">[<a href="#b">12</a>]</cite> below.</p>`);
  check("bracketed <cite> reference is skipped", u.length === 1 && !u[0].text.includes("[12]") && u[0].text.endsWith("shown in below."), JSON.stringify(u.map(x => x.text.slice(-24))));

  // ---- markers, accordions, name lists, page-level hints ------------------------------
  u = collect(`<p>${words(40)}<span style="position:absolute;right:0">[Pg 12]</span> ${words(40)}</p>`);
  check("absolutely positioned page-number span does not split the paragraph", u.length === 1 && u[0].parts === 1 && !u[0].text.includes("[Pg"), JSON.stringify(u.map(x => [x.parts, x.words])));
  u = collect(`<p>${words(40)}<div style="position:absolute;left:0">${words(20)}</div> ${words(40)}</p>`);
  check("a large out-of-flow box still behaves as its own block", u.length >= 1 && u.every(x => !x.text.includes(words(20).slice(0, 20)) || x.words >= 20), JSON.stringify(u.map(x => [x.parts, x.words])));
  {
    // A shadow host reports none of its shadow tree in textContent, so a fixed host with a
    // whole document inside read as an empty decoration (Google Docs' reading overlay).
    sandbox.innerHTML = `<div id="ovl" style="position:fixed;inset:0"></div>`;
    sandbox.querySelector("#ovl").attachShadow({ mode: "open" }).innerHTML = `<p>${words(80)}</p><p>${words(85)}</p>`;
    const inside = PW.collectUnits(sandbox).map((x) => ({ parts: x.parts.length, words: x.wordCount }));
    check("a fixed-position shadow host holding a document is walked", inside.length === 2 && inside[0].words === 80, JSON.stringify(inside));
    sandbox.innerHTML = `<div style="position:fixed;inset:0"><div id="deep"></div></div>`;
    sandbox.querySelector("#deep").attachShadow({ mode: "open" }).innerHTML = `<p>${words(80)}</p>`;
    const nested = PW.collectUnits(sandbox).map((x) => ({ parts: x.parts.length, words: x.wordCount }));
    check("a fixed box whose text hangs in a shadow tree below it is walked", nested.length === 1 && nested[0].words === 80, JSON.stringify(nested));
    sandbox.innerHTML = `<p>${words(40)}<span style="position:fixed;right:0">Page 12</span> ${words(40)}</p>`;
    const label = PW.collectUnits(sandbox).map((x) => ({ parts: x.parts.length, text: x.text }));
    check("a small out-of-flow label is still skipped", label.length === 1 && label[0].parts === 1 && !label[0].text.includes("Page 12"), JSON.stringify(label.map(x => x.parts)));
    sandbox.innerHTML = `<p>${words(40)}<span id="badge" style="position:fixed;right:0"></span> ${words(40)}</p>`;
    sandbox.querySelector("#badge").attachShadow({ mode: "open" }).innerHTML = `<b>Page 12</b>`;
    const small = PW.collectUnits(sandbox).map((x) => ({ parts: x.parts.length, text: x.text }));
    check("a small out-of-flow shadow host with a label inside is still skipped", small.length === 1 && small[0].parts === 1 && !small[0].text.includes("Page 12"), JSON.stringify(small.map(x => [x.parts, x.text.slice(-20)])));
  }
  u = collect(`<div role="tablist"><div role="tab">Section 1</div><div role="tabpanel"><p>${words(80)}</p></div></div>`);
  check("role=tablist accordion content is scored; the tab label is chrome", u.length === 1 && !u[0].text.includes("Section 1"), JSON.stringify(u.map(x => [x.parts, x.words])));
  {
    const b = document.createElement("body"); b.className = "notranslate";
    const s = document.createElement("span"); s.className = "notranslate";
    check("notranslate is ignored at page level, honoured on spans", PW.isBoilerplate(b) === false && (() => { sandbox.innerHTML = `<p>${words(78)} <span class="notranslate">BRANDLEAK</span> end.</p>`; const [x] = PW.collectUnits(sandbox); return x && !x.text.includes("BRANDLEAK"); })());
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

    let host = chipFor(`<p>${words(80)} <img alt="emoji"></p>`);
    check("chip goes AFTER a trailing emoji image (end of the line, not mid-sentence)",
      host && host.previousElementSibling?.tagName === "IMG" && host.parentElement.lastElementChild === host, desc(host));

    host = chipFor(`<p><span>${words(80)} <img alt="emoji"></span></p>`);
    check("…also when the text and the emoji sit inside an inline wrapper",
      host && host.parentElement.tagName === "P" && host.parentElement.lastElementChild === host, desc(host));

    host = chipFor(`<p>${words(80)}<sup class="reference"><a href="#c">[7]</a></sup></p>`);
    check("chip goes after a trailing citation mark", host && host.previousElementSibling?.tagName === "SUP", desc(host));

    host = chipFor(`<p>${words(80)} and it ends with <a href="#x">a real link</a>.</p>`);
    check("a trailing link with words is NOT jumped; the chip stays outside the anchor",
      host && !host.closest("a") && host.parentElement.tagName === "P", desc(host));

    host = chipFor(`<p>${words(80)}<br></p>`);
    check("a trailing <br> is never jumped (the chip must not fall to the next line)",
      host && host.nextElementSibling?.tagName === "BR", desc(host));

    layer.teardownAll();
  }

  // ---- long texts: pass planning ----------------------------------------------------------
  // `prose(n)` — n distinct sentences of ~85 characters, each opening with a capital and
  // ending in a full stop, so a cut at a sentence boundary is recognisable from the text.
  // PW.planWindows plans with the fixtures' pretend tokenizer in the engine's place (the
  // engine's own counts are checked in test/node/windows.test.ts); what matters here is the
  // shape of the plan on real text.
  const W = PW.WINDOW_CHARS;
  const sentenceNo = (i) => `Sentence number ${i} keeps walking through the quiet town while the rain falls on it.`;
  const prose = (n, from = 0) => Array.from({ length: n }, (_, i) => sentenceNo(from + i)).join(" ");
  const lens = (spans) => spans.map((s) => s.end - s.start);
  const tokensOf = (text, s) => PW.spanTokens(text, s);
  // Passes over two neighbouring halves each, reading [0, end): each starts inside the one
  // before it and reaches past it, and each ends where the one after next starts.
  const byHalves = (text, spans, end = text.length) =>
    spans.length > 1 && spans[0].start === 0 && spans[spans.length - 1].end === end &&
    spans.every((s, i) => i === 0 || (s.start > spans[i - 1].start && s.start < spans[i - 1].end && s.end > spans[i - 1].end)) &&
    spans.every((s, i) => i + 2 >= spans.length || s.end === spans[i + 2].start);
  // As many passes as the halves the text divides into, none over the model's window.
  const planned = (text, spans, end = text.length) => {
    const halves = Math.ceil((2 * tokensOf(text, { start: 0, end })) / (PW.PASS_TOKENS - 2 * PW.SNAP_TOKENS));
    return spans.length === halves - 1 && spans.every((s) => tokensOf(text, s) <= PW.PASS_TOKENS);
  };
  {
    const short = prose(10);
    const one = PW.planWindows(short);
    check("a text that fits is ONE pass over all of it, sent as its model form",
      one.length === 1 && one[0].start === 0 && one[0].end === short.length && PW.blockText(short, one[0]) === PW.modelText(short), JSON.stringify(one));

    check("a text too short to overflow is not even counted; a longer one the model holds is still one pass; past that, several",
      PW.fitsWithoutCounting(prose(6)) && !PW.fitsWithoutCounting(prose(7)) && !PW.fitsWithoutCounting("😀 " + prose(1)) &&
      PW.planWindows(prose(20)).length === 1 && PW.planWindows(prose(40)).length > 1, JSON.stringify(lens(PW.planWindows(prose(40)))));

    const long = prose(60);
    const spans = PW.planWindows(long);
    const texts = spans.map((s) => long.slice(s.start, s.end));
    check("a long text is read in passes over two neighbouring halves each, as many as its halves, none over the window",
      spans.length > 2 && byHalves(long, spans) && planned(long, spans), JSON.stringify(spans));
    check("every pass edge falls on a sentence boundary: passes open on a capital and close on a full stop",
      texts.every((t) => /^Sentence number \d+ /.test(t) && /\.$/.test(t.trim())), JSON.stringify(texts.map((t) => [t.slice(0, 20), t.slice(-12)])));

    const zh = Array.from({ length: 140 }, (_, i) => `第${i}句话讲的是一座安静的小城和落在屋顶上的雨，孩子们在窗边读书。`).join("");
    const zhSpans = PW.planWindows(zh);
    check("CJK sentence ends (。 with no space after it) are pass edges too",
      byHalves(zh, zhSpans) && zhSpans.every((s) => zh[s.end - 1] === "。" && zh[s.start] === "第"), JSON.stringify(lens(zhSpans)));

    const unpunctuated = Array.from({ length: 900 }, (_, i) => VOCAB[i % VOCAB.length]).join(" ");
    const upSpans = PW.planWindows(unpunctuated);
    check("one enormous sentence without a full stop is cut between two words",
      byHalves(unpunctuated, upSpans) && planned(unpunctuated, upSpans) && upSpans.every((s) => s.start === 0 || (unpunctuated[s.start - 1] === " " && unpunctuated[s.start] !== " ")),
      JSON.stringify(lens(upSpans)));

    const solid = "😀".repeat(3000); // 6000 UTF-16 units, no space, no sentence
    const chunks = PW.chunksOf(solid);
    const solidSpans = PW.planWindows(solid);
    check("…and a text with no space at all is cut hard, never inside a surrogate pair",
      chunks.every((c) => c.start % 2 === 0 && c.end - c.start <= PW.MAX_CHUNK_CHARS) && byHalves(solid, solidSpans) && solidSpans.every((s) => s.start % 2 === 0 && s.end % 2 === 0), JSON.stringify(solidSpans));

    // Merged unit: twenty unpunctuated bullet items joined the way the walker joins parts.
    const items = Array.from({ length: 20 }, (_, i) => `ITEM${i} ` + Array.from({ length: 24 }, (_, j) => VOCAB[(i + j) % VOCAB.length]).join(" "));
    const merged = items.join("\n\n");
    const mSpans = PW.planWindows(merged);
    check("a merged multi-part unit is read in passes that open and close at joints between two parts",
      byHalves(merged, mSpans) && mSpans.every((s) => (s.start === 0 || (merged.slice(s.start - 2, s.start) === "\n\n" && merged.startsWith("ITEM", s.start))) && (s.end === merged.length || merged.slice(s.end - 2, s.end) === "\n\n")), JSON.stringify(mSpans));

    // Longer than anything a page hands over: only a selection can reach the bound now.
    const dump = (prose(250) + " ").repeat(Math.ceil((PW.MAX_READ_CHARS + 6000) / prose(250).length) + 1).slice(0, PW.MAX_READ_CHARS + 5000);
    const dSpans = PW.planWindows(dump);
    const readEnd = PW.readEnd(dump);
    check("past the bound a selection can reach, the rest is left unread and the reading stops at a sentence end",
      dSpans.length <= PW.MAX_WINDOWS && byHalves(dump, dSpans, readEnd) && readEnd <= PW.MAX_READ_CHARS && readEnd > PW.MAX_READ_CHARS - W && dump.slice(0, readEnd).trim().endsWith("."), JSON.stringify([readEnd, dSpans.length]));

    const [h1, h2] = PW.halve(long, spans[1]);
    check("a pass the engine had to cut is halved at a sentence boundary near its middle",
      h1.start === spans[1].start && h1.end === h2.start && h2.end === spans[1].end && /^Sentence number/.test(long.slice(h2.start)) && Math.abs((h1.end - h1.start) - (h2.end - h2.start)) <= 90, JSON.stringify([h1, h2]));

    check("sentenceStarts: inside the text only, each on the first letter of a sentence",
      (() => { const st = PW.sentenceStarts("One. Two!\n\nThree? Four"); return JSON.stringify(st) === JSON.stringify([5, 11, 18]); })(), JSON.stringify(PW.sentenceStarts("One. Two!\n\nThree? Four")));
    // Chromium's own segmenter, not Node's: test/node/sentences.test.ts has the full table.
    check("sentenceStarts: none after \"Mr.\", \"Dr.\" or \"the U.S.\" in Chromium",
      JSON.stringify(PW.sentenceStarts("Mr. Smith met Dr. Jones. The U.S. Army came.")) === JSON.stringify([25]), JSON.stringify(PW.sentenceStarts("Mr. Smith met Dr. Jones. The U.S. Army came.")));
  }

  // ---- long texts: from a pass back to the page ---------------------------------------------
  const collapse = (t) => t.replace(/\s+/g, " ").trim();
  const located = (unit, spans) => PW.locateSpans(unit.parts, unit.text, spans);
  // The stretches between every two pass edges: consecutive, non-overlapping — what the
  // marks are drawn over (unitVerdict's stretches, before neighbours of one step merge).
  const stretchesOf = (spans) => {
    const edges = [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((x, y) => x - y);
    return edges.slice(1).map((end, i) => ({ start: edges[i], end }));
  };
  {
    // Inline markup everywhere, so pass edges fall inside and between elements.
    sandbox.innerHTML = `<p>${Array.from({ length: 60 }, (_, i) => i % 3 === 0 ? `<em>Sentence number ${i}</em> keeps <a href="#x">walking through</a> the quiet town while the rain falls on it.` : i % 3 === 1 ? `Sentence number ${i} keeps walking <b>through the quiet town while the rain</b> falls on it.` : `<span>Sentence <code>number</code> ${i} keeps walking through the quiet town while the rain falls on it.</span>`).join(" ")}</p>`;
    const htmlBefore = sandbox.innerHTML;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const ranges = located(unit, spans);
    check("inline markup: every pass resolves to one range whose text is the pass's text",
      unit.parts.length === 1 && spans.length >= 3 && ranges && ranges.every((r, i) => r.length === 1 && collapse(r[0].toString()) === unit.text.slice(spans[i].start, spans[i].end).trim()),
      JSON.stringify(ranges && ranges.map((r) => r.map((x) => collapse(x.toString()).slice(0, 24)))));
    const stretched = located(unit, stretchesOf(spans));
    check("…ranges start and end INSIDE text nodes, and the stretches between pass edges leave no gap",
      ranges && stretched && stretched.length > spans.length && [...ranges, ...stretched].every((r) => r[0].startContainer.nodeType === 3 && r[0].endContainer.nodeType === 3) &&
      stretched.slice(1).every((r, i) => r.length === 1 && r[0].startContainer === stretched[i][0].endContainer && r[0].startOffset === stretched[i][0].endOffset));
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
    // Three list items of forty 30-letter words, unevenly split by a full stop: a pass
    // reaches over several items, and an edge may fall INSIDE an item, which then gets two ranges.
    const longWords = (n, from) => Array.from({ length: n }, (_, j) => VOCAB[(from + j) % VOCAB.length] + "abcdefghijklmnopqrstuvwxy").join(" ");
    sandbox.innerHTML = `<ul>${Array.from({ length: 3 }, (_, i) => `<li>ITEM${i} <i>${longWords(13, i)}.</i> Then ${longWords(27, i + 11)}.</li>`).join("")}</ul>`;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const ranges = located(unit, spans);
    const perPass = ranges && ranges.map((r) => r.map((x) => collapse(x.toString())).join("\n\n"));
    check("merged parts: a pass reaching over several parts is one range PER PART, none across two",
      unit.parts.length === 3 && spans.length >= 2 && ranges && ranges.every((r) => r.length > 1) &&
      perPass.every((t, i) => t === unit.text.slice(spans[i].start, spans[i].end).trim()) &&
      ranges.flat().every((x) => x.startContainer.parentElement.closest("li") === x.endContainer.parentElement.closest("li")),
      JSON.stringify(ranges && ranges.map((r) => r.length)));
    const stretches = stretchesOf(spans);
    const stretched = located(unit, stretches);
    check("…and together the stretches' ranges cover every part exactly once", stretched && stretched.flat().length === unit.parts.length + stretches.filter((s, i) => i > 0 && unit.text.slice(s.start - 2, s.start) !== "\n\n").length, JSON.stringify(stretched && stretched.flat().length));
  }
  {
    // Formulas the walker skipped sit between two text nodes of the run — also right where
    // a pass ends. They are in no part.nodes; the text and the mapping run across them.
    sandbox.innerHTML = `<p>${Array.from({ length: 60 }, (_, i) => `Sentence number ${i} keeps <math><mi>QQQ</mi></math> walking through the quiet town while the rain falls on it.`).join(" ")}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    const spans = PW.planWindows(unit.text);
    const ranges = located(unit, spans);
    check("a skipped formula in mid-sentence shifts nothing: passes still resolve to their own words",
      unit.formulas === 60 && !unit.text.includes("QQQ") && ranges && ranges.every((r, i) => r.length === 1 && collapse(r[0].toString().replace(/QQQ/g, " ")) === unit.text.slice(spans[i].start, spans[i].end).trim()),
      JSON.stringify(ranges && ranges.map((r) => r.map((x) => collapse(x.toString()).slice(0, 30)))));

    // The page changes under a verdict that is still in flight.
    unit.parts[0].nodes[4].data = "Sentence REWRITTEN keeps ";
    check("a DOM that no longer says what the unit says resolves to nothing (null), never to wrong words", located(unit, spans) === null);
  }

  // ---- long texts: one verdict from several passes -----------------------------------------
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
    check("…which may be a bucket no single pass chose (human + heavily edited → lightly edited overall)", mid.result.bucket === 1 && near(mid.result.score, 1 / 3), JSON.stringify(mid.result));

    const single = PW.unitVerdict("u3", 900, [{ start: 0, end: 900, result: human }]);
    check("one pass: the unit's verdict IS the fixture's result, number for number", single.result.probs === human.probs && single.result.score === human.score && single.result.id === "u3" && single.windows.length === 1);

    const down = PW.unitVerdict("u4", 4000, [{ start: 0, end: 2000, result: ai }, { start: 2000, end: 4000, result: res([0.25, 0.25, 0.25, 0.25], { degraded: true }) }]);
    check("one degraded pass makes the whole unit Unavailable — never flagged on half an answer", down.result.degraded === true && PW.band(down.result) === "unknown" && !PW.isFlagged(down.result));

    const fr = res([0.25, 0.25, 0.25, 0.25], { unsupported: true, lang: "fr", lang_prob: 0.97, score: 0 });
    const mixed = PW.unitVerdict("u5", 3000, [{ start: 0, end: 1000, result: ai }, { start: 1000, end: 2000, result: fr }, { start: 2000, end: 3000, result: ai }]);
    const allFr = PW.unitVerdict("u6", 2500, [{ start: 0, end: 1000, result: fr }, { start: 1000, end: 2500, result: { ...fr, lang: "de" } }]);
    check("a pass the language gate refused stays out of the mean; all of them refused → Unsupported language",
      !mixed.result.unsupported && near(mixed.result.score, ai.score) && PW.windowReadout(mixed).skipped === 1 && PW.windowReadout(mixed).scores.join("|") === ".93|fr|.93" &&
      allFr.result.unsupported === true && allFr.result.lang === "de", JSON.stringify([mixed.result, allFr.result]));

    const dense = PW.unitVerdict("u7", 5000, [{ start: 0, end: 2000, result: human }, { start: 2000, end: 4000, result: { ...ai, truncated: true } }]);
    check("a pass still cut after the re-read and an unread tail are both carried by the verdict",
      dense.result.truncated === true && dense.unreadChars === 1000 && PW.windowReadout(dense).cutShort === 1 && /Only the opening/.test(PW.coverageNote(dense, "paragraph")) && /too dense/.test(PW.coverageNote(dense, "paragraph")));
    check("a unit read in one pass has no pass readout and no coverage note", PW.windowReadout(single) === null && PW.coverageNote(single, "paragraph") === "");

    // Two passes overlapping by a third: the shared stretch is read by both, each weighed
    // down towards the edge where it cut the text — equally here, half a pass from each.
    const ov = PW.unitVerdict("u8", 3000, [{ start: 0, end: 2000, result: res([1, 0, 0, 0]) }, { start: 1000, end: 3000, result: res([0, 0, 0, 1]) }]);
    check("overlapping passes: the text is judged stretch by stretch between pass edges, and the chip is their mean by length",
      JSON.stringify(ov.stretches.map((st) => [st.start, st.end])) === "[[0,1000],[1000,2000],[2000,3000]]" &&
      near(ov.stretches[1].result.score, 0.5) && [0.5, 0, 0, 0.5].every((p, i) => near(ov.stretches[1].result.probs[i], p)) && near(ov.result.score, 0.5) && PW.windowReadout(ov).count === 2,
      JSON.stringify(ov.stretches));
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
    // From human in the first pass to AI-generated in the last, each pass its own number.
    const ramp = [res([0.9, 0.1, 0, 0]), res([0.4, 0.5, 0.1, 0]), res([0.05, 0.15, 0.6, 0.2]), res([0, 0.1, 0.4, 0.5]), res([0, 0, 0.1, 0.9])];
    const verdict = PW.unitVerdict(unit.id, unit.text.length, spans.map((s, i) => ({ ...s, result: ramp[Math.round((i * (ramp.length - 1)) / (spans.length - 1))] })));
    PW.setHighlight(unit, verdict);
    let marks = bandsOver(sandbox);
    // The name a mark is registered under: its step on the scale, at rest or active.
    const nameFor = (score, active = false) => `anagram-${active ? "a" : "s"}${String(PW.scaleStep(score)).padStart(2, "0")}`;
    // What the marks should be: the stretches, neighbours on one step drawn as one.
    const runs = [];
    for (const st of verdict.stretches) {
      const last = runs[runs.length - 1];
      if (last && last.end === st.start && PW.scaleStep(last.score) === PW.scaleStep(st.result.score)) last.end = st.end;
      else runs.push({ start: st.start, end: st.end, score: st.result.score });
    }
    const drawn = Object.entries(marks).flatMap(([name, texts]) => texts.map((t) => [name, t])).sort((x, y) => unit.text.indexOf(x[1]) - unit.text.indexOf(y[1]));
    check("marks follow the stretches: each run of one step underlined in ITS colour, gap-free, to the last sentence",
      spans.length >= 4 && runs.length >= 4 && new Set(runs.map((r) => PW.scaleStep(r.score))).size >= 4 && drawn.length === runs.length &&
      drawn.every(([name, t], i) => name === nameFor(runs[i].score) && t === collapse(unit.text.slice(runs[i].start, runs[i].end))) &&
      runs[0].start === 0 && runs[runs.length - 1].end === unit.text.length && runs.every((r, i) => i === 0 || r.start === runs[i - 1].end) && drawn[drawn.length - 1][1].endsWith("TAILMARK sentence closes the paragraph."),
      JSON.stringify(drawn.map(([n, t]) => [n, t.slice(0, 20), t.slice(-20)])));
    check("…without touching the page", sandbox.innerHTML === htmlBefore);

    const layer = PW.createBadgeLayer();
    layer.render(unit, verdict);
    const cardText = () => sandbox.querySelector('[data-anagram="host"]').shadowRoot.querySelector(".card").textContent;
    const chips = sandbox.querySelectorAll('[data-anagram="host"]').length;
    const passNumbers = verdict.windows.map((w) => PW.formatScore(w.result.score).replace(".", "\\.")).join("\\s*·\\s*");
    check(`the card says how it was read: 'Read in ${spans.length} passes' with each pass's number; ONE chip with the aggregate`,
      chips === 1 && new RegExp(`Read in ${spans.length} passes\\s*${passNumbers}`).test(cardText()) && /judged by the passes that read it/.test(cardText()) && !/Only the opening/.test(cardText()) && !/first \d+/.test(cardText()) &&
      sandbox.querySelector('[data-anagram="host"]').shadowRoot.querySelector(".num").textContent === PW.formatScore(verdict.result.score) &&
      !/%/.test(sandbox.querySelector('[data-anagram="host"]').shadowRoot.querySelector(".num").textContent), cardText());

    // Only the first two passes read (as under the pass cap): the tail is neither marked nor claimed.
    const partial = PW.unitVerdict(unit.id, unit.text.length, verdict.windows.slice(0, 2));
    PW.setHighlight(unit, partial);
    layer.render(unit, partial);
    marks = bandsOver(sandbox);
    check("text no pass covers gets no mark, and the card says only the opening was scored",
      !Object.values(marks).flat().some((t) => t.includes("TAILMARK")) && partial.unreadChars > 0 && /Only the opening of this paragraph was scored/.test(cardText()) && /Scored\s*first \d+ words/.test(cardText()), cardText());

    // A pass the language gate refused counts for nothing: the marks are those of the same
    // reading without it.
    const fr = res([0.25, 0.25, 0.25, 0.25], { unsupported: true, lang: "fr", score: 0 });
    const gated = PW.unitVerdict(unit.id, unit.text.length, verdict.windows.map((w, i) => (i === 1 ? { ...w, result: fr } : w)));
    PW.setHighlight(unit, gated);
    const gatedMarks = JSON.stringify(bandsOver(sandbox));
    PW.setHighlight(unit, PW.unitVerdict(unit.id, unit.text.length, verdict.windows.filter((_, i) => i !== 1)));
    check("a pass the language gate refused is not marked and changes no mark",
      gatedMarks === JSON.stringify(bandsOver(sandbox)) && gatedMarks !== JSON.stringify(marks) && gated.stretches.every((st) => st.result.probs !== fr.probs), gatedMarks.slice(0, 200));

    // The DOM moves on while the verdict is in flight: whole parts, aggregate band.
    unit.parts[0].nodes[0].data = "Edited " + unit.parts[0].nodes[0].data;
    PW.setHighlight(unit, verdict);
    marks = bandsOver(sandbox);
    const aggregate = nameFor(verdict.result.score);
    check("a stretch that cannot be found falls back to the whole part in the aggregate colour, never to nothing",
      Object.keys(marks).join() === aggregate && marks[aggregate].length === 1 && marks[aggregate][0].startsWith("Edited Sentence number 0") && marks[aggregate][0].endsWith("closes the paragraph."), JSON.stringify(Object.keys(marks)));

    // The common case stays what it was: one whole-part range, no offsets resolved.
    PW.clearHighlight(unit.id);
    sandbox.innerHTML = `<p>${words(80)}</p>`;
    const [small] = PW.collectUnits(sandbox);
    const smallVerdict = PW.unitVerdict(small.id, small.text.length, [{ start: 0, end: small.text.length, result: res([0, 0, 0.1, 0.9]) }]);
    PW.setHighlight(small, smallVerdict);
    layer.render(small, smallVerdict);
    marks = bandsOver(sandbox);
    const smallName = `anagram-s${String(PW.scaleStep(smallVerdict.result.score)).padStart(2, "0")}`;
    check("a one-pass unit is marked and carded exactly as before",
      Object.keys(marks).join() === smallName && marks[smallName].length === 1 && marks[smallName][0] === small.text && !/Scored/.test(cardText()) && !/window/.test(cardText()),
      cardText());
    PW.clearHighlight(small.id);
    layer.teardownAll();
  }

  // ---- one scale ----------------------------------------------------------------------
  // Every read unit is underlined at rest, in the colour of its score, and the whole of ONE
  // unit takes a tint while the reader is on it. There is one rule per step of the scale,
  // at rest or active, and every line is solid: how sure the model is shows on the dot.
  {
    PW.registerHighlightStyles();
    const css = () => document.querySelector('style[data-anagram="style"]').textContent;
    const ruleFor = (name) => (css().match(new RegExp(`::highlight\\(${name}\\)\\s*\\{([^}]*)\\}`)) ?? [, ""])[1];
    const step = (n) => String(n).padStart(2, "0");
    const all = Array.from({ length: PW.SCALE_STEPS + 1 }, (_, n) => step(n));
    const colour = (rule) => (rule.match(/text-decoration-color: ([^;]+)/) ?? [, ""])[1];

    check("every step of the scale is underlined at rest, solid, with no tint on the page's own words",
      all.every((n) => /text-decoration-style: solid/.test(ruleFor(`anagram-s${n}`)) && !/background-color/.test(ruleFor(`anagram-s${n}`))),
      css().slice(0, 400));
    check("the line weighs the same at every score, so a score either side of a word's edge does not jump",
      new Set(all.map((n) => (ruleFor(`anagram-s${n}`).match(/text-decoration-thickness: ([^;]+)/) ?? [, ""])[1])).size === 1,
      css().slice(0, 400));
    check("the colour moves along the scale: every step differs from the one before it",
      all.every((n, i) => i === 0 || colour(ruleFor(`anagram-s${n}`)) !== colour(ruleFor(`anagram-s${all[i - 1]}`))),
      all.map((n) => colour(ruleFor(`anagram-s${n}`))).join(" "));
    check("nothing anywhere is wavy or dashed, and there is one rule per step at rest and one active",
      !/wavy|dashed/.test(css()) && (css().match(/::highlight\(/g) ?? []).length === 2 * all.length, css().slice(0, 400));
    check("the active rules exist for every step, tint and line, so a hover can show the whole of one unit",
      all.every((n) => /background-color/.test(ruleFor(`anagram-a${n}`)) && /underline/.test(ruleFor(`anagram-a${n}`))),
      css().slice(0, 400));

    const marksOf = (el) => {
      const out = [];
      for (const [name, hl] of CSS.highlights) for (const r of hl) if (el.contains(r.startContainer)) out.push(name);
      return out.sort();
    };
    sandbox.innerHTML = `<p>${words(80)}</p>`;
    const [human] = PW.collectUnits(sandbox);
    const humanVerdict = PW.unitVerdict(human.id, human.text.length, [{ start: 0, end: human.text.length, result: res([0.9, 0.1, 0, 0]) }]);
    const humanStep = step(PW.scaleStep(humanVerdict.result.score));
    PW.setHighlight(human, humanVerdict);
    check("a human unit is underlined too, at the quiet end of the scale",
      marksOf(sandbox).join() === `anagram-s${humanStep}` && PW.scaleStep(humanVerdict.result.score) <= 2, JSON.stringify(marksOf(sandbox)));

    PW.setActiveUnit(human.id);
    check("while the unit is active its range moves to the active set, and only that unit's does",
      marksOf(sandbox).join() === `anagram-a${humanStep}`, JSON.stringify(marksOf(sandbox)));
    PW.setActiveUnit(null);
    check("leaving puts it back at rest", marksOf(sandbox).join() === `anagram-s${humanStep}`, JSON.stringify(marksOf(sandbox)));

    PW.setActiveUnit(human.id);
    PW.clearHighlight(human.id);
    check("clearing an ACTIVE unit leaves nothing behind in either set", marksOf(sandbox).length === 0, JSON.stringify(marksOf(sandbox)));
  }

  // ---- how sure: the dot --------------------------------------------------------------
  // No threshold: the chip's dot and the card's swatch are full when the verdict's word is
  // likely right (lib/render/confidence.ts) and a thinner ring, in the same colour, the less
  // likely it is, down to a line that stays visible.
  {
    sandbox.innerHTML = `<p>${words(80)}</p>`;
    const [unit] = PW.collectUnits(sandbox);
    const layer = PW.createBadgeLayer();
    const px = (value) => Number.parseFloat(value);
    const ring = (el) => px((getComputedStyle(el).boxShadow.match(/([\d.]+)px inset/) ?? [, "NaN"])[1]);
    // From a sure human verdict to a split one, each less likely to be right than the last.
    const seen = [[0.98, 0.02, 0, 0], [0.8, 0.18, 0.02, 0], [0.55, 0.4, 0.04, 0.01], [0.35, 0.1, 0.1, 0.45]].map((probs) => {
      const verdict = PW.unitVerdict(unit.id, unit.text.length, [{ start: 0, end: unit.text.length, result: res(probs, { tokens: 302 }) }]);
      layer.render(unit, verdict);
      const root = sandbox.querySelector('[data-anagram="host"]').shadowRoot;
      const dot = root.querySelector(".pill .dot");
      const sw = root.querySelector(".card .sw");
      return {
        doubt: (1 - PW.verdictConfidence(verdict)).toFixed(3),
        tag: root.querySelector(".pill").style.getPropertyValue("--u"),
        swTag: sw.style.getPropertyValue("--u"),
        dot: [ring(dot), px(getComputedStyle(dot).width) / 2],
        sw: [ring(sw), px(getComputedStyle(sw).width) / 2],
        card: root.querySelector(".card").textContent,
      };
    });
    check("the chip and the card carry the verdict's doubt, and no card puts a number or a word on it",
      seen.every((s) => s.tag === s.doubt && s.swTag === s.doubt && !/uncertain|split between|confiden/i.test(s.card)) &&
      seen.every((s, i) => i === 0 || Number(s.doubt) > Number(seen[i - 1].doubt)), JSON.stringify(seen));
    check("a word surely right is a nearly full dot; each likelier-wrong one is a thinner ring; the thinnest is still at least 1px",
      seen.every((s) => s.dot.every(Number.isFinite) && s.sw.every(Number.isFinite)) &&
      seen[0].dot[0] >= seen[0].dot[1] * 0.9 && seen[0].sw[0] >= seen[0].sw[1] * 0.9 &&
      seen.every((s, i) => i === 0 || (s.dot[0] < seen[i - 1].dot[0] && s.sw[0] < seen[i - 1].sw[0])) &&
      seen[3].dot[0] >= 1 && seen[3].sw[0] >= 1 && seen[3].dot[0] < seen[3].dot[1] / 2,
      JSON.stringify(seen.map((s) => [s.doubt, s.dot, s.sw])));
    layer.teardownAll();
  }

  // ---- what the walk REACHES ---------------------------------------------------------------
  // Four defects a 124-site survey (2026-09) measured, each about text the walk
  // never got to: a container that merely DECLARES itself a heading, an application shell
  // marked notranslate, a box that clips its own text, and prose typeset in <pre>. Every
  // check below fails on the walker as it was before these rules.
  {
    // A line of ten filler words ending in a full stop — `preProse(6)` is six such lines,
    // i.e. prose shaped like an RFC page: ten words to the line, a sentence per line.
    const preProse = (n) => Array.from({ length: n }, () => words(10)).join("\n");

    // 1 · a heading is a barrier only while it is a LABEL ------------------------------------
    u = collect(`<div role="heading" aria-level="3"><p>${sent(40)}</p><p>${sent(40)}</p></div>`);
    check("a div[role=heading] holding paragraphs is a container, not a heading: its text is read (lobste.rs comment bodies)",
      u.length === 1 && u[0].parts === 2, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<h2><a href="#c">A teaser card title</a><p>${sent(80)}</p></h2>`);
    check("…and so is a whole teaser card wrapped in <h2> (网易, 新浪, the Guardian's live blog, dev.to)",
      u.length === 1 && !u[0].text.includes("teaser card title"), JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<div role="heading">Short Section Label</div><p>${sent(30)}</p><div role="heading">Another Label</div>`);
    check("a real role=heading label is still a barrier and still never scored", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<p>${sent(40)}</p><h3><span>Title</span> <em>continued</em></h3><p>${sent(40)}</p>`);
    check("…inline markup inside a heading does not make it a container", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<h2>${sent(80)}</h2>`);
    check("a 'heading' of eighty words is a text block and is read as one (decided: length settles it)",
      u.length === 1 && u[0].parts === 1, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<h2><a href="#a">A long headline that runs to about twenty words and is still nothing but a headline on the page</a></h2><p>${sent(40)}</p><p>${sent(40)}</p>`);
    check("…while a twenty-word headline is a label: a barrier, and no part of the text under it",
      u.length === 1 && u[0].parts === 2 && !u[0].text.includes("headline"), JSON.stringify(u.map(x => [x.parts, x.words])));

    // 2 · notranslate: a shell is not a widget ------------------------------------------------
    u = collect(`<div id="mastodon" class="notranslate app-holder"><div class="ui"><main><div role="feed"><article><p>${sent(80)}</p></article></div></main></div></div>`);
    check("a notranslate APPLICATION SHELL (Mastodon's app-holder) is walked: the statuses inside it are read",
      u.length === 1 && u[0].words >= 75, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<div translate="no"><section><p>${sent(80)}</p></section></div>`);
    check("…sectioning content anywhere under it is what tells a shell from a widget", u.length === 1, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<div class="notranslate"><p>${sent(80)}</p></div>`);
    check("a notranslate WIDGET is still honoured (no landmark, a sliver of the page)", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

    check("isNoTranslate: shell no, widget yes, page level no",
      (() => {
        sandbox.innerHTML = `<div class="shell notranslate"><main><p>x</p></main></div><div class="widget notranslate"><p>x</p></div>`;
        const shell = sandbox.querySelector(".shell");
        const widget = sandbox.querySelector(".widget");
        const body = document.createElement("body");
        body.className = "notranslate";
        return PW.isNoTranslate(shell) === false && PW.isNoTranslate(widget) === true && PW.isNoTranslate(body) === false;
      })());

    // 3 · a box that clips its own text is read; its CHIP goes where it can be seen ----------
    // `clipsOwnText` no longer excludes anything: a feed post behind "see more" is one
    // author's text, in the page, and the reader can open it. What it decides is where the
    // chip is inserted (lib/render/badge.ts) — after the clipping box, not after a last word
    // that is out of sight.
    const CLIPPED = `width:400px;max-height:40px;overflow:hidden`;
    u = collect(`<div style="${CLIPPED}">${sent(80)}</div>`);
    check("a box clipping most of its own text is still scored (LinkedIn's 'see more' post)",
      u.length === 1 && u[0].words === 80, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<div style="width:400px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden">${sent(80)}</div>`);
    check("…and so is a line-clamped one (Substack's Notes feed)", u.length === 1, JSON.stringify(u.map(x => [x.parts, x.words])));
    {
      sandbox.innerHTML = `<div style="${CLIPPED}"><p id="inner">${sent(80)}</p></div>`;
      const inside = PW.collectUnits(sandbox.querySelector("#inner"));
      check("…including on a re-scan rooted inside such a box", inside.length === 1, JSON.stringify(inside.length));
      const watched = PW.WATCHED_ATTRS ?? [];
      check("the observer watches the attributes a 'see more' reveal uses, aria-expanded included",
        ["class", "style", "hidden", "open", "aria-hidden", "aria-expanded"].every((a) => watched.includes(a)), watched.join(","));
    }

    // What counts as a box that clips its own text, and everything that does not.
    {
      const clips = (style, html = sent(80), sel = "div") => {
        sandbox.innerHTML = `<${sel} style="${style}">${html}</${sel}>`;
        const el = sandbox.firstElementChild;
        return PW.clipsOwnText(el, getComputedStyle(el));
      };
      check("clipsOwnText: a fixed height and a line clamp over twice their text",
        clips(CLIPPED) &&
        clips("width:400px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden") &&
        clips("width:400px;max-height:40px;overflow-y:clip"));
      check("guard: a SCROLL container (overflow:auto/scroll) is readable, not clipping",
        !clips("width:400px;max-height:40px;overflow:auto") && !clips("width:400px;max-height:40px;overflow:scroll"));
      check("guard: horizontal-only overflow (a carousel) is not vertical clipping",
        !clips("width:400px;overflow-x:hidden;white-space:nowrap"));
      check("guard: a few pixels of decorative overflow are not a hidden post",
        !clips("width:400px;height:60px;overflow:hidden", sent(20)));
      check("guard: a box as tall as the viewport is the page's own scrolling box",
        !clips(`width:400px;height:${Math.round(window.innerHeight * 0.95)}px;overflow:hidden`));
      check("guard: <main>, <body> and [role=main] are page level — body{overflow:hidden} under a modal clips nothing",
        !clips(`${CLIPPED}`, `<p>${sent(80)}</p>`, "main") &&
        (() => {
          const prev = document.body.getAttribute("style");
          document.body.setAttribute("style", "overflow:hidden;height:80px");
          const v = PW.clipsOwnText(document.body, getComputedStyle(document.body));
          if (prev === null) document.body.removeAttribute("style");
          else document.body.setAttribute("style", prev);
          return !v;
        })());
      check("guard: a <details> hides its content by other means and never counts as clipping",
        !clips(`${CLIPPED}`, `<summary>More</summary><p>${sent(80)}</p>`, "details"));
    }

    // Where the chip lands when the box clips.
    {
      const layer = PW.createBadgeLayer();
      const chipsFor = (html) => {
        sandbox.innerHTML = html;
        const units = PW.collectUnits(sandbox);
        for (const unit of units) {
          const result = { id: unit.id, bucket: 0, probs: [0.9, 0.06, 0.03, 0.01], score: 0.05 };
          layer.render(unit, PW.unitVerdict(unit.id, unit.text.length, [{ start: 0, end: unit.text.length, result }]));
        }
        return { units, hosts: [...sandbox.querySelectorAll('[data-anagram="host"]')] };
      };
      const box = () => sandbox.querySelector("#box");

      let r = chipsFor(`<div class="post"><div id="box" style="${CLIPPED}">${sent(80)}</div><button type="button" aria-expanded="false">…see more</button></div>`);
      check("the chip of a post whose last line is out of sight goes AFTER the clipping box, where the reader is",
        r.hosts.length === 1 && r.hosts[0].previousElementSibling === box() && !box().contains(r.hosts[0]),
        `${r.hosts.length} host(s), parent ${r.hosts[0]?.parentElement?.id || r.hosts[0]?.parentElement?.className}`);

      // LinkedIn's new UI: the clamp is a <span> inside the <p> that also holds "…more".
      r = chipsFor(`<p class="post"><span id="box" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;width:400px">${sent(80)}</span><button type="button">…more</button></p>`);
      check("…the same for a clamped <span>: the chip sits in the paragraph, beside the '…more' control",
        r.hosts.length === 1 && r.hosts[0].previousElementSibling === box() && r.hosts[0].parentElement.className === "post",
        `${r.hosts.length} host(s)`);

      // Two units in one clipped box: only the one nobody can see moves.
      r = chipsFor(`<div class="post"><div id="box" style="width:400px;max-height:120px;overflow:hidden"><p>${sent(80)}</p><p>${sent(80)}</p><p>${sent(80)}</p></div></div>`);
      const visible = r.hosts.filter((h) => box().contains(h));
      check("several units in one clipped box: the chips of the visible paragraphs stay put, only the hidden ones move out",
        r.units.length >= 2 && visible.length >= 1 && visible.length < r.hosts.length,
        `${visible.length} of ${r.hosts.length} inside the box`);

      // Once the reader expands the post the chip stays where it is: the host is reused.
      r = chipsFor(`<div class="post"><div id="box" style="${CLIPPED}">${sent(80)}</div></div>`);
      const moved = r.hosts[0];
      const unit = r.units[0];
      box().style.maxHeight = "none";
      if (unit) {
        const again = { id: unit.id, bucket: 3, probs: [0.01, 0.02, 0.07, 0.9], score: 0.95 };
        layer.render(unit, PW.unitVerdict(unit.id, unit.text.length, [{ start: 0, end: unit.text.length, result: again }]));
      }
      check("after the reader opens the post the chip is the same one, in the same place, and no second chip appears",
        sandbox.querySelectorAll('[data-anagram="host"]').length === 1 && !!moved && moved.isConnected && moved.previousElementSibling === box(),
        `${sandbox.querySelectorAll('[data-anagram="host"]').length} host(s)`);

      // A quotation, a list or a spoiler span INSIDE the clipped text is not a post
      // boundary: the chips of quoted passages in Goodreads reviews used to stay in the
      // truncated box, out of sight (2 of 150 chips on one book page).
      r = chipsFor(`<article class="post"><div id="box" style="${CLIPPED}">${sent(40)}<blockquote><p>${sent(80)}</p></blockquote></div></article>`);
      check("a chip anchored inside a <blockquote> in the clipped text still finds the box above it (Goodreads reviews)",
        r.hosts.length >= 1 && r.hosts.every((h) => !box().contains(h)) && r.hosts[r.hosts.length - 1].previousElementSibling === box(),
        `${r.hosts.filter((h) => box().contains(h)).length} of ${r.hosts.length} still inside`);

      r = chipsFor(`<article class="post"><div id="box" style="${CLIPPED}"><ul><li>${sent(40)}</li><li>${sent(40)}</li></ul></div></article>`);
      check("…and so does one anchored in a list item", r.hosts.length >= 1 && r.hosts.every((h) => !box().contains(h)), `${r.hosts.length} host(s)`);

      // But a chip never leaves its post: the box has to be INSIDE the post.
      r = chipsFor(`<article id="box" class="post" style="${CLIPPED}">${sent(80)}</article>`);
      check("guard: when the clipping box IS the post, the chip stays inside it rather than beside the post",
        r.hosts.length === 1 && box().contains(r.hosts[0]), `${r.hosts.length} host(s)`);

      r = chipsFor(`<div id="box" style="${CLIPPED}"><article class="post">${sent(80)}</article></div>`);
      check("guard: a clipping box that holds the whole post keeps the chip in the post", r.hosts.length === 1 && box().contains(r.hosts[0]), `${r.hosts.length} host(s)`);

      // A box that hides a couple of PARAGRAPHS of its own text is not a "see more" box by
      // the measure in lib/dom/style.ts — a Steam review card 663 px tall holding 771 px of
      // review has nothing like twice its own height in it — but the reader cannot see what
      // it cuts off, chips included (the survey found 25 such chips on one Steam page). What
      // the placement layer asks is only whether something is hidden.
      r = chipsFor(`<div class="post"><div id="box" style="width:400px;height:150px;overflow:hidden"><p>${sent(80)}</p><p>${sent(80)}</p></div></div>`);
      {
        const outside = r.hosts.filter((h) => !box().contains(h));
        check("a box that hides a paragraph of its own text without hiding half of itself still gets one chip under it (Steam review cards)",
          outside.length === 1 && outside[0].previousElementSibling === box(),
          `${outside.length} of ${r.hosts.length} outside`);
      }

      // Nothing moves for an ordinary paragraph, or for the guards above.
      for (const [name, style, text] of [
        ["a plain paragraph", "width:400px", sent(80)],
        ["a scroll container", "width:400px;max-height:40px;overflow:auto", sent(80)],
        ["a box that overflows by a line", "width:400px;height:146px;overflow:hidden", sent(80)],
      ]) {
        r = chipsFor(`<div class="post"><div id="box" style="${style}">${text}</div></div>`);
        check(`the chip stays inside ${name}`, r.hosts.length === 1 && box().contains(r.hosts[0]), `${r.hosts.length} host(s)`);
      }
      layer.teardownAll();
      sandbox.innerHTML = "";
    }

    // 4 · prose typeset in <pre> -----------------------------------------------------------------
    u = collect(`<pre>${preProse(8)}</pre>`);
    check("a <pre> of wrapped PROSE is read (RFCs as HTML, man pages, mailing-list archives)",
      u.length === 1 && u[0].words >= 75, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<pre><code>${preProse(8)}</code></pre>`);
    check("…but markup that says code keeps it out, whatever the text reads like", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

    u = collect(`<div class="highlight-python notranslate"><div class="highlight"><pre>${preProse(8)}</pre></div></div>`);
    check("…and so does a highlighter's wrapper (Sphinx, Pygments, Prism)", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));

    {
      const code = {
        python: "def parse(path):\n    with open(path) as fh:\n        data = json.load(fh)\n    result = {}\n    for key, value in data.items():\n        if key.startswith(\"_\"):\n            continue\n        result[key] = normalise(value)\n    return result",
        javascript: "export function createStore(reducer, state) {\n  const listeners = new Set();\n  return {\n    getState() { return state; },\n    dispatch(action) { state = reducer(state, action); return action; },\n    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },\n  };\n}",
        c: "static int probe(struct device *dev)\n{\n\tstruct ctx *c;\n\tint ret;\n\n\tc = alloc(sizeof(*c));\n\tif (!c)\n\t\treturn -ENOMEM;\n\tret = request_irq(dev, irq, handler, 0, \"name\", c);\n\treturn ret < 0 ? ret : 0;\n}",
        json: '{\n  "name": "example",\n  "version": "1.2.3",\n  "scripts": { "build": "make", "test": "make check" },\n  "keywords": ["one", "two", "three"],\n  "private": true\n}',
        yaml: "version: 2\njobs:\n  build:\n    docker:\n      - image: node:22\n    steps:\n      - checkout\n      - run: npm ci\n      - run: npm test\nworkflows:\n  main:\n    jobs: [build]",
        shell: "$ git clone https://example.org/repo.git\nCloning into 'repo'...\nremote: Enumerating objects: 4122, done.\n$ cd repo && npm ci\nadded 431 packages in 12s\n$ npm test\n  120 passing (3s)\n$ echo $?\n0",
        sql: "SELECT u.id, u.name, count(o.id) AS orders\n  FROM users u\n  LEFT JOIN orders o ON o.user_id = u.id\n WHERE u.status <> 'deleted'\n GROUP BY u.id, u.name\n HAVING count(o.id) > 3\n ORDER BY orders DESC\n LIMIT 50;",
        diff: "--- a/one/two.txt\n+++ b/one/two.txt\n@@ -12,7 +12,9 @@ Required properties:\n-  - control: optional, see below\n+  - control: required unless the second supply is absent\n+    as the example below shows\n \n Optional properties:\n   - label: a readable name",
        "stack trace": 'Traceback (most recent call last):\n  File "/usr/lib/python3.12/runpy.py", line 198, in _run_module\n    return _run_code(code, main_globals, None,\n  File "/srv/app/main.py", line 42, in <module>\n    app.run(host="0.0.0.0", port=8000)\nRuntimeError: address already in use',
        log: "2026-09-18T09:14:02.113Z INFO  [worker-3] GET /api/units 200 12ms\n2026-09-18T09:14:02.884Z WARN  [worker-1] cache miss key=u_3f\n2026-09-18T09:14:03.002Z ERROR [worker-7] fixture timeout after 20000ms\n2026-09-18T09:14:03.551Z INFO  [worker-3] native score completed 233ms batch=8",
        "ASCII table": "+---------+--------+---------+\n| profile | chips  | ms      |\n+---------+--------+---------+\n| phone   |     12 |     840 |\n| laptop  |     12 |     610 |\n+---------+--------+---------+",
        "table of contents": "Table of Contents\n\n   1   Introduction ..................................3\n   1.1    Purpose....................................3\n   1.2    Terminology ...............................4\n   2   Notes ........................................5\n   3   Security Considerations ......................9",
      };
      const scored = Object.entries(code).filter(([, text]) => collect(`<pre>${text.replace(/</g, "&lt;")}</pre>`).length > 0);
      check("code and near-code in a <pre> stay out: Python, JavaScript, C, JSON, YAML, a shell session, SQL, a diff, a stack trace, log output, an ASCII table, a table of contents",
        scored.length === 0, scored.map(([k]) => k).join(", "));

      const licence = "Permission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files, to deal in the Software\nwithout restriction, including without limitation the rights to use, copy,\nmodify, merge, publish, distribute, sublicense, and to permit persons to whom\nthe Software is furnished to do so, subject to the following conditions.\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.";
      u = collect(`<pre>${licence}</pre>`);
      check("a licence header IS prose — English sentences, written by a person — and is read", u.length === 1, JSON.stringify(u.map(x => [x.parts, x.words])));

      const poem = "the quiet town keeps walking through the rain\nand children read their books near warm windows\nwhile rooftops hold the evening over us\nthe lazy dog has given up the garden\nand nothing in the house is moving now\nthe long quiet evenings fall on every roof\nthe brown fox sleeps beneath the empty table\nand somewhere down the road a gate is swinging\nthe lamps come on along the river slowly\nand all the windows gather in the dark";
      u = collect(`<pre>${poem}</pre>`);
      check("…while lines that never punctuate like sentences (a poem) stay excluded, as anything unclear does", u.length === 0, JSON.stringify(u.map(x => [x.parts, x.words])));
    }

    {
      // A mailing-list message: the reply is the author's, the "> " lines are not.
      const quoted = "> QUOTED the committee met on thursday to consider the revised plan\n> QUOTED and several members asked for the deadline to be moved again";
      sandbox.innerHTML = `<pre>Alice Moreau wrote:\n${quoted}\n\n${preProse(8)}</pre>`;
      let got = PW.collectUnits(sandbox);
      check("an e-mail quotation never merges with the reply under it",
        got.length === 1 && !got[0].text.includes("QUOTED"), JSON.stringify(got.map(x => [x.parts.length, x.wordCount, x.text.slice(0, 20)])));

      // lore.kernel.org wraps each quoted block in a span: the boundary is between nodes.
      sandbox.innerHTML = `<pre>Alice Moreau wrote:\n<span class="q">${quoted}</span>\n${preProse(8)}</pre>`;
      got = PW.collectUnits(sandbox);
      check("…including where the quote sits in a <span> of its own (lore.kernel.org)",
        got.length === 1 && !got[0].text.includes("QUOTED"), JSON.stringify(got.map(x => [x.parts.length, x.wordCount, x.text.slice(0, 20)])));
    }

    u = collect(`<pre>RFC 9999                       Short Notes                      June 2026\n\n${preProse(8)}</pre>`);
    check("a running head in column layout inside an accepted <pre> is still a barrier, never part of the text",
      u.length === 1 && !u[0].text.includes("Short Notes"), JSON.stringify(u.map(x => [x.parts, x.text.slice(0, 20)])));

    {
      // An incremental re-scan rooted inside a <pre> follows the same rule as the walk.
      sandbox.innerHTML = `<pre><span id="in-prose">${preProse(8)}</span></pre>`;
      const inProse = PW.collectUnits(sandbox.querySelector("#in-prose")).length;
      sandbox.innerHTML = `<pre><code><span id="in-code">${preProse(8)}</span></code></pre>`;
      const inCode = PW.collectUnits(sandbox.querySelector("#in-code")).length;
      check("a re-scan inside a <pre>: prose is read, code is not", inProse === 1 && inCode === 0, `${inProse} / ${inCode}`);
    }
  }

  // ---- the text the model reads ------------------------------------------------------------
  const written = "LLMs’ “rich” steps---prompting -- pages 1–5… of Acme™ 👨\u200D👩\u200D👧";
  check("model form: quotes, dashes, ellipses, symbols and emoji sequences reach the engine as written", PW.modelText(written) === written, JSON.stringify(PW.modelText(written)));
  check("model form: escapes, invisibles, NBSP and ligatures repaired", PW.modelText("74.1\\% of hy\u00ADphen\u200Bated \u202Ebidi\u202C\u00A0ﬁnal") === "74.1% of hyphenated bidi final", JSON.stringify(PW.modelText("74.1\\% of hy\u00ADphen\u200Bated \u202Ebidi\u202C\u00a0ﬁnal")));
  check("model form: un-rendered LaTeX math dropped, dollar amounts kept", PW.modelText("on the $\\tau^{2}$-bench costs $5 and $10") === "on the -bench costs $5 and $10", JSON.stringify(PW.modelText("on the $\\tau^{2}$-bench costs $5 and $10")));
  check("model form: paragraph breaks survive as one line break", PW.modelText("Sure, here it is.\n\n  Body  text.") === "Sure, here it is.\nBody text.", JSON.stringify(PW.modelText("Sure, here it is.\n\n  Body  text.")));
  check("what is sent is the model form, and putting it in the model form again changes nothing",
    PW.modelText("a---b ‘c’") === PW.blockText("a---b ‘c’", { start: 0, end: 9 }) && PW.modelText(PW.modelText("a -- b ‘c’ ``d'' ﬁ\\%")) === PW.modelText("a -- b ‘c’ ``d'' ﬁ\\%"));
  check("isSeparatorRun: rules yes, numbers no", PW.isSeparatorRun("* * *") && PW.isSeparatorRun("———") && !PW.isSeparatorRun("(3)") && !PW.isSeparatorRun("12"));

  // ---- pure text utils ---------------------------------------------------------------
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
  check("isFlagged(): AI-generated only", !PW.isFlagged(mk(2, [0, 0.2, 0.6, 0.2])) && PW.isFlagged(mk(3, [0, 0, 0.1, 0.9])) && !PW.isFlagged(mk(1, [0.2, 0.6, 0.2, 0])) && !PW.isFlagged(mk(0, [0.9, 0.1, 0, 0])));
  // The score is written the way a correlation is — two decimals, no leading zero, no
  // per cent sign — and only the top of the scale breaks the shape, because ".100" is not
  // a number. Anything spoken says the leading zero: a screen reader reads ".93" badly.
  check("formatScore(): two decimals, no leading zero, 1.0 at the top",
    PW.formatScore(mk(3, [0, 0, 0, 1]).score) === "1.0" && PW.formatScore(mk(0, [1, 0, 0, 0]).score) === ".00" &&
    PW.formatScore(mk(1, [0.25, 0.25, 0.25, 0.25]).score) === ".50" && PW.formatScore(0.004) === ".00" && PW.formatScore(0.995) === "1.0");
  check("spokenScore(): the same number with the zero a screen reader needs",
    PW.spokenScore(0.93) === "0.93" && PW.spokenScore(0) === "0.00" && PW.spokenScore(1) === "1.0");

  sandbox.remove();
  return out;
});

// ---- a unit whose batch was abandoned is dispatched again from where it stands ------------
// The viewport observer lets an element go once it has been seen, so a paragraph on screen
// is dispatched once. When that batch is abandoned (the caches were cleared under it) the
// paragraph must be placed again, or it waits for the idle prefetch's background lane.
{
  const ob = await browser.newPage();
  await ob.setContent("<!doctype html><html><body></body></html>");
  await ob.addScriptTag({ path: BUNDLE });
  const r = await ob.evaluate(async () => {
    const WORDS = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(" ");
    document.body.innerHTML = `<p>${Array.from({ length: 80 }, (_, i) => WORDS[i % WORDS.length]).join(" ")}.</p>`;
    const [unit] = PW.collectUnits(document.body);
    const seen = [];
    const observers = PW.createObservers({ onVisible: () => seen.push("viewport"), onNear: () => seen.push("near"), onDirty() {} });
    const frames = () => new Promise((done) => setTimeout(done, 200));
    observers.observeUnit(unit);
    await frames();
    const first = seen.join();
    observers.observeUnit(unit);
    await frames();
    const again = seen.join();
    observers.reobserve(unit);
    await frames();
    observers.stop();
    return { first, again, placed: seen.join() };
  });
  results.push({
    name: "a unit on screen is dispatched once, and in the viewport lane again when it is placed again",
    ok: r.first.endsWith("viewport") && r.again === r.first && r.placed === `${r.first},${r.first}`,
    note: JSON.stringify(r),
  });
  await ob.close();
}

// ---- the page's shadow roots are watched, never Anagram's own ------------------------------
// Every shadow root on the page is watched from the start, walked into or not. The ball and
// the chips are shadow hosts too, and a ball that redraws its count must not wake the
// observer that redraws it: that is a re-scan every quarter second on a settled page.
{
  const ob = await browser.newPage();
  await ob.setContent("<!doctype html><html><body></body></html>");
  await ob.addScriptTag({ path: BUNDLE });
  const r = await ob.evaluate(async () => {
    const own = document.createElement("div");
    own.setAttribute("data-anagram", "host");
    const ownRoot = own.attachShadow({ mode: "open" });
    ownRoot.innerHTML = "<span>1</span>";
    const widget = document.createElement("div");
    const widgetRoot = widget.attachShadow({ mode: "open" });
    document.body.append(own, widget);
    const dirty = [];
    const observers = PW.createObservers({ onVisible() {}, onNear() {}, onDirty: (nodes) => dirty.push(...nodes) });
    observers.start();
    ownRoot.querySelector("span").textContent = "2"; // the ball redraws its count
    widgetRoot.innerHTML = "<p>The page renders into its own root.</p>";
    await new Promise((done) => setTimeout(done, 500));
    observers.stop();
    return { own: dirty.filter((n) => ownRoot.contains(n)).length, page: dirty.filter((n) => widgetRoot.contains(n)).length };
  });
  results.push({
    name: "a shadow root on the page is watched from the start, one of Anagram's own never is",
    ok: r.page > 0 && r.own === 0,
    note: JSON.stringify(r),
  });
  await ob.close();
}

// ---- a chip inside a clipped box follows the page when it reflows -------------------------
// The placement is measured once, when the verdict lands, and the page does not stand still:
// on a Goodreads book page the reviews grow as their images and web fonts arrive, and a chip
// that was inside the visible band of a truncated review ends up below it (measured: a box
// showing the end of the text at 141 px of 160 px showed it at 228 px a few seconds later).
// The layer watches such a chip with an IntersectionObserver rooted at the box; the check
// needs a turn of the event loop, so it runs in a page of its own.
{
  const rf = await browser.newPage();
  await rf.setContent("<!doctype html><html><body></body></html>");
  await rf.addScriptTag({ path: BUNDLE });
  const r = await rf.evaluate(async () => {
    const WORDS = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(" ");
    const words = (n) => Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ") + ".";
    document.body.innerHTML = `<div class="post"><div id="box" style="width:400px;height:150px;overflow:hidden"><div id="pad" style="height:0"></div><p id="first">${words(80)}</p><h3>A heading keeps the two apart</h3><p>${words(120)}</p></div></div>`;
    const layer = window.PW_LAYER = PW.createBadgeLayer();
    const box = document.getElementById("box");
    const units = PW.collectUnits(document.body);
    for (const unit of units) {
      const result = { id: unit.id, bucket: 0, probs: [0.9, 0.06, 0.03, 0.01], score: 0.05 };
      layer.render(unit, PW.unitVerdict(unit.id, unit.text.length, [{ start: 0, end: unit.text.length, result }]));
    }
    const inFirst = document.querySelector('#first [data-anagram="host"]');
    const before = { placedInsideBox: !!inFirst && box.contains(inFirst), units: units.length };
    // The page reflows under the chip: something above the paragraph grows.
    document.getElementById("pad").style.height = "300px";
    await new Promise((done) => setTimeout(done, 400));
    return {
      ...before,
      stillInsideBox: !!inFirst && box.contains(inFirst),
      afterBox: !!inFirst && inFirst.previousElementSibling === box,
      chips: document.querySelectorAll('[data-anagram="host"]').length,
    };
  });
  results.push({
    name: "a chip left inside a clipped box is moved out when the page reflows under it",
    ok: r.placedInsideBox && !r.stillInsideBox && r.afterBox && r.chips === 2,
    note: JSON.stringify(r),
  });
  await rf.close();
}

// ---- structural fixtures: who is scored with whom on real-site markup ------------------
// test/fixtures/*.html are reduced from the live DOM of the sites they name (each file says
// what was verified and what was modelled). Every text block is annotated with the voice it
// belongs to, so the checks are about AUTHORS, not about selectors:
//   data-voice="name"   nearest ancestor names the voice of a text node
//   data-chrome         name / handle / timestamp / action rows and pseudo-headings
//   data-expect         "unit": some unit covers text in here · "none": no unit does
//   data-parts          "n": exactly ONE unit covers text in here, and it has n parts
const FIXTURES = join(__dirname, "fixtures");
/** [units, multi-part units] per fixture — a change here is a change of behaviour. */
const EXPECTED = {
  "amp-article": [1, 1],
  "article-list-table": [6, 5],
  "bilibili-comments": [2, 2],
  "bluesky-profile": [0, 0],
  "chat-transcript": [2, 1],
  "clipped-reviews": [8, 1],
  "comments-li": [2, 1],
  "consent-banners": [1, 1],
  "discord-channel": [1, 0],
  "discourse-thread": [2, 2],
  "facebook-page": [3, 2],
  "front-page-cards": [2, 1],
  "github-discussion": [3, 2],
  "github-issue": [3, 3],
  "hn-thread": [2, 1],
  "linkedin-clipped": [5, 1],
  "linkedin-feed": [2, 2],
  "linkedin-listitem": [2, 1],
  "listicle": [1, 1],
  "listicle-divsoup": [2, 1],
  "lobsters-comment": [3, 1],
  "mailing-list": [3, 0],
  "mastodon-shell": [2, 1],
  "news-article": [1, 1],
  "permalink-single": [2, 1],
  "phpbb-topic": [2, 1],
  "quora-question": [2, 1],
  "recipe-faq": [5, 4],
  "reddit-thread": [3, 2],
  "reference-lists": [6, 0],
  "review-cards": [2, 1],
  "rfc-html": [3, 0],
  "slack-channel": [2, 1],
  "stackoverflow-question": [5, 2],
  "substack-article": [16, 13],
  "substack-comments": [3, 2],
  "substack-note": [3, 1],
  "telegram-channel": [2, 1],
  "teams-chat": [2, 1],
  "thread-100": [75, 50],
  "threads-profile": [2, 1],
  "truncated-previews": [3, 0],
  "tufte-sidenotes": [4, 3],
  "v2ex-topic": [2, 2],
  "webmail-apple": [4, 4],
  "webmail-gmail": [4, 3],
  "webmail-outlook": [5, 5],
  "wikipedia-article": [3, 2],
  "wordpress-comments": [2, 2],
  "wordpress-single": [1, 1],
  "wordpress-taxonomy": [3, 3],
  "x-timeline": [7, 5],
  "youtube-comments": [2, 0],
  "zhihu-answers": [13, 7],
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
    // The COMPOSED tree, as the walker sees it: Bilibili's comments are nested open shadow
    // roots, which closest(), contains() and querySelectorAll() do not look into.
    const up = (e) => e.parentElement ?? (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null);
    const nearest = (e, attr) => { for (; e; e = up(e)) if (e.hasAttribute(attr)) return e; return null; };
    const holds = (el, inner) => { for (let e = inner; e; e = up(e)) if (e === el) return true; return false; };
    const everywhere = (root, sel, acc = []) => {
      acc.push(...root.querySelectorAll(sel));
      for (const host of root.querySelectorAll("*")) if (host.shadowRoot) everywhere(host.shadowRoot, sel, acc);
      return acc;
    };
    const voiceOf = (part) => nearest(part.nodes[0].parentElement, "data-voice")?.getAttribute("data-voice") ?? "(none)";
    const mixed = [];
    const chrome = [];
    const covered = new Set();
    for (const u of units) {
      const voices = [...new Set(u.parts.map(voiceOf))];
      if (voices.length > 1) mixed.push(voices.join("+"));
      for (const part of u.parts) for (const n of part.nodes) {
        if (nearest(n.parentElement, "data-chrome")) chrome.push(n.textContent.trim().slice(0, 30));
        for (let e = n.parentElement; e; e = up(e)) covered.add(e);
      }
    }
    const wrong = [];
    const annotated = everywhere(document, "[data-expect]");
    for (const el of annotated) {
      const want = el.getAttribute("data-expect") === "unit";
      if (covered.has(el) !== want) wrong.push(`${want ? "no unit for" : "unexpected unit on"} "${el.textContent.trim().slice(0, 40)}"`);
      // data-parts="n": ONE unit covers this block, and it has exactly n parts ("3+1": two units).
      if (el.hasAttribute("data-parts")) {
        const mine = units.filter((u) => u.parts.some((part) => holds(el, part.container)));
        const got = mine.map((u) => u.parts.length).join("+");
        if (got !== el.getAttribute("data-parts")) wrong.push(`${got || "no"} parts instead of ${el.getAttribute("data-parts")} on "${el.textContent.trim().slice(0, 40)}"`);
      }
    }
    return { units: units.length, merged: units.filter((u) => u.parts.length > 1).length, mixed, chrome, wrong, annotated: annotated.length };
  });
  await fx.close();
  const [wantUnits, wantMerged] = EXPECTED[name] ?? [-1, -1];
  results.push({ name: `fixture ${name}: no unit mixes two voices`, ok: r.mixed.length === 0, note: r.mixed.join(" | ") });
  results.push({ name: `fixture ${name}: no name / time / action row inside a unit`, ok: r.chrome.length === 0, note: r.chrome.join(" | ") });
  results.push({ name: `fixture ${name}: covered exactly where expected (${r.annotated} annotated blocks)`, ok: r.annotated > 0 && r.wrong.length === 0, note: r.wrong.join(" | ") });
  results.push({ name: `fixture ${name}: ${wantUnits} units, ${wantMerged} of them multi-part`, ok: r.units === wantUnits && r.merged === wantMerged, note: `${r.units} units, ${r.merged} multi-part` });
}

// ---- a mailing-list quotation: the markers are the frame, not the words -------------------
// The "> " a mail client puts in front of every quoted line is how it draws a quotation, so
// it is no part of what the model reads. The parts stay node-based, so the offset map that
// leads from a window back to the page has to drop exactly the same characters — otherwise
// every window falls back to marking the whole unit.
{
  const ml = await browser.newPage();
  await ml.goto(pathToFileURL(join(FIXTURES, "mailing-list.html")).href);
  await ml.addScriptTag({ path: BUNDLE });
  const r = await ml.evaluate(() => {
    const collapse = (t) => t.replace(/\s+/g, " ").trim();
    const units = PW.collectUnits(document.body);
    const quoted = units.find((u) => u.text.includes("maintained by four people"));
    const reply = units.find((u) => u.text.includes("I agree that the history"));
    const ranges = quoted ? PW.locateSpans(quoted.parts, quoted.text, PW.planWindows(quoted.text)) : null;
    return {
      units: units.length,
      quoted: quoted ? quoted.text : null,
      reply: reply ? reply.text : null,
      raw: quoted ? quoted.parts.map((p) => p.nodes.map((n) => n.data).join("")).join("") : "",
      located: ranges ? ranges.map((rs) => rs.map((x) => collapse(x.toString()))) : null,
    };
  });
  await ml.close();
  // The ranges run over the page, markers and all — what must line up is the text they cover
  // once the markers are taken out of it again.
  const marked = r.located && r.located.flat().join(" ");
  const rebuilt = marked && marked.replace(/>/g, " ").replace(/\s+/g, " ").trim();
  results.push({
    name: "mailing-list: the quoted lines are scored without their \"> \" markers",
    ok: !!r.quoted && !r.quoted.includes(">") && r.quoted.startsWith("Right, so a package") && r.raw.includes(">"),
    note: JSON.stringify(r.quoted && r.quoted.slice(0, 60)),
  });
  results.push({
    name: "mailing-list: the reply under the quotation is untouched",
    ok: !!r.reply && !r.reply.includes(">") && r.reply.startsWith("I agree that the history is the better record"),
    note: JSON.stringify(r.reply && r.reply.slice(0, 60)),
  });
  results.push({
    name: "mailing-list: windows of the quoted unit still resolve to ranges over the quoted lines",
    ok: !!marked && r.located.every((rs) => rs.length > 0) && marked.includes("version control history gives us") && rebuilt === r.quoted,
    note: JSON.stringify(r.located && r.located.map((rs) => rs.map((x) => x.slice(0, 30)))),
  });
}

// ---- PLACEMENT: one chip after a clipping box, and a chip that keeps being watched --------
// Two defects a 30-page session survey (2026-09) measured on live pages, both
// about where a chip goes when the site clips a post to a few lines:
//
//   · EVERY unit of a clamped review was inserted after the box, because every unit's own
//     anchor is out of sight in it — Goodreads piled 91 chips of distinct units at 16
//     anchors (twelve in a row at the worst, reading 12%/85%/57%/…), Steam 52, Amazon 4.
//     At most ONE chip may sit after such a box: the first unit in document order whose own
//     anchor is out of sight. Every later unit keeps its chip at its OWN anchor, where the
//     reader finds it the moment the box is opened.
//   · a hidden chip got a single chance to be rescued: the watcher stopped watching before
//     it re-checked, so a box that was not clipping YET (its images and web fonts still on
//     the way — the Goodreads case) kept its chip out of sight for good. Steam left 25 chips
//     there, Goodreads 6, the Guardian's live blog 3.
//
// Both need a turn of the event loop, so both run in pages of their own. The markup is the
// fixture the survey's own findings are written into (test/fixtures/clipped-reviews.html).
{
  const cr = await browser.newPage();
  await cr.goto(pathToFileURL(join(FIXTURES, "clipped-reviews.html")).href);
  await cr.addScriptTag({ path: BUNDLE });
  const r = await cr.evaluate(async () => {
    const HOST = '[data-anagram="host"]';
    const tick = () => new Promise((done) => setTimeout(done, 350));
    const box = (id) => document.getElementById(id);
    const card = (id) => box(id).closest("article");
    const numOf = (h) => h.shadowRoot.querySelector(".num").textContent;
    const after = (id) => [...card(id).querySelectorAll(HOST)].filter((h) => !box(id).contains(h)).map(numOf);
    const within = (id) => [...box(id).querySelectorAll(HOST)].map(numOf);
    const chips = () => document.querySelectorAll(HOST).length;
    /** The last line of a unit — the line the chip closes. */
    const endRect = (u) => {
      const part = u.parts[u.parts.length - 1];
      const range = document.createRange();
      range.selectNodeContents(part.nodes[part.nodes.length - 1]);
      const rects = range.getClientRects();
      return rects[rects.length - 1] ?? null;
    };

    const units = PW.collectUnits(document.body);
    // A distinct score per unit, so every chip says which unit it belongs to.
    const pct = new Map();
    const paint = (layer, list) => {
      for (const u of list) {
        const i = units.indexOf(u);
        const score = (i + 1) / 20;
        pct.set(u.id, PW.formatScore(score));
        const result = { id: u.id, bucket: 0, probs: [1 - score, score, 0, 0], score };
        layer.render(u, PW.unitVerdict(u.id, u.text.length, [{ start: 0, end: u.text.length, result }]));
      }
    };
    /** Which unit SHOULD hold the one slot after a box: the first one in document order
     *  whose last line is below the visible band. Read off the geometry, so the check does
     *  not depend on the font this machine renders the fixture in. */
    const wanted = (id) => {
      const bottom = box(id).getBoundingClientRect().bottom - 1;
      for (const u of units) {
        if (!box(id).contains(u.parts[0].nodes[0])) continue;
        const end = endRect(u);
        if (end && end.top >= bottom) return pct.get(u.id);
      }
      return null;
    };

    const layer = (window.PW_LAYER = PW.createBadgeLayer());
    paint(layer, units);
    await tick();
    const collapsed = { after: after("nadia-box"), within: within("nadia-box"), want: wanted("nadia-box"), chips: chips() };
    const guards = { tomas: after("tomas-box"), tomasIn: within("tomas-box"), priya: after("priya-box"), priyaIn: within("priya-box") };

    // The reader opens the review: every chip goes back to its own anchor, where its own
    // paragraph now ends, and every one of them has a box on the screen.
    document.getElementById("nadia-more").click();
    await tick();
    const opened = {
      after: after("nadia-box"),
      within: within("nadia-box"),
      chips: chips(),
      invisible: [...box("nadia-box").querySelectorAll(HOST)].filter((h) => h.getBoundingClientRect().height === 0).length,
    };

    // …and closes it again: the first hidden chip parks a SECOND time (the old watcher gave
    // a chip one chance and then let it go).
    document.getElementById("nadia-more").click();
    await tick();
    const closed = { after: after("nadia-box"), within: within("nadia-box"), want: wanted("nadia-box"), chips: chips() };

    // A page that stands still moves nothing: moving a chip changes the layout, which is
    // what the box's own observers report, so a rule that is not stable would loop here.
    let moves = 0;
    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        for (const n of [...rec.addedNodes, ...rec.removedNodes]) {
          if (n.nodeType === 1 && n.matches(HOST)) moves++;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    await new Promise((done) => setTimeout(done, 900));
    mo.disconnect();

    // The same page, chipped in REVERSE order — verdicts land in the order the fixture
    // answers, not in the order the page is written — still parks the same unit.
    layer.teardownAll();
    const later = PW.createBadgeLayer();
    paint(later, [...units].reverse());
    await tick();
    const reversed = { after: after("nadia-box"), want: wanted("nadia-box"), chips: chips() };
    later.teardownAll();
    return { collapsed, guards, opened, closed, moves, reversed, units: units.length };
  });
  await cr.close();
  results.push({
    name: "a review the site clips: ONE chip after the box — the first unit whose own last line is out of sight — and the rest at their own anchors",
    ok: r.collapsed.after.length === 1 && r.collapsed.want !== null && r.collapsed.after[0] === r.collapsed.want &&
      r.collapsed.within.length === 5 && r.collapsed.chips === r.units,
    note: JSON.stringify(r.collapsed),
  });
  results.push({
    name: "…the one-unit boxes beside it behave exactly as before: one chip each, after the box",
    ok: r.guards.tomas.length === 1 && r.guards.tomasIn.length === 0 && r.guards.priya.length === 1 && r.guards.priyaIn.length === 0,
    note: JSON.stringify(r.guards),
  });
  results.push({
    name: "opening the review brings every chip back to its own paragraph, all of them drawn, and no second chip appears",
    ok: r.opened.after.length === 0 && r.opened.within.length === 6 && r.opened.invisible === 0 && r.opened.chips === r.units,
    note: JSON.stringify(r.opened),
  });
  results.push({
    name: "closing it again parks the first hidden chip a second time (a chip is watched for as long as it is in the box)",
    ok: r.closed.after.length === 1 && r.closed.after[0] === r.closed.want && r.closed.within.length === 5 && r.closed.chips === r.units,
    note: JSON.stringify(r.closed),
  });
  results.push({ name: "a page standing still moves no chip at all", ok: r.moves === 0, note: `${r.moves} host insertions/removals in 900 ms` });
  results.push({
    name: "the same review chipped in the order the fixture answers, not the order it is written, parks the same unit",
    ok: r.reversed.after.length === 1 && r.reversed.after[0] === r.reversed.want && r.reversed.chips === r.units,
    note: JSON.stringify(r.reversed),
  });
}

// A box that is NOT clipping when the chips land and starts clipping seconds later: the
// Goodreads review whose cover images and web font arrive after the verdicts do. Nothing
// is hidden at insertion time, so the chips go where their text ends; when the box fills
// up, the first unit that has gone out of sight parks after it and the second stays where
// it is, out of sight until the reader opens the review.
{
  const lc = await browser.newPage();
  await lc.setContent("<!doctype html><html><body></body></html>");
  await lc.addScriptTag({ path: BUNDLE });
  const r = await lc.evaluate(async () => {
    const HOST = '[data-anagram="host"]';
    const WORDS = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(" ");
    const words = (n) => Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ") + ".";
    document.body.innerHTML =
      `<div class="post"><div id="box" style="max-height:400px;overflow:hidden;width:400px">` +
      `<img id="cover" alt="" style="display:block;width:100%;height:0">` +
      `<p id="one">${words(80)}</p><p id="two">${words(80)}</p></div></div>`;
    const box = document.getElementById("box");
    const layer = (window.PW_LAYER = PW.createBadgeLayer());
    const units = PW.collectUnits(document.body);
    const pct = new Map();
    units.forEach((u, i) => {
      const score = (i + 1) / 20;
      pct.set(u.id, PW.formatScore(score));
      const result = { id: u.id, bucket: 0, probs: [1 - score, score, 0, 0], score };
      layer.render(u, PW.unitVerdict(u.id, u.text.length, [{ start: 0, end: u.text.length, result }]));
    });
    const numOf = (h) => h.shadowRoot.querySelector(".num").textContent;
    const inside = () => [...box.querySelectorAll(HOST)].map(numOf);
    const outside = () => [...document.querySelectorAll(HOST)].filter((h) => !box.contains(h)).map(numOf);
    const before = { inside: inside(), outside: outside(), units: units.length };
    // The cover image arrives and pushes both paragraphs out of the visible band.
    document.getElementById("cover").style.height = "600px";
    await new Promise((done) => setTimeout(done, 450));
    return {
      ...before,
      first: pct.get(units[0]?.id),
      afterInside: inside(),
      afterOutside: outside(),
      chips: document.querySelectorAll(HOST).length,
    };
  });
  await lc.close();
  results.push({
    name: "a box that only starts clipping once its images arrive still rescues a chip — one after the box, the rest at their anchors",
    ok: r.units === 2 && r.outside.length === 0 && r.inside.length === 2 &&
      r.afterOutside.length === 1 && r.afterOutside[0] === r.first && r.afterInside.length === 1 && r.chips === 2,
    note: JSON.stringify(r),
  });
}

// =====================================================================================
// PAGE DIAGNOSTICS — "Copy page diagnostics" (lib/diagnostics/).
//
// The feature's hard requirement is that NOTHING a person wrote leaves the page. So the
// fixture is a page made of things that must not travel — a name, an e-mail address, a URL
// with a token in its query, a data attribute carrying a sentence, an alt, a title, an
// input value, an inline JSON blob and an HTML comment — and its prose is deliberately
// nonsense built from consonant clusters that occur in no English text, so the check can
// be the strict one: not one FOUR-CHARACTER run of any text node on that page may appear
// anywhere in the report. Natural prose could not be checked that way (a page saying
// "under" would collide with the report's own "under the 75-word floor") and a weaker
// check is what lets a leak through.
// =====================================================================================
{
  const dp = await browser.newPage();
  await dp.setContent("<!doctype html><html lang=\"en\"><body></body></html>");
  await dp.addScriptTag({ path: BUNDLE });
  const r = await dp.evaluate(async () => {
    // Two pages of the same SHAPE and different words. The first holds the secrets; the
    // second has never seen them. A four-character run of the first page's text that turns
    // up in BOTH reports came from the report's own vocabulary — "right-clicked" holds
    // "icke", "examined" holds "exam", the lorem-ipsum filler holds "cons" — and a run that
    // appears in the first report ALONE can only have come from the page. That control is
    // what keeps the check at four characters instead of retreating to a length where
    // nothing collides and nothing is proven.
    const PAGES = [
      {
        vocab: "zqxwkv jhzxvq kzwvqj hxkqvw zqxjhz wkvkzw xvqhxk vqjzqx kzwjhz qvwwkv".split(" "),
        secrets: {
          handle: "quillgrove",
          name: "Marla Quillgrove",
          mail: "marla.quillgrove@zephyrmail.example",
          url: "https://intranet.example/doc?token=HUNTERWOMBAT42",
          note: "Sandsurfer briefing notes",
          alt: "Moonjelly portrait",
          title: "Klaxonberry tooltip",
          value: "Vermillionpaste",
          json: "Tumblewicket",
          comment: "Grubblesnatch draft",
        },
      },
      {
        // Same lengths throughout, so the filler — which is generated from word lengths —
        // comes out identical and every gram of it is accounted for by this control.
        vocab: "bdfghj mnprst vwxzbd fghjmn prstvw xzbdfg hjmnpr stvwxz bdfghj mnprst".split(" "),
        secrets: {
          handle: "underbridge",
          name: "Tomas Underbridge",
          mail: "tomas.underbridge@quartzpost.invalid",
          url: "https://internal.invalid/pg?ticket=BADGERLANTERN7",
          note: "Waveglider standing order",
          alt: "Coralfinch engraving",
          title: "Peppergrind caption",
          value: "Saffronbucket",
          json: "Wanderhatch",
          comment: "Pebblescript memo",
        },
      },
    ];
    const mount = ({ vocab, secrets }) => {
      const prose = (n) => Array.from({ length: n }, (_, i) => vocab[i % vocab.length]).join(" ") + ".";
      document.body.innerHTML =
        `<!-- ${secrets.comment} -->` +
        `<script type="application/json">{"owner":"${secrets.json}","by":"${secrets.name}"}</script>` +
        `<nav class="site-nav"><a href="${secrets.url}">${prose(12)}</a></nav>` +
        `<main><article class="post" data-note="${secrets.note}" data-testid="postBody">` +
        `<h2>${prose(4)}</h2>` +
        `<p title="${secrets.title}">${prose(80)}</p>` +
        `<p>${prose(80)}</p>` +
        // A person's name in all three of the places an identifier can carry one.
        `<div class="byline author-${secrets.handle}" id="thread-${secrets.handle}" ` +
        `data-testid="${secrets.handle}Panel"><span>${prose(3)}</span></div>` +
        `<img alt="${secrets.alt}" src="${secrets.url}" width="40" height="40">` +
        `<form><input value="${secrets.value}"><textarea>${prose(8)}</textarea></form>` +
        `<address>${secrets.name} &lt;${secrets.mail}&gt;</address>` +
        `<pre><code>${secrets.json} = "${secrets.value}";\nif (${secrets.json}) { run(); }</code></pre>` +
        `</article></main>`;
    };
    const env = () => ({
      version: "0.0.0-test",
      manifestVersion: 3,
      uiLanguage: "en",
      messageLocale: "en",
      analysisScope: "page",
      mergeShorts: true,
      displayMode: "all",
      siteRule: null,
      globallyEnabled: true,
      daemon: { state: "up", model: "test-model 1 (calibration none)" },
      running: true,
      onceForPage: false,
      pdf: false,
      docs: null,
      counts: { scored: 0, flagged: 0, unsupported: 0, unavailable: 0 },
      frameGate: { minWidth: 200, minArea: 40000 },
      clickedFrameId: 0,
      target: document.querySelector("article"),
      detectLanguage: async () => null,
    });
    /** Every four-character run of letters/digits in every text node now in the page. */
    const gramsOfPage = () => {
      const grams = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        for (const run of (n.textContent ?? "").match(/[\p{L}\p{Nd}]+/gu) ?? []) {
          for (let i = 0; i + 4 <= run.length; i++) grams.add(run.slice(i, i + 4).toLowerCase());
        }
      }
      return grams;
    };

    mount(PAGES[0]);
    const grams = gramsOfPage();
    const report = await PW.buildDiagnostics(env());
    mount(PAGES[1]);
    const control = (await PW.buildDiagnostics(env())).toLowerCase();

    const lower = report.toLowerCase();
    const leakedGrams = [...grams].filter((g) => lower.includes(g) && !control.includes(g));
    const leakedSecrets = Object.values(PAGES[0].secrets).filter(
      (s) => report.includes(s) || lower.includes(s.toLowerCase()),
    );

    return {
      report,
      bytes: new TextEncoder().encode(report).length,
      grams: grams.size,
      leakedGrams: leakedGrams.slice(0, 8).map((g) => `${g} @ …${report.slice(Math.max(0, lower.indexOf(g) - 30), lower.indexOf(g) + 20)}…`),
      leakedSecrets,
      hasSections: ["# Anagram page diagnostics", "## Counts", "## Why the rest is silent", "## Frames", "## Structure"].every(
        (h) => report.includes(h),
      ),
      // The shape survives even though the words do not: two paragraphs of eighty words
      // each are two units, and the capture keeps the elements that made them.
      structureKeeps: /<article[^>]*class="post"/.test(report) && /<p[^>]*>/.test(report),
      dropsUrls: !report.includes("href") && !report.includes("intranet"),
      dropsAlt: !report.includes("alt="),
      keepsTestId: report.includes('data-testid="postBody"'),
      // The planted name is gone from class, id and test id, and what is left is its
      // SHAPE — ten letters — beside the structural words the report is allowed to say.
      keepsShape:
        /class="byline author-x10"/.test(report) &&
        /id="thread-x10"/.test(report) &&
        /data-testid="x10Panel"/.test(report),
    };
  });
  await dp.close();
  results.push({
    name: "diagnostics: not one 4-character run of the page's text appears in the report",
    ok: r.leakedGrams.length === 0 && r.grams > 50,
    note: `${r.grams} grams checked, leaked ${JSON.stringify(r.leakedGrams)}`,
  });
  results.push({
    name: "diagnostics: the name, the e-mail, the tokened URL, the data attribute, the alt, the title, the input value, the JSON blob and the comment are all absent",
    ok: r.leakedSecrets.length === 0,
    note: JSON.stringify(r.leakedSecrets),
  });
  results.push({
    name: "diagnostics: URLs and alt text are dropped outright, while the markup a fixture needs survives",
    ok: r.dropsUrls && r.dropsAlt && r.structureKeeps && r.keepsTestId,
    note: JSON.stringify({ dropsUrls: r.dropsUrls, dropsAlt: r.dropsAlt, structureKeeps: r.structureKeeps, keepsTestId: r.keepsTestId }),
  });
  results.push({
    name: "diagnostics: a name in a class, an id or a test id is replaced by its shape, and the structural words survive",
    ok: r.keepsShape,
    note: (r.report.match(/class="byline[^"]*"|id="thread[^"]*"|data-testid="[^"]*Panel"/g) ?? []).join(" ") || "no trace of the planted element",
  });
  results.push({
    name: "diagnostics: the report carries its five sections and stays under the 60 kB a chat will take",
    ok: r.hasSections && r.bytes <= 60_000,
    note: `${r.bytes} bytes`,
  });
}

// ---- diagnostics: which subframes the content script reaches ------------------------------
// A srcdoc or about:blank frame takes the page's origin, and the registration follows it
// there (matchOriginAsFallback); a sandboxed frame has no origin and is left alone.
{
  const fp = await browser.newPage();
  await fp.setContent("<!doctype html><html lang=\"en\"><body></body></html>");
  await fp.addScriptTag({ path: BUNDLE });
  const frames = await fp.evaluate(async () => {
    document.body.innerHTML = `<article><p>A page with frames.</p></article>` +
      `<iframe srcdoc="<p>A chapter.</p>" width="640" height="300"></iframe>` +
      `<iframe width="640" height="300"></iframe>` +
      `<iframe sandbox srcdoc="<p>Sandboxed.</p>" width="640" height="300"></iframe>` +
      `<iframe src="data:text/html,x" width="640" height="300"></iframe>`;
    const report = () => PW.buildDiagnostics({
      version: "0.0.0-test", manifestVersion: 3, uiLanguage: "en", messageLocale: "en", analysisScope: "page",
      mergeShorts: true, displayMode: "all", siteRule: null, globallyEnabled: true, daemon: { state: "up" },
      running: true, onceForPage: false, pdf: false, docs: null, counts: { scored: 0, flagged: 0, unsupported: 0, unavailable: 0 },
      frameGate: { minWidth: 200, minArea: 40000 }, clickedFrameId: 0,
      target: null, detectLanguage: async () => null,
    }).then((text) => text.split("\n").filter((l) => /^ {2}- (srcdoc|about:blank|data:)/.test(l)));
    return await report();
  });
  const runs = (l) => l.includes("our content script runs there");
  results.push({
    name: "diagnostics: srcdoc and about:blank frames run the content script, a sandboxed or data: frame never",
    ok: frames.length === 4 && runs(frames[0]) && runs(frames[1]) && !runs(frames[2]) && frames[2].includes("sandboxed") && !runs(frames[3]),
    note: JSON.stringify(frames),
  });
  await fp.close();
}

// ---- reading surfaces: sites that show a document the walk cannot read (lib/surfaces/) --------
await surfaceChecks(browser, BUNDLE, FIXTURES, results);

await browser.close();

let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note && !r.ok ? `  —  ${r.note}` : ""}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} unit checks passed`);
process.exit(pass === results.length ? 0 : 1);
