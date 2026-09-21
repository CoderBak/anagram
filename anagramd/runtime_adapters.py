"""Offline Torch/ONNX adapters and hardware inventory for the runtime controller.

Imports of model libraries are deliberately inside background discovery/loading.
Only the fixed artifact names below can be selected through native runtime controls.
"""
from __future__ import annotations

import gc
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
import threading
import time
from pathlib import Path

import numpy as np

from runtime_controller import Candidate, RuntimeController, error_text
from scoring import score_texts

ONNX_FILES = {"fp32": "model.onnx", "fp16": "model_fp16.onnx", "int8": "model_int8.onnx"}
_DIGESTS = {}


def package_version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def cuda_driver_version():
    """Read the installed driver's version, without starting a model or shell."""
    if sys.platform not in {"linux", "win32"}:
        return None
    try:
        import ctypes
        driver = ctypes.CDLL("nvcuda.dll" if sys.platform == "win32" else "libcuda.so.1")
        value = ctypes.c_int()
        query = driver.cuDriverGetVersion
        query.argtypes = [ctypes.POINTER(ctypes.c_int)]
        query.restype = ctypes.c_int
        return value.value if query(ctypes.byref(value)) == 0 else None
    except (OSError, AttributeError):
        return None


def execution_environment(torch_module=None):
    # A saved speed comparison is only useful for the hardware/thread/driver
    # configuration that ran it. Apple accelerator drivers follow the OS build.
    result = {"system": platform.system(), "machine": platform.machine(),
              "os_build": platform.version(), "cpu_count": os.cpu_count(),
              "cpu_affinity": sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
              "thread_env": {name: os.environ.get(name) for name in
                             ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")}}
    if torch_module is not None:
        result.update(torch_threads=torch_module.get_num_threads(),
                      torch_interop_threads=torch_module.get_num_interop_threads(),
                      cuda_runtime=torch_module.version.cuda, hip_runtime=torch_module.version.hip,
                      cuda_driver=cuda_driver_version() if torch_module.cuda.is_available() else None)
    return result


def digest(path: Path):
    stat = path.stat()
    key = (str(path.resolve()), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    if key not in _DIGESTS:
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(4 << 20), b""):
                h.update(chunk)
        after = path.stat()
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != key[1:]:
            raise ValueError(f"Model artifact changed while reading {path.name}; retry after the download finishes")
        _DIGESTS[key] = h.hexdigest()
    return _DIGESTS[key]


def artifact_files(model_dir: Path, candidate: Candidate):
    if candidate.runtime == "onnx":
        directory = model_dir / "onnx"
        graph = directory / ONNX_FILES[candidate.precision]
        # External tensor data participates in identity too. Other .onnx variants
        # do not, so replacing INT8 alone cannot relabel the FP32 graph.
        return [graph, *sorted(p for p in directory.rglob("*") if p.is_file()
                              and p.suffix != ".onnx" and not any(x.startswith(".") for x in p.relative_to(directory).parts))]
    files = sorted(model_dir.glob("*.safetensors"))
    if not files:
        files = sorted(model_dir.glob("pytorch_model*.bin"))
    return files + sorted(model_dir.glob("*.index.json"))


def artifact_stamp(files):
    return [(str(p), p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns) for p in files]


def runtime_version(engine, candidate, model_dir, api, options):
    files = artifact_files(model_dir, candidate)
    if not files:
        raise ValueError("No local model weights; download models in Anagram Settings")
    weights = {str(p.relative_to(model_dir)): digest(p) for p in files}
    weight_hash = hashlib.sha256(json.dumps(weights, sort_keys=True).encode()).hexdigest()
    manifest = api.pipeline_manifest(model_dir, engine.max_length, engine.dtype_name, engine.lid)
    manifest["runtime"] = {"candidate": candidate.id, "runtime": candidate.runtime,
                           "device": candidate.device, "precision": candidate.precision,
                           "options": options,
                           "versions": {name: package_version(name) for name in
                                        ("torch", "transformers", "onnxruntime", "numpy")},
                           "implementation": {name: digest(Path(__file__).with_name(name))
                                              for name in ("engine.py", "runtime_adapters.py", "scoring.py")}}
    tail = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    return f"sha256:{weight_hash[:12]}-p{tail[:8]}-runtime1"


class OnnxEditLens:
    def __init__(self, model_dir, candidate, max_length, batch_size, lid, api):
        import emoji
        import onnxruntime as ort
        from transformers import AutoTokenizer

        if hasattr(ort, "disable_telemetry_events"):
            ort.disable_telemetry_events()

        self.emoji, self.lid = emoji, lid
        self.max_length, self.batch_size = max_length, batch_size
        self.device, self.dtype_name = candidate.device, candidate.precision
        self.lock = threading.Lock()
        self.scored = 0
        self.started = time.time()
        self.last_run_ms = self.last_wait_ms = 0.0
        self.n_buckets = len(api.BUCKET_LABELS)
        self.api = api
        config = json.loads((model_dir / "config.json").read_text())
        if (config.get("architectures") != ["RobertaForSequenceClassification"]
                or len(config.get("id2label", {})) != self.n_buckets
                or config.get("problem_type") not in (None, "single_label_classification")):
            raise ValueError("The ONNX adapter requires the four-class EditLens RoBERTa configuration")
        self.tok = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True,
                                                 trust_remote_code=False)
        self.options = self.provider_options(candidate)
        provider = self.options["provider"]
        if provider not in ort.get_available_providers():
            raise ValueError(f"{provider} is not available in the installed ONNX Runtime")
        session_options = ort.SessionOptions()
        session_options.log_severity_level = 3
        self.options["session"] = {"intra_op_num_threads": session_options.intra_op_num_threads,
                                   "inter_op_num_threads": session_options.inter_op_num_threads,
                                   "execution_mode": str(session_options.execution_mode),
                                   "graph_optimization_level": str(session_options.graph_optimization_level)}
        requested = [(provider, self.options["provider_options"])]
        if provider != "CPUExecutionProvider":
            requested.append("CPUExecutionProvider")
        graph = model_dir / "onnx" / ONNX_FILES[candidate.precision]
        self.session = ort.InferenceSession(str(graph), sess_options=session_options, providers=requested)
        # ORT can fall back to CPU when an EP fails to initialize. Never label that
        # session as a successfully selected accelerator. Graph partition fallback
        # within a successfully initialized CoreML/CUDA provider remains possible.
        if not self.session.get_providers() or self.session.get_providers()[0] != provider:
            self.session = None
            raise ValueError(f"{provider} could not initialize; choose the CPU candidate explicitly")
        self.session.disable_fallback()
        self.input_names = {value.name for value in self.session.get_inputs()}
        if not self.input_names <= {"input_ids", "attention_mask", "token_type_ids"}:
            raise ValueError(f"Unsupported ONNX inputs: {sorted(self.input_names)}")
        if "input_ids" not in self.input_names:
            raise ValueError("ONNX graph has no input_ids")
        outputs = self.session.get_outputs()
        if not any(value.name == "logits" for value in outputs):
            raise ValueError("ONNX graph has no logits output")

    @staticmethod
    def provider_options(candidate):
        if candidate.device.startswith("cuda:"):
            return {"provider": "CUDAExecutionProvider",
                    "provider_options": {"device_id": int(candidate.device.split(":")[1])}}
        if candidate.device == "coreml":
            return {"provider": "CoreMLExecutionProvider",
                    "provider_options": {"MLComputeUnits": "ALL"}}
        return {"provider": "CPUExecutionProvider", "provider_options": {}}

    def _logits(self, ids):
        enc = self.tok.pad({"input_ids": ids}, padding=True, return_tensors="np")
        if "token_type_ids" in self.input_names and "token_type_ids" not in enc:
            enc["token_type_ids"] = np.zeros_like(enc["input_ids"])
        feed = {name: np.asarray(enc[name], dtype=np.int64) for name in self.input_names}
        return self.session.run(["logits"], feed)[0]

    def score(self, texts):
        return score_texts(self, texts, self.api.clean_text)

    def synchronize(self):
        # session.run returns CPU logits synchronously.
        pass

    def accelerator_bytes(self):
        # Torch's allocator counters do not measure allocations owned by ORT.
        return None

    def info(self):
        info = self.api.EditLens.info(self)
        info["runtime"] = "onnx"
        return info

    def close(self):
        self.session = None
        self.tok = None
        gc.collect()


def create_controller(model_dir: Path, config_path: Path, lid_path: Path,
                      max_length=512, batch_size=32, *, api=None):
    if api is None:
        import engine as api
    model_dir, lid_path = Path(model_dir), Path(lid_path)
    gate = None
    environment = None

    def discover():
        nonlocal gate, environment
        candidates = []
        torch_error = ort_error = None
        cuda_devices, mps, providers = [], False, []
        torch_module = None
        try:
            import torch
            torch_module = torch
            mps = torch.backends.mps.is_available()
            if torch.cuda.is_available():
                cuda_devices = [(i, torch.cuda.get_device_name(i)) for i in range(torch.cuda.device_count())]
        except Exception as exc:
            torch_error = error_text(exc)
        try:
            import onnxruntime as ort
            if hasattr(ort, "disable_telemetry_events"):
                ort.disable_telemetry_events()
            providers = ort.get_available_providers()
        except Exception as exc:
            ort_error = error_text(exc)
        environment = execution_environment(torch_module)
        common_missing = None if (model_dir / "config.json").is_file() else "Model configuration is missing; download models in Anagram Settings"

        def add(runtime, device, device_label, precision, unavailable=None):
            candidate = Candidate(id=f"{runtime}:{device}:{precision}",
                                  label=f"{device_label} · {'PyTorch' if runtime == 'torch' else 'ONNX Runtime'} · {precision.upper()}",
                                  device=device, runtime=runtime, precision=precision,
                                  experimental=precision == "int8")
            reason = common_missing or unavailable
            if not reason:
                files = artifact_files(model_dir, candidate)
                if not files or any(not p.is_file() for p in files):
                    reason = "Model artifact is missing; download models in Anagram Settings"
            if reason:
                candidate = Candidate(**{**candidate.__dict__, "available": False, "reason": reason})
            candidates.append(candidate)

        cpu_label = f"CPU ({platform.machine()})"
        add("torch", "cpu", cpu_label, "fp32", torch_error)
        for device, label in ([("mps", "Apple GPU (MPS)")] if mps else []) + [
                (f"cuda:{index}", name) for index, name in cuda_devices]:
            for precision in ("fp32", "fp16"):
                add("torch", device, label, precision, torch_error)
        for precision in ONNX_FILES:
            add("onnx", "cpu", cpu_label, precision,
                ort_error or (None if "CPUExecutionProvider" in providers else "CPUExecutionProvider is unavailable"))
        if "CUDAExecutionProvider" in providers:
            for index, name in cuda_devices:
                for precision in ("fp32", "fp16"):
                    add("onnx", f"cuda:{index}", name, precision)
        # CoreML's cold graph compilation is unsuitable for this quick first-run
        # comparison. MPS covers Apple GPUs. Dynamic INT8 MatMulInteger commonly
        # falls back to CPU on CUDA, so do not offer it as a GPU INT8 candidate.
        # Gate construction is background work too. Preserve control-plane access
        # if its dependency/file is absent; a later benchmark retries discovery.
        gate = api.LanguageId(lid_path)
        inventory = {"candidates": [c.__dict__ for c in candidates],
                     "machine": [environment, cuda_devices, mps],
                     "versions": {n: package_version(n) for n in ("torch", "transformers", "onnxruntime", "numpy")},
                     "pipeline": api.pipeline_manifest(model_dir, max_length, "catalog", gate),
                     "batch_size": batch_size,
                     "artifacts": {c.id: artifact_stamp(artifact_files(model_dir, c)) for c in candidates if c.available},
                     "implementation": {name: digest(Path(__file__).with_name(name)) for name in
                                        ("runtime_adapters.py", "runtime_controller.py", "scoring.py")}}
        context = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()
        return candidates, context

    def factory(candidate):
        if gate is None:
            raise ValueError("Language gate has not initialized; rerun the comparison")
        files = [*artifact_files(model_dir, candidate),
                 *[model_dir / name for name in api.PIPELINE_FILES if (model_dir / name).is_file()]]
        before = artifact_stamp(files)
        engine = None
        try:
            if candidate.runtime == "torch":
                engine = api.EditLens.__new__(api.EditLens)
                engine.__init__(model_dir, candidate.device, max_length, batch_size,
                                candidate.precision, gate, warmup=False)
                options = {"device": candidate.device, "environment": environment}
            else:
                engine = OnnxEditLens.__new__(OnnxEditLens)
                engine.__init__(model_dir, candidate, max_length, batch_size, gate, api)
                options = {**engine.options, "environment": environment}
            engine.version = runtime_version(engine, candidate, model_dir, api, options)
            if artifact_stamp(files) != before:
                raise ValueError("Model artifacts changed during loading; rerun after downloading finishes")
            return engine
        except BaseException:
            if engine is not None:
                try:
                    engine.close()
                except Exception:
                    pass  # preserve the original, actionable load failure
            gc.collect()
            raise

    return RuntimeController(config_path, discover, factory)
