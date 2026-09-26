// test/web-bench/corpus.mjs — the web reading benchmark's pages, gathered from public datasets.
//
//   node test/web-bench/corpus.mjs <sources dir> <corpus dir>
//
// Nothing is downloaded here: <sources dir> holds the datasets as their authors publish
// them, unpacked, and this copies the pages and their truth into one layout the bench reads.
// Datasets stay out of the repository.
//
//   wcxb/          WCXB, CC BY 4.0 — https://github.com/murroughfoley/wcx — every page:
//                  7 page types, main content as text, must-include / must-exclude snippets
//   webmainbench.jsonl
//                  WebMainBench, Apache-2.0 — https://github.com/opendatalab/WebMainBench —
//                  English pages only, a fixed sample (SAMPLE.wmb), truth an HTML subtree
//   sigir/combined/
//                  the combined benchmark of Bevendorff et al., SIGIR 2023, Apache-2.0 —
//                  https://github.com/chatnoir-eu/web-content-extraction-benchmark — a fixed
//                  sample per source dataset; its copy of Readability's pages is left out,
//                  the originals come from readability/
//   readability/   Mozilla Readability's test pages, Apache-2.0 — truth is Readability's own
//                  expected output, so it flatters Readability and never decides a comparison
//   webseg/webis-webseg-20/
//                  Webis-WebSeg-20, CC BY 4.0 — segment boundaries only (no main content):
//                  every text node's segment, from the majority-vote polygons
//
// Only pages set mostly in Latin script are kept: the metrics count words by letter runs,
// which a CJK page does not have, and the product reads English. Samples are the first
// pages in SHA-1 order of their id, so a rebuild picks the same pages.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";

const [SOURCES, CORPUS] = process.argv.slice(2);
if (!SOURCES || !CORPUS) throw new Error("usage: corpus.mjs <sources dir> <corpus dir>");

const SAMPLE = { wmb: { Normal: 400, Conversational: 200 }, sigirPerSource: 150, webseg: 400 };

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
export const safe = (id) => id.replace(/[^\w.-]+/g, "_");

/** Share of letters that are Latin script (ASCII or Latin-1/Extended). */
function latinShare(text) {
  let latin = 0, letters = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  return letters === 0 ? 0 : latin / letters;
}
const isLatin = (text) => latinShare(text.slice(0, 20000)) >= 0.9;

/** Valid UTF-8 or not: a page that is gets `charset=utf-8`, the rest are left to the
 *  browser's own detection (their `<meta charset>`, or the legacy default). */
function charsetOf(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return "utf-8";
  } catch {
    return null;
  }
}

mkdirSync(join(CORPUS, "pages"), { recursive: true });
mkdirSync(join(CORPUS, "truth"), { recursive: true });
const manifest = [];
const skipped = {};

function add(entry, html, truth) {
  const file = safe(entry.id);
  const buf = Buffer.isBuffer(html) ? html : Buffer.from(html, "utf8");
  writeFileSync(join(CORPUS, "pages", `${file}.html`), buf);
  writeFileSync(join(CORPUS, "truth", `${file}.json`), JSON.stringify(truth));
  manifest.push({ charset: charsetOf(buf), ...entry, page: `pages/${file}.html`, truth: `truth/${file}.json` });
}
const skip = (dataset, why) => {
  skipped[dataset] ??= {};
  skipped[dataset][why] = (skipped[dataset][why] ?? 0) + 1;
};

// ---- WCXB -------------------------------------------------------------------------------

function wcxb() {
  const root = join(SOURCES, "wcxb");
  const meta = JSON.parse(readFileSync(join(root, "metadata.json"), "utf8")).files;
  for (const [fileId, m] of Object.entries(meta)) {
    const gt = JSON.parse(readFileSync(join(root, m.split, "ground-truth", `${fileId}.json`), "utf8"));
    const g = gt.ground_truth;
    // A page with no main content at all is kept: nothing on it should be read.
    const text = g.main_content ?? "";
    if (text.trim() && !isLatin(text)) { skip("wcxb", "not Latin script"); continue; }
    const html = gunzipSync(readFileSync(join(root, m.split, "html", `${fileId}.html.gz`)));
    add(
      { id: `wcxb/${fileId}`, dataset: "wcxb", type: m.page_type, url: gt.url, licence: "CC-BY-4.0", upstreamSplit: m.split },
      html,
      { kind: "text", text, with: g.with ?? [], without: g.without ?? [] },
    );
  }
}

// ---- WebMainBench -------------------------------------------------------------------------

async function webmainbench() {
  const path = join(SOURCES, "webmainbench.jsonl");
  const picked = { Normal: [], Conversational: [] };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (d.meta?.language !== "en") continue;
    const style = d.meta?.style === "Conversational" ? "Conversational" : "Normal";
    picked[style].push({ key: sha1(`wmb/${d.track_id}`), d });
    // Keep the memory bounded: only the best-ranked candidates can end up in the sample.
    if (picked[style].length > SAMPLE.wmb[style] * 4) {
      picked[style].sort((a, b) => (a.key < b.key ? -1 : 1));
      picked[style].length = SAMPLE.wmb[style] * 2;
    }
  }
  for (const [style, list] of Object.entries(picked)) {
    list.sort((a, b) => (a.key < b.key ? -1 : 1));
    let n = 0;
    for (const { d } of list) {
      if (n >= SAMPLE.wmb[style]) break;
      if (!isLatin(d.convert_main_content ?? "")) { skip("wmb", "not Latin script"); continue; }
      n++;
      add(
        { id: `wmb/${d.track_id}`, dataset: "wmb", type: style === "Conversational" ? "conversational" : "mixed", level: d.meta.level, url: d.url, licence: "Apache-2.0" },
        d.html,
        { kind: "html", html: d.main_html },
      );
    }
  }
}

// ---- SIGIR 2023 combined -----------------------------------------------------------------

function sigir() {
  const root = join(SOURCES, "sigir", "combined");
  for (const file of readdirSync(join(root, "ground-truth")).sort()) {
    const source = file.replace(/\.jsonl$/, "");
    if (source === "readability") continue; // the originals come from Mozilla's own tests
    const rows = readFileSync(join(root, "ground-truth", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    rows.sort((a, b) => (sha1(`sigir/${source}/${a.page_id}`) < sha1(`sigir/${source}/${b.page_id}`) ? -1 : 1));
    let n = 0;
    for (const row of rows) {
      if (n >= SAMPLE.sigirPerSource) break;
      const text = row.plaintext ?? "";
      if (text.split(/\s+/).filter(Boolean).length < 20) { skip("sigir", "truth under 20 words"); continue; }
      if (!isLatin(text)) { skip("sigir", "not Latin script"); continue; }
      const htmlPath = join(root, "html", source, `${row.page_id}.html`);
      if (!existsSync(htmlPath)) { skip("sigir", "no html"); continue; }
      n++;
      add(
        { id: `sigir/${source}/${row.page_id.slice(0, 16)}`, dataset: "sigir", type: source, url: row.url ?? null, licence: "Apache-2.0" },
        readFileSync(htmlPath),
        { kind: "text", text },
      );
    }
  }
}

// ---- Mozilla Readability test pages -------------------------------------------------------

function readability() {
  const root = join(SOURCES, "readability", "test", "test-pages");
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "expected.html"))) continue;
    const expected = readFileSync(join(dir, "expected.html"), "utf8");
    if (!isLatin(expected.replace(/<[^>]+>/g, " "))) { skip("readability", "not Latin script"); continue; }
    add(
      { id: `readability/${name}`, dataset: "readability", type: "article", url: null, licence: "Apache-2.0" },
      readFileSync(join(dir, "source.html")),
      { kind: "html", html: expected },
    );
  }
}

// ---- Webis-WebSeg-20 ------------------------------------------------------------------------

/** Ray casting over one ring. */
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** A multipolygon: a list of polygons, each an outer ring and then its holes. */
const inMultiPolygon = (x, y, mp) => mp.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole)));

function csvRows(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function webseg() {
  const root = join(SOURCES, "webseg", "webis-webseg-20");
  const ids = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => (sha1(`webseg/${a}`) < sha1(`webseg/${b}`) ? -1 : 1));
  let n = 0;
  for (const pid of ids) {
    if (n >= SAMPLE.webseg) break;
    const dir = join(root, pid);
    if (!["dom.html", "nodes.csv", "nodes-texts.csv", "ground-truth.json"].every((f) => existsSync(join(dir, f)))) { skip("webseg", "incomplete"); continue; }
    const texts = csvRows(readFileSync(join(dir, "nodes-texts.csv"), "utf8")).slice(1);
    const all = texts.map((r) => r[2] ?? "").join(" ");
    if (all.split(/\s+/).filter(Boolean).length < 200) { skip("webseg", "under 200 words"); continue; }
    if (!isLatin(all)) { skip("webseg", "not Latin script"); continue; }
    const gt = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8"));
    const segments = gt.segmentations["majority-vote"] ?? [];
    const seg = {};
    for (const r of csvRows(readFileSync(join(dir, "nodes.csv"), "utf8")).slice(1)) {
      const [left, bottom, right, top, xpath] = r;
      if (!xpath || !xpath.includes("text()")) continue;
      const x = (Number(left) + Number(right)) / 2, y = (Number(top) + Number(bottom)) / 2;
      seg[xpath] = segments.findIndex((mp) => inMultiPolygon(x, y, mp));
    }
    // The dataset numbers an element among its RENDERED siblings of the same tag, under the
    // page's own stylesheets, so a hidden sibling shifts every path below it. Each text
    // node's text is kept too: bench.mjs falls back to the same text under the same tags.
    const text = {};
    for (const [xpath, , t] of texts) if (xpath && seg[xpath] !== undefined) text[xpath] = t.replace(/\s+/g, " ").trim();
    n++;
    add(
      { id: `webseg/${pid}`, dataset: "webseg", type: "segments", url: null, licence: "CC-BY-4.0", width: gt.width },
      readFileSync(join(dir, "dom.html")),
      { kind: "segments", segments: segments.length, seg, text },
    );
  }
}

wcxb();
await webmainbench();
sigir();
readability();
webseg();
writeFileSync(join(CORPUS, "manifest.json"), JSON.stringify(manifest, null, 1));
const counts = {};
for (const e of manifest) counts[`${e.dataset}/${e.type}`] = (counts[`${e.dataset}/${e.type}`] ?? 0) + 1;
console.log(JSON.stringify({ pages: manifest.length, counts, skipped }, null, 1));
