"""Local three-class detector for dated anagram-detectors releases."""

import datetime
import json
import os
from pathlib import Path
import re
import threading
import time
import unicodedata

SOURCE = "CoderBak/anagram-detectors"
LABELS = ["human", "ai_assisted", "ai_generated"]
DEFAULT = Path(__file__).with_name("detector-release.json")
RELEASE = re.compile(r"(\d{4}-\d{2}-\d{2})-([1-9]\d*(?:\.\d+)?[mb])(?:-[a-z0-9]+)*")
SENTENCE = re.compile(r"""[.!?…]+["'”’)\]]*(?=\s|$)|\n\s*\n""")
WORDS = re.compile(r"\b\w+(?:['’]\w+)*\b")
FILES = {f["path"] for f in json.loads(DEFAULT.read_text())["files"]}


def validate_release(pin):
    from download_modelkit import validate_pin

    validate_pin(pin)
    match = RELEASE.fullmatch(pin.get("release", ""))
    if (
        not match
        or len(pin["release"]) > 96
        or pin["repository"] != SOURCE
        or {f["path"] for f in pin["files"]} != FILES
    ):
        raise ValueError("Invalid detector release")
    datetime.date.fromisoformat(match[1])
    for f in pin["files"]:
        limit = 32 * 2**30 if f["path"] == "backbone/model.safetensors" else 16 * 2**20
        if not 0 < f["size_bytes"] <= limit:
            raise ValueError("Invalid detector file size")
    return pin


def selected(home, pending=True):
    from safe_files import read_json

    for name in (
        ["pending-detector.json", "active-detector.json"] if pending else ["active-detector.json"]
    ):
        try:
            return validate_release(read_json(home / name, max_bytes=16384))
        except FileNotFoundError:
            continue
    return validate_release(json.loads(DEFAULT.read_text()))


def reuse_weights(home, pin):
    """Link already verified identical files into the pending revision on the same disk."""
    from download_modelkit import matches, plain_tree

    previous = selected(home, pending=False)
    if previous["revision"] == pin["revision"]:
        return
    old, new = model_dir(home, previous), model_dir(home, pin)
    plain_tree(old)
    plain_tree(new)
    hashes = {f["path"]: f["sha256"] for f in previous["files"]}
    for entry in pin["files"]:
        name = entry["path"]
        target = new / name
        if target.exists() or hashes.get(name) != entry["sha256"] or not matches(old / name, entry):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(old / name, target)
        except OSError:
            pass


def retire_legacy_files(home):
    """Remove only recognized installed EditLens artifacts after the new runtime is ready."""
    from download_modelkit import matches, plain_tree
    legacy = home / "models/editlens_roberta-large"
    if not legacy.exists():
        return
    plain_tree(legacy)
    files = json.loads(Path(__file__).with_name("modelkit.json").read_text())["files"]
    for entry in files:
        path = legacy / entry["path"]
        if matches(path, entry):
            path.unlink()
    for directory, _, _ in os.walk(legacy, topdown=False):
        folder = Path(directory)
        if not any(folder.iterdir()):
            folder.rmdir()


def model_dir(home, pin):
    return home / "models" / ("detector-" + pin["revision"])


def plan(pin, profile):
    return dict(
        schema_version=1,
        profile=profile,
        devices=["CPU · ONNX Runtime"],
        selected_paths=[e["path"] for e in pin["files"]],
        total_bytes=sum(e["size_bytes"] for e in pin["files"]),
    )


def normalize(text):
    text = unicodedata.normalize("NFC", text).translate(
        str.maketrans("‘’‚′“”„″   ", "''''\"\"\"\"   ", "\u200b\u200c\u200d\ufeff")
    )
    text = re.sub(r"\s*—\s*", " -- ", text)
    text = re.sub(r"(?<=\w)–(?=\w)", "-", text)
    text = re.sub(r"\s*–\s*", " - ", text).replace("…", "...")
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]{2,}", " ", re.sub(r"[ \t]+\n", "\n", text))).strip()


def check_metadata(meta, crf, pin):
    match = RELEASE.fullmatch(pin["release"])
    if (
        meta.get("format") != "anagram-detector/1"
        or meta.get("classes") != LABELS
        or meta.get("heads") != ["token", "segment", "mixed"]
        or meta.get("decoder") != "linear_chain_crf"
        or meta.get("language") != "en"
        or (meta.get("release_date"), meta.get("size")) != match.groups()
        or not 0 < meta["stride"] <= meta["window"] <= 2048
        or not 1 <= meta["min_words"] <= 10000
        or not 1 <= crf.get("l_min", 0) <= meta["window"]
    ):
        raise ValueError("Unsupported detector release metadata")


class Detector:
    dtype_name = "fp32"
    device = "cpu"
    n_buckets = 3
    last_run_ms = last_wait_ms = 0

    def __init__(self, root, pin, lid):
        import numpy as np
        from runtime_controller import import_onnxruntime
        ort = import_onnxruntime()
        from tokenizers import Tokenizer
        from detector_graph import compile_graph
        from download_modelkit import plain_tree

        plain_tree(root)
        self.pin, self.lid = pin, lid
        self.meta = json.loads((root / "model.json").read_text())
        self.crf = json.loads((root / "crf.json").read_text())
        check_metadata(self.meta, self.crf, pin)
        self.max_length = self.meta["window"] + 2
        self.version = pin["revision"] + "-ort-cpu-crf2"
        self.tokenizer = Tokenizer.from_file(str(root / "tokenizer/tokenizer.json"))
        cfg = json.loads((root / "backbone/config.json").read_text())
        self.cls, self.sep = cfg["cls_token_id"], cfg["sep_token_id"]
        graph = root / "detector.onnx"
        import tempfile

        data = compile_graph(root, cfg, self.meta)
        with tempfile.NamedTemporaryFile(dir=root, delete=False) as stream:
            stream.write(data)
        os.replace(stream.name, graph)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = min(8, os.cpu_count() or 1)
        opts.add_session_config_entry("session.disable_prepacking", "1")
        self.session = ort.InferenceSession(str(graph), opts, providers=["CPUExecutionProvider"])
        self.lock = threading.Lock()
        buckets = np.arange(15) / 14
        self.phi = np.maximum(0, 1 - 2 * np.abs(buckets[:, None] - np.array([0, 0.5, 1])))
        self.w = np.asarray(self.crf["W"])
        self.bias = np.asarray(self.crf["alpha"]) + self.crf["delta"]

    def count_tokens(self, texts):
        cleaned = [normalize(t) for t in texts]

        def count(t):
            return len(self.tokenizer.encode(t, add_special_tokens=False).ids) if t else 0

        return {
            "alone": [count(t) for t in cleaned],
            "following": [count(" " + t) if t else 0 for t in cleaned],
            "window": self.meta["window"],
        }

    def score(self, texts):
        start = time.perf_counter()
        with self.lock:
            began = time.perf_counter()
            results = [self._one(text) for text in texts]
            self.last_run_ms = (time.perf_counter() - began) * 1000
            self.last_wait_ms = (began - start) * 1000
        return results

    def _one(self, text):
        import numpy as np

        if len(WORDS.findall(text)) < self.meta["min_words"] or not any(c.isalpha() for c in text):
            return dict(
                bucket=0, probs=[1 / 3] * 3, score=0, tokens=0, truncated=False, insufficient=True
            )
        text = normalize(text)
        encoded = self.tokenizer.encode(text, add_special_tokens=False)
        ids, offsets = encoded.ids, np.asarray(encoded.offsets)
        n, width, stride = len(ids), self.meta["window"], self.meta["stride"]
        last = max(0, n - width)
        starts = list(range(0, last + 1, stride))
        if starts[-1] != last:
            starts.append(last)
        features, count = np.zeros((n, 6)), np.zeros(n)
        mix, weight = np.zeros(n), np.zeros(n)
        for start in starts:
            end = min(start + width, n)
            tokens, seg, mixed = self.session.run(
                None, {"input_ids": np.asarray([self.cls, *ids[start:end], self.sep], dtype=np.int64)}
            )
            segment = np.exp(seg[0] - seg.max()) @ self.phi
            features[start:end, :3] += tokens[1:-1]
            features[start:end, 3:] += np.log(np.maximum(1e-6, segment / segment.sum()))
            count[start:end] += 1
            length = end - start
            centre = 1 - np.abs(np.arange(length) - (length - 1) / 2) / ((length + 1) / 2)
            mix[start:end] += centre * (mixed[0, 1] - mixed[0, 0])
            weight[start:end] += centre
        unary = (features / count[:, None]) @ self.w.T + self.bias
        mix /= weight
        back = np.zeros((n, 3), dtype=np.int8)
        scores = unary[0].copy()
        for i in range(1, n):
            cost = min(0, -self.crf["lambda"] + self.crf["gamma"] * (mix[i] + mix[i - 1]) / 2)
            choices = np.broadcast_to(scores[:, None] + cost, (3, 3)).copy()
            np.fill_diagonal(choices, scores)
            best = choices.argmax(axis=0)
            best[scores == choices.max(axis=0)] = np.arange(3)[scores == choices.max(axis=0)]
            back[i] = best
            scores = unary[i] + choices[best, np.arange(3)]
        path = np.empty(n, dtype=np.int8)
        state = int(scores.argmax())
        for i in range(n - 1, -1, -1):
            path[i] = state
            state = back[i, state]
        ends = [m.end() for m in SENTENCE.finditer(text)]
        sentence = np.searchsorted(
            ends, (offsets[:, 0] + np.maximum(offsets[:, 1] - 1, offsets[:, 0])) // 2, side="right"
        )
        cuts = [0, *list(np.flatnonzero(np.diff(sentence)) + 1), n]
        for a, b in zip(cuts, cuts[1:]):
            path[a:b] = np.bincount(path[a:b], minlength=3).argmax()
        if self.crf["l_min"] > 1:
            boundaries = [0, *list(np.flatnonzero(np.diff(path)) + 1), n]
            runs = [[path[a], b - a] for a, b in zip(boundaries, boundaries[1:])]
            while len(runs) > 1:
                i = next((j for j, (_, length) in enumerate(runs) if length < self.crf["l_min"]), None)
                if i is None:
                    break
                left = runs[i - 1] if i else None
                right = runs[i + 1] if i + 1 < len(runs) else None
                target = (
                    left if left and (not right or left[0] == right[0] or left[1] >= right[1]) else right
                )
                target[1] += runs.pop(i)[1]
                if left and right and left[0] == right[0]:
                    left[1] += right[1]
                    runs.pop(i)
            path = np.repeat([k for k, _ in runs], [length for _, length in runs])
        owner = np.maximum(0, np.searchsorted(offsets[:, 0], np.arange(len(text)), side="right") - 1)
        shares = np.bincount(path[owner], minlength=3) / len(text)
        return dict(
            sentenceLabels=[int(path[a]) for a in cuts[:-1]],
            bucket=int(shares.argmax()),
            probs=shares.tolist(),
            score=float(shares[2] + shares[1] / 2),
            tokens=n,
            truncated=False,
        )

    def info(self):
        from engine import CONTRACT_VERSION, APP_VERSION

        return dict(
            ok=True,
            contract=CONTRACT_VERSION,
            app_version=APP_VERSION,
            model=dict(id=self.pin["release"], ver=self.version, calibration="anagram-detector/1"),
            n_buckets=3,
            buckets=LABELS,
            languages=["en"],
            lid=self.lid.name,
            max_tokens=self.max_length,
            device="cpu",
            dtype="fp32",
        )

    def synchronize(self):
        pass

    def accelerator_bytes(self):
        return None

    def close(self):
        self.session = None


def controller(root, home, pin, lid_path):
    from engine import LanguageId
    from runtime_controller import Candidate, RuntimeController

    gate = LanguageId(lid_path)
    candidate = Candidate("onnx:cpu:fp32", "CPU · ONNX Runtime", "cpu", "onnx", "fp32")
    return RuntimeController(
        home / "runtime.json",
        lambda: ([candidate], pin["revision"] + "-crf2"),
        lambda _: Detector(root, pin, gate),
    )
