// test/fixtures/webengine/tinyTokenizer.mjs — a small tokenizer.json of the modelkit's shape.
//
// The byte-level alphabet (256 tokens), RoBERTa's five special tokens and a handful of
// merges, so lib/webengine/tokenizer.ts runs the real algorithm on something the suite
// can reason about. The ids are stable: the tiny ONNX model (make-fixtures.py) reads
// them as rows of its table, TINY_VOCAB_SIZE rows in all.
export const TINY_VOCAB_SIZE = 300;

/** GPT-2's bytes_to_unicode, as lib/webengine/tokenizer.ts spells bytes. */
function byteAlphabet() {
  const table = [];
  let next = 256;
  for (let b = 0; b < 256; b++) {
    const printable = (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
    table.push(String.fromCharCode(printable ? b : next++));
  }
  return table;
}

export const TINY_MERGES = [
  ["t", "h"], ["th", "e"], ["Ġ", "t"], ["Ġt", "he"], ["h", "e"], ["Ġ", "a"], ["i", "n"], ["Ġ", "the"],
  ["r", "e"], ["o", "n"], ["a", "n"], ["an", "d"], ["Ġ", "and"], ["e", "r"], ["Ġ", "w"], ["Ġw", "or"], ["o", "r"],
  ["Ġwor", "d"], ["'", "s"], ["1", "2"], ["12", "3"],
];

export function tinyTokenizerJson() {
  const vocab = {};
  let id = 0;
  const specials = ["<s>", "<pad>", "</s>", "<unk>"];
  for (const s of specials) vocab[s] = id++;
  for (const char of byteAlphabet()) vocab[char] = id++;
  for (const [a, b] of TINY_MERGES) if (!(a + b in vocab)) vocab[a + b] = id++;
  vocab["<mask>"] = id++;
  if (id > TINY_VOCAB_SIZE) throw new Error(`tiny vocabulary has ${id} entries; TINY_VOCAB_SIZE is ${TINY_VOCAB_SIZE}`);
  const added = (content, i, lstrip = false) => ({ id: i, content, single_word: false, lstrip, rstrip: false, normalized: true, special: true });
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: [added("<s>", 0), added("<pad>", 1), added("</s>", 2), added("<unk>", 3), added("<mask>", vocab["<mask>"], true)],
    normalizer: null,
    pre_tokenizer: { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: true },
    post_processor: { type: "RobertaProcessing", sep: ["</s>", 2], cls: ["<s>", 0], trim_offsets: true, add_prefix_space: false },
    decoder: { type: "ByteLevel", add_prefix_space: true, trim_offsets: true, use_regex: true },
    model: { type: "BPE", dropout: null, unk_token: null, continuing_subword_prefix: "", end_of_word_suffix: "", fuse_unk: false, byte_fallback: false, ignore_merges: false, vocab, merges: TINY_MERGES },
  };
}
