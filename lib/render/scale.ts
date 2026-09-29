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
// The colour is the number itself on one continuous ramp: green through amber to red,
// read at a glance, with the hue, lightness and chroma all moving with the score, so .49
// and .51 look alike. Lightness falls the whole way (rises on a dark surface), so a reader
// who cannot tell red from green still sees the order, and the word is always beside it;
// chroma is as high as sRGB allows, so the human end is plainly green and the middle amber.
import type { ScoreResult } from "../contract";
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

// ---- colour ----------------------------------------------------------------------------

/** OKLCH hue: green at score 0, amber at the middle, red at 1, linear in each half. */
export const HUES = { human: 145, middle: 70, ai: 25 } as const;
/**
 * OKLCH lightness at score 0, .5 and 1 (linear between), and chroma at 0, .25, .5, .75 and
 * 1 (linear between). Chroma is as high as sRGB allows at each lightness and hue: the limit
 * falls from a vivid green to an olive and rises again to the red, so it is set at each knot
 * to 69-100% of the limit there, and the whole ramp, sampled every hundredth, stays inside
 * sRGB (test/node/scale.test.ts computes the limit). Where it holds back, at the dark ramp's
 * quarter steps, more would bring two steps closer for a reader who cannot tell red from
 * green: simulated for protanopia and deuteranopia (Machado 2009), a quarter of the scale
 * apart is at least 7.8 (light) and 6.0 (dark) OKLab x100, and the test holds it there.
 * Lightness falls the whole way on a light page and rises on a dark one, which is what such
 * a reader sees.
 */
const RAMP = {
  light: { l: [0.76, 0.58, 0.42], c: [0.226, 0.131, 0.119, 0.135, 0.168] },
  dark: { l: [0.46, 0.66, 0.78], c: [0.143, 0.1, 0.141, 0.13, 0.126] },
} as const;

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(Math.max(x, 0), 1) : 0;
}

/** The score's hue, in degrees: green through amber to red. */
export function scaleHue(score: number): number {
  const s = clamp01(score);
  const { human, middle, ai } = HUES;
  return s <= 0.5 ? human + (middle - human) * (s / 0.5) : middle + (ai - middle) * ((s - 0.5) / 0.5);
}

/** The ramp's lightness at `score`: linear in each half. */
export function scaleLightness(score: number, dark: boolean): number {
  const [a, b, c] = (dark ? RAMP.dark : RAMP.light).l;
  const s = clamp01(score);
  return s <= 0.5 ? a + (b - a) * (s / 0.5) : b + (c - b) * ((s - 0.5) / 0.5);
}

/** The ramp's chroma at `score`: linear between the quarter-step knots. */
export function scaleChroma(score: number, dark: boolean): number {
  const c = (dark ? RAMP.dark : RAMP.light).c;
  const s = clamp01(score);
  const k = Math.min(3, Math.floor(s * 4));
  return c[k]! + (c[k + 1]! - c[k]!) * (s * 4 - k);
}

/** The score's colour, as a CSS oklch() — with `alpha`, a tint of it. */
export function scaleColor(score: number, dark: boolean, alpha = 1): string {
  const s = clamp01(score);
  return `oklch(${scaleLightness(s, dark).toFixed(3)} ${scaleChroma(s, dark).toFixed(3)} ${scaleHue(s).toFixed(1)}${alpha < 1 ? ` / ${alpha}` : ""})`;
}

/**
 * The same colour for a stylesheet, reading the score from a custom property, so one
 * rule serves every chip and the page's light or dark surface picks the ramp. Each
 * piecewise-linear channel is written with min() and max(), which is what the functions
 * above compute for a score in 0–1.
 */
export function scaleColorCss(dark: boolean, variable = "--s"): string {
  const r = dark ? RAMP.dark : RAMP.light;
  const s = `var(${variable}, 0)`;
  const { human, middle, ai } = HUES;
  const [l0, l1, l2] = r.l;
  const c = r.c;
  const chroma = [0, 1, 2, 3].map((i) => `${((c[i + 1]! - c[i]!) * 4).toFixed(3)} * max(0, min(${s} - ${i * 0.25}, 0.25))`).join(" + ");
  return (
    `oklch(calc(${l0} + ${((l1 - l0) * 2).toFixed(3)} * min(${s}, 0.5) + ${((l2 - l1) * 2).toFixed(3)} * max(${s} - 0.5, 0)) ` +
    `calc(${c[0]} + ${chroma}) ` +
    `calc(${human} - ${(2 * (human - middle)).toFixed(1)} * min(${s}, 0.5) - ${(2 * (middle - ai)).toFixed(1)} * max(${s} - 0.5, 0)))`
  );
}

/** The whole ramp as a left-to-right gradient (the card's scale), with stops along the hue's path. */
export function scaleGradient(dark: boolean): string {
  // Every channel bends only at a quarter step, so five stops draw the ramp exactly.
  const stops = [0, 0.25, 0.5, 0.75, 1].map((s) => `${scaleColor(s, dark)} ${s * 100}%`);
  return `linear-gradient(to right in oklch, ${stops.join(", ")})`;
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
