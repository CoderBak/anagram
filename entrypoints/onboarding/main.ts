// Setup page: the engine panel reports its own lifecycle; this page adds the site grant
// once the engine is ready and points at the guide in the reader's language.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { linkSourceCode } from "../../lib/ui/sourceCode";
import { messageLocale, t } from "../../lib/i18n";
import { ALL_SITES } from "../../lib/access/patterns";
import { accessSummary, requestAccess } from "../../lib/access/grant";
import { mountComponentSettings, componentReady } from "#flavor/engine-panel";
import { scaleColorCss } from "../../lib/render/scale";

// The in-browser edition's engine card is named for what it is (localizePage leaves an
// English page's markup as it is, so the text is set here too).
if (import.meta.env.ANAGRAM_FLAVOR === "oneclick") {
  const title = document.querySelector<HTMLElement>('[data-i18n="componentTitle"]')!;
  title.dataset.i18n = "engineTitle";
  title.textContent = t("engineTitle");
}
localizePage();
followSystemTheme();
linkSourceCode();
// The demo's colours come from the same scale as the chips and marks on the page.
const scaleRule = document.createElement("style");
scaleRule.textContent = `.sc { --c: ${scaleColorCss(false)}; } html.dark .sc { --c: ${scaleColorCss(true)}; }`;
document.head.append(scaleRule);
document.getElementById("version")!.textContent = `v${browser.runtime.getManifest().version}`;
if (messageLocale() === "zh-CN") {
  (document.getElementById("guide") as HTMLAnchorElement).href = "https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.zh-CN.md";
}
const readyBlock = document.getElementById("ready")!;
const accessGrant = document.getElementById("access-grant") as HTMLButtonElement;
const accessOnce = document.getElementById("access-once")!;
const go = document.getElementById("go")!;
let ready = false, allSites = false;

function render(): void {
  readyBlock.hidden = !ready;
  accessGrant.hidden = accessOnce.hidden = allSites;
  go.hidden = !allSites;
}

async function renderAccess(): Promise<void> {
  allSites = (await accessSummary()).all;
  render();
}
// Permission requests remain optional and begin directly inside the user's gesture.
accessGrant.addEventListener("click", () => { void requestAccess(ALL_SITES).then(renderAccess); });
browser.permissions.onAdded.addListener(() => void renderAccess());
browser.permissions.onRemoved.addListener(() => void renderAccess());
void renderAccess();
mountComponentSettings(document.getElementById("componentSettings")!, (reply) => {
  ready = reply.kind === "ok" && componentReady(reply.snapshot);
  render();
});
// The next step belongs right under the status line, above the Manage and Advanced folds.
document.getElementById("manage")?.before(readyBlock);
