// test/pdf-bench/consistency.mjs — one paper, read as its PDF and as arXiv's HTML: same verdicts?
//
//   ANAGRAM_PDF_BENCH=<corpus> node test/pdf-bench/consistency.mjs <zotero dumps> --features <bench run dir>
//       --python <engine python> --modelkit <dir> --lid <lid.176.ftz> --out <dir>
//       [--n 50] [--only <id,…>] [--css latexml|notes] [--step read|score|compare]
//
// Never in CI: it scores with the real model. For papers the corpus has in both forms, a
// sample drawn by the hash of the id from three strata of the `--features` run of bench.mjs
// (formula-heavy, else two-column, else one-column), each step cached under --out:
//
//   read     the PDF's units as the reader builds them (Zotero's structure through
//            lib/pdf/structured.ts, runStructured) and the HTML's as the content script
//            does (test/web-bench/page.ts in headless Chromium, the page answered from disk,
//            nothing else loaded); both readings placed on the HTML's own paragraphs
//            (truth.mjs, align.mjs), which is what the two are compared on.
//   score    every unit read as the orchestrator reads it: passes planned on the engine's
//            token counts (readInWindows) and one verdict per unit (unitVerdict), by the
//            native host over stdio in a throwaway home linked to the modelkit.
//   compare  per paragraph, the verdict of the unit that reads it on each side: score
//            difference, word, the "AI-generated" flag, and why they differ (report.md).
import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alignDocument } from "./align.mjs";
import { loadPipeline, runStructured } from "./anagram.mjs";
import { PROSE, tokenize, truthOf } from "./truth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON = join(ROOT, "anagramd");
const CORPUS = process.env.ANAGRAM_PDF_BENCH;
if (!CORPUS) throw new Error("set ANAGRAM_PDF_BENCH to the corpus directory (see corpus.mjs)");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const RAW = positional[0];
const OUT = resolve(flag("out", join(dirname(CORPUS), "consistency")));
const safe = (id) => id.replace(/[^\w.-]+/g, "_");
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
/** Math tokens per body token from which a paper counts as formula-heavy (bench.mjs FORMULA_HEAVY). */
const FORMULA_HEAVY = 0.6;
const LEVELS = ["human", "lightly edited", "heavily edited", "AI-generated"];
const CSS = [
  ".ltx_note_content { display: none; }",
  ...(flag("css", "latexml") === "notes" ? [] : [
    ".ltx_runin { display: inline; }",
    ".ltx_runin::after { content: \" \"; }",
    ".ltx_runin + .ltx_para, .ltx_runin + .ltx_para > .ltx_p:first-child, .ltx_runin + .ltx_p { display: inline; }",
  ]),
].join("\n");

// ---- the sample -------------------------------------------------------------------------

function stratumOf(features) {
  if ((features.mathShare ?? 0) >= FORMULA_HEAVY) return "formula-heavy";
  return features.twoColumn ? "two-column" : "one-column";
}

function sample(n) {
  const only = flag("only")?.split(",");
  const runDir = resolve(flag("features") ?? "");
  const features = new Map();
  for (const f of readdirSync(join(runDir, "docs")).filter((x) => x.endsWith(".json"))) {
    const d = JSON.parse(readFileSync(join(runDir, "docs", f), "utf8"));
    if (d.features && d.truth === "html" && d.metrics) features.set(d.id, d.features);
  }
  const docs = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8")).filter((d) =>
    d.has_html && (d.category ?? []).includes("arxiv-recent") && features.has(d.id) && existsSync(join(RAW, `${safe(d.id)}.json`)));
  if (only) return docs.filter((d) => only.includes(d.id)).map((d) => ({ ...d, features: features.get(d.id), stratum: stratumOf(features.get(d.id)) }));
  const strata = new Map();
  for (const d of docs.sort((a, b) => sha1(a.id).localeCompare(sha1(b.id)))) {
    const s = stratumOf(features.get(d.id));
    if (!strata.has(s)) strata.set(s, []);
    strata.get(s).push({ ...d, features: features.get(d.id), stratum: s });
  }
  // Round robin over the strata, so each holds a third where it can.
  const out = [];
  const lists = [...strata.values()];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && out.length < n) out.push(l[i]);
  return out;
}

// ---- read ---------------------------------------------------------------------------------

async function bundlePage() {
  const dir = mkdtempSync(join(tmpdir(), "anagram-consistency-"));
  const outfile = join(dir, "page.js");
  await build({ entryPoints: [join(ROOT, "test", "web-bench", "page.ts")], bundle: true, format: "iife", globalName: "WB", outfile, logLevel: "error", target: ["chrome120"] });
  const source = `${readFileSync(outfile, "utf8")}\n;globalThis.WB = WB;`;
  rmSync(dir, { recursive: true, force: true });
  return source;
}

/** The HTML as the content script's first collection reads it (test/web-bench/bench.mjs measurePage). */
async function readHtml(context, bundle, doc) {
  const body = readFileSync(join(CORPUS, doc.html));
  const page = await context.newPage();
  let served = false;
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !served) {
      served = true;
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    }
    return route.abort();
  });
  try {
    await page.goto(doc.html_source, { waitUntil: "load", timeout: 60000 }).catch(async (error) => {
      if ((await page.evaluate(() => document.readyState).catch(() => "loading")) === "loading") throw error;
    });
    // arXiv's stylesheet is not in the corpus. What of it changes what the walk reads is
    // LaTeXML's own (LaTeXML.css): a footnote's text shows on hover only, not in the line,
    // and a run-in title — \paragraph's, a theorem's or a proof's head — is set in the line
    // of the paragraph it opens. `--css notes` keeps the first rule only.
    // (addStyleTag waits for a load event that never fires with page scripts off.)
    await page.evaluate((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
    }, CSS);
    await page.evaluate(bundle);
    return await page.evaluate((o) => WB.measure(o), { scope: "page", extractor: "none", explain: true });
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * The truth without its formulas. Neither reading keeps a formula (the walker skips
 * MathML, the PDF path the glyphs set in a mathematics face), so the words either side of
 * one meet in both, and the truth is made to read the same way: otherwise the anchors that
 * place a reading on the truth break at every formula and the words after it look missing.
 */
function withoutMath(truth) {
  const keep = [];
  const remap = new Int32Array(truth.tokens.length + 1);
  truth.tokens.forEach((t, q) => {
    remap[q] = keep.length;
    if (t.cat !== "inline-math" && t.cat !== "display-math") keep.push(t);
  });
  remap[truth.tokens.length] = keep.length;
  return {
    tokens: keep,
    paras: truth.paras.map((p) => (p.start < 0 ? p : { ...p, start: remap[p.start], end: remap[p.end] })),
  };
}

/** Each side's tokens on the truth: the unit that owns every truth token, and the text a
 *  side has that the truth does not, by the paragraph it stands in. */
function placeOnTruth(truth, run, unitOfBlock) {
  const aligned = alignDocument(truth, run);
  const unitOf = new Int32Array(truth.tokens.length).fill(-1);
  const blockOf = new Int32Array(truth.tokens.length).fill(-1);
  const extras = [];
  for (const b of aligned.blocks) {
    const T = b.toks;
    for (let i = 0; i < T.length; i++) {
      const tok = T[i];
      if (tok.gt >= 0) {
        unitOf[tok.gt] = unitOfBlock[tok.block];
        blockOf[tok.gt] = tok.block;
        continue;
      }
      if (unitOfBlock[tok.block] < 0) continue;
      // A token the truth does not have: in the paragraph of the token before it, else after.
      let j = i - 1;
      while (j >= 0 && T[j].gt < 0) j--;
      let k = i + 1;
      while (k < T.length && T[k].gt < 0) k++;
      const a = j >= 0 ? truth.tokens[T[j].gt].para : -1;
      const z = k < T.length ? truth.tokens[T[k].gt].para : -1;
      extras.push({ unit: unitOfBlock[tok.block], para: a >= 0 ? a : z, t: tok.t, label: tok.label });
    }
  }
  return { unitOf: [...unitOf], blockOf: [...blockOf], extras };
}

async function readAll(docs) {
  const todo = docs.filter((d) => !existsSync(join(OUT, "read", `${safe(d.id)}.json`)));
  if (todo.length === 0) return;
  mkdirSync(join(OUT, "read"), { recursive: true });
  const engine = await loadPipeline();
  const bundle = await bundlePage();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 850 }, serviceWorkers: "block" });
  try {
    for (const doc of todo) {
      const began = Date.now();
      const z = JSON.parse(readFileSync(join(RAW, `${safe(doc.id)}.json`), "utf8"));
      const pdf = await runStructured(engine, join(CORPUS, doc.file), z.structure, z.ms);
      const web = await readHtml(context, bundle, doc);
      const truth = withoutMath(truthOf(readFileSync(join(CORPUS, doc.html), "utf8")));
      // The web's units as blocks: a unit's text is its parts joined by "\n\n".
      const webBlocks = [];
      const webUnits = web.units.map((u, k) => {
        const blocks = u.text.split("\n\n").map((text) => webBlocks.push({ text, page: 0, kind: "paragraph" }) - 1);
        return { text: u.text, words: u.words, blocks, where: u.where, landmark: u.landmark, comment: u.comment, k };
      });
      const pdfUnitOfBlock = new Int32Array(pdf.blocks.length).fill(-1);
      pdf.units.forEach((u, k) => { for (const b of u.blocks) pdfUnitOfBlock[b] = k; });
      const webUnitOfBlock = new Int32Array(webBlocks.length).fill(-1);
      webUnits.forEach((u, k) => { for (const b of u.blocks) webUnitOfBlock[b] = k; });
      const pdfPlaced = placeOnTruth(truth, { blocks: pdf.blocks, units: pdf.units, pages: pdf.pages }, pdfUnitOfBlock);
      const webPlaced = placeOnTruth(truth, { blocks: webBlocks, units: webUnits }, webUnitOfBlock);
      const record = {
        id: doc.id, stratum: doc.stratum, features: doc.features, pages: pdf.numPages, css: flag("css", "latexml"),
        truth: { cats: truth.tokens.map((t) => t.cat), paras: truth.paras.map((p, i) => ({ ...p, i })), words: truth.tokens.map((t) => t.r) },
        pdf: { units: pdf.units.map((u) => ({ text: u.text, words: u.words, blocks: u.blocks, page: u.page })), blocks: pdf.blocks.map((b) => ({ text: b.text, kind: b.kind, page: b.page })), ...pdfPlaced },
        web: { units: webUnits, silent: (web.silent ?? []).map((s) => ({ words: s.words, reason: s.reason, text: s.text.slice(0, 600) })), ...webPlaced },
      };
      writeFileSync(join(OUT, "read", `${safe(doc.id)}.json`), JSON.stringify(record));
      console.log(`read ${doc.id} [${doc.stratum}] pdf ${record.pdf.units.length} units, html ${record.web.units.length} units, ${((Date.now() - began) / 1000).toFixed(1)} s`);
    }
  } finally {
    await browser.close();
  }
}

// ---- the engine ------------------------------------------------------------------------------

const APP_FILES = ["native_host.py", "native_component.py", "download_modelkit.py", "model_plan.py", "modelkit.json",
  "runtime_controller.py", "runtime_adapters.py", "benchmark_worker.py", "scoring.py", "engine.py", "safe_files.py", "pyproject.toml"];

/** A throwaway component home holding links to the files the host's own plan selects. */
function prepareHome(python, kit, lid) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "anagram-consistency-home-")));
  const home = join(base, "owned");
  const plan = JSON.parse(execFileSync(python, ["-I", "-B", "-c",
    "import sys,json;sys.path.insert(0,sys.argv[1]);from model_plan import build_plan,discover_hardware;" +
    "from download_modelkit import load_pin,PIN;print(json.dumps(build_plan(load_pin(PIN),discover_hardware())))", DAEMON], { encoding: "utf8" }));
  const pin = JSON.parse(readFileSync(join(DAEMON, "modelkit.json"), "utf8"));
  mkdirSync(join(home, "app"), { recursive: true });
  mkdirSync(join(home, "models", "editlens_roberta-large"), { recursive: true });
  writeFileSync(join(home, ".native-component.json"), JSON.stringify({ schema_version: 1, host: "dev.coderbak.anagram", home }));
  for (const name of APP_FILES) copyFileSync(join(DAEMON, name), join(home, "app", name));
  const link = (from, to) => {
    mkdirSync(dirname(to), { recursive: true });
    try { linkSync(from, to); } catch { copyFileSync(from, to); }
  };
  for (const entry of pin.files) if (plan.selected_paths.includes(entry.path)) link(join(kit, entry.path), join(home, "models", "editlens_roberta-large", entry.path));
  link(lid, join(home, "models", "lid.176.ftz"));
  writeFileSync(join(home, "app", "consistency-fixture.py"),
    "import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(__file__).parent))\n" +
    "import download_modelkit\ndef no_network(*a,**k): raise AssertionError('attempted a download')\n" +
    "download_modelkit.transfer_asset=no_network\nimport native_host\nnative_host.main()\n");
  return { base, home };
}

/** The native host over stdio: four-byte length, then JSON, answers matched by id. */
class Host {
  constructor(python, home, logFile) {
    this.log = openSync(logFile, "a");
    this.child = spawn(python, ["-I", "-u", join(home, "app", "consistency-fixture.py"), "--home", home], { cwd: home, stdio: ["pipe", "pipe", this.log] });
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.seq = 0;
    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (this.buffer.length < 4 + size) break;
        const reply = JSON.parse(this.buffer.subarray(4, 4 + size).toString("utf8"));
        this.buffer = this.buffer.subarray(4 + size);
        const waiter = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        waiter?.(reply);
      }
    });
    this.child.on("exit", (code) => { for (const w of this.pending.values()) w({ ok: false, error: { code: "exit", message: `host exited ${code}` } }); this.pending.clear(); });
  }

  async request(op, payload = {}) {
    const id = `c-${++this.seq}`;
    const body = Buffer.from(JSON.stringify({ v: 1, id, op, payload }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    const reply = await new Promise((done) => {
      this.pending.set(id, done);
      this.child.stdin.write(Buffer.concat([head, body]));
    });
    if (!reply.ok) throw new Error(`${op}: ${JSON.stringify(reply.error ?? reply)}`);
    return reply.data;
  }

  async ready() {
    for (const end = Date.now() + 600000; Date.now() < end;) {
      const s = await this.request("status");
      if (s.state === "ready") return s;
      if (s.state === "error") throw new Error(`engine error ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("engine never became ready");
  }

  close() {
    this.child.stdin.end();
    return new Promise((done) => { this.child.on("exit", done); setTimeout(() => { this.child.kill(); done(); }, 60000); }).finally(() => closeSync(this.log));
  }
}

// ---- score ------------------------------------------------------------------------------------

async function scoreAll(docs) {
  const todo = docs.filter((d) => !existsSync(join(OUT, "scores", `${safe(d.id)}.json`)));
  if (todo.length === 0) return;
  mkdirSync(join(OUT, "scores"), { recursive: true });
  const python = flag("python"), kit = flag("modelkit"), lid = flag("lid");
  if (!python || !kit || !lid) throw new Error("scoring needs --python, --modelkit and --lid");
  const { pipeline } = await loadPipeline();
  const { base, home } = prepareHome(python, resolve(kit), resolve(lid));
  const host = new Host(python, home, join(OUT, "host.log"));
  try {
    const status = await host.ready();
    const version = (await host.request("health")).model.ver;
    console.log(`engine ready: ${status.runtime.active_id} ${version}`);
    // Window texts already scored, by this model version: the model form is the cache key,
    // as it is in the extension (lib/backend/swCache.ts).
    const cacheFile = join(OUT, "cache.jsonl");
    const cache = new Map();
    if (existsSync(cacheFile)) for (const line of readFileSync(cacheFile, "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.v === version) cache.set(row.text, row.r);
    }
    let asked = 0, passes = 0;
    const scoreBlocks = async (blocks) => {
      const out = new Map();
      const need = new Map();
      for (const b of blocks) {
        const hit = cache.get(b.text);
        if (hit) out.set(b.id, { ...hit, id: b.id });
        else if (!need.has(b.text)) need.set(b.text, [b.id]);
        else need.get(b.text).push(b.id);
      }
      const unique = [...need.keys()].map((text, i) => ({ id: `b${i}`, text }));
      for (const slice of pipeline.requestSlices(unique, (b) => b.text.length)) {
        const data = await host.request("score", { v: "3.0", blocks: slice });
        asked += slice.length;
        for (const r of data.results) {
          const text = slice.find((b) => b.id === r.id).text;
          if (!r.degraded) {
            cache.set(text, r);
            appendFileSync(cacheFile, `${JSON.stringify({ v: version, text, r })}\n`);
          }
          for (const id of need.get(text)) out.set(id, { ...r, id });
        }
      }
      passes += blocks.length;
      return out;
    };
    // lib/messaging/client.ts requestTokenCounts: at most 512 texts and 200 000 characters a request.
    const countTokens = async (texts) => {
      const counts = { alone: [], following: [] };
      for (let at = 0; at < texts.length;) {
        let end = at, chars = 0;
        while (end < texts.length && end - at < 512 && (end === at || chars + texts[end].length <= 200000)) chars += texts[end++].length;
        const got = await host.request("tokens", { v: "3.0", texts: texts.slice(at, end) });
        counts.alone.push(...got.alone);
        counts.following.push(...got.following);
        at = end;
      }
      return counts;
    };
    for (const doc of todo) {
      const began = Date.now();
      const rec = JSON.parse(readFileSync(join(OUT, "read", `${safe(doc.id)}.json`), "utf8"));
      const verdicts = {};
      for (const side of ["pdf", "web"]) {
        const items = rec[side].units.map((u, k) => ({ id: `${side}${k}`, text: u.text, order: k }));
        // The orchestrator sends a batch of units at a time; a page's first batches are
        // what is on screen. The batch changes nothing about any one unit's verdict.
        const read = await pipeline.readInWindows(items, scoreBlocks, countTokens);
        verdicts[side] = items.map((item) => {
          const windows = read.get(item.id) ?? [];
          const v = pipeline.unitVerdict(item.id, item.text.length, windows);
          const r = v.result;
          return {
            score: r.score, probs: r.probs, level: r.degraded || r.unsupported ? null : pipeline.levelOf(r.score),
            degraded: !!r.degraded, unsupported: !!r.unsupported, truncated: !!r.truncated,
            passes: windows.map((w) => ({ start: w.start, end: w.end, score: w.result.score, tokens: w.result.tokens, unsupported: !!w.result.unsupported })),
          };
        });
      }
      writeFileSync(join(OUT, "scores", `${safe(doc.id)}.json`), JSON.stringify({ id: doc.id, version, runtime: status.runtime.active_id, ...verdicts }));
      console.log(`scored ${doc.id} ${((Date.now() - began) / 1000).toFixed(1)} s (${asked} texts asked so far, ${passes} passes)`);
    }
  } finally {
    await host.close();
    rmSync(base, { recursive: true, force: true });
  }
}

// ---- compare ----------------------------------------------------------------------------------

/** The unit that owns most of a paragraph's prose tokens on one side, and how much it owns. */
function holder(unitOf, prose) {
  const counts = new Map();
  for (const q of prose) if (unitOf[q] >= 0) counts.set(unitOf[q], (counts.get(unitOf[q]) ?? 0) + 1);
  let unit = -1, n = 0, covered = 0, second = 0;
  for (const [u, c] of counts) {
    covered += c;
    if (c > n) { second = n; unit = u; n = c; } else if (c > second) second = c;
  }
  const of = (x) => (prose.length ? x / prose.length : 0);
  // Split: another unit holds a tenth of it or more (a stray token placed elsewhere is not a split).
  return { unit, share: of(n), covered: of(covered), split: of(second) >= 0.1 };
}

const quantile = (xs, p) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
};
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "—");
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const table = (rows, head) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function compareDocument(rec, sc, pipeline) {
  const cats = rec.truth.cats;
  const tokenCount = (text) => tokenize(text).map((x) => x.t);
  const unitParas = (side) => {
    // The truth paragraphs each unit holds most of (≥ half of their prose tokens).
    const out = rec[side].units.map(() => new Set());
    for (const p of rec.truth.paras) {
      if (!PROSE.has(p.cat) || p.start < 0) continue;
      const prose = [];
      for (let q = p.start; q < p.end; q++) if (PROSE.has(cats[q])) prose.push(q);
      const h = holder(rec[side].unitOf, prose);
      if (h.unit >= 0 && h.share >= 0.5) out[h.unit].add(p.i);
    }
    return out;
  };
  const parasOf = { pdf: unitParas("pdf"), web: unitParas("web") };
  const extrasBy = (side) => {
    const m = new Map();
    for (const e of rec[side].extras) {
      if (e.para < 0) continue;
      if (!m.has(e.para)) m.set(e.para, []);
      m.get(e.para).push(e);
    }
    return m;
  };
  const extras = { pdf: extrasBy("pdf"), web: extrasBy("web") };
  const rows = [];
  for (const p of rec.truth.paras) {
    if (!PROSE.has(p.cat) || p.start < 0) continue;
    const prose = [];
    for (let q = p.start; q < p.end; q++) if (PROSE.has(cats[q])) prose.push(q);
    if (prose.length < 4) continue;
    const a = holder(rec.pdf.unitOf, prose);
    const b = holder(rec.web.unitOf, prose);
    const va = a.unit >= 0 ? sc.pdf[a.unit] : null;
    const vb = b.unit >= 0 ? sc.web[b.unit] : null;
    const readA = a.share >= 0.5 && va && va.level !== null;
    const readB = b.share >= 0.5 && vb && vb.level !== null;
    const row = { doc: rec.id, stratum: rec.stratum, para: p.i, cat: p.cat, words: prose.length, pdfUnit: a.unit, webUnit: b.unit, pdfShare: a.share, webShare: b.share, readA, readB };
    if (readA !== readB) {
      // Read on one side only: why the other side did not. The PDF keeps every block it
      // read, scored or not; the web keeps only units, and the walker's own survey says
      // why the rest of the page's prose got none (lib/diagnostics/silence.ts).
      if (!readA) row.why = prose.filter((q) => rec.pdf.blockOf[q] >= 0).length >= prose.length / 2 ? "PDF: read, not scored" : "PDF: not read";
      else {
        const words = new Set(prose.map((q) => rec.truth.words[q].toLowerCase()));
        const hit = rec.web.silent.find((x) => {
          const t = new Set(tokenize(x.text).map((k) => k.t));
          let n = 0;
          for (const w of words) if (t.has(w)) n++;
          return n >= words.size * 0.8;
        });
        row.why = hit ? `HTML: ${hit.reason.replace(/\d+/g, "N").replace(/:.*$/, "")}` : "HTML: not read";
      }
    }
    // What stands in the paragraph on one side and not the other: truth tokens (a
    // citation, a formula's letters, a footnote mark) and text the truth does not have.
    const onlyPdf = {}, onlyWeb = {};
    for (let q = p.start; q < p.end; q++) {
      const x = rec.pdf.unitOf[q] === a.unit && a.unit >= 0, y = rec.web.unitOf[q] === b.unit && b.unit >= 0;
      if (x && !y) onlyPdf[cats[q]] = (onlyPdf[cats[q]] ?? 0) + 1;
      if (y && !x) onlyWeb[cats[q]] = (onlyWeb[cats[q]] ?? 0) + 1;
    }
    for (const e of extras.pdf.get(p.i) ?? []) if (e.unit === a.unit) onlyPdf[`+${e.label}`] = (onlyPdf[`+${e.label}`] ?? 0) + 1;
    for (const e of extras.web.get(p.i) ?? []) if (e.unit === b.unit) onlyWeb[`+${e.label}`] = (onlyWeb[`+${e.label}`] ?? 0) + 1;
    row.onlyPdf = onlyPdf;
    row.onlyWeb = onlyWeb;
    row.sameParaText = Object.keys(onlyPdf).length === 0 && Object.keys(onlyWeb).length === 0;
    if (readA && readB) {
      const ua = rec.pdf.units[a.unit], ub = rec.web.units[b.unit];
      const pa = parasOf.pdf[a.unit], pb = parasOf.web[b.unit];
      row.sameBounds = pa.size === pb.size && [...pa].every((x) => pb.has(x)) && !a.split && !b.split;
      row.split = a.split ? (b.split ? "both" : "pdf") : b.split ? "web" : null;
      row.identical = pipeline.modelText(ua.text) === pipeline.modelText(ub.text);
      const ta = tokenCount(ua.text), tb = tokenCount(ub.text);
      row.sameWords = ta.length === tb.length && ta.every((t, i) => t === tb[i]);
      row.pdfParas = pa.size;
      row.webParas = pb.size;
      row.pdfPasses = va.passes.length;
      row.webPasses = vb.passes.length;
      row.pdfWords = ua.words;
      row.webWords = ub.words;
      row.pdfScore = va.score;
      row.webScore = vb.score;
      row.pdfLevel = va.level;
      row.webLevel = vb.level;
      row.diff = va.score - vb.score;
      row.kind = row.sameBounds ? (row.identical ? "identical input" : row.sameWords ? "same boundaries, same words" : "same boundaries, different words")
        : row.sameParaText ? "different boundaries, same paragraph text" : "different boundaries, different paragraph text";
    }
    rows.push(row);
  }
  // The document as a whole: the units each side scored, and how much of it is flagged.
  const doc = { id: rec.id, stratum: rec.stratum };
  for (const side of ["pdf", "web"]) {
    let words = 0, flagged = 0, mean = 0, units = 0, flaggedUnits = 0, passes = 0;
    rec[side].units.forEach((u, k) => {
      const v = sc[side][k];
      if (!v || v.level === null) return;
      units++;
      words += u.words;
      mean += u.words * v.score;
      passes += v.passes.length > 1 ? 1 : 0;
      if (v.level === 3) { flagged += u.words; flaggedUnits++; }
    });
    doc[side] = { units, words, flaggedWords: flagged, flaggedShare: words ? flagged / words : 0, flaggedUnits, meanScore: words ? mean / words : NaN, multiPass: passes };
  }
  return { rows, doc };
}

function report(docs, pipeline) {
  const all = [], perDoc = [];
  let engine = "", css = "";
  for (const d of docs) {
    const rf = join(OUT, "read", `${safe(d.id)}.json`), sf = join(OUT, "scores", `${safe(d.id)}.json`);
    if (!existsSync(rf) || !existsSync(sf)) continue;
    const sc = JSON.parse(readFileSync(sf, "utf8"));
    engine = `${sc.runtime} ${sc.version}`;
    const rec = JSON.parse(readFileSync(rf, "utf8"));
    css = rec.css ?? flag("css", "latexml");
    const { rows, doc } = compareDocument(rec, sc, pipeline);
    all.push(...rows);
    perDoc.push(doc);
  }
  const both = all.filter((r) => r.readA && r.readB);
  const out = [];
  const byStratum = new Map([["all", perDoc.map((d) => d.id)]]);
  for (const d of perDoc) { if (!byStratum.has(d.stratum)) byStratum.set(d.stratum, []); byStratum.get(d.stratum).push(d.id); }
  const summarize = (rows) => {
    const diffs = rows.map((r) => Math.abs(r.diff));
    const w = rows.reduce((s, r) => s + r.words, 0);
    const wsum = (f) => rows.reduce((s, r) => s + (f(r) ? r.words : 0), 0) / Math.max(1, w);
    return {
      n: rows.length, words: w,
      level: rows.filter((r) => r.pdfLevel === r.webLevel).length / Math.max(1, rows.length), levelW: wsum((r) => r.pdfLevel === r.webLevel),
      flag: rows.filter((r) => (r.pdfLevel === 3) === (r.webLevel === 3)).length / Math.max(1, rows.length), flagW: wsum((r) => (r.pdfLevel === 3) === (r.webLevel === 3)),
      mean: diffs.reduce((s, x) => s + x, 0) / Math.max(1, diffs.length), p50: quantile(diffs, 0.5), p90: quantile(diffs, 0.9), p99: quantile(diffs, 0.99), max: diffs.length ? Math.max(...diffs) : NaN,
      over05: diffs.filter((x) => x > 0.05).length / Math.max(1, diffs.length), over10: diffs.filter((x) => x > 0.1).length / Math.max(1, diffs.length), over25: diffs.filter((x) => x > 0.25).length / Math.max(1, diffs.length),
      bias: rows.reduce((s, r) => s + r.diff, 0) / Math.max(1, rows.length),
    };
  };
  const head = ["", "paragraphs", "words", "same word", "(by words)", "same AI flag", "(by words)", "mean |Δ|", "median", "p90", "p99", "max", ">.05", ">.10", ">.25", "mean PDF−HTML"];
  const line = (name, s) => [name, s.n, s.words, pct(s.level), pct(s.levelW), pct(s.flag), pct(s.flagW), f3(s.mean), f3(s.p50), f3(s.p90), f3(s.p99), f3(s.max), pct(s.over05), pct(s.over10), pct(s.over25), f3(s.bias)];
  out.push(`# PDF and HTML verdicts on the same paper`, "",
    `${perDoc.length} arXiv papers (${[...byStratum].filter(([k]) => k !== "all").map(([k, v]) => `${v.length} ${k}`).join(", ")}). A paragraph is one p.ltx_p of arXiv's HTML (prose, ≥ 4 tokens); each side's verdict for it is that of the unit holding most of it. Scores 0–1; words cut at 1/6, 1/2, 5/6; flag = AI-generated.`, "",
    `Engine ${engine}. HTML read with page scripts off, nothing but the page loaded, and ${css === "notes" ? "LaTeXML's footnote rule" : "LaTeXML's footnote and run-in title rules"} in place of arXiv's stylesheet; the browser's own language check is not run (the engine's is).`, "");
  const reads = { both: both.length, pdfOnly: all.filter((r) => r.readA && !r.readB).length, webOnly: all.filter((r) => !r.readA && r.readB).length, neither: all.filter((r) => !r.readA && !r.readB).length };
  const wordsOf = (rows) => rows.reduce((s, r) => s + r.words, 0);
  out.push(`Paragraphs: ${all.length} (${wordsOf(all)} prose tokens). Read on both sides ${reads.both} (${wordsOf(both)}), PDF only ${reads.pdfOnly} (${wordsOf(all.filter((r) => r.readA && !r.readB))}), HTML only ${reads.webOnly} (${wordsOf(all.filter((r) => !r.readA && r.readB))}), neither ${reads.neither} (${wordsOf(all.filter((r) => !r.readA && !r.readB))}).`, "");
  const whyRows = new Map();
  for (const r of all) if (r.why) { const c = whyRows.get(r.why) ?? { n: 0, words: 0, short: 0 }; c.n++; c.words += r.words; c.short += r.words < 75 ? 1 : 0; whyRows.set(r.why, c); }
  out.push("Why a paragraph was read on one side only (the side that did not read it):", "",
    table([...whyRows].sort((x, y) => y[1].words - x[1].words).map(([k, c]) => [k, c.n, c.words, c.short]), ["reason", "paragraphs", "prose tokens", "of them under 75 tokens"]), "");
  out.push("## Agreement on paragraphs read on both sides", "");
  const rowsBy = (pred) => both.filter(pred);
  const idsIn = (name) => new Set(byStratum.get(name));
  out.push(table([...byStratum.keys()].map((k) => line(k, summarize(k === "all" ? both : rowsBy((r) => idsIn(k).has(r.doc))))), head), "");
  const kinds = ["identical input", "same boundaries, same words", "same boundaries, different words", "different boundaries, same paragraph text", "different boundaries, different paragraph text"];
  out.push("## By what differs between the two readings", "", table(kinds.map((k) => line(k, summarize(rowsBy((r) => r.kind === k)))), head), "");
  out.push("Passes: ", table([
    line("one pass on both sides", summarize(rowsBy((r) => r.pdfPasses === 1 && r.webPasses === 1))),
    line("several passes on a side", summarize(rowsBy((r) => r.pdfPasses > 1 || r.webPasses > 1))),
  ], head), "");
  // Confusion of the words.
  const conf = LEVELS.map(() => LEVELS.map(() => 0));
  for (const r of both) conf[r.pdfLevel][r.webLevel]++;
  out.push("Words, PDF (rows) against HTML (columns):", "", table(conf.map((row, i) => [LEVELS[i], ...row]), ["PDF \\ HTML", ...LEVELS]), "");
  // How close to a cut the paragraphs whose words differ sit.
  const CUTS = [1 / 6, 1 / 2, 5 / 6];
  const offCut = (r) => Math.min(...CUTS.filter((c) => (r.pdfScore - c) * (r.webScore - c) <= 0).map((c) => Math.max(Math.abs(r.pdfScore - c), Math.abs(r.webScore - c))));
  const split = both.filter((r) => r.pdfLevel !== r.webLevel);
  out.push(`Of the ${split.length} paragraphs whose word differs, both scores lie within 0.05 of the cut between them for ${split.filter((r) => offCut(r) <= 0.05).length}, within 0.10 for ${split.filter((r) => offCut(r) <= 0.1).length}.`, "");
  // Causes: what one side's paragraph has that the other's does not.
  const causeCount = (pick) => {
    const m = new Map();
    for (const r of both) for (const [k, v] of Object.entries(pick(r))) { const c = m.get(k) ?? { paras: 0, tokens: 0 }; c.paras++; c.tokens += v; m.set(k, c); }
    return [...m].sort((x, y) => y[1].paras - x[1].paras);
  };
  out.push("## Text in one reading of a paragraph and not in the other", "",
    "Truth categories (cite, inline-math, mark, footnote, body…) are HTML tokens only one side read inside that paragraph; `+label` is text the HTML does not have (align.mjs's label: noise = a mangled word such as a mended hyphen, number, inline-math, unmatched…).", "",
    table(causeCount((r) => r.onlyPdf).slice(0, 14).map(([k, c]) => [`PDF only: ${k}`, c.paras, c.tokens]), ["what", "paragraphs", "tokens"]), "",
    table(causeCount((r) => r.onlyWeb).slice(0, 14).map(([k, c]) => [`HTML only: ${k}`, c.paras, c.tokens]), ["what", "paragraphs", "tokens"]), "");
  // Boundaries.
  const diffB = rowsBy((r) => !r.sameBounds);
  const bcount = (pred) => diffB.filter(pred).length;
  out.push("## Different boundaries", "",
    `${diffB.length} paragraphs: PDF unit holds more paragraphs ${bcount((r) => r.pdfParas > r.webParas)}, HTML unit holds more ${bcount((r) => r.webParas > r.pdfParas)}, same count but different paragraphs ${bcount((r) => r.pdfParas === r.webParas)}. The paragraph itself split between two units: on the PDF ${bcount((r) => r.split === "pdf" || r.split === "both")}, on the HTML ${bcount((r) => r.split === "web" || r.split === "both")}.`, "");
  // Documents.
  const dd = perDoc.map((d) => ({ ...d, diff: d.pdf.flaggedShare - d.web.flaggedShare, mdiff: d.pdf.meanScore - d.web.meanScore }));
  const lvl = (x) => pipeline.levelOf(x);
  out.push("## Documents", "",
    "The product gives a document no verdict of its own: the panel counts flagged units. Here: the share of scored words in AI-generated units, whether any unit is flagged, and the word-weighted mean score (and the word it would read as).", "",
    `Any unit flagged: same on ${dd.filter((d) => (d.pdf.flaggedUnits > 0) === (d.web.flaggedUnits > 0)).length}/${dd.length}. |Δ flagged share| mean ${f3(dd.reduce((s, d) => s + Math.abs(d.diff), 0) / Math.max(1, dd.length))}, max ${f3(Math.max(...dd.map((d) => Math.abs(d.diff))))}. |Δ mean score| mean ${f3(dd.reduce((s, d) => s + Math.abs(d.mdiff), 0) / Math.max(1, dd.length))}, max ${f3(Math.max(...dd.map((d) => Math.abs(d.mdiff))))}; word of the mean score the same on ${dd.filter((d) => lvl(d.pdf.meanScore) === lvl(d.web.meanScore)).length}/${dd.length}.`, "",
    table(dd.map((d) => [d.id, d.stratum, `${d.pdf.units} / ${d.web.units}`, `${d.pdf.words} / ${d.web.words}`, `${d.pdf.flaggedUnits} / ${d.web.flaggedUnits}`, `${pct(d.pdf.flaggedShare)} / ${pct(d.web.flaggedShare)}`, `${f3(d.pdf.meanScore)} / ${f3(d.web.meanScore)}`]),
      ["paper", "stratum", "units PDF / HTML", "words", "flagged units", "flagged share", "mean score"]), "");
  // Examples: the largest differences of each kind.
  out.push("## Largest differences", "");
  for (const k of kinds.slice(1)) {
    const ex = rowsBy((r) => r.kind === k).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 4);
    if (ex.length === 0) continue;
    out.push(`### ${k}`, "");
    for (const r of ex) {
      const rec = JSON.parse(readFileSync(join(OUT, "read", `${safe(r.doc)}.json`), "utf8"));
      const clip = (s) => (s.length > 700 ? `${s.slice(0, 700)}…` : s).replace(/\n\n/g, " ¶ ").replace(/\|/g, "\\|");
      out.push(`- ${r.doc} ¶${r.para}: PDF ${f3(r.pdfScore)} (${LEVELS[r.pdfLevel]}, ${r.pdfPasses} pass${r.pdfPasses > 1 ? "es" : ""}, ${r.pdfParas} ¶) vs HTML ${f3(r.webScore)} (${LEVELS[r.webLevel]}, ${r.webPasses} pass${r.webPasses > 1 ? "es" : ""}, ${r.webParas} ¶). PDF only ${JSON.stringify(r.onlyPdf)}; HTML only ${JSON.stringify(r.onlyWeb)}`,
        `  - PDF: ${clip(rec.pdf.units[r.pdfUnit].text)}`, `  - HTML: ${clip(rec.web.units[r.webUnit].text)}`);
    }
    out.push("");
  }
  const text = out.join("\n");
  writeFileSync(join(OUT, "report.md"), text);
  writeFileSync(join(OUT, "paragraphs.json"), JSON.stringify(all));
  writeFileSync(join(OUT, "documents.json"), JSON.stringify(perDoc, null, 1));
  console.log(text);
}

// ---- main -------------------------------------------------------------------------------------

if (!RAW || !flag("features")) {
  console.log("usage: consistency.mjs <zotero dumps> --features <bench run dir> --python <python> --modelkit <dir> --lid <file> --out <dir> [--n 50] [--only ids] [--step read|score|compare]");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const docs = sample(Number(flag("n", "50")));
writeFileSync(join(OUT, "sample.json"), JSON.stringify(docs.map((d) => ({ id: d.id, stratum: d.stratum, features: d.features })), null, 1));
const step = flag("step", "all");
if (step === "all" || step === "read") await readAll(docs);
if (step === "all" || step === "score") await scoreAll(docs);
if (step === "all" || step === "compare") report(docs, (await loadPipeline()).pipeline);
