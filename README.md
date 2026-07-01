# Pangram AI Detector (M1)

A Manifest V3 Chrome extension (built with [WXT](https://wxt.dev)) that detects
AI-generated text on web pages and renders an inline AI-confidence chip (Shadow
DOM) plus a colored underline per scored unit. Short neighbouring paragraphs are
merged into one unit so chat/comment-style content is covered; long paragraphs are
never split. It is **not** a translator.

The detection backend is a swappable `ScoreClient` seam; M1 ships an in-extension
**random stub** that returns the same contract the real backend will.

## Develop

```bash
npm install        # also runs `wxt prepare` via postinstall
npm run dev        # launches a Chrome profile with the extension + HMR
```

## Typecheck

```bash
npm run typecheck  # wxt prepare && tsc --noEmit
```

## Build + load unpacked

```bash
npm run build      # outputs output/chrome-mv3/
```

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select `output/chrome-mv3`.
4. Pin the extension; the toolbar icon opens the popup (on/off, per-site, Rescan).

## Self-test

Run `npm run test:e2e` (22 checks over `test/selftest.html`, served over http),
or `npm run browser` for a live window. `node test/sites.mjs` sweeps real sites
(incl. the HuggingFace papers page) with screenshots. See HANDOFF.md §8.

## Layout

- `entrypoints/` — WXT scans this to build the manifest (content, background, popup, options).
- `lib/` — shared modules: DOM walker, capture pipeline, messaging, render, backend, settings.
- `public/` — copied verbatim into the bundle (icons go here post-M1).
- `test/` — hand-made self-test page.
