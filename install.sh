#!/bin/sh
# Anagram installer — everything lives in ONE folder, nothing else on the machine changes.
#
#   curl -fsSL https://github.com/CoderBak/anagram/releases/latest/download/install.sh | sh
#
# What it does (no sudo, no shell-profile edits, no system Python, no Homebrew):
#   $ANAGRAM_HOME (default ~/.anagram)
#     bin/anagram     the command: start · stop · status · logs · update · uninstall
#     bin/uv          a static uv binary (fetched with UV_UNMANAGED_INSTALL — modifies nothing)
#     python/         a uv-managed CPython, private to Anagram
#     venv/           the daemon's packages from the committed uv.lock (reproducible)
#     app/            the scoring daemon (anagramd) at the installed release
#     extension/      the built extension, ready for Chrome's "Load unpacked"
#     models/         the EditLens checkpoint + the fastText language model
#     hf/ cache/ logs/ run/   Hugging Face cache, uv cache, daemon logs, pid file
#
# Options (environment):
#   ANAGRAM_HOME=…          install somewhere else (default ~/.anagram)
#   ANAGRAM_RELEASE_URL=…   where the release assets live (default: the latest GitHub release)
#   ANAGRAM_HF_TOKEN=…      Hugging Face token for the gated checkpoint (else you are asked)
#   ANAGRAM_SKIP_MODEL=1    do not download the checkpoint now (`anagram model` does it later)
#   ANAGRAM_PYTHON=3.12     Python version to install
#
# Re-running updates in place. `anagram uninstall` removes the folder — that is all there is.
set -eu

ANAGRAM_HOME="${ANAGRAM_HOME:-$HOME/.anagram}"
RELEASE_URL="${ANAGRAM_RELEASE_URL:-https://github.com/CoderBak/anagram/releases/latest/download}"
PYTHON_VERSION="${ANAGRAM_PYTHON:-3.12}"
HF_REPO="pangram/editlens_roberta-large"
HF_REVISION="f93e1ace74528cfb48f337ab2fe946fb71a728cb"
WEIGHTS_SHA256="869f33df7928c447bbd150d3b5192b4ea90b1cbd2ee4aad97f5d51d59dfc8cfb"
LID_URL="https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
# Filled in at release time from a repository secret; never committed.
DEFAULT_HF_TOKEN="__ANAGRAM_HF_TOKEN__"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }

[ "$(id -u)" -eq 0 ] && [ -z "${ANAGRAM_ALLOW_ROOT:-}" ] && die "do not run as root — Anagram installs into your home folder only"
need curl; need tar
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else die "sha256sum or shasum is required"; fi
sha256_of() { $SHA "$1" | cut -c1-64; }

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in Darwin|Linux) ;; *) die "unsupported OS: $OS (macOS and Linux for now)";; esac
case "$ARCH" in arm64|aarch64|x86_64) ;; *) die "unsupported CPU: $ARCH";; esac

mkdir -p "$ANAGRAM_HOME/bin" "$ANAGRAM_HOME/models" "$ANAGRAM_HOME/logs" "$ANAGRAM_HOME/run" "$ANAGRAM_HOME/cache" "$ANAGRAM_HOME/hf"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/anagram-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- 1. release tarball
say "Downloading the Anagram release"
curl -fsSL --retry 3 -o "$TMP/anagram.tar.gz" "$RELEASE_URL/anagram.tar.gz"
curl -fsSL --retry 3 -o "$TMP/anagram.tar.gz.sha256" "$RELEASE_URL/anagram.tar.gz.sha256"
expected="$(cut -c1-64 "$TMP/anagram.tar.gz.sha256")"
actual="$(sha256_of "$TMP/anagram.tar.gz")"
[ "$expected" = "$actual" ] || die "checksum mismatch for anagram.tar.gz (expected $expected, got $actual)"
mkdir -p "$TMP/x" && tar -xzf "$TMP/anagram.tar.gz" -C "$TMP/x"
REL="$TMP/x/anagram"
[ -f "$REL/VERSION" ] || die "unexpected release layout"
VERSION="$(cat "$REL/VERSION")"
note "version $VERSION"
rm -rf "$ANAGRAM_HOME/app" "$ANAGRAM_HOME/extension"
cp -R "$REL/app" "$ANAGRAM_HOME/app"
cp -R "$REL/extension" "$ANAGRAM_HOME/extension"
cp "$REL/bin/anagram" "$ANAGRAM_HOME/bin/anagram" && chmod +x "$ANAGRAM_HOME/bin/anagram"
cp "$REL/install.sh" "$ANAGRAM_HOME/app/install.sh" 2>/dev/null || true
printf '%s\n' "$VERSION" > "$ANAGRAM_HOME/VERSION"

# ---------------------------------------------------------------- 2. uv (static binary, unmanaged)
if [ ! -x "$ANAGRAM_HOME/bin/uv" ]; then
  say "Fetching uv into $ANAGRAM_HOME/bin (no PATH or profile changes)"
  curl -fsSL --retry 3 https://astral.sh/uv/install.sh | UV_UNMANAGED_INSTALL="$ANAGRAM_HOME/bin" UV_PRINT_QUIET=1 sh
fi
UV="$ANAGRAM_HOME/bin/uv"
export UV_CACHE_DIR="$ANAGRAM_HOME/cache"
export UV_PYTHON_INSTALL_DIR="$ANAGRAM_HOME/python"
export UV_PYTHON_BIN_DIR="$ANAGRAM_HOME/python/bin"
export UV_TOOL_DIR="$ANAGRAM_HOME/tools"
export UV_TOOL_BIN_DIR="$ANAGRAM_HOME/tools/bin"
export UV_PROJECT_ENVIRONMENT="$ANAGRAM_HOME/venv"
export UV_NO_MODIFY_PATH=1

# ---------------------------------------------------------------- 3. private Python + locked packages
say "Installing a private Python $PYTHON_VERSION"
"$UV" python install "$PYTHON_VERSION" --quiet
say "Installing the daemon's packages from uv.lock (torch, transformers, fastapi…)"
( cd "$ANAGRAM_HOME/app" && "$UV" sync --frozen --no-dev --python "$PYTHON_VERSION" --quiet )
PY="$ANAGRAM_HOME/venv/bin/python"
[ -x "$PY" ] || die "virtual environment was not created"
# The download cache only serves re-syncs; an update re-fetches anyway. Keep the footprint small.
"$UV" cache clean --quiet 2>/dev/null || rm -rf "$ANAGRAM_HOME/cache"

# ---------------------------------------------------------------- 4. models
export HF_HOME="$ANAGRAM_HOME/hf"
MODEL_DIR="$ANAGRAM_HOME/models/editlens_roberta-large"
if [ -z "${ANAGRAM_SKIP_MODEL:-}" ]; then
  if [ -f "$MODEL_DIR/model.safetensors" ] && [ "$(sha256_of "$MODEL_DIR/model.safetensors")" = "$WEIGHTS_SHA256" ]; then
    say "EditLens checkpoint already present and verified"
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
    HF_TOKEN="$TOKEN" "$PY" - "$MODEL_DIR" <<PYEOF
import sys
from huggingface_hub import snapshot_download
snapshot_download("$HF_REPO", revision="$HF_REVISION", local_dir=sys.argv[1], allow_patterns=["*.json", "*.txt", "*.safetensors", "README.md"])
PYEOF
    [ "$(sha256_of "$MODEL_DIR/model.safetensors")" = "$WEIGHTS_SHA256" ] || die "downloaded weights do not match the verified checksum"
    note "checksum verified"
  fi
  if [ ! -f "$ANAGRAM_HOME/models/lid.176.ftz" ]; then
    say "Downloading the fastText language model (1 MB)"
    curl -fsSL --retry 3 -o "$ANAGRAM_HOME/models/lid.176.ftz" "$LID_URL"
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
