// Build the test extension once, before the workers start: each would otherwise find it
// stale at the same moment and build it over the others (test/test-build.mjs); and the
// copies made from it and from the shipping build (deviceBuild, shippingWithNative) are made
// here too, for the same reason.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { deviceBuild, ensureTestBuild, shippingWithNative } from "../test-build.mjs";
import { DEVICES } from "./devices.mjs";

export default function globalSetup() {
  ensureTestBuild("chrome-mv3");
  for (const [name, device] of Object.entries(DEVICES)) deviceBuild(name, device);
  // The local engine in use (Native Messaging granted) on an Apple Silicon Mac: the crash fallback.
  deviceBuild("apple-silicon", DEVICES["apple-silicon"], { native: "required" });
  // The suites on the shipping build (`npm run build` first) drive the local engine's fake host.
  if (existsSync(join(import.meta.dirname, "..", "..", "output", "chrome-mv3", "manifest.json"))) shippingWithNative();
}
