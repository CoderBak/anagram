import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installationCommand } from "../../lib/ui/installationCommand";

const chromeId = "a".repeat(32);
const installers = { sh: "1".repeat(64), ps1: "2".repeat(64) };
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** Run a command without blocking this process: the stand-in release is served from it. */
const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(file, args, { timeout: 30_000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`)));

describe("native installation command", () => {
  it.each(["mac", "linux"])("pins %s scripts and assets to the installed extension version", (os) => {
    const result = installationCommand(os, "chrome", chromeId, "0.4.0", "en", installers)!;
    expect(result.scriptUrl).toBe("https://github.com/CoderBak/anagram/releases/download/v0.4.0/install.sh");
    expect(result.command).toContain(`ANAGRAM_EXTENSION_ID='${chromeId}'`);
    expect(result.command).toContain("ANAGRAM_BROWSER='chrome'");
    expect(result.command).toContain("ANAGRAM_LANG='en'");
    expect(result.command).toContain("ANAGRAM_RELEASE_URL='https://github.com/CoderBak/anagram/releases/download/v0.4.0'");
    expect(result.command).not.toContain("latest");
  });
  it("checks the installer against the digest it was built with before running it", () => {
    expect(installationCommand("mac", "chrome", chromeId, "0.9.0", "en", installers)!.command).toContain(`echo '${installers.sh}  '"$f" | shasum -a 256 -c -`);
    expect(installationCommand("linux", "chrome", chromeId, "0.9.0", "en", installers)!.command).toContain(`echo '${installers.sh}  '"$f" | sha256sum -c -`);
    const win = installationCommand("win", "chrome", chromeId, "0.9.0", "en", installers)!.command;
    expect(win).toContain(`(Get-FileHash -Algorithm SHA256 $f).Hash -ne '${installers.ps1}'`);
    expect(win).not.toContain("Invoke-RestMethod");
  });
  it.each([undefined, { sh: "x", ps1: "2".repeat(64) }, { sh: "1".repeat(64), ps1: "" }])("gives no command without the installers' digests (%o)", (digests) => {
    expect(installationCommand("mac", "chrome", chromeId, "0.9.0", "en", digests)).toBeNull();
  });
  it("uses the supported Firefox registration ID and Chinese installer language", () => {
    expect(installationCommand("linux", "firefox", "anagram@coderbak.dev", "0.4.0", "zh_CN", installers)?.command)
      .toContain("ANAGRAM_BROWSER='firefox' ANAGRAM_LANG='zh_CN'");
  });
  it("uses Safari's containing-app identity and safely quotes a custom engine home", () => {
    const result = installationCommand("mac", "safari", "dev.coderbak.Anagram.Extension (TEAM123)", "0.8.2", "en", installers, "/tmp/Anagram's engine")!;
    expect(result.command).toContain("ANAGRAM_BROWSER='safari'");
    expect(result.command).toContain("ANAGRAM_EXTENSION_ID='dev.coderbak.Anagram.Extension (TEAM123)'");
    expect(result.command).toContain("ANAGRAM_HOME='/tmp/Anagram'\\''s engine'");
  });
  it("passes the matching Windows parameters instead of a POSIX command", () => {
    const result = installationCommand("win", "chrome", chromeId, "0.4.0", "zh_CN", installers)!;
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
    ["win", "safari", "dev.coderbak.Anagram.Extension", "0.8.2"],
    ["mac", "safari", "dev.coderbak.Anagram';bad", "0.8.2"],
  ] as const)("refuses unsupported platform or shell-bearing identifiers", (os, browser, id, version) => {
    expect(installationCommand(os, browser, id, version, "en", installers)).toBeNull();
  });
});

// The command as a user pastes it, run against a stand-in release: the installer it was built
// for runs, with what the command passes it; any other file is never run.
describe("the installation command, run", () => {
  let server: Server;
  let base = "";
  let served: Record<string, string> = {};
  const dir = mkdtempSync(join(tmpdir(), "anagram-install-command-"));
  const marker = join(dir, "ran");
  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = served[req.url ?? ""];
      if (body === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/plain" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const local = (command: string, scriptUrl: string): string => command.replace(scriptUrl, `${base}/installer`);

  const posix = process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : null;
  it.skipIf(!posix)("on macOS or Linux, runs the installer with its digest, and refuses one that differs", async () => {
    const script = `printf '%s %s %s' "$ANAGRAM_EXTENSION_ID" "$ANAGRAM_BROWSER" "$ANAGRAM_LANG" > '${marker}'\n`;
    served = { "/installer": script };
    const result = installationCommand(posix!, "chrome", chromeId, "0.9.0", "en", { sh: sha256(script), ps1: "0".repeat(64) })!;
    await run("/bin/sh", ["-c", local(result.command, result.scriptUrl)]);
    expect(readFileSync(marker, "utf8")).toBe(`${chromeId} chrome en`);
    rmSync(marker);
    served = { "/installer": script.replace("printf", "echo tampered; printf") };
    const refused = await run("/bin/sh", ["-c", local(result.command, result.scriptUrl)]);
    expect(existsSync(marker)).toBe(false);
    expect(refused).toMatch(/FAILED/);
  });

  const pwsh = (() => { try { execFileSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "pipe" }); return true; } catch { return false; } })();
  it.skipIf(!pwsh)("in PowerShell, runs the installer with its digest, and refuses one that differs", async () => {
    const script = `param($ExtensionId, $Browser, $Language, $ReleaseUrl)\nSet-Content -NoNewline -Path '${marker}' -Value "$ExtensionId $Browser $Language"\n`;
    served = { "/installer": script };
    const result = installationCommand("win", "chrome", chromeId, "0.9.0", "en", { sh: "0".repeat(64), ps1: sha256(script) })!;
    await run("pwsh", ["-NoProfile", "-Command", local(result.command, result.scriptUrl)]);
    expect(readFileSync(marker, "utf8")).toBe(`${chromeId} chrome en`);
    rmSync(marker);
    served = { "/installer": script.replace("param", "Write-Host tampered\nparam") };
    const refused = await run("pwsh", ["-NoProfile", "-Command", local(result.command, result.scriptUrl)]);
    expect(existsSync(marker)).toBe(false);
    expect(refused).toMatch(/nothing was run/);
  });
});
