# Anagram roadmap

Updated September 22, 2026. Read [DEVELOPMENT.md](DEVELOPMENT.md) first for release
state and product decisions. This is an outstanding-work list, not a claim that all
ideas have been approved for immediate implementation. Stable IDs support later PRs.
Update statuses and acceptance evidence here as work lands.

Already implemented: message authorization; document/frame permission invalidation;
canonicalization fixes; cache expiry/clear generations and model provenance; bounded
backend queues; isolated runtime comparisons; optional memory-only caching; plain-text
analysis; full PDF.js; device-selected downloads; bilingual setup. The unreleased
terminal-first HF transport and download-only recovery are also implemented. Do not
reintroduce these as missing features. Details: [audit-followup.md](audit-followup.md).

## Recommended next implementation order

1. A1–A5: installation preflight and recovery.
2. B1–B5 with C1–C2: bounded work that follows reading and retains useful results.
3. PDF extraction/large-file behavior, runtime footprint and clean-machine testing.
4. Store preparation and broader validated platform support.

## A. Installation, upgrade and removal

| ID | Status | Work and acceptance evidence |
| --- | --- | --- |
| A1 | Open | Check browser registration conflicts before large dependency downloads. Report the exact conflict without replacing another installation. |
| A2 | Open | Distinguish owned upgrades, orphan registrations and foreign/modified registrations. Add a backed-up, verifiable orphan-repair flow. A local orphan was manually backed up during development; that is not an implemented product recovery feature. |
| A3 | Confirmed defect | Make interrupted uninstall retryable using a non-startable retiring state. Inject deletion failure after ownership revocation; retry cleanup without restoring execution permission to a partly deleted component. |
| A4 | Confirmed defect | Serialize the shared user/browser registration across different custom component homes. Two homes must not both report success after racing the same manifest/key. |
| A5 | Open | Recover stale installer barriers and staging/rollback directories with provenance and live-process checks. Cover forced exits and child-process lifetime, especially on Windows. Never blindly remove locks or foreign files. |
| A6 | Partial | Per-file download disk checks exist. Add early whole-install disk requirements including runtime, weights, temporary files and rollback; report OS/architecture/path problems before expensive work. |
| A7 | Partial | Terminal preparation, official HTTP retries, durable partials and a download-only command now exist. Improve dependency reuse and cache-cleanup timing after registration failures; keep clear repair choices without defaulting to reinstall/re-download. |
| A8 | Open | Define extension/component protocol compatibility and migration UX, including unpacked-ID changes, store-ID migration and failed-update rollback. Maintain exact origin ownership checks. |

Evidence for A3/A4 and filesystem limits: [filesystem audit](filesystem-audit.md).
Native code has ordinary user OS privileges; no-admin installation is not an OS sandbox.
Whole-home uninstall currently removes everything inside the validated dedicated home,
including user files placed there. Consider unexpected-file/mount-point checks and clear
cleanup previews; do not promise deletion of OS/browser caches or external downloaded ZIPs.

## B. Reading policy and long conversations — approved next feature

| ID | Status | Work and acceptance evidence |
| --- | --- | --- |
| B1 | Open | Make current-reading analysis the default. Start with 600–1,000 ms dwell experiments; allow slow continuous reading rather than requiring a complete scroll stop. |
| B2 | Open | Suppress inference while fast scrolling with velocity hysteresis. Scanning through 1,000 pages must not create a 1,000-page backlog. |
| B3 | Partial | Navigation/revocation cancellation exists. Add same-document scan generations and drop queued work after stop, rescan, content change or loss of reading relevance. An executing accelerator kernel may finish; stale results must not appear. |
| B4 | Open | Bound discovery time, extraction, retained DOM references, queued tokens and results separately. Use small directional lookahead, foreground priority and fair multi-window budgets; pause hidden documents. Existing backend queue caps are not enough. |
| B5 | Open | Incrementally capture long/streaming chats with stable message/window identities and text stabilization. Avoid a synchronous whole-document scan before viewport filtering. |
| B6 | Open | Improve grouping of short neighboring paragraphs within the same semantic message/section, preserving source spans. Do not combine unrelated posts, authors or chat roles merely to reach a length threshold. |
| B7 | Open | Add explicit bounded quick sampling: useful body opening/closing passages plus a few distributed locations; recent/current turns for chats. Bound the search for samples, show positions and coverage, and do not describe a sample as a whole-document verdict. |
| B8 | Open | Make full-document analysis an explicit bounded streaming operation with progress, pause and cancellation, replacing implicit repeated idle prefetch through the entire document. |

Borrow visible-first rendering from PDF.js and fast-scroll hysteresis from Virtuoso.
Evaluate queue primitives only if they simplify the implementation; retain authorization,
deduplication and consumer cancellation. Do not introduce a React virtualization stack
into third-party page DOM. Dwell and sample counts are tuning proposals, not validated defaults.

## C. PDF reliability

| ID | Status | Work and acceptance evidence |
| --- | --- | --- |
| C1 | Open | Replace `MAX_ANALYSIS_PAGES = 300` with a bounded active-page budget. Reading page 900 must allow analysis there without processing preceding pages. |
| C2 | Open | Separate compact analysis results from recycled PDF.js page views. Returning to a page restores results; reports retain completed coverage within an explicit bounded cache policy. |
| C3 | Open | Restore/reopen the reader safely after refresh. Reauthorize network sources as needed; explain local re-selection when the browser cannot restore access. Do not silently retain raw PDFs/passwords. |
| C4 | Open | Investigate range/chunk/Blob reading and image-memory limits. Current automatic/picker limits are 50/100 MiB and source bytes are loaded as a whole; render virtualization alone does not bound all memory. Do not just raise file limits. |
| C5 | Open | Add complex-layout/source-map fixtures: columns, tables, hyphens, repeated headers/footers, references and math. Resolve the existing table-reflow test TODO. |
| C6 | Open | Give PDF.js reading history/preferences explicit retention and clearing controls. Score-cache clear and memory-only scoring do not currently clear `pdfjs.history`. |

## D. Runtime/download efficiency

| ID | Status | Work and acceptance evidence |
| --- | --- | --- |
| D1 | Open | Evaluate separate runtime dependency packs, so ONNX-only users need not install Torch. Weight selection already exists; lightweight hardware detection and dependency planning must precede this change. |
| D2 | Partial | Setup already separates preparation/load/warmup/measurement and exposes low sample counts. Tune the short benchmark budget and first-result time without presenting 30 s of inference as 30 s total installation. |
| D3 | Open | Profile extraction, tokenization, queue wait, forward pass, transport and presentation independently. Optimize demonstrated bottlenecks before replacing tokenizer/backend libraries. |
| D4 | Open | Tune CPU threads and batch/token budgets against latency, throughput and browser responsiveness; include low-memory and background workloads. |
| D5 | Validation needed | Exercise OOM, unavailable GPU, model-load failure and sleep/wake recovery. Report the actual backend and preserve explicit precision choices rather than silently switching quantization. |
| D6 | Partial | Methodology changes already invalidate old reports. Review invalidation across hardware/runtime/model changes, explain results as machine-specific observations, and preserve manual selection. |

Keep current HF files and their license/attribution. No FP8 default, automatic INT8
recommendation or automatic local conversion is planned. Keep numerical parity and
preprocessing regression checks; independent detector accuracy/calibration research is deferred.

## E. Everyday UX and privacy

| ID | Status | Work and acceptance evidence |
| --- | --- | --- |
| E1 | Ongoing | Make hiding annotations, pausing analysis, stopping/unloading the engine, deleting models, clearing records and uninstalling distinct and understandable. |
| E2 | Partial | Coverage/report metadata exist. Extend them for reading/sampling so unprocessed text, insufficient evidence, unsupported language, errors and low scores cannot be confused. |
| E3 | Partial | Download errors are now visible and survive reconnect. Improve consolidated registration/version/device diagnostics and optional sanitized support export, excluding text, URLs, tokens and passwords by default. |
| E4 | Partial | Offline checks and network disclosure exist. Keep repeatable first-run/offline verification and distinguish model/update traffic from authorized original-document reads. No “never uses the network” claim. |
| E5 | Open | Evaluate an installation-keyed cryptographic cache digest and migration/clear semantics. Current unsalted 53-bit text hashes are not anonymous against guessed input; memory-only mode is already available. |
| E6 | Validation needed | Manual keyboard, screen-reader, zoom, focus restoration and dense-annotation testing, including the combined full PDF.js viewer/panel. Automated accessibility checks already exist. |

## F. Delivery, tests and maintenance

| ID | Status | Work and acceptance evidence |
| --- | --- | --- |
| F1 | Pending real users | Test a clean Apple Silicon Mac without development tools, especially 8 GB M1/M2 machines. Follow installation, selection, restart, upgrade and full removal. |
| F2 | Open | Stress 1,000–3,000-page text/image PDFs, long streaming chats, fast seeking/returning, multiple windows and hidden tabs. Measure viewer baseline separately from Anagram work, plus interruption/disk/network failure and memory reclamation. |
| F3 | Pending platforms | Establish explicit support levels with actual Windows/Linux checks. Windows source review/C# compilation on Mac is not a substitute for PowerShell, registry, sharing-lock and deletion tests. |
| F4 | Open | Encode an intentional CI cost/platform policy. Remote manual disablement and skip markers are current operational choices, not a durable YAML redesign; do not enable or run matrices without a corresponding user request. |
| F5 | Open | Finish stable store extension IDs, signed Firefox distribution, public privacy/support/homepage URLs, current screenshots and reviewer instructions. Cover developer-to-store migration. |
| F6 | Partial | Correct stale docs and verify final manifests/assets. Make version, permission and release-link drift harder to miss; do not allow stale test builds to silently substitute for shipping artifact checks. |
| F7 | Open | Design authenticated release metadata/signatures with a publisher trust root and rotation. Existing SHA-256 files, immutable Actions pins and license inventory are useful but not independent release authentication. |
| F8 | Ongoing | Track security updates to PDF.js and other dependencies, keep bundled executable assets verified, remove actually obsolete scaffolding and clarify capture/source-span/scheduling interfaces without a wholesale rewrite. |

The shipping permission set is `storage`, `activeTab`, `contextMenus`, `scripting`,
`nativeMessaging`, `webNavigation`, `webRequest`; HTTP/HTTPS and local-file grants remain
optional. Audit actual ZIPs and PDF listener scope. Do not add speculative permissions,
or remove a permission needed by an implemented feature simply to reduce the count.

## Deferred / conditional functionality

- Signed/notarized graphical macOS installer after recovery logic is dependable.
- CoreML/MLX production support after startup, shape buckets, cache policy, numerical
  parity, dependency licensing and packaging justify it. Existing M4 evidence is tracked.
- Local model conversion only when total dependency/conversion/validation cost beats
  downloading on the target platform; no change to the current HF weights now.
- Local OCR for scanned PDFs after clearly reporting absent text, with explicit resource cost.
- Intel Mac, Windows ARM, more AMD/NPU devices only after explicit compatibility validation.
- Browser-only inference as a separate suitable-model experiment, not the present default.
- Shared multi-browser serving only if demand justifies its lifecycle/security complexity.
- Independent detector-quality/multilingual research and commercial licensing decisions
  before making new claims or pursuing those product directions.

Keep PDF.js, Readability, DOMPurify, Intl.Segmenter, ONNX Runtime and fast-check. Benchmark
Trafilatura/Resiliparse/rs-trafilatura only for demonstrated extraction gaps, considering
source mapping and footprint. spaCy and Infinity are not planned default dependencies.
