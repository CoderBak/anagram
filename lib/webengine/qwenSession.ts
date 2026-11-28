// The checkpoint's two decoder layer types share graphs across all their layers.
// Only the selected embedding rows are read. Opening one layer at a time bounds
// temporary memory when its BF16 weights are widened for ONNX Runtime.
import graphs from "../../anagramd/qwen-graphs.json";
import { checkQwenConfig, type DetectorConfig } from "../detectorFormat";
import type { OrtModule, OrtSession, OrtTensor } from "./session";
import type { Heads } from "./detectorScore";

type TensorHeader = {shape: number[]; dtype: string; data_offsets: [number, number]};
class Weights {
  private constructor(private file: Blob, private start: number, private table: Record<string, TensorHeader>, private dtype: "BF16" | "F32") {}

  static async open(file: Blob, dtype: "BF16" | "F32") {
    const size = Number(new DataView(await file.slice(0, 8).arrayBuffer()).getBigUint64(0, true));
    if (size < 1 || size > 2**20 || size + 8 > file.size) throw new Error("Invalid Qwen weight header");
    return new Weights(file, 8 + size, JSON.parse(await file.slice(8, 8 + size).text()), dtype);
  }

  slice(name: string, shape: number[]): Blob {
    const header = this.table[name];
    if (!header || header.dtype !== this.dtype || !Array.isArray(header.shape) ||
        header.shape.length !== shape.length || !shape.every((n,i) => Number.isSafeInteger(n) && n > 0 && n === header.shape[i]))
      throw new Error(`Unexpected Qwen tensor ${name}`);
    const [start, end] = header.data_offsets;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || this.start + end > this.file.size ||
        end-start !== shape.reduce((a,b)=>a*b, this.dtype === "F32" ? 4 : 2)) throw new Error(`Invalid Qwen tensor size: ${name}`);
    return this.file.slice(this.start + start, this.start + end);
  }
}

async function widenBF16(data: Blob): Promise<Float32Array<ArrayBuffer>> {
  const words = new Uint16Array(await data.arrayBuffer());
  const bits = new Uint32Array(words.length);
  for (let i = 0; i < words.length; i++) bits[i] = words[i]! << 16;
  return new Float32Array(bits.buffer);
}

export class QwenSession {
  private layers: OrtSession[] = [];
  private constructor(private ort: OrtModule, private embedding: Blob, private vocab: number) {}

  static async create(ort: OrtModule, gpu: boolean, cfg: DetectorConfig, window: number,
                      backboneFile: Blob, headFile: Blob, signal: AbortSignal) {
    checkQwenConfig(cfg, window);
    const vocab = cfg.vocab_size!;
    const backbone = await Weights.open(backboneFile, "BF16"), heads = await Weights.open(headFile, "F32");
    const result = new QwenSession(ort, backbone.slice("embed_tokens.weight", [vocab, 1024]), vocab);
    try {
      for (const [index, kind] of [...cfg.layer_types, "heads"].entries()) {
        const spec = graphs[kind as "linear_attention" | "full_attention" | "heads"];
        const externalData = [];
        for (const [name, shape] of Object.entries(spec.weights)) {
          signal.throwIfAborted();
          const isHead = kind === "heads" && name !== "norm.weight";
          const tensor = (isHead ? heads : backbone).slice(kind === "heads" ? name : `layers.${index}.${name}`, shape);
          externalData.push({path: name, data: isHead ? tensor : new Blob([(await widenBF16(tensor)).buffer])});
        }
        const bytes = Uint8Array.from(atob(spec.model), c => c.charCodeAt(0));
        const gpuProvider = kind === "linear_attention"
          ? { name: "webgpu", forceCpuNodeNames: graphs.linear_attention.scanNodes }
          : { name: "webgpu" };
        result.layers.push(await ort.InferenceSession.create(bytes, {externalData, executionProviders: gpu ? [gpuProvider] : ["wasm"],
          graphOptimizationLevel: "all", logSeverityLevel: 3, enableCpuMemArena: false, extra: {session: {disable_prepacking: "1"}}}));
      }
      return result;
    } catch (error) {
      await result.release();
      throw error;
    }
  }

  async heads(ids: number[]): Promise<Heads> {
    if (!ids.length || ids.length > 512) throw new Error("Invalid Qwen window");
    const width = 1024;
    const data = new Float32Array(2 * ids.length * width);
    const rows = new Map<number, Float32Array>();
    for (const [i, id] of ids.entries()) {
      if (!Number.isSafeInteger(id) || id < 0 || id >= this.vocab) throw new Error("Invalid Qwen token ID");
      let row = rows.get(id);
      if (!row) {
        row = await widenBF16(this.embedding.slice(id * width * 2, (id + 1) * width * 2));
        rows.set(id, row);
      }
      data.set(row, i * width);
    }
    data.copyWithin(ids.length * width, 0, ids.length * width);
    let hidden: OrtTensor = new this.ort.Tensor("float32", data, [2 * ids.length, width]);
    try {
      for (const layer of this.layers.slice(0, -1)) {
        const outputs = await layer.run({hidden});
        hidden.dispose?.();
        hidden = outputs.result!;
      }
      const second = (hidden.data as Float32Array).subarray(ids.length * width);
      const pooledInput = new this.ort.Tensor("float32", second, [ids.length, width]);
      try {
        const outputs = await this.layers.at(-1)!.run({hidden: pooledInput});
        try {
          const floats = (name: string) => Float32Array.from(outputs[name]!.data as ArrayLike<number>);
          return {token: floats("token"), segment: floats("segment"), mixed: floats("mixed")};
        } finally { for (const output of Object.values(outputs)) output.dispose?.(); }
      } finally { pooledInput.dispose?.(); }
    } finally { hidden.dispose?.(); }
  }

  async release() {
    const layers = this.layers.splice(0);
    for (const layer of layers) await layer.release();
  }
}
