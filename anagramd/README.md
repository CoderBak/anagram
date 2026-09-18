# anagramd — local scoring daemon

The extension never runs a model in the browser. It talks over HTTP to this small
daemon, which loads **`pangram/editlens_roberta-large`** (EditLens, ICLR 2026,
CC BY-NC-SA 4.0 — non-commercial) and scores paragraphs on your machine.
Nothing leaves localhost — and the daemon is hardened like a service, not a script
(see below). It is the only scorer: without it the extension shows *Unavailable*.

```sh
# 1. weights (gated on Hugging Face — accept the terms once, then):
hf download pangram/editlens_roberta-large --local-dir ../models/editlens_roberta-large

# 2. deps from the lockfile (torch, transformers, fastapi, uvicorn, emoji, fasttext) into anagramd/.venv:
cd anagramd && uv sync --frozen && cd ..

# 3. run
npm run serve            # = sh anagramd/run.sh (uses .venv if present) → http://127.0.0.1:8765
python3 anagramd/serve.py --selftest   # sanity check: four paragraphs, PASS/FAIL per line, non-zero on failure
```

With the daemon up, the extension picks it up within seconds (it re-probes `/health`
every 5 s while down); the popup names the model. Without it, paragraphs show as
Unavailable and are re-queued automatically when it answers.

If the model directory is missing, the daemon downloads the checkpoint itself through
`huggingface_hub`, pinned to the verified Hub revision (accept the terms on the model
page and `hf auth login` once). The served model version identifies the whole scoring
pipeline, not just the weights: `sha256:<12 hex of model.safetensors>-p<8 hex>-pre1`, e.g.
`sha256:869f33df7928-p1512a764-pre1`. The weights digest is memoized next to the checkpoint
(startup warns when it is not the verified one); the second digest covers a canonical
manifest of the small files that decide how text reaches the weights — `config.json`,
`tokenizer.json`, `tokenizer_config.json`, `vocab.json`, `merges.txt`,
`special_tokens_map.json` — together with `--max-length`, the effective dtype and whether
the language gate is on. The extension keys every cached verdict by this string, so no two
configurations that can disagree about a paragraph ever share a cache entry.

## API

Served by FastAPI + uvicorn; request and response bodies are validated with pydantic, and
an interactive OpenAPI UI lives at `http://127.0.0.1:8765/docs`.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /health` | – | `{ok, model:{id,ver,calibration}, n_buckets, buckets, languages, lid, max_tokens, limits, device}` |
| `POST /score` | `{v:"2.1", blocks:[{id,text}]}` | `{v, model, results:[{id,bucket,probs,score,tokens,truncated,lang,lang_prob,unsupported?}]}` |

**Hardening.** Binds `127.0.0.1` (a non-loopback `--host` needs `--allow-remote`) and
refuses any request whose `Host` header is not a loopback name (DNS rebinding → 400).
It sends no CORS headers, so a web page cannot read a response, and two rules keep a
page from reaching `/score` in the first place: `POST /score` must be declared
`application/json` (parameters such as `; charset=utf-8` are fine, anything else or
nothing is 415), which forces a CORS preflight that then fails for want of CORS headers;
and a request that carries an `Origin` must carry an extension one
(`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) or the daemon's own
(so `/docs` → "Try it out" keeps working) — everything else, `null` included, is 403.
A request with no `Origin` at all (curl, the `anagram` CLI, Node) is accepted as before.
Every request is then validated before anything is tokenized: `v` must be contract `2.x`,
≤ 256 blocks, ≤ 16 000 characters per block, ids unique and ≤ 64 characters. The 2 MB body
cap (413) counts the bytes that actually arrive, not the declared `Content-Length`, so a
chunked body cannot walk past it either. The limits are reported by `/health`.

**Language gate.** EditLens is English-only (model card `language: en`; every dataset
source in the paper is English). The daemon runs every block through fastText's
[`lid.176`](https://fasttext.cc/docs/en/language-identification.html) language
identifier first (downloaded to `../models/lid.176.ftz` on first start, ~1 MB); only
blocks whose top label is `en` reach the model. Others come back as
`{unsupported: true, lang: "zh", lang_prob: 0.99}` with placeholder buckets, and the
extension shows an "Unsupported language" chip instead of a number. `/health`
reports `languages` and `lid`. The gate **fails closed**: if fastText or its model
cannot be loaded the daemon refuses to start; `--no-language-gate` turns it off
explicitly (logged, `lid: null` in `/health` — not advised). The extension also
pre-gates confidently non-English paragraphs with the browser's own detector, so
most of them never arrive here.

`bucket` is 0 = human, 1 = lightly AI-edited, 2 = heavily AI-edited, 3 = AI-generated.
Scored results also carry `lang` / `lang_prob`.
`score` is the probability-weighted bucket index in [0, 1] — the model's continuous
"extent of AI editing" (a change-magnitude estimate for the text as a whole, not a
share of AI-written words). Text is preprocessed exactly like the reference
`scripts/preprocess.py` (emoji → `:names:`, lowercase, whitespace collapse) and
truncated to 512 tokens (`truncated: true` when that happened).

## Benchmarks

`bench.py` measures load time, memory and throughput of the EditLens checkpoints on
this machine (`.venv/bin/python bench.py --json out.json`); it also drives the
`pangram/editlens_Llama-3.2-3B` LoRA adapter merged onto `meta-llama/Llama-3.2-3B`
(`train_head.py` holds the reference score head). Results for an Apple M4 / 24 GB are
in `../docs/benchmarks/`.
