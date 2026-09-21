"""Offline modelkit tests and tiny installer fixtures; no ML dependencies or downloads."""
import contextlib
import hashlib
import importlib.util
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

    def download(self, **kwargs):
        self.calls.append(kwargs)
        self.assertIs(kwargs["token"], False)
        self.assertEqual(kwargs["revision"], self.pin["revision"])
        write_files(Path(kwargs["local_dir"]), {kwargs["filename"]: self.contents[kwargs["filename"]]})

    def install(self, **kwargs):
        self.mod.install(self.target, self.pin, download=kwargs.pop("download", self.download),
                         cached=kwargs.pop("cached", lambda *a, **k: None), **kwargs)

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
        names = {c["filename"] for c in self.calls}
        self.assertNotIn("model.safetensors", names)
        self.assertNotIn("onnx/model.onnx", names)

    def test_verified_hub_symlink_cache_reused(self):
        blob = self.root / "blob"
        blob.write_bytes(self.contents["model.safetensors"])
        cache = self.root / "snapshot"
        cache.symlink_to(blob)
        self.install(cached=lambda repo, name, **k: str(cache) if name == "model.safetensors" else None)
        self.assertNotIn("model.safetensors", {c["filename"] for c in self.calls})
        self.assertFalse((self.target / "model.safetensors").is_symlink())

    def test_tampered_download_preserves_installed_tree(self):
        write_files(self.target, {"model.safetensors": b"old"})
        def bad(**kwargs):
            write_files(Path(kwargs["local_dir"]), {kwargs["filename"]: b"bad"})
        with self.assertRaisesRegex(ValueError, "nothing was replaced"):
            self.install(download=bad)
        self.assertEqual((self.target / "model.safetensors").read_bytes(), b"old")
        self.assertTrue((self.root / ".incoming-model" / "model.safetensors").exists())

    def test_corrupt_cached_blob_forces_fresh_download(self):
        blob = self.root / "blob"
        blob.write_bytes(b"bad")
        self.install(cached=lambda *a, **k: str(blob))
        self.assertTrue(all(c["force_download"] for c in self.calls))

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
        with self.assertRaisesRegex(ValueError, "symbolic link"):
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
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.install()
        self.assertEqual(list(outside.iterdir()), [])

    def test_complete_pin_matches_verified_payload_metadata(self):
        pin = self.mod.load_pin(SOURCE.with_name("modelkit.json"))
        self.assertEqual(pin["revision"], "f7cb4b06e5067ecdb66c566c7982a413f86f569f")
        names = {e["path"] for e in pin["files"]}
        self.assertTrue(set(self.contents) <= names)
        self.assertEqual(sum(e["size_bytes"] for e in pin["files"]), 4073892651)


def fixture():
    source = Path(sys.argv[2])
    app = source.parent
    contents = {name: value.encode() for name, value in json.loads((app / "fixture.json").read_text()).items()}
    def download(**kwargs):
        assert kwargs["token"] is False
        value = contents[kwargs["filename"]]
        if (app.parent / "TAMPER").exists():
            value = b"half a download, cut off here\n"
        write_files(Path(kwargs["local_dir"]), {kwargs["filename"]: value})
    sys.modules["huggingface_hub"] = types.SimpleNamespace(
        hf_hub_download=download, try_to_load_from_cache=lambda *a, **k: None)
    loaded = module(source)
    sys.argv = [str(source)] + sys.argv[3:]
    raise SystemExit(loaded.main())


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--fixture":
        fixture()
    else:
        unittest.main()
