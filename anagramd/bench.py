#!/usr/bin/env python3
"""bench.py — speed and resource needs of the EditLens checkpoints on THIS machine.

Loads each checkpoint the way the reference `scripts/inference.py` does, then measures:
    load        wall time, disk size, process RSS growth, accelerator memory after load
    latency     one paragraph at a time (the interactive path: a chip appearing on scroll)
    throughput  batches of 8 / 32 paragraphs at several paragraph lengths (the prefetch path)
    footprint   peak process RSS and peak MPS/CUDA driver memory during the run
    sanity      buckets on the daemon's selftest samples (human / AI / lightly edited)

Checkpoints
    roberta-large   pangram/editlens_roberta-large — full weights (RobertaForSequenceClassification)
    llama-3.2-3b    pangram/editlens_Llama-3.2-3B  — a LoRA adapter (r=8) + NormedLinear score head
                    on meta-llama/Llama-3.2-3B; the adapter is merged into the base for inference.
                    The reference runs this base 4-bit (QLoRA, bitsandbytes); bitsandbytes has no
                    MPS kernels, so here the base is fp16 — the adapter weights are identical.

A DEVELOPER TOOL, and only that: it is not in the release tarball (scripts/release.mjs),
because the installed venv omits its `peft` and `accelerate` packages: they are the
`bench` extra and `uv sync --no-dev` does not install extras. `psutil` is a base dependency.
MODELS_DIR below resolves to the models directory beside the repository, which does not
exist in an installation either. Run it from a checkout, against `../../models/`.

Usage
    .venv/bin/python bench.py                      # both checkpoints, MPS if available
    .venv/bin/python bench.py --models roberta-large
    .venv/bin/python bench.py --json out.json --runs 5
    .venv/bin/python bench.py --online             # allow the Hub to fetch what is missing
"""
from __future__ import annotations

import os
import sys

# The same switch serve.py throws, and for the same reason: huggingface_hub and transformers
# read these variables once, at their own import time, so it has to happen before anything
# can import them. It matters more here than there, because the LoRA checkpoint below is
# measured on meta-llama/Llama-3.2-3B — a base model that a missing local directory would
# otherwise have this script quietly download, six gigabytes of it, in the middle of a
# benchmark. Offline, the same situation is a local error naming the file that is missing.
# --online is read straight from argv because argparse runs far too late to be of use.
OFFLINE_VARS = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE",
                "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN")
ONLINE = "--online" in sys.argv
if not ONLINE:
    for _offline_var in OFFLINE_VARS:
        os.environ[_offline_var] = "1"

import argparse
import gc
import json
import resource
import statistics
import time
from pathlib import Path

import numpy as np
import psutil
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import BUCKET_LABELS, SELFTEST, clean_text  # noqa: E402

# serve.py throws the same switch when IT is imported, which is after ours, so --online has
# to undo it again here. This is still early enough to count: transformers and
# huggingface_hub do not arrive until the first Bench is built, several lines below.
if ONLINE:
    for _offline_var in OFFLINE_VARS:
        os.environ.pop(_offline_var, None)

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"
CHECKPOINTS = {
    "roberta-large": {
        "kind": "full",
        "path": MODELS_DIR / "editlens_roberta-large",
        "max_length": 512,  # hard cap of the architecture
    },
    "llama-3.2-3b": {
        "kind": "lora",
        "base": MODELS_DIR / "Llama-3.2-3B",
        "adapter": MODELS_DIR / "editlens_Llama-3.2-3B",
        "max_length": 1024,  # reference default; paragraphs here never reach it
    },
}

# Realistic English prose to build paragraphs of controlled length from.
SENTENCES = [
    "I got the call around six, right when the rice was starting to catch on the bottom of the pan.",
    "My brother never rings on weeknights, so I turned the burner off and sat on the floor to listen.",
    "He talked for twenty minutes about a dog he was thinking of adopting.",
    "Afterwards the rice was ruined and I ate it anyway, standing at the counter with the window open.",
    "The flat we rented that spring had radiators that clanked all night and a landlord who promised a plumber.",
    "From the kitchen you could see a slice of the canal if you leaned out far enough.",
    "Some mornings a heron stood there like it owned the place, and we stayed four years partly because of it.",
    "In today's rapidly evolving digital landscape, effective communication has become more crucial than ever.",
    "By leveraging cutting-edge technologies, organizations can unlock unprecedented opportunities for growth.",
    "This comprehensive approach empowers teams to navigate complex challenges with confidence and agility.",
    "Building a consistent writing habit is one of the most valuable investments you can make.",
    "Start by setting aside a dedicated time each day, even if it is just fifteen minutes.",
    "Remember that progress matters more than perfection, so embrace imperfect drafts along the way.",
    "The committee met twice that autumn and agreed on almost nothing except the date of the next meeting.",
    "Nobody had checked whether the old bridge could take the weight, and by then it was too late to ask.",
]


def paragraph(words: int, seed: int) -> str:
    """~`words` words of varied prose; `seed` rotates the sentence order so texts differ."""
    out: list[str] = []
    n = 0
    i = seed
    while n < words:
        s = SENTENCES[i % len(SENTENCES)]
        out.append(s)
        n += len(s.split())
        i += 1
    return " ".join(out)


def sync(device: str) -> None:
    if device == "mps":
        torch.mps.synchronize()
    elif device == "cuda":
        torch.cuda.synchronize()


def accel_mem(device: str) -> int:
    if device == "mps":
        return torch.mps.driver_allocated_memory()
    if device == "cuda":
        return torch.cuda.memory_allocated()
    return 0


def dir_bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file() and ".cache" not in f.parts)


def rss() -> int:
    return psutil.Process().memory_info().rss


def peak_rss() -> int:
    # macOS reports ru_maxrss in bytes; Linux in kilobytes.
    v = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return v if sys.platform == "darwin" else v * 1024


class Bench:
    def __init__(self, name: str, spec: dict, device: str, dtype: torch.dtype):
        import emoji
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.name, self.spec, self.device, self.dtype = name, spec, device, dtype
        self.emoji = emoji
        self.max_length = spec["max_length"]
        gc.collect()
        rss0, accel0 = rss(), accel_mem(device)
        t0 = time.time()
        if spec["kind"] == "full":
            self.disk = dir_bytes(spec["path"])
            self.tok = AutoTokenizer.from_pretrained(str(spec["path"]))
            self.model = AutoModelForSequenceClassification.from_pretrained(str(spec["path"]), dtype=dtype)
        else:
            from peft import PeftModel
            from train_head import NormedLinear

            self.disk = dir_bytes(spec["base"]) + dir_bytes(spec["adapter"])
            self.tok = AutoTokenizer.from_pretrained(str(spec["adapter"]))
            if self.tok.pad_token is None:
                self.tok.pad_token = self.tok.eos_token
                self.tok.padding_side = "left"
            base = AutoModelForSequenceClassification.from_pretrained(
                str(spec["base"]), num_labels=len(BUCKET_LABELS), dtype=dtype,
            )
            base.config.pad_token_id = self.tok.pad_token_id
            base.score = NormedLinear(base.config.hidden_size, len(BUCKET_LABELS), dtype=dtype)
            peft_model = PeftModel.from_pretrained(base, str(spec["adapter"]))
            self.model = peft_model.merge_and_unload()  # plain Llama with the adapter folded in
        self.model.to(device).eval()
        sync(device)
        self.load_s = time.time() - t0
        self.params = sum(p.numel() for p in self.model.parameters())
        self.rss_after_load = rss() - rss0
        self.accel_after_load = accel_mem(device) - accel0
        self.peak_accel = accel_mem(device)

    @torch.inference_mode()
    def score(self, texts: list[str]) -> tuple[np.ndarray, int]:
        cleaned = [clean_text(t, self.emoji) for t in texts]
        enc = self.tok(cleaned, truncation=True, max_length=self.max_length, padding=True,
                       return_tensors="pt").to(self.device)
        logits = self.model(**enc).logits.float()
        sync(self.device)
        self.peak_accel = max(self.peak_accel, accel_mem(self.device))
        probs = torch.softmax(logits, dim=-1).cpu().numpy()
        return probs, int(enc["attention_mask"].sum().item())

    def timed(self, texts: list[str], runs: int) -> dict:
        for _ in range(2):  # warm-up: shader compilation / allocator growth
            self.score(texts)
        times, tokens = [], 0
        for _ in range(runs):
            t0 = time.perf_counter()
            _, tokens = self.score(texts)
            times.append(time.perf_counter() - t0)
        med = statistics.median(times)
        return {
            "batch": len(texts),
            "tokens_per_para": round(tokens / len(texts)),
            "median_ms": round(med * 1000, 1),
            "p95_ms": round(sorted(times)[max(0, int(len(times) * 0.95) - 1)] * 1000, 1),
            "paras_per_s": round(len(texts) / med, 2),
            "tokens_per_s": round(tokens / med),
        }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=list(CHECKPOINTS), choices=list(CHECKPOINTS))
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    ap.add_argument("--dtype", default="fp16", choices=["fp16", "bf16", "fp32"])
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--json", type=Path, default=None)
    # Declared so --help lists it and argparse does not reject it; the flag itself was
    # acted on at the top of this file, long before argparse existed.
    ap.add_argument("--online", action="store_true",
                    help="let the Hugging Face client fetch a model that is not on this disk")
    args = ap.parse_args()

    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    dtype = {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": torch.float32}[args.dtype]
    if device == "cpu" and dtype != torch.float32:
        dtype = torch.float32

    vm = psutil.virtual_memory()
    print(f"machine: {psutil.cpu_count(logical=True)} CPUs, {vm.total / 2**30:.0f} GB RAM, "
          f"device={device}, dtype={args.dtype}, torch {torch.__version__}")
    print(f"paragraph lengths: 60 / 120 / 250 / 400 words; batches 1 / 8 / 32; median of {args.runs} runs\n")

    results = {"device": device, "dtype": args.dtype, "torch": torch.__version__, "models": {}}
    for name in args.models:
        spec = CHECKPOINTS[name]
        missing = [p for p in (spec.get("path"), spec.get("base"), spec.get("adapter")) if p and not p.exists()]
        if missing:
            print(f"== {name}: SKIP — missing {missing}")
            continue
        print(f"== {name}")
        b = Bench(name, spec, device, dtype)
        r: dict = {
            "params_M": round(b.params / 1e6),
            "disk_GB": round(b.disk / 2**30, 2),
            "load_s": round(b.load_s, 1),
            "rss_growth_on_load_GB": round(b.rss_after_load / 2**30, 2),
            "accel_mem_after_load_GB": round(b.accel_after_load / 2**30, 2),
            "runs": [],
        }
        print(f"   {r['params_M']} M params · {r['disk_GB']} GB on disk · loaded in {r['load_s']} s · "
              f"RSS +{r['rss_growth_on_load_GB']} GB · accelerator {r['accel_mem_after_load_GB']} GB")

        # sanity: the daemon's selftest samples
        texts = [t for _, t in SELFTEST if not t.startswith("这")]
        probs, _ = b.score(texts)
        r["sanity"] = [
            {"expected": lbl, "bucket": BUCKET_LABELS[int(p.argmax())],
             "score": round(float(p @ np.arange(len(p)) / (len(p) - 1)), 3)}
            for (lbl, _), p in zip([s for s in SELFTEST if not s[1].startswith("这")], probs)
        ]
        print("   sanity:", ", ".join(f"{s['expected']}→{s['bucket']} ({s['score']})" for s in r["sanity"]))

        print(f"   {'words':>5} {'tok/para':>8} {'batch':>5} {'median ms':>10} {'p95 ms':>8} {'paras/s':>8} {'tokens/s':>9}")
        for words in (60, 120, 250, 400):
            for batch in (1, 8, 32):
                texts = [paragraph(words, seed=i * 3) for i in range(batch)]
                row = b.timed(texts, args.runs)
                row["words"] = words
                r["runs"].append(row)
                print(f"   {words:>5} {row['tokens_per_para']:>8} {batch:>5} {row['median_ms']:>10} "
                      f"{row['p95_ms']:>8} {row['paras_per_s']:>8} {row['tokens_per_s']:>9}")
        r["peak_accel_mem_GB"] = round(b.peak_accel / 2**30, 2)
        r["peak_rss_GB"] = round(peak_rss() / 2**30, 2)
        print(f"   peak accelerator memory {r['peak_accel_mem_GB']} GB · peak process RSS {r['peak_rss_GB']} GB\n")
        results["models"][name] = r
        del b
        gc.collect()
        if device == "mps":
            torch.mps.empty_cache()

    if args.json:
        args.json.write_text(json.dumps(results, indent=2))
        print("wrote", args.json)


if __name__ == "__main__":
    main()
