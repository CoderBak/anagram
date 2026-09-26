// test/node/machinePaths.test.ts — no path of the building machine in what ships.
//
// Every build checks its own output (wxt.config.ts) and the release its component
// (scripts/release.mjs); this reads the committed vendor files and the last builds.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { machinePaths, machinePathsIn } from "../../scripts/machinePaths.mjs";

const ROOT = join(__dirname, "..", "..");

describe("build-machine paths", () => {
  it("are recognised, and what names nobody is not", () => {
    for (const leak of [
      "file:///Users/jane/anagram/.cache/document-worker/pdf.js/external/jbig2/jbig2.js",
      "/home/runner/work/anagram/anagram/node_modules/x.js",
      "/root/.cache/x",
      "/var/folders/7x/abc/T/anagram",
      "C:\\\\Users\\\\jane\\\\anagram",
      "file:///C:/Users/jane/anagram",
      "file:///tmp/anagram/build/x.js",
    ]) expect(machinePathsIn(`e="${leak}"`), leak).not.toEqual([]);
    for (const clean of [
      'HOME:"/home/web_user"',
      '"file:///*"',
      '"file:///document-worker/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs"',
      "/mnt/azure_nvme_temp/_work/1/s/onnxruntime/core/framework/copy.h",
      "https://example.com/home/jane",
      '"../build/pdf.worker.mjs"',
    ]) expect(machinePathsIn(clean), clean).toEqual([]);
  });

  it("are in none of the committed vendor files", () => {
    expect(machinePaths(join(ROOT, "vendor"))).toEqual([]);
  });

  for (const dir of ["public/vendor", "output/chrome-mv3", "output/firefox-mv2", "output-test/chrome-mv3", "output-test/firefox-mv2"]) {
    it.skipIf(!existsSync(join(ROOT, dir)))(`are in nothing under ${dir}`, () => {
      expect(machinePaths(join(ROOT, dir))).toEqual([]);
    });
  }
});
