import { describe, expect, it } from "vitest";
import { installationCommand } from "../../lib/ui/installationCommand";

const chromeId = "a".repeat(32);
describe("native installation command", () => {
  it.each(["mac", "linux"])("pins %s scripts and assets to the installed extension version", (os) => {
    const result = installationCommand(os, "chrome", chromeId, "0.4.0", "en")!;
    expect(result.scriptUrl).toBe("https://github.com/CoderBak/anagram/releases/download/v0.4.0/install.sh");
    expect(result.command).toContain(`ANAGRAM_EXTENSION_ID='${chromeId}'`);
    expect(result.command).toContain("ANAGRAM_BROWSER='chrome'");
    expect(result.command).toContain("ANAGRAM_LANG='en'");
    expect(result.command).toContain("ANAGRAM_RELEASE_URL='https://github.com/CoderBak/anagram/releases/download/v0.4.0'");
    expect(result.command).not.toContain("latest");
  });
  it("uses the supported Firefox registration ID and Chinese installer language", () => {
    expect(installationCommand("linux", "firefox", "anagram@coderbak.dev", "0.4.0", "zh_CN")?.command)
      .toContain("ANAGRAM_BROWSER='firefox' ANAGRAM_LANG='zh_CN'");
  });
  it("passes the matching Windows parameters instead of a POSIX command", () => {
    const result = installationCommand("win", "chrome", chromeId, "0.4.0", "zh_CN")!;
    expect(result.platform).toBe("windows");
    expect(result.scriptUrl).toMatch(/v0\.4\.0\/install\.ps1$/);
    expect(result.command).toContain(`-ExtensionId '${chromeId}' -Browser 'chrome' -Language 'zh_CN'`);
    expect(result.command).toContain("-ReleaseUrl 'https://github.com/CoderBak/anagram/releases/download/v0.4.0'");
    expect(result.command).not.toContain("curl");
  });
  it.each([
    ["mac", "chrome", "a'; touch bad", "0.4.0"],
    ["win", "firefox", "other@example.com", "0.4.0"],
    ["linux", "chrome", chromeId, "0.4.0';bad"],
    ["android", "chrome", chromeId, "0.4.0"],
  ] as const)("refuses unsupported platform or shell-bearing identifiers", (os, browser, id, version) => {
    expect(installationCommand(os, browser, id, version, "en")).toBeNull();
  });
});
