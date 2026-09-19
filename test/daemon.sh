#!/bin/sh
# Run test/daemon.py under the daemon's own interpreter when there is one (anagramd/.venv, the
# same one `npm run serve` uses), so the checks that need fastapi or fasttext actually run
# instead of skipping. ANAGRAMD_PYTHON overrides; a bare python3 is the last resort.
#
#   sh test/daemon.sh        (= npm run test:daemon)
#
# Nothing here loads the model, opens a port or touches an installed Anagram folder.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${ANAGRAMD_PYTHON:-}" ]; then PY="$ANAGRAMD_PYTHON"
elif [ -x "$ROOT/anagramd/.venv/bin/python" ]; then PY="$ROOT/anagramd/.venv/bin/python"
else PY="python3"; fi
# No .pyc anywhere: the suite imports serve.py from a tree that may not be ours to write in.
PYTHONDONTWRITEBYTECODE=1 exec "$PY" "$ROOT/test/daemon.py" "$@"
