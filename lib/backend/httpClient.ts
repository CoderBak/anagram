// lib/backend/httpClient.ts — ScoreClient over HTTP to the local anagramd daemon
// (anagramd/serve.py). One POST per batch; the daemon speaks contract v2 verbatim.
//
// Every byte off the wire is VALIDATED (valibot) before it can become a chip: bucket
// range, probability range and sum, integer counts, model identity, contract major.
// Malformed data is a ProtocolError → the router renders "Unavailable" and caches
// nothing. The model named in the RESPONSE is what the batch reports as its producer.
import * as v from "valibot";
import { BUCKET_COUNT, CONTRACT_VERSION } from "../contract";
import type { ModelInfo, ScoreBlock, ScoreClient, ScoredBatch, ScoreResult } from "../contract";
import { parseRetryAfter } from "./retry";

/** Below Chrome's 30 s cutoff for a single fetch() inside an extension service worker. */
const SCORE_TIMEOUT_MS = 25_000;
const HEALTH_TIMEOUT_MS = 1_500;
/** Stored probabilities are rounded to 3–4 decimals; allow that much drift in the sum. */
const PROB_SUM_TOLERANCE = 0.02;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * The daemon answered, with a status rather than a batch. The status travels on the error
 * because it is what decides whether asking again can help — 503 while the weights load is
 * worth another try, 400 is the same answer every time (lib/backend/retry.ts) — and so does
 * `Retry-After` when the daemon sends one.
 */
export class DaemonHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`anagramd HTTP ${status}`);
    this.name = "DaemonHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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
  /** The daemon's own release, which the extension compares with its own. Optional
   *  because every daemon built before this field existed answered without it. */
  app_version: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(64)))),
});

export type HealthInfo = v.InferOutput<typeof HealthSchema>;

/**
 * Why a /health probe did not produce a usable daemon. "unreachable" means nothing is
 * listening (or it timed out, or it answered something we cannot use); "contract" means
 * something DID answer and named a contract major other than ours; "outdated" means
 * something is listening and will not let us read a word of it, which is what a daemon
 * older than this extension looks like — see `somethingIsListening`. The three need
 * different advice — start it, update it, update it — so they must not collapse into one
 * "not running".
 */
export type HealthFailureReason = "unreachable" | "contract" | "outdated";

export type HealthResult =
  | { ok: true; health: HealthInfo }
  | { ok: false; reason: HealthFailureReason; contract?: string };

const UNREACHABLE: HealthResult = { ok: false, reason: "unreachable" };
const OUTDATED: HealthResult = { ok: false, reason: "outdated" };

/**
 * Redirects are never followed on either endpoint: the URL we chose is checked to be
 * loopback, but a 307/308 from whatever is listening on that port would re-send the
 * request — for /score, the page text itself — to an address we never vetted.
 */
const NO_REDIRECT = "error" as const;

function withTimeout(ms: number): { signal: AbortSignal; done(): void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

function sameMajor(version: string): boolean {
  return version.split(".")[0] === CONTRACT_VERSION.split(".")[0];
}

/** A dotted, all-numeric version as its parts, or null for anything else. */
function numericVersion(version: string | null | undefined): number[] | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  return /^\d+(\.\d+)*$/.test(trimmed) ? trimmed.split(".").map(Number) : null;
}

/**
 * Is the daemon older than the extension asking? They ship as one artifact — one
 * `npm run bump` sets both — so a reader whose extension updated by itself in the
 * background is running an extension the daemon has never met, and the honest thing is
 * to ask them for the one command that puts it right.
 *
 * A daemon that reports no version at all is every daemon built before this existed, so
 * it is behind by definition. A version neither of us can parse is treated the same way,
 * except when it is OUR version that is odd: nagging a reader about their daemon because
 * of something strange in our own manifest would be blaming the wrong machine.
 */
export function daemonIsBehind(daemonVersion: string | null | undefined, extensionVersion: string): boolean {
  const daemon = numericVersion(daemonVersion);
  if (daemon === null) return true;
  const mine = numericVersion(extensionVersion);
  if (mine === null) return false;
  for (let i = 0; i < Math.max(daemon.length, mine.length); i++) {
    const theirs = daemon[i] ?? 0;
    const ours = mine[i] ?? 0;
    if (theirs !== ours) return theirs < ours;
  }
  return false;
}

/**
 * A last question asked of an address whose ordinary request failed: is ANYTHING there?
 *
 * The extension holds no host permission for the daemon, so reading an answer depends on
 * the daemon sending CORS headers naming our origin. A daemon older than that is
 * listening, healthy and completely unreadable — the browser hands us the same failure it
 * gives for a closed port, and the two need opposite advice. So we ask once more in
 * `no-cors` mode, where the browser requires no headers and gives back an opaque response
 * it will not let us read. That it resolved at all is the whole answer: something is
 * there, and it is too old.
 *
 * `redirect: "error"` is left off because the Fetch standard forbids anything but "follow"
 * in `no-cors` mode. Nothing is risked by that: this sends a bodyless GET with credentials
 * omitted, it reads nothing back, and `connect-src` (wxt.config.ts) would refuse to follow
 * a redirect off loopback anyway.
 */
async function somethingIsListening(baseUrl: string): Promise<boolean> {
  const t = withTimeout(HEALTH_TIMEOUT_MS);
  try {
    await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      signal: t.signal,
      cache: "no-store",
      mode: "no-cors",
      credentials: "omit",
    });
    return true;
  } catch {
    return false;
  } finally {
    t.done();
  }
}

/** GET /health — the daemon's identity, or why it cannot be used (see HealthResult). */
export async function fetchHealth(baseUrl: string): Promise<HealthResult> {
  const t = withTimeout(HEALTH_TIMEOUT_MS);
  // Whether the daemon answered us at all, as opposed to answering something we could not
  // make sense of. It decides which question is worth asking below.
  let answered = false;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      signal: t.signal,
      cache: "no-store",
      redirect: NO_REDIRECT,
    });
    answered = true;
    if (!res.ok) return UNREACHABLE;
    const body: unknown = await res.json();
    // The contract is read LENIENTLY, straight off the raw JSON and before the schema:
    // a daemon of another major may well have changed the shape of /health too, and we
    // still want to say "wrong version" rather than "not running" about it.
    const reported = (body as { contract?: unknown } | null)?.contract;
    if (typeof reported === "string" && !sameMajor(reported)) {
      return { ok: false, reason: "contract", contract: reported };
    }
    const parsed = v.safeParse(HealthSchema, body);
    if (!parsed.success) return UNREACHABLE;
    return { ok: true, health: parsed.output };
  } catch {
    // A daemon that answered and then sent nonsense is reachable, whatever else is wrong
    // with it. Only a request that never completed can be the old-daemon case.
    if (answered) return UNREACHABLE;
    return (await somethingIsListening(baseUrl)) ? OUTDATED : UNREACHABLE;
  } finally {
    t.done();
  }
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

export class HttpScoreClient implements ScoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly modelInfo: ModelInfo,
  ) {}

  model(): ModelInfo {
    return this.modelInfo;
  }

  async scoreBatch(blocks: ScoreBlock[]): Promise<ScoredBatch> {
    const t = withTimeout(SCORE_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: CONTRACT_VERSION, blocks: blocks.map((b) => ({ id: b.id, text: b.text })) }),
        signal: t.signal,
        redirect: NO_REDIRECT,
      });
      if (!res.ok) throw new DaemonHttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
      const parsed = v.safeParse(ScoreResponseSchema, await res.json());
      if (!parsed.success) {
        const issue = parsed.issues[0];
        throw new ProtocolError(`malformed /score response: ${v.getDotPath(issue) ?? "?"} ${issue.message}`);
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
    } finally {
      t.done();
    }
  }
}
