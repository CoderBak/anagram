// test/web-bench/bench.mjs — how well the content script reads web pages, measured offline.
//
//   ANAGRAM_WEB_BENCH=<corpus> node test/web-bench/bench.mjs run [--name <run>] [--scope page|main] [--extractor readability|none]
//                                    [--only <id,…>] [--datasets wcxb,wmb,…] [--concurrency <n>] [--no-explain]
//   ANAGRAM_WEB_BENCH=<corpus> node test/web-bench/bench.mjs external <name> <outputs.jsonl> --truth-from <run>
//   ANAGRAM_WEB_BENCH=<corpus> node test/web-bench/bench.mjs report <run> [<other run>…] [--split dev|test]
//   ANAGRAM_WEB_BENCH=<corpus> node test/web-bench/bench.mjs diff <run> [--worst <n>] [--page <id>]
//   ANAGRAM_WEB_BENCH=<corpus> node test/web-bench/bench.mjs rescore <run>
//
// The corpus is built by corpus.mjs. Each page is opened in Playwright's bundled Chromium,
// headless, in a throwaway context, with page scripts off, at its original address — the
// document is answered from disk by the harness and every other request is refused, with
// DNS mapped to nowhere underneath in case anything slipped past. page.ts then runs the
// content script's first collection in it (see there). Results go to <corpus>/../out/<run>/:
// docs/<id>.json, summary.md and summary.json, diff/*.html for the pages that fail worst.
// `external` scores another extractor's output (JSON lines of {id, markdown, ms}) the same
// way, once as it stands and once grouped into the units Anagram would score (group.ts).
//
// HELD OUT. Rules are tuned on the `dev` split only; `test` is the pages whose id's SHA-1
// begins with a hex digit 0–4 (about 30%), and is only ever reported.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scorePage, scoreSegments, tokens } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = process.env.ANAGRAM_WEB_BENCH;
if (!CORPUS) throw new Error("set ANAGRAM_WEB_BENCH to the corpus directory (see corpus.mjs)");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const OUT = flag("out", join(dirname(CORPUS), "out"));
const manifest = () => JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));
/** Which split a page is in, by its id alone: "test" is held out, "dev" is tuned on. */
export const splitOf = (id) => (/^[0-4]/.test(createHash("sha1").update(id).digest("hex")) ? "test" : "dev");
const safe = (id) => id.replace(/[^\w.-]+/g, "_");
/** Page types whose comments are the main content: comment units outside the truth count as leakage there. */
const COMMENTS_ARE_CONTENT = new Set(["forum", "conversational"]);

/** The truth of a page as blocks of text (headings, paragraphs, list items), or null. */
function truthBlocksOf(entry, truth, measured) {
  if (truth.kind === "text") return truth.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (truth.kind === "html") return measured?.truthBlocks ?? null;
  return null;
}

/** A reason from the page diagnostics, without the page-specific names in it. */
function reasonClass(reason) {
  if (!reason) return "a unit exists (not silent)";
  if (reason.startsWith("page chrome")) {
    const branch = reason.split(" — ")[1] ?? "";
    if (branch.startsWith("name token")) return "page chrome: class/id token";
    return `page chrome: ${branch.replace(/"[^"]*"/g, "…")}`;
  }
  const rules = [
    [/^never-scored tag <(\w+)>/, (m) => `never-scored tag <${m[1]}>`],
    [/^inside a <pre>/, () => "machine-text <pre>"],
    [/^aria-hidden/, () => "aria-hidden ancestor"],
    [/^translate="no"/, () => "translate=no ancestor"],
    [/^inside contenteditable/, () => "contenteditable"],
    [/^inside heading label/, () => "inside a heading"],
    [/^(visibility|opacity|visually hidden|out of flow|zero-size)/, () => "hidden or zero-size"],
    [/^the box alone yields/, () => "suppressed by a barrier or a neighbouring voice"],
    [/^no run survived/, () => "every block invisible or excluded"],
    [/^no letters/, () => "no letters"],
    [/^symbol noise/, () => "symbol noise"],
    [/^preserved-whitespace/, () => "column gaps in preserved text"],
    [/^link-dense/, () => "link-dense"],
    [/^reads as a name list/, () => "name list"],
    [/^under the \d+-word floor/, () => "under the 75-word floor"],
    [/^no unit although/, () => "under the floor after marks/formulas"],
  ];
  for (const [re, name] of rules) {
    const m = re.exec(reason);
    if (m) return name(m);
  }
  return reason.slice(0, 60);
}

// ---- run -----------------------------------------------------------------------------

async function bundlePage() {
  const dir = mkdtempSync(join(tmpdir(), "anagram-webbench-"));
  const outfile = join(dir, "page.js");
  await build({
    entryPoints: [join(HERE, "page.ts")], bundle: true, format: "iife", globalName: "WB",
    outfile, logLevel: "error", target: ["chrome120"],
  });
  // page.evaluate() runs a string inside a function, where `var WB` stays local.
  const source = `${readFileSync(outfile, "utf8")}\n;globalThis.WB = WB;`;
  rmSync(dir, { recursive: true, force: true });
  return source;
}

async function measurePage(context, bundle, entry, opts) {
  const truth = JSON.parse(readFileSync(join(CORPUS, entry.truth), "utf8"));
  const body = readFileSync(join(CORPUS, entry.page));
  const url = entry.url && /^https?:/.test(entry.url) ? entry.url : `https://${entry.dataset}.bench.invalid/${safe(entry.id)}.html`;
  const page = await context.newPage();
  if (entry.width) await page.setViewportSize({ width: entry.width, height: 850 });
  // Requests the page makes while it is being measured: layout starts web fonts and lazy
  // images on its own, anything else would be the code under test reaching out.
  const requests = { load: 0, measure: 0, measureByType: {}, measureUrls: [] };
  let phase = "load";
  let served = false;
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      if (!served) {
        served = true;
        return route.fulfill({ status: 200, contentType: entry.charset ? `text/html; charset=${entry.charset}` : "text/html", body });
      }
      // A meta refresh or a form: 204 keeps the page where it is.
      requests[phase]++;
      return route.fulfill({ status: 204, body: "" });
    }
    requests[phase]++;
    if (phase === "measure") {
      requests.measureByType[req.resourceType()] = (requests.measureByType[req.resourceType()] ?? 0) + 1;
      if (requests.measureUrls.length < 5) requests.measureUrls.push(`${req.resourceType()} ${req.url().slice(0, 160)}`);
    }
    return route.abort();
  });
  const began = Date.now();
  try {
    // A page whose load event never comes (a stalled subresource) is measured as parsed.
    await page.goto(url, { waitUntil: "load", timeout: 30000 }).catch(async (error) => {
      const state = await page.evaluate(() => document.readyState).catch(() => "loading");
      if (state === "loading") throw error;
    });
    phase = "measure";
    await page.evaluate(bundle);
    const measured = await Promise.race([
      page.evaluate((o) => WB.measure(o), {
        scope: opts.scope, extractor: opts.extractor,
        truthHtml: truth.kind === "html" ? truth.html : null,
        xpaths: truth.kind === "segments", explain: opts.explain && truth.kind !== "segments",
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("measure timed out")), 90000)),
    ]);
    return { truth, measured, requests, wallMs: Date.now() - began };
  } finally {
    await page.close().catch(() => {});
  }
}

function record(entry, truth, measured, requests, wallMs, meta) {
  const base = {
    id: entry.id, dataset: entry.dataset, type: entry.type, level: entry.level, split: splitOf(entry.id), url: entry.url,
    meta, requests, wallMs, timing: measured.timing,
    scope: { found: measured.scope.found, byExtractor: measured.scope.byExtractor, root: measured.scope.root, mutated: measured.scope.mutated },
    bodyToks: tokens(measured.bodyText).length,
  };
  if (truth.kind === "segments") {
    const seg = scoreSegments(measured.units, truth.seg, truth.text);
    return { ...base, truthKind: "segments", segments: seg, units: measured.units.map((u) => ({ words: u.words, parts: u.parts, comment: u.comment, where: u.where, landmark: u.landmark, text: u.text })) };
  }
  const truthBlocks = truthBlocksOf(entry, truth, measured);
  const m = scorePage({
    truthBlocks, units: measured.units, scopeText: measured.scope.text,
    snippets: truth.with ? { with: truth.with, without: truth.without } : null,
    commentsAreContent: COMMENTS_ARE_CONTENT.has(entry.type),
  });
  const { perUnit, marks, ...metrics } = m;
  // Silent stretches that are main content: how much of the truth each would have given.
  const truthGramsText = truthBlocks.join("\n");
  const silent = (measured.silent ?? []).map((s) => {
    const sm = scorePage({ truthBlocks: [truthGramsText], units: [{ text: s.text }] });
    return { path: s.path, words: s.words, reason: s.reason, cls: reasonClass(s.reason), note: s.note, main: sm.readMain, toks: sm.read, text: s.text.slice(0, 400) };
  });
  return {
    ...base, truthKind: truth.kind, truthBlocks, metrics, silent,
    units: measured.units.map((u, k) => ({ words: u.words, parts: u.parts, comment: u.comment, where: u.where, landmark: u.landmark, toks: perUnit[k].toks, main: perUnit[k].main, text: u.text })),
  };
}

async function run() {
  const { chromium } = await import("playwright");
  const scope = flag("scope", "page");
  const extractor = scope === "main" ? flag("extractor", "readability") : "none";
  const name = flag("name", `${scope}${scope === "main" ? `-${extractor}` : ""}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);
  const only = flag("only")?.split(",");
  const datasets = flag("datasets")?.split(",");
  const explain = !has("no-explain");
  const dir = join(OUT, name);
  // A run of the whole corpus starts afresh; one restricted by --only or --datasets
  // re-measures those pages inside the run it names.
  if (!only && !datasets) rmSync(join(dir, "docs"), { recursive: true, force: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  const bundle = await bundlePage();
  const entries = manifest().filter((e) => (!only || only.includes(e.id)) && (!datasets || datasets.includes(e.dataset)));
  const meta = { scope, extractor, explain, date: new Date().toISOString(), js: false };
  writeFileSync(join(dir, "run.json"), JSON.stringify(meta));

  // Nothing leaves the machine: the harness answers the one document itself and refuses
  // everything else, and underneath that every host name resolves to nothing.
  const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 850 }, serviceWorkers: "block" });
  let next = 0, done = 0;
  const concurrency = Number(flag("concurrency", "6"));
  const began = Date.now();
  async function worker() {
    for (;;) {
      const entry = entries[next++];
      if (!entry) return;
      const file = join(dir, "docs", `${safe(entry.id)}.json`);
      try {
        const { truth, measured, requests, wallMs } = await measurePage(context, bundle, entry, { scope, extractor, explain });
        writeFileSync(file, JSON.stringify(record(entry, truth, measured, requests, wallMs, meta)));
      } catch (error) {
        writeFileSync(file, JSON.stringify({ id: entry.id, dataset: entry.dataset, type: entry.type, split: splitOf(entry.id), error: String(error?.message ?? error) }));
      }
      if (++done % 100 === 0) console.log(`${done}/${entries.length} ${((Date.now() - began) / 1000).toFixed(0)} s`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await browser.close();
  report([name]);
}

// ---- external ----------------------------------------------------------------------------

/** Another extractor's output, scored as it stands and as the units Anagram would make of it. */
async function external(name, file) {
  const dir = mkdtempSync(join(tmpdir(), "anagram-webbench-"));
  const outfile = join(dir, "group.mjs");
  await build({ entryPoints: [join(HERE, "group.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error" });
  const { unitsOfMarkdown } = await import(pathToFileURL(outfile).href);
  rmSync(dir, { recursive: true, force: true });
  const byId = new Map(manifest().map((e) => [e.id, e]));
  // An HTML truth is turned into blocks inside the page, so those come from a run of ours.
  const ref = flag("truth-from");
  const htmlTruth = new Map(ref ? loadRun(ref).docs.filter((d) => d.truthBlocks).map((d) => [d.id, d.truthBlocks]) : []);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const grouped of [false, true]) {
    const runName = grouped ? `${name}-units` : name;
    const out = join(OUT, runName);
    mkdirSync(join(out, "docs"), { recursive: true });
    const meta = { engine: name, grouped, date: new Date().toISOString() };
    writeFileSync(join(out, "run.json"), JSON.stringify(meta));
    for (const row of lines) {
      const entry = byId.get(row.id);
      if (!entry) continue;
      const truth = JSON.parse(readFileSync(join(CORPUS, entry.truth), "utf8"));
      if (truth.kind === "segments") continue;
      const md = row.markdown ?? "";
      const texts = grouped ? unitsOfMarkdown(md) : md.trim() ? [md] : [];
      const truthBlocks = truth.kind === "text" ? truthBlocksOf(entry, truth) : htmlTruth.get(entry.id) ?? null;
      if (!truthBlocks) continue;
      const units = texts.map((text) => ({ text, comment: false }));
      const m = scorePage({ truthBlocks, units, snippets: truth.with ? { with: truth.with, without: truth.without } : null, commentsAreContent: COMMENTS_ARE_CONTENT.has(entry.type) });
      const { perUnit, marks, ...metrics } = m;
      writeFileSync(join(out, "docs", `${safe(entry.id)}.json`), JSON.stringify({
        id: entry.id, dataset: entry.dataset, type: entry.type, split: splitOf(entry.id), meta, truthKind: truth.kind, metrics,
        timing: { totalMs: row.ms ?? null }, error: row.error ?? undefined,
        units: units.map((u, k) => ({ words: tokens(u.text).length, parts: 1, comment: false, toks: perUnit[k].toks, main: perUnit[k].main, text: u.text })),
      }));
    }
    report([runName]);
  }
}

// ---- rescore -----------------------------------------------------------------------------

/** Recompute a run's figures from what it recorded (the units and the truth blocks), after
 *  the metrics changed; the region's own figures are kept, its text was not stored. */
function rescore(name) {
  const run = loadRun(name);
  const byId = new Map(manifest().map((e) => [e.id, e]));
  for (const d of run.docs) {
    if (!d.metrics || !d.truthBlocks) continue;
    const truth = JSON.parse(readFileSync(join(CORPUS, byId.get(d.id).truth), "utf8"));
    const m = scorePage({ truthBlocks: d.truthBlocks, units: d.units, snippets: truth.with ? { with: truth.with, without: truth.without } : null, commentsAreContent: COMMENTS_ARE_CONTENT.has(d.type) });
    const { perUnit, marks, ...metrics } = m;
    d.metrics = { ...metrics, scope: d.metrics.scope };
    d.units.forEach((u, k) => Object.assign(u, perUnit[k]));
    writeFileSync(join(run.dir, "docs", `${safe(d.id)}.json`), JSON.stringify(d));
  }
  report([name]);
}

// ---- report ------------------------------------------------------------------------------

function loadRun(name) {
  const dir = join(OUT, name);
  const meta = existsSync(join(dir, "run.json")) ? JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) : {};
  const docs = readdirSync(join(dir, "docs")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, "docs", f), "utf8")));
  return { name, dir, meta, docs };
}

const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : `${(100 * x).toFixed(1)}`);
const num = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "–" : x.toFixed(d));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
function table(rows, head) {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** Micro-averages over pages (every word counts once), plus WCXB's per-page mean BoW F1. */
function aggregate(docs) {
  const ok = docs.filter((d) => d.metrics);
  const sum = (f) => ok.reduce((a, d) => a + (f(d) ?? 0), 0);
  const truth = sum((d) => d.metrics.truth), read = sum((d) => d.metrics.read);
  const readMain = sum((d) => d.metrics.readMain), covered = sum((d) => d.metrics.covered);
  const truthLong = sum((d) => d.metrics.truthLong), coveredLong = sum((d) => d.metrics.coveredLong);
  const leakOther = sum((d) => d.metrics.leakOther), leakComment = sum((d) => d.metrics.leakComment);
  const withN = sum((d) => d.metrics.with?.n), withHit = sum((d) => d.metrics.with?.hit);
  const withoutN = sum((d) => d.metrics.without?.n), withoutHit = sum((d) => d.metrics.without?.hit);
  const scoped = ok.filter((d) => d.metrics.scope);
  const scopeToks = scoped.reduce((a, d) => a + d.metrics.scope.toks, 0);
  const scopeMain = scoped.reduce((a, d) => a + d.metrics.scope.main, 0);
  const scopeCovered = scoped.reduce((a, d) => a + d.metrics.scope.covered, 0);
  const scopeTruth = scoped.reduce((a, d) => a + d.metrics.truth, 0);
  const precision = read ? readMain / read : NaN, recall = truth ? covered / truth : NaN;
  const f1PerPage = ok.filter((d) => d.metrics.truth > 0).map((d) => {
    const p = d.metrics.read ? d.metrics.readMain / d.metrics.read : 0, r = d.metrics.covered / d.metrics.truth;
    return p + r > 0 ? (2 * p * r) / (p + r) : 0;
  });
  return {
    pages: docs.length, errors: docs.filter((d) => d.error).length,
    nothingRead: ok.filter((d) => d.metrics.read === 0 && d.metrics.truth > 0).length,
    units: ok.reduce((a, d) => a + d.units.length, 0),
    commentWords: ok.reduce((a, d) => a + d.units.filter((u) => u.comment).reduce((b, u) => b + u.words, 0), 0),
    words: ok.reduce((a, d) => a + d.units.reduce((b, u) => b + u.words, 0), 0),
    recall, recallLong: truthLong ? coveredLong / truthLong : NaN,
    precision, leak: read ? leakOther / read : NaN, leakComment: read ? leakComment / read : NaN,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : NaN,
    f1PageMean: f1PerPage.reduce((a, b) => a + b, 0) / Math.max(1, f1PerPage.length),
    bowF1Mean: ok.filter((d) => d.metrics.truth > 0).reduce((a, d) => a + d.metrics.bowF1, 0) / Math.max(1, ok.filter((d) => d.metrics.truth > 0).length),
    withRate: withN ? withHit / withN : NaN, withoutRate: withoutN ? withoutHit / withoutN : NaN,
    scopeRecall: scopeTruth ? scopeCovered / scopeTruth : NaN, scopePrecision: scopeToks ? scopeMain / scopeToks : NaN,
    scopeFound: scoped.length ? ok.filter((d) => d.scope?.found).length / ok.length : NaN,
    byExtractor: ok.length && ok[0].meta?.scope === "main" ? ok.filter((d) => d.scope?.byExtractor).length / ok.length : NaN,
    msMedian: median(ok.map((d) => d.timing?.totalMs)),
    scopeMsMedian: median(docs.map((d) => d.timing?.scopeMs)),
    scopeMsP90: (() => { const s = docs.map((d) => d.timing?.scopeMs).filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * 0.9)] : NaN; })(),
    mutated: docs.filter((d) => d.scope?.mutated).length,
    requests: docs.reduce((a, d) => a + (d.requests?.measure ?? 0), 0),
    requestsNotLayout: docs.reduce((a, d) => a + Object.entries(d.requests?.measureByType ?? {}).filter(([t]) => !["font", "image", "media"].includes(t)).reduce((b, [, n]) => b + n, 0), 0),
  };
}

function aggregateSegments(docs) {
  const ok = docs.filter((d) => d.segments);
  const s = (f) => ok.reduce((a, d) => a + f(d.segments), 0);
  const tp = s((x) => x.tp), fp = s((x) => x.fp), fn = s((x) => x.fn);
  const p = tp / Math.max(1, tp + fp), r = tp / Math.max(1, tp + fn);
  return {
    pages: docs.length, errors: docs.filter((d) => d.error).length, units: s((x) => x.units),
    mapped: s((x) => x.mappedWords) / Math.max(1, s((x) => x.scoredWords)),
    purity: s((x) => x.pureWords) / Math.max(1, s((x) => x.unitWords)),
    crossing: s((x) => x.crossing) / Math.max(1, s((x) => x.units)),
    recall: r, precision: p, f1: (2 * p * r) / Math.max(1e-9, p + r),
  };
}

function groupsOf(docs) {
  const main = docs.filter((d) => d.dataset !== "webseg");
  const groups = new Map([["all (main-content datasets)", main.filter((d) => d.dataset !== "readability")]]);
  const add = (key, d) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  };
  for (const d of main) add(d.dataset, d);
  for (const d of main) add(`${d.dataset}/${d.type}`, d);
  for (const d of main) if (COMMENTS_ARE_CONTENT.has(d.type)) add("forum + conversational", d);
  for (const d of main) if (!COMMENTS_ARE_CONTENT.has(d.type) && d.dataset !== "readability") add("all except forum/conversational", d);
  return groups;
}

/** Where the main content that got no unit went, in the page diagnostics' words. */
function missedBy(docs) {
  const by = new Map();
  let truth = 0, missed = 0, outside = 0;
  const size = { truth: [0, 0, 0], covered: [0, 0, 0] };
  for (const d of docs) {
    if (!d.metrics) continue;
    truth += d.metrics.truth;
    missed += d.metrics.truth - d.metrics.covered;
    for (let k = 0; k < 3; k++) {
      size.truth[k] += d.metrics.bySize?.truth[k] ?? 0;
      size.covered[k] += d.metrics.bySize?.covered[k] ?? 0;
    }
    if (d.metrics.scope) outside += Math.max(0, d.metrics.truth - d.metrics.scope.covered);
    for (const s of d.silent ?? []) {
      if (s.main < s.toks * 0.5 || s.main < 20) continue;
      const k = s.cls;
      const v = by.get(k) ?? { toks: 0, pages: new Set() };
      v.toks += s.main;
      v.pages.add(d.id);
      by.set(k, v);
    }
  }
  return { truth, missed, outside, size, rows: [...by].sort((a, b) => b[1].toks - a[1].toks) };
}

/** Which containers the leaked words were read from, by class/id token and by landmark. */
function leakedBy(docs) {
  const byToken = new Map(), byLandmark = new Map();
  let leaked = 0;
  for (const d of docs) {
    if (!d.metrics) continue;
    const commentsCount = COMMENTS_ARE_CONTENT.has(d.type);
    for (const u of d.units) {
      if (u.comment && !commentsCount) continue;
      const leak = (u.toks ?? 0) - (u.main ?? 0);
      if (leak <= 0) continue;
      leaked += leak;
      const lm = u.landmark || "(none)";
      const v = byLandmark.get(lm) ?? { toks: 0, pages: new Set() };
      v.toks += leak;
      v.pages.add(d.id);
      byLandmark.set(lm, v);
      const names = new Set((u.where ?? "").match(/[#.][\w-]+/g)?.map((t) => t.slice(1).toLowerCase()) ?? []);
      for (const t of names) {
        const w = byToken.get(t) ?? { toks: 0, pages: new Set() };
        w.toks += leak;
        w.pages.add(d.id);
        byToken.set(t, w);
      }
    }
  }
  const top = (m, n) => [...m].filter(([, v]) => v.pages.size >= 3).sort((a, b) => b[1].toks - a[1].toks).slice(0, n);
  return { leaked, landmarks: top(byLandmark, 12), tokens: top(byToken, 30) };
}

function badnessOf(d) {
  if (!d.metrics) return 0;
  const missedLong = d.metrics.truthLong - d.metrics.coveredLong;
  return missedLong + d.metrics.leakOther;
}

function report(names) {
  const split = flag("split");
  const runs = names.map(loadRun).map((r) => (split ? { ...r, name: `${r.name} [${split}]`, docs: r.docs.filter((d) => splitOf(d.id) === split) } : r));
  const out = [];
  for (const run of runs) {
    const m = run.meta;
    out.push(`# ${run.name} (${m.engine ?? `scope ${m.scope}${m.scope === "main" ? `, ${m.extractor}` : ""}`}${m.grouped ? ", grouped into Anagram units" : ""})`, "");
    const groups = groupsOf(run.docs);
    const rows = [...groups].map(([g, docs]) => {
      const a = aggregate(docs);
      return [g, a.pages, a.errors, a.nothingRead, a.units, a.words, pct(a.recall), pct(a.recallLong), pct(a.precision), pct(a.leak), pct(a.leakComment), pct(a.f1), pct(a.f1PageMean), pct(a.bowF1Mean),
        pct(a.withRate), pct(a.withoutRate), pct(a.scopeRecall), pct(a.scopePrecision), pct(a.byExtractor), num(a.msMedian, 0)];
    });
    out.push(table(rows, ["pages", "n", "err", "none read", "units", "words", "recall", "recall ≥75w ¶", "precision", "leak", "comments/reviews outside truth", "F1", "F1 page mean", "BoW F1 page mean", "must-incl hit", "must-excl hit", "scope recall", "scope precision", "region ≠ text-mass probe", "ms/page"]), "");
    const everything = aggregate(run.docs);
    if (!m.engine) out.push(`Requests while measuring, every one refused: ${everything.requests}, of them anything but a font, image or media file layout asked for: ${everything.requestsNotLayout}.` +
      (m.scope === "main" ? ` Main-content detection ${num(everything.scopeMsMedian, 1)} ms median, ${num(everything.scopeMsP90, 1)} ms p90; pages it changed: ${everything.mutated}.` : ""), "");
    const segDocs = run.docs.filter((d) => d.dataset === "webseg");
    if (segDocs.length) {
      const s = aggregateSegments(segDocs);
      out.push("Unit boundaries against Webis-WebSeg-20 segments (majority vote):", "",
        table([[s.pages, s.errors, s.units, pct(s.mapped), pct(s.recall), pct(s.precision), pct(s.f1), pct(s.purity), pct(s.crossing)]],
          ["pages", "err", "units", "scored words placed in a segment", "segment changes that end a unit", "unit ends at a segment change", "F1", "unit words in its main segment", "units across segments"]), "");
    }
    const all = run.docs.filter((d) => d.dataset !== "webseg" && d.dataset !== "readability");
    const missed = missedBy(all);
    if (missed.size.truth.some(Boolean)) {
      const names = ["under 10 words (headings, labels, short items)", "10 to 74 words", "75 words or more"];
      out.push("Truth words by the size of the truth paragraph they are in, and the share of them read:", "",
        table(names.map((n, k) => [n, pct(missed.size.truth[k] / Math.max(1, missed.truth)), pct(missed.size.covered[k] / Math.max(1, missed.size.truth[k]))]), ["paragraph", "% of truth", "read"]), "");
    }
    if (missed.rows.length || missed.outside) {
      out.push(`Main content missed: ${pct(missed.missed / Math.max(1, missed.truth))}% of truth words${missed.outside ? `, of them outside the scope root ${pct(missed.outside / Math.max(1, missed.truth))}%` : ""}. Silent prose blocks that are main content, by the page diagnostics' reason (whole-page walk):`, "",
        table(missed.rows.slice(0, 20).map(([k, v]) => [k, v.toks, pct(v.toks / Math.max(1, missed.truth)), v.pages.size]), ["reason", "truth words", "% of truth", "pages"]), "");
    }
    const leaked = leakedBy(all);
    if (leaked.leaked) {
      out.push("Leaked words (read, not main content; comments and reviews on non-forum pages excluded) by landmark:", "",
        table(leaked.landmarks.map(([k, v]) => [k, v.toks, pct(v.toks / leaked.leaked), v.pages.size]), ["landmark", "words", "% of leak", "pages"]), "",
        "…and by class/id token of the unit's nearest five ancestors (a unit counts once per token; tokens on ≥3 pages):", "",
        table(leaked.tokens.map(([k, v]) => [`\`${k}\``, v.toks, pct(v.toks / leaked.leaked), v.pages.size]), ["token", "words", "% of leak", "pages"]), "");
    }
    const worst = all.filter((d) => d.metrics).sort((a, b) => badnessOf(b) - badnessOf(a)).slice(0, 25);
    out.push("Worst pages (missed words of ≥75-word truth paragraphs + leaked words):", "",
      table(worst.map((d) => [d.id, d.type, d.url ?? "", badnessOf(d), d.metrics.truthLong - d.metrics.coveredLong, d.metrics.leakOther, d.scope?.root ?? ""]), ["page", "type", "url", "badness", "missed ≥75w", "leaked", "scope root"]), "");
    const summary = { run: run.name, meta: run.meta, groups: Object.fromEntries([...groups].map(([g, d]) => [g, aggregate(d)])), segments: segDocs.length ? aggregateSegments(segDocs) : null };
    writeFileSync(join(run.dir, `summary${split ? `-${split}` : ""}.json`), JSON.stringify(summary, null, 1));
  }
  if (runs.length > 1) {
    const ids = runs.map((r) => new Set(r.docs.filter((d) => d.metrics).map((d) => d.id)));
    const common = new Set([...ids[0]].filter((id) => ids.every((s) => s.has(id))));
    out.push(`# Head to head (${common.size} pages every run read)`, "");
    const keys = new Set();
    for (const r of runs) for (const g of groupsOf(r.docs.filter((d) => common.has(d.id))).keys()) keys.add(g);
    const rows = [];
    for (const g of keys) {
      for (const r of runs) {
        const docs = groupsOf(r.docs.filter((d) => common.has(d.id))).get(g) ?? [];
        if (!docs.length) continue;
        const a = aggregate(docs);
        rows.push([g, r.name, a.pages, a.units, a.words, a.commentWords, pct(a.recall), pct(a.recallLong), pct(a.precision), pct(a.leak), pct(a.leakComment), pct(a.f1), pct(a.bowF1Mean), pct(a.withRate), pct(a.withoutRate), pct(a.scopeRecall), pct(a.scopePrecision)]);
      }
    }
    out.push(table(rows, ["pages", "run", "n", "units", "words", "comment/review words", "recall", "recall ≥75w ¶", "precision", "leak", "comments/reviews outside truth", "F1", "BoW F1 page mean", "must-incl hit", "must-excl hit", "scope recall", "scope precision"]), "");
  }
  const text = out.join("\n");
  const suffix = split ? `-${split}` : "";
  writeFileSync(join(runs[0].dir, runs.length > 1 ? `compare-${names.join("-vs-")}${suffix}.md` : `summary${suffix}.md`), text);
  console.log(text);
}

// ---- diff ------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** `text` with each word wrapped by `mark(index)`'s colour, in the order tokens() reads them. */
function painted(text, marks, offset, colour) {
  let html = "", at = 0, k = offset;
  for (const m of text.normalize("NFKC").matchAll(/[\p{L}\p{N}_]+/gu)) {
    html += esc(text.normalize("NFKC").slice(at, m.index));
    const c = colour(marks[k++]);
    html += c ? `<span style="background:${c}">${esc(m[0])}</span>` : esc(m[0]);
    at = m.index + m[0].length;
  }
  return { html: html + esc(text.normalize("NFKC").slice(at)), next: k };
}

function diffPage(dir, d) {
  const m = scorePage({ truthBlocks: d.truthBlocks, units: d.units, commentsAreContent: COMMENTS_ARE_CONTENT.has(d.type) });
  let k = 0;
  const left = d.units.map((u, i) => {
    const p = painted(u.text, m.marks.inTruth, k, (hit) => (hit ? "" : u.comment && !COMMENTS_ARE_CONTENT.has(d.type) ? "#e6dcff" : "#ffc2c2"));
    k = p.next;
    return `<div class="b"><div class="m">unit ${i} · ${u.words} w · ${u.parts} part(s)${u.comment ? " · comment" : ""}${u.landmark ? ` · in &lt;${esc(u.landmark)}&gt;` : ""}<br>${esc(u.where)}</div>${p.html}</div>`;
  });
  k = 0;
  const right = d.truthBlocks.map((b) => {
    const p = painted(b, m.marks.covered, k, (hit) => (hit ? "" : "#ff8080"));
    k = p.next;
    return `<div class="b">${p.html}</div>`;
  });
  const silent = (d.silent ?? []).filter((s) => s.main >= 20).map((s) => `<li>${s.main}/${s.toks} main words · <b>${esc(s.cls)}</b> · ${esc(s.path)}<br><small>${esc(s.reason)}</small><br><i>${esc(s.text.slice(0, 200))}…</i></li>`);
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(d.id)}</title>
<style>body{font:13px/1.45 system-ui;margin:12px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}.b{border:1px solid #ccc;padding:6px;margin:0 0 8px}.m{font:11px monospace;color:#666}</style>
<h1>${esc(d.id)} (${esc(d.type)})</h1><p>${esc(d.url ?? "")} · scope root: ${esc(d.scope?.root ?? "whole page")}</p>
<p><span style="background:#ffc2c2">read, not main content</span> <span style="background:#e6dcff">comment, not in the truth</span> <span style="background:#ff8080">main content missed</span></p>
${silent.length ? `<h2>Main content the walk left silent (page diagnostics)</h2><ul>${silent.join("")}</ul>` : ""}
<div class="cols"><div><h2>Units read (${d.units.length})</h2>${left.join("\n")}</div><div><h2>Truth</h2>${right.join("\n")}</div></div>`;
  mkdirSync(join(dir, "diff"), { recursive: true });
  const file = join(dir, "diff", `${safe(d.id)}.html`);
  writeFileSync(file, html);
  return file;
}

function diff(name) {
  const run = loadRun(name);
  const page = flag("page");
  const docs = run.docs.filter((d) => d.metrics && d.truthBlocks);
  const targets = page ? docs.filter((d) => d.id === page) : docs.sort((a, b) => badnessOf(b) - badnessOf(a)).slice(0, Number(flag("worst", "20")));
  for (const d of targets) console.log(diffPage(run.dir, d));
}

/** The arguments that are neither a --flag nor a flag's value. */
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !["no-explain"].includes(argv[i - 1].slice(2))));
const [command, ...rest] = positional;
if (command === "run") await run();
else if (command === "external") await external(rest[0], rest[1]);
else if (command === "report") report(rest);
else if (command === "diff") diff(rest[0]);
else if (command === "rescore") rescore(rest[0]);
else console.log("usage: bench.mjs run [--name <run>] [--scope page|main] [--extractor readability|none] [--only <ids>] [--datasets <names>] [--concurrency <n>] [--no-explain] | external <name> <jsonl> --truth-from <run> | report <run> [<run>…] [--split dev|test] | diff <run> [--worst <n> | --page <id>] | rescore <run>");
