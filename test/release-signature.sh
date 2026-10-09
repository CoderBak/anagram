#!/bin/sh
# test/release-signature.sh — a release's Sigstore signature, checked as the installers check it.
#
# Needs the network: PyPI for the pinned verifier (installer/sigstore.txt) and uv's Python
# builds for the installer's own; Sigstore's update server is used where it answers. What
# signs is a real bundle of another project's — cosign v3.1.3's checksums file and its
# keyless bundle (test/fixtures/sigstore/) — since nothing outside it can sign as Anagram's
# release workflow. Shown:
#   - installer/verify_release.py with the pinned sigstore-python: the real bundle verifies,
#     with Sigstore's trust root as it is now and with the one the verifier carries; a changed
#     file, another identity and another issuer do not; its command refuses a signature from
#     anyone but Anagram's release workflow.
#   - install.sh over HTTPS (a local server with a certificate of its own): a release with no
#     signature, and one signed by somebody else, are refused before anything of them is
#     opened, and the component already installed is left as it was.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$ROOT/test/fixtures/sigstore"
T="$(mktemp -d "${TMPDIR:-/tmp}/anagram-signature-test.XXXXXX")"
SERVER=""
trap '[ -z "$SERVER" ] || kill "$SERVER" 2>/dev/null; rm -rf "$T"' EXIT INT TERM
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL  %s  —  %s\n' "$1" "$2"; }
UV="$(command -v uv)" || { echo "uv is required (https://docs.astral.sh/uv/)"; exit 2; }
if ! curl -fsS --max-time 15 -o /dev/null https://pypi.org/simple/sigstore/; then
  echo "SKIP  PyPI does not answer: these checks need the network"; exit 0
fi
ONLINE=0
curl -fsS --max-time 15 -o /dev/null https://tuf-repo-cdn.sigstore.dev/timestamp.json && ONLINE=1

# ---------------------------------------------------------------- the verifier
if "$UV" venv -q --python 3.12 "$T/v" && "$UV" pip install -q --python "$T/v/bin/python" --require-hashes --no-deps --no-build -r "$ROOT/installer/sigstore.txt"; then
  ok "the pinned verifier installs, every file's hash required"
else
  bad "the pinned verifier installs" "uv pip install failed"; echo "$pass passed, $fail failed"; exit 1
fi
results="$("$T/v/bin/python" -I - "$ROOT/installer" "$FIX" "$T" "$ONLINE" <<'PY'
import os, shutil, sys
installer, fix, tmp, online = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
os.environ.update(XDG_CACHE_HOME=os.path.join(tmp, "cache"), XDG_DATA_HOME=os.path.join(tmp, "data"))
sys.path.insert(0, installer)
import verify_release as release

signed = os.path.join(fix, "cosign_checksums.txt")
bundle = open(signed + ".sigstore.json", "rb").read()
WHO, GOOGLE = "keyless@projectsigstore.iam.gserviceaccount.com", "https://accounts.google.com"
changed = os.path.join(tmp, "changed.txt")
shutil.copy(signed, changed)
with open(changed, "a") as stream:
    stream.write("\n")

def verifies(*args, **kwargs):
    try:
        release.verify(*args, **kwargs)
        return True
    except Exception:
        return False

checks = {
    "a real bundle verifies against the trust root the verifier carries, offline": verifies(signed, bundle, WHO, GOOGLE, offline=True),
    "a changed file does not verify": not verifies(changed, bundle, WHO, GOOGLE, offline=True),
    "another identity does not verify": not verifies(signed, bundle, "release@example.com", GOOGLE, offline=True),
    "another issuer does not verify": not verifies(signed, bundle, WHO, release.ISSUER, offline=True),
    "the signer is read from the bundle's certificate": release.signers(bundle) == [WHO],
    "no signer but Anagram's release workflow names a version": release.signed_version(bundle) is None,
}
if online:
    checks["and against Sigstore's trust root as it is now"] = verifies(signed, bundle, WHO, GOOGLE, offline=False)
for name, good in checks.items():
    print(("PASS  " if good else "FAIL  ") + name)
PY
)"
printf '%s\n' "$results"
pass=$((pass + $(printf '%s\n' "$results" | grep -c '^PASS'))); fail=$((fail + $(printf '%s\n' "$results" | grep -c '^FAIL')))
[ "$ONLINE" = 1 ] || echo "NOTE  Sigstore's update server does not answer: its current trust root was not tried"
out="$("$T/v/bin/python" -I "$ROOT/installer/verify_release.py" "$FIX/cosign_checksums.txt" "$FIX/cosign_checksums.txt.sigstore.json" 2>&1)"; rc=$?
if [ $rc -eq 1 ] && echo "$out" | grep -q "not from Anagram's release workflow"; then
  ok "verify_release.py refuses a valid signature by anyone but Anagram's release workflow"
else bad "verify_release.py and a foreign signature" "rc=$rc $out"; fi

# ---------------------------------------------------------------- install.sh over HTTPS
export ANAGRAM_BROWSER=firefox ANAGRAM_EXTENSION_ID=anagram@coderbak.dev ANAGRAM_LANG=en
unset ANAGRAM_HOME ANAGRAM_MAINTENANCE_FD UV_DEFAULT_INDEX UV_INDEX_URL PIP_INDEX_URL PIP_CONFIG_FILE UV_CONFIG_FILE UV_PYTHON_INSTALL_MIRROR UV_INSTALLER_GITHUB_BASE_URL XDG_CONFIG_HOME
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=127.0.0.1 \
  -addext "subjectAltName=IP:127.0.0.1" -keyout "$T/key.pem" -out "$T/cert.pem" >/dev/null 2>&1 \
  || { bad "a certificate for the local server" "openssl failed"; echo "$pass passed, $fail failed"; exit 1; }
mkdir -p "$T/www/plain" "$T/www/foreign"
python3 - "$T/www" "$T/cert.pem" "$T/key.pem" "$T/port" <<'PY' &
import functools, http.server, ssl, sys
root, cert, key, portfile = sys.argv[1:5]
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=root))
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
open(portfile, "w").write(str(server.server_address[1]))
server.serve_forever()
PY
SERVER=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/port" ] && break; sleep 0.3; done
BASE="https://127.0.0.1:$(cat "$T/port")"

# A release as install.sh expects one, unsigned by Anagram.
R="$T/src/anagram"; mkdir -p "$R/app" "$R/extension" "$R/bin"
echo "9.9.10" > "$R/VERSION"; echo "new app" > "$R/app/engine.py"; echo "new extension" > "$R/extension/manifest.json"
printf '#!/bin/sh\necho NEW CLI\n' > "$R/bin/anagram"; chmod +x "$R/bin/anagram"; cp "$ROOT/install.sh" "$R/install.sh"
( cd "$T/src" && tar -czf "$T/www/plain/anagram.tar.gz" anagram )
( cd "$T/www/plain" && { shasum -a 256 anagram.tar.gz 2>/dev/null || sha256sum anagram.tar.gz; } > anagram.tar.gz.sha256 )
cp "$T/www/plain/"* "$T/www/foreign/"
cp "$FIX/cosign_checksums.txt.sigstore.json" "$T/www/foreign/anagram.tar.gz.sigstore.json"

# An installed component, whose uv is the real one under the version install.sh pins.
UVV="$(grep '^UV_VERSION=' "$ROOT/install.sh" | cut -d'"' -f2)"
H="$T/home"; mkdir -p "$H/bin" "$H/venv/bin" "$H/app" "$H/extension" "$T/user"
echo "Anagram installation folder." > "$H/.anagram-home"; echo "9.9.9" > "$H/VERSION"
echo "old app" > "$H/app/engine.py"; echo "old extension" > "$H/extension/manifest.json"
printf '#!/bin/sh\necho OLD CLI\n' > "$H/bin/anagram"; chmod +x "$H/bin/anagram"
printf '#!/bin/sh\nexit 0\n' > "$H/venv/bin/python"; chmod +x "$H/venv/bin/python"
printf '#!/bin/sh\nif [ "${1:-}" = --version ]; then echo "uv %s"; exit 0; fi\nexec "%s" "$@"\n' "$UVV" "$UV" > "$H/bin/uv"; chmod +x "$H/bin/uv"
installed() { printf '%s|%s|%s|%s' "$(cat "$H/VERSION")" "$(cat "$H/app/engine.py")" "$(cat "$H/extension/manifest.json")" "$("$H/bin/anagram")"; }
before="$(installed)"
install_from() { HOME="$T/user" ANAGRAM_HOME="$H" ANAGRAM_RELEASE_URL="$BASE/$1" CURL_CA_BUNDLE="$T/cert.pem" sh "$ROOT/install.sh" 2>&1; }

out="$(install_from plain)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "carries no signature" && [ "$(installed)" = "$before" ] && [ ! -e "$H/app.old" ]; then
  ok "install.sh: a release over HTTPS with no signature is refused, the component untouched"
else bad "unsigned release over HTTPS" "rc=$rc $(echo "$out" | tail -2 | tr '\n' ' ')"; fi
out="$(install_from foreign)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "not from Anagram's release workflow" && echo "$out" | grep -q "not signed by Anagram's release workflow" \
    && [ "$(installed)" = "$before" ] && [ ! -e "$H/app.old" ]; then
  ok "install.sh: a release signed by somebody else is refused, the component untouched"
else bad "foreign signature over HTTPS" "rc=$rc $(echo "$out" | tail -3 | tr '\n' ' ')"; fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
