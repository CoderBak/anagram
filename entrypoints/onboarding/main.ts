// Setup page, one compact page: where Anagram reads (permissions come first, so they are seen
// at the very start), the engine and its model download (the engine card decides which engine
// this device runs, or lets the person choose, and its panel reports its own lifecycle,
// lib/ui/engineCard.ts), and how to read a verdict.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { linkSourceCode } from "../../lib/ui/sourceCode";
import { messageLocale } from "../../lib/i18n";
import { mountEngineCard } from "../../lib/ui/engineCard";
import { mountSiteAccess } from "../../lib/ui/siteAccess";
import { mountPdfRows } from "../../lib/ui/pdfRows";
import { scaleColorCss, scaleGradient } from "../../lib/render/scale";
import "../../lib/ui/rows.css";

localizePage();
followSystemTheme();
linkSourceCode();
// The colours of the four words and of the scale come from the same ramp as the chips and marks on the page.
const scaleRule = document.createElement("style");
scaleRule.textContent =
  `.sc { --c: ${scaleColorCss(false)}; } html.dark .sc { --c: ${scaleColorCss(true)}; }` +
  `.grad { background: ${scaleGradient(false)}; } html.dark .grad { background: ${scaleGradient(true)}; }`;
document.head.append(scaleRule);
document.getElementById("version")!.textContent = `v${browser.runtime.getManifest().version}`;
if (messageLocale() === "zh-CN") {
  (document.getElementById("guide") as HTMLAnchorElement).href = "https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.zh-CN.md";
}

const where = document.getElementById("where")!;
mountSiteAccess(where, { hint: true });
mountPdfRows(where);
mountEngineCard({
  title: document.getElementById("engineTitle")!,
  panelHost: document.getElementById("componentSettings")!,
  settings: false,
});
