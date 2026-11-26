# Anagram local component

The browser launches `native_host.py --home INSTALLATION_DIRECTORY` through Native
Messaging: length-prefixed JSON on stdin/stdout, no HTTP server or separate daemon. One
host owns one installation. The installer registers `dev.coderbak.anagram`
for the exact extension ID and prepares the selected [Anagram detector](https://huggingface.co/CoderBak/anagram-detectors)
and fastText language identifier. The component runs the FP32 encoder and CRF locally using ONNX Runtime on the CPU.
The terminal command `anagram download` resumes preparation for the selected commit.
Settings can switch the model independently of the component version.

## Operations

| Operation | Effect |
| --- | --- |
| `status`, `health`, `runtime` | Component, engine and runtime snapshots; never wait for a load |
| `score` | Score up to 256 blocks with the ready engine (wakes an idle one) |
| `tokens {texts}` | Count up to 512 cleaned texts' tokens without special tokens, `alone` and `following` a space, and one pass's `window`; runs beside scoring (wakes an idle engine) |
| `runtime.config {id}` | Switch to an available candidate and persist it |
| `runtime.benchmark {budget_s}` | Measure available candidates in isolated processes; keeps the selection |
| `runtime.cancel` | Cancel the running load or measurement |
| `models.select {release}` | Install a dated release pinned to its commit and file hashes |
| `models.download`, `models.pause`, `models.delete {confirm}` | Prepare, pause or remove model files |
| `engine.stop`, `engine.resume`, `engine.settings {idle_unload_s}` | Persistent stop/resume and idle unloading |
| `component.update {version?}`, `component.uninstall {confirm}` | Maintenance through the trusted helper; an update names the extension's release |

Requests never carry paths, commands or URLs. Validation failures are `422`; host
failures are `500 internal_error`.

## Tests

```sh
ANAGRAMD_PYTHON=/path/to/venv/bin/python npm run test:backend   # fixtures only, no weights
/path/to/venv/bin/python test/modelkit.py
anagramd/.venv/bin/python test/native-real.py --python "$PWD/anagramd/.venv/bin/python" \
  --model-dir /path/to/editlens_roberta_modelkit --lid-model /path/to/lid.176.ftz
```

The real-model smoke test links existing verified weights into a temporary installation,
blocks downloads and exercises automatic selection, scoring, stop/resume and restart.
