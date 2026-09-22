# Working on Anagram

Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) first. User instructions override this file.

- Work on `dev`. Routine commits use `[skip ci]`. Never enable, dispatch or rely on
  GitHub Actions and never push a version tag as part of ordinary development.
- Chrome on Apple Silicon macOS is the primary target. Keep the Firefox build compiling.
- Scoring uses Native Messaging over stdio only. Do not add an HTTP inference service.
- The local engine picks its own configuration. Never require a benchmark or a manual
  choice during setup; FP32 is the only automatic pick.
- Keep the pinned Hugging Face modelkit, its attribution and CC BY-NC-SA 4.0 license.
- Test installation, download and removal only in temporary homes and temporary browser
  profiles. Never touch the developer's real `~/.anagram` or browser registration.
- Keep English and Chinese copy aligned. `test/node/i18n.test.ts` enforces the key sets.
- Prefer deleting over documenting. Do not add docs that repeat the code or the UI.
