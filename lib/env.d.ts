// Build-time values wxt.config.ts defines beside WXT's own (BROWSER, …).
interface ImportMetaEnv {
  /** "1" in the test build (output-test/), "" in the shipping one: a branch on it is dropped
   *  from the shipping bundles. */
  readonly ANAGRAM_TEST_BUILD: "1" | "";
}
