"""Offline modelkit tests and tiny installer fixtures; no ML dependencies or downloads."""
import contextlib
import hashlib
import importlib.util
import io
from urllib.parse import unquote
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

SOURCE = Path(__file__).resolve().parents[1] / "anagramd" / "download_modelkit.py"
sys.path.insert(0, str(SOURCE.parent))
from transfer_fixture import transfer_with
# Tiny fixtures can run without ML dependencies. A stdlib-only run explicitly skips
# the OS-lock regression; the installed application requires real filelock.
try:
    import filelock
    HAS_FILELOCK = True
except ImportError:
    HAS_FILELOCK = False
    sys.modules["filelock"] = types.SimpleNamespace(FileLock=lambda *a, **k: contextlib.nullcontext())


def module(path=SOURCE):
    spec = importlib.util.spec_from_file_location("download_modelkit_test", path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def pin_for(contents):
    return {"schema_version": 1, "repository": "fixture/model", "revision": "a" * 40,
            "files": [{"path": name, "size_bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                      for name, value in contents.items()]}


def write_files(root, contents):
    for name, value in contents.items():
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(value)


class ModelkitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "model"
        self.contents = {"model.safetensors": b"original", "onnx/model.onnx": b"fp32",
                         "onnx/model_fp16.onnx": b"fp16", "onnx/model_int8.onnx": b"int8",
                         "tokenizer.json": b"tokenizer", "LICENSE": b"CC", "NOTICE": b"authors"}
        self.pin = pin_for(self.contents)
        self.mod = module()
        self.calls = []

    def opener(self, request, timeout):
        self.assertFalse(request.has_header("Authorization"))
        prefix = "https://huggingface.co/fixture/model/resolve/" + self.pin["revision"] + "/"
        self.assertTrue(request.full_url.startswith(prefix))
        name = unquote(request.full_url[len(prefix):])
        self.calls.append(name)
        response = io.BytesIO(self.contents[name])
        response.status, response.headers = 200, {}
        return response

    def install(self, **kwargs):
        self.mod.install_streaming(self.target, self.pin, transfer=transfer_with(kwargs.pop("opener", self.opener), self.mod.DownloadPaused), **kwargs)

    def test_all_files_anonymous_and_valid_noop(self):
        self.install()
        self.assertEqual(len(self.calls), len(self.contents))
        self.assertEqual(self.mod.invalid_files(self.target, self.pin), [])
        self.calls.clear()
        before = {p: p.stat().st_mtime_ns for p in self.target.rglob("*")}
        self.install()
        self.assertEqual(self.calls, [])
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in self.target.rglob("*")})

    def test_valid_existing_and_staged_files_reused(self):
        write_files(self.target, {"model.safetensors": self.contents["model.safetensors"]})
        write_files(self.root / ".incoming-model", {"onnx/model.onnx": self.contents["onnx/model.onnx"]})
        self.install()
        names = set(self.calls)
        self.assertNotIn("model.safetensors", names)
        self.assertNotIn("onnx/model.onnx", names)

    def test_tampered_download_preserves_installed_tree(self):
        write_files(self.target, {"model.safetensors": b"old"})
        def bad(request, timeout):
            response = io.BytesIO(b"corrupt!")
            response.status, response.headers = 200, {}
            return response
        with self.assertRaisesRegex(ValueError, "Checksum or size mismatch"):
            self.install(opener=bad)
        self.assertEqual((self.target / "model.safetensors").read_bytes(), b"old")
        self.assertFalse((self.root / ".incoming-model" / "model.safetensors").exists())

    def test_corrupt_staged_file_is_downloaded_again(self):
        write_files(self.root / ".incoming-model", {"model.safetensors": b"bad"})
        self.install()
        self.assertIn("model.safetensors", self.calls)
        self.assertEqual(self.mod.invalid_files(self.target, self.pin), [])

    def test_cli_only_checks_local_files_without_mutation(self):
        write_files(self.target, self.contents)
        manifest = self.root / "pin.json"
        manifest.write_text(json.dumps(self.pin))
        before = {p: p.stat().st_mtime_ns for p in self.root.rglob("*")}
        with patch.object(sys, "argv", [str(SOURCE), "--model-dir", str(self.target), "--manifest", str(manifest), "--profile", "all"]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.mod.main(), 0)
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in self.root.rglob("*")})

    def test_recovery_after_interrupted_promotion(self):
        write_files(self.root / "model.old", self.contents)
        self.install()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.mod.invalid_files(self.target, self.pin), [])

    def test_hardlinked_partial_and_lock_never_truncate_external_files(self):
        outside = self.root / "outside"
        outside.write_bytes(b"keep")
        incoming = self.root / ".incoming-model"
        incoming.mkdir()
        part = incoming / "model.safetensors.part"
        os.link(outside, part)
        with self.assertRaisesRegex(ValueError, "hardlink"):
            self.install()
        self.assertEqual(outside.read_bytes(), b"keep")
        self.assertEqual(self.calls, [])
        part.unlink()
        lock = self.root / ".model.download.lock"
        lock.unlink(missing_ok=True)
        os.link(outside, lock)
        with self.assertRaisesRegex(ValueError, "hardlink"):
            self.install()
        self.assertEqual(outside.read_bytes(), b"keep")

    def test_partial_swapped_to_hardlink_during_request_is_rejected_before_write(self):
        outside = self.root / "outside"
        outside.write_bytes(b"keep")
        incoming = self.root / ".incoming-model"
        def swap(request, timeout):
            response = self.opener(request, timeout)
            os.link(outside, incoming / "model.safetensors.part")
            return response
        with self.assertRaisesRegex(ValueError, "linked"):
            self.install(opener=swap)
        self.assertEqual(outside.read_bytes(), b"keep")

    def test_symlink_and_path_traversal_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_text("keep")
        self.target.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink|symbolic link"):
            self.install()
        self.assertEqual((outside / "keep").read_text(), "keep")
        for name in ("../escape", "/escape", "onnx/../escape", "onnx\\escape", ".cache/escape"):
            self.pin["files"][0]["path"] = name
            manifest = self.root / "pin.json"
            manifest.write_text(json.dumps(self.pin))
            with self.assertRaises(ValueError):
                self.mod.load_pin(manifest)

    def test_insufficient_space_does_not_download_or_replace(self):
        write_files(self.target, {"model.safetensors": b"old"})
        with patch.object(self.mod.shutil, "disk_usage", return_value=types.SimpleNamespace(free=0)):
            with self.assertRaisesRegex(ValueError, "free disk space"):
                self.install()
        self.assertEqual(self.calls, [])
        self.assertEqual((self.target / "model.safetensors").read_bytes(), b"old")

    def test_symlinked_model_parent_refused(self):
        outside = self.root / "outside"
        outside.mkdir()
        parent = self.root / "models"
        parent.symlink_to(outside)
        self.target = parent / "model"
        with self.assertRaisesRegex(ValueError, "symlink|symbolic link"):
            self.install()
        self.assertEqual(list(outside.iterdir()), [])

    def test_complete_pin_matches_verified_payload_metadata(self):
        pin = self.mod.load_pin(SOURCE.with_name("modelkit.json"))
        self.assertEqual(pin["revision"], "f7cb4b06e5067ecdb66c566c7982a413f86f569f")
        names = {e["path"] for e in pin["files"]}
        self.assertTrue(set(self.contents) <= names)
        self.assertEqual(sum(e["size_bytes"] for e in pin["files"]), 4073892651)

    def test_subset_download_and_verification_ignore_missing_other_variants(self):
        selected = ["model.safetensors", "tokenizer.json", "LICENSE", "NOTICE"]
        events = []
        self.install(selected_paths=selected, progress=lambda *value: events.append(value))
        self.assertEqual(set(self.calls), set(selected))
        self.assertEqual(self.mod.invalid_files(self.target, self.pin, selected), [])
        self.assertEqual(set(self.mod.invalid_files(self.target, self.pin)), set(self.contents) - set(selected))
        total = sum(len(self.contents[name]) for name in selected)
        self.assertEqual(events[-1], (total, total, None))
        self.assertTrue(all(size == total and 0 <= received <= total for received, size, _ in events))

    def test_adding_one_pack_preserves_valid_installed_variants_by_hardlink(self):
        common = ["tokenizer.json", "LICENSE", "NOTICE"]
        self.install(selected_paths=common + ["model.safetensors"])
        original = self.target / "model.safetensors"
        inode = original.stat().st_ino
        before = {name: (self.target / name).stat().st_mtime_ns for name in common}
        self.calls.clear()
        # The new plan may omit the previously chosen manual model. Keep it anyway.
        self.install(selected_paths=common + ["onnx/model_fp16.onnx"])
        self.assertEqual(self.calls, ["onnx/model_fp16.onnx"])
        self.assertEqual(self.mod.invalid_files(self.target, self.pin, common + ["model.safetensors", "onnx/model_fp16.onnx"]), [])
        self.assertEqual(original.stat().st_ino, inode)
        self.assertEqual(before, {name: (self.target / name).stat().st_mtime_ns for name in common})

    def test_shrunk_scope_never_promotes_unselected_staging_or_parts(self):
        write_files(self.target, {"model.safetensors": self.contents["model.safetensors"],
                                  "onnx/model_int8.onnx": b"corrupt", "untracked": b"old"})
        incoming = self.root / ".incoming-model"
        write_files(incoming, {
            "onnx/model.onnx": self.contents["onnx/model.onnx"],
            "onnx/model_fp16.onnx.part": self.contents["onnx/model_fp16.onnx"],
            "tokenizer.json": self.contents["tokenizer.json"], "tokenizer.json.part": b"stale",
            ".cache/old": b"metadata", "untracked": b"stale",
        })
        self.install(selected_paths=["tokenizer.json", "NOTICE"])
        self.assertEqual(self.calls, ["NOTICE"])
        self.assertEqual({p.relative_to(self.target).as_posix() for p in self.target.rglob("*") if p.is_file()},
                         {"model.safetensors", "tokenizer.json", "NOTICE"})

    def test_resume_keeps_selected_range_bytes_but_discards_removed_pack(self):
        name = "onnx/model.onnx"
        self.contents[name] = b"x" * (128 * 1024 + 1)
        self.pin = pin_for(self.contents)
        cancel = threading.Event()
        def progress(received, _total, current):
            if current == name and received >= 64 * 1024:
                cancel.set()
        with self.assertRaises(self.mod.DownloadPaused):
            self.install(selected_paths=[name, "onnx/model_fp16.onnx"], cancel=cancel, progress=progress)
        incoming = self.root / ".incoming-model"
        part = incoming / (name + ".part")
        offset = part.stat().st_size
        self.assertEqual(offset, 64 * 1024)
        write_files(incoming, {"onnx/model_fp16.onnx": self.contents["onnx/model_fp16.onnx"]})
        requests = []
        def ranged(request, timeout):
            requests.append(request.get_header("Range"))
            if request.full_url.endswith(name):
                self.assertEqual(request.get_header("Range"), f"bytes={offset}-")
                self.assertFalse(request.has_header("Authorization"))
                response = io.BytesIO(self.contents[name][offset:])
                response.status = 206
                response.headers = {"Content-Range": f"bytes {offset}-{len(self.contents[name])-1}/{len(self.contents[name])}"}
                return response
            return self.opener(request, timeout)
        cancel.clear()
        self.install(selected_paths=[name, "tokenizer.json"], cancel=cancel, opener=ranged)
        self.assertIn(f"bytes={offset}-", requests)
        self.assertEqual(self.mod.invalid_files(self.target, self.pin, [name, "tokenizer.json"]), [])
        self.assertFalse((self.target / "onnx/model_fp16.onnx").exists())
        self.assertFalse(any(self.target.rglob("*.part")))

    def test_selected_corruption_keeps_preexisting_valid_manual_variant(self):
        old = {"model.safetensors": self.contents["model.safetensors"], "NOTICE": self.contents["NOTICE"]}
        write_files(self.target, old)
        def corrupt(_request, _timeout=None, **_kwargs):
            response = io.BytesIO(b"evil")
            response.status, response.headers = 200, {}
            return response
        with self.assertRaisesRegex(ValueError, "Checksum or size mismatch"):
            self.install(selected_paths=["onnx/model_fp16.onnx"], opener=corrupt)
        self.assertEqual({p.relative_to(self.target).as_posix(): p.read_bytes() for p in self.target.rglob("*") if p.is_file()}, old)

    def test_selected_promotion_failure_restores_entire_previous_install(self):
        old = {"model.safetensors": self.contents["model.safetensors"], "NOTICE": self.contents["NOTICE"]}
        write_files(self.target, old)
        incoming = self.root / ".incoming-model"
        rename = Path.rename
        def fail_promotion(path, destination):
            if path == incoming:
                raise OSError("simulated promotion failure")
            return rename(path, destination)
        with patch.object(Path, "rename", fail_promotion):
            with self.assertRaisesRegex(OSError, "promotion failure"):
                self.install(selected_paths=["onnx/model_fp16.onnx"])
        self.assertEqual({p.relative_to(self.target).as_posix(): p.read_bytes() for p in self.target.rglob("*") if p.is_file()}, old)
        self.calls.clear()
        self.install(selected_paths=["onnx/model_fp16.onnx"])
        self.assertEqual(self.calls, [])  # reuse the already verified selected download
        self.assertEqual((self.target / "model.safetensors").read_bytes(), old["model.safetensors"])

    def test_invalid_selected_paths_are_rejected_before_mutation(self):
        bad_scopes = ([], "model.safetensors", ["missing"], ["../escape"], ["/escape"],
                      ["onnx\\model.onnx"], [".cache/file"], ["model.safetensors"] * 2, [None])
        for selected in bad_scopes:
            with self.subTest(selected=selected):
                with self.assertRaises(ValueError):
                    self.install(selected_paths=selected)
                with self.assertRaises(ValueError):
                    self.mod.invalid_files(self.target, self.pin, selected)
                self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_invalid_pin_rejected_even_when_unsafe_entry_is_unselected(self):
        self.pin["files"][0]["path"] = "../escape"
        with self.assertRaisesRegex(ValueError, "Invalid pinned"):
            self.install(selected_paths=["tokenizer.json"])
        self.assertEqual(list(self.root.iterdir()), [])
        self.pin = pin_for(self.contents)
        self.pin["schema_version"] = True
        with self.assertRaisesRegex(ValueError, "Invalid pinned"):
            self.install(selected_paths=["tokenizer.json"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_complete_corrupt_partial_does_not_underestimate_disk_requirement(self):
        incoming = self.root / ".incoming-model"
        write_files(incoming, {"onnx/model_fp16.onnx.part": b"evil"})
        with patch.object(self.mod.shutil, "disk_usage", return_value=types.SimpleNamespace(free=64 * 1024 * 1024)):
            with self.assertRaisesRegex(ValueError, "free disk space"):
                self.install(selected_paths=["onnx/model_fp16.onnx"])
        self.assertEqual(self.calls, [])
        self.assertFalse(self.target.exists())

    @unittest.skipUnless(HAS_FILELOCK, "real filelock is required to exercise concurrent ownership")
    def test_busy_lock_prevents_scope_cleanup_and_recovery(self):
        incoming, backup = self.root / ".incoming-model", self.root / "model.old"
        write_files(incoming, {"onnx/model.onnx.part": b"paused"})
        write_files(backup, {"model.safetensors": b"old"})
        with filelock.FileLock(str(self.root / ".model.download.lock"), timeout=0):
            with self.assertRaises(filelock.Timeout):
                self.install(selected_paths=["tokenizer.json"])
        self.assertEqual((incoming / "onnx/model.onnx.part").read_bytes(), b"paused")
        self.assertEqual((backup / "model.safetensors").read_bytes(), b"old")
        self.assertFalse(self.target.exists())
        self.assertEqual(self.calls, [])

    def test_cli_profiles_verify_only_planned_files_without_mutation(self):
        selected = ["model.safetensors", "tokenizer.json"]
        write_files(self.target, {name: self.contents[name] for name in selected})
        manifest = self.root / "pin.json"
        manifest.write_text(json.dumps(self.pin))
        hardware = object()
        calls = []
        def plan(pin, discovered, profile="recommended"):
            self.assertEqual(pin, self.pin)
            self.assertIs(discovered, hardware)
            calls.append(profile)
            return {"selected_paths": selected}
        planner = types.SimpleNamespace(discover_hardware=lambda: hardware, build_plan=plan)
        before = {p: p.stat().st_mtime_ns for p in self.root.rglob("*")}
        with patch.dict(sys.modules, {"model_plan": planner}):
            for options, expected in (([], "recommended"), (["--profile", "expanded"], "expanded")):
                with patch.object(sys, "argv", [str(SOURCE), "--model-dir", str(self.target), "--manifest", str(manifest), *options]), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(self.mod.main(), 0)
                self.assertEqual(calls[-1], expected)
            for options in (["--all"], ["--profile", "all"]):
                with patch.object(sys, "argv", [str(SOURCE), "--model-dir", str(self.target), "--manifest", str(manifest), *options]), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(self.mod.main(), 1)  # other variants are absent
            self.assertEqual(calls, ["recommended", "expanded"])
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in self.root.rglob("*")})

    def test_installed_profile_respects_saved_expanded_choice(self):
        self.target = self.root / "home/models/model"
        home = self.target.parent.parent
        home.mkdir()
        state = {"schema_version": 1, "initialized": True, "download_pending": False,
                 "download_paused": False, "download_failed": False, "engine_stopped": False,
                 "models_deleted": False, "idle_unload_s": 300, "model_profile": "expanded"}
        (home / "component-state.json").write_text(json.dumps(state))
        self.assertEqual(self.mod.installed_profile(self.target), "expanded")
        selected = ["onnx/model_int8.onnx", "NOTICE"]
        write_files(self.target, {name: self.contents[name] for name in selected})
        manifest = self.root / "pin.json"
        manifest.write_text(json.dumps(self.pin))
        seen = []
        def plan(_pin, _hardware, profile):
            seen.append(profile)
            return {"selected_paths": selected}
        planner = types.SimpleNamespace(discover_hardware=lambda: {}, build_plan=plan)
        with patch.dict(sys.modules, {"model_plan": planner}), patch.object(sys, "argv", [
            str(SOURCE), "--model-dir", str(self.target), "--manifest", str(manifest),
        ]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.mod.main(), 0)
        self.assertEqual(seen, ["expanded"])
        self.assertIn("installed: expanded", output.getvalue())

    def test_installed_profile_rejects_legacy_corrupt_and_linked_preferences(self):
        self.target = self.root / "home/models/model"
        home = self.target.parent.parent
        home.mkdir()
        path = home / "component-state.json"
        self.assertEqual(self.mod.installed_profile(self.target), "recommended")
        legacy = {"schema_version": 1, "initialized": True, "download_pending": False, "download_paused": False,
                  "download_failed": False, "engine_stopped": False, "models_deleted": False, "idle_unload_s": 300}
        path.write_text(json.dumps(legacy))  # preferences that predate the profile field
        self.assertEqual(self.mod.installed_profile(self.target), "recommended")
        path.write_text('{"schema_version":1}')
        with self.assertRaises(ValueError):
            self.mod.installed_profile(self.target)
        for data in ('{', '[]', '{"model_profile":"all"}',
                     '{"model_profile":"recommended","model_profile":"expanded"}',
                     '{"model_profile":"recommended","extra":NaN}', " " * 65537):
            path.write_text(data)
            with self.subTest(data=data[:80]), self.assertRaises(ValueError):
                self.mod.installed_profile(self.target)
        path.unlink()
        outside = self.root / "outside-state.json"
        outside.write_text('{"model_profile":"expanded"}')
        path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.mod.installed_profile(self.target)



if __name__ == "__main__":
    unittest.main()
