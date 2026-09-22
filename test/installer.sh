#!/bin/sh
# Offline installer containment, atomic replacement and native registration tests.
set -u
export ANAGRAM_BROWSER=firefox ANAGRAM_EXTENSION_ID=anagram@coderbak.dev ANAGRAM_LANG=en
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/anagram-installer-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT INT TERM
FAKE_HOME="$T/fakehome"; mkdir -p "$FAKE_HOME"
UNREACHABLE="file:///nonexistent/anagram-release"   # every refusal must come BEFORE any download
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

# Fixed leaf paths must not redirect writes, including failure rollback.
for leaf in .anagram-home VERSION bin/anagram bin/anagram.new bin/uv bin/uv.new .native-host.lock; do
  guarded="$T/leaf-$(echo "$leaf" | tr / _)"
  mkdir -p "$guarded/bin"
  echo owned > "$guarded/.anagram-home"
  victim="$T/victim-$(echo "$leaf" | tr / _)"
  printf 'personal data must survive\n' > "$victim"
  rm -f "$guarded/$leaf"
  ln -s "$victim" "$guarded/$leaf"
  out="$(ANAGRAM_HOME="$guarded" run_install)"; rc=$?
  if [ $rc -ne 0 ] && ! echo "$out" | grep -q 'Downloading' && [ "$(cat "$victim")" = 'personal data must survive' ]; then
    ok "symlinked $leaf rejected before writing or rollback"
  else bad "symlinked leaf $leaf" "rc=$rc $out"; fi
done

# A competing installer must not clean up files it did not create.
busy="$T/busy-installer"
mkdir -p "$busy/.installer-lock" "$busy/app"
echo owned > "$busy/.anagram-home"
echo keep > "$busy/app/KEEP"
before_busy="$(snapshot "$busy")"
out="$(ANAGRAM_HOME="$busy" run_install)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'another installer' && [ "$before_busy" = "$(snapshot "$busy")" ]; then
  ok "competing installer leaves the entire existing component unchanged"
else bad "installer lock" "rc=$rc $out"; fi

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
if [ $rc -ne 0 ] && intact "$T/ok3"; then ok "uninstall refuses incomplete component without its trusted helper"; else bad "missing uninstall helper" "rc=$rc"; fi

# 9. the CLI refuses to derive a home from a location that is not an Anagram folder
mkdir -p "$T/stray/bin" && cp "$ROOT/installer/anagram" "$T/stray/bin/anagram"
out="$(HOME="$FAKE_HOME" sh "$T/stray/bin/anagram" doctor 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "not inside an Anagram folder"; then ok "CLI outside an Anagram folder refuses to run"; else bad "stray CLI" "rc=$rc $(echo "$out" | tail -1)"; fi

PY3="$(command -v python3)"
make_home() { # owned fixture directory
  h="$1"
  mkdir -p "$h/app" "$h/bin" "$h/extension" "$h/models" \
           "$h/run" "$h/venv/bin" "$h/cache" "$h/hf" "$h/python"
  echo "Anagram installation folder." > "$h/.anagram-home"
  echo "9.9.9" > "$h/VERSION"
  printf '{\n  "manifest_version": 3,\n  "name": "Anagram",\n  "version": "9.9.9"\n}\n' > "$h/extension/manifest.json"
  echo "# engine fixture" > "$h/app/engine.py"
  echo "# native host fixture" > "$h/app/native_host.py"
  cp "$ROOT/installer/native_registration.py" "$h/app/native_registration.py"
  cat > "$h/venv/bin/python" <<STUB
#!/bin/sh
# stub venv/bin/python: imports nothing, opens no socket of its own, reaches no network.
[ "\${1:-}" = -I ] && shift
case "\${1:-}" in
  */native_registration.py) exec "$PY3" "\$@" ;;
  */prepare_models.py) echo 'Fixture model preparation'; [ ! -f "\$3/fail-download-fixture" ]; exit \$? ;;
  -) exec "$PY3" "\$@" ;;
esac
exit 2
STUB
  chmod +x "$h/venv/bin/python"
  cp "$ROOT/installer/anagram" "$h/bin/anagram" && chmod +x "$h/bin/anagram"
}

# An active host's OS lock must block a direct installer before downloads/swaps.
HLOCK="$T/active-host"; make_home "$HLOCK"
out="$("$PY3" - "$ROOT" "$FAKE_HOME" "$HLOCK" <<'PYLOCK'
import fcntl, json, os, subprocess, sys
from pathlib import Path
root, user, target = map(Path, sys.argv[1:])
(target / '.native-component.json').write_text(json.dumps({'schema_version': 1, 'host': 'dev.coderbak.anagram', 'home': str(target.resolve())}))
with (target / '.native-host.lock').open('w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    run = subprocess.run(['sh', str(root / 'install.sh')], env={**os.environ, 'HOME': str(user), 'ANAGRAM_HOME': str(target), 'ANAGRAM_RELEASE_URL': 'file:///nonexistent/anagram-release'}, text=True, capture_output=True)
    assert run.returncode != 0 and 'Anagram is running' in run.stderr, (run.returncode, run.stdout, run.stderr)
    assert not (target / '.installer-lock').exists()
    assert (target / 'VERSION').read_text().strip() == '9.9.9'
    assert not (target / 'app.old').exists()
print('host lock preserved')
PYLOCK
)"; rc=$?
if [ $rc -eq 0 ]; then ok "active native host blocks direct reinstall without changing files";
else bad "native host installer lock" "$out"; fi

plant "$T/outside"
# Hardlinks prove release replacement is atomic; the local archive avoids network access.
UVV="$(grep '^UV_VERSION=' "$ROOT/install.sh" | cut -d'"' -f2)"
RELDIR="$T/rel"; mkdir -p "$RELDIR/src/anagram/app" "$RELDIR/src/anagram/extension" "$RELDIR/src/anagram/bin"
echo "9.9.10" > "$RELDIR/src/anagram/VERSION"
echo "new app" > "$RELDIR/src/anagram/app/engine.py"
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
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HU" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
leftover="$(find "$HU" -name '*.new' 2>/dev/null | tr '\n' ' ')"
if [ $rc -eq 0 ] && grep -q "NEW CLI" "$HU/bin/anagram" && [ -x "$HU/bin/anagram" ] && grep -q "OLD CLI" "$T/held-cli"; then
  ok "update: the command is renamed over, so a running anagram keeps reading the old file"
else bad "atomic bin/anagram" "rc=$rc held=$(head -2 "$T/held-cli" | tail -1) $(echo "$out" | tail -1)"; fi
if [ "$(cat "$HU/VERSION")" = "9.9.10" ] && [ "$(cat "$T/held-version")" = "9.9.9" ] && [ -z "$leftover" ]; then
  ok "update: VERSION is renamed over too, and no .new file is left behind"
else bad "atomic VERSION" "VERSION=$(cat "$HU/VERSION") held=$(cat "$T/held-version") leftover='$leftover'"; fi
if [ "$before_out" = "$(snapshot "$T/outside")" ] && [ "$before_fake" = "$(snapshot "$FAKE_HOME")" ] && [ "$(cat "$HU/app/engine.py")" = "new app" ]; then
  ok "update: the new app/ and extension/ landed, and nothing outside the folder moved"
else bad "offline update side effects" "app=$(cat "$HU/app/engine.py" 2>/dev/null)"; fi

# Default installation registers the host, then invokes terminal model preparation.
HFIRST="$T/first-start"; make_home "$HFIRST"
rm -f "$HFIRST/VERSION"
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$HFIRST/bin/uv"; chmod +x "$HFIRST/bin/uv"
cp "$ROOT/installer/anagram" "$RELDIR/src/anagram/bin/anagram"
( cd "$RELDIR/src" && tar -czf "$RELDIR/anagram.tar.gz" anagram )
sha_of "$RELDIR/anagram.tar.gz" > "$RELDIR/anagram.tar.gz.sha256"
# Clear only the prior fixture's exact owned registration through the real helper.
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HFIRST" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ -f "$HFIRST/.native-component.json" ] && [ ! -f "$HFIRST/config" ] && echo "$out" | grep -q "the browser finishes setup automatically"; then
  ok "fresh installation registers native host and invokes terminal preparation without a listener config"
else bad "fresh native install" "rc=$rc $out"; fi
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HFIRST" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ ! -f "$HFIRST/config" ]; then
  ok "installer rerun updates exact owned registration without a listener config"
else bad "installer native rerun" "rc=$rc $out"; fi
HOME="$FAKE_HOME" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$HFIRST" >/dev/null 2>&1
# A browser registration conflict must restore the previous app and private env.
HROLL="$T/rollback-home"; make_home "$HROLL"
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
# Model failure occurs after the runtime/registration commit and must not undo it.
HDOWN="$T/download-failure"; make_home "$HDOWN"
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$HDOWN/bin/uv"; chmod +x "$HDOWN/bin/uv"
touch "$HDOWN/fail-download-fixture"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HDOWN" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && [ "$(cat "$HDOWN/VERSION")" = 9.9.10 ] && [ -f "$HDOWN/.native-component.json" ] \
   && [ -x "$HDOWN/venv/bin/python" ] && [ ! -e "$HDOWN/.installer-lock" ] && echo "$out" | grep -q 'Fixture model preparation'; then
  ok "model download failure retains committed runtime and registration and releases the installer barrier"
else bad "download failure after commit" "rc=$rc $out"; fi
rm "$HDOWN/fail-download-fixture"
out="$(HOME="$FAKE_HOME" "$HDOWN/bin/anagram" download 2>&1)"; rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q 'Fixture model preparation'; then
  ok "download-only CLI invokes preparation without reinstalling runtime packages"
else bad "download-only CLI" "rc=$rc $out"; fi
HOME="$FAKE_HOME" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$HDOWN" >/dev/null 2>&1
if "$PY3" "$ROOT/test/native_registration.py" > "$T/native-tests.log" 2>&1; then
  ok "native registration containment, exact origins, inventory and rollback tests pass"
else bad "native registration tests" "$(tail -n 8 "$T/native-tests.log")"; fi

if "$PY3" "$ROOT/test/modelkit.py" > "$T/modelkit-tests.log" 2>&1; then
  ok "all offline modelkit integrity/staging/anonymous-download tests pass"
else bad "modelkit tests" "$(tail -n 8 "$T/modelkit-tests.log")"; fi

for command in model start stop restart status logs selftest native-update native-uninstall; do
  out="$(HOME="$FAKE_HOME" "$HFIRST/bin/anagram" "$command" 2>&1)"; rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q 'Usage: anagram'; then
    ok "obsolete command $command is rejected"
  else bad "obsolete command $command" "rc=$rc $out"; fi
done
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ $fail -eq 0 ]
