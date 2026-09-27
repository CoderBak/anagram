#!/usr/bin/env python3
"""Reference cleaning and token ids from the engine's own Python for the browser engine.

  python test/webengine/text-reference.py <modelkit dir> <out.jsonl> [text file or CSV ...]

Every text of the inputs (a CSV's `text` column, or a plain file, one text a line, with
\\n escapes) and a set of built-in edge cases go through anagramd's clean_text and the
modelkit's tokenizer.json in the Rust `tokenizers` library, as the native engine reads
them. One JSON line per text: the text, the SHA-256 of its cleaned form, the SHA-256 of
its ids with and without the special tokens, and the `tokens` operation's two counts.
test/webengine/text-check.mjs replays the file through lib/webengine/. Needs the
engine's Python dependencies (emoji, tokenizers, pydantic) — never part of CI.
"""
import csv
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "anagramd"))
import emoji  # noqa: E402
from engine import clean_text  # noqa: E402
from scoring import Tokenizer  # noqa: E402

EDGE_CASES = [
    "", " ", "\n\n", "Hello 👍🏽 world 👨‍👩‍👧 flags 🇺🇸🇫🇷 ☺ ☺️ 1️⃣ #️⃣ 🏳️‍🌈 🏴‍☠️",
    "a‍👍 z ‍ alone ️ stray ︎ stray2", "🧑🏽‍🤝‍🧑🏻 and 👩‍❤️‍💋‍👨 and 🫱🏼‍🫲🏿",
    "<think>plan</think> Sure, here is the answer.\nThe body.", "x</think>y</think>z",
    "Sure! Here you go:\nSecond paragraph.", "Certainly.\n\n\nOnly one paragraph after blanks.",
    "  Here is the text\n", "Title: Only one line", "I'm happy to help you.\nWith this.",
    "Text with <s> and </s> and <pad> and <unk> and   <mask> inside <MASK> too", "<mask>",
    "  non-breaking spaces  em 　ideographic \x1c\x1d\x1e\x1f separators \x85 nel ﻿ bom ​ zwsp",
    "ΟΔΥΣΣΕΥΣ İstanbul STRASSE ǅ ﬁ ß", "Tabs\tand\r\nCRLF\rCR\x0bVT\x0cFF", "'s 't 're 've 'm 'll 'd 'S 'T don't",
    "numbers 12345 mixed12abc 3.14 1,000 ½ ² ٣ ４", "punct!!! ... --- ??? \"quoted\" 'single' (paren) [brack] {brace} @#$%^&*",
    "long run of spaces      here and trailing   ", "emoji at end 😀", "😀", "😀😀😀 three",
    "日本語のテキスト and 中文 and 한국어 and العربية and עברית", "🙂‍↔️ head shaking 🙂‍↕️", "keycaps 0️⃣ 9️⃣ *️⃣ and © ® ™ ‼️ ⁉️",
    "combining é and ́ lone and ̈", "surrogates 𝒜𝒷𝒸 𝔘𝔫𝔦 🅰️ 🅱️", "Abstract\nline two\nline three",
]


def sha(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def texts_of(path: Path):
    if path.suffix == ".csv":
        csv.field_size_limit(sys.maxsize)
        with path.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row.get("text"):
                    yield row["text"]
    else:
        for line in path.read_text(encoding="utf-8").splitlines():
            yield json.loads(line) if line.startswith('"') else line


def main() -> int:
    kit, out = Path(sys.argv[1]), Path(sys.argv[2])
    tok = Tokenizer(kit)
    n = 0
    with out.open("w", encoding="utf-8") as f:
        sources = [iter(EDGE_CASES)] + [texts_of(Path(p)) for p in sys.argv[3:]]
        for source in sources:
            for text in source:
                if len(text) > 16000:
                    continue
                cleaned = clean_text(text, emoji)
                encoded = tok([cleaned, " " + cleaned], add_special_tokens=False)["input_ids"]
                special = tok([cleaned], add_special_tokens=True)["input_ids"][0]
                f.write(json.dumps({"text": text, "clean": hashlib.sha256(cleaned.encode()).hexdigest(),
                                    "clean_len": len(cleaned), "ids": sha(encoded[0]), "special": sha(special),
                                    "alone": len(encoded[0]), "following": len(encoded[1]) if cleaned else 0},
                                   ensure_ascii=False) + "\n")
                n += 1
    print(f"{out}: {n} texts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
