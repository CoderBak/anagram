// entrypoints/options/main.ts — the settings surface.
// Global toggles bind straight to storage-backed settings (content scripts watch
// them live); the per-site section manages siteOverrides (add form + Remove
// buttons). All rendering is DOM construction — never innerHTML with stored
// strings (hostnames are user data).
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { settings, clearSiteOverride, setSiteOverride } from "../../lib/settings/settings";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus } from "../../lib/messaging/protocol";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const markStyleEl = document.getElementById("markStyle") as HTMLSelectElement;
const displayModeEl = document.getElementById("displayMode") as HTMLSelectElement;
const analysisScopeEl = document.getElementById("analysisScope") as HTMLSelectElement;
const mergeShortsEl = document.getElementById("mergeShorts") as HTMLInputElement;
const debugEl = document.getElementById("debug") as HTMLInputElement;
const sitesEl = document.getElementById("sites") as HTMLElement;
const versionEl = document.getElementById("version") as HTMLElement;
const addRuleEl = document.getElementById("addRule") as HTMLFormElement;
const addHostEl = document.getElementById("addHost") as HTMLInputElement;
const addModeEl = document.getElementById("addMode") as HTMLSelectElement;
const addErrorEl = document.getElementById("addError") as HTMLElement;
const backendEl = document.getElementById("backend") as HTMLSelectElement;
const serverUrlEl = document.getElementById("serverUrl") as HTMLInputElement;
const backendStatusEl = document.getElementById("backendStatus") as HTMLElement;
const checkBackendEl = document.getElementById("checkBackend") as HTMLButtonElement;

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

function bindSelect<T extends string>(
  el: HTMLSelectElement,
  item: { getValue(): Promise<T>; setValue(v: T): Promise<void> },
): void {
  void item.getValue().then((v) => {
    el.value = v;
  });
  el.addEventListener("change", () => {
    void item.setValue(el.value as T);
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

  const wrap = document.createElement("div");
  wrap.className = "table-container";
  const table = document.createElement("table");
  table.className = "table";
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
    remove.className = "btn";
    remove.dataset.variant = "ghost";
    remove.dataset.size = "xs";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      void clearSiteOverride(host).then(renderSites);
    });
    actions.appendChild(remove);
  }
  wrap.appendChild(table);
  sitesEl.appendChild(wrap);
}

/**
 * Normalize pasted site input to a bare hostname: trim, lowercase, and strip any
 * protocol/credentials/port/path ("https://x.com/foo" → "x.com"). Returns null
 * when nothing usable remains.
 */
function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(candidate).hostname.replace(/\.+$/, "");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

addRuleEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const host = normalizeHost(addHostEl.value);
  if (host === null) {
    addErrorEl.textContent = "Enter a hostname like example.com.";
    addErrorEl.hidden = false;
    return;
  }
  addErrorEl.hidden = true;
  const mode: "on" | "off" = addModeEl.value === "off" ? "off" : "on";
  // The siteOverrides watch below re-renders the table once the write lands.
  void setSiteOverride(host, mode).then(() => {
    addHostEl.value = "";
    addHostEl.focus();
  });
});
addHostEl.addEventListener("input", () => {
  addErrorEl.hidden = true;
});

followSystemTheme();
bindToggle(enabledEl, settings.enabled);
bindToggle(highlightsEl, settings.showHighlights);
bindToggle(debugEl, settings.debug);
bindToggle(mergeShortsEl, settings.mergeShorts);
bindSelect(displayModeEl, settings.displayMode);
bindSelect(markStyleEl, settings.markStyle);
bindSelect(analysisScopeEl, settings.analysisScope);
void renderSites();
settings.siteOverrides.watch(() => void renderSites());
const version = browser.runtime.getManifest().version;
versionEl.textContent = `v${version} · contract 2.0`;

// --- scoring backend -------------------------------------------------------------
bindSelect(backendEl, settings.backend);
void settings.serverUrl.getValue().then((v) => {
  serverUrlEl.value = v;
});
serverUrlEl.addEventListener("change", () => {
  const v = serverUrlEl.value.trim().replace(/\/+$/, "") || "http://127.0.0.1:8765";
  serverUrlEl.value = v;
  void settings.serverUrl.setValue(v).then(() => refreshBackend(true));
});

/** Ask the service worker which backend is live; `probe` forces a fresh /health check. */
async function refreshBackend(probe: boolean): Promise<void> {
  backendStatusEl.textContent = "Checking…";
  try {
    const s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe,
    })) as BackendStatus | undefined;
    if (!s) throw new Error("no status");
    if (s.active === "server") {
      backendStatusEl.textContent =
        `Connected — ${s.model.id} (${s.model.ver}) on ${s.server.device ?? "?"} at ${s.serverUrl}.`;
    } else if (s.mode === "stub") {
      backendStatusEl.textContent = "Demo stub selected — scores are deterministic placeholders, not verdicts.";
    } else {
      backendStatusEl.textContent =
        `Daemon not reachable at ${s.serverUrl} — ` +
        (s.mode === "auto" ? "using the demo stub until it comes up." : "paragraphs will show as Unavailable.");
    }
    versionEl.textContent =
      `v${version} · contract 2.0 · backend: ${s.active === "server" ? s.model.id : "demo stub"}`;
  } catch {
    backendStatusEl.textContent = "Could not reach the extension’s service worker.";
  }
}
checkBackendEl.addEventListener("click", () => void refreshBackend(true));
settings.backend.watch(() => void refreshBackend(true));
void refreshBackend(false);
