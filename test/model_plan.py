#!/usr/bin/env python3
"""Capability probing and scoped model plans, without classifier weights/network."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "anagramd"))
import model_plan
from model_plan import ARTIFACT_PATHS, build_plan, candidate_catalog, discover_hardware
from runtime_adapters import OnnxEditLens, create_controller, execution_environment
from runtime_controller import Candidate


def hardware(*, torch=True, cpu=True, mps=False, cuda=False, ort=True, ort_cpu=True, ort_cuda=False, rocm=False):
    def state(value):
        return {"available": value, "error": None if value else "probe unavailable"}
    def device(kind):
        return {"id": "cuda:0", "index": 0, "label": "Test accelerator (" + kind + ")", "kind": kind, **state(True)}
    return {"schema_version": 1, "system": "TestOS", "machine": "test-cpu",
            "torch": {"available": torch, "version": "test", "error": None,
                      "cpu": state(cpu and torch), "mps": state(mps and torch),
                      "cuda": [device("rocm" if rocm else "cuda")] if cuda else []},
            "onnx": {"available": ort, "version": "test", "error": None,
                     "cpu": state(ort_cpu and ort), "cuda": [device("cuda")] if ort_cuda else [],
                     "providers": ["CPUExecutionProvider", "CUDAExecutionProvider", "CoreMLExecutionProvider"]}}


class FakeTorch:
    __version__ = "test"
    float32 = "float32"

    def __init__(self, *, mps=False, cuda=0, fail=(), rocm=False):
        self.calls = []
        self.fail = set(fail)
        self.version = SimpleNamespace(cuda=None if rocm else "test", hip="test" if rocm else None)
        self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps))
        self.mps = SimpleNamespace(synchronize=lambda: self.calls.append(("sync", "mps")))
        self.cuda = SimpleNamespace(is_available=lambda: bool(cuda), device_count=lambda: cuda,
                                    get_device_name=lambda i: f"Device {i}",
                                    synchronize=lambda device: self.calls.append(("sync", device)))
        self.get_num_threads = lambda: 4
        self.get_num_interop_threads = lambda: 4

    def ones(self, shape, *, dtype, device):
        self.calls.append(("allocate", device))
        if device in self.fail:
            raise RuntimeError("allocation failed on " + device)
        return np.ones(shape, dtype=np.float32)


class FakeOrt:
    __version__ = "test"

    def __init__(self, *, cuda=False, wrong=False, fallback=False):
        self.providers = ["CPUExecutionProvider"] + (["CUDAExecutionProvider"] if cuda else [])
        self.calls = []
        self.wrong = wrong
        self.fallback = fallback
        self.telemetry_disabled = False

    def disable_telemetry_events(self):
        self.telemetry_disabled = True

    def get_available_providers(self):
        return self.providers

    class SessionOptions:
        def __init__(self):
            self.config = {}
        def add_session_config_entry(self, key, value):
            self.config[key] = value

    def InferenceSession(self, graph, *, sess_options, providers):
        if not isinstance(graph, bytes):
            raise AssertionError("Probe must use in-memory bytes, not model files")
        first = providers[0]
        name = first[0] if isinstance(first, tuple) else first
        self.calls.append((name, sess_options.config, first))
        def run(names, inputs):
            self.calls.append(("run", name))
            assert names == ["z"]
            return [np.zeros((2, 2), dtype=np.float32) if self.wrong else inputs["x"] @ inputs["y"]]
        return SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider" if self.fallback else name],
                               disable_fallback=lambda: None, run=run)


class ModelPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pin = json.loads((ROOT / "anagramd/modelkit.json").read_text())

    def weights(self, plan):
        return set(plan["selected_paths"]) & set(ARTIFACT_PATHS.values())

    def test_import_is_light_without_any_runtime(self):
        code = """
import sys
class RejectRuntimeImport:
    def find_spec(self, fullname, *args):
        if fullname.split('.')[0] in {'torch', 'onnxruntime', 'numpy'}:
            raise AssertionError('heavy import: ' + fullname)
sys.meta_path.insert(0, RejectRuntimeImport())
sys.path.insert(0, sys.argv[1])
import model_plan
assert 'torch' not in sys.modules and 'onnxruntime' not in sys.modules
"""
        run = subprocess.run([sys.executable, "-I", "-c", code, str(ROOT / "anagramd")],
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_discovery_allocates_syncs_and_retains_gpu_errors(self):
        torch, ort = FakeTorch(mps=True, cuda=2, fail={"mps", "cuda:1"}), FakeOrt()
        with patch.object(model_plan.importlib, "import_module", side_effect=lambda name: {"torch": torch, "onnxruntime": ort}[name]), \
                patch.object(model_plan.platform, "system", return_value="Darwin"):
            found = discover_hardware()
        self.assertTrue(found["torch"]["cpu"]["available"])
        self.assertFalse(found["torch"]["mps"]["available"])
        self.assertIn("allocation failed", found["torch"]["mps"]["error"])
        self.assertTrue(found["torch"]["cuda"][0]["available"])
        self.assertFalse(found["torch"]["cuda"][1]["available"])
        self.assertIn(("sync", "cuda:0"), torch.calls)
        self.assertTrue(found["onnx"]["cpu"]["available"])
        self.assertIn(("run", "CPUExecutionProvider"), ort.calls)
        self.assertTrue(ort.telemetry_disabled)

    def test_mps_reports_working_only_after_sync_and_result(self):
        torch, ort = FakeTorch(mps=True), FakeOrt()
        with patch.object(model_plan.importlib, "import_module", side_effect=lambda name: {"torch": torch, "onnxruntime": ort}[name]):
            found = discover_hardware()
        self.assertTrue(found["torch"]["mps"]["available"])
        self.assertIn(("allocate", "mps"), torch.calls)
        self.assertIn(("sync", "mps"), torch.calls)

    def test_ort_cuda_probe_works_without_torch_and_disables_cpu_fallback(self):
        ort = FakeOrt(cuda=True)
        def load(name):
            if name == "torch":
                raise ImportError("Torch not installed")
            return ort
        with patch.object(model_plan.importlib, "import_module", side_effect=load):
            found = discover_hardware()
        self.assertFalse(found["torch"]["available"])
        self.assertTrue(found["onnx"]["cuda"][0]["available"])
        cuda_call = next(row for row in ort.calls if row[0] == "CUDAExecutionProvider")
        self.assertEqual(cuda_call[1], {"session.disable_cpu_ep_fallback": "1"})
        self.assertEqual(cuda_call[2][1], {"device_id": 0})
        cpu_call = next(row for row in ort.calls if row[0] == "CPUExecutionProvider")
        self.assertNotIn("session.disable_cpu_ep_fallback", cpu_call[1])
        self.assertIn(("run", "CUDAExecutionProvider"), ort.calls)

    def test_provider_listing_without_correct_execution_is_not_available(self):
        for ort in (FakeOrt(cuda=True, wrong=True), FakeOrt(cuda=True, fallback=True)):
            with self.subTest(ort=ort), patch.object(model_plan.importlib, "import_module", side_effect=lambda name: FakeTorch() if name == "torch" else ort):
                found = discover_hardware()
            self.assertFalse(found["onnx"]["cuda"][0]["available"])
            self.assertIsNotNone(found["onnx"]["cuda"][0]["error"])

    def test_rocm_keeps_cuda_api_identity_without_nvidia_driver_claim(self):
        torch, ort = FakeTorch(cuda=1, rocm=True), FakeOrt()
        with patch.object(model_plan.importlib, "import_module", side_effect=lambda name: {"torch": torch, "onnxruntime": ort}[name]):
            found = discover_hardware()
        device = found["torch"]["cuda"][0]
        self.assertEqual(device["id"], "cuda:0")
        self.assertEqual(device["kind"], "rocm")
        self.assertIn("ROCm", device["label"])
        with patch("runtime_adapters.cuda_driver_version", side_effect=AssertionError("NVIDIA driver queried for ROCm")):
            environment = execution_environment(torch)
        self.assertIsNone(environment["cuda_driver"])
        self.assertEqual(environment["hip_runtime"], "test")

    def test_recommended_gpu_shares_one_source_with_cpu_and_half_precision(self):
        plan = build_plan(self.pin, hardware(mps=True))
        self.assertEqual(plan["artifact_ids"], ["torch-source"])
        self.assertEqual(self.weights(plan), {"model.safetensors"})
        self.assertEqual(plan["candidate_ids"], ["torch:cpu:fp32", "torch:mps:fp32", "torch:mps:fp16"])
        self.assertIn("Apple GPU (MPS)", plan["devices"])
        shared = {e["path"] for e in self.pin["files"]} - set(ARTIFACT_PATHS.values())
        self.assertTrue(shared <= set(plan["selected_paths"]))
        self.assertEqual(len(set(plan["selected_paths"])), len(plan["selected_paths"]))
        self.assertEqual(plan["total_bytes"], sum(e["size_bytes"] for e in plan["files"]))
        plan["files"][0]["size_bytes"] = 0
        self.assertNotEqual(self.pin["files"][0]["size_bytes"], 0)

    def test_recommended_cpu_prefers_verified_ort_else_torch(self):
        ort = build_plan(self.pin, hardware())
        self.assertEqual(ort["candidate_ids"], ["onnx:cpu:fp32"])
        self.assertEqual(self.weights(ort), {"onnx/model.onnx"})
        torch = build_plan(self.pin, hardware(ort=False))
        self.assertEqual(torch["candidate_ids"], ["torch:cpu:fp32"])
        self.assertEqual(self.weights(torch), {"model.safetensors"})

    def test_recommended_ort_cuda_uses_only_fp32_with_same_file_cpu_fallback(self):
        plan = build_plan(self.pin, hardware(torch=False, ort_cuda=True))
        self.assertEqual(plan["candidate_ids"], ["onnx:cpu:fp32", "onnx:cuda:0:fp32"])
        self.assertEqual(self.weights(plan), {"onnx/model.onnx"})

    def test_expanded_cpu_omits_half_coreml_and_mlx_despite_provider_listing(self):
        plan = build_plan(self.pin, hardware(), "expanded")
        self.assertEqual(self.weights(plan), {"model.safetensors", "onnx/model.onnx", "onnx/model_int8.onnx"})
        self.assertEqual(plan["candidate_ids"], ["torch:cpu:fp32", "onnx:cpu:fp32", "onnx:cpu:int8"])
        catalog = candidate_catalog(hardware())
        self.assertTrue(next(c for c in catalog if c["id"] == "onnx:cpu:int8")["experimental"])
        self.assertFalse(any(c["precision"] == "fp16" for c in catalog))

    def test_expanded_ort_cuda_adds_half_file_but_never_cuda_int8(self):
        plan = build_plan(self.pin, hardware(cuda=True, ort_cuda=True), "expanded")
        self.assertEqual(self.weights(plan), set(ARTIFACT_PATHS.values()))
        self.assertIn("onnx:cuda:0:fp16", plan["candidate_ids"])
        self.assertNotIn("onnx:cuda:0:int8", plan["candidate_ids"])
        self.assertNotIn("onnx:cpu:fp16", plan["candidate_ids"])

    def test_no_runtime_or_invalid_pin_never_returns_shared_only_plan(self):
        with self.assertRaises(ValueError):
            build_plan(self.pin, hardware(torch=False, ort=False))
        with self.assertRaises(ValueError):
            build_plan(self.pin, hardware(), "all")
        pin = copy.deepcopy(self.pin)
        pin["files"] = [e for e in pin["files"] if e["path"] != "onnx/model.onnx"]
        with self.assertRaises(ValueError):
            build_plan(pin, hardware())
        pin = copy.deepcopy(self.pin)
        pin["files"].append(copy.deepcopy(pin["files"][0]))
        with self.assertRaises(ValueError):
            build_plan(pin, hardware())

    def test_controller_filters_old_artifacts_and_rechecks_planned_gpu(self):
        original = hardware(mps=True)
        plan = build_plan(self.pin, original)
        fake_api = SimpleNamespace(LanguageId=lambda _: object(), pipeline_manifest=lambda *_: {"test": True})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model"
            (model / "onnx").mkdir(parents=True)
            (model / "config.json").write_text("{}")
            for name in ARTIFACT_PATHS.values():
                (model / name).write_bytes(b"tiny placeholder; never loaded")
            with patch("runtime_adapters.discover_hardware", return_value=original) as probe, \
                    patch("runtime_adapters.execution_environment", return_value={}):
                controller = create_controller(model, root / "runtime.json", root / "lid", api=fake_api, plan=plan)
                self.assertEqual(probe.call_count, 0)
                candidates, *_ = controller.discover()
            self.assertEqual([c.id for c in candidates], plan["candidate_ids"])
            self.assertTrue(all(c.available for c in candidates))
            failed = hardware(mps=False)
            failed["torch"]["mps"]["error"] = "MPS allocation no longer works"
            with patch("runtime_adapters.discover_hardware", return_value=failed), \
                    patch("runtime_adapters.execution_environment", return_value={}):
                changed, *_ = controller.discover()
            self.assertTrue(changed[0].available)
            self.assertTrue(all(not c.available and "allocation" in c.reason for c in changed[1:]))
            controller.close()

    def test_removed_device_precision_combinations_are_rejected_by_adapter(self):
        for device, precision in (("cpu", "fp16"), ("coreml", "fp32"), ("cuda:0", "int8")):
            candidate = Candidate("test", "test", device, "onnx", precision)
            with self.subTest(device=device, precision=precision), self.assertRaises(ValueError):
                OnnxEditLens.provider_options(candidate)
        self.assertEqual(OnnxEditLens.provider_options(Candidate("x", "x", "cuda:2", "onnx", "fp16"))["provider_options"], {"device_id": 2})


if __name__ == "__main__":
    unittest.main(verbosity=2)
