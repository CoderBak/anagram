// test/pages.mjs — screenshot the extension pages (popup / options / onboarding) in light +
// dark for visual QA. Output: <artifacts>/page-<name>-<scheme>.png (gitignored).
//   node test/pages.mjs [outDir] [popup,options,onboarding]
import { mkdirSync } from "node:fs";
import { launchExtension, ARTIFACTS } from "./harness.mjs";

const OUT = process.argv[2] || ARTIFACTS;
mkdirSync(OUT, { recursive: true });
const pages = (process.argv[3] || "popup,options,onboarding").split(",");
for (const scheme of ["light", "dark"]) {
  const { context: ctx, extId: id } = await launchExtension({ colorScheme: scheme, viewport: { width: 900, height: 900 } });
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
