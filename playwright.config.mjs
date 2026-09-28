// playwright.config.mjs — the suites that run under Playwright Test (test/pw/).
//
// Every test launches its own temporary profile with the extension (test/pw/fixtures.mjs),
// so they run side by side. No retries: a check that passes on its second try is a bug in
// the check or in the product, and is fixed where it is.
//
// The performance budgets measure time, so they are a project of their own: one worker,
// after everything else has passed (`npm run test:perf` runs them alone, with --no-deps).
// The live sites are the only tests that go to the network, so their project exists only
// when asked for with ANAGRAM_LIVE=1, which `npm run test:scenarios` sets.
import { defineConfig } from "@playwright/test";

const LIVE = process.env.ANAGRAM_LIVE === "1";

export default defineConfig({
  testDir: "test/pw",
  globalSetup: "./test/pw/global-setup.mjs",
  outputDir: "test-results/pw",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  projects: [
    { name: "chromium", testMatch: "**/*.spec.mjs", testIgnore: ["**/perf.spec.mjs", "**/scenarios-live.spec.mjs"] },
    ...(LIVE ? [{ name: "live", testMatch: "**/scenarios-live.spec.mjs" }] : []),
    { name: "perf", testMatch: "**/perf.spec.mjs", dependencies: ["chromium"], workers: 1, fullyParallel: false, timeout: 15 * 60_000 },
  ],
});
