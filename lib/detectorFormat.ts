export interface DetectorMeta {
  format: string;
  classes: string[];
  decoder: string;
  heads: string[];
  language: string;
  release_date: string;
  size: string;
  window: number;
  stride: number;
  min_words: number;
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
    meta.decoder !== "linear_chain_crf" ||
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
export function checkBackbone(cfg: DetectorConfig, window: number) {
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
    !cfg.layer_types.every((k) => k === "full_attention" || k === "sliding_attention") ||
    cfg.layer_types.length > 128 ||
    cfg.layer_types[0] !== "full_attention"
  )
    throw new Error("Unsupported detector configuration");
}
