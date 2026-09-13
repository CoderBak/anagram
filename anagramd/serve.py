#!/usr/bin/env python3
"""anagramd — local scoring daemon for the Anagram extension.

Wraps `pangram/editlens_roberta-large` (EditLens: Thai, Emi, Masrour & Iyyer, ICLR 2026;
https://arxiv.org/abs/2510.03154) behind a tiny HTTP API on 127.0.0.1 that speaks the
extension's contract (lib/contract.ts, CONTRACT_VERSION "2.0").

The model is a 4-way sequence classifier over the *extent of AI editing* in a text:
    bucket 0  fully human-written
    bucket 1  lightly AI-edited
    bucket 2  heavily AI-edited
    bucket 3  fully AI-generated
Its continuous score is the probability-weighted bucket index normalized to [0, 1]
(exactly what the reference `scripts/inference.py` emits as `*_score`).

Endpoints
    GET  /health   → model / device / bucket info (the extension polls this to pick a backend)
    POST /score    → {"v": "2.0", "blocks": [{"id": "...", "text": "..."}]}
                   → {"v": "2.0", "model": {...}, "results": [{"id", "bucket", "probs", "score", ...}]}

Usage
    python anagramd/serve.py                 # ../../models/editlens_roberta-large on :8765
    python anagramd/serve.py --selftest      # score three sample paragraphs and exit
    python anagramd/serve.py --model-dir /path/to/editlens_roberta-large --port 8765

License note: the weights are CC BY-NC-SA 4.0 (non-commercial). Nothing here uploads text
anywhere — the daemon binds to localhost and the extension only ever talks to it.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np

CONTRACT_VERSION = "2.0"
MODEL_ID = "editlens_roberta-large"
# Bump when the weights or preprocessing change — the extension folds this into its cache keys.
MODEL_VER = "hf-2026-03-21"
CALIBRATION = "editlens-4bucket-cosine(0.03,0.15)"
BUCKET_LABELS = ["human", "lightly-edited", "heavily-edited", "ai-generated"]
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[2] / "models" / "editlens_roberta-large"

log = logging.getLogger("anagramd")


# --- preprocessing: verbatim port of EditLens scripts/preprocess.py::clean_text ----------------
# The checkpoint was trained on text passed through exactly this pipeline (notably: lowercased),
# so the daemon must apply it too or scores drift.

_BOILERPLATE_STARTS = ["Sure", "Here", "Abstract", "Title", "I'm happy to help", "Certainly"]


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _remove_think_tag(text: str) -> str:
    if "</think>" in text:
        text = text.split("</think>")[1].strip()
    return text


def _remove_ai_header(text: str, emoji_mod) -> str:
    paragraphs = [p for p in text.split("\n") if p.strip()]
    if not paragraphs:
        return text
    first = re.sub(r"^[^a-zA-Z0-9]*", "", paragraphs[0])
    first = emoji_mod.replace_emoji(first, "")
    if any(first.startswith(p) for p in _BOILERPLATE_STARTS) and len(paragraphs) > 1:
        text = "\n".join(paragraphs[1:])
    return text


def clean_text(text: str, emoji_mod) -> str:
    text = emoji_mod.demojize(text)
    text = _remove_think_tag(text)
    text = _remove_ai_header(text, emoji_mod)
    text = text.lower()
    return _normalize_whitespace(text)


# --- model ---------------------------------------------------------------------------------------


class EditLens:
    def __init__(self, model_dir: Path, device: str, max_length: int, batch_size: int, dtype: str):
        import emoji
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.emoji = emoji
        self.torch = torch
        self.max_length = max_length
        self.batch_size = batch_size
        self.lock = threading.Lock()
        self.scored = 0
        self.started = time.time()

        if not (model_dir / "config.json").exists():
            sys.exit(f"model dir {model_dir} has no config.json — download the model first:\n"
                     f"  hf download pangram/editlens_roberta-large --local-dir {model_dir}")

        self.device = self._pick_device(device)
        self.dtype = torch.float16 if dtype == "fp16" and self.device != "cpu" else torch.float32
        t0 = time.time()
        self.tok = AutoTokenizer.from_pretrained(str(model_dir))
        self.model = self._load(AutoModelForSequenceClassification, model_dir)
        self.model.to(self.device).eval()
        self.n_buckets = int(self.model.config.num_labels)
        if self.n_buckets != len(BUCKET_LABELS):
            log.warning("model has %d labels, extension expects %d", self.n_buckets, len(BUCKET_LABELS))
        log.info("loaded %s on %s (%s) in %.1fs — %d buckets, max %d tokens",
                 model_dir.name, self.device, str(self.dtype).replace("torch.", ""), time.time() - t0,
                 self.n_buckets, max_length)
        self._warmup()

    def _load(self, cls, model_dir: Path):
        """transformers 5 renamed `torch_dtype` to `dtype`; support both."""
        try:
            return cls.from_pretrained(str(model_dir), dtype=self.dtype)
        except TypeError:
            return cls.from_pretrained(str(model_dir), torch_dtype=self.dtype)

    def _pick_device(self, want: str) -> str:
        torch = self.torch
        if want != "auto":
            return want
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    def _warmup(self) -> None:
        t0 = time.time()
        self.score(["warm-up paragraph " * 40])
        log.info("warm-up forward pass %.0f ms", (time.time() - t0) * 1000)

    def score(self, texts: list[str]) -> list[dict]:
        """Score raw texts; returns one dict per input in the same order."""
        torch = self.torch
        cleaned = [clean_text(t, self.emoji) for t in texts]
        # Token counts BEFORE truncation so the client can see when a paragraph was cut.
        full_ids = self.tok(cleaned, add_special_tokens=True, truncation=False)["input_ids"]
        lengths = [len(ids) for ids in full_ids]
        order = sorted(range(len(cleaned)), key=lambda i: lengths[i])  # length-sorted batching
        out: list[dict | None] = [None] * len(cleaned)
        idx = np.arange(self.n_buckets, dtype=np.float64)

        with self.lock, torch.inference_mode():
            for start in range(0, len(order), self.batch_size):
                chunk = order[start:start + self.batch_size]
                enc = self.tok([cleaned[i] for i in chunk], truncation=True, max_length=self.max_length,
                               padding=True, return_tensors="pt").to(self.device)
                logits = self.model(**enc).logits.float().cpu().numpy()
                logits = logits - logits.max(axis=1, keepdims=True)
                probs = np.exp(logits)
                probs /= probs.sum(axis=1, keepdims=True)
                for row, i in enumerate(chunk):
                    p = probs[row]
                    out[i] = {
                        "bucket": int(p.argmax()),
                        "probs": [round(float(x), 4) for x in p],
                        "score": round(float((p @ idx) / (self.n_buckets - 1)), 4),
                        "tokens": min(lengths[i], self.max_length),
                        "truncated": lengths[i] > self.max_length,
                    }
        self.scored += len(cleaned)
        return out  # type: ignore[return-value]

    def info(self) -> dict:
        return {
            "ok": True,
            "contract": CONTRACT_VERSION,
            "model": {"id": MODEL_ID, "ver": MODEL_VER, "calibration": CALIBRATION},
            "n_buckets": self.n_buckets,
            "buckets": BUCKET_LABELS[: self.n_buckets],
            "max_tokens": self.max_length,
            "device": self.device,
            "dtype": str(self.dtype).replace("torch.", ""),
            "uptime_s": round(time.time() - self.started, 1),
            "scored_blocks": self.scored,
        }


# --- HTTP ----------------------------------------------------------------------------------------


def make_app(engine: EditLens):
    from flask import Flask, jsonify, request

    app = Flask("anagramd")

    @app.after_request
    def cors(resp):
        # The extension's service worker has host permission for localhost so CORS is moot for it,
        # but permissive headers let you poke the daemon from any page or a plain fetch() too.
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "content-type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        return resp

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify(engine.info())

    @app.route("/score", methods=["POST", "OPTIONS"])
    def score():
        if request.method == "OPTIONS":
            return ("", 204)
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not isinstance(body.get("blocks"), list):
            return jsonify({"error": "expected {blocks: [{id, text}]}"}), 400
        blocks = [b for b in body["blocks"] if isinstance(b, dict) and isinstance(b.get("id"), str)]
        texts, todo = [], []
        for b in blocks:
            text = b.get("text")
            if isinstance(text, str) and text.strip():
                todo.append(b["id"])
                texts.append(text)
        t0 = time.time()
        scored = engine.score(texts) if texts else []
        by_id = dict(zip(todo, scored))
        results = []
        for b in blocks:
            r = by_id.get(b["id"])
            if r is None:  # empty text — no model output, mark degraded so it is never cached
                results.append({"id": b["id"], "bucket": 0, "probs": [1 / engine.n_buckets] * engine.n_buckets,
                                "score": 0.0, "tokens": 0, "truncated": False, "degraded": True})
            else:
                results.append({"id": b["id"], **r})
        ms = (time.time() - t0) * 1000
        log.info("score %d blocks (%d tok) in %.0f ms — buckets %s", len(texts),
                 sum(r["tokens"] for r in scored), ms, [r["bucket"] for r in scored])
        return jsonify({"v": CONTRACT_VERSION, "session": body.get("session"),
                        "model": engine.info()["model"], "partial": False, "results": results})

    return app


SELFTEST = [
    ("human", "I got the call around six, right when the rice was starting to catch on the bottom of the pan. "
              "My brother never rings on weeknights, so I turned the burner off and sat on the floor to listen. "
              "He talked for twenty minutes about a dog he was thinking of adopting and never mentioned the "
              "thing we both knew he had rung to say. Afterwards the rice was ruined and I ate it anyway."),
    ("ai", "In today's rapidly evolving digital landscape, effective communication has become more crucial "
           "than ever. By leveraging cutting-edge technologies and fostering a culture of collaboration, "
           "organizations can unlock unprecedented opportunities for growth. This comprehensive approach "
           "not only enhances productivity but also empowers teams to navigate complex challenges with "
           "confidence and agility, ultimately driving sustainable success in an increasingly competitive world."),
    ("edited", "I received the call at around six o'clock, just as the rice began to stick to the bottom of "
               "the pan. Since my brother rarely calls on weeknights, I switched off the burner and sat on the "
               "floor to listen. He spoke for twenty minutes about a dog he was considering adopting, never "
               "mentioning what we both knew he had actually called to discuss. Afterwards, the rice was "
               "ruined, but I ate it regardless."),
]


def main() -> None:
    ap = argparse.ArgumentParser(description="Anagram local scoring daemon (EditLens roberta-large)")
    ap.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    ap.add_argument("--dtype", default="fp32", choices=["fp32", "fp16"])
    ap.add_argument("--max-length", type=int, default=512, help="roberta-large caps at 512")
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--selftest", action="store_true", help="score three sample paragraphs, print, exit")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
    engine = EditLens(args.model_dir, args.device, args.max_length, args.batch_size, args.dtype)

    if args.selftest:
        t0 = time.time()
        results = engine.score([t for _, t in SELFTEST])
        for (label, _), r in zip(SELFTEST, results):
            print(f"  expected≈{label:7s} → bucket {r['bucket']} ({BUCKET_LABELS[r['bucket']]:15s}) "
                  f"score {r['score']:.3f}  probs {r['probs']}  tokens {r['tokens']}")
        print(f"  {len(SELFTEST)} paragraphs in {(time.time() - t0) * 1000:.0f} ms on {engine.device}")
        return

    app = make_app(engine)
    log.info("listening on http://%s:%d  (GET /health, POST /score)", args.host, args.port)
    # Werkzeug's dev server is fine here: localhost-only, one model, a handful of clients.
    app.run(host=args.host, port=args.port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
