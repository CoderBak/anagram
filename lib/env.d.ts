// Build-time values wxt.config.ts defines beside WXT's own (BROWSER, …).
interface ImportMetaEnv {
  /** Which Anagram this build is (scripts/flavor.mjs). A branch on it is dropped from the
   *  other flavor's bundle; whole modules are swapped through "#flavor/…" imports instead. */
  readonly ANAGRAM_FLAVOR: "native" | "oneclick";
}
