import { defineConfig } from "wxt";

// WXT config: manifest keys, permissions, targets (spec §8.2).
// NOTE: icons are intentionally omitted for M1 (no PNGs generated yet); the build
// must succeed without them. Add an `icons` key + public/icons/*.png post-M1.
export default defineConfig({
  // Build into ./output (not WXT's default ./.output) so it's visible in Finder.
  outDir: "output",
  manifest: {
    name: "Pangram AI Detector",
    description: "Per-paragraph AI-generated-text confidence badges.",
    permissions: ["storage", "activeTab"],
    host_permissions: ["<all_urls>"],
    action: {
      default_popup: "popup/index.html",
      default_title: "Pangram AI Detector",
    },
  },
});
