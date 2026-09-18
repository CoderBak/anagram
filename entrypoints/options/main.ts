// entrypoints/options/main.ts — the settings surface.
// Global toggles bind straight to storage-backed settings (content scripts watch
// them live); the per-site section manages siteOverrides (add form + Remove
// buttons). All rendering is DOM construction — never innerHTML with stored
// strings (hostnames are user data).
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { settings, clearSiteOverride, setSiteOverride, normalizeServerUrl, DEFAULT_SERVER_URL } from "../../lib/settings/settings";
import { ACTIONS } from "../../lib/messaging/protocol";
import { CONTRACT_VERSION } from "../../lib/contract";
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
const serverUrlEl = document.getElementById("serverUrl") as HTMLInputElement;
const serverUrlErrorEl = document.getElementById("serverUrlError") as HTMLElement;
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
versionEl.textContent = `v${version} · contract ${CONTRACT_VERSION}`;

// --- scoring daemon ------------------------------------------------------------------
void settings.serverUrl.getValue().then((v) => {
  serverUrlEl.value = v;
});
serverUrlEl.addEventListener("change", () => {
  const raw = serverUrlEl.value.trim();
  const v = raw === "" ? DEFAULT_SERVER_URL : normalizeServerUrl(raw);
  if (v === null) {
    // Loopback only: page text must never leave this computer.
    serverUrlErrorEl.textContent = "Only a local address is allowed (http://127.0.0.1:… or http://localhost:…).";
    serverUrlErrorEl.hidden = false;
    void settings.serverUrl.getValue().then((prev) => {
      serverUrlEl.value = prev;
    });
    return;
  }
  serverUrlErrorEl.hidden = true;
  serverUrlEl.value = v;
  void settings.serverUrl.setValue(v).then(() => refreshBackend(true));
});
serverUrlEl.addEventListener("input", () => {
  serverUrlErrorEl.hidden = true;
});

/** Ask the service worker whether the daemon answers; `probe` forces a fresh /health check. */
async function refreshBackend(probe: boolean): Promise<void> {
  backendStatusEl.textContent = "Checking…";
  try {
    const s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe,
    })) as BackendStatus | undefined;
    if (!s) throw new Error("no status");
    if (s.active === "server" && s.model) {
      backendStatusEl.textContent =
        `Connected — ${s.model.id} (${s.model.ver}) on ${s.server.device ?? "?"} at ${s.serverUrl}.`;
    } else if (s.server.reason === "contract") {
      // Something IS listening; the fix is an update, not a start.
      backendStatusEl.textContent =
        `Found a daemon at ${s.serverUrl}, but it speaks contract ${s.server.contract ?? "?"} and this ` +
        `extension needs ${CONTRACT_VERSION.split(".")[0]}.x — run: ~/.anagram/bin/anagram update.`;
    } else {
      backendStatusEl.textContent =
        `Not running at ${s.serverUrl} — paragraphs show as Unavailable until it answers` +
        (s.server.reason === "loopback" && s.server.error ? ` (${s.server.error}).` : ".");
    }
    // The header summary must not contradict the status line above it.
    const summary =
      s.active === "server" && s.model ? s.model.id : s.server.reason === "contract" ? "daemon version mismatch" : "daemon not running";
    versionEl.textContent = `v${version} · contract ${CONTRACT_VERSION} · ${summary}`;
  } catch {
    backendStatusEl.textContent = "Could not reach the extension’s service worker.";
  }
}
checkBackendEl.addEventListener("click", () => void refreshBackend(true));
void refreshBackend(false);
