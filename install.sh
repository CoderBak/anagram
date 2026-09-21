#!/bin/sh
# Anagram native component installer — private runtime plus exact user-level browser registration.
#
# Use the browser-specific installation command shown by Anagram setup.
#
# What it does (no sudo, no shell-profile edits, no system Python, no Homebrew):
#   $ANAGRAM_HOME (default ~/.anagram)
#     .anagram-home   the marker: every destructive step below requires it
#     bin/anagram     the command: start · stop · status · logs · update · uninstall
#     bin/uv          uv 0.11.18, a static binary from its GitHub release, checksum-verified
#     python/         a uv-managed CPython (pinned), private to Anagram
#     venv/           the daemon's packages from the committed uv.lock (hash-verified)
#     app/            the scoring daemon (anagramd) at the installed release
#     extension/      the built extension, ready for Chrome's "Load unpacked"
#     models/         models are downloaded later from the extension, with pinned checksums
#     hf/ cache/ logs/ run/   Hugging Face cache, uv cache, daemon logs, pid file
#
# Safety rules, in order of appearance:
#   - the target must be an absolute, plain directory (no symlink, no "..", not / or $HOME)
#   - an existing non-empty target must carry the marker, or it is refused untouched
#   - all of that is checked BEFORE anything is downloaded
#   - only exact owned native-host registrations are written outside the folder
#   - existing app/, extension/ and the
#     checkpoint are replaced by a staged swap, never by a bare rm -rf on a shared name
#   - a download is verified where it lands, beside the file it will replace, and only a file
#     that matches its pinned checksum is ever renamed into place
#   - every file that replaces one already in the folder is written beside it and renamed
#     over it: `anagram update` runs this script, and the command, the uv binary or the
#     model may be in use while they are replaced
#   - every child process (uv, python) runs with a scrubbed environment: inherited
#     UV_*, PYTHON*, XDG_*, CARGO_* and friends cannot redirect writes or imports
#
# Options (environment):
#   ANAGRAM_HOME=…          install somewhere else (default ~/.anagram)
#   ANAGRAM_RELEASE_URL=…   where the release assets live (default: the latest GitHub release)
#   ANAGRAM_BROWSER=chrome|firefox  register this browser only
#   ANAGRAM_EXTENSION_ID=…  exact Chrome ID (32 a-p) or anagram@coderbak.dev for Firefox
#   ANAGRAM_LANG=en|zh_CN   installation progress language
#   ANAGRAM_DOWNLOAD_MODELS=1  optional terminal download; default is browser-managed setup
#   ANAGRAM_SKIP_MODEL=1    compatibility override: always defer models to the browser
#
# Re-running updates in place. Uninstall removes the folder and exact owned native registrations.
set -eu

INSTALLER_VERSION="0.4.0"
UV_VERSION="0.11.18"
PYTHON_VERSION="${ANAGRAM_PYTHON:-3.12.13}"
RELEASE_URL="${ANAGRAM_RELEASE_URL:-https://github.com/CoderBak/anagram/releases/latest/download}"
WEIGHTS_SHA256="869f33df7928c447bbd150d3b5192b4ea90b1cbd2ee4aad97f5d51d59dfc8cfb"
LID_URL="https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
LID_SHA256="8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83"
MARKER=".anagram-home"
BROWSER="${ANAGRAM_BROWSER:-}"
EXTENSION_ID="${ANAGRAM_EXTENSION_ID:-}"
INSTALL_LANG="${ANAGRAM_LANG:-en}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
tr_msg() { if [ "$INSTALL_LANG" = zh_CN ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

# ---------------------------------------------------------------- 0. environment + target
[ "$(id -u)" -eq 0 ] && [ -z "${ANAGRAM_ALLOW_ROOT:-}" ] && die "do not run as root — Anagram installs into your home folder only"
need curl; need tar; need mktemp
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else die "sha256sum or shasum is required"; fi
sha256_of() { $SHA "$1" | cut -c1-64; }
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
[ -L "$ANAGRAM_HOME" ] && die "'$ANAGRAM_HOME' is a symbolic link — Anagram only installs into a real directory it owns (remove the link or set ANAGRAM_HOME elsewhere)"
if [ -e "$ANAGRAM_HOME" ]; then
  [ -d "$ANAGRAM_HOME" ] || die "'$ANAGRAM_HOME' exists and is not a directory"
  if [ ! -f "$ANAGRAM_HOME/$MARKER" ] && [ -n "$(ls -A "$ANAGRAM_HOME" 2>/dev/null)" ]; then
    die "'$ANAGRAM_HOME' exists, is not empty, and is not an Anagram folder (no $MARKER) — refusing to touch it. Move it aside or set ANAGRAM_HOME to a new folder."
  fi
fi
# Inside the validated folder, the paths we replace or write must be plain directories too.
for sub in app extension bin models venv python hf cache logs run tools; do
  [ -L "$ANAGRAM_HOME/$sub" ] && die "'$ANAGRAM_HOME/$sub' is a symbolic link — refusing to write through it"
done
for sub in app.old extension.old venv.old venv.next; do
  [ ! -e "$ANAGRAM_HOME/$sub" ] && [ ! -L "$ANAGRAM_HOME/$sub" ] || die "unfinished or unsafe staging path: $ANAGRAM_HOME/$sub"
done
case "$INSTALL_LANG" in en|zh_CN) ;; *) die "ANAGRAM_LANG must be en or zh_CN / 语言须为 en 或 zh_CN" ;; esac
case "$BROWSER" in
  chrome) [ "${#EXTENSION_ID}" -eq 32 ] || die "Chrome extension ID must contain 32 a-p characters / Chrome 扩展 ID 必须为 32 位 a-p 字符"
          case "$EXTENSION_ID" in *[!a-p]*) die "invalid Chrome extension ID / Chrome 扩展 ID 无效" ;; esac ;;
  firefox) [ "$EXTENSION_ID" = anagram@coderbak.dev ] || die "Firefox extension ID must be anagram@coderbak.dev" ;;
  *) die "Use the installation command from Anagram setup (ANAGRAM_BROWSER=chrome|firefox and exact extension ID) / 请使用扩展设置页中的安装命令" ;;
esac

mkdir -p "$ANAGRAM_HOME/bin" "$ANAGRAM_HOME/models" "$ANAGRAM_HOME/logs" "$ANAGRAM_HOME/run" "$ANAGRAM_HOME/cache" "$ANAGRAM_HOME/hf"
[ -f "$ANAGRAM_HOME/$MARKER" ] || printf 'Anagram installation folder. Safe to delete with: bin/anagram uninstall\n' > "$ANAGRAM_HOME/$MARKER"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/anagram-install.XXXXXX")"
SWAPPED=""
INSTALL_COMPLETE=0
COMMAND_WRITTEN=0
VERSION_WRITTEN=0
cleanup() {
  if [ "$INSTALL_COMPLETE" -eq 0 ]; then
    for sub in $SWAPPED; do
      [ -L "$ANAGRAM_HOME/$sub" ] && continue
      rm -rf "$ANAGRAM_HOME/$sub"
      [ ! -d "$ANAGRAM_HOME/$sub.old" ] || mv "$ANAGRAM_HOME/$sub.old" "$ANAGRAM_HOME/$sub"
    done
    if [ -f "$TMP/command.backup" ]; then cp "$TMP/command.backup" "$ANAGRAM_HOME/bin/anagram.new"; chmod 755 "$ANAGRAM_HOME/bin/anagram.new"; mv "$ANAGRAM_HOME/bin/anagram.new" "$ANAGRAM_HOME/bin/anagram";
    elif [ "$COMMAND_WRITTEN" -eq 1 ]; then rm -f "$ANAGRAM_HOME/bin/anagram"; fi
    if [ -f "$TMP/version.backup" ]; then cp "$TMP/version.backup" "$ANAGRAM_HOME/VERSION";
    elif [ "$VERSION_WRITTEN" -eq 1 ]; then rm -f "$ANAGRAM_HOME/VERSION"; fi
    [ -L "$ANAGRAM_HOME/venv.next" ] || rm -rf "$ANAGRAM_HOME/venv.next"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Remove something that must be INSIDE the validated folder and must not be a symlink.
remove_ours() {
  case "$1" in "$ANAGRAM_HOME"/*) ;; *) die "internal error: refusing to remove '$1' (outside $ANAGRAM_HOME)";; esac
  [ -L "$1" ] && die "internal error: refusing to remove symlink '$1'"
  rm -rf "$1"
}

# Put a file in its place INSIDE the validated folder: write it beside its name and rename
# it over the old one. `anagram update` runs this installer, so what is being replaced may be
# the very script that is executing (bin/anagram), a binary a running process holds open
# (bin/uv) or a file the CLI is reading (VERSION, the model). Copying onto the original
# truncates it under its reader; a rename swaps the name in one step and leaves whoever has
# the old file open reading it to the end. The temporary sits in the destination's own
# folder, so the rename never crosses a filesystem — and never goes through a symlink.
install_ours() { # src dest [mode]
  case "$2" in "$ANAGRAM_HOME"/*) ;; *) die "internal error: refusing to write '$2' (outside $ANAGRAM_HOME)";; esac
  [ -L "$2" ] && die "internal error: refusing to write through symlink '$2'"
  [ -L "$2.new" ] && die "internal error: refusing to write through symlink '$2.new'"
  rm -f "$2.new"
  cp "$1" "$2.new"
  if [ -n "${3:-}" ]; then chmod "$3" "$2.new"; fi
  mv "$2.new" "$2"
}

# A scrubbed environment for child processes: only what they need, nothing inherited.
# Proxies and CA settings pass through so corporate networks keep working.
clean_env() {
  env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$TMP" LANG="${LANG:-C.UTF-8}" \
    ${http_proxy:+http_proxy="$http_proxy"} ${https_proxy:+https_proxy="$https_proxy"} ${no_proxy:+no_proxy="$no_proxy"} \
    ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} ${NO_PROXY:+NO_PROXY="$NO_PROXY"} \
    ${SSL_CERT_FILE:+SSL_CERT_FILE="$SSL_CERT_FILE"} ${SSL_CERT_DIR:+SSL_CERT_DIR="$SSL_CERT_DIR"} \
    ${REQUESTS_CA_BUNDLE:+REQUESTS_CA_BUNDLE="$REQUESTS_CA_BUNDLE"} ${CURL_CA_BUNDLE:+CURL_CA_BUNDLE="$CURL_CA_BUNDLE"} \
    "$@"
}
run_uv() {
  clean_env UV_CACHE_DIR="$ANAGRAM_HOME/cache" UV_PYTHON_INSTALL_DIR="$ANAGRAM_HOME/python" \
    UV_PYTHON_BIN_DIR="$ANAGRAM_HOME/python/bin" UV_TOOL_DIR="$ANAGRAM_HOME/tools" UV_TOOL_BIN_DIR="$ANAGRAM_HOME/tools/bin" \
    UV_PROJECT_ENVIRONMENT="$ANAGRAM_HOME/venv.next" UV_PYTHON_PREFERENCE=only-managed UV_NO_CONFIG=1 UV_NO_MODIFY_PATH=1 \
    UV_NO_PROGRESS=1 XDG_DATA_HOME="$ANAGRAM_HOME/cache/xdg" XDG_CACHE_HOME="$ANAGRAM_HOME/cache/xdg" XDG_CONFIG_HOME="$ANAGRAM_HOME/cache/xdg" \
    "$ANAGRAM_HOME/bin/uv" "$@"
}

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64)
    MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
    [ "$MACOS_MAJOR" -ge 14 ] || die "the locked PyTorch and ONNX Runtime packages require macOS 14 or newer"
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
esac

# ---------------------------------------------------------------- 1. release tarball
say "$(tr_msg 'Downloading the Anagram release' '正在下载 Anagram 安装包')"
curl -fsSL --retry 3 -o "$TMP/anagram.tar.gz" "$RELEASE_URL/anagram.tar.gz"
curl -fsSL --retry 3 -o "$TMP/anagram.tar.gz.sha256" "$RELEASE_URL/anagram.tar.gz.sha256"
expected="$(cut -c1-64 "$TMP/anagram.tar.gz.sha256")"
actual="$(sha256_of "$TMP/anagram.tar.gz")"
[ "$expected" = "$actual" ] || die "checksum mismatch for anagram.tar.gz (expected $expected, got $actual)"
# Extraction is confined to the release root; archive links are not needed here.
tar -tzf "$TMP/anagram.tar.gz" > "$TMP/members"
while IFS= read -r member; do
  case "$member" in anagram|anagram/) ;; anagram/*) ;; *) die "unexpected archive path" ;; esac
  case "/$member/" in */../*|*/./*) die "unsafe archive path" ;; esac
done < "$TMP/members"
tar -tvzf "$TMP/anagram.tar.gz" | awk 'substr($1,1,1) == "l" || substr($1,1,1) == "h" {bad=1} END {exit bad}' \
  || die "links are not permitted in the release archive"
mkdir -p "$TMP/x" && tar -xzf "$TMP/anagram.tar.gz" -C "$TMP/x"
REL="$TMP/x/anagram"
[ -f "$REL/VERSION" ] && [ -d "$REL/app" ] && [ -d "$REL/extension" ] && [ -f "$REL/bin/anagram" ] || die "unexpected release layout"
VERSION="$(cat "$REL/VERSION")"
note "version $VERSION"
# Staged swap: the new trees are placed beside the old ones, then renamed into place.
STAGE="$ANAGRAM_HOME/.staging.$$"
remove_ours "$STAGE"; mkdir -p "$STAGE"
cp -R "$REL/app" "$STAGE/app"
if [ "$BROWSER" = firefox ] && [ -d "$REL/extension-firefox" ]; then
  cp -R "$REL/extension-firefox" "$STAGE/extension"
else
  cp -R "$REL/extension" "$STAGE/extension"
fi
cp "$REL/install.sh" "$STAGE/app/install.sh" 2>/dev/null || true
for sub in app extension; do
  [ ! -e "$ANAGRAM_HOME/$sub.old" ] || die "unfinished previous update at $ANAGRAM_HOME/$sub.old — restore it before retrying"
  if [ -e "$ANAGRAM_HOME/$sub" ]; then mv "$ANAGRAM_HOME/$sub" "$ANAGRAM_HOME/$sub.old"; fi
  SWAPPED="$sub $SWAPPED"
  mv "$STAGE/$sub" "$ANAGRAM_HOME/$sub"
done
remove_ours "$STAGE"
[ ! -f "$ANAGRAM_HOME/bin/anagram" ] || cp "$ANAGRAM_HOME/bin/anagram" "$TMP/command.backup"
[ ! -f "$ANAGRAM_HOME/VERSION" ] || cp "$ANAGRAM_HOME/VERSION" "$TMP/version.backup"
install_ours "$REL/bin/anagram" "$ANAGRAM_HOME/bin/anagram" 755
COMMAND_WRITTEN=1
printf '%s\n' "$VERSION" > "$TMP/VERSION"
install_ours "$TMP/VERSION" "$ANAGRAM_HOME/VERSION"
VERSION_WRITTEN=1

# ---------------------------------------------------------------- 2. uv (pinned release binary, checksum-verified)
if [ ! -x "$ANAGRAM_HOME/bin/uv" ] || [ "$(clean_env "$ANAGRAM_HOME/bin/uv" --version 2>/dev/null | cut -d' ' -f2)" != "$UV_VERSION" ]; then
  say "Fetching uv $UV_VERSION into $ANAGRAM_HOME/bin (a static binary; no PATH or profile changes)"
  curl -fsSL --retry 3 -o "$TMP/uv.tar.gz" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TARGET.tar.gz"
  [ "$(sha256_of "$TMP/uv.tar.gz")" = "$UV_SHA" ] || die "checksum mismatch for uv-$UV_TARGET.tar.gz"
  tar -xzf "$TMP/uv.tar.gz" -C "$TMP" "uv-$UV_TARGET/uv"
  install_ours "$TMP/uv-$UV_TARGET/uv" "$ANAGRAM_HOME/bin/uv" 755
fi

# ---------------------------------------------------------------- 3. private Python + locked packages
say "$(tr_msg 'Installing private Python' '正在安装独立 Python') $PYTHON_VERSION"
run_uv python install "$PYTHON_VERSION" --quiet
say "$(tr_msg 'Installing locked runtime packages' '正在安装版本锁定的运行依赖')"
( cd "$ANAGRAM_HOME/app" && run_uv sync --frozen --no-dev --python "$PYTHON_VERSION" --quiet )
[ -x "$ANAGRAM_HOME/venv.next/bin/python" ] || die "staged virtual environment was not created"
# Python discovers its venv relative to the executable. The component invokes this
# interpreter directly, never the generated console scripts with staging shebangs.
if [ -d "$ANAGRAM_HOME/venv" ]; then mv "$ANAGRAM_HOME/venv" "$ANAGRAM_HOME/venv.old"; fi
SWAPPED="venv $SWAPPED"
mv "$ANAGRAM_HOME/venv.next" "$ANAGRAM_HOME/venv"
PY="$ANAGRAM_HOME/venv/bin/python"
[ -x "$PY" ] || die "virtual environment was not created"
# The download cache only serves re-syncs; an update re-fetches anyway. Keep the footprint small.
run_uv cache clean --quiet 2>/dev/null || remove_ours "$ANAGRAM_HOME/cache"
mkdir -p "$ANAGRAM_HOME/cache"

# ---------------------------------------------------------------- 4. exact user-level native host registration
say "$(tr_msg 'Registering the local component for this extension only' '正在为当前扩展注册本地组件')"
clean_env PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 "$PY" "$ANAGRAM_HOME/app/native_registration.py" register \
  --home "$ANAGRAM_HOME" --browser "$BROWSER" --extension-id "$EXTENSION_ID" --language "$INSTALL_LANG"
INSTALL_COMPLETE=1
for sub in $SWAPPED; do remove_ours "$ANAGRAM_HOME/$sub.old"; done

# ---------------------------------------------------------------- 5. optional terminal model download (browser manages it by default)
MODEL_DIR="$ANAGRAM_HOME/models/editlens_roberta-large"
if [ "${ANAGRAM_DOWNLOAD_MODELS:-}" = 1 ] && [ -z "${ANAGRAM_SKIP_MODEL:-}" ]; then
  note "EditLens by Pangram and the EditLens authors: CC BY-NC-SA 4.0, noncommercial use only."
  note "Downloading the public modelkit (4.07 GB total); LICENSE and NOTICE are included."
  clean_env HF_HOME="$ANAGRAM_HOME/hf" HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 \
    PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 "$PY" "$ANAGRAM_HOME/app/download_modelkit.py" --model-dir "$MODEL_DIR"
  if [ ! -f "$ANAGRAM_HOME/models/lid.176.ftz" ] || [ "$(sha256_of "$ANAGRAM_HOME/models/lid.176.ftz")" != "$LID_SHA256" ]; then
    say "Downloading the fastText language model (1 MB)"
    curl -fsSL --retry 3 -o "$TMP/lid.176.ftz" "$LID_URL"
    [ "$(sha256_of "$TMP/lid.176.ftz")" = "$LID_SHA256" ] || die "checksum mismatch for lid.176.ftz"
    install_ours "$TMP/lid.176.ftz" "$ANAGRAM_HOME/models/lid.176.ftz"
  fi
fi

# ---------------------------------------------------------------- 6. config + done
[ -f "$ANAGRAM_HOME/config" ] || printf 'PORT=8765\n' > "$ANAGRAM_HOME/config"
say "$(tr_msg 'Installed Anagram local component' 'Anagram 本地组件安装完成') $VERSION: $ANAGRAM_HOME"
note "$(tr_msg 'Return to the extension and reconnect. Downloads, comparison, and model selection continue there.' '请返回扩展并重新连接，在扩展中继续下载模型、性能测试和选择配置。')"
note "$(tr_msg 'EditLens models: CC BY-NC-SA 4.0, noncommercial use. The first model download is 4.07 GB plus temporary space.' 'EditLens 模型采用 CC BY-NC-SA 4.0 许可，仅限非商业用途。首次模型下载约 4.07 GB，另需临时空间。')"
note "$(tr_msg 'No HTTP server, login startup, system Python, or PATH changes were installed.' '未自动启动 HTTP 服务，未添加开机自启，也未修改系统 Python 或 PATH。')"
