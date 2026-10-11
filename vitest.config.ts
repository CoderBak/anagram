// vitest.config.ts — Node-level unit tests for the service-worker logic (router, caches,
// backend client) against WXT's in-memory browser API (`wxt/testing/fake-browser`).
// The DOM-dependent suites stay in Playwright (test/unit.mjs and friends).
import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  // WXT resolves its plugins against its own vite (rolldown) typings while vitest ships a
  // nested vite; the plugin objects are runtime-compatible, only the types disagree.
  plugins: [WxtVitest() as never],
  test: {
    include: ["test/node/**/*.test.ts"],
    restoreMocks: true,
    // The property tests take a few seconds here and three to five times that on a CI runner
    // (the Windows one ran the scheduler's 18 s, a PDF one 5.8 s): 5 s failed tests that pass.
    // What has its own time bound asserts it.
    testTimeout: 30_000,
  },
});
