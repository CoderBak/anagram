/** The installer is version-pinned to this extension; never send an older public
 * script flags it does not understand. Only release packaging enables the copy UI. */
export function installationCommand(os: string, browser: "chrome" | "firefox" | "safari", id: string, version: string, language: "en" | "zh_CN", home?: string | null):
  { command: string; scriptUrl: string; platform: "posix" | "windows" } | null {
  if (!/^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]+)?$/.test(version)) return null;
  if (browser === "chrome" ? !/^[a-p]{32}$/.test(id) : browser === "firefox" ? id !== "anagram@coderbak.dev"
    : os !== "mac" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?: \([A-Za-z0-9-]+\))?$/.test(id)) return null;
  if (home && (!home.startsWith("/") || /[\x00-\x1f\x7f]/.test(home))) return null;
  const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  const release = `https://github.com/CoderBak/anagram/releases/download/v${version}`;
  if (os === "mac" || os === "linux") {
    const scriptUrl = `${release}/install.sh`;
    return { platform: "posix", scriptUrl,
      command: `curl -fsSL '${scriptUrl}' | env ANAGRAM_EXTENSION_ID='${id}' ANAGRAM_BROWSER='${browser}' ANAGRAM_LANG='${language}' ANAGRAM_RELEASE_URL='${release}'${home ? ` ANAGRAM_HOME=${shellQuote(home)}` : ""} sh` };
  }
  if (os === "win") {
    const scriptUrl = `${release}/install.ps1`;
    return { platform: "windows", scriptUrl,
      command: `& ([scriptblock]::Create((Invoke-RestMethod '${scriptUrl}'))) -ExtensionId '${id}' -Browser '${browser}' -Language '${language}' -ReleaseUrl '${release}'` };
  }
  return null;
}
