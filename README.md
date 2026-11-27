# Anagram

Anagram reads English prose in your browser and runs the detector on your computer. In v0.10.1, each paragraph gets a chip showing its main label. Open the chip to see which sentences the detector marked as human, AI-assisted or AI-generated.

## Install

Download the Chrome ZIP under **Assets** on the latest signed release. Use the guide below that matches the version in the ZIP filename. Extract it into a folder you will keep. In Chrome 137 or later, open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked** and choose that folder. [GitHub releases](https://github.com/CoderBak/anagram/releases/latest)

The v0.10.1 setup page preselects the recommended detector and shows its download size. The in-browser engine downloads and verifies the model inside the browser. On supported computers you can also choose the local engine, inspect its installer in setup and run the version-specific command. Both engines need anonymous download access to the selected model on Hugging Face. [Detector releases](https://huggingface.co/CoderBak/anagram-detectors)

## Guides by version

| Version | Guides |
| --- | --- |
| v0.10.1 | [English](https://github.com/CoderBak/anagram/blob/v0.10.1/docs/user-guide.en.md) · [中文](https://github.com/CoderBak/anagram/blob/v0.10.1/docs/user-guide.zh-CN.md) · [Release notes](https://github.com/CoderBak/anagram/blob/v0.10.1/CHANGELOG.md) |
| v0.9.2 | [English](https://github.com/CoderBak/anagram/blob/v0.9.2/docs/user-guide.en.md) · [中文](https://github.com/CoderBak/anagram/blob/v0.9.2/docs/user-guide.zh-CN.md) |

Chrome on Apple Silicon is the primary target. The v0.10.1 release workflow also builds Firefox. Safari on macOS still needs runtime verification. [Build and test instructions](https://github.com/CoderBak/anagram/blob/v0.10.1/docs/DEVELOPMENT.md)

Page text stays on your computer. Reading statistics are optional. Anagram’s code is licensed under the GNU AGPL v3.0 or later. Each detector’s model page lists its terms. [Privacy](https://github.com/CoderBak/anagram/blob/v0.10.1/PRIVACY.md) · [Source](https://github.com/CoderBak/anagram/tree/v0.10.1) · [License](https://github.com/CoderBak/anagram/blob/v0.10.1/LICENSE) · [Third-party notices](https://github.com/CoderBak/anagram/blob/v0.10.1/THIRD_PARTY_NOTICES.md)
