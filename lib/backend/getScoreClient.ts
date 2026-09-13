// lib/backend/getScoreClient.ts — factory for the active ScoreClient.
//
// The SwitchingScoreClient picks a backend per batch from settings:
//   "auto"   → the local anagramd daemon when its /health answers, else the demo stub
//   "server" → the daemon only (failures become degraded "Unavailable" results)
//   "stub"   → the in-extension deterministic stub
// Health is probed lazily and cached (60 s when up, 5 s when down) so a daemon that
// comes online mid-session is picked up within seconds without hammering it.
import type { ModelInfo, ScoreBlock, ScoreClient, ScoreResult } from "../contract";
import { RandomStubScoreClient, STUB_MODEL } from "./randomStub";
import { HttpScoreClient, fetchHealth } from "./httpClient";
import { settings } from "../settings/settings";
import type { BackendMode } from "../settings/settings";
import type { BackendStatus } from "../messaging/protocol";
import { createLogger } from "../log";

const log = createLogger("backend");
const UP_TTL_MS = 60_000;
const DOWN_TTL_MS = 5_000;

class SwitchingScoreClient implements ScoreClient {
  private stub = new RandomStubScoreClient();
  private http: HttpScoreClient | null = null;
  private mode: BackendMode = "auto";
  private serverUrl = "";
  private settingsLoaded: Promise<void>;
  private probe: { ok: boolean; at: number; model: ModelInfo | null; device?: string; error?: string } = {
    ok: false,
    at: 0,
    model: null,
  };
  private probing: Promise<void> | null = null;

  constructor() {
    this.settingsLoaded = Promise.all([settings.backend.getValue(), settings.serverUrl.getValue()]).then(
      ([mode, url]) => {
        this.mode = mode;
        this.serverUrl = url;
      },
    );
    settings.backend.watch((v) => {
      this.mode = v;
      this.invalidate();
    });
    settings.serverUrl.watch((v) => {
      this.serverUrl = v;
      this.invalidate();
    });
  }

  private invalidate(): void {
    this.probe = { ok: false, at: 0, model: null };
    this.http = null;
  }

  /** Re-probe when the cached verdict is older than its TTL (or forced). */
  private async ensureProbe(force = false): Promise<void> {
    await this.settingsLoaded;
    if (this.mode === "stub") return;
    const ttl = this.probe.ok ? UP_TTL_MS : DOWN_TTL_MS;
    if (!force && Date.now() - this.probe.at < ttl) return;
    if (this.probing) return this.probing;
    this.probing = (async () => {
      const url = this.serverUrl;
      const h = await fetchHealth(url);
      if (h) {
        if (!this.http || !this.probe.ok || this.probe.model?.ver !== h.model.ver) {
          this.http = new HttpScoreClient(url, h.model);
          log.log("anagramd up:", h.model.id, h.model.ver, "on", h.device);
        }
        this.probe = { ok: true, at: Date.now(), model: h.model, device: h.device };
      } else {
        if (this.probe.ok) log.warn("anagramd went away — falling back per mode", this.mode);
        this.probe = { ok: false, at: Date.now(), model: null, error: `no healthy anagramd at ${url}` };
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

  model(): ModelInfo {
    if (this.mode !== "stub" && this.probe.ok && this.probe.model) return this.probe.model;
    return STUB_MODEL;
  }

  async scoreBatch(blocks: ScoreBlock[]): Promise<ScoreResult[]> {
    await this.ensureProbe();
    if (this.mode === "stub") return this.stub.scoreBatch(blocks);
    if (this.http && this.probe.ok) {
      try {
        return await this.http.scoreBatch(blocks);
      } catch (e) {
        log.warn("anagramd batch failed", e);
        this.probe = { ok: false, at: Date.now(), model: null, error: String(e) };
        this.http = null;
      }
    }
    if (this.mode === "auto") return this.stub.scoreBatch(blocks);
    throw new Error(this.probe.error ?? "anagramd unavailable");
  }

  /** For the popup/options: which backend is live right now (optionally re-probed). */
  async status(force: boolean): Promise<BackendStatus> {
    await this.ensureProbe(force);
    const active = this.mode !== "stub" && this.probe.ok ? "server" : "stub";
    return {
      mode: this.mode,
      serverUrl: this.serverUrl,
      active,
      model: this.model(),
      server: { ok: this.probe.ok, checkedAt: this.probe.at, device: this.probe.device, error: this.probe.error },
    };
  }
}

let _client: SwitchingScoreClient | null = null;

/** Returns the active ScoreClient (one per service-worker lifetime). */
export function getScoreClient(): ScoreClient {
  return getSwitchingClient();
}

export function getSwitchingClient(): SwitchingScoreClient {
  if (!_client) _client = new SwitchingScoreClient();
  return _client;
}
