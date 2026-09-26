// scripts/machinePaths.mjs — no path of the machine that built Anagram in what it ships.
//
// A bundler that writes a module's own location into its output (webpack's import.meta.url,
// a __filename, a source map) ships the builder's directory, and their user name with it,
// to everyone who installs the result. Every build (wxt.config.ts), the release
// (scripts/release.mjs), the document-worker rebuild and test/node/machinePaths.test.ts
// read every file for one, text and binary alike.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Not Emscripten's virtual /home/web_user, which pdf.js's decoders and the ONNX runtime
// carry, and not the paths of upstream's own build agents inside the WebAssembly pinned from
// npm (/mnt/…/_work/…, /tmp/openjpeg/…): those name nobody.
const MACHINE_PATH = new RegExp([
  // A home directory on macOS or Linux, not a path inside some URL.
  String.raw`(?<![\w.~%-])/(?:Users|home|root)/(?!web_user\b)[\w.-]+`,
  // macOS's per-user temporary folders.
  String.raw`/var/folders/\w`,
  // A Windows profile, however the backslashes are escaped.
  String.raw`\b[A-Za-z]:(?:\\+|/)(?:Users|Documents and Settings)\b`,
  // A file: URL into a machine's own tree.
  String.raw`file:///+(?:[A-Za-z]:|(?:Users|home|root|private|tmp|var|Volumes|mnt|opt|srv|media)\b)`,
].join("|"), "g");

/** Every build-machine path in `text`, up to where the path ends. */
export function machinePathsIn(text) {
  const found = new Set();
  for (const { index } of text.matchAll(MACHINE_PATH)) found.add(text.slice(index).match(/^[^\s"'`<>()|,;]{1,120}/)[0]);
  return [...found];
}

/** Every file under `dir` that carries one, as "<file relative to dir>: <paths>". */
export function machinePaths(dir) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const paths = machinePathsIn(readFileSync(path).toString("latin1"));
      if (paths.length > 0) found.push(`${relative(dir, path).split(sep).join("/")}: ${paths.join(", ")}`);
    }
  };
  walk(dir);
  return found;
}
