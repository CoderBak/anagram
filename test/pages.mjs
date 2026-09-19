// test/pages.mjs — screenshot the extension pages (popup / options / onboarding) in light +
// dark for visual QA. Output: <artifacts>/page-<name>-<scheme>.png (gitignored).
//   node test/pages.mjs [outDir] [popup,options,onboarding]
//
// ANAGRAM_UI_LANG switches the BROWSER's UI language — the one the extension follows — so
// the same pages can be looked at in another language:
//   ANAGRAM_UI_LANG=zh-CN node test/pages.mjs
// The shots are then written as page-<name>-<scheme>-<lang>.png, so a run in one language
// never overwrites another's, and the tool refuses to write English shots under a Chinese
// name: if the language could not be switched on this platform it says so and stops.
import { mkdirSync } from "node:fs";
import { launchExtension, uiLanguage, uiLanguageOf, ARTIFACTS } from "./harness.mjs";

const OUT = process.argv[2] || ARTIFACTS;
mkdirSync(OUT, { recursive: true });
const pages = (process.argv[3] || "popup,options,onboarding").split(",");
const LANG = process.env.ANAGRAM_UI_LANG || "";
const suffix = LANG ? `-${LANG}` : "";
for (const scheme of ["light", "dark"]) {
  const { context: ctx, sw, extId: id } = await launchExtension({
    colorScheme: scheme,
    viewport: { width: 900, height: 900 },
    ...(LANG ? uiLanguage(LANG) : {}),
  });
  if (LANG) {
    const actual = await uiLanguageOf(sw);
    if (actual !== LANG) {
      console.error(`could not switch the browser UI language to ${LANG} (it is ${actual})`);
      await ctx.close();
      process.exit(2);
    }
  }
  for (const name of pages) {
    const p = await ctx.newPage();
    await p.emulateMedia({ colorScheme: scheme });
    if (name === "popup") await p.setViewportSize({ width: 300, height: 560 });
    await p.goto(`chrome-extension://${id}/${name}.html`);
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}/page-${name}-${scheme}${suffix}.png`, fullPage: name !== "popup" });
    console.log("ok", `page-${name}-${scheme}${suffix}.png`);
  }
  await ctx.close();
}
