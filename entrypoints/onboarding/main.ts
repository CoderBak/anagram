// Setup page, three numbered steps and how to read the marks: the engine and its model download
// (the engine card decides which engine this device runs, or lets the person choose, and its
// panel reports its own lifecycle, lib/ui/engineCard.ts), where Anagram reads, and keeping it in
// the toolbar, whose menu is where it is used from. Each step's number turns into a tick once
// the step is done, so the page says what is left at a glance.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { linkSourceCode } from "../../lib/ui/sourceCode";
import { messageLocale } from "../../lib/i18n";
import { engineReady, mountEngineCard } from "../../lib/ui/engineCard";
import { mountSiteAccess } from "../../lib/ui/siteAccess";
import { mountPdfRows } from "../../lib/ui/pdfRows";
import { mountToolbarGuide } from "../../lib/ui/toolbarGuide";
import { accessSummary } from "../../lib/access/grant";
import { bandColorRules } from "../../lib/render/scale";
import "../../lib/ui/rows.css";

localizePage();
followSystemTheme();
linkSourceCode();
// The four words' colours are the chips' and the marks' own.
const scaleRule = document.createElement("style");
scaleRule.textContent = bandColorRules("", "html.dark");
document.head.append(scaleRule);
document.getElementById("version")!.textContent = `v${browser.runtime.getManifest().version}`;
if (messageLocale() === "zh-CN") {
  (document.getElementById("guide") as HTMLAnchorElement).href = "https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.zh-CN.md";
}

const done = (id: string, yes: boolean): void => { document.getElementById(id)!.classList.toggle("done", yes); };

const where = document.getElementById("where")!;
mountSiteAccess(where, { hint: true });
mountPdfRows(where);
mountToolbarGuide(document.getElementById("toolbarGuide")!);
mountEngineCard({
  title: document.getElementById("engineTitle")!,
  panelHost: document.getElementById("componentSettings")!,
  settings: false,
  onUpdate: (engine, reply) => done("engineCard", engineReady(engine, reply)),
});

/** Step 2 is done once any site may be read; step 3 once the browser keeps Anagram in the
 *  toolbar (where it can say: Chrome's action settings). */
async function checkSteps(): Promise<void> {
  const access = await accessSummary().catch(() => null);
  done("whereCard", !!access && (access.all || access.sites.length > 0));
  const userSettings = (browser as { action?: { getUserSettings?: () => Promise<{ isOnToolbar?: boolean }> } }).action?.getUserSettings;
  const pinned = userSettings ? await userSettings().then((u) => u.isOnToolbar === true).catch(() => false) : false;
  done("pinCard", pinned);
}
browser.permissions.onAdded.addListener(() => void checkSteps());
browser.permissions.onRemoved.addListener(() => void checkSteps());
// Pinning is the browser's, and it says nothing when it happens: look again while the page is open.
setInterval(() => void checkSteps(), 2000);
void checkSteps();
