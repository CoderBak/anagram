// lib/webengine/fasttext.ts — fastText's language identification (lid.176.ftz) in the browser.
//
// The native engine gates every paragraph with fastText (anagramd/engine.py LanguageId):
// the top label of the quantized 176-language model, and its probability. This is a port
// of the prediction path of fastText (https://github.com/facebookresearch/fastText, MIT,
// Copyright (c) 2016-present, Facebook, Inc.): the .ftz reader (args, dictionary, the
// product-quantized input matrix, the output matrix), the dictionary's word and
// character-n-gram lookup with its pruning table, the averaged hidden vector, and the
// hierarchical-softmax search over the Huffman tree that the label counts rebuild. The
// arithmetic follows the C++ in single precision (`real` is float), step by step, so that
// the probability agrees with the native gate after its rounding to three places.
// test/webengine/lid-check.mjs compares both on a multilingual sample.

const MAGIC = 793712314;
const VERSION = 12;
const EOS = "</s>";
const BOW = "<";
const EOW = ">";
const LABEL_PREFIX = "__label__";
const KSUB = 256;
/** Loss and model enumerations as args.h numbers them. */
const LOSS_HS = 1;
const MODEL_SUPERVISED = 3;

const fround = Math.fround;

/** Python-side text → the bytes fastText reads, as a latin-1 string for hashing and lookup. */
const encoder = new TextEncoder();

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Dictionary::hash: FNV-1a over the bytes, each taken as a signed char. */
function hash(bytes: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ ((bytes[i] << 24) >> 24)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

class Reader {
  private readonly view: DataView;
  offset = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  int32(): number { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  int64(): number { const v = Number(this.view.getBigInt64(this.offset, true)); this.offset += 8; return v; }
  float64(): number { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }
  bool(): boolean { return this.bytes[this.offset++] !== 0; }
  uint8s(count: number): Uint8Array { const v = this.bytes.subarray(this.offset, this.offset + count); this.offset += count; return v; }
  float32s(count: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getFloat32(this.offset + 4 * i, true);
    this.offset += 4 * count;
    return out;
  }
  /** A NUL-terminated byte string. */
  cstring(): Uint8Array {
    let end = this.offset;
    while (this.bytes[end] !== 0) end++;
    const out = this.bytes.subarray(this.offset, end);
    this.offset = end + 1;
    return out;
  }
}

interface Matrix {
  rows: number;
  /** DenseMatrix::addRowToVector / QuantMatrix::addRowToVector with a = 1. */
  addRowToVector(x: Float32Array, row: number): void;
  /** dotRow(vec, row). */
  dotRow(vec: Float32Array, row: number): number;
}

class ProductQuantizer {
  readonly dim: number;
  readonly nsubq: number;
  readonly dsub: number;
  readonly lastdsub: number;
  readonly centroids: Float32Array;
  constructor(r: Reader) {
    this.dim = r.int32();
    this.nsubq = r.int32();
    this.dsub = r.int32();
    this.lastdsub = r.int32();
    this.centroids = r.float32s(this.dim * KSUB);
  }
  centroidOffset(m: number, code: number): number {
    return m === this.nsubq - 1 ? m * KSUB * this.dsub + code * this.lastdsub : (m * KSUB + code) * this.dsub;
  }
  addcode(x: Float32Array, codes: Uint8Array, row: number, alpha: number): void {
    let d = this.dsub;
    const base = this.nsubq * row;
    for (let m = 0; m < this.nsubq; m++) {
      const c = this.centroidOffset(m, codes[base + m]);
      if (m === this.nsubq - 1) d = this.lastdsub;
      for (let n = 0; n < d; n++) {
        const at = m * this.dsub + n;
        x[at] = fround(x[at] + alpha * this.centroids[c + n]);
      }
    }
  }
  mulcode(x: Float32Array, codes: Uint8Array, row: number, alpha: number): number {
    let res = 0;
    let d = this.dsub;
    const base = this.nsubq * row;
    for (let m = 0; m < this.nsubq; m++) {
      const c = this.centroidOffset(m, codes[base + m]);
      if (m === this.nsubq - 1) d = this.lastdsub;
      for (let n = 0; n < d; n++) res = fround(res + x[m * this.dsub + n] * this.centroids[c + n]);
    }
    return fround(res * alpha);
  }
}

class QuantMatrix implements Matrix {
  readonly rows: number;
  readonly cols: number;
  private readonly qnorm: boolean;
  private readonly codes: Uint8Array;
  private readonly pq: ProductQuantizer;
  private readonly normCodes: Uint8Array | null = null;
  private readonly npq: ProductQuantizer | null = null;
  constructor(r: Reader) {
    this.qnorm = r.bool();
    this.rows = r.int64();
    this.cols = r.int64();
    const codesize = r.int32();
    this.codes = r.uint8s(codesize);
    this.pq = new ProductQuantizer(r);
    if (this.qnorm) {
      this.normCodes = r.uint8s(this.rows);
      this.npq = new ProductQuantizer(r);
    }
  }
  private norm(row: number): number {
    if (!this.qnorm) return 1;
    return this.npq!.centroids[this.npq!.centroidOffset(0, this.normCodes![row])];
  }
  addRowToVector(x: Float32Array, row: number): void { this.pq.addcode(x, this.codes, row, this.norm(row)); }
  dotRow(vec: Float32Array, row: number): number { return this.pq.mulcode(vec, this.codes, row, this.norm(row)); }
}

class DenseMatrix implements Matrix {
  readonly rows: number;
  readonly cols: number;
  private readonly data: Float32Array;
  constructor(r: Reader) {
    this.rows = r.int64();
    this.cols = r.int64();
    this.data = r.float32s(this.rows * this.cols);
  }
  addRowToVector(x: Float32Array, row: number): void {
    const base = row * this.cols;
    for (let j = 0; j < this.cols; j++) x[j] = fround(x[j] + this.data[base + j]);
  }
  dotRow(vec: Float32Array, row: number): number {
    const base = row * this.cols;
    let d = 0;
    for (let j = 0; j < this.cols; j++) d = fround(d + this.data[base + j] * vec[j]);
    return d;
  }
}

interface Entry { word: Uint8Array; count: number; label: boolean; subwords: number[] }

/** Loss::std_log(x): log(x + 1e-5) on a float argument, returned as a float. */
const stdLog = (x: number): number => fround(Math.log(fround(x) + 1e-5));

export interface Prediction { label: string; prob: number }

export class FastText {
  private readonly dim: number;
  private readonly wordNgrams: number;
  private readonly bucket: number;
  private readonly minn: number;
  private readonly maxn: number;
  private readonly entries: Entry[] = [];
  private readonly ids = new Map<string, number>();
  private readonly nwords: number;
  private readonly nlabels: number;
  private readonly pruneidxSize: number;
  private readonly pruneidx = new Map<number, number>();
  private readonly input: Matrix;
  private readonly output: Matrix;
  /** The Huffman tree over the labels: left and right child per node, leaves first. */
  private readonly left: Int32Array;
  private readonly right: Int32Array;

  constructor(bytes: Uint8Array) {
    const r = new Reader(bytes);
    if (r.int32() !== MAGIC) throw new Error("not a fastText model");
    if (r.int32() > VERSION) throw new Error("fastText model is newer than this reader");
    this.dim = r.int32();
    r.int32(); r.int32(); r.int32(); r.int32(); // ws, epoch, minCount, neg
    this.wordNgrams = r.int32();
    const loss = r.int32();
    const model = r.int32();
    this.bucket = r.int32();
    this.minn = r.int32();
    this.maxn = r.int32();
    r.int32(); // lrUpdateRate
    r.float64(); // t
    if (model !== MODEL_SUPERVISED || loss !== LOSS_HS) throw new Error("only supervised hierarchical-softmax fastText models are read");
    // Dictionary::load
    const size = r.int32();
    this.nwords = r.int32();
    this.nlabels = r.int32();
    r.int64(); // ntokens
    this.pruneidxSize = r.int64();
    for (let i = 0; i < size; i++) {
      const word = r.cstring();
      const count = r.int64();
      const label = r.bytes[r.offset++] === 1;
      this.entries.push({ word, count, label, subwords: [] });
    }
    for (let i = 0; i < this.pruneidxSize; i++) {
      const first = r.int32();
      this.pruneidx.set(first, r.int32());
    }
    this.entries.forEach((entry, i) => this.ids.set(latin1(entry.word), i));
    // Dictionary::initNgrams
    const eos = encoder.encode(EOS);
    for (let i = 0; i < size; i++) {
      const entry = this.entries[i];
      entry.subwords.push(i);
      if (latin1(entry.word) !== latin1(eos)) this.computeSubwords(this.wrap(entry.word), entry.subwords);
    }
    const quantInput = r.bool();
    this.input = quantInput ? new QuantMatrix(r) : new DenseMatrix(r);
    const qout = r.bool();
    this.output = quantInput && qout ? new QuantMatrix(r) : new DenseMatrix(r);
    if (this.output.rows < this.nlabels - 1) throw new Error("fastText output matrix does not match the label tree");
    // HierarchicalSoftmaxLoss::buildTree over the label counts.
    const osz = this.nlabels;
    const nodes = 2 * osz - 1;
    const count = new Float64Array(nodes).fill(1e15);
    this.left = new Int32Array(nodes).fill(-1);
    this.right = new Int32Array(nodes).fill(-1);
    for (let i = 0; i < osz; i++) count[i] = this.entries[this.nwords + i].count;
    let leaf = osz - 1;
    let node = osz;
    for (let i = osz; i < nodes; i++) {
      const mini = [0, 0];
      for (let j = 0; j < 2; j++) {
        if (leaf >= 0 && count[leaf] < count[node]) mini[j] = leaf--;
        else mini[j] = node++;
      }
      this.left[i] = mini[0];
      this.right[i] = mini[1];
      count[i] = count[mini[0]] + count[mini[1]];
    }
  }

  private wrap(word: Uint8Array): Uint8Array {
    const out = new Uint8Array(word.length + 2);
    out[0] = BOW.charCodeAt(0);
    out.set(word, 1);
    out[out.length - 1] = EOW.charCodeAt(0);
    return out;
  }

  private pushHash(hashes: number[], id: number): void {
    if (this.pruneidxSize === 0 || id < 0) return;
    if (this.pruneidxSize > 0) {
      const mapped = this.pruneidx.get(id);
      if (mapped === undefined) return;
      id = mapped;
    }
    hashes.push(this.nwords + id);
  }

  /** Dictionary::computeSubwords: the character n-grams of a word, on its UTF-8 bytes. */
  private computeSubwords(word: Uint8Array, ngrams: number[]): void {
    for (let i = 0; i < word.length; i++) {
      if ((word[i] & 0xc0) === 0x80) continue;
      const ngram: number[] = [];
      for (let j = i, n = 1; j < word.length && n <= this.maxn; n++) {
        ngram.push(word[j++]);
        while (j < word.length && (word[j] & 0xc0) === 0x80) ngram.push(word[j++]);
        if (n >= this.minn && !(n === 1 && (i === 0 || j === word.length))) {
          this.pushHash(ngrams, hash(Uint8Array.from(ngram)) % this.bucket);
        }
      }
    }
  }

  /** Dictionary::readWord over the whole input: tokens, with "</s>" for each newline. */
  private static tokens(bytes: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    const eos = encoder.encode(EOS);
    let start = -1;
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      const separator = c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0b || c === 0x0c || c === 0;
      if (!separator) { if (start < 0) start = i; continue; }
      if (start >= 0) { out.push(bytes.subarray(start, i)); start = -1; }
      if (c === 0x0a) out.push(eos);
    }
    if (start >= 0) out.push(bytes.subarray(start));
    return out;
  }

  /** Dictionary::getLine: the input ids of a text (its words, their n-grams, word n-grams). */
  private line(text: string): number[] {
    const words: number[] = [];
    const wordHashes: number[] = [];
    for (const token of FastText.tokens(encoder.encode(text))) {
      const key = latin1(token);
      const h = hash(token);
      const wid = this.ids.get(key) ?? -1;
      const label = wid < 0 ? key.startsWith(LABEL_PREFIX) : this.entries[wid].label;
      if (!label) {
        // Dictionary::addSubwords
        if (wid < 0) { if (key !== EOS) this.computeSubwords(this.wrap(token), words); }
        else if (this.maxn <= 0) words.push(wid);
        else words.push(...this.entries[wid].subwords);
        wordHashes.push(h);
      }
      if (key === EOS) break;
    }
    // Dictionary::addWordNgrams
    for (let i = 0; i < wordHashes.length; i++) {
      let h = wordHashes[i];
      for (let j = i + 1; j < wordHashes.length && j < i + this.wordNgrams; j++) {
        // uint64 arithmetic in C++; the product stays exact below 2^53 only when reduced first.
        h = Number((BigInt(h) * 116049371n + BigInt(wordHashes[j])) & 0xffffffffffffffffn);
        this.pushHash(words, Number(BigInt(h) % BigInt(this.bucket)));
      }
    }
    return words;
  }

  /** FastText::predictLine with k = 1 and threshold 0: the top label and its probability, or null. */
  predict(text: string): Prediction | null {
    const words = this.line(text);
    if (words.length === 0) return null;
    // Model::computeHidden: the average of the input rows.
    const hidden = new Float32Array(this.dim);
    for (const row of words) this.input.addRowToVector(hidden, row);
    const scale = fround(1 / words.length);
    for (let i = 0; i < this.dim; i++) hidden[i] = fround(hidden[i] * scale);
    // HierarchicalSoftmaxLoss::dfs from the root, keeping the best leaf; a later leaf of
    // the same score replaces an earlier one, as the C++ heap does.
    const osz = this.nlabels;
    const floor = stdLog(0);
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestLeaf = -1;
    const dfs = (node: number, score: number): void => {
      if (score < floor) return;
      if (bestLeaf >= 0 && score < bestScore) return;
      if (this.left[node] === -1 && this.right[node] === -1) {
        bestScore = score;
        bestLeaf = node;
        return;
      }
      // C++: f = 1. / (1 + std::exp(-f)) on a float f, so expf and a float sum, then a double division.
      let f = this.output.dotRow(hidden, node - osz);
      f = fround(1 / fround(1 + fround(Math.exp(-f))));
      dfs(this.left[node], fround(score + stdLog(1 - f)));
      dfs(this.right[node], fround(score + stdLog(f)));
    };
    dfs(2 * osz - 2, 0);
    if (bestLeaf < 0) return null;
    const label = new TextDecoder().decode(this.entries[this.nwords + bestLeaf].word);
    // FastText::predictLine: std::exp on the float score, so a float probability.
    return { label: label.startsWith(LABEL_PREFIX) ? label.slice(LABEL_PREFIX.length) : label, prob: fround(Math.exp(bestScore)) };
  }
}
