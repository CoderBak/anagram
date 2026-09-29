// scripts/icons.mjs — renders public/icons/ from assets/icon-dark.svg and assets/icon-light.svg
// with Playwright's Chromium (transparent corners). Run `npm run icons` after changing an SVG
// and commit the PNGs: the build copies them as they are.
//   icon-N.png        dark tile: the manifest, the toolbar, the ball and headers on dark themes
//   icon-light-N.png  light tile: the ball and the headers on light themes
// The whole 1254 canvas is rendered: the margin around the tile is the artwork's own.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SIZES = [16, 32, 48, 96, 128];
const VARIANTS = [
  ["assets/icon-dark.svg", "icon"],
  ["assets/icon-light.svg", "icon-light"],
];

const out = join(root, "public/icons");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [file, stem] of VARIANTS) {
    const svg = readFileSync(join(root, file), "utf8");
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    for (const size of SIZES) {
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
