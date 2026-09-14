// lib/backend/httpClient.ts — ScoreClient over HTTP to the local anagramd daemon
// (anagramd/serve.py). One POST per batch; the daemon speaks contract v2 verbatim.
import { BUCKET_COUNT, CONTRACT_VERSION } from "../contract";
import type { ModelInfo, ScoreBlock, ScoreClient, ScoreResult } from "../contract";

export interface HealthInfo {
  ok: boolean;
  contract: string;
  model: ModelInfo;
  n_buckets: number;
  buckets: string[];
  max_tokens: number;
  device: string;
}

/** Scoring can take a while on a cold Mac; batches are ≤ ~800 chars so 60 s is generous. */
const SCORE_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 1_500;

function withTimeout(ms: number): { signal: AbortSignal; done(): void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

/** GET /health — null when the daemon is down, unreachable, or speaks another contract. */
export async function fetchHealth(baseUrl: string): Promise<HealthInfo | null> {
  const t = withTimeout(HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: t.signal, cache: "no-store" });
    if (!res.ok) return null;
    const h = (await res.json()) as Partial<HealthInfo>;
    if (!h || h.ok !== true || !h.model?.id || h.n_buckets !== BUCKET_COUNT) return null;
    if (typeof h.contract !== "string" || h.contract.split(".")[0] !== CONTRACT_VERSION.split(".")[0]) return null;
    return h as HealthInfo;
  } catch {
    return null;
  } finally {
    t.done();
  }
}

function num(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

/** Coerce one daemon result into a well-formed ScoreResult (never trust the wire blindly). */
function coerce(raw: unknown, id: string): ScoreResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const probs = Array.isArray(r.probs) ? r.probs.map((p) => num(p, 0)) : [];
  if (probs.length !== BUCKET_COUNT) return null;
  let bucket = Math.trunc(num(r.bucket, -1));
  if (bucket < 0 || bucket >= BUCKET_COUNT) {
    bucket = probs.indexOf(Math.max(...probs));
  }
  const score = Math.min(1, Math.max(0, num(r.score, probs.reduce((a, p, i) => a + p * i, 0) / (BUCKET_COUNT - 1))));
  const out: ScoreResult = { id, bucket, probs, score };
  if (typeof r.tokens === "number") out.tokens = r.tokens;
  if (r.truncated === true) out.truncated = true;
  if (r.degraded === true) out.degraded = true;
  if (typeof r.lang === "string" && r.lang) out.lang = r.lang.slice(0, 8);
  if (typeof r.lang_prob === "number") out.lang_prob = r.lang_prob;
  if (r.unsupported === true) out.unsupported = true;
  return out;
}

export class HttpScoreClient implements ScoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly modelInfo: ModelInfo,
  ) {}

  model(): ModelInfo {
    return this.modelInfo;
  }

  async scoreBatch(blocks: ScoreBlock[]): Promise<ScoreResult[]> {
    const t = withTimeout(SCORE_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: CONTRACT_VERSION, blocks: blocks.map((b) => ({ id: b.id, text: b.text })) }),
        signal: t.signal,
      });
      if (!res.ok) throw new Error(`anagramd HTTP ${res.status}`);
      const body = (await res.json()) as { results?: unknown[] };
      const byId = new Map<string, unknown>();
      for (const raw of body.results ?? []) {
        const id = (raw as { id?: unknown })?.id;
        if (typeof id === "string") byId.set(id, raw);
      }
      const out: ScoreResult[] = [];
      for (const b of blocks) {
        const r = coerce(byId.get(b.id), b.id);
        if (r) out.push(r);
      }
      if (out.length === 0 && blocks.length > 0) throw new Error("anagramd returned no usable results");
      return out;
    } finally {
      t.done();
    }
  }
}
