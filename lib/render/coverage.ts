// lib/render/coverage.ts — how a text was READ, in the words the hover card, the
// selection card and the copied report share. A unit that went through the model in one
// pass has nothing to add here; everything below is about the long ones.
import { isScoredWindow, type UnitVerdict } from "../capture/windows";
import { hasLookalikes } from "../dom/lookalikes";
import { isShortText, MODEL_MIN_WORDS } from "../dom/text";
import { t } from "../i18n";
import { formatScore } from "./score";

/**
 * The line a verdict on a short text carries, or "": a text under the model's training
 * minimum (MODEL_MIN_WORDS) is read only because the minimum length (MIN_WORDS) allows it, and
 * its verdict is less reliable. The hover card, the selection card, the report and the text
 * analysis page all say it the same way.
 */
export function shortTextNote(words: number): string {
  return isShortText(words) ? t("coverageShort", MODEL_MIN_WORDS) : "";
}

export interface WindowReadout {
  /** Passes the text was read in (2 or more). */
  count: number;
  /** Each pass's own number (".41"), in reading order; a pass the language gate
   *  refused shows its language code instead. */
  scores: string[];
  /** Passes the language gate refused: not scored, not in the aggregate, not marked. */
  skipped: number;
  /** Passes the engine still had to cut after the re-read in halves: part of their text
   *  never reached the model. */
  cutShort: number;
}

/** The readout for a unit read in several passes; null when one pass covered it. */
export function windowReadout(v: UnitVerdict): WindowReadout | null {
  if (v.windows.length < 2) return null;
  return {
    count: v.windows.length,
    scores: v.windows.map((w) => (isScoredWindow(w) ? formatScore(w.result.score) : (w.result.lang ?? "n/a"))),
    skipped: v.windows.filter((w) => w.result.unsupported).length,
    cutShort: v.windows.filter((w) => isScoredWindow(w) && w.result.truncated).length,
  };
}

/** A card's "Read in N passes" value: ".41, .72, .18". Up to eight numbers may wrap. */
export function windowScores(read: WindowReadout): string {
  return read.scores.join(", ");
}

/**
 * The sentences that go in front of a card's footer when the number needs explaining:
 * the text was read with look-alike letters replaced, it combines several passes, and
 * whatever was NOT read is said here, in words.
 */
export function coverageNote(v: UnitVerdict, what: "paragraph" | "selection", text: string): string {
  const read = windowReadout(v);
  return (
    (hasLookalikes(text) ? t("coverageLookalikes") : "") +
    (v.unreadChars > 0
      ? t(what === "selection" ? "coverageOpeningSelection" : "coverageOpeningParagraph")
      : "") +
    (read && read.cutShort > 0 ? t("coverageTooDense") : "") +
    (read && read.skipped > 0 ? t("coverageOtherLanguages") : "") +
    (read ? t("coverageAveraged", read.count) : "")
  );
}
