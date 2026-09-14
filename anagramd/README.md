# anagramd — local scoring daemon

The extension never runs a model in the browser. It talks over HTTP to this small
daemon, which loads **`pangram/editlens_roberta-large`** (EditLens, ICLR 2026,
CC BY-NC-SA 4.0 — non-commercial) and scores paragraphs on your machine.
Nothing leaves localhost.

```sh
# 1. weights (gated on Hugging Face — accept the terms once, then):
hf download pangram/editlens_roberta-large --local-dir ../models/editlens_roberta-large

# 2. deps (torch, transformers, fastapi, uvicorn, emoji, fasttext) — an isolated venv is simplest:
cd anagramd && uv venv .venv --python 3.13 && uv pip install --python .venv/bin/python -r requirements.txt && cd ..

# 3. run
npm run serve            # = sh anagramd/run.sh (uses .venv if present) → http://127.0.0.1:8765
python3 anagramd/serve.py --selftest   # sanity check: four paragraphs (one Chinese → unsupported), prints buckets
```

With the daemon up, the extension's default backend mode (**Auto**) picks it up on
the next page load; the popup shows which backend produced the scores. Without it,
Auto falls back to the deterministic demo stub and says so.

If the model directory is missing, the daemon downloads the checkpoint itself through
`huggingface_hub` (accept the terms on the model page and `hf auth login` once).

## API

Served by FastAPI + uvicorn; request and response bodies are validated with pydantic, and
an interactive OpenAPI UI lives at `http://127.0.0.1:8765/docs`.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /health` | – | `{ok, model:{id,ver,calibration}, n_buckets, buckets, languages, lid, max_tokens, device}` |
| `POST /score` | `{v:"2.1", blocks:[{id,text}]}` | `{v, model, results:[{id,bucket,probs,score,tokens,truncated,lang,lang_prob,unsupported?}]}` |

**Language gate.** EditLens is English-only (model card `language: en`; every dataset
source in the paper is English). The daemon runs every block through fastText's
[`lid.176`](https://fasttext.cc/docs/en/language-identification.html) language
identifier first (downloaded to `../models/lid.176.ftz` on first start, ~1 MB); only
blocks whose top label is `en` reach the model. Others come back as
`{unsupported: true, lang: "zh", lang_prob: 0.99}` with placeholder buckets, and the
extension shows an "Unsupported language" chip instead of a number. `/health`
reports `languages` and `lid`. `--no-language-gate` scores everything (not advised).

`bucket` is 0 = human, 1 = lightly AI-edited, 2 = heavily AI-edited, 3 = AI-generated.
Scored results also carry `lang` / `lang_prob`.
`score` is the probability-weighted bucket index in [0, 1] — the model's continuous
"extent of AI editing". Text is preprocessed exactly like the reference
`scripts/preprocess.py` (emoji → `:names:`, lowercase, whitespace collapse) and
truncated to 512 tokens (`truncated: true` when that happened).
