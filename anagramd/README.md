# Anagram local component

The browser launches `native_host.py --home INSTALLATION_DIRECTORY` through Native
Messaging. Requests and replies are length-prefixed JSON on stdin/stdout. There is no
HTTP server, listening port or separately started inference daemon.

The setup-page installer creates a private Python environment and registers
`dev.coderbak.anagram` for the exact browser extension ID. Normal operation, downloads,
benchmarks and cleanup are managed in the extension.

## Models and runtime selection

The component anonymously downloads the pinned
[EditLens modelkit](https://huggingface.co/CoderBak/editlens_roberta_modelkit), verifies
file sizes and SHA-256 hashes, and stages replacements before committing them. Device
discovery selects a recommended set, usually about 1.43 GB including the separately
verified fastText language model. A working Torch GPU uses shared safetensors for CPU
FP32 and GPU FP32/FP16; CPU-only systems use ONNX FP32 when available, otherwise Torch FP32.
No Hugging Face token is required.

Settings shows the detected devices, file list and selected total. Preparation bytes
include verified files already on disk, not only network transfers. The saved profile
survives pause/resume and restart. Explicit expanded comparison adds compatible runtimes
and experimental CPU INT8; it does not add CPU ONNX FP16, CoreML or MLX. Returning to
recommended redetects devices without deleting existing extras. The pinned repository's
complete weight variants total about 4.07 GB; this is not the first-install download.

The original Pangram model's **CC BY-NC-SA 4.0** license and attribution remain applicable.
INT8 is experimental; conversion parity reports do not establish task accuracy.

On first setup, device discovery and benchmarking precede an explicit user selection.
The shared measurement budget is 30 seconds; initialization, file verification, loading
and warmup are separate. Each configuration runs in a fresh process. Reports include
batch-one latency, batch-eight throughput, sample counts and sampled memory use where
supported. FP32 recommendation and measured fastest are distinct. Recommendations do
not silently choose a quantized model. Subsequent launches reuse
a compatible saved selection. Benchmark inputs are built-in examples, not browsing text.

Inference loads local files with Hugging Face offline mode. Missing or incompatible
weights produce a recoverable error rather than an inference-time download.

## Implementation

| File | Responsibility |
| --- | --- |
| `native_host.py` | Bounded stdio framing, validated operations and request correlation |
| `native_component.py` | Model download, native lifecycle and maintenance controls |
| `engine.py` | Text validation, preprocessing, language identification and scoring |
| `runtime_controller.py` | Device selection, benchmark state and saved configuration |
| `runtime_adapters.py` | PyTorch/ONNX execution and model provenance |
| `benchmark_worker.py` | Isolated, cancellable per-configuration measurements |
| `download_modelkit.py` | Anonymous, resumable downloads and pinned integrity checks |
| `model_plan.py` | Device-aware recommended/expanded file plans and candidate filtering |
| `modelkit.json` | Repository revision, files and hashes |

One host owns an installation at a time. Tabs and windows in the same browser profile
share it; another browser/profile receives `busy` without loading a second model.
Management requests do not accept arbitrary paths, commands or download URLs.

The native process has ordinary user privileges. Browser registration restricts extension
callers but is not protection against malware with access to the same user's files.
Normal diagnostics omit page text; unexpected dependency errors require separate review.

## Development and validation

From the extension repository:

```sh
(cd anagramd && uv sync --frozen)
npm run test:backend
npm run test:installer
npm run test:native
```

The first two suites use temporary owned folders and fixtures; they do not download the
model or alter real browser registrations. Browser fixture tests verify the Native
Messaging UI flow separately from model accuracy and performance.

For a real-model smoke check with existing, verified weights:

```sh
anagramd/.venv/bin/python test/native-real.py \
  --python "$PWD/anagramd/.venv/bin/python" \
  --model-dir /path/to/editlens_roberta_modelkit \
  --lid-model /path/to/lid.176.ftz
```

This creates a temporary installation, links existing model files and blocks downloads.
It exercises benchmark/selection, scoring, stop/resume, restart and exclusive ownership.
The model path must be on the same filesystem as the temporary directory for hardlinks.

The optional research comparison `bench.py` and its `train_head.py` helper stay in source,
not installed releases. Run it from `anagramd/` after `uv sync --extra bench`, with
checkpoints in `../../models/`. It uses local weights unless `--online` is specified.
Historical measurements are in `../docs/benchmarks/`; they are not universal latency promises.

## Stored files and removal

The installation owns its runtime, weights, download staging, selected runtime,
benchmark report and registration inventory. User-level native-host manifests live at
browser-specific locations; Windows also uses an HKCU registration pointer.

Pause, stop and model deletion are persistent user choices. Reconnecting does not undo
them. Idle unloading defaults to five minutes and can be changed in Settings; unlike
explicit Stop, it reloads on the next scoring request. Status polling does not reset
the inactivity timer. Component updates and removal are complete only when their maintenance receipt
confirms success. Windows schedules a visible worker until open files are released;
`schedule` acknowledgement is not proof of completed removal.

Use Settings for cleanup. Removing only the extension does not remove the native component.
Exact paths and lifecycle instructions are in the [user guide](../docs/user-guide.en.md)
and [footprint](../docs/footprint.md).
