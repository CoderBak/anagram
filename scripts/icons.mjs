// scripts/icons.mjs — renders public/icons/ from the SVGs in assets/ with Playwright's Chromium
// (transparent corners). Run `npm run icons` after changing an SVG and commit the PNGs: the build
// copies them as they are.
//   icon-N.png        dark tile: the manifest and the toolbar, and the pages' headers on dark themes
//   icon-light-N.png  light tile: the pages' headers on light themes
// 16, 32 and 48 px come from the *-small.svg drawings, full-bleed on the 16 px grid so their edges
// land on whole pixels; 96 and 128 px from the full drawings, whose tile keeps its margin.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SIZES = [16, 32, 48, 96, 128];
const SMALL = new Set([16, 32, 48]);
const VARIANTS = [
  ["icon-dark", "icon"],
  ["icon-light", "icon-light"],
];

const out = join(root, "public/icons");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [drawing, stem] of VARIANTS) {
    for (const size of SIZES) {
      const svg = readFileSync(join(root, "assets", `${drawing}${SMALL.has(size) ? "-small" : ""}.svg`), "utf8");
      const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${url}">`,
      );
      await page.evaluate(() => document.querySelector("img").decode());
      const png = await page.screenshot({ omitBackground: true, type: "png" });
      writeFileSync(join(out, `${stem}-${size}.png`), png);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`icons: ${VARIANTS.length * SIZES.length} PNGs in public/icons/`);
