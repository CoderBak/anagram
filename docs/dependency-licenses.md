# Dependency and model license inventory

Recorded from the locked/local packages during the September 21, 2026 audit.
Package license notices must remain with redistributed code and native wheels.
This list identifies direct dependencies and separately downloaded models; it is
not a replacement license for them or a blanket commercial-use authorization.

## Models

| Artifact | Source and license |
| --- | --- |
| EditLens source weights/tokenizer/config | [pangram/editlens_roberta-large](https://huggingface.co/pangram/editlens_roberta-large), CC BY-NC-SA 4.0 |
| FP32/FP16/INT8 ONNX variants | [CoderBak/editlens_roberta_modelkit](https://huggingface.co/CoderBak/editlens_roberta_modelkit), same CC BY-NC-SA 4.0; original Pangram attribution, NOTICE, LICENSE and source revision retained |
| fastText `lid.176.ftz` | [fastText language-identification models](https://fasttext.cc/docs/en/language-identification.html), CC BY-SA 3.0, credited to the fastText authors (Joulin, Grave, Bojanowski, Douze, Jégou, Mikolov); distinct from the fastText code license |

## Browser code and build/test tooling

All are development dependencies in package.json because WXT produces the packaged
browser bundles; some are therefore shipped inside compiled code or vendor assets.

| Package | Version inspected | License reported |
| --- | --- | --- |
| @floating-ui/dom | 1.8.0 | MIT |
| @mozilla/readability | 0.6.0 | Apache-2.0 |
| basecoat-css | 1.0.2 | MIT |
| culori / @types/culori | 4.0.2 / 4.0.1 | MIT |
| dompurify | 3.4.15 | MPL-2.0 OR Apache-2.0 |
| idb | 8.0.3 | ISC |
| pdfjs-dist | 5.7.284 | Apache-2.0; retain notices for bundled fonts, color profiles and decoders too |
| valibot | 1.5.0 | MIT |
| wxt | 0.20.27 | MIT |
| esbuild | 0.27.7 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vitest | 3.2.7 | MIT |
| fast-check | 4.10.2 | MIT |
| playwright | 1.61.1 | Apache-2.0 |
| puppeteer-core / @puppeteer/browsers | 25.11.0 / 3.2.2 | Apache-2.0 |
| axe-core | 4.13.0 | MPL-2.0 (test tooling) |

The locked transitive dependency inventory can be exported locally with
`npm sbom --sbom-format cyclonedx`; inspect it together with package notices when
releasing. A package.json category does not determine whether code is bundled.

## Native runtime

| Package | Version inspected on this Mac | License reported |
| --- | --- | --- |
| torch | 2.14.0 | Wheel metadata: Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT; retain its bundled third-party notices |
| transformers | 5.17.0 | Apache-2.0 |
| safetensors | 0.8.0 | Apache-2.0 |
| numpy | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| pydantic | 2.13.5 | MIT |
| emoji | 2.15.0 | BSD; see the installed [license](https://github.com/carpedm20/emoji/blob/master/LICENSE.txt) and Unicode data notices |
| huggingface-hub | 1.31.0 | Apache-2.0 |
| filelock | 3.32.6 | MIT |
| psutil | 7.2.2 | BSD-3-Clause |
| onnxruntime | 1.30.0 | MIT |
| fasttext | 0.9.3 | MIT |
| fasttext-predict (macOS prediction-only wheel) | 0.9.2.4 | MIT; [package and upstream fork](https://pypi.org/project/fasttext-predict/0.9.2.4/), preserves the fastText model format and prediction API |

`anagramd/uv.lock` is the installation authority. Platform-specific wheels, CUDA
redistributables, private Python, uv and Windows fasttext-wheel have their own
included notices; this Mac inventory does not assert that their contents are identical.

## Research only

Apple benchmark dependencies are installed under `modelkit-work/apple-deps` and are
excluded from the native release file list. In particular, the experiment imports
the **GPL-3.0** `mlx-embeddings` encoder from its installed package; no upstream
source is copied into Anagram. Promoting that implementation to a product dependency
requires a separate license/design decision. No decision to ship MLX or CoreML is
made solely because a benchmark runs faster.
