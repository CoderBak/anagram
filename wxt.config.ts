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
import { ALL_SITES, DAEMON_ORIGINS } from "./lib/access/patterns";

/**
 * THE TEST BUILD. A permission prompt is native browser UI that no automation can click,
 * and `activeTab` cannot be granted synthetically, so a suite driving the shipping build
 * would be looking at an extension with access to nothing. With this set, the two optional
 * patterns are REQUIRED instead — and that is the only difference: the same runtime
 * registration runs and simply finds everything granted. It goes to its own output
 * directory (`output-test/`), so `npm run build` is always the shipping build.
 * See test/harness.mjs, which builds it, and scripts/buildTest.mjs.
 */
const TEST_GRANT_ALL = process.env.ANAGRAM_TEST_GRANT_ALL === "1";

/**
 * lib/i18n.ts imports the English messages so every lookup has a fallback where there is
 * no extension API (the esbuild unit bundle, vitest) or no longer one (a content script
 * whose extension context was invalidated). Two things about that file are dead weight in
 * a bundle: the `description` on each message, which exists for translators, and — by far
 * the larger — every message this particular bundle could never show. The content script
 * runs on every web page and cannot open the options page, the onboarding page or the
 * popup; the background worker only ever names its menu entries.
 *
 * So the import is answered per BUILD. WXT builds the background, each content script and
 * the extension pages as separate Vite builds, and each one is handed the messages that
 * the source files ITS entry can reach actually name — see scripts/i18nSubset.ts for how
 * that set is derived and for the two assertions that make it safe. The shape is
 * `{ key: { message } }` either way, which is what the module reads.
 *
 * A build with no entry we recognise — or any other consumer, `vitest` and the esbuild
 * unit bundle among them — still gets the whole English file, only leaner.
 */
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

/**
 * The Content-Security-Policy of the extension's own pages and its service worker — the
 * one place where "this extension cannot reach the internet" stops being a promise and
 * becomes something the browser enforces. docs/footprint.md is the page that explains it
 * to somebody auditing the extension; this is the policy itself, directive by directive.
 *
 *   connect-src   THE ENFORCEMENT. The worker does all the scoring traffic and every
 *                 extension page shares this policy, so `fetch`, XHR, WebSocket,
 *                 EventSource and sendBeacon can reach the local daemon and nothing else.
 *                 CSP host sources cannot express IPv6 or the whole 127.0.0.0/8 block, so
 *                 the two loopback spellings here are exactly the two the daemon-URL
 *                 setting accepts (lib/settings/settings.ts). `'self'` is the extension's
 *                 own origin, which is how the reader page reads the pdf.js worker's data.
 *                 `file:` is there so that the PDF view can still open a PDF from this
 *                 computer where the reader ticked "Allow access to file URLs"; a file on
 *                 disk is not a place data can be sent to, so it costs the promise nothing.
 *                 What this list deliberately does NOT contain is any remote origin —
 *                 including the one the tab is on, which is why the bytes of a PDF being
 *                 read have to come from the tab that already has them.
 *   script-src    'self' plus 'wasm-unsafe-eval', which is what lets pdf.js instantiate
 *                 the JPEG2000 and JBIG2 decoders it ships as WebAssembly. Without it a
 *                 scanned page in either format comes out blank — measured, not assumed:
 *                 test/pdf-codecs-check.mjs opens one of each in the packaged extension.
 *                 It permits no eval and no remote script; it is the narrowest keyword
 *                 there is for "may compile the bytes we ship".
 *   style-src     'unsafe-inline' is needed and is not idle: all four extension pages
 *                 carry their layout in an inline <style> block, and pdf.js's text layer
 *                 sets per-span positions. It is also what Chrome's DEFAULT extension
 *                 policy allows, so this is no loosening — everything else here is a
 *                 tightening of that default.
 *   img/font      data: and blob: are what a document drawn from bytes needs; neither can
 *                 name a remote host.
 *   frame/form    'none' both: nothing here embeds anything and nothing here posts a form.
 *   base-uri      'none' so an injected <base> cannot re-point a relative URL.
 *
 * Firefox (MV2) takes the same policy as a single string. `object-src 'self'` is spelt out
 * rather than left to default-src because both browsers validate its presence.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "object-src 'self'",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* file:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// WXT config: manifest keys, permissions, targets.
// Icons are generated by `node test/genicons.mjs` into public/icons/.
export default defineConfig({
  // Build into ./output (not WXT's default ./.output) so it's visible in Finder.
  outDir: TEST_GRANT_ALL ? "output-test" : "output",
  vite: () => ({ plugins: [englishFallback()] }),
  hooks: {
    // The content script is registered at runtime (entrypoints/content.ts), and WXT adds
    // such a script's `matches` to host_permissions — which is the one thing this
    // extension must not ask for. What it asks for is decided below, and only below.
    // Dev mode (`npm run dev`) is left alone: WXT registers the script itself there.
    "build:manifestGenerated": (wxt, manifest) => {
      if (wxt.config.command === "serve") return;
      manifest.host_permissions = TEST_GRANT_ALL ? [...DAEMON_ORIGINS, ...ALL_SITES] : [...DAEMON_ORIGINS];
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
      // `scripting` is what registers the content script at runtime and injects it into a
      // tab the user has just asked about; `activeTab` is what makes that injection legal
      // on a site nothing has been granted for. Neither shows a warning at install time.
      permissions: ["storage", "activeTab", "contextMenus", "scripting"],
      // See CSP above. MV3 keys it under `extension_pages`; MV2 is the bare string.
      content_security_policy: browser === "firefox" ? CSP : { extension_pages: CSP },
      ...(browser === "firefox"
        ? {
            // "Copy page diagnostics" copies when the worker's menu message reaches the
            // page, which is no longer a user-input handler, and Firefox refuses a content
            // script both clipboard routes outside one. OPTIONAL, never required: a
            // clipboard permission is a warning at install time ("Input data to the
            // clipboard"; Chrome words it "Modify data you copy and paste"), and a menu
            // entry most readers will never open must not cost every reader that. The
            // worker asks for it inside the click itself, once (entrypoints/background.ts).
            // Chrome needs no permission at all: the async clipboard API answers a content
            // script whose tab is focused, which the click has just made it.
            //
            // MV2 has no `optional_host_permissions`: the two site patterns are optional
            // permissions like any other here. In the test build they are required
            // instead, so they are left out of this list and WXT folds host_permissions
            // into `permissions` for MV2.
            optional_permissions: TEST_GRANT_ALL ? ["clipboardWrite"] : ["clipboardWrite", ...ALL_SITES],
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
      // Keyboard commands. Chrome accepts at most FOUR suggested keys per extension, so
      // these four are the whole budget; everything else is rebindable at
      // chrome://extensions/shortcuts (about:addons on Firefox).
      //
      // All four are Alt+Shift+<letter>, a range no browser claims on macOS (its own
      // shortcuts are Command-based) and where the Windows/Linux exceptions are known and
      // avoided: Alt+Shift+T is Chrome's toolbar focus, Alt+Shift+B its bookmarks bar,
      // Alt+Shift+I its feedback form. P is the product's own letter; L is the LIST the
      // counter opens; J/K walk down/up the way every list-with-a-cursor has since vi —
      // and the pair sits under the right hand on QWERTY, next to each other.
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
      // REQUIRED: the local daemon, which is the only thing this extension may reach at
      // all. No site is included — Anagram installs able to read nothing, and the user
      // grants sites afterwards, all at once or one at a time (lib/access/*). The hook
      // above has the last word on this key.
      host_permissions: TEST_GRANT_ALL ? [...DAEMON_ORIGINS, ...ALL_SITES] : [...DAEMON_ORIGINS],
      // OPTIONAL (Chrome MV3; Firefox MV2 carries them in optional_permissions above):
      // "all sites", which the onboarding page and the options page ask for in one click.
      ...(TEST_GRANT_ALL ? {} : { optional_host_permissions: [...ALL_SITES] }),
      /**
       * Exactly the three chunks a CONTENT SCRIPT imports by URL, and nothing else.
       *
       * A content script's `import()` of an extension URL is a load performed in the web
       * page's context, so the file has to be declared here; an extension page is under no
       * such rule, which is what decides this list. Readability is loaded by the
       * main-content scope (lib/capture/orchestrator.ts), DOMPurify by the Google Docs
       * reading mode (lib/docsOverlay.ts) and the diagnostics chunk by the "Copy page
       * diagnostics" menu entry (lib/diagnostics/index.ts) — all three from
       * lib/lazy.ts, all three built by scripts/vendor.mjs.
       *
       * The rest of public/vendor/ is the PDF reader's: pdf.js, its worker, the CMaps, the
       * standard fourteen fonts, the colour profiles and the two WebAssembly decoders. The
       * reader is an extension page and fetches them as its own origin, so `vendor/*` —
       * which is what was declared until 2026-09-20 — was handing every website on the
       * internet three megabytes of files it has no use for, and handing any page that
       * cared a reliable way to detect that this extension is installed.
       *
       * `use_dynamic_url` closes the rest of that: Chrome then serves these three at an
       * address that is rotated per session and handed only to our own content script, so
       * a page cannot fetch them by guessing the extension id either. It was adopted
       * because the lazy imports go on working with it — the diagnostics chunk through
       * test/diagnostics-check.mjs, Readability through the main-content scenarios,
       * DOMPurify through the same lib/lazy.ts call these two prove. Firefox MV2 takes a
       * plain list of paths and ignores the key, which costs nothing: MV2 has no such
       * mechanism to begin with.
       */
      web_accessible_resources: [
        {
          resources: [
            "vendor/readability.min.mjs",
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
