#!/usr/bin/env python3
"""Experimental EditLens Apple comparison; never installed with the component.

Default: inspect dependencies only. --run explicitly starts sequential, isolated
model workers. Inputs are English browser-fixture prose (not an accuracy corpus),
or --texts JSON containing a list of paragraphs. Measurements exclude tokenization
but include input transfer, synchronized forward, and returning CPU logits.

MLX reuses the installed GPL-3.0 mlx-embeddings XLM-RoBERTa encoder and connects
the checkpoint's actual four-class RoBERTa head. No upstream source is vendored.
Sources: https://github.com/Blaizzy/mlx-embeddings
https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html
https://ml-explore.github.io/mlx/build/html/python/memory_management.html
"""
from __future__ import annotations

import argparse
import atexit
from collections import Counter
import hashlib
from html.parser import HTMLParser
import importlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
import types

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT.parent / "modelkit-work"
BACKENDS = ("mps", "coreml", "mlx", "coreml-direct")
for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"):
    os.environ[name] = "1"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"
sys.path.insert(0, str(ROOT / "anagramd"))


def sha(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 << 20), b""):
            result.update(block)
    return result.hexdigest()


def remove_run_cache(path, run_root):
    """Only the fresh run's cache subtree is eligible for automatic removal."""
    path, run_root = Path(path), Path(run_root).resolve()
    cache_root = run_root / "cache"
    if path.is_symlink() or not path.resolve().is_relative_to(cache_root):
        raise ValueError("Refusing to clean a path outside this run's cache")
    if not path.exists():
        return 0
    logical_bytes = sum(item.stat().st_size for item in path.rglob("*") if item.is_file() and not item.is_symlink())
    shutil.rmtree(path)
    return logical_bytes


def versions():
    result = {}
    for package in ("torch", "transformers", "onnxruntime", "onnx", "mlx", "mlx-metal", "mlx-embeddings", "coremltools"):
        try:
            result[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            result[package] = None
    return result


def mlx_backbone_module():
    """Load installed encoder modules without the unrelated vision/Hub loader."""
    distribution = importlib.metadata.distribution("mlx-embeddings")
    directory = Path(distribution.locate_file("mlx_embeddings/models"))
    package_name = "_anagram_experimental_mlx_embeddings_models"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(directory)]
        sys.modules[package_name] = package
    return importlib.import_module(package_name + ".xlm_roberta")


def check_dependencies():
    result = {"versions": versions(), "platform": platform.platform(), "python": sys.version,
              "loads_model_weights": False}
    try:
        import torch
        result["mps_available"] = torch.backends.mps.is_available()
        result["torch_threads"] = torch.get_num_threads()
    except Exception as exc:
        result["torch_error"] = str(exc)
    try:
        import onnxruntime as ort
        ort.disable_telemetry_events()
        result["onnx_providers"] = ort.get_available_providers()
    except Exception as exc:
        result["onnx_error"] = str(exc)
    try:
        import mlx.core as mx
        module = mlx_backbone_module()
        # Exercise only the padding-position formula; no model is constructed.
        ids = mx.array([[0, 42, 2, 1, 1]], dtype=mx.int32)
        actual = module.XLMRobertaEmbeddings.create_position_ids_from_input_ids(None, ids, 1)
        mx.eval(actual)
        assert actual.tolist() == [[2, 3, 4, 1, 1]]
        result.update(mlx_available=True, mlx_padding_positions=actual.tolist(),
                      mlx_encoder_source_sha256=sha(module.__file__))
    except Exception as exc:
        result["mlx_error"] = str(exc)
    try:
        import coremltools as ct
        result["coremltools_import"] = ct.__version__
    except Exception as exc:
        result["coremltools_error"] = str(exc)
    return result


class Paragraphs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current = None
        self.paragraphs = []
    def handle_starttag(self, tag, attrs):
        if tag == "p":
            self.current = []
    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)
    def handle_endtag(self, tag):
        if tag == "p" and self.current is not None:
            text = " ".join(" ".join(self.current).split())
            if len(text.split()) >= 20 and sum(ord(c) < 128 for c in text) / max(1, len(text)) > .95:
                self.paragraphs.append(text)
            self.current = None


def input_texts(path):
    if path:
        values = json.loads(Path(path).read_text())
        if not isinstance(values, list) or len(values) < 8 or not all(isinstance(v, str) and v.strip() for v in values):
            raise ValueError("--texts must contain at least eight nonempty paragraphs")
        return values, "user-supplied local paragraphs"
    parser = Paragraphs()
    for name in ("news-article.html", "substack-article.html", "hn-thread.html", "github-issue.html"):
        parser.feed((ROOT / "test/fixtures" / name).read_text())
    values = list(dict.fromkeys(parser.paragraphs))
    if len(values) < 8:
        raise ValueError("Not enough fixture paragraphs; supply --texts")
    # Include short, padded paragraphs and longer passages that exercise truncation.
    values += [" ".join(values[(i + j) % len(values)] for j in range(12)) for i in range(8)]
    return values, "English browser-fixture prose; concatenated passages exercise truncation; not an accuracy dataset"


def prepared_inputs(config):
    import emoji
    import numpy as np
    from transformers import AutoTokenizer
    from engine import clean_text
    tokenizer = AutoTokenizer.from_pretrained(config["model_dir"], local_files_only=True, trust_remote_code=False)
    texts = config["texts"]
    ids = tokenizer([clean_text(text, emoji) for text in texts], truncation=False)["input_ids"]
    length, batch = config["length"], config["batch"]
    eos = tokenizer.eos_token_id
    ids = [value if len(value) <= length else value[:length - 1] + [eos] for value in ids]
    prepared, counts, identity = [], [], hashlib.sha256()
    for sample in range(config["samples"]):
        selected = [ids[(sample * len(ids) // config["samples"] + j) % len(ids)] for j in range(batch)]
        encoded = tokenizer.pad({"input_ids": selected}, padding="max_length", max_length=length, return_tensors="np")
        encoded = {key: np.asarray(encoded[key], dtype=np.int64) for key in ("input_ids", "attention_mask")}
        for value in encoded.values():
            identity.update(value.tobytes())
        counts += [len(row) for row in selected]
        prepared.append(encoded)
    return prepared, {"sha256": identity.hexdigest(), "distinct_texts": len(set(texts)),
                      "tokens_min": min(counts), "tokens_max": max(counts),
                      "tokens_mean": statistics.mean(counts), "shape": [batch, length]}


def onnx_input_dimensions(path):
    """Read only small GraphProto input records, seeking past embedded weights."""
    import onnx
    def integer(stream):
        result, shift = 0, 0
        while True:
            byte = stream.read(1)
            if not byte or shift > 63:
                raise ValueError("Invalid ONNX protobuf")
            value = byte[0]
            result |= (value & 127) << shift
            if not value & 128:
                return result
            shift += 7
    def records(stream, end):
        while stream.tell() < end:
            key = integer(stream)
            field, wire = key >> 3, key & 7
            if wire == 2:
                size = integer(stream)
                begin = stream.tell()
                yield field, begin, size
                stream.seek(begin + size)
            elif wire == 0:
                integer(stream)
            elif wire in (1, 5):
                stream.seek(8 if wire == 1 else 4, 1)
            else:
                raise ValueError("Unsupported ONNX protobuf field")
    result = {}
    with Path(path).open("rb") as stream:
        for field, begin, size in records(stream, Path(path).stat().st_size):
            if field == 7:  # ModelProto.graph
                for graph_field, value_begin, value_size in records(stream, begin + size):
                    if graph_field == 11:  # GraphProto.input
                        if value_size > 65536:
                            raise ValueError("Unexpectedly large ONNX input declaration")
                        value = onnx.ValueInfoProto()
                        value.ParseFromString(stream.read(value_size))
                        result[value.name] = [dimension.dim_param or dimension.dim_value
                                              for dimension in value.type.tensor_type.shape.dim]
                break
    return result


class MPS:
    def __init__(self, config):
        import torch
        from transformers import AutoModelForSequenceClassification
        if not torch.backends.mps.is_available():
            raise RuntimeError("MPS unavailable; run this experiment with access to the Mac GPU")
        self.torch = torch
        self.model = AutoModelForSequenceClassification.from_pretrained(
            config["model_dir"], local_files_only=True, trust_remote_code=False,
            dtype=torch.float32 if config["precision"] == "fp32" else torch.float16).to("mps").eval()
        self.sync()
        self.details = {"parameter_dtypes": sorted({str(p.dtype) for p in self.model.parameters()}),
                        "attention_implementation": self.model.config._attn_implementation,
                        "device_memory_kind": "mps_driver_including_cache; overlaps unified process RAM"}
    def predict(self, encoded):
        with self.torch.inference_mode():
            values = {key: self.torch.as_tensor(value, device="mps") for key, value in encoded.items()}
            return self.model(**values).logits.float().cpu().numpy()
    def sync(self): self.torch.mps.synchronize()
    def memory(self): return {"driver": self.torch.mps.driver_allocated_memory(), "active": self.torch.mps.current_allocated_memory()}


def mlx_checkpoint_weights(weights):
    """Match Transformers' legacy LayerNorm aliases without dropping any keys."""
    mapped, aliases = {}, 0
    for name, value in weights.items():
        original = name
        if name.endswith(".LayerNorm.gamma"):
            name = name[:-5] + "weight"
        elif name.endswith(".LayerNorm.beta"):
            name = name[:-4] + "bias"
        if name in mapped:
            raise ValueError(f"Duplicate checkpoint parameter after LayerNorm mapping: {name}")
        mapped[name] = value
        aliases += name != original
    return list(mapped.items()), aliases


class MLX:
    def __init__(self, config):
        import mlx.core as mx
        import mlx.nn as nn
        from mlx.utils import tree_flatten
        mx.set_default_device(mx.gpu)
        module = mlx_backbone_module()
        settings = json.loads((Path(config["model_dir"]) / "config.json").read_text())
        if settings["architectures"] != ["RobertaForSequenceClassification"] or len(settings["id2label"]) != 4:
            raise ValueError("This experiment requires the four-class RoBERTa checkpoint")
        args = module.ModelArgs.from_dict({**settings, "add_pooling_layer": False})
        class Head(nn.Module):
            def __init__(self):
                super().__init__()
                self.dense = nn.Linear(args.hidden_size, args.hidden_size)
                self.out_proj = nn.Linear(args.hidden_size, 4)
            def __call__(self, hidden):
                return self.out_proj(mx.tanh(self.dense(hidden[:, 0, :])))
        class Classifier(nn.Module):
            def __init__(self):
                super().__init__()
                self.roberta = module.Model(args)
                self.classifier = Head()
            def __call__(self, input_ids, attention_mask):
                hidden = self.roberta.embeddings(input_ids)
                # Match the computation dtype instead of promoting FP16 attention
                # to FP32 through the library's default floating-point mask.
                mask = (1 - attention_mask.astype(hidden.dtype))[:, None, None, :] * mx.array(-10000, dtype=hidden.dtype)
                hidden = self.roberta.encoder(hidden, mask)[0]
                return self.classifier(hidden)
        self.mx, self.model = mx, Classifier()
        weights = mx.load(str(Path(config["model_dir"]) / "model.safetensors"))
        # Strict names/shapes ensure no random or omitted classifier parameters.
        mapped, aliases = mlx_checkpoint_weights(weights)
        self.model.load_weights(mapped, strict=True)
        del mapped
        del weights
        dtype = mx.float32 if config["precision"] == "fp32" else mx.float16
        self.model.set_dtype(dtype)
        self.model.eval()
        mx.eval(self.model.parameters())
        self.sync()
        self.details = {"parameter_dtypes": sorted({str(value.dtype) for _, value in tree_flatten(self.model.parameters())}),
                        "device": str(mx.default_device()),
                        "backbone": "installed mlx-embeddings XLMRoberta embeddings+encoder",
                        "classifier": "checkpoint classifier.dense -> tanh -> classifier.out_proj on first token",
                        "legacy_layernorm_aliases_mapped": aliases,
                        "upstream_source_sha256": sha(module.__file__),
                        "experimental_dependency_license": "GPL-3.0; never packaged in the product",
                        "device_memory_kind": "MLX active/cache allocator bytes; overlaps unified process RAM"}
    def predict(self, encoded):
        import numpy as np
        value = self.model(**{key: self.mx.array(array.astype(np.int32)) for key, array in encoded.items()})
        self.mx.eval(value)
        return np.asarray(value.astype(self.mx.float32))
    def sync(self): self.mx.synchronize()
    def memory(self): return {"active": self.mx.get_active_memory(), "cache": self.mx.get_cache_memory(), "allocator_peak": self.mx.get_peak_memory()}


class CoreML:
    def __init__(self, config):
        import onnxruntime as ort
        ort.disable_telemetry_events()
        if "CoreMLExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("Installed ORT has no CoreMLExecutionProvider")
        graph = Path(config["model_dir"]) / "onnx" / ("model.onnx" if config["precision"] == "fp32" else "model_fp16.onnx")
        options = ort.SessionOptions()
        options.enable_profiling = True
        options.profile_file_prefix = str(Path(config["case_dir"]) / "ort-profile")
        dimensions = onnx_input_dimensions(graph)
        bindings = {}
        for shape in dimensions.values():
            for axis, bound in zip(shape, (config["batch"], config["length"])):
                if isinstance(axis, str):
                    if axis in bindings and bindings[axis] != bound:
                        raise ValueError("Inconsistent ONNX symbolic dimensions")
                    bindings[axis] = bound
        for axis, bound in bindings.items():
            options.add_free_dimension_override_by_name(axis, bound)
        cache = Path(config["cache_dir"])
        cache.mkdir(parents=True, exist_ok=True)
        cache_files_before = sum(path.is_file() for path in cache.rglob("*"))
        provider = {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL", "RequireStaticInputShapes": "1",
                    "ModelCacheDirectory": str(cache), "AllowLowPrecisionAccumulationOnGPU": "0"}
        self.session = ort.InferenceSession(str(graph), sess_options=options,
                                           providers=[("CoreMLExecutionProvider", provider), "CPUExecutionProvider"])
        if self.session.get_providers()[0] != "CoreMLExecutionProvider":
            raise RuntimeError("CoreML EP initialization fell back entirely; not a CoreML result")
        self.session.disable_fallback()
        self.inputs = {item.name for item in self.session.get_inputs()}
        self.details = {"provider_options": provider, "input_dimensions": dimensions,
                        "intra_op_num_threads": options.intra_op_num_threads,
                        "inter_op_num_threads": options.inter_op_num_threads,
                        "cache_files_before_session": cache_files_before,
                        "cache_files_after_session": sum(path.is_file() for path in cache.rglob("*")),
                        "graph_precision": config["precision"], "compute_precision": "CoreML provider-controlled; graph dtype is not proof of hardware arithmetic",
                        "device_memory_kind": "unavailable from ORT CoreML", "profiling_during_timing": False,
                        "compile_ms": None, "compile_timing_note": "ORT session creation combines conversion, compilation and load; compare separate cold/cache sessions"}
    def predict(self, encoded):
        return self.session.run(["logits"], {key: value for key, value in encoded.items() if key in self.inputs})[0]
    def sync(self): pass
    def memory(self): return {}
    def finish_profile(self):
        path = Path(self.session.end_profiling())
        events = json.loads(path.read_text())
        nodes, calls, duration = set(), Counter(), Counter()
        for event in events:
            args = event.get("args", {})
            provider = args.get("provider")
            if event.get("cat") == "Node" and provider:
                nodes.add((provider, event.get("name"), args.get("op_name")))
                calls[provider] += 1
                duration[provider] += event.get("dur", 0)
        self.details["profile"] = {"path": str(path), "unique_profiled_kernels_by_provider": dict(Counter(row[0] for row in nodes)),
                                   "warmup_kernel_calls": dict(calls), "warmup_kernel_duration_us": dict(duration),
                                   "note": "Fused partitions count as kernels, not original ONNX operators; CoreML can itself schedule CPU/GPU/ANE."}
        self.details["coreml_partition_observed"] = any(row[0] == "CoreMLExecutionProvider" for row in nodes)


class DirectCoreML:
    def __init__(self, config):
        import coremltools as ct
        self.model = ct.models.MLModel(config["package"], compute_units=ct.ComputeUnit.ALL)
        self.details = {"compute_precision": config["precision"], "compute_units": "ALL (not proof of ANE-only placement)",
                        "device_memory_kind": "unavailable from CoreML"}
    def predict(self, encoded):
        import numpy as np
        return self.model.predict({key: value.astype(np.int32) for key, value in encoded.items()})["logits"]
    def sync(self): pass
    def memory(self): return {}


def prepare_direct(config):
    import numpy as np
    import torch
    import coremltools as ct
    from transformers import AutoModelForSequenceClassification
    Path(config["package"]).parent.mkdir(parents=True, exist_ok=True)
    shape = (config["batch"], config["length"])
    model = AutoModelForSequenceClassification.from_pretrained(config["model_dir"], local_files_only=True,
                                                               trust_remote_code=False, dtype=torch.float32,
                                                               attn_implementation="eager").eval()
    class Wrapper(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model
        def forward(self, input_ids, attention_mask):
            return self.model(input_ids=input_ids, attention_mask=attention_mask).logits
    with torch.inference_mode():
        traced = torch.jit.trace(Wrapper(), (torch.zeros(shape, dtype=torch.int32), torch.ones(shape, dtype=torch.int32)), strict=False)
    converted = ct.convert(traced, convert_to="mlprogram", minimum_deployment_target=ct.target.macOS13,
                           inputs=[ct.TensorType(name=name, shape=shape, dtype=np.int32) for name in ("input_ids", "attention_mask")],
                           outputs=[ct.TensorType(name="logits")], skip_model_load=True,
                           compute_precision=ct.precision.FLOAT32 if config["precision"] == "fp32" else ct.precision.FLOAT16)
    converted.save(config["package"])


def worker(config):
    from runtime_controller import MemorySampler, process_rss
    import numpy as np
    baseline = process_rss()
    begin = time.perf_counter()
    inputs, input_info = prepared_inputs(config)
    preprocessing_ms = (time.perf_counter() - begin) * 1000
    begin = time.perf_counter()
    implementation = {"mps": MPS, "mlx": MLX, "coreml": CoreML, "coreml-direct": DirectCoreML}[config["backend"]]
    backend = implementation(config)
    backend.sync()
    load_ms = (time.perf_counter() - begin) * 1000
    loaded = process_rss()
    warm = time.perf_counter()
    for index in range(config["warmup"]):
        backend.predict(inputs[index % len(inputs)])
        backend.sync()
    warmup_ms = (time.perf_counter() - warm) * 1000
    if hasattr(backend, "finish_profile"):
        backend.finish_profile()
    if config["backend"] == "mlx":
        backend.mx.reset_peak_memory()
    timings, logits, device_memory = [], [], []
    with MemorySampler() as memory:
        for encoded in inputs:
            backend.sync()
            begin = time.perf_counter()
            values = np.asarray(backend.predict(encoded), dtype=np.float32)
            backend.sync()
            timings.append(time.perf_counter() - begin)
            if values.shape != (config["batch"], 4) or not np.isfinite(values).all():
                raise ValueError("Invalid four-class logits")
            logits.append(values.tolist())
            device_memory.append(backend.memory())
            memory.sample()
    resources = {}
    for key in {key for row in device_memory for key in row}:
        values = [row[key] for row in device_memory if key in row]
        resources[key] = {"min_bytes": min(values), "max_bytes": max(values)}
    return {"status": "ok", "backend": config["backend"], "precision": config["precision"],
            "batch": config["batch"], "length": config["length"], "samples": len(timings),
            "cache_mode": config["cache_mode"], "preprocessing_ms": preprocessing_ms,
            "load_or_compile_ms": load_ms, "warmup_ms": warmup_ms,
            "latency_p50_ms": float(np.percentile(timings, 50) * 1000),
            "latency_p90_ms": float(np.percentile(timings, 90) * 1000),
            "throughput_texts_per_s": len(timings) * config["batch"] / sum(timings),
            "measurement_s": sum(timings), "baseline_rss_bytes": baseline, "loaded_rss_bytes": loaded,
            "measurement_peak_rss_bytes": memory.peak, "rss_sample_interval_ms": 50,
            "device_memory": resources, "input": input_info, "details": backend.details,
            "logits": logits, "pid": os.getpid(), "versions": versions(),
            "thread_environment": {key: os.environ.get(key) for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")}}


def parity(row, reference):
    import numpy as np
    if row["input"]["sha256"] != reference["input"]["sha256"]:
        raise ValueError("Input mismatch prevents parity comparison")
    values = np.asarray(row["logits"], dtype=np.float64).reshape(-1, 4)
    expected = np.asarray(reference["logits"], dtype=np.float64).reshape(-1, 4)
    def probabilities(logits):
        weights = np.exp(logits - logits.max(axis=1, keepdims=True))
        return weights / weights.sum(axis=1, keepdims=True)
    difference = np.abs(probabilities(values) - probabilities(expected))
    return {"reference": "MPS FP32; engineering parity only, not accuracy/calibration",
            "max_abs_logit_error": float(np.max(np.abs(values - expected))),
            "mean_abs_logit_error": float(np.mean(np.abs(values - expected))),
            "max_abs_probability_error": float(np.max(difference)),
            "argmax_agreement": float(np.mean(values.argmax(axis=1) == expected.argmax(axis=1))),
            "examples": len(values)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=WORK / "runtime-smoke-models")
    parser.add_argument("--deps", type=Path, default=WORK / "apple-deps")
    parser.add_argument("--output", type=Path, default=WORK / "apple-benchmark")
    parser.add_argument("--texts", type=Path)
    parser.add_argument("--backends", nargs="+", choices=BACKENDS, default=["mps", "coreml", "mlx"])
    parser.add_argument("--precisions", nargs="+", choices=("fp32", "fp16"), default=["fp32", "fp16"])
    parser.add_argument("--batches", nargs="+", type=int, choices=(1, 8), default=[1, 8])
    parser.add_argument("--lengths", nargs="+", type=int, choices=(128, 512), default=[128, 512])
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--keep-cache", action="store_true", help="Keep this run's generated CoreML files; default removes each case cache after cold/warm measurements")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--prepare-direct", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    args.deps = args.deps.resolve()
    args.model_dir = args.model_dir.resolve()
    args.texts = args.texts.resolve() if args.texts else None
    sys.path.insert(0, str(args.deps))
    if args.worker:
        config = json.loads(args.worker.read_text())
        os.chdir(config["case_dir"])
        try:
            if args.prepare_direct:
                started = time.perf_counter()
                prepare_direct(config)
                result = {"status": "ok", "conversion_s": time.perf_counter() - started}
            else:
                result = worker(config)
        except Exception as exc:
            traceback.print_exc()
            result = {"status": "error", "error": str(exc)}
        Path(config["result"]).write_text(json.dumps(result, indent=2, allow_nan=False))
        return 0 if result["status"] == "ok" else 1
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    os.chdir(args.output)
    if not args.run:
        print(json.dumps(check_dependencies(), indent=2))
        return 0
    if args.samples < 20 or args.warmup < 1:
        parser.error("Experiments require at least 20 samples and one warmup")
    texts, source = input_texts(args.texts)
    run_root = Path(tempfile.mkdtemp(prefix="run-", dir=args.output))
    if not args.keep_cache:
        atexit.register(remove_run_cache, run_root / "cache", run_root)
    report = {"schema_version": 1, "platform": platform.platform(), "versions": versions(),
              "run_directory": str(run_root), "keep_cache": args.keep_cache, "cache_cleanup": [],
              "text_source": source, "scope": "pretokenized input -> synchronized four logits on CPU; not browser latency",
              "memory_note": "Each case is a new process. Sampled RSS is not an exact peak. Device counters overlap unified RAM: do not add them. CoreML service allocations may not appear in client RSS.",
              "cases": []}
    report_path = run_root / "report.json"
    hashing_started = time.perf_counter()
    weight_hash = sha(args.model_dir / "model.safetensors")
    hashes = {}
    for precision in set(args.precisions):
        graph = args.model_dir / "onnx" / ("model.onnx" if precision == "fp32" else "model_fp16.onnx")
        if "coreml" in args.backends:
            hashes[precision] = sha(graph)
    report["artifacts"] = {"model.safetensors": weight_hash, "onnx": hashes}
    report["hashing_s"] = time.perf_counter() - hashing_started
    # Always measure MPS FP32 first for every requested shape, even if only MLX
    # or CoreML was requested, so parity never uses a different input/reference.
    order = [("mps", "fp32")] + [(backend, precision) for backend in args.backends
             for precision in args.precisions if (backend, precision) != ("mps", "fp32")]
    references = {}
    for backend, precision in order:
        for batch in args.batches:
            for length in args.lengths:
                modes = ("cold", "warm") if backend == "coreml" else ("none",)
                cache_identity = {"weights": weight_hash if backend == "coreml-direct" else hashes.get(precision),
                                  "script": sha(__file__), "versions": report["versions"], "platform": report["platform"]}
                cache_hash = hashlib.sha256(json.dumps(cache_identity, sort_keys=True).encode()).hexdigest()[:12]
                cache = run_root / "cache" / f"{backend}-{precision}-b{batch}-s{length}-{cache_hash}"
                for mode in modes:
                    name = f"{backend}-{precision}-b{batch}-s{length}-{mode}"
                    case_dir = run_root / name
                    case_dir.mkdir(exist_ok=True)
                    config = {"backend": backend, "precision": precision, "batch": batch, "length": length,
                              "samples": args.samples, "warmup": args.warmup, "texts": texts,
                              "model_dir": str(args.model_dir.resolve()), "case_dir": str(case_dir),
                              "cache_dir": str(cache), "cache_mode": mode,
                              "package": str(cache.with_suffix(".mlpackage")), "result": str(case_dir / "result.json")}
                    if mode == "cold" and cache.exists() and any(cache.iterdir()):
                        config["cache_mode"] = "existing_cache"  # never silently label a reused cache cold
                    config_path = case_dir / "config.json"
                    config_path.write_text(json.dumps(config))
                    command = [sys.executable, "-I", str(Path(__file__).resolve()), "--deps", str(args.deps.resolve()), "--worker", str(config_path)]
                    result_path = Path(config["result"])
                    result_path.unlink(missing_ok=True)
                    print(f"Running {name}", flush=True)
                    with (case_dir / "worker.log").open("wb") as log:
                        try:
                            if backend == "coreml-direct" and not Path(config["package"]).exists():
                                conversion = subprocess.run(command + ["--prepare-direct"], cwd=case_dir, stdout=log, stderr=log, timeout=args.timeout)
                                if conversion.returncode:
                                    raise RuntimeError("Direct CoreML conversion failed; inspect worker.log")
                                conversion_result = json.loads(result_path.read_text())
                            else:
                                conversion_result = None
                            subprocess.run(command, cwd=case_dir, stdout=log, stderr=log, timeout=args.timeout)
                            result = json.loads(result_path.read_text()) if result_path.exists() else {"status": "error", "error": "Worker exited without a result; inspect worker.log"}
                            if conversion_result:
                                result["conversion"] = conversion_result
                        except (subprocess.TimeoutExpired, RuntimeError) as exc:
                            result = {"status": "error", "error": str(exc)}
                    result.update(case=name, log=str(case_dir / "worker.log"), backend=backend,
                                  precision=precision, batch=batch, length=length, cache_mode=config["cache_mode"])
                    if result["status"] == "ok":
                        if backend == "mps" and precision == "fp32":
                            references[(batch, length)] = result
                        elif (batch, length) in references:
                            result["parity"] = parity(result, references[(batch, length)])
                    report["cases"].append(result)
                    report_path.write_text(json.dumps(report, indent=2, allow_nan=False))
                    print(json.dumps({key: result[key] for key in ("case", "status", "latency_p50_ms", "latency_p90_ms", "parity", "error") if key in result}), flush=True)
                    if mode == "cold" and result["status"] != "ok":
                        report.setdefault("skipped_cases", []).append({
                            "case": f"{backend}-{precision}-b{batch}-s{length}-warm",
                            "reason": "Cold session failed or timed out; do not repeat an expensive failed initialization."})
                        break
                if not args.keep_cache:
                    removed = remove_run_cache(cache, run_root)
                    removed += remove_run_cache(cache.with_suffix(".mlpackage"), run_root)
                    report["cache_cleanup"].append({"case": f"{backend}-{precision}-b{batch}-s{length}",
                                                    "logical_bytes_removed": removed})
                    report_path.write_text(json.dumps(report, indent=2, allow_nan=False))
    print(f"Report: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
