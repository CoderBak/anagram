// test/test-build.mjs — the build the browser suites load.
//
// Anagram ships with access to NO site: the user grants it, and a permission prompt is
// native browser UI that neither Playwright nor WebDriver can click (and `activeTab`
// cannot be granted synthetically at all). A suite driving the shipping build would
// therefore be looking at an extension that may read nothing, which is not the thing
// anybody wants tested.
//
// So the suites load the TEST VARIANT: the same code, built with ANAGRAM_TEST_GRANT_ALL=1,
// where the two optional site patterns are REQUIRED host permissions instead. The same
// runtime registration runs — it simply finds everything granted — and nothing else
// differs. It lives in output-test/, so `npm run build` is always the shipping build and
// test/node/permissions.test.ts can pin what that one asks for.
//
// The variant is built HERE when it is missing or was built from other sources than those
// on disk (its stamp, scripts/buildStamp.mjs), so a suite run straight from a checkout — or
// after a `npm run build` and nothing else — keeps working, and one that changed nothing
// does not wait for a build.
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inputsHash, readStamp } from "../scripts/buildStamp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Where the variant is built. `npm run build` never writes here. */
export const TEST_OUT = join(ROOT, "output-test");

/** The builds this process has found current: every launch asks, and one look is enough. */
const current = new Set();

/**
 * Make sure output-test/<dir> is there and built from the sources on disk; build it if not.
 * `dir` is "chrome-mv3" or "firefox-mv2".
 */
export function ensureTestBuild(dir = "chrome-mv3") {
  const manifest = join(TEST_OUT, dir, "manifest.json");
  if (current.has(dir)) return join(TEST_OUT, dir);
  if (existsSync(manifest) && readStamp(TEST_OUT, dir) === inputsHash(ROOT)) {
    current.add(dir);
    return join(TEST_OUT, dir);
  }
  console.log(`building the test extension (output-test/${dir})…`);
  execFileSync(
    process.execPath,
    [join(ROOT, "scripts", "buildTest.mjs"), ...(dir.endsWith("firefox-mv2") ? ["--firefox"] : [])],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (!existsSync(manifest)) {
    console.error(`the test build produced no ${dir} manifest`);
    process.exit(2);
  }
  current.add(dir);
  return join(TEST_OUT, dir);
}

/**
 * `from`'s files at `to`, hard-linked, with its manifest changed by `edit` and `extra` files
 * ({ name: text }) beside them; made again when `from` was built after it, or `extra` differs.
 */
function derivedBuild(from, to, edit, extra = {}) {
  const manifestPath = join(to, "manifest.json");
  const fresh = existsSync(manifestPath) && statSync(manifestPath).mtimeMs > statSync(join(from, "manifest.json")).mtimeMs &&
    Object.entries(extra).every(([name, text]) => existsSync(join(to, name)) && readFileSync(join(to, name), "utf8") === text);
  if (fresh) return to;
  rmSync(to, { recursive: true, force: true });
  const link = (dir) => {
    mkdirSync(join(to, dir), { recursive: true });
    for (const entry of readdirSync(join(from, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) link(rel);
      else if (rel !== "manifest.json") linkSync(join(from, rel), join(to, rel));
    }
  };
  link("");
  const manifest = JSON.parse(readFileSync(join(from, "manifest.json"), "utf8"));
  edit(manifest);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(to, name), text);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return to;
}

/**
 * A copy of the test build that stands in for a device: `device` (lib/device.ts's inputs,
 * any of them) goes into test-device.json, which only the test build reads, over what this
 * machine says (lib/ui/deviceInputs.ts). Native Messaging is optional in it, as shipped, so
 * nothing is chosen until the setup page decides; `native: "required"` keeps the test build's
 * grant, which makes the local engine the one in use, as an update from a release that
 * required it does. Returns the copy's folder, output-test/devices/<name>-<browser>[-granted].
 */
export function deviceBuild(name, device, { browser = "chrome", native = "optional" } = {}) {
  const from = ensureTestBuild(browser === "firefox" ? "firefox-mv2" : "chrome-mv3");
  const to = join(TEST_OUT, "devices", `${name}-${browser}${native === "required" ? "-granted" : ""}`);
  return derivedBuild(from, to, (manifest) => {
    if (native !== "optional") return;
    manifest.permissions = manifest.permissions.filter((p) => p !== "nativeMessaging");
    manifest.optional_permissions = [...(manifest.optional_permissions ?? []), "nativeMessaging"];
  }, { "test-device.json": JSON.stringify(device) });
}

/**
 * The shipping build (output/chrome-mv3, what `npm run build` makes) with Native Messaging
 * granted, as a person who picked the local engine has it (or an update from a release that
 * required it): the suites that drive the fake host through the shipping pages. Nothing else
 * differs. output-test/shipping-native/chrome-mv3.
 */
export function shippingWithNative() {
  const from = join(ROOT, "output", "chrome-mv3");
  return derivedBuild(from, join(TEST_OUT, "shipping-native", "chrome-mv3"), (manifest) => {
    manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== "nativeMessaging");
    manifest.permissions = [...manifest.permissions, "nativeMessaging"];
  });
}
