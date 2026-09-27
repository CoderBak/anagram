// lib/webengine/engine.ts — the local component, in a Web Worker.
//
// What anagramd/native_component.py and anagramd/engine.py are for the native host, for
// the browser: it owns the model files (download, verification, deletion), loads the
// model on the runtime lib/webengine/session.ts picks, answers the contract's operations
// with the native host's shapes, errors and status numbers, and lets the model go after
// the same idle time. One engine per worker; lib/webengine/worker.ts feeds it requests.
import type { ScoreResult } from "../contract";
import { downloadFile, DownloadFailed, DownloadPaused, verifyFile } from "./download";
import { FastText } from "./fasttext";
import { BUCKET_LABELS, CALIBRATION, MODEL_ID, SUPPORTED_LANGUAGES, type Pin, type PinnedFile } from "./pin";
import { CONTRACT_VERSION, EngineError, checkPayloadKeys, parseScorePayload, parseTokensPayload, type EngineOperation } from "./protocol";
import { countTokens, MAX_LENGTH, N_BUCKETS, pyRound, scoreTexts } from "./scoring";
import { probeRuntimes, Session, type Candidate, type RuntimeAssets } from "./session";
import { sha256Hex } from "./sha256";
import { MemoryStore, type FileStore } from "./storage";
import { Tokenizer } from "./tokenizer";

/** The preprocessing this engine performs, named in the model version. */
const PIPELINE_REV = "pre1";
const STATE_FILE = "state.json";
const MAX_PENDING_SCORES = 8;
/** native_component's score_wait_timeout: how long a score waits for an idle engine to wake. */
const WAKE_TIMEOUT_MS = 25_000;
const IDLE_CHECK_MS = 1_000;

type State = "starting" | "needs_models" | "downloading" | "paused" | "loading" | "ready" | "idle" | "stopped" | "error";
type RuntimeState = "loading" | "ready" | "idle" | "error";

interface Settings {
  schema_version: 1;
  initialized: boolean;
  download_pending: boolean;
  download_paused: boolean;
  download_failed: boolean;
  engine_stopped: boolean;
  models_deleted: boolean;
  idle_unload_s: number;
  /** The runtime the user chose (runtime.config), or null for the automatic pick. */
  selected_id: string | null;
  /** The pinned hashes of the files verified so far, by name. */
  verified: Record<string, string>;
}
const STATE_DEFAULT: Settings = {
  schema_version: 1, initialized: false, download_pending: false, download_paused: false, download_failed: false,
  engine_stopped: false, models_deleted: false, idle_unload_s: 300, selected_id: null, verified: {},
};

interface Download {
  status: "idle" | "running" | "paused" | "completed" | "failed";
  bytes_received: number;
  total_bytes: number;
  file: string | null;
  error: string | null;
  phase: "detecting" | "verifying" | "downloading" | "complete";
  detail: string | null;
}

export interface EngineInit {
  pin: Pin;
  assets: RuntimeAssets;
  /** The extension's version, reported as the component's. */
  version: string | null;
  store?: FileStore;
  /** Stands in for fetch, in the suite. */
  transport?: typeof fetch;
  /** Waits between download attempts, in ms (the suite shortens them). */
  retryWaits?: number[];
  /** A backend factory, for the suite; the real one loads the ONNX model. */
  createSession?: (candidate: Candidate, model: Blob) => Promise<LoadedSession>;
  probe?: () => Promise<Candidate[]>;
  /** The clock, for the suite. */
  now?: () => number;
  /** Start as a model let go while idle: loaded by the next score, not now. */
  idle?: boolean;
  /** Called when the model has been let go while idle, so the worker can be ended. */
  onIdle?: () => void;
}

/** What the engine needs of a session: the forward pass, its identity and a release. */
export type LoadedSession = Pick<Session, "logits" | "info" | "device" | "release">;

interface Loaded { session: LoadedSession; tokenizer: Tokenizer; lid: FastText; version: string }

const asText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

export class Engine {
  private readonly store: FileStore;
  private settings: Settings = { ...STATE_DEFAULT, verified: {} };
  private state: State = "starting";
  private error: { code: string; message: string } | null = null;
  private operation: { name: "delete_models"; status: "running" | "completed" | "failed"; receipt: null } | null = null;
  private download: Download = { status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null, phase: "detecting", detail: null };
  private downloadAbort: AbortController | null = null;
  private downloading: Promise<void> | null = null;
  private candidates: Candidate[] = [];
  private runtimeState: RuntimeState = "idle";
  private runtimeError: string | null = null;
  private activeId: string | null = null;
  private loaded: Loaded | null = null;
  private loading: Promise<void> | null = null;
  private loadAbort: AbortController | null = null;
  private storageBytes = 0;
  private lastActivity = 0;
  private pendingScores = 0;
  private scoreChain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private started: Promise<void> | null = null;

  private readonly now: () => number;

  constructor(private readonly init: EngineInit) {
    this.store = init.store ?? new MemoryStore();
    this.now = init.now ?? (() => Date.now());
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Read what an earlier run left and carry on: a download that was running, or the model. */
  start(): Promise<void> {
    return this.started ??= (async () => {
      this.candidates = await (this.init.probe ?? probeRuntimes)();
      await this.readSettings();
      await this.refreshStorage();
      this.idleTimer = setInterval(() => void this.unloadIfIdle(), IDLE_CHECK_MS);
      if (this.error) { this.state = "stopped"; return; }
      if (await this.modelsPresent()) {
        if (this.settings.download_pending) this.settings.download_pending = false;
        await this.writeSettings();
        if (this.init.idle && !this.settings.engine_stopped) { this.state = "idle"; return; }
        this.startRuntime();
        return;
      }
      if (this.settings.download_paused) { this.state = "paused"; this.download = { ...this.download, status: "paused", ...this.totals() }; return; }
      if (this.settings.download_failed) {
        this.state = "needs_models";
        this.download = { ...this.download, status: "failed", error: "Retry the model download to continue setup", ...this.totals() };
        this.error = { code: "download_failed", message: "Retry the model download to continue setup" };
        return;
      }
      if (this.settings.download_pending && !this.settings.engine_stopped) { this.beginDownload(); return; }
      this.state = "needs_models";
    })();
  }

  /** The model was let go while idle and nothing has woken it since. */
  get idle(): boolean {
    return this.state === "idle" && !this.loaded && !this.loading && this.pendingScores === 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.downloadAbort?.abort();
    this.loadAbort?.abort();
    await this.releaseModel();
  }

  private async readSettings(): Promise<void> {
    if ((await this.store.size(STATE_FILE)) === null) return;
    try {
      const saved = JSON.parse(new TextDecoder().decode(await this.store.read(STATE_FILE))) as Partial<Settings>;
      const seconds = saved.idle_unload_s ?? STATE_DEFAULT.idle_unload_s;
      const flags = ["initialized", "download_pending", "download_paused", "download_failed", "engine_stopped", "models_deleted"] as const;
      if (saved.schema_version !== 1 || !Number.isInteger(seconds) || (seconds !== 0 && (seconds < 60 || seconds > 86400)) ||
          flags.some((key) => typeof saved[key] !== "boolean") || (saved.verified !== undefined && (typeof saved.verified !== "object" || saved.verified === null))) {
        throw new Error("damaged");
      }
      const selected = typeof saved.selected_id === "string" && this.candidates.some((c) => c.id === saved.selected_id) ? saved.selected_id : null;
      this.settings = { ...STATE_DEFAULT, ...saved, idle_unload_s: seconds, selected_id: selected, verified: { ...(saved.verified ?? {}) } };
    } catch {
      // A damaged preference file must never trigger an unexpected download.
      this.error = { code: "invalid_request", message: "Component preferences need an explicit resume or download" };
      this.settings = { ...STATE_DEFAULT, initialized: true, engine_stopped: true, download_paused: true, verified: {} };
    }
  }

  private async writeSettings(): Promise<void> {
    const writer = await this.store.writer(STATE_FILE, false);
    await writer.write(new TextEncoder().encode(JSON.stringify(this.settings)));
    await writer.close();
  }

  private async refreshStorage(): Promise<void> {
    this.storageBytes = (await this.store.estimate()).used;
  }

  private totals(): { total_bytes: number; bytes_received: number } {
    return { total_bytes: this.init.pin.files.reduce((n, f) => n + f.size_bytes, 0), bytes_received: this.download.bytes_received };
  }

  /** Every pinned file is on disk at its size, and was verified when it arrived. */
  private async modelsPresent(): Promise<boolean> {
    for (const file of this.init.pin.files) {
      if (this.settings.verified[file.name] !== file.sha256 || (await this.store.size(file.name)) !== file.size_bytes) return false;
    }
    return true;
  }

  // ---- download -------------------------------------------------------------------------------

  private beginDownload(): void {
    if (this.downloading) return;
    const abort = new AbortController();
    this.downloadAbort = abort;
    this.state = "downloading";
    this.error = null;
    this.download = { status: "running", ...this.totals(), bytes_received: 0, file: null, error: null, phase: "detecting", detail: null };
    this.downloading = this.runDownload(abort.signal).finally(() => {
      this.downloading = null;
      if (this.downloadAbort === abort) this.downloadAbort = null;
    });
  }

  private async runDownload(signal: AbortSignal): Promise<void> {
    const total = this.download.total_bytes;
    let received = 0;
    try {
      for (const file of this.init.pin.files) {
        this.download = { ...this.download, phase: "downloading", file: file.name, detail: null };
        if (this.settings.verified[file.name] === file.sha256 && (await this.store.size(file.name)) === file.size_bytes) {
          received += file.size_bytes;
          this.download = { ...this.download, bytes_received: received };
          continue;
        }
        await downloadFile(this.store, file, {
          signal, transport: this.init.transport, retryWaits: this.init.retryWaits,
          onProgress: (bytes) => {
            const now = Math.min(total, received + bytes);
            // Bytes arriving again end a retry's notice.
            this.download = { ...this.download, bytes_received: now, detail: now > this.download.bytes_received ? null : this.download.detail };
          },
          onNotice: (message) => { this.download = { ...this.download, detail: message }; },
        });
        this.settings.verified[file.name] = file.sha256;
        await this.writeSettings();
        received += file.size_bytes;
        this.download = { ...this.download, bytes_received: received };
        await this.refreshStorage();
      }
      this.download = { ...this.download, status: "completed", phase: "complete", bytes_received: total, file: null, detail: null };
      this.settings.download_pending = false;
      this.settings.download_paused = false;
      this.settings.download_failed = false;
      await this.writeSettings();
      await this.refreshStorage();
      this.startRuntime();
    } catch (error) {
      await this.refreshStorage();
      if (error instanceof DownloadPaused || signal.aborted) {
        this.download = { ...this.download, status: "paused", detail: null };
        if (this.state === "downloading") this.state = "paused";
        return;
      }
      const message = error instanceof DownloadFailed ? error.message : asText(error);
      this.download = { ...this.download, status: "failed", error: message, detail: null };
      this.settings.download_pending = false;
      this.settings.download_failed = true;
      await this.writeSettings();
      this.error = { code: "download_failed", message };
      this.state = "error";
    }
  }

  private async pauseDownload(): Promise<void> {
    const running = this.downloading;
    this.downloadAbort?.abort();
    if (running) await running;
  }

  // ---- the model ------------------------------------------------------------------------------

  private startRuntime(): void {
    if (this.closed) return;
    if (this.settings.engine_stopped) { this.state = "stopped"; return; }
    this.state = "loading";
    void this.load();
  }

  /** Load the model on the best available candidate; the promise settles either way. */
  private load(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.loaded) return Promise.resolve();
    const abort = new AbortController();
    this.loadAbort = abort;
    this.runtimeState = "loading";
    this.runtimeError = null;
    this.error = null;
    this.loading = (async () => {
      try {
        const files = new Map(this.init.pin.files.map((f) => [f.name, f]));
        const tokenizerBytes = await this.store.read("tokenizer.json");
        const tokenizer = new Tokenizer(JSON.parse(new TextDecoder().decode(tokenizerBytes)));
        const lidBytes = await this.store.read("lid.176.ftz");
        const lid = new FastText(lidBytes);
        const version = this.modelVersion(files, tokenizerBytes, lidBytes);
        const entry = files.get("model.onnx")!;
        let session: LoadedSession | null = null;
        let lastError: unknown = null;
        for (const candidate of this.candidateOrder()) {
          if (abort.signal.aborted) throw new Error("cancelled");
          // The file itself, which the runtime reads from disk a tensor at a time.
          const model = await this.store.file(entry.name);
          try {
            session = await (this.init.createSession ? this.init.createSession(candidate, model) : Session.create(this.init.assets, candidate, model, abort.signal));
            break;
          } catch (error) {
            lastError = error;
            candidate.available = false;
            candidate.reason = `Failed to load: ${asText(error)}`;
          }
        }
        if (!session) throw lastError ?? new Error("No runtime can load the model here");
        if (abort.signal.aborted || this.closed) { await session.release(); throw new Error("cancelled"); }
        this.loaded = { session, tokenizer, lid, version };
        this.activeId = session.info.candidate.id;
        this.loadResult = { candidate_id: this.activeId, status: "ok", load_ms: Math.round(session.info.createMs), warmup_ms: Math.round(session.info.firstRunMs) };
        this.runtimeState = "ready";
        this.lastActivity = this.now();
        if (this.state === "loading") this.state = "ready";
      } catch (error) {
        if (abort.signal.aborted) { this.runtimeState = "idle"; return; }
        this.runtimeState = "error";
        this.runtimeError = asText(error);
        if (this.state === "loading" || this.state === "ready") this.state = "error";
        this.error = { code: "not_ready", message: this.runtimeError };
      } finally {
        this.loading = null;
        if (this.loadAbort === abort) this.loadAbort = null;
      }
    })();
    return this.loading;
  }

  /** The candidates to try, the chosen one first, then the automatic order; only available ones. */
  private candidateOrder(): Candidate[] {
    const available = this.candidates.filter((c) => c.available);
    const chosen = available.find((c) => c.id === this.settings.selected_id);
    return chosen ? [chosen, ...available.filter((c) => c !== chosen)] : available;
  }

  /** The session's timings, in the runtime snapshot's benchmark shape. */
  private loadResult: { candidate_id: string; status: "ok"; load_ms: number; warmup_ms: number } | null = null;

  /** runtime_adapters.runtime_version's shape: the weights, then everything else that decides a verdict. */
  private modelVersion(files: Map<string, PinnedFile>, tokenizer: Uint8Array, lid: Uint8Array): string {
    const weights = files.get("model.onnx")!.sha256;
    const manifest = {
      files: { "tokenizer.json": sha256Hex(tokenizer) }, max_length: MAX_LENGTH, dtype: "fp32", language_gate: true,
      lid: { name: "fasttext-lid.176", sha256: sha256Hex(lid) }, languages: SUPPORTED_LANGUAGES, labels: BUCKET_LABELS,
      label_schema: CALIBRATION, preprocess: PIPELINE_REV, runtime: "onnxruntime-web", rev: PIPELINE_REV,
    };
    const tail = sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
    return `sha256:${weights.slice(0, 12)}-p${tail.slice(0, 8)}-web1`;
  }

  private async releaseModel(): Promise<void> {
    this.loadAbort?.abort();
    if (this.loading) await this.loading.catch(() => {});
    const loaded = this.loaded;
    this.loaded = null;
    this.activeId = null;
    if (loaded) await loaded.session.release().catch(() => {});
  }

  private async unloadIfIdle(): Promise<void> {
    if (this.closed || !this.settings.idle_unload_s || this.state !== "ready" || !this.loaded || this.pendingScores > 0 ||
        this.now() - this.lastActivity < this.settings.idle_unload_s * 1000) return;
    this.runtimeState = "idle";
    this.state = "idle";
    await this.releaseModel();
    if (this.state === "idle") this.init.onIdle?.();
  }

  /** runtime_controller.wake_and_wait: an idle engine loads again; a score waits for it, bounded. */
  private async wakeAndWait(): Promise<void> {
    if (this.loaded) return;
    if (this.state !== "idle" && this.state !== "loading") throw new EngineError("not_ready", "The local engine is not ready; open component settings", 503);
    if (this.state === "idle") { this.state = "loading"; }
    const waited = Promise.race([this.load(), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), WAKE_TIMEOUT_MS))]);
    if ((await waited) === "timeout" || !this.loaded) {
      throw new EngineError("not_ready", "The idle engine is still loading or was stopped; retry when it is ready", 503);
    }
  }

  // ---- what the pages see ----------------------------------------------------------------------

  private runtimeSnapshot() {
    const recommended = this.candidates.find((c) => c.available)?.id ?? null;
    const selected = this.candidates.some((c) => c.id === this.settings.selected_id && c.available) ? this.settings.selected_id : recommended;
    return {
      schema_version: 1 as const,
      state: this.runtimeState,
      active_id: this.activeId,
      selected_id: selected,
      recommended_id: recommended,
      fastest_id: null,
      candidates: this.candidates.map((c) => ({ ...c })),
      benchmark: { status: "idle" as const, budget_s: 0, elapsed_s: 0, measurement_s: 0, phase: "idle", current_id: null, completed: 0, total: 0,
        results: this.loadResult ? [{ ...this.loadResult }] : [] },
      error: this.runtimeError,
    };
  }

  private status() {
    let state: State = this.state;
    let error = this.error;
    if (state === "loading" && this.runtimeState === "error") { state = "error"; error ??= { code: "not_ready", message: this.runtimeError ?? "Retry the local runtime" }; }
    return {
      schema_version: 1 as const,
      version: this.init.version,
      home: "opfs:anagram-engine",
      state,
      download: { ...this.download },
      runtime: this.state === "needs_models" || this.state === "downloading" || this.state === "paused" ? null : this.runtimeSnapshot(),
      storage: { models_bytes: this.storageBytes },
      error,
      settings: { idle_unload_s: this.settings.idle_unload_s },
      operation: this.operation ? { ...this.operation } : null,
    };
  }

  private info(loaded: Loaded) {
    return {
      ok: true as const,
      contract: CONTRACT_VERSION,
      app_version: this.init.version,
      model: { id: MODEL_ID, ver: loaded.version, calibration: CALIBRATION },
      n_buckets: N_BUCKETS,
      buckets: BUCKET_LABELS,
      languages: SUPPORTED_LANGUAGES,
      lid: "fasttext-lid.176",
      max_tokens: MAX_LENGTH,
      device: loaded.session.device,
      dtype: "fp32",
    };
  }

  // ---- operations -----------------------------------------------------------------------------

  async handle(op: EngineOperation, payload: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
    await this.start();
    switch (op) {
      case "status":
        checkPayloadKeys(payload);
        return { status: 200, data: this.status() };
      case "health": {
        checkPayloadKeys(payload);
        if (this.state === "idle") throw new EngineError("engine_idle", "The engine was unloaded while idle; scoring will reload it", 503);
        if (!this.loaded || this.state !== "ready") throw new EngineError("not_ready", "The local engine is not ready; open component settings", 503);
        return { status: 200, data: this.info(this.loaded) };
      }
      case "runtime":
        checkPayloadKeys(payload);
        if (this.state === "needs_models" || this.state === "downloading" || this.state === "paused") {
          throw new EngineError("not_ready", "The local engine is not ready; open component settings", 503);
        }
        return { status: 200, data: this.runtimeSnapshot() };
      case "runtime.config": {
        checkPayloadKeys(payload, ["id"], ["id"]);
        const candidate = this.candidates.find((c) => c.id === payload.id);
        if (!candidate) throw new EngineError("invalid_request", "Unknown runtime configuration", 422);
        if (!candidate.available) throw new EngineError("invalid_request", candidate.reason ?? "That runtime is not available here", 422);
        if (this.state === "needs_models" || this.state === "downloading" || this.state === "paused") {
          throw new EngineError("not_ready", "The local engine is not ready; open component settings", 503);
        }
        this.settings.selected_id = candidate.id;
        await this.writeSettings();
        if (this.activeId !== candidate.id) {
          await this.releaseModel();
          this.runtimeState = "idle";
          this.startRuntime();
        }
        return { status: 200, data: this.runtimeSnapshot() };
      }
      case "tokens": {
        const request = parseTokensPayload(payload);
        await this.wakeAndWait();
        this.lastActivity = this.now();
        return { status: 200, data: countTokens(this.loaded!.tokenizer, request.texts) };
      }
      case "score":
        return { status: 200, data: await this.score(parseScorePayload(payload).blocks) };
      case "models.download":
        checkPayloadKeys(payload);
        return { status: 200, data: await this.startDownload() };
      case "models.pause": {
        checkPayloadKeys(payload);
        if (this.download.status !== "running") throw new EngineError("busy", "There is no active download to pause", 409);
        this.settings.download_paused = true;
        await this.writeSettings();
        await this.pauseDownload();
        return { status: 200, data: this.status() };
      }
      case "models.delete": {
        checkPayloadKeys(payload, ["confirm"], ["confirm"]);
        if (payload.confirm !== true) throw new EngineError("invalid_request", "Unexpected operation payload", 422);
        return { status: 200, data: await this.deleteModels() };
      }
      case "engine.stop": {
        checkPayloadKeys(payload);
        this.settings.engine_stopped = true;
        if (this.download.status === "running") this.settings.download_paused = true;
        await this.writeSettings();
        await this.pauseDownload();
        await this.releaseModel();
        this.runtimeState = "idle";
        this.state = "stopped";
        return { status: 200, data: this.status() };
      }
      case "engine.resume": {
        checkPayloadKeys(payload);
        this.settings.engine_stopped = false;
        this.error = null;
        if (await this.modelsPresent()) {
          this.settings.download_paused = false;
          this.settings.download_pending = false;
          this.settings.download_failed = false;
          await this.writeSettings();
          this.startRuntime();
        } else {
          this.settings.download_paused = false;
          this.settings.download_failed = false;
          this.settings.download_pending = true;
          await this.writeSettings();
          this.beginDownload();
        }
        return { status: 200, data: this.status() };
      }
      case "engine.settings": {
        checkPayloadKeys(payload, ["idle_unload_s"], ["idle_unload_s"]);
        const seconds = payload.idle_unload_s;
        if (!Number.isInteger(seconds) || (seconds !== 0 && ((seconds as number) < 60 || (seconds as number) > 86400))) {
          throw new EngineError("invalid_request", "idle_unload_s must be 0 or an integer from 60 to 86400", 422);
        }
        this.settings.idle_unload_s = seconds as number;
        await this.writeSettings();
        return { status: 200, data: this.status() };
      }
    }
  }

  private async startDownload() {
    if (this.downloading) throw new EngineError("busy", "A model download is already running", 409);
    if (this.operation?.status === "running") throw new EngineError("not_ready", "Reconnect the native component after this operation", 503);
    this.settings = { ...this.settings, initialized: true, download_pending: true, download_paused: false, download_failed: false, models_deleted: false, engine_stopped: false };
    await this.writeSettings();
    this.operation = null;
    await this.releaseModel();
    this.runtimeState = "idle";
    if (await this.modelsPresent()) {
      this.settings.download_pending = false;
      await this.writeSettings();
      this.download = { ...this.download, status: "completed", phase: "complete", file: null, error: null, ...this.totals(), bytes_received: this.totals().total_bytes };
      this.startRuntime();
    } else {
      this.beginDownload();
    }
    return this.status();
  }

  private async deleteModels() {
    if (this.operation?.status === "running") throw new EngineError("not_ready", "Reconnect the native component after this operation", 503);
    this.operation = { name: "delete_models", status: "running", receipt: null };
    try {
      await this.pauseDownload();
      await this.releaseModel();
      for (const name of await this.store.list()) if (name !== STATE_FILE) await this.store.delete(name);
      this.settings = { ...this.settings, models_deleted: true, download_pending: false, download_paused: false, download_failed: false, verified: {} };
      await this.writeSettings();
      this.download = { status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null, phase: "detecting", detail: null };
      this.runtimeState = "idle";
      this.error = null;
      this.state = "needs_models";
      await this.refreshStorage();
      this.operation.status = "completed";
    } catch (error) {
      this.operation.status = "failed";
      throw new EngineError("internal_error", `Deleting the model files failed: ${asText(error)}`, 500);
    }
    return this.status();
  }

  private async score(blocks: Array<{ id: string; text: string }>) {
    if (this.pendingScores >= MAX_PENDING_SCORES) throw new EngineError("busy", "Too many pending score requests", 409);
    this.pendingScores++;
    const turn = this.scoreChain.then(async () => {
      await this.wakeAndWait();
      const loaded = this.loaded!;
      this.lastActivity = this.now();
      // engine.score_with_engine: the language gate first, then one scoring pass over what passed it.
      const todo: Array<{ id: string; text: string; lang: string; prob: number }> = [];
      const results = new Map<string, ScoreResult>();
      for (const block of blocks) {
        if (!block.text.trim()) continue;
        const detected = loaded.lid.predict(block.text.replace(/\n/g, " ")) ?? { label: "und", prob: 0 };
        if (!SUPPORTED_LANGUAGES.includes(detected.label)) {
          results.set(block.id, { id: block.id, bucket: 0, probs: new Array<number>(N_BUCKETS).fill(1 / N_BUCKETS), score: 0, tokens: 0, truncated: false,
            lang: detected.label, lang_prob: pyRound(detected.prob, 3), unsupported: true });
          continue;
        }
        todo.push({ id: block.id, text: block.text, lang: detected.label, prob: detected.prob });
      }
      const scored = todo.length ? await scoreTexts(loaded.session, loaded.tokenizer, todo.map((b) => b.text)) : [];
      todo.forEach((block, i) => {
        const r = scored[i];
        results.set(block.id, { id: block.id, bucket: r.bucket, probs: r.probs, score: r.score, tokens: r.tokens, truncated: r.truncated, lang: block.lang, lang_prob: pyRound(block.prob, 3) });
      });
      this.lastActivity = this.now();
      return {
        v: CONTRACT_VERSION,
        model: { id: MODEL_ID, ver: loaded.version, calibration: CALIBRATION },
        results: blocks.map((block) => results.get(block.id) ??
          { id: block.id, bucket: 0, probs: new Array<number>(N_BUCKETS).fill(1 / N_BUCKETS), score: 0, tokens: 0, truncated: false, degraded: true }),
      };
    });
    this.scoreChain = turn.catch(() => {});
    try { return await turn; }
    finally { this.pendingScores--; }
  }
}
