"""Run a Qwen3.5 0.8B detector a layer at a time, using the packaged ONNX graphs."""
import base64
import json
import math
import os
import struct
from pathlib import Path

import numpy as np


def check_config(cfg, window, specs):
    rope = cfg.get("rope_parameters", {})
    layers = cfg.get("layer_types")
    if (not isinstance(layers, list) or not 1 <= len(layers) <= 128 or len(layers) != cfg.get("num_hidden_layers")
            or any(kind not in ("full_attention", "linear_attention") for kind in layers)
            or type(cfg.get("vocab_size")) is not int or cfg["vocab_size"] < 1 or
            any(cfg.get(k) != v for k, v in specs["config"].items()) or not 1 <= window <= 512 or
            any(rope.get(k) != v for k, v in specs["rope"].items())):
        raise ValueError("Unsupported Qwen detector configuration")


class Weights:
    def __init__(self, path, dtype):
        with path.open("rb") as stream:
            length, = struct.unpack("<Q", stream.read(8))
            if not 1 <= length <= 2**20:
                raise ValueError("Invalid safetensors header")
            self.table = json.loads(stream.read(length))
        self.start = 8 + length
        self.data = np.memmap(path, mode="r", dtype=np.uint8)
        self.dtype = dtype

    def tensor(self, name, shape):
        spec = self.table[name]
        start, end = spec["data_offsets"]
        dtype = np.dtype("<u2" if self.dtype == "BF16" else "<f4")
        if (spec["shape"] != shape or spec["dtype"] != self.dtype or
                start < 0 or end - start != math.prod(shape) * dtype.itemsize or
                self.start + end > self.data.size):
            raise ValueError(f"Unexpected Qwen tensor {name}")
        return self.data[self.start+start:self.start+end].view(dtype).reshape(shape)


def floats(array):
    return (array.astype(np.uint32) << 16).view(np.float32) if array.dtype == np.uint16 else array


class QwenDetectorSession:
    def __init__(self, root, cfg, window, ort):
        specs = json.loads(Path(__file__).with_name("qwen-graphs.json").read_text())
        check_config(cfg, window, specs)
        backbone = Weights(root / "backbone/model.safetensors", "BF16")
        heads = Weights(root / "head.safetensors", "F32")
        self.embedding = backbone.tensor("embed_tokens.weight", [cfg["vocab_size"], 1024])
        self.layers = []
        for i, kind in enumerate([*cfg["layer_types"], "heads"]):
            spec = specs[kind]
            tensors = []
            for name, shape in spec["weights"].items():
                if kind == "heads":
                    source = backbone if name == "norm.weight" else heads
                    tensor = source.tensor(name, shape)
                else:
                    tensor = backbone.tensor(f"layers.{i}.{name}", shape)
                tensors.append(ort.OrtValue.ortvalue_from_numpy(floats(tensor)))
            opts = ort.SessionOptions()
            opts.enable_cpu_mem_arena = False
            opts.intra_op_num_threads = min(4, os.cpu_count() or 1)
            opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
            opts.add_session_config_entry("session.disable_prepacking", "1")
            opts.add_external_initializers(list(spec["weights"]), tensors)
            self.layers.append(ort.InferenceSession(base64.b64decode(spec["model"]), opts, providers=["CPUExecutionProvider"]))

    def heads(self, ids):
        # Both copies use identical weights and positions run continuously across them.
        # Right padding in the reference implementation does not affect a causal prefix.
        ids = np.asarray(ids)
        if ids.ndim != 1 or not 1 <= ids.size <= 512 or ids.min() < 0 or ids.max() >= len(self.embedding):
            raise ValueError("Invalid Qwen token IDs")
        hidden = floats(self.embedding[np.tile(ids, 2)])
        for layer in self.layers[:-1]:
            hidden, = layer.run(["result"], {"hidden": hidden})
        return self.layers[-1].run(["token", "segment", "mixed"], {"hidden": hidden[len(ids):]})
