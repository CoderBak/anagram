// Build the test extensions once, before the workers start: each would otherwise find them
// stale at the same moment and build them over the others (test/test-build.mjs). The
// oneclick flavor's is for the in-browser engine's setup in a11y.spec.mjs, and goes first:
// every build rewrites the vendored chunks (scripts/vendor.mjs), which leaves an earlier
// build older than its sources, and the workers check only the native one.
import { ensureTestBuild } from "../test-build.mjs";

export default function globalSetup() {
  ensureTestBuild("oneclick-chrome-mv3");
  ensureTestBuild("chrome-mv3");
}
