// lib/backend/randomStub.ts
import { ScoreClient, ScoreBlock, ScoreResult } from "../contract";
import { splitSentences } from "../dom/text";

const MODEL = { id: "stub", ver: "0.0.0", calibration: "none" };

/** Deterministic 53-bit hash of a string (cyrb53) → seed. */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Mulberry32 PRNG → deterministic [0,1) stream from a seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fabricate one coherent ScoreResult for a block, seeded by its text (stable). */
export function randomScore(block: ScoreBlock): ScoreResult {
  const rng = mulberry32(cyrb53(block.text));

  // e_theta: point estimate of AI-probability in [0,1].
  const e_theta = rng();

  // theta_interval: a plausible credible band around e_theta, clamped to [0,1].
  const halfWidth = 0.05 + rng() * 0.15;             // 0.05–0.20
  const lo = Math.max(0, e_theta - halfWidth);
  const hi = Math.min(1, e_theta + halfWidth);

  // detected = lo > 0.5 (the whole credible interval sits in the AI region).
  // (Design §4.5 says "detected = lo>0"; we use lo>0.5 so 'detected' tracks a meaningful
  //  AI judgment rather than being almost-always true. This is the coherent reading.)
  const detected = lo > 0.5;

  // p_value: small when AI evidence is strong (e_theta high), noisy otherwise.
  const p_value = detected
    ? Math.max(0.0001, (1 - e_theta) * rng() * 0.05)   // strong evidence → tiny p
    : Math.min(1, 0.2 + rng() * 0.8);                  // weak/human → large p

  // sentence_flags: one boolean per sentence, biased by e_theta. Use the SAME canonical
  // splitter the highlight layer uses (lib/dom/text splitSentences) so flags[i] lines up
  // with the i-th sentence the renderer underlines. A different split here (e.g. a source
  // newline that one splitter treats as a sentence break and the other doesn't) silently
  // misaligns the marks — that was why the blockquote got a badge but no underline.
  const sentences = splitSentences(block.text);
  // A fully-AI paragraph (detected) → every sentence is AI, so the whole thing underlines
  // and matches the red badge. Otherwise flag per-sentence by e_theta (the "mixed" case).
  // Demo coherence: a flagged paragraph (e_theta >= 0.4) always marks >= 1 sentence.
  // (A real detector emits this badge↔sentence consistency itself.)
  const sentence_flags = detected
    ? sentences.map(() => true)
    : sentences.map(() => rng() < e_theta);
  if (e_theta >= 0.4 && sentence_flags.length > 0 && !sentence_flags.some(Boolean)) {
    sentence_flags[0] = true;
  }

  return { id: block.id, detected, theta_interval: [round(lo), round(hi)], e_theta: round(e_theta), p_value: round(p_value), sentence_flags };
}

function round(x: number): number { return Math.round(x * 1000) / 1000; }

export class RandomStubScoreClient implements ScoreClient {
  /** Artificial latency band (ms) so viewport/dedup/concurrency paths are realistic. */
  private minLatency = 120;
  private maxLatency = 400;

  async scoreBatch(blocks: ScoreBlock[]): Promise<ScoreResult[]> {
    const latency = this.minLatency + Math.random() * (this.maxLatency - this.minLatency);
    await sleep(latency);
    return blocks.map(randomScore);
  }
}

export const STUB_MODEL = MODEL;
