# anagramd — local scoring daemon

The extension never runs a model in the browser. It talks over HTTP to this small
daemon, which loads **`pangram/editlens_roberta-large`** (EditLens, ICLR 2026,
CC BY-NC-SA 4.0 — non-commercial) and scores paragraphs on your machine.
Nothing leaves localhost — and the daemon is hardened like a service, not a script
(see below). It is the only scorer: without it the extension shows *Unavailable*.

```sh
# 1. the two model files — the daemon downloads NOTHING itself (see "Offline", below)
#    weights (gated on Hugging Face — accept the terms once, then):
hf download pangram/editlens_roberta-large --local-dir ../models/editlens_roberta-large
#    fastText lid.176, ~1 MB (sha256 8f3472cfe873…, pinned in install.sh):
curl -fsSL -o ../models/lid.176.ftz https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz

# 2. deps from the lockfile (torch, transformers, fastapi, uvicorn, emoji, fasttext) into anagramd/.venv:
cd anagramd && uv sync --frozen && cd ..

# 3. run
npm run serve            # = sh anagramd/run.sh (uses .venv if present) → http://127.0.0.1:8765
python3 anagramd/serve.py --selftest   # sanity check: four paragraphs, PASS/FAIL per line, non-zero on failure
npm run test:daemon      # offline / identity / Host / Origin / CORS checks — no model, no port, seconds
```

With the daemon up, the extension picks it up within seconds (it re-probes `/health`
every 5 s while down); the popup names the model. Without it, paragraphs show as
Unavailable and are re-queued automatically when it answers.

The above is the from-source setup. In an *installed* folder (`~/.anagram`, from
`install.sh`) this daemon is started and stopped by `~/.anagram/bin/anagram start|stop`,
and `anagram doctor` says which of the folder, the private Python, the model files or
the port is the reason it will not come up — including a daemon whose `/health` reports
a contract major the installed extension does not speak.

## Offline

Serving reaches no network, and the daemon is built so that it cannot: `HF_HUB_OFFLINE`,
`TRANSFORMERS_OFFLINE`, `HF_HUB_DISABLE_TELEMETRY` and `HF_HUB_DISABLE_IMPLICIT_TOKEN` are
set at the top of `serve.py`, above every import, because `huggingface_hub` and
`transformers` read them once when they are imported and ignore a value set later. Neither
model file is ever fetched at run time: a missing one is an error naming the command that
fetches it (`anagram model`, or the `hf download` / `curl` lines above), and `anagram doctor`
reports both files and their checksums. The daemon used to download them on first start —
the checkpoint under whatever Hugging Face token it found, the language model with a bare
`urlretrieve` that left a truncated `.ftz` behind if it was interrupted, which the next start
would load as though it were real.

Downloading is two explicit commands, `install.sh` and `anagram model`. Both land the file in
a staging name beside the one it replaces, check it against the checksum pinned in
`install.sh`, and rename it into place only if it matches — so an interrupted or tampered
download is never something the daemon can load, and re-running resumes rather than starting
the 1.4 GB again.

## The served version

The served model version identifies the whole scoring pipeline, not just the weights:
`sha256:<12 hex of model.safetensors>-p<8 hex>-pre1`, e.g. `sha256:869f33df7928-p1512a764-pre1`.
The weights digest is memoized next to the checkpoint (startup warns when it is not the
verified one); the second digest covers a canonical manifest of everything else that can move
a verdict — the small files that decide how text reaches the weights (`config.json`,
`tokenizer.json`, `tokenizer_config.json`, `vocab.json`, `merges.txt`,
`special_tokens_map.json`), `--max-length`, the effective dtype, the language gate down to the
**sha256 of the fastText model itself** and the languages it lets through, the bucket labels
and their schema, and a hash of the preprocessing source, so an edit to `clean_text` cannot go
on sharing cache entries with the version before it. The extension keys every cached verdict
by this string, so no two configurations that can disagree about a paragraph ever share a
cache entry.

## API

Served by FastAPI + uvicorn; request and response bodies are validated with pydantic, and
an interactive OpenAPI UI lives at `http://127.0.0.1:8765/docs`.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /health` | – | `{ok, app_version, model:{id,ver,calibration,label_schema}, n_buckets, buckets, languages, lid, max_tokens, limits, device}` |
| `POST /score` | `{v:"2.1", blocks:[{id,text}]}` | `{v, model, results:[{id,bucket,probs,score,tokens,truncated,lang,lang_prob,unsupported?}]}` |

`app_version` on `/health` is the daemon's own release (`pyproject.toml` next to `serve.py`,
which `scripts/bump.mjs` keeps in step with the extension, or the installed folder's
`VERSION` one directory up). The extension compares it with its own and asks the user to run
`~/.anagram/bin/anagram update` when the daemon is behind — the two ship as one artifact, so
they are meant to move together. It is additive: contract 2.x clients that never look at it
are unaffected.

**Hardening.** Binds `127.0.0.1` or `localhost` and answers to those two names and no others:
they are the only two a browser's content-security policy can express, so they are all the
extension can ever be pointed at, and every further name is one more `Host` a rebinding page
could try. `--host` takes exactly those two (`127.0.0.2`, `[::1]` and the rest are refused with
a message); `--allow-remote` is the one way to another address, and says what it costs. One
list feeds the `Host` allow-list and the `Origin` guard's idea of our own origin, so the two
cannot drift apart. Any other `Host` header (DNS rebinding) is 400.
It answers CORS **for extension origins only — a web page still cannot read a byte**, and two
rules keep a page from reaching `/score` in the first place: `POST /score` must be declared
`application/json` (parameters such as `; charset=utf-8` are fine, anything else or
nothing is 415), which forces a CORS preflight; and a request that carries an `Origin` must
carry an extension one (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`)
or the daemon's own (so `/docs` → "Try it out" keeps working) — everything else, `null`
included, is 403 with no CORS header, on the preflight as much as on the request, which is
what stops the POST from ever being sent. An extension origin gets that exact origin back in
`Access-Control-Allow-Origin` with `Vary: Origin` — no wildcard, no credentials — and its
preflight is answered `GET, POST` / `content-type` / a ten-minute `Max-Age`, plus
`Access-Control-Allow-Private-Network` when Chrome's private-network check asks for it.
The honest consequence: **an extension no longer needs a host permission to talk to this
daemon**, which is the point — the Anagram extension now installs asking for no host at all.
That is not a new door: any extension could already open one by declaring the permission,
and a web page's way in is no wider than it was.
A request with no `Origin` at all (curl, the `anagram` CLI, Node) is accepted as before.
Every request is then validated before anything is tokenized: `v` must be contract `2.x`,
≤ 256 blocks, ≤ 16 000 characters per block, ids unique and ≤ 64 characters. The 2 MB body
cap (413) counts the bytes that actually arrive, not the declared `Content-Length`, so a
chunked body cannot walk past it either. The limits are reported by `/health`.

**Language gate.** EditLens is English-only (model card `language: en`; every dataset
source in the paper is English). The daemon runs every block through fastText's
[`lid.176`](https://fasttext.cc/docs/en/language-identification.html) language
identifier first (`../models/lid.176.ftz`, ~1 MB — fetched by the installer, never by the
daemon); only blocks whose top label is `en` reach the model. Others come back as
`{unsupported: true, lang: "zh", lang_prob: 0.99}` with placeholder buckets, and the
extension shows an "Unsupported language" chip instead of a number. `/health`
reports `languages` and `lid`. The gate **fails closed**: if fastText or its model
cannot be loaded the daemon refuses to start; `--no-language-gate` turns it off
explicitly (logged, `lid: null` in `/health` — not advised). The extension also
pre-gates confidently non-English paragraphs with the browser's own detector, so
most of them never arrive here.

`bucket` is 0 = human, 1 = lightly AI-edited, 2 = heavily AI-edited, 3 = AI-generated.
`label_schema` names where those edges came from (`editlens-4bucket-cosine(0.03,0.15)`);
`calibration` carries the identical string under the older, wronger name — it describes the
classes, it is not a fitted calibration of the probabilities — and stays for every contract
2.x client written against it.
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
in `../docs/benchmarks/`. It is a developer tool, run by hand and by nothing else, and it
is not in the release tarball: its three extra packages (`peft`, `accelerate`, `psutil`)
are the `bench` extra, which the installer does not install, and it looks for its
checkpoints beside the repository rather than inside an installation. Like the daemon it
switches the Hub offline before importing it, so a checkpoint that is not on this disk is
an error naming it rather than a six-gigabyte download in the middle of a benchmark; pass
`--online` when fetching one is what you meant.
