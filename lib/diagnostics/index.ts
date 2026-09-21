// lib/diagnostics/index.ts — the content script's half of "Copy page diagnostics".
//
// Everything that needs an extension API happens here — the manifest, the settings, the
// site rule, the daemon's state, the language detector — and everything that needs the
// PAGE happens in the chunk this loads on demand (./report.ts, built into
// public/vendor/diagnostics.min.mjs). The split is what keeps the content script's boot
// cost where it was: a page that never asks for a report carries about a kilobyte for the
// entry rather than twenty.
import { browser } from "#imports";
import { detectUnsupported } from "../capture/langGate";
import { messageLocale } from "../i18n";
import { loadDiagnostics } from "../lazy";
import { ACTIONS } from "../messaging/protocol";
import type { BackendStatus } from "../messaging/protocol";
import { effectiveRule, settings } from "../settings/settings";
import type { DaemonFacts, DiagnosticsEnv } from "./report";

/** What the content script knows about this page and the chunk cannot ask for. */
export type DiagnosticsFacts = Pick<
  DiagnosticsEnv,
  "running" | "onceForPage" | "pdf" | "docs" | "counts" | "frameGate" | "clickedFrameId" | "target"
> & {
  /** The hostname the site rules are keyed on (a subframe's is its top page's). */
  host: string;
};

export interface CopyResult {
  ok: boolean;
  /** Size of what was copied, so the worker's badge flash only claims what happened. */
  bytes: number;
  /** Which route took it — worth knowing, because the two fail on different platforms. */
  via: "clipboard" | "execCommand" | "none";
}

/** Is the daemon up, and if not, why not — the shape the report prints from. */
async function daemonFacts(): Promise<DaemonFacts> {
  let status: BackendStatus | undefined;
  try {
    status = (await browser.runtime.sendMessage({ action: ACTIONS.GET_BACKEND_STATUS })) as
      | BackendStatus
      | undefined;
  } catch {
    /* the worker is gone, or the extension context was invalidated */
  }
  if (!status) return { state: "unknown" };
  if (status.active === "server") {
    return {
      state: "up",
      model: status.model ? `${status.model.id} ${status.model.ver} (calibration ${status.model.calibration})` : undefined,
      device: status.server.device,
    };
  }
  const reason = status.server.reason;
  return {
    state: reason === "contract" ? "contract" : "down",
    contract: status.server.contract,
  };
}

/** The language of the UI as the browser asked for it (the messages may resolve elsewhere). */
function uiLanguage(): string {
  try {
    const api = (browser as unknown as { i18n?: { getUILanguage?: () => string } }).i18n;
    return api?.getUILanguage?.() ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Copy with the execCommand fallback, the way the chip's own "Copy" action does
 * (lib/render/badge.ts). The async API is tried first because it is the one that answers
 * without a live user gesture: a context-menu click focuses the tab, which is all Chrome
 * asks of it, and no clipboard permission is declared there. Firefox wants the gesture
 * that is already over by the time this runs, so the worker asks it for the OPTIONAL
 * `clipboardWrite` inside the click itself; without that both routes below refuse, and
 * "none" is what the badge is told.
 */
async function copyText(text: string): Promise<CopyResult["via"]> {
  try {
    await navigator.clipboard.writeText(text);
    return "clipboard";
  } catch {
    /* not focused, or the permission was refused — the old route still works */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy") ? "execCommand" : "none";
  } catch {
    return "none";
  } finally {
    ta.remove();
  }
}

export async function copyPageDiagnostics(facts: DiagnosticsFacts): Promise<CopyResult> {
  const manifest = browser.runtime.getManifest();
  const [chunk, daemon, rule, globallyEnabled, analysisScope, mergeShorts, displayMode] = await Promise.all([
    loadDiagnostics(),
    daemonFacts(),
    effectiveRule(facts.host).catch(() => null),
    settings.enabled.getValue().catch(() => true),
    settings.analysisScope.getValue().catch(() => "page"),
    settings.mergeShorts.getValue().catch(() => true),
    settings.displayMode.getValue().catch(() => "all"),
  ]);
  const text = await chunk.buildDiagnostics({
    ...facts,
    version: manifest.version,
    manifestVersion: manifest.manifest_version,
    uiLanguage: uiLanguage(),
    messageLocale: messageLocale(),
    analysisScope,
    mergeShorts,
    displayMode,
    siteRule: rule,
    globallyEnabled,
    daemon,
    detectLanguage: detectUnsupported,
  });
  const via = await copyText(text);
  return { ok: via !== "none", bytes: new TextEncoder().encode(text).length, via };
}
