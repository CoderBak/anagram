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
// The other half of what a reader is asked for is the SITES, and there the answer is
// none: Anagram installs able to read nothing at all and the user grants what they want
// (lib/access/*). So the shipping manifest declares no content script, requires only the
// local daemon's two loopback patterns, and carries the all-sites pair as OPTIONAL.
//
// These read the last build (CI builds before it runs vitest); with no build on disk — or
// one older than the file that decides its contents — there is nothing to check and they
// skip rather than fail.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_SITES, DAEMON_ORIGINS } from "../../lib/access/patterns";

const ROOT = join(__dirname, "..", "..");

interface Manifest {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
}

const CLIPBOARD = ["clipboardWrite", "clipboardRead"];
/**
 * "Open PDFs in Anagram" would need these on Firefox, whose PDF viewer is a privileged
 * page no content script reaches: a blocking `webRequest.onHeadersReceived` on `main_frame`
 * is the only way to see a `Content-Type: application/pdf` go by. It was built and driven
 * on Firefox 156 and it does work — `redirectUrl` to `reader.html` is refused with
 * NS_ERROR_DOM_BAD_URI because the reader is deliberately not web accessible, but
 * `tabs.update` plus `{cancel: true}` lands the tab in the reader with the paper read.
 *
 * It is not shipped, because the OPTIONAL grant cannot be driven: Firefox accepts
 * `permissions.request` only from a real user-input handler, and WebDriver BiDi can
 * neither deliver input to a moz-extension: page nor satisfy that check with its own
 * script-level activation (test/diagnostics-check.mjs documents the same wall for
 * clipboardWrite). A permission no suite can grant is a feature no suite can prove, so the
 * switch is absent on Firefox instead — and this pins the manifests to match.
 */
const WEB_REQUEST = ["webRequest", "webRequestBlocking"];
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
    expect(chrome.manifest.permissions ?? []).toEqual([
      "storage",
      "activeTab",
      "contextMenus",
      "scripting",
    ]);
    expect((chrome.manifest.optional_permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
  });

  it.skipIf(!firefox.ready)("Firefox asks for clipboardWrite ONLY as an optional permission", () => {
    expect((firefox.manifest.permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
    // MV2 has no optional_host_permissions, so the site patterns are optional permissions
    // beside it — the same offer, spelt the way this manifest version spells it.
    expect(firefox.manifest.optional_permissions ?? []).toEqual(["clipboardWrite", ...ALL_SITES]);
  });

  it.skipIf(!firefox.ready)("…and asks for nothing else on top of what Chrome asks for", () => {
    // MV2 carries host permissions in the same list, so they are taken out here: what is
    // left is what a reader reads, and it has to stay the same four entries everywhere.
    expect(
      (firefox.manifest.permissions ?? []).filter((p) => !p.includes("://") && p !== "<all_urls>"),
    ).toEqual(["storage", "activeTab", "contextMenus", "scripting"]);
  });

  it.skipIf(!chrome.ready || !firefox.ready)("neither target asks for webRequest, required or optional", () => {
    for (const { manifest } of [chrome, firefox]) {
      expect((manifest.permissions ?? []).filter((p) => WEB_REQUEST.includes(p))).toEqual([]);
      expect((manifest.optional_permissions ?? []).filter((p) => WEB_REQUEST.includes(p))).toEqual([]);
    }
  });
});

describe("the sites each target asks for", () => {
  const chrome = target("chrome-mv3");
  const firefox = target("firefox-mv2");

  it.skipIf(!chrome.ready)("Chrome REQUIRES the local daemon and nothing else", () => {
    expect(chrome.manifest.host_permissions ?? []).toEqual(DAEMON_ORIGINS);
  });

  it.skipIf(!chrome.ready)("…and offers every site as an OPTIONAL grant", () => {
    expect(chrome.manifest.optional_host_permissions ?? []).toEqual(ALL_SITES);
  });

  it.skipIf(!firefox.ready)("Firefox requires the same two, in the list MV2 keeps hosts in", () => {
    expect((firefox.manifest.permissions ?? []).filter((p) => p.includes("://"))).toEqual(DAEMON_ORIGINS);
  });

  it.skipIf(!chrome.ready || !firefox.ready)("neither declares a content script at all", () => {
    // The one content script is registered at runtime for the origins the user has
    // granted (lib/access/worker.ts). A declaration here would run it everywhere, which
    // is the whole point of this change.
    for (const { manifest } of [chrome, firefox]) expect(manifest.content_scripts).toBeUndefined();
  });

  it.skipIf(!chrome.ready)("still builds the script the worker registers by name", () => {
    // lib/access/worker.ts names this path; a rename that only the bundler knew about
    // would leave the extension unable to run anywhere.
    expect(existsSync(join(ROOT, "output", "chrome-mv3", "content-scripts", "content.js"))).toBe(true);
  });

  it.skipIf(!chrome.ready)("asks for no site in the SHIPPING build, whatever the test build does", () => {
    // The suites load output-test/, where the two optional patterns are required instead
    // (test/test-build.mjs). Nothing may leak from that build into this one.
    const required = chrome.manifest.host_permissions ?? [];
    for (const pattern of [...ALL_SITES, "<all_urls>"]) expect(required).not.toContain(pattern);
  });
});
