#!/usr/bin/env python3
"""Anagram Native Messaging: bounded UTF-8 JSON frames on stdin/stdout only.

The browser owns this process lifetime. Status/control messages stay responsive
while a bounded score worker performs inference; replies correlate by request id.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
from pathlib import Path
import re
import struct
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024 - 1024
MAX_PENDING_SCORES = 8
OPS = {"status", "health", "score", "runtime", "runtime.benchmark", "runtime.config",
       "runtime.cancel", "models.download", "models.pause", "models.delete",
       "engine.stop", "engine.resume", "engine.settings", "component.update", "component.uninstall"}
IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:-]{1,96}$")


class ProtocolError(Exception):
    pass


def _read_exact(stream, count, *, allow_eof=False):
    parts, remaining = [], count
    while remaining:
        part = stream.read(remaining)
        if not part:
            if allow_eof and remaining == count:
                return None
            raise ProtocolError("Truncated Native Messaging frame")
        parts.append(part)
        remaining -= len(part)
    return b"".join(parts)


def read_frame(stream):
    header = _read_exact(stream, 4, allow_eof=True)
    if header is None:
        return None
    size = struct.unpack("=I", header)[0]
    if not 0 < size <= MAX_REQUEST_BYTES:
        raise ProtocolError("Native request exceeds the allowed size")
    body = _read_exact(stream, size)
    try:
        value = json.loads(body.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        if value is None:
            raise ValueError("JSON null is not a request")
        return value
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise ProtocolError("Invalid UTF-8 JSON Native Messaging frame") from exc


def validate_request(request):
    if (not isinstance(request, dict) or set(request) != {"v", "id", "op", "payload"}
            or type(request["v"]) is not int or request["v"] != 1
            or not isinstance(request["id"], str) or not IDENTIFIER.fullmatch(request["id"])
            or not isinstance(request["op"], str) or request["op"] not in OPS
            or not isinstance(request["payload"], dict)):
        raise ProtocolError("Invalid native request envelope or operation")
    return request


def error_reply(request_id, code, message, status):
    from runtime_controller import error_text
    return {"v": 1, "id": request_id, "ok": False, "status": status,
            "error": {"code": code, "message": error_text(message)}}


class FrameWriter:
    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()
        self.failed = False

    def write(self, response):
        try:
            payload = json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError):
            payload = json.dumps(error_reply(response.get("id", "protocol-error"), "invalid_response",
                                             "The local component returned an invalid response", 500)).encode()
        if len(payload) > MAX_RESPONSE_BYTES:
            payload = json.dumps(error_reply(response.get("id", "protocol-error"), "response_too_large",
                                             "The native response exceeds the allowed size", 413)).encode()
        with self.lock:
            if self.failed:
                return
            try:
                self.stream.write(struct.pack("=I", len(payload)))
                self.stream.write(payload)
                self.stream.flush()
            except (BrokenPipeError, OSError):
                self.failed = True


def dispatch(component, request):
    from native_component import ComponentError
    from runtime_controller import RuntimeBusy, RuntimeUnavailable
    try:
        status, data = component.handle(request["op"], request["payload"])
        return {"v": 1, "id": request["id"], "ok": True, "status": status, "data": data}
    except ComponentError as exc:
        return error_reply(request["id"], exc.code, exc.message, exc.status)
    except RuntimeBusy as exc:
        return error_reply(request["id"], "busy", str(exc), 409)
    except RuntimeUnavailable as exc:
        return error_reply(request["id"], "not_ready", str(exc), 503)
    except ValueError as exc:
        return error_reply(request["id"], "invalid_request", str(exc), 422)
    except (Exception, SystemExit):
        logging.exception("Native operation failed: %s", request["op"])
        return error_reply(request["id"], "internal_error", "The local component operation failed", 500)


def run_host(reader, writer, component=None, startup_error=None):
    output = FrameWriter(writer)
    pending, pending_lock = set(), threading.Lock()
    capacity = threading.BoundedSemaphore(MAX_PENDING_SCORES)
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="anagram-native-score")
    if component is not None:
        component.start()

    def score_work(request):
        try:
            output.write(dispatch(component, request))
        finally:
            with pending_lock:
                pending.discard(request["id"])
            capacity.release()

    try:
        while not output.failed:
            try:
                request = read_frame(reader)
                if request is None:
                    break
            except ProtocolError as exc:
                output.write(error_reply("protocol-error", "invalid_request", str(exc), 400))
                break  # oversized/truncated framing cannot be resynchronized safely
            try:
                validate_request(request)
            except ProtocolError as exc:
                request_id = request.get("id") if isinstance(request, dict) else None
                if not isinstance(request_id, str) or not IDENTIFIER.fullmatch(request_id):
                    request_id = "protocol-error"
                output.write(error_reply(request_id, "invalid_request", str(exc), 422))
                continue
            if startup_error is not None:
                output.write(error_reply(request["id"], startup_error.code, startup_error.message, startup_error.status))
                continue
            with pending_lock:
                duplicate = request["id"] in pending
            if duplicate:
                output.write(error_reply(request["id"], "busy", "A request with this identifier is already pending", 409))
                continue
            if request["op"] == "score":
                if not capacity.acquire(blocking=False):
                    output.write(error_reply(request["id"], "busy", "Too many pending score requests", 409))
                    continue
                with pending_lock:
                    pending.add(request["id"])
                executor.submit(score_work, request)
            else:
                response = dispatch(component, request)
                output.write(response)
                # Windows maintenance may be scheduled until this process exits.
                # Send the truthful scheduled snapshot before releasing the port.
                # A completed POSIX update also retires on health/runtime access,
                # even when no Settings page remains open to poll its status.
                operation = response.get("data", {}).get("operation") if isinstance(response.get("data"), dict) else None
                if ((operation and operation.get("status") == "scheduled")
                        or response.get("error", {}).get("code") == "component_updated"):
                    break
    finally:
        if component is not None:
            component.close()
        executor.shutdown(wait=True, cancel_futures=True)


def protected_stdout():
    """Keep even native-library printf output away from the browser's frame pipe."""
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    protocol_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    return os.fdopen(protocol_fd, "wb", buffering=0)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    # Chrome supplies an origin; Firefox supplies its manifest path and add-on
    # ID. These values are metadata, never paths to open or commands to execute.
    # Browser-owned registration manifests authorize the caller.
    parser.add_argument("caller", nargs="?")
    parser.add_argument("addon_id", nargs="?")
    parser.add_argument("--parent-window", default=None)  # Chrome on Windows; no native UI is opened here
    return parser.parse_args(argv)


def configure_environment(home):
    """Set dependency paths in this process before lazy runtime imports.

    A launcher's earlier preparation subprocess cannot set its parent's env.
    These explicit library settings contain known caches; they are not an OS
    sandbox and leave the user's real HOME unchanged.
    """
    import tempfile
    from safe_files import is_link, regular_stat

    directories = {
        "HF_HOME": "hf", "HF_HUB_CACHE": "hf/hub", "HUGGINGFACE_HUB_CACHE": "hf/hub",
        "HF_DATASETS_CACHE": "hf/datasets", "HF_ASSETS_CACHE": "hf/assets",
        "TRANSFORMERS_CACHE": "hf/transformers", "XDG_CACHE_HOME": "cache",
        "TORCH_HOME": "cache/torch", "TORCHINDUCTOR_CACHE_DIR": "cache/torch/inductor",
        "TORCH_EXTENSIONS_DIR": "cache/torch/extensions",
        "TRITON_CACHE_DIR": "cache/triton", "CUDA_CACHE_PATH": "cache/cuda",
        "MPLCONFIGDIR": "cache/matplotlib", "NUMBA_CACHE_DIR": "cache/numba",
        "TMPDIR": "cache/tmp", "TMP": "cache/tmp", "TEMP": "cache/tmp",
    }
    for relative in dict.fromkeys(directories.values()):
        path = home
        for part in Path(relative).parts:
            path = path / part
            if is_link(path) or (path.exists() and not path.is_dir()):
                raise ValueError(f"Dependency cache must be an owned directory: {path}")
            path.mkdir(exist_ok=True, mode=0o700)
    token = home / "hf/token"
    if is_link(token) or (token.exists() and regular_stat(token).st_nlink != 1):
        raise ValueError("Dependency token path must not be linked")
    for name, relative in directories.items():
        os.environ[name] = str(home / relative)
    os.environ["HF_TOKEN_PATH"] = str(token)
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN"):
        os.environ.pop(name, None)
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE",
                 "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN"):
        os.environ[name] = "1"
    # tempfile may have cached the launcher's directory before configuration.
    tempfile.tempdir = None


def main():
    output = protected_stdout()
    args = parse_args()
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(name)s: %(message)s")
    from native_component import ComponentError, NativeComponent
    component, error = None, None
    try:
        component = NativeComponent(args.home)
        configure_environment(component.home)
        # Contain dependency diagnostics created relative to cwd before any
        # background runtime import (including ORT's fallback session file).
        os.chdir(component.home)
    except ComponentError as exc:
        error = exc
    except Exception as exc:
        if component is not None:
            component.close()
            component = None
        error = ComponentError("not_installed", str(exc), 503)
    try:
        run_host(sys.stdin.buffer, output, component, error)
    finally:
        output.close()


if __name__ == "__main__":
    main()
