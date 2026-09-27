// lib/webengine/onnx.ts — the model's graph without its weights, pointing into the file.
//
// The pinned model.onnx carries its 393 weight tensors inside the protobuf (raw_data).
// Handed to ONNX Runtime Web as bytes, the whole file is copied into WebAssembly memory
// and parsed there, and WebAssembly memory never shrinks: the worker kept gigabytes after
// the weights had gone to the GPU. ONNX's external data is the other way to carry a
// tensor: a location, an offset and a length. This rewrites the file's protobuf with every
// large tensor turned into a reference to its own bytes where they already lie in
// model.onnx, reading only the few kilobytes around them; nothing is written to disk.
// The runtime then reads each tensor from the file when it needs it (session.ts): straight
// onto the GPU, or once into WebAssembly memory for the CPU provider.
//
// Protobuf, as far as this needs it: a message is a sequence of fields, each a varint
// key (number << 3 | wire type) and a value; wire type 2 is a varint length and that many
// bytes. ModelProto.graph is field 7, GraphProto.initializer field 5, and in TensorProto
// raw_data is 9, external_data 13 (StringStringEntryProto: key 1, value 2) and
// data_location 14 (EXTERNAL = 1). A field's order does not matter to a parser, so a
// rewritten tensor keeps its other fields verbatim and appends the reference.

/** Reads `length` bytes at `offset` of the model file. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/** What the rewrite made of the file. */
export interface WeightlessGraph {
  /** The protobuf to create the session from. */
  model: Uint8Array;
  /** Tensors that now point into the file, and their bytes. */
  tensors: number;
  bytes: number;
}

/** Tensors smaller than this stay inline: one read each costs more than it saves. */
const INLINE_BELOW = 4096;
const WINDOW = 64 * 1024;

/** Reads through a window, so walking many small fields costs few reads. */
class Cursor {
  private at = 0;
  private window: Uint8Array = new Uint8Array(0);
  constructor(private readonly readAt: ReadAt, readonly size: number) {}

  async bytes(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.size) throw new Error("the model file is truncated or not ONNX");
    if (offset >= this.at && offset + length <= this.at + this.window.length) return this.window.subarray(offset - this.at, offset - this.at + length);
    if (length > WINDOW) return this.readAt(offset, length);
    this.at = offset;
    this.window = await this.readAt(offset, Math.min(WINDOW, this.size - offset));
    if (this.window.length < length) throw new Error("short read of the model file");
    return this.window.subarray(0, length);
  }

  /** A varint at `offset`: its value and where the next byte is. */
  async varint(offset: number): Promise<[number, number]> {
    const head = await this.bytes(offset, Math.min(10, this.size - offset));
    let value = 0;
    let scale = 1;
    for (let i = 0; i < head.length; i++) {
      value += (head[i] & 0x7f) * scale;
      if (head[i] < 0x80) return [value, offset + i + 1];
      scale *= 128;
    }
    throw new Error("the model file is truncated or not ONNX");
  }
}

interface Field { number: number; wire: number; start: number; body: number; end: number }

/** The fields of the message between `start` and `end`. */
async function* fields(cursor: Cursor, start: number, end: number): AsyncGenerator<Field> {
  for (let at = start; at < end; ) {
    const [key, body] = await cursor.varint(at);
    const number = Math.floor(key / 8);
    const wire = key % 8;
    let valueAt = body;
    let next: number;
    if (wire === 0) next = (await cursor.varint(body))[1];
    else if (wire === 1) next = body + 8;
    else if (wire === 5) next = body + 4;
    else if (wire === 2) { const [length, from] = await cursor.varint(body); valueAt = from; next = from + length; }
    else throw new Error("the model file is not ONNX");
    if (next > end) throw new Error("the model file is truncated or not ONNX");
    yield { number, wire, start: at, body: valueAt, end: next };
    at = next;
  }
}

function varint(value: number): number[] {
  const out: number[] = [];
  while (value >= 0x80) { out.push((value % 128) | 0x80); value = Math.floor(value / 128); }
  out.push(value);
  return out;
}

/** A length-delimited field around `parts`. */
function delimited(number: number, parts: Uint8Array[]): Uint8Array[] {
  const length = parts.reduce((n, p) => n + p.length, 0);
  return [Uint8Array.from([...varint(number * 8 + 2), ...varint(length)]), ...parts];
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function entry(key: string, value: string): Uint8Array[] {
  return delimited(13, [...delimited(1, [utf8(key)]), ...delimited(2, [utf8(value)])]);
}

/** One initializer, rewritten to point into the file, or null to keep it as it is. */
async function tensor(cursor: Cursor, field: Field, location: string): Promise<{ parts: Uint8Array[]; bytes: number } | null> {
  const kept: Uint8Array[] = [];
  let raw: { offset: number; length: number } | null = null;
  for await (const f of fields(cursor, field.body, field.end)) {
    if (f.number === 13 || f.number === 14) return null;
    if (f.number === 9 && f.wire === 2) raw = { offset: f.body, length: f.end - f.body };
    else kept.push((await cursor.bytes(f.start, f.end - f.start)).slice());
  }
  if (!raw || raw.length < INLINE_BELOW) return null;
  const reference = [
    ...entry("location", location), ...entry("offset", String(raw.offset)), ...entry("length", String(raw.length)),
    Uint8Array.from([14 * 8, 1]),
  ];
  return { parts: delimited(5, [...kept, ...reference]), bytes: raw.length };
}

/**
 * The model's protobuf with every tensor of INLINE_BELOW bytes or more read from
 * `location` (the model file itself, which the runtime is given beside the graph).
 */
export async function weightlessGraph(readAt: ReadAt, size: number, location: string): Promise<WeightlessGraph> {
  const cursor = new Cursor(readAt, size);
  const top: Uint8Array[] = [];
  let graph: Uint8Array[] | null = null;
  let tensors = 0;
  let bytes = 0;
  for await (const f of fields(cursor, 0, size)) {
    if (f.number !== 7 || f.wire !== 2) { top.push((await cursor.bytes(f.start, f.end - f.start)).slice()); continue; }
    const body: Uint8Array[] = [];
    for await (const g of fields(cursor, f.body, f.end)) {
      const rewritten = g.number === 5 && g.wire === 2 ? await tensor(cursor, g, location) : null;
      if (rewritten) { body.push(...rewritten.parts); tensors++; bytes += rewritten.bytes; }
      else body.push((await cursor.bytes(g.start, g.end - g.start)).slice());
    }
    graph = delimited(7, body);
  }
  if (!graph) throw new Error("the model file has no graph");
  const parts = [...top, ...graph];
  const model = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { model.set(p, at); at += p.length; }
  return { model, tensors, bytes };
}
