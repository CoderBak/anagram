// The score is the normalized expected class index: (p1 + 2*p2 + 3*p3) / 3.
// It is neither a measured edit distance nor a calibrated probability of AI authorship.
// Render without a percent sign; the four-class distribution remains available separately.

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
