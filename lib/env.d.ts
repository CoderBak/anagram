// Build-time values wxt.config.ts defines beside WXT's own (BROWSER, …).
interface ImportMetaEnv {
  /** Which Anagram this build is (scripts/flavor.mjs). A branch on it is dropped from the
   *  other flavor's bundle; whole modules are swapped through "#flavor/…" imports instead. */
  readonly ANAGRAM_FLAVOR: "native" | "oneclick";
  /** "1" in the test build (output-test/), "" in the shipping one: a branch on it is dropped
   *  from the shipping bundles. */
  readonly ANAGRAM_TEST_BUILD: "1" | "";
}
