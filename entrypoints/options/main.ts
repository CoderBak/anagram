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
import { linkSourceCode } from "../../lib/ui/sourceCode";
import { t, tn } from "../../lib/i18n";
import {
  settings,
  cacheModeStorage,
  clearSiteOverride,
  setSiteOverride,
  effectiveRule,
  normalizeRuleHost,
} from "../../lib/settings/settings";
import { ALL_SITES } from "../../lib/access/patterns";
import { accessSummary, requestAccess, withdrawAccess } from "../../lib/access/grant";
import { ACTIONS } from "../../lib/messaging/protocol";
import { getFileAccess, openFileAccessSettings, requestFileAccess } from "../../lib/pdf/fileAccess";
import type { CacheCountReply } from "../../lib/messaging/protocol";
import { mountComponentSettings, componentConnectionLabel } from "../../lib/ui/componentSettings";
import { bindConfirmedToggle } from "../../lib/ui/confirmedToggle";
import { bindSelect, bindToggle } from "../../lib/ui/boundSetting";
import { createLogger } from "../../lib/log";

const log = createLogger("options");

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const underlineEl = document.getElementById("underline") as HTMLSelectElement;
const displayModeEl = document.getElementById("displayMode") as HTMLSelectElement;
const analysisScopeEl = document.getElementById("analysisScope") as HTMLSelectElement;
const mergeShortsEl = document.getElementById("mergeShorts") as HTMLInputElement;
const autoOpenPdfsEl = document.getElementById("autoOpenPdfs") as HTMLInputElement;
const debugEl = document.getElementById("debug") as HTMLInputElement;
const sitesEl = document.getElementById("sites") as HTMLElement;
const versionEl = document.getElementById("version") as HTMLElement;
const addRuleEl = document.getElementById("addRule") as HTMLFormElement;
const addHostEl = document.getElementById("addHost") as HTMLInputElement;
const addModeEl = document.getElementById("addMode") as HTMLSelectElement;
const addErrorEl = document.getElementById("addError") as HTMLElement;
const addNoteEl = document.getElementById("addNote") as HTMLElement;
const clearCacheEl = document.getElementById("clearCache") as HTMLButtonElement;
const accessStateEl = document.getElementById("accessState") as HTMLElement;
const accessAllEl = document.getElementById("accessAll") as HTMLButtonElement;
const accessWithdrawEl = document.getElementById("accessWithdraw") as HTMLButtonElement;
const cacheCountEl = document.getElementById("cacheCount") as HTMLElement;

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
  for (const key of ["optColSite", "optColRule", "optRemove"] as const) {
    const th = document.createElement("th");
    // The last column holds only Remove buttons, so printing a header over them would be
    // noise — but a header cell with nothing in it is a column with no name at all to a
    // screen reader.
    if (key === "optRemove") {
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
      // A removal that did not land leaves the row where it is, which is still the truth.
      void clearSiteOverride(host).then(showSites, (error) => log.error("could not remove a site rule", error));
    });
    actions.appendChild(remove);
  }
  wrap.appendChild(table);
  sitesEl.appendChild(wrap);
}

function showSites(): void {
  void renderSites().catch((error) => log.error("could not read the site rules", error));
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
  }, (error) => {
    // Nothing was stored: keep what was typed, and say so where a bad host is reported.
    log.error("could not save a site rule", error);
    addNoteEl.hidden = true;
    addErrorEl.textContent = t("optSaveFailed");
    addErrorEl.hidden = false;
  });
});
addHostEl.addEventListener("input", () => {
  addErrorEl.hidden = true;
  addNoteEl.hidden = true;
});

localizePage();
followSystemTheme();
linkSourceCode();
bindToggle(enabledEl, settings.enabled);
bindToggle(debugEl, settings.debug);
bindToggle(mergeShortsEl, settings.mergeShorts);
for (const key of ["reportIncludeText", "reportIncludeUrl"] as const) {
  const input = document.getElementById(key) as HTMLInputElement;
  const failure = document.createElement("p");
  failure.id = `${key}Error`;
  failure.setAttribute("role", "alert");
  failure.hidden = true;
  input.setAttribute("aria-describedby", failure.id);
  input.parentElement!.after(failure);
  bindConfirmedToggle(input, settings[key], (failed) => {
    failure.textContent = failed ? t("optSaveFailed") : "";
    failure.hidden = !failed;
  });
}
const pdfSettingsError = document.getElementById("pdfSettingsError") as HTMLElement;
const fileAccessState = document.getElementById("fileAccessState") as HTMLElement;
const fileAccessEnable = document.getElementById("fileAccessEnable") as HTMLButtonElement;
const fileAccessManage = document.getElementById("fileAccessManage") as HTMLButtonElement;
const fileAccessInstructions = document.getElementById("fileAccessInstructions") as HTMLElement;
async function showFileSettings(): Promise<void> {
  if (!await openFileAccessSettings()) {
    fileAccessInstructions.textContent = t("optFileAccessFirefoxInstructions");
    fileAccessInstructions.hidden = false;
    fileAccessInstructions.focus();
  }
}
function pdfError(failed: boolean): void {
  pdfSettingsError.textContent = failed ? t("optSaveFailed") : "";
  pdfSettingsError.hidden = !failed;
}
bindConfirmedToggle(autoOpenPdfsEl, settings.autoOpenPdfs, pdfError);
let fileRefresh = 0;
async function refreshFileAccess(): Promise<void> {
  const generation = ++fileRefresh;
  const { granted, allowed } = await getFileAccess();
  if (generation !== fileRefresh) return;
  fileAccessState.textContent = t(granted && allowed ? "optFileAccessReady" : granted ? "optFileAccessBrowserRequired" : "optFileAccessNotGranted");
  fileAccessEnable.hidden = granted && allowed;
  fileAccessEnable.textContent = t(granted ? "optFileAccessManage" : "optFileAccessEnable");
}
fileAccessEnable.addEventListener("click", () => {
  // Permission requests must retain the user's activation.
  const granted = requestFileAccess();
  fileAccessEnable.disabled = true;
  void granted.then(async (accepted) => {
    if (!accepted) { pdfError(true); return; }
    pdfError(false);
    const access = await getFileAccess();
    if (!access.allowed) await showFileSettings();
  }).catch(() => pdfError(true)).finally(() => {
    fileAccessEnable.disabled = false;
    void refreshFileAccess();
  });
});
fileAccessManage.addEventListener("click", () => {
  void showFileSettings().catch(() => pdfError(true));
});
window.addEventListener("focus", () => void refreshFileAccess());
browser.permissions.onAdded.addListener(() => void refreshFileAccess());
browser.permissions.onRemoved.addListener(() => void refreshFileAccess());
void refreshFileAccess();
(document.getElementById("openReader") as HTMLButtonElement).addEventListener("click", () => {
  void browser.tabs.create({ url: browser.runtime.getURL(READER_PAGE as PublicPath) });
});
bindSelect(displayModeEl, settings.displayMode);
bindSelect<"all" | "off">(underlineEl, {
  getValue: async () => (await settings.showHighlights.getValue()) ? "all" : "off",
  setValue: (v) => settings.showHighlights.setValue(v === "all"),
});
bindSelect(analysisScopeEl, settings.analysisScope);
showSites();
settings.siteOverrides.watch(showSites);
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

mountComponentSettings(document.getElementById("componentSettings")!, (reply) => {
  versionEl.textContent = `v${version} · ${componentConnectionLabel(reply)}`;
});

const CLEAR_LABEL = clearCacheEl.textContent ?? t("optClearCache");
const cacheStatus = document.getElementById("cacheStatus")!;
const cacheMode = document.getElementById("cacheMode") as HTMLSelectElement;
void cacheModeStorage.getValue().then((mode) => { cacheMode.value = mode; }, () => {
  cacheStatus.textContent = t("optSaveFailed");
});
cacheModeStorage.watch((mode) => { cacheMode.value = mode; });
cacheMode.addEventListener("change", () => {
  const mode = cacheMode.value;
  let confirmedMode: "persistent" | "session" | undefined;
  cacheMode.disabled = true;
  void browser.runtime.sendMessage({ action: ACTIONS.SET_CACHE_MODE, mode }).then((reply) => {
    if (reply?.mode === "persistent" || reply?.mode === "session") confirmedMode = reply.mode;
    cacheStatus.textContent = reply?.ok === true ? "" : t("optSaveFailed");
  }, () => { cacheStatus.textContent = t("optSaveFailed"); }).finally(() => {
    cacheMode.disabled = false;
    if (confirmedMode) cacheMode.value = confirmedMode;
    else void cacheModeStorage.getValue().then((mode) => { cacheMode.value = mode; }, () => {
      cacheStatus.textContent = t("optSaveFailed");
    });
    void refreshCacheCount();
  });
});

/** How many verdicts are on the disk. A number and its unit, nothing else: it is there to
 *  be glanced at before clearing, and the row's own text says what they are. */
async function refreshCacheCount(): Promise<void> {
  try {
    const reply = (await browser.runtime.sendMessage({ action: ACTIONS.GET_CACHE_COUNT })) as
      | CacheCountReply
      | undefined;
    const n = reply?.entries;
    if (typeof n !== "number") { cacheCountEl.textContent = ""; return; }
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
    .then((reply) => {
      if (reply?.ok !== true) throw new Error("clear_failed");
      cacheStatus.textContent = t("optCleared");
      return refreshCacheCount();
    }).catch(() => { cacheStatus.textContent = t("optSaveFailed"); })
    .finally(() => { clearCacheEl.disabled = false; clearCacheEl.textContent = CLEAR_LABEL; });
});
void refreshCacheCount();
