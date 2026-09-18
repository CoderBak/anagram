// lib/capture/windows.ts — reading a long text completely, in windows.
//
// EditLens reads 512 tokens and the daemon cuts whatever is longer, so a long paragraph
// used to be judged by its opening alone while the chip and the underline spoke for all
// of it. A text that does not fit one pass is now cut at sentence boundaries — a unit of
// several paragraphs between two of them, where it can be — into
// consecutive, non-overlapping WINDOWS, each scored as a block of its own through the
// ordinary pipeline (same wire contract; the canonical form of each window is what gets
// deduplicated and cached). The chip states ONE aggregate for the unit; the marks are per
// window. The overwhelming majority of paragraphs fit one window and take the first
// `return` of planWindows(): same request text, same cache key, same card as before.
//
// Order of operations: the unit's OWN collapsed text is cut first and each window is
// canonicalized afterwards. The other way round (canonicalize, then cut) left cut
// positions that could not be mapped back to the DOM, because canonicalization drops and
// rewrites characters.
//
// This file is pure text and arithmetic — no DOM — so the vitest suite can drive it. The
// mapping of a window back to text nodes lives in lib/dom/locate.ts.
import type { ScoreBlock, ScoreResult } from "../contract";
import { BUCKET_COUNT } from "../contract";
import { canonicalForScoring, sentenceStarts } from "../dom/text";

// ---- the budget ---------------------------------------------------------------------

/**
 * Most characters of a text that go into ONE window. The model takes 512 tokens, 510 of
 * them text. Measured with the model's own tokenizer (the roberta BPE in its
 * tokenizer.json): ordinary English prose runs at 4.3–5.0 characters per token; technical
 * prose — 419 paragraphs from the READMEs of this repo's dependencies, full of
 * identifiers, flags and version numbers — at a median of 4.17 with a 10th percentile of
 * 3.46; number-heavy sentences ("lr=2e-5, 88.1 macro-F1, n=12,480") at about 2.7.
 * 1800 characters are ~400 tokens of ordinary prose and stay inside the window down to
 * 3.53 characters per token, which holds for roughly nine of those technical paragraphs
 * in ten even when a window is FULL — and balanced windows rarely are. At 2000 a third
 * of them would overflow. At 1600 one in twenty still would, while ordinary
 * 1700-character paragraphs, which the model reads whole today, would be cut in two.
 * Text denser than the budget assumes comes back `truncated` and is re-read in halves
 * (readInWindows), so the budget decides how often that second trip happens, not
 * whether the text gets read.
 */
export const WINDOW_CHARS = 1800;

/**
 * No window shorter than this: ~130 tokens, about a hundred words, twice the evidence
 * floor a unit needs to be scored at all. Cuts are BALANCED — the window count is fixed
 * first and the text divided evenly — so a short remainder is never produced and then
 * folded back; this bound only limits how far a cut may drift from the even split in
 * search of a sentence end.
 */
export const MIN_WINDOW_CHARS = 600;

/**
 * Most windows read per text: 14 400 characters, some 2 300 words. A single "paragraph"
 * beyond that is a text dump (a transcript in one <div>, a licence, a minified page),
 * the aggregate over 2 300 words no longer moves with more, and each further window is
 * another forward pass (up to about 120 ms each on our M4 benchmark). What lies past the
 * last window is reported as not read and gets no mark.
 */
export const MAX_WINDOWS = 8;

/** Most characters of one text that are ever sent — the scheduler's cost of a unit. */
export const MAX_READ_CHARS = MAX_WINDOWS * WINDOW_CHARS;

/**
 * Hard bound on one block's text on the wire. NFKC can EXPAND text ("…" → "...",
 * "½" → "1⁄2", Arabic presentation forms up to 18×), so a window of 1800 page
 * characters has no fixed canonical length, while the daemon refuses any block over
 * 16 000 characters — and a refused block fails the whole request, its neighbours
 * included. Nothing that reaches this bound is prose, and 4000 characters cannot fit 512
 * tokens anyway, so whatever is cut here also comes back `truncated` and is disclosed.
 */
export const MAX_BLOCK_CHARS = 4000;

// ---- planning -----------------------------------------------------------------------

/** A stretch of a text: offsets into the string, end exclusive. */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * How far from its even share a cut may move to fall BETWEEN two paragraphs instead of
 * between two sentences of one. A text of several paragraphs — a selection across a page,
 * a merged unit the walker could not keep inside one window (lib/dom/walker.ts divides a
 * stretch of short paragraphs into window-sized groups, so that is the exception) — has
 * paragraphs of two or three sentences each: the nearest sentence end is usually in the
 * middle of one, which then closed one window, opened the next and was underlined in two
 * bands. Short paragraphs are under fifty words, so a joint is rarely further than this.
 */
const JOINT_REACH_CHARS = MIN_WINDOW_CHARS / 2;

/** The cut nearest to `ideal` inside [lo, hi]: the joint between two parts of a merged
 *  unit if one is within reach, else a sentence start, else a word start, else the ideal
 *  itself (one enormous "sentence" without a space). */
function pickCut(text: string, starts: number[], ideal: number, lo: number, hi: number): number {
  let best = -1;
  let joint = -1;
  const nearer = (s: number, than: number): boolean => than < 0 || Math.abs(s - ideal) < Math.abs(than - ideal);
  for (const s of starts) {
    if (s < lo) continue;
    if (s > hi) break;
    if (nearer(s, best)) best = s;
    if (Math.abs(s - ideal) <= JOINT_REACH_CHARS && text.startsWith("\n\n", s - 2) && nearer(s, joint)) joint = s;
  }
  if (joint >= 0) return joint;
  if (best >= 0) return best;
  const mid = Math.min(hi, Math.max(lo, Math.round(ideal)));
  for (let d = 0; mid - d >= lo || mid + d <= hi; d++) {
    for (const at of [mid - d, mid + d]) {
      if (at >= lo && at <= hi && /\s/.test(text[at - 1]) && /\S/.test(text[at])) return at;
    }
  }
  // Never between the two halves of a surrogate pair.
  const low = text.charCodeAt(mid);
  return low >= 0xdc00 && low <= 0xdfff && mid > lo ? mid - 1 : mid;
}

/**
 * Cut [start, end) into `n` consecutive spans of `min`…`max` characters, as even as the
 * sentence ends allow. Each cut aims at an even share of what is LEFT, so one early or
 * late sentence end does not push the error onto the last window, and its range keeps
 * the remainder cuttable into the windows still to come.
 */
function balance(
  text: string,
  starts: number[],
  start: number,
  end: number,
  n: number,
  min: number,
  max: number,
): TextSpan[] {
  const spans: TextSpan[] = [];
  let prev = start;
  for (let left = n - 1; left > 0; left--) {
    const ideal = prev + (end - prev) / (left + 1);
    const lo = Math.max(prev + min, end - left * max);
    const hi = Math.min(prev + max, end - left * min);
    const cut = pickCut(text, starts, ideal, lo, hi);
    spans.push({ start: prev, end: cut });
    prev = cut;
  }
  spans.push({ start: prev, end });
  return spans;
}

/**
 * The windows a text is read in. One window covering everything when it fits — the
 * common case, which costs a length comparison. Otherwise ceil(length / WINDOW_CHARS)
 * balanced windows; past MAX_WINDOWS the text is read up to the last sentence end inside
 * the cap and the rest is left out (the last span then ends before the text does).
 */
export function planWindows(text: string): TextSpan[] {
  if (text.length <= WINDOW_CHARS) return [{ start: 0, end: text.length }];
  // A selection can be a whole page; sentences are only looked for in what can be read.
  const capped = text.length > MAX_READ_CHARS;
  const starts = sentenceStarts(capped ? text.slice(0, MAX_READ_CHARS) : text);
  const end = capped
    ? pickCut(text, starts, MAX_READ_CHARS, MAX_READ_CHARS - WINDOW_CHARS + MIN_WINDOW_CHARS, MAX_READ_CHARS)
    : text.length;
  return balance(text, starts, 0, end, Math.ceil(end / WINDOW_CHARS), MIN_WINDOW_CHARS, WINDOW_CHARS);
}

/**
 * A window the daemon had to cut, split once more into two halves. It held more than 510
 * tokens, so each half is ample evidence whatever its length in characters; the cut only
 * has to stay out of the outer quarters.
 */
export function halve(text: string, span: TextSpan): [TextSpan, TextSpan] {
  const quarter = Math.max(1, Math.floor((span.end - span.start) / 4));
  const starts = sentenceStarts(text.slice(span.start, span.end)).map((s) => s + span.start);
  const [a, b] = balance(text, starts, span.start, span.end, 2, quarter, span.end - span.start - quarter);
  return [a, b];
}

/** What is SENT for a stretch of text: its canonical form (which is also its cache key). */
export function blockText(text: string, span: TextSpan): string {
  const canonical = canonicalForScoring(text.slice(span.start, span.end));
  if (canonical.length <= MAX_BLOCK_CHARS) return canonical;
  // Not through the middle of a surrogate pair: half of one cannot be encoded as UTF-8.
  const last = canonical.charCodeAt(MAX_BLOCK_CHARS - 1);
  return canonical.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_BLOCK_CHARS - 1 : MAX_BLOCK_CHARS);
}

// ---- verdicts -----------------------------------------------------------------------

/** One window as the model read it. */
export interface WindowVerdict extends TextSpan {
  /** The wire result for this window's text, untouched. */
  result: ScoreResult;
}

/**
 * What the UI knows about one unit (or one selection). `ScoreResult` is the WIRE type —
 * one block in, one result out — and stays that way; everything a unit needs beyond it
 * lives here.
 */
export interface UnitVerdict {
  /** The unit's id. */
  id: string;
  /**
   * The ONE verdict the chip, the flagged state, the panel, the toolbar count and the
   * report follow, in wire shape so band()/scorePct()/the distribution readout take it
   * as they take any result. For a one-window unit it is the daemon's result itself.
   */
  result: ScoreResult;
  /** The windows that were read, in text order — exactly one for nearly every unit. */
  windows: WindowVerdict[];
  /** Characters at the end of the text that no window covers (the MAX_WINDOWS cap). */
  unreadChars: number;
}

/** Was this window actually scored? Not when the daemon failed or the language gate refused it. */
export function isScoredWindow(w: WindowVerdict): boolean {
  return !w.result.degraded && !w.result.unsupported;
}

/**
 * One verdict from a unit's windows: the length-weighted mean of their probability
 * vectors, bucket = argmax of that mean, score = Σ p̄ᵢ·i/3. The mean is linear, so the
 * chip's number is also the length-weighted mean of the windows' numbers and the bar,
 * the rows and the label all describe the same vector.
 *
 * Rejected: the MAXIMUM window ("the worst part decides") grows with length by itself —
 * under any per-window false-positive rate α a human text of n windows is flagged with
 * probability 1−(1−α)ⁿ, so long paragraphs would turn red for being long, and the number
 * would stop being comparable with a short paragraph's. The MAJORITY bucket throws the
 * probabilities away (a 51/49 window votes like a 99/1 one), ignores length, and is a tie
 * in the commonest case there is — two windows that disagree. A paragraph that turns
 * from human to AI halfway lands in a middle bucket under the mean, which is what
 * EditLens's own scale calls a text of mixed origin; WHERE it turns is what the
 * per-window marks and the card's window row are for.
 *
 * - Any window DEGRADED → the unit is Unavailable. A failure is transient: a partial
 *   verdict would change under the reader once the retry lands.
 * - Windows the language gate refused are permanent facts about those sentences: they
 *   are left out of the mean and of the marks, and the card says so. All refused → the
 *   unit is "Unsupported language".
 */
export function unitVerdict(id: string, textLength: number, windows: WindowVerdict[]): UnitVerdict {
  const unreadChars = Math.max(0, textLength - (windows[windows.length - 1]?.end ?? 0));
  const done = (result: ScoreResult): UnitVerdict => ({ id, result, windows, unreadChars });

  if (windows.length === 1) return done({ ...windows[0].result, id });
  if (windows.length === 0 || windows.some((w) => w.result.degraded)) {
    return done({ id, bucket: 0, probs: new Array<number>(BUCKET_COUNT).fill(1 / BUCKET_COUNT), score: 0, degraded: true });
  }
  const scored = windows.filter(isScoredWindow);
  if (scored.length === 0) {
    const longest = windows.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    return done({ ...longest.result, id });
  }

  const probs = new Array<number>(BUCKET_COUNT).fill(0);
  let weight = 0;
  for (const w of scored) {
    const len = w.end - w.start;
    weight += len;
    for (let i = 0; i < BUCKET_COUNT; i++) probs[i] += (w.result.probs[i] ?? 0) * len;
  }
  for (let i = 0; i < BUCKET_COUNT; i++) probs[i] /= weight;
  let bucket = 0;
  for (let i = 1; i < BUCKET_COUNT; i++) if (probs[i] > probs[bucket]) bucket = i;
  const score = probs.reduce((acc, p, i) => acc + p * i, 0) / (BUCKET_COUNT - 1);

  const result: ScoreResult = { id, bucket, probs, score };
  if (scored.every((w) => typeof w.result.tokens === "number")) {
    result.tokens = scored.reduce((n, w) => n + (w.result.tokens ?? 0), 0);
  }
  if (scored.some((w) => w.result.truncated)) result.truncated = true;
  return done(result);
}

// ---- reading ------------------------------------------------------------------------

/** Anything that can be read in windows: a unit, or a selection. */
export interface Readable {
  id: string;
  text: string;
  order: number;
}

/**
 * Scores blocks and answers by block id; a block it has no answer for is simply missing.
 * `owners` names the Readable each block belongs to (the orchestrator shows that unit's
 * "analyzing…" chip when real work starts).
 */
export type ScoreBlocks = (
  blocks: ScoreBlock[],
  owners: ReadonlyMap<string, string>,
) => Promise<Map<string, ScoreResult>>;

interface Slot {
  owner: Readable;
  span: TextSpan;
  block: ScoreBlock;
}

function slotsFor(owner: Readable, spans: TextSpan[], whole: boolean): Slot[] {
  return spans.map((span) => ({
    owner,
    span,
    block: {
      // A text that fits one window travels under its own id, exactly as it always has.
      id: whole ? owner.id : `${owner.id}:${span.start}-${span.end}`,
      text: blockText(owner.text, span),
      order: owner.order,
    },
  }));
}

async function ask(slots: Slot[], scoreBlocks: ScoreBlocks): Promise<Map<string, ScoreResult>> {
  const owners = new Map(slots.map((s) => [s.block.id, s.owner.id] as const));
  return scoreBlocks(slots.map((s) => s.block), owners);
}

/**
 * Read every item completely: plan its windows, score them all in ONE call (a unit's
 * windows travel together and come back together), then re-read in halves, once, any
 * window the daemon reports it had to cut — text denser than WINDOW_CHARS assumes
 * (digits, URLs, names). A half that is STILL cut stays `truncated`; the card says that
 * part of the text was not read, so there is no silent gap.
 *
 * Atomic per item: the map holds an entry only for items whose EVERY window was
 * answered. Nothing unit-level is cached anywhere — `scoreBlocks` caches per window
 * text, so after a partial failure the windows that did come back are hits on the retry
 * and only the missing one is asked for again.
 */
export async function readInWindows(
  items: Readable[],
  scoreBlocks: ScoreBlocks,
): Promise<Map<string, WindowVerdict[]>> {
  let slots: Slot[] = [];
  for (const item of items) {
    const spans = planWindows(item.text);
    slots.push(...slotsFor(item, spans, spans.length === 1 && spans[0].end === item.text.length));
  }
  const answers = await ask(slots, scoreBlocks);

  const cut = (s: Slot): boolean => {
    const r = answers.get(s.block.id);
    return !!r && !!r.truncated && !r.degraded && !r.unsupported && s.span.end - s.span.start >= 2;
  };
  if (slots.some(cut)) {
    const halves: Slot[] = [];
    slots = slots.flatMap((s) => {
      if (!cut(s)) return [s];
      const pair = slotsFor(s.owner, halve(s.owner.text, s.span), false);
      halves.push(...pair);
      return pair;
    });
    for (const [id, r] of await ask(halves, scoreBlocks)) answers.set(id, r);
  }

  const out = new Map<string, WindowVerdict[]>();
  const incomplete = new Set<string>();
  for (const s of slots) {
    const result = answers.get(s.block.id);
    if (!result) {
      incomplete.add(s.owner.id);
      continue;
    }
    let windows = out.get(s.owner.id);
    if (!windows) out.set(s.owner.id, (windows = []));
    windows.push({ start: s.span.start, end: s.span.end, result });
  }
  for (const id of incomplete) out.delete(id);
  return out;
}
