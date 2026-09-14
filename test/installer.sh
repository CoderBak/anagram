#!/bin/sh
# test/installer.sh — the installer and the anagram command must never touch anything that is
# not a real Anagram folder. Each case plants sentinel files where a careless implementation
# would delete or write, runs the real scripts, and checks the sentinels survived.
#
#   sh test/installer.sh                 # offline cases (no downloads: every refusal happens first)
#   INSTALLER_NET=1 sh test/installer.sh # + a full install under a hostile environment (needs
#                                        #   dist/ from `npm run release` and network)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/anagram-installer-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
FAKE_HOME="$T/fakehome"; mkdir -p "$FAKE_HOME"
UNREACHABLE="http://127.0.0.1:9/nothing"   # every refusal must come BEFORE any download
pass=0; fail=0
ok()   { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf 'FAIL  %s  —  %s\n' "$1" "$2"; }
plant() { mkdir -p "$1/app" "$1/extension"; echo keep > "$1/app/KEEP"; echo keep > "$1/extension/KEEP"; echo keep > "$1/KEEP"; }
intact() { [ -f "$1/app/KEEP" ] && [ -f "$1/extension/KEEP" ] && [ -f "$1/KEEP" ]; }
run_install() { HOME="$FAKE_HOME" ANAGRAM_RELEASE_URL="$UNREACHABLE" sh "$ROOT/install.sh" "$@" 2>&1; }
cli() { d="$1"; shift; mkdir -p "$d/bin" && cp "$ROOT/installer/anagram" "$d/bin/anagram" && chmod +x "$d/bin/anagram" && HOME="$FAKE_HOME" "$d/bin/anagram" "$@" 2>&1 </dev/null; }

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

# 10. (network) full install under a hostile environment: nothing lands outside the folder
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
