// test/pdf-bench/olmocr.mjs — the reader's reading of olmOCR-Bench's pages, for its unit tests.
//
//   node test/pdf-bench/olmocr.mjs <bench_data> <out> [--structure <zotero-dump dir>] [--subsets a,b] [--diagnose]
//   python3 test/pdf-bench/olmocr-check.py <olmocr/bench/tests.py> <bench_data> <out>/<reading> …
//
// olmOCR-Bench (https://huggingface.co/datasets/allenai/olmOCR-bench, ODC-BY) is single PDF
// pages with pass/fail tests on the text a system gives for each: a sentence must be present,
// a running head or a page number absent, one passage must come before another. Its
// multi_column, headers_footers and long_tiny_text subsets say how a reading treats columns,
// page furniture and small print on documents that are not arXiv's; its maths and table tests
// ask for LaTeX and table markup the reader never writes and are not run.
//
// Each page is read as the reader reads it, every page rendered: the structured path
// (Zotero's structure from zotero-dump.mjs, run over <bench_data> with a manifest.json of
// the PDFs, through lib/pdf/structured.ts) and the reflow the reader falls back to
// (lib/pdf/reading.ts). A page's text is what the reader READS — its headings and paragraphs
// in order, "\n\n" between them — in `<reading>/`, and what it SCORES — the units of at least
// the evidence floor — in `<reading>-scored/`; one file per page, named as olmOCR's own
// benchmark names a candidate's (<pdf>_pg1_repeat1.md). --diagnose adds the page's whole
// text layer (`text-layer/`) and every block Zotero found (`structured-all/`), to tell a
// test the reader fails from one no text-based reading could pass or one it fails by design.
// olmocr-check.py runs the upstream
// checker's own test classes over them, offline. Never in CI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPipeline, readPages } from "./anagram.mjs";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : null);
const [data, out] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const SUBSETS = (flag("subsets") ?? "headers_footers,long_tiny_text,multi_column").split(",");
const raw = flag("structure");
const diagnose = argv.includes("--diagnose");
const safe = (id) => id.replace(/[^\w.-]+/g, "_");

const engine = await loadPipeline();
const { pipeline } = engine;
const pdfs = new Set();
for (const subset of SUBSETS) {
  for (const line of readFileSync(join(data, `${subset}.jsonl`), "utf8").split("\n")) {
    if (line.trim()) pdfs.add(JSON.parse(line).pdf);
  }
}

const write = (reading, pdf, blocks) => {
  const name = `${pdf.replace(/\.pdf$/, "")}_pg1_repeat1.md`;
  const text = blocks.map((b) => b.text).join("\n\n");
  const units = pipeline.unitsOf(blocks).filter((u) => u.words >= pipeline.MIN_WORDS).map((u) => u.text).join("\n\n");
  for (const [dir, body] of [[reading, text], [`${reading}-scored`, units]]) {
    const file = join(out, dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${body}\n`);
  }
};

let n = 0;
for (const pdf of [...pdfs].sort()) {
  n++;
  const file = join(data, "pdfs", pdf);
  if (!existsSync(file)) { console.log(`${pdf} missing`); continue; }
  try {
    const { pages } = await readPages(engine, file, { fonts: true });
    write("reflow", pdf, pipeline.reflowRuns([pages]));
    // What the page's text layer holds at all, in content order: a test this fails too asks
    // for text the PDF does not carry (a scan without OCR, OCR errors).
    if (diagnose) write("text-layer", pdf, [{ text: pages.map((p) => p.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(" ")).join("\n") }]);
    const dump = raw && join(raw, `${safe(pdf.replace(/\.pdf$/, ""))}.json`);
    if (dump && existsSync(dump)) {
      const z = JSON.parse(readFileSync(dump, "utf8"));
      if (z.structure) write("structured", pdf, pipeline.structuredBlocks(z.structure, pages));
      // Every block Zotero found, whatever it called it: what the reader chose to leave out.
      if (z.structure && diagnose) {
        const all = pipeline.structuredBlocks(z.structure, pages, { everything: true });
        write("structured-all", pdf, all);
        writeFileSync(join(out, "structured-all", `${pdf.replace(/\.pdf$/, "")}.blocks.json`), JSON.stringify(all.map((b) => ({ origin: b.origin, kind: b.kind, text: b.text }))));
      }
      else console.log(`${pdf}: no structure`);
    }
  } catch (error) {
    console.log(`${pdf} FAILED ${error?.message ?? error}`);
  }
  if (n % 50 === 0) console.log(`${n}/${pdfs.size}`);
}
console.log(`${n} pages`);
