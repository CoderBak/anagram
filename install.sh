#!/bin/sh
# Install a private native runtime and register the exact browser extension ID.
# ANAGRAM_HOME, ANAGRAM_BROWSER, ANAGRAM_EXTENSION_ID and ANAGRAM_LANG come from setup.
# Initial model preparation runs here; the browser owns inference afterwards.
set -eu
umask 077

UV_VERSION="0.11.18"
PYTHON_VERSION="${ANAGRAM_PYTHON:-3.12.13}"
RELEASE_URL="${ANAGRAM_RELEASE_URL:-https://github.com/CoderBak/anagram/releases/latest/download}"
MARKER=".anagram-home"
BROWSER="${ANAGRAM_BROWSER:-}"
EXTENSION_ID="${ANAGRAM_EXTENSION_ID:-}"
INSTALL_LANG="${ANAGRAM_LANG:-en}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
step() { say "[$1/7] $2"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
tr_msg() { if [ "$INSTALL_LANG" = zh_CN ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

# ---------------------------------------------------------------- 0. environment + target
[ "$(id -u)" -eq 0 ] && [ -z "${ANAGRAM_ALLOW_ROOT:-}" ] && die "do not run as root — Anagram installs into your home folder only"
CLEANUP_ONLY=0
case "${1:-}" in --cleanup-only) [ "$#" -eq 1 ] || die "usage: install.sh --cleanup-only"; CLEANUP_ONLY=1 ;; '') ;; *) die "unknown installer option" ;; esac
if [ "$CLEANUP_ONLY" -eq 0 ]; then need curl; need tar; fi
need mktemp
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else die "sha256sum or shasum is required"; fi
sha256_of() { $SHA < "$1" | cut -c1-64; }
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to a directory"

ANAGRAM_HOME="${ANAGRAM_HOME:-$HOME/.anagram}"
case "$ANAGRAM_HOME" in
  /*) ;;
  *) die "ANAGRAM_HOME must be an absolute path (got '$ANAGRAM_HOME')" ;;
esac
case "/$ANAGRAM_HOME/" in
  */../*|*/./*) die "ANAGRAM_HOME must not contain . or .. segments (got '$ANAGRAM_HOME')" ;;
esac
# Strip trailing slashes; refuse the roots nobody means.
while [ "${ANAGRAM_HOME%/}" != "$ANAGRAM_HOME" ]; do ANAGRAM_HOME="${ANAGRAM_HOME%/}"; done
[ -n "$ANAGRAM_HOME" ] || die "ANAGRAM_HOME resolves to /"
case "$ANAGRAM_HOME" in
  "$HOME"|/|/usr|/usr/local|/opt|/etc|/var|/tmp|/private/tmp|/Users|/home|/Applications|/Library|/System)
    die "refusing to install into '$ANAGRAM_HOME' — choose a dedicated folder such as $HOME/.anagram" ;;
esac
parent="${ANAGRAM_HOME%/*}"
while [ -n "$parent" ]; do
  if [ -L "$parent" ]; then
    case "$parent:$(readlink "$parent")" in
      /tmp:private/tmp|/var:private/var) [ "$(uname -s)" = Darwin ] || die "symbolic link in installation path: $parent" ;;
      *) die "symbolic link in installation path: $parent" ;;
    esac
  fi
  parent="${parent%/*}"
done
[ -L "$ANAGRAM_HOME" ] && die "'$ANAGRAM_HOME' is a symbolic link — Anagram only installs into a real directory it owns (remove the link or set ANAGRAM_HOME elsewhere)"
bootstrap_lock_only() {
  lock_dir="$ANAGRAM_HOME/.installer-lock"
  [ "$(ls -A "$ANAGRAM_HOME" 2>/dev/null)" = .installer-lock ] && [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] &&
    [ -f "$lock_dir/home-marker" ] && [ ! -L "$lock_dir/home-marker" ] && [ -f "$lock_dir/pid" ] && [ ! -L "$lock_dir/pid" ] || return 1
  lock_pid="$(cat "$lock_dir/pid")"
  case "$lock_pid" in ''|*[!0-9]*) return 1 ;; esac
  ! kill -0 "$lock_pid" 2>/dev/null && printf 'Anagram installation: %s\n' "$(cd "$ANAGRAM_HOME" && pwd -P)" | cmp -s - "$lock_dir/home-marker"
}
if [ -e "$ANAGRAM_HOME" ]; then
  [ -d "$ANAGRAM_HOME" ] || die "'$ANAGRAM_HOME' exists and is not a directory"
  if [ ! -f "$ANAGRAM_HOME/$MARKER" ] && [ -n "$(ls -A "$ANAGRAM_HOME" 2>/dev/null)" ] && ! bootstrap_lock_only; then
    die "'$ANAGRAM_HOME' exists, is not empty, and is not an Anagram folder (no $MARKER) — refusing to touch it. Move it aside or set ANAGRAM_HOME to a new folder."
  fi
fi
uid="$(id -u)"
ancestor="$ANAGRAM_HOME"
while [ -n "$ancestor" ]; do
  if [ -d "$ancestor" ]; then
    unsafe="$(find "$ancestor" -prune \( ! -user "$uid" ! -user 0 -o \( -perm -0020 -o -perm -0002 \) ! -perm -1000 \) -print)"
    [ -z "$unsafe" ] || die "installation path is writable or replaceable by another user: $ancestor"
  fi
  ancestor="${ancestor%/*}"
done
if [ -d "$ANAGRAM_HOME" ]; then
  [ -z "$(find "$ANAGRAM_HOME" -prune \( ! -user "$uid" -o -perm -0020 -o -perm -0002 \) -print)" ] || die "installation directory must belong to you and be writable by you alone"
fi
# Check fixed file destinations before backups or rollback can touch them.
for sub in "$MARKER" VERSION bin/anagram bin/anagram.new bin/uv bin/uv.new .native-host.lock .native-component.json native-registration.json; do
  [ ! -L "$ANAGRAM_HOME/$sub" ] || die "symbolic link in installation: $sub"
  [ ! -e "$ANAGRAM_HOME/$sub" ] || [ -f "$ANAGRAM_HOME/$sub" ] || die "installation file is not regular: $sub"
done
# Inside the validated folder, the paths we replace or write must be plain directories too.
for sub in app extension bin models venv python hf cache logs run tools; do
  [ -L "$ANAGRAM_HOME/$sub" ] && die "'$ANAGRAM_HOME/$sub' is a symbolic link — refusing to write through it"
done
# Leftovers of an interrupted installer are recovered under the lock; links never are.
for sub in app.old extension.old venv.old venv.next .installer-lock; do
  [ ! -L "$ANAGRAM_HOME/$sub" ] || die "unsafe staging path: $ANAGRAM_HOME/$sub"
done
check_marker() {
  [ ! -e "$ANAGRAM_HOME/.native-uninstall.json" ] && [ ! -L "$ANAGRAM_HOME/.native-uninstall.json" ] || die "this folder contains an interrupted uninstall"
  if [ -f "$ANAGRAM_HOME/$MARKER" ]; then
    real="$(cd "$ANAGRAM_HOME" && pwd -P)"
    if [ "$(cat "$ANAGRAM_HOME/$MARKER")" != "Anagram installation: $real" ]; then
      # Older completed releases have a second receipt bound to their real home.
      [ -f "$ANAGRAM_HOME/.native-component.json" ] && [ ! -L "$ANAGRAM_HOME/.native-component.json" ] || die "installation marker does not identify this folder"
      quoted_home="$(printf '%s' "$real" | sed 's/["\\]/\\&/g')"
      grep -Fq "\"home\": \"$quoted_home\"" "$ANAGRAM_HOME/.native-component.json" || die "component ownership marker does not name this folder"
    fi
  fi
}
check_marker
case "$INSTALL_LANG" in en|zh_CN) ;; *) die "ANAGRAM_LANG must be en or zh_CN / 语言须为 en 或 zh_CN" ;; esac
if [ "$CLEANUP_ONLY" -eq 0 ]; then case "$BROWSER" in
  chrome) [ "${#EXTENSION_ID}" -eq 32 ] || die "Chrome extension ID must contain 32 a-p characters / Chrome 扩展 ID 必须为 32 位 a-p 字符"
          case "$EXTENSION_ID" in *[!a-p]*) die "invalid Chrome extension ID / Chrome 扩展 ID 无效" ;; esac ;;
  firefox) [ "$EXTENSION_ID" = anagram@coderbak.dev ] || die "Firefox extension ID must be anagram@coderbak.dev" ;;
  safari) [ "$(uname -s)" = Darwin ] || die "Safari's local engine requires macOS / Safari 本地引擎需要 macOS"
          printf '%s\n' "$EXTENSION_ID" | LC_ALL=C grep -Eq '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+( \([A-Za-z0-9-]+\))?$' || die "invalid Safari extension ID / Safari 扩展 ID 无效" ;;
  *) die "Use the installation command from Anagram setup (ANAGRAM_BROWSER=chrome|firefox|safari and exact extension ID) / 请使用扩展设置页中的安装命令" ;;
esac; fi

TMP=""
CLAIM=""
CLAIM_ID=""
LOCK="$ANAGRAM_HOME/.installer-lock"
INSTALL_LOCK=""
SWAPPED=""
BACKED_DIRS=""
INSTALL_COMPLETE=0
COMMAND_WRITTEN=0
VERSION_WRITTEN=0
UV_WRITTEN=0
CREATED_MARKER=0
CREATED_HOME=0
CREATED_DIRS=""
ROLLBACK_PY=""
STAGE=""
cleanup() {
  # Finish the rollback even when the signal that started it is repeated.
  trap '' HUP INT TERM
  if [ -n "$CLAIM" ] && { [ -L "$CLAIM" ] || [ ! -d "$CLAIM" ] || [ "$(directory_identity "$CLAIM")" != "$CLAIM_ID" ]; }; then
    note "The installer claim directory changed. Kept it and the installer journal for recovery."
    exit 1
  fi
  if [ -n "$INSTALL_LOCK" ] && { [ -L "$ANAGRAM_HOME" ] || [ -L "$LOCK" ] || [ -L "$LOCK/pid" ] ||
      [ "$(cat "$LOCK/pid" 2>/dev/null)" != "$$" ]; }; then
    note "The installation directory or lock changed. Its files were kept for inspection."
    INSTALL_LOCK=""
    STAGE=""
  fi
  if [ -n "$INSTALL_LOCK" ] && [ -f "$LOCK/registering" ]; then
    note "Installation stopped during browser registration. Run the same setup command again to finish."
    # The next attempt can tell whether registration committed. Keep both the
    # working runtime and the journal that binds it to this request.
    INSTALL_LOCK=""
    STAGE=""
  fi
  if [ -n "$INSTALL_LOCK" ] && [ -n "$TMP" ]; then recover_scratch; fi
  if [ "$INSTALL_COMPLETE" -eq 0 ] && [ -n "$INSTALL_LOCK" ]; then
    recovery_dir=""
    published="$SWAPPED"
    [ "$COMMAND_WRITTEN" -eq 0 ] || published="$published bin/anagram"
    [ "$VERSION_WRITTEN" -eq 0 ] || published="$published VERSION"
    [ "$UV_WRITTEN" -eq 0 ] || published="$published bin/uv"
    [ -z "$published" ] || prune_recorded "$ANAGRAM_HOME" $published
    for sub in $SWAPPED; do
      keep_interrupted "$ANAGRAM_HOME/$sub"
      case " $BACKED_DIRS " in *" $sub "*) mv "$ANAGRAM_HOME/$sub.old" "$ANAGRAM_HOME/$sub" ;; esac
    done
    if [ "$COMMAND_WRITTEN" -eq 1 ]; then
      keep_interrupted "$ANAGRAM_HOME/bin/anagram"
      [ ! -f "$LOCK/command.backup" ] || install_ours "$LOCK/command.backup" "$ANAGRAM_HOME/bin/anagram" 755
    fi
    if [ "$VERSION_WRITTEN" -eq 1 ]; then
      keep_interrupted "$ANAGRAM_HOME/VERSION"
      [ ! -f "$LOCK/version.backup" ] || install_ours "$LOCK/version.backup" "$ANAGRAM_HOME/VERSION"
    fi
    if [ "$UV_WRITTEN" -eq 1 ]; then
      keep_interrupted "$ANAGRAM_HOME/bin/uv"
      [ ! -f "$LOCK/uv.backup" ] || install_ours "$LOCK/uv.backup" "$ANAGRAM_HOME/bin/uv" 755
    fi
    for sub in $CREATED_DIRS; do rmdir "$ANAGRAM_HOME/$sub" 2>/dev/null || :; done
  fi
  if [ -n "$STAGE" ]; then
    recovery_dir="${recovery_dir:-}"
    prune_recorded "$STAGE" app extension venv python
    rmdir "$STAGE" 2>/dev/null || keep_interrupted "$STAGE"
  fi
  if [ -n "$INSTALL_LOCK" ]; then
    rm -f "$LOCK/claim" "$LOCK/created-dirs" "$LOCK/scratch.path" "$LOCK/scratch.identity" "$LOCK/build.identity" "$LOCK/failed-mirror.identity" "$LOCK/scratch-files.next" "$LOCK/scratch-files.json" "$LOCK/scratch-python.sha" "$LOCK/created-home" "$LOCK/helper.py" "$LOCK/helper.sha" "$LOCK/receipt.sha" "$LOCK/python.sha" "$LOCK/python-backup" "$LOCK/stage" "$LOCK/swapping" "$LOCK/uv.backup" "$LOCK/command.backup" "$LOCK/version.backup" "$LOCK/proposed-files.json" "$LOCK/promoting"
    if [ "$INSTALL_COMPLETE" -eq 0 ] && [ "$CREATED_MARKER" -eq 1 ] && [ ! -L "$ANAGRAM_HOME/$MARKER" ] &&
       printf 'Anagram installation: %s\n' "$ANAGRAM_HOME" | cmp -s - "$ANAGRAM_HOME/$MARKER"; then
      rm -f "$ANAGRAM_HOME/$MARKER"
    fi
    # A new entrant either sees the full lock or its absence. Keep the PID
    # and bound marker together even if this process dies while retiring it.
    [ ! -e "$CLAIM/retired" ] && [ ! -L "$CLAIM/retired" ] || die "lock retirement directory changed"
    mv "$LOCK" "$CLAIM/retired"
    rm -f "$CLAIM/retired/pid" "$CLAIM/retired/home-marker"
    rmdir "$CLAIM/retired" 2>/dev/null || note "Unverified installer records remain in $CLAIM/retired"
    if [ "$INSTALL_COMPLETE" -eq 0 ] && [ "$CREATED_HOME" -eq 1 ]; then rmdir "$ANAGRAM_HOME" 2>/dev/null || :; fi
  fi
  if [ -n "$CLAIM" ]; then
    if [ ! -L "$CLAIM/.installer-lock" ]; then
      rm -f "$CLAIM/.installer-lock/claim" "$CLAIM/.installer-lock/pid" "$CLAIM/.installer-lock/home-marker" "$CLAIM/.installer-lock/created-home"
    fi
    if [ -f "$CLAIM/$MARKER" ] && [ ! -L "$CLAIM/$MARKER" ] && printf 'Anagram installation: %s\n' "$ANAGRAM_HOME" | cmp -s - "$CLAIM/$MARKER"; then rm "$CLAIM/$MARKER"; fi
    if [ -f "$CLAIM/owner" ] && [ ! -L "$CLAIM/owner" ] && printf 'Anagram claim: %s/%s\n' "$ANAGRAM_HOME" "${CLAIM##*/}" | cmp -s - "$CLAIM/owner"; then rm "$CLAIM/owner"; fi
    rmdir "$CLAIM/.installer-lock" "$CLAIM" 2>/dev/null || :
  fi
}
trap cleanup EXIT
# dash skips the EXIT trap when a signal kills it; exit instead, so cleanup runs.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Remove something that must be INSIDE the validated folder and must not be a symlink.
check_parent() {
  checked_parent="${1%/*}"
  while [ "$checked_parent" != "$ANAGRAM_HOME" ]; do
    case "$checked_parent" in "$ANAGRAM_HOME"/*) ;; *) die "path is outside the installation directory: $1" ;; esac
    [ ! -L "$checked_parent" ] || die "installation directory became a symbolic link: $checked_parent"
    checked_parent="${checked_parent%/*}"
  done
  [ -d "$ANAGRAM_HOME" ] && [ ! -L "$ANAGRAM_HOME" ] || die "installation directory changed during setup"
}
# Rename beside the destination so running commands keep reading their old file.
install_ours() { # src dest [mode]
  check_parent "$2"
  case "$2" in "$ANAGRAM_HOME"/*) ;; *) die "internal error: refusing to write '$2' (outside $ANAGRAM_HOME)";; esac
  [ -L "$2" ] && die "internal error: refusing to write through symlink '$2'"
  [ ! -e "$2" ] || [ -f "$2" ] || die "internal error: destination is not a regular file: $2"
  replacement="$(mktemp "${2%/*}/.anagram-replace.XXXXXX")"
  if ! cp "$1" "$replacement"; then rm -f "$replacement"; return 1; fi
  if [ -n "${3:-}" ]; then chmod "$3" "$replacement"; fi
  mv -f "$replacement" "$2"
}

# A scrubbed environment for child processes: only what they need, nothing inherited.
# Proxies and CA settings pass through so corporate networks keep working.
clean_env() {
  env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$TMP" LANG="${LANG:-C.UTF-8}" \
    ${TERM:+TERM="$TERM"} ${COLUMNS:+COLUMNS="$COLUMNS"} \
    ${http_proxy:+http_proxy="$http_proxy"} ${https_proxy:+https_proxy="$https_proxy"} ${no_proxy:+no_proxy="$no_proxy"} \
    ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} ${NO_PROXY:+NO_PROXY="$NO_PROXY"} \
    ${SSL_CERT_FILE:+SSL_CERT_FILE="$SSL_CERT_FILE"} ${SSL_CERT_DIR:+SSL_CERT_DIR="$SSL_CERT_DIR"} \
    ${REQUESTS_CA_BUNDLE:+REQUESTS_CA_BUNDLE="$REQUESTS_CA_BUNDLE"} ${CURL_CA_BUNDLE:+CURL_CA_BUNDLE="$CURL_CA_BUNDLE"} \
    "$@"
}
run_uv() {
  clean_env UV_CACHE_DIR="$UV_CACHE" UV_PYTHON_INSTALL_DIR="$PYTHON_STORE" \
    UV_PYTHON_BIN_DIR="$TMP/python-bin" UV_TOOL_DIR="$TMP/tools" UV_TOOL_BIN_DIR="$TMP/tools/bin" \
    UV_PROJECT_ENVIRONMENT="$BUILD/venv" UV_PYTHON_PREFERENCE=only-managed UV_NO_CONFIG=1 UV_NO_MODIFY_PATH=1 \
    XDG_DATA_HOME="$TMP/xdg" XDG_CACHE_HOME="$TMP/xdg" XDG_CONFIG_HOME="$TMP/xdg" \
    ${PYTHON_FROM:+UV_PYTHON_INSTALL_MIRROR="$PYTHON_FROM"} \
    "$UV_BIN" "$@"
}

OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$CLEANUP_ONLY" -eq 0 ]; then case "$OS/$ARCH" in
  Darwin/arm64)
    MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
    [ "$MACOS_MAJOR" -ge 14 ] || die "the locked MLX and ONNX Runtime packages require macOS 14 or newer"
    UV_TARGET="aarch64-apple-darwin"; UV_SHA="1a7adf8dadae3b55853115d13a8bf564d219597ad13824b93b213706933863e5" ;;
  Darwin/x86_64) die "the locked model runtimes do not provide Intel macOS wheels; use macOS 14+ on Apple Silicon or Linux glibc 2.28+" ;;
  Linux/x86_64|Linux/aarch64)
    if ldd --version 2>&1 | grep -qi musl || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
      die "the locked model runtimes require glibc 2.28+; musl Linux is not supported"
    fi
    LIBC=gnu
    GLIBC_VERSION="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')" || true
    printf '%s\n' "$GLIBC_VERSION" | awk -F. 'NF >= 2 && ($1 > 2 || ($1 == 2 && $2 >= 28)) {ok=1} END {exit !ok}' \
      || die "the locked model runtimes require glibc 2.28+ (found ${GLIBC_VERSION:-unknown})"
    case "$ARCH/$LIBC" in
      x86_64/gnu)   UV_TARGET="x86_64-unknown-linux-gnu";   UV_SHA="588f3e360f69ce02b6982aa99f2240e803933a6b7e176ac01617830adf955add" ;;
      aarch64/gnu)  UV_TARGET="aarch64-unknown-linux-gnu";  UV_SHA="0f03c6648df1c159557f4222c0f37250f84733fb88d6fc3c16770e17c177a8c9" ;;
    esac ;;
  *) die "unsupported platform: $OS $ARCH (macOS 14+ Apple Silicon or glibc Linux x86_64/arm64)" ;;
esac; fi
# Where PyPI, GitHub or the Python builds are slow or blocked (mainland China, a company
# network), people point pip and uv at a mirror; the installer takes the same one. The
# lock's hashes, uv's checksums for Python and the pinned checksum of uv still decide every
# file, so a mirror changes where the files come from, never what they are. When a mirror
# fails, the original source is tried.
mirror_url() { # value: an http(s) URL of plain URL characters, else nothing
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$' || return 0
  printf '%s' "${1%/}"
}
url_host() { h="${1#*://}"; h="${h%%/*}"; printf '%s' "${h##*@}"; } # never a password in a log
first_mirror() { for candidate in "$@"; do candidate="$(mirror_url "$candidate")"; [ -z "$candidate" ] || { printf '%s' "$candidate"; return 0; }; done; }
# index-url in the [global] or [install] section of a pip configuration file.
pip_conf_index() {
  [ -f "$1" ] && [ -r "$1" ] || return 0
  awk '/^[ \t]*[#;]/ {next}
    /^[ \t]*\[/ {s = $0; gsub(/[ \t\r]/, "", s); next}
    s == "[global]" || s == "[install]" {
      i = index($0, "="); if (!i) next
      k = substr($0, 1, i - 1); gsub(/[ \t]/, "", k)
      if (k == "index-url" || k == "index_url") {v = substr($0, i + 1); gsub(/^[ \t]+|[ \t\r]+$/, "", v); print v; exit}
    }' "$1"
}
# From a uv.toml: the [[index]] marked default (or the older index-url), or python-install-mirror.
uv_toml_value() { # file index|python
  [ -f "$1" ] && [ -r "$1" ] || return 0
  awk -v want="$2" '
    BEGIN {q = sprintf("%c", 39)}
    function unquote(v) {if (match(v, /"[^"]*"/) || match(v, q "[^" q "]*" q)) return substr(v, RSTART + 1, RLENGTH - 2); return ""}
    function close_table() {if (t == "[[index]]" && def && url != "" && chosen == "") chosen = url}
    /^[ \t]*#/ {next}
    /^[ \t]*\[/ {close_table(); t = $0; sub(/#.*/, "", t); gsub(/[ \t\r]/, "", t); url = ""; def = 0; next}
    {
      i = index($0, "="); if (!i) next
      k = substr($0, 1, i - 1); gsub(/[ \t]/, "", k); v = substr($0, i + 1)
      if (t == "[[index]]") {if (k == "url") url = unquote(v); else if (k == "default" && v ~ /^[ \t]*true/) def = 1}
      else if ((t == "" || t == "[pip]") && k == "index-url" && top == "") top = unquote(v)
      else if (t == "" && k == "python-install-mirror") python = unquote(v)
    }
    END {close_table(); print (want == "python") ? python : (chosen != "" ? chosen : top)}' "$1"
}
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
UV_CONFIG="${UV_CONFIG_FILE:-$CONFIG_HOME/uv/uv.toml}"
PYPI_INDEX="$(first_mirror "${UV_DEFAULT_INDEX:-}" "${UV_INDEX_URL:-}" "${PIP_INDEX_URL:-}" "$(uv_toml_value "$UV_CONFIG" index)" \
  "$(pip_conf_index "${PIP_CONFIG_FILE:-}")" "$(pip_conf_index "$CONFIG_HOME/pip/pip.conf")" \
  "$(pip_conf_index "$HOME/Library/Application Support/pip/pip.conf")" "$(pip_conf_index "$HOME/.pip/pip.conf")" \
  "$(pip_conf_index /etc/xdg/pip/pip.conf)" "$(pip_conf_index /etc/pip.conf)")"
PYTHON_MIRROR="$(first_mirror "${UV_PYTHON_INSTALL_MIRROR:-}" "$(uv_toml_value "$UV_CONFIG" python)")"
UV_GITHUB="$(first_mirror "${UV_INSTALLER_GITHUB_BASE_URL:-}")"
PYTHON_FROM=""
mirror_failed() { note "$(tr_msg "$(url_host "$1") did not work; trying the original source" "$(url_host "$1") 无法使用，改用原始来源")"; }

# One installer at a time, including first install before private Python exists. The
# lock holds its installer's process ID, so the lock of one that was killed or lost
# with the machine is taken over, and what it left half-done is recovered.
acquire_lock() {
  mkdir "$CLAIM/.installer-lock"
  printf '%s\n' "${CLAIM##*/}" > "$CLAIM/.installer-lock/claim"
  printf '%s\n' "$$" > "$CLAIM/.installer-lock/pid"
  printf 'Anagram installation: %s\n' "$ANAGRAM_HOME" > "$CLAIM/.installer-lock/home-marker"
  [ "$CREATED_HOME" -eq 0 ] || : > "$CLAIM/.installer-lock/created-home"
  for attempt in 1 2 3; do
    if [ ! -e "$LOCK" ] && [ ! -L "$LOCK" ]; then
      # The destination is the parent directory. The complete, nonempty lock
      # takes its exact basename in one rename, including its PID.
      mv -n "$CLAIM/.installer-lock" "$ANAGRAM_HOME/" 2>/dev/null || :
      [ -e "$CLAIM/.installer-lock" ] || return 0
    fi
    [ -e "$LOCK" ] || continue
    [ -d "$LOCK" ] && [ ! -L "$LOCK" ] && [ ! -L "$LOCK/pid" ] || die "unsafe installer lock: $LOCK"
    for name in pid claim created-dirs home-marker scratch.path scratch.identity build.identity failed-mirror.identity scratch-files.json scratch-files.next scratch-python.sha swapping command.backup version.backup uv.backup stage proposed-files.json promoting registering created-home python-backup helper.py helper.sha receipt.sha python.sha; do
      path="$LOCK/$name"
      [ ! -L "$path" ] && { [ ! -e "$path" ] || [ -f "$path" ]; } || die "invalid installer journal: $name"
    done
    owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    case "$owner" in
      '') # A claimant killed between its two PID renames leaves an exact journal.
        if [ ! -e "$LOCK/pid" ] && [ -f "$LOCK/home-marker" ] && [ ! -L "$LOCK/home-marker" ] &&
           printf 'Anagram installation: %s\n' "$ANAGRAM_HOME" | cmp -s - "$LOCK/home-marker"; then
          for abandoned in "$LOCK"/pid.*; do
            [ -f "$abandoned" ] && [ ! -L "$abandoned" ] || continue
            claimant="${abandoned##*.}"; previous="$(cat "$abandoned")"
            case "$claimant" in ''|*[!0-9]*) continue ;; esac
            case "$previous" in ''|*[!0-9]*) continue ;; esac
            if ! kill -0 "$claimant" 2>/dev/null && ! kill -0 "$previous" 2>/dev/null; then
              mv -n "$abandoned" "$LOCK/pid" 2>/dev/null || :
              break
            fi
          done
        fi
        sleep 1; continue ;;
      *[!0-9]*) die "unreadable installer lock: $LOCK" ;;
    esac
    ! kill -0 "$owner" 2>/dev/null || die "another installer (process $owner) is using $ANAGRAM_HOME; retry after it finishes"
    # Its installer is gone. Of several claimants only one can move its pid file aside;
    # one that moved a live claimant's file instead puts it back.
    [ ! -e "$LOCK/pid.$$" ] && [ ! -L "$LOCK/pid.$$" ] || die "installer lock claim already exists"
    mv "$LOCK/pid" "$LOCK/pid.$$" 2>/dev/null || die "another installer is recovering $ANAGRAM_HOME; retry after it finishes"
    if [ "$(cat "$LOCK/pid.$$")" != "$owner" ]; then
      mv "$LOCK/pid.$$" "$LOCK/pid"
      die "another installer is recovering $ANAGRAM_HOME; retry after it finishes"
    fi
    mv "$CLAIM/.installer-lock/pid" "$LOCK/pid"
    rm -f "$LOCK/pid.$$"
    RECOVERING=1
    note "$(tr_msg 'Recovering from an interrupted installation' '正在恢复被中断的安装')"
    return 0
  done
  die "another installer is active, or its lock cannot be verified: $LOCK. Wait for any running installer to finish. If the lock persists, keep its contents for recovery."
}
# After a crash the user may have edited either copy or put files into staging.
# Move uncertain entries aside without opening them, even if a backup exists.
keep_interrupted() {
  check_parent "$1"
  [ -e "$1" ] || [ -L "$1" ] || return 0
  if [ -z "$recovery_dir" ]; then
    recovery_dir="$(mktemp -d "$ANAGRAM_HOME/.preserved-XXXXXX")"
    note "Keeping files from the interrupted installation in $recovery_dir"
  fi
  check_parent "$recovery_dir/${1##*/}"
  [ ! -e "$recovery_dir/${1##*/}" ] && [ ! -L "$recovery_dir/${1##*/}" ] || die "recovery destination already exists; files were kept"
  mv "$1" "$recovery_dir/${1##*/}"
}
prune_recorded() {
  prune_root="$1"; shift
  [ -f "$LOCK/helper.sha" ] && [ -f "$LOCK/receipt.sha" ] && [ -f "$LOCK/python.sha" ] || return 0
  for name in helper.sha receipt.sha python.sha helper.py proposed-files.json; do
    [ -f "$LOCK/$name" ] && [ ! -L "$LOCK/$name" ] || return 0
  done
  [ "$(sha256_of "$LOCK/helper.py")" = "$(cat "$LOCK/helper.sha")" ] &&
    [ "$(sha256_of "$LOCK/proposed-files.json")" = "$(cat "$LOCK/receipt.sha")" ] || return 0
  for prune_python in "$ROLLBACK_PY" "$ANAGRAM_HOME/venv/bin/python" "$prune_root/venv/bin/python" \
      "$ANAGRAM_HOME"/python/*/bin/python3 "$prune_root"/python/*/bin/python3; do
    [ -x "$prune_python" ] && [ "$(sha256_of "$prune_python")" = "$(cat "$LOCK/python.sha")" ] || continue
    clean_env "$prune_python" -I -B -S - "$LOCK" "$ANAGRAM_HOME" "$prune_root" "$@" <<'PYPRUNE' || note "Keeping files whose ownership could not be verified"
import sys
from pathlib import Path
folder, home, destination = map(Path, sys.argv[1:4])
sys.path.insert(0, str(folder))
from helper import read_files, prune_files
roots = set(sys.argv[4:])
files = read_files(home, folder / "proposed-files.json")
prune_files(destination, {name: signature for name, signature in files.items()
                          if name in roots or name.split("/")[0] in roots})
PYPRUNE
    return 0
  done
}
record_plan() {
  printf '%s\n' "$(sha256_of "$LOCK/proposed-files.json")" > "$TMP/receipt.sha"
  printf '%s\n' "$(sha256_of "$1")" > "$TMP/python.sha"
  install_ours "$TMP/python.sha" "$LOCK/python.sha"
  install_ours "$TMP/receipt.sha" "$LOCK/receipt.sha"
}
scratch_records() { # verified private interpreter, operation, scratch, expected top-level entries
  scratch_runner="$1"; scratch_action="$2"; scratch_root="$3"; shift 3
  clean_env "$scratch_runner" -I -B -S - "$scratch_action" "$scratch_root" "$LOCK" "$ANAGRAM_HOME" "$@" <<'PYSCRATCH'
import hashlib, json, os, stat, sys
from pathlib import Path
action, scratch, lock, home, *roots = sys.argv[1:]
scratch, lock = Path(scratch), Path(lock)
info = scratch.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
    raise ValueError("unsafe installer scratch")
binding = [home, (lock / "stage").read_text().strip(), str(scratch), info.st_dev, info.st_ino]
plan = lock / "scratch-files.json"
if plan.is_symlink():
    raise ValueError("unsafe scratch receipt")
data = json.loads(plan.read_bytes()) if plan.is_file() else {"binding": binding, "files": {}}
if data["binding"] != binding:
    raise ValueError("scratch receipt does not belong to this install")
files = data["files"]
def fingerprint(path, info):
    identity = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
    if stat.S_ISLNK(info.st_mode):
        return [*identity, "link:" + os.readlink(path)]
    if stat.S_ISREG(info.st_mode):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            if not os.path.samestat(info, os.fstat(stream.fileno())):
                raise ValueError("temporary file changed during inspection")
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        after = path.lstat()
        if not os.path.samestat(info, after) or after.st_size != info.st_size or after.st_mtime_ns != info.st_mtime_ns:
            raise ValueError("temporary file changed during inspection")
        return [*identity, digest]
    if stat.S_ISDIR(info.st_mode) and not path.is_mount():
        return [info.st_dev, info.st_ino, "dir"]
def record(path):
    info = path.lstat()
    name = path.relative_to(scratch).as_posix()
    old = files.get(name)
    signature = old if old and len(old) == 5 and old[:4] == [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns] else fingerprint(path, info)
    if signature is None:
        return
    if old and old != signature:
        return  # Already recorded. Preserve a later edit.
    files[name] = signature
    if signature[-1] == "dir":
        for child in path.iterdir():
            record(child)
if action == "record":
    for root in roots:
        path = scratch / root
        if path.exists() or path.is_symlink():
            record(path)
    fresh = lock / "scratch-files.next"
    with fresh.open("x") as output:
        json.dump(data, output, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    fresh.replace(plan)
else:
    for name, expected in sorted(files.items(), key=lambda item: item[0].count("/"), reverse=True):
        if roots and name.split("/")[0] not in roots:
            continue
        if not name or any(part in (".", "..", "") for part in name.split("/")):
            raise ValueError("invalid scratch record")
        path = scratch / name
        if any(parent.is_symlink() or parent.is_mount() for parent in path.parents if parent != scratch and parent.is_relative_to(scratch)):
            continue
        try:
            info = path.lstat()
            if fingerprint(path, info) == expected:
                if expected[-1] == "dir":
                    try:
                        path.rmdir()
                    except OSError:
                        pass
                else:
                    path.unlink()
        except FileNotFoundError:
            pass
PYSCRATCH
}
directory_identity() {
  if [ "$OS" = Darwin ]; then stat -f '%d:%i' "$1"; else stat -c '%d:%i' "$1"; fi
}
recover_scratch() {
  [ -f "$LOCK/scratch.path" ] && [ -f "$LOCK/stage" ] || return 0
  scratch_root="$(cat "$LOCK/scratch.path")"
  case "$scratch_root" in /*/anagram-install.??????) ;; *) die "invalid installer scratch path" ;; esac
  [ -e "$scratch_root" ] || return 0
  if [ -L "$scratch_root" ] || [ ! -d "$scratch_root" ] || [ -L "$LOCK/scratch.identity" ] || [ ! -f "$LOCK/scratch.identity" ] ||
     [ "$(directory_identity "$scratch_root")" != "$(cat "$LOCK/scratch.identity")" ]; then
    note "The temporary directory identity changed or was never recorded. Kept $scratch_root"
    return 0
  fi
  scratch_stamp="Anagram scratch: $ANAGRAM_HOME/$(cat "$LOCK/stage")"
  if ! { [ ! -L "$scratch_root" ] && [ -d "$scratch_root" ] && [ "$(cd "$scratch_root" && pwd -P)" = "$scratch_root" ] &&
    [ -f "$scratch_root/.anagram-work" ] && [ ! -L "$scratch_root/.anagram-work" ] &&
    printf '%s\n' "$scratch_stamp" | cmp -s - "$scratch_root/.anagram-work"; }; then
    note "Temporary directory ownership changed. Kept $scratch_root"
    return 0
  fi
  scratch_stage=$(cat "$LOCK/stage")
  case "$scratch_stage" in .staging.[a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9]) ;; *) die "invalid scratch transaction" ;; esac
  if [ -f "$LOCK/scratch-files.json" ] && [ -f "$LOCK/scratch-python.sha" ]; then
    for scratch_runner in "$scratch_root"/bootstrap-python/*/bin/python3 "$scratch_root/build/venv/bin/python" \
        "$ANAGRAM_HOME/venv/bin/python" "$ANAGRAM_HOME"/python/*/bin/python3 "$ANAGRAM_HOME/$scratch_stage/venv/bin/python"; do
      [ -x "$scratch_runner" ] && [ "$(sha256_of "$scratch_runner")" = "$(cat "$LOCK/scratch-python.sha")" ] || continue
      if ! scratch_records "$scratch_runner" prune "$scratch_root"; then
        note "Temporary file ownership could not be verified. Kept $scratch_root"
        return 0
      fi
      break
    done
  fi
  for build_root in build failed-mirror; do
    if [ -d "$scratch_root/$build_root" ] && [ ! -L "$scratch_root/$build_root" ] && [ ! -L "$LOCK/$build_root.identity" ] &&
       [ -f "$LOCK/$build_root.identity" ] && [ "$(directory_identity "$scratch_root/$build_root")" = "$(cat "$LOCK/$build_root.identity")" ]; then
      prune_recorded "$scratch_root/$build_root" app extension venv
      rmdir "$scratch_root/$build_root" 2>/dev/null || :
    fi
  done
  rm -f "$LOCK/scratch.path"
  rm -f "$scratch_root/.anagram-work"
  rmdir "$scratch_root" 2>/dev/null || note "Temporary files without a matching receipt remain at $scratch_root ($(du -skx "$scratch_root" | cut -f1) KiB)"
}
finish_registration() {
  # Never execute a program that changed after the verified release was
  # staged. The pending browser/ID can differ from the caller retrying today.
  {
    IFS= read -r transaction && IFS= read -r request_browser &&
      IFS= read -r request_id && IFS= read -r request_lang &&
      IFS= read -r helper_sha && IFS= read -r python_sha && IFS= read -r receipt_sha &&
      ! IFS= read -r extra
  } < "$LOCK/registering" || die "invalid interrupted registration record; installation was preserved"
  [ -n "$transaction" ] && [ "$transaction" = "$(cat "$LOCK/stage")" ] || die "registration receipt does not match the installer transaction"
  recovery_helper="$ANAGRAM_HOME/app/native_registration.py"
  recovery_python="$ANAGRAM_HOME/venv/bin/python"
  [ ! -L "$recovery_helper" ] && [ -f "$recovery_helper" ] && [ "$(sha256_of "$recovery_helper")" = "$helper_sha" ] &&
    [ -x "$recovery_python" ] && [ "$(sha256_of "$recovery_python")" = "$python_sha" ] &&
    [ -f "$LOCK/proposed-files.json" ] && [ "$(sha256_of "$LOCK/proposed-files.json")" = "$receipt_sha" ] ||
      die "files needed to recover browser registration changed; installation was preserved"
  if clean_env "$recovery_python" -I "$recovery_helper" registration-committed --transaction "$transaction" --home "$ANAGRAM_HOME"; then :
  else
    [ "$?" -eq 1 ] || die "registration inventory could not be verified; installation was preserved"
    if [ "$CLEANUP_ONLY" -eq 1 ]; then
      if clean_env "$recovery_python" -I "$recovery_helper" registration-pending --transaction "$transaction" --home "$ANAGRAM_HOME"; then :
      else
        [ "$?" -eq 1 ] || die "registration inventory could not be verified; installation was preserved"
        rm -f "$LOCK/registering"
        return 0  # No browser registration was written. Roll back the pending swaps.
      fi
    fi
    clean_env "$recovery_python" -I "$recovery_helper" register --installed-files --transaction "$transaction" \
      --staged-files "$LOCK/proposed-files.json" --home "$ANAGRAM_HOME" --browser "$request_browser" \
      --extension-id "$request_id" --language "$request_lang" || die "could not finish interrupted registration; installation and recovery information were preserved"
  fi
  python_backup=""
  [ ! -f "$LOCK/python-backup" ] || python_backup=--python-backup
  clean_env "$recovery_python" -I "$recovery_helper" finish-update $python_backup --home "$ANAGRAM_HOME" --backups "$LOCK" ||
    die "installed component needs a cleanup retry; registration recovery information was preserved"
  rm -f "$LOCK/registering" "$LOCK/promoting" "$LOCK/swapping" "$LOCK/command.backup" "$LOCK/version.backup" "$LOCK/uv.backup"
}
recover_leftovers() {
  recovery_dir=""
  if [ -f "$LOCK/claim" ]; then
    old_claim="$(cat "$LOCK/claim")"
    case "$old_claim" in .anagram-claim.[a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9])
      old_path="${ANAGRAM_HOME%/*}/$old_claim"
      if [ ! -L "$old_path" ] && [ -f "$old_path/owner" ] && [ ! -L "$old_path/owner" ] &&
          printf 'Anagram claim: %s/%s\n' "$ANAGRAM_HOME" "$old_claim" | cmp -s - "$old_path/owner"; then
        rm "$old_path/owner"; rmdir "$old_path" 2>/dev/null || note "Unverified claim files were kept in $old_path"
      fi ;;
      *) die "invalid installer claim record" ;; esac
  fi
  recover_scratch
  [ ! -f "$LOCK/registering" ] || finish_registration
  swapping=0; [ ! -f "$LOCK/swapping" ] || swapping=1
  for sub in app extension venv python; do
    if [ "$sub" = python ] && [ ! -f "$LOCK/python-backup" ]; then continue; fi
    [ -e "$ANAGRAM_HOME/$sub.old" ] || continue
    if [ "$swapping" -eq 1 ] || [ ! -e "$ANAGRAM_HOME/$sub" ]; then
      prune_recorded "$ANAGRAM_HOME" "$sub"
      keep_interrupted "$ANAGRAM_HOME/$sub"
      mv "$ANAGRAM_HOME/$sub.old" "$ANAGRAM_HOME/$sub"
    else
      keep_interrupted "$ANAGRAM_HOME/$sub.old"
    fi
  done
  if [ "$swapping" -eq 1 ]; then
    if [ -f "$LOCK/promoting" ]; then
      while IFS= read -r sub; do
        case "$sub" in app|extension|venv|python|bin/anagram|bin/uv|VERSION) ;; *) die "invalid installer promotion journal" ;; esac
        prune_recorded "$ANAGRAM_HOME" "$sub"
        keep_interrupted "$ANAGRAM_HOME/$sub"
      done < "$LOCK/promoting"
    fi
    if [ -f "$LOCK/command.backup" ] && ! cmp -s "$LOCK/command.backup" "$ANAGRAM_HOME/bin/anagram"; then
      prune_recorded "$ANAGRAM_HOME" bin/anagram
      keep_interrupted "$ANAGRAM_HOME/bin/anagram"
      install_ours "$LOCK/command.backup" "$ANAGRAM_HOME/bin/anagram" 755
    fi
    if [ -f "$LOCK/version.backup" ] && ! cmp -s "$LOCK/version.backup" "$ANAGRAM_HOME/VERSION"; then
      prune_recorded "$ANAGRAM_HOME" VERSION
      keep_interrupted "$ANAGRAM_HOME/VERSION"
      install_ours "$LOCK/version.backup" "$ANAGRAM_HOME/VERSION"
    fi
    if [ -f "$LOCK/uv.backup" ] && ! cmp -s "$LOCK/uv.backup" "$ANAGRAM_HOME/bin/uv"; then
      prune_recorded "$ANAGRAM_HOME" bin/uv
      keep_interrupted "$ANAGRAM_HOME/bin/uv"
      install_ours "$LOCK/uv.backup" "$ANAGRAM_HOME/bin/uv" 755
    fi
  fi
  if [ "$swapping" -eq 1 ] && [ -f "$LOCK/created-dirs" ]; then
    while IFS= read -r sub; do
      case "$sub" in bin|models|run|cache|hf) rmdir "$ANAGRAM_HOME/$sub" 2>/dev/null || : ;; *) die "invalid directory journal" ;; esac
    done < "$LOCK/created-dirs"
  fi
  if [ -f "$LOCK/stage" ] && [ ! -L "$LOCK/stage" ]; then
    stage="$(cat "$LOCK/stage")"
    case "$stage" in .staging.[a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9])
      prune_recorded "$ANAGRAM_HOME/$stage" app extension venv python
      rmdir "$ANAGRAM_HOME/$stage" 2>/dev/null || keep_interrupted "$ANAGRAM_HOME/$stage" ;;
      *) die "invalid staging receipt" ;; esac
  fi
  keep_interrupted "$ANAGRAM_HOME/venv.next"
  # A crash can occur after replacing a fixed file and before its old bytes
  # were classified by finish-update. Keep any such journal copies.
  for name in command.backup version.backup uv.backup; do keep_interrupted "$LOCK/$name"; done
  rm -f "$LOCK/created-dirs" "$LOCK/scratch.path" "$LOCK/scratch.identity" "$LOCK/build.identity" "$LOCK/failed-mirror.identity" "$LOCK/scratch-files.next" "$LOCK/scratch-files.json" "$LOCK/scratch-python.sha" "$LOCK/created-home" "$LOCK/helper.py" "$LOCK/helper.sha" "$LOCK/receipt.sha" "$LOCK/python.sha" "$LOCK/python-backup" "$LOCK/swapping" "$LOCK/promoting" "$LOCK/proposed-files.json"
  printf '%s\n' "${CLAIM##*/}" > "$LOCK/claim"
}
if [ "$CLEANUP_ONLY" -eq 1 ] && [ ! -e "$ANAGRAM_HOME/$MARKER" ] && ! bootstrap_lock_only; then
  note "No verified Anagram installation to clean at $ANAGRAM_HOME"; exit 0
fi
if [ ! -d "$ANAGRAM_HOME" ]; then
  mkdir -p "$(dirname "$ANAGRAM_HOME")"
  if mkdir "$ANAGRAM_HOME" 2>/dev/null; then CREATED_HOME=1
  elif [ ! -d "$ANAGRAM_HOME" ] || [ -L "$ANAGRAM_HOME" ]; then die "could not create $ANAGRAM_HOME"; fi
fi
ANAGRAM_HOME="$(cd "$ANAGRAM_HOME" && pwd -P)"
LOCK="$ANAGRAM_HOME/.installer-lock"
CLAIM="$(mktemp -d "${ANAGRAM_HOME%/*}/.anagram-claim.XXXXXX")"
CLAIM_ID="$(directory_identity "$CLAIM")"
printf 'Anagram claim: %s/%s\n' "$ANAGRAM_HOME" "${CLAIM##*/}" > "$CLAIM/owner"
if [ ! -f "$ANAGRAM_HOME/$MARKER" ]; then
  [ -z "$(ls -A "$ANAGRAM_HOME")" ] || bootstrap_lock_only || die "files appeared in the new installation directory"
  printf 'Anagram installation: %s\n' "$ANAGRAM_HOME" > "$CLAIM/$MARKER"
  mv -n "$CLAIM/$MARKER" "$ANAGRAM_HOME/"
  [ -f "$CLAIM/$MARKER" ] || CREATED_MARKER=1
fi
RECOVERING=0
acquire_lock
if [ "$RECOVERING" -eq 0 ]; then INSTALL_LOCK="$LOCK"; fi
check_marker
if [ "$RECOVERING" -eq 1 ] && [ -f "$LOCK/created-home" ]; then CREATED_HOME=1; fi
if [ "$CREATED_MARKER" -eq 1 ]; then
  remaining="$(find "$ANAGRAM_HOME" ! -path "$ANAGRAM_HOME" -prune ! -name .installer-lock ! -name "$MARKER" -print)"
  [ -z "$remaining" ] || die "files appeared in the new installation directory"
fi
# Until recovery succeeds the lock stays behind for the next installer to take over.
[ "$RECOVERING" -eq 0 ] || recover_leftovers
INSTALL_LOCK="$LOCK"
if [ "$CLEANUP_ONLY" -eq 1 ]; then
  if [ -e "$ANAGRAM_HOME/.native-component.json" ]; then
    note "The registered component is available. To remove it, run: $ANAGRAM_HOME/bin/anagram uninstall"
  else
    CREATED_MARKER=1
    note "Recovered the interrupted install. Unverified files, if present, were kept in $ANAGRAM_HOME"
  fi
  exit 0
fi
# Another installer may have finished between the initial checks and this lock.
for sub in app extension bin models venv python hf cache logs run tools "$MARKER" VERSION bin/anagram bin/anagram.new bin/uv bin/uv.new .native-host.lock .native-component.json native-registration.json; do
  [ ! -L "$ANAGRAM_HOME/$sub" ] || die "symbolic link in installation: $sub"
done
for sub in app.old extension.old venv.old venv.next; do
  [ ! -e "$ANAGRAM_HOME/$sub" ] && [ ! -L "$ANAGRAM_HOME/$sub" ] || die "unfinished or unsafe staging path: $ANAGRAM_HOME/$sub"
done
if [ -e "$ANAGRAM_HOME/.native-component.json" ] || [ -e "$ANAGRAM_HOME/.native-host.lock" ]; then
  [ -x "$ANAGRAM_HOME/venv/bin/python" ] || die "the existing component has no private Python; repair or remove it before installing"
  if [ -n "${ANAGRAM_MAINTENANCE_FD:-}" ]; then
    install_fd="$ANAGRAM_MAINTENANCE_FD"
  else
    # flock is attached to this open-file description, shared with the Python child.
    exec 9<> "$ANAGRAM_HOME/.native-host.lock"
    install_fd=9
  fi
  clean_env "$ANAGRAM_HOME/venv/bin/python" -I - "$ANAGRAM_HOME" "$install_fd" <<'PYLOCK'
import fcntl, json, os, stat, sys
from pathlib import Path
home, fd = Path(sys.argv[1]), int(sys.argv[2])
path = home / '.native-host.lock'
if fd < 3 or path.is_symlink():
    sys.exit('Invalid native maintenance lock')
opened, current = os.fstat(fd), path.lstat()
if not all(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 for info in (opened, current)) or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
    sys.exit('Native maintenance lock path changed')
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit('Anagram is running. Stop/disconnect the local component in Settings before reinstalling.')
marker = home / '.native-component.json'
if marker.is_symlink() or json.loads(marker.read_text()) != {'schema_version': 1, 'host': 'dev.coderbak.anagram', 'home': str(home.resolve())}:
    sys.exit('Component ownership marker does not match this directory')
# Do not LOCK_UN: the parent shell still owns the same open-file description.
PYLOCK
fi
STAGE="$(mktemp -d "$ANAGRAM_HOME/.staging.XXXXXX")"
printf '%s\n' "${STAGE##*/}" > "$LOCK/stage"
temp_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
temp_candidate="$temp_parent/anagram-install.${STAGE##*.}"
printf '%s\n' "$temp_candidate" > "$LOCK/scratch.path"
mkdir "$temp_candidate" || die "temporary directory already exists: $temp_candidate"
TMP="$temp_candidate"
directory_identity "$TMP" > "$LOCK/scratch.identity"
printf 'Anagram scratch: %s/%s\n' "$ANAGRAM_HOME" "${STAGE##*/}" > "$TMP/.anagram-work"
UV_CACHE="$TMP/bootstrap-cache"
BUILD="$TMP/build"
mkdir "$BUILD"
directory_identity "$BUILD" > "$LOCK/build.identity"
UV_BIN="$ANAGRAM_HOME/bin/uv"
PYTHON_STORE="$ANAGRAM_HOME/python"

RECORD_UV=""
# ---------------------------------------------------------------- 1. uv (pinned release binary, checksum-verified)
# uv and the private Python come first: the release's signature is checked with them, before
# anything of the release is opened.
step 1 "$(tr_msg 'Preparing the package manager' '正在准备依赖管理器')"
if [ ! -x "$ANAGRAM_HOME/bin/uv" ] || [ "$(clean_env "$ANAGRAM_HOME/bin/uv" --version 2>/dev/null | cut -d' ' -f2)" != "$UV_VERSION" ]; then
  note "$(tr_msg 'Downloading uv' '正在下载 uv') $UV_VERSION"
  uv_release="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TARGET.tar.gz"
  if [ -z "$UV_GITHUB" ] || ! { note "$(tr_msg 'from your mirror,' '来自你配置的镜像') $(url_host "$UV_GITHUB")"; curl -q --proto =https,file --proto-redir =https -fL --retry 3 -o "$TMP/uv.tar.gz" "$UV_GITHUB${uv_release#https://github.com}" && [ "$(sha256_of "$TMP/uv.tar.gz")" = "$UV_SHA" ]; }; then
    [ -z "$UV_GITHUB" ] || mirror_failed "$UV_GITHUB"
    curl -q --proto =https,file --proto-redir =https -fL --retry 3 -o "$TMP/uv.tar.gz" "$uv_release"
  fi
  [ "$(sha256_of "$TMP/uv.tar.gz")" = "$UV_SHA" ] || die "checksum mismatch for uv-$UV_TARGET.tar.gz"
  tar -xzf "$TMP/uv.tar.gz" -C "$TMP" "uv-$UV_TARGET/uv"
  RECORD_UV=--new-uv
  UV_BIN="$TMP/uv-$UV_TARGET/uv"
else
  note "$(tr_msg 'Using installed uv' '使用已安装的 uv') $UV_VERSION"
fi

# ---------------------------------------------------------------- 2. private Python
RECORD_PYTHON=""
step 2 "$(tr_msg 'Installing private Python' '正在安装独立 Python') $PYTHON_VERSION"
PYTHON_FROM="$PYTHON_MIRROR"
existing_python=""
[ ! -d "$PYTHON_STORE" ] || existing_python="$(run_uv python find --managed-python --no-python-downloads "$PYTHON_VERSION" 2>/dev/null || :)"
case "$existing_python" in "$PYTHON_STORE"/*) [ -x "$existing_python" ] || existing_python="" ;; *) existing_python="" ;; esac
if [ -z "$existing_python" ]; then
  RECORD_PYTHON=--new-python
  PYTHON_STORE="$TMP/bootstrap-python"
  if [ -z "$PYTHON_FROM" ] || ! { note "$(tr_msg 'from your mirror,' '来自你配置的镜像') $(url_host "$PYTHON_FROM")"; run_uv python install "$PYTHON_VERSION"; }; then
    [ -z "$PYTHON_FROM" ] || mirror_failed "$PYTHON_FROM"
    PYTHON_FROM=""
    run_uv python install "$PYTHON_VERSION"
  fi
fi
# Take the first scratch receipt as soon as a verified interpreter exists.
scratch_python="$existing_python"
if [ -z "$scratch_python" ]; then
  for candidate in "$PYTHON_STORE"/*/bin/python3; do
    [ ! -x "$candidate" ] || { scratch_python="$candidate"; break; }
  done
fi
if [ -n "$scratch_python" ]; then
  printf '%s\n' "$(sha256_of "$scratch_python")" > "$LOCK/scratch-python.sha"
  scratch_records "$scratch_python" record "$TMP" bootstrap-python "uv-$UV_TARGET" uv.tar.gz bootstrap-cache python-bin
fi
UV_CACHE="$TMP/verifier-cache"
# ---------------------------------------------------------------- the release's signature
# A release fetched over HTTPS is used only if its Sigstore bundle verifies: signed by
# .github/workflows/release.yml in GitHub Actions at the release's tag, and by nothing else
# (installer/verify_release.py, run with sigstore-python in a throwaway environment, every
# file's hash pinned). A release given as a local file is one's own build, checked by its
# checksum alone.
sigstore_requirements() {
  cat <<'REQUIREMENTS'
# >>> generated by scripts/sigstoreLock.mjs from installer/sigstore.in
annotated-types==0.8.0 --hash=sha256:f072f4d804ea359e4eaf198b1af7a8b0943881a87f31bb764f8bf219bb9419e0
certifi==2026.7.22 --hash=sha256:62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775
cffi==2.1.1 ; platform_python_implementation != 'PyPy' --hash=sha256:68e62fe11f30d5ca8289242866f0a5291402d8529ca2178ab8afc5c9694ae890 --hash=sha256:c1453022f490d2459a11819d83ad1d586e9ff65a12ac3e705ffebd46d3685dcf --hash=sha256:f53e442b08449d42821fa4a4fba000095af9f62742a500f978a9f557ec44339a --hash=sha256:f81b3b8f3d4e343550fa4baa0e479bba9f2d29ce9c2e9b51d1ce1718d7442fcf
charset-normalizer==3.5.2 --hash=sha256:1c50fe28bbc2ced33386f298650d91218076c05420e6cbd790b913adc41659e7 --hash=sha256:3d31298449090ab8d47b7b1b2a555ff73cac7ed438a08b7ac160980c7ebed649 --hash=sha256:4275811936e2f06feff5e598fb42a1b7ae852da8e39605211892b56b81a34efd --hash=sha256:780fbe7cab297b81dad9fb8dc5eb003c0468ffb0d9e5f65068c53a34661a96bc --hash=sha256:9f56f72050826f63dcee7a7f55b0a77168cb3bfc553fd405e7f8f9ece75a4036 --hash=sha256:b6b751274acb69d77b3323d6b7dbaa3c7fdfc1eb829b7eb61d262f32e1af9685 --hash=sha256:b91363207bd9dc966a691e959bb47f64b30f7ac4b072be9968b366982f7db77c --hash=sha256:d19fbd981a488e22cd04883659ca6b08f50b5974f9fd7c95655ef6a043e5893f --hash=sha256:ed2a239c0ea213acc1908150a3037257083c7c083128f1a4cec2ec4b97dca491
cryptography==50.0.2 --hash=sha256:0ddc924c04591c2811ca024d62ecad4f7f6f08af8939c211438f48a16bd23602 --hash=sha256:0ec5f09541743261e66e291b4a0cbf0fb2997aeaab6d9e9c740b9dba1b58d1c2 --hash=sha256:1981f1db4630889b9ef7803fadef12b056f428cb6b85c27ba57b774793b6093c --hash=sha256:4061c0079120205fb760c58acab6443e217307dcf05e3702cf970e0689972856 --hash=sha256:4e81d95e5bafc2d6e34e4bed780e53e4d5b9a2f928573428aa4d35fbec1eb0de --hash=sha256:630ebfea3bf689d075f82316324ff7433dc447fe6bc1bfc76524b74b4a9567d2 --hash=sha256:79def8d059362e7831389ed3be0ecdf58a89386e1271e35dd9f5af84e81bffd0 --hash=sha256:7afa5a6602a9f29af1f3a2965f831bae7c9d5d597b7cbb716d41ab3b7d89879c --hash=sha256:87e9ce85beb6b328ba370cc6e6aea483c92617b4c95b1d33a49297eb662bfb04 --hash=sha256:9dab55f57c74c3cad24c323bacbbd04be4705ba6eb0d92e920b1fc4837ed5079 --hash=sha256:c5e67125c7dca78d199ec4e116aa93dbb83494808ecbb8211a2cb09b1bf41dbd --hash=sha256:dfe9763530994147d9af1def057a5b9658b00e8f8fe8743d144d1e0911c2e454 --hash=sha256:ee247f5c245c9a2fe7c8e2214e295918838e44e00a45a6718451e4004219e767 --hash=sha256:f21e8a22c8605750c7af886bab299a363721264061b4ac0a30efb73cfd58efc5 --hash=sha256:f9f6143a8c75945eb960d9eb98905a441394abfa24afaae239d514ffb2586480 --hash=sha256:fa8f5efb344d6908a1ce62f4a24e2e5780f825d6f53f5f50ec5ffacac72936cb
dnspython==2.9.0 --hash=sha256:9a4aedb833c3c1b49214d04d44d3032ab7a9135f7c1d29a549b4ff78fd82fda9
email-validator==2.3.0 --hash=sha256:80f13f623413e6b197ae73bb10bf4eb0908faf509ad8362c5edeb0be7fd450b4
id==1.6.1 --hash=sha256:f5ec41ed2629a508f5d0988eda142e190c9c6da971100612c4de9ad9f9b237ca
idna==3.20 --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
markdown-it-py==4.2.0 --hash=sha256:9f7ebbcd14fe59494226453aed97c1070d83f8d24b6fc3a3bcf9a38092641c4a
mdurl==0.1.2 --hash=sha256:84008a41e51615a49fc9966191ff91509e3c40b939176e643fd50a5c2196b8f8
platformdirs==4.12.4 --hash=sha256:78bfb9db2a8471ed7eebe3c3c932da413911042994e699b384fbb4493fa872d7
pyasn1==0.6.4 --hash=sha256:deda9277cfd454080ec40b207fb6df82206a3a2688735233cdcd8d3d565f088b
pycparser==3.11 ; implementation_name != 'PyPy' and platform_python_implementation != 'PyPy' --hash=sha256:51d5a8ba2be0bbe440b99d2112604c95bbbc3c2748a64260186c541e1729cd80
pydantic==2.14.0 --hash=sha256:15fab1bea6f1dc5003b54fc2ecab230c1fd1dbade2acd4addc52d81e32416d4b
pydantic-core==2.50.0 --hash=sha256:0abe1b44d361b948404b6b2ed80be2583e0077340572e071afa6e0eda4e1de30 --hash=sha256:1541c334af5d42cb9eb03862a9b4d2cfbfc670fd05172ec51f3ce02d704550f1 --hash=sha256:ae45853d25a23fba56681d2f9ed41f3e3f12f0a3b2393fefa08ff6406320a1f5 --hash=sha256:f187030fc3d62c668feb0f09e92852e0eb414d7fcefc4748f2e67d245aade37e
pygments==2.21.0 --hash=sha256:2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9
pyjwt==2.15.1 --hash=sha256:42d59d631f7768a1028a64c7ff581a9bf7519804daf91fc5b6c56e30eec5e193
pyopenssl==26.4.0 --hash=sha256:f0eb0cb2d581d3ad2b9c489468485e7f2ab6727d08401bcf9d824c3caddf3c1c
requests==2.34.2 --hash=sha256:2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0
rfc3161-client==1.0.9 --hash=sha256:7b703b233dbee7228d117d5f1c118363c61d523fa6f018c9217c79e3c6684f86 --hash=sha256:908f6a775da4bdce1d39f825a4431f389542696078ef3e4ed911a068bcaf1792 --hash=sha256:a7004edfbf1bb7ec7801978a39fa7a7fe385ca59673df90d7578079b6eba3b24 --hash=sha256:fac3f440a507555e684dc5daba75e33dc08f0f45fdefa48448f19001233a6b21
rfc8785==0.1.4 --hash=sha256:520d690b448ecf0703691c76e1a34a24ddcd4fc5bc41d589cb7c58ec651bcd48
rich==15.0.0 --hash=sha256:33bd4ef74232fb73fe9279a257718407f169c09b78a87ad3d296f548e27de0bb
securesystemslib==1.5.1 --hash=sha256:ada8bdf817da29ece4ba91654f6a162ce7cfbadbc3ae3f840f7313f9d22675de
sigstore==4.5.0 --hash=sha256:f045b207f2e12605cf775ec38e89c5eda625d71ffa7830477db65e47ec2bc8b2
sigstore-models==0.0.6 --hash=sha256:5201a68f4d7d0f8bec1e2f4378eb646b084c52609a4e31db8c385095fff68b2e
sigstore-rekor-types==0.0.18 --hash=sha256:b62bf38c5b1a62bc0d7fe0ee51a0709e49311d137c7880c329882a8f4b2d1d78
tuf==7.0.1 --hash=sha256:d30434bda6e079ab303fb30d1b3006d939a10ca34783b1573d61cd9b802fa45c
typing-extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
typing-inspection==0.4.4 --hash=sha256:65b8397ba37ccbce054456aaccddfc91e6e3083c92824df348d96ca832f3f147
urllib3==2.8.0 --hash=sha256:0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3
# <<< generated
REQUIREMENTS
}
verify_release_script() {
  cat <<'SCRIPT'
# >>> installer/verify_release.py, copied by scripts/sigstoreLock.mjs
"""Verify a release's Sigstore bundle before anything of the release is used.

A release is signed by .github/workflows/release.yml, run in GitHub Actions at the release's
tag, and by nothing else: Sigstore keyless signing names that workflow, its repository and
the tag in a certificate the public log records. install.sh and install.ps1 carry this file
(scripts/sigstoreLock.mjs copies it in) and run it with sigstore-python, installed with every
file's hash pinned, before they open the archive:

    python -I verify_release.py ARCHIVE BUNDLE [VERSION]

It prints the version the signature names and exits 0, or says why not and exits 1. VERSION,
when given, is the one asked for, and the signature must name it. Sigstore's trust root is
brought up to date where its update server answers, and is otherwise the one sigstore-python
carries (where that server cannot be reached, as in mainland China).
"""
import base64
import hashlib
import json
import logging
from pathlib import Path
from unittest.mock import patch
import re
import sys
import tempfile

SIGNER = "https://github.com/CoderBak/anagram/.github/workflows/release.yml@refs/tags/v"
ISSUER = "https://token.actions.githubusercontent.com"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def signers(bundle_json):
    """Every name the bundle's certificate is issued to (unverified: what to verify against)."""
    from cryptography import x509

    material = json.loads(bundle_json)["verificationMaterial"]
    raw = (material.get("certificate") or material["x509CertificateChain"]["certificates"][0])["rawBytes"]
    names = x509.load_der_x509_certificate(base64.b64decode(raw)).extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return [*names.get_values_for_type(x509.UniformResourceIdentifier), *names.get_values_for_type(x509.RFC822Name)]


def signed_version(bundle_json, signer=SIGNER, asked=None):
    """The version of the one release workflow run the certificate names, or None."""
    found = [name[len(signer):] for name in signers(bundle_json) if name.startswith(signer) and VERSION.fullmatch(name[len(signer):])]
    if len(found) != 1 or (asked is not None and found[0] != asked):
        return None
    return found[0]


def verify(archive, bundle_json, identity, issuer=ISSUER, offline=None):
    """Raise unless the bundle is a valid signature of `archive` by `identity`. `offline`: None
    tries Sigstore's update server first."""
    from sigstore._internal import tuf
    from sigstore.hashes import Hashed
    from sigstore.models import Bundle
    from sigstore.verify import Verifier, policy
    from sigstore_models.common.v1 import HashAlgorithm

    # The pinned Sigstore version chooses its TUF directories via platformdirs
    # and exposes no per-verification cache option. Redirect only that lookup.
    with tempfile.TemporaryDirectory(prefix="anagram-sigstore-") as folder:
        root = Path(folder)
        with patch.object(tuf, "_get_dirs", return_value=(root / "metadata", root / "targets")):
            if offline is None:
                try:
                    verifier = Verifier.production(offline=False)
                except Exception as error:  # unreachable, or refused: the trust root sigstore-python carries
                    print(f"Sigstore's update server did not answer ({type(error).__name__}); using the trust root this verifier carries.", file=sys.stderr)
                    verifier = Verifier.production(offline=True)
            else:
                verifier = Verifier.production(offline=offline)
    digest = hashlib.sha256()
    with open(archive, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    hashed = Hashed(algorithm=HashAlgorithm.SHA2_256, digest=digest.digest())
    verifier.verify_artifact(hashed, Bundle.from_json(bundle_json), policy.Identity(identity=identity, issuer=issuer))


def main(argv):
    if len(argv) not in (2, 3) or (len(argv) == 3 and not VERSION.fullmatch(argv[2])):
        print("usage: verify_release.py ARCHIVE BUNDLE [VERSION]", file=sys.stderr)
        return 2
    archive, bundle, asked = argv[0], argv[1], (argv[2] if len(argv) == 3 else None)
    # What the installer says is enough: not sigstore-python's notes on how it got its trust root.
    logging.getLogger("sigstore").setLevel(logging.ERROR)
    with open(bundle, "rb") as stream:
        bundle_json = stream.read()
    try:
        version = signed_version(bundle_json, asked=asked)
    except (ValueError, KeyError, TypeError) as error:
        print(f"The release's signature is not a Sigstore bundle ({error}).", file=sys.stderr)
        return 1
    if version is None:
        wanted = f"{SIGNER}{asked}" if asked else f"{SIGNER}<version>"
        print(f"The release's signature is not from Anagram's release workflow ({wanted}).", file=sys.stderr)
        return 1
    try:
        verify(archive, bundle_json, SIGNER + version)
    except Exception as error:
        print(f"The release's signature does not verify: {error}", file=sys.stderr)
        return 1
    print(version)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
# <<< installer/verify_release.py
SCRIPT
}
release_signature() { # archive bundle [version]: prints the version the signature names
  verifier="$TMP/verifier"
  sigstore_requirements > "$TMP/sigstore.txt"
  verify_release_script > "$TMP/verify_release.py"
  run_uv venv --quiet --python "$PYTHON_VERSION" "$verifier" || return 1
  if [ -z "$PYPI_INDEX" ] || ! run_uv pip install --quiet --python "$verifier/bin/python" --require-hashes --no-deps --no-build \
      --default-index "$PYPI_INDEX" -r "$TMP/sigstore.txt"; then
    [ -z "$PYPI_INDEX" ] || mirror_failed "$PYPI_INDEX"
    run_uv pip install --quiet --python "$verifier/bin/python" --require-hashes --no-deps --no-build -r "$TMP/sigstore.txt" || return 1
  fi
  clean_env "$verifier/bin/python" -I "$TMP/verify_release.py" "$@"
}

# ---------------------------------------------------------------- 3. release tarball
step 3 "$(tr_msg 'Downloading and verifying the Anagram release' '正在下载并校验 Anagram 安装包')"
curl -q --proto =https,file --proto-redir =https -fL --retry 3 -o "$TMP/anagram.tar.gz" "$RELEASE_URL/anagram.tar.gz"
curl -q --proto =https,file --proto-redir =https -fsSL --retry 3 -o "$TMP/anagram.tar.gz.sha256" "$RELEASE_URL/anagram.tar.gz.sha256"
expected="$(cut -c1-64 "$TMP/anagram.tar.gz.sha256")"
actual="$(sha256_of "$TMP/anagram.tar.gz")"
[ "$expected" = "$actual" ] || die "checksum mismatch for anagram.tar.gz (expected $expected, got $actual)"
SIGNED=""
case "$RELEASE_URL" in
  file://*) note "$(tr_msg 'A local release: checked by its checksum, not by a signature' '本地安装包：只校验校验和，不校验签名')" ;;
  *)
    curl -q --proto =https --proto-redir =https -fsSL --retry 3 -o "$TMP/anagram.tar.gz.sigstore.json" "$RELEASE_URL/anagram.tar.gz.sigstore.json" \
      || die "the release carries no signature (anagram.tar.gz.sigstore.json)"
    ASKED=""
    case "$RELEASE_URL" in */download/v*) ASKED="${RELEASE_URL##*/download/v}" ;; esac
    SIGNED="$(release_signature "$TMP/anagram.tar.gz" "$TMP/anagram.tar.gz.sigstore.json" $ASKED)" \
      || die "the release is not signed by Anagram's release workflow; it was not installed"
    note "$(tr_msg "signed by Anagram's release workflow for version" '已由 Anagram 发布流程签名，版本') $SIGNED" ;;
esac
# Extraction is confined to the release root; archive links are not needed here.
tar -tzf "$TMP/anagram.tar.gz" > "$TMP/members"
while IFS= read -r member; do
  case "$member" in anagram|anagram/) ;; anagram/*) ;; *) die "unexpected archive path" ;; esac
  case "/$member/" in */../*|*/./*) die "unsafe archive path" ;; esac
done < "$TMP/members"
tar -tvzf "$TMP/anagram.tar.gz" > "$TMP/member-types"
LC_ALL=C awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" {bad=1} END {exit bad}' "$TMP/member-types" \
  || die "only regular files and directories are permitted in the release archive"
mkdir -p "$TMP/x" && tar -xzf "$TMP/anagram.tar.gz" -C "$TMP/x"
REL="$TMP/x/anagram"
[ -f "$REL/VERSION" ] && [ -d "$REL/app" ] && [ -d "$REL/extension" ] && [ -f "$REL/bin/anagram" ] || die "unexpected release layout"
VERSION="$(cat "$REL/VERSION")"
[ -z "$SIGNED" ] || [ "$VERSION" = "$SIGNED" ] || die "the release says it is $VERSION, but its signature is for $SIGNED"
# A release asked for by its version (the extension's own, from Settings) must be that
# version: a release that says otherwise is not the one its address names.
case "$RELEASE_URL" in
  */download/v*) [ "$VERSION" = "${RELEASE_URL##*/download/v}" ] || die "the release says it is $VERSION, not ${RELEASE_URL##*/download/v} as asked" ;;
esac
note "version $VERSION"
# Build in a private directory on the component filesystem. Existing installed
# code stays in place until release verification and dependency setup succeed.
cp -R "$REL/app" "$BUILD/app"
if [ "$BROWSER" = firefox ] && [ -d "$REL/extension-firefox" ]; then
  cp -R "$REL/extension-firefox" "$BUILD/extension"
else
  cp -R "$REL/extension" "$BUILD/extension"
fi
cp "$REL/install.sh" "$BUILD/app/install.sh" 2>/dev/null || true
install_ours "$REL/app/native_registration.py" "$LOCK/helper.py"
printf '%s\n' "$(sha256_of "$REL/app/native_registration.py")" > "$TMP/helper.sha"
install_ours "$TMP/helper.sha" "$LOCK/helper.sha"
if [ -n "$RECORD_PYTHON" ] && [ -d "$PYTHON_STORE" ]; then
  # uv's virtual environment needs the managed interpreter's final path.
  # Record it before publishing it, so a failed dependency install can undo
  # the move without removing anything subsequently added by the user.
  interpreter=""
  for candidate in "$PYTHON_STORE"/*/bin/python3; do
    [ ! -x "$candidate" ] || { interpreter="$candidate"; break; }
  done
  [ -n "$interpreter" ] || die "staged managed Python is missing"
  clean_env "$interpreter" -I "$REL/app/native_registration.py" stage-files \
    --home "$ANAGRAM_HOME" --tree python "$PYTHON_STORE" --output "$LOCK/proposed-files.json"
  record_plan "$interpreter"
  ROLLBACK_PY="$interpreter"
  [ ! -e "$STAGE/python" ] && [ ! -L "$STAGE/python" ] || die "files appeared in installer staging"
  mv "$PYTHON_STORE" "$STAGE/python"
  : > "$LOCK/swapping"
  if [ -e "$ANAGRAM_HOME/python" ]; then
    [ ! -L "$ANAGRAM_HOME/python" ] && [ -d "$ANAGRAM_HOME/python" ] &&
      [ ! -e "$ANAGRAM_HOME/python.old" ] && [ ! -L "$ANAGRAM_HOME/python.old" ] || die "unexpected Python installation directory"
    : > "$LOCK/python-backup"
    mv "$ANAGRAM_HOME/python" "$ANAGRAM_HOME/python.old"
    BACKED_DIRS="python"
  else
    printf '%s\n' python >> "$LOCK/promoting"
  fi
  SWAPPED="python"
  mv "$STAGE/python" "$ANAGRAM_HOME/python"
  ROLLBACK_PY="$ANAGRAM_HOME/python/${interpreter#"$PYTHON_STORE"/}"
  PYTHON_STORE="$ANAGRAM_HOME/python"
fi

UV_CACHE="$TMP/dependency-cache"
step 4 "$(tr_msg 'Installing locked runtime packages' '正在安装版本锁定的运行依赖')"
note "$(tr_msg "Downloading and installing ONNX Runtime and other dependencies; progress appears below." "正在下载并安装 ${RUNTIMES:+${RUNTIMES}、}ONNX Runtime 等依赖；具体进度显示在下方。")"
note "$(tr_msg 'Device-selected model weights will download here after registration.' '注册完成后，将在此下载适合本机设备的模型权重。')"
# --no-build everywhere: every locked package resolves to a wheel on each supported
# platform, so no toolchain is ever required to complete an installation.
# uv sync --frozen fetches the lock's own files.pythonhosted.org addresses whatever index is
# set, so from a mirror the lock is exported with its hashes and every one is required.
from_index() {
  ( cd "$BUILD/app" && run_uv export --frozen --no-dev --no-emit-project --no-header \
      --format requirements-txt --quiet --output-file "$TMP/requirements.txt" ) \
    && run_uv venv --quiet --python "$PYTHON_VERSION" "$BUILD/venv" \
    && run_uv pip sync --python "$BUILD/venv/bin/python" --require-hashes --no-build \
      --default-index "$PYPI_INDEX" "$TMP/requirements.txt"
}
if [ -z "$PYPI_INDEX" ] || ! { note "$(tr_msg 'from your package index,' '来自你配置的软件包镜像') $(url_host "$PYPI_INDEX")"; from_index; }; then
  if [ -n "$PYPI_INDEX" ]; then
    mirror_failed "$PYPI_INDEX"
    if [ -e "$BUILD/venv" ]; then
      mkdir "$TMP/failed-mirror"
      directory_identity "$TMP/failed-mirror" > "$LOCK/failed-mirror.identity"
      mv "$BUILD/venv" "$TMP/failed-mirror/venv"
    fi
  fi
  ( cd "$BUILD/app" && run_uv sync --frozen --no-dev --no-build --python "$PYTHON_VERSION" )
fi
[ -x "$BUILD/venv/bin/python" ] || die "staged virtual environment was not created"
if [ -f "$ANAGRAM_HOME/app/.anagram-installed-files.json" ]; then
  clean_env "$BUILD/venv/bin/python" -I "$REL/app/native_registration.py" check-update --home "$ANAGRAM_HOME"
fi
set -- stage-files --home "$ANAGRAM_HOME" --tree app "$BUILD/app" --tree extension "$BUILD/extension" --tree venv "$BUILD/venv" \
  --file bin/anagram "$REL/bin/anagram" --file VERSION "$REL/VERSION" --output "$TMP/proposed-files.json"
[ ! -f "$LOCK/proposed-files.json" ] || set -- "$@" --include-files "$LOCK/proposed-files.json"
[ -z "$RECORD_UV" ] || set -- "$@" --file bin/uv "$UV_BIN"
clean_env "$BUILD/venv/bin/python" -I "$REL/app/native_registration.py" "$@"
install_ours "$TMP/proposed-files.json" "$LOCK/proposed-files.json"
printf '%s\n' "$(sha256_of "$BUILD/venv/bin/python")" > "$LOCK/scratch-python.sha"
record_plan "$BUILD/venv/bin/python"
scratch_records "$BUILD/venv/bin/python" record "$TMP" x verifier bootstrap-cache verifier-cache dependency-cache xdg python-bin tools \
  "uv-$UV_TARGET" uv.tar.gz anagram.tar.gz anagram.tar.gz.sha256 anagram.tar.gz.sigstore.json verify_release.py sigstore.txt members member-types requirements.txt \
  helper.sha receipt.sha python.sha proposed-files.json
ROLLBACK_PY="$BUILD/venv/bin/python"
for sub in app extension venv; do
  [ ! -e "$STAGE/$sub" ] && [ ! -L "$STAGE/$sub" ] || die "files appeared in installer staging"
  mv "$BUILD/$sub" "$STAGE/$sub"
done
ROLLBACK_PY="$STAGE/venv/bin/python"
# Python discovers its venv relative to the executable. The component invokes this
# interpreter directly, never the generated console scripts with staging shebangs.
: > "$LOCK/swapping"
for sub in bin models run cache hf; do
  [ ! -L "$ANAGRAM_HOME/$sub" ] || die "installation directory became a symbolic link: $sub"
  if [ ! -d "$ANAGRAM_HOME/$sub" ]; then
    mkdir "$ANAGRAM_HOME/$sub"; CREATED_DIRS="$sub $CREATED_DIRS"; printf '%s\n' "$sub" >> "$LOCK/created-dirs"
  fi
done
for sub in app extension venv; do
  if [ -e "$ANAGRAM_HOME/$sub" ]; then
    [ ! -L "$ANAGRAM_HOME/$sub" ] && [ -d "$ANAGRAM_HOME/$sub" ] || die "unexpected file at $ANAGRAM_HOME/$sub"
    [ ! -e "$ANAGRAM_HOME/$sub.old" ] && [ ! -L "$ANAGRAM_HOME/$sub.old" ] || die "unexpected backup at $ANAGRAM_HOME/$sub.old"
    mv "$ANAGRAM_HOME/$sub" "$ANAGRAM_HOME/$sub.old"
    BACKED_DIRS="$sub $BACKED_DIRS"
  else
    printf '%s\n' "$sub" >> "$LOCK/promoting"
  fi
  SWAPPED="$sub $SWAPPED"
  mv "$STAGE/$sub" "$ANAGRAM_HOME/$sub"
done
PY="$ANAGRAM_HOME/venv/bin/python"
ROLLBACK_PY="$PY"
[ -x "$PY" ] || die "virtual environment was not created"
backup_file() {
  if [ -f "$ANAGRAM_HOME/$1" ]; then install_ours "$ANAGRAM_HOME/$1" "$LOCK/$2"
  else printf '%s\n' "$1" >> "$LOCK/promoting"; fi
}
backup_file bin/anagram command.backup
backup_file VERSION version.backup
install_ours "$REL/bin/anagram" "$ANAGRAM_HOME/bin/anagram" 755
COMMAND_WRITTEN=1
install_ours "$REL/VERSION" "$ANAGRAM_HOME/VERSION"
VERSION_WRITTEN=1
if [ -n "$RECORD_UV" ]; then
  backup_file bin/uv uv.backup
  install_ours "$UV_BIN" "$ANAGRAM_HOME/bin/uv" 755
  UV_WRITTEN=1
fi
# The download cache only serves re-syncs; an update re-fetches anyway. Keep the footprint small.
step 5 "$(tr_msg 'Cleaning temporary package downloads' '正在清理依赖下载缓存')"
scratch_records "$PY" prune "$TMP" bootstrap-cache verifier-cache dependency-cache


# ---------------------------------------------------------------- 4. exact user-level native host registration
step 6 "$(tr_msg 'Preparing the local component connection' '正在准备本地组件连接')"
transaction="${STAGE##*/}"
printf '%s\n' "$transaction" "$BROWSER" "$EXTENSION_ID" "$INSTALL_LANG" "$(sha256_of "$REL/app/native_registration.py")" \
  "$(sha256_of "$PY")" "$(sha256_of "$LOCK/proposed-files.json")" > "$TMP/registering"
scratch_records "$PY" record "$TMP" registering
install_ours "$TMP/registering" "$LOCK/registering"
if ! clean_env "$PY" -I "$REL/app/native_registration.py" register --installed-files --transaction "$transaction" \
    --staged-files "$LOCK/proposed-files.json" --home "$ANAGRAM_HOME" --browser "$BROWSER" --extension-id "$EXTENSION_ID" --language "$INSTALL_LANG"; then
  if clean_env "$PY" -I "$REL/app/native_registration.py" registration-pending --home "$ANAGRAM_HOME" --transaction "$transaction"; then
    die "browser registration needs recovery"
  else
    query_status=$?
    [ "$query_status" -eq 1 ] || die "browser registration state could not be verified"
  fi
  rm -f "$LOCK/registering"
  die "could not register the local engine"
fi
INSTALL_COMPLETE=1
python_backup=""
[ ! -f "$LOCK/python-backup" ] || python_backup=--python-backup
clean_env "$PY" -I "$REL/app/native_registration.py" finish-update $python_backup --home "$ANAGRAM_HOME" --backups "$INSTALL_LOCK" ||
  die "Installed the component but could not finish cleanup"
rm -f "$LOCK/swapping" "$LOCK/promoting" "$LOCK/registering"

# The runtime is committed: a network failure must not roll it back or force
# another dependency installation. Retain the installer lock during preparation.
step 7 "$(tr_msg 'Preparing model files with Hugging Face' '正在使用 Hugging Face 准备模型文件')"
clean_env PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 "$PY" -I "$ANAGRAM_HOME/app/prepare_models.py" \
  --home "$ANAGRAM_HOME" --installer --language "$INSTALL_LANG" --detector-manifest "${ANAGRAM_DETECTOR_MANIFEST:-}" || {
    status=$?
    note "$(tr_msg 'The local engine is installed. Return to Anagram setup to retry the model download.' '本地引擎已安装。请返回 Anagram 设置页面重试模型下载。')" >&2
    exit "$status"
  }

# Installation complete.
say "$(tr_msg 'Installed Anagram local component' 'Anagram 本地组件安装完成') $VERSION: $ANAGRAM_HOME"
note "$(tr_msg 'Return to Anagram setup in your browser to see the engine status.' '请返回浏览器中的 Anagram 设置页面查看引擎状态。')"
note "$(tr_msg 'The browser manages the component; no login startup, system Python, or PATH changes were installed.' '本地组件由浏览器管理，未添加开机自启，也未修改系统 Python 或 PATH。')"
