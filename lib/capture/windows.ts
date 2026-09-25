// lib/capture/windows.ts — reading a long text completely, in passes that overlap by half.
//
// EditLens reads 512 tokens and the engine cuts whatever is longer, so a long paragraph
// used to be judged by its opening alone while the chip and the underline spoke for all
// of it. A text that does not fit one pass is divided into HALVES of equal token count and
// read in PASSES of two neighbouring halves each, so every half past the first is read
// twice: at the end of one pass, with what came before it, and at the start of the next,
// with what comes after it. The two readings are mirror images and count alike. The engine
// counts the tokens of every word (the `tokens` operation), so the halves are even to the
// token, and each edge between two halves moves to a sentence start when one is near:
// EditLens was trained on texts that begin where a text begins and are cut, if at all, at
// the end. Each pass is scored as a block of its own through the ordinary pipeline (same
// wire contract; the model form of each pass is what gets deduplicated and cached).
// The chip states ONE aggregate for the unit; the marks follow the halves. Most
// paragraphs fit one pass: same request text, same cache key, same card as before.
//
// Order of operations: the unit's OWN collapsed text is cut first and each pass is put in
// its model form (modelText) afterwards. The other way round left cut positions that could
// not be mapped back to the DOM, because the model form drops characters.
//
// This file is pure text and arithmetic — no DOM — so the vitest suite can drive it. The
// mapping of a stretch back to text nodes lives in lib/dom/locate.ts.
import type { ScoreBlock, ScoreResult, TokenCounts } from "../contract";
import { BUCKET_COUNT } from "../contract";
import { modelText, sentenceStarts } from "../dom/text";

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

/**
 * How far, in tokens, an edge between two halves may move from its even place to land on a
 * sentence start: about one sentence (English runs 20 to 30 tokens a sentence), so one is
 * usually in reach. Passes are planned twice this short of PASS_TOKENS, so no two moved
 * edges can push a pass past what the model reads.
 */
export const SNAP_TOKENS = 32;

/** The longest run without a space that counts as one word (a URL, CJK without marks). */
export const MAX_CHUNK_CHARS = 200;

/** Emoji: the engine spells them out by name (":grinning_face:") before it counts. */
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u20E3]/u;

/**
 * Whether a text certainly fits one pass without asking the engine. The model's tokenizer
 * never makes more tokens than the text has UTF-8 bytes, counted on what the engine reads
 * — the model form, lower-cased. Only emoji grow on the way, so a text with one is always
 * counted.
 */
export function fitsWithoutCounting(text: string): boolean {
  if (text.length > 4 * PASS_TOKENS) return false;
  const model = modelText(text);
  return !PICTOGRAPHIC.test(model) && new TextEncoder().encode(model.toLowerCase()).length <= PASS_TOKENS;
}

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
 * token, is 80 640 tokens, or 2 × 80 640 / (PASS_TOKENS − 2 × SNAP_TOKENS) ≈ 362 halves.
 * A forward pass is around a tenth of a second on the hardware this runs on. The passes of
 * a long text never travel as one request (requestSlices).
 */
export const MAX_WINDOWS = 400;

/**
 * Hard bound on one block's text on the wire. The engine refuses any block over 16 000
 * characters, and a refused block fails the whole request, its neighbours included. A pass
 * planned on counts holds 510 tokens, which reaches 4000 characters only at eight
 * characters a token, and no prose does: nothing that reaches this bound is prose.
 */
export const MAX_BLOCK_CHARS = 4000;

/**
 * Most blocks and characters one scoring request carries. The worker refuses a request of
 * more than 256 blocks or 256 000 characters whole (lib/access/messages.ts), and answers
 * Unavailable past 256 blocks or 250 000 characters of one page's at a time
 * (lib/backend/router.ts). One unit can pass all of that alone: MAX_WINDOWS windows, each
 * up to MAX_BLOCK_CHARS, and twice as many halves when the daemon cuts them. So what a
 * batch sends goes in requests of this size, one after another, and the four batches the
 * orchestrator keeps in flight stay inside the page's share together. At six bytes a
 * character, the most JSON takes to escape one, a request also stays under the worker's
 * 900 000 encoded bytes.
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
 * across the halves when a joint is near. Short paragraphs are under 75 words, so a
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

/** A word of a text, as passes are planned on: its span, trailing space included. */
export interface Chunk extends TextSpan {
  /** No space before it: it goes on from the chunk before (a sentence that starts with no
   *  space in front, as in Chinese, or a cut inside a run too long for one word). */
  glued: boolean;
}

/** A space between two words as the engine reads them: not the byte-order mark JavaScript
 *  counts as one, which the model form drops (modelText), so the words either side meet. */
const SPACE = /[^\S\uFEFF]/;

/**
 * Cut [0, end) into the words passes are planned on: a new chunk at every word start, at
 * every sentence start (sentenceStarts, which finds sentences with no space in front too),
 * and every MAX_CHUNK_CHARS inside a run without a space, never between the halves of a
 * surrogate pair. Every character belongs to exactly one chunk.
 */
export function chunksOf(text: string, end = text.length): Chunk[] {
  if (end <= 0) return [];
  const cuts = new Set<number>([0]);
  for (let at = 1; at < end; at++) if (SPACE.test(text[at - 1]) && !SPACE.test(text[at])) cuts.add(at);
  for (const at of sentenceStarts(text.slice(0, end))) if (at > 0 && at < end) cuts.add(at);
  const sorted = [...cuts].sort((x, y) => x - y);
  const out: Chunk[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let start = sorted[i];
    const stop = i + 1 < sorted.length ? sorted[i + 1] : end;
    let glued = start > 0 && !SPACE.test(text[start - 1]);
    let run = start;
    while (run < stop && !SPACE.test(text[run])) run++;
    while (run - start > MAX_CHUNK_CHARS) {
      let cut = start + MAX_CHUNK_CHARS;
      const low = text.charCodeAt(cut);
      if (low >= 0xdc00 && low <= 0xdfff) cut--;
      out.push({ start, end: cut, glued });
      start = cut;
      glued = true;
    }
    out.push({ start, end: stop, glued });
  }
  return out;
}

/** A text's chunks up to readEnd, and the model form of each: what the engine counts. */
export function wordsOf(text: string): { chunks: Chunk[]; words: string[] } {
  const chunks = chunksOf(text, readEnd(text));
  const model = new Map<string, string>();
  const words = chunks.map((c) => {
    const raw = text.slice(c.start, c.end).trimEnd();
    let word = model.get(raw);
    if (word === undefined) model.set(raw, (word = modelText(raw)));
    return word;
  });
  return { chunks, words };
}

/**
 * The passes a text of `chunks` is read in, from each chunk's counts: `alone` where a
 * pass starts on it, `following` a space inside one (a glued chunk goes on from the one
 * before it, so it counts alone there too). The tokenizer never merges across a space, so
 * those add up to exactly what the engine reads. One pass when the whole text fits
 * PASS_TOKENS.
 *
 * Otherwise the text is divided into h = ⌈2N / (PASS_TOKENS − 2·SNAP_TOKENS)⌉ halves of
 * N/h tokens and read in h − 1 passes, each over two neighbouring halves. Each edge
 * between two halves moves to the nearest sentence start within SNAP_TOKENS of its even
 * place, else the nearest word start there, else the nearest chunk, but never so far that
 * a pass would outgrow PASS_TOKENS. A chunk too large for a pass on its own (a run of
 * emoji the engine spells out) still makes one too long; the engine reads its opening and
 * says so, and readInWindows reads it again in halves.
 */
export function planPasses(text: string, chunks: readonly Chunk[], counts: TokenCounts): TextSpan[] {
  const k = chunks.length;
  if (k === 0) return [];
  const end = chunks[k - 1].end;
  const alone = chunks.map((_, i) => Math.max(0, counts.alone[i] ?? 0));
  const inner = chunks.map((c, i) => (i === 0 || c.glued ? alone[i] : Math.max(0, counts.following[i] ?? 0)));
  const cum = [0];
  for (let i = 0; i < k; i++) cum.push(cum[i] + inner[i]);
  const total = cum[k];
  /** Tokens of a pass over chunks [a, b): its first word as a text starts, the rest in place. */
  const tokens = (a: number, b: number): number => cum[b] - cum[a] - inner[a] + alone[a];
  const halves = Math.min(k, Math.ceil((2 * total) / (PASS_TOKENS - 2 * SNAP_TOKENS)));
  if (total <= PASS_TOKENS || halves < 3) return [{ start: 0, end }];

  const sentences = new Set(sentenceStarts(text.slice(0, end)));
  const edges = [0];
  let mid = 0;
  for (let i = 1; i < halves; i++) {
    const aim = (i * total) / halves;
    // Where this edge may go: past the one before, leaving a chunk for each edge after it,
    // no further than the pass that began two edges back can reach, and — the last edge —
    // no earlier than the last pass can start and still fit.
    let lo = edges[i - 1] + 1;
    let hi = k - (halves - i);
    if (i >= 2) {
      // A pass grows with its end: the last end that fits, by bisection (or, when not even
      // the first does — a chunk too large for any pass — the first).
      const from = edges[i - 2];
      let a = lo;
      let b = hi;
      while (a < b) {
        const m = (a + b + 1) >> 1;
        if (tokens(from, m) <= PASS_TOKENS) a = m;
        else b = m - 1;
      }
      hi = a;
    }
    if (i === halves - 1) while (lo < hi && tokens(lo, k) > PASS_TOKENS) lo++;
    mid = Math.max(mid, lo);
    while (mid < hi && cum[mid] < aim) mid++;
    mid = Math.min(mid, hi);
    let best = mid;
    let bestRank = Infinity;
    const consider = (j: number): void => {
      const off = Math.abs(cum[j] - aim);
      const kind = off > SNAP_TOKENS ? 3 : sentences.has(chunks[j].start) ? 0 : chunks[j].glued ? 2 : 1;
      const rank = kind * (total + 1) + off;
      if (rank < bestRank) {
        bestRank = rank;
        best = j;
      }
    };
    for (let j = mid; j >= lo && (j >= mid - 1 || cum[j] >= aim - SNAP_TOKENS); j--) consider(j);
    for (let j = mid + 1; j <= hi && cum[j] <= aim + SNAP_TOKENS; j++) consider(j);
    edges.push(best);
  }
  edges.push(k);
  const at = (j: number): number => (j < k ? chunks[j].start : end);
  return edges.slice(0, -2).map((e, p) => ({ start: at(e), end: at(edges[p + 2]) }));
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

/**
 * What is SENT for a stretch of text: its model form, which is also its cache key. The
 * engine drops the first paragraph of a block that opens like a chatbot's preamble ("Sure!
 * Here is…") when more follow, as the official pipeline does with a whole text. A pass
 * further in does not open the text, so its line breaks go as spaces, which the engine
 * reads alike otherwise.
 */
export function blockText(text: string, span: TextSpan): string {
  let model = modelText(text.slice(span.start, span.end));
  if (span.start > 0) model = model.replace(/\n/g, " ");
  if (model.length <= MAX_BLOCK_CHARS) return model;
  // Not through the middle of a surrogate pair: half of one cannot be encoded as UTF-8.
  const last = model.charCodeAt(MAX_BLOCK_CHARS - 1);
  return model.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_BLOCK_CHARS - 1 : MAX_BLOCK_CHARS);
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
 * The stretches between every two pass edges, each with the mean of the scored passes
 * that read it: two for every half but the first and the last, which count alike — one
 * read it with what came before, the other with what comes after. Passes that do not
 * overlap (the halves of a pass read again) are their own stretches, unchanged.
 */
function combineStretches(passes: readonly WindowVerdict[]): WindowVerdict[] {
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
    const probs = new Array<number>(BUCKET_COUNT).fill(0);
    for (const p of over) for (let j = 0; j < BUCKET_COUNT; j++) probs[j] += (p.result.probs[j] ?? 0) / over.length;
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

  const stretches = combineStretches(windows);
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

/** Both token counts of every text, in order — or null when the engine did not answer. */
export type CountTokens = (texts: string[]) => Promise<TokenCounts | null>;

/**
 * The passes each item is read in, or null for one that could not be planned because
 * the engine did not answer the count. An item that fits one pass without counting
 * (`fits`) is one pass; the words of every other one are counted together, each distinct
 * word once, on the model form the engine will be sent.
 */
async function planAll(
  items: readonly Readable[],
  fits: readonly boolean[],
  countTokens: CountTokens,
): Promise<Array<TextSpan[] | null>> {
  const plans: Array<TextSpan[] | null> = items.map((item, i) => (fits[i] ? [{ start: 0, end: item.text.length }] : null));
  const long = items.flatMap((_, i) => (fits[i] ? [] : [i]));
  const planned = long.map((i) => wordsOf(items[i].text));
  const texts: string[] = [];
  const known = new Map<string, number>();
  const refs = planned.map(({ words }) =>
    words.map((word) => {
      let at = known.get(word);
      if (at === undefined) {
        at = texts.length;
        known.set(word, at);
        texts.push(word);
      }
      return at;
    }),
  );
  let counts: TokenCounts | null = null;
  try {
    counts = await countTokens(texts);
  } catch {
    counts = null;
  }
  if (!counts || counts.alone.length !== texts.length || counts.following.length !== texts.length) return plans;
  const { alone, following } = counts;
  long.forEach((i, n) => {
    const own = { alone: refs[n].map((r) => alone[r]), following: refs[n].map((r) => following[r]) };
    plans[i] = planPasses(items[i].text, planned[n].chunks, own).slice(0, MAX_WINDOWS);
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
 * any pass the engine reports it had to cut — one holding a word too large for any pass.
 * A half that is STILL cut stays `truncated`; the card says that part of the text was not
 * read, so there is no silent gap. An item whose words went uncounted is Unavailable, as
 * one whose score failed is.
 *
 * Atomic per item: the map holds an entry only for items whose EVERY window was
 * answered. Nothing unit-level is cached anywhere — `scoreBlocks` caches per window
 * text, so after a partial failure the windows that did come back are hits on the retry
 * and only the missing one is asked for again.
 */
export async function readInWindows(
  items: Readable[],
  scoreBlocks: ScoreBlocks,
  countTokens: CountTokens,
): Promise<Map<string, WindowVerdict[]>> {
  let slots: Slot[] = [];
  // Only a text that may not fit one pass waits for a count; the rest start reading at
  // once, as they always have.
  const fits = items.map((item) => fitsWithoutCounting(item.text));
  const plans = fits.every(Boolean)
    ? items.map((item) => [{ start: 0, end: item.text.length }])
    : await planAll(items, fits, countTokens);
  const uncounted: Readable[] = [];
  items.forEach((item, i) => {
    const spans = plans[i];
    if (!spans) uncounted.push(item);
    else slots.push(...slotsFor(item, spans, spans.length === 1 && spans[0].start === 0 && spans[0].end === item.text.length));
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
  for (const item of uncounted) out.set(item.id, [{ start: 0, end: item.text.length, result: unavailableResult(item.id) }]);
  return out;
}
