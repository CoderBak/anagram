// lib/render/flagLevel.ts — the word paragraphs are flagged from (Settings), with nothing else:
// lib/settings/settings.ts reads it in the background worker, which carries no verdict words.

/** The word a paragraph is flagged from, and every word above it. */
export type FlagFrom = "light" | "heavy" | "ai";
/** Heavily edited and AI-generated: the reader chose this over AI-generated alone, which is
 *  the word the model gets right most often ("heavily edited" is right under a third of the
 *  time against the edit-magnitude buckets EditLens is trained on), and the setting says so. */
export const DEFAULT_FLAG_FROM: FlagFrom = "heavy";
const FLAG_LEVEL: Record<FlagFrom, number> = { light: 1, heavy: 2, ai: 3 };

/** The level of the scale (lib/render/scale.ts levelOf) a paragraph is flagged from. */
export function flagLevel(from: FlagFrom): number {
  return FLAG_LEVEL[from] ?? FLAG_LEVEL[DEFAULT_FLAG_FROM];
}

/** What a stored value says, the default where it says something else. */
export function flagFromOf(value: unknown): FlagFrom {
  return value === "light" || value === "heavy" || value === "ai" ? value : DEFAULT_FLAG_FROM;
}
