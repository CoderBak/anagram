// test/node/random.ts — a seeded generator for the property suites.
//
// The pure text machinery (model form, window planning, the scheduler) is fed by
// whatever the web hands it, so the interesting inputs are the ones nobody thought to
// write a fixture for. These helpers build them from a seed: every case is reproducible
// from the number the failing assertion prints, and the same seed gives the same text on
// every machine, which a Math.random() case never would.
//
// No dependency: mulberry32 is five lines, has a period long past anything a suite runs
// through, and needs no seeding ceremony.

export interface Rng {
  /** [0, 1). */
  float(): number;
  /** Integer in [lo, hi], both included. */
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
}

export function rng(seed: number): Rng {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return {
    float: next,
    int,
    chance: (p) => next() < p,
    pick: (xs) => xs[int(0, xs.length - 1)],
  };
}

/** Seeds for one property run: consecutive, so a failure names a number one can retype. */
export function seeds(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

// ---- alphabets ------------------------------------------------------------------------

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const CAPS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Han + kana: text with no spaces between words and its own sentence marks. */
const CJK_CHARS = "的一是不了人我在有他这为之大来以个中上们时年月日国经过说要会後言語文字漢かなカナ";
const EMOJI = ["😀", "🚀", "🌍", "👩‍💻", "🇯🇵", "✅", "🙂"];
/** Every invisible the model form promises to remove. The joiner is kept: emoji need it. */
export const INVISIBLES = [
  "​", "‌", "‎", "‏", "­", "﻿",
  "‪", "‬", "⁠", "⁦", "⁩",
];
/** What a LaTeX-to-HTML converter leaves in the text. */
const LATEX_BITS = ["---", "--", "``", "''", "\\%", "\\&", "\\_", "\\#"];
const LATEX_SPANS = ["$\\tau^{2}$", "$\\alpha$", "$\\mathrm{CO}_2$"];
const PUNCT = [",", ";", ":", " —", " –", ")", "(", "…"];

/** Figures as a converted paper writes them: en-dashed ranges, escaped percents. */
function figure(r: Rng): string {
  const a = r.int(1, 2026);
  const k = r.int(0, 4);
  if (k === 0) return `${a}–${a + r.int(1, 40)}`;
  if (k === 1) return `${a}-${a + r.int(1, 40)}`;
  if (k === 2) return `${r.int(0, 99)}.${r.int(0, 9)}\\%`;
  if (k === 3) return `${a},${String(r.int(0, 999)).padStart(3, "0")}`;
  return `${a}‑${a + r.int(1, 9)}`;
}

const word = (r: Rng): string => {
  const n = r.int(2, 11);
  let w = r.chance(0.12) ? r.pick(CAPS.split("")) : r.pick(LETTERS.split(""));
  for (let i = 1; i < n; i++) w += LETTERS[r.int(0, 25)];
  return w;
};

const cjkRun = (r: Rng, n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += CJK_CHARS[r.int(0, CJK_CHARS.length - 1)];
  return s;
};

export interface TextOpts {
  /** Keep adding sentences until the text is at least this long. */
  targetChars?: number;
  /** Paragraphs, joined the way a merged unit joins its parts ("\n\n"). */
  parts?: number;
  /** Share of sentences written in CJK (their own full stop, no space after it). */
  cjk?: number;
  /** Per-word chance of a presentation variant (invisible, NBSP, curly quote, emoji). */
  noise?: number;
  /** Per-sentence chance of LaTeX residue. */
  latex?: number;
  /** Per-sentence chance of a LaTeX span written TIGHT against quotes or dashes —
   *  `'$\alpha$'`, ``$\tau^{2}$'', `x-$\alpha$-y`. Removing the span welds what stood on
   *  either side of it together, and what it welds has to be folded in the same pass. */
  latexTight?: number;
  /** No sentence-ending punctuation anywhere — the "no boundary" case. */
  unpunctuated?: boolean;
  /** Insert one unbroken token of this many characters (a base64 blob, a hash). */
  hugeToken?: number;
  /** Blank lines and single newlines inside a paragraph. */
  newlines?: boolean;
  /** Straight quotes, placed so no two of them ever end up adjacent. */
  quotes?: number;
}

function decorate(r: Rng, w: string, o: TextOpts): string {
  const noise = o.noise ?? 0;
  if (noise > 0 && r.chance(noise)) {
    const k = r.int(0, 4);
    if (k === 0) return w.slice(0, 1) + r.pick(INVISIBLES) + w.slice(1);
    if (k === 1) return w + " ";
    if (k === 2) return r.pick(EMOJI) + w;
    if (k === 3) return w + r.pick(PUNCT);
    return w + r.pick(INVISIBLES);
  }
  if ((o.quotes ?? 0) > 0 && r.chance(o.quotes!)) {
    // Letter-adjacent only: "''" is a LaTeX quote of its own, and two quotes side by
    // side would not survive the fold the pair test is about.
    return r.chance(0.5) ? `"${w}"` : `${w.slice(0, 1)}'${w.slice(1)}`;
  }
  return w;
}

function sentence(r: Rng, o: TextOpts): string {
  if (r.chance(o.cjk ?? 0)) {
    const s = cjkRun(r, r.int(8, 40));
    return o.unpunctuated ? s : s + r.pick(["。", "！", "？"]);
  }
  const n = r.int(4, 22);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(r.chance(0.08) ? figure(r) : decorate(r, word(r), o));
  if (r.chance(o.latex ?? 0)) {
    words.splice(r.int(0, words.length), 0, r.chance(0.5) ? r.pick(LATEX_BITS) : r.pick(LATEX_SPANS));
  }
  if (r.chance(o.latexTight ?? 0)) {
    const span = r.pick(LATEX_SPANS);
    const tight = r.pick([`'${span}'`, `\`\`${span}''`, `"${span}"`, `${span}'s`, `x-${span}-y`, `${span}--${span}`]);
    words.splice(r.int(0, words.length), 0, tight);
  }
  let s = words.join(" ");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return o.unpunctuated ? s : s + r.pick([".", ".", ".", "!", "?", "."]);
}

function part(r: Rng, o: TextOpts, min: number): string {
  let s = "";
  while (s.length < min || s === "") {
    s += (s === "" ? "" : r.chance(o.newlines ? 0.25 : 0) ? "\n" : " ") + sentence(r, o);
  }
  if (o.newlines && r.chance(0.3)) s += "\n\n" + sentence(r, o);
  return s;
}

/** A text built to a shape — the raw material of the property runs. */
export function makeText(r: Rng, o: TextOpts = {}): string {
  const target = o.targetChars ?? r.int(40, 400);
  const parts = Math.max(1, o.parts ?? 1);
  const per = Math.ceil(target / parts);
  const out: string[] = [];
  for (let i = 0; i < parts; i++) out.push(part(r, o, per));
  let text = out.join("\n\n");
  if (o.hugeToken) {
    const blob = Array.from({ length: o.hugeToken }, () => LETTERS[r.int(0, 25)] + "").join("");
    const at = r.int(0, text.length);
    text = text.slice(0, at) + blob + text.slice(at);
  }
  return text;
}

// ---- presentation variants (renderings of one text) ----------------------------------

/** Positions a character may be inserted at without splitting a surrogate pair. */
function safeCut(s: string, at: number): boolean {
  if (at <= 0 || at >= s.length) return false;
  const prev = s.charCodeAt(at - 1);
  return !(prev >= 0xd800 && prev <= 0xdbff);
}

/** The same text with soft hyphens sprinkled through it (hyphenation hints). */
export function withSoftHyphens(r: Rng, s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += s[i];
    if (r.chance(0.08) && safeCut(s, i + 1)) out += "­";
  }
  return out;
}

/** The same text with its spaces set as non-breaking ones. */
export function withNbsp(r: Rng, s: string): string {
  return s.replace(/ /g, (m) => (r.chance(0.5) ? " " : m));
}

/** The same text with typographic quotes instead of straight ones. */
export function withCurlyQuotes(s: string): string {
  let open = true;
  return s
    .replace(/"/g, () => ((open = !open) ? "”" : "“"))
    .replace(/'/g, "’");
}
