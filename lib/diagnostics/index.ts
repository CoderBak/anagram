import { sendDocumentMessage } from "../access/session";
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
  "running" | "onceForPage" | "translated" | "pdf" | "docs" | "counts" | "frameGate" | "clickedFrameId" | "target"
> & {
  /** The hostname the site rules are keyed on (a subframe's is its top page's). */
  host: string;
};

export interface CopyResult {
  ok: boolean;
  /** Size of what was copied, so the worker's badge flash only claims what happened. */
  bytes: number;
  /** Which route took it — worth knowing, because the two fail on different platforms. */
  via: "clipboard" | "none";
}

/** Is the daemon up, and if not, why not — the shape the report prints from. */
async function daemonFacts(): Promise<DaemonFacts> {
  let status: BackendStatus | undefined;
  try {
    status = (await sendDocumentMessage({ action: ACTIONS.GET_BACKEND_STATUS })) as
      | BackendStatus
      | undefined;
  } catch {
    /* the worker is gone, or the extension context was invalidated */
  }
  if (!status) return { state: "unknown" };
  if (status.active === "idle" || status.active === "loading") return {state: status.active};
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
 * Copy with the async clipboard API, the one that answers without a live user gesture: a
 * context-menu click focuses the tab, which is all Chrome asks of it, and no clipboard
 * permission is declared there. Firefox wants the gesture that is already over by the time
 * this runs, so the worker asks it for the OPTIONAL `clipboardWrite` inside the click itself.
 * Where it refuses all the same, "none" is what the badge is told: there is no fallback
 * through the page — a <textarea> in its DOM, selected and copied, would hand the page the
 * report (the version, the settings, the site's rule, the engine, the device), and a `copy`
 * listener of its own could put something else on the clipboard in its place.
 */
async function copyText(text: string): Promise<CopyResult["via"]> {
  try {
    await navigator.clipboard.writeText(text);
    return "clipboard";
  } catch {
    return "none";
  }
}

export async function copyPageDiagnostics(facts: DiagnosticsFacts): Promise<CopyResult> {
  const manifest = browser.runtime.getManifest();
  const [chunk, daemon, rule, globallyEnabled, displayMode] = await Promise.all([
    loadDiagnostics(),
    daemonFacts(),
    effectiveRule(facts.host).catch(() => null),
    settings.enabled.getValue().catch(() => settings.enabled.fallback),
    settings.displayMode.getValue().catch(() => settings.displayMode.fallback),
  ]);
  const text = await chunk.buildDiagnostics({
    ...facts,
    version: manifest.version,
    manifestVersion: manifest.manifest_version,
    uiLanguage: uiLanguage(),
    messageLocale: messageLocale(),
    displayMode,
    siteRule: rule,
    globallyEnabled,
    daemon,
    detectLanguage: detectUnsupported,
  });
  const via = await copyText(text);
  return { ok: via !== "none", bytes: new TextEncoder().encode(text).length, via };
}
