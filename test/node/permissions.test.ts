// test/node/permissions.test.ts — what the two manifests ask the user for.
//
// A permission is a sentence in the install dialog, and one of them is a trap: any
// clipboard permission makes Chrome say "Modify data you copy and paste" and Firefox
// "Input data to the clipboard" — and a store update that ADDS a warning permission
// disables the extension until every user re-accepts it. "Copy page diagnostics" is a
// menu entry most readers will never open, so it may not cost them that.
//
// What it may do is ask Firefox for `clipboardWrite` OPTIONALLY, from inside the menu
// click, because Firefox refuses a content script both clipboard routes outside a
// user-input handler and the copy happens after the message reaches the page. Chrome needs
// nothing: the async clipboard API answers a content script whose tab is focused.
//
// These read the last build (CI builds before it runs vitest); with no build on disk — or
// one older than the file that decides its contents — there is nothing to check and they
// skip rather than fail.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

interface Manifest {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
}

const CLIPBOARD = ["clipboardWrite", "clipboardRead"];
const DECIDES = join(ROOT, "wxt.config.ts");

/** One target's manifest, and whether it is fresh enough to say anything. */
function target(dir: string): { ready: boolean; manifest: Manifest } {
  const path = join(ROOT, "output", dir, "manifest.json");
  const builtAt = existsSync(path) ? statSync(path).mtimeMs : 0;
  const ready = builtAt > 0 && statSync(DECIDES).mtimeMs <= builtAt;
  return { ready, manifest: ready ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : {} };
}

describe("the permissions each target asks for", () => {
  const chrome = target("chrome-mv3");
  const firefox = target("firefox-mv2");

  it.skipIf(!chrome.ready)("Chrome asks for no clipboard permission at all, required or optional", () => {
    expect(chrome.manifest.permissions ?? []).toEqual(["storage", "activeTab", "contextMenus"]);
    expect((chrome.manifest.optional_permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
  });

  it.skipIf(!firefox.ready)("Firefox asks for clipboardWrite ONLY as an optional permission", () => {
    expect((firefox.manifest.permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
    expect(firefox.manifest.optional_permissions ?? []).toEqual(["clipboardWrite"]);
  });

  it.skipIf(!firefox.ready)("…and asks for nothing else on top of what Chrome asks for", () => {
    // host_permissions is <all_urls> on both and is what the product IS; the required list
    // is what a reader reads, and it has to stay the same three entries everywhere.
    expect((firefox.manifest.permissions ?? []).filter((p) => p !== "<all_urls>")).toEqual([
      "storage",
      "activeTab",
      "contextMenus",
    ]);
  });
});
