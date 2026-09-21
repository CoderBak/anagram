#!/usr/bin/env python3
"""Apple experiment bookkeeping checks; no model weights or accelerator work."""
import json
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

SCRIPT = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/benchmark-apple.py"))


class AppleExperimentTests(unittest.TestCase):
    def test_mlx_legacy_layernorm_aliases_preserve_values_and_reject_collisions(self):
        gamma, beta, classifier = object(), object(), object()
        values, count = SCRIPT["mlx_checkpoint_weights"]({
            "roberta.embeddings.LayerNorm.gamma": gamma,
            "roberta.embeddings.LayerNorm.beta": beta,
            "classifier.dense.weight": classifier,
        })
        self.assertEqual(count, 2)
        self.assertEqual(dict(values), {"roberta.embeddings.LayerNorm.weight": gamma,
                                        "roberta.embeddings.LayerNorm.bias": beta,
                                        "classifier.dense.weight": classifier})
        with self.assertRaises(ValueError):
            SCRIPT["mlx_checkpoint_weights"]({"x.LayerNorm.gamma": gamma, "x.LayerNorm.weight": gamma})

    def test_cleanup_only_removes_this_runs_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "fresh-run"
            cache = run / "cache/case"
            cache.mkdir(parents=True)
            (cache / "weights.bin").write_bytes(b"temporary")
            keep = root / "original-model"
            keep.mkdir()
            (keep / "weights.bin").write_bytes(b"original")
            self.assertEqual(SCRIPT["remove_run_cache"](cache, run), 9)
            self.assertFalse(cache.exists())
            with self.assertRaises(ValueError):
                SCRIPT["remove_run_cache"](keep, run)
            self.assertEqual((keep / "weights.bin").read_bytes(), b"original")

    def test_parity_checks_input_identity_and_softmax_not_embedding_distance(self):
        reference = {"input": {"sha256": "same"}, "logits": [[[1, 2, 3, 4]], [[4, 3, 2, 1]]]}
        shifted = {"input": {"sha256": "same"}, "logits": [[[11, 12, 13, 14]], [[14, 13, 12, 11]]]}
        result = SCRIPT["parity"](shifted, reference)
        self.assertEqual(result["examples"], 2)
        self.assertEqual(result["max_abs_logit_error"], 10)
        self.assertEqual(result["max_abs_probability_error"], 0)
        self.assertEqual(result["argmax_agreement"], 1)
        shifted["input"]["sha256"] = "different"
        with self.assertRaises(ValueError):
            SCRIPT["parity"](shifted, reference)

    def test_coreml_profile_finishes_before_all_measured_samples(self):
        now, events = [0.0], []
        class Backend:
            def __init__(self, _):
                self.details = {}
            def predict(self, values):
                events.append("predict")
                now[0] += .003
                return np.ones((1, 4), dtype=np.float32)
            def sync(self):
                events.append("sync")
                now[0] += .001
            def finish_profile(self):
                events.append("finish_profile")
                now[0] += 100  # profile export must never enter measured latency
            def memory(self): return {"driver": 20}
        worker = SCRIPT["worker"]
        config = {"backend": "coreml", "precision": "fp32", "batch": 1, "length": 128,
                  "samples": 20, "warmup": 3, "cache_mode": "cold"}
        values = [{"input_ids": np.zeros((1, 128)), "attention_mask": np.ones((1, 128))}] * 20
        with patch.dict(worker.__globals__, CoreML=Backend, prepared_inputs=lambda _: (values, {"sha256": "same"})), \
                patch("time.perf_counter", side_effect=lambda: now[0]):
            result = worker(config)
        boundary = events.index("finish_profile")
        self.assertEqual(events[:boundary].count("predict"), 3)
        self.assertEqual(events[boundary:].count("predict"), 20)
        self.assertAlmostEqual(result["latency_p50_ms"], 4)
        self.assertAlmostEqual(result["latency_p90_ms"], 4)
        self.assertAlmostEqual(result["measurement_s"], .08)
        self.assertAlmostEqual(result["throughput_texts_per_s"], 250)
        self.assertEqual(len(result["logits"]), 20)

    def test_profile_reports_unique_kernels_separately_from_repeated_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            path.write_text(json.dumps([
                {"cat": "Node", "name": "partition", "dur": 10, "args": {"provider": "CoreMLExecutionProvider", "op_name": "CoreML"}},
                {"cat": "Node", "name": "partition", "dur": 12, "args": {"provider": "CoreMLExecutionProvider", "op_name": "CoreML"}},
                {"cat": "Node", "name": "gather", "dur": 3, "args": {"provider": "CPUExecutionProvider", "op_name": "Gather"}},
            ]))
            backend = SCRIPT["CoreML"].__new__(SCRIPT["CoreML"])
            backend.session = SimpleNamespace(end_profiling=lambda: str(path))
            backend.details = {}
            backend.finish_profile()
            report = backend.details["profile"]
            self.assertEqual(report["unique_profiled_kernels_by_provider"], {"CoreMLExecutionProvider": 1, "CPUExecutionProvider": 1})
            self.assertEqual(report["warmup_kernel_calls"]["CoreMLExecutionProvider"], 2)
            self.assertTrue(backend.details["coreml_partition_observed"])

    def test_input_preparation_contains_distinct_lengths_padding_and_eos_truncation(self):
        class Tokenizer:
            eos_token_id = 2
            def __call__(self, texts, **kwargs):
                return {"input_ids": [[0, *range(3, 3 + len(text.split())), 2] for text in texts]}
            def pad(self, values, *, max_length, **kwargs):
                rows = values["input_ids"]
                return {"input_ids": np.asarray([row + [1] * (max_length - len(row)) for row in rows]),
                        "attention_mask": np.asarray([[1] * len(row) + [0] * (max_length - len(row)) for row in rows])}
        modules = {"transformers": SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a, **k: Tokenizer())),
                   "emoji": SimpleNamespace(demojize=lambda value: value, replace_emoji=lambda value, _: value)}
        config = {"model_dir": "unused", "texts": ["word " * length for length in (10, 30, 50, 200, 500, 60, 90, 70)],
                  "length": 128, "batch": 8, "samples": 20}
        with patch.dict(sys.modules, modules):
            values, info = SCRIPT["prepared_inputs"](config)
            again, same = SCRIPT["prepared_inputs"](config)
        self.assertEqual(info["sha256"], same["sha256"])
        self.assertEqual(info["shape"], [8, 128])
        self.assertEqual(info["tokens_max"], 128)
        self.assertEqual(info["tokens_min"], 12)
        self.assertTrue(any(row["attention_mask"].sum() < 8 * 128 for row in values))
        for value in values:
            for ids, mask in zip(value["input_ids"], value["attention_mask"]):
                self.assertEqual(ids[int(mask.sum()) - 1], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
