// lib/render/score.ts — the one place a score becomes text.
//
// EditLens answers on 0–1: how far a text sits from untouched human writing toward fully
// AI-generated. That is an EXTENT of editing — an edit distance from a human original —
// and writing it "63%" made every surface of the product read as "63 % sure this is AI",
// which is the one thing the number does not say. So it is written the way a correlation
// or a batting average is: two decimals, no leading zero, no percent sign. ".93".
//
// The top of the scale is the exception: ".100" is not a number and "1.00" claims a
// precision the rounding has not got, so a score that rounds to one reads "1.0".
//
// Numbers that really ARE probabilities — the four-bucket distribution in the card, the
// language gate's confidence — keep their "%" and never come through here.

/** Anything outside 0–1 (and NaN) is a bug upstream; paint something rather than "NaN". */
function clamp(score: number): number {
  return Number.isFinite(score) ? Math.min(Math.max(score, 0), 1) : 0;
}

/** ".00" … ".99", and "1.0" at the top. Hosts set tabular figures so chips do not jitter. */
export function formatScore(score: number): string {
  const hundredths = Math.round(clamp(score) * 100);
  if (hundredths >= 100) return "1.0";
  return `.${String(hundredths).padStart(2, "0")}`;
}

/**
 * The same number for a screen reader. ".93" is announced as "point nine three" by some
 * and as "ninety-three" by others, so anything SPOKEN — an aria-label, a live region —
 * says the leading zero out loud. Never used for anything drawn.
 */
export function spokenScore(score: number): string {
  const text = formatScore(score);
  return text.startsWith(".") ? `0${text}` : text;
}
