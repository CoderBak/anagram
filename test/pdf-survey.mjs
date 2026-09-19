// test/pdf-survey.mjs — what does lib/pdf/reflow.ts make of REAL PDFs?
//
// test/node/pdf-reflow.test.ts pins the rules against pages built by hand, which is the
// only way to test them; this is the other half, in the spirit of test/coverage.mjs: take
// a handful of public documents — a two-column paper, a single-column one, an RFC, a
// report — run the extractor and the reflow over them under Node, and report numbers that
// say whether the paragraphs came back whole. Nothing here asserts and nothing here is in
// CI: it is a magnifying glass for finding the next fixture, and every finding worth
// keeping should end up as a synthetic page in the vitest file.
//
// The numbers, per document:
//
//   pages / blocks / headings         — how much structure came out at all;
//   unfinished  — paragraphs ending in no sentence punctuation, the proxy for a
//                 paragraph cut in half at a column or page break (a few are legitimate:
//                 headings set as paragraphs, table rows, addresses, formulae);
//   lower-start — paragraphs opening in lower case, the proxy for the opposite mistake,
//                 a continuation that was never joined back on (or, just as often, a
//                 correct refusal to join across an intervening figure);
//   hyphen-gaps — "in- depth" left in the text: a break the mender never saw;
//   fused-risk  — words of 12 letters or more with no vowel run a real word has, the
//                 cheapest signal there is for "indepth"-style damage;
//   short/long  — the five shortest and five longest paragraphs, first 80 characters,
//                 where furniture welded to prose and front matter show themselves.
//
//   node test/pdf-survey.mjs                            # the default documents
//   node test/pdf-survey.mjs --dir ~/pdfs               # every .pdf in a folder
//   node test/pdf-survey.mjs --reflow /tmp/old.ts       # another build of the rules
//   node test/pdf-survey.mjs --label before             # → pdf-survey-before.json
//   node test/pdf-survey.mjs --diff a.json b.json       # what changed between two runs
//
// Downloads land in ANAGRAM_PDFS (default: a scratch folder outside the repo) and the
// report in ANAGRAM_ARTIFACTS. Neither a PDF nor its text ever goes into the repo.
import { buildSync } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ARTIFACTS = process.env.ANAGRAM_ARTIFACTS || tmpdir();
const PDFS = process.env.ANAGRAM_PDFS || join(tmpdir(), "anagram-pdfs");

/** Public documents, chosen for their layouts rather than their contents. */
const DOCUMENTS = [
  ["paper-two-column", "https://arxiv.org/pdf/1810.04805v2"],
  ["paper-single-column", "https://arxiv.org/pdf/1706.03762v7"],
  ["paper-two-column-physics", "https://arxiv.org/pdf/2106.02024v2"],
  ["paper-report-style", "https://arxiv.org/pdf/2302.13971v1"],
  ["rfc", "https://www.rfc-editor.org/rfc/rfc9110.pdf"],
];

// ---- command line ----------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? true : v;
};
const diff = opt("diff", null);
const label = opt("label", null);
const dir = opt("dir", null);
const reflowSource = opt("reflow", join(ROOT, "lib/pdf/reflow.ts"));
const maxPages = Number(opt("pages", 40));
const only = argv.filter((a) => !a.startsWith("--"));

// ---- the rules under test ---------------------------------------------------------------

/** Bundle the reflow out of the tree, exactly as test/unit.mjs bundles the walker. */
async function loadReflow(source) {
  const out = join(tmpdir(), `anagram-reflow-${Date.now()}.mjs`);
  buildSync({ entryPoints: [source], bundle: true, format: "esm", outfile: out, logLevel: "warning" });
  return import(pathToFileURL(out).href);
}

/**
 * The same page → runs mapping lib/pdf/extract.ts makes in the browser, against the
 * legacy build, which is the one that runs under Node. Kept in step with extract.ts by
 * hand: it is six lines, and a survey that shared the extension's module would have to
 * drag in the whole WXT environment to read a file.
 */
const ROTATION_EPSILON = 0.02;
async function extract(pdfjs, doc, n) {
  const p = await doc.getPage(n);
  const viewport = p.getViewport({ scale: 1 });
  const content = await p.getTextContent();
  const items = [];
  for (const it of content.items) {
    if (!("str" in it)) continue;
    const m = pdfjs.Util.transform(viewport.transform, it.transform);
    items.push({
      str: it.str,
      x: m[4],
      y: m[5],
      width: it.width,
      height: it.height,
      fontName: it.fontName,
      hasEOL: it.hasEOL,
      rotated: Math.abs(m[1]) > ROTATION_EPSILON || Math.abs(m[2]) > ROTATION_EPSILON,
    });
  }
  p.cleanup();
  return { page: n, width: viewport.width, height: viewport.height, items };
}

// ---- the measurements -------------------------------------------------------------------

const SENTENCE_END = /[.!?。！？…:;](["'”’)\]]|\s)*$/u;
/** "in- depth": a hyphen that kept its space, so no mender ever saw the break. */
const HYPHEN_GAP = /\p{L}[-‐]\s\p{L}/gu;
/** A long word with no vowel in its second half — what "indepth" and "followup" are not. */
const LONG_WORD = /\p{L}{12,}/gu;

function measure(name, pages, blocks, ms) {
  const paragraphs = blocks.filter((b) => b.kind === "paragraph");
  const words = (t) => t.split(/\s+/).length;
  const unfinished = paragraphs.filter((p) => !SENTENCE_END.test(p.text));
  const lowerStart = paragraphs.filter((p) => /^\p{Ll}/u.test(p.text));
  const text = blocks.map((b) => b.text).join("\n");
  const sorted = [...paragraphs].sort((a, b) => words(a.text) - words(b.text));
  const head = (p) => `${words(p.text)}w p${p.page} ${p.text.slice(0, 80)}`;
  return {
    name,
    ms,
    pages,
    blocks: blocks.length,
    headings: blocks.length - paragraphs.length,
    paragraphs: paragraphs.length,
    words: paragraphs.reduce((n, p) => n + words(p.text), 0),
    scorable: paragraphs.filter((p) => words(p.text) >= 50).length,
    unfinished: share(unfinished.length, paragraphs.length),
    lowerStart: share(lowerStart.length, paragraphs.length),
    hyphenGaps: (text.match(HYPHEN_GAP) ?? []).length,
    longWords: [...new Set(text.match(LONG_WORD) ?? [])].length,
    shortest: sorted.slice(0, 5).map(head),
    longest: sorted.slice(-5).reverse().map(head),
  };
}

const share = (n, total) => (total === 0 ? 0 : Number((n / total).toFixed(3)));

// ---- getting the documents ---------------------------------------------------------------

async function fetchTo(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return file;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
    return file;
  } finally {
    clearTimeout(timer);
  }
}

// ---- the run ------------------------------------------------------------------------------

if (diff) {
  const [a, b] = [diff, argv.shift()].map((f) => JSON.parse(readFileSync(f, "utf8")));
  const byName = new Map(a.map((r) => [r.name, r]));
  for (const after of b) {
    const before = byName.get(after.name);
    if (!before) continue;
    const moved = ["blocks", "headings", "paragraphs", "scorable", "unfinished", "lowerStart", "hyphenGaps", "longWords"]
      .map((k) => (before[k] === after[k] ? null : `${k} ${before[k]} → ${after[k]}`))
      .filter(Boolean);
    console.log(`${after.name}: ${moved.length === 0 ? "unchanged" : moved.join(", ")}`);
  }
  process.exit(0);
}

mkdirSync(PDFS, { recursive: true });
mkdirSync(ARTIFACTS, { recursive: true });

const { reflowPdf } = await loadReflow(reflowSource);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const wanted = dir
  ? readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => [basename(f, ".pdf"), join(dir, f)])
  : DOCUMENTS;
const rows = [];

for (const [name, source] of wanted) {
  if (only.length > 0 && !only.some((o) => name.includes(o))) continue;
  let file = source;
  try {
    if (/^https?:/.test(source)) file = await fetchTo(source, join(PDFS, `${name}.pdf`));
  } catch (e) {
    console.log(`${name}: could not be fetched — ${String(e)}`);
    continue;
  }
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(file)),
      disableFontFace: true,
      useSystemFonts: false,
      useWasm: false,
      useWorkerFetch: false,
      verbosity: 0,
    }).promise;
    const count = Math.min(doc.numPages, maxPages);
    const pages = [];
    for (let n = 1; n <= count; n++) pages.push(await extract(pdfjs, doc, n));
    const started = performance.now();
    const blocks = reflowPdf(pages);
    const ms = Math.round(performance.now() - started);
    await doc.destroy();
    const row = measure(name, count, blocks, ms);
    rows.push(row);
    console.log(
      `\n${row.name}  ${row.pages}p  ${row.blocks} blocks (${row.headings} headings, ${row.scorable} scorable)  ${row.ms} ms`,
    );
    console.log(
      `  unfinished ${row.unfinished}  lower-start ${row.lowerStart}  hyphen-gaps ${row.hyphenGaps}  long words ${row.longWords}`,
    );
    for (const s of row.shortest) console.log(`  short  ${s}`);
    for (const s of row.longest) console.log(`  long   ${s}`);
  } catch (e) {
    console.log(`${name}: could not be read — ${String(e)}`);
  }
}

if (label) {
  const out = join(ARTIFACTS, `pdf-survey-${label}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\n${out}`);
}
