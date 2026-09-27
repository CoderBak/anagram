// Build the test extensions once, before the workers start: each would otherwise find them
// stale at the same moment and build them over the others (test/test-build.mjs). The
// oneclick flavor's is for the in-browser engine's setup in a11y.spec.mjs.
import { ensureTestBuild } from "../test-build.mjs";

export default function globalSetup() {
  ensureTestBuild("chrome-mv3");
  ensureTestBuild("oneclick-chrome-mv3");
}
