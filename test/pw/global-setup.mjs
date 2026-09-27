// Build the test extension once, before the workers start: each would otherwise find it
// stale at the same moment and build it over the others (test/test-build.mjs).
import { ensureTestBuild } from "../test-build.mjs";

export default function globalSetup() {
  ensureTestBuild("chrome-mv3");
}
