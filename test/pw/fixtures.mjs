// test/pw/fixtures.mjs — Playwright Test fixtures for the extension suites.
//
// Each test gets its own browser, built on the same launch the node runners use
// (test/harness.mjs): a deterministic Native Messaging host in a temporary home, a fresh
// temporary Chromium profile with the extension loaded and that host registered in it, and
// the page. Nothing is shared between tests but the page servers, and nothing touches a
// real profile or ~/.anagram.
//
//   nativeHost  the fake host (test/fake-native.mjs); close()/resume() stop and start it
//   extension   { context, sw, extId, url(path), worker() } for the build the test asks for
//   context     that persistent context (replaces Playwright's own, so no second browser)
//   page        a tab in it; the test fails on any uncaught error in it
//   pages       this worker's page server: pages.serve({ "/a.html": html }) and pages.url()
//   pdfServer   the same server answering every *.pdf with the fixture PDF
//   storage     chrome.storage.local, read and written from the extension's worker
//   clipboard   the system clipboard, granted; or a recorder in place of it on one page
//
// Options, with test.use():
//   build       "test" (output-test/, which grants every site), "shipping" (output/, what
//               `npm run build` makes) or the path of an unpacked build
//   launch      extra launchExtension() options: viewport, colorScheme, …
//   uiLanguage  the browser's UI language ("zh-CN"); a test the browser does not come up
//               in that language for is skipped, never run against English
//   offline     the context is offline and the test fails on any http(s) request
//   tracing     false turns the trace off: it records the page as it goes, which a suite
//               that measures time or memory must not pay for
//
// A failed test keeps a trace and a screenshot in its test-results/ folder:
// `npx playwright show-trace <zip>`.
import http from "node:http";
import { isAbsolute, join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { closeServer, launchExtension, uiLanguage as uiLanguageLaunch, uiLanguageOf } from "../harness.mjs";
import { createNativeFixture } from "../fake-native.mjs";
import { LOCKED_PDF, TEST_PDF } from "../pdf-fixture.mjs";

const SHIPPING = join(import.meta.dirname, "..", "..", "output", "chrome-mv3");

/** What a route answers: an HTML string, bytes (a PDF when the path says so) or a handler. */
function answer(route, path, req, res) {
  if (typeof route === "function") return route(req, res);
  const pdf = Buffer.isBuffer(route) && /\.pdf$/i.test(path);
  const type = pdf ? "application/pdf" : "text/html; charset=utf-8";
  res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(route) });
  res.end(route);
}

/** An http server on localhost whose routes the tests set; `*` answers what nothing else does. */
async function pageServer() {
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    const route = routes.get(path) ?? [...routes].find(([key]) => key.startsWith("*") && path.endsWith(key.slice(1)))?.[1];
    if (route === undefined) return void res.writeHead(404).end();
    answer(route, path, req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { routes, base: `http://localhost:${server.address().port}`, close: () => closeServer(server) };
}

export const test = base.extend({
  build: ["test", { option: true }],
  launch: [{}, { option: true }],
  uiLanguage: [null, { option: true }],
  offline: [false, { option: true }],
  tracing: [true, { option: true }],

  nativeHost: async ({}, use) => {
    const host = await createNativeFixture();
    await use(host);
    await host.close();
    host.dispose();
  },

  extension: async ({ build, launch, uiLanguage, tracing, nativeHost }, use, testInfo) => {
    const extDir = build === "shipping" ? SHIPPING : isAbsolute(build) ? build : undefined;
    const language = uiLanguage ? uiLanguageLaunch(uiLanguage) : {};
    const launched = await launchExtension({ nativeFixture: nativeHost, extDir, ...language, ...launch });
    if (!launched.extId) {
      await launched.context.close();
      throw new Error("the extension's worker never started");
    }
    if (uiLanguage) {
      // The launch cannot promise the language (harness.mjs uiLanguage()): read it back.
      const got = (await uiLanguageOf(launched.sw))?.replace("_", "-").toLowerCase() ?? null;
      const want = uiLanguage.toLowerCase();
      if (got !== want && !got?.startsWith(`${want}-`)) {
        await launched.context.close();
        testInfo.skip(true, `the browser came up in ${got ?? "no language"}, not ${uiLanguage}`);
      }
    }
    const { context, extId } = launched;
    /** The extension's worker as it is now: a reload (the file-access switch) replaces it. */
    const worker = () => context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`)) ?? launched.sw;
    if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });
    await use({ ...launched, worker, url: (path) => `chrome-extension://${extId}/${path}` });
    const failed = testInfo.status !== testInfo.expectedStatus;
    if (tracing) await context.tracing.stop(failed ? { path: testInfo.outputPath("trace.zip") } : undefined).catch(() => {});
    await context.close();
  },

  // Offline, when asked: nothing may leave for the network, what the extension needs it carries.
  context: async ({ extension, offline }, use) => {
    const { context } = extension;
    if (!offline) return void (await use(context));
    await context.setOffline(true);
    const external = [];
    const record = (request) => {
      if (/^https?:/.test(request.url())) external.push(request.url());
    };
    context.on("request", record);
    await use(context);
    context.off("request", record);
    expect(external, "requests that left the extension").toEqual([]);
  },

  page: async ({ context }, use, testInfo) => {
    const page = await context.newPage();
    const errors = [];
    // The stack too: an error thrown with no message is otherwise an empty line.
    page.on("pageerror", (error) => errors.push(error.stack || `${error.name}: ${error.message}`));
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await page.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => {});
    }
    expect(errors, "uncaught errors in the page").toEqual([]);
  },

  pageServer: [
    async ({}, use) => {
      const server = await pageServer();
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],

  pages: async ({ pageServer }, use) => {
    const mine = new Set();
    const pages = {
      base: pageServer.base,
      url: (path) => pageServer.base + path,
      /** Add routes for this test: { "/path": html | Buffer | (req, res) => void }. */
      serve(routes) {
        for (const [path, route] of Object.entries(routes)) {
          pageServer.routes.set(path, route);
          mine.add(path);
        }
        return pages;
      },
    };
    await use(pages);
    for (const path of mine) pageServer.routes.delete(path);
  },

  pdfServer: async ({ pages }, use) => {
    await use(pages.serve({ "/locked.pdf": LOCKED_PDF, "*.pdf": TEST_PDF }));
  },

  storage: async ({ extension }, use) => {
    await use({
      get: (keys) => extension.worker().evaluate((k) => chrome.storage.local.get(k), keys),
      set: (items) => extension.worker().evaluate((v) => chrome.storage.local.set(v), items),
    });
  },

  clipboard: async ({ context }, use) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await use({
      read: (page) => page.evaluate(() => navigator.clipboard.readText().catch(() => null)),
      write: (page, text) => page.evaluate((t) => navigator.clipboard.writeText(t).catch(() => {}), text),
      /** Put a recorder in place of the page's clipboard; the function reads what it was last given. */
      async record(page) {
        await page.evaluate(() => {
          window.__clipboard = "";
          Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.__clipboard = text; } } });
        });
        return () => page.evaluate(() => window.__clipboard);
      },
    });
  },
});

export { expect };
