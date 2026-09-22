# Working on Anagram

Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the current handoff, code map,
local checks and release boundaries, then [docs/ROADMAP.md](docs/ROADMAP.md) for
prioritized outstanding work. User instructions take precedence over this file.

- `dev` contains unreleased changes after v0.5.0. Matching version strings do not
  mean the GitHub release assets contain the checkout's changes.
- Use local, targeted checks. The owner does not want incidental multi-platform
  GitHub Actions costs. Do not enable/dispatch workflows or push version tags as
  part of ordinary development. Use `[skip ci]` for routine commits/pushes unless
  the user requests CI. This does not disable workflow triggers in source.
- Preserve Native Messaging, optional site/file grants, offline inference and
  exact browser registration. Do not reintroduce an HTTP inference service.
- Keep current HF weights and attribution/license. Recommend FP32; FP16 is an
  explicit choice and INT8 remains experimental. CoreML/MLX production support,
  automatic conversion and independent detector-quality research are deferred.
- Test installation/download/removal in temporary owned homes and browser profiles.
  Do not change a developer's real registration, model files or installation as
  an incidental test. No global Python/package, shell profile or PATH changes.
- Keep English/Chinese copy, privacy/storage docs and packaged-file lists aligned
  with changes. Record actual checks and platform limits; fixtures are not real
  model-performance measurements. Keep generated artifacts and credentials out of Git.
