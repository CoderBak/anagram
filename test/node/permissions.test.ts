// Shipping builds require Native Messaging and request website access separately.
// Firefox clipboard access is optional; Chrome needs no clipboard permission.
// Manifest assertions require a build newer than wxt.config.ts.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_SITES } from "../../lib/access/patterns";

const ROOT = join(__dirname, "..", "..");

interface Manifest {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
}

const CLIPBOARD = ["clipboardWrite", "clipboardRead"];
// PDF detection observes navigation and response types without blocking requests.
const REQUIRED = ["storage", "activeTab", "contextMenus", "scripting", "nativeMessaging", "webNavigation", "webRequest"];
const OPTIONAL_HOSTS = [...ALL_SITES, "file:///*"];
const DECIDES = join(ROOT, "wxt.config.ts");

/** One target's manifest, and whether it is fresh enough to say anything. */
function target(dir: string, out = "output"): { ready: boolean; manifest: Manifest } {
  const path = join(ROOT, out, dir, "manifest.json");
  const builtAt = existsSync(path) ? statSync(path).mtimeMs : 0;
  const ready = builtAt > 0 && statSync(DECIDES).mtimeMs <= builtAt;
  return { ready, manifest: ready ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : {} };
}

describe("the permissions each target asks for", () => {
  const chrome = target("chrome-mv3");
  const firefox = target("firefox-mv2");

  it.skipIf(!chrome.ready)("Chrome asks for no clipboard permission at all, required or optional", () => {
    expect(chrome.manifest.permissions ?? []).toEqual(REQUIRED);
    expect((chrome.manifest.optional_permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
  });

  it.skipIf(!firefox.ready)("Firefox asks for clipboardWrite ONLY as an optional permission", () => {
    expect((firefox.manifest.permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
    // MV2 has no optional_host_permissions, so the site patterns are optional permissions
    // beside it — the same offer, spelt the way this manifest version spells it.
    expect(firefox.manifest.optional_permissions ?? []).toEqual(["clipboardWrite", ...OPTIONAL_HOSTS]);
  });

  it.skipIf(!firefox.ready)("…and asks for nothing else on top of what Chrome asks for", () => {
    // MV2 carries host permissions in the same list, so they are taken out here: what is
    // left is what a reader reads, and it has to stay the same entries everywhere.
    expect(
      (firefox.manifest.permissions ?? []).filter((p) => !p.includes("://") && p !== "<all_urls>"),
    ).toEqual(REQUIRED);
  });

  it.skipIf(!chrome.ready || !firefox.ready)("native messaging is required, never an optional grant", () => {
    for (const { manifest } of [chrome, firefox]) {
      expect(manifest.permissions).toContain("nativeMessaging");
      expect(manifest.optional_permissions ?? []).not.toContain("nativeMessaging");
    }
  });

  it.skipIf(!chrome.ready || !firefox.ready)("observes PDF requests without blocking, debugger, or broad tabs permissions", () => {
    for (const { manifest } of [chrome, firefox]) {
      expect(manifest.permissions).toContain("webRequest");
      expect(manifest.permissions).toContain("webNavigation");
      for (const name of ["webRequestBlocking", "debugger", "tabs", "downloads", "management"]) {
        expect([...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])]).not.toContain(name);
      }
    }
  });
});

describe("the hosts each target asks for", () => {
  const chrome = target("chrome-mv3");
  const firefox = target("firefox-mv2");

  it.skipIf(!chrome.ready)("Chrome REQUIRES no host at all — the key is not even there", () => {
    // Not an empty array: the key is deleted, so a store reviewer reading the manifest
    // sees no host line to interpret.
    expect(chrome.manifest.host_permissions).toBeUndefined();
  });

  it.skipIf(!chrome.ready)("…and offers every site as an OPTIONAL grant", () => {
    expect(chrome.manifest.optional_host_permissions ?? []).toEqual(OPTIONAL_HOSTS);
  });

  it.skipIf(!firefox.ready)("Firefox requires no host either, in the list MV2 keeps hosts in", () => {
    expect((firefox.manifest.permissions ?? []).filter((p) => p.includes("://"))).toEqual([]);
  });

  it.skipIf(!firefox.ready)("…and offers the same optional websites and file access, the way MV2 spells it", () => {
    expect((firefox.manifest.optional_permissions ?? []).filter((p) => p.includes("://"))).toEqual(
      OPTIONAL_HOSTS,
    );
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

  it.skipIf(!chrome.ready)("asks for nothing at all in the SHIPPING build, whatever the test build does", () => {
    // The suites load output-test/, where the two optional patterns are required instead
    // (test/test-build.mjs). Nothing may leak from that build into this one.
    const required = chrome.manifest.host_permissions ?? [];
    for (const pattern of [...ALL_SITES, "<all_urls>", "http://127.0.0.1/*", "http://localhost/*"]) {
      expect(required).not.toContain(pattern);
    }
  });
});

/**
 * The store package is `npm run zip`, and the only thing standing between it and the TEST
 * build is an environment variable: `ANAGRAM_TEST_GRANT_ALL=1` moves the whole build to
 * `output-test/`, and `wxt zip` follows it there. Uploading that would hand every reader
 * an extension that REQUIRES access to every site they visit — and since the two builds
 * are otherwise byte-for-byte the same work, nothing about the package would look wrong.
 *
 * Two things keep it from happening, and both are checked here: wxt.config.ts refuses to
 * run `wxt zip` at all with that variable set, and the variant it does build is telling
 * itself — the site patterns sit in `host_permissions` rather than in the optional list.
 * So a zip anybody ever has in their hands can be opened and told apart in one look.
 */
describe("the test build cannot be mistaken for the store package", () => {
  const shipping = target("chrome-mv3");
  const variant = target("chrome-mv3", "output-test");

  it.skipIf(!variant.ready)("the variant REQUIRES website patterns while files remain optional", () => {
    expect(variant.manifest.host_permissions ?? []).toEqual([...ALL_SITES]);
    expect(variant.manifest.optional_host_permissions).toEqual(["file:///*"]);
  });

  it.skipIf(!variant.ready || !shipping.ready)("so the two manifests can never read alike", () => {
    // The one key that decides it, read the way a reviewer would read it.
    const requires = (m: Manifest) => ALL_SITES.every((p) => (m.host_permissions ?? []).includes(p));
    expect(requires(variant.manifest)).toBe(true);
    expect(requires(shipping.manifest)).toBe(false);
  });

  it("`wxt zip` refuses to run with ANAGRAM_TEST_GRANT_ALL set", () => {
    // The guard lives in wxt.config.ts, which cannot be imported here (it is the build's
    // own config and would run WXT's plugin machinery), so what is pinned is that the
    // refusal is still there and still reads both the variable and the zip command.
    const config = readFileSync(DECIDES, "utf8");
    expect(config).toMatch(/if \(TEST_GRANT_ALL && process\.argv\.slice\(2\)\.includes\("zip"\)\)/);
    expect(config).toMatch(/would package the TEST build/);
  });
});
