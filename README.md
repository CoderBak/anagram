<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/icon-dark.svg">
  <img src="assets/icon-light.svg" alt="" width="64" height="64">
</picture>

# Anagram

Anagram marks English prose in your browser with a local estimate of how much an AI
edited it: human, lightly edited, heavily edited or AI-generated. Scoring runs on your
own computer with Pangram's EditLens model, inside the browser or in a local engine.
Nothing you read leaves your machine.

[User guide](docs/user-guide.en.md) · [中文指南](docs/user-guide.zh-CN.md) · [Privacy](PRIVACY.md)

## Install

1. Download the Chrome ZIP from the [latest release](https://github.com/CoderBak/anagram/releases),
   extract it to a folder you will keep, and load that folder at `chrome://extensions`
   with Developer mode on and **Load unpacked**. Chrome 137 or later.
2. The setup page opens. On most computers the model (1.4 GB) downloads into the browser
   by itself. On an Apple Silicon Mac, or a Windows or Linux PC with an NVIDIA graphics
   card, it asks first: **One click** runs the model in the browser; **Terminal** installs
   a faster local engine with one command, which installs a private Python runtime,
   registers the extension and downloads the model files. Settings switches later.
3. When it says Ready, grant a site, or use **Analyze this page** from the toolbar icon for
   one page.

Apple Silicon Macs are the tested platform. Linux and Windows installers exist but have
not been exercised on real machines. Firefox 153+ has a build but is not the focus.

The Safari version targets **Mac computers with Safari 27+**. It shares the recommended
**One click** browser setup and optional **Terminal** engine with Chrome and Firefox.
The browser engine needs a compatible WebGPU adapter and uses a pinned engine tab;
the separate engine needs a full Safari app build and an Apple Silicon Mac. Build and
real-Mac verification instructions are in [Development](docs/DEVELOPMENT.md#safari).
Safari runtime verification is pending.

## Use

Every analyzed paragraph gets a small chip with a score from .00 (human) to 1.0
(AI-generated). Hover it for the four-way breakdown. Pin Anagram beside the address bar
using the browser-specific guide in setup. Its toolbar popup lists flagged paragraphs,
jumps to them, and controls page marks. On Google Docs, choose **Analyze document**
from the popup to open the reading view. PDFs open in a built-in reader. Settings
covers site access, marks, cache and the engine, and includes the pinning guide.

## Develop

```sh
npm ci
npm run build          # output/chrome-mv3
npm run typecheck
npm run test:node
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the code map, the full check list
and open work.

## Model and license

Anagram's code is licensed under the [GNU AGPL v3.0 or later](LICENSE). The third-party
work it ships or adapts keeps its own licences, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Inference uses [Pangram's EditLens RoBERTa-large](https://huggingface.co/pangram/editlens_roberta-large)
via the [CoderBak/editlens_roberta_modelkit](https://huggingface.co/CoderBak/editlens_roberta_modelkit)
redistribution, pinned in `anagramd/modelkit.json`. The model is **CC BY-NC-SA 4.0**,
non-commercial. Scores are estimates, not proof of authorship.
