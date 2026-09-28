// test/node/webengineOnnx.test.ts — the graph without its weights (lib/webengine/onnx.ts).
//
// The tiny fixture's 300 × 4 table is large enough to be pointed into the file; the
// rewritten graph, run by ONNX Runtime Web (the engine's own package, its CPU provider
// under Node) with the original file as external data, must answer exactly as the file.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { weightlessGraph } from "../../lib/webengine/onnx";

const MODEL = new Uint8Array(readFileSync(join(__dirname, "..", "fixtures", "webengine", "tiny.onnx")));
/** The engine's runtime, an alias of onnxruntime-web whose types name the package itself. */
const ENGINE_ORT = "onnxruntime-web-engine";
const readAt = async (offset: number, length: number) => MODEL.slice(offset, offset + length);

describe("weightlessGraph", () => {
  it("points the large tensors into the file and keeps everything else", async () => {
    const graph = await weightlessGraph(readAt, MODEL.length, "model.onnx");
    expect(graph.tensors).toBe(1);
    expect(graph.bytes).toBe(300 * 4 * 4);
    expect(graph.model.length).toBeLessThan(MODEL.length - graph.bytes + 200);
    const text = new TextDecoder("latin1").decode(graph.model);
    for (const word of ["location", "model.onnx", "offset", "length", "input_ids", "attention_mask", "logits", "Gather", "ReduceSum"]) expect(text).toContain(word);
  });

  it("answers as the model file does, in ONNX Runtime Web", async () => {
    const ort = (await import(ENGINE_ORT)) as typeof import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    const graph = await weightlessGraph(readAt, MODEL.length, "model.onnx");
    const ids = [[0, 5, 17, 299, 2, 1], [3, 3, 250, 2, 1, 1]];
    const mask = [[1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 0, 0]];
    const feeds = () => ({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.flat(), BigInt), [2, 6]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(mask.flat(), BigInt), [2, 6]),
    });
    const whole = await ort.InferenceSession.create(MODEL);
    const split = await ort.InferenceSession.create(graph.model, { externalData: [{ path: "model.onnx", data: MODEL }] });
    const expected = (await whole.run(feeds())).logits!.data as Float32Array;
    const got = (await split.run(feeds())).logits!.data as Float32Array;
    expect(Array.from(got)).toEqual(Array.from(expected));
    await whole.release();
    await split.release();
  });

  it("refuses what is not an ONNX file", async () => {
    const junk = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    await expect(weightlessGraph(async (o, n) => junk.slice(o, o + n), junk.length, "model.onnx")).rejects.toThrow();
    await expect(weightlessGraph(async (o, n) => MODEL.slice(o, o + n), MODEL.length - 100, "model.onnx")).rejects.toThrow();
  });
});
