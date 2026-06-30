// lib/capture/langGate.ts — local language pre-gate.
//
// EditLens reads English only; the daemon refuses everything else with fastText. That
// refusal costs a round trip per paragraph, so the content script asks the browser's
// built-in detector first (`browser.i18n.detectLanguage`, CLD — no download, ~1 ms) and
// marks a paragraph "unsupported" locally when it is CONFIDENTLY not English. Anything
// uncertain still goes to the daemon, whose fastText verdict stays authoritative. A page
// like a Chinese news site never wakes the model at all.
import { browser } from "#imports";
import type { ScoreResult } from "../contract";
import { BUCKET_COUNT } from "../contract";

/** Share the top language must hold for a local "unsupported" verdict: this much when
 *  the detector calls itself reliable, more when it does not (a few Latin tokens —
 *  "div", "span" — inside a Chinese paragraph make CLD hedge while still saying zh 96%). */
const MIN_SHARE_RELIABLE = 85;
const MIN_SHARE_UNSURE = 90;
/** Any English share at or above this sends the paragraph to the daemon instead. */
const MAX_ENGLISH_SHARE = 10;

interface Detection {
  isReliable: boolean;
  languages: Array<{ language: string; percentage: number }>;
}

/**
 * The detected non-English language of `text`, or null when it is English, unknown,
 * uncertain, or the API is unavailable (→ let the daemon decide).
 */
export async function detectUnsupported(text: string): Promise<{ lang: string; prob: number } | null> {
  try {
    const api = (browser as unknown as { i18n?: { detectLanguage?: (t: string) => Promise<Detection> } }).i18n;
    if (!api?.detectLanguage) return null;
    const d = await api.detectLanguage(text.slice(0, 2000));
    if (!d?.languages?.length) return null;
    const top = d.languages[0];
    if (!top || top.language === "en" || top.language === "und") return null;
    if (top.percentage < (d.isReliable ? MIN_SHARE_RELIABLE : MIN_SHARE_UNSURE)) return null;
    if (d.languages.some((l) => l.language === "en" && l.percentage >= MAX_ENGLISH_SHARE)) return null;
    // "zh-CN" / "zh-TW" → "zh" to match the daemon's ISO 639-1 codes.
    return { lang: top.language.split("-")[0].toLowerCase(), prob: Math.round(top.percentage) / 100 };
  } catch {
    return null;
  }
}

/** A contract-shaped "unsupported language" result produced without the daemon. */
export function unsupportedResult(id: string, lang: string, prob: number): ScoreResult {
  return {
    id,
    bucket: 0,
    probs: new Array<number>(BUCKET_COUNT).fill(1 / BUCKET_COUNT),
    score: 0,
    tokens: 0,
    lang,
    lang_prob: prob,
    unsupported: true,
  };
}
