// Same arXiv abstract in /abs and /html: compare the exact extraction and canonical
// scoring payloads. This checks extraction parity; it does not load or score a model.
// Requires test/.unit-bundle.js from npm run test:unit.
//   node test/abs-vs-html.mjs [arxiv-id ...]
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
let sameRaw = 0, sameCanonical = 0;
console.log("paper        raw identical?  canonical payload identical?");
for (const row of rows) {
  sameRaw += row.absRaw === row.htmlRaw;
  sameCanonical += row.absCanon === row.htmlCanon;
  console.log(`${row.id}  ${row.absRaw === row.htmlRaw ? "yes" : "no"}  ${row.absCanon === row.htmlCanon ? "yes" : "no: " + firstDiff(row.absCanon, row.htmlCanon)}`);
}
function firstDiff(a, b) { let i = 0; while (i < a.length && a[i] === b[i]) i++; return JSON.stringify(a.slice(Math.max(0, i - 15), i + 20)) + " vs " + JSON.stringify(b.slice(Math.max(0, i - 15), i + 20)); }
console.log(`${rows.length} papers · identical raw ${sameRaw}/${rows.length} · identical canonical payload ${sameCanonical}/${rows.length}`);
