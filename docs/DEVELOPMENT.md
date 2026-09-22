# Development handoff

Updated September 22, 2026. This document and the linked source/reports are sufficient
to continue development without the earlier conversation or the author's machine.
The prioritized backlog is [ROADMAP.md](ROADMAP.md); implementation and historical
validation are in [audit-followup.md](audit-followup.md).

## Checkout versus release

- Work on `dev`. Published **v0.5.0** is commit
  `f5dec0e4ee7d91574765106636dfd0b3521b74f4`; its assets are at
  [the release page](https://github.com/CoderBak/anagram/releases/tag/v0.5.0).
- The terminal-first downloader changes following that commit are **unreleased**.
  Package/installer version strings still say 0.5.0. The public v0.5.0 installation
  command fetches the older component, even when copied from a newly built checkout.
- Do not replace public v0.5.0 assets silently. A subsequent authorized release
  should bump all versions using `scripts/bump.mjs`, build matching assets, inspect
  them and publish with truthful platform-validation notes.
- Pushing source does not update a loaded unpacked extension, an installed native
  component or a GitHub release. `npm run release` only produces local `dist/` files.
- GitHub's `ci` workflow was manually disabled during the owner's Mac-focused work.
  Its YAML still has push/PR/manual/reusable triggers; the tag-release workflow calls
  its full matrix. Check remote state rather than assuming it is unchanged. Ordinary
  development commits use `[skip ci]`; do not trigger or re-enable paid matrices or
  push a version tag merely to publish source changes.

## Product decisions

- The browser starts a per-user Native Messaging host over stdio; no HTTP listener
  or daily terminal-managed server. Tabs/windows in one browser profile share it.
  One component home is owned exclusively by one host; a multi-browser daemon is deferred.
- First setup installs a private runtime, detects working devices, downloads the
  recommended model files, then returns to the extension for a short benchmark and
  explicit configuration choice. Manual selection and rerunning the benchmark exist.
- Keep `CoderBak/editlens_roberta_modelkit` at the shipped revision in
  `anagramd/modelkit.json`. No new weight variants/uploads are planned in this iteration.
  A working Torch GPU shares source safetensors across CPU/GPU FP32 and GPU FP16;
  CPU-only prefers ONNX FP32. About 1.43 GB is the recommended model set, not total
  installation space. Expanded compatible models require an explicit action.
- Preserve Pangram attribution and **CC BY-NC-SA 4.0**. Public modelkit downloads
  need no account/token. FP32 remains the recommendation, FP16 optional and INT8
  experimental. Keep numerical parity/pipeline checks; independent quality research,
  stronger quality claims, CoreML/MLX production integration and local conversion are deferred.
- Keep the complete packaged PDF.js viewer. Optional automatic takeover respects
  source permissions; local picking/dropping does not require access to every file.
  Do not try to inject into protected built-in browser PDF viewers.
- Follow-reading scheduling is approved next work, **not implemented yet**. Current
  PDFs can be read completely, but only rendered pages among the first 300 are analyzed.

## Latest download change

`install.sh` / `install.ps1` now commit the runtime and exact browser registration
before invoking `prepare_models.py`. A network failure must not roll that committed
runtime back. The installer retains its lock during preparation. Standalone
`bin/anagram download` obtains the normal host lock; close the browser's component
connection before running it. Explicit pauses/model deletion survive updates.

Both terminal preparation and Settings use `download_modelkit.py` for pinned file
selection, staging, safe partial-file ownership, SHA-256 verification and atomic
promotion. `hub_transfer.py` runs the locked HF library's `file_download.http_get`
in a child process with HTTPS-only redirects, anonymous headers, retries and bounded
progress messages. Inference's offline environment is not relaxed. This is **not**
an invocation of `hf download`, and does not enable Xet or duplicate model caches.

Why this adapter exists: the installed Hub **1.31.0** high-level downloader creates
unique temporary files and discards them on failure. Its HTTP transport can resume
from an existing open file. We retain Anagram's guarded `.part` handle and delegate
network/range/retry handling to that transport. This is a dependency-sensitive API;
retain `test/hub-transfer.py` when upgrading the Hub library. Server refusal of Range
can still require restarting that file; full-size hash failures discard corrupt partials.

The worker's parent pipe closes on parent death, ending the transfer. UI retries share
the same files/lock. Errors appear expanded in the UI and the latest reason is saved
in `download-error.json` under the component home. CDN signed URL query strings are
removed from transfer diagnostics. Do not promise all failures are transient or resumable.

## Source map

| Area | Starting points |
| --- | --- |
| Manifest, browser builds and CSP | `wxt.config.ts`, `scripts/verify-release.py`, `scripts/release.mjs` |
| Background authorization / website access | `entrypoints/background.ts`, `lib/access/worker.ts`, `lib/backend/nativeBridge.ts` |
| Page capture, segmentation and scheduling | `lib/capture/`, `lib/dom/`, `lib/capture/orchestrator.ts`, `lib/capture/scheduler.ts` |
| Scoring routing and cache | `lib/backend/router.ts`, `lib/backend/swCache.ts` |
| Full PDF viewer and source authorization | `entrypoints/reader/`, `lib/pdf/`, `vendor/pdfjs/5.7.284/` |
| Native wire protocol / ownership | `anagramd/native_host.py`, `anagramd/native_component.py`, `lib/backend/nativeProtocol.ts` |
| Device and model planning | `anagramd/model_plan.py`, `anagramd/modelkit.json` |
| Download / terminal preparation | `anagramd/download_modelkit.py`, `anagramd/hub_transfer.py`, `anagramd/prepare_models.py` |
| Inference and benchmark isolation | `anagramd/engine.py`, `anagramd/scoring.py`, `anagramd/runtime_controller.py`, `anagramd/runtime_adapters.py`, `anagramd/benchmark_worker.py` |
| Installation / update / cleanup | `install.sh`, `install.ps1`, `installer/anagram`, `installer/native_registration.py`, `installer/maintenance.ps1`, `anagramd/safe_files.py` |
| Setup / settings and localization | `lib/ui/componentSettings.ts`, `lib/ui/runtimeSettings.ts`, `public/_locales/en/`, `public/_locales/zh_CN/` |

## Local checks from a fresh clone

Use Node 22+ and Python 3.12/3.13. Build before running browser tests; shipping and
all-granted test builds are different artifacts. Select checks relevant to the change.

```sh
npm ci
npm run typecheck
npm run build
npm run test:node
npx playwright install chromium
node test/download-plan.mjs
node test/native-browser.mjs
```

For backend/installer checks without Torch, model weights or a real registration, use
a disposable virtual environment. The exact HF version matches the production lock:

```sh
python3.12 -m venv /tmp/anagram-checks-venv
/tmp/anagram-checks-venv/bin/python -m pip install numpy 'pydantic>=2' emoji filelock psutil 'huggingface_hub==1.31.0'
ANAGRAMD_PYTHON=/tmp/anagram-checks-venv/bin/python npm run test:backend
/tmp/anagram-checks-venv/bin/python test/modelkit.py
/tmp/anagram-checks-venv/bin/python test/native_registration.py
npm run test:installer
```

Use a fresh temporary venv path if that example directory already belongs to other
work. Dependency installation uses the network; the tests themselves use fixtures.
For actual inference, `(cd anagramd && uv sync --frozen)` installs the larger locked
runtime, not weights. `test/native-real.py` accepts explicit existing verified model
and language-model paths, creates a temporary installation and blocks downloads.
See [anagramd/README.md](../anagramd/README.md) and [manual checks](manual-checks.md).

Do not use the author's `~/.anagram`, browser profiles, `../modelkit-work`, `../wt`,
`test-results/` or temporary logs as required inputs. They are local state, not a
portable dependency. Installer tests use fake homes and tiny transfers; their results
do not establish download reliability across networks or Windows runtime support.

## Evidence and limitations

The latest download change passed 44 installer checks, 25 modelkit tests, 9 real-HF-
transport tests with mocked HTTP, 4 terminal tests, the backend suite, 38 targeted Node
tests, typecheck, Chrome build and isolated English/Chinese download UI checks on Mac.
Live tests downloaded/hashed two tiny HF files and the language model; weight transfer
was interrupted at 1 MiB and resumed to 2 MiB. Terminal preparation reused verified
full model files in an isolated home, discovered CPU/MPS and repeated without downloading
or running inference. This was not a fresh complete 1.43 GB network-download test.

Windows script integration is source-only for this change. No Linux or Windows real
installation has been validated by the Mac checks, and no remote CI was started.
Generated `test-results/` and temporary logs are intentionally not committed; the
test source and this summary are the portable record. Historical test counts below
different sections of `audit-followup.md` belong to different snapshots.

Tracked performance reports, methods and raw sanitized JSON live in
[docs/benchmarks](benchmarks/). Start with
[MPS/CoreML/MLX on M4](benchmarks/apple-m4-2026-09-21.md) and
[conversion/extraction](benchmarks/setup-extraction-m4-2026-09-21.md).
These are workload-specific measurements, not blanket backend rankings or quality claims.

For file ownership/recovery restrictions, read [filesystem-audit.md](filesystem-audit.md).
For privacy promises and their limits, read [network-privacy.md](network-privacy.md),
[footprint.md](footprint.md) and [PRIVACY.md](../PRIVACY.md).
