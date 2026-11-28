"""Exercise release switching through the native component with small local checkpoints."""

import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "anagramd"))
import numpy as np
from tokenizers import Tokenizer, models, pre_tokenizers
import detector
import native_component
from native_component import NativeComponent


def tensor_file(shapes):
    table, chunks, at = {}, [], 0
    for name, shape in shapes.items():
        value = np.zeros(shape, dtype="<f4").tobytes()
        table[name] = {"shape": shape, "dtype": "F32", "data_offsets": [at, at + len(value)]}
        chunks.append(value)
        at += len(value)
    header = json.dumps(table).encode()
    return struct.pack("<Q", len(header)) + header + b"".join(chunks)


def fixture(day, label):
    hidden = 8
    backbone = tensor_file(
        {
            "embeddings.tok_embeddings.weight": [5, hidden],
            "embeddings.norm.weight": [hidden],
            "layers.0.attn.Wqkv.weight": [3 * hidden, hidden],
            "layers.0.attn.Wo.weight": [hidden, hidden],
            "layers.0.mlp_norm.weight": [hidden],
            "layers.0.mlp.Wi.weight": [32, hidden],
            "layers.0.mlp.Wo.weight": [hidden, 16],
            "final_norm.weight": [hidden],
        }
    )
    heads = tensor_file(
        {
            "token_head.weight": [3, hidden],
            "segment_head.weight": [15, hidden],
            "segment_head.bias": [15],
            "mixed_head.weight": [2, hidden],
            "mixed_head.bias": [2],
        }
    )
    tok = Tokenizer(
        models.BPE({"[UNK]": 0, "[CLS]": 1, "[SEP]": 2, "[PAD]": 3, "a": 4}, [], unk_token="[UNK]")
    )
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    meta = dict(
        format="anagram-detector/1",
        classes=detector.LABELS,
        heads=["token", "segment", "mixed"],
        decoder="linear_chain_crf",
        language="en",
        release_date=day,
        size="1m",
        window=64,
        stride=32,
        min_words=5,
    )
    cfg = dict(
        model_type="modernbert",
        hidden_activation="gelu",
        norm_eps=1e-5,
        attention_bias=False,
        mlp_bias=False,
        norm_bias=False,
        is_causal=False,
        hidden_size=8,
        num_attention_heads=2,
        local_attention=8,
        layer_types=["full_attention"],
        cls_token_id=1,
        sep_token_id=2,
        rope_parameters={
            k: dict(rope_type="default", rope_theta=10000.0)
            for k in ["full_attention", "sliding_attention"]
        },
    )
    alpha = [0, 0, 0]
    alpha[label] = 5
    crf = dict(
        W=[[0] * 6 for _ in range(3)], alpha=alpha, delta=[0] * 3, gamma=1, l_min=1, **{"lambda": 1}
    )
    assets = {
        "model.json": json.dumps(meta).encode(),
        "crf.json": json.dumps(crf).encode(),
        "backbone/config.json": json.dumps(cfg).encode(),
        "tokenizer/tokenizer.json": tok.to_str().encode(),
        "backbone/model.safetensors": backbone,
        "head.safetensors": heads,
    }
    pin = dict(
        schema_version=1,
        repository=detector.SOURCE,
        release=day + "-1m",
        revision=hashlib.sha1(day.encode()).hexdigest(),
        files=[
            dict(path=k, size_bytes=len(b), sha256=hashlib.sha256(b).hexdigest())
            for k, b in assets.items()
        ],
    )
    return pin, assets


class ReleaseTests(unittest.TestCase):
    def test_switch_restart_and_failed_update(self):
        first, second, bad = (fixture(f"2026-12-0{i}", k) for i, k in [(1, 0), (2, 2), (3, 1)])
        with (
            tempfile.TemporaryDirectory() as temp,
            patch("engine.LanguageId", return_value=SimpleNamespace(enabled=False, name=None)),
            patch.object(
                native_component,
                "LID_ENTRY",
                dict(path="lid.176.ftz", size_bytes=1, sha256=hashlib.sha256(b"L").hexdigest()),
            ),
        ):
            home = Path(temp).resolve()
            (home / ".native-component.json").write_text(
                json.dumps(dict(home=str(home), host=native_component.HOST_NAME, schema_version=1))
            )

            def download(cancel, progress):
                if component.pin == bad[0]:
                    raise IOError("Model update interrupted")
                assets = second[1] if component.pin == second[0] else first[1]
                for name, data in assets.items():
                    path = component.model_dir / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                if component.pin == second[0]:
                    (component.model_dir / "detector.onnx").write_bytes(b"unrelated document")
                component.lid_path.write_bytes(b"L")

            def settled():
                component.thread.join(timeout=15)
                self.assertFalse(component.thread.is_alive())
                self.assertEqual(component.status()["state"], "ready", component.status())

            def score():
                reply = component.handle(
                    "score",
                    dict(v="3.0", blocks=[dict(id="p", text="a a a a a a"), dict(id="short", text="a")]),
                )[1]
                self.assertTrue(reply["results"][1]["insufficient"])
                self.assertEqual(reply["results"][0]["sentenceLabels"], [reply["results"][0]["bucket"]])
                return reply["model"]["id"], reply["results"][0]["bucket"]

            component = NativeComponent(home, pin=first[0], downloader=download)
            try:
                component.start()
                settled()
                self.assertEqual(score(), (first[0]["release"], 0))
                self.assertFalse((component.model_dir / "detector.onnx").exists())
                component.handle("models.select", {"release": second[0]})
                settled()
                self.assertEqual(score(), (second[0]["release"], 2))
                self.assertFalse(detector.model_dir(home, first[0]).exists())
                self.assertEqual((component.model_dir / "detector.onnx").read_bytes(), b"unrelated document")
                component.handle("models.select", {"release": bad[0]})
                settled()
                self.assertEqual(score(), (second[0]["release"], 2))
            finally:
                component.close()
            component = NativeComponent(
                home, downloader=lambda *_: self.fail("Offline restart downloaded a model")
            )
            try:
                component.start()
                settled()
                self.assertEqual(score(), (second[0]["release"], 2))
            finally:
                component.close()


class PublishedCheckpointParity(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("ANAGRAM_TEST_DETECTOR_DIR"), "requires a local detector snapshot")
    def test_published_sentence_and_document_outputs(self):
        """Reads an existing November 28 snapshot. Expected values come from the published PyTorch detector."""
        root = Path(os.environ["ANAGRAM_TEST_DETECTOR_DIR"])
        release = json.loads((root / "model.json").read_text())["release_id"]
        labels, counts, bucket = {
            "2026-11-28-400m-ettin_research": ([1, 1, 2, 2], [0, 167, 163], 1),
            "2026-11-28-0.8b-qwen3.5_research": ([1, 2, 2, 2], [0, 114, 216], 2),
        }[release]
        text = (
            "The specimen from 1927 was recorded under an obsolete name; the second label gives the name used "
            "by the collector. I checked both names against the handwritten ledger. The entry on page forty "
            "is faint, but the date and the place are quite clear. This time I am leaving the original label "
            "alone so the next visitor can read it too."
        )
        model = detector.Detector(root, {"release": release, "revision": "test"}, None)
        result, = model.score([text])
        self.assertEqual(result["sentenceLabels"], labels)
        self.assertEqual(result["bucket"], bucket)
        self.assertEqual(result["probs"], [n / len(text) for n in counts])


if __name__ == "__main__":
    unittest.main()
