#!/usr/bin/env python3
"""Write lib/webengine/emoji.data.json from the pinned `emoji` package.

EditLens's preprocessing spells emoji out by name (emoji.demojize) before the text is
lowercased and tokenized, so the in-browser engine carries the same names. The file is
the package's emoji.json reduced to what demojize reads: for every emoji sequence its
English name and its qualification status (the status decides how a zero-width joiner
after a component is read). The `emoji` version must be the one anagramd/uv.lock pins.

  python scripts/emojiData.py    # with `emoji` importable, e.g. from the engine's venv
"""
import json
import sys
from pathlib import Path

import emoji
from emoji import unicode_codes

ROOT = Path(__file__).resolve().parents[1]
LOCK = (ROOT / "anagramd" / "uv.lock").read_text()
pinned = LOCK.split('name = "emoji"\nversion = "')[1].split('"')[0]
if emoji.__version__ != pinned:
    sys.exit(f"emoji {emoji.__version__} is importable, but anagramd/uv.lock pins {pinned}")
data = {key: [entry["en"], entry["status"]] for key, entry in unicode_codes.EMOJI_DATA.items()}
out = ROOT / "lib" / "webengine" / "emoji.data.json"
out.write_text(json.dumps({"version": emoji.__version__, "emoji": data}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"{out.relative_to(ROOT)}: {len(data)} emoji from emoji {emoji.__version__}")
