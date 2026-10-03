"""Shared EditLens tokenization and four-class postprocessing for local runtimes."""
from __future__ import annotations

import json
from pathlib import Path
import time

import numpy as np

#: What a forward pass costs beyond its tokens, in tokens: a pass of `rows` texts padded to
#: `width` costs about PASS_TOKENS + rows × width. Fitted on an M4: MLX takes 4.3 ms a pass and
#: 0.2 ms a token. lib/webengine/scoring.ts cuts the same way, with its own runtimes' figures.
PASS_TOKENS = 24


def passes(widths: list[int], limit: int, fixed: int = PASS_TOKENS) -> list[tuple[int, int]]:
    """Cut texts sorted by length into forward passes of at most `limit` texts, where padding
    the shorter ones to a longer one's width would cost more than another pass: the cuts with
    the least total cost (fixed + rows × width a pass), as [start, end) spans of `widths`.

    A pass is padded to its longest text: one pass of a 30-token text and a 500-token one
    costs 1,024 tokens, two cost 578. Of cuts that cost the same, the later passes are the
    fuller."""
    n = len(widths)
    best, cut = [0] + [None] * n, [0] * (n + 1)
    for end in range(1, n + 1):
        for start in range(max(0, end - limit), end):
            cost = best[start] + fixed + (end - start) * widths[end - 1]
            if best[end] is None or cost < best[end]:
                best[end], cut[end] = cost, start
    spans, end = [], n
    while end:
        spans.append((cut[end], end))
        end = cut[end]
    return spans[::-1]


class Tokenizer:
    """The modelkit's tokenizer.json in the Rust tokenizers library, as transformers'
    fast RoBERTa tokenizer runs it, without transformers. Truncation and padding stay
    off in the backend, so concurrent calls only read it."""

    def __init__(self, model_dir: Path):
        from tokenizers import Tokenizer as Backend

        self.backend = Backend.from_file(str(Path(model_dir) / "tokenizer.json"))
        self.backend.no_truncation()
        self.backend.no_padding()
        special = json.loads((Path(model_dir) / "special_tokens_map.json").read_text())
        ids = {name: self.backend.token_to_id(special[name]) for name in ("eos_token", "sep_token", "pad_token")}
        if None in ids.values():
            raise ValueError("EditLens tokenizer is missing a special token")
        self.eos_token_id, self.sep_token_id, self.pad_token_id = ids.values()

    def __call__(self, texts, *, add_special_tokens, truncation=False):
        if truncation:
            raise ValueError("Scoring truncates token ids itself")
        encoded = self.backend.encode_batch(list(texts), add_special_tokens=add_special_tokens)
        return {"input_ids": [row.ids for row in encoded]}

    def pad(self, encoded):
        """Right padding, as the collator: int64 input_ids and attention_mask arrays."""
        rows = encoded["input_ids"]
        width = max(map(len, rows))
        ids = np.full((len(rows), width), self.pad_token_id, dtype=np.int64)
        mask = np.zeros((len(rows), width), dtype=np.int64)
        for i, row in enumerate(rows):
            ids[i, :len(row)], mask[i, :len(row)] = row, 1
        return {"input_ids": ids, "attention_mask": mask}


def score_texts(engine, texts: list[str], clean_text) -> list[dict]:
    """Use the same cleaning, truncation, order and rounding on every runtime.

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
        widths = [min(lengths[i], engine.max_length) for i in order]
        for start, end in passes(widths, engine.batch_size):
            chunk = order[start:end]
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
