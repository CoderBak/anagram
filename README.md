# Pangram AI Detector (M1)

A Manifest V3 Chrome extension (built with [WXT](https://wxt.dev)) that detects
AI-generated text on web pages and renders a per-paragraph AI-confidence badge
(Shadow DOM) plus an optional in-place highlight. It is **not** a translator.

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
npm run build      # outputs .output/chrome-mv3/
```

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select `.output/chrome-mv3`.
4. Pin the extension; the toolbar icon opens the popup (on/off, per-site, Rescan).

## Self-test

Open `test/selftest.html` (enable "Allow access to file URLs" for the extension).
Each paragraph / list item / blockquote should show one badge; `<pre>`/`<code>`
and short fragments show none. See the build spec §8.5.

## Layout

- `entrypoints/` — WXT scans this to build the manifest (content, background, popup, options).
- `lib/` — shared modules: DOM walker, capture pipeline, messaging, render, backend, settings.
- `public/` — copied verbatim into the bundle (icons go here post-M1).
- `test/` — hand-made self-test page.
