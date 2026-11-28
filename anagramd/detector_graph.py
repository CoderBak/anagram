"""Compile the bundled ModernBERT graph against local safetensors. Weights stay in place."""

import base64
import json
import math
import struct
from pathlib import Path

import numpy as np


def varint(n):
    result = bytearray()
    while n >= 128:
        result.append((n & 127) | 128)
        n >>= 7
    result.append(n)
    return bytes(result)


def integer(key, value):
    return varint(key * 8) + varint(value)


def field(key, value):
    if isinstance(value, str):
        value = value.encode()
    return varint(key * 8 + 2) + varint(len(value)) + value


def external(path, name):
    with path.open("rb") as stream:
        (length,) = struct.unpack("<Q", stream.read(8))
        if not 0 < length <= 2**20:
            raise ValueError("Invalid weight header")
        table = json.loads(stream.read(length))
    size = path.stat().st_size
    for key, spec in table.items():
        if key == "__metadata__":
            continue
        start, end = spec["data_offsets"]
        shape = spec["shape"]
        if (
            spec["dtype"] != "F32"
            or start < 0
            or end - start != 4 * math.prod(shape)
            or 8 + length + end > size
        ):
            raise ValueError(f"Unsupported weight {key}")
        entries = (("location", name), ("offset", str(8 + length + start)), ("length", str(end - start)))
        yield field(
            5,
            b"".join(integer(1, n) for n in shape)
            + integer(2, 1)
            + field(8, key)
            + b"".join(field(13, field(1, k) + field(2, v)) for k, v in entries)
            + integer(14, 1),
        )


def compile_graph(root, cfg, meta):
    graph = json.loads(Path(__file__).with_name("detector-graph.json").read_text())
    hidden, heads, width = cfg["hidden_size"], cfg["num_attention_heads"], meta["window"] + 2
    dim = hidden // heads
    kinds = cfg.get("layer_types")
    if kinds is None:
        layers, every = cfg.get("num_hidden_layers", 0), cfg.get("global_attn_every_n_layers", 0)
        if not (1 <= layers <= 128 and every > 0):
            raise ValueError("Missing ModernBERT attention configuration")
        kinds = ["sliding_attention" if i % every else "full_attention" for i in range(layers)]
    if (
        cfg["model_type"] != "modernbert"
        or cfg["hidden_activation"] != "gelu"
        or cfg["norm_eps"] != 1e-5
        or any(cfg[k] for k in ("attention_bias", "mlp_bias", "norm_bias", "is_causal"))
        or not 2 <= width <= 2050
        or not 0 < dim <= 256
        or dim % 2
        or hidden != heads * dim
        or not 0 < len(kinds) <= 128
        or kinds[0] != "full_attention"
    ):
        raise ValueError("Unsupported detector configuration")
    parts = [field(2, "anagram-detector/1")]
    prev = ""
    stages = (
        [("start", "start_", 0)]
        + [("first" if i == 0 else k, f"l{i}_", i) for i, k in enumerate(kinds)]
        + [("end", "end_", 0)]
    )
    for stage, prefix, index in stages:

        def name(value):
            return value.replace("$prev", prev).replace("$p", prefix).replace("$i", str(index))

        for op, inputs, outputs, attrs in graph[stage]:
            node = b"".join(field(1, name(i)) for i in inputs) + b"".join(
                field(2, name(o)) for o in outputs
            )
            parts.append(
                field(1, node + field(4, op) + b"".join(field(5, base64.b64decode(a)) for a in attrs))
            )
        prev = name(graph[stage][-1][2][0])

    def constant(name, value, dtype):
        data = np.asarray(value, dtype=dtype)
        parts.append(
            field(
                5,
                b"".join(integer(1, n) for n in data.shape)
                + integer(2, 7 if dtype == "<i8" else 1)
                + field(8, name)
                + field(9, data.tobytes()),
            )
        )

    constant("qkv_shape", [-1, 3, heads, dim], "<i8")
    constant("hidden_shape", [-1, hidden], "<i8")
    constant("attention_scale", dim**-0.5, "<f4")
    for i in range(3):
        constant(f"index{i}", i, "<i8")
    constant("cls_index", [0], "<i8")
    for kind in ("full_attention", "sliding_attention"):
        params = cfg.get("rope_parameters", {}).get(kind, {
            "rope_type": "default", "rope_theta": cfg.get("global_rope_theta" if kind == "full_attention" else "local_rope_theta", 0),
        })
        if params["rope_type"] != "default" or not np.isfinite(params["rope_theta"]) or params["rope_theta"] <= 0:
            raise ValueError("Unsupported rotary embedding")
        angles = np.outer(np.arange(width), params["rope_theta"] ** (-np.arange(0, dim, 2) / dim))
        angles = np.concatenate([angles, angles], axis=1)
        for fn in (np.sin, np.cos):
            constant(kind + fn.__name__, fn(angles), "<f4")
    distance = np.abs(np.arange(width)[:, None] - np.arange(width))
    constant("mask", np.where(distance > cfg["local_attention"] // 2, -1e9, 0), "<f4")
    for path in ("backbone/model.safetensors", "head.safetensors"):
        parts.extend(external(root / path, path))
    for key, role in ((11, "inputs"), (12, "outputs")):
        parts.extend(field(key, base64.b64decode(x)) for x in graph[role])
    return integer(1, 9) + field(7, b"".join(parts)) + field(8, integer(2, 20))
