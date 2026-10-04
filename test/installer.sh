#!/bin/sh
# Offline installer containment, atomic replacement and native registration tests.
set -u
# An inherited component home or lock would point the installer and CLI cases at it.
unset ANAGRAM_HOME ANAGRAM_MAINTENANCE_FD
# Nor may the mirrors this machine's pip and uv use: each case below sets its own.
unset UV_DEFAULT_INDEX UV_INDEX_URL PIP_INDEX_URL PIP_CONFIG_FILE UV_CONFIG_FILE UV_PYTHON_INSTALL_MIRROR UV_INSTALLER_GITHUB_BASE_URL XDG_CONFIG_HOME
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

# An interrupted uninstall keeps its markers and this command; the CLI finishes it.
HREM="$T/interrupted-uninstall"; mkdir -p "$HREM/bin" "$HREM/models"
echo owned > "$HREM/.anagram-home"; echo x > "$HREM/models/weights"
cp "$ROOT/installer/anagram" "$HREM/bin/anagram"; chmod +x "$HREM/bin/anagram"
printf '{\n  "schema_version": 1,\n  "host": "dev.coderbak.anagram",\n  "home": "%s"\n}\n' "$(cd "$HREM" && pwd -P)" > "$HREM/.native-uninstall.json"
plant "$T/victim3"; ln -s "$T/victim3" "$HREM/models/outside"
cp -R "$HREM" "$T/copied-uninstall"
mkdir "$HREM/.installer-lock"
out="$(HOME="$FAKE_HOME" "$HREM/bin/anagram" uninstall -y 2>&1)"; rc=$?
if [ $rc -ne 0 ] && [ -f "$HREM/models/weights" ]; then ok "an interrupted uninstall waits for an active installer"; else bad "uninstall during install" "rc=$rc $out"; fi
rmdir "$HREM/.installer-lock"
out="$(HOME="$FAKE_HOME" "$T/copied-uninstall/bin/anagram" uninstall -y 2>&1)"; rc=$?
if [ $rc -ne 0 ] && [ -f "$T/copied-uninstall/models/weights" ]; then ok "an uninstall marker naming another folder is refused"; else bad "copied uninstall marker" "rc=$rc $out"; fi
out="$(HOME="$FAKE_HOME" "$HREM/bin/anagram" uninstall -y 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ ! -e "$HREM" ] && intact "$T/victim3"; then ok "an interrupted uninstall is finished without following links"; else bad "finish interrupted uninstall" "rc=$rc $out"; fi

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
  */prepare_models.py) echo "Fixture model preparation: \$*"; [ ! -f "\$3/fail-download-fixture" ]; exit \$? ;;
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

# A release asked for by its version must be that version: the one at .../download/v9.9.11 that
# says it is 9.9.10 is refused, and nothing in the folder changes.
mkdir -p "$T/relpin/download/v9.9.11"
cp "$RELDIR/anagram.tar.gz" "$RELDIR/anagram.tar.gz.sha256" "$T/relpin/download/v9.9.11/"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HU" ANAGRAM_RELEASE_URL="file://$T/relpin/download/v9.9.11" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "not 9.9.11 as asked" && [ "$(cat "$HU/VERSION")" = "9.9.10" ]; then
  ok "update: a release that is not the version asked for is refused, the folder untouched"
else bad "pinned release version" "rc=$rc VERSION=$(cat "$HU/VERSION") $(echo "$out" | tail -1)"; fi

# Default installation registers the host, then invokes terminal model preparation.
HFIRST="$T/first-start"; make_home "$HFIRST"
rm -f "$HFIRST/VERSION"
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$HFIRST/bin/uv"; chmod +x "$HFIRST/bin/uv"
cp "$ROOT/installer/anagram" "$RELDIR/src/anagram/bin/anagram"
( cd "$RELDIR/src" && tar -czf "$RELDIR/anagram.tar.gz" anagram )
sha_of "$RELDIR/anagram.tar.gz" > "$RELDIR/anagram.tar.gz.sha256"
# Clear only the prior fixture's exact owned registration through the real helper.
# A UTF-8 locale, as in any Mac terminal: there bash reads a multibyte character right after
# $NAME as part of the name.
out="$(HOME="$FAKE_HOME" LC_ALL=en_US.UTF-8 ANAGRAM_HOME="$HFIRST" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ -f "$HFIRST/.native-component.json" ] && [ ! -f "$HFIRST/config" ] && echo "$out" | grep -q "the browser finishes setup automatically"; then
  ok "fresh installation registers native host and invokes terminal preparation without a listener config"
else bad "fresh native install" "rc=$rc $out"; fi
if echo "$out" | grep -q "Downloading and installing \([A-Za-z]*, \)\{0,1\}ONNX Runtime" && ! echo "$out" | grep -q "unbound variable"; then
  ok "the runtime packages step names its runtime in a UTF-8 locale"
else bad "runtime packages note" "$(echo "$out" | grep -A1 '\[4/7\]')"; fi
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$HFIRST" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ ! -f "$HFIRST/config" ]; then
  ok "installer rerun updates exact owned registration without a listener config"
else bad "installer native rerun" "rc=$rc $out"; fi
HOME="$FAKE_HOME" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$HFIRST" >/dev/null 2>&1
# Linux gets PyTorch (the cuda extra) only beside an NVIDIA GPU: a driver in /proc, or a GPU
# nvidia-smi lists. Fake commands stand in for the machine and a temporary root for /.
FAKE_OS="$T/fake-os"; mkdir -p "$FAKE_OS/bin"
printf '#!/bin/sh\necho "ldd (GNU libc) 2.39"\n' > "$FAKE_OS/bin/ldd"
printf '#!/bin/sh\necho "glibc 2.39"\n' > "$FAKE_OS/bin/getconf"
printf '#!/bin/sh\necho 15.0\n' > "$FAKE_OS/bin/sw_vers"
os_install() { # name "os arch" gpu(none|proc|smi|wsl): an update of a home whose environment has PyTorch
  h="$T/os-$1"; make_home "$h"; mkdir -p "$h/venv/lib/python3.12/site-packages/torch"
  printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then echo "$*" > "$(dirname "$0")/../sync-args"; mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$h/bin/uv"; chmod +x "$h/bin/uv"
  printf '#!/bin/sh\n[ "$1" = -s ] && echo %s || echo %s\n' $2 > "$FAKE_OS/bin/uname"
  rm -rf "$FAKE_OS/root"; mkdir -p "$FAKE_OS/root/proc/driver"
  [ "$3" != proc ] || { mkdir "$FAKE_OS/root/proc/driver/nvidia"; echo "NVRM version: NVIDIA UNIX Open Kernel Module  580.82.07" > "$FAKE_OS/root/proc/driver/nvidia/version"; }
  [ "$3" != wsl ] || { mkdir -p "$FAKE_OS/root/usr/lib/wsl/lib"; printf '#!/bin/sh\n[ "$1" = -L ] && echo "GPU 0: NVIDIA GeForce RTX 4070 (UUID: GPU-0)"\n' > "$FAKE_OS/root/usr/lib/wsl/lib/nvidia-smi"; chmod +x "$FAKE_OS/root/usr/lib/wsl/lib/nvidia-smi"; }
  if [ "$3" = smi ]; then printf '#!/bin/sh\n[ "$1" = -L ] && echo "GPU 0: NVIDIA L4 (UUID: GPU-0)"\n' > "$FAKE_OS/bin/nvidia-smi"
  else printf '#!/bin/sh\necho "No devices were found"; exit 6\n' > "$FAKE_OS/bin/nvidia-smi"; fi
  chmod +x "$FAKE_OS/bin/"*
  out="$(HOME="$FAKE_HOME" PATH="$FAKE_OS/bin:$PATH" ANAGRAM_TEST_ROOT="$FAKE_OS/root" ANAGRAM_HOME="$h" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
  HOME="$FAKE_HOME" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$h" >/dev/null 2>&1
  args="$(cat "$h/sync-args" 2>/dev/null)"
}
os_install linux-cpu "Linux x86_64" none
if [ $rc -eq 0 ] && [ "${args#*--extra}" = "$args" ] && echo "$out" | grep -q "Downloading and installing ONNX Runtime and" \
   && [ "$(echo "$out" | grep -c 'No NVIDIA GPU: PyTorch and its CUDA libraries (about 5 GB) are removed')" -eq 1 ] && [ ! -e "$h/venv/lib/python3.12/site-packages/torch" ]; then
  ok "Linux without an NVIDIA GPU syncs without PyTorch and says in one line that the update removes it"
else bad "Linux CPU sync" "rc=$rc args=$args $out"; fi
os_install linux-driver "Linux aarch64" proc
if [ $rc -eq 0 ] && echo " $args " | grep -q ' --extra cuda ' && echo "$out" | grep -q "Downloading and installing PyTorch, ONNX Runtime" && ! echo "$out" | grep -q 'No NVIDIA GPU'; then
  ok "Linux with the NVIDIA driver in /proc syncs the cuda extra"
else bad "Linux NVIDIA driver sync" "rc=$rc args=$args $out"; fi
os_install linux-smi "Linux x86_64" smi
if [ $rc -eq 0 ] && echo " $args " | grep -q ' --extra cuda ' && ! echo "$out" | grep -q 'No NVIDIA GPU'; then
  ok "Linux where nvidia-smi lists a GPU syncs the cuda extra"
else bad "Linux nvidia-smi sync" "rc=$rc args=$args $out"; fi
os_install linux-wsl "Linux x86_64" wsl
if [ $rc -eq 0 ] && echo " $args " | grep -q ' --extra cuda ' && ! echo "$out" | grep -q 'No NVIDIA GPU'; then
  ok "WSL2, whose nvidia-smi is off the PATH, syncs the cuda extra"
else bad "WSL2 nvidia-smi sync" "rc=$rc args=$args $out"; fi
os_install mac-smi "Darwin arm64" smi
if [ $rc -eq 0 ] && [ -n "$args" ] && [ "${args#*--extra}" = "$args" ] && ! echo "$out" | grep -q 'No NVIDIA GPU'; then
  ok "macOS never syncs the cuda extra"
else bad "macOS sync" "rc=$rc args=$args $out"; fi
# A mirror the person's pip or uv already uses serves the packages and Python, with every
# locked hash required; a mirror that fails gives way to the original source.
mirror_install() { # name [VAR=value...]: an update whose uv logs each call and the Python mirror it was given
  h="$T/mirror-$1"; shift; make_home "$h"; rm -rf "$T/mirror-user"; mkdir -p "$T/mirror-user"
  cat > "$h/bin/uv" <<FAKEUV
#!/bin/sh
echo "uv $UVV"
here="\$(dirname "\$0")/.."
echo "\$* | python-mirror=\${UV_PYTHON_INSTALL_MIRROR:-}" >> "\$here/uv-log"
case "\$1" in
  sync) mkdir -p "\$UV_PROJECT_ENVIRONMENT/bin"; cp "\$here/venv/bin/python" "\$UV_PROJECT_ENVIRONMENT/bin/python" ;;
  venv) for a; do last="\$a"; done; mkdir -p "\$last/bin"; cp "\$here/venv/bin/python" "\$last/bin/python" ;;
  pip) [ ! -f "\$here/pip-fails" ] || exit 1 ;;
  python) [ -z "\${UV_PYTHON_INSTALL_MIRROR:-}" ] || [ ! -f "\$here/python-mirror-fails" ] || exit 1 ;;
esac
exit 0
FAKEUV
  chmod +x "$h/bin/uv"
  [ -z "${MIRROR_SETUP:-}" ] || eval "$MIRROR_SETUP"
  out="$(env HOME="$T/mirror-user" ANAGRAM_HOME="$h" ANAGRAM_RELEASE_URL="file://$RELDIR" "$@" sh "$ROOT/install.sh" 2>&1)"; rc=$?
  HOME="$T/mirror-user" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$h" >/dev/null 2>&1
  log="$(cat "$h/uv-log" 2>/dev/null)"
}
mirror_install env UV_DEFAULT_INDEX=https://mirror.test/simple/
if [ $rc -eq 0 ] && echo "$log" | grep -q '^export --frozen --no-dev --no-emit-project' && echo "$log" | grep -q '^venv --quiet --python' \
   && echo "$log" | grep -q '^pip sync .* --require-hashes --no-build --default-index https://mirror.test/simple ' && ! echo "$log" | grep -q '^sync ' \
   && echo "$out" | grep -q 'from your package index, mirror.test' && [ -x "$h/venv/bin/python" ]; then
  ok "UV_DEFAULT_INDEX: the locked packages come from that index, every hash required"
else bad "UV_DEFAULT_INDEX mirror" "rc=$rc log=$log $out"; fi
MIRROR_SETUP='mkdir -p "$T/mirror-user/.config/pip"; printf "[global]\ntimeout = 60\nindex-url = https://someone:s3cret@pip.mirror.test/pypi/simple\n" > "$T/mirror-user/.config/pip/pip.conf"'
mirror_install pip-conf
if [ $rc -eq 0 ] && echo "$log" | grep -q -- '--default-index https://someone:s3cret@pip.mirror.test/pypi/simple ' \
   && echo "$out" | grep -q 'from your package index, pip.mirror.test' && ! echo "$out" | grep -q 's3cret'; then
  ok "pip.conf's index-url is used, and its password never printed"
else bad "pip.conf mirror" "rc=$rc log=$log $out"; fi
MIRROR_SETUP='mkdir -p "$T/mirror-user/.config/uv"; printf "python-install-mirror = \"https://py.mirror.test/releases/download\"\n\n[[index]]\nname = \"torch\"\nurl = \"https://torch.mirror.test/whl\"\n\n[[index]]\nurl = '"'"'https://uv.mirror.test/simple'"'"'\ndefault = true # the mirror\n" > "$T/mirror-user/.config/uv/uv.toml"'
mirror_install uv-toml
if [ $rc -eq 0 ] && echo "$log" | grep -q -- '--default-index https://uv.mirror.test/simple ' \
   && echo "$log" | grep -q '^python install .* | python-mirror=https://py.mirror.test/releases/download$' \
   && echo "$out" | grep -q 'from your mirror, py.mirror.test'; then
  ok "uv.toml: its default index and its Python mirror are used, not an index it uses for one package"
else bad "uv.toml mirror" "rc=$rc log=$log $out"; fi
MIRROR_SETUP='mkdir -p "$T/mirror-user/.config/pip"; printf "[global]\nindex-url = https://pip.mirror.test/simple\n" > "$T/mirror-user/.config/pip/pip.conf"'
mirror_install precedence PIP_INDEX_URL=https://env.mirror.test/simple
if [ $rc -eq 0 ] && echo "$log" | grep -q -- '--default-index https://env.mirror.test/simple '; then
  ok "an index set in the environment comes before one in a configuration file"
else bad "mirror precedence" "rc=$rc log=$log"; fi
MIRROR_SETUP=': > "$h/pip-fails"; : > "$h/python-mirror-fails"'
mirror_install failing UV_DEFAULT_INDEX=https://down.mirror.test/simple UV_PYTHON_INSTALL_MIRROR=https://down.mirror.test/python
if [ $rc -eq 0 ] && echo "$log" | grep -q '^sync --frozen --no-dev --no-build' && [ ! -e "$h/venv.next" ] && [ -x "$h/venv/bin/python" ] \
   && [ "$(echo "$out" | grep -c 'down.mirror.test did not work; trying the original source')" -eq 2 ] \
   && echo "$log" | grep '^python install' | tail -1 | grep -q 'python-mirror=$'; then
  ok "a mirror that fails gives way to PyPI and the original Python builds"
else bad "failing mirror" "rc=$rc log=$log $out"; fi
MIRROR_SETUP=''
mirror_install malformed "UV_DEFAULT_INDEX=ftp://mirror.test/simple" "PIP_INDEX_URL=https://mirror.test/simple'; touch /tmp/x" UV_PYTHON_INSTALL_MIRROR="https://a b.test/"
if [ $rc -eq 0 ] && echo "$log" | grep -q '^sync --frozen' && ! echo "$log" | grep -q '^pip ' && ! echo "$log" | grep -q 'python-mirror=.' && ! echo "$out" | grep -q 'mirror,'; then
  ok "an index that is not a plain http(s) address is ignored"
else bad "malformed mirror" "rc=$rc log=$log $out"; fi
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
# Interrupted installers. dash (/bin/sh on Debian) skips an EXIT trap when a signal kills it.
SH_UNDER_TEST="$(command -v dash || echo sh)"
paused_uv() { # home marker: a uv whose sync announces itself, then blocks until killed
  printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; : > "%s"; sleep 30; fi\nexit 0\n' "$UVV" "$2" > "$1/bin/uv"; chmod +x "$1/bin/uv"
}
interrupt_install() { # home signal: start an update, then signal its whole process group mid-sync
  "$PY3" - "$SH_UNDER_TEST" "$ROOT/install.sh" "$FAKE_HOME" "$1" "file://$RELDIR" "$1.sync" "$2" <<'PYSIG'
import os, signal, subprocess, sys, time
from pathlib import Path
shell, script, user, home, release, started, sig = sys.argv[1:]
env = {**os.environ, 'HOME': user, 'ANAGRAM_HOME': home, 'ANAGRAM_RELEASE_URL': release}
process = subprocess.Popen([shell, script], env=env, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
deadline = time.monotonic() + 20
while not Path(started).exists():
    if process.poll() is not None or time.monotonic() > deadline:
        sys.exit('installer did not reach uv sync')
    time.sleep(0.05)
os.killpg(process.pid, getattr(signal, 'SIG' + sig))
process.wait(20)
PYSIG
}
for sig in TERM INT HUP; do
  h="$T/signal-$sig"; make_home "$h"; paused_uv "$h" "$h.sync"
  before="$(snapshot "$h")"
  out="$(interrupt_install "$h" "$sig" 2>&1)"; rc=$?
  if [ $rc -eq 0 ] && [ "$before" = "$(snapshot "$h")" ]; then
    ok "SIG$sig mid-update restores the component and releases the lock under $(basename "$SH_UNDER_TEST")"
  else bad "SIG$sig mid-update" "rc=$rc $out; left: $(ls -A "$h" | tr '\n' ' ')"; fi
done
# SIGKILL or power loss skips every trap. The next installer takes over the dead lock.
h="$T/killed-installer"; make_home "$h"; paused_uv "$h" "$h.sync"
before="$(snapshot "$h")"
interrupt_install "$h" KILL >/dev/null 2>&1
if [ -f "$h/.installer-lock/pid" ] && [ -d "$h/app.old" ]; then ok "a killed installer leaves its lock and backups behind"
else bad "killed installer fixture" "left: $(ls -A "$h" | tr '\n' ' ')"; fi
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$h" ANAGRAM_RELEASE_URL="$UNREACHABLE" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'Recovering from an interrupted installation' && [ "$before" = "$(snapshot "$h")" ]; then
  ok "the next installer takes over a dead installer's lock and restores what it swapped"
else bad "dead installer recovery" "rc=$rc $out"; fi
printf '#!/bin/sh\necho "uv %s"\nif [ "$1" = sync ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; cp "$(dirname "$0")/../venv/bin/python" "$UV_PROJECT_ENVIRONMENT/bin/python"; fi\nexit 0\n' "$UVV" > "$h/bin/uv"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$h" ANAGRAM_RELEASE_URL="file://$RELDIR" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ "$(cat "$h/VERSION")" = 9.9.10 ] && [ -z "$(ls -d "$h"/*.old "$h/venv.next" "$h"/.staging.* "$h/.installer-lock" 2>/dev/null)" ]; then
  ok "after recovery the update completes"
else bad "update after recovery" "rc=$rc $out"; fi
HOME="$FAKE_HOME" "$PY3" "$ROOT/installer/native_registration.py" unregister --home "$h" >/dev/null 2>&1
h="$T/live-installer"; make_home "$h"; mkdir "$h/.installer-lock"; echo $$ > "$h/.installer-lock/pid"
before="$(snapshot "$h")"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$h" ANAGRAM_RELEASE_URL="$UNREACHABLE" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "another installer (process $$)" && [ "$before" = "$(snapshot "$h")" ]; then
  ok "a running installer's lock is never taken over"
else bad "live installer lock" "rc=$rc $out"; fi
# With no swap on record the dead installer had committed: keep its trees, drop their backups.
h="$T/committed-crash"; make_home "$h"; mkdir -p "$h/app.old/half-deleted" "$h/.installer-lock"; echo 99999999 > "$h/.installer-lock/pid"
out="$(HOME="$FAKE_HOME" ANAGRAM_HOME="$h" ANAGRAM_RELEASE_URL="$UNREACHABLE" sh "$ROOT/install.sh" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && [ -f "$h/app/engine.py" ] && [ ! -e "$h/app.old" ] && [ ! -e "$h/.installer-lock" ]; then
  ok "a committed installer's leftover backup is dropped, never promoted"
else bad "committed installer leftovers" "rc=$rc $out"; fi
# The CLI names the repair, and update reaches it without the host lock the dead lock blocks.
h="$T/dead-installer-cli"; make_home "$h"; real="$(cd "$h" && pwd -P)"
printf '{"schema_version": 1, "host": "dev.coderbak.anagram", "home": "%s"}\n' "$real" > "$h/.native-component.json"
printf 'import pathlib, sys\npathlib.Path(sys.argv[0]).with_name("called").write_text(" ".join(sys.argv[1:]))\n' > "$h/app/native_registration.py"
mkdir "$h/.installer-lock"; echo 99999999 > "$h/.installer-lock/pid"
out="$(HOME="$FAKE_HOME" "$h/bin/anagram" download 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'anagram update' && ! echo "$out" | grep -q 'Fixture model preparation'; then
  ok "download names the repair for a dead installer's lock"
else bad "download with a dead installer lock" "rc=$rc $out"; fi
out="$(HOME="$FAKE_HOME" "$h/bin/anagram" update 2>&1)"; rc=$?
if [ $rc -eq 0 ] && [ "$(cat "$h/app/called" 2>/dev/null)" = "update --home $real" ]; then
  ok "update repairs past a dead installer's lock"
else bad "update with a dead installer lock" "rc=$rc $out"; fi
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
out="$(HOME="$FAKE_HOME" "$HDOWN/bin/anagram" download --profile expanded 2>&1)"; rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q -- '--profile expanded$'; then
  ok "download --profile passes the chosen model set to preparation"
else bad "download --profile" "rc=$rc $out"; fi
for args in "--profile" "--profile bogus" "--home /nonexistent" "--installer"; do
  out="$(HOME="$FAKE_HOME" "$HDOWN/bin/anagram" download $args 2>&1)"; rc=$?
  if [ $rc -ne 0 ] && ! echo "$out" | grep -q 'Fixture model preparation'; then
    ok "download refuses '$args' before preparation"
  else bad "download $args" "rc=$rc $out"; fi
done
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
