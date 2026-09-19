// test/coverage.mjs — does the segmenter SEE the text a reader sees, on real websites?
//
// test/survey.mjs watches the whole extension (chips, bands, the daemon). This is the
// layer below it: no extension, no daemon, no fixtures — just lib/dom/walker.ts, bundled
// out of the tree exactly as test/unit.mjs bundles it, injected into a live page and asked
// one question per page: WHICH text got a unit, and which did not. The list of pages lives
// in test/coverage.urls.json (name / kind / url / post selector / note) and is meant to be
// broad — news, blogs, papers, docs, wikis, forums, social, shops, video, long documents,
// AI surfaces, mail archives — because every one of them builds a "post" out of different
// markup. Nothing here asserts; it reports, so the same list can be re-run after a change
// to the grouping rules and the two runs diffed.
//
// Per page it records, by numbers and tag names only (a 40-character digit-masked hint is
// kept where a finding needs one to be legible — no page text beyond that):
//
//   reachability — ok / login wall / bot check / blocked / timeout — and the final URL;
//   units, merged units, words judged vs words of visible prose (the exclusion rule is
//     printed in the report: nav/header/footer/aside + landmark roles + dialogs, plus
//     invisible and zero-size subtrees and the never-scored tags);
//   SILENT     — a post container (or, with no post selector, the smallest block holding
//                ≥ 50 words) that produced NO unit, with a structural reason obtained by
//                re-running the walker's own predicates in the page: excluded by ancestry
//                (which test, which ancestor), boilerplate class token (which token),
//                link-dense, name-list, symbol noise, aria-hidden, contenteditable,
//                zero-size container, no paragraph and no mergeable group reaching the
//                floor, or a "show more" control that truncates the text;
//   FRAGMENTED — one post covered by several units (parts/words of each), and single
//                paragraphs whose text nodes ended up in two different units;
//   CROSSING   — a unit whose parts lie in two posts, or in a post and outside it, and
//                (post selector or not) a unit whose parts lie in two different voice
//                scopes as walker.ts defines them;
//   CHROME     — units inside nav / header / footer / aside / cookie banners / sidebars /
//                "related" widgets / code blocks / tables;
//   WEIGHT     — elements visited, collectUnits time, longest task over 200 ms.
//
//   node test/coverage.mjs                        # the whole list
//   node test/coverage.mjs wikipedia reddit       # only entries whose name contains one
//   node test/coverage.mjs --label before         # → coverage-before.json + .md
//   node test/coverage.mjs --kind forum --jobs 2
//   node test/coverage.mjs --diff a.json b.json   # what changed between two runs
//
// Reports go to ANAGRAM_ARTIFACTS (or --out dir), never into the repo. Headless always;
// logged-out always (no profile, no cookies); at most one page of a site at a time, with a
// pause between two pages of the same host. A wall, a bot check or a timeout is a RESULT.
import { launchPlain, ARTIFACTS, sweep } from "./harness.mjs";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- command line ------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? true : v;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};

const DIFF = opt("diff", null);
const OUT_DIR = opt("out", ARTIFACTS);
const LABEL = String(opt("label", "run"));
const KIND = opt("kind", null);
const JOBS = Math.max(1, Number(opt("jobs", 4)) || 4);
const NAV_TIMEOUT = Number(opt("timeout", 20000)) || 20000;
const SCROLLS = Number(opt("scrolls", 4)) || 4;
const LIST_ONLY = flag("list");
const filters = argv.filter((a) => !a.startsWith("--")).map((s) => s.toLowerCase());

mkdirSync(OUT_DIR, { recursive: true });
const out = (name) => join(OUT_DIR, name);

// ---- diff mode ---------------------------------------------------------------------

if (DIFF) {
  const [bPath, aPath] = [DIFF, argv.find((a) => a.endsWith(".json") && a !== DIFF)];
  if (!aPath) {
    console.error("usage: node test/coverage.mjs --diff before.json after.json");
    process.exit(2);
  }
  diffRuns(bPath, aPath);
  process.exit(0);
}

/** Compare two runs page by page. Only what moved is printed. */
function diffRuns(beforePath, afterPath) {
  const load = (p) => {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return { label: j.label ?? basename(p), rows: new Map((j.pages ?? []).map((r) => [r.name, r])) };
  };
  const B = load(beforePath);
  const A = load(afterPath);
  const METRICS = [
    ["units", (r) => r.units],
    ["merged", (r) => r.merged],
    ["wordsJudged", (r) => r.wordsJudged],
    ["silent", (r) => (r.silent ?? []).length],
    ["fragmented", (r) => (r.fragmented ?? []).length],
    ["splitParagraphs", (r) => r.splitParagraphs],
    ["crossing", (r) => (r.crossing ?? []).length],
    ["crossingScopes", (r) => r.crossingScopes],
    ["chromeUnits", (r) => r.chromeUnits],
  ];
  const lines = [`# coverage diff — ${B.label} → ${A.label}`, ""];
  const names = [...new Set([...B.rows.keys(), ...A.rows.keys()])].sort();
  const gone = names.filter((n) => !A.rows.has(n));
  const fresh = names.filter((n) => !B.rows.has(n));
  const moved = [];
  for (const n of names) {
    const b = B.rows.get(n);
    const a = A.rows.get(n);
    if (!b || !a) continue;
    if (b.reach !== a.reach) moved.push(`| ${n} | reach | ${b.reach} | ${a.reach} |`);
    if (b.reach !== "ok" || a.reach !== "ok") continue;
    for (const [k, get] of METRICS) {
      const x = get(b) ?? 0;
      const y = get(a) ?? 0;
      if (x !== y) moved.push(`| ${n} | ${k} | ${x} | ${y} | ${y - x > 0 ? "+" : ""}${y - x} |`);
    }
  }
  lines.push(`| page | metric | ${B.label} | ${A.label} | Δ |`, "| --- | --- | --- | --- | --- |", ...moved);
  if (gone.length) lines.push("", `Only in ${B.label}: ${gone.join(", ")}`);
  if (fresh.length) lines.push("", `Only in ${A.label}: ${fresh.join(", ")}`);
  const text = lines.join("\n");
  const file = out(`coverage-diff-${B.label}-${A.label}.md`);
  writeFileSync(file, text + "\n");
  console.log(text);
  console.log(`\n→ ${file}`);
}

// ---- the list ----------------------------------------------------------------------

const ALL = JSON.parse(readFileSync(join(__dirname, "coverage.urls.json"), "utf8"));
const entries = ALL.filter(
  (e) =>
    (!KIND || e.kind === KIND) &&
    (filters.length === 0 || filters.some((f) => e.name.toLowerCase().includes(f) || e.kind.toLowerCase().includes(f))),
);
if (entries.length === 0) {
  console.error("no entries matched");
  process.exit(2);
}
if (LIST_ONLY) {
  for (const e of entries) console.log(`${e.kind.padEnd(10)} ${e.name.padEnd(28)} ${e.url}`);
  process.exit(0);
}

// ---- the injected code -------------------------------------------------------------
//
// Two bundles. The first is the shipped walker packaged for a live page (probe-entry.ts →
// window.__anagramProbe) plus test/fixtures/probe-report.js, exactly what a human pastes
// into DevTools. The second exposes the walker's own helper modules under window.__cov so
// the findings can name a STRUCTURAL reason (which exclusion, which class token) instead of
// guessing — it is built from the same tree, so it follows whatever the walker does today.

const PROBE = out(".coverage-probe.js");
const HELPERS = out(".coverage-helpers.js");
buildSync({
  entryPoints: [join(__dirname, "fixtures", "probe-entry.ts")],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outfile: PROBE,
  logLevel: "error",
});
buildSync({
  stdin: {
    contents: [
      'export * as walker from "../../lib/dom/walker";',
      'export * as text from "../../lib/dom/text";',
      'export * as boiler from "../../lib/dom/boilerplate";',
      'export * as tags from "../../lib/dom/tags";',
      'export * as style from "../../lib/dom/style";',
      'export * as types from "../../lib/types";',
    ].join("\n"),
    resolveDir: join(__dirname, "fixtures"),
    sourcefile: "coverage-helpers.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  globalName: "__cov",
  target: "chrome120",
  outfile: HELPERS,
  logLevel: "error",
});
const REPORT_JS = join(__dirname, "fixtures", "probe-report.js");

/** Longest-task recorder, installed before any page script runs. */
const LONGTASK_INIT = () => {
  window.__covLongest = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration > window.__covLongest) window.__covLongest = e.duration;
    }).observe({ type: "longtask", buffered: true });
  } catch {}
};

// ====================================================================================
// IN-PAGE ANALYSIS. Runs inside the page after both bundles are injected. Returns counts,
// tag names and short digit-masked hints only.
// ====================================================================================

function analyse(cfg) {
  const P = window.__anagramProbe;
  const C = window.__cov || {};
  const T = C.text || {};
  const B = C.boiler || {};
  const TG = C.tags || {};
  const W = C.walker || {};
  /** A heading is a barrier only while it is a LABEL. A container that merely DECLARES
   *  itself one — lobste.rs' comment bodies, a teaser card wrapped in an <h2> — is walked
   *  like the block it is, so calling it a barrier named the wrong reason for every text
   *  under it (tags.isHeadingLabel). */
  const headingBarrier = (el) => !!(TG.isHeading && TG.isHeading(el) && (!TG.isHeadingLabel || TG.isHeadingLabel(el)));
  /** A <pre> of PROSE — an RFC, a man page, a mailing-list message — is read like any other
   *  block; only the rest is machine text the walk never enters (walker.isProsePre). */
  const codePre = (el) => el.nodeName.toUpperCase() === "PRE" && !(W.isProsePre && W.isProsePre(el));
  const MARK = (C.types && C.types.MARK_ATTR) || "data-anagram";
  const MIN = typeof T.MIN_UNIT_WORDS === "number" ? T.MIN_UNIT_WORDS : 50;
  const MIN_MERGE = typeof T.MIN_MERGE_WORDS === "number" ? T.MIN_MERGE_WORDS : 8;
  const countWords = (P && P.countWords) || ((s) => (s.match(/\S+/g) || []).length);
  const words = (s) => countWords(String(s || "").replace(/\s+/g, " ").trim());

  /** ≤ 40 chars, digits masked, handles and mails removed — only to make a finding legible. */
  const hint = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .replace(/[\w.+-]+@[\w.-]+/g, "@")
      .replace(/\d/g, "#")
      .trim()
      .slice(0, 40);

  // ---- what counts as page chrome (printed in the report) ---------------------------
  const CHROME_SEL =
    'nav,header,footer,aside,dialog,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="dialog"],[role="menu"],[role="toolbar"],[role="search"]';
  const HARD_SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION", "OPTGROUP",
    "BUTTON", "SVG", "MATH", "IFRAME", "FRAME", "OBJECT", "EMBED", "HEAD", "TITLE",
    "IMG", "PICTURE", "VIDEO", "AUDIO", "CANVAS", "INPUT", "RT", "RP", "METER", "PROGRESS",
  ]);

  // ---- composed-tree helpers (mirror the walker: shadow roots replace light children) --
  const kidsOf = (el) => {
    const sr = el.shadowRoot;
    if (sr) return Array.from(sr.childNodes);
    if (typeof HTMLSlotElement !== "undefined" && el instanceof HTMLSlotElement) return el.assignedNodes({ flatten: true });
    return Array.from(el.childNodes);
  };
  const parentOf = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const containsComposed = (a, b) => {
    for (let cur = b; cur; cur = parentOf(cur)) if (cur === a) return true;
    return false;
  };
  const closestComposed = (el, sel) => {
    for (let cur = el; cur; ) {
      const hit = cur.closest(sel);
      if (hit) return hit;
      cur = cur.getRootNode() instanceof ShadowRoot ? cur.getRootNode().host : null;
    }
    return null;
  };

  const csCache = new WeakMap();
  const cs = (el) => {
    let v = csCache.get(el);
    if (v === undefined) {
      try {
        v = getComputedStyle(el);
      } catch {
        v = null;
      }
      csCache.set(el, v);
    }
    return v;
  };
  const rectVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /** Does this element occupy space? The walker asks this of the block that OWNS a run —
   *  never of its ancestors, and for good reason: a float/clearfix wrapper measures 0 px
   *  high while its children fill the screen (36氪), and `display:contents` has no box at
   *  all (MDN's <main>). Pruning on an ancestor's rect would lose whole articles. */
  const hasBox = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
  };
  const invisible = (el) => {
    const s = cs(el);
    if (!s) return false;
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || s.opacity === "0") return true;
    return el.getAttribute("aria-hidden") === "true";
  };

  // ---- one pass: visible words per subtree, chrome split off, smallest 50-word blocks --
  // `all` is every visible word in the subtree; `prose` is the same with chrome subtrees
  // zeroed. The smallest containers holding MIN prose words are the analysis set when the
  // entry names no post selector.
  const wordsOf = new Map();
  const proseOf = new Map();
  const blocks = [];
  let visited = 0;
  let chromeWords = 0;

  function walkWords(el, inChrome) {
    visited++;
    const tag = el.nodeName.toUpperCase();
    if (HARD_SKIP.has(tag)) return { all: 0, prose: 0 };
    if (invisible(el)) return { all: 0, prose: 0 };
    let chrome = inChrome;
    if (!chrome) {
      try {
        chrome = el.matches(CHROME_SEL);
      } catch {}
    }
    let all = 0;
    let prose = 0;
    let childMax = 0;
    let box;
    for (const n of kidsOf(el)) {
      if (n.nodeType === 3) {
        if (box === undefined) box = hasBox(el);
        if (!box) continue; // text owned by a collapsed box is not on screen
        const w = words(n.textContent);
        all += w;
        prose += w;
      } else if (n.nodeType === 1) {
        const r = walkWords(n, chrome);
        all += r.all;
        prose += r.prose;
        if (r.prose > childMax) childMax = r.prose;
      }
    }
    if (chrome) {
      if (!inChrome) chromeWords += all;
      prose = 0;
    }
    wordsOf.set(el, all);
    proseOf.set(el, prose);
    if (prose >= MIN && childMax < MIN) blocks.push(el);
    return { all, prose };
  }
  const proseWords = document.body ? walkWords(document.body, false).prose : 0;

  // ---- segment ---------------------------------------------------------------------
  const t0 = performance.now();
  const units = P.collectUnits(document.body);
  const collectMs = Math.round((performance.now() - t0) * 10) / 10;

  const unitContainers = units.map((u) => u.parts.map((p) => p.container));
  const unitsIn = (el) => {
    const hit = [];
    for (let i = 0; i < units.length; i++) {
      if (unitContainers[i].some((c) => containsComposed(el, c))) hit.push(i);
    }
    return hit;
  };

  // ---- the analysis set: the site's posts, or the page's smallest 50-word blocks ------
  let posts = [];
  if (cfg.post) {
    try {
      posts = Array.from(document.querySelectorAll(cfg.post)).filter((el) => hasBox(el));
    } catch {}
  }
  const usingPosts = posts.length > 0;
  const set = (usingPosts ? posts : blocks).slice(0, cfg.maxSet);
  // A post counts all of its visible words (a post inside an <aside> is still the reader's
  // text); a block candidate is prose by construction.
  const setWords = set.map((el) => (usingPosts ? wordsOf.get(el) ?? words(el.innerText) : proseOf.get(el) ?? 0));

  // ---- SILENT: ≥ 50 words of visible prose, no unit ----------------------------------

  /** Which branch of isBoilerplate() fired, probed on a detached element so the answer is
   *  the shipped predicate's, not a copy of its table. */
  function boilerWhy(el) {
    if (!B.isBoilerplate) return "boilerplate";
    const probe = document.createElement("div");
    const role = el.getAttribute("role");
    if (role) {
      probe.setAttribute("role", role);
      if (B.isBoilerplate(probe)) return "role=" + role;
      probe.removeAttribute("role");
    }
    const tag = el.nodeName.toUpperCase();
    if (tag === "NAV") return "<nav>";
    if (tag === "ASIDE") return "<aside>";
    if (tag === "HEADER" || tag === "FOOTER") return "<" + tag.toLowerCase() + "> outside article/main";
    const hay = ((el.id || "") + " " + (el.getAttribute("class") || "")).slice(0, 256);
    for (const tok of hay.split(/\s+/)) {
      if (!tok) continue;
      probe.className = tok;
      if (B.isBoilerplate(probe)) return "class token " + tok.slice(0, 40);
      probe.className = "";
      probe.id = tok;
      if (B.isBoilerplate(probe)) return "id token " + tok.slice(0, 40);
      probe.id = "";
    }
    return "boilerplate (branch not determined)";
  }

  /** The walker's own ancestry exclusion, re-run so the answer names the test and the tag. */
  function ancestryReason(el) {
    const plain = document.contentType === "text/plain";
    for (let cur = el; cur; cur = parentOf(cur)) {
      const tag = cur.nodeName.toUpperCase();
      if (TG.NO_SCORE_TAGS && TG.NO_SCORE_TAGS.has(tag)) return "ancestry: never-scored tag <" + tag.toLowerCase() + ">";
      if (tag === "PRE" && !plain && codePre(cur)) return "ancestry: inside a <pre> of machine text";
      if (cur.hasAttribute && cur.hasAttribute(MARK)) return "ancestry: our own UI";
      if (B.isNoTranslate && B.isNoTranslate(cur)) return "ancestry: translate=no / .notranslate on <" + tag.toLowerCase() + ">";
      if (cur.isContentEditable) return "ancestry: contenteditable <" + tag.toLowerCase() + ">";
      if (cur.getAttribute && cur.getAttribute("aria-hidden") === "true") return "ancestry: aria-hidden <" + tag.toLowerCase() + ">";
      if (B.isBoilerplate && B.isBoilerplate(cur)) return "ancestry: boilerplate <" + tag.toLowerCase() + "> — " + boilerWhy(cur);
      // Not one of isExcludedByAncestry's tests, but it has the same effect: visit()
      // treats a heading LABEL as a barrier and RETURNS without descending. A container
      // that only declares itself a heading is walked, so it is no reason for anything.
      if (headingBarrier(cur))
        return (
          "ancestry: heading label <" + tag.toLowerCase() +
          (cur.getAttribute && cur.getAttribute("role") === "heading" ? ' role="heading"' : "") +
          "> — the walk never descends into a heading"
        );
    }
    return null;
  }

  /** Approximate the walker's runs: text nodes grouped by their nearest block-laid-out
   *  ancestor. Used only to say WHY a silent container is silent. */
  function runsIn(root) {
    const map = new Map();
    const skipped = { headingWords: 0, headingTags: new Set() };
    const add = (block, text, inLink) => {
      let r = map.get(block);
      if (!r) map.set(block, (r = { text: "", linkChars: 0 }));
      r.text += text;
      if (inLink) r.linkChars += text.trim().length;
    };
    (function rec(el, block, inLink) {
      if (HARD_SKIP.has(el.nodeName.toUpperCase())) return;
      if (invisible(el)) return;
      // visit() treats a heading LABEL as a barrier and RETURNS: nothing under one is read.
      if (el !== root && headingBarrier(el)) {
        skipped.headingWords += words(el.textContent);
        skipped.headingTags.add(
          el.nodeName.toLowerCase() + (el.getAttribute("role") === "heading" ? '[role="heading"]' : ""),
        );
        return;
      }
      const s = cs(el);
      const d = s ? s.display : "";
      const inline = d.startsWith("inline") || d === "contents" || d === "ruby" || d === "math" || d === "";
      const b = inline ? block : el;
      const link = inLink || el.nodeName.toUpperCase() === "A";
      for (const n of kidsOf(el)) {
        if (n.nodeType === 3) {
          const t = (n.textContent || "").replace(/\s+/g, " ");
          if (t.trim()) add(b, t, link);
        } else if (n.nodeType === 1) rec(n, b, link);
      }
    })(root, root, false);
    const list = [...map.entries()].map(([el, r]) => {
      const text = r.text.replace(/\s+/g, " ").trim();
      return {
        el,
        text,
        words: words(text),
        linkRatio: text.length ? Math.min(1, r.linkChars / text.length) : 0,
        zero: !rectVisible(el),
        nameList: T.looksLikeNameList ? !!T.looksLikeNameList(text) : false,
        noise: T.symbolNoiseRatio ? T.symbolNoiseRatio(text) : 0,
        heading: headingBarrier(el),
      };
    });
    return { list, skipped };
  }

  /** Does text here keep its newlines (pre / pre-wrap / break-spaces)? */
  const preservesWs = (el) => {
    const s = cs(el);
    const ws = s ? s.whiteSpace : "";
    return ws.startsWith("pre") || ws === "break-spaces";
  };

  /** A "show more" / clamp control that hides most of the text from the reader AND us. */
  function truncation(el) {
    try {
      if (el.querySelector('[aria-expanded="false"]')) return "aria-expanded=false control";
      const s = cs(el);
      if (s) {
        if (s.webkitLineClamp && s.webkitLineClamp !== "none") return "-webkit-line-clamp " + s.webkitLineClamp;
        if (s.maxHeight !== "none" && el.scrollHeight > el.clientHeight + 8 && s.overflow !== "visible")
          return "max-height " + s.maxHeight + " with overflow clipped";
      }
      for (const c of el.querySelectorAll("button,a,span,div")) {
        const t = (c.textContent || "").trim();
        if (t.length <= 24 && /show more|read more|see more|view more|continue reading|展开|阅读全文|更多|続きを読む/i.test(t))
          return "control: " + hint(t);
      }
    } catch {}
    return null;
  }

  function silentReason(el) {
    const anc = ancestryReason(el);
    if (anc) return { reason: anc, kind: "ancestry" };
    let standalone = [];
    try {
      standalone = P.collectUnits(el);
    } catch {}
    const trunc = truncation(el);
    if (standalone.length > 0) {
      return {
        reason:
          "context: collectUnits(container) alone yields " +
          standalone.length +
          " unit(s) — a page-level barrier or voice scope suppressed it here",
        kind: "context",
        standalone: standalone.length,
      };
    }
    const { list: runs, skipped } = runsIn(el);
    const texty = runs.filter((r) => r.words > 0);
    const maxWords = texty.reduce((m, r) => Math.max(m, r.words), 0);
    const stats = {
      runs: texty.length,
      maxRunWords: maxWords,
      runsOverMerge: texty.filter((r) => r.words >= MIN_MERGE).length,
      linkDense: texty.filter((r) => r.linkRatio > 0.6).length,
      nameList: texty.filter((r) => r.nameList).length,
      noisy: texty.filter((r) => r.noise > 0.2).length,
      zeroSize: texty.filter((r) => r.zero).length,
      headings: texty.filter((r) => r.heading).length,
      wordsUnderHeading: skipped.headingWords,
    };
    let reason;
    if (skipped.headingWords >= MIN)
      reason =
        skipped.headingWords + "w sit inside " + [...skipped.headingTags].join(" / ") +
        " — visit() treats a heading as a barrier and returns WITHOUT descending, so the text under it is never read";
    else if (texty.length === 0) reason = "no run survived the walk (every block invisible or excluded)";
    else if (stats.zeroSize === texty.length) reason = "zero-size containers (" + stats.zeroSize + " blocks, rect 0×0)";
    else if (stats.linkDense >= Math.ceil(texty.length / 2)) reason = "link-dense: " + stats.linkDense + "/" + texty.length + " blocks over the 0.6 link-text ratio";
    else if (stats.nameList >= Math.ceil(texty.length / 2)) reason = "name-list shape: " + stats.nameList + "/" + texty.length + " blocks";
    else if (stats.noisy >= Math.ceil(texty.length / 2)) reason = "symbol noise > 0.2 in " + stats.noisy + "/" + texty.length + " blocks";
    else if (maxWords < MIN)
      reason =
        "no paragraph reaches " + MIN + " words (longest " + maxWords + "w over " + texty.length +
        " blocks) and no merge got there" + (stats.headings ? " — " + stats.headings + " heading barrier(s) inside" : "");
    else if (
      T.hasColumnGaps &&
      T.hasColumnGaps(el.textContent || "") &&
      preservesWs(el)
    ) {
      // run(): a preserved-whitespace run with interior column gaps is machine layout
      // (ASCII tables, RFC headers, timestamped IRC logs) — a barrier, never a unit.
      stats.columnGaps = true;
      reason =
        "preserved-whitespace text with interior column gaps — run() reads it as machine layout (ASCII table / aligned log) and makes it a barrier, so none of it is scored";
    } else {
      // The walker counts fewer words than this tool does: citation/footnote marks and
      // formulas are skipped mid-sentence, so a block that measures 51w here can be 48w
      // to the walker and fall under the floor.
      const marks = el.querySelectorAll("sup,cite").length;
      const maths = el.querySelectorAll("math,mjx-container,.katex,.mwe-math-element,.ltx_Math,.MathJax").length;
      stats.supCite = marks;
      stats.formulas = maths;
      reason =
        "no unit although the longest block measures " + maxWords + "w by this tool's count — the walker counts less here (" +
        marks + " sup/cite marks, " + maths + " formulas are skipped mid-sentence), leaving it under the " + MIN + "-word floor";
    }
    if (trunc) reason += "; site truncates: " + trunc;
    return { reason, kind: "local", stats };
  }

  const setUnits = set.map((el) => unitsIn(el));
  const silent = [];
  for (let i = 0; i < set.length; i++) {
    if (setWords[i] < MIN) continue;
    if (setUnits[i].length > 0) continue;
    const el = set[i];
    const row = { i, words: setWords[i], tag: el.nodeName.toLowerCase(), hint: hint(el.textContent) };
    if (silent.length < cfg.maxReasons) Object.assign(row, silentReason(el));
    silent.push(row);
  }

  // ---- FRAGMENTED: one container, several units --------------------------------------
  const fragmented = [];
  for (let i = 0; i < set.length; i++) {
    const hit = setUnits[i];
    if (hit.length < 2) continue;
    fragmented.push({
      i,
      tag: set[i].nodeName.toLowerCase(),
      words: setWords[i],
      units: hit.map((k) => units[k].parts.length + "p/" + units[k].wordCount + "w"),
      hint: hint(set[i].textContent),
    });
  }

  // One PARAGRAPH whose text nodes ended in two different units — the sharpest form.
  const paraOfUnit = new Map();
  for (let i = 0; i < units.length; i++) {
    for (const p of units[i].parts) {
      const para = closestComposed(p.container, "p,li,blockquote,dd,figcaption");
      if (!para) continue;
      let s = paraOfUnit.get(para);
      if (!s) paraOfUnit.set(para, (s = new Set()));
      s.add(i);
    }
  }
  const splitParas = [...paraOfUnit.entries()].filter(([, s]) => s.size > 1);

  // ---- CROSSING ----------------------------------------------------------------------
  const crossing = [];
  if (usingPosts) {
    for (let i = 0; i < units.length; i++) {
      const owners = new Set();
      let outside = 0;
      for (const c of unitContainers[i]) {
        const own = posts.find((el) => containsComposed(el, c));
        if (own) owners.add(own);
        else outside++;
      }
      if (owners.size > 1) crossing.push({ unit: i, posts: owners.size, parts: unitContainers[i].length, words: units[i].wordCount, what: "two posts" });
      else if (owners.size === 1 && outside > 0)
        crossing.push({ unit: i, posts: 1, parts: unitContainers[i].length, words: units[i].wordCount, outside, what: "post + outside" });
    }
  }
  const SCOPE_SEL = 'article,[role="article"],blockquote,figure,[role="link"]';
  let crossingScopes = 0;
  const crossingScopeSamples = [];
  for (let i = 0; i < units.length; i++) {
    if (unitContainers[i].length < 2) continue;
    const scopes = new Set(unitContainers[i].map((c) => closestComposed(c, SCOPE_SEL) || "page"));
    if (scopes.size > 1) {
      crossingScopes++;
      if (crossingScopeSamples.length < 4)
        crossingScopeSamples.push({
          unit: i,
          parts: unitContainers[i].length,
          words: units[i].wordCount,
          scopes: [...scopes].map((s) => (s === "page" ? "page" : s.nodeName.toLowerCase() + (s.getAttribute("role") ? "[role=" + s.getAttribute("role") + "]" : ""))),
        });
    }
  }

  // ---- CHROME ------------------------------------------------------------------------
  const plainDoc = document.contentType === "text/plain";
  /** Class/id tokens matched with the same `^|[-_] … [-_]|$` boundaries the product's own
   *  boilerplate filter uses, so "layout__2-sidebars-inline" is not a sidebar. */
  const tokenRe = (alts) => new RegExp("(?:^|[-_])(?:" + alts + ")(?:[-_]|$)", "i");
  const PAGE_LEVEL = new Set(["BODY", "HTML", "MAIN", "ARTICLE"]);
  const closestToken = (el, re) => {
    for (let cur = el; cur; ) {
      for (let e = cur; e; e = e.parentElement) {
        // Page-level containers carry state classes ("sidebar-visible" on mdBook's <html>)
        // that say nothing about the text inside them — the product's own filter ignores
        // them for the same reason.
        if (PAGE_LEVEL.has(e.nodeName.toUpperCase())) continue;
        const cls = e.getAttribute ? e.getAttribute("class") : null;
        const id = e.id || "";
        if (id && re.test(id)) return e;
        if (cls) for (const t of cls.split(/\s+/)) if (t && re.test(t)) return e;
      }
      cur = cur.getRootNode() instanceof ShadowRoot ? cur.getRootNode().host : null;
    }
    return null;
  };
  const CATS = [
    ["nav", 'nav,[role="navigation"],[role="menu"],[role="menubar"]'],
    ["header", 'header,[role="banner"]'],
    ["footer", 'footer,[role="contentinfo"]'],
    ["aside", 'aside,[role="complementary"]'],
    ["cookie/consent", tokenRe("cookies?|consent|gdpr")],
    ["sidebar", tokenRe("sidebar|side[-_]?bar|rail")],
    ["related/promo", tokenRe("related|recommended|promo|promoted|trending|newsletter|subscribe|most[-_]?read")],
    // A hit here is inline <code>, a highlighted block, or a <pre> of machine text. A <pre>
    // of PROSE is read like any other block and is NOT code (see below). On a text/plain
    // document the whole body IS a <pre> by design.
    ["code", plainDoc ? "code[data-never]" : "pre,code"],
    ["table of numbers", "table"],
    ["form", "form"],
  ];
  const chromeHits = {};
  const chromeSamples = [];
  let chromeUnitCount = 0;
  let layoutTableUnits = 0;
  let layoutWrapperUnits = 0;
  let prosePreUnits = 0;
  for (let i = 0; i < units.length; i++) {
    const digits = (units[i].text.match(/\d/g) || []).length;
    const digitRatio = Math.round((digits / Math.max(1, units[i].text.length)) * 100) / 100;
    const cats = new Set();
    for (const c of unitContainers[i]) {
      for (const [name, sel] of CATS) {
        let hit = null;
        try {
          hit = sel instanceof RegExp ? closestToken(c, sel) : closestComposed(c, sel);
        } catch {}
        if (!hit) continue;
        // A <pre> that READS as prose is not a code block: an RFC published as HTML, a man
        // page, a mailing-list message. RFC 2616 reported all 554 of its units as chrome.
        if (name === "code" && !codePre(hit)) {
          prosePreUnits++;
          continue;
        }
        // A table is only a finding when it really is a table of numbers: Hacker News and
        // other old forums lay out whole comment threads in tables of prose.
        if (name === "table of numbers" && digitRatio <= 0.15) {
          layoutTableUnits++;
          continue;
        }
        // A class token on a box that holds most of the page is a LAYOUT class, not a
        // widget: Nature's `eds-l-with-sidebar` content column, mdBook's `sidebar-visible`
        // state. A real sidebar holds a small share of the prose.
        if (sel instanceof RegExp && (proseOf.get(hit) ?? 0) > proseWords * 0.5) {
          layoutWrapperUnits++;
          continue;
        }
        cats.add(name);
      }
    }
    if (cats.size === 0) continue;
    chromeUnitCount++;
    for (const k of cats) chromeHits[k] = (chromeHits[k] || 0) + 1;
    if (chromeSamples.length < 8)
      chromeSamples.push({
        cats: [...cats],
        words: units[i].wordCount,
        parts: units[i].parts.length,
        tag: unitContainers[i][0].nodeName.toLowerCase(),
        digitRatio,
        hint: hint(units[i].text),
      });
  }

  return {
    lang: document.documentElement.getAttribute("lang") || null,
    finalUrl: location.href.slice(0, 300),
    title: hint(document.title),
    contentType: document.contentType,
    units: units.length,
    merged: units.filter((u) => u.parts.length > 1).length,
    maxParts: units.reduce((m, u) => Math.max(m, u.parts.length), 0),
    wordsJudged: units.reduce((n, u) => n + u.wordCount, 0),
    wordsProse: proseWords,
    wordsChrome: chromeWords,
    posts: posts.length,
    postsWith50: setWords.filter((w) => w >= MIN).length,
    setKind: usingPosts ? "post:" + cfg.post : "blocks(smallest ≥" + MIN + "w)",
    setSize: set.length,
    silent,
    fragmented,
    splitParagraphs: splitParas.length,
    splitParagraphSamples: splitParas.slice(0, 4).map(([el, s]) => ({ tag: el.nodeName.toLowerCase(), words: words(el.textContent), units: s.size, hint: hint(el.textContent) })),
    crossing,
    crossingScopes,
    crossingScopeSamples,
    chromeUnits: chromeUnitCount,
    chromeByCat: chromeHits,
    chromeSamples,
    layoutTableUnits,
    layoutWrapperUnits,
    prosePreUnits,
    visited,
    domElements: document.getElementsByTagName("*").length,
    collectMs,
    longestTask: Math.round(window.__covLongest || 0),
  };
}

// ---- reachability ------------------------------------------------------------------

const BOT_RE = /just a moment|verifying you are human|attention required|checking your browser|are you a robot|enable javascript and cookies|unusual traffic|access denied|请开启javascript|安全验证|人机验证|滑动验证/i;
const WALL_RE = /log in to continue|sign in to continue|log in or sign up|create an account to continue|you must log in|register to view|members only|登录后查看|请先登录|登录知乎|扫码登录|continue with (?:google|apple|facebook)/i;
/** What a sign-in box says, wherever in the world. Read only from a dialog that IS the
 *  whole page, so an ordinary "Sign in" link in a header never matches. */
const SIGN_IN_RE = /log ?in|sign ?in|sign ?up|join now|create (?:an |a free )?account|continue with|登录|注册|登入|ログイン|로그인/i;
/** The dialog landmarks a modal sign-in box is built from. */
const DIALOG_SEL = 'dialog,[role="dialog"],[role="alertdialog"]';

/** Classify what the reader would meet. Body text is inspected in the page and only the
 *  verdict comes back. */
async function reachOf(page, status) {
  const v = await page
    .evaluate(
      ({ bot, wall, dialogSel }) => {
        const body = document.body;
        const t = (document.title || "") + " " + (body ? body.innerText.slice(0, 1500) : "");
        const count = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
        /** Outermost matches only, so nothing inside another match is counted twice. */
        const tops = (sel) => {
          const all = body ? Array.from(body.querySelectorAll(sel)) : [];
          return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
        };
        const dialogs = tops(dialogSel);
        const dialogText = dialogs.map((el) => el.innerText || "").join(" ");
        // What a modal hides from the reader. Opening one marks the page behind it
        // aria-hidden (Threads: `div#scrollview`, 1 422 words; LinkedIn:
        // `main#main-content`, 1 573), and innerText still reports every word of it.
        const behind = tops('[aria-hidden="true"]').filter((el) => !dialogs.some((d) => d.contains(el) || el.contains(d)));
        return {
          bot: new RegExp(bot, "i").test(t),
          wall: new RegExp(wall, "i").test(t),
          words: count(body ? body.innerText : ""),
          dialogWords: count(dialogText),
          hiddenWords: behind.reduce((n, el) => n + count(el.innerText), 0),
          dialogText: dialogText.slice(0, 600),
          path: location.pathname,
        };
      },
      { bot: BOT_RE.source, wall: WALL_RE.source, dialogSel: DIALOG_SEL },
    )
    .catch(() => null);
  if (!v) return "blocked";
  if (v.bot) return "bot check";
  if (/\/(?:login|signin|sign-in|signup|checkpoint|consent|challenge)\b/i.test(v.path)) return "login wall";
  if (v.wall && v.words < 900) return "login wall";
  // A page that IS a dialog. Threads, LinkedIn and Facebook answer a logged-out reader with
  // a sign-in box and mark everything behind it aria-hidden, which the walk honours: the
  // page reports zero prose words and zero units, and the row said "ok" — which reads as
  // "the walker found nothing here" rather than "there was nothing to find".
  if (v.dialogWords >= 20 && v.words - v.dialogWords - v.hiddenWords < 30)
    return SIGN_IN_RE.test(v.dialogText) ? "login wall" : "blocked (the page is one dialog)";
  if (status && status >= 400) return `blocked (HTTP ${status})`;
  if (v.words < 30) return "blocked (empty page)";
  return "ok";
}

// ---- the run -------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

const browser = await launchPlain({ headless: true });

/** One page, start to finish. Never throws: a failure is a row. */
async function visit(entry) {
  const started = Date.now();
  const row = { name: entry.name, kind: entry.kind, url: entry.url, note: entry.note, post: entry.post ?? null };
  const context = await browser.newContext({
    bypassCSP: true, // the probe is injected as a <script>; many sites forbid that
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: entry.locale || "en-US",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  await page.addInitScript(LONGTASK_INIT);
  try {
    let status = 0;
    let navErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        status = resp ? resp.status() : 0;
        navErr = null;
        break;
      } catch (e) {
        navErr = String(e).split("\n")[0].slice(0, 120);
      }
    }
    if (navErr) {
      row.reach = /Timeout/i.test(navErr) ? "timeout" : "blocked";
      row.error = navErr;
      row.ms = Date.now() - started;
      return row;
    }
    row.status = status;
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    if (entry.waitFor) await page.waitForSelector(entry.waitFor, { timeout: 8000 }).catch(() => {});
    // SPAs hydrate after "load"; a scroll of a few screens then brings in lazy comments.
    await page.waitForTimeout(1500);
    await sweep(page, entry.scrolls ?? SCROLLS, 450);
    await page.waitForTimeout(1200);

    row.reach = await reachOf(page, status);
    if (row.reach !== "ok") {
      row.finalUrl = page.url().slice(0, 300);
      row.ms = Date.now() - started;
      return row;
    }

    await page.addScriptTag({ path: PROBE });
    await page.addScriptTag({ path: HELPERS });
    await page.addScriptTag({ path: REPORT_JS });
    const probe = await page
      .evaluate((sel) => JSON.parse(window.probeReport(sel || undefined)), entry.post ?? null)
      .catch((e) => ({ probeError: String(e).slice(0, 120) }));
    const deep = await page
      .evaluate(analyse, { post: entry.post ?? null, maxSet: 400, maxReasons: 12 })
      .catch((e) => ({ analyseError: String(e).slice(0, 200) }));
    Object.assign(row, deep, { probe });
    row.ms = Date.now() - started;
    return row;
  } catch (e) {
    row.reach = row.reach ?? "blocked";
    row.error = String(e).split("\n")[0].slice(0, 160);
    row.ms = Date.now() - started;
    return row;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// Workers take the next entry whose HOST is free, so a site never sees two pages at once,
// and a host is left alone for a moment between its pages.
const queue = entries.slice();
const busy = new Set();
const lastSeen = new Map();
const rows = [];
let done = 0;

async function worker() {
  for (;;) {
    let idx = -1;
    for (let i = 0; i < queue.length; i++) {
      const h = hostOf(queue[i].url);
      if (busy.has(h)) continue;
      const gap = Date.now() - (lastSeen.get(h) ?? 0);
      if (gap < 2500) continue;
      idx = i;
      break;
    }
    if (idx < 0) {
      if (queue.length === 0) return;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const [entry] = queue.splice(idx, 1);
    const host = hostOf(entry.url);
    busy.add(host);
    let row;
    try {
      row = await visit(entry);
    } catch (e) {
      row = { name: entry.name, kind: entry.kind, url: entry.url, reach: "blocked", error: String(e).slice(0, 120) };
    }
    busy.delete(host);
    lastSeen.set(host, Date.now());
    rows.push(row);
    done++;
    const bits = row.reach === "ok" ? `units=${row.units} merged=${row.merged} judged=${row.wordsJudged}/${row.wordsProse} silent=${(row.silent ?? []).length} frag=${(row.fragmented ?? []).length} cross=${(row.crossing ?? []).length}/${row.crossingScopes} chrome=${row.chromeUnits} ${row.collectMs}ms` : (row.error ?? "");
    console.log(`[${String(done).padStart(3)}/${entries.length}] ${row.name.padEnd(26)} ${String(row.reach).padEnd(16)} ${bits}`);
  }
}

console.log(`coverage: ${entries.length} pages, ${JOBS} at a time, label "${LABEL}" → ${OUT_DIR}`);
await Promise.all(Array.from({ length: Math.min(JOBS, entries.length) }, worker));
await browser.close();

rows.sort((a, b) => ALL.findIndex((e) => e.name === a.name) - ALL.findIndex((e) => e.name === b.name));

// ---- output ---------------------------------------------------------------------------

const jsonPath = out(`coverage-${LABEL}.json`);
writeFileSync(jsonPath, JSON.stringify({ label: LABEL, at: new Date().toISOString(), entries: entries.length, pages: rows }, null, 1));

const ok = rows.filter((r) => r.reach === "ok");
const md = [];
md.push(`# Page-segmentation coverage — \`${LABEL}\``);
md.push("");
md.push(`${rows.length} pages, ${ok.length} examined, ${rows.length - ok.length} unreachable. ${new Date().toISOString()}`);
md.push("");
md.push(
  "Visible prose = every text node under `<body>` that is not in a `display:none` / " +
    "`visibility:hidden` / `opacity:0` / `aria-hidden` / zero-size subtree, not in a never-scored " +
    "tag (script, style, button, textarea, img, svg, …), and not inside **nav, header, footer, " +
    "aside, dialog or a navigation/banner/contentinfo/complementary/dialog/menu/toolbar/search " +
    "role** — those subtrees are counted separately as chrome words. Each text node is counted once.",
);
md.push("");
md.push("| page | kind | reach | lang | units | merged | judged | prose | cov% | silent | frag | split¶ | cross | scopes | chrome | ms | collect |");
md.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  if (r.reach !== "ok") {
    md.push(`| ${r.name} | ${r.kind} | **${r.reach}** | | | | | | | | | | | | | ${r.ms ?? ""} | |`);
    continue;
  }
  const cov = r.wordsProse ? Math.round((r.wordsJudged / r.wordsProse) * 100) : 0;
  md.push(
    `| ${r.name} | ${r.kind} | ok | ${r.lang ?? "–"} | ${r.units} | ${r.merged} | ${r.wordsJudged} | ${r.wordsProse} | ${cov} | ${(r.silent ?? []).length} | ${(r.fragmented ?? []).length} | ${r.splitParagraphs ?? 0} | ${(r.crossing ?? []).length} | ${r.crossingScopes ?? 0} | ${r.chromeUnits ?? 0} | ${r.ms} | ${r.collectMs} |`,
  );
}
md.push("");
md.push("## Pages");
for (const r of rows) {
  md.push("");
  md.push(`### ${r.name} — ${r.kind}`);
  md.push(`\`${r.url}\`${r.post ? ` · post \`${r.post}\`` : ""}${r.note ? ` · ${r.note}` : ""}`);
  if (r.reach !== "ok") {
    md.push(`- **${r.reach}**${r.status ? ` (HTTP ${r.status})` : ""}${r.error ? ` — \`${r.error}\`` : ""}`);
    continue;
  }
  md.push(
    `- lang \`${r.lang ?? "–"}\`, ${r.units} units (${r.merged} merged, max ${r.maxParts} parts), ` +
      `${r.wordsJudged} of ${r.wordsProse} prose words judged (${r.wordsProse ? Math.round((r.wordsJudged / r.wordsProse) * 100) : 0} %), ` +
      `${r.wordsChrome} words in chrome`,
  );
  md.push(`- analysis set: ${r.setKind}, ${r.setSize} containers, ${r.postsWith50} of them ≥ 50 words`);
  if ((r.silent ?? []).length) {
    md.push(`- **silent (${r.silent.length})** — ≥ 50 words, no unit:`);
    for (const s of r.silent.slice(0, 8))
      md.push(`  - \`<${s.tag}>\` ${s.words}w — ${s.reason ?? "(reason not computed: past the first 12)"}${s.stats ? ` · ${JSON.stringify(s.stats)}` : ""} · "${s.hint}"`);
  }
  if ((r.fragmented ?? []).length) {
    md.push(`- **fragmented (${r.fragmented.length})** — one container, several units:`);
    for (const f of r.fragmented.slice(0, 6)) md.push(`  - \`<${f.tag}>\` ${f.words}w → ${f.units.join(" + ")} · "${f.hint}"`);
  }
  if (r.splitParagraphs) {
    md.push(`- **one paragraph in two units: ${r.splitParagraphs}**`);
    for (const s of (r.splitParagraphSamples ?? []).slice(0, 3)) md.push(`  - \`<${s.tag}>\` ${s.words}w across ${s.units} units · "${s.hint}"`);
  }
  if ((r.crossing ?? []).length) {
    md.push(`- **crossing (${r.crossing.length})** — a unit over two posts or a post and the page:`);
    for (const c of r.crossing.slice(0, 6)) md.push(`  - unit #${c.unit}: ${c.parts} parts / ${c.words}w — ${c.what}${c.outside ? ` (${c.outside} parts outside)` : ""}`);
  }
  if (r.crossingScopes) {
    md.push(`- **crossing voice scopes: ${r.crossingScopes}** (article / role=article / blockquote / figure / role=link vs the page)`);
    for (const c of (r.crossingScopeSamples ?? []).slice(0, 3)) md.push(`  - unit #${c.unit}: ${c.parts} parts / ${c.words}w over ${c.scopes.join(" + ")}`);
  }
  if (r.chromeUnits) {
    md.push(`- **chrome units: ${r.chromeUnits}** — ${Object.entries(r.chromeByCat ?? {}).map(([k, v]) => `${k}×${v}`).join(", ")}`);
    for (const c of (r.chromeSamples ?? []).slice(0, 4))
      md.push(`  - ${c.cats.join("+")}: \`<${c.tag}>\` ${c.parts}p/${c.words}w, digits ${c.digitRatio} · "${c.hint}"`);
  }
  if (r.layoutTableUnits) md.push(`- ${r.layoutTableUnits} units sit in a \`<table>\` that is prose, not numbers (layout table) — not counted as chrome`);
  if (r.prosePreUnits) md.push(`- ${r.prosePreUnits} units sit in a \`<pre>\` that reads as prose (an RFC, a man page, a mail archive) — read like any other block, not counted as chrome`);
  md.push(`- weight: ${r.domElements} elements in the document, ${r.visited} visited, collectUnits ${r.collectMs} ms${r.longestTask > 200 ? `, longest task ${r.longestTask} ms` : ""}`);
  if (r.analyseError) md.push(`- analyse error: \`${r.analyseError}\``);
}
const mdPath = out(`coverage-${LABEL}.md`);
writeFileSync(mdPath, md.join("\n") + "\n");

console.log("");
console.log(`examined ${ok.length}/${rows.length}; silent ${ok.reduce((n, r) => n + (r.silent ?? []).length, 0)}, ` +
  `fragmented ${ok.reduce((n, r) => n + (r.fragmented ?? []).length, 0)}, ` +
  `split paragraphs ${ok.reduce((n, r) => n + (r.splitParagraphs ?? 0), 0)}, ` +
  `crossing ${ok.reduce((n, r) => n + (r.crossing ?? []).length, 0)}, ` +
  `scope crossings ${ok.reduce((n, r) => n + (r.crossingScopes ?? 0), 0)}, ` +
  `chrome units ${ok.reduce((n, r) => n + (r.chromeUnits ?? 0), 0)}`);
console.log(`→ ${jsonPath}`);
console.log(`→ ${mdPath}`);
