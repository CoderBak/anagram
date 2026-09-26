// lib/ui/sourceCode.ts — the "Source code" link in the Settings and setup footers.
//
// Anagram is AGPL-3.0-or-later, so whoever runs it is offered the source of exactly what
// they run: the release tag of this version. Every published build is a tagged release —
// the install command already points at the same tag's assets (installationCommand.ts) —
// so the tag is the Corresponding Source, where a branch would move on under the reader.
// A local build of a version not yet released names a tag that does not exist yet; only
// somebody who already has the source runs one.
import { browser } from "#imports";

export function sourceCodeUrl(version: string): string {
  return `https://github.com/CoderBak/anagram/tree/v${encodeURIComponent(version)}`;
}

/** Point the page's #sourceCode link at the running version's source. */
export function linkSourceCode(): void {
  const link = document.getElementById("sourceCode") as HTMLAnchorElement | null;
  if (link) link.href = sourceCodeUrl(browser.runtime.getManifest().version);
}
