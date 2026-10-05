// test/node/statsZip.test.ts — the export's zip (lib/stats/zip.ts) opens with a real unzip.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, zip } from "../../lib/stats/zip";

describe("zip", () => {
  it("computes CRC-32 as zlib does", () => {
    expect(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
  it("makes an archive unzip reads back, names in UTF-8 included", () => {
    const dir = mkdtempSync(join(tmpdir(), "anagram-zip-"));
    try {
      const files = [{ name: "manifest.json", text: '{"a":1}\n' }, { name: "visits.csv", text: "id,url\nv1,https://例え.jp/\n" }];
      writeFileSync(join(dir, "out.zip"), zip(files));
      execFileSync("unzip", ["-q", join(dir, "out.zip"), "-d", join(dir, "x")]);
      for (const f of files) expect(readFileSync(join(dir, "x", f.name), "utf8")).toBe(f.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
