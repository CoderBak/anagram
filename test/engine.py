#!/usr/bin/env python3
"""Offline model loading and pipeline identity checks; no model or socket required."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import tokenize
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
DAEMON = ROOT / "anagramd"
sys.path.insert(0, str(DAEMON))

passed = failed = skipped = 0


def check(name: str, ok: bool, note: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {name}" + (f"  —  {note}" if note else ""))
    else:
        failed += 1
        print(f"FAIL  {name}" + (f"  —  {note}" if note else ""))


def skip(name: str, why: str) -> None:
    global skipped
    skipped += 1
    print(f"SKIP  {name}  —  {why}")


def run_py(code: str, *args: str) -> subprocess.CompletedProcess:
    """Start with inherited online flags to verify the engine overrides them."""
    env = dict(os.environ)
    env.update(PYTHONPATH=str(DAEMON), PYTHONDONTWRITEBYTECODE="1",
               HF_HUB_OFFLINE="0", TRANSFORMERS_OFFLINE="0")
    return subprocess.run([sys.executable, "-c", code, *args], capture_output=True, text=True,
                          timeout=300, env=env, cwd=str(ROOT))


import engine as engine_api  # noqa: E402  — after sys.path, and the point of the suite

# Suppress expected warnings about tiny fixture weights.
logging.getLogger("anagramd").setLevel(logging.CRITICAL)


# --- 1. serving is offline -------------------------------------------------------------------

print("\n-- offline --")

r = run_py("""
import json, os, sys
import engine as engine_api
print(json.dumps({
    "env": {k: os.environ.get(k) for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE",
                                           "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_IMPLICIT_TOKEN")},
    "imported": sorted(m for m in ("transformers", "huggingface_hub", "torch") if m in sys.modules),
}))
""")
try:
    info = json.loads(r.stdout.strip().splitlines()[-1])
except Exception:
    info = {"env": {}, "imported": ["<did not run>"]}
    print(r.stderr.strip()[-600:])
check("importing engine.py sets the hub offline flags, overruling an inherited HF_HUB_OFFLINE=0",
      info["env"].get("HF_HUB_OFFLINE") == "1" and info["env"].get("TRANSFORMERS_OFFLINE") == "1",
      json.dumps(info["env"]))
check("telemetry and implicit tokens are off too",
      info["env"].get("HF_HUB_DISABLE_TELEMETRY") == "1" and info["env"].get("HF_HUB_DISABLE_IMPLICIT_TOKEN") == "1",
      json.dumps(info["env"]))
check("engine.py imports neither transformers nor huggingface_hub at module level — so the flags "
      "above are set BEFORE anything reads them", info["imported"] == [], f"imported {info['imported']}")

r = run_py("""
import engine as engine_api, huggingface_hub, sys
from huggingface_hub import constants
print("offline=%s" % bool(constants.HF_HUB_OFFLINE))
""")
if "No module named 'huggingface_hub'" in r.stderr:
    skip("huggingface_hub itself comes up offline", "huggingface_hub is not installed here")
else:
    check("huggingface_hub imported after engine.py comes up offline (its constants are read once, "
          "at import time)", "offline=True" in r.stdout, r.stdout.strip() or r.stderr.strip()[-200:])

# Inspect code tokens, excluding strings and comments.
names = {tok.string for tok in tokenize.generate_tokens(
    io.StringIO((DAEMON / "engine.py").read_text()).readline) if tok.type == tokenize.NAME}
fetchers = names & {"urllib", "urlretrieve", "urlopen", "snapshot_download", "hf_hub_download",
                    "requests", "httpx", "aiohttp", "socket"}
check("no name that fetches anything is left in engine.py's code (comments and docstrings aside)",
      not fetchers, ", ".join(sorted(fetchers)) or "none of urllib/urlopen/snapshot_download/…")

# A missing model file must be an error that names the command which fetches it — and must get
# there without so much as looking up a hostname. The guard below fails the subprocess if any
# socket is created at all, so "it did not download" is checked rather than assumed.
GUARD = """
import socket
class NoNetwork(socket.socket):
    def __init__(self, *a, **k):
        raise AssertionError("the daemon opened a socket")
socket.socket = NoNetwork
socket.create_connection = lambda *a, **k: (_ for _ in ()).throw(AssertionError("the daemon connected"))
socket.getaddrinfo = lambda *a, **k: (_ for _ in ()).throw(AssertionError("the daemon resolved a name"))
"""

r = run_py(f"""
import engine as engine_api
from pathlib import Path
{GUARD}
try:
    engine_api.LanguageId(Path("/nonexistent/lid.176.ftz"))
except RuntimeError as e:
    print("EXIT<<%s>>" % e)
""")
if "fasttext is not importable" in r.stdout:
    skip("a missing language model is a clear error, with no network attempt", "fasttext is not installed here")
else:
    msg = r.stdout.split("EXIT<<", 1)[-1]
    check("a missing language model exits with a clear error naming Settings",
          "EXIT<<" in r.stdout and "Settings" in msg and "lid.176.ftz" in msg,
          (msg.splitlines() or [r.stderr.strip()[-200:]])[0])
    check("…and reaches no network doing it (any socket at all fails the test)",
          "opened a socket" not in r.stdout + r.stderr and "resolved a name" not in r.stdout + r.stderr)

r = run_py(f"""
import engine as engine_api
from pathlib import Path
{GUARD}
try:
    engine_api.require_model(Path("/nonexistent/editlens_roberta-large"))
except RuntimeError as e:
    print("EXIT<<%s>>" % e)
""")
msg = r.stdout.split("EXIT<<", 1)[-1]
check("a missing checkpoint exits with a clear error naming Settings, with no download",
      "EXIT<<" in r.stdout and "Settings" in msg and "Download models" in msg,
      (msg.splitlines() or [r.stderr.strip()[-200:]])[0])


# --- 2. the pipeline identity --------------------------------------------------------------

print("\n-- pipeline identity --")


def fake_lid(digest: str | None, name: str = "fasttext-lid.176"):
    """A LanguageId that never loaded anything: `enabled` is `model is not None`."""
    lid = engine_api.LanguageId.__new__(engine_api.LanguageId)
    lid.model = object() if digest else None
    lid.name = name if digest else None
    lid.digest = digest
    return lid


def model_dir(where: Path, weights: bytes = b"a checkpoint", tokenizer: str = '{"tok": 1}') -> Path:
    where.mkdir(parents=True, exist_ok=True)
    (where / "model.safetensors").write_bytes(weights)
    (where / "config.json").write_text('{"num_labels": 4}')
    (where / "tokenizer.json").write_text(tokenizer)
    return where


from runtime_adapters import runtime_version  # noqa: E402
from runtime_controller import Candidate  # noqa: E402

TORCH_CPU = Candidate("torch:cpu:fp32", "CPU", "cpu", "torch", "fp32")


def version(where: Path, max_length: int, dtype: str, lid) -> str:
    """The identity the runtime gives a loaded engine."""
    engine = SimpleNamespace(max_length=max_length, dtype_name=dtype, lid=lid)
    return runtime_version(engine, TORCH_CPU, where, engine_api, {"device": "cpu"})


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    base_dir = model_dir(tmp / "base")
    lid_a = fake_lid(hashlib.sha256(b"lid A").hexdigest())
    lid_b = fake_lid(hashlib.sha256(b"lid B").hexdigest())
    base = version(base_dir, 512, "float16", lid_a)

    check("the version still has the shape the extension and native clients expect",
          bool(re.fullmatch(r"sha256:[0-9a-f]{12}-p[0-9a-f]{8}-[a-z0-9]+", base)), base)
    check("the same pipeline hashes to the same version twice",
          version(base_dir, 512, "float16", lid_a) == base)

    # One input at a time: each of these on its own has to move the string the extension keys
    # its cache by, because each of them on its own can move a verdict.
    moved = {
        "another language model (same weights, same everything else)":
            version(base_dir, 512, "float16", lid_b),
        "the language gate turned off":
            version(base_dir, 512, "float16", fake_lid(None)),
        "another token limit": version(base_dir, 256, "float16", lid_a),
        "another dtype": version(base_dir, 512, "float32", lid_a),
        "another tokenizer.json":
            version(model_dir(tmp / "tok", tokenizer='{"tok": 2}'), 512, "float16", lid_a),
        "other weights":
            version(model_dir(tmp / "w", weights=b"another checkpoint entirely"), 512, "float16", lid_a),
    }
    for what, version in moved.items():
        check(f"the version changes with {what}", version != base, version)
    check("the language model's digest is the only thing that differs between those two runs, and "
          "it is enough", moved["another language model (same weights, same everything else)"][:19] == base[:19])

check("the preprocessing source is digested, so an edit to clean_text cannot keep the old cache "
      "keys", re.fullmatch(r"[0-9a-f]{12}", engine_api.preprocess_digest()) is not None, engine_api.preprocess_digest())

# What the version is made of, named rather than inferred from a digest: a new thing that can
# move a verdict should be added here as well as to the manifest.
with tempfile.TemporaryDirectory() as tmp:
    manifest = engine_api.pipeline_manifest(model_dir(Path(tmp) / "m"), 512, "float16", fake_lid("d" * 64))
    check("the manifest covers the pipeline files, the window, the dtype, the gate and its model, "
          "the languages, the labels and the preprocessing",
          set(manifest) == {"files", "max_length", "dtype", "language_gate", "lid", "languages",
                            "labels", "label_schema", "preprocess", "rev"}, ", ".join(sorted(manifest)))
    check("the language model is in it by digest, not by name alone",
          manifest["lid"] == {"name": "fasttext-lid.176", "sha256": "d" * 64}, json.dumps(manifest["lid"]))
    check("every small pipeline file that exists is in it by digest",
          set(manifest["files"]) == {"config.json", "tokenizer.json"}
          and all(re.fullmatch(r"[0-9a-f]{64}", v) for v in manifest["files"].values()),
          ", ".join(sorted(manifest["files"])))



# Native score validation is transport independent.
from pydantic import ValidationError
bad_requests = [
    {"v":"2.2","blocks":[]},
    {"v":"4.0","blocks":[]},
    {"v":"3.0","blocks":[{"id":"same","text":"a"},{"id":"same","text":"b"}]},
    {"v":"3.0","blocks":[{"id":"x" * 65,"text":"a"}]},
    {"v":"3.0","blocks":[{"id":"x","text":"a" * 16001}]},
    {"v":"3.0","blocks":[{"id":str(i),"text":"a"} for i in range(257)]},
]
for index, payload in enumerate(bad_requests):
    try:
        engine_api.ScoreRequest.model_validate(payload)
    except ValidationError:
        check(f"invalid score request {index} is refused before tokenization", True)
    else:
        check(f"invalid score request {index} is refused before tokenization", False)
check("contract 3.x score request remains valid", engine_api.ScoreRequest.model_validate({"v":"3.1","blocks":[]}).v == "3.1")

bad_requests = [
    {"v":"2.2","texts":[]},
    {"texts":["a"]},
    {"v":"3.0","texts":"a"},
    {"v":"3.0","texts":["a", 1]},
    {"v":"3.0","texts":["a", None]},
    {"v":"3.0","texts":[["a"]]},
    {"v":"3.0","texts":["a" * 16001]},
    {"v":"3.0","texts":["a"] * 513},
    {"v":"3.0","texts":["a" * 16000] * 16 + ["a"]},
]
for index, payload in enumerate(bad_requests):
    try:
        engine_api.TokensRequest.model_validate(payload)
    except ValidationError:
        check(f"invalid tokens request {index} is refused before tokenization", True)
    else:
        check(f"invalid tokens request {index} is refused before tokenization", False)
check("the largest tokens request is valid",
      len(engine_api.TokensRequest.model_validate({"v":"3.0","texts":["a" * 500] * 512}).texts) == 512)
# A fast tokenizer refuses an empty batch; no texts never reach it.
untokenized = SimpleNamespace(tok=None, emoji=None, max_length=512)
check("no texts count to nothing without calling the tokenizer",
      engine_api.tokens_with_engine(engine_api.TokensRequest.model_validate({"v":"3.0","texts":[]}), untokenized)
      == {"alone": [], "following": [], "window": 510})
# Each text is counted as cleaned, once on its own and once after a space; an empty one is
# nothing either way (a space alone is not a word of the text).
asked = []
def fake_tok(texts, add_special_tokens, truncation):
    asked.append(list(texts))
    return {"input_ids": [[0] * (len(t.split(" ")) if t.strip() else len(t)) for t in texts]}
counted = engine_api.tokens_with_engine(
    engine_api.TokensRequest.model_validate({"v":"3.0","texts":["  Two WORDS ", ""]}),
    SimpleNamespace(tok=fake_tok, emoji=SimpleNamespace(demojize=lambda t: t, replace_emoji=lambda t, r: t), max_length=512))
check("a text is counted alone and after a space, cleaned the way scoring cleans it",
      asked == [["two words", "", " two words", " "]] and counted == {"alone": [2, 0], "following": [3, 0], "window": 510},
      repr((asked, counted)))
print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(bool(failed))
