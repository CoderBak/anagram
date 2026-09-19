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
// The variant is built HERE when it is missing or older than the sources, so a runner that
// only knows `npm run build` (scripts/fullsuite, a developer on a branch) keeps working.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Where the variant is built. `npm run build` never writes here. */
export const TEST_OUT = join(ROOT, "output-test");

/** Everything whose change means the build on disk is stale. */
const SOURCES = ["entrypoints", "lib", "public", "scripts", "wxt.config.ts", "package.json"];

function newestMtime(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const name of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, name)));
  }
  return newest;
}

/**
 * Make sure output-test/<dir> is there and not older than the sources; build it if not.
 * `dir` is "chrome-mv3" or "firefox-mv2".
 */
export function ensureTestBuild(dir = "chrome-mv3") {
  const manifest = join(TEST_OUT, dir, "manifest.json");
  const builtAt = existsSync(manifest) ? statSync(manifest).mtimeMs : 0;
  const sourceAt = Math.max(...SOURCES.map((s) => newestMtime(join(ROOT, s))));
  if (builtAt > sourceAt) return join(TEST_OUT, dir);
  console.log(`building the test extension (output-test/${dir})…`);
  execFileSync(
    process.execPath,
    [join(ROOT, "scripts", "buildTest.mjs"), ...(dir === "firefox-mv2" ? ["--firefox"] : [])],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (!existsSync(manifest)) {
    console.error(`the test build produced no ${dir} manifest`);
    process.exit(2);
  }
  return join(TEST_OUT, dir);
}
