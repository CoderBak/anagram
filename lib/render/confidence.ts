// lib/render/confidence.ts — how likely a verdict's word is right.
//
// A small logistic model of the chance that the word shown (Human / Lightly edited /
// Heavily edited / AI-generated, from the score's cuts) names the edit-magnitude bucket
// EditLens was trained to predict (the official score_to_bucket of the cosine score). It
// was fitted on the EditLens validation split only — full texts, 75/100/150-word prefixes
// and long texts read in passes, prepared as the official pipeline prepares them — chosen
// by grouped cross-validation on that split together with a held-out half of the
// out-of-domain Enron set, and checked once on the test, Enron and Llama sets (calibration
// error 0.045 / 0.037 / 0.041; a verdict rated 0.9 or more was right 93–98% of the time).
//
// What it says still depends on the mix of human and AI text a page holds, which nothing
// here can know, so it is only ever shown as how full a verdict's dot is (ringCss in
// scale.ts), never as a number.
import type { ScoreResult } from "../contract";
import { isScoredWindow, type UnitVerdict } from "../capture/windows";
import { levelOf, spread } from "./scale";

const INTERCEPT = 0.4789800889881948;
/** Per level (human, lightly, heavily, AI): the level's own offset … */
const LEVEL = [0, -0.27777072278684506, -0.8218023160479644, -0.49052984604712996];
/** … and its slope on logit(score). */
const SCORE = [-0.27906235472594465, 0.3749664232263039, -0.15136091856577924, 0.04171772685651157];
/** Shared slopes: ln(tokens read), logit(probability on the shown category), spread. */
const TOKENS = 0.17878516533077032;
const SHOWN = 0.17470375685695397;
const SPREAD = -2.062463805292949;

type Range = readonly [number, number];
/** Per level, the range each input took in the fitting data; inputs are held inside it. */
const RANGES: ReadonlyArray<{ score: Range; tokens: Range; shown: Range; spread: Range }> = [
  { score: [-5.066224313171635, -1.6115994695962763], tokens: [4.330733340286331, 7.6511201757027], shown: [0.3187800617569478, 4.157867957904519], spread: [0.1079897114440898, 0.6159157193426169] },
  { score: [-1.6094379124341005, -0.00386667148425811], tokens: [4.382026634673881, 7.61085279039525], shown: [-1.874926793954646, 2.2482560573486663], spread: [0.4018233110875144, 0.8898423705603394] },
  { score: [0.00026666666824688506, 1.6056028166501586], tokens: [4.430816798843313, 7.460490305825338], shown: [-2.2298704300161543, 1.8244563919418213], spread: [0.4842262831913746, 0.8853121859924141] },
  { score: [1.614004862123296, 8.00603417874912], tokens: [4.382026634673881, 7.487733761436444], shown: [0.4959198380732626, 7.130098510125688], spread: [0.029050071715344638, 0.5926436403475907] },
];

const logit = (x: number): number => {
  const p = Math.min(Math.max(x, 1e-4), 1 - 1e-4);
  return Math.log(p / (1 - p));
};
const clamp = (x: number, [lo, hi]: Range): number => Math.min(Math.max(x, lo), hi);

/**
 * The chance that `result`'s word is right, from its four probabilities and the text
 * tokens the model read (the engine's `tokens` less the two special tokens of each pass).
 */
export function confidence(result: ScoreResult, passes = 1): number {
  const p = result.probs;
  const level = levelOf(result.score);
  const shown = level === 0 ? p[0] : level === 3 ? p[3] : p[1] + p[2];
  const tokensRead = Math.max(0, (result.tokens ?? 0) - 2 * passes);
  const range = RANGES[level];
  const z =
    INTERCEPT +
    LEVEL[level] +
    SCORE[level] * clamp(logit(result.score), range.score) +
    TOKENS * clamp(Math.log(Math.max(1, tokensRead)), range.tokens) +
    SHOWN * clamp(logit(shown), range.shown) +
    SPREAD * clamp(spread(p), range.spread);
  return 1 / (1 + Math.exp(-z));
}

/** A unit's verdict: its aggregate, over the passes that were scored. */
export function verdictConfidence(v: UnitVerdict): number {
  return confidence(v.result, Math.max(1, v.windows.filter(isScoredWindow).length));
}
