# anagramd — local scoring daemon

The extension never runs a model in the browser. It talks over HTTP to this small
daemon, which loads **`pangram/editlens_roberta-large`** (EditLens, ICLR 2026,
CC BY-NC-SA 4.0 — non-commercial) and scores paragraphs on your machine.
Nothing leaves localhost.

```sh
# 1. weights (gated on Hugging Face — accept the terms once, then):
hf download pangram/editlens_roberta-large --local-dir ../models/editlens_roberta-large

# 2. deps (torch, transformers, flask, emoji)
pip install -r anagramd/requirements.txt

# 3. run
npm run serve            # = python3 anagramd/serve.py  → http://127.0.0.1:8765
python3 anagramd/serve.py --selftest   # sanity check: three paragraphs, prints buckets
```

With the daemon up, the extension's default backend mode (**Auto**) picks it up on
the next page load; the popup shows which backend produced the scores. Without it,
Auto falls back to the deterministic demo stub and says so.

## API

| Route | Body | Returns |
| --- | --- | --- |
| `GET /health` | – | `{ok, model:{id,ver,calibration}, n_buckets, buckets, max_tokens, device}` |
| `POST /score` | `{v:"2.0", blocks:[{id,text}]}` | `{v, model, results:[{id,bucket,probs,score,tokens,truncated}]}` |

`bucket` is 0 = human, 1 = lightly AI-edited, 2 = heavily AI-edited, 3 = AI-generated.
`score` is the probability-weighted bucket index in [0, 1] — the model's continuous
"extent of AI editing". Text is preprocessed exactly like the reference
`scripts/preprocess.py` (emoji → `:names:`, lowercase, whitespace collapse) and
truncated to 512 tokens (`truncated: true` when that happened).
