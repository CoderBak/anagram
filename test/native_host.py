#!/usr/bin/env python3
"""Native framing/lifecycle/download tests using only tiny injected fixtures."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import queue
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DAEMON = Path(__file__).resolve().parents[1] / "anagramd"
sys.path.insert(0, str(DAEMON))
import native_host as host
from native_component import ComponentError, HOST_NAME, HomeLock, NativeComponent, STATE_DEFAULT
from download_modelkit import DownloadPaused, download_asset, install_streaming, invalid_files
from runtime_controller import Candidate, RuntimeController
from transfer_fixture import transfer_with


def frame(value):
    data = json.dumps(value, ensure_ascii=False).encode()
    return struct.pack("=I", len(data)) + data


def request(op="status", id="request-1", payload=None):
    return {"v": 1, "id": id, "op": op, "payload": payload or {}}


def replies(buffer):
    source, out = io.BytesIO(buffer), []
    while True:
        value = host.read_frame(source)
        if value is None:
            return out
        out.append(value)


class Fragmented(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 3))


class QueuedReader:
    """Browser stdin that delivers each frame when the test sends it; None is EOF."""
    def __init__(self):
        self.queue, self.buffer = queue.Queue(), b""
    def read(self, count):
        while not self.buffer:
            data = self.queue.get(timeout=3)
            if data is None:
                return b""
            self.buffer += data
        result, self.buffer = self.buffer[:count], self.buffer[count:]
        return result


class FramingTests(unittest.TestCase):
    def test_utf8_and_fragmented_frames(self):
        value = request("score", payload={"v": "2.1", "blocks": [{"id": "a", "text": "你好 🙂"}]})
        self.assertEqual(host.read_frame(Fragmented(frame(value))), value)
        self.assertEqual(host.read_frame(io.BytesIO()), None)
        for broken in (b"\x01\x00", struct.pack("=I", 8) + b"{}", struct.pack("=I", 0),
                       struct.pack("=I", host.MAX_REQUEST_BYTES + 1), struct.pack("=I", 1) + b"\xff", frame(None)):
            with self.subTest(broken=broken[:8]), self.assertRaises(host.ProtocolError):
                host.read_frame(io.BytesIO(broken))

    def test_envelope_and_operations_are_whitelisted(self):
        invalid = [[], {**request(), "v": True}, {**request(), "path": "/tmp/anything"},
                   request("shell"), request(id=""), request(id="x" * 97),
                   {**request(), "payload": []}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(host.ProtocolError):
                host.validate_request(value)

    def test_oversized_or_invalid_replies_become_bounded_errors(self):
        output = io.BytesIO()
        writer = host.FrameWriter(output)
        writer.write({"v": 1, "id": "big", "data": "x" * host.MAX_RESPONSE_BYTES})
        writer.write({"v": 1, "id": "nan", "data": float("nan")})
        values = replies(output.getvalue())
        self.assertEqual([r["error"]["code"] for r in values], ["response_too_large", "invalid_response"])
        self.assertLess(len(output.getvalue()), 4096)

    def test_busy_startup_never_constructs_or_starts_another_component(self):
        output = io.BytesIO()
        error = ComponentError("busy", "another browser owns this component", 409)
        host.run_host(io.BytesIO(frame(request()) + frame(request("models.download", "2"))), output,
                      startup_error=error)
        self.assertEqual([r["status"] for r in replies(output.getvalue())], [409, 409])

    def test_completed_update_health_reply_retires_the_old_host(self):
        class Component:
            closed = False
            def start(self):
                pass
            def close(self):
                self.closed = True
            def handle(self, op, payload):
                self.last_op = op
                raise ComponentError("component_updated", "Reconnect to use the updated component", 503)
        component, output = Component(), io.BytesIO()
        host.run_host(io.BytesIO(frame(request("health")) + frame(request("status", "later"))), output, component)
        values = replies(output.getvalue())
        self.assertEqual(len(values), 1)
        self.assertEqual((values[0]["status"], values[0]["error"]["code"]), (503, "component_updated"))
        self.assertEqual(component.last_op, "health")
        self.assertTrue(component.closed)

    def test_status_responds_while_score_is_blocked(self):
        class Writer(io.BytesIO):
            def flush(self):
                answered.set()
        entered, release, answered = threading.Event(), threading.Event(), threading.Event()
        class Component:
            def start(self):
                pass
            def close(self):
                release.set()
            def handle(self, op, payload):
                if op == "score":
                    entered.set()
                    release.wait(3)
                return 200, {"op": op, "operation": None}
        reader, writer = QueuedReader(), Writer()
        thread = threading.Thread(target=host.run_host, args=(reader, writer, Component()))
        thread.start()
        reader.queue.put(frame(request("score", "slow")))
        self.assertTrue(entered.wait(2))
        reader.queue.put(frame(request("status", "quick")))
        self.assertTrue(answered.wait(2))
        self.assertEqual(replies(writer.getvalue())[0]["id"], "quick")
        release.set()
        reader.queue.put(None)
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual({r["id"] for r in replies(writer.getvalue())}, {"quick", "slow"})

    def test_score_abandoned_by_the_browser_in_the_queue_is_not_scored(self):
        entered, release = threading.Event(), threading.Event()
        scored = []
        class Component:
            def start(self):
                pass
            def close(self):
                release.set()
            def handle(self, op, payload):
                scored.append(payload["id"])
                if payload["id"] == "slow":
                    entered.set()
                    release.wait(3)
                return 200, {"op": op}
        written = threading.Semaphore(0)
        class Writer(io.BytesIO):
            def flush(self):
                written.release()
        reader, writer = QueuedReader(), Writer()
        thread = threading.Thread(target=host.run_host, args=(reader, writer, Component()))
        with patch.object(host, "SCORE_QUEUE_TIMEOUT_S", 0.2):
            thread.start()
            reader.queue.put(frame(request("score", "slow", {"id": "slow"})))
            self.assertTrue(entered.wait(2))
            reader.queue.put(frame(request("score", "stale", {"id": "stale"})))
            time.sleep(0.4)  # the browser's timeout passes while "slow" holds the only worker
            reader.queue.put(frame(request("score", "fresh", {"id": "fresh"})))
            time.sleep(0.05)
            release.set()
            for _ in range(3):
                self.assertTrue(written.acquire(timeout=3))
            reader.queue.put(None)
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(scored, ["slow", "fresh"])
        answers = {r["id"]: r for r in replies(writer.getvalue())}
        self.assertEqual((answers["stale"]["status"], answers["stale"]["error"]["code"]), (409, "busy"))
        self.assertEqual((answers["slow"]["status"], answers["fresh"]["status"]), (200, 200))

    def test_host_import_does_not_import_model_libraries(self):
        code = "import sys;sys.path.insert(0,sys.argv[1]);import native_host;print([n for n in ('torch','transformers','onnxruntime') if n in sys.modules])"
        result = subprocess.run([sys.executable, "-I", "-c", code, str(DAEMON)], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "[]")

    def test_host_contains_relative_dependency_files_in_owned_home(self):
        code = """
import sys, os, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import native_host, native_component
class Component:
    def __init__(self, home): self.home = Path(home).resolve()
    def start(self): Path('dependency-session').write_text('fixture')
    def handle(self, op, payload):
        return 200, {'cwd': str(Path.cwd()), 'tmp': tempfile.gettempdir(),
                     'home': os.environ.get('HOME'), 'token': os.environ.get('HF_TOKEN'),
                     'cache': {name: os.environ.get(name) for name in
                               ('HF_HOME','HF_HUB_CACHE','HF_TOKEN_PATH','TORCH_HOME','XDG_CACHE_HOME','TMPDIR')},
                     'offline': os.environ.get('HF_HUB_OFFLINE')}
    def close(self): pass
native_component.NativeComponent = Component
sys.argv = ['native_host.py', '--home', sys.argv[2]]
native_host.main()
"""
        with tempfile.TemporaryDirectory() as directory:
            launch, home = Path(directory) / "launch", Path(directory) / "owned"
            launch.mkdir()
            home.mkdir()
            result = subprocess.run([sys.executable, "-I", "-c", code, str(DAEMON), str(home)],
                                    input=frame(request()), capture_output=True, cwd=launch, check=True,
                                    env={**os.environ, "HF_HOME": str(launch), "TORCH_HOME": str(launch),
                                         "TMPDIR": str(launch), "HF_TOKEN": "fixture-secret", "HF_HUB_OFFLINE": "0"})
            data = replies(result.stdout)[0]["data"]
            self.assertEqual(data["cwd"], str(home.resolve()))
            self.assertEqual(data["tmp"], str(home.resolve() / "cache/tmp"))
            self.assertEqual(data["home"], os.environ.get("HOME"))
            self.assertIsNone(data["token"])
            self.assertEqual(data["offline"], "1")
            self.assertTrue(all(Path(value).is_relative_to(home.resolve()) for value in data["cache"].values()))
            self.assertTrue((home / "dependency-session").is_file())
            self.assertEqual(list(launch.iterdir()), [])

    def test_host_cache_links_are_rejected_before_environment_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            home, outside = Path(directory) / "owned", Path(directory) / "outside"
            home.mkdir()
            outside.mkdir()
            (home / "cache").symlink_to(outside, target_is_directory=True)
            with patch.dict(os.environ, {}), self.assertRaisesRegex(ValueError, "owned directory"):
                host.configure_environment(home)
            self.assertEqual(list(outside.iterdir()), [])

    def test_browser_launch_arguments_are_metadata_only(self):
        chrome = host.parse_args(["--home", "/tmp/owned", "chrome-extension://example/", "--parent-window=123"])
        self.assertEqual((chrome.caller, chrome.addon_id), ("chrome-extension://example/", None))
        self.assertFalse(hasattr(chrome, "parent_window"))  # Windows Chrome's handle is ignored, not stored
        firefox = host.parse_args(["--home", "/tmp/owned", "/tmp/native manifest.json", "anagram@example.org"])
        self.assertEqual((firefox.caller, firefox.addon_id), ("/tmp/native manifest.json", "anagram@example.org"))


class FixtureEngine:
    version = "native-test-v1"
    n_buckets = 4
    last_run_ms = last_wait_ms = 0
    lid = SimpleNamespace(enabled=False)
    def score(self, texts):
        return [{"bucket": 0, "probs": [1., 0., 0., 0.], "score": 0., "tokens": 8, "truncated": False}
                for _ in texts]
    def synchronize(self):
        pass
    def accelerator_bytes(self):
        return None
    def close(self):
        pass
    def info(self):
        return {"ok": True, "contract": "2.1", "model": {"id": "editlens_roberta-large", "ver": self.version, "calibration": "test"}}


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "owned"
        self.home.mkdir()
        (self.home / ".native-component.json").write_text(json.dumps(
            {"schema_version": 1, "host": HOST_NAME, "home": str(self.home.resolve())}))
        self.downloads = 0
        self.components = []
        self.pin = {"files": [{"path": "fixture", "size_bytes": 8, "sha256": hashlib.sha256(b"fixture!").hexdigest()}]}

    def tearDown(self):
        for component in self.components:
            component.close()

    def download(self, cancel, progress):
        self.downloads += 1
        target = self.home / "models/fixture"
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(b"fixture!")
        progress(8, 8, "fixture")

    def factory(self):
        return RuntimeController(self.home / "runtime.json",
                                 lambda: ([Candidate("torch:cpu:fp32", "CPU", "cpu", "torch", "fp32")], "native-test"),
                                 lambda _: FixtureEngine(), max_runs=1, memory=lambda: 100)

    def make(self, **kwargs):
        def plan(profile):
            return {"profile": profile, "devices": ["Fixture CPU"],
                    "candidate_ids": ["torch:cpu:fp32"],
                    "selected_paths": ["fixture"], "total_bytes": 8}
        component = NativeComponent(self.home, pin=self.pin,
                                    downloader=kwargs.pop("downloader", self.download),
                                    verifier=kwargs.pop("verifier", lambda: (self.home / "models/fixture").is_file()),
                                    controller_factory=self.factory,
                                    planner=kwargs.pop("planner", plan), **kwargs)
        self.components.append(component)
        return component

    def finish(self, component):
        if component.thread:
            component.thread.join(3)
            self.assertFalse(component.thread.is_alive())
        if component.controller and component.controller.thread:
            component.controller.thread.join(3)
            self.assertFalse(component.controller.thread.is_alive())

    def first_run(self, component):
        """Prepared files lead straight to a loaded runtime; no choice is requested."""
        component.start()
        self.finish(component)
        status = component.status()
        self.assertEqual(status["state"], "ready", status)
        self.assertEqual(status["runtime"]["active_id"], "torch:cpu:fp32")

    def test_first_connection_downloads_once_and_models_are_reused(self):
        component = self.make()
        self.first_run(component)
        self.assertEqual(self.downloads, 1)
        self.assertEqual(component.status()["download"]["status"], "completed")
        component.close()
        restarted = self.make()
        self.first_run(restarted)
        self.assertEqual(self.downloads, 1)

    def test_exclusive_home_lock_refuses_second_browser(self):
        component = self.make()
        with self.assertRaises(ComponentError) as error:
            self.make()
        self.assertEqual(error.exception.code, "busy")
        self.assertEqual(self.downloads, 0)
        component.close()
        self.make().close()

    @unittest.skipUnless(os.name == "posix", "POSIX inherited flock")
    def test_maintenance_child_retains_lock_after_owner_closes_its_descriptor(self):
        lock = HomeLock(self.home)
        fd = lock.maintenance_fd()
        child = subprocess.Popen([sys.executable, "-I", "-c",
                                  "import sys; print('ready',flush=True); sys.stdin.read(1)"],
                                 pass_fds=(fd,), stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b"ready\n")
            lock.close()
            with self.assertRaises(ComponentError) as error:
                HomeLock(self.home)
            self.assertEqual(error.exception.code, "busy")
            child.communicate(b"x", timeout=3)
            replacement = HomeLock(self.home)
            replacement.close()
        finally:
            lock.close()
            if child.poll() is None:
                child.kill()
            child.wait()
            child.stdin.close()
            child.stdout.close()

    @unittest.skipUnless(os.name == "posix", "POSIX helper process groups")
    def test_helper_timeout_stops_installer_descendants_before_lock_is_released(self):
        lock = HomeLock(self.home)
        fd = lock.maintenance_fd()
        marker = self.home / "descendant-ready"
        child_code = "import pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(%r).touch(); time.sleep(60)" % str(marker)
        helper_code = ("import subprocess,sys,time,pathlib; subprocess.Popen([sys.executable,'-I','-c',%r],pass_fds=(%d,)); "
                       "\nwhile not pathlib.Path(%r).exists(): time.sleep(.005)\nprint('ready',flush=True)\ntime.sleep(60)"
                       % (child_code, fd, str(marker)))
        helper = subprocess.Popen([sys.executable, "-I", "-c", helper_code], pass_fds=(fd,),
                                  start_new_session=True, stdout=subprocess.PIPE)
        try:
            self.assertEqual(helper.stdout.readline(), b"ready\n")
            NativeComponent._terminate_helper(helper)
            self.assertIsNotNone(helper.poll())
            lock.close()
            deadline = time.monotonic() + 2
            while True:
                try:
                    replacement = HomeLock(self.home)
                    replacement.close()
                    break
                except ComponentError:
                    if time.monotonic() > deadline:
                        self.fail("installer descendant still holds the inherited lock")
                    time.sleep(.01)
        finally:
            lock.close()
            if helper.poll() is None:
                NativeComponent._terminate_helper(helper)

    def test_installer_gate_prevents_native_start_and_releases_acquired_lock(self):
        installing = self.home / ".installer-lock"
        for kind in ("directory", "dangling_symlink"):
            if kind == "directory":
                installing.mkdir()
            else:
                installing.symlink_to(self.home / "absent")
            with self.assertRaises(ComponentError) as caught:
                HomeLock(self.home)
            self.assertEqual(caught.exception.code, "busy")
            installing.rmdir() if kind == "directory" else installing.unlink()
        # Installer can begin between the first check and flock acquisition.
        original = Path.exists
        seen = 0
        def exists(path):
            nonlocal seen
            if path == installing:
                seen += 1
                if seen == 2:
                    installing.mkdir()
            return original(path)
        with patch.object(Path, "exists", exists), self.assertRaises(ComponentError) as caught:
            HomeLock(self.home)
        self.assertEqual(caught.exception.code, "busy")
        installing.rmdir()
        replacement = HomeLock(self.home)
        replacement.close()

    def test_settings_replace_links_without_touching_their_targets(self):
        component = self.make()
        outside = Path(self.temp.name) / "outside-state"
        temp = component.state_path.with_suffix(".json.tmp")
        for kind in ("symlink", "hardlink"):
            outside.write_text("keep")
            if kind == "symlink":
                temp.symlink_to(outside)
            else:
                os.link(outside, temp)
            component._save_settings()
            self.assertEqual(outside.read_text(), "keep")
            temp.unlink()
        component.state_path.unlink()
        os.link(outside, component.state_path)
        component._save_settings()
        self.assertEqual(outside.read_text(), "keep")
        component.state_path.unlink()
        component.state_path.symlink_to(outside)
        with self.assertRaises(ComponentError):
            component._read_settings()
        with self.assertRaises(ComponentError):
            component._save_settings()
        self.assertEqual(outside.read_text(), "keep")

    def test_startup_failure_after_locking_releases_the_home(self):
        # The host answers the startup error for its lifetime; the terminal,
        # installer and a reconnecting host must still be able to take the home.
        state = self.home / "component-state.json"
        state.symlink_to(Path(self.temp.name) / "elsewhere.json")
        with self.assertRaises(ComponentError) as caught:
            self.make()
        self.assertEqual(caught.exception.status, 422)
        HomeLock(self.home).close()
        state.unlink()
        with patch("native_component.load_pin", side_effect=ValueError("damaged modelkit pin")), \
                self.assertRaisesRegex(ValueError, "damaged"):
            NativeComponent(self.home)
        HomeLock(self.home).close()

    def test_home_is_revalidated_after_lock_acquisition(self):
        with patch("native_component.validate_home", side_effect=ComponentError("not_installed", "removed")):
            with self.assertRaises(ComponentError):
                HomeLock(self.home)
        replacement = HomeLock(self.home)
        replacement.close()

    @unittest.skipIf(os.name == "nt", "POSIX maintenance command")
    def test_terminal_maintenance_respects_native_lock_and_confirmation(self):
        (self.home / ".anagram-home").write_text("owned")
        app = self.home / "app"
        app.mkdir()
        for name in ("native_component.py", "runtime_controller.py", "download_modelkit.py", "model_plan.py", "safe_files.py", "modelkit.json"):
            shutil.copyfile(DAEMON / name, app / name)
        (app / "native_registration.py").write_text(
            "import pathlib,sys\npathlib.Path(sys.argv[-1], 'helper-called').write_text(sys.argv[1])\n")
        (self.home / "bin").mkdir()
        command = self.home / "bin/anagram"
        shutil.copyfile(DAEMON.parent / "installer/anagram", command)
        command.chmod(0o700)
        (self.home / "venv/bin").mkdir(parents=True)
        (self.home / "venv/bin/python").symlink_to(sys.executable)
        component = self.make()
        env = {**os.environ, "HOME": str(self.temp.name)}
        busy = subprocess.run([str(command), "update"], env=env, capture_output=True, text=True)
        self.assertNotEqual(busy.returncode, 0)
        self.assertIn("Another browser", busy.stderr)
        self.assertFalse((self.home / "helper-called").exists())
        component.close()
        confirmed = subprocess.run([str(command), "update"], env=env, capture_output=True, text=True)
        self.assertEqual(confirmed.returncode, 0, confirmed.stderr)
        self.assertEqual((self.home / "helper-called").read_text(), "update")
        denied = subprocess.run([str(command), "uninstall"], env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True)
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual((self.home / "helper-called").read_text(), "update")

    def test_download_pause_and_explicit_resume_survive_reconnect(self):
        entered = threading.Event()
        def slow(cancel, progress):
            entered.set()
            cancel.wait(3)
            raise DownloadPaused()
        component = self.make(downloader=slow)
        component.start()
        self.assertTrue(entered.wait(2))
        self.assertEqual(component.handle("models.pause", {})[0], 202)
        self.finish(component)
        self.assertEqual(component.status()["state"], "paused")
        component.close()
        restarted = self.make()
        restarted.start()
        self.finish(restarted)
        self.assertEqual(self.downloads, 0)
        self.assertEqual(restarted.status()["state"], "paused")
        restarted.handle("models.download", {})
        self.finish(restarted)
        self.assertEqual(self.downloads, 1)
        self.assertEqual(restarted.status()["state"], "ready")

    def test_failed_download_requires_explicit_retry(self):
        def fail(*_):
            raise OSError("network unavailable")
        component = self.make(downloader=fail)
        component.start()
        self.finish(component)
        self.assertEqual(component.status()["error"]["code"], "download_failed")
        component.close()
        restarted = self.make()
        restarted.start()
        self.finish(restarted)
        self.assertEqual(self.downloads, 0)
        self.assertEqual(restarted.status()["state"], "needs_models")
        self.assertEqual(restarted.status()["error"]["message"], "network unavailable")
        restarted.handle("models.download", {})
        self.finish(restarted)
        self.assertEqual(self.downloads, 1)

    def test_engine_stop_persists_and_resume_restores_saved_selection(self):
        component = self.make()
        self.first_run(component)
        self.assertTrue(component.handle("health", {})[1]["ok"])
        score = component.handle("score", {"v": "2.1", "blocks": [{"id": "a", "text": "a paragraph"}]})[1]
        self.assertEqual(score["results"][0]["bucket"], 0)
        component.handle("engine.stop", {})
        self.finish(component)
        self.assertEqual(component.status()["state"], "stopped")
        component.close()
        restarted = self.make()
        restarted.start()
        self.finish(restarted)
        self.assertEqual(restarted.status()["state"], "stopped")
        self.assertIsNone(restarted.controller)
        restarted.handle("engine.resume", {})
        self.finish(restarted)
        self.assertEqual(restarted.status()["state"], "ready")
        self.assertEqual(self.downloads, 1)

    def test_idle_settings_persist_and_only_score_wakes_unloaded_engine(self):
        component = self.make()
        self.first_run(component)
        self.assertEqual(component.status()["settings"], {"idle_unload_s": 300})
        for value in (True, -1, 1, 59, 86401, 60.5, "300"):
            with self.subTest(value=value), self.assertRaises(ComponentError):
                component.handle("engine.settings", {"idle_unload_s": value})
        component.handle("engine.settings", {"idle_unload_s": 60})
        controller = component.controller
        activity = controller.last_activity
        component.handle("health", {})
        component.status()
        self.assertEqual(controller.last_activity, activity)
        controller.last_activity -= 61
        self.assertTrue(controller.unload_if_idle())
        self.finish(component)
        self.assertEqual(component.status()["state"], "idle")
        for _ in range(3):
            with self.assertRaises(ComponentError) as error:
                component.handle("health", {})
            self.assertEqual(error.exception.code, "engine_idle")
            component.handle("runtime", {})
            self.assertEqual(component.status()["state"], "idle")
        score = {"v": "2.1", "blocks": [{"id": "a", "text": "a paragraph"}]}
        response = host.dispatch(component, request("score", payload=score))
        self.assertEqual(response["status"], 200)
        self.finish(component)
        self.assertEqual(component.status()["state"], "ready")
        self.assertEqual(component.handle("score", score)[0], 200)
        component.handle("engine.stop", {})
        self.finish(component)
        response = host.dispatch(component, request("score", payload=score))
        self.assertEqual(response["status"], 503)
        self.assertIsNone(component.controller)
        component.close()
        restarted = self.make()
        restarted.start()
        self.finish(restarted)
        self.assertEqual(restarted.status()["settings"], {"idle_unload_s": 60})
        self.assertEqual(restarted.status()["state"], "stopped")

    def test_idle_score_wait_does_not_block_status_and_stop_rejects_it(self):
        component = self.make()
        self.first_run(component)
        controller = component.controller
        controller.last_activity -= 301
        controller.unload_if_idle()
        self.finish(component)
        entered, release = threading.Event(), threading.Event()
        factory = controller.factory
        def loading(candidate):
            entered.set()
            release.wait(3)
            return factory(candidate)
        controller.factory = loading
        replies = []
        score = {"v": "2.1", "blocks": [{"id": "a", "text": "a paragraph"}]}
        thread = threading.Thread(target=lambda: replies.append(host.dispatch(component, request("score", payload=score))))
        thread.start()
        self.assertTrue(entered.wait(1))
        self.assertEqual(component.status()["state"], "loading")
        self.assertEqual(replies, [])
        component.handle("engine.stop", {})
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(replies[0]["status"], 503)
        release.set()
        self.finish(component)
        self.assertEqual(component.status()["state"], "stopped")

    def test_engine_stop_lets_an_inflight_score_finish_then_unloads(self):
        component = self.make(stop_timeout=0.05)
        self.first_run(component)
        controller = component.controller
        entered, release = threading.Event(), threading.Event()
        closed = []
        engine = controller.engine
        engine.close = lambda: closed.append(True)
        def slow_score():
            with controller.use_engine():
                entered.set()
                release.wait(3)
        scorer = threading.Thread(target=slow_score)
        scorer.start()
        self.assertTrue(entered.wait(2))
        self.assertEqual(component.handle("engine.stop", {})[0], 202)
        time.sleep(0.3)  # well past stop_timeout: the stop must wait, not fail
        self.assertEqual(component.status()["state"], "loading")
        self.assertTrue(json.loads((self.home / "component-state.json").read_text())["engine_stopped"])
        self.assertEqual(closed, [])
        release.set()
        scorer.join(2)
        self.finish(component)
        status = component.status()
        self.assertEqual(status["state"], "stopped")
        self.assertIsNone(status["error"])
        self.assertIsNone(component.controller)
        self.assertEqual(closed, [True])

    def test_internal_failures_are_host_errors_not_client_errors(self):
        component = self.make()
        self.first_run(component)
        score = {"v": "2.1", "blocks": [{"id": "a", "text": "a paragraph"}]}
        engine = component.controller.engine
        engine.score = lambda texts: [{"bucket": "not a bucket", "probs": [1., 0., 0., 0.], "score": 0.,
                                       "tokens": 8, "truncated": False} for _ in texts]  # fails response validation
        response = host.dispatch(component, request("score", payload=score))
        self.assertEqual((response["status"], response["error"]["code"]), (500, "internal_error"))
        def invalid_logits(_texts):
            raise ValueError("runtime returned invalid EditLens logits")
        engine.score = invalid_logits
        response = host.dispatch(component, request("score", payload=score))
        self.assertEqual((response["status"], response["error"]["code"]), (500, "internal_error"))
        self.assertNotIn("logits", response["error"]["message"])
        # Request validation stays a client error.
        response = host.dispatch(component, request("score", payload={"v": "9.0", "blocks": []}))
        self.assertEqual((response["status"], response["error"]["code"]), (422, "invalid_request"))
        for op, payload in (("runtime.config", {"id": "onnx:cpu:int8"}), ("runtime.benchmark", {"budget_s": 5})):
            response = host.dispatch(component, request(op, payload=payload))
            self.assertEqual((response["status"], response["error"]["code"]), (422, "invalid_request"), op)
        self.assertEqual(component.status()["state"], "ready")

    def test_legacy_component_settings_receive_default_idle_timeout(self):
        component = self.make()
        self.first_run(component)
        component.close()
        saved = json.loads((self.home / "component-state.json").read_text())
        saved.pop("idle_unload_s")
        (self.home / "component-state.json").write_text(json.dumps(saved))
        restarted = self.make()
        self.assertEqual(restarted.settings["idle_unload_s"], 300)
        self.assertFalse(restarted.settings["engine_stopped"])

    def test_device_planning_precedes_download_and_status_stays_responsive(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def plan(profile):
            calls.append(("plan", profile))
            entered.set()
            release.wait(3)
            return {"profile": profile, "devices": ["Fixture GPU"],
                    "candidate_ids": ["torch:cpu:fp32"], "selected_paths": ["fixture"],
                    "total_bytes": 8}
        def download(cancel, progress):
            calls.append(("download", component.plan["profile"]))
            self.download(cancel, progress)
        component = self.make(planner=plan, downloader=download)
        component.start()
        try:
            self.assertTrue(entered.wait(2))
            status = component.handle("status", {})[1]
            self.assertEqual(status["download"]["phase"], "detecting")
            self.assertEqual(status["download"]["total_bytes"], 0)
            self.assertEqual(self.downloads, 0)
        finally:
            release.set()
        self.finish(component)
        self.assertEqual(calls, [("plan", "recommended"), ("download", "recommended")])
        plan = component.status()["download"]["plan"]
        self.assertEqual(set(plan), {"devices", "total_bytes"})
        self.assertEqual(plan["devices"], ["Fixture GPU"])

    def test_download_payload_carries_no_profile_and_the_terminal_choice_is_reused(self):
        calls = []
        def plan(profile):
            calls.append(profile)
            return {"profile": profile, "devices": ["Fixture CPU"], "candidate_ids": ["torch:cpu:fp32"],
                    "selected_paths": ["fixture"], "total_bytes": 8}
        component = self.make(planner=plan)
        self.first_run(component)
        for payload in ({"profile": "recommended"}, {"profile": "expanded"}, {"profile": None}, {"url": "https://example.com"}):
            with self.subTest(payload=payload), self.assertRaises(ComponentError):
                component.handle("models.download", payload)
        self.assertEqual(calls, ["recommended"])
        component.close()
        # prepare_models.py --profile expanded records the choice in the component state.
        path = self.home / "component-state.json"
        path.write_text(json.dumps({**json.loads(path.read_text()), "model_profile": "expanded"}))
        restarted = self.make(planner=plan)
        self.first_run(restarted)
        self.assertEqual(calls, ["recommended", "expanded"])
        restarted.handle("models.download", {})
        self.finish(restarted)
        self.assertEqual(calls, ["recommended", "expanded", "expanded"])
        self.assertEqual(json.loads(path.read_text())["model_profile"], "expanded")

    def test_pause_while_detecting_never_starts_a_download(self):
        entered, release = threading.Event(), threading.Event()
        def plan(profile):
            entered.set()
            release.wait(3)
            return {"profile": profile, "devices": [], "selected_paths": ["fixture"], "total_bytes": 8}
        component = self.make(planner=plan)
        component.start()
        try:
            self.assertTrue(entered.wait(2))
            component.handle("models.pause", {})
        finally:
            release.set()
        self.finish(component)
        self.assertEqual(self.downloads, 0)
        self.assertEqual(component.status()["state"], "paused")

    def test_preferences_without_a_profile_default_to_recommended_and_grant_nothing(self):
        saved = {**STATE_DEFAULT, "initialized": True, "download_pending": True}
        saved.pop("model_profile")
        path = self.home / "component-state.json"
        path.write_text(json.dumps(saved))
        (self.home / "runtime.json").write_text(json.dumps({"schema_version": 1, "selected_id": "onnx:cpu:int8"}))
        plans = []
        def build_plan(_pin, _hardware, profile="recommended"):
            plans.append(profile)
            return {"schema_version": 1, "profile": profile, "devices": ["Fixture CPU"],
                    "candidate_ids": ["torch:cpu:fp32"], "selected_paths": ["fixture"], "total_bytes": 8}
        with patch("model_plan.discover_hardware", return_value={"fixture": True}), \
                patch("model_plan.build_plan", side_effect=build_plan):
            component = self.make(planner=None)  # the real planner, without any migration
            self.assertEqual(component.settings["model_profile"], "recommended")
            component.start()
            self.finish(component)
        self.assertEqual(plans, ["recommended"])
        self.assertEqual(self.downloads, 1)
        self.assertEqual(json.loads(path.read_text())["model_profile"], "recommended")
        self.assertEqual(component.status()["runtime"]["active_id"], "torch:cpu:fp32")

    def test_selected_download_verification_expansion_and_restart_use_the_same_plan(self):
        from urllib.parse import unquote
        contents = {"model.safetensors": b"source", "onnx/model.onnx": b"fp32",
                    "onnx/model_int8.onnx": b"int8", "config.json": b"config", "LICENSE": b"license"}
        entries = [{"path": name, "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                   for name, data in contents.items()]
        self.pin = {"schema_version": 1, "repository": "fixture/model", "revision": "a" * 40, "files": entries}
        lid = {"path": "lid.176.ftz", "size_bytes": 3, "sha256": hashlib.sha256(b"lid").hexdigest()}
        def planner(profile):
            selected = entries if profile == "expanded" else [e for e in entries if not e["path"].startswith("onnx/")]
            return {"profile": profile, "devices": ["CPU", "MPS"],
                    "candidate_ids": ["torch:cpu:fp32"], "selected_paths": [e["path"] for e in selected],
                    "total_bytes": sum(e["size_bytes"] for e in selected)}
        requests = []
        def open_fixture(request, timeout):
            name = unquote(request.full_url.split(self.pin["revision"] + "/", 1)[-1])
            data = b"lid" if request.full_url.endswith("/lid.176.ftz") else contents[name]
            requests.append("lid.176.ftz" if data == b"lid" else name)
            result = io.BytesIO(data)
            result.status, result.headers = 200, {}
            return result
        with patch("native_component.LID_ENTRY", lid), patch("download_modelkit.transfer_asset", lambda *a, **kw: transfer_with(open_fixture)(*a, **{k:v for k,v in kw.items() if k != "notice"})):
            component = self.make(downloader=None, verifier=None, planner=planner)
            self.first_run(component)
            self.assertEqual(set(requests), {"model.safetensors", "config.json", "LICENSE", "lid.176.ftz"})
            self.assertFalse((component.model_dir / "onnx").exists())
            self.assertEqual(component.status()["download"]["total_bytes"], 22)
            component.close()
            requests.clear()
            restarted = self.make(downloader=None, verifier=None, planner=planner)
            self.first_run(restarted)
            self.assertEqual(requests, [])
            restarted.close()
            # The terminal's expanded preparation is recorded in the state and reused.
            state = self.home / "component-state.json"
            state.write_text(json.dumps({**json.loads(state.read_text()), "model_profile": "expanded"}))
            expanded = self.make(downloader=None, verifier=None, planner=planner)
            expanded.start()
            self.finish(expanded)
            self.assertEqual(expanded.status()["state"], "needs_models")  # planned ONNX files are absent
            expanded.handle("models.download", {})
            self.finish(expanded)
            self.assertEqual(set(requests), {"onnx/model.onnx", "onnx/model_int8.onnx"})
            self.assertEqual(expanded.status()["state"], "ready")
            self.assertEqual(expanded.plan["profile"], "expanded")
            self.assertTrue((expanded.model_dir / "onnx/model_int8.onnx").is_file())
            self.assertEqual(expanded.status()["download"]["total_bytes"], 22 + 4 + 4)

    def test_delete_requires_confirmation_and_never_redownloads_on_reopen(self):
        component = self.make()
        self.first_run(component)
        sentinel = Path(self.temp.name) / "unrelated"
        sentinel.write_text("keep")
        for payload in ({}, {"confirm": False}, {"confirm": True, "path": str(sentinel)}):
            with self.assertRaises(ComponentError):
                component.handle("models.delete", payload)
        component.handle("models.delete", {"confirm": True})
        self.finish(component)
        status = component.status()
        self.assertEqual(status["state"], "needs_models")
        self.assertEqual(status["operation"]["status"], "completed")
        self.assertTrue(status["operation"]["receipt"])
        self.assertFalse((self.home / "models").exists())
        self.assertEqual(sentinel.read_text(), "keep")
        component.close()
        restarted = self.make()
        restarted.start()
        self.finish(restarted)
        self.assertEqual(restarted.status()["state"], "needs_models")
        self.assertEqual(self.downloads, 1)

    def test_lifecycle_jobs_wait_past_the_stop_timeout_for_an_inflight_score(self):
        # Deletion goes last: the next component would otherwise need models again.
        for op, payload, final in (("engine.resume", {}, "ready"), ("models.download", {}, "ready"),
                                   ("component.update", {}, "stopped"),
                                   ("component.uninstall", {"confirm": True}, "stopped"),
                                   ("models.delete", {"confirm": True}, "needs_models")):
            with self.subTest(op=op):
                component = self.make(stop_timeout=0.05, helper=lambda _: {"status": "completed"})
                self.first_run(component)
                controller = component.controller
                entered, release = threading.Event(), threading.Event()
                def slow_score():
                    with controller.use_engine():
                        entered.set()
                        release.wait(3)
                scorer = threading.Thread(target=slow_score)
                scorer.start()
                try:
                    self.assertTrue(entered.wait(2))
                    self.assertEqual(component.handle(op, payload)[0], 202)
                    time.sleep(0.3)  # well past stop_timeout: the job must wait, not fail
                    status = component.status()
                    self.assertNotEqual(status["state"], "error", status)
                    self.assertIsNone(status["error"])
                    self.assertTrue((self.home / "models").exists())
                    with self.assertRaises(ComponentError) as caught:
                        component.handle("engine.stop", {})
                    self.assertEqual(caught.exception.code, "busy")  # still one lifecycle job at a time
                finally:
                    release.set()
                    scorer.join(2)
                self.finish(component)
                status = component.status()
                self.assertEqual(status["state"], final, status)
                self.assertIsNone(status["error"])
                component.close()
        self.assertFalse((self.home / "models").exists())

    def test_lifecycle_job_waits_for_an_uncancellable_load_past_the_stop_timeout(self):
        component = self.make(stop_timeout=0.05)
        self.first_run(component)
        controller = component.controller
        entered, release = threading.Event(), threading.Event()
        factory = controller.factory
        def loading(candidate):
            entered.set()
            release.wait(3)
            return factory(candidate)
        controller.factory = loading
        try:
            self.assertEqual(component.handle("runtime.config", {"id": "torch:cpu:fp32"})[0], 202)
            self.assertTrue(entered.wait(2))
            component.handle("models.delete", {"confirm": True})
            time.sleep(0.3)
            status = component.status()
            self.assertEqual(status["operation"]["status"], "running", status)
            self.assertIsNone(status["error"])
        finally:
            release.set()
        self.finish(component)
        self.assertEqual(component.status()["state"], "needs_models")
        self.assertEqual(component.status()["operation"]["status"], "completed")
        self.assertFalse((self.home / "models").exists())

    def test_owned_tree_links_are_not_followed_during_delete(self):
        component = self.make()
        self.first_run(component)
        outside = Path(self.temp.name) / "keep"
        outside.mkdir()
        (outside / "value").write_text("safe")
        (self.home / "models/link").symlink_to(outside, target_is_directory=True)
        component.handle("models.delete", {"confirm": True})
        self.finish(component)
        self.assertEqual(component.status()["state"], "error")
        self.assertEqual((outside / "value").read_text(), "safe")

    def test_models_root_link_cannot_redirect_deletion(self):
        component = self.make()
        self.first_run(component)
        outside = Path(self.temp.name) / "outside-models"
        (self.home / "models").rename(outside)
        (self.home / "models").symlink_to(outside, target_is_directory=True)
        component.handle("models.delete", {"confirm": True})
        self.finish(component)
        self.assertEqual(component.status()["state"], "error")
        self.assertEqual((outside / "fixture").read_bytes(), b"fixture!")

    def test_deleting_owned_hardlink_preserves_external_file(self):
        component = self.make()
        self.first_run(component)
        outside = Path(self.temp.name) / "outside-keep"
        outside.write_bytes(b"keep")
        os.link(outside, self.home / "models/linked-file")
        component.handle("models.delete", {"confirm": True})
        self.finish(component)
        self.assertEqual(component.status()["state"], "needs_models")
        self.assertEqual(outside.read_bytes(), b"keep")

    def test_maintenance_only_completes_after_helper_success(self):
        entered, release = threading.Event(), threading.Event()
        def helper(name):
            self.assertEqual(name, "uninstall")
            entered.set()
            release.wait(3)
            return {"status": "completed"}
        component = self.make(helper=helper)
        self.first_run(component)
        status = component.handle("component.uninstall", {"confirm": True})[1]
        self.assertEqual(status["operation"]["status"], "running")
        self.assertIsNone(status["operation"]["receipt"])
        self.assertTrue(entered.wait(2))
        release.set()
        self.finish(component)
        status = component.status()
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(status["operation"]["status"], "completed")
        self.assertTrue(status["operation"]["receipt"])

    def test_scheduled_windows_maintenance_never_mints_completion_receipt(self):
        component = self.make(helper=lambda _: {"status": "scheduled"})
        self.first_run(component)
        component.handle("component.uninstall", {"confirm": True})
        self.finish(component)
        self.assertEqual(component.status()["operation"]["status"], "scheduled")
        self.assertIsNone(component.status()["operation"]["receipt"])
        self.assertTrue(component.exit_requested.is_set())

    def test_update_hands_only_a_strict_extension_version_to_the_helper(self):
        calls = []
        component = self.make(helper=lambda *args: calls.append(args) or {"status": "completed"})
        self.first_run(component)
        for payload in ({"version": "v0.6.1"}, {"version": "0.6"}, {"version": "0.6.1-rc.1"}, {"version": "01.6.1"},
                        {"version": "0.6.1\n"}, {"version": "\u0660.\u0666.\u0661"}, {"version": 6}, {"version": None},
                        {"version": "0.6.1", "url": "https://example.com"}, {"url": "https://example.com"}):
            with self.subTest(payload=payload), self.assertRaises(ComponentError) as caught:
                component.handle("component.update", payload)
            self.assertEqual((caught.exception.code, caught.exception.status), ("invalid_request", 422))
        component.handle("component.update", {"version": "0.6.1"})
        self.finish(component)
        self.assertEqual(calls, [("update", "0.6.1")])

    @unittest.skipIf(os.name == "nt", "POSIX maintenance helper")
    def test_helper_command_carries_the_pinned_release(self):
        app = self.home / "app"
        app.mkdir()
        (app / "native_registration.py").write_text(
            "import json,pathlib,sys\npathlib.Path(sys.argv[-1], 'argv.json').write_text(json.dumps(sys.argv[1:]))\n"
            "print(json.dumps({'status': 'completed'}))\n")
        component = self.make()
        self.assertEqual(component._run_helper("update", "0.6.1"), {"status": "completed"})
        argv = json.loads((self.home / "argv.json").read_text())
        self.assertEqual(argv[:3], ["update", "--release", "0.6.1"])
        self.assertEqual(argv[-2:], ["--home", str(self.home.resolve())])
        component._run_helper("update")
        self.assertNotIn("--release", json.loads((self.home / "argv.json").read_text()))

    def test_completed_update_reconnects_without_a_settings_status_poll(self):
        component = self.make(helper=lambda _: {"status": "completed"})
        self.first_run(component)
        component.handle("component.update", {})
        self.finish(component)
        for op in ("health", "runtime"):
            with self.subTest(op=op), self.assertRaises(ComponentError) as caught:
                component.handle(op, {})
            self.assertEqual((caught.exception.code, caught.exception.status), ("component_updated", 503))
        # A settings poll still receives its truthful completed acknowledgement.
        self.assertEqual(component.handle("status", {})[1]["operation"]["status"], "completed")
        component.close()
        restarted = self.make()
        restarted.start()
        self.finish(restarted)
        self.assertIsNone(restarted.status()["operation"])
        self.assertTrue(restarted.handle("health", {})[1]["ok"])
        self.assertEqual(self.downloads, 1)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.content = b"0123456789" * 20000
        self.entry = {"path": "weights", "size_bytes": len(self.content),
                      "sha256": hashlib.sha256(self.content).hexdigest()}
        self.calls = []

    def opener(self, request, timeout):
        self.assertEqual(timeout, 60)
        self.assertFalse(request.has_header("Authorization"))
        start = int(request.get_header("Range", "bytes=0-")[6:-1])
        self.calls.append(start)
        response = io.BytesIO(self.content[start:])
        response.status = 206 if start else 200
        response.headers = {"Content-Range": f"bytes {start}-{len(self.content)-1}/{len(self.content)}"} if start else {}
        return response

    def test_pause_keeps_partial_then_range_resume_verifies(self):
        cancel = threading.Event()
        target = self.root / "weights"
        def progress(received):
            if received >= 65536:
                cancel.set()
        with self.assertRaises(DownloadPaused):
            download_asset("https://example.test/pinned", target, self.entry, cancel=cancel,
                           progress=progress, transfer=transfer_with(self.opener))
        self.assertFalse(target.exists())
        part = self.root / "weights.part"
        self.assertGreater(part.stat().st_size, 0)
        offset = part.stat().st_size
        cancel.clear()
        download_asset("https://example.test/pinned", target, self.entry, cancel=cancel, transfer=transfer_with(self.opener))
        self.assertEqual(self.calls, [0, offset])
        self.assertEqual(target.read_bytes(), self.content)
        self.assertFalse(part.exists())

    def test_checksum_failure_never_replaces_installed_bytes(self):
        target = self.root / "weights"
        target.write_bytes(b"old")
        bad = {**self.entry, "sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "Checksum"):
            download_asset("https://example.test/pinned", target, bad, transfer=transfer_with(self.opener))
        self.assertEqual(target.read_bytes(), b"old")
        self.assertFalse((self.root / "weights.part").exists())

    def test_streaming_install_commits_only_verified_files_and_reuses(self):
        pin = {"schema_version": 1, "repository": "fixture/model", "revision": "a" * 40, "files": [self.entry]}
        target = self.root / "model"
        progress = []
        install_streaming(target, pin, transfer=transfer_with(self.opener), progress=lambda *x: progress.append(x))
        self.assertEqual(invalid_files(target, pin), [])
        before = (target / "weights").stat().st_ctime_ns
        install_streaming(target, pin, transfer=transfer_with(self.opener))
        self.assertEqual(self.calls, [0])
        self.assertEqual((target / "weights").stat().st_ctime_ns, before)
        self.assertEqual(progress[-1], (len(self.content), len(self.content), None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
