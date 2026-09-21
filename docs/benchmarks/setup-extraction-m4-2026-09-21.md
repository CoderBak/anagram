# Local conversion and extraction measurements

Measured on September 21, 2026, on the project owner's Apple M4 MacBook, 10 CPU
cores, 24 GiB unified memory, macOS 27.2. These are local engineering measurements,
not a detector-accuracy study or a claim about other machines. Existing model
weights and the installed Anagram component were not modified.

## Converting downloaded source weights locally

[`benchmark-conversion.py`](../../scripts/benchmark-conversion.py) invokes the
modelkit's existing converter in a fresh process for each stage, sampling process
RSS every 20 ms. Each stage ran once; the OS file cache was warm. The separate
validation stages use the modelkit's existing 24 synthetic parity inputs.

| Conversion | Time | Peak sampled process RSS |
| --- | ---: | ---: |
| Source → ONNX FP32 | 7.53 s | 4.48 GiB |
| ONNX FP32 → FP16 | 6.88 s | 3.97 GiB |
| ONNX FP32 → INT8 | 8.43 s | 4.49 GiB |

Conversion took **22.84 s** in total; parity validation added **13.83 s**. All three
generated ONNX artifacts were byte-for-byte identical to the published modelkit.
The experimental copies were deleted after verification, freeing 2.65 GB; the
source weights, logs and result JSON remain.

| Existing parity check | Largest probability difference | Top-class changes | Result |
| --- | ---: | ---: | --- |
| FP32 | 0.00000402 | 0 / 24 | Pass |
| FP16 | 0.00267339 | 0 / 24 | Pass |
| INT8 | 0.12102217 | 1 / 24 | Fail, as already disclosed for the published artifact |

The INT8 result is an existing experimental-artifact limitation, not a newly
introduced conversion regression. It remains excluded from automatic
recommendation. Agreement on these fixtures does not establish detector accuracy.

Downloading source weights and shared assets only would reduce the current
roughly 4.07 GB download to roughly 1.43 GB, about 65% less. It would still create
the same final local variants and require conversion dependencies, temporary disk
space and roughly 4.5 GiB of sampled process RAM on this machine. Therefore this
experiment supports further installer work, but does not change the current
first-run download policy. Lower-memory machines, interrupted conversion, and
other OS/dependency combinations still need validation.

Full versions, hashes, sizes and results: [conversion JSON](conversion-m4-2026-09-21.json).

## Browser extraction

[`extraction-benchmark.mjs`](../../test/extraction-benchmark.mjs) ran in local
Chromium 149.0.7827.55 with all network requests blocked, two warmups and 15 samples
per case. DOM creation and source-range verification are outside timing. Counts
were stable and all planned scoring windows retained connected source mappings in
all eight fixtures. This checks mapping completeness, not extraction accuracy on
real websites.

| Fixture | Whole-page collection p50 |
| --- | ---: |
| Article | 0.3 ms |
| X feed | 1.8 ms |
| LinkedIn feed | 0.5 ms |
| Google Docs fixture | 0.2 ms |
| 100 comments | 8.1 ms |
| 1,000 comments | 81.7 ms |
| 128 nested levels | 0.6 ms |
| Structured PDF text | 0.1 ms |

The 1,000-comment case deserves follow-up: collection p90 was 84.7 ms and finding
the main region independently took 106.2 ms p50 / 114.4 ms p90. Those synchronous
operations can occupy the main thread for noticeable periods. The next focused
optimization should investigate bounded traversal and yielding, with source
mapping preserved. These observations do not justify replacing the extraction
engine without a comparative experiment.

PDF reflow p50 was 0.3 ms. That fixture measures structured text reflow and source
mapping, **not PDF decoding, rendering, OCR or model inference**.

Full samples and fixture hashes: [extraction JSON](extraction-m4-2026-09-21.json).
