# Audit follow-up, September 21, 2026

## Unreleased: terminal-first model preparation, September 22

The installers now prepare device-selected model files after committing the private
runtime and exact browser registration. A failed model transfer leaves that runtime
installed and prints a download-only retry command. `bin/anagram download` shares
the browser's pinned staging/verification path, and takes the host lock when run alone.
Explicit pauses and removed-model preferences survive component updates.

Transfers use the locked Hugging Face library's HTTP retry/range implementation in a
separate process, with 60-second read timeout, durable guarded partial files, HTTPS-only
redirects, anonymous requests and final SHA-256 verification. The high-level Hub 1.31
downloader discards failed temporary files; the wrapper deliberately retains Anagram's
partial-file ownership instead. This path does not use Xet or a duplicate model cache.
Worker cancellation and loss of its parent pipe stop transfer without changing the
inference process's offline settings. Browser errors open their details automatically;
the most recent failure reason survives reconnection.

Local checks: 44 installer checks, 25 modelkit tests, 9 actual HF transport tests with
mock HTTP responses, 4 terminal preparation tests, the backend suite, 38 targeted Node
tests, TypeScript and Chrome build passed. The isolated English/Chinese browser checks
include visible failure details and retry notices. Live HTTPS checks downloaded and
hashed two tiny HF files plus the language model; a weight transfer was interrupted at
1 MiB and resumed to 2 MiB. An isolated terminal run reused verified full model files,
detected CPU/MPS, saved preparation state and repeated without network or inference.
No user's installed files were replaced and no GitHub workflow was started. Windows
installer integration was updated in source but has not been executed on Windows.

Implementation follows the review of `56abeee`. Independent detector-quality research
is deferred by the project owner. Numerical conversion parity and pipeline correctness
remain release engineering checks, without stronger accuracy claims.

## Implemented

- Validate/authorize worker messages by caller role before hashing or allocating work.
- Frame/document/session-bound analysis; revoke affected work and discard late results.
- Reader-bound PDF tickets, stale-navigation rejection, 64 MiB aggregate raw-byte limit,
  at most two transfers, strict chunks and acknowledgments.
- Idempotent canonicalization, versioned cache identity, full model provenance, expiry
  at lookup, and epoch-aware reads/clears/queued persistence.
- Truthful cache deletion failures and a memory-only cache preference.
- Serialize cache preference changes and fail back to memory-only mode when applying
  or saving fails; report the actual mode. Unwritable settings cannot promise that
  this fallback survives a worker/browser restart, so the UI explicitly requires retry.
- Bounded/fair queues, per-document limits, cancellation preserving other consumers.
- Per-candidate benchmark subprocesses, separate hash/load timing, sample counts,
  insufficient-sample labels, explicit memory scope and FP32/fastest distinction.
- Configurable idle unload; status polling does not keep a model loaded; explicit stop
  remains stopped. Previous benchmark reports are invalidated when methodology changes.
- Remove the unevaluated quality column; explain the normalized expected class index.
- Plain-text input/file import, coverage, technical report metadata, opt-in text/URL
  export, clearer automatic-analysis controls and bilingual reviewer instructions.
- Report privacy switches acknowledge storage writes and revert visibly on failure.
- Preserve the native maintenance lock through installer children and failed/killed
  parent processes; revoke the installation marker before removal begins.
- Prepare a device-aware recommended model set on first setup, followed by the short
  benchmark and explicit configuration selection. Expanded compatible runtimes and
  experimental CPU INT8 require a separate download action; verified files are reused.
- Pin existing Actions dependencies to verified immutable commits; check packaged ZIP
  permissions/CSP/assets locally. No GitHub workflow is enabled or invoked by this work.

## Measurements and validation

Measurements use the owner's Apple M4 MacBook with 24 GiB memory. The
[conversion/extraction report](benchmarks/setup-extraction-m4-2026-09-21.md) includes
reproducible scripts, raw samples and artifact hashes. Client-side conversion took
22.84 seconds plus 13.83 seconds of parity checks; INT8 reproduced its previously
documented parity failure. This does not change installer defaults. The 1,000-comment
fixture exposed a useful next DOM performance target; ordinary article extraction
remained sub-millisecond in this controlled fixture run.

The [MPS/CoreML/MLX comparison](benchmarks/apple-m4-2026-09-21.md) records all measurements,
including repeated-reference drift and failed initial MLX loading attempts. CoreML FP16
was faster in the measured shapes, but ORT CoreML startup cost and static-shape/cache
management need separate engineering before production integration. The current MLX
adapter does not justify replacing MPS across workloads.

The earlier [real Native Messaging smoke](benchmarks/native-m4-2026-09-21.json), before
device-aware download defaults, reused existing verified weights in a temporary
installation with network downloads blocked. All six then-tested production candidates
completed both workloads in isolated processes (12 successful
rows). First status took 49 ms; first setup took 59.35 s, including 30.67 s of measured
inference. Explicit FP32 selection, scoring, unsupported-language handling, exclusive
ownership, stop/resume and restart without rebenchmark all passed. Restart took 5.63 s.
These timings include production preprocessing and differ from the pretokenized Apple
backend comparison.

The subsequent device-aware setup smoke (`test-results/native-selective-m4.json`) used
only the recommended source-weight files: 1,427,320,559 bytes including language detection.
Torch CPU FP32 and MPS FP32/FP16 completed six workload rows. First status took 51 ms;
setup took 39.208 s, including 22.550 s of measured inference; restart took 3.767 s.
This also used a temporary installation with network downloads blocked. It verifies
partial-weight setup and does not measure real download time.

Strict TypeScript validation and all 42 Node test files passed: 515 tests passed and
one existing TODO remains. Offline backend tests (27 engine checks, 30 runtime tests and 30 native-host tests) and
the 33-check installer suite passed on this Mac. Native registration coverage includes
19 tests. Windows-specific C# was compiled locally, but Windows execution and Linux
execution were not performed. No remote CI or workflow was started.

Final local browser checks passed: runtime selection, plain-text input, PDF handoff
(27/27), bilingual native lifecycle UI and CSP (18/18). Chrome and Firefox shipping
builds both succeeded, and their actual ZIPs passed the permissions/CSP/asset verifier.
Interactive tests used isolated Chromium profiles on this Mac. Firefox was built and
its ZIP inspected, but its interactive browser suite was not run. Artifacts and logs
are in `test-results/audit-package/` and `test-results/audit-*.log`.

The download-plan follow-up additionally passed TypeScript validation, 67 focused Node
tests (four existing conditional skips), and a fresh Chromium build. The isolated
English/Chinese browser check passed detection/verification progress, explicit expanded
and recommended actions, profile-preserving resume, older-component compatibility,
safe text rendering, light/dark accessibility and 400 px layout. Its fixture screenshots
and log are in `test-results/download-plan/`; these are not model-performance measurements.

These checks used isolated installations; no existing user installation was replaced.

The selective-download follow-up also passed an ONNX-only CPU Native Messaging smoke
on this Mac with GPU access unavailable in the test sandbox. Only the recommended
ONNX FP32 graph and shared assets were present; safetensors and other ONNX variants
were absent. The 1,427,717,912-byte plan completed both workloads, explicit selection,
scoring, stop/resume and restart without network access. Its report is
`test-results/native-selective-cpu.json`. This tests the CPU path locally, not Windows
or Linux execution. The profile-migration regressions bring native-host unit coverage
to 37 passing tests; model planning has 14 and selective modelkit installation has 23.

`scripts/benchmark-conversion.py` reuses the modelkit's existing converter and parity
fixtures. `scripts/benchmark-apple.py` uses the same source classifier across backends;
research dependencies and generated weights/caches stay outside the shipping package.

## Deliberately unchanged or deferred

- Keep Native Messaging, without an HTTP service or shared multi-browser daemon.
  The subsequent PDF.js integration adds `webNavigation` and `webRequest` for authorized
  PDF routing, plus optional local-file access; website access remains optional.
- No automatic client-side conversion or CoreML/MLX production backend until measurements
  justify its installation, parity and maintenance costs.
- A keyed cryptographic cache digest needs a separate asynchronous key/migration design;
  current unsalted hashes are described honestly and memory-only storage is available.
- Navigation and permission withdrawal cancel document work. A same-document stop or
  rescan also discards late page results, but interrupting already-dispatched work for
  that scan would need a separate scan generation without revoking document permission.
- No independent accuracy/calibration study, commercial-license claim, or signed
  graphical installer. Authentic release signing requires an actual publisher trust
  root; SHA-256 checksums alone do not provide it.

## Full PDF.js integration and Mac release

The reader now packages Mozilla's complete generic PDF.js 5.7.284 viewer, with pinned
upstream hashes and local executable/font/decoder assets. It supports search, outlines,
thumbnails, rotation, password-protected files, printing and downloading. Optional PDF
takeover operates on authorized sources; local picking/dropping works without granting
all local files. Network restrictions and setup/update/document-fetch exceptions are
documented in [network privacy](network-privacy.md).

Local validation after this integration: TypeScript and 535 Node tests passed (one
existing table-reflow TODO). Chrome PDF routing passed 26 checks, CSP 17, and bundled
decoder rendering five. Isolated Chrome and Firefox viewer/source tests exercised
offline reading, search, passwords, original bytes and unavailable-engine behavior.
Chrome installation UI was checked in English and Chinese, including the browser's
local-file switch. Native permission prompts and actual OS print dialogs still require
manual testing. Both shipping ZIPs passed artifact-level permissions/CSP checks.

The Mac test release retains partial analysis: rendered pages among the first 300 can
be scored, while the complete PDF remains readable. Refreshing a reader may require
reopening the original file. The following scheduling work is intentionally deferred.

## Next TODO: follow reading with bounded work

- [ ] Make following the current reading area the default for both webpages and PDFs.
  Admit text after a short dwell (initial tuning range 600–1,000 ms), use scroll-speed
  hysteresis to suppress work while seeking, and discard queued work that leaves the
  relevant area. Recheck visibility, text version and authorization before dispatch.
- [ ] Bound discovery, extraction, queued tokens, retained DOM references and results
  independently. Keep a small directional lookahead and fair global/per-document
  budgets; pause hidden documents. Already-running inference may finish, but scrolling
  through 1,000 pages must not create a 1,000-page inference backlog.
- [ ] Replace the first-300-pages analysis cutoff with a bounded active-page budget so
  any page can be analyzed when read. Keep compact cached results separate from recycled
  PDF.js page views; do not claim that PDF source bytes or image decoding use constant
  memory.
- [ ] Add incremental conversation capture with stable message/window identities and
  streaming-text stabilization, preserving speaker boundaries. Avoid a full synchronous
  document scan before viewport filtering.
- [ ] Offer explicit quick sampling with a fixed window budget: useful opening/closing
  body passages plus a few distributed locations when appropriate. Prefer recent/current
  turns for chat. Bound the search for useful text too, and show sample positions and
  coverage without presenting them as a whole-document verdict.
- [ ] Make full-document analysis an explicit, cancellable, bounded streaming operation
  with progress and pause/resume, rather than an unbounded idle prefetch.
- [ ] Validate long streaming chats and 1,000–3,000-page text/image PDFs: fast seeking,
  returning to an earlier page, multiple windows, hidden tabs, cancellation and retained
  memory. Measure the viewer baseline separately from Anagram's additional work.

Reuse PDF.js's [visible-first rendering queue](https://github.com/mozilla/pdf.js/blob/v5.7.284/web/pdf_rendering_queue.js).
Borrow fast-scroll hysteresis from [Virtuoso](https://virtuoso.dev/react-virtuoso/virtuoso/scroll-seek-placeholders/)
and viewport/work-budget ideas from [CodeMirror](https://codemirror.net/docs/ref/).
Evaluate [p-queue](https://github.com/sindresorhus/p-queue) only for queue primitives;
Anagram must retain its authorization, cancellation, deduplication and fairness rules.
The dwell/window figures are starting points for measurement, not validated defaults.

## Release 0.5.0 filesystem follow-up, September 22

[Filesystem audit](filesystem-audit.md) records the actual installation/runtime/export
footprint, reproduced link-write defects, fixes and remaining recovery/concurrent-custom-home
limitations. Native runtime state uses bounded reads and random atomic replacement;
download partials reject aliases; installers coordinate with the host and preserve foreign
files on refusal. Known dependency caches are configured in the actual inference process.

The Mac installer now uses the locked `fasttext-predict` wheel and forbids source builds.
A fresh isolated CPython 3.12.13 runtime installed successfully with `uv sync --frozen
--no-dev --no-build`; ten language-gate inputs matched the previous fastText package exactly.
The shipped EditLens/modelkit weights and their licenses are unchanged.

Final local release checks: 533 Node tests passed, two checks for an outdated all-granted
test build were skipped, and the existing table-reflow TODO remains. Shipping Chrome and
Firefox package permission/CSP checks passed. Installer checks: 42; registration: 24;
native/runtime/modelkit/engine/network policy: 131. Windows script changes were source
reviewed and embedded C# compiled locally; no PowerShell or Windows execution was available.

The final real-model smoke used that newly installed runtime, a temporary owned home,
existing verified model files and blocked model downloads. First status took 47 ms;
device discovery/preparation/comparison took 43.349 s; restart with the saved MPS FP32
selection took 3.994 s. Scoring, language rejection, stop/resume, peer exclusion and
restart without rebenchmark passed. The raw local report is
`test-results/release-0.5.0-native-real.json`; it is not a download-time measurement.
