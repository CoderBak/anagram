"""Offline modelkit tests and tiny installer fixtures; no ML dependencies or downloads."""
import contextlib
import hashlib
import importlib.util
import io
from urllib.parse import unquote
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

SOURCE = Path(__file__).resolve().parents[1] / "anagramd" / "download_modelkit.py"
# CI's installer suite intentionally has no Python packages installed. The fixture
# lock is a no-op; concurrency/OS locking is delegated to the filelock dependency.
try:
    import filelock
except ImportError:
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
        self.mod.install_streaming(self.target, self.pin, opener=kwargs.pop("opener", self.opener), **kwargs)

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
            response = io.BytesIO(b"bad")
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
        with patch.object(sys, "argv", [str(SOURCE), "--model-dir", str(self.target), "--manifest", str(manifest)]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.mod.main(), 0)
        self.assertEqual(before, {p: p.stat().st_mtime_ns for p in self.root.rglob("*")})

    def test_recovery_after_interrupted_promotion(self):
        write_files(self.root / "model.old", self.contents)
        self.install()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.mod.invalid_files(self.target, self.pin), [])

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



if __name__ == "__main__":
    unittest.main()
