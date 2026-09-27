#!/usr/bin/env python3
"""Reference language-gate decisions from the native fastText for the browser's port.

  python test/webengine/lid-reference.py <lid.176.ftz> <out.jsonl> [CSV or text file ...] [--limit N]

Built-in multilingual sentences and edge cases, then the texts of the inputs (a CSV's
`text` column, or one text a line), each predicted exactly as anagramd/engine.py
LanguageId.detect does: newlines replaced by spaces, the pybind predict with k = 1 and
threshold 0. One JSON line per text: text, label, probability. Needs fasttext-predict
(the engine's own dependency) — never part of CI.
"""
import csv
import json
import sys
from pathlib import Path

import fasttext

SENTENCES = [
    "The quick brown fox jumps over the lazy dog while the sun sets behind the hills.",
    "Der schnelle braune Fuchs springt über den faulen Hund, während die Sonne untergeht.",
    "Le renard brun rapide saute par-dessus le chien paresseux au coucher du soleil.",
    "El rápido zorro marrón salta sobre el perro perezoso mientras se pone el sol.",
    "A rápida raposa marrom pula sobre o cão preguiçoso enquanto o sol se põe.",
    "La volpe marrone veloce salta sopra il cane pigro mentre il sole tramonta.",
    "De snelle bruine vos springt over de luie hond terwijl de zon ondergaat.",
    "Den snabba bruna räven hoppar över den lata hunden medan solen går ner.",
    "Den raske brune reven hopper over den late hunden mens solen går ned.",
    "Den hurtige brune ræv springer over den dovne hund, mens solen går ned.",
    "Nopea ruskea kettu hyppää laiskan koiran yli auringon laskiessa.",
    "Szybki brązowy lis przeskakuje nad leniwym psem, gdy słońce zachodzi.",
    "Rychlá hnědá liška skáče přes líného psa, zatímco slunce zapadá.",
    "A gyors barna róka átugorja a lusta kutyát, miközben lemegy a nap.",
    "Vulpea maro rapidă sare peste câinele leneș în timp ce soarele apune.",
    "Быстрая коричневая лиса перепрыгивает через ленивую собаку, пока садится солнце.",
    "Швидка коричнева лисиця перестрибує через ледачого пса, поки сідає сонце.",
    "Бързата кафява лисица прескача мързеливото куче, докато слънцето залязва.",
    "Η γρήγορη καφέ αλεπού πηδάει πάνω από τον τεμπέλη σκύλο καθώς δύει ο ήλιος.",
    "Hızlı kahverengi tilki, güneş batarken tembel köpeğin üzerinden atlar.",
    "השועל החום המהיר קופץ מעל הכלב העצלן בזמן שהשמש שוקעת.",
    "الثعلب البني السريع يقفز فوق الكلب الكسول بينما تغرب الشمس.",
    "روباه قهوه‌ای سریع در حالی که خورشید غروب می‌کند از روی سگ تنبل می‌پرد.",
    "तेज़ भूरी लोमड़ी आलसी कुत्ते के ऊपर से कूदती है जब सूरज डूबता है।",
    "দ্রুত বাদামী শিয়াল অলস কুকুরের উপর দিয়ে লাফ দেয় যখন সূর্য অস্ত যায়।",
    "வேகமான பழுப்பு நரி சோம்பேறி நாயின் மேல் குதிக்கிறது.",
    "素早い茶色のキツネが怠け者の犬を飛び越える。",
    "敏捷的棕色狐狸跳过了懒惰的狗，太阳正在落山。",
    "敏捷的棕色狐狸跳過了懶惰的狗，太陽正在落山。",
    "빠른 갈색 여우가 게으른 개를 뛰어넘는다.",
    "Con cáo nâu nhanh nhẹn nhảy qua con chó lười biếng khi mặt trời lặn.",
    "สุนัขจิ้งจอกสีน้ำตาลที่ว่องไวกระโดดข้ามสุนัขขี้เกียจ",
    "Rubah coklat yang cepat melompati anjing malas saat matahari terbenam.",
    "Mabilis na tumalon ang kayumangging soro sa tamad na aso habang lumulubog ang araw.",
    "Mbweha mwekundu mwepesi anaruka juu ya mbwa mvivu jua linapozama.",
    "Is é an sionnach donn tapa a léimeann thar an madra leisciúil.",
    "Mae'r llwynog brown cyflym yn neidio dros y ci diog wrth i'r haul fachlud.",
    "Ang mabilis na brown fox ay tumatalon sa tamad na aso.",
    "ok", "Hello", "hello world", "the", "Bonjour", "Gracias", "Danke schön", "da", "no", "si", "ja",
    "123 456 789", "!!! ??? ...", "http://example.com/path?x=1", "user@example.com", "😀 😃 😄",
    "This is English with a little français et deutsch mixed in, mostly English though.",
    "Ceci est français avec a little English mixed in, mais surtout du français quand même.",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.",
    "def main():\n    return 42  # comment",
    "SELECT * FROM users WHERE id = 1;",
    "Line one.\nLine two.\nLine three.",
    "tab\tseparated\twords\there", "  leading and trailing spaces  ", " non-breaking spaces here",
    "MiXeD CaSe EnGlIsH sEnTeNcE fOr ThE gAtE", "ALL CAPS ENGLISH SENTENCE ABOUT NOTHING IN PARTICULAR",
    "Ελληνικά and English together in one line of text for the detector.",
    "Português do Brasil é diferente do português de Portugal em alguns detalhes.",
    "Ẹ̀yin ọmọ Yorùbá, ẹ kú àárọ̀ o.", "Kia ora, ko wai tō ingoa?", "Ola, como estás? Eu estou ben, grazas.",
]
EDGE = ["", " ", "\n", "\t", "\x00", "a", "é", "中", "𝒜", "​", "a​b", "﻿", "</s>", "__label__en hello", "__label__fr", "<unk>",
        "ab" * 400, "word " * 300, "x" * 5000]


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
    argv = sys.argv[1:]
    limit = None
    if "--limit" in argv:
        at = argv.index("--limit")
        limit = int(argv[at + 1])
        del argv[at:at + 2]
    args = argv
    model, out = Path(args[0]), Path(args[1])
    lid = fasttext.load_model(str(model))
    n = 0
    with out.open("w", encoding="utf-8") as f:
        sources = [iter(SENTENCES + EDGE)]
        for p in args[2:]:
            source = texts_of(Path(p))
            sources.append((t for i, t in enumerate(source) if limit is None or i < limit))
        for source in sources:
            for text in source:
                if len(text) > 16000:
                    continue
                pairs = lid.f.predict(text.replace("\n", " "), 1, 0.0, "strict")
                if pairs:
                    prob, label = pairs[0]
                    row = {"text": text, "label": label.replace("__label__", ""), "prob": float(prob)}
                else:
                    row = {"text": text, "label": "und", "prob": 0.0}
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                n += 1
    print(f"{out}: {n} texts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
