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
import { adoptBandColorRules } from "../../lib/render/scale";
import "../../lib/ui/rows.css";

localizePage();
followSystemTheme();
linkSourceCode();
// The four words' colours are the chips' and the marks' own.
adoptBandColorRules();
document.getElementById("version")!.textContent = `v${browser.runtime.getManifest().version}`;
if (messageLocale() === "zh-CN") {
  (document.getElementById("guide") as HTMLAnchorElement).href = "https://github.com/CoderBak/anagram/blob/dev/docs/user-guide.zh-CN.md";
}

// One step at a time: the first one not done is open, the others are a line each with their
// tick; a header opens or closes its step, and what the reader opened or closed stays so.
const steps = ["engineCard", "whereCard", "pinCard"].map((id) => document.getElementById(id)!);
const chosen = new Map<HTMLElement, boolean>();
function layout(): void {
  const current = steps.find((step) => !step.classList.contains("done"));
  for (const step of steps) {
    const open = chosen.get(step) ?? step === current;
    step.classList.toggle("open", open);
    step.querySelector(".step-toggle")!.setAttribute("aria-expanded", String(open));
  }
}
for (const step of steps) {
  const toggle = (): void => { chosen.set(step, !step.classList.contains("open")); layout(); };
  const header = step.querySelector("header")!;
  header.addEventListener("click", (e) => { if (!(e.target as Element).closest(".step-toggle")) toggle(); });
  step.querySelector(".step-toggle")!.addEventListener("click", toggle);
}
// Sent to a step (the toolbar menu's "How to keep Anagram in the toolbar"): that step open, in view.
function openAsked(): void {
  const asked = steps.find((step) => `#${step.id}` === location.hash);
  if (!asked) return;
  chosen.set(asked, true);
  layout();
  requestAnimationFrame(() => asked.scrollIntoView({ block: "start" }));
}
window.addEventListener("hashchange", openAsked);
const done = (id: string, yes: boolean): void => {
  const step = document.getElementById(id)!;
  if (step.classList.contains("done") === yes) return;
  step.classList.toggle("done", yes);
  layout();
};
layout();
openAsked();

const where = document.getElementById("where")!;
mountSiteAccess(where, { hint: true });
mountPdfRows(where);
mountToolbarGuide(document.getElementById("toolbarGuide")!);
mountEngineCard({
  title: document.getElementById("engineTitle")!,
  panelHost: document.getElementById("componentSettings")!,
  settings: false,
  // An engine that keeps dying is not done, whatever its last snapshot says.
  onUpdate: (engine, reply, crashed) => done("engineCard", !crashed && engineReady(engine, reply)),
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
