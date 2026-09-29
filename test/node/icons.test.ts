// test/node/icons.test.ts — the icon: clean SVG sources, the PNGs scripts/icons.mjs renders
// from them, and the manifest that names them. The ball's own use of it is checked in
// a browser (test/pw/scenarios-ui.spec.mjs).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SIZES = [16, 32, 48, 96, 128];

/** A PNG's size and whether it is RGBA, from its IHDR. */
function png(file: string): { width: number; height: number; colorType: number } {
  const b = readFileSync(join(ROOT, file));
  expect(b.subarray(1, 4).toString(), file).toBe("PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25]! };
}

describe("the icon sources", () => {
  for (const file of ["assets/icon-dark.svg", "assets/icon-light.svg"]) {
    it(`${file} has transparent corners and carries no provenance metadata`, () => {
      const svg = readFileSync(join(ROOT, file), "utf8");
      expect(svg).not.toMatch(/c2pa|<metadata/i);
      // No rectangle over the whole canvas: the tile is the only thing that paints its corners.
      expect(svg).not.toMatch(/<rect width="1254" height="1254" fill="#[0-9a-f]+"/i);
      expect(svg).toContain('id="tileShape"');
    });
  }
});

describe("the icon PNGs", () => {
  for (const stem of ["icon", "icon-light"]) {
    for (const size of SIZES) {
      it(`${stem}-${size}.png is ${size} px square with an alpha channel`, () => {
        expect(png(`public/icons/${stem}-${size}.png`)).toEqual({ width: size, height: size, colorType: 6 });
      });
    }
  }
});

describe("the shipping manifest's icons", () => {
  const OUT = join(ROOT, "output", "chrome-mv3");
  const built = existsSync(join(OUT, "manifest.json")) ? statSync(join(OUT, "manifest.json")).mtimeMs : 0;
  const ready = built > 0 && statSync(join(ROOT, "wxt.config.ts")).mtimeMs <= built;
  it.skipIf(!ready)("names the dark tile at 16, 32, 48, 96 and 128, for the extension and its toolbar button", () => {
    const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")) as {
      icons: Record<string, string>;
      action: { default_icon: Record<string, string> };
    };
    for (const set of [m.icons, m.action.default_icon]) {
      expect(Object.keys(set).map(Number)).toEqual(SIZES);
      for (const [size, path] of Object.entries(set)) {
        expect(path).toBe(`icons/icon-${size}.png`);
        expect(existsSync(join(OUT, path)), path).toBe(true);
      }
    }
  });
});

describe("the Firefox manifest's toolbar button", () => {
  const OUT = join(ROOT, "output", "firefox-mv2");
  const built = existsSync(join(OUT, "manifest.json")) ? statSync(join(OUT, "manifest.json")).mtimeMs : 0;
  const ready = built > 0 && statSync(join(ROOT, "wxt.config.ts")).mtimeMs <= built;
  it.skipIf(!ready)("shows the dark tile, and the light tile on themes with light text (dark toolbars)", () => {
    const m = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")) as {
      browser_action: { default_icon: Record<string, string>; theme_icons: { light: string; dark: string; size: number }[] };
    };
    expect(m.browser_action.default_icon["16"]).toBe("icons/icon-16.png");
    expect(m.browser_action.theme_icons).toEqual([16, 32].map((size) => ({ light: `icons/icon-light-${size}.png`, dark: `icons/icon-${size}.png`, size })));
    for (const t of m.browser_action.theme_icons) for (const f of [t.light, t.dark]) expect(existsSync(join(OUT, f)), f).toBe(true);
  });
});
