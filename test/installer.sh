#!/bin/sh
# test/installer.sh — the installer and the anagram command must never touch anything that is
# not a real Anagram folder. Each case plants sentinel files where a careless implementation
# would delete or write, runs the real scripts, and checks the sentinels survived.
#
#   sh test/installer.sh                 # offline cases (no downloads: every refusal happens
#                                        #   first, and the one install runs off a local tarball)
#   INSTALLER_NET=1 sh test/installer.sh # + a full install under a hostile environment (needs
#                                        #   dist/ from `npm run release` and network)
set -u
export ANAGRAM_BROWSER=firefox ANAGRAM_EXTENSION_ID=anagram@coderbak.dev ANAGRAM_LANG=en
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/anagram-installer-test.XXXXXX")"
LISTENERS=""                                # throwaway servers this script started
trap 'for p in $LISTENERS; do kill "$p" 2>/dev/null; done; rm -rf "$T"' EXIT INT TERM
FAKE_HOME="$T/fakehome"; mkdir -p "$FAKE_HOME"
UNREACHABLE="http://127.0.0.1:9/nothing"   # every refusal must come BEFORE any download
pass=0; fail=0
ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf 'FAIL  %s  —  %s\n' "$1" "$2"; }
plant() { mkdir -p "$1/app" "$1/extension"; echo keep > "$1/app/KEEP"; echo keep > "$1/extension/KEEP"; echo keep > "$1/KEEP"; }
intact() { [ -f "$1/app/KEEP" ] && [ -f "$1/extension/KEEP" ] && [ -f "$1/KEEP" ]; }
run_install() { HOME="$FAKE_HOME" ANAGRAM_RELEASE_URL="$UNREACHABLE" sh "$ROOT/install.sh" "$@" 2>&1; }
cli() { d="$1"; shift; mkdir -p "$d/bin" && cp "$ROOT/installer/anagram" "$d/bin/anagram" && chmod +x "$d/bin/anagram" && HOME="$FAKE_HOME" "$d/bin/anagram" "$@" 2>&1 </dev/null; }
sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-64; }

# Everything a tree contains and what is in it: the "nothing was touched" evidence. Symbolic
# links are compared by target (never followed), regular files by checksum.
snapshot() {
  ( cd "$1" 2>/dev/null || exit 0
    find . -print | LC_ALL=C sort | while read -r p; do
      if [ -L "$p" ]; then printf '%s -> %s\n' "$p" "$(readlink "$p")"
      elif [ -f "$p" ]; then printf '%s  %s\n' "$p" "$(sha_of "$p")"
      else printf '%s/\n' "$p"; fi
    done )
}

# 1. ~/.anagram is a symlink to somebody's directory → refused, target untouched
plant "$T/victim"; ln -s "$T/victim" "$FAKE_HOME/.anagram"
out="$(HOME="$FAKE_HOME" ANAGRAM_RELEASE_URL="$UNREACHABLE" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "symbolic link" && intact "$T/victim"; then ok "symlinked ~/.anagram is refused and its target untouched"; else bad "symlinked ~/.anagram" "rc=$rc $(echo "$out" | tail -1)"; fi
rm -f "$FAKE_HOME/.anagram"

# 2. inherited ANAGRAM_HOME pointing at an existing project → refused, project untouched
plant "$T/project"
out="$(ANAGRAM_HOME="$T/project" run_install)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "not an Anagram folder" && intact "$T/project"; then ok "existing non-Anagram directory is refused untouched"; else bad "existing directory" "rc=$rc $(echo "$out" | tail -1)"; fi

# 3. bad shapes of ANAGRAM_HOME
for h in "relative/path" "/" "$FAKE_HOME" "$T/a/../b" "/tmp" "/usr/local"; do
  out="$(ANAGRAM_HOME="$h" run_install)"; rc=$?
  if [ $rc -ne 0 ] && ! echo "$out" | grep -q "Downloading"; then ok "ANAGRAM_HOME='$h' is refused before any download"; else bad "ANAGRAM_HOME='$h'" "rc=$rc $(echo "$out" | tail -1)"; fi
done

# 4. a symlink INSIDE an Anagram folder pointing elsewhere → refused
mkdir -p "$T/ok1" && echo x > "$T/ok1/.anagram-home"; plant "$T/victim2"; ln -s "$T/victim2/app" "$T/ok1/app"
out="$(ANAGRAM_HOME="$T/ok1" run_install)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "symbolic link" && intact "$T/victim2"; then ok "symlinked app/ inside the folder is refused"; else bad "inner symlink" "rc=$rc $(echo "$out" | tail -1)"; fi

# 5. a fresh empty folder passes validation and only THEN tries the network
out="$(ANAGRAM_HOME="$T/fresh" run_install)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "Downloading the Anagram release" && [ -f "$T/fresh/.anagram-home" ]; then ok "fresh folder: validated, marker written, download attempted"; else bad "fresh folder" "rc=$rc $(echo "$out" | tail -1)"; fi

# 6. anagram uninstall on a folder without the marker → refused
plant "$T/proj2"
out="$(cli "$T/proj2" uninstall -y)"; rc=$?
if [ $rc -ne 0 ] && intact "$T/proj2"; then ok "uninstall refuses a folder without the marker"; else bad "uninstall no marker" "rc=$rc $(echo "$out" | tail -1)"; fi
out="$(ANAGRAM_HOME="$T/proj2" cli "$T/proj2" uninstall -y)"; rc=$?
if [ $rc -ne 0 ] && intact "$T/proj2"; then ok "inherited ANAGRAM_HOME without the marker is refused"; else bad "inherited ANAGRAM_HOME" "rc=$rc"; fi

# 7. uninstall through a symlink to a real Anagram folder → refused (only the link is a lie)
plant "$T/ok2"; echo x > "$T/ok2/.anagram-home"; ln -s "$T/ok2" "$T/link2"
out="$(ANAGRAM_HOME="$T/link2" cli "$T/ok2" uninstall -y)"; rc=$?
if [ $rc -ne 0 ] && intact "$T/ok2"; then ok "uninstall refuses a symlinked ANAGRAM_HOME"; else bad "symlinked uninstall" "rc=$rc"; fi

# 8. non-interactive uninstall without -y → refused; with -y → removed
plant "$T/ok3"; echo x > "$T/ok3/.anagram-home"
out="$(cli "$T/ok3" uninstall)"; rc=$?
if [ $rc -ne 0 ] && intact "$T/ok3"; then ok "non-interactive uninstall without -y is refused"; else bad "no -y" "rc=$rc $(echo "$out" | tail -1)"; fi
out="$(cli "$T/ok3" uninstall -y)"; rc=$?
if [ $rc -eq 0 ] && [ ! -e "$T/ok3" ]; then ok "uninstall -y removes a real Anagram folder"; else bad "uninstall -y" "rc=$rc"; fi

# 9. the CLI refuses to derive a home from a location that is not an Anagram folder
mkdir -p "$T/stray/bin" && cp "$ROOT/installer/anagram" "$T/stray/bin/anagram"
out="$(HOME="$FAKE_HOME" sh "$T/stray/bin/anagram" status 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "not inside an Anagram folder"; then ok "CLI outside an Anagram folder refuses to run"; else bad "stray CLI" "rc=$rc $(echo "$out" | tail -1)"; fi

# ---------------------------------------------------------------------------------------
# `doctor` and `update` need a folder that looks installed, a Python that is not Python, and
# something on the port. None of it leaves this temp directory: a stub interpreter that
# imports nothing, and a throwaway HTTP server that answers /health the way anagramd does
# (mode "anagramd") or 404s everything (mode "foreign" — a program that simply took the port).
# ---------------------------------------------------------------------------------------
NODE="$(command -v node 2>/dev/null || true)"
PY3="$(command -v python3 2>/dev/null || true)"
cat > "$T/listen.js" <<'JS'
const http = require("node:http");
const [port, mode, contract, uptime] = process.argv.slice(2);
const body = JSON.stringify({ ok: true, contract, model: { id: "editlens_roberta-large", ver: "sha256:869f33df7928-pbeef1234-pre1", calibration: "editlens-4bucket" },
  n_buckets: 4, languages: ["en"], lid: "fasttext-lid.176", device: "cpu", dtype: "float32", uptime_s: Number(uptime), scored_blocks: 7 });
http.createServer((req, res) => {
  if (mode === "anagramd" && req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(body); }
  else if (["loading", "benchmarking", "awaiting_selection", "error"].includes(mode) && req.url === "/runtime") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ schema_version: 1, state: mode })); }
  else { res.writeHead(404, { "content-type": "text/plain" }); res.end("not anagramd\n"); }
}).listen(Number(port), "127.0.0.1");
JS
cat > "$T/listen.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port, mode, contract, uptime = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
body = json.dumps({"ok": True, "contract": contract,
                   "model": {"id": "editlens_roberta-large", "ver": "sha256:869f33df7928-pbeef1234-pre1", "calibration": "editlens-4bucket"},
                   "n_buckets": 4, "languages": ["en"], "lid": "fasttext-lid.176", "device": "cpu",
                   "dtype": "float32", "uptime_s": float(uptime), "scored_blocks": 7}).encode()
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        pending = mode in ("loading", "benchmarking", "awaiting_selection", "error") and self.path == "/runtime"
        payload = json.dumps({"schema_version": 1, "state": mode}).encode() if pending else body if (mode == "anagramd" and self.path == "/health") else b"not anagramd\n"
        self.send_response(200 if pending or payload is body else 404)
        self.send_header("content-type", "application/json" if payload is body else "text/plain")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(port)), H).serve_forever()
PY
if [ -n "$NODE" ]; then LISTEN="$NODE $T/listen.js"; elif [ -n "$PY3" ]; then LISTEN="$PY3 $T/listen.py"; else LISTEN=""; fi

# Start one; print its pid once it really answers, nothing when it never came up. Runs in a
# command substitution, so `listen` below is what records the pid for the exit trap.
start_listener() { # port mode [contract] [uptime_s]
  [ -n "$LISTEN" ] || return 1
  # shellcheck disable=SC2086  # LISTEN is "<interpreter> <script>", split on purpose
  $LISTEN "$1" "$2" "${3:-2.1}" "${4:-90}" >/dev/null 2>&1 &
  p=$!
  i=0
  while [ $i -lt 60 ]; do
    if curl -s -m 1 -o /dev/null "http://127.0.0.1:$1/"; then echo "$p"; return 0; fi
    kill -0 "$p" 2>/dev/null || return 1
    sleep 0.1; i=$((i + 1))
  done
  kill "$p" 2>/dev/null
  return 1
}
listen() { # → $LPID, and non-zero when nothing could be started
  LPID="$(start_listener "$@" || true)"
  [ -n "$LPID" ] && LISTENERS="$LISTENERS $LPID"
  [ -n "$LPID" ]
}
stop_listener() {
  [ -n "${1:-}" ] || return 0
  kill "$1" 2>/dev/null
  i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
}
# A port nothing is listening on (curl's exit 7 = connection refused).
free_port() {
  p="$1"
  while [ "$p" -lt 64000 ]; do
    rc=0; curl -s -m 1 -o /dev/null "http://127.0.0.1:$p/" >/dev/null 2>&1 || rc=$?
    [ "$rc" -eq 7 ] && { echo "$p"; return 0; }
    p=$((p + 1))
  done
  echo "$1"
}

# A complete-looking Anagram folder: every sub-folder, a version on both sides, stub model
# files, and the two checksums the doctor must compare them against — read out of the copy of
# install.sh the installer leaves in app/, exactly as a real folder carries it.
make_home() { # dir port
  h="$1"
  mkdir -p "$h/app" "$h/bin" "$h/extension" "$h/logs" "$h/models/editlens_roberta-large" \
           "$h/run" "$h/venv/bin" "$h/cache" "$h/hf" "$h/python"
  echo "Anagram installation folder." > "$h/.anagram-home"
  echo "9.9.9" > "$h/VERSION"
  printf '{\n  "manifest_version": 3,\n  "name": "Anagram",\n  "version": "9.9.9"\n}\n' > "$h/extension/manifest.json"
  printf 'PORT=%s\n' "$2" > "$h/config"
  printf '{"architectures": ["RobertaForSequenceClassification"], "num_labels": 4}\n' > "$h/models/editlens_roberta-large/config.json"
  printf 'these are not 1.4 GB of weights\n' > "$h/models/editlens_roberta-large/model.safetensors"
  printf 'this is not fastText\n' > "$h/models/lid.176.ftz"
  { echo '#!/bin/sh'
    echo '# stub of the installer copy every real folder carries; doctor reads (never runs) it'
    echo "WEIGHTS_SHA256=\"$(sha_of "$h/models/editlens_roberta-large/model.safetensors")\""
    echo "LID_SHA256=\"$(sha_of "$h/models/lid.176.ftz")\""
  } > "$h/app/install.sh"
  echo "print('serve')" > "$h/app/serve.py"
  echo "# native host fixture" > "$h/app/native_host.py"
  cp "$ROOT/installer/native_registration.py" "$h/app/native_registration.py"
  cp "$ROOT/anagramd/download_modelkit.py" "$h/app/download_modelkit.py"
  "$PY3" - "$h" <<'PY'
import hashlib, json, sys
from pathlib import Path
h = Path(sys.argv[1])
root = h / 'models/editlens_roberta-large'
for name in ('onnx/model.onnx', 'onnx/model_fp16.onnx', 'onnx/model_int8.onnx', 'tokenizer.json', 'LICENSE', 'NOTICE'):
    p = root / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('fixture ' + name)
contents = {str(p.relative_to(root)): p.read_text() for p in root.rglob('*') if p.is_file()}
(h / 'app/fixture.json').write_text(json.dumps(contents))
(h / 'app/modelkit.json').write_text(json.dumps({'schema_version':1, 'repository':'fixture/model', 'revision':'a'*40, 'files':[
    {'path':name, 'size_bytes':len(value.encode()), 'sha256':hashlib.sha256(value.encode()).hexdigest()} for name,value in contents.items()]}))
PY
  h_real="$(cd "$h" && pwd -P)"
  cat > "$h/venv/bin/python" <<STUB
#!/bin/sh
# stub venv/bin/python: imports nothing, opens no socket of its own, reaches no network.
[ "\${1:-}" = -I ] && shift
case "\${1:-}" in
  */native_registration.py) exec "$PY3" "\$@" ;;
  */download_modelkit.py) exec "$PY3" "$ROOT/test/modelkit.py" --fixture "\$@" ;;
  -) cat > /dev/null                                  # the probe arrives on stdin
     if [ -n "\${HEALTH_JSON:-}" ]; then echo "running · stub daemon"; exit 0; fi
     if [ -n "\${RUNTIME_JSON:-}" ]; then printf '%s' "\$RUNTIME_JSON" | "$PY3" -c 'import json,sys; d=json.load(sys.stdin); assert d["schema_version"]==1; print(d["state"])'; exit \$?; fi
     echo "version 3.12.13"
     for m in torch transformers fastapi uvicorn fasttext emoji huggingface_hub; do echo "import \$m ok"; done
     exit 0 ;;
esac
port=8765; runtime_config=""                          # "python app/serve.py … --port N"
while [ \$# -gt 0 ]; do case "\$1" in --port) port="\$2" ;; --runtime-config) runtime_config="\$2" ;; esac; shift; done
case "\$runtime_config" in "$h/runtime.json"|"$h_real/runtime.json") ;; *) echo 'wrong runtime config path'; exit 2 ;; esac
echo "stub daemon on \$port"
mode=anagramd
[ -f "$h/RUNTIME_STATE" ] && mode="\$(cat "$h/RUNTIME_STATE")"
exec $LISTEN "\$port" "\$mode" 2.1 1
STUB
  chmod +x "$h/venv/bin/python"
  cp "$ROOT/installer/anagram" "$h/bin/anagram" && chmod +x "$h/bin/anagram"
}

P1="$(free_port $((20000 + $$ % 9000)))"; P2="$(free_port $((P1 + 1)))"
P3="$(free_port $((P2 + 1)))"; P4="$(free_port $((P3 + 1)))"

# 10. doctor on a complete folder with a daemon answering → every line ok, exit 0
H1="$T/dochome"; make_home "$H1" "$P1"
mkdir -p "$T/outside"; echo keep > "$T/outside/KEEP"
if ! listen "$P1" anagramd; then
  bad "doctor on a healthy folder" "no stub daemon on 127.0.0.1:$P1 (node/python3 missing?)"
else
  dpid="$LPID"
  echo "$dpid" > "$H1/run/anagramd.pid"
  before_home="$(snapshot "$H1")"; before_out="$(snapshot "$T/outside")"; before_fake="$(snapshot "$FAKE_HOME")"
  out="$(cli "$H1" doctor)"; rc=$?
  oks="$(echo "$out" | grep -c '^ok ')"
  if [ $rc -eq 0 ] && ! echo "$out" | grep -q "FAIL" && [ "$oks" -ge 8 ]; then
    ok "doctor on a healthy folder: $oks ok lines, no FAIL, exit 0"
  else bad "doctor healthy" "rc=$rc $(echo "$out" | grep -v '^ok' | tail -3)"; fi
  if [ "$before_home" = "$(snapshot "$H1")" ] && [ "$before_out" = "$(snapshot "$T/outside")" ] && [ "$before_fake" = "$(snapshot "$FAKE_HOME")" ]; then
    ok "doctor created, changed and removed nothing (listing + checksums identical)"
  else bad "doctor is read-only" "the folder, its neighbour or the fake HOME changed under doctor"; fi
  if echo "$out" | grep -q "contract 2.1" && echo "$out" | grep -q "editlens_roberta-large"; then
    ok "doctor prints the daemon's model, device, language gate and contract"
  else bad "doctor daemon line" "$(echo "$out" | grep daemon)"; fi

  # 11. version tells the installed build from the running one
  touch -t 202001010000 "$H1/VERSION"       # installed long before the daemon started
  out="$(cli "$H1" version)"; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "9.9.9" && echo "$out" | grep -q "daemon running this build"; then
    ok "version: a daemon started after the install is reported as that build"
  else bad "version (same build)" "rc=$rc $out"; fi
  touch "$H1/VERSION"                       # an update landed under the running daemon
  out="$(cli "$H1" version)"; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "restart to run the updated daemon"; then
    ok "version: a VERSION newer than the running process says to restart"
  else bad "version (stale daemon)" "rc=$rc $out"; fi
  stop_listener "$dpid"; rm -f "$H1/run/anagramd.pid"

  # 12. a daemon speaking another contract major → FAIL, "run anagram update"
  if listen "$P1" anagramd 3.0; then
    echo "$LPID" > "$H1/run/anagramd.pid"
    out="$(cli "$H1" doctor)"; rc=$?
    if [ $rc -ne 0 ] && echo "$out" | grep -q "contract 3.0" && echo "$out" | grep -q "anagram update"; then
      ok "doctor: a daemon with the wrong contract major says to run anagram update"
    else bad "doctor contract" "rc=$rc $(echo "$out" | grep -i contract | head -2)"; fi
    stop_listener "$LPID"; rm -f "$H1/run/anagramd.pid"
  else bad "doctor contract" "no stub daemon on 127.0.0.1:$P1"; fi
fi

# 13. no checkpoint → the checkpoint line FAILs and says which command fetches it
H2="$T/nomodel"; make_home "$H2" "$P2"; rm -f "$H2/models/editlens_roberta-large/model.safetensors"
before="$(snapshot "$H2")"
out="$(cli "$H2" doctor)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "^FAIL  checkpoint" && echo "$out" | grep -q "anagram model" && [ "$before" = "$(snapshot "$H2")" ]; then
  ok "doctor: a missing checkpoint FAILs, exit 1, folder untouched"
else bad "doctor missing model" "rc=$rc $(echo "$out" | grep FAIL | head -2)"; fi

# 14. a weight file that is not the pinned one → FAIL naming both checksums
H3="$T/badsha"; make_home "$H3" "$P2"; printf 'tampered\n' > "$H3/models/editlens_roberta-large/model.safetensors"
before="$(snapshot "$H3")"
out="$(cli "$H3" doctor)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "^FAIL  checkpoint" && echo "$out" | grep -q "the pinned checkpoint is" && [ "$before" = "$(snapshot "$H3")" ]; then
  ok "doctor: weights that do not match the pinned sha256 FAIL, folder untouched"
else bad "doctor wrong checksum" "rc=$rc $(echo "$out" | grep FAIL | head -2)"; fi

# 15. a symlinked logs/ → FAIL before anything reads or writes through it, target untouched
H4="$T/linkedlogs"; make_home "$H4" "$P2"; plant "$T/logvictim"
rm -rf "$H4/logs"; ln -s "$T/logvictim" "$H4/logs"
before="$(snapshot "$T/logvictim")"
out="$(cli "$H4" doctor)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "^FAIL  folder" && echo "$out" | grep -q "logs" && intact "$T/logvictim" && [ "$before" = "$(snapshot "$T/logvictim")" ]; then
  ok "doctor: a symlinked logs/ FAILs and its target is neither read through nor written"
else bad "doctor symlinked logs" "rc=$rc $(echo "$out" | grep FAIL | head -2)"; fi

# 16. a pid file whose process is gone, with nothing on the port → stale, FAIL
H5="$T/stalepid"; make_home "$H5" "$P3"
echo 999999 > "$H5/run/anagramd.pid"          # a pid that cannot be running
before="$(snapshot "$H5")"
out="$(cli "$H5" doctor)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "stale pid file" && [ "$before" = "$(snapshot "$H5")" ]; then
  ok "doctor: a stale pid file FAILs and is left exactly where it is"
else bad "doctor stale pid" "rc=$rc $(echo "$out" | grep FAIL | head -2)"; fi

# 17. somebody else's program on our port → FAIL, and it is not killed
H6="$T/foreign"; make_home "$H6" "$P4"
if ! listen "$P4" foreign; then
  bad "doctor with a foreign listener" "no stub listener on 127.0.0.1:$P4"
else
  fpid="$LPID"
  before="$(snapshot "$H6")"
  out="$(cli "$H6" doctor)"; rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q "^FAIL  port" && kill -0 "$fpid" 2>/dev/null && [ "$before" = "$(snapshot "$H6")" ]; then
    ok "doctor: another program on the port FAILs, stays alive, folder untouched"
  else bad "doctor foreign listener" "rc=$rc $(echo "$out" | grep FAIL | head -2)"; fi
  stop_listener "$fpid"
fi

# 18. doctor outside an Anagram folder, and through a symlink to one → refused like the rest
out="$(HOME="$FAKE_HOME" sh "$T/stray/bin/anagram" doctor 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "not inside an Anagram folder"; then
  ok "doctor outside an Anagram folder refuses to run"
else bad "doctor outside" "rc=$rc $(echo "$out" | tail -1)"; fi
ln -s "$T/stalepid" "$T/stalelink"
out="$(ANAGRAM_HOME="$T/stalelink" cli "$T/stalepid" doctor)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "refusing to use it"; then
  ok "doctor refuses a symlinked ANAGRAM_HOME"
else bad "doctor symlinked home" "rc=$rc $(echo "$out" | tail -1)"; fi

# 19. start records the DAEMON's pid, not a shell wrapping it — otherwise stop (and the
#     restart inside update) would kill the wrapper and leave the daemon holding the port
HS="$T/startstop"; make_home "$HS" "$P1"
out="$(cli "$HS" start)"; rc=$?
spid="$(cat "$HS/run/anagramd.pid" 2>/dev/null || true)"
[ -n "$spid" ] && LISTENERS="$LISTENERS $spid"
if [ $rc -ne 0 ] || ! curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$P1/health"; then
  bad "start/stop" "start did not bring the stub daemon up: rc=$rc $(echo "$out" | tail -1)"
else
  out="$(cli "$HS" stop)"; rc2=$?
  if [ $rc2 -eq 0 ] && ! kill -0 "$spid" 2>/dev/null \
     && ! curl -fs -m 2 -o /dev/null "http://127.0.0.1:$P1/health" 2>/dev/null && [ ! -f "$HS/run/anagramd.pid" ]; then
    ok "start records the daemon's own pid; stop leaves nothing running on the port"
  else bad "start/stop" "rc=$rc2 pid $spid still alive or port still answering"; fi
fi

# 20. update: the installer succeeded and our daemon was running → it is restarted
H7="$T/upd-ok"; make_home "$H7" "$P2"
cat > "$H7/app/install.sh" <<'SH'
#!/bin/sh
# stub installer: succeeds, writes only inside the folder it was handed
echo "==> stub installer ran"
: > "$ANAGRAM_HOME/app/INSTALL_RAN"
SH
cli "$H7" start > /dev/null 2>&1                 # started the way a user starts it
dpid="$(cat "$H7/run/anagramd.pid" 2>/dev/null || true)"
[ -n "$dpid" ] && LISTENERS="$LISTENERS $dpid"
if [ -z "$dpid" ] || ! curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$P2/health"; then
  bad "update restarts a running daemon" "the stub daemon would not start on 127.0.0.1:$P2"
else
  out="$(cli "$H7" update)"; rc=$?
  newpid="$(cat "$H7/run/anagramd.pid" 2>/dev/null || true)"
  LISTENERS="$LISTENERS $newpid"
  if [ $rc -eq 0 ] && [ -f "$H7/app/INSTALL_RAN" ] && echo "$out" | grep -q "Restarting the daemon" \
     && ! kill -0 "$dpid" 2>/dev/null && [ "$newpid" != "$dpid" ] && kill -0 "$newpid" 2>/dev/null \
     && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$P2/health"; then
    ok "update: a running daemon is stopped and started again on the new code"
  else bad "update restart" "rc=$rc old=$dpid new=$newpid $(echo "$out" | tail -2)"; fi
  stop_listener "$newpid"
fi

# 21. update: the installer failed → the running daemon is left alone
H8="$T/upd-fail"; make_home "$H8" "$P3"
cat > "$H8/app/install.sh" <<'SH'
#!/bin/sh
echo "==> stub installer is about to fail"
: > "$ANAGRAM_HOME/app/INSTALL_TRIED"
exit 3
SH
cli "$H8" start > /dev/null 2>&1
dpid="$(cat "$H8/run/anagramd.pid" 2>/dev/null || true)"
[ -n "$dpid" ] && LISTENERS="$LISTENERS $dpid"
if [ -z "$dpid" ] || ! curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$P3/health"; then
  bad "update leaves a running daemon alone" "the stub daemon would not start on 127.0.0.1:$P3"
else
  out="$(cli "$H8" update)"; rc=$?
  if [ $rc -ne 0 ] && [ -f "$H8/app/INSTALL_TRIED" ] && echo "$out" | grep -q "left alone" \
     && kill -0 "$dpid" 2>/dev/null && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$P3/health" \
     && [ "$(cat "$H8/run/anagramd.pid")" = "$dpid" ]; then
    ok "update: a failed installer leaves the running daemon (and its pid file) alone"
  else bad "update failure" "rc=$rc $(echo "$out" | tail -2)"; fi
  stop_listener "$dpid"
fi

# 22. update through a symlinked ANAGRAM_HOME → refused before the installer is run at all
H9="$T/upd-link"; make_home "$H9" "$P4"
cat > "$H9/app/install.sh" <<'SH'
#!/bin/sh
: > "$ANAGRAM_HOME/app/INSTALL_RAN"
SH
ln -s "$H9" "$T/upd-link-alias"
out="$(ANAGRAM_HOME="$T/upd-link-alias" cli "$H9" update)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "refusing to use it" && [ ! -f "$H9/app/INSTALL_RAN" ]; then
  ok "update refuses a symlinked ANAGRAM_HOME before running any installer"
else bad "update symlinked home" "rc=$rc $(echo "$out" | tail -1)"; fi

# 22b. update with no app/install.sh in the folder → a refusal that names the one-line
#      install. Until 2026-09-20 this case fetched install.sh from GitHub and piped it into
#      a shell: an unread script, run with this folder's name in its environment, by a
#      command the user asked to update something they already had.
HNI="$T/upd-no-installer"; make_home "$HNI" "$P4"
cli "$HNI" version > /dev/null 2>&1            # so bin/anagram is in place before the snapshot
rm -f "$HNI/app/install.sh"
before="$(snapshot "$HNI")"
out="$(cli "$HNI" update)"; rc=$?
if [ $rc -ne 0 ] \
   && echo "$out" | grep -q "no app/install.sh" \
   && echo "$out" | grep -q "releases/latest/download/install.sh | sh" \
   && [ ! -f "$HNI/app/install.sh" ] && [ "$before" = "$(snapshot "$HNI")" ]; then
  ok "update with no installer in the folder refuses and names the command, fetching nothing"
else bad "update without app/install.sh" "rc=$rc $(echo "$out" | tail -3)"; fi

# 23. an update over an existing folder replaces the command by RENAME, not in place.
#     `anagram update` runs the installer, so bin/anagram is the very script executing while
#     it is replaced — a copy onto it truncates it under the shell still reading it. A hard
#     link stands in for that open file: after a rename it still reads the OLD bytes, after a
#     copy it would read the new ones. No network anywhere: the release is a tarball this
#     test builds and hands over file://, uv is already there at the pinned version so that
#     step is skipped, venv/bin/python is a stub, and the model is skipped.
UVV="$(grep '^UV_VERSION=' "$ROOT/install.sh" | cut -d'"' -f2)"
RELDIR="$T/rel"; mkdir -p "$RELDIR/src/anagram/app" "$RELDIR/src/anagram/extension" "$RELDIR/src/anagram/bin"
echo "9.9.10" > "$RELDIR/src/anagram/VERSION"
echo "new app" > "$RELDIR/src/anagram/app/serve.py"
echo "# native host fixture" > "$RELDIR/src/anagram/app/native_host.py"
cp "$ROOT/installer/native_registration.py" "$RELDIR/src/anagram/app/native_registration.py"
echo "new extension" > "$RELDIR/src/anagram/extension/manifest.json"
printf '#!/bin/sh\necho NEW CLI\n' > "$RELDIR/src/anagram/bin/anagram"; chmod +x "$RELDIR/src/anagram/bin/anagram"
cp "$ROOT/install.sh" "$RELDIR/src/anagram/install.sh"
( cd "$RELDIR/src" && tar -czf "$RELDIR/anagram.tar.gz" anagram )
sha_of "$RELDIR/anagram.tar.gz" > "$RELDIR/anagram.tar.gz.sha256"

HU="$T/update-home"; mkdir -p "$HU/bin" "$HU/venv/bin" "$HU/app" "$HU/extension"
echo "Anagram installation folder." > "$HU/.anagram-home"
printf '#!/bin/sh\necho OLD CLI\n' > "$HU/bin/anagram"; chmod +x "$HU/bin/anagram"
echo "9.9.9" > "$HU/VERSION"
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$HU/bin/uv"; chmod +x "$HU/bin/uv"
printf '#!/bin/sh\nexit 0\n' > "$HU/venv/bin/python"; chmod +x "$HU/venv/bin/python"
ln "$HU/bin/anagram" "$T/held-cli"          # the file the running command has open
ln "$HU/VERSION" "$T/held-version"
before_out="$(snapshot "$T/outside")"; before_fake="$(snapshot "$FAKE_HOME")"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HU" ANAGRAM_RELEASE_URL="file://$RELDIR" ANAGRAM_SKIP_MODEL=1 sh "$ROOT/install.sh" 2>&1)"; rc=$?
leftover="$(find "$HU" -name '*.new' 2>/dev/null | tr '\n' ' ')"
if [ $rc -eq 0 ] && grep -q "NEW CLI" "$HU/bin/anagram" && [ -x "$HU/bin/anagram" ] && grep -q "OLD CLI" "$T/held-cli"; then
  ok "update: the command is renamed over, so a running anagram keeps reading the old file"
else bad "atomic bin/anagram" "rc=$rc held=$(head -2 "$T/held-cli" | tail -1) $(echo "$out" | tail -1)"; fi
if [ "$(cat "$HU/VERSION")" = "9.9.10" ] && [ "$(cat "$T/held-version")" = "9.9.9" ] && [ -z "$leftover" ]; then
  ok "update: VERSION is renamed over too, and no .new file is left behind"
else bad "atomic VERSION" "VERSION=$(cat "$HU/VERSION") held=$(cat "$T/held-version") leftover='$leftover'"; fi
if [ "$before_out" = "$(snapshot "$T/outside")" ] && [ "$before_fake" = "$(snapshot "$FAKE_HOME")" ] && [ "$(cat "$HU/app/serve.py")" = "new app" ]; then
  ok "update: the new app/ and extension/ landed, and nothing outside the folder moved"
else bad "offline update side effects" "app=$(cat "$HU/app/serve.py" 2>/dev/null)"; fi

# 24. `anagram model` on a folder whose two models both match their pinned checksums downloads
#     nothing at all — the command that reaches the internet only does so when it must.
HM="$T/model-cli"; make_home "$HM" "$P2"
before="$(snapshot "$HM")"
out="$(HOME="$FAKE_HOME" "$HM/bin/anagram" model 2>&1 </dev/null)"; rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q "nothing to download" && [ "$before" = "$(snapshot "$HM")" ]; then
  ok "anagram model: both models already verified → nothing downloaded, nothing touched"
else bad "anagram model (already verified)" "rc=$rc $(echo "$out" | tail -1)"; fi

# 25. a checkpoint that arrives whole and matches the pinned checksum is renamed into place,
#     and the staging directory it came down into is gone afterwards.
rm -f "$HM/models/editlens_roberta-large/model.safetensors"
out="$(HOME="$FAKE_HOME" "$HM/bin/anagram" model 2>&1 </dev/null)"; rc=$?
incoming="$HM/models/.incoming-editlens_roberta-large"
if [ $rc -eq 0 ] && [ -f "$HM/models/editlens_roberta-large/model.safetensors" ] \
   && [ "$(sha_of "$HM/models/editlens_roberta-large/model.safetensors")" = "$(sed -n 's/^WEIGHTS_SHA256="\([0-9a-f]*\)".*/\1/p' "$HM/app/install.sh")" ] \
   && [ ! -e "$incoming" ] && echo "$out" | grep -q "verified"; then
  ok "anagram model: a checkpoint that verifies is renamed into place, staging directory gone"
else bad "anagram model (verified download)" "rc=$rc incoming=$([ -e "$incoming" ] && echo left) $(echo "$out" | tail -1)"; fi

# 26. a staging directory from a download that never finished is worth keeping only while it
#     can still be resumed — once the full modelkit is verified it no longer serves a purpose.
mkdir -p "$incoming"; printf 'the half that arrived\n' > "$incoming/model.safetensors"
out="$(HOME="$FAKE_HOME" "$HM/bin/anagram" model 2>&1 </dev/null)"; rc=$?
if [ $rc -eq 0 ] && [ ! -e "$incoming" ] && echo "$out" | grep -q "nothing to download"; then
  ok "anagram model: a staging directory that can no longer be resumed is cleaned up"
else bad "stale staging directory" "rc=$rc $(echo "$out" | tail -1)"; fi

# 27. a download that does NOT match the pinned checksum is never promoted: the checkpoint that
#     was already there is untouched, the bad bytes stay in the staging directory (so a re-run
#     reuses verified complete files on retry), and the command fails.
: > "$HM/TAMPER"                                  # the stub python now writes a cut-off file
# The checkpoint on disk no longer matches, which is what sends the command back to the Hub.
printf 'the checkpoint that was already here\n' > "$HM/models/editlens_roberta-large/model.safetensors"
good="$(sha_of "$HM/models/editlens_roberta-large/model.safetensors")"
out="$(HOME="$FAKE_HOME" "$HM/bin/anagram" model 2>&1 </dev/null)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "nothing was replaced" \
   && [ "$(sha_of "$HM/models/editlens_roberta-large/model.safetensors")" = "$good" ] \
   && [ -f "$incoming/model.safetensors" ]; then
  ok "anagram model: an interrupted download is refused, kept aside, and never loadable"
else bad "anagram model (bad checksum)" "rc=$rc $(echo "$out" | tail -1)"; fi
rm -f "$HM/TAMPER"; rm -rf "$incoming"

# 28. the same in install.sh: its checkpoint step downloads into a staging directory, verifies
#     it there, and leaves the folder exactly as it was when the bytes are not the pinned ones.
#     Offline throughout — the release comes off file://, uv is already at the pinned version,
#     venv/bin/python is a stub that stands in for the download, and the run dies before the
#     language model (the only other thing this step would fetch) is ever asked for.
HM2="$T/model-install"; make_home "$HM2" "$P2"
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$HM2/bin/uv"; chmod +x "$HM2/bin/uv"
: > "$HM2/TAMPER"
cp "$HM2/app/download_modelkit.py" "$HM2/app/modelkit.json" "$HM2/app/fixture.json" "$RELDIR/src/anagram/app/"
( cd "$RELDIR/src" && tar -czf "$RELDIR/anagram.tar.gz" anagram )
sha_of "$RELDIR/anagram.tar.gz" > "$RELDIR/anagram.tar.gz.sha256"
rm -f "$HM2/models/lid.176.ftz"
printf 'the checkpoint that was already here\n' > "$HM2/models/editlens_roberta-large/model.safetensors"
good="$(sha_of "$HM2/models/editlens_roberta-large/model.safetensors")"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HM2" ANAGRAM_DOWNLOAD_MODELS=1 ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "nothing was replaced" \
   && [ "$(sha_of "$HM2/models/editlens_roberta-large/model.safetensors")" = "$good" ] \
   && [ ! -e "$HM2/models/lid.176.ftz" ] \
   && [ -f "$HM2/models/.incoming-editlens_roberta-large/model.safetensors" ]; then
  ok "install.sh: a checkpoint that does not verify replaces nothing and stops before any other download"
else bad "install.sh staged checkpoint" "rc=$rc $(echo "$out" | tail -2)"; fi

# Default installation registers the host and leaves model/setup work to the browser.
HFIRST="$T/first-start"; make_home "$HFIRST" "$P3"
rm -f "$HFIRST/VERSION"
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$HFIRST/bin/uv"; chmod +x "$HFIRST/bin/uv"
cp "$ROOT/installer/anagram" "$RELDIR/src/anagram/bin/anagram"
( cd "$RELDIR/src" && tar -czf "$RELDIR/anagram.tar.gz" anagram )
sha_of "$RELDIR/anagram.tar.gz" > "$RELDIR/anagram.tar.gz.sha256"
# Clear only the prior fixture's exact owned registration through the real helper.
HOME="$FAKE_HOME" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$HM2" >/dev/null 2>&1
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HFIRST" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ -f "$HFIRST/.native-component.json" ] && [ ! -f "$HFIRST/run/anagramd.pid" ] && echo "$out" | grep -q "Return to the extension"; then
  ok "fresh installation registers native host without starting HTTP or downloading models"
else bad "fresh native install" "rc=$rc $out"; fi
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HFIRST" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ ! -f "$HFIRST/run/anagramd.pid" ]; then
  ok "installer rerun updates exact owned registration without starting a daemon"
else bad "installer native rerun" "rc=$rc $out"; fi
HOME="$FAKE_HOME" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$HFIRST" >/dev/null 2>&1
# A browser registration conflict must restore the previous app and private env.
HROLL="$T/rollback-home"; make_home "$HROLL" "$P3"
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$HROLL/bin/uv"; chmod +x "$HROLL/bin/uv"
case "$(uname -s)" in
  Darwin) registration="$FAKE_HOME/Library/Application Support/Mozilla/NativeMessagingHosts/dev.coderbak.anagram.json" ;;
  *) registration="$FAKE_HOME/.mozilla/native-messaging-hosts/dev.coderbak.anagram.json" ;;
esac
mkdir -p "$(dirname "$registration")"; printf 'foreign owner\n' > "$registration"
app_before="$(snapshot "$HROLL/app")"; env_before="$(snapshot "$HROLL/venv")"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HROLL" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && [ "$app_before" = "$(snapshot "$HROLL/app")" ] && [ "$env_before" = "$(snapshot "$HROLL/venv")" ] \
   && [ "$(cat "$HROLL/VERSION")" = 9.9.9 ] && [ "$(cat "$registration")" = 'foreign owner' ] && [ ! -e "$HROLL/app.old" ] && [ ! -e "$HROLL/venv.old" ]; then
  ok "registration conflict rolls back app, version and private environment while preserving foreign registration"
else bad "native installation rollback" "rc=$rc $out"; fi
rm -f "$registration"
if "$PY3" "$ROOT/test/native_registration.py" > "$T/native-tests.log" 2>&1; then
  ok "native registration containment, exact origins, inventory and rollback tests pass"
else bad "native registration tests" "$(tail -n 8 "$T/native-tests.log")"; fi

# 29. a proxy in the environment must not hide the daemon. curl has no loopback exception, so
#     with http_proxy set, every probe this script makes about 127.0.0.1 went to the proxy —
#     which cannot reach a port on this machine, so `status` and `doctor` reported the daemon
#     down (and told a company's proxy which ports somebody is asking about). Dead proxy, live
#     daemon → still found.
HP="$T/proxyhome"; make_home "$HP" "$P3"
if ! listen "$P3" anagramd; then
  bad "a proxy does not hide the daemon" "no stub daemon on 127.0.0.1:$P3"
else
  ppid="$LPID"
  echo "$ppid" > "$HP/run/anagramd.pid"
  out="$(HOME="$FAKE_HOME" http_proxy="http://127.0.0.1:9" https_proxy="http://127.0.0.1:9" \
        HTTP_PROXY="http://127.0.0.1:9" "$HP/bin/anagram" status 2>&1 </dev/null)"; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "running"; then
    ok "a proxy in the environment does not hide the daemon on 127.0.0.1"
  else bad "a proxy does not hide the daemon" "rc=$rc $(echo "$out" | tail -1)"; fi
  stop_listener "$ppid"
fi

# Pending first-run setup is a live control server, not a failed installation.
HR="$T/runtime-home"; make_home "$HR" "$P3"
echo awaiting_selection > "$HR/RUNTIME_STATE"
out="$(HOME="$FAKE_HOME" "$HR/bin/anagram" start 2>&1)"; rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q "awaiting configuration"; then
  ok "start succeeds when runtime is awaiting selection and /health is unavailable"
else bad "runtime start" "rc=$rc $out"; fi
out="$(HOME="$FAKE_HOME" "$HR/bin/anagram" status 2>&1)"; rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q "first-run page or Settings"; then
  ok "status explains the pending first-run choice"
else bad "runtime status" "rc=$rc $out"; fi
out="$(HOME="$FAKE_HOME" "$HR/bin/anagram" doctor 2>&1)"; rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q "runtime control is available: awaiting_selection"; then
  ok "doctor recognizes first-run runtime and does not report a foreign port"
else bad "runtime doctor" "rc=$rc $out"; fi
HOME="$FAKE_HOME" "$HR/bin/anagram" stop >/dev/null 2>&1
if "$PY3" "$ROOT/test/modelkit.py" > "$T/modelkit-tests.log" 2>&1; then
  ok "all offline modelkit integrity/cache/anonymous-download tests pass"
else bad "modelkit tests" "$(tail -n 8 "$T/modelkit-tests.log")"; fi

# 30. (network) full install under a hostile environment: nothing lands outside the folder
if [ -n "${INSTALLER_NET:-}" ]; then
  [ -f "$ROOT/dist/anagram.tar.gz" ] || { bad "network install" "run npm run release first"; }
  H="$T/nethome/.anagram"; mkdir -p "$T/nethome"
  out="$(HOME="$T/nethome" ANAGRAM_HOME="$H" ANAGRAM_RELEASE_URL="file://$ROOT/dist" ANAGRAM_SKIP_MODEL=1 \
        UV_INSTALL_DIR="$T/evil1" CARGO_DIST_FORCE_INSTALL_DIR="$T/evil2" UV_PYTHON_INSTALL_DIR="$T/evil3" XDG_DATA_HOME="$T/evil4" \
        UV_CACHE_DIR="$T/evil5" UV_PROJECT_ENVIRONMENT="$T/evil6" UV_TOOL_DIR="$T/evil7" PYTHONPATH="$T/evil8" PYTHONHOME="" UV_CONFIG_FILE="$T/evil9" \
        sh "$ROOT/install.sh" 2>&1)"; rc=$?
  leaked="$(ls -d "$T"/evil* 2>/dev/null | tr '\n' ' ')"
  H_REAL="$(cd "$H" 2>/dev/null && pwd -P)"   # macOS: /var/folders → /private/var/folders
  if [ $rc -eq 0 ] && [ -z "$leaked" ] && [ -x "$H/bin/uv" ] && [ -x "$H/venv/bin/python" ] && [ -d "$H/python" ] && [ "$(HOME="$T/nethome" "$H/venv/bin/python" -c 'import os, sys; p = os.path.realpath(sys.prefix); print(p.startswith(sys.argv[1]) or p.startswith(sys.argv[2]))' "$H" "$H_REAL")" = "True" ]; then
    ok "hostile UV_*/XDG_*/PYTHON* environment: everything landed inside the folder ($(du -sh "$H" | cut -f1))"
  else bad "hostile environment install" "rc=$rc leaked='$leaked' $(echo "$out" | tail -1)"; fi
  out="$(HOME="$T/nethome" "$H/bin/anagram" uninstall -y 2>&1)"; rc=$?
  if [ $rc -eq 0 ] && [ -z "$(ls -A "$T/nethome")" ]; then ok "uninstall after the network install leaves the home empty"; else bad "network uninstall" "rc=$rc"; fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ $fail -eq 0 ]
