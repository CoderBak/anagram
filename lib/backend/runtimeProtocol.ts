import * as v from "valibot";

const Text = v.pipe(v.string(), v.maxLength(2000));
const Id = v.pipe(v.string(), v.minLength(1), v.maxLength(120));
const NumberValue = v.pipe(v.number(), v.finite(), v.minValue(0));
const Count = v.pipe(NumberValue, v.integer());
const Metric = v.optional(v.nullable(NumberValue));

const CandidateSchema = v.object({
  id: Id,
  label: Text,
  device: Text,
  runtime: Text,
  precision: Text,
  experimental: v.boolean(),
  available: v.boolean(),
  reason: v.optional(v.nullable(Text)),
});

const ResultSchema = v.object({
  candidate_id: Id,
  status: v.picklist(["ok", "error"]),
  error: v.optional(v.nullable(Text)),
  load_ms: Metric,
  warmup_ms: Metric,
  latency_ms: Metric,
  throughput_per_s: Metric,
  peak_rss_bytes: Metric,
  accelerator_bytes: Metric,
  samples: v.optional(v.nullable(Count)),
  batch_size: v.optional(v.nullable(Count)),
  tokens_per_text: Metric,
  duration_s: Metric,
});

export const RuntimeSchema = v.object({
  schema_version: v.literal(1),
  state: v.picklist(["loading", "benchmarking", "awaiting_selection", "ready", "error"]),
  active_id: v.nullable(Id),
  selected_id: v.nullable(Id),
  recommended_id: v.nullable(Id),
  needs_selection: v.boolean(),
  candidates: v.pipe(v.array(CandidateSchema), v.maxLength(64)),
  benchmark: v.object({
    status: v.picklist(["idle", "running", "completed", "cancelled", "failed"]),
    budget_s: NumberValue,
    elapsed_s: NumberValue,
    measurement_s: NumberValue,
    phase: Text,
    current_id: v.nullable(Id),
    completed: Count,
    total: Count,
    results: v.pipe(v.array(ResultSchema), v.maxLength(128)),
  }),
  error: v.nullable(Text),
});

export type RuntimeSnapshot = v.InferOutput<typeof RuntimeSchema>;
export type RuntimeCandidate = RuntimeSnapshot["candidates"][number];
export type RuntimeResult = RuntimeSnapshot["benchmark"]["results"][number];
export type RuntimeReply =
  | { kind: "ok"; snapshot: RuntimeSnapshot }
  | { kind: "unavailable" | "invalid" | "rejected"; message?: string };
export type RuntimeAction = "benchmark" | "cancel" | "config";

export function runtimeReady(s: RuntimeSnapshot): boolean {
  return s.state === "ready" && !s.needs_selection && s.active_id !== null && s.selected_id === s.active_id;
}

export function runtimeBusy(s: RuntimeSnapshot): boolean {
  return s.state === "loading" || s.state === "benchmarking" || s.benchmark.status === "running";
}

/** Ready pages ask infrequently; unfinished setup remains live while it is visible. */
export function runtimePollMs(s?: RuntimeSnapshot): number {
  return s && runtimeReady(s) && !runtimeBusy(s) ? 15_000 : s ? 1_000 : 5_000;
}

export function canApplyRuntime(s: RuntimeSnapshot, id: string | null): boolean {
  return !runtimeBusy(s) && id !== null && s.candidates.some((c) => c.id === id && c.available) &&
    (!runtimeReady(s) || id !== s.selected_id);
}

export function parseRuntime(body: unknown): RuntimeSnapshot | null {
  const parsed = v.safeParse(RuntimeSchema, body);
  if (!parsed.success) return null;
  const s = parsed.output;
  const ids = new Set(s.candidates.map((c) => c.id));
  if (ids.size !== s.candidates.length) return null;
  if ([s.active_id, s.selected_id, s.recommended_id, s.benchmark.current_id].some((id) => id !== null && !ids.has(id))) return null;
  if (s.benchmark.results.some((r) => !ids.has(r.candidate_id))) return null;
  return s;
}

