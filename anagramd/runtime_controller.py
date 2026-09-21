"""Background lifecycle and bounded, cooperative local runtime comparisons.

Measurements cover text cleaning, tokenization, forward and postprocessing of
fixed ~120-word English samples, not language identification or browser transport.
Native status and control requests never wait for a model load or forward pass. Native
loads/forwards cannot safely be interrupted in a Python thread: cancellation
takes effect at their next boundary. The budget covers measured forwards only;
discovery, loading, warmup and restoring a saved selection take additional time.
"""
from __future__ import annotations

import copy
import json
import math
import os
import statistics
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path


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


# Same controlled prose/rotation as bench.py, kept free of its developer-only
# dependencies. Both workloads use ~120 words; these samples do not measure accuracy.
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
        return psutil.Process().memory_info().rss
    except (ImportError, OSError):
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
    return {"status": "idle", "budget_s": budget, "elapsed_s": 0.0,
            "measurement_s": 0.0, "phase": "discovery", "current_id": None,
            "completed": 0, "total": 0, "results": []}


class RuntimeController:
    def __init__(self, config_path: Path, discover, factory, *, clock=time.perf_counter,
                 memory=process_rss, max_runs: int = 20):
        self.config_path = Path(config_path)
        self.discover = discover  # -> (list[Candidate], provenance context string)
        self.factory = factory    # -> a loaded engine; no warmup in the factory
        self.clock, self.memory, self.max_runs = clock, memory, max_runs
        self.lock = threading.RLock()
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
        self.needs_selection = True
        self.error = None
        self.benchmark = empty_benchmark()
        self.benchmark_started = None

    def snapshot(self) -> dict:
        with self.lock:
            benchmark = copy.deepcopy(self.benchmark)
            if benchmark["status"] == "running" and self.benchmark_started is not None:
                benchmark["elapsed_s"] = round(self.clock() - self.benchmark_started, 3)
            return {"schema_version": 1, "state": self.state,
                    "active_id": self.active_id, "selected_id": self.selected_id,
                    "recommended_id": self.recommended_id,
                    "needs_selection": self.needs_selection,
                    "candidates": [asdict(candidate) for candidate in self.candidates],
                    "benchmark": benchmark, "error": self.error}

    def start(self):
        with self.lock:
            if self.started or self.closed:
                return
            self.started = True
            self._launch(self._bootstrap)

    def _launch(self, work):
        self.cancel_event.clear()
        self.thread = threading.Thread(target=self._run, args=(work,),
                                       name="anagram-runtime", daemon=True)
        self.thread.start()

    def _run(self, work):
        try:
            work()
        except Cancelled:
            with self.lock:
                self.state = "awaiting_selection"
                self.needs_selection = True
                if self.benchmark["status"] == "running":
                    self._finish_benchmark("cancelled")
                elif self.benchmark["status"] == "idle":
                    self.benchmark["status"] = "cancelled"
                self.benchmark["phase"] = "cancelled"
        except (Exception, SystemExit) as exc:
            with self.lock:
                self.state = "error"
                self.error = error_text(exc)
                self.needs_selection = True
                if self.benchmark["status"] == "running":
                    self._finish_benchmark("failed")
                self.benchmark["phase"] = "error"

    def _check_cancel(self):
        if self.cancel_event.is_set() or self.closed:
            raise Cancelled()

    def _read_saved(self):
        try:
            saved = json.loads(self.config_path.read_text())
            if (not isinstance(saved, dict) or type(saved.get("schema_version")) is not int
                    or saved["schema_version"] != 1):
                raise ValueError("unsupported runtime configuration")
            return saved
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            # A damaged file does not prevent the user from running setup again.
            with self.lock:
                self.error = error_text(f"Saved runtime configuration could not be read: {exc}")
            return None

    def _bootstrap(self):
        self._refresh()
        self._check_cancel()
        saved = self._read_saved()
        if saved and saved.get("context") == self.context:
            report = saved.get("benchmark")
            valid_report = self._valid_report(report)
            if valid_report:
                with self.lock:
                    self.benchmark = report
                    self._recommend()
            else:
                # Never publish an unvalidated disk object as the wire report,
                # or the client cannot even render its recovery controls.
                saved = {}
                with self.lock:
                    self.error = "Saved benchmark report was invalid; running a fresh comparison."
            candidate = self._find(saved.get("selected_id"))
            if candidate and candidate.available and isinstance(saved.get("selected_version"), str):
                # Reports are for display only; a successfully loaded engine must also
                # match the saved content-derived version before it may score.
                with self.lock:
                    self.selected_id = candidate.id
                    self.selected_version = saved["selected_version"]
                    self.needs_selection = False
                if self._activate(candidate, expected_version=saved["selected_version"]):
                    return
            elif saved.get("selected_id") is None and valid_report and report["status"] in {"completed", "cancelled"}:
                with self.lock:
                    self.state = "awaiting_selection"
                    self.benchmark["phase"] = "awaiting_selection"
                return
        with self.lock:
            self.selected_id = None
            self.selected_version = None
            self.needs_selection = True
        self._benchmark_work(30, refresh=False)

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
        if (report["status"] not in ("completed", "cancelled", "failed", "idle")
                or type(report["budget_s"]) is not int or not 10 <= report["budget_s"] <= 30
                or not number(report["elapsed_s"]) or not number(report["measurement_s"])
                or not text(report["phase"])):
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
                   "accelerator_bytes", "tokens_per_text", "duration_s"}
        required = {"candidate_id", "status", "load_ms", "warmup_ms", "latency_ms",
                    "throughput_per_s", "peak_rss_bytes", "samples", "batch_size", "duration_s"}
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
        candidates, context = self.discover()
        if len({c.id for c in candidates}) != len(candidates):
            raise ValueError("duplicate runtime candidate identifiers")
        with self.lock:
            self.candidates = candidates
            if self.context is not None and self.context != context:
                self.selected_id = None
                self.selected_version = None
                self.needs_selection = True
                self.recommended_id = None
            self.context = context

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
            expected_context = self.context
            def work():
                self._close_engine(old_engine)
                self._refresh()
                if self.context != expected_context:
                    with self.lock:
                        self.benchmark = empty_benchmark()
                    raise ValueError("Model files or runtime configuration changed; rerun the comparison before selecting")
                current = self._find(candidate.id)
                if current is None or not current.available:
                    raise ValueError("The selected runtime is no longer available; rerun the comparison")
                self._activate(current)
            self._launch(work)
            return self.snapshot()

    def cancel(self):
        with self.lock:
            if self.state not in {"loading", "benchmarking"}:
                raise RuntimeBusy("there is no running runtime operation to cancel")
            self.cancel_event.set()
            return self.snapshot()

    @contextmanager
    def use_engine(self):
        with self.lock:
            if (self.state != "ready" or self.engine is None or self.needs_selection
                    or self.active_id != self.selected_id):
                raise RuntimeUnavailable("runtime is not ready; open Anagram Settings to finish setup")
            engine = self.engine
            self.leases += 1
        try:
            yield engine
        finally:
            with self.lock:
                self.leases -= 1
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
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.config_path.with_name(self.config_path.name + ".tmp")
        try:
            with temp.open("w", encoding="utf-8") as f:
                json.dump(saved, f, allow_nan=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp, self.config_path)
        finally:
            temp.unlink(missing_ok=True)

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
                    self.error = "Model or runtime provenance changed; compare runtimes and select again."
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
                self.needs_selection = False
                self.state = "ready"
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
        # Only measured FP32 candidates may be recommended. Lower precision is an
        # explicit choice, and speed samples are never labeled accuracy evaluations.
        rows = [r for r in self.benchmark["results"] if r.get("status") == "ok"
                and r.get("batch_size") == 1 and self._find(r.get("candidate_id"))
                and self._find(r["candidate_id"]).precision == "fp32"
                and self._find(r["candidate_id"]).available]
        self.recommended_id = min(rows, key=lambda r: r["latency_ms"])["candidate_id"] if rows else None

    def _error_row(self, candidate, batch, error, load_ms=0):
        return {"candidate_id": candidate.id, "status": "error", "error": error_text(error),
                "load_ms": round(load_ms, 2), "warmup_ms": None, "latency_ms": None,
                "throughput_per_s": None, "peak_rss_bytes": None, "samples": 0,
                "batch_size": batch, "duration_s": 0.0}

    def _append(self, row):
        with self.lock:
            self.benchmark["results"].append(row)
            self.benchmark["completed"] += 1

    def _benchmark_work(self, budget, refresh=True):
        with self.lock:
            self.state = "benchmarking"
            self.benchmark = empty_benchmark(budget)
            self.benchmark["status"] = "running"
            self.benchmark_started = self.clock()
        if refresh:
            self._refresh()
        candidates = [c for c in self.candidates if c.available]
        with self.lock:
            self.benchmark["total"] = len(candidates) * 2
        if not candidates:
            raise ValueError("No available runtime. Install the model files and a supported runtime, then rerun the comparison.")
        cancelled = False
        try:
            for candidate in candidates:
                self._check_cancel()
                engine = None
                with self.lock:
                    self.benchmark.update(phase="loading", current_id=candidate.id)
                load_start = self.clock()
                try:
                    engine = self.factory(candidate)
                    engine.synchronize()
                    load_ms = (self.clock() - load_start) * 1000
                    self._check_cancel()
                    for batch in (1, 8):
                        self._check_cancel()
                        try:
                            row = self._measure(engine, candidate, batch, load_ms, budget)
                        except Cancelled:
                            raise
                        except Exception as exc:
                            row = self._error_row(candidate, batch, exc, load_ms)
                        self._append(row)
                except Cancelled:
                    raise
                except (Exception, SystemExit) as exc:
                    for batch in (1, 8):
                        self._append(self._error_row(candidate, batch, exc,
                                                     (self.clock() - load_start) * 1000))
                finally:
                    self._close_engine(engine)
        except Cancelled:
            cancelled = True
        with self.lock:
            self._finish_benchmark("cancelled" if cancelled else "completed")
            self.state = "awaiting_selection"
            self.benchmark["phase"] = "cancelled" if cancelled else "awaiting_selection"
            self.needs_selection = True
        self._persist()
        # An explicit rerun does not change a saved choice. Restore it after the
        # comparison (including cancellation), unless this is the first setup.
        previous = self._find(self.selected_id)
        if previous and previous.available and not self.closed:
            self.cancel_event.clear()
            self._activate(previous)

    def _measure(self, engine, candidate, batch, load_ms, budget):
        texts = [paragraph(seed=i * 3) for i in range(batch)]
        with self.lock:
            self.benchmark["phase"] = "warmup"
        reset_peak = getattr(engine, "reset_accelerator_peak", None)
        if reset_peak:
            reset_peak()
        warm_start = self.clock()
        engine.score(texts)
        engine.synchronize()
        warmup_ms = (self.clock() - warm_start) * 1000
        self._check_cancel()
        with self.lock:
            remaining = max(0.0, budget - self.benchmark["measurement_s"])
            workloads = max(1, self.benchmark["total"] - self.benchmark["completed"])
            allowance = remaining / workloads
            self.benchmark["phase"] = "measurement"
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
                    with self.lock:
                        self.benchmark["measurement_s"] += duration
                durations.append(duration)
                consumed += duration
                tokens = sum(row["tokens"] for row in result) / batch
                value = engine.accelerator_bytes()
                if value is not None:
                    accelerator = max(accelerator or 0, value)
                memory.sample()
                self._check_cancel()
        median = statistics.median(durations)
        row = {"candidate_id": candidate.id, "status": "ok", "load_ms": round(load_ms, 2),
               "warmup_ms": round(warmup_ms, 2), "latency_ms": round(median * 1000, 3),
               "throughput_per_s": round(batch / median, 3), "peak_rss_bytes": memory.peak,
               "samples": len(durations), "batch_size": batch,
               "tokens_per_text": round(tokens, 1), "duration_s": round(consumed, 6)}
        if accelerator is not None:
            row["accelerator_bytes"] = accelerator
        return row

    def close(self):
        with self.lock:
            self.closed = True
            self.cancel_event.set()
            if self.leases == 0 and self.state == "ready":
                engine, self.engine = self.engine, None
                self.active_id = None
            else:
                engine = None
        self._close_engine(engine)
