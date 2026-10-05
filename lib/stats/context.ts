// lib/stats/context.ts — what the log is recorded under: the configuration, and the device, the
// engine and the settings that shape what it holds. A row is added when the worker starts and
// when any of it changes, and only when it did change (DEVICE decides how much of the device).
import { browser } from "#imports";
import type { ModelInfo } from "../contract";
import { settings, cacheModeStorage } from "../settings/settings";
import { ALL_SITES } from "../access/patterns";
import type { ContextRow, EngineInfo } from "./model";
import { localDate } from "./model";
import { readStatsConfig } from "./settings";
import type { LogStore } from "./store";

const LAST = "context";

interface NavigatorUA { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; getHighEntropyValues?(hints: string[]): Promise<Record<string, string>> } }

async function device(exact: boolean): Promise<Pick<ContextRow, "browser" | "os" | "hardware">> {
  const nav = navigator as Navigator & NavigatorUA & { deviceMemory?: number };
  const ua = nav.userAgent;
  const brand = nav.userAgentData?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) ?? nav.userAgentData?.brands?.find((b) => /chromium/i.test(b.brand));
  const browserName = brand?.brand ?? (/firefox/i.test(ua) ? "Firefox" : /safari/i.test(ua) && !/chrome/i.test(ua) ? "Safari" : "Chrome");
  const os = nav.userAgentData?.platform || (/mac os/i.test(ua) ? "macOS" : /windows/i.test(ua) ? "Windows" : /linux/i.test(ua) ? "Linux" : "other");
  if (!exact) return { browser: browserName, os };
  let platformVersion = "", architecture = "";
  try {
    const high = await nav.userAgentData?.getHighEntropyValues?.(["platformVersion", "architecture"]);
    platformVersion = high?.platformVersion ?? ""; architecture = high?.architecture ?? "";
  } catch { /* not told */ }
  const version = brand?.version ?? /(?:Firefox|Version|Chrome)\/([\d.]+)/.exec(ua)?.[1] ?? "";
  return {
    browser: `${browserName} ${version}`.trim(),
    os: `${os} ${platformVersion} ${architecture}`.trim(),
    hardware: { cores: nav.hardwareConcurrency, memory: nav.deviceMemory },
  };
}

export async function noteStatsContext(deps: { store: LogStore; model(): ModelInfo | null; engine(): Promise<EngineInfo | null> }): Promise<void> {
  const config = await readStatsConfig();
  if (!config.on) return;
  const L = config.layers;
  const [flagFrom, displayMode, underlineScope, showHighlights, cache, pdfReadAhead, autoOpenPdfs, overrides, all, granted, engine] = await Promise.all([
    settings.flagFrom.getValue(), settings.displayMode.getValue(), settings.underlineScope.getValue(), settings.showHighlights.getValue(),
    cacheModeStorage.getValue(), settings.pdfReadAhead.getValue(), settings.autoOpenPdfs.getValue(), settings.siteOverrides.getValue(),
    browser.permissions.contains({ origins: [...ALL_SITES] }).catch(() => false),
    browser.permissions.getAll().then((p) => p.origins?.length ?? 0).catch(() => 0),
    deps.engine().catch(() => null),
  ]);
  const at = Date.now();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const row: ContextRow = {
    at, date: localDate(new Date(at)),
    extension: browser.runtime.getManifest().version,
    ...(L.device !== "none" ? await device(L.device === "exact") : {}),
    locale: { ui: browser.i18n.getUILanguage(), zone, offset: -new Date(at).getTimezoneOffset() },
    model: deps.model() ?? undefined,
    engine: engine ? (L.engine === "full" ? engine : L.engine === "basic" ? { kind: engine.kind } : undefined) : undefined,
    settings: {
      flagFrom: String(flagFrom), chips: String(displayMode), underlines: showHighlights ? String(underlineScope) : "off", cache: String(cache),
      pdfReadAhead: !!pdfReadAhead, autoOpenPdfs: !!autoOpenPdfs, access: all ? "all" : "sites", granted,
      off: Object.values(overrides ?? {}).filter((v) => v === "off").length,
    },
    recording: { layers: { ...L }, hashed: [...config.hashed], retention: { ...config.retention } },
  };
  // A row only when something changed.
  const { at: _a, date: _d, ...what } = row;
  const key = JSON.stringify(what);
  if ((await deps.store.getMeta(LAST)) === key) return;
  await deps.store.context(row);
  await deps.store.setMeta(LAST, key);
}
