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
import { NOTICES_FILE, bundledPackages, packageOfModule, unlistedPackages } from "./scripts/notices.mjs";
import { machinePaths } from "./scripts/machinePaths.mjs";

// Page-reading tests pregrant website access and Native Messaging in a separate
// output-test directory. Shipping installs keep both optional.
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

/** In a dev build a page's link to a public file comes out as the dev server's
 *  `/@fs/vendor/…`, which names no file: it is answered from public/ (the reader's PDF.js
 *  viewer.css, without which the viewer does not start). And each page's own CSP lets it
 *  reach the dev server's socket, as the manifest's does: otherwise every page logs a
 *  violation to the extension's error list. */
function publicLinksInDev() {
  return {
    name: "anagram:public-links-in-dev",
    transformIndexHtml(html: string, ctx: { server?: { config: { server: { origin?: string; port?: number } } } }) {
      const server = ctx.server?.config.server;
      const socket = (server?.origin ?? `http://localhost:${server?.port ?? 3000}`).replace(/^http/, "ws");
      // WXT hands a page through this twice: the source goes in once.
      return html.includes(socket) ? html : html.replace(/(http-equiv="Content-Security-Policy" content="connect-src 'self')/u, `$1 ${socket}`);
    },
    configureServer(server: { middlewares: { use(handler: (req: { url?: string }, res: unknown, next: () => void) => void): void } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith("/@fs/vendor/")) req.url = req.url.slice("/@fs".length);
        next();
      });
    },
  };
}

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

// Every npm package the build compiles code from is named in THIRD_PARTY_NOTICES.md
// (scripts/notices.mjs), and every package named there for this build still ships: a
// dependency added without its notice, or a notice kept for code that has gone, fails the
// build. The group builds each report what their chunks hold; "build:done" compares.
const shippedPackages = new Set<string>();
type BundleChunk = { type: string; modules?: Record<string, { renderedLength: number }> };
function thirdPartyNotices() {
  return {
    name: "anagram:third-party-notices",
    generateBundle(_options: unknown, bundle: Record<string, BundleChunk>) {
      for (const chunk of Object.values(bundle)) {
        for (const [id, { renderedLength }] of Object.entries(chunk.modules ?? {})) {
          const pkg = renderedLength > 0 ? packageOfModule(id) : null;
          if (pkg) shippedPackages.add(pkg);
        }
      }
      const unlisted = unlistedPackages(shippedPackages);
      if (unlisted.length > 0) {
        throw new Error(
          `The build bundles code from packages ${NOTICES_FILE} does not list. Add each to scripts/notices.mjs with its licence and run node scripts/notices.mjs:\n  ${unlisted.join("\n  ")}`,
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

// The dark tile at every size scripts/icons.mjs renders: it reads on light and dark toolbars.
const TOOLBAR_ICONS = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  96: "icons/icon-96.png",
  128: "icons/icon-128.png",
};

// WXT config: manifest keys, permissions, targets.
// Icons are committed as PNGs under public/icons/ and copied into the build as-is
// (scripts/icons.mjs renders them from assets/*.svg).
export default defineConfig({
  // Build into ./output (not WXT's default ./.output) so it's visible in Finder.
  outDir: TEST_GRANT_ALL ? "output-test" : "output",
  zip: {
    // Keep generated output out of Firefox's review source archive. WXT excludes
    // output/ and node_modules itself, but does not apply our .gitignore.
    excludeSources: [
      "dist/**", "output-test/**", "test-results/**", ".cache/**",
      "**/__pycache__/**", "**/*.pyc", "**/*.log", "**/*.ses",
      "test/*.png", "test/matrix.json", "test/survey.json",
    ],
  },
  // A dev build is never shipped, and WXT's reloader pulls in code no shipping build has.
  vite: ({ command }) => ({
    // The test build reads a stand-in device (lib/ui/deviceInputs.ts); the shipping one has no such code.
    define: { "import.meta.env.ANAGRAM_TEST_BUILD": JSON.stringify(TEST_GRANT_ALL ? "1" : "") },
    plugins: [englishFallback(), ...(command === "serve" ? [publicLinksInDev()] : [thirdPartyNotices()])],
    // The extension's pages are cross-origin isolated (require-corp), and in a dev build their
    // stylesheets come from the dev server: it has to say they may be embedded.
    server: { headers: { "Cross-Origin-Resource-Policy": "cross-origin" } },
  }),
  hooks: {
    // AGPL: every copy of the extension carries the licence text, and the notices of the
    // third-party work it contains.
    "build:publicAssets": (_wxt, files) => {
      for (const name of ["LICENSE", NOTICES_FILE]) files.push({ absoluteSrc: resolve(ROOT, name), relativeDest: name });
    },
    "build:before": () => shippedPackages.clear(),
    // WXT's dev reloader refreshes every tab a content script may run on, which in an
    // everyday browser with all sites granted is every tab, and does so whenever the
    // background connects. Here a content-script change reloads the extension instead, once,
    // and the background connecting reloads nothing: open tabs keep their page. Installed on
    // every start, together with its flag: a changed config is a new module, and a reloader
    // reading another start's flag would answer every connection with a reload, forever.
    "server:started": (_wxt, server) => {
      let connecting = false, pending = false;
      // Runs before WXT adds its own listener for the same event, so the flag is up while
      // that listener asks for the content scripts' reload.
      server.ws.on("wxt:background-initialized", () => {
        connecting = true;
        queueMicrotask(() => (connecting = false));
      });
      server.reloadContentScript = () => {
        if (pending || connecting) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          server.reloadExtension();
        });
      };
    },
    "build:done": (wxt) => {
      if (wxt.config.command === "serve") return;
      const gone = [...bundledPackages()]
        .filter(([name, { chunk }]) => !chunk && !shippedPackages.has(name))
        .map(([name]) => name);
      if (gone.length > 0) {
        throw new Error(
          `${NOTICES_FILE} lists packages this build no longer bundles. Remove them from scripts/notices.mjs and run node scripts/notices.mjs:\n  ${gone.join("\n  ")}`,
        );
      }
      const leaks = machinePaths(wxt.config.outDir);
      if (leaks.length > 0) {
        throw new Error(`The build carries paths of the machine it was built on (scripts/machinePaths.mjs):\n  ${leaks.join("\n  ")}`);
      }
    },
    // Production content scripts are registered only after a grant or user action.
    // Remove WXT's inferred hosts; its dev server manages its own registration.
    "build:manifestGenerated": (wxt, manifest) => {
      // A dev build loaded into an everyday browser reads only the sites granted to it, as a
      // shipping build does: WXT's dev server keeps its own host but not the content script's
      // <all_urls>, nor `tabs`. Its reloader's WebSocket needs a ws: source, which the
      // connect-src's http: does not cover, and the pages' stylesheets (the reader's PDF.js
      // viewer.css) and the images and fonts they name come from the dev server too, as WXT
      // already allows their scripts to.
      if (wxt.config.command === "serve") {
        manifest.host_permissions = manifest.host_permissions?.filter((p: string) => p !== "<all_urls>");
        manifest.permissions = manifest.permissions?.filter((p: string) => p !== "tabs");
        const csp = manifest.content_security_policy;
        if (typeof csp === "object" && csp.extension_pages && wxt.server) {
          csp.extension_pages = csp.extension_pages
            .replace("connect-src 'self'", `connect-src 'self' ${wxt.server.origin.replace(/^http/, "ws")}`)
            .replace("style-src 'self'", `style-src 'self' ${wxt.server.origin}`)
            .replace("img-src 'self'", `img-src 'self' ${wxt.server.origin}`)
            .replace("font-src 'self'", `font-src 'self' ${wxt.server.origin}`);
        }
        return;
      }
      if (TEST_GRANT_ALL) manifest.host_permissions = [...ALL_SITES];
      else delete manifest.host_permissions;
      // Firefox's MV2 button is built from the popup page, not from `action` above: its icon
      // is set here. "light" is the icon for themes with light text (dark toolbars), "dark"
      // for themes with dark text (light toolbars) - MDN, browser_action theme_icons.
      if (manifest.browser_action) {
        manifest.browser_action.default_icon = TOOLBAR_ICONS;
        manifest.browser_action.theme_icons = [16, 32].map((size) => ({
          light: `icons/icon-light-${size}.png`,
          dark: `icons/icon-${size}.png`,
          size,
        }));
      }
    },
  },
  manifest: ({ browser }) => {
    const safari = browser === "safari";
    const productName = safari ? "Anagram for Safari" : browser === "firefox" ? "Anagram for Firefox" : "Anagram for Chrome";
    // Two engines, chosen at run time (lib/backend/engines.ts). The in-browser one runs in an
    // offscreen document (Chrome), a background page (Firefox), or a pinned tab (Safari), and keeps
    // the model in the extension's storage, which the browser must not evict. Its download
    // needs no host: Hugging Face answers it with CORS headers, and the language identifier
    // ships in the package (lib/webengine/pin.ts). Native Messaging reaches the local engine
    // and is asked for when the person picks it in Chrome/Firefox. Safari declares it
    // for the containing-app bridge, but engine choice remains explicit. Test builds
    // require it for the suites that drive the fake host.
    const engine = [...(browser === "chrome" ? ["offscreen"] : []), "unlimitedStorage", ...(TEST_GRANT_ALL || browser === "safari" ? ["nativeMessaging"] : [])];
    const optionalNative = TEST_GRANT_ALL || browser === "safari" ? [] : ["nativeMessaging"];
    return {
      name: productName,
      // The browser's own UI language picks the folder under public/_locales; English is
      // what it falls back to, which is also what every __MSG_* below is written in.
      default_locale: "en",
      description: "__MSG_extDescription__",
      // The engines' permissions provide inference; activeTab/scripting provide opt-in reading.
      permissions: ["storage", "activeTab", "contextMenus", "scripting", ...engine, "webNavigation", "webRequest"],
      // See CSP above. MV3 keys it under `extension_pages`; MV2 is the bare string.
      content_security_policy: browser === "firefox" ? CSP : { extension_pages: CSP },
      ...(browser === "firefox"
        ? {
            // Firefox clipboard copying asks permission only when the menu is used.
            // MV2 carries optional website patterns in the same list.
            optional_permissions: TEST_GRANT_ALL
              ? ["clipboardWrite", "file:///*"]
              : ["clipboardWrite", ...optionalNative, ...ALL_SITES, "file:///*"],
            browser_specific_settings: {
              gecko: {
                // The ID the local engine's installer registers (installer/native_registration.py).
                id: "anagram@coderbak.dev",
                // 153 (an ESR) has WebAssembly JSPI, which ONNX Runtime Web's one build needs
                // (the in-browser engine and the PDF document worker), and CSS.highlights,
                // which draws every underline; test/firefox.mjs runs against it.
                strict_min_version: "153.0",
                // AMO's data-collection disclosure: nothing is collected or transmitted.
                data_collection_permissions: { required: ["none"] },
              },
            },
          }
        : safari ? {
            browser_specific_settings: { safari: { strict_min_version: "27.0" } },
          } : {
            // Native Messaging, optional: Chrome 137 accepts it so, and an update keeps the
            // grant a release that required it had (test/inbrowser.mjs).
            optional_permissions: optionalNative,
            // The in-browser engine's runtime is ONNX Runtime Web's JSPI build, the GPU and the
            // CPU path alike (lib/webengine/session.ts): WebAssembly JSPI shipped in Chrome 137.
            minimum_chrome_version: "137",
            // Cross-origin isolation for every extension page, so that the offscreen
            // document's worker has SharedArrayBuffer and the CPU path its threads. The pages
            // load nothing cross-origin but by fetch (test/inbrowser.mjs checks each one
            // isolated and the reader opening a PDF; the suites drive the local engine's pages
            // under it too).
            cross_origin_embedder_policy: { value: "require-corp" },
            cross_origin_opener_policy: { value: "same-origin" },
          }),
      // Chrome permits four suggested shortcuts. Avoid its Alt+Shift+T/B/I bindings.
      commands: {
        "toggle-overlay": {
          suggested_key: { default: "Alt+Shift+P" },
          description: "__MSG_cmdToggleOverlay__",
        },
        [browser === "firefox" ? "_execute_browser_action" : "_execute_action"]: {
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
      // Website access is optional.
      ...(TEST_GRANT_ALL ? { host_permissions: [...ALL_SITES] } : {}),
      // OPTIONAL (Chrome MV3; Firefox MV2 carries them in optional_permissions above):
      // "all sites", which the onboarding page and the options page ask for in one click.
      optional_host_permissions: [...(TEST_GRANT_ALL ? [] : ALL_SITES), ...(safari ? [] : ["file:///*"])],
      // Only content-script imports are web accessible. Reader assets stay private;
      // Chrome rotates these chunk URLs per session to prevent stable-ID probing.
      web_accessible_resources: [
        {
          resources: [
            "vendor/purify.min.mjs",
            "vendor/diagnostics.min.mjs",
            "vendor/surfaces.min.mjs",
            // The Google Docs reading bar's icon on a light and on a dark page (lib/render/logo.ts).
            "icons/icon-96.png",
            "icons/icon-light-96.png",
          ],
          matches: ["<all_urls>"],
          ...(!safari ? { use_dynamic_url: true } : {}),
        },
      ],
      icons: TOOLBAR_ICONS,
      action: {
        default_popup: "popup/index.html",
        default_title: productName,
        // The dark tile reads on light and dark toolbars alike.
        default_icon: TOOLBAR_ICONS,
      },
    };
  },
});
