#!/bin/sh
# Launch anagramd with its own venv when present (see anagramd/README.md), else python3.
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/python ]; then exec .venv/bin/python serve.py "$@"; fi
exec python3 serve.py "$@"
