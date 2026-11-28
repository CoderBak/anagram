import { config as qwenLayerConfig, rope as qwenRope } from "../anagramd/qwen-graphs.json";

export interface DetectorMeta {
  format: string;
  classes: string[];
  decoder?: string;
  architecture?: "modernbert" | "qwen3_5_text";
  release_id?: string;
  copies?: number;
  document_fraction_basis?: "all_labeled_characters";
  heads: string[];
  language: string;
  release_date: string;
  size: string;
  window: number;
  stride: number;
  min_words: number;
}
/** Applies the published verdict thresholds to counts or length-weighted shares. */
export function labeledCharacterBucket(shares: readonly number[], total: number): number {
  const tolerance = 32 * Number.EPSILON * total;
  if (10 * shares[0]! >= 9 * total - tolerance) return 0;
  return 5 * (2 * shares[2]! + shares[1]!) >= 8 * total - tolerance ? 2 : 1;
}

export interface Crf {
  W: number[][];
  alpha: number[];
  delta: number[];
  lambda: number;
  gamma: number;
  l_min: number;
}
export interface DetectorConfig {
  model_type: string;
  num_hidden_layers?: number;
  vocab_size?: number;
  global_attn_every_n_layers?: number;
  global_rope_theta?: number;
  local_rope_theta?: number;
  hidden_activation: string;
  norm_eps: number;
  attention_bias: boolean;
  mlp_bias: boolean;
  norm_bias: boolean;
  is_causal: boolean;
  hidden_size: number;
  num_attention_heads: number;
  local_attention: number;
  layer_types: string[];
  rope_parameters: Record<string, { rope_type: string; rope_theta: number }>;
}
export function checkDetector(meta: DetectorMeta, crf: Crf, release: string) {
  if (
    meta.format !== "anagram-detector/1" ||
    meta.classes.join(",") !== "human,ai_assisted,ai_generated" ||
    meta.heads.join(",") !== "token,segment,mixed" ||
    (meta.decoder !== "linear_chain_crf" && !(meta.decoder === undefined && meta.release_id === release && meta.document_fraction_basis === "all_labeled_characters")) ||
    (meta.release_id !== undefined && meta.release_id !== release) ||
    (meta.architecture !== undefined && !["modernbert", "qwen3_5_text"].includes(meta.architecture)) ||
    (meta.architecture === "qwen3_5_text" && meta.copies !== 2) ||
    (meta.document_fraction_basis !== undefined && meta.document_fraction_basis !== "all_labeled_characters") ||
    meta.language !== "en" ||
    release.split("-").slice(0, 4).join("-") !== meta.release_date + "-" + meta.size ||
    !Number.isInteger(meta.window) ||
    !Number.isInteger(meta.stride) ||
    meta.window > 2048 ||
    meta.stride < 1 ||
    meta.stride > meta.window ||
    !Number.isInteger(meta.min_words) ||
    meta.min_words < 1 ||
    meta.min_words > 10000 ||
    !Number.isInteger(crf.l_min) ||
    crf.l_min < 1 ||
    crf.l_min > meta.window ||
    crf.W.length !== 3 ||
    crf.W.some((w) => w.length !== 6) ||
    crf.alpha.length !== 3 ||
    crf.delta.length !== 3 ||
    ![...crf.W.flat(), ...crf.alpha, ...crf.delta, crf.lambda, crf.gamma].every(Number.isFinite)
  )
    throw new Error("Unsupported detector release");
}
/** Transformers 4 serializes the attention cadence and rotary frequencies as scalars. */
export function modernBertConfig(cfg: DetectorConfig): DetectorConfig {
  const layers = cfg.num_hidden_layers ?? 0, every = cfg.global_attn_every_n_layers ?? 0;
  const full = cfg.global_rope_theta ?? 0, sliding = cfg.local_rope_theta ?? 0;
  return {
    ...cfg,
    layer_types: cfg.layer_types ?? (Number.isInteger(layers) && layers > 0 && layers <= 128 && Number.isInteger(every) && every > 0
      ? Array.from({length: layers}, (_, i) => i % every === 0 ? "full_attention" : "sliding_attention") : []),
    rope_parameters: cfg.rope_parameters ?? {
      full_attention: {rope_type: "default", rope_theta: full}, sliding_attention: {rope_type: "default", rope_theta: sliding},
    },
  };
}
export function checkBackbone(input: DetectorConfig, window: number, architecture = "modernbert") {
  if (input.model_type !== architecture) throw new Error("Detector architecture does not match its backbone");
  if (architecture === "qwen3_5_text") {
    checkQwenConfig(input, window);
    return;
  }
  const cfg = modernBertConfig(input);
  const dim = cfg.hidden_size / cfg.num_attention_heads,
    width = window + 2;
  if (
    cfg.model_type !== "modernbert" ||
    cfg.hidden_activation !== "gelu" ||
    cfg.norm_eps !== 1e-5 ||
    cfg.attention_bias ||
    cfg.mlp_bias ||
    cfg.norm_bias ||
    cfg.is_causal ||
    !Number.isInteger(dim) ||
    dim < 2 ||
    dim > 256 ||
    dim % 2 ||
    !Number.isInteger(width) ||
    width < 3 ||
    width > 2050 ||
    !["full_attention", "sliding_attention"].every(k => cfg.rope_parameters[k]?.rope_type === "default" && Number.isFinite(cfg.rope_parameters[k]?.rope_theta) && cfg.rope_parameters[k]!.rope_theta > 0) ||
    !cfg.layer_types.every((k) => k === "full_attention" || k === "sliding_attention") ||
    cfg.layer_types.length > 128 ||
    cfg.layer_types[0] !== "full_attention"
  )
    throw new Error("Unsupported detector configuration");
}

// The packaged graph implements the text-only 0.8B layer shapes. The checkpoint specifies their order.
export function checkQwenConfig(cfg: DetectorConfig, window: number) {
  const c = cfg as unknown as Record<string, unknown>;
  const rope = c.rope_parameters as Record<string, unknown> | undefined;
  if (!Object.entries(qwenLayerConfig).every(([key, value]) => c[key] === value) ||
      !Object.entries(qwenRope).every(([key, value]) => rope?.[key] === value) ||
      !Number.isSafeInteger(cfg.vocab_size) || (cfg.vocab_size ?? 0) < 1 ||
      !Array.isArray(cfg.layer_types) || cfg.layer_types.length !== c.num_hidden_layers || cfg.layer_types.length < 1 || cfg.layer_types.length > 128 ||
      cfg.layer_types.some(kind => kind !== "linear_attention" && kind !== "full_attention") ||
      !Number.isInteger(window) || window < 1 || window > 512) throw new Error("Unsupported Qwen detector configuration");
}
