// test/pdf-bench/align.mjs — what a reconstruction got right, measured against the truth.
//
// Every token of every block is traced to the ground-truth token it reproduces, by
// anchors: a 4-gram of the truth that the block repeats, then token by token while the
// two keep step (a gap of up to three truth tokens is allowed, for a word the PDF lost),
// with a bigram search a little further on when they fall out of step (an equation's
// glyphs in the middle of a sentence). Each truth token is claimed once. A block token
// that reproduces nothing is labelled by where it stands: in a column of numbers down
// the margin it is a line number; between two tokens of one paragraph it is a citation
// or a number the HTML writes differently, inline math, or noise (a mangled word); at
// the head or foot of the page it is a running head or a page number; in a block that
// is mostly one kind of non-prose (a reference list, a caption) it is that kind; and
// anything else is unmatched (text in a figure, most often).
//
// A block is a paragraph as the reconstruction made it; a unit is what gets scored (the
// blocks the reader groups, all of at least 75 words). The measures:
//   coverage   body tokens reproduced by any block / by a scored unit
//   leakage    tokens of scored units that are not body prose, by what they are instead
//   order      prose paragraphs placed where the truth has them (Kendall tau over the
//              paragraphs, the count outside the longest in-order run) and tokens read
//              backwards (a jump back in the truth while reading forward)
//   boundaries a block that starts where a paragraph starts is a found boundary; one
//              starting inside a paragraph whose beginning another block holds is a split;
//              a paragraph whose start sits inside another block is a merge
import { PROSE, tokenize } from "./truth.mjs";

const K = 4;
/** How far from the last anchor, in truth tokens, a block too short to anchor is looked for. */
const SHORT_REACH = 150;
/** Labels that are not prose to score and are counted as leakage. */
export const LEAK = ["inline-math", "display-math", "margin", "line-number", "caption", "figtext", "footnote", "reference", "front", "heading", "noise", "unmatched", "duplicate"];

function keyAt(tokens, i) {
  return `${tokens[i].t} ${tokens[i + 1].t} ${tokens[i + 2].t} ${tokens[i + 3].t}`;
}

/** Items of each page that form a column of line numbers: bare numbers stacked at one x. */
export function lineNumberItems(pages) {
  const out = new Map();
  for (const page of pages ?? []) {
    const stacks = new Map();
    page.items.forEach((it, i) => {
      if (!/^\s*\d{1,4}\s*$/.test(it.str)) return;
      const key = Math.round((it.x + it.width) / 3);
      if (!stacks.has(key)) stacks.set(key, []);
      stacks.get(key).push(i);
    });
    const set = new Set();
    for (const [key, members] of stacks) {
      const near = [...(stacks.get(key - 1) ?? []), ...members, ...(stacks.get(key + 1) ?? [])];
      if (near.length >= 12) for (const i of members) set.add(i);
    }
    out.set(page.page, set);
  }
  return out;
}

/** The page and item each character of a block came from, where the engine says. */
function sourceOf(block, offset) {
  for (const r of block.runs ?? []) if (offset >= r.at && offset < r.at + r.length) return r;
  return null;
}

export function alignDocument(truth, engine) {
  const G = truth.tokens;
  const n = G.length;
  const owner = new Int32Array(n).fill(-1);
  const index = new Map();
  for (let i = 0; i + K <= n; i++) {
    const key = keyAt(G, i);
    const list = index.get(key);
    if (list) list.push(i);
    else index.set(key, [i]);
  }
  const pagesByNumber = new Map((engine.pages ?? []).map((p) => [p.page, p]));
  const numbered = lineNumberItems(engine.pages);
  const unitOf = new Int32Array(engine.blocks.length).fill(-1);
  engine.units.forEach((u, k) => { for (const b of u.blocks) unitOf[b] = k; });

  // ---- tokens of the reconstruction, in reading order --------------------------------
  const ours = [];
  const blocks = engine.blocks.map((block, bi) => {
    const toks = tokenize(block.text).map((tok) => {
      const run = sourceOf(block, tok.s);
      const page = run?.page ?? block.page;
      const item = run ? pagesByNumber.get(run.page)?.items[run.item] : undefined;
      const out = { t: tok.t, s: tok.s, e: tok.e, block: bi, page, gt: -1, label: "", item, itemIndex: run?.item ?? -1, g: ours.length };
      ours.push(out);
      return out;
    });
    return { ...block, toks, unit: unitOf[bi] };
  });

  // ---- anchoring ------------------------------------------------------------------------
  let last = -1;
  const claim = (tok, q) => { owner[q] = tok.g; tok.gt = q; };
  for (const b of blocks) {
    const T = b.toks;
    let p = -1;
    for (let i = 0; i < T.length; i++) {
      let hit = -1;
      if (p >= 0) {
        for (let d = 1; d <= 4 && p + d < n; d++) {
          const q = p + d;
          if (owner[q] < 0 && G[q].t === T[i].t) { hit = q; break; }
        }
      }
      if (hit < 0 && i + K <= T.length) {
        const cands = index.get(keyAt(T, i));
        if (cands) {
          const ref = p >= 0 ? p : last;
          let bestLen = -1;
          for (const c of cands) {
            if (owner[c] >= 0) continue;
            let len = 0;
            while (len < 16 && i + len < T.length && c + len < n && owner[c + len] < 0 && T[i + len].t === G[c + len].t) len++;
            if (len > bestLen || (len === bestLen && Math.abs(c - ref) < Math.abs(hit - ref))) { bestLen = len; hit = c; }
          }
        }
      }
      if (hit < 0 && p >= 0 && i + 1 < T.length) {
        for (let q = p + 1; q <= p + 40 && q + 1 < n; q++) {
          if (owner[q] < 0 && owner[q + 1] < 0 && G[q].t === T[i].t && G[q + 1].t === T[i + 1].t) { hit = q; break; }
        }
      }
      if (hit >= 0) { claim(T[i], hit); p = hit; last = hit; }
    }
    // A block too short to hold an anchor (a heading, a label): the whole of it, found
    // again close to the last anchor. Anywhere in the document a word or two turns up by
    // chance, and a chance match would take the token from the block that really has it.
    if (T.length > 0 && T.length < K && T.every((x) => x.gt < 0) && last >= 0) {
      let best = -1;
      for (let c = Math.max(0, last - SHORT_REACH); c + T.length <= Math.min(n, last + SHORT_REACH); c++) {
        let ok = true;
        for (let j = 0; j < T.length && ok; j++) ok = owner[c + j] < 0 && G[c + j].t === T[j].t;
        if (ok && (best < 0 || Math.abs(c - last) < Math.abs(best - last))) best = c;
      }
      if (best >= 0) { T.forEach((x, j) => claim(x, best + j)); last = best + T.length - 1; }
    }
  }

  // ---- labels -----------------------------------------------------------------------------
  for (const b of blocks) {
    const T = b.toks;
    for (let i = 0; i < T.length; i++) {
      const tok = T[i];
      if (tok.gt >= 0) { tok.label = G[tok.gt].cat; continue; }
      let j = i - 1;
      while (j >= 0 && T[j].gt < 0) j--;
      let k = i + 1;
      while (k < T.length && T[k].gt < 0) k++;
      const a = j >= 0 ? T[j].gt : -1;
      const z = k < T.length ? T[k].gt : -1;
      const inside = a >= 0 && z > a && G[a].para >= 0 && G[a].para === G[z].para && z - a <= k - j + 8;
      const pg = pagesByNumber.get(tok.page);
      const rel = tok.item && pg ? tok.item.y / (pg.height || 1) : 0.5;
      if (tok.item && numbered.get(tok.page)?.has(tok.itemIndex)) tok.label = "line-number";
      else if (inside) {
        const gap = new Set();
        for (let q = a + 1; q < z; q++) gap.add(G[q].cat);
        tok.label = gap.has("cite") ? "cite" : /^\d+$/.test(tok.t) ? "number" : gap.has("inline-math") || tok.t.length === 1 ? "inline-math" : "noise";
      } else if (tok.item && (rel < 0.07 || rel > 0.94)) tok.label = "margin";
      else if (i + K <= T.length && index.has(keyAt(T, i))) tok.label = "duplicate";
      else tok.label = "unmatched";
    }
    // Text the truth words differently (a reference list's full author list, a caption's
    // symbols) is still what the block around it is: when most of what the block matched is
    // one kind of non-prose, what it did not match is taken to be the same kind.
    const kinds = {};
    let matched = 0;
    for (const tok of T) if (tok.gt >= 0) { matched++; kinds[tok.label] = (kinds[tok.label] ?? 0) + 1; }
    const [major, votes] = Object.entries(kinds).sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
    if (votes >= 3 && votes >= matched * 0.6 && ["reference", "caption", "figtext", "footnote", "front", "display-math"].includes(major)) {
      for (const tok of T) if (tok.label === "unmatched") tok.label = major;
    }
  }

  // ---- coverage and leakage -----------------------------------------------------------------
  const count = (list, pick) => {
    const out = {};
    for (const x of list) { const k = pick(x); out[k] = (out[k] ?? 0) + 1; }
    return out;
  };
  let body = 0, coveredAll = 0, coveredScored = 0;
  for (let q = 0; q < n; q++) {
    if (G[q].cat !== "body") continue;
    body++;
    if (owner[q] >= 0) {
      coveredAll++;
      if (blocks[ours[owner[q]].block].unit >= 0) coveredScored++;
    }
  }
  const scoredToks = ours.filter((t) => blocks[t.block].unit >= 0);
  const readToks = ours.filter((t) => blocks[t.block].kind !== "heading");
  const leakShare = (list) => list.length ? list.filter((t) => LEAK.includes(t.label)).length / list.length : 0;

  // ---- order -------------------------------------------------------------------------------
  const paraStats = truth.paras.map((p, pi) => {
    const mine = [];
    let prose = 0;
    for (let q = p.start; q >= 0 && q < p.end; q++) {
      if (!PROSE.has(G[q].cat)) continue;
      prose++;
      if (owner[q] >= 0) mine.push(owner[q]);
    }
    mine.sort((x, y) => x - y);
    return { pi, prose, matched: mine.length, pos: mine.length ? mine[mine.length >> 1] : -1 };
  });
  const placed = paraStats.filter((s) => s.prose >= 5 && s.matched >= s.prose * 0.5);
  let concordant = 0, discordant = 0;
  for (let x = 0; x < placed.length; x++) {
    for (let y = x + 1; y < placed.length; y++) {
      if (placed[x].pos < placed[y].pos) concordant++;
      else discordant++;
    }
  }
  const inOrder = longestIncreasing(placed.map((s) => s.pos));
  const outOfOrder = placed.filter((_, i) => !inOrder.has(i)).map((s) => ({ para: s.pi, page: ours[s.pos].page }));
  let lastProse = -1;
  const backJumps = [];
  for (const tok of ours) {
    if (tok.gt < 0 || !PROSE.has(G[tok.gt].cat)) continue;
    if (tok.gt < lastProse) backJumps.push(tok.page);
    lastProse = tok.gt;
  }

  // ---- boundaries ----------------------------------------------------------------------------
  const proseBefore = (q) => {
    const p = truth.paras[G[q].para];
    let c = 0;
    for (let x = p.start; x < q; x++) if (PROSE.has(G[x].cat)) c++;
    return c;
  };
  const starts = new Set();
  const splits = [];
  for (const b of blocks) {
    // A block with fewer prose tokens than an anchor holds (a figure's "0", a stray label)
    // was placed by chance if at all, and says nothing about where paragraphs break.
    const prose = b.toks.filter((t) => t.gt >= 0 && PROSE.has(G[t.gt].cat) && G[t.gt].para >= 0);
    if (prose.length < K) continue;
    const first = prose[0];
    const pi = G[first.gt].para;
    if (proseBefore(first.gt) <= 1) { starts.add(pi); continue; }
    // Inside a paragraph: a split only if what comes before it was read by another block.
    const p = truth.paras[pi];
    let prev = -1;
    for (let q = first.gt - 1; q >= p.start && prev < 0; q--) if (owner[q] >= 0 && PROSE.has(G[q].cat)) prev = q;
    if (prev < 0) continue;
    const other = blocks[ours[owner[prev]].block];
    if (other === b) continue;
    const brk = other.page !== b.page || b.columnBreak;
    splits.push({ para: pi, page: first.page, kind: brk ? "at-break" : "in-column", block: first.block, after: ours[owner[prev]].block });
  }
  const merges = [];
  let tp = 0;
  for (const s of paraStats) {
    const p = truth.paras[s.pi];
    if (!PROSE.has(p.cat) || p.soft || s.prose < 3 || s.matched < s.prose * 0.5) continue;
    let q0 = -1;
    for (let q = p.start; q < p.end && q0 < 0; q++) if (PROSE.has(G[q].cat)) q0 = q;
    if (q0 < 0 || owner[q0] < 0) continue;
    if (starts.has(s.pi)) { tp++; continue; }
    const tok = ours[owner[q0]];
    const T = blocks[tok.block].toks;
    let before = null;
    for (let i = T.indexOf(tok) - 1; i >= 0 && !before; i--) if (T[i].label) before = T[i];
    // Nothing before it in its block: the paragraph opens in a block too short to count.
    const kind = !before ? "short-start" : before.gt >= 0 && PROSE.has(G[before.gt].cat) ? "prose" : before.label;
    merges.push({ para: s.pi, page: tok.page, kind, block: tok.block });
  }
  const fp = splits.length;
  const fn = merges.length;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;

  // ---- per page ------------------------------------------------------------------------------
  const pages = new Map();
  const pageOf = (n0) => {
    if (!pages.has(n0)) pages.set(n0, { page: n0, tokens: 0, scored: 0, leak: {}, missed: 0, splits: 0, merges: 0, backJumps: 0, outOfOrder: 0 });
    return pages.get(n0);
  };
  for (const t of ours) {
    const pg = pageOf(t.page);
    pg.tokens++;
    if (blocks[t.block].unit >= 0) {
      pg.scored++;
      if (LEAK.includes(t.label)) pg.leak[t.label] = (pg.leak[t.label] ?? 0) + 1;
    }
  }
  // A body token nobody read is charged to the page of the nearest one somebody did.
  const nearPage = new Int32Array(n).fill(-1);
  let seen = -1;
  for (let q = 0; q < n; q++) { if (owner[q] >= 0) seen = ours[owner[q]].page; nearPage[q] = seen; }
  seen = -1;
  for (let q = n - 1; q >= 0; q--) { if (owner[q] >= 0) seen = ours[owner[q]].page; if (nearPage[q] < 0) nearPage[q] = seen; }
  for (let q = 0; q < n; q++) if (G[q].cat === "body" && owner[q] < 0 && nearPage[q] >= 0) pageOf(nearPage[q]).missed++;
  for (const s of splits) pageOf(s.page).splits++;
  for (const m of merges) pageOf(m.page).merges++;
  for (const pg of backJumps) pageOf(pg).backJumps++;
  for (const o of outOfOrder) pageOf(o.page).outOfOrder++;
  for (const pg of pages.values()) {
    const leaked = Object.values(pg.leak).reduce((a, b) => a + b, 0);
    pg.badness = leaked + pg.missed + 20 * (pg.splits + pg.merges) + 10 * pg.backJumps + 20 * pg.outOfOrder;
  }

  const metrics = {
    truth: { tokens: n, body, paras: truth.paras.filter((p) => PROSE.has(p.cat)).length, math: G.filter((t) => t.cat === "inline-math" || t.cat === "display-math").length },
    coverage: { body, all: coveredAll, scored: coveredScored },
    leak: {
      scored: scoredToks.length,
      scoredBy: count(scoredToks, (t) => t.label),
      read: readToks.length,
      readBy: count(readToks, (t) => t.label),
      scoredShare: leakShare(scoredToks),
      readShare: leakShare(readToks),
    },
    order: { paras: placed.length, concordant, discordant, tau: placed.length > 1 ? (concordant - discordant) / (concordant + discordant) : 1, outOfOrder: outOfOrder.length, backJumps: backJumps.length },
    bounds: {
      tp, fp, fn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
      splits: count(splits, (s) => s.kind), merges: count(merges, (m) => m.kind),
    },
  };
  return { metrics, blocks, pages: [...pages.values()].sort((a, b) => a.page - b.page), owner, splits, merges, outOfOrder };
}

/** Indices of one longest strictly increasing subsequence of `seq`. */
function longestIncreasing(seq) {
  const tails = [];
  const prev = new Int32Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}


/** Tokens of scored units printed as line numbers, from the page geometry alone (no truth). */
export function lineNumbersScored(engine) {
  if (!engine.pages) return null;
  const numbered = lineNumberItems(engine.pages);
  const scored = new Set(engine.units.flatMap((u) => u.blocks));
  let count = 0;
  engine.blocks.forEach((block, bi) => {
    if (!scored.has(bi)) return;
    for (const tok of tokenize(block.text)) {
      const run = sourceOf(block, tok.s);
      if (run && numbered.get(run.page)?.has(run.item)) count++;
    }
  });
  return count;
}
