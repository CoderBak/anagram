// scripts/i18nSubset.ts — which English messages a given bundle can actually show.
//
// lib/i18n.ts imports the English file so every lookup has an answer where there is no
// extension API (the esbuild unit bundle, vitest) and where there is no longer one (a
// content script whose extension context was invalidated). That fallback is ~20 kB of
// prose, and it used to be compiled into EVERY bundle in full — the content script
// carried the options page's 71 strings and the onboarding page's 54 on every web page
// it ran on, and could never show one of them.
//
// So the import is answered per BUILD. WXT builds the background, each content script
// and the extension pages as separate Vite builds (see wxt.config.ts), and each of those
// builds gets the messages ITS entry can name and no others.
//
// WHICH KEYS — from the source, never from the key's prefix. Starting at the entry file
// (a .ts, or a page's .html and the modules its <script> tags name), our own relative
// imports are followed to every source file the entry can reach, and every quoted
// identifier in those files that happens to name a message — or to name a plural's base,
// `foo` for `foo_one`/`foo_other` — is kept. That is deliberately a SUPERSET of the
// `t("…")` calls: it also catches a key held in a table (lib/render/band.ts's Band →
// key record), a key picked out of a `const` array (the options page's column headers)
// and a key that only ever appears in a page's `data-i18n` attribute, without any of
// them having to be written a particular way.
//
// WHY THAT IS SAFE. A file we failed to follow would be a file whose keys we drop, so
// the scan is checked against the bundler's own module graph at the end of the build
// (`unscanned`): if the build pulled in a source file this scan never read, the build
// FAILS rather than shipping a bundle that is quietly missing a string. And every
// literal key an entry passes to `t()` / `tn()` / `data-i18n` is asserted to exist in
// en/messages.json (`unknownKeys`), which is the old "a key nobody wrote" vitest moved
// forward to the build.
//
// THE ONE THING IT CANNOT SEE is a key assembled at run time out of pieces —
// `t("band" + kind)`. There is none in the tree, and there is no need to write one: a
// table of literals, which is how lib/render/band.ts does it, is read perfectly well.
//
// Worst case anyway: in a real extension `browser.i18n.getMessage` answers from the
// COMPLETE messages.json that ships in _locales/, so a key missing from a bundle's
// fallback is only ever visible where there is no extension at all.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** One entry of a WebExtension messages.json, after the descriptions are stripped. */
export interface Message {
  message: string;
}

/** Source files we read for keys and follow imports through. */
const CODE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
/** The extensions of the extensionless relative imports our code is written with. */
const TRIED = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.js"];

/** `import … from "x"`, `import("x")`, `import "x"`, `export … from "x"`. */
const SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
/** A page's module scripts: `<script type="module" src="./main.ts">`. */
const SCRIPT_SRC = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
/** Any quoted bareword — the widest thing that could be naming a message. */
const QUOTED = /["'`]([A-Za-z][A-Za-z0-9_]*)["'`]/g;
/** The keys an entry names OUT LOUD, which therefore have to exist. */
const NAMED = /\bt\(\s*["']([A-Za-z0-9_]+)["']|\btn\(\s*["']([A-Za-z0-9_]+)["']|\bdata-i18n(?:-title|-aria-label|-placeholder|-html)?=["']([A-Za-z0-9_]+)["']/g;

/** `messageLocale()` is what every page sets `<html lang>` from: always compiled in. */
const ALWAYS = ["localeTag"];

/** A real path, POSIX or Windows — what an entry has to be for us to read it. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;

/** WXT's tsconfig aliases for the project root, all four of them. */
const ALIAS = /^(?:@@?|~~?)\//;

/** The file an import names, with our extensionless style and the root aliases resolved. */
function resolveImport(spec: string, importer: string, root: string): string | undefined {
  const base = ALIAS.test(spec)
    ? resolve(root, spec.slice(spec.indexOf("/") + 1))
    : resolve(dirname(importer), spec);
  for (const suffix of TRIED) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Every source file reachable from `entries`, entries included.
 *
 * Only our OWN imports are followed — relative, or through one of WXT's root aliases:
 * every other specifier is a dependency or one of WXT's virtual modules, and nothing
 * under node_modules asks us for a message. A specifier that resolves to nothing is left
 * alone rather than thrown at — the scan reads comments too, and a path in a comment is
 * not a build error. The module-graph check at the end of the build is what makes a
 * genuinely missed import impossible.
 */
export function reachableSources(entries: string[], root: string): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const specs: string[] = [];
    if (file.endsWith(".html")) {
      for (const m of text.matchAll(SCRIPT_SRC)) specs.push(m[1]);
    } else if (CODE.test(file)) {
      for (const m of text.matchAll(SPECIFIER)) specs.push(m[1] ?? m[2] ?? m[3]);
    }
    for (const spec of specs) {
      if (!spec.startsWith(".") && !spec.startsWith("/") && !ALIAS.test(spec)) continue;
      const target = resolveImport(spec, file, root);
      // Code and pages only. The one other thing our sources import is the English file
      // itself, and reading THAT for keys would of course find every one of them.
      if (!target || seen.has(target)) continue;
      if (CODE.test(target) || target.endsWith(".html")) queue.push(target);
    }
  }
  return [...seen].sort();
}

/** Both halves of a plural, for a bareword that is one's base. */
const plural = (key: string): [string, string] => [`${key}_one`, `${key}_other`];

/**
 * The keys `files` can name, and the ones they name that do not exist.
 *
 * `all` is the English file. A bareword counts as a key when it IS one, or when it is
 * the base of a plural pair — which is how `tn("countAria", n)` reaches `countAria_one`
 * and `countAria_other` without either of them ever being written down.
 */
export function keysUsedBy(
  files: string[],
  all: Record<string, unknown>,
): { keys: string[]; unknownKeys: string[] } {
  // hasOwn, not `in`: a bareword like "constructor" or "toString" is on every object's
  // prototype, and would otherwise be compiled in as a message with no text.
  const has = (key: string): boolean => Object.hasOwn(all, key);
  const keys = new Set<string>(ALWAYS.filter(has));
  const unknown = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(QUOTED)) {
      const word = m[1];
      if (has(word)) keys.add(word);
      const [one, other] = plural(word);
      if (has(one) && has(other)) {
        keys.add(one);
        keys.add(other);
      }
    }
    for (const m of text.matchAll(NAMED)) {
      const word = m[1] ?? m[2] ?? m[3];
      const [one, other] = plural(word);
      if (!has(word) && !(has(one) && has(other))) unknown.add(`${word} (${file})`);
    }
  }
  return { keys: [...keys].sort(), unknownKeys: [...unknown].sort() };
}

/** `{ key: { message } }` for exactly `keys` — the shape lib/i18n.ts reads. */
export function subsetMessages(
  all: Record<string, { message: string }>,
  keys: string[],
): Record<string, Message> {
  const lean: Record<string, Message> = {};
  for (const key of keys) lean[key] = { message: all[key].message };
  return lean;
}

/**
 * The entry FILES of one Vite build, or undefined when it has none to speak of.
 *
 * WXT gives the background and each content script their own single-entry library build,
 * behind a virtual module that carries the real path after a `?`; the extension pages
 * are one build with an HTML entry each. Anything else — a config resolved for no build
 * at all, or some future shape — answers undefined, and the whole English file is
 * compiled in, exactly as it was before this existed.
 */
export function entryFilesOf(config: {
  build?: {
    lib?: false | { entry?: unknown };
    rollupOptions?: { input?: unknown };
  };
}): string[] | undefined {
  const lib = config.build?.lib;
  const entry = lib === false || lib == null ? undefined : lib.entry;
  if (typeof entry === "string") {
    const real = entry.startsWith("virtual:") ? entry.slice(entry.indexOf("?") + 1) : entry;
    return real.includes("?") || !ABSOLUTE.test(real) ? undefined : [real];
  }
  const input = config.build?.rollupOptions?.input;
  const list =
    typeof input === "string"
      ? [input]
      : Array.isArray(input)
        ? input
        : input && typeof input === "object"
          ? Object.values(input as Record<string, string>)
          : [];
  const files = list.filter((x): x is string => typeof x === "string" && ABSOLUTE.test(x));
  return files.length > 0 ? files : undefined;
}

/**
 * Source files the bundler really pulled in that this scan never read.
 *
 * Anything left here is a key we could be dropping, so the caller fails the build. Only
 * our own tree counts: dependencies never call `t()`, and `.wxt/` holds WXT's generated
 * re-export shims, which hold no messages.
 */
export function unscanned(moduleIds: Iterable<string>, root: string, scanned: string[]): string[] {
  // Module ids come from the bundler with forward slashes even on Windows, while
  // node:path hands back the platform's own — one spelling, or the check is inert there.
  const slash = (p: string): string => p.replace(/\\/g, "/");
  const base = `${slash(root)}/`;
  const known = new Set(scanned.map(slash));
  const out = new Set<string>();
  for (const raw of moduleIds) {
    const id = slash(raw).split("?")[0];
    if (!id.startsWith(base)) continue;
    if (id.includes("/node_modules/") || id.includes("/.wxt/")) continue;
    if (!CODE.test(id) || known.has(id)) continue;
    out.add(id);
  }
  return [...out].sort();
}
