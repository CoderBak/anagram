#!/usr/bin/env python3
"""Runtime lifecycle, guarded controls and shared scoring checks without EditLens weights."""
from __future__ import annotations

import json
import copy
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "anagramd"))
import engine as engine_api
from runtime_controller import Candidate, RuntimeBusy, RuntimeController, RuntimeUnavailable, error_text
from runtime_adapters import OnnxEditLens, artifact_files, digest, runtime_version


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


FP32 = Candidate("torch:cpu:fp32", "CPU", "cpu", "torch", "fp32")
FP16 = Candidate("onnx:cpu:fp16", "CPU FP16", "cpu", "onnx", "fp16")
INT8 = Candidate("onnx:cpu:int8", "CPU INT8", "cpu", "onnx", "int8", experimental=True)


class Factory:
    def __init__(self, clock):
        self.clock = clock
        self.loaded = []
        self.resident = 0
        self.max_resident = 0
        self.version = "v1"
        self.fail = None
        self.on_score = None
        self.peak_resets = []
        self.cost = lambda candidate, batch: 1.0

    def __call__(self, candidate):
        self.loaded.append(candidate.id)
        self.clock.advance(7)  # loading is separate from the measurement budget
        if candidate.id == self.fail:
            raise ValueError("simulated load failure")
        self.resident += 1
        self.max_resident = max(self.max_resident, self.resident)
        return FakeEngine(self, candidate)


class FakeEngine:
    def __init__(self, factory, candidate):
        self.factory, self.candidate = factory, candidate
        self.version = f"{factory.version}:{candidate.id}"
        self.closed = False
        self.lid = SimpleNamespace(enabled=False)
        self.n_buckets = 4
        self.last_run_ms = self.last_wait_ms = 0

    def score(self, texts):
        if self.factory.on_score:
            self.factory.on_score(self, texts)
        self.factory.clock.advance(self.factory.cost(self.candidate, len(texts)))
        return [{"bucket": 0, "probs": [1., 0., 0., 0.], "score": 0.,
                 "tokens": 140, "truncated": False} for _ in texts]

    def info(self):
        return {"ok": True, "contract": "2.1", "model": {
            "id": "editlens_roberta-large", "ver": self.version, "calibration": "test"}}

    def synchronize(self):
        pass

    def accelerator_bytes(self):
        return None

    def reset_accelerator_peak(self):
        self.factory.peak_resets.append(self.candidate.id)

    def close(self):
        if not self.closed:
            self.closed = True
            self.factory.resident -= 1


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "runtime.json"
        self.controllers = []

    def tearDown(self):
        for controller in self.controllers:
            controller.close()
            if controller.thread:
                controller.thread.join(timeout=2)
        self.temp.cleanup()

    def make(self, candidates=(FP32, FP16), context="same", factory=None):
        clock = factory.clock if factory else Clock()
        factory = factory or Factory(clock)
        controller = RuntimeController(self.path, lambda: (list(candidates), context), factory,
                                       clock=clock, memory=lambda: 123456, max_runs=100)
        self.controllers.append(controller)
        return controller, factory

    def finish(self, controller):
        controller.thread.join(timeout=3)
        self.assertFalse(controller.thread.is_alive(), "background operation did not finish")

    def setup_complete(self, controller):
        controller.start()
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "awaiting_selection")

    def select(self, controller, candidate=FP32):
        controller.request_selection(candidate.id)
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "ready")

    def test_first_run_measures_shared_budget_then_requires_explicit_selection(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        snapshot = controller.snapshot()
        self.assertIsNone(snapshot["active_id"])
        self.assertIsNone(snapshot["selected_id"])
        self.assertTrue(snapshot["needs_selection"])
        self.assertEqual(snapshot["recommended_id"], FP32.id)
        report = snapshot["benchmark"]
        self.assertEqual(report["total"], 4)
        self.assertEqual(report["completed"], 4)
        self.assertEqual({row["batch_size"] for row in report["results"]}, {1, 8})
        self.assertLessEqual(report["measurement_s"], 31)  # at most one in-flight forward overrun
        self.assertGreaterEqual(report["measurement_s"], 29)
        self.assertGreater(report["elapsed_s"], report["measurement_s"] + 14)
        self.assertEqual(factory.max_resident, 1)
        self.assertEqual(factory.resident, 0)
        self.assertEqual(factory.peak_resets, [FP32.id, FP32.id, FP16.id, FP16.id])
        with self.assertRaises(RuntimeUnavailable):
            with controller.use_engine():
                pass

    def test_fp16_and_experimental_int8_cannot_be_recommended(self):
        clock = Clock()
        factory = Factory(clock)
        factory.cost = lambda candidate, batch: 1 if candidate.precision == "fp32" else 0.01
        controller, _ = self.make((FP32, FP16, INT8), factory=factory)
        self.setup_complete(controller)
        self.assertEqual(controller.snapshot()["recommended_id"], FP32.id)

    def test_selection_persists_and_restart_loads_only_saved_candidate(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller, FP16)
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved["selected_id"], FP16.id)
        self.assertEqual(saved["selected_version"], f"v1:{FP16.id}")
        controller.close()
        restarted, second = self.make()
        restarted.start()
        self.finish(restarted)
        self.assertEqual(restarted.snapshot()["active_id"], FP16.id)
        self.assertEqual(second.loaded, [FP16.id])
        self.assertEqual(factory.max_resident, 1)

    def test_pending_choice_reuses_completed_report_on_restart(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        controller.close()
        restarted, factory = self.make()
        self.setup_complete(restarted)
        self.assertEqual(factory.loaded, [])
        self.assertEqual(restarted.snapshot()["benchmark"]["completed"], 4)

    def test_changed_context_or_engine_version_invalidates_saved_choice(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        self.select(controller)
        controller.close()
        changed, factory = self.make(context="different hardware or artifacts")
        self.setup_complete(changed)
        self.assertIsNone(changed.snapshot()["active_id"])
        self.select(changed)
        changed.close()
        v2factory = Factory(Clock())
        v2factory.version = "v2"
        mismatched, _ = self.make(context="different hardware or artifacts", factory=v2factory)
        self.setup_complete(mismatched)
        self.assertIsNone(mismatched.snapshot()["selected_id"])
        self.assertEqual(v2factory.max_resident, 1)

    def test_cancel_waits_for_one_inflight_operation_then_stops(self):
        entered, release = threading.Event(), threading.Event()
        controller, factory = self.make()
        factory.on_score = lambda *_: (entered.set(), release.wait(2))
        controller.start()
        self.assertTrue(entered.wait(2))
        self.assertEqual(controller.cancel()["state"], "benchmarking")
        with self.assertRaises(RuntimeBusy):
            controller.request_selection(FP32.id)
        release.set()
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["benchmark"]["status"], "cancelled")
        self.assertEqual(snapshot["state"], "awaiting_selection")
        self.assertEqual(factory.loaded, [FP32.id])
        self.assertEqual(factory.resident, 0)

    def test_rerun_restores_existing_choice_and_is_single_resident(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller, FP16)
        controller.request_benchmark(10)
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["active_id"], FP16.id)
        self.assertEqual(snapshot["selected_id"], FP16.id)
        self.assertEqual(snapshot["state"], "ready")
        self.assertLessEqual(snapshot["benchmark"]["measurement_s"], 11)
        self.assertEqual(factory.max_resident, 1)

    def test_rerun_initial_response_resets_elapsed_time(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        factory.clock.advance(3600)
        response = controller.request_benchmark(10)
        self.assertEqual(response["benchmark"]["status"], "running")
        self.assertEqual(response["benchmark"]["elapsed_s"], 0)
        self.finish(controller)

    def test_selection_cannot_overlap_benchmark_finalization_or_restore(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        entered, release = threading.Event(), threading.Event()
        original = controller._persist
        def persist(*args):
            entered.set()
            release.wait(2)
            return original(*args)
        controller._persist = persist
        controller.request_benchmark(10)
        self.assertTrue(entered.wait(2))
        self.assertEqual(controller.snapshot()["state"], "awaiting_selection")
        with self.assertRaises(RuntimeBusy):
            controller.request_selection(FP16.id)
        release.set()
        self.finish(controller)
        self.assertEqual(controller.snapshot()["active_id"], FP32.id)
        self.assertEqual(factory.max_resident, 1)

    def test_failed_switch_does_not_serve_old_engine_under_new_identity(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        factory.fail = FP16.id
        controller.request_selection(FP16.id)
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "error")
        self.assertIsNone(snapshot["active_id"])
        self.assertEqual(snapshot["selected_id"], FP32.id)
        self.assertEqual(factory.resident, 0)
        self.select(controller, FP32)

    def test_cancelled_selection_does_not_persist_the_new_choice(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        original = self.path.read_text()
        entered, release = threading.Event(), threading.Event()
        factory.on_score = lambda *_: (entered.set(), release.wait(2))
        controller.request_selection(FP16.id)
        self.assertTrue(entered.wait(2))
        controller.cancel()
        release.set()
        self.finish(controller)
        self.assertEqual(self.path.read_text(), original)
        self.assertEqual(controller.snapshot()["selected_id"], FP32.id)
        self.assertIsNone(controller.snapshot()["active_id"])
        self.assertEqual(factory.resident, 0)

    def test_cancel_cannot_split_selection_commit_from_ready_state(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        entered, release, cancel_started = threading.Event(), threading.Event(), threading.Event()
        original = controller._persist
        def persist(*args):
            entered.set()
            release.wait(2)
            original(*args)
        controller._persist = persist
        controller.request_selection(FP16.id)
        self.assertTrue(entered.wait(2))
        cancelled = []
        def cancel():
            cancel_started.set()
            try:
                controller.cancel()
                cancelled.append("accepted")
            except RuntimeBusy:
                cancelled.append("already ready")
        canceller = threading.Thread(target=cancel)
        canceller.start()
        self.assertTrue(cancel_started.wait(2))
        release.set()
        self.finish(controller)
        canceller.join(timeout=2)
        self.assertEqual(cancelled, ["already ready"])
        self.assertEqual(controller.snapshot()["active_id"], FP16.id)
        self.assertEqual(json.loads(self.path.read_text())["selected_id"], FP16.id)

    def test_changed_files_between_report_and_selection_require_comparison(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        controller.discover = lambda: ([FP32, FP16], "files replaced")
        controller.request_selection(FP32.id)
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "error")
        self.assertIsNone(controller.snapshot()["active_id"])
        self.assertEqual(controller.snapshot()["benchmark"]["results"], [])
        self.assertEqual(factory.loaded, [FP32.id, FP16.id])

    def test_active_score_lease_blocks_switch_and_shutdown_releases_it(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        with controller.use_engine() as engine:
            with self.assertRaises(RuntimeBusy):
                controller.request_benchmark()
            controller.close()
            self.assertFalse(engine.closed)
        self.assertEqual(factory.resident, 0)

    def test_damaged_config_is_recoverable(self):
        self.path.write_text("{incomplete")
        controller, _ = self.make()
        self.setup_complete(controller)
        self.select(controller)
        self.assertIsNone(controller.snapshot()["error"])
        self.assertEqual(json.loads(self.path.read_text())["selected_id"], FP32.id)

    def test_corrupt_saved_report_fields_are_discarded_and_rebenchmarked(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        self.select(controller)
        saved = json.loads(self.path.read_text())
        controller.close()
        def row_field(key, value):
            return lambda report: report["results"][0].update({key: value})
        corruptions = {
            "budget string": lambda r: r.update(budget_s="corrupted"),
            "budget boolean": lambda r: r.update(budget_s=True),
            "negative elapsed": lambda r: r.update(elapsed_s=-1),
            "nan measurement": lambda r: r.update(measurement_s=float("nan")),
            "infinite elapsed": lambda r: r.update(elapsed_s=float("inf")),
            "overflowing integer": lambda r: r.update(elapsed_s=10**1000),
            "phase object": lambda r: r.update(phase={}),
            "phase too long": lambda r: r.update(phase="x" * 2001),
            "phase utf16 too long": lambda r: r.update(phase="🙂" * 1001),
            "unknown current": lambda r: r.update(current_id="unknown"),
            "boolean count": lambda r: r.update(completed=True),
            "wrong count": lambda r: r.update(completed=0),
            "too many workloads": lambda r: r.update(total=129),
            "results object": lambda r: r.update(results={}),
            "unknown result candidate": row_field("candidate_id", "unknown"),
            "latency string": row_field("latency_ms", "fast"),
            "null ok latency": row_field("latency_ms", None),
            "negative metric": row_field("peak_rss_bytes", -1),
            "fractional samples": row_field("samples", 1.5),
            "zero ok samples": row_field("samples", 0),
            "unknown batch": row_field("batch_size", 32),
            "error object": row_field("error", {}),
            "error too long": row_field("error", "x" * 2001),
            "error surrogate": row_field("error", "\ud800"),
            "extra nan field": row_field("extra", float("nan")),
            "duplicate workload": lambda r: r["results"].__setitem__(1, dict(r["results"][0])),
        }
        for name, corrupt in corruptions.items():
            with self.subTest(name=name):
                damaged = copy.deepcopy(saved)
                corrupt(damaged["benchmark"])
                self.path.write_text(json.dumps(damaged))
                restarted, factory = self.make()
                self.setup_complete(restarted)
                snapshot = restarted.snapshot()
                self.assertEqual(factory.loaded, [FP32.id, FP16.id])
                self.assertTrue(restarted._valid_report(snapshot["benchmark"]))
                self.assertIsNone(snapshot["active_id"])
                json.dumps(snapshot, allow_nan=False)
                restarted.close()

    def test_long_provider_errors_leave_controls_renderable(self):
        controller, _ = self.make()
        def fail(_candidate):
            raise ValueError("🙂" * 2001)
        controller.factory = fail
        self.setup_complete(controller)
        snapshot = controller.snapshot()
        self.assertTrue(controller._valid_report(snapshot["benchmark"]))
        self.assertTrue(all(len(row["error"].encode("utf-16-le")) <= 4000
                            for row in snapshot["benchmark"]["results"]))
        self.assertEqual(error_text("\ud800"), "?")
        restarted, _ = self.make(context="failed discovery")
        def fail_discovery():
            raise ValueError("x" * 2001)
        restarted.discover = fail_discovery
        restarted.start()
        self.finish(restarted)
        self.assertEqual(len(restarted.snapshot()["error"]), 2000)

    def test_missing_models_keep_runtime_controls_recoverable(self):
        controller, _ = self.make()
        def fail():
            raise RuntimeError("missing language model")
        controller.discover = fail
        controller.start()
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "error")
        with self.assertRaises(RuntimeUnavailable):
            with controller.use_engine():
                pass
        controller.discover = lambda: ([FP32], "fixed")
        controller.request_benchmark()
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "awaiting_selection")

    def test_runtime_budgets_and_candidate_ids_are_validated(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        for value in (9, 31, True, 10.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                controller.request_benchmark(value)
        for value in ("unknown", "../../model"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                controller.request_selection(value)


class ProvenanceTests(unittest.TestCase):
    def test_selected_onnx_and_external_data_change_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / "onnx").mkdir()
            (path / "config.json").write_text("{}")
            for name in ("model.onnx", "model_fp16.onnx", "model_int8.onnx"):
                (path / "onnx" / name).write_bytes(name.encode())
            engine = SimpleNamespace(max_length=512, dtype_name="int8",
                                     lid=SimpleNamespace(enabled=False, name=None, digest=None))
            first = runtime_version(engine, INT8, path, engine_api, {"provider": "CPUExecutionProvider"})
            (path / "onnx/model_int8.onnx").write_bytes(b"changed int8 weights")
            second = runtime_version(engine, INT8, path, engine_api, {"provider": "CPUExecutionProvider"})
            self.assertNotEqual(first, second)
            (path / "onnx/tensors.data").write_bytes(b"external tensor data")
            third = runtime_version(engine, INT8, path, engine_api, {"provider": "CPUExecutionProvider"})
            self.assertNotEqual(second, third)
            self.assertNotEqual(third, runtime_version(engine, INT8, path, engine_api, {"provider": "OtherProvider"}))
            self.assertEqual({p.name for p in artifact_files(path, INT8)}, {"model_int8.onnx", "tensors.data"})
            self.assertEqual(digest(path / "config.json"), digest(path / "config.json"))


class ScoringParityTests(unittest.TestCase):
    def test_torch_auto_is_fp32_and_cpu_fp16_is_not_silently_coerced(self):
        class Model:
            config = SimpleNamespace(num_labels=4)
            def to(self, *_):
                return self
            def eval(self):
                return self
        fake_torch = SimpleNamespace(float32="float32", float16="float16")
        fake_transformers = SimpleNamespace(
            AutoModelForSequenceClassification=SimpleNamespace(from_pretrained=lambda *a, **k: Model()),
            AutoTokenizer=SimpleNamespace(from_pretrained=lambda *a, **k: object()))
        with patch.dict(sys.modules, {"torch": fake_torch, "transformers": fake_transformers}), \
                patch.object(engine_api, "require_model"), patch.object(engine_api, "pipeline_version", return_value="test"):
            for device in ("cpu", "mps", "cuda:0"):
                engine = engine_api.EditLens(Path("unused"), device, 512, 8, "auto", None, warmup=False)
                self.assertEqual(engine.dtype_name, "float32")
            with self.assertRaisesRegex(ValueError, "CPU FP16"):
                engine_api.EditLens(Path("unused"), "cpu", 512, 8, "fp16", None, warmup=False)

    def test_torch_and_onnx_share_cleaning_truncation_order_and_four_logits(self):
        # The session stub verifies the real ONNX adapter feed and shared
        # semantics; the real-model smoke suite checks the exported graph too.
        import numpy as np
        import emoji

        class Tokenizer:
            eos_token_id, sep_token_id = 2, 2
            def __init__(self):
                self.cleaned = []
            def __call__(self, texts, **_):
                self.cleaned = list(texts)
                return {"input_ids": [[1, *[len(w) + 3 for w in t.split()], 2] for t in texts]}
            def pad(self, inputs, **_):
                ids = inputs["input_ids"]
                width = max(map(len, ids))
                return {"input_ids": np.array([row + [0] * (width - len(row)) for row in ids]),
                        "attention_mask": np.array([[1] * len(row) + [0] * (width - len(row)) for row in ids])}

        def logits(ids):
            value = np.asarray(ids, dtype=np.float32).sum(axis=1, keepdims=True) / 100
            return np.concatenate([value, -value, value * 0, value / 2], axis=1)

        feeds = []
        class Session:
            def run(self, names, feed):
                self_names = {"input_ids", "attention_mask", "token_type_ids"}
                self_test.assertEqual(set(feed), self_names)
                self_test.assertTrue(all(value.dtype == np.int64 for value in feed.values()))
                self_test.assertTrue(np.all(feed["token_type_ids"] == 0))
                feeds.append(feed)
                return [logits(feed["input_ids"])]

        self_test = self
        onnx = OnnxEditLens.__new__(OnnxEditLens)
        onnx.api, onnx.session = engine_api, Session()
        onnx.input_names = {"input_ids", "attention_mask", "token_type_ids"}
        direct = engine_api.EditLens.__new__(engine_api.EditLens)
        for engine in (onnx, direct):
            engine.tok, engine.emoji = Tokenizer(), emoji
            engine.max_length, engine.batch_size, engine.n_buckets = 8, 2, 4
            engine.lock, engine.scored = threading.Lock(), 0
        direct._logits = lambda ids: logits(direct.tok.pad({"input_ids": ids})["input_ids"])
        texts = ["Sure, here it is.\nA DIFFERENT paragraph 🙂", "Long " * 20, "short",
                 "discarded reasoning</think> This IS the answer"]
        expected, actual = direct.score(texts), onnx.score(texts)
        self.assertEqual(actual, expected)
        self.assertTrue(actual[1]["truncated"])
        self.assertEqual(actual[1]["tokens"], 8)
        self.assertEqual(len(actual[0]["probs"]), 4)
        self.assertEqual(onnx.tok.cleaned, direct.tok.cleaned)
        self.assertNotIn("sure", onnx.tok.cleaned[0])
        self.assertEqual(onnx.tok.cleaned[-1], "this is the answer")
        self.assertEqual(sum(len(feed["input_ids"]) for feed in feeds), len(texts))


if __name__ == "__main__":
    unittest.main(verbosity=2)
