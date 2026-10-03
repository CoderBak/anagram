// lib/render/confidence.ts — how likely a verdict's word is right.
//
// A small logistic model of the chance that the word shown (Human / Lightly edited /
// Heavily edited / AI-generated, from the score's cuts) names the edit-magnitude bucket
// EditLens was trained to predict (the official score_to_bucket of the cosine score). It
// was fitted on the EditLens validation split only — full texts, 75/100/150-word prefixes
// and long texts read in passes, each read as the extension reads it (modelText, passes,
// unitVerdict) — and chosen by grouped cross-validation on that split together with a
// held-out half of the out-of-domain Enron set. Its calibration error on the test, Enron
// and Llama sets is 0.044 / 0.037 / 0.041.
//
// What it says still depends on the mix of human and AI text a page holds, which nothing
// here can know, so it is never shown as a number: under one half the card says "Unsure"
// and names the neighbouring word (unsureNote in dist.ts). On two sets the fitting never saw — news articles and
// learners' essays, each wholly human or wholly AI-generated — a verdict rated 0.9 or
// more was right 99.6–100% of the time, but the two middle words, which no text there
// could earn, were still rated 0.3–0.5 on average: the chance they have on EditLens's mix.
import type { ScoreResult } from "../contract";
import { isScoredWindow, type UnitVerdict } from "../capture/windows";
import { levelOf, spread } from "./scale";

const INTERCEPT = 0.39604529574629543;
/** Per level (human, lightly, heavily, AI): the level's own offset … */
const LEVEL = [0, -0.3041899230185732, -0.8430515498859256, -0.49279492129463337];
/** … and its slope on logit(score). */
const SCORE = [-0.29204303263171155, 0.4170929568122539, -0.15785272051282226, 0.04341040130161003];
/** Shared slopes: ln(tokens read), logit(probability on the shown category), spread. */
const TOKENS = 0.19895368771235053;
const SHOWN = 0.16876597318770153;
const SPREAD = -2.032751610589588;

type Range = readonly [number, number];
/** Per level, the range each input took in the fitting data; inputs are held inside it. */
const RANGES: ReadonlyArray<{ score: Range; tokens: Range; shown: Range; spread: Range }> = [
  { score: [-5.066224313171635, -1.6115994695962763], tokens: [4.330733340286331, 7.6511201757027], shown: [0.3301982077272004, 4.157867957904519], spread: [0.1079897114440898, 0.5779440918750994] },
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
 * SHORT TEXTS. The model above was fitted on texts of 75 words or more — some 100 text tokens
 * (70 to 80-word EditLens texts read 96 at the median) — and holds its length input inside the
 * range it saw, so a 30-word text got the dot of a 75-word one: on the EditLens test split the
 * dots of 25–49-word texts were 0.044 fuller on average than their word was right (0.021 at 50–74
 * words). Under 100 tokens the dot therefore falls with the length, by this slope per unit of
 * ln(tokens), fitted on EditLens val prefixes of 25 to 74 words and taken at the 95th percentile
 * of 200 bootstrap fits, so that it errs towards doubt: on the test split the gap is 0.001 at
 * 25–49 words and 0.009 at 50–74, and nothing of 100 tokens or more changes.
 */
const SHORT_TOKENS = 100;
const SHORT_SLOPE = 0.37;

/** The fitted model's log-odds that `result`'s word is right. */
function fittedLogit(result: ScoreResult, tokensRead: number): number {
  const p = result.probs;
  const level = levelOf(result.score);
  const shown = level === 0 ? p[0]! : level === 3 ? p[3]! : p[1]! + p[2]!;
  const range = RANGES[level]!;
  return (
    INTERCEPT +
    LEVEL[level]! +
    SCORE[level]! * clamp(logit(result.score), range.score) +
    TOKENS * clamp(Math.log(Math.max(1, tokensRead)), range.tokens) +
    SHOWN * clamp(logit(shown), range.shown) +
    SPREAD * clamp(spread(p), range.spread)
  );
}

const tokensReadOf = (result: ScoreResult, passes: number): number => Math.max(0, (result.tokens ?? 0) - 2 * passes);

/** The fitted model alone, without the short-text slope (what the fitting script computed). */
export function fittedConfidence(result: ScoreResult, passes = 1): number {
  return 1 / (1 + Math.exp(-fittedLogit(result, tokensReadOf(result, passes))));
}

/**
 * The chance that `result`'s word is right, from its four probabilities and the text
 * tokens the model read (the engine's `tokens` less the two special tokens of each pass),
 * lower for a text under the model's training minimum (SHORT TEXTS).
 */
export function confidence(result: ScoreResult, passes = 1): number {
  const tokensRead = tokensReadOf(result, passes);
  const short = SHORT_SLOPE * Math.min(0, Math.log(Math.max(1, tokensRead)) - Math.log(SHORT_TOKENS));
  return 1 / (1 + Math.exp(-(fittedLogit(result, tokensRead) + short)));
}

/** A unit's verdict: its aggregate, over the passes that were scored. */
export function verdictConfidence(v: UnitVerdict): number {
  return confidence(v.result, Math.max(1, v.windows.filter(isScoredWindow).length));
}
