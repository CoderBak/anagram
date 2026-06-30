// test/pages.mjs — screenshot the extension pages (popup / options / onboarding) in light +
// dark for visual QA. Output: test/page-<name>-<scheme>.png (gitignored).
//   node test/pages.mjs [outDir] [popup,options,onboarding]
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "output", "chrome-mv3");
const OUT = process.argv[2] || __dirname;
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const pages = (process.argv[3] || "popup,options,onboarding").split(",");
for (const scheme of ["light", "dark"]) {
  const ctx = await chromium.launchPersistentContext("", {
    headless: false, colorScheme: scheme, viewport: { width: 900, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  for (const name of pages) {
    const p = await ctx.newPage();
    await p.emulateMedia({ colorScheme: scheme });
    if (name === "popup") await p.setViewportSize({ width: 300, height: 560 });
    await p.goto(`chrome-extension://${id}/${name}.html`);
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}/page-${name}-${scheme}.png`, fullPage: name !== "popup" });
    console.log("ok", `page-${name}-${scheme}.png`);
  }
  await ctx.close();
}
