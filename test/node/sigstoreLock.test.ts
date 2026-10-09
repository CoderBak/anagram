// test/node/sigstoreLock.test.ts — the release's signature check, carried in three places.
//
// install.sh and install.ps1 each carry the pinned verifier list (installer/sigstore.txt) and
// the script that verifies (installer/verify_release.py), copied in by scripts/sigstoreLock.mjs;
// the release workflow signs with the same list. A copy that drifted from its source would
// verify with something nobody reviewed. (test/release-signature.sh runs the verifier itself.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain ES module of the build scripts
import { BEGIN, END, SCRIPT_BEGIN, SCRIPT_END, servesOf } from "../../scripts/sigstoreLock.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8").replace(/^﻿/, "");
const between = (text: string, begin: string, end: string): string => {
  const from = text.indexOf(begin), to = text.indexOf(end);
  expect(from, `${begin} … ${end}`).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to + end.length);
};

describe("the release's signature check", () => {
  const list = read("installer/sigstore.txt");
  const script = read("installer/verify_release.py").trimEnd();

  it("is carried by both installers exactly as its sources have it", () => {
    for (const file of ["install.sh", "install.ps1"]) {
      const text = read(file);
      expect(between(text, BEGIN, END), file).toBe(between(list, BEGIN, END));
      expect(between(text, SCRIPT_BEGIN, SCRIPT_END), file).toBe(`${SCRIPT_BEGIN}\n${script}\n${SCRIPT_END}`);
    }
    // Nothing in them ends PowerShell's here-strings or the shell's heredocs early.
    expect(`${list}\n${script}`.split("\n").filter((line) => /^'@|^(REQUIREMENTS|SCRIPT)$/.test(line))).toEqual([]);
  });

  it("pins sigstore-python as installer/sigstore.in asks, every package by version and hash", () => {
    const pin = read("installer/sigstore.in").trim();
    const lines = between(list, BEGIN, END).split("\n").slice(1, -1);
    expect(lines.some((line) => line.startsWith(`${pin} `))).toBe(true);
    for (const line of lines) expect(line).toMatch(/^[a-z0-9._-]+==[^ ]+( ; [^-]+)? (--hash=sha256:[0-9a-f]{64} ?)+$/);
  });

  it("keeps the wheels a CPython 3.12 can install on the platforms the installers run on, and no others", () => {
    expect(servesOf("cryptography-50.0.2-cp311-abi3-macosx_10_9_universal2.whl")).toEqual(["macOS arm64"]);
    expect(servesOf("cryptography-50.0.2-cp311-abi3-manylinux_2_28_aarch64.whl")).toEqual(["Linux arm64"]);
    expect(servesOf("pydantic_core-2.50.0-cp312-cp312-win_amd64.whl")).toEqual(["Windows x86-64"]);
    expect(servesOf("pydantic_core-2.50.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl")).toEqual(["Linux x86-64"]);
    expect(servesOf("rich-15.0.0-py3-none-any.whl")).toHaveLength(4);
    for (const other of ["pydantic_core-2.50.0-cp313-cp313-win_amd64.whl", "cffi-2.1.1-cp312-cp312-musllinux_1_2_x86_64.whl", "cffi-2.1.1-cp312-cp312-macosx_10_13_x86_64.whl", "cryptography-50.0.2-pp311-pypy311_pp73-manylinux_2_28_x86_64.whl", "cffi-2.1.1.tar.gz"])
      expect(servesOf(other), other).toEqual([]);
  });

  it("trusts only the release workflow at a version tag, the repository the installers download from", () => {
    expect(script).toContain('SIGNER = "https://github.com/CoderBak/anagram/.github/workflows/release.yml@refs/tags/v"');
    expect(script).toContain('ISSUER = "https://token.actions.githubusercontent.com"');
    expect(read("install.sh")).toContain("https://github.com/CoderBak/anagram/releases/latest/download");
    expect(read("install.sh")).toContain('"$RELEASE_URL/anagram.tar.gz.sigstore.json"');
    expect(read("install.ps1")).toContain("'/anagram.zip.sigstore.json'");
  });

  it("is what the release workflow signs with, from the tag, and uploads", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).not.toMatch(/inputs:/);
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    expect(workflow).toMatch(/id-token: write/);
    expect(workflow).toContain("--require-hashes --no-deps --only-binary :all: -r installer/sigstore.txt");
    expect(workflow).toMatch(/sigstore sign anagram\.tar\.gz anagram\.zip /);
    expect(workflow).toContain("dist/*.sigstore.json");
  });
});
