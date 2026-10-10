/** The SHA-256 of the installers this build was made with (wxt.config.ts INSTALLERS): the release
 *  of the same version serves those very files (scripts/release.mjs). */
export interface InstallerDigests { sh: string; ps1: string }

const DIGEST = /^[0-9a-f]{64}$/;

/** The installer is version-pinned to this extension; never send an older public
 * script flags it does not understand. Only release packaging enables the copy UI.
 *
 * The command downloads the installer to a file and runs it only if it has the SHA-256 this
 * extension was built with: the installer checks every release asset it fetches (its Sigstore
 * signature, installer/verify_release.py), and this is what checks the installer itself on a
 * first install, when nothing of Anagram's is on the computer yet. A file that differs is
 * deleted unrun. */
export function installationCommand(os: string, browser: "chrome" | "firefox" | "safari", id: string, version: string, language: "en" | "zh_CN",
  installers: InstallerDigests | undefined, home?: string | null):
  { command: string; scriptUrl: string; platform: "posix" | "windows" } | null {
  if (!/^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/.test(version)) return null;
  if (browser === "chrome" ? !/^[a-p]{32}$/.test(id) : browser === "firefox" ? id !== "anagram@coderbak.dev"
    : os !== "mac" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?: \([A-Za-z0-9-]+\))?$/.test(id)) return null;
  if (home && (!home.startsWith("/") || /[\x00-\x1f\x7f]/.test(home))) return null;
  if (!installers || !DIGEST.test(installers.sh) || !DIGEST.test(installers.ps1)) return null;
  const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  const release = `https://github.com/CoderBak/anagram/releases/download/v${version}`;
  if (os === "mac" || os === "linux") {
    const scriptUrl = `${release}/install.sh`;
    // macOS has shasum, Linux's coreutils sha256sum; both check a "<digest>  <file>" line.
    const check = os === "mac" ? "shasum -a 256 -c" : "sha256sum -c";
    const env = `env ANAGRAM_EXTENSION_ID='${id}' ANAGRAM_BROWSER='${browser}' ANAGRAM_LANG='${language}' ANAGRAM_RELEASE_URL='${release}'${home ? ` ANAGRAM_HOME=${shellQuote(home)}` : ""}`;
    return { platform: "posix", scriptUrl,
      command: `f=$(mktemp) && curl -fsSL '${scriptUrl}' -o "$f" && echo '${installers.sh}  '"$f" | ${check} - && ${env} sh "$f"; rm -f "$f"` };
  }
  if (os === "win") {
    const scriptUrl = `${release}/install.ps1`;
    return { platform: "windows", scriptUrl,
      command: `$f = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName() + '.ps1'); try { Invoke-WebRequest -UseBasicParsing '${scriptUrl}' -OutFile $f; ` +
        `if ((Get-FileHash -Algorithm SHA256 $f).Hash -ne '${installers.ps1}') { throw 'install.ps1 is not the installer this extension was built with; nothing was run.' }; ` +
        `& ([scriptblock]::Create([IO.File]::ReadAllText($f))) -ExtensionId '${id}' -Browser '${browser}' -Language '${language}' -ReleaseUrl '${release}' } finally { Remove-Item $f -ErrorAction SilentlyContinue }` };
  }
  return null;
}
