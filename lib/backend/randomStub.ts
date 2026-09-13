// lib/backend/randomStub.ts — deterministic demo backend (contract v2 shape).
// Fabricates an EditLens-style bucket distribution seeded by the paragraph text, so
// the whole surface can be exercised without the model. Never mistake its numbers
// for verdicts: the popup and report footer say "demo stub" whenever it is active.
import { BUCKET_COUNT } from "../contract";
import type { ModelInfo, ScoreClient, ScoreBlock, ScoreResult } from "../contract";

const MODEL: ModelInfo = { id: "stub", ver: "0.0.0", calibration: "none" };

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

function round(x: number): number { return Math.round(x * 10000) / 10000; }

/** Fabricate one coherent ScoreResult for a block, seeded by its text (stable). */
export function randomScore(block: ScoreBlock): ScoreResult {
  const rng = mulberry32(cyrb53(block.text));
  // A latent "extent of AI editing", then a distribution peaked around it so the
  // probabilities look like a real classifier's (one dominant bucket, neighbours
  // share the remainder) rather than noise.
  const latent = rng();
  const sigma = 0.14 + rng() * 0.12;
  const logits: number[] = [];
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const center = i / (BUCKET_COUNT - 1);
    logits.push(-((latent - center) ** 2) / (2 * sigma * sigma));
  }
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => round(e / sum));
  let bucket = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bucket]) bucket = i;
  const score = round(probs.reduce((acc, p, i) => acc + p * i, 0) / (BUCKET_COUNT - 1));
  return { id: block.id, bucket, probs, score, tokens: Math.min(512, Math.ceil(block.text.length / 4)) };
}

export class RandomStubScoreClient implements ScoreClient {
  /** Artificial latency band (ms) so viewport/dedup/concurrency paths are realistic. */
  private minLatency = 120;
  private maxLatency = 400;

  async scoreBatch(blocks: ScoreBlock[]): Promise<ScoreResult[]> {
    const latency = this.minLatency + Math.random() * (this.maxLatency - this.minLatency);
    await sleep(latency);
    return blocks.map(randomScore);
  }

  model(): ModelInfo {
    return MODEL;
  }
}

export const STUB_MODEL = MODEL;
