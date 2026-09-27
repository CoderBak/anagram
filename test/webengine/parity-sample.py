#!/usr/bin/env python3
"""The parity sample for the in-browser engine, from a native parity run.

  python test/webengine/parity-sample.py --report <editlens-parity.py --report file> \\
      --data <EditLens data dir with test.csv> --modelkit <modelkit dir> --out <sample.json>

test/editlens-parity.py scores a fixed 200-text sample of the gated test split with
Pangram's official inference and the native host; with --report it writes every text's
official probabilities. This joins that report back to the texts and adds what the
native engine's `tokens` operation answers for each (through anagramd/scoring.py, the
same Rust tokenizer), so test/webengine/parity.mjs can hold the browser engine to both.
Needs the engine's Python dependencies (emoji, tokenizers, pydantic); never in CI.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "anagramd"))
import emoji  # noqa: E402
from engine import clean_text  # noqa: E402
from scoring import Tokenizer  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--modelkit", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    wanted = {t["text_id"]: t for t in report["texts"]}
    csv.field_size_limit(sys.maxsize)
    texts = {}
    with (args.data / "test.csv").open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["text_id"] in wanted and row["text"] and len(row["text"]) <= 16000:
                texts[row["text_id"]] = row["text"]
    missing = [text_id for text_id in wanted if text_id not in texts]
    if missing:
        sys.exit(f"{len(missing)} texts of the report are not in {args.data / 'test.csv'}")
    tok = Tokenizer(args.modelkit)
    out = []
    for text_id, t in wanted.items():
        text = texts[text_id]
        cleaned = clean_text(text, emoji)
        length = len(tok([cleaned], add_special_tokens=True)["input_ids"][0])
        alone = len(tok([cleaned], add_special_tokens=False)["input_ids"][0])
        following = len(tok([" " + cleaned], add_special_tokens=False)["input_ids"][0]) if cleaned else 0
        out.append({"text_id": text_id, "text": text, "official": t["official"], "native": t["anagram"],
                    "length": length, "alone": alone, "following": following})
    args.out.write_text(json.dumps(out))
    print(f"{args.out}: {len(out)} texts, {sum(o['length'] > 512 for o in out)} longer than 512 tokens")
    return 0


if __name__ == "__main__":
    sys.exit(main())
