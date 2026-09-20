// lib/backend/getScoreClient.ts — the one ScoreClient: the local anagramd daemon.
//
// There is no scoring fallback. When the daemon does not answer, batches fail, the
// router hands back degraded results (rendered "Unavailable", never cached) and tells
// the content script the backend is down; the content script pauses and re-checks
// through status() until the daemon is back. Health is probed lazily and cached
// (60 s when up, 5 s when down) so a daemon that comes online mid-session is picked up
// within seconds without being hammered.
//
// Only LOOPBACK URLs are accepted: page text must never leave this machine. A setting
// that points elsewhere is treated as "no daemon", with the reason in status().
import { browser } from "#imports";
import { CONTRACT_VERSION } from "../contract";
import type { ModelInfo, ScoreBlock, ScoreClient, ScoredBatch } from "../contract";
import { HttpScoreClient, daemonIsBehind, fetchHealth } from "./httpClient";
import { settings, DEFAULT_SERVER_URL, effectiveServerUrl, isLoopbackUrl } from "../settings/settings";
import type { BackendStatus } from "../messaging/protocol";
import { createLogger } from "../log";

const log = createLogger("backend");
const UP_TTL_MS = 60_000;
const DOWN_TTL_MS = 5_000;

/** Placeholder identity while no daemon has answered (nothing is cached under it —
 *  every result produced meanwhile is degraded). */
const NO_MODEL: ModelInfo = { id: "none", ver: "0", calibration: "none" };

/** This build's own version, which the daemon's is measured against. Asked through a
 *  try/catch because the same module is bundled for places that have no extension API. */
function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return "";
  }
}

interface Probe {
  ok: boolean;
  at: number;
  model: ModelInfo | null;
  device?: string;
  error?: string;
  /** Why the daemon is unusable, so the UI can advise "start it" or "update it" rather
   *  than guessing from the error string. Absent while it is up. */
  reason?: "unreachable" | "contract" | "loopback" | "outdated";
  /** The contract a mismatched daemon reported, for the same message. */
  contract?: string;
  /** The daemon wants updating — either it is too old to answer us at all, or it
   *  answered and named a release behind our own. Set in both cases, because the pages
   *  say the same thing about both. */
  outdated?: boolean;
}

export class DaemonClient implements ScoreClient {
  private http: HttpScoreClient | null = null;
  private serverUrl = DEFAULT_SERVER_URL;
  private settingsLoaded: Promise<void>;
  private probe: Probe = { ok: false, at: 0, model: null };
  private probing: Promise<void> | null = null;
  /** Bumped on every settings change so a probe of the OLD endpoint cannot commit. */
  private generation = 0;

  constructor() {
    // `effectiveServerUrl` stands between the setting and every fetch: a URL an older
    // build accepted and this one no longer can is served by the default instead.
    this.settingsLoaded = settings.serverUrl.getValue().then((url) => {
      this.serverUrl = effectiveServerUrl(url);
    });
    settings.serverUrl.watch((url) => {
      this.serverUrl = effectiveServerUrl(url);
      this.invalidate();
    });
  }

  private invalidate(): void {
    this.generation++;
    this.probe = { ok: false, at: 0, model: null };
    this.http = null;
    this.probing = null;
  }

  /** Re-probe when the cached verdict is older than its TTL (or forced). */
  private async ensureProbe(force = false): Promise<void> {
    await this.settingsLoaded;
    const ttl = this.probe.ok ? UP_TTL_MS : DOWN_TTL_MS;
    if (!force && Date.now() - this.probe.at < ttl) return;
    if (this.probing) return this.probing;
    const gen = this.generation;
    const url = this.serverUrl;
    this.probing = (async () => {
      if (!isLoopbackUrl(url)) {
        this.probe = {
          ok: false,
          at: Date.now(),
          model: null,
          reason: "loopback",
          error: `daemon URL must be a loopback address (got ${url})`,
        };
        this.http = null;
        return;
      }
      const res = await fetchHealth(url);
      if (gen !== this.generation) return; // settings changed under us — stale answer
      if (res.ok) {
        const h = res.health;
        if (!this.http || !this.probe.ok || this.probe.model?.ver !== h.model.ver) {
          this.http = new HttpScoreClient(url, h.model);
          log.log("anagramd up:", h.model.id, h.model.ver, "on", h.device);
        }
        // A daemon behind this extension still scores — the contract is what decides
        // whether we can talk — but the two are released together, so the pages ask for
        // the one command that brings it level.
        const outdated = daemonIsBehind(h.app_version, extensionVersion());
        this.probe = { ok: true, at: Date.now(), model: h.model, device: h.device, outdated };
      } else {
        if (this.probe.ok) log.warn("anagramd went away — batches will be Unavailable until it is back");
        // Three different problems, three different sentences. Another contract major and
        // a daemon too old to answer CORS both need updating rather than starting, and the
        // UI tells them apart from an outage by `reason` alone.
        const error =
          res.reason === "contract"
            ? `anagramd at ${url} speaks contract ${res.contract} — this extension needs ${CONTRACT_VERSION}`
            : res.reason === "outdated"
              ? `something is listening at ${url} but will not answer this extension — it is older than the extension is`
              : `no healthy anagramd at ${url}`;
        this.probe = {
          ok: false,
          at: Date.now(),
          model: null,
          reason: res.reason,
          contract: res.contract,
          outdated: res.reason === "outdated",
          error,
        };
        this.http = null;
      }
    })().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  async ready(): Promise<void> {
    await this.ensureProbe();
  }

  isUp(): boolean {
    return this.probe.ok;
  }

  model(): ModelInfo {
    return this.probe.ok && this.probe.model ? this.probe.model : NO_MODEL;
  }

  async scoreBatch(blocks: ScoreBlock[]): Promise<ScoredBatch> {
    await this.ensureProbe();
    if (!this.http || !this.probe.ok) throw new Error(this.probe.error ?? "anagramd unavailable");
    try {
      const batch = await this.http.scoreBatch(blocks);
      // Provenance comes from the response; a daemon restarted with other weights
      // between probes is noticed here rather than a minute later.
      if (batch.model.ver !== this.probe.model?.ver || batch.model.id !== this.probe.model?.id) {
        this.probe = { ...this.probe, model: batch.model };
        this.http = new HttpScoreClient(this.serverUrl, batch.model);
      }
      return batch;
    } catch (e) {
      log.warn("anagramd batch failed", e);
      // A failed batch only says the daemon stopped answering properly; the next probe
      // is what tells a version mismatch from an outage.
      this.probe = { ok: false, at: Date.now(), model: null, reason: "unreachable", error: String(e) };
      this.http = null;
      throw e;
    }
  }

  /** For the popup/options/content script: is the daemon up (optionally re-probed now)? */
  async status(force: boolean): Promise<BackendStatus> {
    await this.ensureProbe(force);
    return {
      serverUrl: this.serverUrl,
      active: this.probe.ok ? "server" : "down",
      model: this.probe.ok ? this.probe.model : null,
      server: {
        ok: this.probe.ok,
        checkedAt: this.probe.at,
        device: this.probe.device,
        error: this.probe.error,
        reason: this.probe.reason,
        contract: this.probe.contract,
        outdated: this.probe.outdated,
      },
    };
  }
}

let _client: DaemonClient | null = null;

/** The daemon client (one per service-worker lifetime). */
export function getDaemonClient(): DaemonClient {
  if (!_client) _client = new DaemonClient();
  return _client;
}

/** The active ScoreClient — always the daemon. */
export function getScoreClient(): ScoreClient {
  return getDaemonClient();
}
