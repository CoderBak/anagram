// Shipping builds require their engine's permissions — Native Messaging in the native
// flavor, an offscreen document and unevictable storage in the oneclick one — and request
// website access separately. Firefox clipboard access is optional; Chrome needs no
// clipboard permission. Manifest assertions require a build newer than wxt.config.ts.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_SITES } from "../../lib/access/patterns";

const ROOT = join(__dirname, "..", "..");

interface Manifest {
  name?: string;
  description?: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
  content_security_policy?: unknown;
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
  minimum_chrome_version?: string;
  cross_origin_embedder_policy?: { value: string };
  cross_origin_opener_policy?: { value: string };
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

  it.skipIf(!chrome.ready)("still builds the scripts the worker registers by name", () => {
    // lib/access/worker.ts names these paths; a rename that only the bundler knew about
    // would leave the extension unable to run anywhere.
    expect(existsSync(join(ROOT, "output", "chrome-mv3", "content-scripts", "content.js"))).toBe(true);
    expect(existsSync(join(ROOT, "output", "chrome-mv3", "content-scripts", "shadow.js"))).toBe(true);
    expect(existsSync(join(ROOT, "output", "chrome-mv3", "content-scripts", "shadowPort.js"))).toBe(true);
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

/**
 * The oneclick flavor (scripts/flavor.mjs): the same reading permissions as native and the
 * in-browser engine's in place of Native Messaging. The model downloads without any host
 * permission (Hugging Face answers with CORS headers; the language identifier ships in the
 * package). Named apart, so both flavors install side by side. Checks run on
 * `npm run build:oneclick` and `build:oneclick:firefox` output.
 */
describe("the oneclick flavor", () => {
  const chrome = target("oneclick-chrome-mv3");
  const firefox = target("oneclick-firefox-mv2");
  const nativeChrome = target("chrome-mv3");
  const variant = target("oneclick-chrome-mv3", "output-test");

  it.skipIf(!chrome.ready)("Chrome swaps nativeMessaging for an offscreen document and unevictable storage", () => {
    expect(chrome.manifest.permissions).toEqual(
      ["storage", "activeTab", "contextMenus", "scripting", "offscreen", "unlimitedStorage", "webNavigation", "webRequest"],
    );
  });

  it.skipIf(!firefox.ready)("Firefox takes unevictable storage and no offscreen document: its background page is one", () => {
    expect((firefox.manifest.permissions ?? []).filter((p) => !p.includes("://"))).toEqual(
      ["storage", "activeTab", "contextMenus", "scripting", "unlimitedStorage", "webNavigation", "webRequest"],
    );
  });

  it.skipIf(!chrome.ready || !firefox.ready)("asks for Native Messaging nowhere, required or optional", () => {
    for (const { manifest } of [chrome, firefox]) {
      expect([...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])]).not.toContain("nativeMessaging");
    }
  });

  it.skipIf(!chrome.ready || !firefox.ready)("requires no host and offers the same optional hosts as native: none for the model", () => {
    expect(chrome.manifest.host_permissions).toBeUndefined();
    expect(chrome.manifest.optional_host_permissions).toEqual(OPTIONAL_HOSTS);
    expect((firefox.manifest.permissions ?? []).filter((p) => p.includes("://"))).toEqual([]);
    expect(firefox.manifest.optional_permissions).toEqual(["clipboardWrite", ...OPTIONAL_HOSTS]);
    for (const { manifest } of [chrome, firefox]) {
      expect(manifest.content_scripts).toBeUndefined();
      expect(JSON.stringify(manifest)).not.toMatch(/huggingface|hf\.co|fbaipublicfiles/);
    }
  });

  it.skipIf(!chrome.ready || !firefox.ready)("is named apart from the native flavor, in Chrome and in Firefox", () => {
    for (const { manifest } of [chrome, firefox]) {
      expect(manifest.name).toBe("__MSG_extNameInBrowser__");
      expect(manifest.description).toBe("__MSG_extDescriptionInBrowser__");
    }
    expect(firefox.manifest.browser_specific_settings?.gecko?.id).toBe("anagram-oneclick@coderbak.dev");
  });

  it.skipIf(!chrome.ready || !firefox.ready)("requires the browsers its runtime runs in: Chrome 137, Firefox 153", () => {
    // WebAssembly JSPI, which the runtime's only build needs (lib/webengine/session.ts).
    expect(chrome.manifest.minimum_chrome_version).toBe("137");
    expect(firefox.manifest.browser_specific_settings?.gecko?.strict_min_version).toBe("153.0");
  });

  it.skipIf(!chrome.ready || !firefox.ready)("isolates Chrome's extension pages, so the engine's WebAssembly gets threads", () => {
    expect(chrome.manifest.cross_origin_embedder_policy).toEqual({ value: "require-corp" });
    expect(chrome.manifest.cross_origin_opener_policy).toEqual({ value: "same-origin" });
    // Firefox's MV2 manifest has no such keys; its background page runs the engine one-threaded.
    expect(firefox.manifest.cross_origin_embedder_policy).toBeUndefined();
  });

  it.skipIf(!nativeChrome.ready)("leaves the native flavor's browsers and isolation as they were", () => {
    expect(nativeChrome.manifest.minimum_chrome_version).toBeUndefined();
    expect(nativeChrome.manifest.cross_origin_embedder_policy).toBeUndefined();
    expect(nativeChrome.manifest.cross_origin_opener_policy).toBeUndefined();
  });

  it.skipIf(!chrome.ready || !nativeChrome.ready)("keeps the native flavor's Content-Security-Policy", () => {
    expect(chrome.manifest.content_security_policy).toEqual(nativeChrome.manifest.content_security_policy);
  });

  it.skipIf(!variant.ready)("its test variant requires the site patterns, as the native one does", () => {
    expect(variant.manifest.host_permissions ?? []).toEqual([...ALL_SITES]);
    expect(variant.manifest.optional_host_permissions).toEqual(["file:///*"]);
  });
});
