#!/usr/bin/env python3
"""Write the small binary fixtures the browser-engine suites run on.

  python test/webengine/make-fixtures.py        # needs onnx and fasttext (fasttext-predict)

- test/fixtures/webengine/tiny.onnx: a classifier of the real model's signature (int64
  input_ids and attention_mask [batch, length] in, float logits [batch, 4] out) whose
  logits are the sum over unmasked tokens of a fixed 300 x 4 table: every id i maps to
  row i, TABLE_ROW(i) below, so a test can compute the expected logits itself.
- test/fixtures/webengine/tiny-lid.bin: a supervised hierarchical-softmax fastText model
  of the file format lid.176.ftz uses, with two labels (en, fr), a dense input matrix and
  a handful of words, plus tiny-lid.expected.json: what the real fastText predicts for
  some strings, which test/node/webengineFasttext.test.ts holds the port to.
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

OUT = Path(__file__).resolve().parents[1] / "fixtures" / "webengine"
VOCAB = 300


def table_row(i: int) -> list[float]:
    return [((i % 7) / 7 - 0.5) * 0.4, ((i % 11) / 11 - 0.5) * 0.4, ((i % 13) / 13 - 0.5) * 0.4, ((i % 17) / 17 - 0.5) * 0.4]


def write_onnx() -> None:
    table = np.array([table_row(i) for i in range(VOCAB)], dtype=np.float32)
    nodes = [
        helper.make_node("Gather", ["table", "input_ids"], ["rows"], axis=0),
        helper.make_node("Cast", ["attention_mask"], ["mask_f"], to=TensorProto.FLOAT),
        helper.make_node("Unsqueeze", ["mask_f", "axes"], ["mask_3"]),
        helper.make_node("Mul", ["rows", "mask_3"], ["masked"]),
        helper.make_node("ReduceSum", ["masked", "sum_axes"], ["logits"], keepdims=0),
    ]
    graph = helper.make_graph(
        nodes, "tiny-editlens",
        [helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "length"]),
         helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "length"])],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["batch", 4])],
        initializer=[numpy_helper.from_array(table, "table"),
                     numpy_helper.from_array(np.array([2], dtype=np.int64), "axes"),
                     numpy_helper.from_array(np.array([1], dtype=np.int64), "sum_axes")],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], producer_name="anagram-fixture")
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, OUT / "tiny.onnx")


def write_fasttext() -> None:
    dim, bucket, minn, maxn = 4, 1000, 2, 4
    words = [("the", 900, [1.0, 0.2, 0.0, 0.0]), ("hello", 300, [1.0, 0.0, 0.1, 0.0]), ("world", 250, [0.8, 0.0, 0.0, 0.1]),
             ("bonjour", 200, [-1.0, 0.0, 0.1, 0.0]), ("monde", 150, [-0.8, 0.1, 0.0, 0.0]), ("le", 400, [-1.0, 0.2, 0.0, 0.0]),
             ("</s>", 1000, [0.0, 0.0, 0.0, 0.0])]
    labels = [("__label__en", 1000), ("__label__fr", 500)]
    out = bytearray()
    out += struct.pack("<ii", 793712314, 12)
    out += struct.pack("<12i", dim, 5, 5, 1, 5, 1, 1, 3, bucket, minn, maxn, 100) + struct.pack("<d", 1e-4)
    out += struct.pack("<iiiqq", len(words) + len(labels), len(words), len(labels), 5000, -1)
    for word, count, _ in words:
        out += word.encode() + b"\0" + struct.pack("<qb", count, 0)
    for label, count in labels:
        out += label.encode() + b"\0" + struct.pack("<qb", count, 1)
    out += struct.pack("<?", False)  # dense input
    rows = len(words) + bucket
    matrix = np.zeros((rows, dim), dtype=np.float32)
    for i, (_, _, vector) in enumerate(words):
        matrix[i] = vector
    rng = np.random.default_rng(7)
    matrix[len(words):] = rng.normal(0, 0.05, size=(bucket, dim)).astype(np.float32)
    out += struct.pack("<qq", rows, dim) + matrix.tobytes()
    out += struct.pack("<?", False)  # qout
    output = np.array([[2.0, 0.5, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0]], dtype=np.float32)
    out += struct.pack("<qq", len(labels), dim) + output.tobytes()
    (OUT / "tiny-lid.bin").write_bytes(bytes(out))
    import fasttext
    model = fasttext.load_model(str(OUT / "tiny-lid.bin"))
    strings = ["hello world", "bonjour le monde", "the world", "le monde", "hello", "unknown words only", "", "   ", "a\nb",
               "hello\nbonjour le monde", "__label__fr hello", "zzz", "the", "Hello World", "hello, world!", "héllo wörld"]
    expected = []
    for s in strings:
        pairs = model.f.predict(s.replace("\n", " "), 1, 0.0, "strict")
        expected.append({"text": s, "label": pairs[0][1].replace("__label__", "") if pairs else "und", "prob": float(pairs[0][0]) if pairs else 0.0})
    (OUT / "tiny-lid.expected.json").write_text(json.dumps(expected, indent=1) + "\n")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    write_onnx()
    write_fasttext()
    for name in ("tiny.onnx", "tiny-lid.bin", "tiny-lid.expected.json"):
        print(f"{OUT / name}: {(OUT / name).stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
