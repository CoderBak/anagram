// test/abs-vs-html.mjs — same abstract, two renderings: does the pipeline send the model the
// same bytes? For each arXiv id, the abstract is extracted from the /abs page and from the
// HTML rendering with the extension's own walker, its canonical scoring form
// (canonicalForScoring) is scored by the daemon, and the two are compared. The extension
// itself sends an abstract longer than one window as several blocks cut from that same text;
// here each abstract stays ONE block, because the question is whether the two renderings
// agree, not how a long one is read. Residual gaps are content differences
// (paper versions, arXiv's URL rewriting, paragraph segmentation) or the model's own
// sensitivity — not extraction. Needs `npm run serve` and a fresh test/.unit-bundle.js
// (`npm run test:unit` builds it).
//
//   node test/abs-vs-html.mjs                 # 12 recent cs.CL papers + 2212.10001
//   node test/abs-vs-html.mjs 2212.10001 2609.12191
import { launchPlain } from "./harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, ".unit-bundle.js");
const argIds = process.argv.slice(2);
const listing = argIds.length ? "" : await fetch("https://arxiv.org/list/cs.CL/recent?skip=0&show=50", { headers: { "user-agent": "Mozilla/5.0" } }).then((r) => r.text(), () => "");
const ids = argIds.length ? argIds : [...new Set([...listing.matchAll(/abs\/(\d{4}\.\d{5})/g)].map((m) => m[1]))].slice(0, 12);
if (!argIds.length) ids.unshift("2212.10001");

/** Prototype canonicalization for the SCORING payload (presentation, not content). */

const browser = await launchPlain();
const rows = [];
async function extract(url, canonical) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(800);
    await page.addScriptTag({ path: BUNDLE });
    await page.evaluate((c) => { window.__canon = c; }, canonical);
    return await page.evaluate(() => {
      const pageAbs = (document.querySelector("blockquote.abstract, .ltx_abstract")?.textContent ?? "").replace(/\s+/g, " ").trim();
      const key = pageAbs.replace(/^Abstract:?\s*/i, "").slice(20, 60);
      const u = PW.collectUnits(document.body).find((u) => u.text.includes(key));
      return u ? (window.__canon ? PW.canonicalForScoring(u.text) : u.text) : null;
    });
  } catch { return null; } finally { await page.close(); }
}
for (const id of ids) {
  const absRaw = await extract(`https://arxiv.org/abs/${id}`, false);
  const htmlRaw = await extract(`https://arxiv.org/html/${id}`, false);
  const absCanon = await extract(`https://arxiv.org/abs/${id}`, true);
  const htmlCanon = await extract(`https://arxiv.org/html/${id}`, true);
  if (!absRaw || !htmlRaw || !absCanon || !htmlCanon) { console.log(`skip ${id} (no html or abstract not found)`); continue; }
  rows.push({ id, absRaw, htmlRaw, absCanon, htmlCanon });
}
await browser.close();
const blocks = rows.flatMap((r) => [["absRaw", r.absRaw], ["htmlRaw", r.htmlRaw], ["absCanon", r.absCanon], ["htmlCanon", r.htmlCanon]].map(([k, text]) => ({ id: `${r.id}:${k}`, text })));
const res = await fetch("http://127.0.0.1:8765/score", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: "2.1", blocks }) }).then((r) => r.json());
const S = Object.fromEntries(res.results.map((x) => [x.id, x]));
const pct = (x) => Math.round(x.score * 100);
let dRaw = 0, dCanon = 0, agreeRaw = 0, agreeCanon = 0, sameText = 0;
console.log("NOTE: raw = the new walker's unit text (markers already skipped); canon = its canonical form, which is what the extension SENDS (whole, or cut into windows)");
console.log("paper       abs raw  html raw  | abs sent   html sent  | payloads identical?");
for (const r of rows) {
  const a = S[`${r.id}:absRaw`], h = S[`${r.id}:htmlRaw`], ac = S[`${r.id}:absCanon`], hc = S[`${r.id}:htmlCanon`];
  dRaw += Math.abs(pct(a) - pct(h)); dCanon += Math.abs(pct(ac) - pct(hc));
  agreeRaw += a.bucket === h.bucket; agreeCanon += ac.bucket === hc.bucket; sameText += r.absCanon === r.htmlCanon;
  console.log(`${r.id}  ${String(pct(a)).padStart(4)}% b${a.bucket}  ${String(pct(h)).padStart(4)}% b${h.bucket}   |  ${String(pct(ac)).padStart(4)}% b${ac.bucket}   ${String(pct(hc)).padStart(4)}% b${hc.bucket}    | ${r.absCanon === r.htmlCanon ? "yes" : "no: " + firstDiff(r.absCanon, r.htmlCanon)}`);
}
function firstDiff(a, b) { let i = 0; while (i < a.length && a[i] === b[i]) i++; return JSON.stringify(a.slice(Math.max(0, i - 15), i + 20)) + " vs " + JSON.stringify(b.slice(Math.max(0, i - 15), i + 20)); }
console.log(`\n${rows.length} papers · mean |Δ| raw ${(dRaw / rows.length).toFixed(1)} pts, canon ${(dCanon / rows.length).toFixed(1)} pts · same verdict raw ${agreeRaw}/${rows.length}, canon ${agreeCanon}/${rows.length} · identical payload after canon ${sameText}/${rows.length}`);
