#!/usr/bin/env python3
"""anagramd — local scoring daemon for the Anagram extension.

Wraps `pangram/editlens_roberta-large` (EditLens: Thai, Emi, Masrour & Iyyer, ICLR 2026;
https://arxiv.org/abs/2510.03154) behind a small HTTP API on 127.0.0.1 that speaks the
extension's contract (lib/contract.ts, CONTRACT_VERSION "2.1").

The model is a 4-way sequence classifier over the *extent of AI editing* in a text:
    bucket 0  fully human-written
    bucket 1  lightly AI-edited
    bucket 2  heavily AI-edited
    bucket 3  fully AI-generated
Its continuous score is the probability-weighted bucket index normalized to [0, 1]
(exactly what the reference `scripts/inference.py` emits as `*_score`).

Language gate: EditLens is trained on English only (model card: `language: en`; every
dataset source in the paper is English). Every block is first run through fastText's
lid.176 language identifier (Joulin et al.) and only blocks whose top label is `en` reach
the model; the rest come back as `unsupported: true` with the detected language so the
extension can say "Unsupported language" instead of showing a meaningless percentage.

Stack: FastAPI (request/response validation via pydantic, CORS, OpenAPI docs at /docs)
served by uvicorn; the model runs under torch on MPS/CUDA in fp16 (CPU fp32); weights are
fetched with huggingface_hub when the model directory is missing.

Endpoints
    GET  /health   → model / device / bucket / language info (the extension polls this)
    POST /score    → {"v": "2.1", "blocks": [{"id": "...", "text": "..."}]}
                   → {"v": "2.1", "model": {...}, "results": [{"id", "bucket", "probs", "score",
                                                                "lang", "lang_prob", ...}]}
    GET  /docs     → interactive OpenAPI UI (FastAPI)

Usage
    python anagramd/serve.py                 # ../../models/editlens_roberta-large on :8765
    python anagramd/serve.py --selftest      # score four sample paragraphs (one non-English) and exit
    python anagramd/serve.py --model-dir /path/to/editlens_roberta-large --port 8765

License note: the weights are CC BY-NC-SA 4.0 (non-commercial). Nothing here uploads text
anywhere — the daemon binds to localhost and the extension only ever talks to it.
"""
from __future__ import annotations

import argparse
import logging
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "2.1"
HF_REPO = "pangram/editlens_roberta-large"
MODEL_ID = "editlens_roberta-large"
# Bump when the weights or preprocessing change — the extension folds this into its cache keys.
MODEL_VER = "hf-2026-03-21"
CALIBRATION = "editlens-4bucket-cosine(0.03,0.15)"
BUCKET_LABELS = ["human", "lightly-edited", "heavily-edited", "ai-generated"]
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[2] / "models" / "editlens_roberta-large"
SUPPORTED_LANGUAGES = ["en"]
LID_URL = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
DEFAULT_LID_PATH = DEFAULT_MODEL_DIR.parent / "lid.176.ftz"

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


# --- language identification (fastText lid.176) ---------------------------------------------------


class LanguageId:
    """fastText lid.176 (176 languages, ~1 MB compressed). `detect` → (iso639-1 code, prob).

    Disabled (every block passes) when fastText or the model file is unavailable — the
    daemon logs it loudly and /health reports `lid: null`.
    """

    def __init__(self, path: Path):
        self.model = None
        self.name = None
        try:
            import fasttext  # noqa: F401
        except Exception as e:  # pragma: no cover
            log.warning("fasttext not importable (%s) — language gate DISABLED, all text is scored", e)
            return
        if not path.exists():
            try:
                import urllib.request
                log.info("downloading fastText lid.176 (~1 MB) to %s", path)
                path.parent.mkdir(parents=True, exist_ok=True)
                urllib.request.urlretrieve(LID_URL, path)
            except Exception as e:
                log.warning("could not fetch %s (%s) — language gate DISABLED", LID_URL, e)
                return
        import fasttext
        self.model = fasttext.load_model(str(path))
        self.name = "fasttext-lid.176"
        log.info("language gate: fastText lid.176 loaded; supported = %s", SUPPORTED_LANGUAGES)

    @property
    def enabled(self) -> bool:
        return self.model is not None

    def detect(self, text: str) -> tuple[str, float]:
        # fasttext 0.9.3's predict() wrapper breaks on NumPy 2 (np.array(copy=False));
        # the C++ binding returns [(prob, "__label__xx"), ...] and is stable.
        pairs = self.model.f.predict(text.replace("\n", " "), 1, 0.0, "strict")
        if not pairs:
            return ("und", 0.0)
        prob, label = pairs[0]
        return (label.replace("__label__", ""), float(prob))


# --- model ---------------------------------------------------------------------------------------


def ensure_model(model_dir: Path) -> None:
    """Fetch the weights with huggingface_hub when the directory has no checkpoint.

    The repo is gated (CC BY-NC-SA — accept the terms on the model page once); the Hub
    client picks up the token from `hf auth login` / HF_TOKEN. Resumable, checksum-verified.
    """
    if (model_dir / "config.json").exists():
        return
    log.info("no checkpoint at %s — downloading %s via huggingface_hub", model_dir, HF_REPO)
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(HF_REPO, local_dir=str(model_dir))
    except Exception as e:
        sys.exit(f"could not download {HF_REPO} into {model_dir}: {e}\n"
                 f"  accept the model terms at https://huggingface.co/{HF_REPO}, run `hf auth login`, then\n"
                 f"  hf download {HF_REPO} --local-dir {model_dir}")


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
        self.last_run_ms = 0.0
        self.last_wait_ms = 0.0

        ensure_model(model_dir)

        self.device = self._pick_device(device)
        # fp16 on the GPU is numerically indistinguishable here (probs agree to 3-4 decimals) and
        # ~20% faster at batch 16-32; CPU stays fp32 (half precision is slow on CPU kernels).
        if dtype == "auto":
            dtype = "fp16" if self.device in ("mps", "cuda") else "fp32"
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
        # ONE tokenizer pass: full ids give the pre-truncation length (so the client can see
        # when a paragraph was cut); the window is applied by slicing, which is exactly what
        # the tokenizer's own truncation produces ([cls] + tokens[:max-2] + [sep]).
        all_ids = self.tok(cleaned, add_special_tokens=True, truncation=False)["input_ids"]
        lengths = [len(ids) for ids in all_ids]
        eos = self.tok.eos_token_id if self.tok.eos_token_id is not None else self.tok.sep_token_id
        order = sorted(range(len(cleaned)), key=lambda i: lengths[i])  # length-sorted batching
        out: list[dict | None] = [None] * len(cleaned)
        idx = np.arange(self.n_buckets, dtype=np.float64)

        t_wait = time.time()
        with self.lock, torch.inference_mode():
            self.last_wait_ms = (time.time() - t_wait) * 1000  # time spent queued behind another batch
            t_run = time.time()
            for start in range(0, len(order), self.batch_size):
                chunk = order[start:start + self.batch_size]
                ids = [all_ids[i] if lengths[i] <= self.max_length
                       else all_ids[i][: self.max_length - 1] + [eos] for i in chunk]
                enc = self.tok.pad({"input_ids": ids}, padding=True, return_tensors="pt").to(self.device)
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
            self.last_run_ms = (time.time() - t_run) * 1000
        self.scored += len(cleaned)
        return out  # type: ignore[return-value]

    def info(self) -> dict:
        return {
            "ok": True,
            "contract": CONTRACT_VERSION,
            "model": {"id": MODEL_ID, "ver": MODEL_VER, "calibration": CALIBRATION},
            "n_buckets": self.n_buckets,
            "buckets": BUCKET_LABELS[: self.n_buckets],
            "languages": SUPPORTED_LANGUAGES,
            "lid": self.lid.name if getattr(self, "lid", None) and self.lid.enabled else None,
            "max_tokens": self.max_length,
            "device": self.device,
            "dtype": str(self.dtype).replace("torch.", ""),
            "uptime_s": round(time.time() - self.started, 1),
            "scored_blocks": self.scored,
        }


# --- wire types (pydantic) — module level so FastAPI can resolve the postponed annotations ----------


class Block(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    text: str = ""


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    v: str | None = None
    session: str | None = None
    blocks: list[Block] = Field(default_factory=list)


class ScoreResult(BaseModel):
    id: str
    bucket: int
    probs: list[float]
    score: float
    tokens: int
    truncated: bool
    lang: str | None = None
    lang_prob: float | None = None
    unsupported: bool | None = None
    degraded: bool | None = None


class ModelInfo(BaseModel):
    id: str
    ver: str
    calibration: str


class ScoreResponse(BaseModel):
    v: str
    session: str | None
    model: ModelInfo
    partial: bool
    results: list[ScoreResult]


# --- HTTP (FastAPI) --------------------------------------------------------------------------------


def unsupported_result(block_id: str, n_buckets: int, lang: str, prob: float) -> dict:
    return {"id": block_id, "bucket": 0, "probs": [1 / n_buckets] * n_buckets, "score": 0.0,
            "tokens": 0, "truncated": False, "lang": lang, "lang_prob": round(prob, 3), "unsupported": True}


def make_app(engine: EditLens):
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    app = FastAPI(title="anagramd", version=MODEL_VER,
                  description="Local EditLens scoring daemon for the Anagram extension "
                              "(contract " + CONTRACT_VERSION + ").")
    # The extension's service worker has host permission for localhost so CORS is moot for it,
    # but permissive headers let you poke the daemon from any page or a plain fetch() too.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "OPTIONS"],
                       allow_headers=["content-type"])

    @app.get("/health")
    def health() -> dict:
        return engine.info()

    # Sync `def` → FastAPI runs it in a worker thread; the model lock serializes GPU work
    # while language-id and JSON handling for other requests proceed concurrently.
    @app.post("/score", response_model=ScoreResponse, response_model_exclude_none=True)
    def score(req: ScoreRequest) -> dict:
        t0 = time.time()
        texts, todo, langs, skipped = [], [], {}, {}
        for b in req.blocks:
            if not b.text.strip():
                continue
            if engine.lid.enabled:
                lang, prob = engine.lid.detect(b.text)
                if lang not in SUPPORTED_LANGUAGES:
                    skipped[b.id] = (lang, prob)
                    continue
                langs[b.id] = (lang, prob)
            todo.append(b.id)
            texts.append(b.text)
        scored = engine.score(texts) if texts else []
        by_id = dict(zip(todo, scored))
        results = []
        for b in req.blocks:
            if b.id in skipped:
                results.append(unsupported_result(b.id, engine.n_buckets, *skipped[b.id]))
                continue
            r = by_id.get(b.id)
            if r is None:  # empty text — no model output, mark degraded so it is never cached
                results.append({"id": b.id, "bucket": 0, "probs": [1 / engine.n_buckets] * engine.n_buckets,
                                "score": 0.0, "tokens": 0, "truncated": False, "degraded": True})
            else:
                out = {"id": b.id, **r}
                if b.id in langs:
                    out["lang"], out["lang_prob"] = langs[b.id][0], round(langs[b.id][1], 3)
                results.append(out)
        ms = (time.time() - t0) * 1000
        log.info("score %d blocks (%d tok): %.0f ms model, %.0f ms queued, %.0f ms total — buckets %s%s",
                 len(texts), sum(r["tokens"] for r in scored), engine.last_run_ms, engine.last_wait_ms, ms,
                 [r["bucket"] for r in scored],
                 f" — {len(skipped)} unsupported ({', '.join(sorted({v[0] for v in skipped.values()}))})" if skipped else "")
        return {"v": CONTRACT_VERSION, "session": req.session, "model": engine.info()["model"],
                "partial": False, "results": results}

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
    ("zh", "这是一个完全用中文写成的段落。模型只在英文数据上训练过，所以这段文字不应该被打分，"
           "而应该被标记为不支持的语言。检测器应该能够识别出这一点，并且不要给出一个看起来很可信的百分比。"),
]


def main() -> None:
    ap = argparse.ArgumentParser(description="Anagram local scoring daemon (EditLens roberta-large)")
    ap.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    ap.add_argument("--dtype", default="auto", choices=["auto", "fp32", "fp16"],
                    help="auto = fp16 on mps/cuda, fp32 on cpu")
    ap.add_argument("--max-length", type=int, default=512, help="roberta-large caps at 512")
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--lid-model", type=Path, default=DEFAULT_LID_PATH,
                    help="fastText lid.176.ftz path (downloaded on first run if missing)")
    ap.add_argument("--no-language-gate", action="store_true", help="score every block regardless of language")
    ap.add_argument("--selftest", action="store_true", help="score sample paragraphs (incl. a non-English one), print, exit")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
    engine = EditLens(args.model_dir, args.device, args.max_length, args.batch_size, args.dtype)
    engine.lid = LanguageId(args.lid_model) if not args.no_language_gate else LanguageId(Path("/nonexistent"))

    if args.selftest:
        t0 = time.time()
        for label, text in SELFTEST:
            if engine.lid.enabled:
                lang, prob = engine.lid.detect(text)
                if lang not in SUPPORTED_LANGUAGES:
                    print(f"  expected≈{label:7s} → UNSUPPORTED language {lang} ({prob:.2f}) — not scored")
                    continue
            r = engine.score([text])[0]
            print(f"  expected≈{label:7s} → bucket {r['bucket']} ({BUCKET_LABELS[r['bucket']]:15s}) "
                  f"score {r['score']:.3f}  probs {r['probs']}  tokens {r['tokens']}")
        print(f"  {len(SELFTEST)} paragraphs in {(time.time() - t0) * 1000:.0f} ms on {engine.device}"
              f" (language gate: {'on' if engine.lid.enabled else 'OFF'})")
        return

    import uvicorn

    app = make_app(engine)
    log.info("listening on http://%s:%d  (GET /health, POST /score, GET /docs)", args.host, args.port)
    # Our own per-request log line above replaces uvicorn's access log.
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
