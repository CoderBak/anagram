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
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { ensureTestBuild, TEST_OUT } from "./test-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The TEST variant, not the shipping build: a suite cannot click a permission prompt,
 *  so it loads the build where the site patterns are already granted. See test-build.mjs. */
export const EXT = join(TEST_OUT, "chrome-mv3");
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
  ensureTestBuild("chrome-mv3");
}

/** Serve in-memory HTML pages over http so the registered content script runs. */
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
  // A caller that brought its own executable (uiLanguage() on macOS) has already picked one.
  if (headless && !opts.executablePath) opts.channel = "chromium";
  if (classicScrollbars) opts.ignoreDefaultArgs = ["--hide-scrollbars"];
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  const context = await chromium.launchPersistentContext("", opts);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  if (backendUrl && extId) await setServerUrl(context, extId, backendUrl);
  if (sw) await waitForRegistration(sw);
  return { context, sw, extId };
}

/**
 * The content script is REGISTERED AT RUNTIME (lib/access/worker.ts), so a page opened in
 * the first moments of a launch could load before the worker has registered it and get no
 * content script at all. The suites wait for the registration instead of racing it.
 */
async function waitForRegistration(sw, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await sw
      .evaluate(async () => {
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        return scripts.some((s) => s.id === "anagram-content");
      })
      .catch(() => false);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn("the content script was not registered within 10s — pages may run without it");
  return false;
}

/**
 * Launch options that put the BROWSER's UI language at `tag` — the language
 * `chrome.i18n` follows, and therefore the one the extension is translated into. It is
 * NOT `navigator.language`, so Playwright's own `locale` option does nothing for it, and
 * every desktop platform reads it from somewhere else:
 *
 *   Linux, Windows  `--lang=<tag>`; Linux also wants LANGUAGE in the environment.
 *   macOS           Chromium ignores --lang and asks Cocoa, which reads the AppleLanguages
 *                   user default. That default can be set per process — `-AppleLanguages
 *                   "(zh-CN)"` in the argument list — but Playwright refuses any argument
 *                   that does not start with "-" ("Arguments can not specify page to be
 *                   opened"), so the pair cannot be passed through `args`. It goes through
 *                   a one-line launcher instead: a shell script standing in for the
 *                   browser executable, which prepends the pair and drops Playwright's
 *                   trailing `about:blank` — Chromium would otherwise see `(zh-CN)` as a
 *                   second startup target and refuse to start headless. The first page
 *                   then lands on an error page rather than about:blank, which no caller
 *                   here cares about: every suite opens the pages it wants.
 *
 * None of this is guaranteed — a locale the build has no bundle for, a platform nobody
 * tried — so the caller must READ THE LANGUAGE BACK (`chrome.i18n.getUILanguage()`) and
 * skip loudly rather than assert against a browser that is still in English.
 */
export function uiLanguage(tag) {
  const posix = tag.replace("-", "_");
  if (process.platform !== "darwin") {
    return { args: [`--lang=${tag}`], env: { ...process.env, LANGUAGE: posix } };
  }
  const real = chromium.executablePath();
  const dir = mkdtempSync(join(tmpdir(), "anagram-lang-"));
  const launcher = join(dir, `chromium-${posix}.sh`);
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      "# Written by test/harness.mjs — see uiLanguage().",
      `REAL='${real}'`,
      "n=$#",
      "i=0",
      "while [ $i -lt $n ]; do",
      '  a="$1"; shift',
      '  [ "$a" = "about:blank" ] || set -- "$@" "$a"',
      "  i=$((i+1))",
      "done",
      `exec "$REAL" -AppleLanguages '(${tag})' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  return { executablePath: launcher };
}

/** The language the extension actually came up in, or null when the worker never woke. */
export async function uiLanguageOf(sw) {
  if (!sw) return null;
  return sw.evaluate(() => chrome.i18n.getUILanguage()).catch(() => null);
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
