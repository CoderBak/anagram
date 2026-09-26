#!/usr/bin/env python3
"""Anagram's scoring against Pangram's official EditLens inference, on the gated test split.

  ANAGRAM_EDITLENS_DATA=<pangramlabs/EditLens checkout: scripts/, data/test.csv, roberta-large-tok/>
  ANAGRAM_MODELKIT=<verified modelkit directory>  ANAGRAM_LID_MODEL=<lid.176.ftz>
  python test/editlens-parity.py [--n 200] [--python <anagramd python>]

Run it with a Python that has the engine's dependencies and scipy. A fixed sample of the
test split (by bucket of the training label and by length, half of it longer than the 512
tokens the model reads) is scored twice with the same weights:

- OFFICIAL: scripts/preprocess.py clean_text, then scripts/inference.py's steps — the
  FacebookAI/roberta-large tokenizer with truncation at 512, DataCollatorWithPadding in
  batches of 24, softmax, argmax, probs @ arange(4) / 3. Its Trainer runs in bf16 on a GPU;
  here the forward pass is FP32 on the CPU, the precision the engine selects for itself.
- ANAGRAM: the native host itself, over stdio, in a throwaway component home holding
  links to the modelkit, choosing its runtime as it does for a user.

Every text's four probabilities must agree to 1e-4 (the host rounds them to four places),
and the bucket, the verdict word (score cuts 1/6, 1/2, 5/6) and the token count exactly.
A text the language gate turns away is reported, not compared. Skips when a path is
missing or CI is set; never part of CI, because the data is gated.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
DAEMON = ROOT / "anagramd"
MAX_LENGTH = 512
BATCH = 24  # scripts/inference.py --batch_size default
CUTS = (1 / 6, 1 / 2, 5 / 6)  # lib/render/scale.ts SCORE_CUTS
TOLERANCE = 1e-4
APP_FILES = ("native_host.py", "native_component.py", "download_modelkit.py", "model_plan.py", "modelkit.json",
             "runtime_controller.py", "runtime_adapters.py", "benchmark_worker.py", "scoring.py", "engine.py",
             "safe_files.py", "pyproject.toml")


def level(score: float) -> int:
    return sum(score >= cut for cut in CUTS)


def paths() -> tuple[Path, Path, Path] | None:
    if os.environ.get("CI"):
        print("SKIP  EditLens parity — never in CI")
        return None
    names = ("ANAGRAM_EDITLENS_DATA", "ANAGRAM_MODELKIT", "ANAGRAM_LID_MODEL")
    values = [os.environ.get(name) for name in names]
    if not all(values):
        print(f"SKIP  EditLens parity — set {', '.join(n for n, v in zip(names, values) if not v)}")
        return None
    data, kit, lid = (Path(v).expanduser().resolve() for v in values)
    needed = [data / "scripts/preprocess.py", data / "data/test.csv", data / "roberta-large-tok/tokenizer.json",
              kit / "config.json", kit / "model.safetensors", lid]
    missing = [str(p) for p in needed if not p.is_file()]
    if missing:
        print(f"SKIP  EditLens parity — missing {', '.join(missing)}")
        return None
    return data, kit, lid


def bucket_of(score: float) -> int:
    """scripts/preprocess.py score_to_bucket with configs/roberta.yaml's 4, 0.03, 0.15."""
    lo, hi, n = 0.03, 0.15, 4
    if score <= lo:
        return 0
    if score >= hi:
        return n - 1
    return 1 + int((score - lo) / (hi - lo) * (n - 2))


def sample(rows: list[dict], lengths: list[int], n: int) -> list[int]:
    """n/8 texts from each training bucket × (fits 512 tokens, longer), by hash of text_id."""
    strata: dict[tuple[int, bool], list[int]] = {}
    for i, row in enumerate(rows):
        try:
            score = float(row["cosine_score"])
        except ValueError:
            continue
        if math.isnan(score):
            continue
        strata.setdefault((bucket_of(score), lengths[i] > MAX_LENGTH), []).append(i)
    key = lambda i: hashlib.sha256(rows[i]["text_id"].encode()).hexdigest()
    ordered = {k: sorted(v, key=key) for k, v in sorted(strata.items())}
    per = n // len(ordered)
    chosen = [i for v in ordered.values() for i in v[:per]]
    rest = sorted((i for v in ordered.values() for i in v[per:]), key=key)
    return sorted(chosen + rest[:n - len(chosen)], key=key)


def official(data: Path, kit: Path, texts: list[str]):
    """scripts/inference.py run_inference, minus datasets/Trainer: same cleaning, tokenizer,
    truncation, collator, softmax and score, in FP32 on the CPU."""
    import numpy as np
    import torch
    from scipy.special import softmax
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, DataCollatorWithPadding

    sys.path.insert(0, str(data / "scripts"))
    from preprocess import clean_text  # the official module, unchanged

    tokenizer = AutoTokenizer.from_pretrained(str(data / "roberta-large-tok"))
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        tokenizer.padding_side = "left"
    model = AutoModelForSequenceClassification.from_pretrained(str(kit)).eval()
    if model.dtype != torch.float32:
        raise SystemExit(f"FAIL  the checkpoint loaded as {model.dtype}, not FP32")
    n_buckets = model.config.num_labels
    features = [tokenizer(clean_text(t), truncation=True, max_length=MAX_LENGTH) for t in texts]
    collate = DataCollatorWithPadding(tokenizer)
    logits = []
    with torch.inference_mode():
        for start in range(0, len(features), BATCH):
            batch = collate([dict(f) for f in features[start:start + BATCH]])
            logits.append(model(**batch).logits.float().numpy())
    probs = softmax(np.concatenate(logits), axis=1)
    scores = (probs @ np.arange(n_buckets)) / (n_buckets - 1)
    return probs, probs.argmax(axis=1), scores, [len(f["input_ids"]) for f in features]


class Host:
    """The native host over stdio, in `home`, with downloads made impossible."""

    def __init__(self, python: Path, home: Path, log):
        fixture = home / "app/parity-fixture.py"
        fixture.write_text("import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(__file__).parent))\n"
                           "import download_modelkit\ndef no_network(*a,**k): raise AssertionError('parity attempted a download')\n"
                           "download_modelkit.transfer_asset=no_network\nimport native_host\nnative_host.main()\n")
        self.process = subprocess.Popen([str(python), "-I", "-u", str(fixture), "--home", str(home)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, cwd=home)
        self.sequence = 0

    def read(self, size: int, timeout: float) -> bytes:
        out, end = b"", time.monotonic() + timeout
        while len(out) < size:
            left = end - time.monotonic()
            if left <= 0 or not select.select([self.process.stdout], [], [], left)[0]:
                raise TimeoutError("native reply did not arrive")
            part = os.read(self.process.stdout.fileno(), size - len(out))
            if not part:
                raise RuntimeError(f"native host exited: {self.process.poll()}")
            out += part
        return out

    def request(self, op: str, payload: dict | None = None, timeout: float = 60) -> dict:
        self.sequence += 1
        body = json.dumps({"v": 1, "id": f"parity-{self.sequence}", "op": op, "payload": payload or {}}).encode()
        self.process.stdin.write(struct.pack("=I", len(body)) + body)
        self.process.stdin.flush()
        reply = json.loads(self.read(struct.unpack("=I", self.read(4, timeout))[0], timeout))
        if not reply.get("ok"):
            raise RuntimeError(f"{op} failed: {reply}")
        return reply["data"]

    def ready(self, timeout: float = 600) -> dict:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            data = self.request("status")
            if data["state"] == "ready":
                return data
            if data["state"] == "error":
                raise RuntimeError(f"engine error: {data}")
            time.sleep(0.25)
        raise TimeoutError("native component never became ready")

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.process.kill()


def prepare_home(python: Path, home: Path, kit: Path, lid: Path) -> None:
    """A component home holding the files the host's own plan selects, linked, not copied."""
    probe = subprocess.run([str(python), "-I", "-B", "-c",
                            "import sys,json;sys.path.insert(0,sys.argv[1]);"
                            "from model_plan import build_plan,discover_hardware;"
                            "from download_modelkit import load_pin,PIN;"
                            "print(json.dumps(build_plan(load_pin(PIN),discover_hardware())))", str(DAEMON)],
                           capture_output=True, text=True, check=True, timeout=120)
    selected = set(json.loads(probe.stdout)["selected_paths"])
    pin = json.loads((DAEMON / "modelkit.json").read_text())
    (home / "app").mkdir(parents=True)
    models = home / "models/editlens_roberta-large"
    models.mkdir(parents=True)
    (home / ".native-component.json").write_text(json.dumps(
        {"schema_version": 1, "host": "dev.coderbak.anagram", "home": str(home)}))
    for name in APP_FILES:
        shutil.copyfile(DAEMON / name, home / "app" / name)

    def link(source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, target)
        except OSError:
            shutil.copyfile(source, target)

    for entry in pin["files"]:
        if entry["path"] not in selected:
            continue
        source = kit / entry["path"]
        if not source.is_file() or source.stat().st_size != entry["size_bytes"]:
            raise SystemExit(f"FAIL  modelkit file missing or not the pinned size: {source}")
        link(source, models / entry["path"])
    link(lid, home / "models/lid.176.ftz")


def anagram(python: Path, kit: Path, lid: Path, texts: list[str], report: dict) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="anagram-parity-") as temporary:
        home = Path(temporary).resolve() / "owned"
        prepare_home(python, home, kit, lid)
        with (home / "host.log").open("wb") as log:
            host = Host(python, home, log)
            try:
                began = time.monotonic()
                status = host.ready()
                report["anagram_ready_s"] = round(time.monotonic() - began, 1)
                report["runtime"] = status["runtime"]["active_id"]
                began = time.monotonic()
                results = []
                for start in range(0, len(texts), 50):
                    blocks = [{"id": str(i), "text": t} for i, t in enumerate(texts[start:start + 50], start)]
                    data = host.request("score", {"v": "3.0", "blocks": blocks}, timeout=900)
                    results.extend(data["results"])
                report["anagram_score_s"] = round(time.monotonic() - began, 1)
                report["model_version"] = data["model"]["ver"]
                return results
            except BaseException:
                log.flush()
                print((home / "host.log").read_text(errors="replace")[-8000:])
                raise
            finally:
                host.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--n", type=int, default=200)
    parser.add_argument("--python", type=Path, default=Path(sys.executable), help="Python the native host runs on")
    parser.add_argument("--report", type=Path, help="write per-text results as JSON here")
    args = parser.parse_args()
    found = paths()
    if found is None:
        return 0
    data, kit, lid = found
    from transformers import AutoTokenizer, logging as hf_logging
    hf_logging.set_verbosity_error()
    hf_logging.disable_progress_bar()
    sys.path.insert(0, str(data / "scripts"))
    from preprocess import clean_text

    csv.field_size_limit(sys.maxsize)
    with (data / "data/test.csv").open(newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if r["text"] and len(r["text"]) <= 16000]
    tokenizer = AutoTokenizer.from_pretrained(str(data / "roberta-large-tok"))
    lengths = [len(ids) for ids in tokenizer([clean_text(r["text"]) for r in rows], truncation=False)["input_ids"]]
    picked = sample(rows, lengths, args.n)
    texts = [rows[i]["text"] for i in picked]
    report = {"sample": len(picked), "longer_than_512": sum(lengths[i] > MAX_LENGTH for i in picked)}

    began = time.monotonic()
    probs, buckets, scores, counts = official(data, kit, texts)
    report["official_s"] = round(time.monotonic() - began, 1)
    ours = anagram(args.python, kit, lid, texts, report)

    failures, gated, rows_out = [], [], []
    dp, ds, exact = [], [], 0
    for k, (i, r) in enumerate(zip(picked, ours)):
        if r.get("unsupported"):
            gated.append((rows[i]["text_id"], r.get("lang"), r.get("lang_prob")))
            continue
        diff = max(abs(float(a) - float(b)) for a, b in zip(r["probs"], probs[k]))
        dp.append(diff)
        ds.append(abs(r["score"] - scores[k]))
        exact += [round(float(x), 4) for x in probs[k]] == r["probs"]
        same = (diff <= TOLERANCE and r["bucket"] == int(buckets[k]) and level(r["score"]) == level(float(scores[k]))
                and r["tokens"] == counts[k] and r["truncated"] == (lengths[i] > MAX_LENGTH))
        if not same:
            failures.append(rows[i]["text_id"])
        rows_out.append({"text_id": rows[i]["text_id"], "tokens": lengths[i], "official": [float(x) for x in probs[k]],
                         "anagram": r["probs"], "max_abs_diff": diff, "bucket": [int(buckets[k]), r["bucket"]],
                         "level": [level(float(scores[k])), level(r["score"])], "ok": same})
    compared = len(dp)
    report.update(compared=compared, gated=len(gated), rounded_identical=exact,
                  max_prob_diff=max(dp, default=0.0), mean_prob_diff=sum(dp) / max(1, compared),
                  max_score_diff=max(ds, default=0.0), mean_score_diff=sum(ds) / max(1, compared),
                  bucket_agreement=sum(r["bucket"][0] == r["bucket"][1] for r in rows_out) / max(1, compared),
                  verdict_agreement=sum(r["level"][0] == r["level"][1] for r in rows_out) / max(1, compared))
    if args.report:
        args.report.write_text(json.dumps({"summary": report, "texts": rows_out, "gated": gated}, indent=1))
    print(json.dumps(report, indent=1))
    for text_id, lang, prob in gated:
        print(f"NOTE  language gate refused {text_id} ({lang} {prob})")
    if failures or compared == 0:
        print(f"FAIL  EditLens parity — {len(failures)} of {compared} texts differ: {', '.join(failures[:10])}")
        return 1
    print(f"PASS  EditLens parity — {compared} texts, max |Δp| {report['max_prob_diff']:.2e} "
          f"({exact} identical at the host's four places), buckets, verdicts and token counts identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
