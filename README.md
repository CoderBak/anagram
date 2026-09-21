# Anagram

Anagram annotates English prose with local estimates of AI editing: human, lightly
edited, heavily edited or AI-generated. It supports Chrome and Firefox, with English
and Simplified Chinese interfaces. Predictions are estimates, not proof of authorship.

[English user guide](docs/user-guide.en.md) · [中文使用指南](docs/user-guide.zh-CN.md) ·
[Privacy](PRIVACY.md) · [Permissions and storage](docs/footprint.md)

## Installation

[Download version 0.5.0](https://github.com/CoderBak/anagram/releases/tag/v0.5.0) ·
Use the Chrome or Firefox browser ZIP; the setup page installs the matching native component.

1. Install the extension from its published browser listing, or extract a Chrome release
   ZIP to a permanent folder and select it through `chrome://extensions` → Developer mode
   → **Load unpacked**. Firefox uses its separate build.
2. Follow the setup page. Run its OS-specific installation command once to install the
   local component and register the exact extension ID. No administrator privileges or
   daily terminal session are required.
3. Keep setup open while the component detects usable devices and prepares the recommended
   model set (usually **1.43 GB**, including language detection; runtime and temporary space
   are additional). Settings shows the selected files, exact total and reused-file progress.
4. Review the device comparison and explicitly choose a configuration. The initial
   benchmark has a **30-second total measurement budget**; loading and warmup take extra
   time. FP32 is recommended; supported GPUs can also compare FP16 from shared weights.
   **Download expanded comparison models** adds compatible runtimes and experimental CPU INT8.
5. Grant website access where you want automatic annotation, or use **Analyze this page**
   for a single page without a persistent site grant.

Browser ZIPs, native components and installers are distributed together in the GitHub
release. `npm run release` prepares these files locally; it does not publish them.

All inference and component management use **Native Messaging over stdin/stdout**.
There is no HTTP inference server, port setting or alternate developer transport.
The browser starts the component when needed and reuses the saved device choice after a
restart. Intentional pauses and engine stops remain in effect until resumed.

Multiple windows and tabs in the same browser profile share one connection and model.
A different browser or profile cannot use the same installation concurrently.

## Reading and settings

- Inline chips show the predicted editing level and score. A detail card shows the four
  class probabilities; the panel collects flagged text and supports filtering/navigation.
- Related short blocks can be grouped, and long text is processed in overlapping windows.
  Viewport text is prioritized; duplicate text shares cached or in-flight results.
- PDFs open in the extension reader. Google Docs has a reading view; the original document
  is not edited. Unsupported languages are identified rather than given misleading scores.
- Settings controls downloads, engine start/stop, runtime selection, benchmark reruns,
  updates, cache clearing, model deletion and complete uninstall.
- Website access is optional and revocable. Display style, analysis scope and per-site
  switches are independent of browser permission grants.

## Updates and removal

Browser-store installs receive extension updates through the browser. For an unpacked
install, replace the extension files in the same directory and reload it. Update the
native component separately in Settings when prompted.

Use **Uninstall Anagram completely** before removing the extension to remove owned model
files, runtime files and native registration. macOS/Linux can then remove the extension
following confirmed cleanup. On Windows, wait for the maintenance window to confirm
success, then remove the extension manually. Removing only the extension leaves native
files behind because browsers do not provide a native uninstall hook.

Default component locations are `~/.anagram` on macOS/Linux and
`%LOCALAPPDATA%\Anagram` on Windows. A small native-host registration also lives in the
browser's user-level registration location. Downloaded archives, the user-selected
unpacked extension folder and OS backups are outside component cleanup.

## Models and license

Inference uses [Pangram's EditLens RoBERTa-large](https://huggingface.co/pangram/editlens_roberta-large).
[CoderBak/editlens_roberta_modelkit](https://huggingface.co/CoderBak/editlens_roberta_modelkit)
redistributes the original checkpoint and FP32/FP16/INT8 ONNX conversions with attribution,
license, checksums and numerical validation reports. Files are pinned in
[`anagramd/modelkit.json`](anagramd/modelkit.json) and downloaded anonymously.

The model remains **CC BY-NC-SA 4.0**, including its noncommercial restriction.
Numerical conversion checks are not an independent accuracy evaluation; the INT8 variant has known
parity limitations and is marked experimental.

## Development

```sh
npm ci
npm run build                 # output/chrome-mv3
npm run build:firefox         # output/firefox-mv2
npm run typecheck
npm run test:node
```

Browser tests use isolated profiles and a deterministic Native Messaging fixture.
Fixture scores and timings are not model performance measurements.

```sh
npx playwright install chromium
npm run test:unit
npm run test:e2e
node test/scenarios.mjs --local
npm run test:a11y
npm run test:native
npm run test:runtime
npm run test:firefox          # requires Firefox 140+
```

Backend tests use Python 3.12/3.13. With `uv` installed:

```sh
(cd anagramd && uv sync --frozen)
npm run test:backend
npm run test:installer
```

See [`anagramd/README.md`](anagramd/README.md) for native-host development and real-model
checks, and [manual checks](docs/manual-checks.md) for platform verification. The optional
`npm run lab` container provides a separate screen for browser QA; it does not expose a
model inference service.

`npm run release` builds both browser ZIPs, native component archives, installers and
checksums under `dist/`. It does not push or publish. The release workflow publishes assets
only after a version tag is pushed and its checks pass. Generated test output and local
machine metadata are excluded from release archives.

## Architecture and privacy

Content scripts extract text only from authorized pages. The background worker validates,
deduplicates and prioritizes requests, then sends text blocks through one Native Messaging
connection. The local component validates operations, manages model files and runtime state,
and performs inference. Replies are correlated to their originating requests.

Scoring has no network endpoint. Ordinary extension pages use `connect-src 'self'`; the
manifest allows original-document connections for an isolated, authorized PDF loader.
Original PDF/Google Docs reads can use the network. The native component separately
downloads models, dependencies and requested updates. Browser CSP does not sandbox that
program, which runs with the user's OS permissions. See the repeatable
[network privacy checks](docs/network-privacy.md).

Page text is used in memory. The score cache stores hashes and numeric verdicts, expires
after 30 days and can be cleared in Settings. Private-window results are not persisted.
There is no telemetry or remote inference. See [PRIVACY.md](PRIVACY.md) for the full data
boundary, download hosts and cleanup limits.
