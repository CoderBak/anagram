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
// The colour is the number itself on one continuous ramp — one hue, light to dark (a
// magnitude, not a category), so .49 and .51 look alike, lightness alone still orders
// the scale for a reader who sees no hue, and human text carries the quietest mark on
// the page. Dark surfaces run the same ramp from dim to bright.
import type { ScoreResult } from "../contract";
import { BUCKET_COUNT } from "../contract";

/** Where one word ends and the next begins, on the 0–1 score. */
export const SCORE_CUTS = [1 / 6, 1 / 2, 5 / 6] as const;

/** Which of the four words a score reads as: 0 human … 3 AI-generated. */
export function levelOf(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  let level = 0;
  while (level < SCORE_CUTS.length && s >= SCORE_CUTS[level]) level++;
  return level;
}

// ---- colour ---------------------------------------------------------------------------

const HUE = 25;
/** OKLCH lightness and chroma at score 0 and at score 1; both move linearly between. */
const RAMP = {
  light: { l0: 0.76, l1: 0.44, c0: 0.045, c1: 0.16 },
  dark: { l0: 0.5, l1: 0.74, c0: 0.045, c1: 0.15 },
} as const;

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : 0;
}

/** The score's colour, as a CSS oklch() — with `alpha`, a tint of it. */
export function scaleColor(score: number, dark: boolean, alpha = 1): string {
  const r = dark ? RAMP.dark : RAMP.light;
  const s = clamp01(score);
  const l = r.l0 + (r.l1 - r.l0) * s;
  const c = r.c0 + (r.c1 - r.c0) * s;
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${HUE}${alpha < 1 ? ` / ${alpha}` : ""})`;
}

/**
 * The same colour for a stylesheet, reading the score from a custom property, so one
 * rule serves every chip and the page's light or dark surface picks the ramp.
 */
export function scaleColorCss(dark: boolean, variable = "--s"): string {
  const r = dark ? RAMP.dark : RAMP.light;
  return (
    `oklch(calc(${r.l0} + ${(r.l1 - r.l0).toFixed(3)} * var(${variable}, 0)) ` +
    `calc(${r.c0} + ${(r.c1 - r.c0).toFixed(3)} * var(${variable}, 0)) ${HUE})`
  );
}

/** The whole ramp as a left-to-right gradient (the card's scale). */
export function scaleGradient(dark: boolean): string {
  return `linear-gradient(to right in oklch, ${scaleColor(0, dark)}, ${scaleColor(1, dark)})`;
}

/**
 * Underlines are painted by named ::highlight() rules, which cannot take a colour per
 * range, so the ramp is sampled: twenty-one steps, .05 apart — closer than the eye tells
 * two thin lines apart.
 */
export const SCALE_STEPS = 20;
export function scaleStep(score: number): number {
  return Math.round(clamp01(score) * SCALE_STEPS);
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

/**
 * How thick a verdict's dot is, as a ring in the score's colour, for the doubt in `--u`
 * (1 − the chance its word is right, lib/render/confidence.ts): the whole `radius` when the
 * word is surely right (a full dot), thinning in proportion to that chance down to a line
 * that stays visible. No threshold, and no fading, which the colour scale would read as
 * "more human".
 */
export function ringCss(radius: string): string {
  const least = "max(1px, 0.08em)";
  return `calc(${least} + (${radius} - ${least}) * (1 - var(--u, 0)))`;
}

/** The range the card shades around the score: one standard deviation, in score units. */
export function scoreRange(r: ScoreResult): { from: number; to: number } {
  const half = (spread(r.probs) * ((BUCKET_COUNT - 1) / 2)) / (BUCKET_COUNT - 1);
  return { from: clamp01(r.score - half), to: clamp01(r.score + half) };
}
