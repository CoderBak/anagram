// entrypoints/options/main.ts — reading preferences, site access and engine settings.
// Global toggles bind straight to storage-backed settings (content scripts watch
// them live); the sites row manages siteOverrides (add form + Remove
// buttons). All rendering is DOM construction, never innerHTML with stored
// strings (hostnames are user data).
import { bindDisclosure } from "../../lib/ui/disclosure";
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import "../../lib/ui/rows.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { mountExtensionUpdate } from "../../lib/ui/extensionUpdate";
import { linkSourceCode } from "../../lib/ui/sourceCode";
import { t } from "../../lib/i18n";
import {
  settings,
  cacheModeStorage,
  clearSiteOverride,
  setSiteOverride,
  effectiveRule,
  normalizeRuleHost,
} from "../../lib/settings/settings";
import { hasAccess, requestAccess } from "../../lib/access/grant";
import { commentOriginOfHost } from "../../lib/access/commentFrames";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { CacheCountReply } from "../../lib/messaging/protocol";
import { mountDetectorPicker } from "../../lib/ui/detectorPicker";
import { mountEngineCard } from "../../lib/ui/engineCard";
import { mountSiteAccess } from "../../lib/ui/siteAccess";
import { mountPdfRows } from "../../lib/ui/pdfRows";
import { bindToggle } from "../../lib/ui/boundSetting";
import { mountReadingPreferences } from "../../lib/ui/readingPreferences";
import { createLogger } from "../../lib/log";
import { rank, configOf, normalize, presetConfig, presetOf, retained, RETENTION, type Preset, type RecordingConfig, type Retention } from "../../lib/stats/config";
import { openStatsStore } from "../../lib/stats/store";
import { clearStatistics, readStatsConfig, saveStatsConfig, statsSecret } from "../../lib/stats/settings";
import { presetHint, presetLabel, PRESET_IDS, warningsOf } from "../../lib/stats/ui";
import { keepsLess, stripTo } from "../../lib/stats/strip";
import { formatWords } from "../../lib/stats/format";

const log = createLogger("options");

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const sitesEl = document.getElementById("sites") as HTMLElement;
const versionEl = document.getElementById("version") as HTMLElement;
const addRuleEl = document.getElementById("addRule") as HTMLFormElement;
const addHostEl = document.getElementById("addHost") as HTMLInputElement;
const addModeEl = document.getElementById("addMode") as HTMLSelectElement;
const addErrorEl = document.getElementById("addError") as HTMLElement;
const addNoteEl = document.getElementById("addNote") as HTMLElement;
const clearCacheEl = document.getElementById("clearCache") as HTMLButtonElement;
const cacheCountEl = document.getElementById("cacheCount") as HTMLElement;

bindDisclosure(document.querySelector<HTMLButtonElement>("#siteRulesToggle")!, document.getElementById("siteRules")!);

async function renderSites(): Promise<void> {
  const overrides = await settings.siteOverrides.getValue();
  const hosts = Object.keys(overrides).sort();
  sitesEl.textContent = "";
  document.getElementById("ruleCount")!.textContent = hosts.length ? String(hosts.length) : "";

  if (hosts.length === 0) return;

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
mountExtensionUpdate(document.getElementById("extensionUpdate")!);
followSystemTheme();
linkSourceCode();
bindToggle(enabledEl, settings.enabled);
// The site rows first (they come before the toggle in the list), then the PDF rows.
{
  const holder = document.createElement("div");
  mountSiteAccess(holder);
  document.getElementById("siteRows")!.prepend(...holder.children);
}
mountPdfRows(document.getElementById("pdfRows")!, { readAhead: true });
mountReadingPreferences(document.getElementById("readingPreferences")!);

showSites();
settings.siteOverrides.watch(showSites);
versionEl.textContent = `v${browser.runtime.getManifest().version}`;

// --- a comment thread from another site ----------------------------------------------------
// The panel on a page that shows its comments in a frame of a site nobody granted (Disqus,
// Facebook's comments plugin) opens this page at `#comments=<host>`: a content script cannot
// ask the browser for a site, and this page's click can. Only a known comment provider is
// offered, whatever the address says (lib/access/commentFrames.ts).
const commentsEl = document.getElementById("comments") as HTMLElement;
const commentsStateEl = document.getElementById("commentsState") as HTMLElement;
const commentsAllowEl = document.getElementById("commentsAllow") as HTMLButtonElement;
let commentsOrigin: string | null = null;
async function renderComments(): Promise<void> {
  const host = new URLSearchParams(location.hash.slice(1)).get("comments") ?? "";
  commentsOrigin = commentOriginOfHost(host);
  commentsEl.hidden = commentsOrigin === null;
  if (!commentsOrigin) return;
  const granted = await hasAccess(commentsOrigin);
  commentsStateEl.textContent = t(granted ? "optCommentsAllowed" : "optCommentsFrom", host);
  commentsAllowEl.textContent = t("optCommentsAllow", host);
  commentsAllowEl.hidden = granted;
}
commentsAllowEl.addEventListener("click", () => {
  // The request first, with nothing awaited before it (lib/access/grant.ts). A yes reaches
  // the pages that show the thread from the worker (lib/access/worker.ts).
  if (commentsOrigin) void requestAccess([commentsOrigin]).then(renderComments);
});
browser.permissions.onAdded.addListener(() => void renderComments());
browser.permissions.onRemoved.addListener(() => void renderComments());
window.addEventListener("hashchange", () => void renderComments());
void renderComments().then(() => {
  if (commentsEl.hidden) return;
  commentsEl.scrollIntoView({ block: "center" });
  if (!commentsAllowEl.hidden) commentsAllowEl.focus({ preventScroll: true });
});

const updateDetector = mountDetectorPicker(document.getElementById("detectorPicker")!);
mountEngineCard({
  title: document.getElementById("engineLabel")!,
  onUpdate: (_engine, reply) => { if (reply) updateDetector(reply); },
  panelHost: document.getElementById("componentSettings")!,
  settings: true,
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
  let count: CacheCountReply["entries"] | undefined;
  try {
    const reply = (await browser.runtime.sendMessage({ action: ACTIONS.GET_CACHE_COUNT })) as
      | CacheCountReply
      | undefined;
    count = reply?.entries;
  } catch {
    // Clearing remains available when the worker cannot report a count.
  }
  clearCacheEl.hidden = count === 0;
  cacheCountEl.hidden = !count;
  cacheCountEl.textContent = typeof count === "number"
    ? t(count === 1 ? "optCacheEntries_one" : "optCacheEntries_other", count.toLocaleString())
    : "";
}

// --- statistics ------------------------------------------------------------------------------
// What the reading log keeps (lib/stats/config.ts): a preset, shown in a menu with a line of
// what it keeps, and for how long. Off by default; what someone else using this browser profile
// could read is said plainly. A setting made field by field before shows as its own option. The
// log itself is this extension's own IndexedDB, opened here to size it, coarsen it and clear it.
void (async () => {
  const presetsEl = document.getElementById("statsPresets") as HTMLSelectElement;
  const presetHintEl = document.getElementById("statsPresetHint")!;
  const warnEl = document.getElementById("statsWarnings") as HTMLElement;
  const keepEl = document.getElementById("statsKeep") as HTMLDetailsElement;
  const fineEl = document.getElementById("statsFine") as HTMLSelectElement;
  const detailEl = document.getElementById("statsDetailDays") as HTMLSelectElement;
  const totalsEl = document.getElementById("statsTotals") as HTMLSelectElement;
  const sizeEl = document.getElementById("statsSize") as HTMLElement;
  const actionsEl = document.getElementById("statsActions") as HTMLElement;
  /** Records the log holds: its buttons stay while there is something to open, export or clear. */
  let kept = 0;
  const statusEl = document.getElementById("statsStatus") as HTMLElement;
  const store = openStatsStore();
  let config: RecordingConfig = await readStatsConfig();

  for (const p of ["off", ...PRESET_IDS] as const) presetsEl.add(new Option(presetLabel(p), p));
  presetsEl.disabled = false;
  presetsEl.addEventListener("change", () => {
    const p = presetsEl.value;
    if (p === "custom") return;
    statusEl.textContent = "";
    void choose(p === "off" ? { ...config, on: false } : presetConfig(p as Preset, config.retention))
      .catch(() => { statusEl.textContent = t("optSaveFailed"); paint(); actionsEl.hidden = false; });
  });
  for (const days of RETENTION.fine) fineEl.add(new Option(t("optStatsDays", days), String(days)));
  for (const days of RETENTION.detail) detailEl.add(new Option(t("optStatsDays", days), String(days)));
  for (const days of RETENTION.totals) totalsEl.add(new Option(days ? t("optStatsDays", days) : t("optStatsUntilCleared"), String(days)));

  const openStats = document.getElementById("openStats")!;
  function updateActions(): void {
    openStats.hidden = !config.on && kept === 0;
    presetHintEl.hidden = !config.on && kept === 0;
    actionsEl.hidden = kept === 0 && !statusEl.textContent;
    document.getElementById("exportStats")!.hidden = kept === 0;
    document.getElementById("clearStats")!.hidden = kept === 0;
  }
  function paint(): void {
    const preset = config.on ? presetOf(config) ?? "custom" : "off";
    const custom = presetsEl.querySelector('option[value="custom"]');
    if (preset === "custom" && !custom) presetsEl.add(new Option(presetLabel("custom"), "custom"));
    else if (preset !== "custom") custom?.remove();
    presetsEl.value = preset;
    presetHintEl.textContent = presetHint(preset);
    keepEl.hidden = !config.on;
    if (!config.on) keepEl.open = false;
    // Only the lengths of what this choice keeps.
    const has = retained(config.layers);
    fineEl.closest<HTMLElement>(".field")!.hidden = !has.fine;
    detailEl.closest<HTMLElement>(".field")!.hidden = !has.detail;
    updateActions();
    warnEl.replaceChildren(...warningsOf(config).map((key) => Object.assign(document.createElement("p"), { textContent: t(key) })));
    fineEl.value = String(config.retention.fine);
    detailEl.value = String(config.retention.detail);
    totalsEl.value = String(config.retention.totals);
  }

  async function paintSize(): Promise<void> {
    const { rows } = await store.size().catch(() => ({ rows: {} as Record<string, number> }));
    const count = Object.values(rows).reduce((a, b) => a + b, 0);
    sizeEl.textContent = t("optStatsSizeValue", formatWords(count));
    kept = count;
    updateActions();
  }

  /** Keep `next` from now on; where it keeps less than before, offer to delete what it would
   *  not have kept. Keeping it is the default: a setting lowered for a while and raised again
   *  loses nothing it was not told to. */
  async function choose(next: RecordingConfig): Promise<void> {
    const before = config;
    const { config: normal } = normalize(next);
    config = await saveStatsConfig(next.on ? normal : { ...next, on: false });
    paint();
    if (keepsLess(before, config)) {
      const kept = await store.size().catch(() => null);
      if (!kept) return;
      const details = ["visits", "units", "events", "texts", "tabs"].some((name) => (kept.rows[name] ?? 0) > 0);
      const totals = !details && kept.rows.totals ? (await store.read("", "\uffff", { visits: false })).totals : [];
      const context = kept.rows.context && (rank("device", config.layers.device) > rank("device", before.layers.device)
        || rank("engine", config.layers.engine) > rank("engine", before.layers.engine));
      if (details || context || totals.some((row) => row.scope === "site" || row.scope === "page")) offerToStrip(config);
    }
  }

  const dropDialog = document.getElementById("dropStatsDialog") as HTMLDialogElement;
  let stripTo_: RecordingConfig | null = null;
  function offerToStrip(next: RecordingConfig): void {
    stripTo_ = next;
    if (!dropDialog.open) dropDialog.showModal();
    document.getElementById("dropStatsKeep")!.focus();
  }
  document.getElementById("dropStatsKeep")!.addEventListener("click", () => dropDialog.close());
  document.getElementById("dropStatsConfirm")!.addEventListener("click", () => {
    statusEl.textContent = "";
    const next = stripTo_;
    if (!next) { dropDialog.close(); return; }
    void statsSecret().then((secret) => stripTo(store, next, secret)).then(
      () => { statusEl.textContent = t("statsDropped"); void paintSize(); },
      () => { statusEl.textContent = t("optSaveFailed"); },
    ).finally(() => dropDialog.close());
  });

  const retention = (): Retention => ({
    fine: Number(fineEl.value) as Retention["fine"], detail: Number(detailEl.value) as Retention["detail"], totals: Number(totalsEl.value) as Retention["totals"],
  });
  for (const el of [fineEl, detailEl, totalsEl]) el.addEventListener("change", () => void choose({ ...config, retention: retention() }));
  settings.statsConfig.watch((value) => { config = configOf(value); paint(); });
  paint();
  void paintSize();

  const statsPage = (hash = ""): void => void browser.tabs.create({ url: browser.runtime.getURL("/stats.html") + hash });
  document.getElementById("openStats")!.addEventListener("click", () => statsPage());
  document.getElementById("exportStats")!.addEventListener("click", () => statsPage("#export"));
  const dialog = document.getElementById("clearStatsDialog") as HTMLDialogElement;
  document.getElementById("clearStats")!.addEventListener("click", () => {
    statusEl.textContent = "";
    dialog.showModal();
    document.getElementById("clearStatsCancel")!.focus();
  });
  document.getElementById("clearStatsCancel")!.addEventListener("click", () => dialog.close());
  document.getElementById("clearStatsConfirm")!.addEventListener("click", () => {
    // What is recorded from now on cannot be matched with what was cleared.
    void clearStatistics(store).then(
      () => { statusEl.textContent = t("statsCleared"); void paintSize(); },
      () => { statusEl.textContent = t("optSaveFailed"); },
    ).finally(() => dialog.close());
  });
  // Opened from the statistics page's link: the group in view.
  if (location.hash === "#statistics") {
    const group = document.getElementById("statistics")!;
    group.scrollIntoView({ block: "start" });
    group.focus({ preventScroll: true });
  }
})();

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
// Returning from a reading tab can make a previously empty cache clearable.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshCacheCount();
});
document.getElementById("cache")!.addEventListener("pointerenter", () => void refreshCacheCount());
void refreshCacheCount();
