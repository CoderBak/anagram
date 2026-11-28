# Anagram

Anagram reads English prose in your browser and runs the detector on your computer. Each paragraph gets a chip showing its main label. Open the chip to see which sentences the detector marked as human, AI-assisted or AI-generated.

## Install

Download `anagram-chrome-0.11.0.zip` from the signed release and extract it into a folder you will keep. In Chrome 137 or later, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked** and choose that folder. [Download for Chrome](https://github.com/CoderBak/anagram/releases/download/v0.11.0/anagram-chrome-0.11.0.zip) · [All release files](https://github.com/CoderBak/anagram/releases/tag/v0.11.0)

Setup offers Ettin 400M and Qwen3.5 0.8B. It preselects the detector recommended on Hugging Face and shows its download size. The in-browser engine downloads and verifies the model inside the browser. On supported computers you can also choose the local engine, inspect its installer in setup and run the version-specific command. Both engines need anonymous download access to the selected model on Hugging Face. [Detector releases](https://huggingface.co/CoderBak/anagram-detectors)

## Guides by version

| Version | Guides |
| --- | --- |
| v0.11.0 | [English](https://github.com/CoderBak/anagram/blob/v0.11.0/docs/user-guide.en.md) · [中文](https://github.com/CoderBak/anagram/blob/v0.11.0/docs/user-guide.zh-CN.md) · [Release notes](https://github.com/CoderBak/anagram/blob/v0.11.0/CHANGELOG.md) |
| v0.10.2 | [English](https://github.com/CoderBak/anagram/blob/v0.10.2/docs/user-guide.en.md) · [中文](https://github.com/CoderBak/anagram/blob/v0.10.2/docs/user-guide.zh-CN.md) · [Release notes](https://github.com/CoderBak/anagram/blob/v0.10.2/CHANGELOG.md) |
| v0.9.2 | [English](https://github.com/CoderBak/anagram/blob/v0.9.2/docs/user-guide.en.md) · [中文](https://github.com/CoderBak/anagram/blob/v0.9.2/docs/user-guide.zh-CN.md) |

Chrome on Apple Silicon is the primary target. For Firefox 153 or later, download the Firefox ZIP and follow the versioned guide above. Safari on macOS still needs runtime verification. [Download for Firefox](https://github.com/CoderBak/anagram/releases/download/v0.11.0/anagram-firefox-0.11.0.zip) · [Build and test instructions](https://github.com/CoderBak/anagram/blob/v0.11.0/docs/DEVELOPMENT.md)

Page text stays on your computer. Reading statistics are optional. Anagram’s code is licensed under the GNU AGPL v3.0 or later. Each detector’s model page lists its terms. [Privacy](https://github.com/CoderBak/anagram/blob/v0.11.0/PRIVACY.md) · [Source](https://github.com/CoderBak/anagram/tree/v0.11.0) · [License](https://github.com/CoderBak/anagram/blob/v0.11.0/LICENSE) · [Third-party notices](https://github.com/CoderBak/anagram/blob/v0.11.0/THIRD_PARTY_NOTICES.md)
