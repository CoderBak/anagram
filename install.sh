#!/bin/sh
# Anagram installer — everything lives in ONE folder, nothing else on the machine changes.
#
#   curl -fsSL https://github.com/CoderBak/anagram/releases/latest/download/install.sh | sh
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
#     models/         the EditLens checkpoint + the fastText language model (both checksum-verified)
#     hf/ cache/ logs/ run/   Hugging Face cache, uv cache, daemon logs, pid file
#
# Safety rules, in order of appearance:
#   - the target must be an absolute, plain directory (no symlink, no "..", not / or $HOME)
#   - an existing non-empty target must carry the marker, or it is refused untouched
#   - all of that is checked BEFORE anything is downloaded
#   - nothing is ever removed outside the validated folder; existing app/, extension/ and the
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
#   ANAGRAM_HF_TOKEN=…      Hugging Face token for the gated checkpoint (else the built-in one)
#   ANAGRAM_SKIP_MODEL=1    do not download the checkpoint now (anagram model does it later)
#
# Re-running updates in place. `anagram uninstall` removes the folder — that is all there is.
set -eu

INSTALLER_VERSION="0.3.2"
UV_VERSION="0.11.18"
PYTHON_VERSION="${ANAGRAM_PYTHON:-3.12.13}"
RELEASE_URL="${ANAGRAM_RELEASE_URL:-https://github.com/CoderBak/anagram/releases/latest/download}"
HF_REPO="pangram/editlens_roberta-large"
HF_REVISION="f93e1ace74528cfb48f337ab2fe946fb71a728cb"
WEIGHTS_SHA256="869f33df7928c447bbd150d3b5192b4ea90b1cbd2ee4aad97f5d51d59dfc8cfb"
LID_URL="https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
LID_SHA256="8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83"
MARKER=".anagram-home"
# Filled in at release time from a repository secret; never committed.
DEFAULT_HF_TOKEN="__ANAGRAM_HF_TOKEN__"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
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

mkdir -p "$ANAGRAM_HOME/bin" "$ANAGRAM_HOME/models" "$ANAGRAM_HOME/logs" "$ANAGRAM_HOME/run" "$ANAGRAM_HOME/cache" "$ANAGRAM_HOME/hf"
[ -f "$ANAGRAM_HOME/$MARKER" ] || printf 'Anagram installation folder. Safe to delete with: bin/anagram uninstall\n' > "$ANAGRAM_HOME/$MARKER"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/anagram-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

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
    UV_PROJECT_ENVIRONMENT="$ANAGRAM_HOME/venv" UV_PYTHON_PREFERENCE=only-managed UV_NO_CONFIG=1 UV_NO_MODIFY_PATH=1 \
    UV_NO_PROGRESS=1 XDG_DATA_HOME="$ANAGRAM_HOME/cache/xdg" XDG_CACHE_HOME="$ANAGRAM_HOME/cache/xdg" XDG_CONFIG_HOME="$ANAGRAM_HOME/cache/xdg" \
    "$ANAGRAM_HOME/bin/uv" "$@"
}

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64)   UV_TARGET="aarch64-apple-darwin";   UV_SHA="1a7adf8dadae3b55853115d13a8bf564d219597ad13824b93b213706933863e5" ;;
  Darwin/x86_64)  UV_TARGET="x86_64-apple-darwin";    UV_SHA="00a61e3db99b53c927a7e6c4ccdccb898aa3253d07928822211e9dc570a25661" ;;
  Linux/x86_64|Linux/aarch64)
    if ldd --version 2>&1 | grep -qi musl || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then LIBC=musl; else LIBC=gnu; fi
    case "$ARCH/$LIBC" in
      x86_64/gnu)   UV_TARGET="x86_64-unknown-linux-gnu";   UV_SHA="588f3e360f69ce02b6982aa99f2240e803933a6b7e176ac01617830adf955add" ;;
      aarch64/gnu)  UV_TARGET="aarch64-unknown-linux-gnu";  UV_SHA="0f03c6648df1c159557f4222c0f37250f84733fb88d6fc3c16770e17c177a8c9" ;;
      x86_64/musl)  UV_TARGET="x86_64-unknown-linux-musl";  UV_SHA="a095a969fc8357f42e35652e0554525a47a29010ddb814bd82650c2ffa7d6d62" ;;
      aarch64/musl) UV_TARGET="aarch64-unknown-linux-musl"; UV_SHA="6d895725333680bf7633ad635baff8e49dc45d3b52e00b2b3adf6ced41f2ebe2" ;;
    esac ;;
  *) die "unsupported platform: $OS $ARCH (macOS and Linux on x86_64/arm64 for now)" ;;
esac

# ---------------------------------------------------------------- 1. release tarball
say "Downloading the Anagram release"
curl -fsSL --retry 3 -o "$TMP/anagram.tar.gz" "$RELEASE_URL/anagram.tar.gz"
curl -fsSL --retry 3 -o "$TMP/anagram.tar.gz.sha256" "$RELEASE_URL/anagram.tar.gz.sha256"
expected="$(cut -c1-64 "$TMP/anagram.tar.gz.sha256")"
actual="$(sha256_of "$TMP/anagram.tar.gz")"
[ "$expected" = "$actual" ] || die "checksum mismatch for anagram.tar.gz (expected $expected, got $actual)"
mkdir -p "$TMP/x" && tar -xzf "$TMP/anagram.tar.gz" -C "$TMP/x"
REL="$TMP/x/anagram"
[ -f "$REL/VERSION" ] && [ -d "$REL/app" ] && [ -d "$REL/extension" ] && [ -f "$REL/bin/anagram" ] || die "unexpected release layout"
VERSION="$(cat "$REL/VERSION")"
note "version $VERSION"
# Staged swap: the new trees are placed beside the old ones, then renamed into place.
STAGE="$ANAGRAM_HOME/.staging.$$"
remove_ours "$STAGE"; mkdir -p "$STAGE"
cp -R "$REL/app" "$STAGE/app"
cp -R "$REL/extension" "$STAGE/extension"
cp "$REL/install.sh" "$STAGE/app/install.sh" 2>/dev/null || true
for sub in app extension; do
  if [ -e "$ANAGRAM_HOME/$sub" ]; then remove_ours "$ANAGRAM_HOME/$sub.old"; mv "$ANAGRAM_HOME/$sub" "$ANAGRAM_HOME/$sub.old"; fi
  mv "$STAGE/$sub" "$ANAGRAM_HOME/$sub"
  remove_ours "$ANAGRAM_HOME/$sub.old"
done
remove_ours "$STAGE"
install_ours "$REL/bin/anagram" "$ANAGRAM_HOME/bin/anagram" 755
printf '%s\n' "$VERSION" > "$TMP/VERSION"
install_ours "$TMP/VERSION" "$ANAGRAM_HOME/VERSION"

# ---------------------------------------------------------------- 2. uv (pinned release binary, checksum-verified)
if [ ! -x "$ANAGRAM_HOME/bin/uv" ] || [ "$(clean_env "$ANAGRAM_HOME/bin/uv" --version 2>/dev/null | cut -d' ' -f2)" != "$UV_VERSION" ]; then
  say "Fetching uv $UV_VERSION into $ANAGRAM_HOME/bin (a static binary; no PATH or profile changes)"
  curl -fsSL --retry 3 -o "$TMP/uv.tar.gz" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TARGET.tar.gz"
  [ "$(sha256_of "$TMP/uv.tar.gz")" = "$UV_SHA" ] || die "checksum mismatch for uv-$UV_TARGET.tar.gz"
  tar -xzf "$TMP/uv.tar.gz" -C "$TMP" "uv-$UV_TARGET/uv"
  install_ours "$TMP/uv-$UV_TARGET/uv" "$ANAGRAM_HOME/bin/uv" 755
fi

# ---------------------------------------------------------------- 3. private Python + locked packages
say "Installing a private Python $PYTHON_VERSION"
run_uv python install "$PYTHON_VERSION" --quiet
say "Installing the daemon's packages from uv.lock (torch, transformers, fastapi…)"
( cd "$ANAGRAM_HOME/app" && run_uv sync --frozen --no-dev --python "$PYTHON_VERSION" --quiet )
PY="$ANAGRAM_HOME/venv/bin/python"
[ -x "$PY" ] || die "virtual environment was not created"
# The download cache only serves re-syncs; an update re-fetches anyway. Keep the footprint small.
run_uv cache clean --quiet 2>/dev/null || remove_ours "$ANAGRAM_HOME/cache"
mkdir -p "$ANAGRAM_HOME/cache"

# ---------------------------------------------------------------- 4. models (checksum-verified)
MODEL_DIR="$ANAGRAM_HOME/models/editlens_roberta-large"
INCOMING="$ANAGRAM_HOME/models/.incoming-editlens_roberta-large"
if [ -z "${ANAGRAM_SKIP_MODEL:-}" ]; then
  if [ -f "$MODEL_DIR/model.safetensors" ] && [ "$(sha256_of "$MODEL_DIR/model.safetensors")" = "$WEIGHTS_SHA256" ]; then
    say "EditLens checkpoint already present and verified"
    # Half a download is worth keeping only while it can still be resumed into the checkpoint
    # that is now already here. 1.4 GB of nothing otherwise.
    [ -e "$INCOMING" ] && remove_ours "$INCOMING"
  else
    TOKEN="${ANAGRAM_HF_TOKEN:-}"
    [ -z "$TOKEN" ] && [ "$DEFAULT_HF_TOKEN" != "__ANAGRAM_HF_TOKEN__" ] && TOKEN="$DEFAULT_HF_TOKEN"
    if [ -z "$TOKEN" ] && [ -t 0 ]; then
      note "The EditLens checkpoint ($HF_REPO) is gated on Hugging Face: accept its terms at"
      note "https://huggingface.co/$HF_REPO, then paste a read token from https://huggingface.co/settings/tokens"
      printf '    token: '; read -r TOKEN
    fi
    [ -n "$TOKEN" ] || die "no Hugging Face token — set ANAGRAM_HF_TOKEN=… or ANAGRAM_SKIP_MODEL=1 (then run: anagram model)"
    say "Downloading the EditLens checkpoint (1.4 GB, resumable)"
    # Staged, like everything else that replaces a file in use: the download lands in a
    # directory beside the real one and is checked there, so a run interrupted halfway — or a
    # file that is not the pinned one — is never at the name the daemon loads from. The staging
    # directory keeps the same name between attempts, which is what lets a re-run resume
    # instead of starting the 1.4 GB again.
    [ -L "$INCOMING" ] && die "'$INCOMING' is a symbolic link — refusing to write through it"
    mkdir -p "$INCOMING"
    clean_env HF_HOME="$ANAGRAM_HOME/hf" HF_TOKEN="$TOKEN" HF_HUB_DISABLE_TELEMETRY=1 PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 \
      "$PY" - "$INCOMING" "$HF_REPO" "$HF_REVISION" <<'PYEOF'
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[2], revision=sys.argv[3], local_dir=sys.argv[1], allow_patterns=["*.json", "*.txt", "*.safetensors", "README.md"])
PYEOF
    [ "$(sha256_of "$INCOMING/model.safetensors" 2>/dev/null || true)" = "$WEIGHTS_SHA256" ] \
      || die "the downloaded weights are not the pinned checkpoint — they stay in $INCOMING and nothing was replaced (re-run to resume the download)"
    note "checksum verified"
    [ -L "$MODEL_DIR" ] && die "'$MODEL_DIR' is a symbolic link — refusing to replace it"
    if [ -e "$MODEL_DIR" ]; then remove_ours "$MODEL_DIR.old"; mv "$MODEL_DIR" "$MODEL_DIR.old"; fi
    mv "$INCOMING" "$MODEL_DIR"
    remove_ours "$MODEL_DIR.old"
  fi
  if [ ! -f "$ANAGRAM_HOME/models/lid.176.ftz" ] || [ "$(sha256_of "$ANAGRAM_HOME/models/lid.176.ftz")" != "$LID_SHA256" ]; then
    say "Downloading the fastText language model (1 MB)"
    curl -fsSL --retry 3 -o "$TMP/lid.176.ftz" "$LID_URL"
    [ "$(sha256_of "$TMP/lid.176.ftz")" = "$LID_SHA256" ] || die "checksum mismatch for lid.176.ftz"
    install_ours "$TMP/lid.176.ftz" "$ANAGRAM_HOME/models/lid.176.ftz"
  fi
fi

# ---------------------------------------------------------------- 5. config + done
[ -f "$ANAGRAM_HOME/config" ] || printf 'PORT=8765\n' > "$ANAGRAM_HOME/config"
say "Installed Anagram $VERSION into $ANAGRAM_HOME"
echo
note "1. Start the scoring daemon (stays in this folder, listens on 127.0.0.1 only):"
note "     $ANAGRAM_HOME/bin/anagram start"
note "2. Load the extension: chrome://extensions → Developer mode → Load unpacked →"
note "     $ANAGRAM_HOME/extension"
note "3. Browse. '$ANAGRAM_HOME/bin/anagram status' shows the daemon, '... stop' stops it,"
note "   '... uninstall' removes this folder and nothing else."
[ -n "${ANAGRAM_SKIP_MODEL:-}" ] && note "(model skipped — run: $ANAGRAM_HOME/bin/anagram model)"
echo
note "Tip: add it to your PATH yourself if you like —  export PATH=\"$ANAGRAM_HOME/bin:\$PATH\""
