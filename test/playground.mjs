// test/playground.mjs — a live browser to PLAY with the extension.
//
// Opens a headed Chromium with the freshly built extension and a set of
// interesting tabs (fixtures + real pages). Stays open until you close the
// window. Fresh throwaway profile each launch (so rebuilds always load) —
// for logged-in sites, load output/chrome-mv3 into your own Chrome instead.
//
//   npm run play
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "output", "chrome-mv3");
if (!existsSync(join(EXT, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

// Serve both fixture pages over http so the content script injects.
const pages = {
  "/selftest.html": readFileSync(join(__dirname, "selftest.html"), "utf8"),
  "/ui-fixtures.html": readFileSync(join(__dirname, "ui-fixtures.html"), "utf8"),
};
const server = http.createServer((req, res) => {
  const body = pages[req.url.split("?")[0]] ?? pages["/selftest.html"];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

const TABS = [
  `http://localhost:${port}/selftest.html`,
  "https://en.wikipedia.org/wiki/Alan_Turing",
  "https://huggingface.co/papers/2606.12385",
  "https://docs.google.com/document/d/1gRLkVx985SLnysZvrkm8PQolykP-rRWxBtxFoywXXRo/edit?usp=sharing",
  "https://www.rfc-editor.org/rfc/rfc768.txt",
];

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
  ],
});
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

const first = context.pages()[0] ?? (await context.newPage());
await first.goto(TABS[0]).catch(() => {});
for (const url of TABS.slice(1)) {
  const p = await context.newPage();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
}
await first.bringToFront();

console.log("\n🟢  Pangram playground is live.");
console.log("    Tabs: self-test · Wikipedia · HF paper · your Google Doc · RFC txt");
console.log("    Close the browser window (or Ctrl+C here) to stop.\n");

await new Promise((resolve) => {
  context.on("close", resolve);
  process.on("SIGINT", resolve);
  process.on("SIGTERM", resolve);
});
server.close();
process.exit(0);
