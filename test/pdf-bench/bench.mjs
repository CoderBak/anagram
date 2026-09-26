// test/pdf-bench/bench.mjs — how well the PDF reader reads papers, measured, not guessed.
//
//   ANAGRAM_PDF_BENCH=<corpus> node test/pdf-bench/bench.mjs run [--name <run>] [--only <id,…>] [--window <pages>]
//   ANAGRAM_PDF_BENCH=<corpus> node test/pdf-bench/bench.mjs zotero <raw dir> [--name <run>] [--features <run>]
//   ANAGRAM_PDF_BENCH=<corpus> node test/pdf-bench/bench.mjs report <run> [<other run>…]
//   ANAGRAM_PDF_BENCH=<corpus> node test/pdf-bench/bench.mjs diff <run> [--worst <n>] [--page <id>:<n>]
//
// The corpus is built by corpus.mjs; results go to <corpus>/../out/<run>/ (or --out):
// docs/<id>.json (blocks with every token's label, units, metrics, per-page figures),
// units/<id>.txt (what would be scored, page by page), summary.md and summary.json, and
// diff/*.html (side by side with the truth) for the pages that fail worst. `zotero`
// scores what zotero-dump.mjs wrote from Zotero's document-worker the same way, taking
// each document's category from an Anagram run, so `report` can set the two side by side.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEAK, alignDocument, lineNumberItems, lineNumbersScored } from "./align.mjs";
import { NEUTRAL, truthOf } from "./truth.mjs";

const CORPUS = process.env.ANAGRAM_PDF_BENCH;
if (!CORPUS) throw new Error("set ANAGRAM_PDF_BENCH to the corpus directory (see corpus.mjs)");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
const OUT = flag("out", join(dirname(CORPUS), "out"));
const manifest = () => JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));

/** A share of the page's body text set across its middle: a one-column page. */
function twoColumnPage(page) {
  const body = page.items.filter((it) => !it.rotated && it.str.trim().length >= 3);
  if (body.length === 0) return null;
  const sizes = body.map((it) => it.height).sort((a, b) => a - b);
  const size = sizes[sizes.length >> 1];
  let left = 0, right = 0, across = 0;
  const mid = page.width / 2;
  for (const it of body) {
    if (Math.abs(it.height - size) > size * 0.15) continue;
    const n = it.str.trim().length;
    if (it.x < mid - 2 && it.x + it.width > mid + 2) across += n;
    else if (it.x + it.width <= mid + 2) left += n;
    else right += n;
  }
  const total = left + right + across;
  if (total < 800) return null;
  return across < total * 0.1 && left > total * 0.25 && right > total * 0.25;
}

const WORD_MADE = /microsoft|word|pdfmaker|libreoffice|openoffice|google docs|quartz|pages|wps|aspose|itext/i;
const TEX_MADE = /tex|dvips|dvipdf|ghostscript|latex|typst|xetex|luatex/i;

/** What kind of document this is, from the PDF alone (and the truth's own math count). */
function featuresOf(run, truthMetrics) {
  const cols = run.pages.map(twoColumnPage).filter((v) => v !== null);
  const numbered = lineNumberItems(run.pages);
  const withNumbers = [...numbered.values()].filter((s) => s.size >= 12).length;
  return {
    twoColumn: cols.length > 0 && cols.filter(Boolean).length >= cols.length * 0.5,
    lineNumbered: withNumbers >= Math.max(1, run.pages.length * 0.5),
    wordMade: isWordMade(run.producer, run.creator),
    mathShare: truthMetrics ? truthMetrics.math / Math.max(1, truthMetrics.body) : null,
  };
}

/** Category tags a document is reported under. */
function tagsOf(doc) {
  const f = doc.features ?? {};
  const tags = [f.twoColumn ? "two-column" : "one-column"];
  if (f.mathShare !== null && f.mathShare >= FORMULA_HEAVY) tags.push("formula-heavy");
  if (f.lineNumbered) tags.push("line-numbered");
  if (f.wordMade) tags.push("word-made");
  for (const c of doc.category ?? []) if (c !== "arxiv-recent") tags.push(c);
  return [...new Set(tags)];
}
/** Math tokens per body token above which a paper is formula-heavy (about the top quarter). */
const FORMULA_HEAVY = 0.6;

const LABEL_CODE = { body: "b", appendix: "a", ack: "k", runin: "r", mark: "m", heading: "h", front: "f", caption: "c", figtext: "t", footnote: "n", reference: "R", "display-math": "D", "inline-math": "I", margin: "M", "line-number": "L", noise: "N", unmatched: "U", duplicate: "2", number: "#", cite: "C" };
const CODE_LABEL = Object.fromEntries(Object.entries(LABEL_CODE).map(([k, v]) => [v, k]));

/**
 * The truth for a document: arXiv's HTML where there is one, else the structure tree of a
 * Word-made PDF or of one the manifest marks `truth: "tagged"` (tagged.mjs), else none —
 * the document is still read and timed, and only the measures that need no truth are
 * reported for it.
 */
async function truthFor(doc, wordMade) {
  if (doc.has_html) return { kind: "html", truth: truthOf(readFileSync(join(CORPUS, doc.html), "utf8")) };
  if (!wordMade && doc.truth !== "tagged") return { kind: null, truth: null };
  const { loadPipeline, documentOptions, MAX_ANALYSIS_PAGES } = await import("./anagram.mjs");
  const { taggedTruthOf } = await import("./tagged.mjs");
  const { pdfjs } = await loadPipeline();
  const data = new Uint8Array(readFileSync(join(CORPUS, doc.file)));
  const truth = await taggedTruthOf(pdfjs, documentOptions(data), MAX_ANALYSIS_PAGES);
  return { kind: truth ? "tagged" : null, truth };
}

const isWordMade = (producer, creator) => WORD_MADE.test(`${producer} ${creator}`) && !TEX_MADE.test(`${producer} ${creator}`);

/** Score one engine's reading of one document and write what was found. */
function scoreDocument(dir, doc, run, { kind, truth }, extra = {}) {
  const aligned = truth ? alignDocument(truth, run) : null;
  const pagesRead = run.pages?.length ?? run.analysedPages ?? 0;
  const record = {
    id: doc.id, category: doc.category, source: doc.source, has_truth: !!truth, truth: kind,
    numPages: run.numPages, analysedPages: pagesRead, producer: run.producer, creator: run.creator,
    features: run.features ?? featuresOf(run, aligned?.metrics.truth),
    timing: run.timing,
    units: {
      count: run.units.length,
      words: run.units.reduce((a, u) => a + u.words, 0),
      blocks: run.blocks.length,
      blocks75: run.words ? run.words.filter((w) => w >= 75).length : null,
      lineNumberTokens: lineNumbersScored(run),
    },
    metrics: aligned?.metrics ?? null,
    pages: aligned?.pages ?? null,
    splits: aligned?.splits ?? [], merges: aligned?.merges ?? [], outOfOrder: aligned?.outOfOrder ?? [],
    blocks: (aligned?.blocks ?? run.blocks).map((b, i) => ({
      page: b.page, kind: b.kind, apart: b.apart, columnBreak: b.columnBreak, unit: aligned ? b.unit : -1, text: b.text,
      ...(aligned ? { ts: b.toks.map((t) => t.s), te: b.toks.map((t) => t.e), tp: b.toks.map((t) => t.page), tg: b.toks.map((t) => t.gt), tl: b.toks.map((t) => LABEL_CODE[t.label] ?? "?").join("") } : { index: i }),
    })),
    unitList: run.units.map((u) => ({ blocks: u.blocks, words: u.words, page: u.page })),
    ...extra,
  };
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "units"), { recursive: true });
  writeFileSync(join(dir, "docs", `${safe(doc.id)}.json`), JSON.stringify(record));
  writeFileSync(join(dir, "units", `${safe(doc.id)}.txt`), unitsText(run));
  return record;
}

function unitsText(run) {
  const lines = [];
  let page = 0;
  run.units.forEach((u, k) => {
    if (u.page !== page) { page = u.page; lines.push(`=== page ${page} ===`); }
    lines.push(`[unit ${k} · ${u.words} words · ${u.blocks.length} paragraph${u.blocks.length > 1 ? "s" : ""}]`);
    lines.push(u.blocks.map((b) => run.blocks[b].text).join("\n\n"), "");
  });
  return `${lines.join("\n")}\n`;
}

const safe = (id) => id.replace(/[^\w.-]+/g, "_");

// ---- run -----------------------------------------------------------------------------

async function run() {
  const { loadPipeline, runAnagram } = await import("./anagram.mjs");
  const name = flag("name", `anagram-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);
  const only = flag("only")?.split(",");
  const window = Number(flag("window", "0"));
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const engine = await loadPipeline();
  const docs = manifest().filter((d) => existsSync(join(CORPUS, d.file)) && (!only || only.includes(d.id)));
  let i = 0;
  for (const doc of docs) {
    i++;
    try {
      const result = await runAnagram(engine, join(CORPUS, doc.file), { window });
      const record = scoreDocument(dir, doc, result, await truthFor(doc, isWordMade(result.producer, result.creator)));
      const m = record.metrics;
      console.log(`${i}/${docs.length} ${doc.id} ${result.pages.length}p ${m ? `cov ${(m.coverage.scored / Math.max(1, m.coverage.body)).toFixed(2)} leak ${m.leak.scoredShare.toFixed(2)} F1 ${m.bounds.f1.toFixed(2)} tau ${m.order.tau.toFixed(2)}` : "(no truth)"}`);
    } catch (error) {
      console.log(`${i}/${docs.length} ${doc.id} FAILED ${error?.message ?? error}`);
      writeFileSync(join(dir, "docs", `${safe(doc.id)}.error`), String(error?.stack ?? error));
    }
  }
  writeFileSync(join(dir, "run.json"), JSON.stringify({ engine: "anagram", window, date: new Date().toISOString() }));
  report([name]);
}

// ---- zotero ----------------------------------------------------------------------------

/**
 * Zotero's body flow as blocks the grouping rules can take: headings, paragraphs, list
 * items and block quotes that carry no flowClass (Zotero's own verdict that a block is a
 * caption, a footnote, a running head, a figure's text…) and are not bibliography
 * entries. A block Zotero marks as the next part of another (a paragraph carried over a
 * column or a page) is joined to it, a line-end hyphen mended. Everything left out is a
 * barrier: nothing is grouped across it.
 */
function zoteroBlocks(content) {
  const text = (n) => (typeof n.text === "string" ? n.text : Array.isArray(n.content) ? n.content.map(text).join(n.type === "blockquote" ? " " : "") : "");
  const blocks = [];
  const byPath = new Map();
  let barrier = true;
  const add = (node, kind, path) => {
    const t = text(node).replace(/\s+/g, " ").trim();
    if (!t) return;
    const page = (node.pageRects?.[0]?.[0] ?? 0) + 1;
    const prev = node.previousPart ? byPath.get(JSON.stringify(node.previousPart)) : null;
    if (prev) {
      prev.text = /\p{L}-$/u.test(prev.text) && /^\p{Ll}/u.test(t) ? prev.text.slice(0, -1) + t : `${prev.text} ${t}`;
      byPath.set(JSON.stringify(path), prev);
      return;
    }
    const last = blocks[blocks.length - 1];
    const block = { kind, text: t, page, apart: false, columnBreak: barrier || !last || last.page !== page, runs: [] };
    barrier = false;
    blocks.push(block);
    byPath.set(JSON.stringify(path), block);
  };
  content.forEach((node, i) => {
    if (node.flowClass || node.reference) { barrier = true; return; }
    if (node.type === "heading") add(node, "heading", [i]);
    else if (node.type === "paragraph" || node.type === "blockquote") add(node, "paragraph", [i]);
    else if (node.type === "list") {
      (node.content ?? []).forEach((item, k) => { if (item.reference) barrier = true; else add(item, "paragraph", [i, k]); });
    } else barrier = true;
  });
  return blocks;
}

async function zotero() {
  const raw = rest[0];
  const name = flag("name", "zotero");
  const base = flag("features") ? new Map(loadRun(flag("features")).docs.map((d) => [d.id, d])) : new Map();
  const { loadPipeline } = await import("./anagram.mjs");
  const { pipeline } = await loadPipeline();
  const dir = join(OUT, name);
  mkdirSync(join(dir, "docs"), { recursive: true });
  for (const doc of manifest()) {
    const file = join(raw, `${safe(doc.id)}.json`);
    if (!existsSync(file)) continue;
    const z = JSON.parse(readFileSync(file, "utf8"));
    if (z.error) { console.log(`${doc.id} FAILED in Zotero`); continue; }
    const blocks = zoteroBlocks(z.content);
    const known = base.get(doc.id);
    const result = {
      numPages: z.pages, analysedPages: z.pages, producer: known?.producer ?? "", creator: known?.creator ?? "",
      blocks, words: pipeline.planWords(blocks), units: pipeline.unitsOf(blocks),
      timing: { totalMs: z.ms }, features: known?.features ?? { twoColumn: false, lineNumbered: false, wordMade: false, mathShare: null },
    };
    const record = scoreDocument(dir, doc, result, await truthFor(doc, result.features.wordMade));
    const m = record.metrics;
    console.log(`${doc.id} ${m ? `cov ${(m.coverage.scored / Math.max(1, m.coverage.body)).toFixed(2)} leak ${m.leak.scoredShare.toFixed(2)} F1 ${m.bounds.f1.toFixed(2)}` : "(no truth)"}`);
  }
  writeFileSync(join(dir, "run.json"), JSON.stringify({ engine: "zotero document-worker", date: new Date().toISOString() }));
  report([name]);
}

// ---- report ----------------------------------------------------------------------------

function loadRun(name) {
  const dir = join(OUT, name);
  const docs = readdirSync(join(dir, "docs")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, "docs", f), "utf8")));
  const meta = existsSync(join(dir, "run.json")) ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) : {};
  return { name, dir, docs, meta };
}

const pct = (x) => (x === null || Number.isNaN(x) ? "—" : `${(100 * x).toFixed(1)}%`);
const num = (x, d = 2) => (x === null || Number.isNaN(x) ? "—" : x.toFixed(d));
const quantile = (xs, p) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
};

/** Everything that is summed over documents: micro-averages, as a token or a boundary counts. */
function aggregate(docs) {
  const scored = docs.filter((d) => d.metrics);
  const sum = (f) => scored.reduce((a, d) => a + f(d.metrics), 0);
  const body = sum((m) => m.coverage.body);
  const scoredTok = sum((m) => m.leak.scored);
  const readTok = sum((m) => m.leak.read);
  const by = {};
  const readBy = {};
  for (const d of scored) {
    for (const [k, v] of Object.entries(d.metrics.leak.scoredBy)) by[k] = (by[k] ?? 0) + v;
    for (const [k, v] of Object.entries(d.metrics.leak.readBy)) readBy[k] = (readBy[k] ?? 0) + v;
  }
  const leaked = LEAK.reduce((a, k) => a + (by[k] ?? 0), 0);
  const readLeaked = LEAK.reduce((a, k) => a + (readBy[k] ?? 0), 0);
  const tp = sum((m) => m.bounds.tp), fp = sum((m) => m.bounds.fp), fn = sum((m) => m.bounds.fn);
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
  const splits = {}, merges = {};
  for (const d of scored) {
    for (const [k, v] of Object.entries(d.metrics.bounds.splits)) splits[k] = (splits[k] ?? 0) + v;
    for (const [k, v] of Object.entries(d.metrics.bounds.merges)) merges[k] = (merges[k] ?? 0) + v;
  }
  const taus = scored.filter((d) => d.metrics.order.paras > 1).map((d) => d.metrics.order.tau);
  const pages = docs.reduce((a, d) => a + d.analysedPages, 0);
  const perPage = docs.flatMap((d) => d.timing?.extractMs ?? []);
  const reflowPerPage = docs.filter((d) => d.analysedPages).map((d) => (d.timing?.reflowMs ?? NaN) / d.analysedPages);
  const totalPerPage = docs.filter((d) => d.analysedPages && d.timing?.totalMs !== undefined).map((d) => d.timing.totalMs / d.analysedPages);
  return {
    docs: docs.length, withTruth: scored.length, pages,
    coverageAll: sum((m) => m.coverage.all) / Math.max(1, body),
    coverageScored: sum((m) => m.coverage.scored) / Math.max(1, body),
    leakScored: leaked / Math.max(1, scoredTok),
    leakRead: readLeaked / Math.max(1, readTok),
    leakScoredNoInline: (leaked - (by["inline-math"] ?? 0)) / Math.max(1, scoredTok),
    leakBy: Object.fromEntries(LEAK.map((k) => [k, (by[k] ?? 0) / Math.max(1, scoredTok)])),
    neutralScored: [...NEUTRAL].reduce((a, k) => a + (by[k] ?? 0), 0) / Math.max(1, scoredTok),
    precision, recall, f1: (2 * precision * recall) / Math.max(1e-9, precision + recall), tp, fp, fn, splits, merges,
    tauMean: taus.reduce((a, b) => a + b, 0) / Math.max(1, taus.length),
    tauMin: taus.length ? Math.min(...taus) : NaN,
    outOfOrder: sum((m) => m.order.outOfOrder), placedParas: sum((m) => m.order.paras),
    backJumps: sum((m) => m.order.backJumps),
    backJumpsPer1k: (1000 * sum((m) => m.order.backJumps)) / Math.max(1, sum((m) => m.coverage.all)),
    units: docs.reduce((a, d) => a + d.units.count, 0),
    unitWords: docs.reduce((a, d) => a + d.units.words, 0),
    blocks: docs.reduce((a, d) => a + d.units.blocks, 0),
    blocks75: docs.reduce((a, d) => a + (d.units.blocks75 ?? 0), 0),
    lineNumberTokens: docs.filter((d) => d.features?.lineNumbered).reduce((a, d) => a + (d.units.lineNumberTokens ?? 0), 0),
    extractMsMedian: quantile(perPage, 0.5), extractMsP90: quantile(perPage, 0.9),
    reflowMsPerPage: reflowPerPage.reduce((a, b) => a + b, 0) / Math.max(1, reflowPerPage.length),
    totalMsPerPage: totalPerPage.length ? totalPerPage.reduce((a, b) => a + b, 0) / totalPerPage.length : NaN,
  };
}

/** The pages that fail worst, at most `perDoc` of any one document so one bad paper
 *  does not fill the list. */
function worstPages(docs, n, perDoc = 2) {
  const rows = [];
  for (const d of docs) for (const p of d.pages ?? []) rows.push({ id: d.id, ...p });
  const taken = new Map();
  return rows.sort((a, b) => b.badness - a.badness).filter((r) => {
    const k = taken.get(r.id) ?? 0;
    taken.set(r.id, k + 1);
    return k < perDoc;
  }).slice(0, n);
}

/** The biggest single thing wrong with a page, in words. */
function reasonOf(p) {
  const parts = [
    ...Object.entries(p.leak).map(([k, v]) => [LEAK_WORDS[k] ?? k, v]),
    ["text missed", p.missed],
    ["paragraph split", 20 * p.splits],
    ["paragraphs merged", 20 * p.merges],
    ["read out of order", 10 * p.backJumps + 20 * p.outOfOrder],
  ].sort((a, b) => b[1] - a[1]);
  return parts.filter(([, v]) => v > 0).slice(0, 2).map(([k]) => k).join("; ");
}
const LEAK_WORDS = {
  "display-math": "formula lines scored", "inline-math": "inline math in scored text", margin: "running head / page number scored",
  "line-number": "line numbers in scored text", caption: "caption scored", figtext: "figure/table text scored", footnote: "footnote scored",
  reference: "reference list scored", front: "front matter scored", heading: "heading inside scored text", noise: "mangled words", unmatched: "text not in the truth scored", duplicate: "text scored twice",
};

function table(rows, head) {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function report(names) {
  const runs = names.map(loadRun);
  const out = [];
  const groups = (docs) => {
    const tags = new Map([["all", docs]]);
    for (const d of docs) for (const t of tagsOf(d)) { if (!tags.has(t)) tags.set(t, []); tags.get(t).push(d); }
    return tags;
  };
  for (const run of runs) {
    const tags = groups(run.docs);
    out.push(`# ${run.name}${run.meta.engine ? ` (${run.meta.engine}${run.meta.window ? `, window ${run.meta.window}` : ""})` : ""}`, "");
    const rows = [...tags].map(([tag, docs]) => {
      const a = aggregate(docs);
      return [tag, `${a.docs} (${a.withTruth})`, a.pages, pct(a.coverageAll), pct(a.coverageScored), pct(a.leakScored), pct(a.precision), pct(a.recall), pct(a.f1),
        num(a.tauMean), `${a.outOfOrder}/${a.placedParas}`, num(a.backJumpsPer1k, 1), a.units, a.unitWords, num(a.extractMsMedian, 1), num(a.reflowMsPerPage, 2)];
    });
    out.push(table(rows, ["docs", "n (truth)", "pages", "cov read", "cov scored", "leak scored", "bnd P", "bnd R", "bnd F1", "tau", "out of order", "back/1k", "units", "unit words", "extract ms/p", "reflow ms/p"]), "");
    const all = aggregate(run.docs);
    out.push("Leakage of scored tokens by kind (share of all scored tokens):", "",
      table([...tags].map(([tag, docs]) => { const a = aggregate(docs); return [tag, pct(a.leakScoredNoInline), ...LEAK.map((k) => pct(a.leakBy[k]))]; }), ["docs", "leak w/o inline math", ...LEAK]), "",
      `Neutral in scored (appendix, acknowledgements, citations, run-in heads, marks, renumbered numbers): ${pct(all.neutralScored)}. Read leakage (every non-heading block): ${pct(all.leakRead)}. Line-number tokens in scored units of line-numbered documents, from page geometry alone: ${all.lineNumberTokens}.`, "");
    out.push(`Splits: ${JSON.stringify(all.splits)}. Merges (what the paragraph was merged into): ${JSON.stringify(all.merges)}.`, "");
    out.push(`Blocks ${all.blocks}, of them ≥75 words ${all.blocks75}. Extract p90 ${num(all.extractMsP90, 1)} ms/page.${Number.isNaN(all.totalMsPerPage) ? "" : ` Total ${num(all.totalMsPerPage, 1)} ms/page.`}`, "");
    const worst = worstPages(run.docs, 20);
    out.push("Worst pages (at most two per document):", "", table(worst.map((p) => [p.id, p.page, p.badness, reasonOf(p), Object.entries(p.leak).map(([k, v]) => `${k} ${v}`).join(", "), p.missed, p.splits, p.merges, p.backJumps, p.outOfOrder]),
      ["doc", "page", "badness", "main reason", "leaked scored tokens", "missed", "splits", "merges", "back jumps", "out of order"]), "");
    const summary = { run: run.name, meta: run.meta, groups: Object.fromEntries([...tags].map(([t, d]) => [t, aggregate(d)])), worst };
    writeFileSync(join(run.dir, "summary.json"), JSON.stringify(summary, null, 1));
  }
  if (runs.length > 1) {
    // Head to head on the documents every run read, with truth.
    const ids = runs.map((r) => new Set(r.docs.filter((d) => d.metrics).map((d) => d.id)));
    const common = [...ids[0]].filter((id) => ids.every((s) => s.has(id)));
    out.push(`# Head to head (${common.length} documents with truth read by every run)`, "");
    const rows = runs.map((r) => {
      const a = aggregate(r.docs.filter((d) => common.includes(d.id)));
      return [r.name, pct(a.coverageAll), pct(a.coverageScored), pct(a.leakScored), pct(a.leakBy["display-math"] + a.leakBy["inline-math"]), pct(a.leakBy.margin + a.leakBy["line-number"]), pct(a.leakBy.caption + a.leakBy.figtext + a.leakBy.footnote + a.leakBy.reference + a.leakBy.front), pct(a.f1), num(a.tauMean), `${a.outOfOrder}/${a.placedParas}`, a.units, a.unitWords, num(a.totalMsPerPage, 1)];
    });
    out.push(table(rows, ["run", "cov read", "cov scored", "leak scored", "math", "margins+line nos", "captions/figs/notes/refs/front", "bnd F1", "tau", "out of order", "units", "unit words", "ms/page"]), "");
  }
  const text = out.join("\n");
  writeFileSync(join(runs[0].dir, runs.length > 1 ? `compare-${runs.map((r) => r.name).join("-vs-")}.md` : "summary.md"), text);
  console.log(text);
}

// ---- diff ------------------------------------------------------------------------------

const COLOURS = { body: "", appendix: "#e8f0ff", ack: "#e8f0ff", runin: "#eee", mark: "#eee", heading: "#ffe3b3", front: "#ffd6e7", caption: "#d5f5d5", figtext: "#c8ecec", footnote: "#e6dcff", reference: "#f5d0c5", "display-math": "#ffb3b3", "inline-math": "#ffdada", margin: "#ffe066", "line-number": "#ffe066", noise: "#ddd", unmatched: "#bbb", duplicate: "#f99", number: "#eee", cite: "#eee" };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function diffPage(dir, docRecord, pageNo) {
  const doc = manifest().find((d) => d.id === docRecord.id);
  const { truth } = await truthFor(doc, docRecord.truth === "tagged");
  const G = truth.tokens;
  const covered = new Map();
  docRecord.blocks.forEach((b, bi) => (b.tg ?? []).forEach((q, i) => { if (q >= 0) covered.set(q, { bi, page: b.tp[i] }); }));
  const left = [];
  const touched = new Set();
  docRecord.blocks.forEach((b, bi) => {
    if (!(b.tp ?? []).includes(pageNo) && b.page !== pageNo) return;
    let html = "";
    let at = 0;
    b.ts.forEach((s, i) => {
      html += esc(b.text.slice(at, s));
      const label = CODE_LABEL[b.tl[i]];
      const word = esc(b.text.slice(s, b.te[i]));
      html += label === "body" ? word : `<span style="background:${COLOURS[label]}" title="${label}">${word}</span>`;
      at = b.te[i];
      if (b.tg[i] >= 0 && G[b.tg[i]].para >= 0) touched.add(G[b.tg[i]].para);
    });
    html += esc(b.text.slice(at));
    const unit = b.unit >= 0 ? `unit ${b.unit} (${docRecord.unitList[b.unit].words} w)` : "not scored";
    left.push(`<div class="b ${b.kind}"><div class="m">#${bi} p${b.page} ${b.kind}${b.apart ? " apart" : ""}${b.columnBreak ? " break" : ""} · ${unit}</div>${html}</div>`);
  });
  const paras = [...touched].sort((a, b) => a - b);
  const right = paras.map((pi) => {
    const p = truth.paras[pi];
    const words = [];
    for (let q = p.start; q < p.end; q++) {
      const tok = G[q];
      const hit = covered.get(q);
      const style = !hit && tok.cat === "body" ? "background:#ff8080" : tok.cat !== "body" ? `background:${COLOURS[tok.cat] ?? "#eee"}` : "";
      words.push(style ? `<span style="${style}" title="${tok.cat}${hit ? ` → #${hit.bi}` : " missed"}">${esc(tok.r)}</span>` : esc(tok.r));
    }
    return `<div class="b"><div class="m">¶${pi} ${p.cat}${p.soft ? " soft" : ""}${p.abstract ? " abstract" : ""}</div>${words.join(" ")}</div>`;
  });
  const legend = Object.entries(COLOURS).filter(([, c]) => c).map(([k, c]) => `<span style="background:${c}">${k}</span>`).join(" ");
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(docRecord.id)} p${pageNo}</title>
<style>body{font:13px/1.45 system-ui;margin:12px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}.b{border:1px solid #ccc;padding:6px;margin:0 0 8px}.b.heading{border-color:#e0a000}.m{font:11px monospace;color:#666}</style>
<h1>${esc(docRecord.id)} page ${pageNo}</h1><p>${legend} <span style="background:#ff8080">body missed</span></p>
<div class="cols"><div><h2>Reconstruction (blocks touching the page)</h2>${left.join("\n")}</div><div><h2>Truth (paragraphs those blocks reach)</h2>${right.join("\n")}</div></div>`;
  mkdirSync(join(dir, "diff"), { recursive: true });
  const file = join(dir, "diff", `${safe(docRecord.id)}-p${pageNo}.html`);
  writeFileSync(file, html);
  return file;
}

async function diff(name) {
  const run = loadRun(name);
  const page = flag("page");
  const targets = page
    ? [{ id: page.split(":")[0], page: Number(page.split(":")[1]) }]
    : worstPages(run.docs, Number(flag("worst", "20")));
  for (const t of targets) {
    const record = run.docs.find((d) => d.id === t.id);
    if (!record?.truth) { console.log(`${t.id}: no truth`); continue; }
    console.log(await diffPage(run.dir, record, t.page));
  }
}

/** The arguments that are neither a --flag nor a flag's value. */
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const [command, ...rest] = positional;
if (command === "run") await run();
else if (command === "report") report(rest);
else if (command === "diff") await diff(rest[0]);
else if (command === "zotero") await zotero();
else console.log("usage: bench.mjs run [--name <run>] [--only <ids>] [--window <n>] | zotero <raw dir> [--name <run>] [--features <run>] | report <run> [<run>…] | diff <run> [--worst <n> | --page <id>:<n>]");
