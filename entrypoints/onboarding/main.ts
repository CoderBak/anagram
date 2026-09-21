// First-run landing page: native setup owns its persisted download/benchmark lifecycle.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { t, tn } from "../../lib/i18n";
import { ALL_SITES } from "../../lib/access/patterns";
import { accessSummary, requestAccess } from "../../lib/access/grant";
import { mountComponentSettings, componentConnectionLabel, componentReady } from "../../lib/ui/componentSettings";

localizePage();
followSystemTheme();
const version = browser.runtime.getManifest().version;
document.getElementById("version")!.textContent = `v${version}`;
document.getElementById("ext-version")!.textContent = `v${version}`;
const componentRow = document.getElementById("row-daemon")!;
const componentState = document.getElementById("daemon-state")!;
const componentDetail = document.getElementById("daemon-detail")!;
const accessRow = document.getElementById("row-access")!;
const accessState = document.getElementById("access-state")!;
const accessGrant = document.getElementById("access-grant") as HTMLButtonElement;
const accessOnce = document.getElementById("access-once")!;
const readyRow = document.getElementById("row-ready")!;
const readyText = document.getElementById("ready-text")!;
let ready = false, connected = false, hasAccess = false;

function renderReady(): void {
  readyRow.dataset.state = ready ? "ok" : "idle";
  readyText.textContent = t(ready ? hasAccess ? "onbGo" : "componentReadyManual" : connected ? "runtimeSetupPending" : "componentInstallWaiting");
}

async function renderAccess(): Promise<void> {
  const { all, sites } = await accessSummary();
  accessRow.dataset.state = all || sites.length > 0 ? "ok" : "idle";
  accessState.textContent = all ? t("accessAll") : sites.length > 0 ? tn("accessSites", sites.length) : t("accessNone");
  accessGrant.hidden = all;
  accessOnce.hidden = all;
  hasAccess = all || sites.length > 0;
  renderReady();
}
// Permission requests remain optional and begin directly inside the user's gesture.
accessGrant.addEventListener("click", () => { void requestAccess(ALL_SITES).then(renderAccess); });
browser.permissions.onAdded.addListener(() => void renderAccess());
browser.permissions.onRemoved.addListener(() => void renderAccess());
void renderAccess();
mountComponentSettings(document.getElementById("componentSettings")!, (reply) => {
  connected = reply.kind === "ok";
  ready = reply.kind === "ok" && componentReady(reply.snapshot);
  componentRow.dataset.state = ready ? "ok" : reply.kind === "ok" && reply.snapshot.state !== "error" ? "idle" : "bad";
  componentState.textContent = componentConnectionLabel(reply);
  componentDetail.hidden = reply.kind !== "ok";
  componentDetail.textContent = reply.kind === "ok" && reply.snapshot.version ? `v${reply.snapshot.version}` : "";
  renderReady();
});
