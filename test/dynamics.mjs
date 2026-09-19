// test/dynamics.mjs — what the WHOLE extension does to a page OVER TIME.
//
// test/coverage.mjs asks the segmenter one question about one snapshot of a page.
// test/survey.mjs watches the whole extension, but only until the first scan settles.
// This is the layer neither of them reaches: everything that happens AFTER that —
// infinite scroll, virtualized lists that delete the posts we chipped, frameworks that
// re-render text we split, lazy comment sections, "show more" expansions, SPA route
// changes, a live blog rewriting itself under the reader.
//
// Per page it opens the BUILT extension against test/fake-daemon.mjs (deterministic
// verdicts, no model, and — the point — a recording daemon: every paragraph it was asked
// about is kept, so "we scored that one twice" is a fact, not a guess), runs a scripted
// 60–120 s session (scroll down screen by screen, back to the top, click the view-only
// controls the entry names, follow one in-site link and come back, resize once, toggle
// the ball off and on) and samples the DOM every ~2 s. It then runs the SAME page again
// in a plain browser with NO extension, so a long task, a hydration warning or a
// `removeChild` error can be attributed to the site rather than to us.
//
// The content script lives in an isolated world, so nothing here reads its variables.
// Everything is observed through what it leaves in the page: chip hosts
// (`span[data-anagram="host"]`, open shadow root → `.pill` / `.num` / `.card`), the
// ranges in `CSS.highlights`, `#anagram-fab`, the `[anagram:*]` console lines the debug
// setting unlocks, and the fake daemon's own record of what it was asked.
//
// What it records, per page:
//
//   CHIPS      — hosts over time, connected vs. detached-but-still-reachable, zero-size,
//                DUPLICATES (two chips closing the same text: same preceding 100
//                characters), orphans (a chip whose preceding text is gone), chips stuck
//                "analyzing…" past 10 s, chips in page chrome, chips out of sight inside
//                a box that clips its own text;
//   STABILITY  — FLICKER: chips that appeared or vanished between two samples whose page
//                text was byte-identical; RESENDS: paragraphs the daemon was asked about
//                more than once (the L1 + service-worker caches should make this zero);
//                requests and blocks per minute; how far scoring lags the scroll;
//   INTEGRITY  — did the PAGE break? a hash of the main region's own text before/after on
//                pages that do not change by themselves, in BOTH runs; adjacent duplicate
//                sentences and adjacent identical text nodes (what a framework re-render
//                over one of our text-node splits looks like); uncaught errors naming DOM
//                surgery (removeChild / insertBefore / not a child of this node /
//                hydration), ours vs. theirs;
//   COST       — long tasks (count / worst / total) and CDP Performance metrics with and
//                without the extension, JS heap at start and end, page mutation records
//                per second, chip settle time;
//   NAV        — after one in-site navigation and the way back: old chips gone, new page
//                chipped, the ball still there, no highlight ranges over detached nodes.
//
//   node test/dynamics.mjs                        # the whole list
//   node test/dynamics.mjs wikipedia bluesky      # only entries whose name/kind matches
//   node test/dynamics.mjs --minutes 2 --out /tmp/dyn
//   node test/dynamics.mjs --list                 # what would run
//   node test/dynamics.mjs --no-control           # skip the extension-less control runs
//
// Reports and screenshots go to ANAGRAM_ARTIFACTS (or --out), never into the repo.
// Headless always; logged-out always (throwaway profile, no cookies); one page of a site
// at a time. A wall, a bot check or a timeout is a RESULT, not a failure.
import { withFakeDaemon, launchPlain, BADGE_SEL, ARTIFACTS, requireBuild } from "./harness.mjs";
import { cyrb53 } from "./fake-daemon.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- command line --------------------------------------------------------------------

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

const OUT_DIR = String(opt("out", ARTIFACTS));
const LABEL = String(opt("label", "run"));
const KIND = opt("kind", null);
const MINUTES = Number(opt("minutes", 1.5)) || 1.5;
const NAV_TIMEOUT = Number(opt("timeout", 20000)) || 20000;
const SAMPLE_MS = Number(opt("sample", 2000)) || 2000;
/** The control run repeats the scroll script for this share of the session budget. It is 1
 *  by default: an infinite feed loads what it is scrolled through, so a shorter control
 *  run would compare our cost on a long page against theirs on a short one. */
const CONTROL_SHARE = Number(opt("control-share", 1)) || 1;
const NO_CONTROL = flag("no-control");
const LIST_ONLY = flag("list");
const filters = argv.filter((a) => !a.startsWith("--")).map((s) => s.toLowerCase());

const BUDGET_MS = Math.round(MINUTES * 60_000);
mkdirSync(OUT_DIR, { recursive: true });
const out = (name) => join(OUT_DIR, name);

const ALL = JSON.parse(readFileSync(join(__dirname, "dynamics.urls.json"), "utf8"));
const entries = ALL.filter(
  (e) =>
    (!KIND || e.kind === KIND) &&
    (filters.length === 0 ||
      filters.some((f) => e.name.toLowerCase().includes(f) || e.kind.toLowerCase().includes(f))),
);
if (entries.length === 0) {
  console.error("no entries matched");
  process.exit(2);
}
if (LIST_ONLY) {
  for (const e of entries) console.log(`${e.kind.padEnd(7)} ${e.name.padEnd(22)} ${e.url}`);
  process.exit(0);
}
requireBuild();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const VIEWPORT = { width: 1280, height: 900 };
const RESIZED = { width: 900, height: 700 };

// ======================================================================================
// IN-PAGE CODE. Installed at document_start in BOTH runs, so the cost of the recorders
// themselves is paid on both sides of the comparison.
// ======================================================================================

/** Long tasks, page mutation records, and a per-document identity (SPA vs. real nav). */
const INIT = () => {
  const D = (window.__dyn = {
    docId: Math.random().toString(36).slice(2, 10),
    ids: new WeakMap(),
    refs: [],
    next: 1,
    tasks: 0,
    taskWorst: 0,
    taskTotal: 0,
    muts: 0,
  });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        D.tasks++;
        D.taskTotal += e.duration;
        if (e.duration > D.taskWorst) D.taskWorst = e.duration;
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* no longtask support — the field stays 0 in both runs */
  }
  try {
    // The PAGE's own churn, as the extension's MutationObserver would see it. Records
    // that are only our own chip hosts going in or out are not the page moving.
    new MutationObserver((records) => {
      let n = 0;
      for (const r of records) {
        if (r.type === "attributes") {
          const t = r.target;
          if (t && t.hasAttribute && t.hasAttribute("data-anagram")) continue;
        } else if (r.type === "childList") {
          const moved = r.addedNodes.length + r.removedNodes.length;
          let ours = moved > 0;
          for (const n2 of r.addedNodes) if (!(n2.nodeType === 1 && n2.hasAttribute("data-anagram"))) ours = false;
          for (const n2 of r.removedNodes) if (!(n2.nodeType === 1 && n2.hasAttribute("data-anagram"))) ours = false;
          if (ours) continue;
        }
        n++;
      }
      D.muts += n;
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
  } catch {
    /* nothing to count */
  }
};

/**
 * One sample. `deep` samples add everything that needs layout or computed style (rects,
 * clipping boxes, duplicates, chrome) — the cheap ones run every 2 s and cost a few DOM
 * queries, so the long-task comparison is not swamped by the measuring.
 */
function SAMPLE(cfg) {
  const D = window.__dyn || { ids: new WeakMap(), refs: [], next: 1 };
  const hash = (str) => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return String(4294967296 * (2097151 & h2) + (h1 >>> 0));
  };

  const hosts = [];
  for (const h of document.querySelectorAll('[data-anagram="host"]')) {
    if (h.id !== "anagram-fab") hosts.push(h);
  }
  // The id carries the DOCUMENT it belongs to: after a real navigation the counter starts
  // over, and a bare number would make the new page's first chips look like survivors of
  // the old one.
  const idOf = (el) => {
    let v = D.ids.get(el);
    if (!v) {
      v = D.docId + ":" + D.next++;
      D.ids.set(el, v);
      if (D.refs.length < 4000 && typeof WeakRef === "function") D.refs.push(new WeakRef(el));
    }
    return v;
  };

  // Our hosts hold their chip in a SHADOW root and carry no light children, so any page
  // element's textContent is the page's own text with our chips already excluded.
  // `article` is deliberately NOT a fallback: on a feed `querySelector("article")` is the
  // FIRST post, and a hash over one post would stay equal while thirty others came and
  // went — every virtualized removal would then be counted as flicker.
  const region =
    (cfg.region && document.querySelector(cfg.region)) ||
    document.querySelector("main, [role=main]") ||
    document.body;
  const regionText = region ? region.textContent.replace(/\s+/g, " ").trim() : "";
  // The page's own element count, with our chips, the ball and our style tag taken out:
  // a second, cheap witness that the page did not move between two samples.
  const pageEls = document.getElementsByTagName("*").length - document.querySelectorAll("[data-anagram]").length;

  /** The text the chip closes: the last 100 characters before it in document order. */
  const preceding = (host) => {
    let s = "";
    let node = host;
    for (let i = 0; i < 40 && s.length < 140; i++) {
      const prev = node.previousSibling;
      if (!prev) {
        node = node.parentNode;
        if (!node || node === document.body || node.nodeType === 9) break;
        continue;
      }
      node = prev;
      const t = prev.nodeType === 3 ? prev.nodeValue : prev.nodeType === 1 ? prev.textContent : "";
      s = (t || "").slice(-200) + s;
    }
    return s.replace(/\s+/g, " ").trim().slice(-100);
  };

  const rows = [];
  for (const h of hosts) {
    const root = h.shadowRoot;
    const pill = root ? root.querySelector(".pill") : null;
    const cls = pill ? pill.className : "";
    const row = {
      id: idOf(h),
      pending: /\bpending\b/.test(cls),
      band: (cls.match(/band-([a-z]+)/) || [, "none"])[1],
      hidden: h.classList.contains("pg-hidden"),
      settled: !!(root && root.querySelector(".card .head")),
    };
    rows.push(row);
  }

  let hlRanges = 0;
  let hlDetached = 0;
  let hlNames = 0;
  try {
    if (typeof CSS !== "undefined" && CSS.highlights) {
      for (const [name, hl] of CSS.highlights) {
        if (!String(name).startsWith("anagram")) continue;
        hlNames++;
        for (const r of hl) {
          hlRanges++;
          try {
            if (!r.startContainer.isConnected || !r.endContainer.isConnected) hlDetached++;
          } catch {
            hlDetached++;
          }
        }
      }
    }
  } catch {
    /* no highlight registry */
  }

  const base = {
    t: Math.round(performance.now()),
    docId: D.docId,
    url: location.href.slice(0, 300),
    scrollY: Math.round(window.scrollY),
    scrollH: Math.round(document.documentElement.scrollHeight),
    innerH: window.innerHeight,
    hosts: rows,
    n: rows.length,
    pending: rows.filter((r) => r.pending).length,
    hidden: rows.filter((r) => r.hidden).length,
    fab: !!document.getElementById("anagram-fab"),
    hlNames,
    hlRanges,
    hlDetached,
    textHash: hash(regionText),
    textChars: regionText.length,
    pageEls,
    muts: D.muts | 0,
    tasks: D.tasks | 0,
    taskWorst: Math.round(D.taskWorst || 0),
    taskTotal: Math.round(D.taskTotal || 0),
    heap: (performance.memory && performance.memory.usedJSHeapSize) || 0,
    deep: false,
  };
  if (!cfg.deep) return base;

  // ---- deep: layout, computed style, structure ---------------------------------------
  const CHROME_SEL =
    'nav,header,footer,aside,dialog,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="dialog"],[role="menu"],[role="toolbar"],[role="search"]';
  /** A box that clips its own text, as lib/dom/style.ts judges one (overflow / clamp). */
  const clipBoxOf = (el) => {
    for (let cur = el, i = 0; cur && i < 6; i++, cur = cur.parentElement) {
      let s;
      try {
        s = getComputedStyle(cur);
      } catch {
        return null;
      }
      const clipped =
        (s.webkitLineClamp && s.webkitLineClamp !== "none") ||
        ((s.overflowY === "hidden" || s.overflowY === "clip") && s.maxHeight !== "none") ||
        (s.overflow === "hidden" && cur.scrollHeight > cur.clientHeight + 8);
      if (clipped) return cur;
    }
    return null;
  };

  const byAnchor = new Map();
  let zeroSize = 0;
  let chrome = 0;
  let clippedOut = 0;
  let orphan = 0;
  const dupSamples = [];
  const chromeSamples = [];
  const clipSamples = [];
  const orphanSamples = [];

  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const row = rows[i];
    const r = h.getBoundingClientRect();
    row.w = Math.round(r.width);
    row.h = Math.round(r.height);
    if (!row.hidden && r.width === 0 && r.height === 0) zeroSize++;
    const parent = h.parentElement;
    if (parent && parent.closest(CHROME_SEL)) {
      chrome++;
      if (chromeSamples.length < 4) chromeSamples.push(preceding(h).slice(-50));
    }
    const pre = preceding(h);
    if (pre.length < 15) {
      orphan++;
      if (orphanSamples.length < 4)
        orphanSamples.push({ pre, parent: parent ? parent.nodeName.toLowerCase() : "?" });
    }
    if (pre.length >= 40) {
      const key = pre;
      let g = byAnchor.get(key);
      if (!g) byAnchor.set(key, (g = []));
      g.push(h);
    }
    if (!row.hidden && (r.width > 0 || r.height > 0)) {
      const box = clipBoxOf(parent || h);
      if (box) {
        const br = box.getBoundingClientRect();
        if (r.top > br.bottom - 1 || r.bottom < br.top + 1 || r.left > br.right - 1) {
          clippedOut++;
          if (clipSamples.length < 4)
            clipSamples.push({ box: box.nodeName.toLowerCase(), cls: (box.className || "").toString().slice(0, 40) });
        }
      }
    }
  }
  // Two chips closing the same text are one of two different things, and the chips
  // themselves say which: a chip states its unit's percentage and its unit's word count,
  // so a group in which every chip reads the SAME number over the SAME number of words is
  // one unit chipped twice, while a group whose numbers differ is several DISTINCT units
  // whose chips were all inserted at one anchor (the clipped-box rule in
  // badge.ts insertionPoint()/clippingBoxOf() moves a chip after the box when its own
  // anchor is out of sight — every unit of a clamped post lands in the same place).
  const numOf = (h) => (h.shadowRoot?.querySelector(".num")?.textContent ?? "").trim();
  const wordsOf = (h) => {
    for (const r of h.shadowRoot?.querySelectorAll(".card .row") ?? []) {
      if ((r.querySelector(".k")?.textContent ?? "") === "Words") return (r.querySelector(".v")?.textContent ?? "").trim();
    }
    return "";
  };
  let dupGroups = 0;
  let dupChips = 0;
  let sameUnitGroups = 0;
  let sameUnitChips = 0;
  let pileUpGroups = 0;
  let pileUpChips = 0;
  let repeatedTextChips = 0;
  for (const [key, g] of byAnchor) {
    if (g.length < 2) continue;
    const nums = [...new Set(g.map(numOf))];
    const words = [...new Set(g.map(wordsOf))];
    const sameParent = g.every((x) => x.parentElement === g[0].parentElement);
    // Chips in DIFFERENT parents that close the same text are the page showing that text
    // twice (a headline in the river and again in a rail). Two distinct units with one
    // text get one chip each BY DESIGN — scheduler.ts dedups by unit identity, not text —
    // so this is not a defect and is counted apart.
    const kind = !sameParent ? "repeated" : nums.length === 1 && words.length === 1 && nums[0] !== "" ? "sameUnit" : "pileUp";
    dupGroups++;
    dupChips += g.length - 1;
    if (kind === "sameUnit") {
      sameUnitGroups++;
      sameUnitChips += g.length - 1;
    } else if (kind === "pileUp") {
      pileUpGroups++;
      pileUpChips += g.length - 1;
    } else {
      repeatedTextChips += g.length - 1;
    }
    if (dupSamples.length < 6)
      dupSamples.push({
        chips: g.length,
        kind,
        nums: nums.slice(0, 6),
        words: words.slice(0, 6),
        sameParent,
        parent: g[0].parentElement ? g[0].parentElement.nodeName.toLowerCase() : "?",
        hint: key.slice(-60),
      });
  }

  // ---- the page's own text: duplicated sentences / duplicated adjacent text nodes -----
  const sents = regionText.split(/(?<=[.!?。！？])\s+/);
  let dupSentences = 0;
  let dupSentenceHint = "";
  for (let i = 1; i < sents.length; i++) {
    if (sents[i].length >= 40 && sents[i] === sents[i - 1]) {
      dupSentences++;
      if (!dupSentenceHint) dupSentenceHint = sents[i].slice(0, 70);
    }
  }
  let dupTextNodes = 0;
  let dupTextNodeHint = "";
  try {
    const tw = document.createTreeWalker(region || document.body, NodeFilter.SHOW_TEXT);
    let prev = "";
    let prevParent = null;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const t = (n.nodeValue || "").replace(/\s+/g, " ").trim();
      if (t.length >= 40) {
        if (t === prev && n.parentElement === prevParent) {
          dupTextNodes++;
          if (!dupTextNodeHint) dupTextNodeHint = t.slice(0, 70);
        }
        prev = t;
        prevParent = n.parentElement;
      }
    }
  } catch {
    /* region gone */
  }

  // ---- does scoring keep up? long visible paragraphs with no chip in or after them ----
  let visPara = 0;
  let visParaNoChip = 0;
  try {
    for (const p of document.querySelectorAll("p")) {
      const words = (p.textContent.match(/\S+/g) || []).length;
      if (words < 50) continue;
      const r = p.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.width === 0) continue;
      if (p.closest(CHROME_SEL) || p.closest("[aria-hidden=true], pre, [contenteditable]")) continue;
      visPara++;
      const own = p.querySelector('[data-anagram="host"]');
      const after = p.nextElementSibling && p.nextElementSibling.matches('[data-anagram="host"]');
      if (!own && !after) visParaNoChip++;
    }
  } catch {
    /* fine */
  }

  // ---- hosts we saw earlier that are detached now but still reachable -----------------
  let detached = 0;
  try {
    for (const ref of D.refs) {
      const el = ref.deref();
      if (el && !el.isConnected) detached++;
    }
  } catch {
    /* no WeakRef */
  }

  return {
    ...base,
    deep: true,
    zeroSize,
    chrome,
    chromeSamples,
    clippedOut,
    clipSamples,
    orphan,
    orphanSamples,
    dupGroups,
    dupChips,
    sameUnitGroups,
    sameUnitChips,
    pileUpGroups,
    pileUpChips,
    repeatedTextChips,
    dupSamples,
    dupSentences,
    dupSentenceHint,
    dupTextNodes,
    dupTextNodeHint,
    visPara,
    visParaNoChip,
    detached,
    domElements: document.getElementsByTagName("*").length,
    fabCount:
      (document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? "").trim(),
  };
}

// ---- reachability ---------------------------------------------------------------------

const BOT_RE =
  /just a moment|verifying you are human|attention required|checking your browser|are you a robot|prove your humanity|enable javascript and cookies|unusual traffic|access denied|安全验证|人机验证/i;
const WALL_RE =
  /log in to continue|sign in to continue|log in or sign up|create an account to continue|you must log in|register to view|members only|continue with (?:google|apple|facebook)/i;

async function reachOf(page, status) {
  const v = await page
    .evaluate(
      ({ bot, wall }) => {
        const t = (document.title || "") + " " + (document.body ? document.body.innerText.slice(0, 1500) : "");
        const w = (document.body ? document.body.innerText : "").split(/\s+/).filter(Boolean).length;
        return { bot: new RegExp(bot, "i").test(t), wall: new RegExp(wall, "i").test(t), words: w, path: location.pathname };
      },
      { bot: BOT_RE.source, wall: WALL_RE.source },
    )
    .catch(() => null);
  if (!v) return "blocked";
  if (v.bot) return "bot check";
  if (/\/(?:login|signin|sign-in|signup|checkpoint|consent|challenge)\b/i.test(v.path)) return "login wall";
  if (v.wall && v.words < 900) return "login wall";
  if (status && status >= 400) return `blocked (HTTP ${status})`;
  if (v.words < 30) return "blocked (empty page)";
  return "ok";
}

// ---- the scripted session --------------------------------------------------------------

/** goto with one retry; returns { status, error }. */
async function navigate(page, url) {
  let err = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      return { status: resp ? resp.status() : 0, error: null };
    } catch (e) {
      err = String(e).split("\n")[0].slice(0, 140);
    }
  }
  return { status: 0, error: err };
}

/**
 * Click one VIEW-ONLY control the entry names ("show more", "load more comments",
 * "expand replies", a tab, a <details>). Anything that navigates is undone at once:
 * this tool looks, it does not walk around the site.
 */
async function clickAct(page, act, note) {
  const label = act.label || act.sel || act.text || "control";
  const sel =
    act.sel ??
    ["button", '[role="button"]', "summary", "a", "span"]
      .map((t) => `${t}:has-text("${String(act.text).replace(/"/g, '\\"')}")`)
      .join(", ");
  const loc = page.locator(sel);
  const want = Math.max(1, Number(act.n) || 1);
  let clicked = 0;
  let count = 0;
  try {
    count = await loc.count();
  } catch {
    count = 0;
  }
  const urlBefore = page.url();
  for (let i = 0; i < Math.min(count, want * 3) && clicked < want; i++) {
    const el = loc.nth(i);
    try {
      const txt = ((await el.textContent({ timeout: 1500 })) || "").replace(/\s+/g, " ").trim();
      if (act.text && txt.length > 60) continue; // matched a container, not the control
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      await el.click({ timeout: 4000 });
      clicked++;
      await page.waitForTimeout(Number(act.wait) || 2500);
      if (page.url() !== urlBefore) {
        note.push(`act "${label}" navigated — went back`);
        await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(1500);
        break;
      }
    } catch {
      /* not clickable / covered / detached — a result, recorded below */
    }
  }
  note.push(`act "${label}": ${clicked}/${want} clicked (${count} candidates)`);
  return clicked;
}

/**
 * One page, one run. `withExt` false is the control: the same script, no extension, no
 * ball toggle and no navigation, so the site's own long tasks and DOM errors are known.
 */
async function runSession({ page, entry, budgetMs, withExt, daemon, drain, shotMid, onBeforeNav }) {
  const notes = [];
  const samples = [];
  const region = entry.region ?? null;
  let sampleTimer = 0;

  const take = async (deep) => {
    const s = await page.evaluate(SAMPLE, { deep, region }).catch(() => null);
    if (!s) return null;
    s.wall = Date.now();
    if (daemon) {
      drain();
      s.req = daemon.stats.requests;
      s.blk = daemon.stats.blocks;
    }
    samples.push(s);
    return s;
  };
  /** Wait, sampling on the way. Every phase spends its time through here. */
  const idle = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const slice = Math.min(400, end - Date.now());
      await page.waitForTimeout(slice).catch(() => {});
      if (Date.now() - sampleTimer >= SAMPLE_MS) {
        sampleTimer = Date.now();
        await take(false);
      }
    }
  };

  await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
  await idle(2500);
  const first = await take(true);
  sampleTimer = Date.now();

  // --- phase A: down, screen by screen (feeds get 30+ screens if the budget allows) ----
  const downMs = Math.round(budgetMs * 0.42);
  const endDown = Date.now() + downMs;
  let screens = 0;
  while (Date.now() < endDown) {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9))).catch(() => {});
    screens++;
    await idle(650);
  }
  notes.push(`scrolled ${screens} screens down`);
  const mid = await take(true);
  if (shotMid) await page.screenshot({ path: shotMid }).catch(() => {});

  // --- phase B: back to the top --------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    await page
      .evaluate(() => window.scrollBy(0, -Math.round(window.innerHeight * 6)))
      .catch(() => {});
    await idle(400);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await idle(Math.round(budgetMs * 0.05));
  const atTop = await take(true);

  // --- phase C: the view-only controls the entry names ---------------------------------
  const actMs = Math.round(budgetMs * 0.18);
  const endAct = Date.now() + actMs;
  for (const act of entry.act ?? []) {
    if (Date.now() > endAct) break;
    await clickAct(page, act, notes);
    await idle(800);
  }
  if (Date.now() < endAct) await idle(endAct - Date.now());

  // --- phase D: one resize ---------------------------------------------------------------
  await page.setViewportSize(RESIZED).catch(() => {});
  await idle(3000);
  const resized = await take(true);
  await page.setViewportSize(VIEWPORT).catch(() => {});
  await idle(2500);

  // --- phase E: the ball off and on ------------------------------------------------------
  let toggle = null;
  if (withExt) {
    const clickFab = () =>
      page
        .evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector("button.fab")?.click())
        .catch(() => {});
    const shown = await take(false);
    await clickFab();
    await idle(1500);
    const off = await take(false);
    await clickFab();
    await idle(1500);
    const on = await take(false);
    toggle = {
      before: shown ? shown.n - shown.hidden : 0,
      off: off ? off.n - off.hidden : 0,
      on: on ? on.n - on.hidden : 0,
      lost: shown && on ? shown.n - on.n : 0,
    };
  }

  // Everything cost is compared on happens BEFORE this point: the control run does not
  // navigate, and one extra document load would make the extension look like it cost one.
  const navAt = samples.length;
  if (onBeforeNav) await onBeforeNav();

  // --- phase F: one in-site link and back, LAST so the end state is the returned page ----
  let nav = null;
  if (withExt) {
    nav = { tried: false, ok: false };
    const before = await take(true);
    nav.beforeHosts = before ? before.n : 0;
    nav.beforeIds = before ? before.hosts.map((h) => h.id) : [];
    nav.beforeDoc = before ? before.docId : null;
    const origin = new URL(page.url()).origin;
    const urlBefore = page.url();
    let moved = false;
    if (entry.link) {
      nav.tried = true;
      try {
        const el = page.locator(entry.link).first();
        await el.scrollIntoViewIfNeeded({ timeout: 3000 });
        await el.click({ timeout: 5000 });
        await page.waitForTimeout(2500);
        moved = page.url() !== urlBefore;
      } catch (e) {
        notes.push("link click failed: " + String(e).split("\n")[0].slice(0, 80));
      }
    }
    if (!moved) {
      const href = await page
        .evaluate((o) => {
          const seen = location.href;
          for (const a of document.querySelectorAll("main a[href], article a[href], a[href]")) {
            const h = a.href;
            if (!h.startsWith(o) || h === seen || h.includes("#")) continue;
            if ((a.textContent || "").trim().split(/\s+/).length < 3) continue;
            const r = a.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            return h;
          }
          return null;
        }, origin)
        .catch(() => null);
      if (href) {
        nav.tried = true;
        const r = await navigate(page, href);
        moved = !r.error;
      }
    }
    if (moved) {
      await idle(5000);
      const after = await take(true);
      nav.ok = true;
      nav.url = page.url().slice(0, 200);
      nav.sameDocument = after && after.docId === nav.beforeDoc;
      nav.afterHosts = after ? after.n : 0;
      nav.survivingIds = after ? after.hosts.filter((h) => nav.beforeIds.includes(h.id)).length : 0;
      nav.afterFab = after ? after.fab : false;
      nav.afterHlDetached = after ? after.hlDetached : 0;
      nav.afterDetached = after ? after.detached : 0;
      await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).catch(async () => {
        await navigate(page, entry.url);
      });
      await idle(5000);
      const back = await take(true);
      nav.backUrl = page.url().slice(0, 200);
      nav.backHosts = back ? back.n : 0;
      nav.backFab = back ? back.fab : false;
      nav.backHlDetached = back ? back.hlDetached : 0;
    } else {
      notes.push("no in-site link followed");
    }
  }

  const last = await take(true);
  return { samples, notes, first, mid, atTop, resized, last, nav, toggle, screens, navAt };
}

// ---- turning a sample series into findings ----------------------------------------------

function analyse(samples) {
  const live = samples.filter((s) => s && s.hosts);
  const firstSeen = new Map();
  const lastSeen = new Map();
  const pendingFrom = new Map();
  const settleMs = [];
  const stuck = new Set();
  let flickerGone = 0;
  let flickerNew = 0;
  let quietPairs = 0;
  const seenAt = new Map();

  for (let i = 0; i < live.length; i++) {
    const s = live[i];
    const ids = new Set(s.hosts.map((h) => h.id));
    for (const id of ids) {
      let a = seenAt.get(id);
      if (!a) seenAt.set(id, (a = []));
      a.push(i);
    }
    for (const h of s.hosts) {
      if (!firstSeen.has(h.id)) firstSeen.set(h.id, s.wall);
      lastSeen.set(h.id, s.wall);
      if (h.pending) {
        if (!pendingFrom.has(h.id)) pendingFrom.set(h.id, s.wall);
        if (s.wall - pendingFrom.get(h.id) > 10_000) stuck.add(h.id);
      } else if (pendingFrom.has(h.id)) {
        settleMs.push(s.wall - pendingFrom.get(h.id));
        pendingFrom.delete(h.id);
      }
    }
    if (i === 0) continue;
    const prev = live[i - 1];
    // Flicker only counts where the PAGE stood still: same document, same text, the same
    // number of the page's own elements, same scroll position, no resize. Anything else
    // is the site legitimately changing, and a chip going with it is not our defect.
    if (
      prev.docId !== s.docId ||
      prev.textHash !== s.textHash ||
      prev.pageEls !== s.pageEls ||
      prev.scrollY !== s.scrollY ||
      prev.innerH !== s.innerH
    )
      continue;
    quietPairs++;
    const before = new Set(prev.hosts.map((h) => h.id));
    for (const id of before) if (!ids.has(id)) flickerGone++;
    for (const id of ids) if (!before.has(id)) flickerNew++;
  }
  // Chips still pending when the run ended have been pending at least this long.
  const now = live.length ? live[live.length - 1].wall : 0;
  for (const [id, from] of pendingFrom) if (now - from > 10_000) stuck.add(id);
  // The sharpest form: the SAME host element was gone from a sample and came back later.
  // A chip that is removed and re-inserted is a chip the reader saw blink.
  let flickerReappear = 0;
  for (const at of seenAt.values()) {
    for (let i = 1; i < at.length; i++) if (at[i] - at[i - 1] > 1) { flickerReappear++; break; }
  }

  settleMs.sort((a, b) => a - b);
  const pick = (q) => (settleMs.length ? settleMs[Math.min(settleMs.length - 1, Math.floor(settleMs.length * q))] : null);
  const deep = live.filter((s) => s.deep);
  const maxOf = (k) => deep.reduce((m, s) => Math.max(m, s[k] ?? 0), 0);

  return {
    samples: live.length,
    deepSamples: deep.length,
    quietPairs,
    hostsEverSeen: firstSeen.size,
    hostsAtEnd: live.length ? live[live.length - 1].n : 0,
    hostsMax: live.reduce((m, s) => Math.max(m, s.n), 0),
    flickerGone,
    flickerNew,
    flickerReappear,
    stuckPending: stuck.size,
    settleP50: pick(0.5),
    settleP90: pick(0.9),
    settleN: settleMs.length,
    dupGroupsMax: maxOf("dupGroups"),
    dupChipsMax: maxOf("dupChips"),
    sameUnitChipsMax: maxOf("sameUnitChips"),
    sameUnitGroupsMax: maxOf("sameUnitGroups"),
    pileUpChipsMax: maxOf("pileUpChips"),
    pileUpGroupsMax: maxOf("pileUpGroups"),
    repeatedTextChipsMax: maxOf("repeatedTextChips"),
    zeroSizeMax: maxOf("zeroSize"),
    chromeMax: maxOf("chrome"),
    clippedOutMax: maxOf("clippedOut"),
    orphanMax: maxOf("orphan"),
    detachedMax: maxOf("detached"),
    hlDetachedMax: maxOf("hlDetached"),
    hlRangesMax: maxOf("hlRanges"),
    visParaNoChipMax: maxOf("visParaNoChip"),
    dupSentencesMax: maxOf("dupSentences"),
    dupTextNodesMax: maxOf("dupTextNodes"),
    dupSample: deep.map((s) => s.dupSamples).find((x) => x && x.length) ?? null,
    clipSample: deep.map((s) => s.clipSamples).find((x) => x && x.length) ?? null,
    orphanSample: deep.map((s) => s.orphanSamples).find((x) => x && x.length) ?? null,
    dupSentenceHint: deep.map((s) => s.dupSentenceHint).find(Boolean) ?? "",
    dupTextNodeHint: deep.map((s) => s.dupTextNodeHint).find(Boolean) ?? "",
  };
}

/**
 * Rates over the whole run, so the control's shorter session is still comparable.
 *
 * The in-page counters live in `window.__dyn` and so RESET at every real navigation; the
 * totals are therefore summed from the positive deltas between consecutive samples, and a
 * drop is read as "a new document started counting". Long tasks are counted from the FIRST
 * sample on, never from navigation: both runs pay the same page-load cost, and dividing it
 * by two different session lengths would make the shorter control run look the busier one.
 */
/** The samples cost is judged on: everything up to the navigation phase, and their span. */
function costWindow(run) {
  const s = run.samples.slice(0, run.navAt > 1 ? run.navAt : run.samples.length).filter(Boolean);
  const ms = s.length > 1 ? s[s.length - 1].wall - s[0].wall : 1;
  return [s, ms];
}

function rates(samples, ms) {
  const live = samples.filter(Boolean);
  if (live.length === 0 || ms <= 0) return {};
  const a = live[0];
  const z = live[live.length - 1];
  const min = ms / 60000;
  const sumUp = (k) => {
    let n = 0;
    for (let i = 1; i < live.length; i++) {
      const d = live[i][k] - live[i - 1][k];
      if (d > 0) n += d;
      else if (live[i][k] > 0 && d < 0) n += live[i][k]; // counter restarted with a new document
    }
    return n;
  };
  const tasks = sumUp("tasks");
  const taskMs = sumUp("taskTotal");
  const muts = sumUp("muts");
  return {
    tasksLoad: a.tasks,
    taskMsLoad: Math.round(a.taskTotal),
    tasks,
    tasksPerMin: +(tasks / min).toFixed(1),
    taskWorst: live.reduce((m, s) => Math.max(m, s.taskWorst ?? 0), 0),
    taskTotal: Math.round(taskMs),
    taskMsPerMin: Math.round(taskMs / min),
    mutsPerSec: +((muts / ms) * 1000).toFixed(1),
    muts,
    reqPerMin: z.req === undefined ? null : +((z.req - (a.req ?? 0)) / min).toFixed(1),
    blkPerMin: z.blk === undefined ? null : +((z.blk - (a.blk ?? 0)) / min).toFixed(1),
    heapStartMB: a.heap ? +(a.heap / 1048576).toFixed(1) : null,
    heapEndMB: z.heap ? +(z.heap / 1048576).toFixed(1) : null,
    heapPeakMB: (() => {
      const p = live.reduce((m, s) => Math.max(m, s.heap ?? 0), 0);
      return p ? +(p / 1048576).toFixed(1) : null;
    })(),
  };
}

const DOM_ERR_RE =
  /removeChild|insertBefore|appendChild|replaceChild|not a child of this node|NotFoundError|HierarchyRequestError|hydrat|Minified React error #(?:418|421|422|423|425)|Text content does not match/i;

/** Attach the error/console/log recorders to a page. */
function watch(page) {
  const rec = { pageErrors: [], domErrors: [], extLogs: [], extErrors: [] };
  page.on("pageerror", (e) => {
    const t = String(e).split("\n")[0].slice(0, 200);
    rec.pageErrors.push(t);
    if (DOM_ERR_RE.test(t)) rec.domErrors.push(t);
  });
  const t0 = Date.now();
  page.on("console", (m) => {
    const text = m.text();
    const u = m.location()?.url ?? "";
    if (text.startsWith("[anagram:")) {
      rec.extLogs.push(`+${Date.now() - t0}ms ${text.slice(0, 180)}`);
      return;
    }
    if (m.type() !== "error" && m.type() !== "warning") return;
    if (u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid")) {
      rec.extErrors.push(text.slice(0, 160));
      return;
    }
    if (m.type() === "error") {
      rec.pageErrors.push(text.slice(0, 200));
      if (DOM_ERR_RE.test(text)) rec.domErrors.push(text.slice(0, 200));
    } else if (DOM_ERR_RE.test(text)) {
      rec.domErrors.push(text.slice(0, 200));
    }
  });
  return rec;
}

/** Count the orchestrator's own debug lines by what they say. */
function countLogs(lines) {
  const c = {};
  const bump = (k) => (c[k] = (c[k] ?? 0) + 1);
  for (const l of lines) {
    if (l.includes("url change refresh")) bump("urlChange");
    else if (l.includes("Readability chunk")) bump("readability");
    else if (l.includes("prefetch: queued")) bump("prefetchPass");
    else if (l.includes("backend changed")) bump("backendChanged");
    else if (l.includes("document replaced")) bump("documentReplaced");
    else if (l.includes("dirty re-scan failed")) bump("dirtyFailed");
    else if (l.includes("render failed")) bump("renderFailed");
    else if (l.includes("re-queued")) bump("requeued");
    else if (l.includes("daemon not answering")) bump("daemonDown");
    else if (l.includes("scoring daemon back")) bump("daemonBack");
    else if (l.trim().endsWith("rescan")) bump("rescan");
    else if (l.includes("started")) bump("started");
    else if (l.includes("stopped")) bump("stopped");
  }
  // "prefetch: queued N of M unscored units" carries the size of each pass.
  let queued = 0;
  for (const l of lines) {
    const m = l.match(/prefetch: queued (\d+) of (\d+)/);
    if (m) queued += Number(m[1]);
  }
  c.prefetchQueued = queued;
  return c;
}

async function cdpMetrics(session) {
  if (!session) return null;
  try {
    const { metrics } = await session.send("Performance.getMetrics");
    const g = (n) => metrics.find((m) => m.name === n)?.value ?? null;
    return {
      taskDuration: g("TaskDuration"),
      scriptDuration: g("ScriptDuration"),
      layoutDuration: g("LayoutDuration"),
      recalcStyleDuration: g("RecalcStyleDuration"),
      layoutCount: g("LayoutCount"),
      recalcStyleCount: g("RecalcStyleCount"),
      jsHeapUsedSize: g("JSHeapUsedSize"),
      nodes: g("Nodes"),
    };
  } catch {
    return null;
  }
}

function deltaMetrics(a, b) {
  if (!a || !b) return null;
  const d = {};
  for (const k of Object.keys(b)) {
    if (a[k] == null || b[k] == null) continue;
    d[k] = k.endsWith("Duration") ? +(b[k] - a[k]).toFixed(2) : Math.round(b[k] - a[k]);
  }
  return d;
}

// ---- one page, both runs -----------------------------------------------------------------

async function visit(entry) {
  const started = Date.now();
  const row = { name: entry.name, kind: entry.kind, url: entry.url, note: entry.note ?? null, static: !!entry.static };

  // --- the extension run -----------------------------------------------------------------
  // A fresh daemon AND a fresh throwaway profile per page: the L1 cache, the service
  // worker's IndexedDB cache and the recorded texts must all belong to this page alone.
  let ctx = null;
  let ext = null;
  try {
    ext = await withFakeDaemon({ viewport: VIEWPORT, userAgent: UA, locale: "en-US", timezoneId: "Asia/Shanghai" });
    ctx = ext.context;
    const extId = ext.sw ? new URL(ext.sw.url()).host : null;
    if (extId) {
      const opt = await ctx.newPage();
      await opt.goto(`chrome-extension://${extId}/options.html`).catch(() => {});
      await opt
        .evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: true }, res)))
        .catch(() => {});
      await opt.close().catch(() => {});
    }
    row.debug = !!extId;

    const page = await ctx.newPage();
    await page.addInitScript(INIT);
    const rec = watch(page);
    // Some sites open a tab on click; close it and stay where we are.
    ctx.on("page", (p) => {
      if (p !== page) p.close().catch(() => {});
    });

    const seenTexts = new Map();
    const drain = () => {
      const batch = ext.daemon.stats.texts.splice(0);
      for (const t of batch) {
        const k = cyrb53(t);
        const e = seenTexts.get(k);
        if (e) e.n++;
        else seenTexts.set(k, { n: 1, len: t.length, hint: t.replace(/\s+/g, " ").slice(0, 60) });
      }
    };

    const navRes = await navigate(page, entry.url);
    row.status = navRes.status;
    if (navRes.error) {
      row.reach = /Timeout/i.test(navRes.error) ? "timeout" : "blocked";
      row.error = navRes.error;
      row.ms = Date.now() - started;
      await ctx.close().catch(() => {});
      await ext.daemon.close().catch(() => {});
      return row;
    }
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    row.reach = await reachOf(page, navRes.status);
    if (row.reach !== "ok") {
      row.finalUrl = page.url().slice(0, 200);
      row.ms = Date.now() - started;
      await ctx.close().catch(() => {});
      await ext.daemon.close().catch(() => {});
      return row;
    }

    const cdp = await ctx.newCDPSession(page).catch(() => null);
    if (cdp) await cdp.send("Performance.enable").catch(() => {});
    const m0 = await cdpMetrics(cdp);

    const shotMid = out(`dyn-${entry.name}-mid.png`);
    const shotEnd = out(`dyn-${entry.name}-end.png`);
    const sessionStart = Date.now();
    let m1 = null;
    const run = await runSession({
      page,
      entry,
      budgetMs: BUDGET_MS,
      withExt: true,
      daemon: ext.daemon,
      drain,
      shotMid,
      onBeforeNav: async () => {
        m1 = await cdpMetrics(cdp);
      },
    });
    const sessionMs = Date.now() - sessionStart;
    drain();

    const tall = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
    await page.screenshot({ path: shotEnd, fullPage: tall > 0 && tall < 25000 }).catch(() => {});
    row.shots = { mid: shotMid, end: shotEnd };

    if (!m1) m1 = await cdpMetrics(cdp); // the run never reached the navigation phase
    row.ext = {
      ...analyse(run.samples),
      ...rates(...costWindow(run)),
      sessionMs,
      screens: run.screens,
      cdp: deltaMetrics(m0, m1),
      notes: run.notes,
      nav: run.nav,
      toggle: run.toggle,
      fabAtEnd: run.last ? run.last.fab : false,
      fabCount: run.last ? run.last.fabCount : "",
      domElements: run.last ? run.last.domElements : 0,
      logs: countLogs(rec.extLogs),
      // Kept so an anomaly can be placed in time afterwards: one compact row per sample
      // (ms since the first, chips, pending, hidden, scroll, the page's own element count
      // and text hash), and the orchestrator's own lines with the moment each arrived.
      series: run.samples
        .filter(Boolean)
        .map((s, i, a) => [s.wall - a[0].wall, s.n, s.pending, s.hidden, s.scrollY, s.pageEls, s.textHash, s.deep ? 1 : 0]),
      logLines: rec.extLogs.slice(0, 300),
      extErrors: [...new Set(rec.extErrors)].slice(0, 8),
      pageErrors: [...new Set(rec.pageErrors)].slice(0, 8),
      domErrors: [...new Set(rec.domErrors)].slice(0, 6),
      textHashStart: run.first ? run.first.textHash : null,
      textHashTop: run.atTop ? run.atTop.textHash : null,
      textHashEnd: run.last ? run.last.textHash : null,
      textCharsStart: run.first ? run.first.textChars : 0,
      textCharsEnd: run.last ? run.last.textChars : 0,
    };
    const dupTexts = [...seenTexts.values()].filter((v) => v.n > 1);
    row.ext.daemon = {
      requests: ext.daemon.stats.requests,
      blocks: ext.daemon.stats.blocks,
      uniqueTexts: seenTexts.size,
      resentTexts: dupTexts.length,
      resentBlocks: dupTexts.reduce((n, v) => n + v.n - 1, 0),
      worstRepeat: dupTexts.reduce((m, v) => Math.max(m, v.n), 0),
      resentSamples: dupTexts.sort((a, b) => b.n - a.n).slice(0, 3).map((v) => ({ n: v.n, len: v.len, hint: v.hint })),
    };
    await ctx.close().catch(() => {});
    ctx = null;
    await ext.daemon.close().catch(() => {});
  } catch (e) {
    row.reach = row.reach ?? "blocked";
    row.error = String(e).split("\n")[0].slice(0, 200);
    if (ctx) await ctx.close().catch(() => {});
    if (ext) await ext.daemon.close().catch(() => {});
  }

  // --- the control run: same page, same script, no extension -------------------------------
  if (!NO_CONTROL && row.reach === "ok") {
    const browser = await launchPlain({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        userAgent: UA,
        locale: "en-US",
        timezoneId: "Asia/Shanghai",
      });
      const page = await context.newPage();
      await page.addInitScript(INIT);
      const rec = watch(page);
      const navRes = await navigate(page, entry.url);
      if (!navRes.error) {
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        const cdp = await context.newCDPSession(page).catch(() => null);
        if (cdp) await cdp.send("Performance.enable").catch(() => {});
        const m0 = await cdpMetrics(cdp);
        const t0 = Date.now();
        const run = await runSession({
          page,
          entry,
          budgetMs: Math.round(BUDGET_MS * CONTROL_SHARE),
          withExt: false,
          daemon: null,
          drain: () => {},
        });
        const ms = Date.now() - t0;
        const m1 = await cdpMetrics(cdp);
        row.control = {
          ...rates(...costWindow(run)),
          sessionMs: ms,
          screens: run.screens,
          cdp: deltaMetrics(m0, m1),
          textHashStart: run.first ? run.first.textHash : null,
          textHashTop: run.atTop ? run.atTop.textHash : null,
          textHashEnd: run.last ? run.last.textHash : null,
          dupSentencesMax: Math.max(...run.samples.filter((s) => s.deep).map((s) => s.dupSentences ?? 0), 0),
          dupTextNodesMax: Math.max(...run.samples.filter((s) => s.deep).map((s) => s.dupTextNodes ?? 0), 0),
          pageErrors: [...new Set(rec.pageErrors)].slice(0, 8),
          domErrors: [...new Set(rec.domErrors)].slice(0, 6),
          domElements: run.last ? run.last.domElements : 0,
        };
      } else {
        row.control = { error: navRes.error };
      }
      await context.close().catch(() => {});
    } catch (e) {
      row.control = { error: String(e).split("\n")[0].slice(0, 160) };
    }
    await browser.close().catch(() => {});
  }

  row.ms = Date.now() - started;
  return row;
}

// ---- the run ------------------------------------------------------------------------------

console.log(
  `dynamics: ${entries.length} pages, ${MINUTES} min each${NO_CONTROL ? "" : ` + a ${Math.round(CONTROL_SHARE * 100)} % control run`} → ${OUT_DIR}`,
);
const rows = [];
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  let row;
  try {
    row = await visit(e);
  } catch (err) {
    row = { name: e.name, kind: e.kind, url: e.url, reach: "blocked", error: String(err).slice(0, 160) };
  }
  rows.push(row);
  const x = row.ext;
  const bits =
    row.reach === "ok" && x
      ? `chips=${x.hostsAtEnd}/${x.hostsMax} dup=${x.dupChipsMax} flick=${x.flickerGone}/${x.flickerNew} stuck=${x.stuckPending} orph=${x.orphanMax} resend=${x.daemon.resentBlocks} req/m=${x.reqPerMin} task=${x.tasksPerMin}/min vs ${row.control?.tasksPerMin ?? "–"} domErr=${x.domErrors.length}/${row.control?.domErrors?.length ?? "–"}`
      : (row.error ?? "");
  console.log(`[${String(i + 1).padStart(2)}/${entries.length}] ${row.name.padEnd(20)} ${String(row.reach).padEnd(16)} ${bits}`);
}

// ---- output ---------------------------------------------------------------------------------

const jsonPath = out(`dynamics-${LABEL}.json`);
writeFileSync(
  jsonPath,
  JSON.stringify({ label: LABEL, at: new Date().toISOString(), minutes: MINUTES, entries: entries.length, pages: rows }, null, 1),
);

const ok = rows.filter((r) => r.reach === "ok" && r.ext);
const md = [];
md.push(`# Anagram over time — \`${LABEL}\``);
md.push("");
md.push(
  `${rows.length} pages, ${ok.length} examined, ${rows.length - ok.length} unreachable. ` +
    `${MINUTES} min scripted session each, sampled every ${SAMPLE_MS / 1000} s, ` +
    `plus a control run of the same page with NO extension. ${new Date().toISOString()}`,
);
md.push("");
md.push(
  "**How to read the columns.** *chips* = hosts at the end / the most ever live at once. " +
    "*dup* = chips closing the SAME preceding 100 characters of text (two chips for one text). " +
    "*flick* = chips that vanished / appeared between two samples in which the page's own text, " +
    "the scroll position and the viewport were all unchanged. *stuck* = chips left \"analyzing…\" " +
    "for more than 10 s. *orph* = connected chips with less than 15 characters of text before " +
    "them (the unit they judge is gone). *clip* = chips drawn outside a box that clips its own " +
    "text. *resend* = blocks the daemon was asked about more than once (the L1 and service-worker " +
    "caches should make this 0). *task/min* = long tasks per minute, extension vs. control. " +
    "*Δtext* = the main region's own text changed between the first sample and the last " +
    "(`=` unchanged, `≠` changed) — meaningful only on pages marked static.",
);
md.push("");
md.push(
  "| page | kind | reach | chips | 2× unit | piled | flick↓ | blink | stuck | orph | clip | chrome | 0px | detach | hl✗ | resend | req/min | task/min ext:ctl | heap MB | Δtext ext:ctl | DOM err ext:ctl |",
);
md.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: |");
for (const r of rows) {
  if (r.reach !== "ok" || !r.ext) {
    md.push(`| ${r.name} | ${r.kind} | **${r.reach ?? "?"}** | | | | | | | | | | | | | | | | | | |`);
    continue;
  }
  const x = r.ext;
  const c = r.control ?? {};
  const same = (a, b) => (a && b ? (a === b ? "=" : "≠") : "?");
  md.push(
    `| ${r.name} | ${r.kind} | ok | ${x.hostsAtEnd}/${x.hostsMax} | ${x.sameUnitChipsMax} | ${x.pileUpChipsMax} | ${x.flickerGone} | ${x.flickerReappear} | ` +
      `${x.stuckPending} | ${x.orphanMax} | ${x.clippedOutMax} | ${x.chromeMax} | ${x.zeroSizeMax} | ${x.detachedMax} | ` +
      `${x.hlDetachedMax} | ${x.daemon.resentBlocks} | ${x.reqPerMin ?? "–"} | ${x.tasksPerMin}:${c.tasksPerMin ?? "–"} | ` +
      `${x.heapStartMB ?? "–"}→${x.heapEndMB ?? "–"} | ${same(x.textHashStart, x.textHashEnd)}:${same(c.textHashStart, c.textHashEnd)} | ` +
      `${x.domErrors.length}:${c.domErrors ? c.domErrors.length : "–"} |`,
  );
}
md.push("");
md.push("## Pages");
for (const r of rows) {
  md.push("");
  md.push(`### ${r.name} — ${r.kind}`);
  md.push(`\`${r.url}\`${r.note ? ` · ${r.note}` : ""}`);
  if (r.reach !== "ok" || !r.ext) {
    md.push(`- **${r.reach ?? "?"}**${r.status ? ` (HTTP ${r.status})` : ""}${r.error ? ` — \`${r.error}\`` : ""}`);
    continue;
  }
  const x = r.ext;
  const c = r.control ?? {};
  md.push(
    `- ${x.samples} samples over ${Math.round(x.sessionMs / 1000)} s, ${x.screens} screens scrolled; ` +
      `${x.hostsEverSeen} distinct chips seen, ${x.hostsAtEnd} at the end (peak ${x.hostsMax}); ` +
      `${x.hlRangesMax} highlight ranges at most; ball ${x.fabAtEnd ? "present" : "**GONE**"}${x.fabCount ? ` (“${x.fabCount}”)` : ""}; ` +
      `${x.quietPairs} of the ${x.samples - 1} sample pairs were "quiet" (same text, scroll and viewport) — flicker can only be seen in those`,
  );
  md.push(
    `- daemon: ${x.daemon.requests} requests / ${x.daemon.blocks} blocks, ${x.daemon.uniqueTexts} distinct texts, ` +
      `${x.reqPerMin ?? "–"} req/min, ${x.blkPerMin ?? "–"} blocks/min`,
  );
  md.push(
    `- cost: ${x.tasksLoad} long tasks (${x.taskMsLoad} ms) while the page loaded, then ${x.tasks} during the session ` +
      `(${x.tasksPerMin}/min, worst ${x.taskWorst} ms, ${x.taskMsPerMin} ms/min) vs. control ` +
      `${c.tasksLoad ?? "–"} (${c.taskMsLoad ?? "–"} ms) + ${c.tasks ?? "–"} (${c.tasksPerMin ?? "–"}/min, worst ${c.taskWorst ?? "–"} ms, ${c.taskMsPerMin ?? "–"} ms/min); ` +
      `page mutations ${x.mutsPerSec}/s vs ${c.mutsPerSec ?? "–"}/s; heap ${x.heapStartMB ?? "–"} → ${x.heapEndMB ?? "–"} MB ` +
      `vs ${c.heapStartMB ?? "–"} → ${c.heapEndMB ?? "–"} MB`,
  );
  if (x.cdp && c.cdp)
    md.push(
      `- CDP over the session: script ${x.cdp.scriptDuration}s / layout ${x.cdp.layoutDuration}s / style ${x.cdp.recalcStyleDuration}s ` +
        `vs control ${c.cdp.scriptDuration}s / ${c.cdp.layoutDuration}s / ${c.cdp.recalcStyleDuration}s ` +
        `(${x.cdp.layoutCount} vs ${c.cdp.layoutCount} layouts; nodes ${x.domElements} vs ${c.domElements ?? "–"})`,
    );
  if (x.settleN)
    md.push(`- chip settle time (pending → verdict, ±${SAMPLE_MS / 1000} s resolution): p50 ${x.settleP50} ms, p90 ${x.settleP90} ms over ${x.settleN} chips`);
  const logs = Object.entries(x.logs ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}×${v}`);
  if (logs.length) md.push(`- \`[anagram:orchestrator]\`: ${logs.join(", ")}`);

  const anomalies = [];
  if (x.sameUnitChipsMax > 0)
    anomalies.push(
      `**${x.sameUnitChipsMax} chips too many for the SAME unit** (${x.sameUnitGroupsMax} groups whose chips all read the same percentage over the same word count): ` +
        (x.dupSample ?? []).filter((d) => d.kind === "sameUnit").map((d) => `${d.chips}× “${d.nums[0]}” (${d.words[0]} words) in one \`<${d.parent}>\` after “…${d.hint}”`).join("; "),
    );
  if (x.pileUpChipsMax > 0)
    anomalies.push(
      `**${x.pileUpChipsMax} chips of DISTINCT units piled at one insertion point** (${x.pileUpGroupsMax} anchors): ` +
        (x.dupSample ?? []).filter((d) => d.kind === "pileUp").map((d) => `${d.chips} chips (${d.nums.join("/")}) in one \`<${d.parent}>\` after “…${d.hint}”`).join("; "),
    );
  if (x.orphanMax > 0)
    anomalies.push(
      `**orphan chips: ${x.orphanMax}** — connected, but nothing is left of the text they judge` +
        ((x.orphanSample ?? []).length ? ` (parents: ${x.orphanSample.map((o) => `<${o.parent}>`).join(", ")})` : ""),
    );
  // A chip APPEARING while the page stands still is only the verdict landing. A chip
  // VANISHING while the page stands still is the defect this run is looking for.
  if (x.flickerGone > 0)
    anomalies.push(
      `**flicker: ${x.flickerGone} chips vanished** across ${x.quietPairs} sample pairs in which the page's own text, scroll and viewport were identical (${x.flickerNew} appeared in the same pairs — that part is just verdicts landing)`,
    );
  if (x.flickerReappear > 0)
    anomalies.push(`**${x.flickerReappear} chip hosts left the DOM and came back** — the same element, removed and re-inserted (the reader sees it blink)`);
  if (x.stuckPending > 0) anomalies.push(`**stuck “analyzing…”: ${x.stuckPending} chips** past 10 s`);
  if (x.daemon.resentBlocks > 0)
    anomalies.push(
      `**repeated scoring: ${x.daemon.resentBlocks} blocks re-sent** (${x.daemon.resentTexts} texts, worst one sent ${x.daemon.worstRepeat}×): ` +
        x.daemon.resentSamples.map((s) => `${s.n}× ${s.len}ch “${s.hint}…”`).join("; "),
    );
  if (x.clippedOutMax > 0)
    anomalies.push(
      `**chips drawn outside a clipping box: ${x.clippedOutMax}**` +
        ((x.clipSample ?? []).length ? ` (${x.clipSample.map((s) => `<${s.box}> .${s.cls}`).join(", ")})` : ""),
    );
  if (x.repeatedTextChipsMax > 0)
    anomalies.push(
      `${x.repeatedTextChipsMax} chips close text that appears more than once on the page, in different parents — one chip per copy, which is by design (noted so it is not read as a duplicate)`,
    );
  if (x.chromeMax > 0) anomalies.push(`chips in page chrome: ${x.chromeMax}`);
  if (x.zeroSizeMax > 0) anomalies.push(`chips with no box at all (0×0, not hidden): ${x.zeroSizeMax}`);
  if (x.detachedMax > 0)
    anomalies.push(`hosts detached but still reachable: ${x.detachedMax} (suggestive of a retained badge, not proof — GC may simply not have run)`);
  if (x.hlDetachedMax > 0) anomalies.push(`**highlight ranges over detached nodes: ${x.hlDetachedMax}**`);
  if (x.visParaNoChipMax > 0)
    anomalies.push(`at worst ${x.visParaNoChipMax} long \`<p>\` in the viewport with no chip (scoring lagging the scroll, or the walker declining them)`);
  if (r.static && x.textHashStart !== x.textHashEnd)
    anomalies.push(
      `**the page's own text changed** over the session (${x.textCharsStart} → ${x.textCharsEnd} chars) although the entry is marked static` +
        (c.textHashStart && c.textHashStart !== c.textHashEnd ? " — the control run changed too, so this is the site" : c.textHashStart ? " — **the control run did NOT change**" : ""),
    );
  if (x.dupSentencesMax > (c.dupSentencesMax ?? 0))
    anomalies.push(`**duplicated sentences in the page text: ${x.dupSentencesMax}** (control ${c.dupSentencesMax ?? "–"}) — “${x.dupSentenceHint}…”`);
  if (x.dupTextNodesMax > (c.dupTextNodesMax ?? 0))
    anomalies.push(`**identical adjacent text nodes: ${x.dupTextNodesMax}** (control ${c.dupTextNodesMax ?? "–"}) — “${x.dupTextNodeHint}…”`);
  if (x.domErrors.length)
    anomalies.push(`**DOM-surgery errors with the extension: ${x.domErrors.length}** (control ${c.domErrors ? c.domErrors.length : "–"}): ${x.domErrors.slice(0, 3).map((e) => `\`${e}\``).join("; ")}`);
  if (x.extErrors.length) anomalies.push(`extension console errors: ${x.extErrors.map((e) => `\`${e}\``).join("; ")}`);
  if (!x.fabAtEnd) anomalies.push("**the floating ball is gone at the end of the session**");
  if (x.logs?.rescan) anomalies.push(`${x.logs.rescan} full rescans (every verdict on the page re-derived)`);
  if (x.logs?.documentReplaced) anomalies.push(`${x.logs.documentReplaced}× "document replaced — restarting"`);
  if (x.logs?.backendChanged) anomalies.push(`${x.logs.backendChanged}× "backend changed" (L1 cache dropped, page re-derived)`);

  if (anomalies.length) {
    md.push("- anomalies:");
    for (const a of anomalies) md.push(`  - ${a}`);
  } else {
    md.push("- no anomalies");
  }

  const n = x.nav;
  if (n && n.ok) {
    md.push(
      `- after one in-site navigation (${n.sameDocument ? "same document — SPA" : "new document"}) to \`${n.url}\`: ` +
        `${n.beforeHosts} → ${n.afterHosts} chips, ${n.survivingIds} of the old hosts survived, ball ${n.afterFab ? "present" : "**GONE**"}, ` +
        `${n.afterHlDetached} highlight ranges over detached nodes; back → ${n.backHosts} chips, ball ${n.backFab ? "present" : "**GONE**"}, ` +
        `${n.backHlDetached} detached ranges`,
    );
  } else if (n && n.tried) md.push("- in-site navigation: attempted, did not move");
  if (x.toggle)
    md.push(
      `- ball toggle: ${x.toggle.before} visible → ${x.toggle.off} off → ${x.toggle.on} on` +
        (x.toggle.lost ? ` (**${x.toggle.lost} chips lost across the toggle**)` : ""),
    );
  if ((x.notes ?? []).length) md.push(`- session: ${x.notes.join("; ")}`);
}
const mdPath = out(`dynamics-${LABEL}.md`);
writeFileSync(mdPath, md.join("\n") + "\n");

console.log("");
console.log(
  `examined ${ok.length}/${rows.length}; duplicate chips ${ok.reduce((n, r) => n + r.ext.dupChipsMax, 0)}, ` +
    `flicker ${ok.reduce((n, r) => n + r.ext.flickerGone + r.ext.flickerNew, 0)}, ` +
    `stuck ${ok.reduce((n, r) => n + r.ext.stuckPending, 0)}, ` +
    `orphans ${ok.reduce((n, r) => n + r.ext.orphanMax, 0)}, ` +
    `re-sent blocks ${ok.reduce((n, r) => n + r.ext.daemon.resentBlocks, 0)}, ` +
    `DOM errors ${ok.reduce((n, r) => n + r.ext.domErrors.length, 0)} (control ${ok.reduce((n, r) => n + (r.control?.domErrors?.length ?? 0), 0)})`,
);
console.log(`→ ${jsonPath}`);
console.log(`→ ${mdPath}`);
