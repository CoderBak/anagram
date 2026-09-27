// test/node/firefoxVersion.test.ts — how the Firefox suites learn which Firefox they drive
// (test/firefox-harness.mjs). The version is read from the install, not from a browser the
// machine may fail to start at that moment; when it has to start one, the reason it failed
// is told rather than swallowed.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — a plain ES module of the test harness, without types
import { firefoxVersion } from "../firefox-harness.mjs";

const INI = (version: string, repository: string) =>
  `[App]\nVendor=Mozilla\nName=Firefox\nRemotingName=firefox\nVersion=${version}\nBuildID=20260908152208\nSourceRepository=${repository}\n`;

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A Firefox install whose binary cannot start: it exits at once, printing nothing. */
function install(layout: "mac" | "flat", ini: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "anagram-firefox-version-"));
  homes.push(home);
  const bin = layout === "mac" ? join(home, "Firefox.app", "Contents", "MacOS") : join(home, "firefox");
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, process.platform === "win32" ? "firefox.cmd" : "firefox");
  writeFileSync(exe, process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
  chmodSync(exe, 0o755);
  if (ini !== null) {
    const resources = layout === "mac" ? join(home, "Firefox.app", "Contents", "Resources") : bin;
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "application.ini"), ini);
  }
  return exe;
}

describe("the Firefox a suite drives", () => {
  it("is known by its install, whether or not the browser could start just then", () => {
    const esr = firefoxVersion(install("mac", INI("140.16.0", "https://hg.mozilla.org/releases/mozilla-esr140")));
    expect(esr).toEqual({ version: "140.16.0esr", major: 140, banner: "Mozilla Firefox 140.16.0esr" });
    const release = firefoxVersion(install("flat", INI("156.0.1", "https://hg.mozilla.org/releases/mozilla-release")));
    expect(release).toEqual({ version: "156.0.1", major: 156, banner: "Mozilla Firefox 156.0.1" });
  });

  it("where the install says nothing, starts it, and tells why that failed", () => {
    const got = firefoxVersion(install("flat", null));
    expect(got.version).toBeUndefined();
    expect(got.error).toMatch(/--version failed/);
  });
});
