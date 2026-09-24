"""Background runtime lifecycle: automatic selection, loading and optional comparisons.

After model files are prepared the controller picks the best available FP32
configuration itself, loads it, warms it up, persists the choice and becomes
ready. A saved choice is reused on every later start while its candidate is
still available. Comparisons only run on explicit request, in a disposable
process per candidate, and never change the selection.

Native status and control requests never wait for a model load or forward pass.
Measurements cover text cleaning, tokenization, forward and postprocessing of
fixed ~120-word English samples, not language identification or browser transport.
"""
from __future__ import annotations

import copy
import json
import math
import statistics
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from safe_files import atomic_json, read_json


@dataclass(frozen=True)
class Candidate:
    id: str
    label: str
    device: str
    runtime: str
    precision: str
    experimental: bool = False
    available: bool = True
    reason: str | None = None


class RuntimeBusy(Exception):
    pass


class RuntimeUnavailable(Exception):
    pass


class Cancelled(Exception):
    pass


def error_text(error) -> str:
    """Keep provider failures readable by the control client's bounded schema."""
    # The browser counts UTF-16 code units. Replace malformed surrogates and
    # avoid splitting a supplementary character at the 2000-unit boundary.
    value = str(error) or type(error).__name__
    return value.encode("utf-16-le", errors="replace")[:4000].decode("utf-16-le", errors="ignore")


def preference_rank(candidate: Candidate):
    """Automatic selection order; lower sorts first, None is never auto-selected.

    Only FP32 is chosen automatically. FP16 and INT8 remain explicit choices.
    """
    if candidate.precision != "fp32":
        return None
    device = candidate.device
    index = int(device.split(":")[1]) if device.startswith("cuda:") and device[5:].isdigit() else 0
    if candidate.runtime == "torch" and device.startswith("cuda:"):
        return (0, index)
    if candidate.runtime == "torch" and device == "mps":
        return (1, 0)
    if candidate.runtime == "onnx" and device.startswith("cuda:"):
        return (2, index)
    if candidate.runtime == "onnx" and device == "cpu":
        return (3, 0)
    if candidate.runtime == "torch" and device == "cpu":
        return (4, 0)
    return None


def auto_candidate(candidates) -> Candidate | None:
    """The first available candidate in preference order, or None."""
    ranked = [(preference_rank(c), position, c) for position, c in enumerate(candidates)
              if c.available and preference_rank(c) is not None]
    return min(ranked)[2] if ranked else None


# Fixed English samples for warmup and measurements; they do not measure accuracy.
SENTENCES = (
    "I got the call around six, right when the rice was starting to catch on the bottom of the pan.",
    "My brother never rings on weeknights, so I turned the burner off and sat on the floor to listen.",
    "He talked for twenty minutes about a dog he was thinking of adopting.",
    "Afterwards the rice was ruined and I ate it anyway, standing at the counter with the window open.",
    "The flat we rented that spring had radiators that clanked all night and a landlord who promised a plumber.",
    "From the kitchen you could see a slice of the canal if you leaned out far enough.",
    "Some mornings a heron stood there like it owned the place, and we stayed four years partly because of it.",
    "In today's rapidly evolving digital landscape, effective communication has become more crucial than ever.",
    "By leveraging cutting-edge technologies, organizations can unlock unprecedented opportunities for growth.",
    "This comprehensive approach empowers teams to navigate complex challenges with confidence and agility.",
    "Building a consistent writing habit is one of the most valuable investments you can make.",
    "Start by setting aside a dedicated time each day, even if it is just fifteen minutes.",
    "Remember that progress matters more than perfection, so embrace imperfect drafts along the way.",
    "The committee met twice that autumn and agreed on almost nothing except the date of the next meeting.",
    "Nobody had checked whether the old bridge could take the weight, and by then it was too late to ask.",
)


def paragraph(words: int = 120, seed: int = 0) -> str:
    out, count = [], 0
    while count < words:
        sentence = SENTENCES[seed % len(SENTENCES)]
        out.append(sentence)
        count += len(sentence.split())
        seed += 1
    return " ".join(out)


def process_rss() -> int | None:
    try:
        import psutil
    except ImportError:
        return None
    try:
        return psutil.Process().memory_info().rss
    except (psutil.Error, OSError):
        return None


class MemorySampler:
    """Maximum observed process RSS; sampled, not an allocator's exact peak."""
    def __init__(self, read=process_rss):
        self.read = read
        self.peak = None
        self.stop = threading.Event()

    def sample(self):
        value = self.read()
        if value is not None:
            self.peak = max(self.peak or 0, value)

    def __enter__(self):
        self.sample()
        def poll():
            while not self.stop.wait(0.05):
                self.sample()
        self.thread = threading.Thread(target=poll, name="anagram-rss", daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=0.2)
        self.sample()


def empty_benchmark(budget=30):
    return {"report_version": 2, "environment": None, "context": None,
            "status": "idle", "budget_s": budget, "elapsed_s": 0.0,
            "measurement_s": 0.0, "phase": "idle", "current_id": None,
            "completed": 0, "total": 0, "results": []}


class RuntimeController:
    """States: loading, benchmarking, ready, idle, error.

    ``idle`` means no engine is resident; the next score request reloads the
    saved selection (or auto-selects when there is none). ``error`` carries text
    in ``error`` and recovers through an explicit selection or comparison.
    """
    def __init__(self, config_path: Path, discover, factory, *, clock=time.perf_counter,
                 memory=process_rss, max_runs: int = 20, benchmark_runner=None,
                 idle_unload_s=0):
        self.config_path = Path(config_path)
        self.discover = discover  # -> (list[Candidate], provenance context string[, environment])
        self.factory = factory    # -> a loaded engine; no warmup in the factory
        self.clock, self.memory, self.max_runs = clock, memory, max_runs
        self.benchmark_runner = benchmark_runner  # (candidate, remaining, workloads, max_runs, cancel, receive)
        self.environment = None
        self.idle_unload_s = idle_unload_s
        self.last_activity = None
        self.idle_stop = threading.Event()
        self.idle_thread = None
        self.lock = threading.RLock()
        self.ready_condition = threading.Condition(self.lock)
        self.idle_wake_thread = None
        self.cancel_event = threading.Event()
        self.thread = None
        self.started = False
        self.closed = False
        self.leases = 0
        self.engine = None
        self.context = None
        self.state = "loading"
        self.candidates = []
        self.selected_id = None
        self.selected_version = None
        self.active_id = None
        self.recommended_id = None
        self.fastest_id = None
        self.error = None
        self.benchmark = empty_benchmark()
        self.benchmark_started = None

    def snapshot(self) -> dict:
        with self.lock:
            benchmark = copy.deepcopy(self.benchmark)
            if benchmark["status"] == "running" and self.benchmark_started is not None:
                benchmark["elapsed_s"] = round(self.clock() - self.benchmark_started, 3)
            # A report measured under other artifacts/threads/drivers is shown, but labelled.
            benchmark["stale"] = bool(benchmark["results"]) and benchmark["context"] != self.context
            return {"schema_version": 1, "state": self.state,
                    "active_id": self.active_id, "selected_id": self.selected_id,
                    "recommended_id": self.recommended_id,
                    "fastest_id": self.fastest_id,
                    "candidates": [asdict(candidate) for candidate in self.candidates],
                    "benchmark": benchmark, "error": self.error}

    def start(self):
        with self.lock:
            if self.started or self.closed:
                return
            self.started = True
            self._launch(self._bootstrap)
            self.idle_thread = threading.Thread(target=self._idle_watch, name="anagram-idle", daemon=True)
            self.idle_thread.start()

    def set_idle_unload(self, seconds):
        if type(seconds) is not int or (seconds != 0 and not 60 <= seconds <= 86400):
            raise ValueError("idle_unload_s must be 0 or an integer from 60 to 86400")
        with self.lock:
            self.idle_unload_s = seconds

    def _idle_watch(self):
        while not self.idle_stop.wait(1):
            self.unload_if_idle()

    def unload_if_idle(self):
        with self.lock:
            if (self.closed or not self.idle_unload_s or self.state != "ready" or self.leases
                    or self.last_activity is None or self.clock() - self.last_activity < self.idle_unload_s
                    or (self.thread is not None and self.thread.is_alive())):
                return False
            engine, self.engine = self.engine, None
            self.active_id = None
            self.state = "loading"
            def unload():
                self._close_engine(engine)
                with self.lock:
                    self.state = "idle"
            self._launch(unload)
            return True

    def wake(self):
        with self.lock:
            if self.state != "idle":
                return False
            # Idle is only published as a job's last step, so that job's thread
            # may still be exiting; it holds no engine and no lease.
            if self.closed:
                raise RuntimeBusy("runtime is busy; retry after the current operation finishes")
            candidate, expected = self._find(self.selected_id), self.selected_version
            if candidate is None or not candidate.available:
                candidate, expected = auto_candidate(self.candidates), None
            if candidate is None:
                raise RuntimeUnavailable(self._unavailable_text())
            self.state = "loading"
            def resume():
                if not self._activate(candidate, expected_version=expected):
                    raise RuntimeUnavailable("Model files changed while the engine was unloaded; retry or choose a configuration")
            self._launch(resume)
            self.idle_wake_thread = self.thread
            return True

    def wake_and_wait(self, timeout=25):
        """Only score workers wait; status/health remain passive and responsive."""
        with self.ready_condition:
            self.wake()
            target = self.idle_wake_thread
            if self.state != "loading" or target is None or self.thread is not target:
                return
            self.ready_condition.wait_for(
                lambda: self.closed or self.cancel_event.is_set() or self.thread is not target or self.state != "loading",
                timeout=timeout)
            if (self.closed or self.cancel_event.is_set() or self.thread is not target or self.state != "ready"):
                raise RuntimeUnavailable("The idle engine is still loading or was stopped; retry when it is ready")

    def _launch(self, work):
        self.cancel_event.clear()
        self.thread = threading.Thread(target=self._run, args=(work,),
                                       name="anagram-runtime", daemon=True)
        self.thread.start()
        self.ready_condition.notify_all()

    def _run(self, work):
        try:
            work()
        except Cancelled:
            with self.lock:
                # No engine is resident; the next score reloads the saved or automatic choice.
                self.state = "idle"
                if self.benchmark["status"] == "running":
                    self._finish_benchmark("cancelled")
                self.benchmark["phase"] = "cancelled"
                self.benchmark["current_id"] = None
        except (Exception, SystemExit) as exc:
            with self.lock:
                self.state = "error"
                self.error = error_text(exc)
                if self.benchmark["status"] == "running":
                    self._finish_benchmark("failed")
                self.benchmark["phase"] = "error"
                self.benchmark["current_id"] = None
        finally:
            with self.ready_condition:
                self.ready_condition.notify_all()

    def _check_cancel(self):
        if self.cancel_event.is_set() or self.closed:
            raise Cancelled()

    def _read_saved(self):
        try:
            saved = read_json(self.config_path)
            if (not isinstance(saved, dict) or type(saved.get("schema_version")) is not int
                    or saved["schema_version"] != 1):
                raise ValueError("unsupported runtime configuration")
            return saved
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            # A damaged file does not prevent automatic selection from replacing it.
            with self.lock:
                self.error = error_text(f"Saved runtime configuration could not be read: {exc}")
            return None

    def _unavailable_text(self):
        reasons = [c.reason for c in self.candidates if not c.available and c.reason]
        detail = f" ({reasons[0]})" if reasons else ""
        return "No available runtime" + detail + "; download the model files and use a supported runtime"

    def _bootstrap(self):
        self._refresh()
        self._check_cancel()
        saved = self._read_saved() or {}
        report = saved.get("benchmark")
        if self._valid_report(report):
            # Reports are display only; an invalid one is simply not shown.
            with self.lock:
                self.benchmark = report
                self._recommend()
        candidate = self._find(saved.get("selected_id"))
        if candidate is not None and candidate.available:
            # The saved choice survives context and provenance changes; the
            # loaded engine's version is recorded again for the idle-wake check.
            with self.lock:
                self.selected_id = candidate.id
                self.selected_version = saved.get("selected_version") if isinstance(saved.get("selected_version"), str) else None
            self._activate(candidate)
            return
        self._auto_select()

    def _auto_select(self):
        candidate = auto_candidate(self.candidates)
        if candidate is None:
            raise ValueError(self._unavailable_text())
        with self.lock:
            self.selected_id = None
            self.selected_version = None
        self._activate(candidate)

    def _valid_report(self, report):
        """Validate every persisted field before it can enter a runtime snapshot.

        Numeric checks exclude booleans and non-finite JSON extensions. Candidate
        references and workload counts are validated against this discovery, not
        merely against strings saved by a previous process.
        """
        def number(value):
            try:
                return type(value) in (int, float) and math.isfinite(value) and value >= 0
            except OverflowError:
                return False

        def text(value):
            try:
                return isinstance(value, str) and len(value.encode("utf-16-le")) <= 4000
            except UnicodeEncodeError:
                return False

        if not isinstance(report, dict) or set(report) != set(empty_benchmark()):
            return False
        if (type(report["report_version"]) is not int or report["report_version"] != 2
                or report["status"] not in ("completed", "cancelled", "failed", "idle")
                or type(report["budget_s"]) is not int or not 10 <= report["budget_s"] <= 30
                or not number(report["elapsed_s"]) or not number(report["measurement_s"])
                or not text(report["phase"])
                or (report["context"] is not None and not (isinstance(report["context"], str) and len(report["context"]) <= 128))):
            return False
        if report["environment"] is not None:
            if not isinstance(report["environment"], dict):
                return False
            try:
                if len(json.dumps(report["environment"], allow_nan=False)) > 16000:
                    return False
            except (TypeError, ValueError, RecursionError):
                return False
        known_ids = {candidate.id for candidate in self.candidates}
        current = report["current_id"]
        if current is not None and (not isinstance(current, str) or current not in known_ids):
            return False
        results, completed, total = report["results"], report["completed"], report["total"]
        if (not isinstance(results, list) or len(results) > 128
                or type(completed) is not int or type(total) is not int
                or not 0 <= completed <= total <= min(128, len(known_ids) * 2)
                or completed != len(results)):
            return False
        if report["status"] == "completed" and completed != total:
            return False
        metrics = {"load_ms", "warmup_ms", "latency_ms", "throughput_per_s", "peak_rss_bytes",
                   "accelerator_bytes", "tokens_per_text", "duration_s", "initialization_ms", "hash_ms",
                   "baseline_rss_bytes", "loaded_rss_bytes", "rss_sample_interval_ms"}
        required = {"candidate_id", "status", "load_ms", "warmup_ms", "latency_ms",
                    "throughput_per_s", "peak_rss_bytes", "samples", "batch_size", "duration_s",
                    "initialization_ms", "hash_ms", "baseline_rss_bytes", "loaded_rss_bytes",
                    "rss_scope", "rss_sample_interval_ms", "accelerator_kind", "measurement_quality"}
        allowed = required | metrics | {"error"}
        workloads = set()
        for row in results:
            if not isinstance(row, dict) or not required <= set(row) <= allowed:
                return False
            candidate_id = row["candidate_id"]
            if (not isinstance(candidate_id, str) or candidate_id not in known_ids
                    or row["status"] not in ("ok", "error")
                    or type(row["batch_size"]) is not int or row["batch_size"] not in (1, 8)
                    or type(row["samples"]) is not int or not 0 <= row["samples"] <= 1_000_000
                    or row["rss_scope"] != "isolated_process"
                    or row["rss_sample_interval_ms"] != 50
                    or row["accelerator_kind"] not in (None, "mps_driver_including_cache", "cuda_allocator_peak")
                    or row["measurement_quality"] != ("sufficient" if row["samples"] >= 3 else "insufficient")
                    or (row.get("error") is not None and not text(row["error"]))):
                return False
            if any(value is not None and not number(value)
                   for key, value in row.items() if key in metrics):
                return False
            if row["status"] == "ok" and (
                    any(row[key] is None for key in ("load_ms", "warmup_ms", "latency_ms", "throughput_per_s", "duration_s"))
                    or row["latency_ms"] <= 0 or row["throughput_per_s"] <= 0
                    or row["duration_s"] <= 0 or row["samples"] == 0):
                return False
            workload = (candidate_id, row["batch_size"])
            if workload in workloads:
                return False
            workloads.add(workload)
        return True

    def _refresh(self):
        with self.lock:
            self.benchmark["phase"] = "discovery"
        discovery = self.discover()
        candidates, context = discovery[:2]
        if len({c.id for c in candidates}) != len(candidates):
            raise ValueError("duplicate runtime candidate identifiers")
        with self.lock:
            self.candidates = candidates
            self.context = context
            self.environment = discovery[2] if len(discovery) > 2 else None
            self._recommend()

    def _find(self, candidate_id):
        return next((c for c in self.candidates if c.id == candidate_id), None)

    def _ensure_idle(self):
        if (self.closed or self.state in {"loading", "benchmarking"} or self.leases
                or (self.thread is not None and self.thread.is_alive())):
            raise RuntimeBusy("runtime is busy; retry after the current operation finishes")

    def request_benchmark(self, budget_s=30):
        if type(budget_s) is not int or not 10 <= budget_s <= 30:
            raise ValueError("budget_s must be an integer between 10 and 30")
        with self.lock:
            self._ensure_idle()
            self.state = "benchmarking"
            self.error = None
            old_engine, self.engine = self.engine, None
            self.active_id = None
            self.benchmark = empty_benchmark(budget_s)
            self.benchmark["status"] = "running"
            self.benchmark_started = self.clock()
            def work():
                self._close_engine(old_engine)
                self._benchmark_work(budget_s)
            self._launch(work)
            return self.snapshot()

    def request_selection(self, candidate_id):
        with self.lock:
            self._ensure_idle()
            candidate = self._find(candidate_id)
            if candidate is None or not candidate.available:
                raise ValueError("choose an available runtime candidate in Settings")
            self.state = "loading"
            self.error = None
            self.benchmark["phase"] = "loading"
            self.benchmark["current_id"] = candidate.id
            old_engine, self.engine = self.engine, None
            self.active_id = None
            def work():
                self._close_engine(old_engine)
                self._refresh()
                current = self._find(candidate.id)
                if current is None or not current.available:
                    raise ValueError("The selected runtime is no longer available: "
                                     + (current.reason if current and current.reason else "device or model files changed"))
                self._activate(current)
            self._launch(work)
            return self.snapshot()

    def cancel(self):
        with self.lock:
            if self.state not in {"loading", "benchmarking"}:
                raise RuntimeBusy("there is no running runtime operation to cancel")
            self.cancel_event.set()
            self.ready_condition.notify_all()
            return self.snapshot()

    @contextmanager
    def use_engine(self, *, activity=True):
        with self.lock:
            if (self.closed or self.state != "ready" or self.engine is None
                    or self.active_id != self.selected_id):
                raise RuntimeUnavailable("runtime is not ready; open Anagram Settings to finish setup")
            engine = self.engine
            self.leases += 1
            if activity:
                self.last_activity = self.clock()
        try:
            yield engine
        finally:
            with self.lock:
                self.leases -= 1
                if activity:
                    self.last_activity = self.clock()
                retired = None
                if self.closed and self.leases == 0:
                    retired, self.engine = self.engine, None
                    self.active_id = None
            self._close_engine(retired)

    def _persist(self, selected_version=None):
        with self.lock:
            saved = {"schema_version": 1, "context": self.context,
                     "selected_id": self.selected_id,
                     "selected_version": selected_version if selected_version is not None else self.selected_version,
                     "benchmark": copy.deepcopy(self.benchmark)}
        atomic_json(self.config_path, saved)

    @staticmethod
    def _close_engine(engine):
        if engine is not None:
            close = getattr(engine, "close", None)
            if close:
                close()

    def _activate(self, candidate, expected_version=None):
        with self.lock:
            self.state = "loading"
            self.benchmark["phase"] = "loading"
            self.benchmark["current_id"] = candidate.id
        engine = None
        try:
            self._check_cancel()
            engine = self.factory(candidate)
            self._check_cancel()
            if expected_version is not None and engine.version != expected_version:
                with self.lock:
                    self.error = "Model or runtime provenance changed while the engine was unloaded; retry or choose a configuration."
                return False
            with self.lock:
                self.benchmark["phase"] = "warmup"
            engine.score([paragraph()])
            engine.synchronize()
            self._check_cancel()
            # The commit is one short critical section: cancellation accepted
            # before it cannot persist a new choice; cancellation arriving after
            # it sees a ready runtime and is refused as no operation is running.
            with self.lock:
                self._check_cancel()
                previous_id, previous_version = self.selected_id, self.selected_version
                self.selected_id = candidate.id
                self.selected_version = engine.version
                try:
                    self._persist(engine.version)
                except Exception:
                    self.selected_id = previous_id
                    self.selected_version = previous_version
                    raise
                self.engine, engine = engine, None
                self.active_id = candidate.id
                self.state = "ready"
                self.last_activity = self.clock()
                self.error = None
                self.benchmark["phase"] = "ready"
                self.benchmark["current_id"] = None
            return True
        finally:
            self._close_engine(engine)

    def _finish_benchmark(self, status):
        self.benchmark["status"] = status
        if self.benchmark_started is not None:
            self.benchmark["elapsed_s"] = round(self.clock() - self.benchmark_started, 3)
        self.benchmark["current_id"] = None
        self._recommend()

    def _recommend(self):
        # The recommendation is what automatic selection picks: FP32 only, by
        # device preference. The fastest measured candidate is a separate label
        # and may be lower precision; speed samples are never accuracy evaluations.
        chosen = auto_candidate(self.candidates)
        self.recommended_id = chosen.id if chosen else None
        measured = [r for r in self.benchmark["results"] if r.get("status") == "ok"
                    and r.get("batch_size") == 1 and self._find(r.get("candidate_id"))
                    and self._find(r["candidate_id"]).available]
        self.fastest_id = min(measured, key=lambda r: r["latency_ms"])["candidate_id"] if measured else None

    def _error_row(self, candidate, batch, error, load_ms=0):
        return {"candidate_id": candidate.id, "status": "error", "error": error_text(error),
                "load_ms": round(load_ms, 2), "warmup_ms": None, "latency_ms": None,
                "throughput_per_s": None, "peak_rss_bytes": None, "samples": 0,
                "batch_size": batch, "duration_s": 0.0,
                "initialization_ms": None, "hash_ms": None,
                "baseline_rss_bytes": None, "loaded_rss_bytes": None,
                "rss_scope": "isolated_process",
                "rss_sample_interval_ms": 50, "accelerator_kind": None,
                "measurement_quality": "insufficient"}

    def _append(self, row):
        with self.lock:
            self.benchmark["results"].append(row)
            self.benchmark["completed"] += 1

    def _benchmark_work(self, budget):
        if self.benchmark_runner is None:
            raise ValueError("No benchmark runner is configured")
        with self.lock:
            self.state = "benchmarking"
            self.benchmark = empty_benchmark(budget)
            self.benchmark["status"] = "running"
            self.benchmark_started = self.clock()
        self._refresh()
        candidates = [c for c in self.candidates if c.available]
        with self.lock:
            self.benchmark["total"] = len(candidates) * 2
            self.benchmark["environment"] = self.environment
            self.benchmark["context"] = self.context
        if not candidates:
            raise ValueError(self._unavailable_text())
        cancelled = False
        try:
            for candidate in candidates:
                self._check_cancel()
                self._isolated_candidate(candidate, budget)
        except Cancelled:
            cancelled = True
        with self.lock:
            self._finish_benchmark("cancelled" if cancelled else "completed")
            self.benchmark["phase"] = "cancelled" if cancelled else "completed"
        self._persist()
        if self.closed:
            raise Cancelled()
        # A comparison never changes the choice: restore the saved selection
        # (also after cancellation), or select automatically when there is none.
        self.cancel_event.clear()
        previous = self._find(self.selected_id)
        if previous is not None and previous.available:
            self._activate(previous)
        else:
            self._auto_select()

    def _measure(self, engine, candidate, batch, load_ms, budget):
        texts = [paragraph(seed=i * 3) for i in range(batch)]
        self._phase("warmup")
        reset_peak = getattr(engine, "reset_accelerator_peak", None)
        warm_start = self.clock()
        engine.score(texts)
        engine.synchronize()
        warmup_ms = (self.clock() - warm_start) * 1000
        self._check_cancel()
        if reset_peak:
            try:
                reset_peak()
            except Exception:
                pass
        with self.lock:
            remaining = max(0.0, budget - self.benchmark["measurement_s"])
            workloads = max(1, self.benchmark["total"] - self.benchmark["completed"])
            allowance = remaining / workloads
        self._phase("measurement")
        if allowance <= 0:
            return self._error_row(candidate, batch, "measurement budget exhausted", load_ms)
        durations, consumed, tokens, accelerator = [], 0.0, None, None
        with MemorySampler(self.memory) as memory:
            for _ in range(self.max_runs):
                self._check_cancel()
                if consumed >= allowance:
                    break
                engine.synchronize()
                t0 = self.clock()
                try:
                    result = engine.score(texts)
                    engine.synchronize()
                finally:
                    # Failed forwards consume the same shared measurement budget.
                    duration = max(0.000001, self.clock() - t0)
                    self._measurement(duration)
                durations.append(duration)
                consumed += duration
                tokens = sum(row["tokens"] for row in result) / batch
                try:
                    value = engine.accelerator_bytes()
                except Exception:
                    value = None  # unavailable counters must not fail a valid forward
                if value is not None:
                    accelerator = max(accelerator or 0, value)
                memory.sample()
                self._check_cancel()
        median = statistics.median(durations)
        row = {"candidate_id": candidate.id, "status": "ok", "load_ms": round(load_ms, 2),
               "warmup_ms": round(warmup_ms, 2), "latency_ms": round(median * 1000, 3),
               "throughput_per_s": round(batch / median, 3), "peak_rss_bytes": memory.peak,
               "samples": len(durations), "batch_size": batch,
               "tokens_per_text": round(tokens, 1), "duration_s": round(consumed, 6),
               "initialization_ms": None, "hash_ms": None,
               "baseline_rss_bytes": None, "loaded_rss_bytes": None,
               "rss_scope": "isolated_process", "rss_sample_interval_ms": 50,
               "accelerator_kind": ("mps_driver_including_cache" if candidate.device == "mps"
                                    else "cuda_allocator_peak" if candidate.runtime == "torch" and candidate.device.startswith("cuda")
                                    else None),
               "measurement_quality": "sufficient" if len(durations) >= 3 else "insufficient"}
        if accelerator is not None:
            row["accelerator_bytes"] = accelerator
        return row

    def _phase(self, phase):
        with self.lock:
            self.benchmark["phase"] = phase

    def _measurement(self, seconds):
        with self.lock:
            self.benchmark["measurement_s"] += seconds

    def _isolated_candidate(self, candidate, budget):
        with self.lock:
            self.benchmark.update(phase="initialization", current_id=candidate.id)
            remaining = max(0.0, budget - self.benchmark["measurement_s"])
            workloads = self.benchmark["total"] - self.benchmark["completed"]
        received = set()
        def receive(message):
            kind = message["type"]
            if kind == "phase":
                self._phase(message["phase"])
            elif kind == "measurement":
                self._measurement(message["seconds"])
            elif kind == "row":
                row = message["row"]
                if row["candidate_id"] != candidate.id or row["batch_size"] in received:
                    raise ValueError("Invalid benchmark worker workload")
                received.add(row["batch_size"])
                self._append(row)
        try:
            self.benchmark_runner(candidate, remaining, workloads, self.max_runs,
                                  self.cancel_event, receive)
            self._check_cancel()
            if received != {1, 8}:
                raise ValueError("Benchmark worker exited before completing both workloads")
        except Cancelled:
            raise
        except Exception as exc:
            for batch in (1, 8):
                if batch not in received:
                    self._append(self._error_row(candidate, batch, exc))

    def close(self):
        with self.lock:
            self.closed = True
            self.idle_stop.set()
            self.cancel_event.set()
            self.ready_condition.notify_all()
            if self.leases == 0 and self.state == "ready":
                engine, self.engine = self.engine, None
                self.active_id = None
            else:
                engine = None
        self._close_engine(engine)
