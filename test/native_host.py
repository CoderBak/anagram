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

DAEMON = Path(__file__).resolve().parents[1] / "anagramd"
sys.path.insert(0, str(DAEMON))
import native_host as host
from native_component import ComponentError, HOST_NAME, NativeComponent
from download_modelkit import DownloadPaused, download_asset, install_streaming, invalid_files
from runtime_controller import Candidate, RuntimeController


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
        class Reader:
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
        reader, writer = Reader(), Writer()
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

    def test_host_import_does_not_import_model_libraries(self):
        code = "import sys;sys.path.insert(0,sys.argv[1]);import native_host;print([n for n in ('torch','transformers','onnxruntime') if n in sys.modules])"
        result = subprocess.run([sys.executable, "-I", "-c", code, str(DAEMON)], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "[]")

    def test_host_contains_relative_dependency_files_in_owned_home(self):
        code = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import native_host, native_component
class Component:
    def __init__(self, home): self.home = Path(home).resolve()
    def start(self): Path('dependency-session').write_text('fixture')
    def handle(self, op, payload): return 200, {'cwd': str(Path.cwd())}
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
                                    input=frame(request()), capture_output=True, cwd=launch, check=True)
            self.assertEqual(replies(result.stdout)[0]["data"]["cwd"], str(home.resolve()))
            self.assertTrue((home / "dependency-session").is_file())
            self.assertEqual(list(launch.iterdir()), [])

    def test_browser_launch_arguments_are_metadata_only(self):
        chrome = host.parse_args(["--home", "/tmp/owned", "chrome-extension://example/", "--parent-window=123"])
        self.assertEqual((chrome.caller, chrome.addon_id, chrome.parent_window), ("chrome-extension://example/", None, "123"))
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
        component = NativeComponent(self.home, pin=self.pin,
                                    downloader=kwargs.pop("downloader", self.download),
                                    verifier=lambda: (self.home / "models/fixture").is_file(),
                                    controller_factory=self.factory, **kwargs)
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
        component.start()
        self.finish(component)
        self.assertEqual(component.status()["state"], "awaiting_selection")

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

    @unittest.skipIf(os.name == "nt", "POSIX maintenance command")
    def test_terminal_maintenance_respects_native_lock_and_confirmation(self):
        (self.home / ".anagram-home").write_text("owned")
        app = self.home / "app"
        app.mkdir()
        for name in ("native_component.py", "runtime_controller.py", "download_modelkit.py", "modelkit.json"):
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
        self.assertEqual(restarted.status()["state"], "awaiting_selection")

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
        restarted.handle("models.download", {})
        self.finish(restarted)
        self.assertEqual(self.downloads, 1)

    def test_engine_stop_persists_and_resume_restores_saved_selection(self):
        component = self.make()
        self.first_run(component)
        component.handle("runtime.config", {"id": "torch:cpu:fp32"})
        self.finish(component)
        self.assertEqual(component.status()["state"], "ready")
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

    def test_delete_waits_for_an_inflight_engine_lease(self):
        component = self.make()
        self.first_run(component)
        component.handle("runtime.config", {"id": "torch:cpu:fp32"})
        self.finish(component)
        controller = component.controller
        with controller.use_engine():
            component.handle("models.delete", {"confirm": True})
            time.sleep(0.1)
            self.assertTrue((self.home / "models").exists())
            self.assertEqual(component.status()["operation"]["status"], "running")
        self.finish(component)
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

    def test_completed_update_reconnects_without_a_settings_status_poll(self):
        component = self.make(helper=lambda _: {"status": "completed"})
        self.first_run(component)
        component.handle("runtime.config", {"id": "torch:cpu:fp32"})
        self.finish(component)
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
        self.assertEqual(timeout, 10)
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
                           progress=progress, opener=self.opener)
        self.assertFalse(target.exists())
        part = self.root / "weights.part"
        self.assertGreater(part.stat().st_size, 0)
        offset = part.stat().st_size
        cancel.clear()
        download_asset("https://example.test/pinned", target, self.entry, cancel=cancel, opener=self.opener)
        self.assertEqual(self.calls, [0, offset])
        self.assertEqual(target.read_bytes(), self.content)
        self.assertFalse(part.exists())

    def test_checksum_failure_never_replaces_installed_bytes(self):
        target = self.root / "weights"
        target.write_bytes(b"old")
        bad = {**self.entry, "sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "Checksum"):
            download_asset("https://example.test/pinned", target, bad, opener=self.opener)
        self.assertEqual(target.read_bytes(), b"old")
        self.assertFalse((self.root / "weights.part").exists())

    def test_streaming_install_commits_only_verified_files_and_reuses(self):
        pin = {"repository": "fixture/model", "revision": "a" * 40, "files": [self.entry]}
        target = self.root / "model"
        progress = []
        install_streaming(target, pin, opener=self.opener, progress=lambda *x: progress.append(x))
        self.assertEqual(invalid_files(target, pin), [])
        before = (target / "weights").stat().st_ctime_ns
        install_streaming(target, pin, opener=self.opener)
        self.assertEqual(self.calls, [0])
        self.assertEqual((target / "weights").stat().st_ctime_ns, before)
        self.assertEqual(progress[-1], (len(self.content), len(self.content), None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
