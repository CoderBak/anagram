// test/daemon-cors-check.mjs — scoring works with NO host permission, in a real browser.
//
// Every other browser suite loads the TEST build, where `http://*/*` is a REQUIRED host
// permission (test/test-build.mjs). That pattern covers loopback, so in those suites the
// extension talks to the daemon on a host permission and CORS is never exercised at all —
// they would stay green with the daemon answering no CORS headers whatsoever, and the
// SHIPPING build would be unable to score a single paragraph.
//
// So this one loads the shipping build: no host permission, nothing granted, nothing
// registered. It asks the four questions that decide whether the trade was sound —
//
//   a. does /health get through as an ordinary cross-origin request?
//   b. does a batch really score, preflight and all?
//   c. is a daemon that answers NO CORS headers (every daemon before this change) reported as
//      "outdated" rather than "unreachable"? Those need opposite advice, and they look
//      identical to the browser;
//   d. is nothing listening still "unreachable"?
//
// — plus the two the same machinery decides: a daemon behind this extension goes on
// scoring while the status asks for an update, and a WEB page still cannot read a byte of
// the daemon.
//
// Chrome always; Firefox when one can be driven (it reports SKIP, never FAIL, otherwise),
// because the MV2 build asks for no host either and a moz-extension origin is a different
// origin for the daemon to answer.
//
//   node test/daemon-cors-check.mjs
//   node test/daemon-cors-check.mjs --chrome-only
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import { startFakeDaemon, EXTENSION_VERSION } from "./fake-daemon.mjs";
import * as ff from "./firefox-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME_ONLY = process.argv.includes("--chrome-only");

const results = [];
const record = (name, ok, note = "") =>
  results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

/**
 * The SHIPPING build, built here if it is missing or older than the sources — the same
 * courtesy test/test-build.mjs does for the test variant, so this check is runnable on its
 * own. `npm run build` never writes to output-test/, and nothing here writes to output/
 * except that build.
 */
function requireShippingBuild(dir) {
  const manifest = join(ROOT, "output", dir, "manifest.json");
  const builtAt = existsSync(manifest) ? statSync(manifest).mtimeMs : 0;
  const newest = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return 0;
    }
    if (!stat.isDirectory()) return stat.mtimeMs;
    return readdirSync(path).reduce((max, n) => Math.max(max, newest(join(path, n))), stat.mtimeMs);
  };
  const sourceAt = Math.max(
    ...["entrypoints", "lib", "public", "scripts", "wxt.config.ts", "package.json"].map((s) =>
      newest(join(ROOT, s)),
    ),
  );
  if (builtAt <= sourceAt) {
    console.log(`building the shipping extension (output/${dir})…`);
    execFileSync("npm", ["run", dir === "firefox-mv2" ? "build:firefox" : "build"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
  if (!existsSync(manifest)) {
    console.error(`no shipping ${dir} build — run npm run build`);
    process.exit(2);
  }
  return join(ROOT, "output", dir);
}

/** What an extension page asks the worker, and what comes back. */
const STATUS = (probe) => `browser.runtime.sendMessage({ action: "getBackendStatus", probe: ${probe} })`;
const BATCH = `browser.runtime.sendMessage({
  action: "scoreBatch",
  req: {
    v: "2.1", session: "cors-check", surface: "chrome-ext", priority: "viewport",
    lang: "en", domain: "example.com",
    blocks: [{ id: "one", text: ${JSON.stringify(
      "A paragraph long enough for the daemon to have an opinion about it, written out " +
        "plainly so that nothing in it depends on the model being the real one.",
    )}, order: 0 }],
  },
})`;

// ---- Chrome ----------------------------------------------------------------------------

const EXT = requireShippingBuild("chrome-mv3");

// If this build asked for a host, everything below would pass on the permission instead of
// on CORS, and the suite would be measuring nothing. So it is the first thing checked.
const chromeManifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
record(
  "Chrome: the build under test asks for NO host permission (or this proves nothing)",
  chromeManifest.host_permissions === undefined,
  JSON.stringify(chromeManifest.host_permissions ?? null),
);

let daemon = await startFakeDaemon();
const port = daemon.port;

const context = await chromium.launchPersistentContext("", {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
const extId = sw ? new URL(sw.url()).host : null;
record("Chrome: the shipping build loads and its worker wakes", extId !== null, String(extId));

const page = await context.newPage();
await page.goto(`chrome-extension://${extId}/options.html`);
await page.evaluate((u) => new Promise((res) => chrome.storage.local.set({ serverUrl: u, backendTransport: "http" }, res)), daemon.url);

/** Ask the worker something, from one of the extension's own pages. */
const ask = (expr) => page.evaluate(`(async () => ${expr})()`);

// a. /health as an ordinary cross-origin request.
const up = await ask(STATUS(true));
record(
  "Chrome: the daemon is connected with no host permission — /health read over CORS",
  up?.active === "server" && up?.model != null,
  JSON.stringify({ active: up?.active, reason: up?.server?.reason, model: up?.model?.id }),
);
record(
  "Chrome: and it is not reported as needing an update (the fake is this build's version)",
  up?.server?.outdated === false,
  `daemon ${EXTENSION_VERSION}`,
);

// b. a real batch: content-type application/json is not CORS-safelisted, so the browser
// must have sent a preflight and the daemon must have answered it.
const batch = await ask(BATCH);
record(
  "Chrome: a batch really scores — the POST went out as a cross-origin request",
  batch?.backend === "up" && batch?.results?.length === 1 && typeof batch.results[0].score === "number",
  JSON.stringify(batch?.results?.[0] ?? batch),
);
record(
  "Chrome: and the daemon answered a preflight for it (no host permission bypassed CORS)",
  daemon.stats.preflights > 0 && daemon.stats.blocks === 1,
  JSON.stringify({ preflights: daemon.stats.preflights, blocks: daemon.stats.blocks }),
);

// A web page is no closer than it was: the daemon's Origin guard refuses it before CORS is
// considered, so the fetch fails outright.
const files = await new Promise((resolve) => {
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>a page</title><p>hello");
  });
  server.listen(0, "127.0.0.1", () =>
    resolve({
      url: `http://localhost:${server.address().port}/`,
      close: () => new Promise((r) => server.close(() => r())),
    }),
  );
});
const web = await context.newPage();
await web.goto(files.url, { waitUntil: "load" });
const fromWeb = await web.evaluate(
  (u) => fetch(`${u}/health`).then((r) => `read ${r.status}`, (e) => `refused (${e.name})`),
  daemon.url,
);
record(
  "Chrome: a WEB page still cannot read the daemon — the grant is to extensions alone",
  fromWeb.startsWith("refused"),
  fromWeb,
);
await web.close();

// e. a daemon BEHIND this extension: it still scores, and the status asks for an update.
await daemon.close();
daemon = await startFakeDaemon({ port, appVersion: "0.0.1" });
const behind = await ask(STATUS(true));
const behindBatch = await ask(BATCH);
record(
  "Chrome: a daemon older than the extension goes on scoring, and says it wants updating",
  behind?.active === "server" && behind?.server?.outdated === true && behindBatch?.results?.length === 1,
  JSON.stringify({ active: behind?.active, outdated: behind?.server?.outdated }),
);

// c. a daemon too old to answer CORS at all — listening, healthy, unreadable.
await daemon.close();
daemon = await startFakeDaemon({ port, cors: false });
const old = await ask(STATUS(true));
record(
  "Chrome: a daemon that sends no CORS headers is 'outdated', not 'unreachable'",
  old?.active === "down" && old?.server?.reason === "outdated" && old?.server?.outdated === true,
  JSON.stringify({ active: old?.active, reason: old?.server?.reason }),
);

// d. and nothing listening is still "unreachable" — the advice is "start it".
await daemon.close();
const gone = await ask(STATUS(true));
record(
  "Chrome: with nothing listening at all it is 'unreachable'",
  gone?.active === "down" && gone?.server?.reason === "unreachable",
  JSON.stringify({ active: gone?.active, reason: gone?.server?.reason }),
);

await page.close();
await context.close();
await files.close();

// ---- Firefox ---------------------------------------------------------------------------
//
// The MV2 build asks for no host either, and `moz-extension://<uuid>` is a different origin
// for the daemon to answer — different enough that Firefox has historically sent `null` for
// some extension requests, which the daemon's Origin guard refuses with the rest. That is
// the question worth asking here, and it cannot be asked anywhere else.

if (!CHROME_ONLY) {
  let launched = null;
  try {
    const dir = requireShippingBuild("firefox-mv2");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    record(
      "Firefox: the build under test asks for NO host permission",
      (manifest.permissions ?? []).filter((p) => String(p).includes("://")).length === 0,
      JSON.stringify(manifest.permissions),
    );
    const fx = await ff.launchFirefox({ extDir: dir });
    const fxDaemon = await startFakeDaemon();
    await ff.setServerUrl(fx.browser, fx.extUrl, fxDaemon.url);
    launched = { ...fx, daemon: fxDaemon };
  } catch (e) {
    record("Firefox: the daemon answers a moz-extension origin", null, String(e).split("\n")[0]);
  }

  if (launched) {
    const { browser, extUrl, daemon: fxDaemon } = launched;
    const fxPage = await ff.openExtensionPage(browser, extUrl("options.html"));
    const fxAsk = (expr) => fxPage.evaluate(`(async () => ${expr})()`).catch((e) => ({ error: String(e) }));

    const fxUp = await fxAsk(STATUS(true));
    record(
      "Firefox: the daemon answers a moz-extension origin, with no host permission",
      fxUp?.active === "server" && fxUp?.model != null,
      JSON.stringify({ active: fxUp?.active, reason: fxUp?.server?.reason, error: fxUp?.error }),
    );
    const fxBatch = await fxAsk(BATCH.replace('"chrome-ext"', '"firefox-ext"'));
    record(
      "Firefox: a batch scores over CORS, preflight and all",
      fxBatch?.backend === "up" && fxBatch?.results?.length === 1 && fxDaemon.stats.preflights > 0,
      JSON.stringify({ backend: fxBatch?.backend, preflights: fxDaemon.stats.preflights }),
    );

    await fxDaemon.close();
    const fxGone = await fxAsk(STATUS(true));
    record(
      "Firefox: with nothing listening it is 'unreachable'",
      fxGone?.active === "down" && fxGone?.server?.reason === "unreachable",
      JSON.stringify({ active: fxGone?.active, reason: fxGone?.server?.reason }),
    );

    await fxPage.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ---- summary ---------------------------------------------------------------------------

console.log("\n=== SCORING WITH NO HOST PERMISSION ===");
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(
  `\n${results.length - fails.length - skips.length}/${results.length} checks passed${skips.length ? `, ${skips.length} skipped` : ""}`,
);
console.log(fails.length === 0 ? "✅ NO-HOST GREEN" : "❌ NO-HOST FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
