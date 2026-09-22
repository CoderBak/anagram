"""Shared EditLens tokenization and four-class postprocessing for local runtimes."""
from __future__ import annotations

import time

import numpy as np


def score_texts(engine, texts: list[str], clean_text) -> list[dict]:
    """Use the same cleaning, truncation, order and rounding on Torch and ONNX.

    A backend implements ``_logits(list[list[int]])`` and returns a [batch, 4]
    array. Tokenization happens once, before truncation, so the reported length
    and truncated flag have the same meaning on every backend.
    """
    cleaned = [clean_text(text, engine.emoji) for text in texts]
    if not cleaned:
        return []
    all_ids = engine.tok(cleaned, add_special_tokens=True, truncation=False)["input_ids"]
    lengths = [len(ids) for ids in all_ids]
    eos = engine.tok.eos_token_id
    if eos is None:
        eos = engine.tok.sep_token_id
    if eos is None:
        raise ValueError("EditLens tokenizer has no end-of-sequence token")
    order = sorted(range(len(texts)), key=lambda i: lengths[i])
    out = [None] * len(texts)
    indices = np.arange(engine.n_buckets, dtype=np.float64)
    waiting = time.perf_counter()
    with engine.lock:
        engine.last_wait_ms = (time.perf_counter() - waiting) * 1000
        started = time.perf_counter()
        for start in range(0, len(order), engine.batch_size):
            chunk = order[start:start + engine.batch_size]
            ids = [all_ids[i] if lengths[i] <= engine.max_length
                   else all_ids[i][:engine.max_length - 1] + [eos] for i in chunk]
            logits = np.asarray(engine._logits(ids), dtype=np.float32)
            if logits.shape != (len(chunk), engine.n_buckets) or not np.isfinite(logits).all():
                raise ValueError("runtime returned invalid EditLens logits")
            logits = logits - logits.max(axis=1, keepdims=True)
            probs = np.exp(logits)
            probs /= probs.sum(axis=1, keepdims=True)
            for row, i in enumerate(chunk):
                p = probs[row]
                out[i] = {
                    "bucket": int(p.argmax()),
                    "probs": [round(float(x), 4) for x in p],
                    "score": round(float((p @ indices) / (engine.n_buckets - 1)), 4),
                    "tokens": min(lengths[i], engine.max_length),
                    "truncated": lengths[i] > engine.max_length,
                }
        engine.last_run_ms = (time.perf_counter() - started) * 1000
    return out
