// test/harness.mjs — shared launch helpers for the Playwright suites.
//
// launchExtension() opens a fresh-profile Chromium with the built extension and, when
// given a backend URL, writes it into the extension's settings BEFORE any page opens
// (the service worker watches the setting and re-probes). withFakeDaemon() pairs that
// with test/fake-daemon.mjs for suites that must not depend on the real model.
//
// ISOLATION. Every suite runs HEADLESS unless a window is asked for: Chromium's new
// headless mode loads MV3 extensions (Playwright's "chromium" channel), so a test run
// opens nothing on the desktop, takes no focus and leaves no Dock icon. The profile is a
// throwaway directory; the user's own Chrome is never touched.
//
//   node test/e2e.mjs            # headless (default)
//   HEADED=1 node test/e2e.mjs   # watch it run — or run it under Xvfb in the sandbox
//
// Only the two interactive tools (npm run browser / npm run play) always open a window.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import { startFakeDaemon } from "./fake-daemon.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXT = join(__dirname, "..", "output", "chrome-mv3");
/** Badge hosts share data-anagram="host" with the FAB host — exclude the FAB by id. */
export const BADGE_SEL = '[data-anagram="host"]:not(#anagram-fab)';

/** A window only when asked for. HEADLESS=0 is the old spelling of HEADED=1. */
export const HEADED = process.env.HEADED === "1" || process.env.HEADLESS === "0";

/** Where suites put screenshots and reports. The sandbox points this at its mounted
 *  results folder; on the host it stays test/ (gitignored *.png), as before. */
export const ARTIFACTS = process.env.ANAGRAM_ARTIFACTS || __dirname;
export function artifact(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  return join(ARTIFACTS, name);
}

export function requireBuild() {
  if (!existsSync(join(EXT, "manifest.json"))) {
    console.error("Build the extension first:  npm run build");
    process.exit(2);
  }
}

/** Serve in-memory HTML pages over http so the <all_urls> content script runs. */
export async function serveHtml(pages, fallback = Object.keys(pages)[0]) {
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    const body = pages[path] ?? pages[fallback];
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://localhost:${server.address().port}`;
  return { base, url: (path) => base + path, close: () => new Promise((r) => server.close(() => r())) };
}

/** Extra Chromium switches from the environment (the sandbox uses this for containers). */
const ENV_ARGS = (process.env.ANAGRAM_CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean);

/**
 * Launch Chromium with the built extension.
 *
 * `headless` defaults to "no window". `classicScrollbars` keeps the layout-affecting
 * scrollbars Windows and Linux draw (Playwright hides them in headless mode; macOS has
 * overlay scrollbars either way). Everything else is passed through as Playwright context
 * options, so a caller can emulate a device: viewport, deviceScaleFactor, colorScheme,
 * locale, timezoneId, reducedMotion, forcedColors, hasTouch, userAgent.
 */
export async function launchExtension({
  backendUrl,
  headless = !HEADED,
  viewport = { width: 1280, height: 850 },
  args = [],
  classicScrollbars = false,
  ...contextOptions
} = {}) {
  requireBuild();
  const opts = {
    headless,
    viewport,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check", ...ENV_ARGS, ...args],
    ...contextOptions,
  };
  // The bundled headless shell cannot load extensions; the full build's new headless can.
  if (headless) opts.channel = "chromium";
  if (classicScrollbars) opts.ignoreDefaultArgs = ["--hide-scrollbars"];
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  const context = await chromium.launchPersistentContext("", opts);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  if (backendUrl && extId) await setServerUrl(context, extId, backendUrl);
  return { context, sw, extId };
}

/** A plain page-only browser (no extension) under the same no-window rule. */
export function launchPlain(options = {}) {
  return chromium.launch({ headless: !HEADED, args: ENV_ARGS, ...options });
}

/** Point the extension at a daemon URL (written through an extension page's storage). */
export async function setServerUrl(context, extId, url) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.evaluate((u) => new Promise((res) => chrome.storage.local.set({ serverUrl: u }, res)), url);
  await page.close();
}

/** Fake daemon + extension pointed at it. */
export async function withFakeDaemon(launchOpts = {}, daemonOpts = {}) {
  const daemon = await startFakeDaemon(daemonOpts);
  const ext = await launchExtension({ ...launchOpts, backendUrl: daemon.url });
  return { daemon, ...ext };
}

/** Scroll through the page so viewport-first scoring dispatches everything. */
export async function sweep(page, steps = 6, stepDelay = 300) {
  await page
    .evaluate(
      async ({ n, d }) => {
        const step = Math.round(window.innerHeight * 0.8);
        for (let i = 0; i < n; i++) {
          window.scrollBy(0, step);
          await new Promise((r) => setTimeout(r, d));
        }
        window.scrollTo(0, 0);
      },
      { n: steps, d: stepDelay },
    )
    .catch(() => {});
}
