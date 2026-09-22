"""Device capability probes and pinned, minimal model download plans.

Importing this module does not import an inference runtime. Discovery exercises
only a 2x2 matrix operation, not the classifier or network. A successful probe
establishes a working device/runtime; loading the classifier can still fail
for insufficient memory or unsupported operators.
"""
from __future__ import annotations

import base64
import copy
import importlib
import platform
import re

from runtime_controller import error_text

ARTIFACT_PATHS = {
    "torch-source": "model.safetensors",
    "onnx-fp32": "onnx/model.onnx",
    "onnx-fp16": "onnx/model_fp16.onnx",
    "onnx-int8": "onnx/model_int8.onnx",
}
# ONNX IR 8 / opset 13: float32 x[2,2] @ y[2,2] -> z[2,2].
# No weights and no dependency on the optional ONNX conversion package.
_PROBE_GRAPH = base64.b64decode(
    "CAgSB2FuYWdyYW06bAoRCgF4CgF5EgF6IgZNYXRNdWwSGGFuYWdyYW0tY2FwYWJpbGl0eS1wcm9iZVoT"
    "CgF4Eg4KDAgBEggKAggCCgIIAloTCgF5Eg4KDAgBEggKAggCCgIIAmITCgF6Eg4KDAgBEggKAggCCgIIAkIECgAQDQ=="
)


def _status(available=False, error=None):
    return {"available": available, "error": error}


def _torch_probe(torch, device):
    value = torch.ones((2, 2), dtype=torch.float32, device=device)
    result = value @ value
    if device == "mps":
        torch.mps.synchronize()
    elif device.startswith("cuda:"):
        torch.cuda.synchronize(device)
    if result.sum().item() != 8.0:
        raise RuntimeError("Device capability probe returned an incorrect result")


def _ort_probe(ort, provider, index=0):
    import numpy as np

    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    if provider != "CPUExecutionProvider":
        options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
    providers = [(provider, {"device_id": index})] if provider == "CUDAExecutionProvider" else [provider]
    session = ort.InferenceSession(_PROBE_GRAPH, sess_options=options, providers=providers)
    try:
        actual = session.get_providers()
        if not actual or actual[0] != provider:
            raise RuntimeError(f"{provider} initialization fell back to another provider")
        session.disable_fallback()
        value = np.ones((2, 2), dtype=np.float32)
        output = session.run(["z"], {"x": value, "y": value})
        if len(output) != 1 or not np.array_equal(output[0], np.full((2, 2), 2.0, dtype=np.float32)):
            raise RuntimeError("ONNX capability probe returned an incorrect result")
    finally:
        del session


def discover_hardware():
    """Return serializable capability/error details without requiring model files."""
    torch_info = {"available": False, "version": None, "error": None,
                  "cpu": _status(error="PyTorch is unavailable"),
                  "mps": _status(error="MPS is unavailable"), "cuda": []}
    ort_info = {"available": False, "version": None, "error": None, "providers": [],
                "cpu": _status(error="CPUExecutionProvider is unavailable"), "cuda": []}
    result = {"schema_version": 1, "system": platform.system(), "machine": platform.machine(),
              "torch": torch_info, "onnx": ort_info}
    try:
        torch = importlib.import_module("torch")
        torch_info.update(available=True, version=str(torch.__version__))
        try:
            _torch_probe(torch, "cpu")
            torch_info["cpu"] = _status(True)
        except Exception as exc:
            torch_info["cpu"] = _status(error=error_text(exc))
        try:
            if torch.backends.mps.is_available():
                _torch_probe(torch, "mps")
                torch_info["mps"] = _status(True)
        except Exception as exc:
            torch_info["mps"] = _status(error=error_text(exc))
        try:
            if torch.cuda.is_available():
                kind = "rocm" if getattr(torch.version, "hip", None) else "cuda"
                for index in range(torch.cuda.device_count()):
                    device = {"id": f"cuda:{index}", "index": index,
                              "label": f"GPU {index} ({'ROCm' if kind == 'rocm' else 'CUDA'})",
                              "kind": kind, **_status()}
                    try:
                        device["label"] = f"{torch.cuda.get_device_name(index)} ({'ROCm' if kind == 'rocm' else 'CUDA'})"
                        _torch_probe(torch, device["id"])
                        device.update(_status(True))
                    except Exception as exc:
                        device.update(_status(error=error_text(exc)))
                    torch_info["cuda"].append(device)
        except Exception as exc:
            torch_info["cuda_error"] = error_text(exc)
    except Exception as exc:
        message = error_text(exc)
        torch_info.update(error=message)
        torch_info["cpu"] = _status(error=message)
        torch_info["mps"] = _status(error=message)

    try:
        ort = importlib.import_module("onnxruntime")
        if hasattr(ort, "disable_telemetry_events"):
            ort.disable_telemetry_events()
        ort_info.update(available=True, version=str(ort.__version__), providers=list(ort.get_available_providers()))
        if "CPUExecutionProvider" in ort_info["providers"]:
            try:
                _ort_probe(ort, "CPUExecutionProvider")
                ort_info["cpu"] = _status(True)
            except Exception as exc:
                ort_info["cpu"] = _status(error=error_text(exc))
        if "CUDAExecutionProvider" in ort_info["providers"]:
            # CPU-only Torch (or missing Torch) cannot enumerate CUDA devices.
            # Probe ORT device 0 itself rather than assuming that no GPU exists.
            known = [d for d in torch_info["cuda"] if d["kind"] == "cuda"]
            for known_device in known or [{"id": "cuda:0", "index": 0, "label": "GPU 0 (ONNX Runtime CUDA)", "kind": "cuda"}]:
                device = {key: known_device[key] for key in ("id", "index", "label", "kind")}
                try:
                    _ort_probe(ort, "CUDAExecutionProvider", device["index"])
                    device.update(_status(True))
                except Exception as exc:
                    device.update(_status(error=error_text(exc)))
                ort_info["cuda"].append(device)
    except Exception as exc:
        message = error_text(exc)
        ort_info.update(error=message)
        ort_info["cpu"] = _status(error=message)
    return result


def candidate_catalog(hardware):
    """Supported candidate descriptions, independently of installed artifacts."""
    result = []
    cpu_label = f"CPU ({hardware.get('machine') or 'unknown architecture'})"

    def add(runtime, device, label, precision, status):
        runtime_status = hardware.get(runtime, {})
        available = runtime_status.get("available") is True and status.get("available") is True
        result.append({"id": f"{runtime}:{device}:{precision}",
                       "label": f"{label} · {'PyTorch' if runtime == 'torch' else 'ONNX Runtime'} · {precision.upper()}",
                       "device_label": label, "device": device, "runtime": runtime, "precision": precision,
                       "experimental": precision == "int8", "available": available,
                       "reason": None if available else error_text(status.get("error") or runtime_status.get("error") or "Device/runtime is unavailable")})

    for runtime in ("torch", "onnx"):
        info = hardware.get(runtime, {})
        cpu = info.get("cpu", {})
        add(runtime, "cpu", cpu_label, "fp32", cpu)
        if runtime == "onnx":
            add(runtime, "cpu", cpu_label, "int8", cpu)
        if runtime == "torch" and info.get("mps", {}).get("available") is True:
            for precision in ("fp32", "fp16"):
                add(runtime, "mps", "Apple GPU (MPS)", precision, info["mps"])
        for device in info.get("cuda", []):
            if not re.fullmatch(r"cuda:(0|[1-9][0-9]*)", device.get("id", "")):
                raise ValueError("Invalid device identity in hardware discovery")
            for precision in ("fp32", "fp16"):
                add(runtime, device["id"], device["label"], precision, device)
    return result


def candidate_spec(candidate_id, hardware):
    """Preserve a planned GPU as unavailable when a fresh probe loses that device."""
    for candidate in candidate_catalog(hardware):
        if candidate["id"] == candidate_id:
            return candidate
    match = re.fullmatch(r"(torch|onnx):(mps|cuda:(?:0|[1-9][0-9]*)):(fp32|fp16)", candidate_id)
    if not match or (match[1] == "onnx" and match[2] == "mps"):
        raise ValueError("Unsupported runtime candidate in model plan")
    runtime, device, precision = match.groups()
    label = "Apple GPU (MPS)" if device == "mps" else f"GPU {device.split(':')[1]}"
    info = hardware.get(runtime, {})
    error = info.get("mps", {}).get("error") if device == "mps" else info.get("cuda_error")
    return {"id": candidate_id, "label": f"{label} · {'PyTorch' if runtime == 'torch' else 'ONNX Runtime'} · {precision.upper()}",
            "device_label": label, "device": device, "runtime": runtime, "precision": precision,
            "experimental": False, "available": False,
            "reason": error_text(error or info.get("error") or "Planned device is no longer available; rescan the model plan")}


def build_plan(pin, hardware, profile="recommended"):
    """Select pinned files and compatible candidates; never inspect local weights."""
    if profile not in {"recommended", "expanded"}:
        raise ValueError("Model profile must be recommended or expanded")
    available = [c for c in candidate_catalog(hardware) if c["available"]]
    if profile == "expanded":
        chosen = available
    elif any(c["runtime"] == "torch" and c["device"] != "cpu" for c in available):
        chosen = [c for c in available if c["runtime"] == "torch"]
    elif any(c["runtime"] == "onnx" and c["device"] != "cpu" for c in available):
        chosen = [c for c in available if c["runtime"] == "onnx" and c["precision"] == "fp32"]
    elif any(c["id"] == "onnx:cpu:fp32" for c in available):
        chosen = [c for c in available if c["id"] == "onnx:cpu:fp32"]
    else:
        chosen = [c for c in available if c["id"] == "torch:cpu:fp32"]
    if not chosen:
        raise ValueError("No working local inference runtime was found")
    artifacts = {"torch-source" if c["runtime"] == "torch" else f"onnx-{c['precision']}" for c in chosen}
    selected_weights = {ARTIFACT_PATHS[name] for name in artifacts}
    entries = pin.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Model plan requires pinned file entries")
    seen, files = set(), []
    for entry in entries:
        if (not isinstance(entry, dict) or not isinstance(entry.get("path"), str)
                or type(entry.get("size_bytes")) is not int or entry["size_bytes"] < 0
                or entry["path"] in seen):
            raise ValueError("Invalid or duplicate pinned model file")
        name = entry["path"]
        seen.add(name)
        if name not in ARTIFACT_PATHS.values() or name in selected_weights:
            files.append(copy.deepcopy(entry))
    if not selected_weights <= seen:
        raise ValueError("Pinned manifest is missing a selected model artifact")
    return {"schema_version": 1, "profile": profile,
            "artifact_ids": [name for name in ARTIFACT_PATHS if name in artifacts],
            "candidate_ids": [c["id"] for c in chosen],
            "devices": list(dict.fromkeys(c["device_label"] for c in chosen)),
            "selected_paths": [entry["path"] for entry in files], "files": files,
            "total_bytes": sum(entry["size_bytes"] for entry in files)}
