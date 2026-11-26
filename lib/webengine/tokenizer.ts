// lib/webengine/tokenizer.ts — the modelkit's tokenizer.json, read as Hugging Face's
// `tokenizers` library reads it.
//
// EditLens is RoBERTa-large, so the tokenizer is GPT-2's byte-level BPE: the text is cut
// by one regular expression into pieces (a word with its leading space, a number, a run
// of punctuation), each piece is spelt as one printable character per UTF-8 byte, and
// the byte characters are merged pairwise by the learned ranks until no merge applies.
// The five added tokens ("<s>", "<pad>", "</s>", "<unk>", "<mask>") are looked for in
// the text first, as the library does. Nothing here is adapted from another
// implementation; the algorithm is the published one and the results are compared with
// the Python library on the whole official data set (test/webengine/tokenizer-check.py).

/** The GPT-2 pre-tokenizer's whitespace, Oniguruma's `\s`: Unicode White_Space. */
const WS = "\\t\\n\\x0b\\x0c\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PRETOKENIZE = new RegExp(
  `'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^${WS}\\p{L}\\p{N}]+|[${WS}]+(?![^${WS}])|[${WS}]+`,
  "gu",
);
const WHITESPACE = new RegExp(`[${WS}]`, "u");

/** GPT-2's bytes_to_unicode: every byte as one printable character. */
function byteAlphabet(): string[] {
  const table: string[] = new Array(256);
  let next = 256;
  for (let b = 0; b < 256; b++) {
    const printable = (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174 && b <= 255);
    table[b] = String.fromCharCode(printable ? b : next++);
  }
  return table;
}

interface AddedToken { id: number; content: string; lstrip: boolean; rstrip: boolean; single_word: boolean }

export interface TokenizerFile {
  normalizer?: {type:string} | null;
  added_tokens: AddedToken[];
  pre_tokenizer: { type: string; add_prefix_space: boolean; use_regex?: boolean } | null;
  post_processor: { type: string; sep: [string, number]; cls: [string, number] } | null;
  model: { type: string; vocab: Record<string, number>; merges: Array<[string, string] | string> };
}

export class Tokenizer {
  private readonly vocab: Map<string, number>;
  private readonly ranks = new Map<string, number>();
  private readonly bytes = byteAlphabet();
  private readonly encoder = new TextEncoder();
  private readonly addedBySpelling = new Map<string, AddedToken>();
  private readonly addedPattern: RegExp;
  private readonly cache = new Map<string, number[]>();
  private readonly widths = new Map<number,number>();
  private readonly nfc: boolean;
  readonly clsId: number;
  readonly sepId: number;
  readonly padId: number;

  constructor(file: TokenizerFile) {
    if (file.model.type !== "BPE") throw new Error(`tokenizer model ${file.model.type} is not BPE`);
    if (file.pre_tokenizer?.type !== "ByteLevel" || file.pre_tokenizer.add_prefix_space) throw new Error("tokenizer is not byte-level without a prefix space");
    this.nfc = file.normalizer?.type === "NFC";
    if (!["RobertaProcessing","TemplateProcessing"].includes(file.post_processor?.type ?? "")) throw new Error("tokenizer has no RoBERTa post-processor");
    this.vocab = new Map(Object.entries(file.model.vocab));
    file.model.merges.forEach((merge, rank) => {
      const [a, b] = Array.isArray(merge) ? merge : merge.split(" ");
      this.ranks.set(`${a}\u0000${b}`, rank);
    });
    // Regex alternatives at the same position are tried in order. Escape each spelling
    // as a literal so normal prose can skip straight to the next actual added token.
    for (const token of file.added_tokens.toSorted((x, y) => y.content.length - x.content.length)) {
      if (token.content && !this.addedBySpelling.has(token.content)) this.addedBySpelling.set(token.content, token);
    }
    const spellings = [...this.addedBySpelling.keys()].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.addedPattern = new RegExp(spellings.join("|") || "(?!)", "g");
    const special = (name:string) => file.added_tokens.find(t=>t.content===name);
    this.clsId = file.post_processor?.cls?.[1] ?? special("[CLS]")?.id ?? -1;
    this.sepId = file.post_processor?.sep?.[1] ?? special("[SEP]")?.id ?? -1;
    if (this.clsId < 0 || this.sepId < 0) throw new Error("Missing sequence tokens");
    for (const [token,id] of this.vocab) this.widths.set(id,Array.from(token).length);
    for (const token of file.added_tokens) this.widths.set(token.id,this.encoder.encode(token.content).length);
    const pad = special("<pad>") ?? special("[PAD]");
    if (!pad) throw new Error("tokenizer has no <pad> token");
    this.padId = pad.id;
  }

  /** The library's encode(text, add_special_tokens): token ids. */
  encode(text: string, addSpecialTokens: boolean): number[] {
    if (this.nfc) text = text.normalize("NFC");
    const ids: number[] = [];
    if (addSpecialTokens) ids.push(this.clsId);
    let from = 0;
    for (const match of this.addedMatches(text)) {
      this.encodeText(text.slice(from, match.start), ids);
      ids.push(match.id);
      from = match.end;
    }
    this.encodeText(text.slice(from), ids);
    if (addSpecialTokens) ids.push(this.sepId);
    return ids;
  }

  /** Character offsets for the release's byte-level vocabulary, including split Unicode scalars. */
  offsets(text: string, ids: number[]): [number,number][] {
    let tokenEnd = 0, scalarEnd = 0, units = 0, scalars = 0;
    const offsets = ids.map((id): [number, number] => {
      // If the previous token ended inside a scalar, this token shares its start.
      const start = tokenEnd < scalarEnd ? scalars - 1 : scalars;
      tokenEnd += this.widths.get(id) ?? 0;
      while (scalarEnd < tokenEnd && units < text.length) {
        const cp = text.codePointAt(units)!;
        units += cp > 0xffff ? 2 : 1;
        scalarEnd += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp <= 0xffff ? 3 : 4;
        scalars++;
      }
      return [start, scalars];
    });
    if (tokenEnd !== scalarEnd || units !== text.length) throw new Error("Tokenizer offsets do not match the passage");
    return offsets;
  }

  /** Leftmost-longest occurrences of the added tokens, with their strip rules applied. */
  private addedMatches(text: string): Array<{ start: number; end: number; id: number }> {
    const out: Array<{ start: number; end: number; id: number }> = [];
    this.addedPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = this.addedPattern.exec(text)) !== null) {
      const found = this.addedBySpelling.get(match[0])!;
      let start = match.index;
      let end = this.addedPattern.lastIndex;
      if (found.single_word) {
        const before = start > 0 ? text[start - 1] : "";
        const after = end < text.length ? text[end] : "";
        if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) { this.addedPattern.lastIndex = start + 1; continue; }
      }
      if (found.lstrip) while (start > 0 && WHITESPACE.test(text[start - 1]!)) start--;
      if (found.rstrip) while (end < text.length && WHITESPACE.test(text[end]!)) end++;
      const previous = out[out.length - 1];
      if (previous && previous.end > start) previous.end = start;
      out.push({ start, end, id: found.id });
      this.addedPattern.lastIndex = end;
    }
    return out;
  }

  private encodeText(text: string, ids: number[]): void {
    if (!text) return;
    for (const piece of text.match(PRETOKENIZE) ?? []) {
      const cached = this.cache.get(piece);
      if (cached) { ids.push(...cached); continue; }
      let word = "";
      for (const byte of this.encoder.encode(piece)) word += this.bytes[byte];
      const pieceIds = this.bpe(word);
      if (this.cache.size >= 50_000) this.cache.clear();
      this.cache.set(piece, pieceIds);
      ids.push(...pieceIds);
    }
  }

  private bpe(word: string): number[] {
    const whole = this.vocab.get(word);
    if (whole !== undefined) return [whole];
    let symbols = Array.from(word);
    for (;;) {
      let best = Number.POSITIVE_INFINITY;
      let at = -1;
      for (let i = 0; i + 1 < symbols.length; i++) {
        const rank = this.ranks.get(`${symbols[i]}\u0000${symbols[i + 1]}`);
        if (rank !== undefined && rank < best) { best = rank; at = i; }
      }
      if (at < 0) break;
      // `at` is a pair the loop above found, so both symbols exist.
      const first = symbols[at]!;
      const second = symbols[at + 1]!;
      const merged: string[] = [];
      for (let i = 0; i < symbols.length; i++) {
        if (i + 1 < symbols.length && symbols[i] === first && symbols[i + 1] === second) { merged.push(first + second); i++; }
        else merged.push(symbols[i]!);
      }
      symbols = merged;
      if (symbols.length === 1) break;
    }
    return symbols.map((symbol) => {
      const id = this.vocab.get(symbol);
      if (id === undefined) throw new Error(`tokenizer vocabulary has no entry for ${JSON.stringify(symbol)}`);
      return id;
    });
  }
}
