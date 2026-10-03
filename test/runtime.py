#!/usr/bin/env python3
"""Runtime lifecycle, guarded controls and shared scoring checks without EditLens weights."""
from __future__ import annotations

import hashlib
import io
import json
import copy
from concurrent.futures import ThreadPoolExecutor
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "anagramd"))
import engine as engine_api
from runtime_controller import (Candidate, Cancelled, PASSED_OVER, RuntimeBusy, RuntimeController, RuntimeFailure,
                                RuntimeUnavailable, auto_candidate, error_text, forget_crashes)
from runtime_adapters import MlxEditLens, OnnxEditLens, artifact_files, digest, runtime_version, load_candidate
from benchmark_worker import SubprocessBenchmark


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
ONNX32 = Candidate("onnx:cpu:fp32", "CPU ONNX", "cpu", "onnx", "fp32")
MPS = Candidate("torch:mps:fp32", "Apple GPU", "mps", "torch", "fp32")
MPS16 = Candidate("torch:mps:fp16", "Apple GPU FP16", "mps", "torch", "fp16")
CUDA1 = Candidate("torch:cuda:1:fp32", "GPU 1", "cuda:1", "torch", "fp32")
CUDA0 = Candidate("torch:cuda:0:fp32", "GPU 0", "cuda:0", "torch", "fp32")
ONNX_CUDA = Candidate("onnx:cuda:0:fp32", "GPU 0 ONNX", "cuda:0", "onnx", "fp32")
MLX = Candidate("mlx:gpu:fp32", "Apple GPU", "gpu", "mlx", "fp32")


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
        return {"ok": True, "contract": "3.0", "model": {
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


class InProcessRunner:
    """Test double for SubprocessBenchmark: the same message protocol, this process."""
    def __init__(self, factory, clock, memory=lambda: 123456):
        self.factory, self.clock, self.memory = factory, clock, memory

    def __call__(self, candidate, remaining, workloads, max_runs, cancel, receive):
        measure = RuntimeController(Path("unused-runtime.json"), None, None,
                                    clock=self.clock, memory=self.memory, max_runs=max_runs)
        measure.cancel_event = cancel
        measure.benchmark["total"] = workloads
        measure._phase = lambda phase: receive({"type": "phase", "phase": phase})
        original = measure._measurement
        def measurement(seconds):
            original(seconds)
            receive({"type": "measurement", "seconds": seconds})
        measure._measurement = measurement
        measure._phase("initialization")
        started = self.clock()
        engine = self.factory(candidate)
        load_ms = (self.clock() - started) * 1000
        try:
            for batch in (1, 8):
                try:
                    row = measure._measure(engine, candidate, batch, load_ms, remaining)
                except Cancelled:
                    raise
                except Exception as exc:
                    row = measure._error_row(candidate, batch, exc, load_ms)
                row.update(hash_ms=1, initialization_ms=2, baseline_rss_bytes=100, loaded_rss_bytes=200)
                receive({"type": "row", "row": row})
                measure.benchmark["completed"] += 1
        finally:
            engine.close()


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
                                       clock=clock, memory=lambda: 123456, max_runs=100,
                                       benchmark_runner=InProcessRunner(factory, clock))
        self.controllers.append(controller)
        return controller, factory

    def finish(self, controller):
        controller.thread.join(timeout=3)
        self.assertFalse(controller.thread.is_alive(), "background operation did not finish")

    def setup_complete(self, controller, expected=FP32):
        """Start and wait: without a saved choice the controller selects and loads by itself."""
        controller.start()
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "ready", snapshot)
        self.assertEqual(snapshot["active_id"], expected.id)
        self.assertEqual(snapshot["selected_id"], expected.id)

    def select(self, controller, candidate=FP32):
        controller.request_selection(candidate.id)
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "ready")

    def benchmark(self, controller, budget=30):
        controller.request_benchmark(budget)
        self.finish(controller)

    def test_persist_never_truncates_preexisting_temporary_links(self):
        controller, _ = self.make()
        outside = self.path.parent / "outside.txt"
        old_temp = self.path.with_suffix(".json.tmp")
        for kind in ("symlink", "hardlink"):
            outside.write_text("keep")
            if kind == "symlink":
                old_temp.symlink_to(outside)
            else:
                os.link(outside, old_temp)
            controller._persist()
            self.assertEqual(outside.read_text(), "keep")
            self.assertFalse(self.path.is_symlink())
            self.assertEqual(json.loads(self.path.read_text())["schema_version"], 1)
            old_temp.unlink()

    def test_config_hardlink_is_replaced_but_symlink_is_never_read_or_written(self):
        controller, _ = self.make()
        outside = self.path.parent / "outside.json"
        outside.write_text('{"schema_version":1,"selected_id":"external"}')
        original = outside.read_text()
        self.path.symlink_to(outside)
        self.assertIsNone(controller._read_saved())
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            controller._persist()
        self.path.unlink()
        os.link(outside, self.path)
        controller._persist()
        self.assertEqual(outside.read_text(), original)
        self.assertNotEqual(self.path.stat().st_ino, outside.stat().st_ino)

    def test_oversized_runtime_configuration_is_rejected(self):
        controller, _ = self.make()
        self.path.write_text(" " * (1024 * 1024 + 1))
        self.assertIsNone(controller._read_saved())
        self.assertIn("oversized", controller.error)

    def test_first_run_selects_loads_and_persists_without_measuring(self):
        controller, factory = self.make((FP16, FP32))
        self.setup_complete(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["recommended_id"], FP32.id)
        self.assertIsNone(snapshot["fastest_id"])
        self.assertIsNone(snapshot["error"])
        self.assertNotIn("needs_selection", snapshot)
        self.assertEqual(snapshot["benchmark"]["status"], "idle")
        self.assertEqual(snapshot["benchmark"]["results"], [])
        self.assertFalse(snapshot["benchmark"]["stale"])
        self.assertEqual(factory.loaded, [FP32.id])  # one load, one warmup, never a comparison
        self.assertEqual(factory.max_resident, 1)
        self.assertEqual(factory.peak_resets, [])
        saved = json.loads(self.path.read_text())
        self.assertEqual((saved["selected_id"], saved["selected_version"]), (FP32.id, f"v1:{FP32.id}"))
        with controller.use_engine() as engine:
            self.assertEqual(engine.candidate, FP32)

    def test_automatic_selection_prefers_devices_in_a_fixed_order_and_never_lower_precision(self):
        everything = [INT8, MPS16, FP16, FP32, ONNX32, ONNX_CUDA, MPS, MLX, CUDA1, CUDA0]
        expected = [CUDA0, CUDA1, MLX, MPS, ONNX_CUDA, ONNX32, FP32]
        remaining = list(everything)
        for candidate in expected:
            self.assertEqual(auto_candidate(remaining), candidate)
            remaining.remove(candidate)
        self.assertIsNone(auto_candidate(remaining))  # only FP16/INT8 remain
        unavailable = Candidate(**{**CUDA0.__dict__, "available": False, "reason": "no driver"})
        self.assertEqual(auto_candidate([unavailable, MPS16, ONNX32]), ONNX32)
        controller, factory = self.make((INT8, FP16, ONNX32, FP32))
        self.setup_complete(controller, ONNX32)
        self.assertEqual(factory.loaded, [ONNX32.id])

    def test_no_available_candidate_is_a_clear_recoverable_error(self):
        missing = Candidate(**{**FP32.__dict__, "available": False,
                               "reason": "Model artifact is missing; download models in Anagram Settings"})
        controller, factory = self.make((missing, FP16))
        controller.start()
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "error")
        self.assertIn("download models", snapshot["error"])
        self.assertIsNone(snapshot["recommended_id"])
        self.assertEqual(factory.loaded, [])
        controller.discover = lambda: ([FP32, FP16], "fixed")
        controller.request_benchmark(10)
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "ready")
        self.assertEqual(controller.snapshot()["active_id"], FP32.id)

    def test_explicit_benchmark_measures_every_candidate_and_keeps_the_selection(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.benchmark(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "ready")
        self.assertEqual(snapshot["active_id"], FP32.id)
        report = snapshot["benchmark"]
        self.assertEqual(report["status"], "completed")
        self.assertEqual((report["total"], report["completed"]), (4, 4))
        self.assertEqual({row["batch_size"] for row in report["results"]}, {1, 8})
        self.assertLessEqual(report["measurement_s"], 31)  # at most one in-flight forward overrun
        self.assertGreaterEqual(report["measurement_s"], 29)
        self.assertGreater(report["elapsed_s"], report["measurement_s"] + 14)
        self.assertFalse(report["stale"])
        self.assertEqual(factory.max_resident, 1)
        self.assertEqual(factory.resident, 1)
        self.assertEqual(factory.peak_resets, [FP32.id, FP32.id, FP16.id, FP16.id])
        self.assertTrue(controller._valid_report(json.loads(self.path.read_text())["benchmark"]))

    def test_fp16_and_experimental_int8_are_fastest_but_never_recommended_or_selected(self):
        clock = Clock()
        factory = Factory(clock)
        factory.cost = lambda candidate, batch: 1 if candidate.precision == "fp32" else 0.01
        controller, _ = self.make((FP32, FP16, INT8), factory=factory)
        self.setup_complete(controller)
        self.benchmark(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["recommended_id"], FP32.id)
        self.assertIn(snapshot["fastest_id"], (FP16.id, INT8.id))
        self.assertEqual(snapshot["active_id"], FP32.id)

    def test_short_measurements_are_labeled_and_old_reports_are_dropped_not_rerun(self):
        controller, _ = self.make()
        controller.max_runs = 1
        self.setup_complete(controller)
        self.benchmark(controller)
        self.assertTrue(all(row["measurement_quality"] == "insufficient"
                            for row in controller.snapshot()["benchmark"]["results"]))
        old = json.loads(self.path.read_text())
        old["benchmark"].pop("report_version")
        self.path.write_text(json.dumps(old))
        controller.close()
        fresh, factory = self.make()
        self.setup_complete(fresh)
        self.assertEqual(fresh.snapshot()["benchmark"]["results"], [])
        self.assertEqual(factory.loaded, [FP32.id])

    def test_saved_report_is_shown_and_labelled_stale_after_a_context_change(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        self.benchmark(controller)
        controller.close()
        restarted, factory = self.make(context="new driver")
        self.setup_complete(restarted)
        report = restarted.snapshot()["benchmark"]
        self.assertEqual(report["completed"], 4)
        self.assertTrue(report["stale"])
        self.assertEqual(factory.loaded, [FP32.id])

    def test_idle_only_counts_score_activity_and_retains_selection(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        controller.set_idle_unload(60)
        factory.clock.advance(59)
        controller.snapshot()
        with controller.use_engine(activity=False):
            pass
        self.assertFalse(controller.unload_if_idle())
        factory.clock.advance(2)
        self.assertTrue(controller.unload_if_idle())
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "idle")
        self.assertEqual(snapshot["selected_id"], FP32.id)
        self.assertIsNone(snapshot["active_id"])
        self.assertEqual(factory.resident, 0)
        for _ in range(5):
            controller.snapshot()
        self.assertEqual(factory.resident, 0)
        self.assertTrue(controller.wake())
        self.finish(controller)
        self.assertEqual(controller.snapshot()["active_id"], FP32.id)
        factory.clock.advance(50)
        with controller.use_engine():
            factory.clock.advance(100)
            self.assertFalse(controller.unload_if_idle())
        self.assertFalse(controller.unload_if_idle())
        factory.clock.advance(61)
        controller.set_idle_unload(0)
        self.assertFalse(controller.unload_if_idle())

    def test_first_score_after_an_idle_unload_wakes_while_the_unload_thread_exits(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        controller.set_idle_unload(60)
        factory.clock.advance(61)
        exiting, run = threading.Event(), controller._run
        def lingering(work):
            run(work)
            exiting.wait(2)  # the unload is complete but its thread has not exited
        controller._run = lingering
        try:
            self.assertTrue(controller.unload_if_idle())
            unloading = controller.thread
            del controller._run
            deadline = time.monotonic() + 2
            while controller.snapshot()["state"] != "idle" and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(unloading.is_alive())
            controller.wake_and_wait(timeout=2)
        finally:
            exiting.set()
        self.assertEqual(controller.snapshot()["state"], "ready")
        self.assertEqual(factory.resident, 1)

    def test_idle_never_interrupts_benchmark_or_load(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        controller.set_idle_unload(60)
        entered, release = threading.Event(), threading.Event()
        factory.on_score = lambda *_: (entered.set(), release.wait(2))
        controller.request_benchmark(10)
        self.assertTrue(entered.wait(2))
        factory.clock.advance(120)
        self.assertFalse(controller.unload_if_idle())
        release.set()
        self.finish(controller)

    def test_idle_wake_rejects_changed_model_version(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        controller.set_idle_unload(60)
        factory.clock.advance(61)
        controller.unload_if_idle()
        self.finish(controller)
        factory.version = "replaced"
        controller.wake()
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "error")
        self.assertEqual(factory.resident, 0)

    def test_idle_score_wait_is_bounded_and_close_wakes_waiters(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        controller.set_idle_unload(60)
        factory.clock.advance(61)
        controller.unload_if_idle()
        self.finish(controller)
        entered, release = threading.Event(), threading.Event()
        factory.on_score = lambda *_: (entered.set(), release.wait(2))
        controller.wake()
        self.assertTrue(entered.wait(1))
        with self.assertRaises(RuntimeUnavailable):
            controller.wake_and_wait(timeout=.01)
        results, waiting = [], threading.Event()
        def score_waiter():
            waiting.set()
            try:
                controller.wake_and_wait(timeout=2)
                results.append("ready")
            except RuntimeUnavailable:
                results.append("stopped")
        waiter = threading.Thread(target=score_waiter)
        waiter.start()
        self.assertTrue(waiting.wait(1))
        controller.close()
        waiter.join(1)
        self.assertFalse(waiter.is_alive())
        self.assertEqual(results, ["stopped"])
        release.set()
        self.finish(controller)
        self.assertEqual(factory.resident, 0)

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

    def test_changed_context_or_engine_version_keeps_the_explicit_choice(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        self.select(controller, FP16)
        controller.close()
        changed, factory = self.make(context="different hardware or artifacts")
        self.setup_complete(changed, FP16)
        self.assertEqual(factory.loaded, [FP16.id])
        changed.close()
        v2factory = Factory(Clock())
        v2factory.version = "v2"
        updated, _ = self.make(context="different hardware or artifacts", factory=v2factory)
        self.setup_complete(updated, FP16)
        self.assertEqual(json.loads(self.path.read_text())["selected_version"], f"v2:{FP16.id}")
        self.assertEqual(v2factory.max_resident, 1)

    def test_unavailable_saved_choice_falls_back_to_automatic_selection(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        self.select(controller, FP16)
        controller.close()
        gone = Candidate(**{**FP16.__dict__, "available": False, "reason": "ONNX Runtime is unavailable"})
        restarted, factory = self.make((FP32, gone))
        self.setup_complete(restarted)
        self.assertEqual(factory.loaded, [FP32.id])
        self.assertEqual(json.loads(self.path.read_text())["selected_id"], FP32.id)

    def test_a_saved_choice_whose_runtime_was_uninstalled_falls_back_without_an_error(self):
        # Linux without an NVIDIA GPU drops PyTorch on update; its candidate is no longer listed.
        controller, _ = self.make((ONNX32, FP32))
        self.setup_complete(controller, ONNX32)
        self.select(controller, FP32)
        controller.close()
        restarted, factory = self.make((ONNX32, INT8))
        self.setup_complete(restarted, ONNX32)
        self.assertEqual(factory.loaded, [ONNX32.id])
        self.assertIsNone(restarted.snapshot()["error"])

    def test_cancelled_first_load_leaves_an_idle_runtime_that_a_score_wakes(self):
        entered, release = threading.Event(), threading.Event()
        controller, factory = self.make()
        factory.on_score = lambda *_: (entered.set(), release.wait(2))
        controller.start()
        self.assertTrue(entered.wait(2))
        self.assertEqual(controller.cancel()["state"], "loading")
        with self.assertRaises(RuntimeBusy):
            controller.request_selection(FP32.id)
        release.set()
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "idle")
        self.assertIsNone(snapshot["selected_id"])
        self.assertFalse(self.path.exists())
        self.assertEqual(factory.resident, 0)
        factory.on_score = None
        self.assertTrue(controller.wake())
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "ready")
        self.assertEqual(controller.snapshot()["active_id"], FP32.id)

    def test_cancelled_benchmark_restores_the_selection(self):
        entered, release = threading.Event(), threading.Event()
        controller, factory = self.make()
        self.setup_complete(controller)
        factory.on_score = lambda *_: (entered.set(), release.wait(2))
        controller.request_benchmark(10)
        self.assertTrue(entered.wait(2))
        self.assertEqual(controller.cancel()["state"], "benchmarking")
        release.set()
        factory.on_score = None
        self.finish(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["benchmark"]["status"], "cancelled")
        self.assertEqual(snapshot["state"], "ready")
        self.assertEqual(snapshot["active_id"], FP32.id)
        self.assertEqual(factory.loaded, [FP32.id, FP32.id, FP32.id])
        self.assertEqual(factory.resident, 1)

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
        self.assertEqual(json.loads(self.path.read_text())["selected_id"], FP16.id)

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
        self.assertEqual(controller.snapshot()["state"], "benchmarking")
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
        self.assertEqual(controller.snapshot()["state"], "idle")
        self.assertEqual(controller.snapshot()["selected_id"], FP32.id)
        self.assertIsNone(controller.snapshot()["active_id"])
        self.assertEqual(factory.resident, 0)
        factory.on_score = None
        controller.wake()
        self.finish(controller)
        self.assertEqual(controller.snapshot()["active_id"], FP32.id)

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

    def test_selection_rechecks_availability_but_not_the_context(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.benchmark(controller)
        controller.discover = lambda: ([FP32, FP16], "files replaced")
        controller.request_selection(FP16.id)
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "ready")
        self.assertEqual(controller.snapshot()["active_id"], FP16.id)
        self.assertTrue(controller.snapshot()["benchmark"]["stale"])
        gone = Candidate(**{**FP32.__dict__, "available": False, "reason": "PyTorch import failed"})
        controller.discover = lambda: ([gone, FP16], "torch removed")
        controller.request_selection(FP32.id)
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "error")
        self.assertIn("PyTorch import failed", controller.snapshot()["error"])
        self.assertIsNone(controller.snapshot()["active_id"])
        self.assertEqual(controller.snapshot()["selected_id"], FP16.id)

    def test_active_score_lease_blocks_switch_and_shutdown_releases_it(self):
        controller, factory = self.make()
        self.setup_complete(controller)
        self.select(controller)
        with controller.use_engine() as engine:
            with self.assertRaises(RuntimeBusy):
                controller.request_benchmark()
            controller.close()
            self.assertFalse(engine.closed)
            with self.assertRaises(RuntimeUnavailable):
                with controller.use_engine():
                    self.fail("closing runtime accepted another scoring lease")
        self.assertEqual(factory.resident, 0)

    def test_damaged_config_is_recoverable(self):
        self.path.write_text("{incomplete")
        controller, _ = self.make()
        self.setup_complete(controller)
        self.select(controller)
        self.assertIsNone(controller.snapshot()["error"])
        self.assertEqual(json.loads(self.path.read_text())["selected_id"], FP32.id)

    def test_corrupt_saved_report_fields_are_discarded_without_rerunning(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        self.benchmark(controller)
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
            "context object": lambda r: r.update(context={}),
            "context too long": lambda r: r.update(context="x" * 129),
            "in-process scope": row_field("rss_scope", "in_process"),
        }
        for name, corrupt in corruptions.items():
            with self.subTest(name=name):
                damaged = copy.deepcopy(saved)
                corrupt(damaged["benchmark"])
                self.path.write_text(json.dumps(damaged))
                restarted, factory = self.make()
                self.setup_complete(restarted)
                snapshot = restarted.snapshot()
                self.assertEqual(factory.loaded, [FP32.id])
                self.assertEqual(snapshot["benchmark"]["results"], [])
                self.assertTrue(restarted._valid_report(json.loads(self.path.read_text())["benchmark"]))
                json.dumps(snapshot, allow_nan=False)
                restarted.close()

    def test_long_provider_errors_leave_controls_renderable(self):
        controller, factory = self.make()
        def fail(_candidate):
            raise ValueError("🙂" * 2001)
        controller.factory = fail
        controller.start()
        self.finish(controller)
        self.assertEqual(controller.snapshot()["state"], "error")
        self.assertEqual(len(controller.snapshot()["error"].encode("utf-16-le")), 4000)
        controller.factory = factory
        self.select(controller)
        controller.benchmark_runner = InProcessRunner(fail, factory.clock)
        self.benchmark(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "ready")
        self.assertTrue(controller._valid_report(json.loads(self.path.read_text())["benchmark"]))
        self.assertTrue(all(row["status"] == "error" and len(row["error"].encode("utf-16-le")) <= 4000
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
        self.assertEqual(controller.snapshot()["state"], "ready")
        self.assertEqual(controller.snapshot()["active_id"], FP32.id)

    def test_runtime_budgets_and_candidate_ids_are_validated(self):
        controller, _ = self.make()
        self.setup_complete(controller)
        for value in (9, 31, True, 10.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                controller.request_benchmark(value)
        for value in ("unknown", "../../model"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                controller.request_selection(value)


# A child process that runs a runtime the way the native host does and dies where the test
# says, the way MLX ends the process on some Metal failures: at once, no handler, no finally.
CRASHING_HOST = r"""
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from runtime_controller import Candidate, RuntimeController
MLX = Candidate("mlx:gpu:fp32", "Apple GPU", "gpu", "mlx", "fp32")
ONNX32 = Candidate("onnx:cpu:fp32", "CPU ONNX", "cpu", "onnx", "fp32")
candidates = [MLX] + ([ONNX32] if sys.argv[4] == "both" else [])
where = sys.argv[3]
class Engine:
    def __init__(self, candidate):
        self.candidate, self.version = candidate, "v1:" + candidate.id
        self.warm = False
    def score(self, texts):
        if self.candidate.runtime == "mlx" and where == "warmup":
            os._exit(134)
        return [{"bucket": 0, "probs": [1., 0., 0., 0.], "score": 0., "tokens": 1, "truncated": False} for _ in texts]
    def synchronize(self):
        pass
    def close(self):
        pass
controller = RuntimeController(Path(sys.argv[2]), lambda: (candidates, "ctx"), Engine)
controller.start()
controller.thread.join(10)
active = controller.snapshot()["active_id"]
if where == "first_batch":
    with controller.use_engine() as engine:
        os._exit(134)  # the first real batch never finishes
if where == "after_batch":
    with controller.use_engine() as engine:
        engine.score(["a batch"])
    controller.confirm()
    os._exit(134)  # a mid-run death, long after the start
if where == "close":
    controller.close()  # the browser went away before any batch: an ordinary exit
print(json.dumps(active))
"""


class CrashTests(unittest.TestCase):
    """What a start does after runtimes that took their process down (runtime_controller)."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "runtime.json"
        self.controllers = []

    def tearDown(self):
        for controller in self.controllers:
            controller.close()
            if controller.thread:
                controller.thread.join(timeout=2)

    def host(self, where, candidates="both"):
        daemon = Path(__file__).resolve().parents[1] / "anagramd"
        return subprocess.run([sys.executable, "-c", CRASHING_HOST, str(daemon), str(self.path), where, candidates],
                              capture_output=True, text=True, timeout=30)

    def start(self, candidates=(MLX, ONNX32)):
        clock = Clock()
        factory = Factory(clock)
        controller = RuntimeController(self.path, lambda: (list(candidates), "ctx"), factory,
                                       clock=clock, memory=lambda: 1, max_runs=1)
        self.controllers.append(controller)
        controller.start()
        controller.thread.join(3)
        return controller, factory

    def record(self):
        return json.loads(self.path.with_name("runtime-crashes.json").read_text())

    def test_a_runtime_that_took_the_process_down_twice_while_starting_is_passed_over_for_onnx_cpu(self):
        for _ in range(2):
            self.assertEqual(self.host("warmup").returncode, 134)
        controller, factory = self.start()
        snapshot = controller.snapshot()
        # FP32 ONNX on the CPU, chosen automatically: no comparison was run, nothing asked.
        self.assertEqual((snapshot["state"], snapshot["active_id"]), ("ready", ONNX32.id))
        self.assertEqual(snapshot["recommended_id"], ONNX32.id)
        self.assertEqual(snapshot["benchmark"]["status"], "idle")
        self.assertEqual(factory.loaded, [ONNX32.id])  # the crashing runtime is not even loaded
        mlx = next(c for c in snapshot["candidates"] if c["id"] == MLX.id)
        self.assertEqual((mlx["available"], mlx["reason"]), (True, PASSED_OVER))
        # Later starts keep to the fallback.
        controller.close()
        again, factory = self.start()
        self.assertEqual((again.snapshot()["active_id"], factory.loaded), (ONNX32.id, [ONNX32.id]))
        # Chosen again on purpose, it is tried again.
        again.request_selection(MLX.id)
        again.thread.join(3)
        snapshot = again.snapshot()
        self.assertEqual((snapshot["state"], snapshot["active_id"], snapshot["recommended_id"]), ("ready", MLX.id, MLX.id))
        self.assertNotEqual(next(c for c in snapshot["candidates"] if c["id"] == MLX.id).get("reason"), PASSED_OVER)

    def test_a_death_on_the_first_batch_counts_as_one_while_starting(self):
        for _ in range(2):
            self.assertEqual(self.host("first_batch").returncode, 134)
        controller, _ = self.start()
        self.assertEqual(controller.snapshot()["active_id"], ONNX32.id)

    def test_one_death_is_retried_by_loading_and_warming_up_again_and_a_scored_batch_forgets_it(self):
        self.assertEqual(self.host("warmup").returncode, 134)
        self.assertEqual(self.record()["open"], True)
        # The next start re-validates the same runtime: loaded, warmed up, then trusted
        # once it has scored; dying later on is not dying at the start.
        finished = self.host("after_batch")
        self.assertEqual(finished.returncode, 134)
        self.assertEqual((self.record()["open"], self.record()["crashes"]), (False, 0))
        self.assertEqual(self.host("warmup").returncode, 134)
        controller, factory = self.start()
        self.assertEqual((controller.snapshot()["active_id"], factory.loaded), (MLX.id, [MLX.id]))
        self.assertEqual(self.record()["passed_over"], [])

    def test_an_ordinary_exit_before_the_first_batch_is_not_a_death(self):
        for _ in range(3):
            result = self.host("close")
            self.assertEqual((result.returncode, result.stdout.strip()), (0, json.dumps(MLX.id)))
        controller, _ = self.start()
        self.assertEqual(controller.snapshot()["active_id"], MLX.id)

    def test_with_nothing_else_installed_it_stops_and_says_so_until_retried(self):
        for _ in range(2):
            self.assertEqual(self.host("warmup", candidates="mlx").returncode, 134)
        controller, factory = self.start(candidates=(MLX,))
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "error")
        self.assertIn("stopped the engine unexpectedly twice", snapshot["error"])
        self.assertEqual(factory.loaded, [])
        controller.close()
        forget_crashes(self.path)  # Retry in Settings (engine.resume)
        retried, factory = self.start(candidates=(MLX,))
        self.assertEqual((retried.snapshot()["state"], factory.loaded), ("ready", [MLX.id]))

    def test_a_damaged_record_is_forgotten_and_never_blocks_a_start(self):
        crash_path = self.path.with_name("runtime-crashes.json")
        for damaged in ("{", "[]", json.dumps({"schema_version": 1, "candidate_id": 5, "open": True,
                                                "crashes": 9, "passed_over": []})):
            crash_path.write_text(damaged)
            controller, _ = self.start()
            self.assertEqual(controller.snapshot()["active_id"], MLX.id)
            controller.close()


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

    def test_verified_weights_are_read_once_and_changed_weights_again(self):
        from download_modelkit import matches
        class Engine:
            max_length, dtype_name = 512, "float32"
            lid = SimpleNamespace(enabled=False, name=None, digest=None)
            def __init__(self, *args, **kwargs): pass
            def synchronize(self): pass
            def close(self): pass
        api = SimpleNamespace(EditLens=Engine, PIPELINE_FILES=engine_api.PIPELINE_FILES,
                              pipeline_manifest=engine_api.pipeline_manifest)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            weights = path / "model.safetensors"
            weights.write_bytes(b"verified weights")
            entry = {"path": weights.name, "size_bytes": weights.stat().st_size,
                     "sha256": hashlib.sha256(b"verified weights").hexdigest()}
            reads, real_open = [], io.open
            def counting_open(file, mode="r", *args, **kwargs):
                if isinstance(file, Path) and file.name == weights.name and "r" in mode:
                    reads.append(file)
                return real_open(file, mode, *args, **kwargs)
            with patch("io.open", counting_open):
                self.assertTrue(matches(weights, entry))  # the component's verification
                first = load_candidate(path, FP32, 512, 32, None, api, {})[0].version
                self.assertEqual(len(reads), 1)
                weights.write_bytes(b"replaced weights!")
                self.assertNotEqual(load_candidate(path, FP32, 512, 32, None, api, {})[0].version, first)
                self.assertEqual(len(reads), 2)


class PassTests(unittest.TestCase):
    """scoring.passes, which lib/webengine/scoring.ts mirrors case for case
    (test/node/webengineText.test.ts)."""

    def test_passes_cut_where_padding_costs_more_than_another_pass_and_least_in_all(self):
        from scoring import passes
        self.assertEqual([b - a for a, b in passes([100] * 35, 8)], [3, 8, 8, 8, 8])
        self.assertEqual(passes([30, 500], 8), [(0, 1), (1, 2)])
        self.assertEqual(passes([30, 40], 8), [(0, 2)])
        self.assertEqual(passes([], 8), [])

        def cheapest(w, limit, fixed, start=0):
            if start == len(w):
                return 0
            return min(fixed + k * w[start + k - 1] + cheapest(w, limit, fixed, start + k)
                       for k in range(1, min(limit, len(w) - start) + 1))

        seed = 7
        def random():
            nonlocal seed
            seed = seed * 48271 % 2147483647
            return seed / 2147483647
        for trial in range(200):
            w = sorted(2 + int(random() * 510) for _ in range(1 + int(random() * 9)))
            limit, fixed = 1 + int(random() * 5), (24, 40)[trial % 2]
            spans = passes(w, limit, fixed)
            self.assertTrue(all(1 <= b - a <= limit for a, b in spans))
            self.assertEqual([k for a, b in spans for k in range(a, b)], list(range(len(w))))
            self.assertEqual(sum(fixed + (b - a) * w[b - 1] for a, b in spans), cheapest(w, limit, fixed))


class IsolatedBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.worker = Path(__file__).resolve().parents[1] / "anagramd/benchmark_worker.py"
        self.fixture = self.home / "fixture.py"
        self.fixture.write_text('''
import os, pathlib, runpy, sys, time, types
pathlib.Path("workers").open("a").write(str(os.getpid()) + "\\n")
class Engine:
    def score(self, texts):
        time.sleep(0.002)
        return [{"tokens": 140} for _ in texts]
    def synchronize(self): pass
    def accelerator_bytes(self): return None
    def close(self): pass
def load(*args, **kwargs):
    kwargs["phase"]("hashing")
    kwargs["phase"]("loading")
    print("fixture native-library diagnostic", flush=True)
    return Engine(), {"hash_ms": 7, "load_ms": 9}
sys.modules["engine"] = types.SimpleNamespace(LanguageId=lambda _: object())
sys.modules["torch"] = types.SimpleNamespace()
sys.modules["emoji"] = types.SimpleNamespace()
sys.modules["transformers"] = types.SimpleNamespace(AutoModelForSequenceClassification=object)
sys.modules["tokenizers"] = types.SimpleNamespace()
sys.modules["onnxruntime"] = types.SimpleNamespace()
sys.modules["runtime_adapters"] = types.SimpleNamespace(execution_environment=lambda _: {}, load_candidate=load)
runpy.run_path(sys.argv[1], run_name="__main__")
''')

    def runner(self, **kwargs):
        return SubprocessBenchmark(self.home, self.home / "lid", self.home,
                                   command=[sys.executable, "-I", str(self.fixture), str(self.worker)], **kwargs)

    def host_factory(self, candidate):
        # The host loads only the selected engine; measurements never run here.
        self.host_loads.append(candidate.id)
        return FakeEngine(Factory(Clock()), candidate)

    def settle(self, controller):
        # Each candidate starts a Python worker of its own, which a loaded machine can take
        # seconds to do. A worker or controller that hangs still fails here, with its state.
        controller.thread.join(60)
        self.assertFalse(controller.thread.is_alive(), controller.snapshot())

    def test_each_candidate_has_a_fresh_process_and_distinct_resource_stages(self):
        self.host_loads = []
        controller = RuntimeController(self.home / "runtime.json", lambda: ([FP32, FP16], "isolated"),
                                       self.host_factory, benchmark_runner=self.runner(), max_runs=3)
        self.addCleanup(controller.close)
        controller.start()
        self.settle(controller)
        self.assertEqual(controller.snapshot()["state"], "ready")
        self.assertFalse((self.home / "workers").exists())
        controller.request_benchmark(10)
        self.settle(controller)
        snapshot = controller.snapshot()
        self.assertEqual(snapshot["state"], "ready", snapshot)
        self.assertEqual(self.host_loads, [FP32.id, FP32.id])
        self.assertTrue(controller._valid_report(json.loads((self.home / "runtime.json").read_text())["benchmark"]))
        self.assertEqual(snapshot["benchmark"]["completed"], 4)
        pids = [int(value) for value in (self.home / "workers").read_text().splitlines()]
        self.assertEqual(len(set(pids)), 2)
        self.assertNotIn(os.getpid(), pids)
        for row in snapshot["benchmark"]["results"]:
            self.assertEqual(row["rss_scope"], "isolated_process")
            self.assertEqual(row["hash_ms"], 7)
            self.assertEqual(row["load_ms"], 9)
            self.assertGreater(row["initialization_ms"], 0)
            self.assertEqual(row["measurement_quality"], "sufficient")
            self.assertEqual(row["samples"], 3)
            self.assertTrue(row["baseline_rss_bytes"] is None or row["baseline_rss_bytes"] > 0)
            self.assertTrue(row["loaded_rss_bytes"] is None or row["loaded_rss_bytes"] > 0)

    def test_cancel_and_timeout_terminate_only_the_owned_worker(self):
        self.fixture.write_text('''
import json, sys, time
json.loads(sys.stdin.readline())
print(json.dumps({"type":"phase", "phase":"measurement"}), flush=True)
time.sleep(60)
''')
        entered = threading.Event()
        runner = self.runner(timeout_s=3)
        original_popen, children = subprocess.Popen, []
        def popen(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            children.append(process)
            return process
        def running(*args):
            receive = args[-1]
            def observed(message):
                receive(message)
                entered.set()
            runner(*args[:-1], observed)
        self.host_loads = []
        controller = RuntimeController(self.home / "runtime.json", lambda: ([FP32], "cancel"),
                                       self.host_factory, benchmark_runner=running)
        self.addCleanup(controller.close)
        with patch("benchmark_worker.subprocess.Popen", side_effect=popen):
            controller.start()
            controller.thread.join(3)
            controller.request_benchmark(10)
            self.assertTrue(entered.wait(2))
            controller.cancel()
            controller.thread.join(3)
            self.assertFalse(controller.thread.is_alive())
            self.assertEqual(controller.snapshot()["benchmark"]["status"], "cancelled")
            self.assertEqual(controller.snapshot()["state"], "ready")
            self.assertIsNotNone(children[-1].poll())
            runner.timeout_s = 0.15
            with self.assertRaises(TimeoutError):
                runner(FP32, 10, 2, 3, threading.Event(), lambda _: None)
            self.assertIsNotNone(children[-1].poll())
        self.assertEqual(len(children), 2)
        self.assertNotIn(os.getpid(), [child.pid for child in children])

    def test_hashing_time_is_excluded_from_model_load(self):
        clock = Clock()
        weights = self.home / "model.safetensors"
        weights.write_bytes(b"fixture")
        class Engine:
            def __init__(self, *args, **kwargs):
                clock.advance(11)
            def synchronize(self):
                clock.advance(2)
            def close(self): pass
        api = SimpleNamespace(EditLens=Engine, PIPELINE_FILES=[])
        phases = []
        with patch("runtime_adapters.digest", side_effect=lambda _: clock.advance(5)), \
                patch("runtime_adapters.runtime_version", side_effect=lambda *_: (clock.advance(3), "version")[1]):
            engine, timings = load_candidate(self.home, FP32, 512, 32, None, api, {},
                                             phase=phases.append, clock=clock)
        self.assertEqual(engine.version, "version")
        self.assertEqual(timings, {"hash_ms": 8000, "load_ms": 13000})
        self.assertEqual(phases, ["hashing", "loading", "hashing"])


class ScoringParityTests(unittest.TestCase):
    def test_torch_device_is_explicit_and_cpu_fp16_is_not_silently_coerced(self):
        class Model:
            config = SimpleNamespace(num_labels=4)
            def to(self, *_):
                return self
            def eval(self):
                return self
        fake_torch = SimpleNamespace(float32="float32", float16="float16")
        fake_transformers = SimpleNamespace(
            AutoModelForSequenceClassification=SimpleNamespace(from_pretrained=lambda *a, **k: Model()))
        with patch.dict(sys.modules, {"torch": fake_torch, "transformers": fake_transformers}), \
                patch.object(engine_api, "require_model"), patch.object(engine_api, "Tokenizer", lambda _: object()):
            for device in ("cpu", "mps", "cuda:0"):
                engine = engine_api.EditLens(Path("unused"), device, 512, 8, "fp32", None, warmup=False)
                self.assertEqual((engine.device, engine.dtype_name), (device, "float32"))
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
        # MLX aborts the process when a graph is evaluated off the thread that built
        # it; every forward runs on the engine's own thread, whoever calls score.
        mlx_threads = []
        def mlx_model(ids, mask):
            mlx_threads.append(threading.current_thread().name)
            self_test.assertEqual(ids.dtype, np.int32)
            self_test.assertTrue(np.array_equal(mask, ids != 0))
            return logits(ids)
        fake_mx = SimpleNamespace(array=np.asarray, clear_cache=lambda: mlx_threads.append("released"))
        mlx = MlxEditLens.__new__(MlxEditLens)
        mlx.api, mlx.model = engine_api, mlx_model
        mlx.owner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="anagram-mlx")
        direct = engine_api.EditLens.__new__(engine_api.EditLens)
        for engine in (onnx, mlx, direct):
            engine.tok, engine.emoji = Tokenizer(), emoji
            engine.max_length, engine.batch_size, engine.n_buckets = 8, 2, 4
            engine.lock = threading.Lock()
        direct._logits = lambda ids: logits(direct.tok.pad({"input_ids": ids})["input_ids"])
        texts = ["Sure, here it is.\nA DIFFERENT paragraph 🙂", "Long " * 20, "short",
                 "discarded reasoning</think> This IS the answer"]
        expected, actual = direct.score(texts), onnx.score(texts)
        self.assertEqual(actual, expected)
        with patch.dict(sys.modules, {"mlx": SimpleNamespace(core=fake_mx), "mlx.core": fake_mx}):
            elsewhere = []
            caller = threading.Thread(target=lambda: elsewhere.append(mlx.score(texts)))
            caller.start()
            caller.join(5)
            self.assertEqual(elsewhere, [expected])
            self.assertEqual(mlx.score(texts), expected)
            mlx.close()
        self.assertEqual(len(mlx_threads), 5)  # two batches per score, then the release
        self.assertTrue(all(name.startswith("anagram-mlx") for name in mlx_threads[:-1]))
        self.assertEqual((mlx_threads[-1], mlx.owner, mlx.model), ("released", None, None))
        self.assertTrue(actual[1]["truncated"])
        self.assertEqual(actual[1]["tokens"], 8)
        self.assertEqual(len(actual[0]["probs"]), 4)
        self.assertEqual(onnx.tok.cleaned, direct.tok.cleaned)
        self.assertNotIn("sure", onnx.tok.cleaned[0])
        self.assertEqual(onnx.tok.cleaned[-1], "this is the answer")
        self.assertEqual(sum(len(feed["input_ids"]) for feed in feeds), len(texts))


class MlxFailureTests(unittest.TestCase):
    def test_a_failure_mlx_reports_fails_the_batch_retriably_and_drops_its_buffers(self):
        import numpy as np
        import emoji

        class Tokenizer:
            eos_token_id = sep_token_id = 2
            def __call__(self, texts, **_):
                return {"input_ids": [[1, 5, 2] for _ in texts]}
            def pad(self, inputs, **_):
                ids = np.array(inputs["input_ids"])
                return {"input_ids": ids, "attention_mask": np.ones_like(ids)}

        calls = []
        def failing(ids, mask):
            calls.append(("forward", threading.current_thread().name))
            raise RuntimeError("[METAL] Command buffer execution failed: Discarded (victim of GPU error/recovery)")
        fake_mx = SimpleNamespace(array=np.asarray,
                                  clear_cache=lambda: calls.append(("clear", threading.current_thread().name)))
        mlx = MlxEditLens.__new__(MlxEditLens)
        mlx.api, mlx.model, mlx.tok, mlx.emoji = engine_api, failing, Tokenizer(), emoji
        mlx.owner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="anagram-mlx")
        mlx.max_length, mlx.batch_size, mlx.n_buckets, mlx.lock = 8, 2, 4, threading.Lock()
        with patch.dict(sys.modules, {"mlx": SimpleNamespace(core=fake_mx), "mlx.core": fake_mx}):
            with self.assertRaisesRegex(RuntimeFailure, "Command buffer execution failed"):
                mlx.score(["a paragraph"])
            # Dropped on MLX's own thread, and the engine is not held: the next batch runs.
            self.assertEqual([what for what, _ in calls], ["forward", "clear"])
            self.assertTrue(all(name.startswith("anagram-mlx") for _, name in calls))
            mlx.model = lambda ids, mask: np.zeros((len(ids), 4), dtype=np.float32)
            self.assertEqual(len(mlx.score(["a paragraph", "another"])), 2)
            mlx.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
