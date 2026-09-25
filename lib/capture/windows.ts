// lib/capture/windows.ts — reading a long text completely, in overlapping passes.
//
// EditLens reads 512 tokens and the engine cuts whatever is longer, so a long paragraph
// used to be judged by its opening alone while the chip and the underline spoke for all
// of it. A text that does not fit one pass is cut into small PIECES (paragraph joints,
// sentence starts, then clause marks, spaces, and at worst a hard cut), the engine says
// how many tokens each piece is, and the text is read in PASSES as full as the model
// allows — 510 tokens — that overlap, so every word past the first half pass is read
// twice and no one cut decides the verdict. Each pass is scored as a block of its own
// through the ordinary pipeline (same wire contract; the canonical form of each pass is
// what gets deduplicated and cached), and each stretch of text takes the passes that read
// it, weighted towards the ones that read it with context on both sides. The chip states
// ONE aggregate for the unit; the marks follow the stretches. The overwhelming majority of
// paragraphs fit one pass: same request text, same cache key, same card as before.
//
// Order of operations: the unit's OWN collapsed text is cut first and each pass is
// canonicalized afterwards. The other way round (canonicalize, then cut) left cut
// positions that could not be mapped back to the DOM, because canonicalization drops and
// rewrites characters.
//
// This file is pure text and arithmetic — no DOM — so the vitest suite can drive it. The
// mapping of a stretch back to text nodes lives in lib/dom/locate.ts.
import type { ScoreBlock, ScoreResult } from "../contract";
import { BUCKET_COUNT } from "../contract";
import { canonicalForScoring, sentenceStarts } from "../dom/text";

// ---- the budget ---------------------------------------------------------------------

/**
 * About one pass of text in characters: what the walker gathers short paragraphs into one
 * unit by (lib/plan/group.ts), so a run of them is read together in one pass. The model
 * takes 512 tokens, 510 of them text. Measured with the model's own tokenizer (the roberta
 * BPE in its tokenizer.json): ordinary English prose runs at 4.3–5.0 characters per token;
 * technical prose — 419 paragraphs from the READMEs of this repo's dependencies, full of
 * identifiers, flags and version numbers — at a median of 4.17 with a 10th percentile of
 * 3.46; number-heavy sentences ("lr=2e-5, 88.1 macro-F1, n=12,480") at about 2.7. 1800
 * characters are ~400 tokens of ordinary prose and stay inside one pass down to 3.53
 * characters per token. A group that does not is read in passes like any long text.
 */
export const WINDOW_CHARS = 1800;

/** Text tokens the model reads in one pass: 512 less its two special tokens. */
export const PASS_TOKENS = 510;

/** Tokens a planned pass leaves free. Pieces are counted one by one, and the same words
 *  can come out a token apart at the seam where two pieces meet inside one pass. */
const PASS_MARGIN = 8;

/**
 * A text this short is read in one pass without asking how many tokens it has: the densest
 * English the model is given — numbers, identifiers — runs above 2.4 characters a token,
 * and 1200 characters of it stay inside one pass. Nearly every paragraph is this short.
 */
export const ONE_PASS_CHARS = 1200;

/** What a piece is taken to hold when the engine cannot count (one older than the count,
 *  or not answering): 3.5 characters a token, which technical prose runs near. */
const ESTIMATE_CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATE_CHARS_PER_TOKEN);
}

/** The longest piece a stretch with no better place to cut is divided into. */
export const MAX_PIECE_CHARS = 300;

/**
 * Most characters of one text that are ever read, and the scheduler's cost of a unit:
 * enough for the longest text a unit may hold (MAX_UNIT_TEXT_CHARS in lib/dom/text.ts —
 * 200 000 characters, some 32 000 words), so a paragraph found on a page is always read
 * to its end. What remains is only the bound a selection can still reach — a whole page
 * selected at once — and what lies past it is reported as not read and gets no mark.
 */
export const MAX_READ_CHARS = 201_600;

/**
 * Most passes read per text: MAX_READ_CHARS of the densest text, at 2.5 characters a
 * token, in passes half a pass apart. A forward pass is around a tenth of a second on the
 * hardware this runs on. The passes of a long text never travel as one request
 * (requestSlices).
 */
export const MAX_WINDOWS = 320;

/**
 * Hard bound on one block's text on the wire. NFKC can EXPAND text ("…" → "...",
 * "½" → "1⁄2", Arabic presentation forms up to 18×), so a pass of page characters has no
 * fixed canonical length, while the engine refuses any block over 16 000 characters — and
 * a refused block fails the whole request, its neighbours included. A pass planned on
 * counts holds 510 tokens of the canonical text, which reaches 4000 characters only at
 * eight characters a token, and no prose does: nothing that reaches this bound is prose.
 */
export const MAX_BLOCK_CHARS = 4000;

/**
 * Most blocks and characters one scoring request carries. The worker refuses a request of
 * more than 256 blocks or 256 000 characters whole (lib/access/messages.ts), and answers
 * Unavailable past 256 blocks or 250 000 characters of one page's at a time
 * (lib/backend/router.ts). One unit can pass all of that alone: MAX_WINDOWS windows, each
 * up to MAX_BLOCK_CHARS once NFKC has expanded it, and twice as many halves when the daemon
 * cuts them. So what a batch sends goes in requests of this size, one after another, and
 * the four batches the orchestrator keeps in flight stay inside the page's share together.
 * At six bytes a character, the most JSON takes to escape one, a request also stays under
 * the worker's 900 000 encoded bytes.
 */
export const REQUEST_BLOCKS = 64;
export const REQUEST_CHARS = 48_000;

/** `items` in consecutive requests of at most REQUEST_BLOCKS blocks and REQUEST_CHARS
 *  characters; nearly every batch is one. */
export function requestSlices<T>(items: readonly T[], chars: (item: T) => number): T[][] {
  const out: T[][] = [];
  let slice: T[] = [];
  let size = 0;
  for (const item of items) {
    const n = chars(item);
    if (slice.length > 0 && (slice.length >= REQUEST_BLOCKS || size + n > REQUEST_CHARS)) {
      out.push(slice);
      slice = [];
      size = 0;
    }
    slice.push(item);
    size += n;
  }
  if (slice.length > 0) out.push(slice);
  return out;
}

/** A block the daemon gave no verdict for: Unavailable, and never cached. */
export function unavailableResult(id: string): ScoreResult {
  return { id, bucket: 0, probs: new Array<number>(BUCKET_COUNT).fill(1 / BUCKET_COUNT), score: 0, degraded: true };
}

// ---- planning -----------------------------------------------------------------------

/** A stretch of a text: offsets into the string, end exclusive. */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * How far from the middle the cut of a pass read again in halves may move to fall BETWEEN
 * two paragraphs instead of between two sentences of one, so that no paragraph is split
 * across the halves when a joint is near. Short paragraphs are under fifty words, so a
 * joint is rarely further than this.
 */
const JOINT_REACH_CHARS = 300;

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

/** How much of a text is read: all of it, or up to the last sentence end inside
 *  MAX_READ_CHARS (a whole page selected at once). */
export function readEnd(text: string): number {
  if (text.length <= MAX_READ_CHARS) return text.length;
  const starts = sentenceStarts(text.slice(0, MAX_READ_CHARS));
  return pickCut(text, starts, MAX_READ_CHARS, MAX_READ_CHARS - WINDOW_CHARS, MAX_READ_CHARS);
}

/**
 * Cut [0, end) into consecutive PIECES — the places a pass may begin or end. Paragraph
 * joints and sentence starts first (sentenceStarts); a stretch still longer than
 * MAX_PIECE_CHARS is cut again after the last clause mark followed by a space, or before
 * the last word inside it, and a run with neither (a URL, base64, a run of CJK without
 * marks) at MAX_PIECE_CHARS itself, never between the halves of a surrogate pair. A piece
 * is only a place a pass MAY cut: nothing depends on a sentence having been found, and
 * every character belongs to exactly one piece.
 */
export function cutPieces(text: string, end = text.length): TextSpan[] {
  const bounds = [0, ...sentenceStarts(text.slice(0, end)).filter((at) => at > 0 && at < end), end];
  const out: TextSpan[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    let start = bounds[i];
    const stop = bounds[i + 1];
    while (stop - start > MAX_PIECE_CHARS) {
      const cut = softCut(text, start, start + MAX_PIECE_CHARS);
      out.push({ start, end: cut });
      start = cut;
    }
    if (stop > start) out.push({ start, end: stop });
  }
  return out;
}

/** A clause ends at one of these (Latin and CJK), and the next piece starts after it. */
const CLAUSE_MARK = /[,;:，；：、—–)\]»"'”’]/;

/** Where a stretch too long for one piece is cut, inside (start + a third, limit]: after
 *  the last clause mark followed by a space, else before the last word, else at limit. */
function softCut(text: string, start: number, limit: number): number {
  const floor = start + Math.floor(MAX_PIECE_CHARS / 3);
  let word = -1;
  for (let at = limit; at > floor; at--) {
    if (!/\s/.test(text[at - 1]) || /\s/.test(text[at])) continue;
    if (CLAUSE_MARK.test(text[at - 2] ?? "")) return at;
    if (word < 0) word = at;
  }
  if (word > 0) return word;
  const low = text.charCodeAt(limit);
  return low >= 0xdc00 && low <= 0xdfff ? limit - 1 : limit;
}

/**
 * The passes pieces holding `tokens` each are read in: [start, end) character spans, each
 * as full as `limit` allows, overlapping, and never cut inside a piece. Pieces within the
 * limit together are one pass. Otherwise the starts are aimed an even share of the way
 * from the first to the last — n = 1 + ⌈(N − L) / (L / 2)⌉ passes, half a pass apart at
 * most, give or take a piece — so nearly every token past the first half pass is read at
 * least twice. Each start is the piece boundary nearest its aim that is past the start
 * before it, no later than the end before it, and late enough to reach past that end —
 * progress, no gap, and no pass inside another — and each pass then takes pieces while
 * they fit. The last pass is anchored at the end, as full as it can be, when it is the one
 * planned next or starts no more than half a pass on, so a start snapped short of its aim
 * does not cost a pass. A piece larger than the limit on its own is a pass by itself; the
 * engine reads its opening and says so, and readInWindows reads it again in halves.
 */
export function planPasses(
  pieces: readonly TextSpan[],
  tokens: readonly number[],
  limit = PASS_TOKENS - PASS_MARGIN,
): TextSpan[] {
  const k = pieces.length;
  if (k === 0) return [];
  const cum = [0];
  for (let i = 0; i < k; i++) cum.push(cum[i] + Math.max(0, tokens[i] ?? 0));
  const total = cum[k];
  const span = (a: number, b: number): TextSpan => ({ start: pieces[a].start, end: pieces[b - 1].end });
  if (total <= limit) return [span(0, k)];
  const steps = Math.ceil((total - limit) / (limit / 2));
  const stride = (total - limit) / steps;
  // The earliest start from which one pass reaches the end: where the last pass starts.
  let anchor = k - 1;
  while (anchor > 0 && total - cum[anchor - 1] <= limit) anchor--;
  const out: TextSpan[] = [];
  for (let a = 0; ; ) {
    let e = a + 1;
    while (e < k && cum[e + 1] - cum[a] <= limit) e++;
    out.push(span(a, e));
    if (e >= k) break;
    // The last pass, if it leaves no gap: when it is the one planned next, or no more than
    // half a pass on anyway.
    if (anchor <= e && (out.length >= steps || cum[anchor] - cum[a] <= limit / 2)) {
      out.push(span(anchor, k));
      break;
    }
    // The next start: past this one, no later than this end, and late enough that the next
    // pass takes the piece this one could not — or it would end where this one did.
    let from = a + 1;
    while (from < e && cum[e + 1] - cum[from] > limit) from++;
    const aim = out.length * stride; // from the first start, so snapping does not drift
    let b = from;
    for (let i = from + 1; i <= e; i++) if (Math.abs(cum[i] - aim) < Math.abs(cum[b] - aim)) b = i;
    if (b >= anchor) {
      out.push(span(anchor, k));
      break;
    }
    a = b;
  }
  return out;
}

/**
 * The passes a text is read in, planned on estimated token counts — for a caller that
 * cannot ask the engine, and for a count shown before reading (the paste page). One pass
 * covering everything when the text is short enough.
 */
export function planWindows(text: string): TextSpan[] {
  if (text.length <= ONE_PASS_CHARS) return [{ start: 0, end: text.length }];
  const pieces = cutPieces(text, readEnd(text));
  return planPasses(pieces, pieces.map((p) => estimateTokens(text.slice(p.start, p.end)))).slice(0, MAX_WINDOWS);
}

/**
 * A pass the engine had to cut, split once more into two halves. It held more than 510
 * tokens, so each half is ample evidence whatever its length in characters; the cut only
 * has to stay out of the outer quarters.
 */
export function halve(text: string, span: TextSpan): [TextSpan, TextSpan] {
  const quarter = Math.max(1, Math.floor((span.end - span.start) / 4));
  const starts = sentenceStarts(text.slice(span.start, span.end)).map((s) => s + span.start);
  const cut = pickCut(text, starts, (span.start + span.end) / 2, span.start + quarter, span.end - quarter);
  return [{ start: span.start, end: cut }, { start: cut, end: span.end }];
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
   * report follow, in wire shape so band()/formatScore()/the distribution readout take it
   * as they take any result. For a one-window unit it is the daemon's result itself.
   */
  result: ScoreResult;
  /** The passes that were read, in text order — exactly one for nearly every unit. */
  windows: WindowVerdict[];
  /**
   * The text as the verdict judges it, stretch by stretch: every span between two pass
   * edges, with the passes that read it combined (combineStretches). The marks follow
   * these. One pass → the pass itself; a stretch no scored pass read is not here.
   */
  stretches: WindowVerdict[];
  /** Characters at the end of the text that no window covers (the MAX_WINDOWS cap). */
  unreadChars: number;
}

/** Was this window actually scored? Not when the daemon failed or the language gate refused it. */
export function isScoredWindow(w: WindowVerdict): boolean {
  return !w.result.degraded && !w.result.unsupported;
}

/** A probability vector in wire shape: bucket = its argmax, score = Σ pᵢ·i / 3. */
function resultOf(id: string, probs: number[]): ScoreResult {
  let bucket = 0;
  for (let i = 1; i < BUCKET_COUNT; i++) if (probs[i] > probs[bucket]) bucket = i;
  return { id, bucket, probs, score: probs.reduce((acc, p, i) => acc + p * i, 0) / (BUCKET_COUNT - 1) };
}

/**
 * How much a pass counts at a point: in full in its middle, down to a fifth at an edge where
 * it CUT the text, since it read the words there with nothing of what came before or after.
 * The text's own start and end are not cuts — every pass reads them without that context.
 */
function taper(pass: TextSpan, at: number, textLength: number): number {
  const fromStart = pass.start > 0 ? at - pass.start : Infinity;
  const fromEnd = pass.end < textLength ? pass.end - at : Infinity;
  const nearest = Math.min(fromStart, fromEnd);
  return nearest === Infinity ? 1 : 0.2 + 0.8 * Math.min(1, nearest / ((pass.end - pass.start) / 2));
}

/**
 * The stretches between every two pass edges, each with the tapered mean of the scored
 * passes that read it. Passes that do not overlap are their own stretches, unchanged.
 */
function combineStretches(passes: readonly WindowVerdict[], textLength: number): WindowVerdict[] {
  const scored = passes.filter(isScoredWindow);
  const edges = [...new Set(scored.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
  const out: WindowVerdict[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    const over = scored.filter((p) => p.start <= start && p.end >= end);
    if (over.length === 0) continue;
    if (over.length === 1 && over[0].start === start && over[0].end === end) {
      out.push(over[0]);
      continue;
    }
    const at = (start + end) / 2;
    const probs = new Array<number>(BUCKET_COUNT).fill(0);
    let weight = 0;
    for (const p of over) {
      const w = taper(p, at, textLength);
      weight += w;
      for (let j = 0; j < BUCKET_COUNT; j++) probs[j] += (p.result.probs[j] ?? 0) * w;
    }
    for (let j = 0; j < BUCKET_COUNT; j++) probs[j] /= weight;
    const result = resultOf(`${start}-${end}`, probs);
    if (over.some((p) => p.result.truncated)) result.truncated = true;
    out.push({ start, end, result });
  }
  return out;
}

/**
 * One verdict from a unit's passes: the length-weighted mean of its stretches' probability
 * vectors, bucket = argmax of that mean, score = Σ p̄ᵢ·i/3. The mean is linear, so the
 * chip's number is also the length-weighted mean of the stretches' numbers and the bar,
 * the rows and the label all describe the same vector. Passes that do not overlap — an
 * engine that cannot count, a pass read again in halves — are their own stretches, and the
 * verdict is the length-weighted mean of the passes, as it always was.
 *
 * Rejected: the MAXIMUM ("the worst part decides") grows with length by itself — under any
 * per-pass false-positive rate α a human text of n passes is flagged with probability
 * 1−(1−α)ⁿ, so long paragraphs would turn red for being long, and the number would stop
 * being comparable with a short paragraph's. The MAJORITY bucket throws the probabilities
 * away (a 51/49 pass votes like a 99/1 one), ignores length, and is a tie in the commonest
 * case there is — two passes that disagree. A paragraph that turns from human to AI
 * halfway lands in a middle bucket under the mean, which is what EditLens's own scale
 * calls a text of mixed origin; WHERE it turns is what the marks and the card are for.
 *
 * - Any pass DEGRADED → the unit is Unavailable. A failure is transient: a partial verdict
 *   would change under the reader once the retry lands.
 * - Passes the language gate refused are permanent facts about those sentences: they are
 *   left out of the mean and of the marks, and the card says so. All refused → the unit is
 *   "Unsupported language".
 */
export function unitVerdict(id: string, textLength: number, windows: WindowVerdict[]): UnitVerdict {
  const unreadChars = Math.max(0, textLength - windows.reduce((end, w) => Math.max(end, w.end), 0));
  const done = (result: ScoreResult, stretches: WindowVerdict[] = []): UnitVerdict =>
    ({ id, result, windows, stretches, unreadChars });

  if (windows.length === 1) return done({ ...windows[0].result, id }, windows.filter(isScoredWindow));
  if (windows.length === 0 || windows.some((w) => w.result.degraded)) return done(unavailableResult(id));
  const scored = windows.filter(isScoredWindow);
  if (scored.length === 0) {
    const longest = windows.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    return done({ ...longest.result, id });
  }

  const stretches = combineStretches(windows, textLength);
  const probs = new Array<number>(BUCKET_COUNT).fill(0);
  let weight = 0;
  for (const st of stretches) {
    const len = st.end - st.start;
    weight += len;
    for (let i = 0; i < BUCKET_COUNT; i++) probs[i] += (st.result.probs[i] ?? 0) * len;
  }
  for (let i = 0; i < BUCKET_COUNT; i++) probs[i] /= weight;
  const result = resultOf(id, probs);
  if (scored.every((w) => typeof w.result.tokens === "number")) {
    result.tokens = scored.reduce((n, w) => n + (w.result.tokens ?? 0), 0);
  }
  if (scored.some((w) => w.result.truncated)) result.truncated = true;
  return done(result, stretches);
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

/**
 * How many model tokens each text is, in order — or null when the engine cannot say (one
 * older than the count, or not answering); the passes are then planned on estimates.
 */
export type CountTokens = (texts: string[]) => Promise<number[] | null>;

/**
 * The passes each item is read in. A text within ONE_PASS_CHARS is one pass without a
 * question. The pieces of every longer one are counted together, in one call, on the
 * canonical text the engine will be sent.
 */
async function planAll(items: readonly Readable[], countTokens?: CountTokens): Promise<TextSpan[][]> {
  const plans: TextSpan[][] = items.map((item) =>
    item.text.length <= ONE_PASS_CHARS ? [{ start: 0, end: item.text.length }] : []);
  const long = items.flatMap((item, i) => (item.text.length > ONE_PASS_CHARS ? [i] : []));
  if (long.length === 0) return plans;
  const pieces = long.map((i) => cutPieces(items[i].text, readEnd(items[i].text)));
  const texts = long.flatMap((i, n) => pieces[n].map((p) => blockText(items[i].text, p)));
  let counts: number[] | null = null;
  if (countTokens) {
    try {
      counts = await countTokens(texts);
    } catch {
      counts = null;
    }
  }
  if (counts && counts.length !== texts.length) counts = null;
  let at = 0;
  long.forEach((i, n) => {
    const tokens = counts
      ? counts.slice(at, at + pieces[n].length)
      : pieces[n].map((p) => estimateTokens(items[i].text.slice(p.start, p.end)));
    at += pieces[n].length;
    plans[i] = planPasses(pieces[n], tokens).slice(0, MAX_WINDOWS);
  });
  return plans;
}

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
    },
  }));
}

async function ask(slots: Slot[], scoreBlocks: ScoreBlocks): Promise<Map<string, ScoreResult>> {
  const owners = new Map(slots.map((s) => [s.block.id, s.owner.id] as const));
  return scoreBlocks(slots.map((s) => s.block), owners);
}

/**
 * Read every item completely: plan its passes (planAll), score them all in ONE call (a
 * unit's passes travel together and come back together), then re-read in halves, once,
 * any pass the engine reports it had to cut — text denser than the count or the estimate
 * said (digits, URLs, names). A half that is STILL cut stays `truncated`; the card says that
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
  countTokens?: CountTokens,
): Promise<Map<string, WindowVerdict[]>> {
  let slots: Slot[] = [];
  // Only a text past ONE_PASS_CHARS waits for a count; the rest start reading at once, as
  // they always have.
  const plans = items.some((item) => item.text.length > ONE_PASS_CHARS)
    ? await planAll(items, countTokens)
    : items.map((item) => [{ start: 0, end: item.text.length }]);
  items.forEach((item, i) => {
    const spans = plans[i];
    slots.push(...slotsFor(item, spans, spans.length === 1 && spans[0].start === 0 && spans[0].end === item.text.length));
  });
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
