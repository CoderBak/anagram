// test/browser.mjs — launch a PERSISTENT, headed Chromium with the Anagram extension
// loaded, open the self-test page, and stay open until you close the window.
//
// Unlike e2e.mjs (which asserts + exits), this just opens a real browser you drive
// yourself: scroll, type a URL, visit any site — the badges appear on any page with prose.
//
//   node test/browser.mjs        (or: npm run browser)
//
// Stop it by closing the Chromium window, or Ctrl+C in this terminal.
import { launchExtension } from "./harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELFTEST = join(__dirname, "selftest.html");

// Serve the self-contained self-test page over http so the content script runs.
const html = readFileSync(SELFTEST, "utf8");
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const selftestUrl = `http://localhost:${port}/selftest.html`;

// The shared harness gives this session a fresh profile and a private native fixture.
const { context } = await launchExtension({
  headless: false, viewport: null, args: ["--start-maximized"],
});
console.log("Scores use the isolated deterministic Native Messaging fixture, not model weights.");

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(selftestUrl).catch(() => {});

// Diagnostic: capture what THIS window actually renders, then (SNAP=1) exit.
await page.waitForTimeout(2500).catch(() => {});
await page.screenshot({ path: join(__dirname, "live.png"), fullPage: true }).catch(() => {});
console.log("    live screenshot: " + join(__dirname, "live.png"));
if (process.env.SNAP === "1") {
  await context.close();
  server.close();
  process.exit(0);
}

console.log("\n🟢  Anagram extension is live in this Chromium window.");
console.log("    Self-test page:  " + selftestUrl);
console.log("    Navigate anywhere — badges appear on any page with paragraphs.");
console.log("    Toggle it / per-site / Rescan from the toolbar popup.");
console.log("    Close the window (or Ctrl+C here) to stop.\n");

// Stay alive until the browser window is closed.
await new Promise((resolve) => {
  context.on("close", resolve);
  process.on("SIGINT", resolve);
  process.on("SIGTERM", resolve);
});
await context.close().catch(() => {});
server.close();
process.exit(0);
