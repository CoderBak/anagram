"""Owned local component lifecycle for the browser's Native Messaging host.

No model library is imported by construction/status. Downloads and model work
run in background threads; one component lock covers the complete host lifetime.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import secrets
import signal
import shutil
import stat
import subprocess
import sys
import threading
import time
import tomllib

from download_modelkit import (PIN, LID_ENTRY, LID_URL, DownloadPaused, download_asset,
                               install_streaming, invalid_files, load_pin, matches, plain_tree)
from runtime_controller import RuntimeBusy, RuntimeUnavailable, error_text
from safe_files import atomic_json, is_link, read_json, regular_stat

HOST_NAME = "dev.coderbak.anagram"
STATE_DEFAULT = {"schema_version": 1, "initialized": False, "download_pending": False,
                 "download_paused": False, "download_failed": False,
                 "engine_stopped": False, "models_deleted": False, "idle_unload_s": 300,
                 "model_profile": "recommended"}


class ComponentError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status
        self.message = error_text(message)


def validate_home(home: Path) -> Path:
    home = Path(home).absolute()
    if is_link(home) or home.resolve() in (Path(home.anchor), Path.home().resolve()):
        raise ComponentError("invalid_request", "The component needs its own non-symlink installation directory", 422)
    home = home.resolve()
    marker = home / ".native-component.json"
    if is_link(marker) or not marker.is_file():
        raise ComponentError("not_installed", "The owned native component marker is missing", 503)
    try:
        data = read_json(marker, max_bytes=16384)
    except (OSError, ValueError) as exc:
        raise ComponentError("not_installed", "The native component marker is invalid", 503) from exc
    if (not isinstance(data, dict) or type(data.get("schema_version")) is not int
            or data != {"schema_version": 1, "host": HOST_NAME, "home": str(home)}):
        raise ComponentError("not_installed", "The native component marker does not match this directory", 503)
    return home


class HomeLock:
    """Exclusive OS lock; a second browser receives busy instead of racing files."""
    def __init__(self, home):
        def check_installer():
            installing = home / ".installer-lock"
            if installing.exists() or is_link(installing):
                raise ComponentError("busy", "Anagram installation is in progress; retry after it finishes", 409)

        check_installer()
        path = home / ".native-host.lock"
        if is_link(path):
            raise ComponentError("invalid_request", "Native host lock is a symbolic link", 422)
        if path.exists() and regular_stat(path).st_nlink != 1:
            raise ComponentError("invalid_request", "Native host lock is a hardlink", 422)
        self.path = path
        self.fd = None
        self.lock = None
        if os.name == "posix":
            import fcntl
            fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                held = os.fstat(fd)
                if not stat.S_ISREG(held.st_mode) or held.st_nlink != 1:
                    raise ComponentError("invalid_request", "Native host lock is not a private regular file", 422)
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.fd = fd
            except BlockingIOError as exc:
                os.close(fd)
                raise ComponentError("busy", "Another browser is using this Anagram component; close its connection first", 409) from exc
            except BaseException:
                os.close(fd)
                raise
        else:
            from filelock import FileLock, Timeout
            self.lock = FileLock(str(path), timeout=0, thread_local=False)
            try:
                self.lock.acquire()
            except Timeout as exc:
                raise ComponentError("busy", "Another browser is using this Anagram component; close its connection first", 409) from exc
        try:
            check_installer()
            validate_home(home)
        except Exception:
            self.close()
            raise

    def maintenance_fd(self):
        """Share this exact POSIX lock description with the fixed helper chain."""
        if os.name != "posix":
            raise ComponentError("unsupported", "Inherited maintenance descriptors require POSIX", 503)
        import fcntl
        fd = self.fd
        if type(fd) is not int or fd < 0:
            raise ComponentError("busy", "The component maintenance lock is not held", 409)
        held, current = os.fstat(fd), self.path.lstat()
        if (not stat.S_ISREG(current.st_mode) or (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino)):
            raise ComponentError("busy", "The component maintenance lock file changed", 409)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            # flock belongs to the shared open-file description. Explicit
            # LOCK_UN here would revoke a maintenance child's inherited lock.
            os.close(fd)
        elif self.lock is not None:
            self.lock.release()


def installed_version(home):
    try:
        value = tomllib.loads((home / "app/pyproject.toml").read_text())["project"]["version"]
        return value if isinstance(value, str) else None
    except (OSError, ValueError, KeyError, TypeError):
        try:
            return (home / "VERSION").read_text().strip() or None
        except OSError:
            return None


class NativeComponent:
    def __init__(self, home, *, pin=None, downloader=None, verifier=None,
                 controller_factory=None, helper=None, planner=None, stop_timeout=30, score_wait_timeout=25):
        self.home = validate_home(Path(home))
        self.home_lock = HomeLock(self.home)
        self.lock = threading.RLock()
        self.cancel_download = threading.Event()
        self.exit_requested = threading.Event()
        self.closed = False
        self.started = False
        self.thread = None
        self.controller = None
        self.runtime_draining = False
        self.stop_timeout = stop_timeout
        self.score_wait_timeout = score_wait_timeout
        self.model_dir = self.home / "models/editlens_roberta-large"
        self.lid_path = self.home / "models/lid.176.ftz"
        self.state_path = self.home / "component-state.json"
        self.version = installed_version(self.home)
        self.pin = pin if pin is not None else load_pin(PIN)
        self.downloader = downloader or self._download_models
        self.verifier = verifier or self._verify_models
        self.planner = planner or self._build_model_plan
        self.plan = None
        self.hardware = None
        self.legacy_profile = False
        self.controller_factory = controller_factory or self._make_controller
        self.helper = helper or self._run_helper
        self.state = "starting"
        self.error = None
        self.operation = None
        self.storage_bytes = 0
        self.download = {"status": "idle", "bytes_received": 0, "total_bytes": 0,
                         "file": None, "error": None, "phase": "detecting"}
        self.settings = self._read_settings()

    def _read_settings(self):
        if is_link(self.state_path):
            raise ComponentError("invalid_request", "Component state is a symbolic link", 422)
        try:
            saved = read_json(self.state_path, max_bytes=65536)
            if isinstance(saved, dict) and "idle_unload_s" not in saved:
                saved["idle_unload_s"] = STATE_DEFAULT["idle_unload_s"]
            if isinstance(saved, dict) and "model_profile" not in saved:
                self.legacy_profile = True
                saved["model_profile"] = "recommended"
            if (not isinstance(saved, dict) or set(saved) != set(STATE_DEFAULT)
                    or type(saved["schema_version"]) is not int or saved["schema_version"] != 1
                    or type(saved["idle_unload_s"]) is not int
                    or (saved["idle_unload_s"] != 0 and not 60 <= saved["idle_unload_s"] <= 86400)
                    or saved["model_profile"] not in ("recommended", "expanded")
                    or any(type(saved[key]) is not bool for key in STATE_DEFAULT
                           if key not in ("schema_version", "idle_unload_s", "model_profile"))):
                raise ValueError("invalid component state")
            return saved
        except FileNotFoundError:
            return dict(STATE_DEFAULT)
        except (OSError, ValueError):
            # A damaged preference file must never trigger an unexpected GB download.
            self.error = {"code": "invalid_request", "message": "Component preferences need an explicit resume or download"}
            return {**STATE_DEFAULT, "initialized": True, "engine_stopped": True, "download_paused": True}

    def _save_settings(self):
        if is_link(self.state_path):
            raise ComponentError("invalid_request", "Component state is a symbolic link", 422)
        saved = dict(self.settings)
        if self.legacy_profile:
            # Until device discovery commits the migrated choice, preserve the
            # legacy marker across pauses, disconnects and unrelated settings.
            saved.pop("model_profile")
        atomic_json(self.state_path, saved)

    def start(self):
        with self.lock:
            if not self.started:
                self.started = True
                self._launch(self._bootstrap, "not_ready")

    def _launch(self, work, code):
        def run():
            try:
                work()
            except DownloadPaused:
                with self.lock:
                    self.download["status"] = "paused"
                    self.state = "paused"
            except (Exception, SystemExit) as exc:
                with self.lock:
                    if self.download["status"] == "running" and self.cancel_download.is_set():
                        self.download["status"] = "paused"
                        self.state = "paused"
                        return
                    self.state = "error"
                    failure_code = "download_failed" if self.download["status"] == "running" else code
                    self.error = {"code": getattr(exc, "code", failure_code), "message": error_text(exc)}
                    if self.operation and self.operation["status"] == "running":
                        self.operation["status"] = "failed"
                    if self.download["status"] == "running":
                        self.download.update(status="failed", error=error_text(exc))
                        self.settings.update(download_pending=False, download_failed=True)
                        try:
                            atomic_json(self.home / "download-error.json", {"message": error_text(exc)})
                            self._save_settings()
                        except OSError:
                            pass
            finally:
                self._refresh_storage()
        self.thread = threading.Thread(target=run, name="anagram-component",
                                       daemon=code not in ("update_failed", "uninstall_failed"))
        self.thread.start()

    def _ensure_idle(self):
        if self.closed or (self.thread is not None and self.thread.is_alive()):
            raise ComponentError("busy", "A component operation is still running", 409)
        if self.exit_requested.is_set() or (self.operation and self.operation["status"] == "completed"
                                            and self.operation["name"] in ("update", "uninstall")):
            raise ComponentError("not_ready", "Reconnect the native component after this operation", 503)

    def _bootstrap(self):
        # A legacy daemon does not share the native lock. Refuse it, never delete
        # its files or signal an unverified PID; the installer owns migration.
        pidfile = self.home / "run/anagramd.pid"
        if pidfile.is_file() and not pidfile.is_symlink():
            try:
                pid = int(pidfile.read_text().strip())
                if pid > 0:
                    import psutil
                    if psutil.pid_exists(pid):
                        raise ComponentError("busy", "Stop the legacy Anagram HTTP daemon before using the native component", 409)
            except (ValueError, ProcessLookupError):
                pass
            except PermissionError as exc:
                raise ComponentError("busy", "The legacy daemon PID could not be verified safely", 409) from exc
        with self.lock:
            first = not self.settings["initialized"]
            if first:
                self.settings.update(initialized=True, download_pending=True)
                self._save_settings()
            if self.settings["models_deleted"]:
                self.state = "needs_models"
                return
            if self.settings["download_paused"]:
                self.state = "paused"
                self.download["status"] = "paused"
                return
            if self.settings["download_failed"]:
                self.state = "needs_models"
                self.download["status"] = "failed"
                message = "Retry the model download to continue setup"
                try:
                    saved = read_json(self.home / "download-error.json", max_bytes=16384)
                    if isinstance(saved, dict) and isinstance(saved.get("message"), str):
                        message = error_text(saved["message"])
                except (OSError, ValueError):
                    pass
                self.error = {"code": "download_failed", "message": message}
                return
            pending = self.settings["download_pending"]
        if pending:
            self._download_work()
        else:
            self._ensure_plan()
            if self.verifier():
                with self.lock:
                    self.download.update(status="completed", phase="complete", bytes_received=self.download["total_bytes"])
                self._start_runtime()
            else:
                with self.lock:
                    self.state = "needs_models"

    def _build_model_plan(self, profile):
        from model_plan import build_plan, discover_hardware
        if self.hardware is None:
            self.hardware = discover_hardware()
        plan = build_plan(self.pin, self.hardware, profile)
        expanded = build_plan(self.pin, self.hardware, "expanded")
        if self.legacy_profile:
            # Retain access to an explicitly selected legacy runtime on upgrade.
            # New installations and explicit profile changes never opt into INT8.
            path = self.home / "runtime.json"
            if is_link(path):
                raise ComponentError("invalid_request", "Runtime preferences are a symbolic link", 422)
            try:
                saved = read_json(path)
                selected = saved.get("selected_id") if isinstance(saved, dict) else None
            except (OSError, ValueError):
                selected = None
            if selected in expanded["candidate_ids"] and selected not in plan["candidate_ids"]:
                plan = expanded
        plan["expanded_bytes"] = expanded["total_bytes"] + LID_ENTRY["size_bytes"]
        return plan

    def _ensure_plan(self):
        if self.plan is not None:
            return
        with self.lock:
            self.download.update(phase="detecting", file=None, total_bytes=0, bytes_received=0)
            profile = self.settings["model_profile"]
        plan = self.planner(profile)
        if self.cancel_download.is_set():
            raise DownloadPaused()
        total = plan["total_bytes"] + LID_ENTRY["size_bytes"]
        with self.lock:
            previous_profile, legacy = self.settings["model_profile"], self.legacy_profile
            self.settings["model_profile"] = plan["profile"]
            self.legacy_profile = False
            try:
                self._save_settings()
            except Exception:
                self.settings["model_profile"], self.legacy_profile = previous_profile, legacy
                raise
            self.plan = plan
            self.download.update(phase="verifying", total_bytes=total, plan={
                "profile": plan["profile"], "devices": plan.get("devices", []),
                "files": [*plan["selected_paths"], "lid.176.ftz"], "total_bytes": total,
                "expanded_bytes": plan.get("expanded_bytes", total),
            })

    def _verify_models(self):
        plain_tree(self.home / "models")
        return not invalid_files(self.model_dir, self.pin, selected_paths=self.plan["selected_paths"]) and matches(self.lid_path, LID_ENTRY)

    def _download_models(self, cancel, progress):
        plain_tree(self.home / "models")
        model_total = self.plan["total_bytes"]
        total = model_total + LID_ENTRY["size_bytes"]
        install_streaming(self.model_dir, self.pin, selected_paths=self.plan["selected_paths"], cancel=cancel,
                          progress=lambda got, _total, name: progress(got, total, name), notice=self._download_notice)
        download_asset(LID_URL, self.lid_path, LID_ENTRY, cancel=cancel,
                       progress=lambda got: progress(model_total + got, total, "lid.176.ftz"), notice=self._download_notice)
        progress(total, total, None)

    def _progress(self, received, total, name):
        with self.lock:
            self.download.update(bytes_received=max(0, min(int(received), int(total))),
                                 total_bytes=max(0, int(total)), file=name, phase="downloading", detail=None)

    def _download_notice(self, message):
        with self.lock:
            self.download["detail"] = error_text(message)

    def _download_work(self):
        self._stop_runtime()
        with self.lock:
            self.state = "downloading"
            self.download.update(status="running", error=None)
            self.error = None
        self._ensure_plan()
        self.downloader(self.cancel_download, self._progress)
        if self.cancel_download.is_set():
            raise DownloadPaused()
        with self.lock:
            self.download.update(phase="verifying", file=None)
        if not self.verifier():
            raise ComponentError("download_failed", "Downloaded model files did not pass verification", 500)
        with self.lock:
            if self.cancel_download.is_set():
                raise DownloadPaused()
            self.settings.update(download_pending=False, download_paused=False, download_failed=False)
            self._save_settings()
            self.download.update(status="completed", phase="complete", bytes_received=self.download["total_bytes"], file=None)
        self._start_runtime()

    def _make_controller(self):
        from runtime_adapters import create_controller
        return create_controller(self.model_dir, self.home / "runtime.json", self.lid_path, plan=self.plan)

    def _start_runtime(self):
        with self.lock:
            if self.closed or self.settings["engine_stopped"]:
                self.state = "stopped"
                return
        controller = self.controller_factory()
        with self.lock:
            if self.closed:
                controller.close()
                return
            self.controller = controller
            controller.set_idle_unload(self.settings["idle_unload_s"])
            self.runtime_draining = False
            self.state = "loading"
        controller.start()

    def _stop_runtime(self):
        with self.lock:
            controller = self.controller
            if controller is not None:
                self.runtime_draining = True
        if controller is None:
            return
        controller.close()
        deadline = time.monotonic() + self.stop_timeout
        while True:
            thread = getattr(controller, "thread", None)
            alive = thread is not None and thread.is_alive()
            with controller.lock:
                leased = controller.leases > 0
            if not alive and not leased:
                break
            if time.monotonic() >= deadline:
                raise ComponentError("busy", "The current inference/load is still stopping; retry after it finishes", 409)
            time.sleep(0.05)
        with self.lock:
            if self.controller is controller:
                self.controller = None
                self.runtime_draining = False

    def _refresh_storage(self):
        total, seen = 0, set()
        root = self.home / "models"
        if not root.is_symlink():
            for directory, folders, files in os.walk(root):
                folders[:] = [name for name in folders if not (Path(directory) / name).is_symlink()]
                for name in files:
                    path = Path(directory) / name
                    try:
                        stat = path.lstat()
                        identity = (stat.st_dev, stat.st_ino)
                        if path.is_file() and not path.is_symlink() and identity not in seen:
                            total += stat.st_size
                            seen.add(identity)
                    except OSError:
                        continue
        with self.lock:
            self.storage_bytes = total

    def status(self):
        with self.lock:
            runtime = self.controller.snapshot() if self.controller is not None else None
            state, error = self.state, copy.deepcopy(self.error)
            if state == "loading" and runtime is not None and not self.runtime_draining:
                state = runtime["state"]
                if state == "error" and error is None:
                    error = {"code": "not_ready", "message": runtime["error"] or "Choose or retry a local runtime"}
            return {"schema_version": 1, "version": self.version, "home": str(self.home),
                    "state": state, "download": copy.deepcopy(self.download), "runtime": runtime,
                    "storage": {"models_bytes": self.storage_bytes}, "error": error,
                    "settings": {"idle_unload_s": self.settings["idle_unload_s"]},
                    "operation": copy.deepcopy(self.operation)}

    def _runtime(self):
        with self.lock:
            if (self.operation and self.operation["name"] == "update"
                    and self.operation["status"] == "completed"):
                # Settings may have closed while the updater was running. A
                # later page scan must retire this old process without needing
                # a lifecycle-status poll to discover the completed update.
                raise ComponentError("component_updated", "The component was updated; reconnect to load the new version", 503)
            if self.closed or self.state != "loading" or self.controller is None or self.runtime_draining:
                raise ComponentError("not_ready", "The local engine is not ready; open component settings", 503)
            return self.controller

    @staticmethod
    def _payload(payload, allowed=(), required=()):
        if not isinstance(payload, dict) or not set(required) <= set(payload) <= set(allowed):
            raise ComponentError("invalid_request", "Unexpected operation payload", 422)

    def handle(self, op, payload):
        if op == "status":
            self._payload(payload)
            return 200, self.status()
        if op == "health":
            self._payload(payload)
            controller = self._runtime()
            if controller.snapshot()["state"] == "idle":
                raise ComponentError("engine_idle", "The engine was unloaded while idle; scoring will reload it", 503)
            with controller.use_engine(activity=False) as engine:
                return 200, engine.info()
        if op == "score":
            from engine import ScoreRequest, ScoreResponse, score_with_engine
            from pydantic import ValidationError
            try:
                request = ScoreRequest.model_validate(payload)
            except ValidationError as exc:
                raise ComponentError("invalid_request", "Invalid score request", 422) from exc
            controller = self._runtime()
            controller.wake_and_wait(timeout=self.score_wait_timeout)
            with controller.use_engine() as engine:
                response = score_with_engine(request, engine)
                return 200, ScoreResponse.model_validate(response).model_dump(exclude_none=True)
        if op == "runtime":
            self._payload(payload)
            return 200, self._runtime().snapshot()
        if op in ("runtime.benchmark", "runtime.config", "runtime.cancel"):
            controller = self._runtime()
            if op == "runtime.benchmark":
                self._payload(payload, ("budget_s",))
                return 202, controller.request_benchmark(payload.get("budget_s", 30))
            if op == "runtime.config":
                self._payload(payload, ("id",), ("id",))
                if not isinstance(payload["id"], str) or len(payload["id"]) > 120:
                    raise ComponentError("invalid_request", "Invalid runtime identifier", 422)
                return 202, controller.request_selection(payload["id"])
            self._payload(payload)
            return 202, controller.cancel()
        if op == "models.pause":
            self._payload(payload)
            with self.lock:
                if self.download["status"] != "running":
                    raise ComponentError("busy", "There is no active download to pause", 409)
                self.settings["download_paused"] = True
                self._save_settings()
                self.cancel_download.set()
                return 202, self.status()
        if op == "engine.settings":
            self._payload(payload, ("idle_unload_s",), ("idle_unload_s",))
            seconds = payload["idle_unload_s"]
            if type(seconds) is not int or (seconds != 0 and not 60 <= seconds <= 86400):
                raise ComponentError("invalid_request", "idle_unload_s must be 0 or an integer from 60 to 86400", 422)
            with self.lock:
                self._ensure_idle()
                previous = self.settings["idle_unload_s"]
                self.settings["idle_unload_s"] = seconds
                try:
                    self._save_settings()
                except Exception:
                    self.settings["idle_unload_s"] = previous
                    raise
                if self.controller is not None:
                    self.controller.set_idle_unload(seconds)
                return 200, self.status()
        if op in ("models.delete", "component.uninstall"):
            self._payload(payload, ("confirm",), ("confirm",))
            if payload["confirm"] is not True:
                raise ComponentError("invalid_request", "Explicit confirmation is required", 422)
        elif op == "models.download":
            self._payload(payload, ("profile",))
            if "profile" in payload and payload["profile"] not in ("recommended", "expanded"):
                raise ComponentError("invalid_request", "Unknown model download profile", 422)
        elif op in ("engine.stop", "engine.resume", "component.update"):
            self._payload(payload)
        else:
            raise ComponentError("invalid_request", "Unknown native operation", 422)
        with self.lock:
            self._ensure_idle()
            self.error = None
            if op == "models.download":
                if "profile" in payload:
                    self.settings["model_profile"] = payload["profile"]
                    self.legacy_profile = False
                self.settings.update(initialized=True, download_pending=True, download_paused=False,
                                     download_failed=False, models_deleted=False, engine_stopped=False)
                self._save_settings()
                self.cancel_download.clear()
                self.plan = None
                self.hardware = None
                self.state = "downloading"
                self.download.update(status="running", phase="detecting", total_bytes=0, bytes_received=0, file=None)
                self.download.pop("plan", None)
                self.operation = None
                self._launch(self._download_work, "download_failed")
            elif op == "engine.stop":
                self.settings["engine_stopped"] = True
                self._save_settings()
                self.state = "loading"
                self.runtime_draining = self.controller is not None
                def stop():
                    self._stop_runtime()
                    with self.lock:
                        self.state = "stopped"
                self._launch(stop, "not_ready")
            elif op == "engine.resume":
                self.settings.update(initialized=True, engine_stopped=False)
                self._save_settings()
                self.state = "loading"
                self.runtime_draining = self.controller is not None
                self.operation = None
                def resume():
                    self._stop_runtime()
                    self.cancel_download.clear()
                    self._ensure_plan()
                    if not self.verifier():
                        with self.lock:
                            self.state = "needs_models"
                        return
                    with self.lock:
                        self.settings.update(download_paused=False, download_pending=False, download_failed=False)
                        self._save_settings()
                    self._start_runtime()
                self._launch(resume, "not_ready")
            else:
                name = {"models.delete": "delete_models", "component.update": "update",
                        "component.uninstall": "uninstall"}[op]
                self.operation = {"name": name, "status": "running", "receipt": None}
                self.state = {"delete_models": "loading", "update": "updating", "uninstall": "uninstalling"}[name]
                self.runtime_draining = self.controller is not None
                self._launch(lambda: self._maintenance(name), name + "_failed")
            return 202, self.status()

    def _maintenance(self, name):
        self._stop_runtime()
        if name == "delete_models":
            plain_tree(self.home / "models")
            runtime_path = self.home / "runtime.json"
            if is_link(runtime_path):
                raise ComponentError("invalid_request", "Runtime preferences are a symbolic link", 422)
            if (self.home / "models").exists():
                shutil.rmtree(self.home / "models")
            runtime_path.unlink(missing_ok=True)
            with self.lock:
                self.settings.update(initialized=True, models_deleted=True, engine_stopped=True,
                                     download_pending=False, download_paused=False, download_failed=False)
                self._save_settings()
                self.download.update(status="idle", bytes_received=0, file=None, error=None)
                self.state = "needs_models"
        else:
            result = self.helper(name)
            if result.get("status") == "scheduled":
                with self.lock:
                    self.operation.update(status="scheduled", receipt=None)
                    self.exit_requested.set()
                return
            if result.get("status") != "completed":
                raise ComponentError(name + "_failed", "The component helper did not confirm completion", 500)
            with self.lock:
                self.state = "stopped"
                if name == "uninstall":
                    self.storage_bytes = 0
        with self.lock:
            self.operation.update(status="completed", receipt=secrets.token_hex(16))

    def _run_helper(self, name):
        validate_home(self.home)
        app = self.home / "app"
        helper = app / "native_registration.py"
        if app.is_symlink() or helper.is_symlink() or not helper.is_file():
            raise ComponentError("unsupported", "The trusted component maintenance helper is missing", 503)
        env = {key: value for key, value in os.environ.items()
               if key not in {"PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"}}
        env.update(PYTHONNOUSERSITE="1", PYTHONSAFEPATH="1")
        command = [sys.executable, "-I", str(helper), name]
        options = {}
        if os.name == "posix":
            fd = self.home_lock.maintenance_fd()
            command += ["--lock-fd", str(fd)]
            options.update(pass_fds=(fd,), start_new_session=True)
        command += ["--home", str(self.home)]
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=sys.stderr, env=env, **options)
        try:
            output, _ = process.communicate(timeout=1200)
        except BaseException:
            self._terminate_helper(process)
            raise
        if process.returncode != 0:
            raise ComponentError(name + "_failed", "The component maintenance helper failed; check its diagnostics", 500)
        if len(output) > 65536:
            raise ComponentError(name + "_failed", "Invalid component helper response", 500)
        try:
            reply = json.loads(output)
            if not isinstance(reply, dict):
                raise ValueError()
            return reply
        except (ValueError, UnicodeDecodeError) as exc:
            raise ComponentError(name + "_failed", "Invalid component helper response", 500) from exc

    @staticmethod
    def _terminate_helper(process):
        if os.name == "posix":
            # This session was created exclusively for our trusted helper. Stop
            # its installer descendants as well as the direct Python child.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.kill()
        process.wait()
        if process.stdout:
            process.stdout.close()

    def close(self):
        with self.lock:
            self.closed = True
            self.cancel_download.set()
        thread = self.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=self.stop_timeout + 12)
        try:
            self._stop_runtime()
        except ComponentError:
            pass
        # Do not release ownership while an in-process model/job still runs.
        # On real browser shutdown process exit releases the OS lock as well.
        alive = thread is not None and thread.is_alive()
        controller = self.controller
        if not alive and controller is None:
            self.home_lock.close()
