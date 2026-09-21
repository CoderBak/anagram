"""Disposable benchmark processes; no browser endpoint or user-supplied command.

RSS belongs only to this candidate's process. Baseline is sampled before model
library imports, loaded RSS after loading, and peak RSS during measurement at
50 ms intervals. MPS driver allocation includes cache and overlaps unified RAM;
it must not be added to RSS. Warm OS file caches are not flushed between workers.
"""
from __future__ import annotations

from dataclasses import asdict
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runtime_controller import Candidate, Cancelled, RuntimeController, error_text, process_rss

MAX_MESSAGE = 65536


class SubprocessBenchmark:
    def __init__(self, model_dir, lid_path, working_dir, *, max_length=512, batch_size=32,
                 timeout_s=180, command=None):
        self.spec = {"model_dir": str(Path(model_dir).resolve()), "lid_path": str(Path(lid_path).resolve()),
                     "max_length": max_length, "batch_size": batch_size}
        self.working_dir = Path(working_dir)
        self.timeout_s = timeout_s
        # Injection is Python-only for lightweight process tests, never a native payload.
        self.command = command or [sys.executable, "-I", "-u", str(Path(__file__).resolve())]

    def __call__(self, candidate, remaining, workloads, max_runs, cancel, receive):
        self.working_dir.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        spec = {**self.spec, "candidate": asdict(candidate), "remaining_s": remaining,
                "workloads": workloads, "max_runs": max_runs, "launched_at": started}
        process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=sys.stderr, cwd=self.working_dir,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        messages = queue.Queue(maxsize=256)
        stopped = threading.Event()

        def enqueue(message):
            while not stopped.is_set():
                try:
                    messages.put(message, timeout=0.05)
                    return
                except queue.Full:
                    pass

        def read():
            try:
                while True:
                    line = process.stdout.readline(MAX_MESSAGE + 1)
                    if not line:
                        enqueue(None)
                        return
                    if len(line) > MAX_MESSAGE or not line.endswith(b"\n"):
                        raise ValueError("Invalid benchmark worker message size")
                    enqueue(json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite metric"))))
            except (OSError, ValueError) as exc:
                enqueue(exc)

        reader = threading.Thread(target=read, name="anagram-benchmark-pipe", daemon=True)
        reader.start()
        try:
            process.stdin.write(json.dumps(spec, allow_nan=False).encode() + b"\n")
            process.stdin.flush()
            while True:
                if cancel.is_set():
                    raise Cancelled()
                if time.perf_counter() - started > self.timeout_s:
                    raise TimeoutError(f"Benchmark candidate exceeded its {self.timeout_s:g}s worker timeout")
                try:
                    message = messages.get(timeout=0.05)
                except queue.Empty:
                    continue
                if message is None:
                    if process.wait(timeout=2) != 0:
                        raise RuntimeError("Benchmark worker exited unexpectedly")
                    return
                if isinstance(message, Exception):
                    raise message
                if not isinstance(message, dict) or message.get("type") not in {"phase", "measurement", "row", "error"}:
                    raise ValueError("Invalid benchmark worker response")
                if message["type"] == "error":
                    raise RuntimeError(message.get("error", "Benchmark worker failed"))
                if message["type"] == "phase" and message.get("phase") not in {"initialization", "hashing", "loading", "warmup", "measurement"}:
                    raise ValueError("Invalid benchmark worker phase")
                if message["type"] == "measurement":
                    seconds = message.get("seconds")
                    if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds < 0:
                        raise ValueError("Invalid benchmark worker timing")
                receive(message)
        finally:
            stopped.set()
            # Popen owns this exact child; never signal an inferred PID, a process
            # group, or the selected engine running in the host.
            if process.poll() is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    # Do not begin another candidate or release component
                    # ownership until the child actually exits, even if the OS
                    # briefly defers a kill while servicing uninterruptible I/O.
                    process.wait()
            try:
                process.stdin.close()
            except OSError:
                pass
            reader.join(timeout=1)
            process.stdout.close()


def run_candidate(spec, emit):
    baseline = process_rss()
    candidate = Candidate(**spec["candidate"])
    emit({"type": "phase", "phase": "initialization"})
    import engine as api  # sets offline policy before Transformers is imported
    try:
        import torch
    except ImportError:
        if candidate.runtime == "torch":
            raise
        torch = None
    import emoji  # noqa: F401 -- include import cost in initialization, not load
    from transformers import AutoTokenizer  # noqa: F401
    if candidate.runtime == "torch":
        from transformers import AutoModelForSequenceClassification  # noqa: F401
    if candidate.runtime == "onnx":
        import onnxruntime as ort
        if hasattr(ort, "disable_telemetry_events"):
            ort.disable_telemetry_events()
    from runtime_adapters import execution_environment, load_candidate
    gate = api.LanguageId(Path(spec["lid_path"]))
    environment = execution_environment(torch)
    initialization_ms = (time.perf_counter() - spec["launched_at"]) * 1000
    engine, timings = load_candidate(Path(spec["model_dir"]), candidate, spec["max_length"],
                                    spec["batch_size"], gate, api, environment,
                                    phase=lambda phase: emit({"type": "phase", "phase": phase}))
    loaded = process_rss()
    measure = RuntimeController(Path("unused-runtime.json"), None, None, max_runs=spec["max_runs"])
    measure.benchmark["total"] = spec["workloads"]
    original_measurement = measure._measurement
    def measurement(seconds):
        original_measurement(seconds)
        emit({"type": "measurement", "seconds": seconds})
    measure._measurement = measurement
    measure._phase = lambda phase: emit({"type": "phase", "phase": phase})
    try:
        for batch in (1, 8):
            try:
                row = measure._measure(engine, candidate, batch, timings["load_ms"], spec["remaining_s"])
            except Exception as exc:
                row = measure._error_row(candidate, batch, exc, timings["load_ms"])
            row.update(timings, initialization_ms=round(initialization_ms, 2),
                       baseline_rss_bytes=baseline, loaded_rss_bytes=loaded,
                       rss_scope="isolated_process")
            emit({"type": "row", "row": row})
            measure.benchmark["completed"] += 1
    finally:
        engine.close()


def main():
    # Even C-library printf must stay off the private JSON result pipe.
    result_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    with os.fdopen(result_fd, "wb", buffering=0) as output:
        def emit(value):
            data = json.dumps(value, allow_nan=False).encode() + b"\n"
            if len(data) > MAX_MESSAGE:
                raise ValueError("Benchmark worker result is too large")
            output.write(data)
        try:
            line = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
            if len(line) > MAX_MESSAGE:
                raise ValueError("Benchmark worker request is too large")
            spec = json.loads(line)
            # A browser killing the native parent closes this private pipe. Do
            # not leave a GB-sized orphan worker after the owner's process exits.
            def parent_watch():
                while os.read(sys.stdin.fileno(), 4096):
                    pass
                os._exit(1)
            threading.Thread(target=parent_watch, name="anagram-benchmark-owner", daemon=True).start()
            run_candidate(spec, emit)
        except BaseException as exc:
            emit({"type": "error", "error": error_text(exc)})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
