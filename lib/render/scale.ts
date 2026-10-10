// lib/render/scale.ts — the one place a verdict becomes a word, a colour and a doubt.
//
// EditLens decodes its four buckets by WEIGHTED AVERAGE, not by the most likely bucket
// (Thai et al., ICLR 2026, §C.2): the buckets are equal slices of the editing scale and
// the estimate is the probability-weighted mean of their midpoints. The number the chip
// shows, Σ pᵢ·i / 3, is that estimate on a 0–1 scale, so the word is the bucket whose
// slice contains it: the cuts sit halfway between bucket centres, at 1/6, 1/2 and 5/6.
// The most likely bucket used to pick the word; with the probabilities spread out it
// flipped on a one-point change and could contradict the number next to it.
//
// The colour is the word's: four colours, one per word, and nothing in between. A reader
// going through a page of verdicts sorts them at a glance — green, gold, orange, crimson —
// where a continuous ramp made .30 and .60 two shades of olive to be told apart. The number
// beside it carries the detail.
import { BUCKET_COUNT } from "../contract";

/** Where one word ends and the next begins, on the 0–1 score. */
export const SCORE_CUTS = [1 / 6, 1 / 2, 5 / 6] as const;

/** Which of the four words a score reads as: 0 human … 3 AI-generated. */
export function levelOf(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  let level = 0;
  while (level < SCORE_CUTS.length && s >= SCORE_CUTS[level]!) level++;
  return level;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : 0;
}

// ---- colour ----------------------------------------------------------------------------

/**
 * The four words' colours, human → AI-generated, on a light page and on a dark one. Chosen
 * to stay apart for a reader who cannot tell red from green (protanopia and deuteranopia,
 * Machado 2009: every pair at least 8.9 OKLab x100 apart on a light page, 9.1 on a dark one,
 * test/node/scale.test.ts) — the deep crimson is what keeps AI-generated off the orange and
 * the green — and to read on white and on near-black.
 */
export const BAND_COLORS = {
  light: ["#00a06a", "#e3a400", "#f0600f", "#a6002e"],
  dark: ["#33d996", "#ffc21a", "#ff8633", "#ff5470"],
} as const;

/** A word's colour (0 human … 3 AI-generated) — with `alpha`, a tint of it. */
export function bandColor(level: number, dark: boolean, alpha = 1): string {
  const hex = (dark ? BAND_COLORS.dark : BAND_COLORS.light)[Math.min(Math.max(Math.round(level), 0), 3)]!;
  if (alpha >= 1) return hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

/** The score's colour: its word's. */
export function scaleColor(score: number, dark: boolean, alpha = 1): string {
  return bandColor(levelOf(score), dark, alpha);
}

/** Stylesheet rules giving `--c` each word's colour under `selector`.b0 … .b3, and the dark
 *  page's under `dark` (a selector prefix for the dark surface). */
export function bandColorRules(selector: string, dark: string, property = "--c"): string {
  return [0, 1, 2, 3].map((i) =>
    `${selector}.b${i} { ${property}: ${BAND_COLORS.light[i]}; }\n${dark} ${selector}.b${i} { ${property}: ${BAND_COLORS.dark[i]}; }`,
  ).join("\n");
}

/** The four words' colours on one of the extension's own pages, as a constructed stylesheet:
 *  those pages allow no inline style (wxt.config.ts CSP). */
export function adoptBandColorRules(doc: Document = document): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(bandColorRules("", "html.dark"));
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
}

/** The four words side by side as a left-to-right bar, each over its slice of the scale (the
 *  card's scale and the setup page's legend). */
export function scaleGradient(dark: boolean): string {
  const c = dark ? BAND_COLORS.dark : BAND_COLORS.light;
  const [a, b, d] = SCORE_CUTS.map((cut) => `${(cut * 100).toFixed(2)}%`);
  return `linear-gradient(to right, ${c[0]} 0 ${a}, ${c[1]} ${a} ${b}, ${c[2]} ${b} ${d}, ${c[3]} ${d} 100%)`;
}

/**
 * Underlines are painted by named ::highlight() rules, which cannot take a colour per range:
 * one name per word.
 */
export const SCALE_STEPS = 3;
export function scaleStep(score: number): number {
  return levelOf(score);
}

// ---- doubt ----------------------------------------------------------------------------

/**
 * How spread out the four probabilities are around their mean, 0 (all on one bucket) to
 * 1 (half on "human", half on "AI-generated"): the standard deviation of the bucket
 * index, over its largest possible value. Ordinal on purpose — 50/50 between two
 * neighbouring buckets says "in between"; 50/50 between the two ends says "no idea". A
 * paragraph read in several windows gets the spread of their MIXTURE, which includes how
 * far the windows disagree with each other.
 */
export function spread(probs: readonly number[]): number {
  let mean = 0;
  for (let i = 0; i < probs.length; i++) mean += (probs[i] ?? 0) * i;
  let variance = 0;
  for (let i = 0; i < probs.length; i++) variance += (probs[i] ?? 0) * (i - mean) ** 2;
  const most = (BUCKET_COUNT - 1) / 2;
  return clamp01(Math.sqrt(variance) / most);
}

/** The word beside the score's on the scale that the score lies nearer to: what an unsure
 *  verdict could as well have been. */
export function nearestOtherLevel(score: number): number {
  const level = levelOf(score);
  const below = level > 0 ? score - SCORE_CUTS[level - 1]! : Infinity;
  const above = level < SCORE_CUTS.length ? SCORE_CUTS[level]! - score : Infinity;
  return below <= above ? level - 1 : level + 1;
}

