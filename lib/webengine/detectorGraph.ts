import recipe from "../../anagramd/detector-graph.json";

import { checkBackbone, type DetectorConfig } from "../detectorFormat";
export type { DetectorConfig } from "../detectorFormat";
function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
  }
  return data;
}
function vint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid protobuf integer");
  const bytes = [];
  while (n >= 128) {
    bytes.push((n % 128) + 128);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}
const text = new TextEncoder();
const integer = (key: number, value: number) => join([vint(key * 8), vint(value)]);
function field(key: number, value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? text.encode(value) : value;
  return join([vint(key * 8 + 2), vint(bytes.length), bytes]);
}
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function external(path: string, blob: Blob): Promise<Uint8Array[]> {
  const length = Number(new DataView(await blob.slice(0, 8).arrayBuffer()).getBigUint64(0, true));
  if (length < 1 || length > 2 ** 20) throw new Error("Invalid weight header");
  const table = JSON.parse(await blob.slice(8, 8 + length).text()) as Record<
    string,
    { shape: number[]; dtype: string; data_offsets: [number, number] }
  >;
  return Object.entries(table)
    .filter(([key]) => key !== "__metadata__")
    .map(([key, spec]) => {
      const [start, end] = spec.data_offsets;
      if (
        spec.dtype !== "F32" ||
        start < 0 ||
        !Number.isSafeInteger(end) ||
        !Number.isSafeInteger(start) ||
        end - start !== 4 * spec.shape.reduce((a, b) => a * b, 1) ||
        end + 8 + length > blob.size
      )
        throw new Error("Unsupported detector weights");
      const entries = [
        ["location", path],
        ["offset", String(8 + length + start)],
        ["length", String(end - start)],
      ];
      return field(
        5,
        join([
          ...spec.shape.map((n) => integer(1, n)),
          integer(2, 1),
          field(8, key),
          ...entries.map(([k, v]) => field(13, join([field(1, k!), field(2, v!)]))),
          integer(14, 1),
        ]),
      );
    });
}
export async function detectorGraph(
  cfg: DetectorConfig,
  window: number,
  weights: { path: string; data: Blob }[],
): Promise<Uint8Array<ArrayBuffer>> {
  const dim = cfg.hidden_size / cfg.num_attention_heads,
    width = window + 2;
  checkBackbone(cfg, window);
  const parts = [field(2, "anagram-detector/1")];
  const stages = [
    { key: "start", prefix: "start_", index: 0 },
    ...cfg.layer_types.map((kind, index) => ({ key: index ? kind : "first", prefix: `l${index}_`, index })),
    { key: "end", prefix: "end_", index: 0 },
  ];
  let prev = "";
  for (const { key, prefix, index } of stages) {
    const nodes = (recipe as unknown as Record<string, [string, string[], string[], string[]][]>)[key];
    if (!nodes || !["start", "first", "full_attention", "sliding_attention", "end"].includes(key))
      throw new Error("Unsupported attention layer");
    const name = (s: string) => s.replace("$prev", prev).replace("$p", prefix).replace("$i", String(index));
    for (const [op, inputs, outputs, attrs] of nodes) {
      parts.push(
        field(
          1,
          join([
            ...inputs.map((i) => field(1, name(i))),
            ...outputs.map((o) => field(2, name(o))),
            field(4, op),
            ...attrs.map((a) => field(5, b64(a))),
          ]),
        ),
      );
    }
    prev = name(nodes.at(-1)![2][0]!);
  }
  function constant(name: string, shape: number[], data: Float32Array | BigInt64Array) {
    parts.push(
      field(
        5,
        join([
          ...shape.map((n) => integer(1, n)),
          integer(2, data instanceof Float32Array ? 1 : 7),
          field(8, name),
          field(9, new Uint8Array(data.buffer)),
        ]),
      ),
    );
  }
  constant("qkv_shape", [4], BigInt64Array.from([-1, 3, cfg.num_attention_heads, dim], BigInt));
  constant("hidden_shape", [2], BigInt64Array.from([-1, cfg.hidden_size], BigInt));
  constant("attention_scale", [], Float32Array.of(dim ** -0.5));
  for (let i = 0; i < 3; i++) constant("index" + i, [], BigInt64Array.of(BigInt(i)));
  constant("cls_index", [1], BigInt64Array.of(0n));
  for (const kind of ["full_attention", "sliding_attention"]) {
    const p = cfg.rope_parameters[kind];
    if (p?.rope_type !== "default" || !(p.rope_theta > 0)) throw new Error("Unsupported rotary embedding");
    const cos = new Float32Array(width * dim),
      sin = new Float32Array(width * dim);
    for (let k = 0; k < dim; k++) {
      const freq = p.rope_theta ** ((-2 * (k % (dim / 2))) / dim);
      for (let i = 0; i < width; i++) {
        cos[i * dim + k] = Math.cos(i * freq);
        sin[i * dim + k] = Math.sin(i * freq);
      }
    }
    constant(kind + "cos", [width, dim], cos);
    constant(kind + "sin", [width, dim], sin);
  }
  const mask = new Float32Array(width * width);
  for (let i = 0; i < width; i++)
    for (let j = 0; j < width; j++)
      if (Math.abs(i - j) > Math.floor(cfg.local_attention / 2)) mask[i * width + j] = -1e9;
  constant("mask", [width, width], mask);
  for (const w of weights) parts.push(...(await external(w.path, w.data)));
  parts.push(...recipe.inputs.map((s) => field(11, b64(s))), ...recipe.outputs.map((s) => field(12, b64(s))));
  return join([integer(1, 9), field(7, join(parts)), field(8, integer(2, 20))]);
}
