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

Stack: FastAPI (request/response validation via pydantic, OpenAPI docs at /docs) served by
uvicorn; the model runs under torch on MPS/CUDA in fp16 (CPU fp32); both model files are read
from disk — serving downloads nothing, ever (see "Offline", below).

Hardening (the daemon is a local service, but a local service is still a service):
    - binds 127.0.0.1 or localhost — the only two names the extension can be pointed at —
      unless --allow-remote is given explicitly
    - Host header allow-list (the same two names) — defeats DNS-rebinding
    - no CORS headers: the extension talks to it with host permissions, web pages cannot read it
    - POST /score must be application/json, and a request that carries an Origin must carry an
      extension one (or our own) — together those keep a web page from reaching /score at all
    - request limits: blocks per request, characters per block, unique ids, contract major
      version — checked by pydantic BEFORE any tokenization; the body cap counts the bytes
      that actually arrive, so a chunked body cannot walk past it
    - the language gate FAILS CLOSED: no fastText model → the daemon refuses to start
      (unless --no-language-gate is passed on purpose)
    - the model version the extension keys its caches by identifies the whole pipeline —
      weights, tokenizer/config files, window, dtype, the language model's own digest,
      the preprocessing source — so no two configurations that can disagree about a
      paragraph ever share a cache entry

Offline: serving reaches no network at all. The Hub clients are switched off in the
environment before they are imported (below), and neither model is ever fetched at run time —
a missing file is an error naming the command that fetches it. Downloading is an explicit
command (`anagram model`, or install.sh) which pins a checksum and stages the file before it
replaces the one in use, so a half-written file can never be loaded.

Endpoints
    GET  /health   → model / device / bucket / language info (the extension polls this)
    POST /score    → {"v": "2.1", "blocks": [{"id": "...", "text": "..."}]}
                   → {"v": "2.1", "model": {...}, "results": [{"id", "bucket", "probs", "score",
                                                                "lang", "lang_prob", ...}]}
    GET  /docs     → interactive OpenAPI UI (FastAPI)

Usage
    python anagramd/serve.py                 # ../../models/editlens_roberta-large on :8765
    python anagramd/serve.py --selftest      # score four sample paragraphs, assert what they should say,
                                             # print PASS/FAIL per line and exit non-zero on any failure
    python anagramd/serve.py --model-dir /path/to/editlens_roberta-large --port 8765

License note: the weights are CC BY-NC-SA 4.0 (non-commercial). Nothing here uploads text
anywhere — the daemon binds to localhost and the extension only ever talks to it.
"""
from __future__ import annotations

import os

# Switch the Hub clients off BEFORE anything can import them: huggingface_hub and transformers
# read these variables once, at their own import time, and a value set afterwards is ignored.
# The daemon downloads nothing itself, so this is belt and braces — but it is the belt that
# matters: without it a tokenizer file that went missing, or a config the loader decides is
# stale, is silently re-fetched from the internet under whatever token happens to be on the
# machine. With it, the same situation is a loud local error, which is what "runs on your
# machine" has to mean. Set, not defaulted: an inherited HF_HUB_OFFLINE=0 does not get a vote.
for _offline_var in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE",
                     "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"):
    os.environ[_offline_var] = "1"

import argparse
import hashlib
import inspect
import json
import logging
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CONTRACT_VERSION = "2.1"
CONTRACT_MAJOR = CONTRACT_VERSION.split(".")[0]
HF_REPO = "pangram/editlens_roberta-large"
# Hub commit the daemon was verified against; snapshot_download pins it so a silent
# upstream change cannot alter verdicts under the same cache keys.
HF_REVISION = "f93e1ace74528cfb48f337ab2fe946fb71a728cb"
MODEL_ID = "editlens_roberta-large"
# SHA-256 of model.safetensors at that revision. The served model version is derived
# from the ACTUAL weights (see pipeline_version) — this constant only lets startup warn
# when the checkpoint on disk is not the verified one.
EXPECTED_WEIGHTS_SHA256 = "869f33df7928c447bbd150d3b5192b4ea90b1cbd2ee4aad97f5d51d59dfc8cfb"
# Preprocessing/bucket-definition revision, folded into the version alongside the hashes.
PIPELINE_REV = "pre1"
# The small files that decide how text reaches the weights. Every one of them can change a
# verdict without touching model.safetensors, so they are hashed into the served version too.
PIPELINE_FILES = ("config.json", "tokenizer.json", "tokenizer_config.json", "vocab.json",
                  "merges.txt", "special_tokens_map.json")
# The bucket edges EditLens used (cosine distance 0.03 / 0.15) — a description of the
# classes, not a calibration of the probabilities. The wire contract has always carried this
# string as `calibration`, which is the wrong word for it; responses now carry the same value
# under `label_schema` as well, and `calibration` stays for every 2.x client already written
# against it.
CALIBRATION = "editlens-4bucket-cosine(0.03,0.15)"
LABEL_SCHEMA = CALIBRATION
BUCKET_LABELS = ["human", "lightly-edited", "heavily-edited", "ai-generated"]
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[2] / "models" / "editlens_roberta-large"
SUPPORTED_LANGUAGES = ["en"]
# Where the language model comes from. The daemon never fetches it — this is here so the error
# it prints when the file is missing can say where the installer got it (install.sh pins the
# checksum of what arrives from this URL).
LID_URL = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
DEFAULT_LID_PATH = DEFAULT_MODEL_DIR.parent / "lid.176.ftz"

# Request limits (the extension sends ≤ ~120 blocks of ≤ 4000 chars; these leave headroom
# for other local clients while bounding what a stray POST can make the GPU chew on).
MAX_BLOCKS = 256
MAX_TEXT_CHARS = 16_000
MAX_ID_CHARS = 64
MAX_BODY_BYTES = 2 * 1024 * 1024
LOOPBACK_HOSTS = ["127.0.0.1", "localhost"]

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

    The gate FAILS CLOSED: if fastText or its model cannot be loaded the daemon exits
    instead of quietly scoring every language with an English-only model. Only
    `--no-language-gate` (explicit, logged, reported by /health as `lid: null`) turns
    it off.

    A missing model file is an error, not a download. Fetching it used to happen here, on
    the first start, with none of the guarantees the installer gives it — no checksum, no
    staging, and an interruption leaving a truncated .ftz that the NEXT start would load as
    if it were the real thing. It is the installer's job (`anagram model`); this says so.

    The model's digest is part of what the daemon serves as its version: this file decides
    which paragraphs are scored at all, so two daemons holding different ones must not share
    the extension's cache entries.
    """

    def __init__(self, path: Path):
        self.model = None
        self.name = None
        self.digest = None
        try:
            import fasttext  # noqa: F401
        except Exception as e:  # pragma: no cover
            sys.exit(f"fasttext is not importable ({e}) — the language gate cannot run.\n"
                     f"  pip install fasttext, or pass --no-language-gate to score every language (not advised)")
        if not path.exists():
            sys.exit(f"the fastText language model is missing: {path}\n"
                     f"  the daemon never downloads it — fetch it with the command that verifies it:\n"
                     f"    anagram model                                    (an installed folder)\n"
                     f"    curl -fsSL -o {path} \\\n"
                     f"      {LID_URL}    (from source, ~1 MB)\n"
                     f"  `anagram doctor` reports this file and its checksum; --no-language-gate scores every "
                     f"language with an English-only model instead (not advised)")
        import fasttext
        self.digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.model = fasttext.load_model(str(path))
        self.name = "fasttext-lid.176"
        log.info("language gate: fastText lid.176 loaded (sha256 %s…); supported = %s",
                 self.digest[:12], SUPPORTED_LANGUAGES)

    @classmethod
    def disabled(cls) -> "LanguageId":
        """Explicitly OFF (--no-language-gate): every block is scored, whatever its language."""
        obj = cls.__new__(cls)
        obj.model = None
        obj.name = None
        obj.digest = None
        log.warning("language gate DISABLED by --no-language-gate — non-English text WILL be scored")
        return obj

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


def require_model(model_dir: Path) -> None:
    """The checkpoint has to be on disk already: starting the daemon downloads nothing.

    This used to call snapshot_download when the directory was empty, which meant a daemon
    could pull 1.4 GB off the internet under whatever Hugging Face token it found on the
    machine, at the moment somebody expected it to start. Fetching is now an explicit
    command that pins the checksum and stages the file (`anagram model`, or install.sh);
    all that is left here is to say which one to run.
    """
    if (model_dir / "config.json").exists():
        return
    sys.exit(f"no EditLens checkpoint in {model_dir} (config.json is missing)\n"
             f"  the daemon never downloads it — fetch it with the command that verifies it:\n"
             f"    anagram model                                    (an installed folder)\n"
             f"    hf download {HF_REPO} --revision {HF_REVISION} --local-dir {model_dir}\n"
             f"  the weights are gated: accept the terms at https://huggingface.co/{HF_REPO} once.\n"
             f"  `anagram doctor` reports this checkpoint and its checksum")


def weights_digest(model_dir: Path) -> tuple[str, str] | None:
    """(file name, SHA-256) of the checkpoint actually loaded, or None if there is none.

    Hashing 1.4 GB takes a second or two; the digest is memoized next to the weights
    together with the file's name, size and mtime, so restarts are free.
    """
    weights = model_dir / "model.safetensors"
    if not weights.exists():  # sharded / other formats: hash whichever checkpoint is there
        files = sorted(p for p in model_dir.glob("*.safetensors")) or sorted(model_dir.glob("*.bin"))
        if not files:
            return None
        weights = files[0]
    st = weights.stat()
    memo = model_dir / ".anagram-weights-sha256.json"
    try:
        cached = json.loads(memo.read_text())
        if cached.get("file") == weights.name and cached.get("size") == st.st_size and cached.get("mtime") == st.st_mtime:
            return (weights.name, cached["sha256"])
    except Exception:
        pass
    h = hashlib.sha256()
    with weights.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    digest = h.hexdigest()
    try:
        memo.write_text(json.dumps({"file": weights.name, "size": st.st_size, "mtime": st.st_mtime, "sha256": digest}))
    except OSError:
        pass
    return (weights.name, digest)


def preprocess_digest() -> str:
    """SHA-256 (12 hex) of the preprocessing source itself.

    `clean_text` and the functions under it decide what the model actually reads — lowercasing,
    the boilerplate first line, the emoji pass. Editing any of them moves the answers, and the
    only thing that used to record it was somebody remembering to bump PIPELINE_REV by hand.
    Hashing the source removes the remembering. A build that cannot show its own source (frozen,
    zipped) falls back to the constant rather than inventing a digest.
    """
    try:
        source = "".join(inspect.getsource(fn) for fn in
                         (_normalize_whitespace, _remove_think_tag, _remove_ai_header, clean_text))
    except (OSError, TypeError):  # pragma: no cover — source unavailable
        return "src-unavailable"
    return hashlib.sha256((source + repr(_BOILERPLATE_STARTS)).encode()).hexdigest()[:12]


def pipeline_manifest(model_dir: Path, max_length: int, dtype: str, lid: LanguageId) -> dict:
    """Everything except the weights that can change what a paragraph comes back as.

    Kept as a plain dict, and hashed by pipeline_version below, so that "what is the served
    version made of" is one readable list rather than something to reconstruct from a digest.
    """
    return {
        # The small files that decide how text reaches the weights (kilobytes — hashed on every
        # start, unlike the 1.4 GB checkpoint).
        "files": {name: hashlib.sha256((model_dir / name).read_bytes()).hexdigest()
                  for name in PIPELINE_FILES if (model_dir / name).is_file()},
        "max_length": max_length,
        "dtype": dtype,
        # The gate decides whether a block is scored at all, so a different language model is
        # as much a different pipeline as different weights are.
        "language_gate": lid.enabled,
        "lid": {"name": lid.name, "sha256": lid.digest} if lid.enabled else None,
        "languages": SUPPORTED_LANGUAGES,
        # What the numbers are taken to mean: the buckets and where their edges came from.
        "labels": BUCKET_LABELS,
        "label_schema": LABEL_SCHEMA,
        "preprocess": preprocess_digest(),
        "rev": PIPELINE_REV,
    }


def pipeline_version(model_dir: Path, max_length: int, dtype: str, lid: LanguageId) -> str:
    """`sha256:<12 hex of the weights>-p<8 hex of the rest>-<pipeline rev>`.

    The extension keys every cached verdict by this string, so it has to change whenever the
    same paragraph could come back with a different number — and the weights are only one of
    the inputs. A swapped tokenizer or config, another --max-length, fp32 instead of fp16, an
    edited preprocessing step, a language gate turned off — or a DIFFERENT language model,
    which decides whether a paragraph is scored at all rather than how — all move the answers
    while model.safetensors stays byte-for-byte identical. The second digest therefore covers a
    canonical JSON manifest: the SHA-256 of every small pipeline file that exists (kilobytes —
    hashed on every start, unlike the weights), the gate down to the digest of its own model
    and the languages it lets through, the preprocessing source, the labels the buckets stand
    for, and the settings that reach the model. The weights digest keeps the front of the
    string because it is the expensive one and the one a human recognizes.
    """
    found = weights_digest(model_dir)
    if found and EXPECTED_WEIGHTS_SHA256 and found[1] != EXPECTED_WEIGHTS_SHA256:
        log.warning("weights %s have sha256 %s…, not the verified %s… — verdicts may differ from the "
                    "benchmarked checkpoint (cache keys stay distinct)", found[0], found[1][:12],
                    EXPECTED_WEIGHTS_SHA256[:12])
    blob = json.dumps(pipeline_manifest(model_dir, max_length, dtype, lid),
                      sort_keys=True, separators=(",", ":")).encode()
    head = f"sha256:{found[1][:12]}" if found else "unknown"
    return f"{head}-p{hashlib.sha256(blob).hexdigest()[:8]}-{PIPELINE_REV}"


class EditLens:
    # The language gate is a constructor argument, not something bolted on afterwards: it
    # decides whether a paragraph is scored at all, so the served version has to know about it.
    def __init__(self, model_dir: Path, device: str, max_length: int, batch_size: int, dtype: str,
                 lid: LanguageId):
        import emoji
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.emoji = emoji
        self.torch = torch
        self.lid = lid
        self.max_length = max_length
        self.batch_size = batch_size
        self.lock = threading.Lock()
        self.scored = 0
        self.started = time.time()
        self.last_run_ms = 0.0
        self.last_wait_ms = 0.0

        require_model(model_dir)

        self.device = self._pick_device(device)
        # fp16 on the GPU is numerically indistinguishable here (probs agree to 3-4 decimals) and
        # ~20% faster at batch 16-32; CPU stays fp32 (half precision is slow on CPU kernels).
        if dtype == "auto":
            dtype = "fp16" if self.device in ("mps", "cuda") else "fp32"
        self.dtype = torch.float16 if dtype == "fp16" and self.device != "cpu" else torch.float32
        self.dtype_name = str(self.dtype).replace("torch.", "")
        # Only now is everything that can move a verdict decided.
        self.version = pipeline_version(model_dir, max_length, self.dtype_name, lid)
        t0 = time.time()
        self.tok = AutoTokenizer.from_pretrained(str(model_dir))
        self.model = self._load(AutoModelForSequenceClassification, model_dir)
        self.model.to(self.device).eval()
        self.n_buckets = int(self.model.config.num_labels)
        if self.n_buckets != len(BUCKET_LABELS):
            log.warning("model has %d labels, extension expects %d", self.n_buckets, len(BUCKET_LABELS))
        log.info("loaded %s on %s (%s) in %.1fs — %d buckets, max %d tokens",
                 model_dir.name, self.device, self.dtype_name, time.time() - t0,
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
            "model": {"id": MODEL_ID, "ver": self.version, "calibration": CALIBRATION,
                      "label_schema": LABEL_SCHEMA},
            "n_buckets": self.n_buckets,
            "buckets": BUCKET_LABELS[: self.n_buckets],
            "languages": SUPPORTED_LANGUAGES,
            "lid": self.lid.name if self.lid.enabled else None,
            "max_tokens": self.max_length,
            "limits": {"max_blocks": MAX_BLOCKS, "max_text_chars": MAX_TEXT_CHARS, "max_body_bytes": MAX_BODY_BYTES},
            "device": self.device,
            "dtype": self.dtype_name,
            "uptime_s": round(time.time() - self.started, 1),
            "scored_blocks": self.scored,
        }


# --- wire types (pydantic) — module level so FastAPI can resolve the postponed annotations ----------


class Block(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=MAX_ID_CHARS)
    text: str = Field(default="", max_length=MAX_TEXT_CHARS)


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    v: str = Field(max_length=16)
    session: str | None = Field(default=None, max_length=64)
    blocks: list[Block] = Field(default_factory=list, max_length=MAX_BLOCKS)

    @field_validator("v")
    @classmethod
    def _contract_major(cls, v: str) -> str:
        if v.split(".")[0] != CONTRACT_MAJOR:
            raise ValueError(f"contract {v} is not {CONTRACT_MAJOR}.x")
        return v

    @model_validator(mode="after")
    def _unique_ids(self) -> "ScoreRequest":
        seen: set[str] = set()
        for b in self.blocks:
            if b.id in seen:
                raise ValueError(f"duplicate block id {b.id!r}")
            seen.add(b.id)
        return self


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
    # The same string under the name that describes it. Additive on purpose: `calibration` is
    # what contract 2.x clients read, and a response model that did not declare this would
    # quietly drop it from /score while /health kept it.
    label_schema: str | None = None


class ScoreResponse(BaseModel):
    v: str
    session: str | None
    model: ModelInfo
    partial: bool
    results: list[ScoreResult]


# --- ASGI guards: refuse a request before FastAPI ever routes or parses it ---------------------------


def _header(scope: dict, name: bytes) -> str | None:
    """First value of a header in an ASGI scope (names arrive lowercased, values as bytes)."""
    for key, value in scope.get("headers", []):
        if key == name:
            return value.decode("latin-1")
    return None


async def _refuse(send, status: int, detail: str) -> None:
    """Answer straight on the ASGI channel, in FastAPI's own {"detail": …} error shape."""
    body = json.dumps({"detail": detail}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


class BodyCap:
    """Cap the bytes we actually RECEIVE, not the bytes a client promises to send.

    A Content-Length check alone is decorative: a chunked (or otherwise streamed) request
    declares no length, so the whole body would be buffered and JSON-parsed before pydantic's
    limits could apply to it. This counts the `http.request` chunks as uvicorn hands them over
    and answers 413 the moment the count passes the cap, so the endpoint never runs.

    Exactly one response reaches the client: after answering we hand the application a
    disconnect (Starlette turns that into its own 400) and drop everything it tries to send.
    """

    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = _header(scope, b"content-length")
        if declared and declared.isdigit() and int(declared) > self.max_bytes:
            await _refuse(send, 413, f"body exceeds {self.max_bytes} bytes")
            return
        state = {"seen": 0, "over": False}

        async def receive_capped():
            if state["over"]:
                return {"type": "http.disconnect"}
            message = await receive()
            if message.get("type") == "http.request":
                state["seen"] += len(message.get("body", b""))
                if state["seen"] > self.max_bytes:
                    state["over"] = True
                    await _refuse(send, 413, f"body exceeds {self.max_bytes} bytes")
                    return {"type": "http.disconnect"}
            return message

        async def send_unless_answered(message):
            if not state["over"]:
                await send(message)

        try:
            await self.app(scope, receive_capped, send_unless_answered)
        except Exception:
            if not state["over"]:  # a real failure; ours is already answered for
                raise


class OriginGuard:
    """Keep a web page out of /score, with two rules aimed at exactly that attacker.

    Content type. A page can only reach a cross-origin URL *without* a CORS preflight when the
    request uses a "simple" content type — text/plain, the form encodings, or none at all via a
    typeless Blob. Demanding application/json therefore forces a preflight, and the preflight
    fails because we answer it with no CORS headers, so the POST is never sent. Parameters
    (`; charset=utf-8`) are fine; anything else, or nothing, is 415.

    Origin. When a request does carry an Origin it must be an extension's, or our own so that
    the /docs "Try it out" button keeps working. `null` — sandboxed iframes, file:// pages,
    some redirects — names no origin we can trust and is refused with the rest. A request with
    no Origin at all (curl, the `anagram` CLI, Node) passes as before: those are not browsers,
    and a browser cannot omit the header on a cross-origin request. Sec-Fetch-* is deliberately
    not consulted — we have not verified what browsers put there for extension requests.
    """

    EXTENSION_SCHEMES = ("chrome-extension://", "moz-extension://", "safari-web-extension://")

    def __init__(self, app, own_origins: tuple[str, ...] = ()):
        self.app = app
        self.own_origins = own_origins

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http":
            origin = _header(scope, b"origin")
            if origin is not None and not self._allowed(origin):
                await _refuse(send, 403, f"origin {origin} is not allowed")
                return
            if scope["method"] == "POST" and scope["path"] == "/score":
                media = (_header(scope, b"content-type") or "").split(";")[0].strip().lower()
                if media != "application/json":
                    await _refuse(send, 415, "POST /score requires content-type: application/json")
                    return
        await self.app(scope, receive, send)

    def _allowed(self, origin: str) -> bool:
        origin = origin.strip().lower()
        return origin in self.own_origins or origin.startswith(self.EXTENSION_SCHEMES)


# --- HTTP (FastAPI) --------------------------------------------------------------------------------


def unsupported_result(block_id: str, n_buckets: int, lang: str, prob: float) -> dict:
    return {"id": block_id, "bucket": 0, "probs": [1 / n_buckets] * n_buckets, "score": 0.0,
            "tokens": 0, "truncated": False, "lang": lang, "lang_prob": round(prob, 3), "unsupported": True}


def allowed_hosts_for(host: str) -> list[str]:
    """Every name this daemon answers to, given the one it was told to bind.

    ONE list, because it feeds two things that have to agree: the Host allow-list and the
    Origin guard's idea of our own origin. Normally it is exactly the two loopback names the
    extension can be pointed at; an --allow-remote host joins them (it still has to be
    reachable as 127.0.0.1 from this machine, and /docs still has to work).
    """
    return list(LOOPBACK_HOSTS) if host in LOOPBACK_HOSTS else [host, *LOOPBACK_HOSTS]


def make_app(engine: EditLens, allowed_hosts: list[str], port: int):
    from fastapi import FastAPI
    from fastapi.middleware.trustedhost import TrustedHostMiddleware
    app = FastAPI(title="anagramd", version=engine.version,
                  description="Local EditLens scoring daemon for the Anagram extension "
                              "(contract " + CONTRACT_VERSION + ").")
    # Starlette runs the LAST middleware added first, so this reads bottom-up: cap the body
    # before anything can buffer it, then refuse foreign origins and non-JSON posts, then the
    # Host allow-list — a page that resolves its own name to 127.0.0.1 (DNS rebinding) still
    # sends its own Host header, and is refused. No CORS middleware on purpose: the extension
    # calls with host permissions (no CORS needed) and web pages get no headers that would let
    # them read a response.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
    # Our own origin is every name we answer to on our own port — that is what a browser puts
    # in Origin when the /docs page posts back to us.
    app.add_middleware(OriginGuard, own_origins=tuple(f"http://{h.lower()}:{port}" for h in allowed_hosts))
    app.add_middleware(BodyCap, max_bytes=MAX_BODY_BYTES)

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


def run_selftest(engine: EditLens) -> int:
    """Score the samples, ASSERT what is robust about them, return the number of failures.

    A selftest that prints whatever the model said and exits 0 cannot fail, which makes it
    useless as the installer's "is this thing actually working" step. The exact numbers move a
    little with device and dtype, so only the ordering is checked: the human paragraph lands in
    bucket 0, the AI one in bucket 3, the lightly rewritten human paragraph strictly between the
    two, the Chinese one is refused by the gate, and every output is a distribution.
    """
    t0 = time.time()
    failures = 0
    scores: dict[str, float] = {}
    probs: dict[str, list[float]] = {}

    def report(state: str, line: str) -> None:
        nonlocal failures
        print(f"  {state}  {line}")
        if state == "FAIL":
            failures += 1

    for label, text in SELFTEST:
        if label == "zh" and not engine.lid.enabled:
            report("SKIP", "zh      → the language gate is off (--no-language-gate), nothing to refuse")
            continue
        if engine.lid.enabled:
            lang, prob = engine.lid.detect(text)
            if lang not in SUPPORTED_LANGUAGES:
                report("PASS" if label == "zh" else "FAIL",
                       f"{label:7s} → unsupported language {lang} ({prob:.2f}), not scored")
                continue
        r = engine.score([text])[0]
        scores[label] = r["score"]
        probs[label] = r["probs"]
        line = (f"{label:7s} → bucket {r['bucket']} ({BUCKET_LABELS[r['bucket']]}), score {r['score']:.3f}, "
                f"probs {r['probs']}, {r['tokens']} tokens")
        if label == "human":
            report("PASS" if r["bucket"] == 0 else "FAIL", f"{line}  [expected bucket 0]")
        elif label == "ai":
            report("PASS" if r["bucket"] == 3 else "FAIL", f"{line}  [expected bucket 3]")
        else:
            report("INFO", line)

    if {"human", "edited", "ai"} <= scores.keys():
        between = scores["human"] < scores["edited"] < scores["ai"]
        report("PASS" if between else "FAIL",
               f"edited {scores['edited']:.3f} lies strictly between human {scores['human']:.3f} "
               f"and ai {scores['ai']:.3f}")
    else:
        report("FAIL", f"only {sorted(scores)} of the three English samples were scored")
    sums = {label: sum(p) for label, p in probs.items()}
    report("PASS" if sums and all(abs(s - 1) < 0.01 for s in sums.values()) else "FAIL",
           "every probs vector sums to 1 — " + ", ".join(f"{k} {v:.4f}" for k, v in sums.items()))
    print(f"  {len(SELFTEST)} paragraphs in {(time.time() - t0) * 1000:.0f} ms on {engine.device}"
          f" (language gate: {'on' if engine.lid.enabled else 'OFF'}, model {engine.version})")
    return failures


def bounded_int(lo: int, hi: int):
    """An argparse type that refuses an out-of-range option before the model is loaded."""
    def parse(raw: str) -> int:
        try:
            value = int(raw)
        except ValueError:
            raise argparse.ArgumentTypeError(f"must be a whole number (got {raw!r})")
        if not lo <= value <= hi:
            raise argparse.ArgumentTypeError(f"must be between {lo} and {hi} (got {value})")
        return value
    parse.__name__ = f"int in [{lo}, {hi}]"
    return parse


def main() -> None:
    ap = argparse.ArgumentParser(description="Anagram local scoring daemon (EditLens roberta-large)")
    ap.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    ap.add_argument("--host", default="127.0.0.1", metavar="{" + "|".join(LOOPBACK_HOSTS) + "}",
                    help="the name to bind, answer Host headers for, and accept as our own Origin")
    ap.add_argument("--allow-remote", action="store_true",
                    help="permit a --host other than those two (page text may then leave this machine — not advised)")
    ap.add_argument("--port", type=bounded_int(1, 65535), default=8765)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    ap.add_argument("--dtype", default="auto", choices=["auto", "fp32", "fp16"],
                    help="auto = fp16 on mps/cuda, fp32 on cpu")
    ap.add_argument("--max-length", type=bounded_int(8, 512), default=512, help="roberta-large caps at 512")
    ap.add_argument("--batch-size", type=bounded_int(1, 256), default=32)
    ap.add_argument("--lid-model", type=Path, default=DEFAULT_LID_PATH,
                    help="fastText lid.176.ftz path (must exist: `anagram model` fetches it, never the daemon)")
    ap.add_argument("--no-language-gate", action="store_true", help="score every block regardless of language")
    ap.add_argument("--selftest", action="store_true",
                    help="score the sample paragraphs, check what they should say, exit non-zero if not")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
    # Exactly two names, everywhere: what we bind, what the Host allow-list answers to, what the
    # Origin guard counts as our own. They are the two the extension can be pointed at, because
    # a browser's content-security policy can name a host and a port and nothing cleverer — so a
    # daemon listening on 127.0.0.2 or [::1] would answer nothing the product can send it, while
    # each extra name is another Host a rebinding page may guess. Other loopback addresses are
    # refused with the rest: --allow-remote is the one way through, and it says what it costs.
    if args.host not in LOOPBACK_HOSTS and not args.allow_remote:
        sys.exit(f"--host {args.host} is not one of {' or '.join(LOOPBACK_HOSTS)}.\n"
                 f"  those are the only two addresses the extension can be pointed at (a browser's CSP\n"
                 f"  cannot name another), so nothing it sends would arrive here.\n"
                 f"  pass --allow-remote to bind it anyway — page text may then leave this machine")
    # The gate is loaded first: it is part of what the served model version identifies.
    lid = LanguageId.disabled() if args.no_language_gate else LanguageId(args.lid_model)
    engine = EditLens(args.model_dir, args.device, args.max_length, args.batch_size, args.dtype, lid)

    if args.selftest:
        failures = run_selftest(engine)
        if failures:
            sys.exit(f"selftest FAILED: {failures} expectation(s) did not hold")
        return

    import uvicorn

    app = make_app(engine, allowed_hosts_for(args.host), args.port)
    log.info("listening on http://%s:%d  (GET /health, POST /score, GET /docs) — model %s",
             args.host, args.port, engine.version)
    # Our own per-request log line above replaces uvicorn's access log.
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
