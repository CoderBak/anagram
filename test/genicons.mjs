// Generate extension icons by rendering the FAB mark design at exact sizes.
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  const fontPx = Math.round(size * 0.62);
  const radius = Math.round(size * 0.22);
  await page.setContent(`<!doctype html><html><head><style>
    * { margin: 0; padding: 0; }
    body { width: ${size}px; height: ${size}px; }
    .mark {
      width: ${size}px; height: ${size}px;
      display: flex; align-items: center; justify-content: center;
      border-radius: ${radius}px;
      background: linear-gradient(135deg, #6d5efc, #b15efc);
      color: #fff;
      font: 800 ${fontPx}px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
    }
  </style></head><body><div class="mark">A</div></body></html>`);
  await page.locator(".mark").screenshot({
    path: `public/icons/icon-${size}.png`,
    omitBackground: true,
  });
  console.log(`icon-${size}.png`);
}
await browser.close();
