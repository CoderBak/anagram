// test/lab/show.mjs — leave a browser with the freshly built extension open on the lab's
// screen, so the current look can be checked at any size without anything opening on the Mac.
// Started by `npm run lab -- show …`; closed by `npm run lab -- hide` (or the window's ×).
//
//   show [url…]            default: the two fixture pages
//     --size 390x844       page size (default: a maximised window)
//     --dark               prefers-color-scheme: dark
//     --dpr 2              device pixel ratio of the page
// Scores come from the deterministic Native Messaging fixture, not model weights.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchExtension, serveHtml } from "../harness.mjs";

const TEST = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const take = (name, value = false) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return argv.splice(i, value ? 2 : 1)[value ? 1 : 0];
};
const size = take("size", true)?.match(/^(\d+)x(\d+)$/);
const dark = take("dark") !== undefined;
const dpr = Number(take("dpr", true) ?? 0) || undefined;
if (argv.some((arg) => arg.startsWith("--"))) throw new Error(`Unknown option: ${argv.find((arg) => arg.startsWith("--"))}`);

const fixtures = await serveHtml({
  "/selftest.html": readFileSync(join(TEST, "selftest.html"), "utf8"),
  "/ui-fixtures.html": readFileSync(join(TEST, "ui-fixtures.html"), "utf8"),
});
const urls = argv.length ? argv : [fixtures.url("/ui-fixtures.html"), fixtures.url("/selftest.html")];

console.log("show: deterministic Native Messaging fixture (not model inference)");

const { context } = await launchExtension({
  headless: false,
  viewport: size ? { width: +size[1], height: +size[2] } : null,
  deviceScaleFactor: size ? dpr : undefined,
  colorScheme: dark ? "dark" : undefined,
  args: size ? ["--window-position=40,40"] : ["--start-maximized"],
});
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
const first = context.pages()[0] ?? (await context.newPage());
await first.goto(urls[0], { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("show:", String(e).slice(0, 120)));
for (const url of urls.slice(1)) {
  const p = await context.newPage();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("show:", String(e).slice(0, 120)));
}
await first.bringToFront();
console.log(`show: open — ${urls.join("  ")}${size ? `  at ${size[0]}` : ""}${dark ? "  dark" : ""}${dpr ? `  dpr ${dpr}` : ""}`);

await new Promise((resolve) => {
  context.on("close", resolve);
  process.on("SIGINT", resolve);
  process.on("SIGTERM", resolve);
});
await context.close().catch(() => {});
process.exit(0);
