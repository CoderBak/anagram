// Validate local component responses before results can become chips or cache entries.
// A batch's own model identity records which configuration produced its verdicts.
import * as v from "valibot";
import { BUCKET_COUNT, CONTRACT_VERSION } from "../contract";
import type { ScoreBlock, ScoredBatch, ScoreResult, TokenCounts } from "../contract";

/** Stored probabilities are rounded to 3–4 decimals; allow that much drift in the sum. */
const PROB_SUM_TOLERANCE = 0.02;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const Prob = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

/** A language tag and nothing else: fastText lid.176 emits 2–3 lowercase letters ("en",
 *  "ceb") and the browser's own detector can add a subtag ("zh-CN"). The value reaches
 *  chip text and card markup, so anything shaped differently is treated as malformed. */
const LANG_CODE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const ModelSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  ver: v.pipe(v.string(), v.maxLength(120)),
  calibration: v.pipe(v.string(), v.maxLength(120)),
});

const ResultSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  bucket: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(BUCKET_COUNT - 1)),
  probs: v.pipe(
    v.array(Prob),
    v.length(BUCKET_COUNT),
    v.check((p) => Math.abs(p.reduce((a, b) => a + b, 0) - 1) <= PROB_SUM_TOLERANCE, "probabilities must sum to 1"),
  ),
  score: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  tokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  truncated: v.optional(v.boolean()),
  lang: v.optional(v.pipe(v.string(), v.regex(LANG_CODE, "must be a language code"))),
  lang_prob: v.optional(Prob),
  unsupported: v.optional(v.boolean()),
  degraded: v.optional(v.boolean()),
});

const ScoreResponseSchema = v.object({
  v: v.string(),
  model: ModelSchema,
  results: v.array(ResultSchema),
});

const HealthSchema = v.object({
  ok: v.literal(true),
  contract: v.string(),
  model: ModelSchema,
  n_buckets: v.literal(BUCKET_COUNT),
  buckets: v.array(v.string()),
  max_tokens: v.pipe(v.number(), v.integer(), v.minValue(1)),
  device: v.string(),
  languages: v.optional(v.array(v.string())),
  lid: v.optional(v.nullable(v.string())),
  dtype: v.optional(v.string()),
  /** Component release used to show update availability. */
  app_version: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64)))),
});

export type HealthInfo = v.InferOutput<typeof HealthSchema>;

export type HealthResult =
  | { ok: true; health: HealthInfo }
  | { ok: false; reason: "unreachable" | "contract"; contract?: string };

const UNREACHABLE: HealthResult = { ok: false, reason: "unreachable" };

function sameMajor(version: string): boolean {
  return version.split(".")[0] === CONTRACT_VERSION.split(".")[0];
}

/** A dotted, all-numeric version as its parts, or null for anything else. */
function numericVersion(version: string | null | undefined): number[] | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  return /^\d+(\.\d+)*$/.test(trimmed) ? trimmed.split(".").map(Number) : null;
}

/** Whether Settings should offer a component update for this extension version. */
export function componentIsBehind(componentVersion: string | null | undefined, extensionVersion: string): boolean {
  const component = numericVersion(componentVersion);
  if (component === null) return true;
  const mine = numericVersion(extensionVersion);
  if (mine === null) return false;
  for (let i = 0; i < Math.max(component.length, mine.length); i++) {
    const theirs = component[i] ?? 0;
    const ours = mine[i] ?? 0;
    if (theirs !== ours) return theirs < ours;
  }
  return false;
}

/** Validate component health, identifying an incompatible contract before its schema. */
export function parseHealth(body: unknown): HealthResult {
  // The contract is read LENIENTLY, straight off the raw JSON and before the schema:
  // a component of another major may have changed the health payload too, and we
  // still want to say "incompatible" rather than "not ready" about it.
  const reported = (body as { contract?: unknown } | null)?.contract;
  if (typeof reported === "string" && !sameMajor(reported)) {
    return { ok: false, reason: "contract", contract: reported };
  }
  const parsed = v.safeParse(HealthSchema, body);
  if (!parsed.success) return UNREACHABLE;
  return { ok: true, health: parsed.output };
}

/** Trim a validated result to the contract's optional-field conventions. */
function toResult(r: v.InferOutput<typeof ResultSchema>): ScoreResult {
  const out: ScoreResult = { id: r.id, bucket: r.bucket, probs: r.probs, score: r.score };
  if (typeof r.tokens === "number") out.tokens = r.tokens;
  if (r.truncated) out.truncated = true;
  if (r.degraded) out.degraded = true;
  if (r.lang) out.lang = r.lang;
  if (typeof r.lang_prob === "number") out.lang_prob = r.lang_prob;
  if (r.unsupported) out.unsupported = true;
  return out;
}

const Counts = v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_000_000)));
const TokenCountsSchema = v.object({
  alone: Counts,
  following: Counts,
  window: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/** Both counts for every text asked about, or null for an answer of any other shape. */
export function parseTokenCounts(body: unknown, asked: number): TokenCounts | null {
  const parsed = v.safeParse(TokenCountsSchema, body);
  if (!parsed.success || parsed.output.alone.length !== asked || parsed.output.following.length !== asked) return null;
  return { alone: parsed.output.alone, following: parsed.output.following };
}

/** Validate identity, probabilities and requested block IDs. */
export function parseScoreResponse(body: unknown, blocks: ScoreBlock[]): ScoredBatch {
  const parsed = v.safeParse(ScoreResponseSchema, body);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    throw new ProtocolError(`malformed score response: ${v.getDotPath(issue) ?? "?"} ${issue.message}`);
  }
  if (!sameMajor(parsed.output.v)) throw new ProtocolError(`contract ${parsed.output.v} ≠ ${CONTRACT_VERSION}`);
  const wanted = new Set(blocks.map((b) => b.id));
  const results: ScoreResult[] = [];
  const seen = new Set<string>();
  for (const r of parsed.output.results) {
    if (!wanted.has(r.id) || seen.has(r.id)) continue; // stray or duplicate id — ignored
    seen.add(r.id);
    results.push(toResult(r));
  }
  if (results.length === 0 && blocks.length > 0) throw new ProtocolError("no result matched a requested block");
  return { results, model: parsed.output.model };
}
