// scripts/bump.mjs — set ONE version across the five files that carry it.
//
//   node scripts/bump.mjs 0.3.2     rewrite all five and print what changed
//   node scripts/bump.mjs --check   verify all five already agree (exit 1 if not)
//
// The extension, the daemon and the installer ship as one artifact, so they must never
// disagree about which version that is — and they did: package-lock.json and
// anagramd/uv.lock sat two releases behind package.json before this existed. The edits
// are deliberately narrow (one field, one line) so the rest of every file — key order,
// indentation, comments, the trailing newline — comes out byte-for-byte unchanged.
//
//   package.json               "version"
//   package-lock.json          "version" and packages[""].version
//   anagramd/pyproject.toml    [project] version
//   anagramd/uv.lock           the version of the [[package]] named "anagramd"
//   install.sh                 INSTALLER_VERSION=
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(msg) {
  console.error(`bump: ${msg}`);
  process.exit(1);
}

/** npm's own lockfile formatting: 2-space JSON, one trailing newline. */
const serialize = (j) => JSON.stringify(j, null, 2) + "\n";

/**
 * A version that lives on one line, replaced by pattern. The pattern must capture the
 * text before the version, the version, and the text after it, and must match exactly
 * the line we mean — every one of these files has other version-shaped lines in it.
 */
function lineField(file, what, re) {
  return {
    file,
    what,
    get: (s) => s.match(re)?.[2] ?? null,
    set: (s, v) => s.replace(re, `$1${v}$3`),
  };
}

/**
 * package-lock.json carries hundreds of dependency "version" keys, so its own two are
 * edited through JSON rather than by pattern. A parse/serialize round trip of the
 * untouched file has to come back byte-for-byte first: npm writes 2-space JSON with a
 * trailing newline, but if that ever stops being true we must not reformat the lockfile.
 */
const packageLock = {
  file: "package-lock.json",
  what: 'version + packages[""].version',
  get(s) {
    const j = JSON.parse(s);
    const root = typeof j.version === "string" ? j.version : null;
    const self = typeof j.packages?.[""]?.version === "string" ? j.packages[""].version : null;
    if (root === null || self === null) return null;
    if (root !== self) fail(`package-lock.json disagrees with itself: "${root}" vs packages[""] "${self}"`);
    return root;
  },
  set(s, v) {
    const j = JSON.parse(s);
    if (serialize(j) !== s) fail("package-lock.json is not 2-space JSON with a trailing newline — refusing to reformat it");
    j.version = v;
    j.packages[""].version = v;
    return serialize(j);
  },
};

const FIELDS = [
  // The only "version" key in package.json; anchored to its own line so no dependency
  // range can ever be mistaken for it.
  lineField("package.json", "version", /^(\s*"version"\s*:\s*")([^"]*)(")/m),
  packageLock,
  lineField("anagramd/pyproject.toml", "[project] version", /^(version\s*=\s*")([^"]*)(")/m),
  // Every locked dependency in uv.lock has a version line too; only the one directly
  // under the daemon's own name may be touched.
  lineField("anagramd/uv.lock", '[[package]] name = "anagramd"', /^(name = "anagramd"\nversion = ")([^"]*)(")/m),
  lineField("install.sh", "INSTALLER_VERSION", /^(INSTALLER_VERSION=")([^"]*)(")/m),
];

/** Read all five. A missing field is fatal: bumping four of five is the drift itself. */
function readAll() {
  return FIELDS.map((f) => {
    const text = readFileSync(join(ROOT, f.file), "utf8");
    const version = f.get(text);
    if (version === null) fail(`${f.file}: no ${f.what} found — the file changed shape, fix this script before releasing`);
    return { ...f, text, version };
  });
}

const arg = process.argv[2];

if (arg === "--check") {
  const found = readAll();
  for (const f of found) console.log(`${f.version.padEnd(10)} ${f.file}`);
  const versions = [...new Set(found.map((f) => f.version))];
  if (versions.length !== 1) fail(`the five versions disagree: ${versions.join(", ")}`);
  console.log(`\nall five agree on ${versions[0]}`);
  process.exit(0);
}

if (!arg || !SEMVER.test(arg)) {
  console.error("Usage: node scripts/bump.mjs <x.y.z>   |   node scripts/bump.mjs --check");
  if (arg) console.error(`  "${arg}" is not a bare x.y.z version`);
  process.exit(1);
}

const found = readAll();
let changed = 0;
for (const f of found) {
  if (f.version === arg) {
    console.log(`  = ${f.file}  already ${arg}`);
    continue;
  }
  const next = f.set(f.text, arg);
  if (f.get(next) !== arg) fail(`${f.file}: the ${f.what} edit did not take`);
  writeFileSync(join(ROOT, f.file), next);
  console.log(`  ✓ ${f.file}  ${f.version} → ${arg}  (${f.what})`);
  changed++;
}
console.log(changed === 0 ? `\nnothing to do — everything was already ${arg}` : `\nbumped ${changed} file${changed === 1 ? "" : "s"} to ${arg}`);
