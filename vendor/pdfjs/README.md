# Pinned complete PDF.js viewer

`upstream.json` records the official Mozilla v5.7.284 generic distribution URL, archive
SHA-256 and checksums for every retained upstream asset. `5.7.284/` contains unchanged
viewer HTML, JavaScript, CSS, images, Fluent translations and Apache-2.0 license.

`scripts/pdfjsViewer.mjs` verifies those checksums and the installed engine version before
copying assets and deriving `entrypoints/reader/index.html`. The generated page adds only
Anagram's entry script, restrictive network meta policy, small analysis/file controls, and
what accessibility needs from the template: a language, a zoomable viewport and landmarks.
Engine, worker, fonts, CMaps and image codecs come from the same pinned `pdfjs-dist` package.
The PDF-scripting sandbox, example PDF, debugger and source maps are not shipped.

To upgrade, obtain the matching official generic release, review integration interfaces,
update checksums and the engine lock together, and run the reader regressions. Builds
never download these assets.
