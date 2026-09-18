// lib/render/coverage.ts — how a text was READ, in the words the hover card, the
// selection card and the copied report share. A unit that went through the model in one
// pass has nothing to add here; everything below is about the long ones.
import { isScoredWindow, type UnitVerdict } from "../capture/windows";
import { scorePct } from "./band";

export interface WindowReadout {
  /** Windows the text was read in (2 or more). */
  count: number;
  /** Each window's own number ("41%"), in reading order; a window the language gate
   *  refused shows its language code instead. */
  pcts: string[];
  /** Windows the language gate refused: not scored, not in the aggregate, not marked. */
  skipped: number;
  /** Windows the daemon still had to cut after the re-read in halves: part of their text
   *  never reached the model. */
  cutShort: number;
}

/** The readout for a unit read in several windows; null when one pass covered it. */
export function windowReadout(v: UnitVerdict): WindowReadout | null {
  if (v.windows.length < 2) return null;
  return {
    count: v.windows.length,
    pcts: v.windows.map((w) => (isScoredWindow(w) ? `${scorePct(w.result)}%` : (w.result.lang ?? "n/a"))),
    skipped: v.windows.filter((w) => w.result.unsupported).length,
    cutShort: v.windows.filter((w) => isScoredWindow(w) && w.result.truncated).length,
  };
}

/** A card's "Scored in N windows" value: "41% · 72% · 18%". Up to eight numbers may wrap,
 *  and the no-break space keeps each separator with the number in front of it. */
export function windowPcts(read: WindowReadout): string {
  return read.pcts.join("\u00a0· ");
}

/**
 * The sentences that go in front of a card's footer when the number needs explaining:
 * it is an average over windows, and whatever was NOT read is said here, in words.
 */
export function coverageNote(v: UnitVerdict, what: "paragraph" | "selection"): string {
  const read = windowReadout(v);
  return (
    (v.unreadChars > 0 ? `Only the opening of this ${what} was scored. ` : "") +
    (read && read.cutShort > 0
      ? "Part of it is too dense for the model's window and was not read. "
      : "") +
    (read && read.skipped > 0 ? "Windows in another language were left out. " : "") +
    (read
      ? `Longer than the model reads in one pass, so it was read in ${read.count} consecutive windows ` +
        "and their results were averaged by length. "
      : "")
  );
}
