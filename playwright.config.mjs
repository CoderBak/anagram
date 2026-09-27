// playwright.config.mjs — the suites that run under Playwright Test (test/pw/).
//
// Every test launches its own temporary profile with the extension (test/pw/fixtures.mjs),
// so they run side by side. No retries: a check that passes on its second try is a bug in
// the check or in the product, and is fixed where it is.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/pw",
  testMatch: "**/*.spec.mjs",
  globalSetup: "./test/pw/global-setup.mjs",
  outputDir: "test-results/pw",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
});
