"""Terminal preparation: owned files, recovery state and no inference startup."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "anagramd"))
from native_component import HOST_NAME, HomeLock, STATE_DEFAULT
from prepare_models import prepare


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.cwd = Path.cwd()
        self.addCleanup(lambda: os.chdir(self.cwd))
        (self.home / ".native-component.json").write_text(json.dumps({
            "schema_version": 1, "host": HOST_NAME, "home": str(self.home)}))
        self.entry = {"path": "weights", "size_bytes": 4, "sha256": hashlib.sha256(b"data").hexdigest()}
        self.pin = {"schema_version": 1, "repository": "fixture/model", "revision": "a"*40, "files": [self.entry]}
        self.manifest = self.home / "pin.json"
        self.manifest.write_text(json.dumps(self.pin))
        self.plan = {"selected_paths": ["weights"], "total_bytes": 4, "devices": ["CPU"], "profile": "recommended"}
        self.requests = 0

    def run_prepare(self, transfer=None, installer=False):
        def download(url, part, size, offset, **kwargs):
            self.requests += 1
            part.write_bytes(b"data")
            kwargs["progress"](4)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch("native_host.configure_environment"))
            stack.enter_context(patch("download_modelkit.PIN", self.manifest))
            stack.enter_context(patch("download_modelkit.LID_ENTRY", self.entry))
            stack.enter_context(patch("download_modelkit.transfer_asset", transfer or download))
            stack.enter_context(patch.dict(sys.modules, {"model_plan": SimpleNamespace(
                discover_hardware=lambda: {}, build_plan=lambda *a: self.plan)}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            prepare(self.home, installer=installer)

    def test_success_commits_state_and_rerun_does_not_download(self):
        self.run_prepare()
        state = json.loads((self.home / "component-state.json").read_text())
        self.assertTrue(state["initialized"])
        self.assertFalse(state["download_pending"])
        self.assertFalse(state["download_failed"])
        self.assertFalse((self.home / "runtime.json").exists())
        self.run_prepare()
        self.assertEqual(self.requests, 2)

    def test_failure_preserves_partial_and_download_only_retry_recovers(self):
        def fail(url, part, *args, **kwargs):
            part.write_bytes(b"da")
            raise RuntimeError("fixture connection interrupted")
        with self.assertRaises(SystemExit):
            self.run_prepare(fail)
        self.assertEqual((self.home / "models/.incoming-editlens_roberta-large/weights.part").read_bytes(), b"da")
        self.assertTrue(json.loads((self.home / "component-state.json").read_text())["download_failed"])
        self.assertIn("connection interrupted", (self.home / "download-error.json").read_text())
        self.run_prepare()
        self.assertFalse(json.loads((self.home / "component-state.json").read_text())["download_failed"])

    def test_installer_keeps_explicit_pause_or_deleted_models(self):
        (self.home / ".installer-lock").mkdir()
        for setting in ("download_paused", "models_deleted"):
            state = {**STATE_DEFAULT, "initialized": True, setting: True}
            (self.home / "component-state.json").write_text(json.dumps(state))
            self.run_prepare(installer=True)
            self.assertEqual(json.loads((self.home / "component-state.json").read_text()), state)
        self.assertEqual(self.requests, 0)

    def test_download_only_command_refuses_active_host(self):
        with contextlib.closing(HomeLock(self.home)):
            with self.assertRaisesRegex(Exception, "Another browser"):
                self.run_prepare()
        self.assertFalse((self.home / "component-state.json").exists())


if __name__ == "__main__":
    unittest.main()
