// test/firefox-harness.mjs — launch helpers for the FIREFOX suite (test/firefox.mjs).
//
// The Chromium suites drive Playwright (test/harness.mjs). Playwright cannot load an
// extension into Firefox at all, so this file drives Firefox through puppeteer-core over
// WebDriver BiDi instead — no geckodriver, no system install:
//
//   * `browser.installExtension(dir)` is BiDi's `webExtension.install`, a TEMPORARY
//     install of the UNPACKED output/firefox-mv2 (unsigned is fine for those).
//   * `extensions.webextensions.uuids` is seeded in the profile, so the extension's
//     internal origin is a CONSTANT (EXT_UUID) and the suite can address
//     moz-extension://<uuid>/options.html directly instead of scraping it.
//   * Firefox refuses BiDi script evaluation in privileged (moz-extension:) documents
//     unless the browser was started with `-remote-allow-system-access`, so that flag is
//     passed — without it every `page.evaluate` on an extension page fails with
//     "System access is required".
//
// ISOLATION. Firefox is ALWAYS headless here, and puppeteer's macOS default argument
// `--foreground` is removed: with it the browser registers as a foreground application.
// As launched below, macOS reports the process as type="BackgroundOnly" — no Dock icon,
// no window, and `lsappinfo front` is unchanged across a whole run. There is no HEADED
// escape hatch on purpose.
//
// Firefox itself is NOT installed system-wide. resolveFirefox() takes, in order:
//   1. $ANAGRAM_FIREFOX                        (an explicit binary)
//   2. the @puppeteer/browsers cache           (npx @puppeteer/browsers install firefox@stable)
//   3. the platform's own install              (what a CI runner image ships)
// and refuses anything below the manifest's strict_min_version.
import { launch } from "puppeteer-core";
import { getInstalledBrowsers } from "@puppeteer/browsers";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { ensureTestBuild, TEST_OUT } from "./test-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The Firefox MV2 build, NOT the Chromium one — and the TEST variant of it, because a
 *  permission prompt is no more clickable here than in Chromium (see test-build.mjs). */
export const EXT = join(TEST_OUT, "firefox-mv2");
/** browser_specific_settings.gecko.id in wxt.config.ts. */
export const GECKO_ID = "anagram@coderbak.dev";
/** Seeded into the profile so moz-extension:// URLs are knowable before the install. */
export const EXT_UUID = "5e0b7a12-3c4d-4f8a-9b16-2d7e8c0f4a31";
/** Lowest Firefox the PRODUCT allows (manifest strict_min_version). */
export const MIN_FIREFOX = 128;
/**
 * Lowest Firefox this SUITE can drive. Higher than the product's minimum on purpose:
 * WebDriver BiDi only learned `webExtension.install` in Firefox 135, so there is no way
 * to get the extension into an older build without geckodriver. Verified here: Firefox
 * 128.0esr answers `unknown command webExtension.install`.
 */
export const MIN_DRIVER_FIREFOX = 135;
/** Badge hosts share data-anagram="host" with the FAB host — exclude the FAB by id. */
export const BADGE_SEL = '[data-anagram="host"]:not(#anagram-fab)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function requireFirefoxBuild() {
  ensureTestBuild("firefox-mv2");
}

function systemFirefoxCandidates() {
  switch (platform()) {
    case "darwin":
      return [
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        join(homedir(), "Applications/Firefox.app/Contents/MacOS/firefox"),
      ];
    case "win32":
      return [
        "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
        "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
      ];
    default:
      return ["/usr/bin/firefox", "/usr/lib/firefox/firefox", "/snap/bin/firefox", "/opt/firefox/firefox"];
  }
}

/** "Mozilla Firefox 156.0" → { version: "156.0", major: 156 }; null when it will not run. */
export function firefoxVersion(executablePath) {
  try {
    const out = execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 30000 });
    const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(out);
    if (!m) return null;
    return { version: out.trim().replace(/^Mozilla Firefox\s*/i, ""), major: Number(m[1]), banner: out.trim() };
  } catch {
    return null;
  }
}

/**
 * Find a Firefox to drive. Returns { executablePath, version, major, source }.
 * Throws with the exact command to run when there is none.
 */
export async function resolveFirefox() {
  const tried = [];
  const candidates = [];
  if (process.env.ANAGRAM_FIREFOX) candidates.push([process.env.ANAGRAM_FIREFOX, "$ANAGRAM_FIREFOX"]);
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || join(homedir(), ".cache", "puppeteer");
  try {
    const cached = (await getInstalledBrowsers({ cacheDir }))
      .filter((b) => b.browser === "firefox")
      // Newest first: a cache may hold several, and old ones are kept around to test
      // the graceful-degradation paths.
      .sort((a, b) => (parseInt(b.buildId.replace(/\D*/, ""), 10) || 0) - (parseInt(a.buildId.replace(/\D*/, ""), 10) || 0));
    for (const b of cached) candidates.push([b.executablePath, `@puppeteer/browsers cache (${b.buildId})`]);
  } catch {
    /* no cache directory yet */
  }
  for (const p of systemFirefoxCandidates()) candidates.push([p, "system install"]);

  for (const [executablePath, source] of candidates) {
    const reject = (why) => {
      tried.push(`${executablePath} — ${why}`);
      // An explicitly named binary is never silently swapped for another.
      if (source === "$ANAGRAM_FIREFOX") throw new Error(`$ANAGRAM_FIREFOX ${executablePath} — ${why}`);
    };
    if (!existsSync(executablePath)) {
      reject("not present");
      continue;
    }
    const v = firefoxVersion(executablePath);
    if (!v) {
      reject("would not report a version");
      continue;
    }
    if (v.major < MIN_DRIVER_FIREFOX) {
      reject(
        `${v.version} cannot be driven: BiDi webExtension.install needs ${MIN_DRIVER_FIREFOX}+` +
          (v.major >= MIN_FIREFOX ? ` (the extension itself claims to support ${MIN_FIREFOX}+)` : ""),
      );
      continue;
    }
    return { executablePath, version: v.version, major: v.major, banner: v.banner, source };
  }
  throw new Error(
    `No drivable Firefox found (needs ${MIN_DRIVER_FIREFOX}+; the extension itself supports ${MIN_FIREFOX}+).\n` +
      `Install one without touching /Applications:\n` +
      `  npx @puppeteer/browsers install firefox@stable\n` +
      `or point the suite at a binary:  ANAGRAM_FIREFOX=/path/to/firefox npm run test:firefox\n` +
      `tried:\n  ${tried.join("\n  ")}`,
  );
}

/**
 * Headless Firefox with the unpacked MV2 build temporarily installed.
 * Returns { browser, firefox, extId, extUrl(path) }.
 */
export const VIEWPORT = { width: 1280, height: 860 };

/**
 * puppeteer's setViewport goes through BiDi `emulation.setScreenOrientationOverride`,
 * which Firefox only grew in 140 — on 135-139 it is an unknown command. The window is
 * sized by `--window-size` at launch anyway, so a failure here is not fatal.
 */
export async function setViewportSafe(page, viewport = VIEWPORT) {
  return page
    .setViewport(viewport)
    .then(() => true)
    .catch(() => false);
}

export async function launchFirefox({ extraPrefs = {}, args = [], viewport = VIEWPORT } = {}) {
  requireFirefoxBuild();
  const firefox = await resolveFirefox();
  const browser = await launch({
    browser: "firefox",
    protocol: "webDriverBiDi",
    executablePath: firefox.executablePath,
    headless: true, // never negotiable — see the note at the top
    // puppeteer adds --foreground on macOS; it makes Firefox a foreground application.
    ignoreDefaultArgs: ["--foreground"],
    // Size the window instead of emulating a viewport per page: emulation.* is patchy on
    // older Firefox (see setViewportSafe).
    defaultViewport: null,
    args: [`--window-size=${viewport.width},${viewport.height}`, "-remote-allow-system-access", ...args],
    extraPrefsFirefox: {
      // A constant internal origin for moz-extension:// URLs.
      "extensions.webextensions.uuids": JSON.stringify({ [GECKO_ID]: EXT_UUID }),
      // Temporary installs are exempt anyway; belt and braces for older builds.
      "xpinstall.signatures.required": false,
      "browser.shell.checkDefaultBrowser": false,
      "browser.startup.homepage_override.mstone": "ignore",
      "datareporting.policy.dataSubmissionEnabled": false,
      "toolkit.telemetry.enabled": false,
      ...extraPrefs,
    },
  });
  let extId;
  try {
    extId = await browser.installExtension(EXT);
  } catch (e) {
    await browser.close().catch(() => {});
    if (String(e).includes("unknown command webExtension.install")) {
      throw new Error(
        `Firefox ${firefox.version} has no BiDi webExtension.install (needs ${MIN_DRIVER_FIREFOX}+).\n` +
          `  npx @puppeteer/browsers install firefox@stable`,
      );
    }
    throw e;
  }
  const extUrl = (path) => `moz-extension://${EXT_UUID}/${path.replace(/^\//, "")}`;
  return { browser, firefox, extId, extUrl };
}

/** `location.href` of a page, or null when the context is gone. */
export const hrefOf = (page) => page.evaluate(() => location.href).catch(() => null);

/**
 * Open an extension page and wait until it is really there.
 *
 * FIREFOX QUIRK: BiDi reports neither the URL (`page.url()` stays "about:blank") nor a
 * load lifecycle event for a privileged document, so `page.goto` always rejects with a
 * TimeoutError even though the navigation happened. We therefore start the navigation,
 * swallow that rejection, and poll `location.href` inside the page instead.
 */
export async function openExtensionPage(browser, url, { timeout = 25000 } = {}) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 2500 }).catch(() => {});
  await waitForExtensionPage(page, url, timeout);
  return page;
}

/** Wait until `page` is at `url` with a parsed document. */
export async function waitForExtensionPage(page, url, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => [location.href, document.readyState])
      .catch(() => null);
    if (ready && ready[0] === url && ready[1] !== "loading") return page;
    await sleep(150);
  }
  throw new Error(`extension page never reached ${url}`);
}

/** The open page whose location.href contains `needle` (the onboarding tab opens itself). */
export async function findPageByHref(browser, needle, { timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const page of await browser.pages()) {
      const href = await hrefOf(page);
      if (href && href.includes(needle)) return { page, href };
    }
    await sleep(200);
  }
  return { page: null, href: null };
}

/**
 * Point the extension at a daemon URL, exactly as the Chromium harness's setServerUrl
 * does: through an extension page's own storage, BEFORE any content page opens.
 */
export async function setServerUrl(browser, extUrl, url) {
  const page = await openExtensionPage(browser, extUrl("options.html"));
  await page.evaluate((u) => browser.storage.local.set({ serverUrl: u }), url);
  await page.close();
}

/** Fake daemon + headless Firefox with the extension pointed at it. */
export async function withFakeDaemon(launchOpts = {}, daemonOpts = {}) {
  const daemon = await startFakeDaemon(daemonOpts);
  const ff = await launchFirefox(launchOpts);
  await setServerUrl(ff.browser, ff.extUrl, daemon.url);
  return { daemon, ...ff };
}

/** Scroll through the page so viewport-first scoring dispatches everything. */
export async function sweep(page, steps = 8, stepDelay = 320) {
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

/** puppeteer's waitForFunction, reduced to a boolean (no throw on timeout). */
export async function waitFor(page, fn, { timeout = 8000, arg } = {}) {
  return page
    .waitForFunction(fn, { timeout, polling: 200 }, arg)
    .then(() => true)
    .catch(() => false);
}
