"""RoBERTa sequence classification in MLX, FP32, as Hugging Face's RobertaForSequenceClassification.

The encoder layout follows bert/model.py of https://github.com/ml-explore/mlx-examples
(MIT, Copyright © 2023 Apple Inc.). What RoBERTa changes: position ids count from
padding_idx + 1 over the non-padding tokens only, LayerNorm eps comes from the config
(1e-5), GELU is the exact erf form, and the head reads the first token through dense,
tanh and out_proj. model.safetensors loads strictly, every tensor used.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn


class Dense(nn.Module):
    """x @ W + b with W stored input-major. On the Apple GPU this GEMM runs about a tenth
    faster in FP32 than nn.Linear's x @ W.T over the checkpoint's output-major weights."""

    def __init__(self, dims_in: int, dims_out: int):
        super().__init__()
        self.weight = mx.zeros((dims_in, dims_out))
        self.bias = mx.zeros((dims_out,))

    def __call__(self, x):
        return mx.addmm(self.bias, x, self.weight)


class Attention(nn.Module):
    def __init__(self, dims: int, heads: int):
        super().__init__()
        self.heads = heads
        self.scale = 1 / math.sqrt(dims // heads)
        self.query = Dense(dims, dims)
        self.key = Dense(dims, dims)
        self.value = Dense(dims, dims)
        self.out = Dense(dims, dims)

    def __call__(self, x, mask):
        batch, length, dims = x.shape

        def split(y):
            return y.reshape(batch, length, self.heads, -1).transpose(0, 2, 1, 3)

        q, k, v = split(self.query(x)), split(self.key(x)), split(self.value(x))
        y = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.scale, mask=mask)
        return self.out(y.transpose(0, 2, 1, 3).reshape(batch, length, dims))


class Layer(nn.Module):
    """Post-norm encoder layer, as BERT and RoBERTa."""

    def __init__(self, dims: int, heads: int, hidden: int, eps: float):
        super().__init__()
        self.attention = Attention(dims, heads)
        self.ln1 = nn.LayerNorm(dims, eps=eps)
        self.linear1 = Dense(dims, hidden)
        self.linear2 = Dense(hidden, dims)
        self.ln2 = nn.LayerNorm(dims, eps=eps)

    def __call__(self, x, mask):
        x = self.ln1(x + self.attention(x, mask))
        return self.ln2(x + self.linear2(nn.gelu(self.linear1(x))))


class Embeddings(nn.Module):
    def __init__(self, config: dict):
        super().__init__()
        dims = config["hidden_size"]
        self.padding_idx = config["pad_token_id"]
        self.word_embeddings = nn.Embedding(config["vocab_size"], dims)
        self.position_embeddings = nn.Embedding(config["max_position_embeddings"], dims)
        self.token_type_embeddings = nn.Embedding(config["type_vocab_size"], dims)
        self.norm = nn.LayerNorm(dims, eps=config["layer_norm_eps"])

    def __call__(self, input_ids, keep):
        # transformers' create_position_ids_from_input_ids: padding keeps padding_idx.
        count = keep.astype(mx.int32)
        positions = mx.cumsum(count, axis=1) * count + self.padding_idx
        x = (self.word_embeddings(input_ids) + self.token_type_embeddings.weight[0]
             + self.position_embeddings(positions))
        return self.norm(x)


class RobertaClassifier(nn.Module):
    def __init__(self, config: dict):
        super().__init__()
        dims = config["hidden_size"]
        self.embeddings = Embeddings(config)
        self.layers = [Layer(dims, config["num_attention_heads"], config["intermediate_size"],
                             config["layer_norm_eps"]) for _ in range(config["num_hidden_layers"])]
        self.dense = Dense(dims, dims)
        self.out_proj = Dense(dims, len(config["id2label"]))

    def __call__(self, input_ids, attention_mask):
        keep = attention_mask.astype(mx.bool_)
        x = self.embeddings(input_ids, keep)
        mask = keep[:, None, None, :]  # a query attends only to real tokens
        for layer in self.layers:
            x = layer(x, mask)
        return self.out_proj(mx.tanh(self.dense(x[:, 0])))


_RENAMES = (
    ("roberta.embeddings.LayerNorm.", "embeddings.norm."),
    ("roberta.embeddings.", "embeddings."),
    ("roberta.encoder.layer.", "layers."),
    (".attention.self.", ".attention."),
    (".attention.output.dense.", ".attention.out."),
    (".attention.output.LayerNorm.", ".ln1."),
    (".intermediate.dense.", ".linear1."),
    (".output.dense.", ".linear2."),
    (".output.LayerNorm.", ".ln2."),
    ("classifier.", ""),
)


def _parameter(name: str, value):
    for old, new in _RENAMES:
        name = name.replace(old, new)
    # Older checkpoints name LayerNorm parameters gamma and beta.
    if name.endswith(".gamma"):
        name = name[:-6] + ".weight"
    elif name.endswith(".beta"):
        name = name[:-5] + ".bias"
    if value.ndim == 2 and not name.startswith("embeddings."):
        value = mx.contiguous(value.T)  # a Dense weight
    return name, value


def load(model_dir: Path) -> RobertaClassifier:
    """Build the classifier from config.json and load model.safetensors, in FP32."""
    config = json.loads((Path(model_dir) / "config.json").read_text())
    if config.get("model_type") != "roberta" or config.get("hidden_act") != "gelu":
        raise ValueError("The MLX adapter requires a RoBERTa checkpoint with exact GELU")
    model = RobertaClassifier(config)
    weights = mx.load(str(Path(model_dir) / "model.safetensors"))
    if any(value.dtype != mx.float32 for value in weights.values()):
        raise ValueError("The MLX adapter requires FP32 weights")
    parameters = []
    for name in list(weights):
        # One tensor at a time, so the file's copy of a transposed weight is freed at once.
        parameters.append(_parameter(name, weights.pop(name)))
        mx.eval(parameters[-1][1])
    # strict: every parameter is loaded, with its shape, and every tensor in the file is used.
    model.load_weights(parameters, strict=True)
    model.eval()
    return model
