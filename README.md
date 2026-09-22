# Anagram

Anagram marks English prose in your browser with a local estimate of how much an AI
edited it: human, lightly edited, heavily edited or AI-generated. Scoring runs on your
own computer with Pangram's EditLens model. Nothing you read leaves your machine.

[User guide](docs/user-guide.en.md) · [中文指南](docs/user-guide.zh-CN.md) · [Privacy](PRIVACY.md)

## Install

1. Download the Chrome ZIP from the [latest release](https://github.com/CoderBak/anagram/releases),
   extract it to a folder you will keep, and load that folder at `chrome://extensions`
   with Developer mode on and **Load unpacked**.
2. The setup page shows one terminal command. Run it once. It installs a private Python
   runtime, registers the extension, and downloads about 1.4 GB of model files.
3. Return to the browser. Anagram picks the best configuration for your hardware and is
   ready. Grant a site, or use **Analyze this page** from the toolbar icon for one page.

Apple Silicon Macs are the tested platform. Linux and Windows installers exist but have
not been exercised on real machines. Firefox has a build but is not the focus.

## Use

Every analyzed paragraph gets a small chip with a score from .00 (human) to 1.0
(AI-generated). Hover it for the four-way breakdown. The floating ball lists flagged
paragraphs and copies a report. PDFs open in a built-in reader. Google Docs get a
reading view. Settings covers site access, marks, cache and the local engine.

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

Inference uses [Pangram's EditLens RoBERTa-large](https://huggingface.co/pangram/editlens_roberta-large)
via the [CoderBak/editlens_roberta_modelkit](https://huggingface.co/CoderBak/editlens_roberta_modelkit)
redistribution, pinned in `anagramd/modelkit.json`. The model is **CC BY-NC-SA 4.0**,
non-commercial. Scores are estimates, not proof of authorship.
