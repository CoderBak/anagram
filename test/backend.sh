#!/bin/sh
# Offline engine, runtime lifecycle and native framing tests.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${ANAGRAMD_PYTHON:-}" ]; then PY="$ANAGRAMD_PYTHON"
elif [ -x "$ROOT/anagramd/.venv/bin/python" ]; then PY="$ROOT/anagramd/.venv/bin/python"
else PY="python3"; fi
# Do not write bytecode into the application tree.
PYTHONDONTWRITEBYTECODE=1 "$PY" "$ROOT/test/engine.py" "$@"
PYTHONDONTWRITEBYTECODE=1 "$PY" "$ROOT/test/runtime.py" "$@"
PYTHONDONTWRITEBYTECODE=1 "$PY" "$ROOT/test/model_plan.py" "$@"
PYTHONDONTWRITEBYTECODE=1 exec "$PY" "$ROOT/test/native_host.py" "$@"
