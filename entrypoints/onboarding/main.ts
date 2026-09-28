// Setup page: the engine card decides which engine this device runs, or lets the person
// choose, and its panel reports its own lifecycle (lib/ui/engineCard.ts); this page adds the
// site grant once the engine is ready and points at the guide in the reader's language.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { linkSourceCode } from "../../lib/ui/sourceCode";
import { messageLocale } from "../../lib/i18n";
import { ALL_SITES } from "../../lib/access/patterns";
import { accessSummary, requestAccess } from "../../lib/access/grant";
import { engineReady, mountEngineCard } from "../../lib/ui/engineCard";
import { scaleColorCss } from "../../lib/render/scale";

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
mountEngineCard({
  title: document.getElementById("engineTitle")!,
  panelHost: document.getElementById("componentSettings")!,
  settings: false,
  onUpdate: (engine, reply) => {
    ready = engineReady(engine, reply);
    // The next step belongs right under the status line, above the Manage and Advanced folds.
    const manage = document.getElementById("manage");
    if (manage && manage.previousElementSibling !== readyBlock) manage.before(readyBlock);
    render();
  },
});
