// entrypoints/options/main.ts — the settings surface.
// Global toggles bind straight to storage-backed settings (content scripts watch
// them live); the per-site table manages siteOverrides. All rendering is DOM
// construction — never innerHTML with stored strings (hostnames are user data).
import { browser } from "#imports";
import { settings, clearSiteOverride } from "../../lib/settings/settings";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const debugEl = document.getElementById("debug") as HTMLInputElement;
const sitesEl = document.getElementById("sites") as HTMLElement;
const versionEl = document.getElementById("version") as HTMLElement;

function bindToggle(
  el: HTMLInputElement,
  item: { getValue(): Promise<boolean>; setValue(v: boolean): Promise<void> },
): void {
  void item.getValue().then((v) => {
    el.checked = v;
  });
  el.addEventListener("change", () => {
    void item.setValue(el.checked);
  });
}

async function renderSites(): Promise<void> {
  const overrides = await settings.siteOverrides.getValue();
  const hosts = Object.keys(overrides).sort();
  sitesEl.textContent = "";

  if (hosts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "No per-site rules yet. Use the toolbar popup's “This site” toggle to add one.";
    sitesEl.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const h of ["Site", "Rule", ""]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const host of hosts) {
    const mode = overrides[host];
    const row = body.insertRow();
    row.insertCell().textContent = host;
    const modeCell = row.insertCell();
    modeCell.textContent = mode === "on" ? "Always on" : "Always off";
    modeCell.className = `mode-${mode}`;
    const actions = row.insertCell();
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      void clearSiteOverride(host).then(renderSites);
    });
    actions.appendChild(remove);
  }
  sitesEl.appendChild(table);
}

bindToggle(enabledEl, settings.enabled);
bindToggle(highlightsEl, settings.showHighlights);
bindToggle(debugEl, settings.debug);
void renderSites();
settings.siteOverrides.watch(() => void renderSites());
versionEl.textContent = `v${browser.runtime.getManifest().version} · surface v2 · backend: random stub`;
