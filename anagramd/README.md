# anagramd — local scoring component

The extension never runs a model in the browser. It uses browser Native Messaging
to start this local component, which loads **`pangram/editlens_roberta-large`** (EditLens, ICLR 2026,
CC BY-NC-SA 4.0 — non-commercial) and scores paragraphs on your machine.
Paragraphs and predictions stay on the machine. The default browser connection
uses framed stdin/stdout, with no listening TCP port. The optional HTTP daemon
remains available for development and diagnostics.

Install using the command on the extension's first-run page. The installer creates
the private Python environment and registers `dev.coderbak.anagram` for the browser.
The browser then starts `native_host.py --home INSTALLATION_DIRECTORY` automatically.
On the first connection it downloads and verifies all pinned model variants
(4.07 GB total) and the small language model, benchmarks this device, and waits for
an explicit runtime choice. No Hugging Face account or token is required.

Settings provides download pause/resume, model deletion, engine stop/resume,
benchmark reruns, runtime selection, and component update/removal. Pausing, stopping,
deleting models, and failed downloads are remembered: reconnecting does not override
those choices. Interrupted, unpaused downloads can resume verified partial files.
Stopping the engine releases its model after any current inference/load finishes.

**One browser connection per installation.** The native host holds an exclusive
installation lock for its lifetime. Another browser receives error code `busy`
(409), without starting downloads or loading another model. Close the first
browser's connection before connecting from another browser. Tabs in one browser
share the extension background's single connection.

Updates and removal report completion only after the trusted installer helper
confirms it. Windows uses a visible maintenance worker that waits for the host to
exit; its acknowledgement is `scheduled`, not `completed`. The extension therefore
does not claim completed removal or remove itself on that acknowledgement.

## Source development and optional HTTP daemon

```sh
# From the extension repository: install locked dependencies into anagramd/.venv.
(cd anagramd && uv sync --frozen)

# Public, anonymous, pinned modelkit: original weights + FP32/FP16/INT8 ONNX,
# shared tokenizer, validation reports and author/license notices (4.07 GB total).
anagramd/.venv/bin/python anagramd/download_modelkit.py --model-dir ../models/editlens_roberta-large

# fastText language model (~1 MB); verify the pinned digest before promoting it.
curl -fsSL -o ../models/lid.176.ftz.part https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz
anagramd/.venv/bin/python -c 'import hashlib,pathlib; p=pathlib.Path("../models/lid.176.ftz.part"); assert hashlib.sha256(p.read_bytes()).hexdigest()=="8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83"; p.replace(p.with_suffix(""))'

npm run serve
npm run test:daemon       # offline contract/security tests without model downloads
```

On first HTTP start the daemon exposes `/runtime` while it discovers runtimes and benchmarks
this device. Review `/runtime`, then post a candidate ID to `/runtime/config` to choose a
configuration. `/health` returns 503 until that configuration is ready to score.
An existing saved selection is reused on later starts; `--runtime-config PATH` selects its
JSON file (by default `runtime.json` beside the model directory).

The source workflow above uses Python 3.12 or 3.13. The committed lock currently provides
macOS 14+ Apple Silicon and Linux glibc 2.28+ x86_64/aarch64 wheels for PyTorch and ONNX
Runtime. It does not provide an Intel macOS or musl Linux installation. The default ONNX
Runtime package supplies CPU and platform-dependent providers; CUDA availability must be
checked at runtime rather than inferred from the presence of a GPU.

In an installed folder (`~/.anagram`, from `install.sh`), the browser owns the native
host lifetime. The legacy `~/.anagram/bin/anagram start|stop|status` commands control
the optional HTTP daemon. Its launcher passes
`--runtime-config ~/.anagram/runtime.json`, and `start` succeeds when the runtime control
server is listening, including while benchmarking or waiting for your choice. CLI `status`
explains those states; it does not report them as ready to score. `anagram doctor` verifies
all pinned modelkit files and the language model without changing them. Use browser
Settings for normal model repair and lifecycle operations. Do not run the HTTP daemon
and native host against the same installation concurrently; migration stops the owned
legacy process, and the native host refuses a live legacy PID.

## Offline

Inference uses local files only. The component sets `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`,
`HF_HUB_DISABLE_TELEMETRY` and `HF_HUB_DISABLE_IMPLICIT_TOKEN` before importing model
libraries, and disables ONNX Runtime telemetry. Model loading and benchmarking never
fetch files. The native lifecycle controller separately downloads pinned artifacts on
the first connection or when the user requests a download/repair. HTTP startup never
downloads models.

`download_modelkit.py` pins public repository `CoderBak/editlens_roberta_modelkit` to commit
`f7cb4b06e5067ecdb66c566c7982a413f86f569f` and verifies every file's size and SHA-256 against
`modelkit.json`. The native downloader uses anonymous HTTPS; the developer Hub downloader
uses `token=False`. Files arrive in a sibling staging
directory and are promoted only after complete verification, preserving an existing model
on download failure. The native path reuses verified installed/staged files and resumes
partial bytes with HTTP Range requests; ignored ranges safely restart that file. Pause
takes effect between reads, verification phases, or files, rather than interrupting an
in-flight filesystem or network call. The developer CLI can also reuse Hub-cached files.
Allow 4.07 GB for the modelkit,
additional space for dependencies, and temporary download space. `--check` verifies local
files without networking or changes. The model directory includes LICENSE, NOTICE and the
unchanged upstream model card. The INT8 variant remains experimental and is not eligible
for automatic selection based on its upstream numerical smoke-check failure.

## The served version

The served model version identifies the whole scoring pipeline, not just the weights.
Runtime-managed engines use `sha256:<weights digest>-p<pipeline digest>-runtime1`, with
the selected ONNX graph/external data or original weights, device, actual precision,
runtime/provider options, relevant package versions and implementation in the fingerprint.
The legacy direct engine uses
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

## Native Messaging API

Requests use a 32-bit native-byte-order byte length followed by UTF-8 JSON:
`{v:1,id:"request-id",op:"status",payload:{}}`. Replies correlate by `id` and have
`{v:1,id,ok:true,status:200,data:...}` or
`{v:1,id,ok:false,status:409,error:{code:"busy",message:"..."}}`.
Requests are capped at 2 MiB and replies below 1 MiB; diagnostics go to stderr.
Only fixed operations and their validated payloads are accepted. There is no arbitrary
filesystem path, shell command, or remote URL operation.

| Operation | Payload | Result |
| --- | --- | --- |
| `status` | `{}` | Component state, download progress, runtime snapshot, storage bytes, error, operation receipt |
| `health`, `score` | HTTP-equivalent payload below | Same health/scoring contract as HTTP |
| `runtime` | `{}` | Runtime snapshot |
| `runtime.benchmark` | `{budget_s?:10..30}` | Start comparison; 202 |
| `runtime.config` | `{id}` | Load and save a discovered candidate; 202 |
| `runtime.cancel` | `{}` | Request cancellation; 202 |
| `models.download`, `models.pause` | `{}` | Start/resume or pause pinned download; 202 |
| `models.delete` | `{confirm:true}` | Stop engine and delete owned models; 202 |
| `engine.stop`, `engine.resume` | `{}` | Release/reload selected engine; 202 |
| `component.update` | `{}` | Invoke trusted installed updater; 202 |
| `component.uninstall` | `{confirm:true}` | Remove owned component and registrations; 202 |

`status` remains responsive before heavy model imports and during inference, downloads,
or maintenance. `health` and `score` return `not_ready` (503) until the explicitly
selected runtime is active. Progress and lifecycle jobs are asynchronous: a 202 means
accepted, not finished. The `operation` field is null or contains `name`, `status`
(`running`, `completed`, `failed`, `scheduled`) and a completion `receipt`. Only a
completed uninstall receipt authorizes the extension's final self-removal flow.

The browser's registered Native Messaging manifest restricts allowed extension IDs.
The host validates its installation ownership marker and holds an OS file lock, and
maintenance helpers operate only on the owned installation and registered manifests.
Model deletion waits for active scoring leases; symbolic-link model trees are refused.

## Optional HTTP API

Served by FastAPI + uvicorn; request and response bodies are validated with pydantic, and
an interactive OpenAPI UI lives at `http://127.0.0.1:8765/docs`.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /health` | – | `{ok, app_version, model:{id,ver,calibration,label_schema}, n_buckets, buckets, languages, lid, max_tokens, limits, device}` |
| `GET /runtime` | – | Runtime state, candidates, benchmark progress/results and saved/active selection; available before scoring is ready |
| `POST /runtime/benchmark` | `{budget_s?}` | Start a bounded local comparison (202) |
| `POST /runtime/cancel` | `{}` | Request benchmark cancellation (202) |
| `POST /runtime/config` | `{id}` | Validate, load and save a candidate selected by the user (202) |
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
identifier first (`../models/lid.176.ftz`, ~1 MB — fetched and verified by the lifecycle
downloader); only blocks whose top label is `en` reach the model. Others come back as
`{unsupported: true, lang: "zh", lang_prob: 0.99}` with placeholder buckets, and the
extension shows an "Unsupported language" chip instead of a number. `/health`
reports `languages` and `lid`. The gate **fails closed**: if fastText or its model
cannot be loaded scoring remains unavailable while lifecycle controls report the error;
the developer HTTP option `--no-language-gate` turns it off
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

The runtime chooser's quick comparison uses a total measurement budget of 30 seconds
across valid candidates, with batch sizes 1 and 8 and fixed roughly 120-word English
samples. Load and warmup time are reported separately and add to wall time. Latency
includes cleaning, tokenization, model inference and score postprocessing; it excludes
the language gate and browser/transport overhead. Results show typical latency,
throughput and observed process memory; they are device-comparison measurements,
not accuracy estimates or percentile guarantees. FP32 is eligible for recommendation;
FP16 remains an explicit option and INT8 is explicitly experimental.

Model-free native tests run with `anagramd/.venv/bin/python test/native_host.py`.
`test/native-real.py` is an explicit subprocess smoke test accepting existing model and
Python paths; it uses a throwaway owned home, hardlinked weights and a network-blocking
test fixture, without registering a browser host or changing the user's installation.

`bench.py` measures load time, memory and throughput of the EditLens checkpoints on
this machine (`.venv/bin/python bench.py --json out.json`); it also drives the
`pangram/editlens_Llama-3.2-3B` LoRA adapter merged onto `meta-llama/Llama-3.2-3B`
(`train_head.py` holds the reference score head). Results for an Apple M4 / 24 GB are
in `../docs/benchmarks/`. It is a developer tool, run by hand and by nothing else, and it
is not in the release tarball: its extra packages (`peft`, `accelerate`)
are the `bench` extra, which the installer does not install; `psutil` also supports the
first-run benchmark and is a base dependency, and it looks for its
checkpoints beside the repository rather than inside an installation. Like the daemon it
switches the Hub offline before importing it, so a checkpoint that is not on this disk is
an error naming it rather than a six-gigabyte download in the middle of a benchmark; pass
`--online` when fetching one is what you meant.
