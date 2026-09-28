// lib/render/report.ts — rules the copied report follows that are worth stating once.
// The report itself is assembled where the verdicts live (lib/capture/orchestrator.ts).
import type { UnitVerdict } from "../capture/windows";
import { t, tn } from "../i18n";
import { verdictConfidence } from "./confidence";
import { SCORE_CUTS } from "./scale";

/** A page's verdicts as the report counts them. */
export interface ReportCounts {
  /** Units with a real verdict. */
  analyzed: number;
  /** Units the local engine never answered for. */
  unavailable: number;
  /** Units the language gate refused. */
  skipped: number;
  /** Units still waiting for a verdict. */
  pending: number;
}

/** Nearer a cut than this, the word could as well be its neighbour's: one step of the
 *  colour scale (lib/render/scale.ts). */
const NEAR_CUT = 0.05;
/** Below this chance, the word is more likely wrong than right (lib/render/confidence.ts):
 *  a dot less than half full. */
const UNSURE = 0.5;

/**
 * A verdict whose word is a close call: its score sits next to a place where the word
 * changes, or the word is more likely wrong than right. A paragraph with no verdict (not
 * English, the engine never answered) is not one.
 */
export function isCloseCall(v: UnitVerdict): boolean {
  const r = v.result;
  if (r.unsupported || r.degraded) return false;
  return SCORE_CUTS.some((cut) => Math.abs(r.score - cut) < NEAR_CUT) || verdictConfidence(v) < UNSURE;
}

/**
 * The sentence under the report's counts that says what they add up to, where the counts
 * alone would mislead: "Flagged: 0" reads as all clear when nothing was judged at all, and a
 * list of verdicts reads as settled when half of them are close calls. Null when the counts
 * speak for themselves.
 */
export function reportState(c: ReportCounts, closeCalls: number, minWords: number): string | null {
  if (c.analyzed === 0) {
    if (c.pending > 0) return t("reportStatePending");
    if (c.unavailable > 0) return t("reportStateUnavailable");
    if (c.skipped > 0) return t("reportStateNotEnglish");
    return t("reportStateShort", minWords);
  }
  return closeCalls > 0 && closeCalls * 2 >= c.analyzed ? tn("reportStateUncertain", closeCalls, c.analyzed) : null;
}

/**
 * Whether the report may give each flagged paragraph a link that reopens the page at it.
 * A link is the page's address plus words of the paragraph (lib/render/textFragment.ts),
 * so it needs both of the reader's report options on — addresses and passage text — and
 * a page anybody else could open: http or https, not a local file or an extension page.
 */
export function mayLinkParagraphs(o: { includeUrl: boolean; includeText: boolean; pageUrl: string }): boolean {
  if (!o.includeUrl || !o.includeText) return false;
  try {
    return /^https?:$/.test(new URL(o.pageUrl).protocol);
  } catch {
    return false;
  }
}
