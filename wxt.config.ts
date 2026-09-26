import { defineConfig } from "wxt";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  entryFilesOf,
  keysUsedBy,
  reachableSources,
  subsetMessages,
  unscanned,
} from "./scripts/i18nSubset";
import { ALL_SITES } from "./lib/access/patterns";

// Page-reading tests pregrant website access in a separate output-test directory.
// Shipping installs keep website access optional.
const TEST_GRANT_ALL = process.env.ANAGRAM_TEST_GRANT_ALL === "1";

// Never package the variant that requires access to every website.
if (TEST_GRANT_ALL && process.argv.slice(2).includes("zip")) {
  throw new Error(
    "ANAGRAM_TEST_GRANT_ALL=1 is set, and `wxt zip` would package the TEST build — the one " +
      "that requires access to every site. Unset it and run `npm run zip` again; that always " +
      "packages the shipping build from output/.",
  );
}

// Each bundle gets only the English fallback messages its source graph can use.
// Fail on unknown message keys or unscanned bundled modules; tests keep all messages.
const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/[/\\]$/, "");
const EN_MESSAGES = fileURLToPath(new URL("./public/_locales/en/messages.json", import.meta.url));
const EN_MESSAGES_ID = "\0anagram:en-messages";

function englishFallback() {
  let entries: string[] | undefined;
  let scanned: string[] = [];
  const loaded = new Set<string>();
  return {
    name: "anagram:english-fallback",
    // Before the bundler's own JSON handling, which would otherwise parse the module we
    // return here as JSON: the import is answered with a module id of our own instead.
    enforce: "pre" as const,
    configResolved(config: Parameters<typeof entryFilesOf>[0]) {
      entries = entryFilesOf(config);
      scanned = entries ? reachableSources(entries, ROOT) : [];
    },
    transform(_code: string, id: string) {
      loaded.add(id);
      return null;
    },
    resolveId(source: string, importer: string | undefined) {
      if (!importer || !source.endsWith("_locales/en/messages.json")) return;
      return resolve(dirname(importer), source) === EN_MESSAGES ? EN_MESSAGES_ID : undefined;
    },
    load(id: string) {
      if (id !== EN_MESSAGES_ID) return;
      const raw = JSON.parse(readFileSync(EN_MESSAGES, "utf8")) as Record<string, { message: string }>;
      if (!entries) return `export default ${JSON.stringify(subsetMessages(raw, Object.keys(raw)))};`;
      const { keys, unknownKeys } = keysUsedBy(scanned, raw);
      if (unknownKeys.length > 0) {
        throw new Error(
          `i18n: ${entries.join(", ")} asks for a message that is not in _locales/en/messages.json:\n  ${unknownKeys.join("\n  ")}`,
        );
      }
      return `export default ${JSON.stringify(subsetMessages(raw, keys))};`;
    },
    // The scan follows our own imports; this is the bundler saying which files it really
    // pulled in. A source file in the build that the scan never read could be naming a
    // message we just left out, so it fails the build instead.
    buildEnd() {
      if (!entries) return;
      const missed = unscanned(loaded, ROOT, scanned);
      if (missed.length > 0) {
        throw new Error(
          `i18n: the build of ${entries.join(", ")} reached source files the message scan did not, so its English fallback may be missing keys. Teach scripts/i18nSubset.ts how they are imported:\n  ${missed.join("\n  ")}`,
        );
      }
    },
  };
}

// The private PDF loader reads only document-bound, authorized source tickets.
// Other UI pages add connect-src 'self' in a meta policy; the viewer only opens bytes.
// Native setup downloads run outside browser CSP.
// Packaged pdf.js image decoders need wasm-unsafe-eval; inline page styles need
// unsafe-inline. Neither directive permits remotely hosted scripts.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "object-src 'self'",
  "connect-src 'self' http: https: file:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// WXT config: manifest keys, permissions, targets.
// Icons are committed as PNGs under public/icons/ and copied into the build as-is.
export default defineConfig({
  // Build into ./output (not WXT's default ./.output) so it's visible in Finder.
  outDir: TEST_GRANT_ALL ? "output-test" : "output",
  zip: {
    // Keep generated output out of Firefox's review source archive. WXT excludes
    // output/ and node_modules itself, but does not apply our .gitignore.
    excludeSources: [
      "dist/**", "output-test/**", "test-results/**", ".cache/**",
      "**/__pycache__/**", "**/*.pyc", "**/*.log", "**/*.ses",
      "test/*.png", "test/matrix.json", "test/survey.json", "test/a11y.json",
    ],
  },
  vite: () => ({ plugins: [englishFallback()] }),
  hooks: {
    // AGPL: every copy of the extension carries the licence text.
    "build:publicAssets": (_wxt, files) => {
      files.push({ absoluteSrc: resolve(ROOT, "LICENSE"), relativeDest: "LICENSE" });
    },
    // Production content scripts are registered only after a grant or user action.
    // Remove WXT's inferred hosts; its dev server manages its own registration.
    "build:manifestGenerated": (wxt, manifest) => {
      if (wxt.config.command === "serve") return;
      if (TEST_GRANT_ALL) manifest.host_permissions = [...ALL_SITES];
      else delete manifest.host_permissions;
      // With no script left to declare, WXT still leaves the empty array behind.
      if (manifest.content_scripts?.length === 0) delete manifest.content_scripts;
    },
  },
  manifest: ({ browser }) => {
    const productName = browser === "firefox" ? "Anagram for Firefox" : "Anagram for Chrome";
    return {
      name: productName,
      // The browser's own UI language picks the folder under public/_locales; English is
      // what it falls back to, which is also what every __MSG_* below is written in.
      default_locale: "en",
      description: "__MSG_extDescription__",
      // Native Messaging provides local inference; activeTab/scripting provide opt-in reading.
      permissions: ["storage", "activeTab", "contextMenus", "scripting", "nativeMessaging", "webNavigation", "webRequest"],
      // See CSP above. MV3 keys it under `extension_pages`; MV2 is the bare string.
      content_security_policy: browser === "firefox" ? CSP : { extension_pages: CSP },
      ...(browser === "firefox"
        ? {
            // Firefox clipboard copying asks permission only when the menu is used.
            // MV2 carries optional website patterns in the same list.
            optional_permissions: TEST_GRANT_ALL ? ["clipboardWrite", "file:///*"] : ["clipboardWrite", ...ALL_SITES, "file:///*"],
            browser_specific_settings: {
              gecko: {
                id: "anagram@coderbak.dev",
                // 140 is the real floor: before it a content script cannot give a shadow root a
                // constructed stylesheet ("Accessing from Xray wrapper is not supported"), so no
                // chip, ball or card renders at all; 140 is also where CSS.highlights arrived.
                strict_min_version: "140.0",
                // AMO's data-collection disclosure: nothing is collected or transmitted.
                data_collection_permissions: { required: ["none"] },
              },
            },
          }
        : {}),
      // Chrome permits four suggested shortcuts. Avoid its Alt+Shift+T/B/I bindings.
      commands: {
        "toggle-overlay": {
          suggested_key: { default: "Alt+Shift+P" },
          description: "__MSG_cmdToggleOverlay__",
        },
        "open-panel": {
          suggested_key: { default: "Alt+Shift+L" },
          description: "__MSG_cmdOpenPanel__",
        },
        "next-flagged": {
          suggested_key: { default: "Alt+Shift+J" },
          description: "__MSG_cmdNextFlagged__",
        },
        "prev-flagged": {
          suggested_key: { default: "Alt+Shift+K" },
          description: "__MSG_cmdPrevFlagged__",
        },
      },
      // Website access is optional; nativeMessaging has its own install warning.
      ...(TEST_GRANT_ALL ? { host_permissions: [...ALL_SITES] } : {}),
      // OPTIONAL (Chrome MV3; Firefox MV2 carries them in optional_permissions above):
      // "all sites", which the onboarding page and the options page ask for in one click.
      optional_host_permissions: TEST_GRANT_ALL ? ["file:///*"] : [...ALL_SITES, "file:///*"],
      // Only content-script imports are web accessible. Reader assets stay private;
      // Chrome rotates these chunk URLs per session to prevent stable-ID probing.
      web_accessible_resources: [
        {
          resources: [
            "vendor/defuddle.min.mjs",
            "vendor/purify.min.mjs",
            "vendor/diagnostics.min.mjs",
          ],
          matches: ["<all_urls>"],
          use_dynamic_url: true,
        },
      ],
      icons: {
        16: "icons/icon-16.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png",
      },
      action: {
        default_popup: "popup/index.html",
        default_title: productName,
      },
    };
  },
});
