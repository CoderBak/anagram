export const TINY_VOCAB_SIZE: number;
export const TINY_MERGES: Array<[string, string]>;
export function tinyTokenizerJson(): {
  version: string;
  truncation: null;
  padding: null;
  added_tokens: Array<{ id: number; content: string; single_word: boolean; lstrip: boolean; rstrip: boolean; normalized: boolean; special: boolean }>;
  normalizer: null;
  pre_tokenizer: { type: string; add_prefix_space: boolean; trim_offsets: boolean; use_regex: boolean };
  post_processor: { type: string; sep: [string, number]; cls: [string, number]; trim_offsets: boolean; add_prefix_space: boolean };
  decoder: { type: string; add_prefix_space: boolean; trim_offsets: boolean; use_regex: boolean };
  model: { type: string; dropout: null; unk_token: null; continuing_subword_prefix: string; end_of_word_suffix: string; fuse_unk: boolean; byte_fallback: boolean; ignore_merges: boolean; vocab: Record<string, number>; merges: Array<[string, string]> };
};
