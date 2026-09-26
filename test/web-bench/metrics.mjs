// test/web-bench/metrics.mjs — what was read, set against what the page's main content is.
//
// Words are runs of letters and digits, lower-cased (the tokenisation of WCXB's own
// evaluate.py, `\w+`). A word READ counts as main content when a run of three words around
// it occurs in the truth, and a word of the truth counts as READ when a run of three words
// around it occurs in what was read: a bag of words calls a sidebar's "the" main content,
// and three words in a row do not. Both sides are one stream of words each, across block and
// unit joints, so a list item of two words is still found inside a unit that reads the list.
//
// WCXB also publishes `word F1` as a bag of words; that figure is reported beside ours
// (`bowF1`) so our numbers can be set against its published baselines.

export const tokens = (text) => (text ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
/** Words the way a reader counts them — whitespace-separated, with a letter or digit. */
export const wordCount = (text) => (text ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const N = 3;

function grams(toks) {
  const set = new Set();
  if (toks.length === 0) return set;
  if (toks.length < N) {
    set.add(toks.join(" "));
    return set;
  }
  for (let i = 0; i + N <= toks.length; i++) set.add(toks.slice(i, i + N).join(" "));
  return set;
}

/** Which of `toks` sit inside a run of N words that `other` also has. */
function marked(toks, other) {
  const hit = new Uint8Array(toks.length);
  if (toks.length === 0) return hit;
  if (toks.length < N) {
    if (other.has(toks.join(" "))) hit.fill(1);
    return hit;
  }
  for (let i = 0; i + N <= toks.length; i++) {
    if (other.has(toks.slice(i, i + N).join(" "))) for (let k = i; k < i + N; k++) hit[k] = 1;
  }
  return hit;
}

function bowOverlap(a, b) {
  const count = new Map();
  for (const t of b) count.set(t, (count.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of a) {
    const c = count.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      count.set(t, c - 1);
    }
  }
  return overlap;
}

const norm = (s) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * One page's figures.
 *
 * `truthBlocks` — the main content, block by block (a heading, a paragraph, a list item).
 * `units` — what would be scored: `{ text, comment }`. `commentsAreContent` — the page type
 * says the comments ARE the main content (a forum, a Q&A page, a conversation), so a comment
 * unit outside the truth is ordinary leakage there; elsewhere it is reported apart, because
 * the product reads comments on purpose where several datasets call them boilerplate.
 */
export function scorePage({ truthBlocks, units, scopeText = null, snippets = null, commentsAreContent = false }) {
  const truthToks = [];
  const inLong = [];
  for (const block of truthBlocks) {
    const toks = tokens(block);
    const long = wordCount(block) >= 75;
    for (const t of toks) {
      truthToks.push(t);
      inLong.push(long);
    }
  }
  const unitToks = units.map((u) => tokens(u.text));
  const readToks = unitToks.flat();
  const truthGrams = grams(truthToks);
  const readGrams = grams(readToks);

  const covered = marked(truthToks, readGrams);
  const inTruth = marked(readToks, truthGrams);

  let coveredAll = 0, long = 0, coveredLong = 0;
  for (let i = 0; i < truthToks.length; i++) {
    if (covered[i]) coveredAll++;
    if (inLong[i]) {
      long++;
      if (covered[i]) coveredLong++;
    }
  }
  // Per unit: how much of it is main content, and whether it is a comment.
  let at = 0, readMain = 0, leakComment = 0, leakOther = 0;
  const perUnit = [];
  units.forEach((u, k) => {
    const n = unitToks[k].length;
    let main = 0;
    for (let i = at; i < at + n; i++) if (inTruth[i]) main++;
    at += n;
    readMain += main;
    const leak = n - main;
    if (u.comment && !commentsAreContent) leakComment += leak;
    else leakOther += leak;
    perUnit.push({ toks: n, main });
  });

  const read = readToks.length;
  const precision = read ? readMain / read : null;
  const recall = truthToks.length ? coveredAll / truthToks.length : null;
  const bow = bowOverlap(readToks, truthToks);
  const bowP = read ? bow / read : 0, bowR = truthToks.length ? bow / truthToks.length : 0;

  let scope = null;
  if (scopeText !== null) {
    const scopeToks = tokens(scopeText);
    const s1 = marked(scopeToks, truthGrams), s2 = marked(truthToks, grams(scopeToks));
    scope = {
      toks: scopeToks.length,
      main: s1.reduce((a, b) => a + b, 0),
      covered: s2.reduce((a, b) => a + b, 0),
    };
  }

  let withHit = null, withoutHit = null;
  if (snippets) {
    const hay = norm(units.map((u) => u.text).join("\n"));
    withHit = snippets.with.filter((s) => hay.includes(norm(s))).length;
    withoutHit = snippets.without.filter((s) => hay.includes(norm(s))).length;
  }

  return {
    truth: truthToks.length, truthLong: long,
    read, readMain, leakOther, leakComment,
    covered: coveredAll, coveredLong,
    precision, recall,
    bowP, bowR, bowF1: bowP + bowR > 0 ? (2 * bowP * bowR) / (bowP + bowR) : 0,
    scope,
    with: snippets ? { n: snippets.with.length, hit: withHit } : null,
    without: snippets ? { n: snippets.without.length, hit: withoutHit } : null,
    perUnit,
    // For the side-by-side view: which truth words were read, which read words are main.
    marks: { covered: Array.from(covered), inTruth: Array.from(inTruth) },
  };
}

/**
 * Unit boundaries against Webis-WebSeg-20's segments. Every scored text node the dataset
 * placed in a segment is one step of the reading; between two consecutive steps the
 * segmentation either changes segment or not, and the units either change unit or not.
 * `recall` — of the segment changes, the share where a unit ends too (a unit never runs
 * across two segments); `purity` — the share of a unit's words in its biggest segment.
 */
export function scoreSegments(units, seg, text = {}) {
  // XPath first; where the dataset's numbering differs (it counts rendered siblings only),
  // the node with the same text under the same tags, nearest in numbering.
  const bare = (xp) => xp.replace(/\[\d+\]/g, "");
  const nums = (xp) => (xp.match(/\[(\d+)\]/g) ?? []).map((m) => Number(m.slice(1, -1)));
  const byText = new Map();
  for (const [xp, t] of Object.entries(text)) {
    const key = `${bare(xp)}\u0000${t}`;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(xp);
  }
  const segOf = (xp, t) => {
    if (seg[xp] !== undefined) return seg[xp];
    const candidates = byText.get(`${bare(xp)}\u0000${t}`);
    if (!candidates) return undefined;
    const mine = nums(xp);
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = nums(c).reduce((a, n, i) => a + Math.abs(n - (mine[i] ?? 0)), 0);
      if (d < bestD) { best = c; bestD = d; }
    }
    return seg[best];
  };
  const steps = [];
  let mapped = 0, total = 0, pureWords = 0, unitWords = 0, crossing = 0;
  units.forEach((u, k) => {
    const bySeg = new Map();
    let words = 0;
    u.xpaths.forEach((part, p) => part.forEach((xp, i) => {
      const w = u.nodeWords[p][i];
      total += w;
      const s = segOf(xp, u.nodeTexts?.[p]?.[i] ?? "");
      if (s === undefined || s < 0) return;
      mapped += w;
      words += w;
      bySeg.set(s, (bySeg.get(s) ?? 0) + w);
      steps.push({ unit: k, seg: s });
    }));
    if (words > 0) {
      const top = Math.max(...bySeg.values());
      pureWords += top;
      unitWords += words;
      if ([...bySeg.values()].filter((w) => w >= words * 0.1).length > 1) crossing++;
    }
  });
  let tp = 0, fp = 0, fn = 0;
  for (let i = 1; i < steps.length; i++) {
    const gt = steps[i].seg !== steps[i - 1].seg;
    const ours = steps[i].unit !== steps[i - 1].unit;
    if (gt && ours) tp++;
    else if (ours) fp++;
    else if (gt) fn++;
  }
  return { mappedWords: mapped, scoredWords: total, pureWords, unitWords, crossing, units: units.length, tp, fp, fn };
}
