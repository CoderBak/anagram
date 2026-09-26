# Development

Anagram is a Chrome extension (WXT, TypeScript) and a Python Native Messaging host.
Content scripts extract prose, the background worker authorizes and batches requests,
and the local engine under `~/.anagram` scores them with EditLens. There is no HTTP
service anywhere. Work on `dev`; `main` holds the published README only.

## Code map

| Area | Start here |
| --- | --- |
| Manifest, CSP, builds | `wxt.config.ts`, `scripts/release.mjs`, `scripts/verify-release.py` |
| Background: authorization, site access, message ACL | `entrypoints/background.ts`, `lib/access/`, `lib/messaging/protocol.ts` |
| Scoring router and cache | `lib/backend/router.ts`, `lib/backend/swCache.ts`, `lib/backend/nativeTransport.ts` |
| Page capture and scheduling | `entrypoints/content.ts`, `lib/capture/orchestrator.ts`, `lib/capture/scheduler.ts`, `lib/dom/walker.ts` |
| In-page rendering | `lib/render/scale.ts` (score to word, colour, doubt), `lib/render/badge.ts` (chips, card), `lib/render/fab.ts` (ball, panel), `lib/render/highlight.ts` |
| Setup, popup, settings | `entrypoints/onboarding/`, `entrypoints/popup/`, `entrypoints/options/`, `lib/ui/componentSettings.ts` |
| PDF reader | `entrypoints/reader/`, `lib/pdf/reflow.ts`, `lib/pdf/handoff.ts`, `vendor/pdfjs/` |
| Native host: protocol, ownership, lifecycle | `anagramd/native_host.py`, `anagramd/native_component.py` |
| Inference and runtime selection | `anagramd/engine.py`, `anagramd/runtime_controller.py`, `anagramd/runtime_adapters.py`, `anagramd/model_plan.py` |
| Model download | `anagramd/download_modelkit.py`, `anagramd/hub_transfer.py`, `anagramd/prepare_models.py`, `anagramd/modelkit.json` |
| Install, update, uninstall | `install.sh`, `install.ps1`, `installer/native_registration.py`, `installer/anagram` |
| Localization | `public/_locales/en/`, `public/_locales/zh_CN/`, `scripts/i18nSubset.ts` |

## Decisions that hold

- Setup is automatic. After model files are prepared the engine detects devices and
  activates the best FP32 configuration itself. Benchmarking and switching are optional.
- The browser starts a per-profile host over stdio. One component home has one owner.
- Model weights are the pinned public modelkit in `anagramd/modelkit.json`, downloaded
  anonymously with SHA-256 verification. License is CC BY-NC-SA 4.0.
- Website access is optional and granted by the user. The shipping manifest declares no
  host permissions; the content script is registered at runtime from grants.
- The complete upstream PDF.js viewer ships unmodified and hash-pinned.

## Checks

Node 22 and Python 3.12. Build before browser suites; the test build grants all
sites and lands in `output-test/`, the shipping build in `output/`.

```sh
npm ci
npm run typecheck
npm run build
npm run test:node                  # vitest; some suites skip without a fresh build
npx playwright install chromium
npm run test:unit                  # DOM walker cases in a blank page
npm run test:e2e                   # extension against a deterministic fake host
node test/scenarios.mjs --local
npm run test:a11y
npm run test:native                # real stdio host fixture, EN and ZH setup
npm run test:paste                 # the paste page, pass readout and report
npm run test:pdf-viewer            # upstream reader: find, zoom, recycling, file limits
npm run test:pdf-install           # PDF setup and local-file access flow, EN and ZH
node test/pdf-route-check.mjs      # PDF routing, handoff caps and privacy
npm run test:network-privacy       # the offline-mode promise in PRIVACY.md
```

Backend and installer tests need a Python venv with the test dependencies only:

```sh
uv venv --python 3.12 /tmp/anagram-venv
uv pip install --python /tmp/anagram-venv/bin/python numpy 'pydantic>=2' emoji filelock psutil 'huggingface_hub==1.31.0'
ANAGRAMD_PYTHON=/tmp/anagram-venv/bin/python npm run test:backend
npm run test:installer
```

Every suite uses temporary homes and temporary browser profiles. Never point a test at
the real `~/.anagram`. Fixture scores are a pure function of the text and say nothing
about model quality. `test/native-real.py` is the only real-model check; it needs
existing verified weights and `(cd anagramd && uv sync --frozen)`.

## Release

`npm run bump <version>` rewrites the version in package files, `anagramd/pyproject.toml`
and `uv.lock`. `npm run release` builds both browser ZIPs, the component archive and
installers under `dist/` and runs `scripts/verify-release.py` on the ZIPs. Publishing is
manual. The install command shown in the extension is pinned to its own version, so a
release must ship matching assets.

## Open work

- Follow the reader: score what is on screen after a short dwell, skip fast scrolling,
  bound queued work per document. Hooks are in `lib/capture/observers.ts` and
  `lib/capture/scheduler.ts`.
- PDF: replace the 300-page analysis cap with a bounded active-page budget and keep
  results across PDF.js page recycling (`entrypoints/reader/main.ts`, `lib/pdf/units.ts`).
- Installer recovery on Windows: two component homes registering one browser race on
  the HKCU keys (`installer/native_registration.py`), and an interrupted uninstall is
  finished only by reinstalling or deleting the folder (`installer/maintenance.ps1`).
- Windows and Linux have not been exercised on real machines.
