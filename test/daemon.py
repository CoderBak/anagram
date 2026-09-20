#!/usr/bin/env python3
"""test/daemon.py — what anagramd promises about itself, checked WITHOUT the model.

The server suite (test/server.mjs) needs the real 1.4 GB checkpoint and a GPU-ish machine, so
it is the wrong place for the properties that have nothing to do with scoring: that serving
never reaches the network, that the daemon answers to exactly the two names the extension can
be pointed at, and that the version string it hands the extension changes whenever anything
that could move a verdict changes. Those are checked here in a second — the HTTP layer against
a stub engine through FastAPI's TestClient, the rest in subprocesses that inspect the module
itself.

    sh test/daemon.sh          (= npm run test:daemon; uses anagramd/.venv when it is there)

Checks that need a package the daemon has but this interpreter does not SKIP loudly rather
than passing quietly. Nothing here downloads anything, opens a port, or touches an installed
Anagram folder.
"""
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
    """A fresh interpreter with anagramd/ importable — and with the offline flags set WRONG.

    HF_HUB_OFFLINE=0 in the environment is what a careless shell or a leftover export looks
    like; serve.py has to overrule it rather than defer to it.
    """
    env = dict(os.environ)
    env.update(PYTHONPATH=str(DAEMON), PYTHONDONTWRITEBYTECODE="1",
               HF_HUB_OFFLINE="0", TRANSFORMERS_OFFLINE="0")
    return subprocess.run([sys.executable, "-c", code, *args], capture_output=True, text=True,
                          timeout=300, env=env, cwd=str(ROOT))


import serve  # noqa: E402  — after sys.path, and the point of the suite

# The daemon warns, rightly, that the stub checkpoints below are not the benchmarked one. That
# is the code under test doing its job; it is not something this suite needs to print.
logging.getLogger("anagramd").setLevel(logging.CRITICAL)


# --- 1. serving is offline -------------------------------------------------------------------

print("\n-- offline --")

r = run_py("""
import json, os, sys
import serve
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
check("importing serve.py sets the hub offline flags, overruling an inherited HF_HUB_OFFLINE=0",
      info["env"].get("HF_HUB_OFFLINE") == "1" and info["env"].get("TRANSFORMERS_OFFLINE") == "1",
      json.dumps(info["env"]))
check("telemetry and implicit tokens are off too",
      info["env"].get("HF_HUB_DISABLE_TELEMETRY") == "1" and info["env"].get("HF_HUB_DISABLE_IMPLICIT_TOKEN") == "1",
      json.dumps(info["env"]))
check("serve.py imports neither transformers nor huggingface_hub at module level — so the flags "
      "above are set BEFORE anything reads them", info["imported"] == [], f"imported {info['imported']}")

r = run_py("""
import serve, huggingface_hub, sys
from huggingface_hub import constants
print("offline=%s" % bool(constants.HF_HUB_OFFLINE))
""")
if "No module named 'huggingface_hub'" in r.stderr:
    skip("huggingface_hub itself comes up offline", "huggingface_hub is not installed here")
else:
    check("huggingface_hub imported after serve.py comes up offline (its constants are read once, "
          "at import time)", "offline=True" in r.stdout, r.stdout.strip() or r.stderr.strip()[-200:])

# Tokenized, not grepped: serve.py's comments and docstrings SAY "snapshot_download" to explain
# why it is not called any more, and a plain search would read those as the call itself.
names = {tok.string for tok in tokenize.generate_tokens(
    io.StringIO((DAEMON / "serve.py").read_text()).readline) if tok.type == tokenize.NAME}
fetchers = names & {"urllib", "urlretrieve", "urlopen", "snapshot_download", "hf_hub_download",
                    "requests", "httpx", "aiohttp", "socket"}
check("no name that fetches anything is left in serve.py's code (comments and docstrings aside)",
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
import serve
from pathlib import Path
{GUARD}
try:
    serve.LanguageId(Path("/nonexistent/lid.176.ftz"))
except SystemExit as e:
    print("EXIT<<%s>>" % e)
""")
if "fasttext is not importable" in r.stdout:
    skip("a missing language model is a clear error, with no network attempt", "fasttext is not installed here")
else:
    msg = r.stdout.split("EXIT<<", 1)[-1]
    check("a missing language model exits with a clear error naming `anagram model`",
          "EXIT<<" in r.stdout and "anagram model" in msg and "lid.176.ftz" in msg,
          (msg.splitlines() or [r.stderr.strip()[-200:]])[0])
    check("…and reaches no network doing it (any socket at all fails the test)",
          "opened a socket" not in r.stdout + r.stderr and "resolved a name" not in r.stdout + r.stderr)

r = run_py(f"""
import serve
from pathlib import Path
{GUARD}
try:
    serve.require_model(Path("/nonexistent/editlens_roberta-large"))
except SystemExit as e:
    print("EXIT<<%s>>" % e)
""")
msg = r.stdout.split("EXIT<<", 1)[-1]
check("a missing checkpoint exits with a clear error naming `anagram model`, with no download",
      "EXIT<<" in r.stdout and "anagram model" in msg and "never downloads" in msg,
      (msg.splitlines() or [r.stderr.strip()[-200:]])[0])


# --- 2. the pipeline identity --------------------------------------------------------------

print("\n-- pipeline identity --")


def fake_lid(digest: str | None, name: str = "fasttext-lid.176"):
    """A LanguageId that never loaded anything: `enabled` is `model is not None`."""
    lid = serve.LanguageId.__new__(serve.LanguageId)
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


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    base_dir = model_dir(tmp / "base")
    lid_a = fake_lid(hashlib.sha256(b"lid A").hexdigest())
    lid_b = fake_lid(hashlib.sha256(b"lid B").hexdigest())
    base = serve.pipeline_version(base_dir, 512, "float16", lid_a)

    check("the version still has the shape the extension and test/server.mjs expect",
          bool(re.fullmatch(r"sha256:[0-9a-f]{12}-p[0-9a-f]{8}-[a-z0-9]+", base)), base)
    check("the same pipeline hashes to the same version twice",
          serve.pipeline_version(base_dir, 512, "float16", lid_a) == base)

    # One input at a time: each of these on its own has to move the string the extension keys
    # its cache by, because each of them on its own can move a verdict.
    moved = {
        "another language model (same weights, same everything else)":
            serve.pipeline_version(base_dir, 512, "float16", lid_b),
        "the language gate turned off":
            serve.pipeline_version(base_dir, 512, "float16", fake_lid(None)),
        "another --max-length": serve.pipeline_version(base_dir, 256, "float16", lid_a),
        "another dtype": serve.pipeline_version(base_dir, 512, "float32", lid_a),
        "another tokenizer.json":
            serve.pipeline_version(model_dir(tmp / "tok", tokenizer='{"tok": 2}'), 512, "float16", lid_a),
        "other weights":
            serve.pipeline_version(model_dir(tmp / "w", weights=b"another checkpoint entirely"), 512, "float16", lid_a),
    }
    for what, version in moved.items():
        check(f"the version changes with {what}", version != base, version)
    check("the language model's digest is the only thing that differs between those two runs, and "
          "it is enough", moved["another language model (same weights, same everything else)"][:19] == base[:19])

check("the preprocessing source is digested, so an edit to clean_text cannot keep the old cache "
      "keys", re.fullmatch(r"[0-9a-f]{12}", serve.preprocess_digest()) is not None, serve.preprocess_digest())

# What the version is made of, named rather than inferred from a digest: a new thing that can
# move a verdict should be added here as well as to the manifest.
with tempfile.TemporaryDirectory() as tmp:
    manifest = serve.pipeline_manifest(model_dir(Path(tmp) / "m"), 512, "float16", fake_lid("d" * 64))
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


# --- 3. the HTTP layer, against a stub engine ------------------------------------------------

print("\n-- host, origin, contract --")

PORT = 8799  # never bound: TestClient speaks to the app object directly


def stub_engine(lid_enabled: bool = True):
    """A real EditLens instance with nothing loaded — every attribute info() and /score read,
    and a score() that answers without a model. Using the real class keeps /health honest."""
    e = serve.EditLens.__new__(serve.EditLens)
    e.version = "sha256:0123456789ab-pdeadbeef-pre1"
    e.n_buckets = 4
    e.max_length = 512
    e.device = "cpu"
    e.dtype_name = "float32"
    e.started = 0.0
    e.scored = 0
    e.last_run_ms = e.last_wait_ms = 0.0
    e.lid = fake_lid("f" * 64 if lid_enabled else None)
    e.lid.detect = lambda text: ("en", 0.99)
    e.score = lambda texts: [{"bucket": 1, "probs": [0.1, 0.6, 0.2, 0.1], "score": 0.43,
                              "tokens": 12, "truncated": False} for _ in texts]
    return e


try:
    from fastapi.testclient import TestClient
except Exception as e:  # pragma: no cover — a bare interpreter
    skip("Host / Origin / contract checks", f"fastapi's TestClient is not importable ({e})")
    TestClient = None

if TestClient is not None:
    hosts = serve.allowed_hosts_for("127.0.0.1")
    app = serve.make_app(stub_engine(), hosts, PORT)
    client = TestClient(app, base_url=f"http://127.0.0.1:{PORT}")
    BODY = {"v": "2.1", "blocks": [{"id": "a", "text": "a paragraph of quite ordinary English."}]}
    JSON_CT = {"content-type": "application/json"}

    check("the two names the extension can use are the two the daemon answers to",
          hosts == ["127.0.0.1", "localhost"] == serve.LOOPBACK_HOSTS, str(hosts))
    for name in ("127.0.0.1", "localhost"):
        r = client.get("/health", headers={"host": f"{name}:{PORT}"})
        check(f"GET /health with Host {name} → 200", r.status_code == 200, str(r.status_code))
    for name in ("127.0.0.2", "[::1]", "evil.example", "localhost.evil.example"):
        r = client.get("/health", headers={"host": f"{name}:{PORT}"})
        check(f"GET /health with Host {name} → 400", r.status_code == 400, str(r.status_code))

    for name in ("127.0.0.1", "localhost"):
        r = client.post("/score", json=BODY, headers={"origin": f"http://{name}:{PORT}"})
        check(f"POST /score from our own origin http://{name}:{PORT} → 200 (the /docs page)",
              r.status_code == 200, str(r.status_code))
    r = client.post("/score", json=BODY, headers={"origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"})
    check("POST /score from an extension origin → 200", r.status_code == 200, str(r.status_code))
    for origin in ("https://evil.example", "null", "http://127.0.0.2:8799", "http://[::1]:8799"):
        r = client.post("/score", json=BODY, headers={"origin": origin})
        check(f"POST /score with Origin {origin} → 403", r.status_code == 403, str(r.status_code))
    r = client.post("/score", content=json.dumps(BODY), headers={"content-type": "text/plain"})
    check("POST /score as text/plain → 415", r.status_code == 415, str(r.status_code))

    health = client.get("/health").json()
    check("/health still carries `calibration` — contract 2.1 clients read that name",
          health["model"]["calibration"] == serve.CALIBRATION, health["model"]["calibration"])
    check("/health also carries `label_schema`, the same value under the name that describes it",
          health["model"].get("label_schema") == serve.LABEL_SCHEMA, str(health["model"].get("label_schema")))
    scored = client.post("/score", json=BODY, headers=JSON_CT).json()
    check("POST /score answers with both fields too (the response model declares label_schema, so "
          "it is not silently dropped)",
          scored["model"].get("calibration") == serve.CALIBRATION
          and scored["model"].get("label_schema") == serve.LABEL_SCHEMA, json.dumps(scored["model"]))
    check("a scored block still comes back in the 2.1 shape",
          scored["v"] == "2.1" and scored["results"][0]["id"] == "a"
          and len(scored["results"][0]["probs"]) == 4, json.dumps(scored["results"][0]))

    # --- CORS: an extension may read the answer, and nobody else ------------------------
    #
    # This is what lets the extension ask for NO host permission. The property worth
    # checking is not "there are headers" but "there are headers for exactly one kind of
    # caller": an extension origin gets its own origin echoed, everybody else gets the 403
    # they always got with nothing on it — on the preflight as much as on the request, since
    # a preflight a page can read is a request it can then send.
    print("\n-- CORS (extension origins only) --")

    EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    PREFLIGHT = {"access-control-request-method": "POST", "access-control-request-headers": "content-type"}

    def acao(r) -> str | None:
        return r.headers.get("access-control-allow-origin")

    for scheme in ("chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                   "moz-extension://5e0b7a12-3c4d-4f8a-9b16-2d7e8c0f4a31",
                   "safari-web-extension://A1B2C3D4-0000-0000-0000-000000000000"):
        r = client.get("/health", headers={"origin": scheme})
        check(f"GET /health from {scheme.split('://')[0]}:// → 200 with its own origin echoed",
              r.status_code == 200 and acao(r) == scheme and "origin" in r.headers.get("vary", "").lower(),
              f"{r.status_code} {acao(r)} vary={r.headers.get('vary')}")

    r = client.post("/score", json=BODY, headers={"origin": EXT_ORIGIN})
    check("POST /score from an extension origin comes back readable (echoed origin, Vary, no wildcard, "
          "no credentials)",
          r.status_code == 200 and acao(r) == EXT_ORIGIN and "origin" in r.headers.get("vary", "").lower()
          and "access-control-allow-credentials" not in r.headers,
          f"{r.status_code} {acao(r)}")

    for path in ("/score", "/health"):
        r = client.options(path, headers={"origin": EXT_ORIGIN, **PREFLIGHT})
        check(f"the preflight OPTIONS {path} from an extension origin is answered",
              r.status_code == 204 and acao(r) == EXT_ORIGIN
              and r.headers.get("access-control-allow-methods") == "GET, POST"
              and r.headers.get("access-control-allow-headers") == "content-type"
              and (r.headers.get("access-control-max-age") or "0").isdigit()
              and int(r.headers.get("access-control-max-age", "0")) > 0,
              f"{r.status_code} {dict(r.headers)}")

    # Chrome's private-network check: a request from an extension page to loopback is the
    # case it was invented for, so the daemon says yes — but only when it was asked.
    r = client.options("/score", headers={"origin": EXT_ORIGIN, **PREFLIGHT,
                                          "access-control-request-private-network": "true"})
    check("…and it grants private-network access when the preflight asks for it",
          r.headers.get("access-control-allow-private-network") == "true", str(dict(r.headers)))
    r = client.options("/score", headers={"origin": EXT_ORIGIN, **PREFLIGHT})
    check("…and does not volunteer it when it was not asked",
          "access-control-allow-private-network" not in r.headers, str(dict(r.headers)))

    for origin in ("https://evil.example", "null", "http://127.0.0.2:8799"):
        r = client.get("/health", headers={"origin": origin})
        check(f"GET /health with Origin {origin} → 403 and NO CORS header",
              r.status_code == 403 and acao(r) is None, f"{r.status_code} {acao(r)}")
        r = client.options("/score", headers={"origin": origin, **PREFLIGHT})
        check(f"…and its PREFLIGHT is refused the same way, so the POST is never sent",
              r.status_code == 403 and acao(r) is None, f"{r.status_code} {acao(r)}")

    r = client.get("/health")
    check("a request with no Origin at all (curl, the CLI) is answered as before, with no CORS header",
          r.status_code == 200 and acao(r) is None, f"{r.status_code} {acao(r)}")
    r = client.get("/health", headers={"origin": f"http://127.0.0.1:{PORT}"})
    check("our own /docs page is answered without one too — same origin needs no permission",
          r.status_code == 200 and acao(r) is None, f"{r.status_code} {acao(r)}")

    # A refusal an extension cannot read is a refusal it has to guess at, so the guards'
    # own answers carry the headers when the caller is an extension.
    r = client.post("/score", content=json.dumps(BODY),
                    headers={"content-type": "text/plain", "origin": EXT_ORIGIN})
    check("a 415 sent TO an extension is readable by it (it says what was wrong, rather than failing opaquely)",
          r.status_code == 415 and acao(r) == EXT_ORIGIN, f"{r.status_code} {acao(r)}")

    # Order: the preflight goes through the same guards the POST will, so a Host the daemon
    # does not answer to is refused before CORS is ever considered.
    r = client.options("/score", headers={"origin": EXT_ORIGIN, "host": f"evil.example:{PORT}", **PREFLIGHT})
    check("a preflight with a Host we do not answer to is refused first, with no CORS header",
          r.status_code == 400 and acao(r) is None, f"{r.status_code} {acao(r)}")

    # --- the daemon's own version ---------------------------------------------------------
    health = client.get("/health").json()
    check("/health carries the daemon's own version, so the extension can ask for an update when "
          "it is behind", health.get("app_version") == serve.APP_VERSION and bool(serve.APP_VERSION),
          str(health.get("app_version")))
    pyproject = (DAEMON / "pyproject.toml").read_text()
    check("…and it is the version scripts/bump.mjs already keeps in step, not a new constant",
          f'version = "{serve.APP_VERSION}"' in pyproject, str(serve.APP_VERSION))
    check("/score is unaffected — the version is on /health only (contract stays 2.x)",
          "app_version" not in client.post("/score", json=BODY, headers=JSON_CT).json())

    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "VERSION").write_text("9.9.9\n")
        app_dir = Path(tmp) / "app"
        app_dir.mkdir()
        (app_dir / "serve.py").write_text("")
        r = run_py("import serve, sys; from pathlib import Path\n"
                   "serve.__file__ = sys.argv[1]\n"
                   "print('VERSION<<%s>>' % serve.read_app_version())", str(app_dir / "serve.py"))
        check("an installed folder with no pyproject.toml falls back to the VERSION the installer wrote",
              "VERSION<<9.9.9>>" in r.stdout, r.stdout.strip() or r.stderr.strip()[-200:])

    # --allow-remote is the one way to another name, and it widens BOTH lists at once.
    remote = serve.allowed_hosts_for("192.168.1.10")
    app2 = serve.make_app(stub_engine(), remote, PORT)
    client2 = TestClient(app2, base_url=f"http://192.168.1.10:{PORT}")
    check("--allow-remote's host joins the allow-list, and the loopback names stay",
          remote == ["192.168.1.10", "127.0.0.1", "localhost"], str(remote))
    check("…and it is answered", client2.get("/health").status_code == 200)


# --- 4. the CLI agrees with all of that ------------------------------------------------------

print("\n-- --host --")


def serve_args(*args: str) -> tuple[int, str]:
    """serve.py's argument handling only. It is pointed at model paths that do not exist, so it
    always exits early — and WHICH complaint it exits with is how we tell a host it accepted
    from one it refused, without loading a model or binding a port."""
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run([sys.executable, str(DAEMON / "serve.py"),
                        "--model-dir", "/nonexistent/model", "--lid-model", "/nonexistent/lid.ftz", *args],
                       capture_output=True, text=True, timeout=300, env=env)
    return r.returncode, (r.stdout + r.stderr).strip()


def first_line(out: str) -> str:
    return out.splitlines()[0] if out else ""


# "it got past --host" = it reached the language model (missing, or fasttext not installed here).
def reached_the_model(out: str) -> bool:
    return "127.0.0.1 or localhost" not in out and ("is missing" in out or "not importable" in out)


for host in ("127.0.0.2", "::1", "0.0.0.0", "192.168.1.10"):
    code, out = serve_args("--host", host)
    check(f"--host {host} is refused, naming the two that work",
          code != 0 and "127.0.0.1 or localhost" in out, first_line(out))
for host in ("127.0.0.1", "localhost"):
    code, out = serve_args("--host", host)
    check(f"--host {host} gets past the host check (it stops at the missing model instead)",
          reached_the_model(out), first_line(out))
code, out = serve_args("--host", "0.0.0.0", "--allow-remote")
check("--allow-remote is still the deliberate way out", reached_the_model(out), first_line(out))

print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
sys.exit(1 if failed else 0)
