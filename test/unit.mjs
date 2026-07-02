// test/unit.mjs — fast unit tests for the walker/assembler + pure text utils.
//
// The walker classifies layout via getComputedStyle, which jsdom cannot fake —
// so the "unit" harness is a real Chromium page: esbuild bundles lib/dom (+ a few
// pure helpers) into an IIFE global `PW`, the bundle is injected into a blank
// page, and table-driven DOM cases run in-page. No extension load, no network:
// the whole suite runs in a few seconds.
//
//   node test/unit.mjs
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUNDLE = join(__dirname, ".unit-bundle.js");

execFileSync(
  join(ROOT, "node_modules", ".bin", "esbuild"),
  [join(__dirname, "unit-entry.ts"), "--bundle", "--format=iife", "--global-name=PW", `--outfile=${BUNDLE}`],
  { stdio: "pipe" },
);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: BUNDLE });

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

  // ---- pure text utils ---------------------------------------------------------------
  const long = (words(40) + " ").repeat(30);
  const t = PW.truncateForScoring(long);
  check("truncateForScoring caps at ~4000 on a sentence end", t.length <= 4000 && /[.!?。！？]$/.test(t.trim()), `len=${t.length}`);

  check("countWords counts CJK", PW.countWords("这是一个测试句子。") >= 4, PW.countWords("这是一个测试句子。"));
  check("symbolNoiseRatio flags box drawing", PW.symbolNoiseRatio("+----+----+ | cell |") > 0.2, PW.symbolNoiseRatio("+----+----+ | cell |").toFixed(2));
  check("symbolNoiseRatio passes prose", PW.symbolNoiseRatio("A well-known state-of-the-art result.") < 0.2, PW.symbolNoiseRatio("A well-known state-of-the-art result.").toFixed(2));
  check("hasColumnGaps: header layout", PW.hasColumnGaps("RFC 768          J. Postel") === true);
  check("hasColumnGaps: newline-guarded", PW.hasColumnGaps("end\n         start") === false);

  const d1 = PW.detectDocsPage(new URL("https://docs.google.com/document/u/0/d/abc-123/edit?tab=t.2"));
  const d2 = PW.detectDocsPage(new URL("https://docs.google.com/document/d/abc/mobilebasic"));
  const d3 = PW.detectDocsPage(new URL("https://docs.google.com/spreadsheets/d/abc/edit"));
  check("detectDocsPage editor/reading/none", d1?.kind === "editor" && d2?.kind === "reading" && d3 === null, JSON.stringify([d1, d2, d3]));

  check("band(): neutral fallback → unknown", PW.band({ id: "x", detected: false, theta_interval: [0, 1], e_theta: 0.5, p_value: 1 }) === "unknown");
  check("band(): detected → ai", PW.band({ id: "x", detected: true, theta_interval: [0.6, 0.9], e_theta: 0.8, p_value: 0.001 }) === "ai");

  sandbox.remove();
  return out;
});

await browser.close();

let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note && !r.ok ? `  —  ${r.note}` : ""}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} unit checks passed`);
process.exit(pass === results.length ? 0 : 1);
