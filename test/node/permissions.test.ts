// Shipping builds require the in-browser engine's permissions — an offscreen document
// (Chrome) and unevictable storage — and offer Native Messaging, for the local engine, and
// website access as optional grants. Firefox clipboard access is optional; Chrome needs no
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
const CHROME_REQUIRED = ["storage", "activeTab", "contextMenus", "scripting", "offscreen", "unlimitedStorage", "webNavigation", "webRequest"];
// Firefox's background page is a document: it hosts the engine's worker without an offscreen one.
const FIREFOX_REQUIRED = CHROME_REQUIRED.filter((p) => p !== "offscreen");
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

  it.skipIf(!chrome.ready)("Chrome requires the in-browser engine's permissions, and no clipboard permission at all", () => {
    expect(chrome.manifest.permissions ?? []).toEqual(CHROME_REQUIRED);
    expect((chrome.manifest.optional_permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
  });

  it.skipIf(!firefox.ready)("Firefox asks for clipboardWrite ONLY as an optional permission", () => {
    expect((firefox.manifest.permissions ?? []).filter((p) => CLIPBOARD.includes(p))).toEqual([]);
    // MV2 has no optional_host_permissions, so the site patterns are optional permissions
    // beside it — the same offer, spelt the way this manifest version spells it.
    expect(firefox.manifest.optional_permissions ?? []).toEqual(["clipboardWrite", "nativeMessaging", ...OPTIONAL_HOSTS]);
  });

  it.skipIf(!firefox.ready)("…and asks for nothing else on top of what Chrome asks for, but the offscreen document", () => {
    // MV2 carries host permissions in the same list, so they are taken out here: what is
    // left is what a reader reads, and it has to stay the same entries everywhere.
    expect(
      (firefox.manifest.permissions ?? []).filter((p) => !p.includes("://") && p !== "<all_urls>"),
    ).toEqual(FIREFOX_REQUIRED);
  });

  it.skipIf(!chrome.ready || !firefox.ready)("native messaging is an optional grant, asked for when the local engine is picked", () => {
    for (const { manifest } of [chrome, firefox]) {
      expect(manifest.permissions).not.toContain("nativeMessaging");
      expect(manifest.optional_permissions ?? []).toContain("nativeMessaging");
    }
    expect(chrome.manifest.optional_permissions).toEqual(["nativeMessaging"]);
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
 * What the in-browser engine needs besides: the browsers its runtime runs in, and cross-origin
 * isolated pages in Chrome. The model downloads without any host permission (Hugging Face
 * answers with CORS headers; the language identifier ships in the package).
 */
describe("the in-browser engine", () => {
  const chrome = target("chrome-mv3");
  const firefox = target("firefox-mv2");
  const variant = target("chrome-mv3", "output-test");

  it.skipIf(!chrome.ready || !firefox.ready)("names no model host, required or optional", () => {
    for (const { manifest } of [chrome, firefox]) expect(JSON.stringify(manifest)).not.toMatch(/huggingface|hf\.co|fbaipublicfiles/);
  });

  it.skipIf(!chrome.ready || !firefox.ready)("is one extension, named as ever, with the ID the local engine's installer registers", () => {
    expect(chrome.manifest.name).toBe("Anagram for Chrome");
    expect(firefox.manifest.name).toBe("Anagram for Firefox");
    for (const { manifest } of [chrome, firefox]) expect(manifest.description).toBe("__MSG_extDescription__");
    // installer/native_registration.py's FIREFOX_ID, install.sh's and install.ps1's check.
    expect(firefox.manifest.browser_specific_settings?.gecko?.id).toBe("anagram@coderbak.dev");
  });

  it.skipIf(!chrome.ready || !firefox.ready)("requires Chrome 137, where its runtime runs, and keeps Firefox at 140, where the local engine does", () => {
    // WebAssembly JSPI, which the runtime's only build needs (lib/webengine/session.ts); Firefox
    // has it from 153, and the setup page offers the local engine alone before (lib/device.ts).
    expect(chrome.manifest.minimum_chrome_version).toBe("137");
    expect(firefox.manifest.browser_specific_settings?.gecko?.strict_min_version).toBe("140.0");
  });

  it.skipIf(!chrome.ready || !firefox.ready)("isolates Chrome's extension pages, so the engine's WebAssembly gets threads", () => {
    expect(chrome.manifest.cross_origin_embedder_policy).toEqual({ value: "require-corp" });
    expect(chrome.manifest.cross_origin_opener_policy).toEqual({ value: "same-origin" });
    // Firefox's MV2 manifest has no such keys; its background page runs the engine one-threaded.
    expect(firefox.manifest.cross_origin_embedder_policy).toBeUndefined();
  });

  it.skipIf(!variant.ready)("the test variant requires Native Messaging, for the suites that drive the fake host", () => {
    expect(variant.manifest.permissions).toContain("nativeMessaging");
    expect(variant.manifest.optional_permissions ?? []).not.toContain("nativeMessaging");
  });
});
