"""Local EditLens inference, language gating, contract validation and model identity.

Native Messaging owns transport and lifecycle. Model loading is strictly offline.
Preprocessing follows pangramlabs/EditLens scripts/preprocess.py.
"""

from __future__ import annotations
import os

for _offline_var in (
    "HF_HUB_OFFLINE",
    "TRANSFORMERS_OFFLINE",
    "HF_DATASETS_OFFLINE",
    "HF_HUB_DISABLE_TELEMETRY",
    "HF_HUB_DISABLE_IMPLICIT_TOKEN",
):
    os.environ[_offline_var] = "1"
import hashlib
import inspect
import logging
import re
import sys
import threading
import time
import tomllib
from pathlib import Path
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scoring import score_texts

CONTRACT_VERSION = "2.1"
CONTRACT_MAJOR = CONTRACT_VERSION.split(".")[0]
MODEL_ID = "editlens_roberta-large"
PIPELINE_REV = "pre1"
PIPELINE_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
)
CALIBRATION = "editlens-4bucket-cosine(0.03,0.15)"
LABEL_SCHEMA = CALIBRATION
BUCKET_LABELS = ["human", "lightly-edited", "heavily-edited", "ai-generated"]
SUPPORTED_LANGUAGES = ["en"]
MAX_BLOCKS = 256
MAX_TEXT_CHARS = 16000
MAX_ID_CHARS = 64
log = logging.getLogger("anagramd")


def read_app_version() -> str | None:
    """The engine's own release version, for health responses — read from where it already lives."""
    here = Path(__file__).resolve().parent
    try:
        version = tomllib.loads((here / "pyproject.toml").read_text())["project"][
            "version"
        ]
        if isinstance(version, str) and version:
            return version
    except (OSError, KeyError, ValueError):
        pass
    try:
        return (here.parent / "VERSION").read_text().strip() or None
    except OSError:
        return None


APP_VERSION = read_app_version()
_BOILERPLATE_STARTS = [
    "Sure",
    "Here",
    "Abstract",
    "Title",
    "I'm happy to help",
    "Certainly",
]


def _normalize_whitespace(text: str) -> str:
    return re.sub("\\s+", " ", text).strip()


def _remove_think_tag(text: str) -> str:
    if "</think>" in text:
        text = text.split("</think>")[1].strip()
    return text


def _remove_ai_header(text: str, emoji_mod) -> str:
    paragraphs = [p for p in text.split("\n") if p.strip()]
    if not paragraphs:
        return text
    first = re.sub("^[^a-zA-Z0-9]*", "", paragraphs[0])
    first = emoji_mod.replace_emoji(first, "")
    if any((first.startswith(p) for p in _BOILERPLATE_STARTS)) and len(paragraphs) > 1:
        text = "\n".join(paragraphs[1:])
    return text


def clean_text(text: str, emoji_mod) -> str:
    text = emoji_mod.demojize(text)
    text = _remove_think_tag(text)
    text = _remove_ai_header(text, emoji_mod)
    text = text.lower()
    return _normalize_whitespace(text)


class LanguageId:
    """fastText lid.176 (176 languages, ~1 MB compressed). `detect` → (iso639-1 code, prob)."""

    def __init__(self, path: Path):
        self.model = None
        self.name = None
        self.digest = None
        if not path.exists():
            raise RuntimeError(
                f"Language model missing: {path}. Download models in Anagram Settings."
            )
        try:
            import fasttext
        except Exception as exc:
            raise RuntimeError(
                "fastText is unavailable; repair the local component installation"
            ) from exc
        self.digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.model = fasttext.load_model(str(path))
        self.name = "fasttext-lid.176"
        log.info(
            "language gate: fastText lid.176 loaded (sha256 %s…); supported = %s",
            self.digest[:12],
            SUPPORTED_LANGUAGES,
        )

    @property
    def enabled(self) -> bool:
        return self.model is not None

    def detect(self, text: str) -> tuple[str, float]:
        pairs = self.model.f.predict(text.replace("\n", " "), 1, 0.0, "strict")
        if not pairs:
            return ("und", 0.0)
        prob, label = pairs[0]
        return (label.replace("__label__", ""), float(prob))


def require_model(model_dir: Path) -> None:
    """The checkpoint has to be on disk already: starting the engine downloads nothing."""
    if (model_dir / "config.json").exists():
        return
    raise RuntimeError(
        f"EditLens model missing: {model_dir}. Download models in Anagram Settings."
    )


def preprocess_digest() -> str:
    """SHA-256 (12 hex) of the preprocessing source itself."""
    try:
        source = "".join(
            (
                inspect.getsource(fn)
                for fn in (
                    _normalize_whitespace,
                    _remove_think_tag,
                    _remove_ai_header,
                    clean_text,
                )
            )
        )
    except (OSError, TypeError):
        return "src-unavailable"
    return hashlib.sha256((source + repr(_BOILERPLATE_STARTS)).encode()).hexdigest()[
        :12
    ]


def pipeline_manifest(
    model_dir: Path, max_length: int, dtype: str, lid: LanguageId
) -> dict:
    """Everything except the weights that can change what a paragraph comes back as."""
    return {
        "files": {
            name: hashlib.sha256((model_dir / name).read_bytes()).hexdigest()
            for name in PIPELINE_FILES
            if (model_dir / name).is_file()
        },
        "max_length": max_length,
        "dtype": dtype,
        "language_gate": lid.enabled,
        "lid": {"name": lid.name, "sha256": lid.digest} if lid.enabled else None,
        "languages": SUPPORTED_LANGUAGES,
        "labels": BUCKET_LABELS,
        "label_schema": LABEL_SCHEMA,
        "preprocess": preprocess_digest(),
        "rev": PIPELINE_REV,
    }


class EditLens:

    def __init__(
        self,
        model_dir: Path,
        device: str,
        max_length: int,
        batch_size: int,
        dtype: str,
        lid: LanguageId,
        *,
        warmup: bool = True,
    ):
        import emoji
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.emoji = emoji
        self.torch = torch
        self.lid = lid
        self.max_length = max_length
        self.batch_size = batch_size
        self.lock = threading.Lock()
        self.last_run_ms = 0.0
        self.last_wait_ms = 0.0
        require_model(model_dir)
        self.device = device
        if dtype == "auto":
            dtype = "fp32"
        if dtype == "fp16" and self.device == "cpu":
            raise ValueError(
                "PyTorch CPU FP16 is not an offered runtime; choose CPU FP32 or an ONNX candidate"
            )
        self.dtype = torch.float16 if dtype == "fp16" else torch.float32
        self.dtype_name = str(self.dtype).replace("torch.", "")
        self.version = None  # runtime_adapters names the loaded artifacts
        t0 = time.time()
        self.tok = AutoTokenizer.from_pretrained(
            str(model_dir), local_files_only=True, trust_remote_code=False
        )
        self.model = self._load(AutoModelForSequenceClassification, model_dir)
        self.model.to(self.device).eval()
        self.n_buckets = int(self.model.config.num_labels)
        if self.n_buckets != len(BUCKET_LABELS):
            raise ValueError(
                f"model has {self.n_buckets} labels, expected {len(BUCKET_LABELS)}"
            )
        log.info(
            "loaded %s on %s (%s) in %.1fs — %d buckets, max %d tokens",
            model_dir.name,
            self.device,
            self.dtype_name,
            time.time() - t0,
            self.n_buckets,
            max_length,
        )
        if warmup:
            self._warmup()

    def _load(self, cls, model_dir: Path):
        """transformers 5 renamed `torch_dtype` to `dtype`; support both."""
        try:
            return cls.from_pretrained(
                str(model_dir),
                dtype=self.dtype,
                local_files_only=True,
                trust_remote_code=False,
            )
        except TypeError:
            return cls.from_pretrained(
                str(model_dir),
                torch_dtype=self.dtype,
                local_files_only=True,
                trust_remote_code=False,
            )

    def _warmup(self) -> None:
        t0 = time.time()
        self.score(["warm-up paragraph " * 40])
        log.info("warm-up forward pass %.0f ms", (time.time() - t0) * 1000)

    def score(self, texts: list[str]) -> list[dict]:
        """Score raw texts; returns one dict per input in the same order."""
        return score_texts(self, texts, clean_text)

    def _logits(self, ids):
        with self.torch.inference_mode():
            enc = self.tok.pad(
                {"input_ids": ids}, padding=True, return_tensors="pt"
            ).to(self.device)
            return self.model(**enc).logits.float().cpu().numpy()

    def synchronize(self):
        if self.device == "mps":
            self.torch.mps.synchronize()
        elif self.device.startswith("cuda"):
            self.torch.cuda.synchronize(self.device)

    def accelerator_bytes(self):
        if self.device == "mps":
            return self.torch.mps.driver_allocated_memory()
        if self.device.startswith("cuda"):
            return self.torch.cuda.max_memory_allocated(self.device)
        return None

    def reset_accelerator_peak(self):
        if self.device.startswith("cuda"):
            self.torch.cuda.reset_peak_memory_stats(self.device)

    def close(self):
        import gc

        self.model = None
        self.tok = None
        gc.collect()
        if getattr(self, "device", None) == "mps":
            self.torch.mps.empty_cache()
        elif getattr(self, "device", "").startswith("cuda"):
            with self.torch.cuda.device(self.device):
                self.torch.cuda.empty_cache()

    def info(self) -> dict:
        return {
            "ok": True,
            "contract": CONTRACT_VERSION,
            "app_version": APP_VERSION,
            "model": {
                "id": MODEL_ID,
                "ver": self.version,
                "calibration": CALIBRATION,
            },
            "n_buckets": self.n_buckets,
            "buckets": BUCKET_LABELS[: self.n_buckets],
            "languages": SUPPORTED_LANGUAGES,
            "lid": self.lid.name if self.lid.enabled else None,
            "max_tokens": self.max_length,
            "device": self.device,
            "dtype": self.dtype_name,
        }


class Block(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=MAX_ID_CHARS)
    text: str = Field(default="", max_length=MAX_TEXT_CHARS)


class ScoreRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    v: str = Field(max_length=16)
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


class ScoreResponse(BaseModel):
    v: str
    model: ModelInfo
    results: list[ScoreResult]


def unsupported_result(block_id: str, n_buckets: int, lang: str, prob: float) -> dict:
    return {
        "id": block_id,
        "bucket": 0,
        "probs": [1 / n_buckets] * n_buckets,
        "score": 0.0,
        "tokens": 0,
        "truncated": False,
        "lang": lang,
        "lang_prob": round(prob, 3),
        "unsupported": True,
    }


def score_with_engine(req: ScoreRequest, engine) -> dict:
    t0 = time.time()
    texts, todo, langs, skipped = ([], [], {}, {})
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
        if r is None:
            results.append(
                {
                    "id": b.id,
                    "bucket": 0,
                    "probs": [1 / engine.n_buckets] * engine.n_buckets,
                    "score": 0.0,
                    "tokens": 0,
                    "truncated": False,
                    "degraded": True,
                }
            )
        else:
            out = {"id": b.id, **r}
            if b.id in langs:
                out["lang"], out["lang_prob"] = (
                    langs[b.id][0],
                    round(langs[b.id][1], 3),
                )
            results.append(out)
    ms = (time.time() - t0) * 1000
    log.info(
        "score %d blocks (%d tok): %.0f ms model, %.0f ms queued, %.0f ms total — buckets %s%s",
        len(texts),
        sum((r["tokens"] for r in scored)),
        engine.last_run_ms,
        engine.last_wait_ms,
        ms,
        [r["bucket"] for r in scored],
        (
            f" — {len(skipped)} unsupported ({', '.join(sorted({v[0] for v in skipped.values()}))})"
            if skipped
            else ""
        ),
    )
    return {
        "v": CONTRACT_VERSION,
        "model": engine.info()["model"],
        "results": results,
    }
