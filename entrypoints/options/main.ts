// entrypoints/options/main.ts — the settings surface.
// Global toggles bind straight to storage-backed settings (content scripts watch
// them live); the per-site section manages siteOverrides (add form + Remove
// buttons). All rendering is DOM construction — never innerHTML with stored
// strings (hostnames are user data).
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { READER_PAGE } from "../../lib/pdf/source";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { t, tn } from "../../lib/i18n";
import {
  settings,
  clearSiteOverride,
  setSiteOverride,
  effectiveRule,
  normalizeMarkStyle,
  normalizeRuleHost,
  normalizeServerUrl,
  DEFAULT_SERVER_URL,
} from "../../lib/settings/settings";
import { ALL_SITES } from "../../lib/access/patterns";
import { accessSummary, requestAccess, withdrawAccess } from "../../lib/access/grant";
import { ACTIONS } from "../../lib/messaging/protocol";
import { PDF_TAB_SCRIPTS_RUN } from "../../lib/surface";
import { CONTRACT_VERSION } from "../../lib/contract";
import type { BackendStatus, CacheCountReply } from "../../lib/messaging/protocol";
import { mountRuntimeSettings, runtimeStateLabel } from "../../lib/ui/runtimeSettings";
import { runtimeReady, type RuntimeSnapshot } from "../../lib/backend/runtimeClient";
import { mountComponentSettings, componentConnectionLabel } from "../../lib/ui/componentSettings";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const markStyleEl = document.getElementById("markStyle") as HTMLSelectElement;
const displayModeEl = document.getElementById("displayMode") as HTMLSelectElement;
const analysisScopeEl = document.getElementById("analysisScope") as HTMLSelectElement;
const mergeShortsEl = document.getElementById("mergeShorts") as HTMLInputElement;
const autoOpenPdfsEl = document.getElementById("autoOpenPdfs") as HTMLInputElement;
const autoOpenPdfsFieldEl = document.getElementById("autoOpenPdfsField") as HTMLElement;
const debugEl = document.getElementById("debug") as HTMLInputElement;
const sitesEl = document.getElementById("sites") as HTMLElement;
const versionEl = document.getElementById("version") as HTMLElement;
const addRuleEl = document.getElementById("addRule") as HTMLFormElement;
const addHostEl = document.getElementById("addHost") as HTMLInputElement;
const addModeEl = document.getElementById("addMode") as HTMLSelectElement;
const addErrorEl = document.getElementById("addError") as HTMLElement;
const addNoteEl = document.getElementById("addNote") as HTMLElement;
const serverUrlEl = document.getElementById("serverUrl") as HTMLInputElement;
const serverUrlErrorEl = document.getElementById("serverUrlError") as HTMLElement;
const backendStatusEl = document.getElementById("backendStatus") as HTMLElement;
const checkBackendEl = document.getElementById("checkBackend") as HTMLButtonElement;
const clearCacheEl = document.getElementById("clearCache") as HTMLButtonElement;
const accessStateEl = document.getElementById("accessState") as HTMLElement;
const accessAllEl = document.getElementById("accessAll") as HTMLButtonElement;
const accessWithdrawEl = document.getElementById("accessWithdraw") as HTMLButtonElement;
const cacheCountEl = document.getElementById("cacheCount") as HTMLElement;
let runtimeSnapshot: RuntimeSnapshot | undefined;
let transport: "native" | "http" = "native";
let componentPanel: ReturnType<typeof mountComponentSettings> | undefined;
let httpRuntimePanel: ReturnType<typeof mountRuntimeSettings> | undefined;
const transportEl = document.getElementById("backendTransport") as HTMLSelectElement;

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
    empty.textContent = t("optNoRules");
    sitesEl.appendChild(empty);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "table-container";
  const table = document.createElement("table");
  table.className = "table";
  const head = table.createTHead().insertRow();
  for (const key of ["optColSite", "optColRule", "optColActions"] as const) {
    const th = document.createElement("th");
    // The last column holds only Remove buttons, so printing "Actions" over them would be
    // noise — but a header cell with nothing in it is a column with no name at all to a
    // screen reader, which is how the table used to read.
    if (key === "optColActions") {
      const label = document.createElement("span");
      label.className = "vh";
      label.textContent = t(key);
      th.appendChild(label);
    } else {
      th.textContent = t(key);
    }
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const host of hosts) {
    const mode = overrides[host];
    const row = body.insertRow();
    row.insertCell().textContent = host;
    const modeCell = row.insertCell();
    modeCell.textContent = mode === "on" ? t("optAlwaysOn") : t("optAlwaysOff");
    modeCell.className = `mode-${mode}`;
    const actions = row.insertCell();
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn";
    remove.dataset.variant = "ghost";
    remove.dataset.size = "xs";
    remove.textContent = t("optRemove");
    remove.addEventListener("click", () => {
      void clearSiteOverride(host).then(renderSites);
    });
    actions.appendChild(remove);
  }
  wrap.appendChild(table);
  sitesEl.appendChild(wrap);
}

/**
 * Normalize pasted site input to the hostname a rule is keyed on: trim, lowercase,
 * strip any protocol/credentials/port/path and the leading "www."
 * ("https://www.Example.com/path" → "example.com"). Returns null when nothing usable
 * remains.
 */
function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    const host = normalizeRuleHost(new URL(candidate).hostname);
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

addRuleEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const host = normalizeHost(addHostEl.value);
  if (host === null) {
    addErrorEl.textContent = t("optBadHost");
    addErrorEl.hidden = false;
    return;
  }
  addErrorEl.hidden = true;
  addNoteEl.hidden = true;
  const mode: "on" | "off" = addModeEl.value === "off" ? "off" : "on";
  // A rule already covering this host from a parent domain is why the new row can
  // leave the page behaving exactly as it did — say which one, or the user is left
  // wondering whether the rule took.
  void effectiveRule(host).then((covering) => {
    if (covering && covering.host !== host && covering.mode === mode) {
      addNoteEl.textContent = t("optAlreadyCovered", covering.host);
      addNoteEl.hidden = false;
    }
    // The siteOverrides watch below re-renders the table once the write lands.
    return setSiteOverride(host, mode);
  }).then(() => {
    addHostEl.value = "";
    addHostEl.focus();
  });
});
addHostEl.addEventListener("input", () => {
  addErrorEl.hidden = true;
  addNoteEl.hidden = true;
});

localizePage();
followSystemTheme();
bindToggle(enabledEl, settings.enabled);
bindToggle(highlightsEl, settings.showHighlights);
bindToggle(debugEl, settings.debug);
bindToggle(mergeShortsEl, settings.mergeShorts);
// "Open PDFs in Anagram" needs a content script inside the PDF tab to notice the PDF and
// ask the worker to move the tab. Chrome wraps its viewer in an ordinary HTML document
// where our script runs; Firefox's is a privileged page where no content script runs at
// all, and there is no other way in that this extension's permissions can pay for (see
// the note in lib/pdf/route.ts). A switch that could not do anything is worse than no
// switch, so on Firefox there is none — the ball, the popup and the menu still open a PDF.
if (PDF_TAB_SCRIPTS_RUN) bindToggle(autoOpenPdfsEl, settings.autoOpenPdfs);
else autoOpenPdfsFieldEl.remove();
// A PDF on this computer has no tab that could hand its bytes over (the extension asks for
// no access to the file scheme, and a file: page may not re-read itself), and Firefox has
// no such tab for any PDF — so the reading mode's own drop zone is the way in, and this is
// the door to it.
(document.getElementById("openReader") as HTMLButtonElement).addEventListener("click", () => {
  void browser.tabs.create({ url: browser.runtime.getURL(READER_PAGE as PublicPath) });
});
bindSelect(displayModeEl, settings.displayMode);
// An old profile holds one of the three styles the quiet marks replaced; the control has
// to show what that value means now rather than land on no option at all.
bindSelect(markStyleEl, {
  getValue: async () => normalizeMarkStyle(await settings.markStyle.getValue()),
  setValue: (v) => settings.markStyle.setValue(v),
});
bindSelect(analysisScopeEl, settings.analysisScope);
void renderSites();
settings.siteOverrides.watch(() => void renderSites());
const version = browser.runtime.getManifest().version;
versionEl.textContent = `v${version}`;

// --- site access -----------------------------------------------------------------------
// Anagram installs able to read no site at all; this row says how much has been granted
// since and is the one place to take it back. Withdrawing leaves the per-site rules below
// alone — they are settings, not access, and they are what a later grant comes back to.
async function renderAccess(): Promise<void> {
  const { all, sites } = await accessSummary();
  accessStateEl.textContent = all
    ? t("accessAll")
    : sites.length > 0
      ? tn("accessSites", sites.length)
      : t("accessNone");
  accessAllEl.hidden = all;
  accessWithdrawEl.hidden = !all && sites.length === 0;
}
// The request has to be the first thing the click does: the browsers honour it only as
// part of the user's gesture. Taking access back needs no gesture.
accessAllEl.addEventListener("click", () => {
  void requestAccess(ALL_SITES).then(renderAccess);
});
accessWithdrawEl.addEventListener("click", () => {
  void withdrawAccess().then(renderAccess);
});
browser.permissions.onAdded.addListener(() => void renderAccess());
browser.permissions.onRemoved.addListener(() => void renderAccess());
void renderAccess();

// --- scoring daemon ------------------------------------------------------------------
void settings.serverUrl.getValue().then((v) => {
  serverUrlEl.value = v;
  // A URL an older build stored and this one no longer accepts: the worker is talking to
  // the default meanwhile, and the field says so the same way a freshly typed bad one does.
  if (normalizeServerUrl(v) === null) {
    serverUrlErrorEl.textContent = t("optBadUrl");
    serverUrlErrorEl.hidden = false;
  }
});
serverUrlEl.addEventListener("change", () => {
  const raw = serverUrlEl.value.trim();
  const v = raw === "" ? DEFAULT_SERVER_URL : normalizeServerUrl(raw);
  if (v === null) {
    // Loopback only: page text must never leave this computer.
    serverUrlErrorEl.textContent = t("optBadUrl");
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
  if (transport !== "http") return;
  backendStatusEl.textContent = t("optChecking");
  try {
    const s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe,
    })) as BackendStatus | undefined;
    if (!s) throw new Error("no status");
    if (runtimeSnapshot && (!runtimeReady(runtimeSnapshot) || s.active !== "server" || !s.model)) {
      backendStatusEl.textContent = runtimeStateLabel(runtimeSnapshot);
    } else if (s.active === "server" && s.model && !s.server.outdated) {
      backendStatusEl.textContent =
        t("optConnected", s.model.id, s.model.ver, `${s.server.device ?? "?"}${s.server.dtype ? ` · ${s.server.dtype}` : ""}`, s.serverUrl);
    } else if (s.server.reason === "contract") {
      // Something IS listening; the fix is an update, not a start.
      backendStatusEl.textContent =
        t("optContractMismatch", s.serverUrl, s.server.contract ?? "?", CONTRACT_VERSION.split(".")[0]);
    } else if (s.server.outdated) {
      // The same fix for two cases the reader need not tell apart: a daemon older than
      // this extension, whether it can still answer it or not at all.
      backendStatusEl.textContent = t("optOutdated", s.serverUrl);
    } else {
      backendStatusEl.textContent =
        s.server.reason === "loopback" && s.server.error
          ? t("optNotRunningReason", s.serverUrl, s.server.error)
          : t("optNotRunning", s.serverUrl);
    }
    // The header summary must not contradict the status line above it.
    const summary =
      runtimeSnapshot && (!runtimeReady(runtimeSnapshot) || s.active !== "server" || !s.model) ? runtimeStateLabel(runtimeSnapshot) : s.active === "server" && s.model && !s.server.outdated
        ? s.model.id
        : s.server.reason === "contract" || s.server.outdated
          ? t("optSummaryMismatch")
          : t("optSummaryDown");
    versionEl.textContent = `v${version} · contract ${CONTRACT_VERSION} · ${summary}`;
  } catch {
    backendStatusEl.textContent = runtimeSnapshot ? runtimeStateLabel(runtimeSnapshot) : t("optNoWorker");
  }
}
checkBackendEl.addEventListener("click", () => void refreshBackend(true));
let transportGeneration = 0;
async function renderTransport(): Promise<void> {
  const generation = ++transportGeneration;
  const next = await settings.backendTransport.getValue();
  if (generation !== transportGeneration) return;
  transport = next;
  transportEl.value = next;
  componentPanel?.destroy(); componentPanel = undefined;
  httpRuntimePanel?.destroy(); httpRuntimePanel = undefined;
  const componentHost = document.getElementById("componentSettings")!;
  const httpHost = document.getElementById("legacyRuntimeSettings") ?? document.getElementById("runtimeSettings")!;
  componentHost.replaceChildren(); httpHost.replaceChildren();
  componentHost.hidden = next !== "native";
  document.getElementById("developerHttp")!.hidden = next !== "http";
  httpHost.id = next === "http" ? "runtimeSettings" : "legacyRuntimeSettings";
  runtimeSnapshot = undefined;
  if (next === "native") {
    componentPanel = mountComponentSettings(componentHost, (reply) => {
      versionEl.textContent = `v${version} · ${componentConnectionLabel(reply)}`;
    });
  } else {
    (document.getElementById("developerBackend") as HTMLDetailsElement).open = true;
    httpRuntimePanel = mountRuntimeSettings(httpHost, (reply) => {
      runtimeSnapshot = reply.kind === "ok" ? reply.snapshot : undefined;
      void refreshBackend(true);
    });
    void refreshBackend(true);
  }
}
transportEl.addEventListener("change", () => { void settings.backendTransport.setValue(transportEl.value === "http" ? "http" : "native"); });
settings.backendTransport.watch(() => void renderTransport());
void renderTransport();

// --- cached verdicts -------------------------------------------------------------------
// The worker owns the caches (its memory and the IndexedDB store) and passes the word on to
// every open tab; the button only says that it happened, the way the copy buttons do.
const CLEAR_LABEL = clearCacheEl.textContent ?? t("optClearCache");

/** How many verdicts are on the disk. A number and its unit, nothing else: it is there to
 *  be glanced at before clearing, and the row's own text says what they are. */
async function refreshCacheCount(): Promise<void> {
  try {
    const reply = (await browser.runtime.sendMessage({ action: ACTIONS.GET_CACHE_COUNT })) as
      | CacheCountReply
      | undefined;
    const n = reply?.entries ?? 0;
    // The number is grouped for the reader's locale before it goes in ("1,284"), so the
    // plural is chosen here: tn() would substitute the bare count as $1.
    cacheCountEl.textContent = t(n === 1 ? "optCacheEntries_one" : "optCacheEntries_other", n.toLocaleString());
  } catch {
    cacheCountEl.textContent = ""; // no worker to ask — the row still works
  }
}

clearCacheEl.addEventListener("click", () => {
  clearCacheEl.disabled = true;
  void browser.runtime
    .sendMessage({ action: ACTIONS.CLEAR_CACHE })
    .catch(() => undefined)
    .then(() => {
      clearCacheEl.disabled = false;
      clearCacheEl.textContent = t("optCleared");
      setTimeout(() => {
        clearCacheEl.textContent = CLEAR_LABEL;
      }, 1500);
      return refreshCacheCount();
    });
});
void refreshCacheCount();
