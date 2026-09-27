// test/pw/fixtures.mjs — Playwright Test fixtures for the extension suites.
//
// Each test gets its own everything, built on the same launch the node runners use
// (test/harness.mjs): a deterministic Native Messaging host in a temporary home, a fresh
// temporary Chromium profile with the extension loaded and that host registered in it, and
// the page. Nothing is shared between tests and nothing touches a real profile or ~/.anagram.
//
//   nativeHost  the fake host (test/fake-native.mjs); close()/resume() stop and start it
//   extension   { context, sw, extId } for the build the test asks for
//   context     that persistent context (replaces Playwright's own, so no second browser)
//   page        a tab in it; the test fails on any uncaught error in it
//
// `test.use({ build: "shipping" })` loads output/ (what `npm run build` makes) instead of
// the test build in output-test/, which already grants every site. A failed test keeps a
// trace and a screenshot in its test-results/ folder: `npx playwright show-trace <zip>`.
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { launchExtension } from "../harness.mjs";
import { createNativeFixture } from "../fake-native.mjs";

const SHIPPING = join(import.meta.dirname, "..", "..", "output", "chrome-mv3");

export const test = base.extend({
  build: ["test", { option: true }],

  nativeHost: async ({}, use) => {
    const host = await createNativeFixture();
    await use(host);
    await host.close();
    host.dispose();
  },

  extension: async ({ build, nativeHost }, use, testInfo) => {
    const launched = await launchExtension({ nativeFixture: nativeHost, extDir: build === "shipping" ? SHIPPING : undefined });
    if (!launched.extId) throw new Error("the extension's worker never started");
    await launched.context.tracing.start({ screenshots: true, snapshots: true });
    await use(launched);
    const failed = testInfo.status !== testInfo.expectedStatus;
    await launched.context.tracing.stop(failed ? { path: testInfo.outputPath("trace.zip") } : undefined).catch(() => {});
    await launched.context.close();
  },

  context: async ({ extension }, use) => {
    await use(extension.context);
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
});

export { expect };
