// lib/webengine/engine.ts — the local component, in a Web Worker.
//
// What anagramd/native_component.py and anagramd/engine.py are for the native host, for
// the browser: it owns the model files (download, verification, deletion), loads the
// model on the runtime lib/webengine/session.ts picks, answers the contract's operations
// with the native host's shapes, errors and status numbers, and lets the model go after
// the same idle time. One engine per worker; lib/webengine/worker.ts feeds it requests.
import { yieldToMessages } from "./scheduling";
import { IDLE_UNLOAD_RULE, validIdleUnload, type ScoreResult } from "../contract";
import { downloadFile, DownloadFailed, DownloadPaused, mirrorOf, noRoomFor, outOfSpace, readPackaged } from "./download";
import { FastText } from "./fasttext";
import { BUCKET_LABELS, CALIBRATION, SUPPORTED_LANGUAGES, modelFileName, type ModelTier, type Pin, type PinnedFile } from "./pin";
import { CONTRACT_VERSION, EngineError, checkPayloadKeys, parseScorePayload, parseTokensPayload, type EngineOperation } from "./protocol";
import { countTokens, MAX_LENGTH, N_BUCKETS, pyRound, scoreTexts } from "./scoring";
import { probeRuntimes, Session, type Candidate, type RuntimeAssets } from "./session";
import { sha256Hex } from "./sha256";
import { MemoryStore, type FileStore } from "./storage";
import { pin as releasePin } from "./pin";
import { validRelease, type DetectorRelease } from "../detectorReleases";
import { checkDetector, detectorScore, enoughDetectorWords, normalizeDetector, type DetectorMeta, type Crf } from "./detectorScore";
import { Tokenizer } from "./tokenizer";

/** The preprocessing this engine performs, named in the model version. */
const PIPELINE_REV = "pre1";
const STATE_FILE = "state.json";
const MAX_PENDING_SCORES = 8;
/** How long a score waits for a model that is loading (a wake from idle, or the first load after
 *  setup). native_component waits 25 s for its engine; the browser's model takes minutes on the
 *  processor, and a score answered "still loading" at 25 s would only be asked again in a cycle
 *  until the load ends. The bound is for a load that hangs; the transport's own (lib/webengine/
 *  client.ts LOAD_WAIT_MS, 300 s) is a little longer, so the engine's answer is what arrives. */
const WAKE_TIMEOUT_MS = 285_000;

type State = "starting" | "needs_models" | "downloading" | "paused" | "loading" | "ready" | "idle" | "stopped" | "error";
type RuntimeState = "loading" | "ready" | "idle" | "error";

interface Settings {
  release?: DetectorRelease;
  pending_release?: DetectorRelease;
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
  /** The FP16 model did not run on this device (its warm-up failed): it is never tried again. */
  fp16_failed?: boolean;
  /** Why the failed download stopped, said again after a restart (a full disk is still full). */
  download_error?: string;
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
  /** Where `pin` is the FP16 model and FP32 fits the device too: what setup falls back to, on the
   *  processor, when FP16 does not run here. Without it that device cannot run the model. */
  fallback?: Pin;
  /** Never offer or fall back to the CPU provider (Safari). */
  gpuOnly?: boolean;
  assets: RuntimeAssets;
  /** The extension's version, reported as the component's. */
  version: string | null;
  store?: FileStore;
  /** Stands in for fetch, in the suite. */
  transport?: typeof fetch;
  /** Waits between download attempts, in ms (the suite shortens them). */
  retryWaits?: number[];
  /** A backend factory, for the suite; the real one loads the ONNX model. */
  createSession?: (candidate: Candidate, model: Blob, signal: AbortSignal) => Promise<LoadedSession>;
  probe?: (tier: ModelTier) => Promise<Candidate[]>;
  /** How long a score waits for a loading model, in ms (the suite shortens it). */
  wakeTimeoutMs?: number;
  /** The clock, for the suite. */
  now?: () => number;
  /** Start as a model let go while idle: loaded by the next score, not now. */
  idle?: boolean;
  /** Called when the model has been let go while idle, so the worker can be ended. */
  onIdle?: () => void;
}

/** What the engine needs of a session: the forward pass, its identity and a release. */
export type LoadedSession = Pick<Session, "logits" | "info" | "device" | "release">;

interface TextFiles {
  tokenizer: Tokenizer;
  bytes: Uint8Array;
  meta?: DetectorMeta;
  crf?: Crf;
}

interface Loaded { detector?: {meta:DetectorMeta;crf:Crf;session:Session}; session: LoadedSession; tokenizer: Tokenizer; lid: FastText; version: string }

/** The FP16 model failed on this device and FP32 does not fit it: the setup page's "cannot run". */
const CANNOT_RUN = { code: "cannot_run", message: "This device cannot run the model: the lighter version failed and the full one does not fit" };

const asText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

export class Engine {
  private readonly store: FileStore;
  /** The files this engine runs on: the tier setup asked for, or FP32 in its place (abandonFp16). */
  private pin: Pin;
  /** The FP16 model failed here and FP32 does not fit: nothing can run. */
  private cannotRun = false;
  private settings: Settings = { ...STATE_DEFAULT, verified: {} };
  private state: State = "starting";
  private error: { code: string; message: string } | null = null;
  private operation: { name: "delete_models"; status: "running" | "completed" | "failed"; receipt: null } | null = null;
  private download: Download = { status: "idle", bytes_received: 0, total_bytes: 0, file: null, error: null, phase: "detecting", detail: null };
  private downloadAbort: AbortController | null = null;
  private downloading: Promise<void> | null = null;
  private selecting = false;
  private candidates: Candidate[] = [];
  private runtimeState: RuntimeState = "idle";
  private runtimeError: string | null = null;
  private activeId: string | null = null;
  private loaded: Loaded | null = null;
  private readingText?: { pin: Pin; result: Promise<TextFiles> };
  private loading: Promise<void> | null = null;
  private loadAbort: AbortController | null = null;
  private storageBytes = 0;
  private lastActivity = 0;
  private pendingScores = 0;
  private settingsSaved: Promise<void> = Promise.resolve();
  private scoreChain: Promise<unknown> = Promise.resolve();
  private scoreGeneration = 0;
  private releasing: Promise<void> | null = null;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private started: Promise<void> | null = null;

  private readonly now: () => number;

  constructor(private readonly init: EngineInit) {
    this.store = init.store ?? new MemoryStore();
    this.now = init.now ?? (() => Date.now());
    this.pin = init.pin;
    this.download = { ...this.download, total_bytes: this.totals().total_bytes };
  }

  private get tier(): ModelTier { return this.pin.tier ?? "fp32"; }

  /** The runtimes this tier can use here. */
  private async probeFor(tier: ModelTier): Promise<Candidate[]> {
    const candidates = await (this.init.probe ?? ((t: ModelTier) => probeRuntimes({ tier: t })))(tier);
    return this.init.gpuOnly ? candidates.filter((c) => c.device === "gpu") : candidates;
  }

  private gpuUnavailable(): boolean {
    if (!this.init.gpuOnly || this.candidates.some((c) => c.available)) return false;
    this.state = "error";
    this.runtimeState = "error";
    this.error = { code: "webgpu_unavailable", message: "Safari requires a compatible WebGPU adapter; CPU inference is disabled" };
    return true;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Read what an earlier run left and carry on: a download that was running, or the model. */
  start(): Promise<void> {
    return this.started ??= (async () => {
      this.candidates = await this.probeFor(this.tier);
      await this.readSettings();
      const selected = this.settings.pending_release ?? this.settings.release;
      if (this.init.pin.release && validRelease(selected)) this.pin = releasePin(this.init.pin.lid.url,"fp32",selected);
      this.download.total_bytes = this.totals().total_bytes;
      if (this.tier === "fp16" && this.settings.fp16_failed) await this.leaveFp16();
      await this.refreshStorage();
      if (this.error) { this.state = "stopped"; return; }
      if (this.cannotRun) { this.state = "error"; this.error = CANNOT_RUN; return; }
      if (this.gpuUnavailable()) return;
      if (await this.modelsPresent()) {
        if (this.settings.download_pending) {
          this.settings.download_pending = false;
          await this.writeSettings();
        }
        if (this.init.idle && !this.settings.engine_stopped) { this.state = "idle"; return; }
        this.startRuntime();
        return;
      }
      if (this.settings.download_paused) { this.state = "paused"; this.download = { ...this.download, status: "paused", ...this.totals() }; return; }
      if (this.settings.download_failed) {
        const said = this.settings.download_error;
        const message = typeof said === "string" && said ? said.slice(0, 2000) : "Retry the model download to continue setup";
        this.state = "needs_models";
        this.download = { ...this.download, status: "failed", error: message, ...this.totals() };
        this.error = { code: "download_failed", message };
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
    this.downloadAbort?.abort();
    this.loadAbort?.abort();
    await this.releaseModel();
    await this.settingsSaved;
  }

  private async readSettings(): Promise<void> {
    if ((await this.store.size(STATE_FILE)) === null) return;
    try {
      const saved = JSON.parse(new TextDecoder().decode(await this.store.read(STATE_FILE))) as Partial<Settings>;
      const seconds = saved.idle_unload_s ?? STATE_DEFAULT.idle_unload_s;
      const flags = ["initialized", "download_pending", "download_paused", "download_failed", "engine_stopped", "models_deleted"] as const;
      if (saved.schema_version !== 1 || !validIdleUnload(seconds) ||
          (saved.release !== undefined && !validRelease(saved.release)) || (saved.pending_release !== undefined && !validRelease(saved.pending_release)) ||
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

  /** Save the settings. A disk too full to take them leaves them as they are in memory, and
   *  the next save tries again: the model's own bytes then meet the full disk and say so. */
  private async writeSettings(required = false, idleSeconds?: number): Promise<void> {
    // A download and the settings page can both save. Read the current preferences when this
    // writer gets its turn so a later save includes all earlier successful changes.
    const write = this.settingsSaved.then(async () => {
      const next = idleSeconds === undefined ? this.settings : { ...this.settings, idle_unload_s: idleSeconds };
      await this.store.replace(STATE_FILE, new TextEncoder().encode(JSON.stringify(next)));
      if (idleSeconds !== undefined) this.settings.idle_unload_s = idleSeconds;
    });
    this.settingsSaved = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      if (required || !outOfSpace(error)) throw error;
    }
  }

  /** The model files and their parts on disk, as lib/webengine/autoSetup.ts counts them: the
   *  room a failed download asks for is what they still lack. */
  private async refreshStorage(): Promise<void> {
    this.storageBytes = (await this.store.estimate()).used - ((await this.store.size(STATE_FILE)) ?? 0);
  }

  private totals(): { total_bytes: number; bytes_received: number } {
    return { total_bytes: this.pin.files.reduce((n, f) => n + f.size_bytes, 0), bytes_received: this.download.bytes_received };
  }

  /** Every pinned file is on disk at its size, and was verified when it arrived. */
  private async modelsPresent(): Promise<boolean> {
    for (const file of this.pin.files) {
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
    // A mirror that worked for one file is where the next one starts (download.ts), and while
    // bytes come from it the setup page says so: its notice outlives a retry's.
    const route: { mirror?: boolean } = {};
    let viaMirror: string | null = null;
    try {
      if (!this.pin.release) await this.dropOtherFiles();
      for (const file of this.pin.files) {
        this.download = { ...this.download, phase: "downloading", file: file.path ?? file.name, detail: viaMirror };
        if (this.settings.verified[file.name] === file.sha256 && (await this.store.size(file.name)) === file.size_bytes) {
          received += file.size_bytes;
          this.download = { ...this.download, bytes_received: received };
          continue;
        }
        await downloadFile(this.store, file, {
          signal, transport: this.init.transport, retryWaits: this.init.retryWaits, route,
          onPhase: (phase) => { this.download.phase = phase; },
          onProgress: (bytes) => {
            const now = Math.min(total, received + bytes);
            // Bytes arriving again end a retry's notice.
            this.download = { ...this.download, bytes_received: now, detail: now > this.download.bytes_received ? viaMirror : this.download.detail };
          },
          onNotice: (message) => {
            if (mirrorOf(message)) viaMirror = message;
            this.download = { ...this.download, detail: message };
          },
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
      const message = error instanceof DownloadFailed ? error.message : outOfSpace(error) ? noRoomFor(this.download.file ?? "the model").message : asText(error);
      this.download = { ...this.download, status: "failed", error: message, detail: null };
      this.settings.download_pending = false;
      this.settings.download_failed = true;
      this.settings.download_error = message;
      this.error = { code: "download_failed", message };
      this.state = "error";
      await this.writeSettings().catch(() => {});
      if(await this.restoreRelease()) this.startRuntime();
    }
  }

  private async restoreRelease():Promise<boolean> {
    const previous=this.settings.release;
    if(!this.settings.pending_release || !validRelease(previous) || previous.revision===this.pin.release?.revision) return false;
    this.pin=releasePin(this.init.pin.lid.url,"fp32",previous);
    delete this.settings.pending_release;
    this.settings.download_pending=false;
    this.settings.download_failed=false;
    this.settings.download_paused=false;
    await this.writeSettings();
    this.candidates=await this.probeFor("fp32");
    return this.modelsPresent();
  }

  /** Only one tier's model is stored at a time: what is not this pin's (the other tier's model,
   *  and what was verified of it) goes before a download starts. */
  private async dropOtherFiles(): Promise<void> {
    const keep = new Set([STATE_FILE, ...this.pin.files.flatMap((f) => [f.name, `${f.name}.part`])]);
    let dropped = false;
    for (const name of await this.store.list()) if (!keep.has(name)) { await this.store.delete(name); dropped = true; }
    for (const name of Object.keys(this.settings.verified)) {
      if (!this.pin.files.some((f) => f.name === name)) { delete this.settings.verified[name]; dropped = true; }
    }
    if (dropped) { await this.writeSettings(); await this.refreshStorage(); }
  }

  /**
   * The FP16 model does not run on this device, now or when it was last tried: it is never
   * tried again. Where FP32 fits (the pin's `fallback`) it takes its place, on the processor;
   * where it does not, nothing can run here.
   */
  private async leaveFp16(): Promise<"fallback" | "stop"> {
    this.settings.fp16_failed = true;
    const fallback = this.init.gpuOnly ? undefined : this.init.fallback;
    if (fallback) {
      this.pin = fallback;
      this.candidates = await this.probeFor(this.tier);
      // The graphics card is what the lighter model failed on: the full one runs on the processor.
      for (const c of this.candidates) if (c.device === "gpu") { c.available = false; c.reason = "The lighter model did not run on this graphics card"; }
      this.download = { ...this.download, total_bytes: this.totals().total_bytes };
    } else {
      this.cannotRun = true;
    }
    return fallback ? "fallback" : "stop";
  }

  private async pauseDownload(): Promise<void> {
    const running = this.downloading;
    this.downloadAbort?.abort();
    if (running) await running;
  }

  // ---- the model ------------------------------------------------------------------------------

  private async modelJson<T>(pin: Pin, path: string): Promise<T> {
    const file = pin.files.find(f => f.path === path)!;
    return JSON.parse(new TextDecoder().decode(await this.store.read(file.name))) as T;
  }

  /** Counts and a simultaneous model wake can share these reads. Idle counts keep no text cache. */
  private textFiles(pin: Pin): Promise<TextFiles> {
    if (this.readingText?.pin === pin) return this.readingText.result;
    const read = async (): Promise<TextFiles> => {
      const name = pin.release ? pin.files.find(f => f.path === "tokenizer/tokenizer.json")!.name : "tokenizer.json";
      const [bytes, meta, crf] = await Promise.all([
        this.store.read(name),
        pin.release ? this.modelJson<DetectorMeta>(pin, "model.json") : undefined,
        pin.release ? this.modelJson<Crf>(pin, "crf.json") : undefined,
      ]);
      if (pin.release) {
        if (!meta || !crf) throw new Error("Missing detector metadata");
        checkDetector(meta, crf, pin.release.release);
      }
      return { bytes, tokenizer: new Tokenizer(JSON.parse(new TextDecoder().decode(bytes))), meta, crf };
    };
    const result = read().finally(() => {
      if (this.readingText?.result === result) this.readingText = undefined;
    });
    this.readingText = { pin, result };
    return result;
  }

  private startRuntime(): void {
    if (this.closed || this.operation?.status === "running") return;
    if (this.releasing) { void this.releasing.then(() => this.startRuntime()); return; }
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
    let modelFailed = false;
    let fallbackNext = false;
    this.loading = (async () => {
      try {
        const files = new Map(this.pin.files.map((f) => [f.name, f]));
        const entryFor = (path:string) => this.pin.files.find(f=>f.path===path)!;
        const release = this.pin.release;
        const [{ tokenizer, bytes, meta, crf }, lidBytes] = await Promise.all([
          this.textFiles(this.pin), readPackaged(this.init.pin.lid),
        ]);
        const lid = new FastText(lidBytes);
        // Tokenizer offsets and extraction order affect sentence labels in cached verdicts.
        const version = release ? release.revision+"-crf3" : this.modelVersion(files, bytes, lidBytes);
        const entry = release ? entryFor("backbone/model.safetensors") : files.get(modelFileName(this.tier))!;
        let session: LoadedSession | null = null;
        let lastError: unknown = null;
        for (const candidate of this.candidateOrder()) {
          if (abort.signal.aborted) throw new Error("cancelled");
          // The file itself, which the runtime reads from disk a tensor at a time.
          const model = await this.store.file(entry.name);
          try {
            session = meta && !this.init.createSession ? await Session.detector(this.init.assets,candidate,await this.modelJson(this.pin, "backbone/config.json"),meta.window,[
              {path:"backbone/model.safetensors",data:model}, {path:"head.safetensors",data:await this.store.file(entryFor("head.safetensors").name)}
            ],abort.signal) : await (this.init.createSession ? this.init.createSession(candidate, model, abort.signal) : Session.create(this.init.assets, candidate, model, abort.signal));
            break;
          } catch (error) {
            // A load that was cancelled (another runtime was chosen with runtime.config, or the
            // model was let go) says nothing about this candidate: it stays as available as it was.
            if (abort.signal.aborted) throw error;
            lastError = error;
            candidate.available = false;
            candidate.reason = `Failed to load: ${asText(error)}`;
          }
        }
        if (!session) { modelFailed = true; throw lastError ?? new Error("No runtime can load the model here"); }
        if (abort.signal.aborted || this.closed) { await session.release(); throw new Error("cancelled"); }
        if (release) {
          const previous = this.settings.release;
          const pending = this.settings.pending_release;
          if (pending || previous !== release) {
            this.settings.release = release;
            delete this.settings.pending_release;
            try {
              await this.writeSettings(true);
            } catch (error) {
              this.settings.release = previous;
              this.settings.pending_release = pending;
              await session.release();
              throw error;
            }
          }
          await this.dropOtherFiles().catch(() => {});
        }
        this.loaded = {session, tokenizer, lid, version: release ? version+"-"+session.device : version,
          detector: meta && crf ? {meta, crf, session:session as Session} : undefined};
        this.activeId = session.info.candidate.id;
        this.loadResult = { candidate_id: this.activeId, status: "ok", load_ms: Math.round(session.info.createMs), warmup_ms: Math.round(session.info.firstRunMs) };
        this.runtimeState = "ready";
        this.lastActivity = this.now();
        if (this.state === "loading") this.state = "ready";
        this.scheduleIdleUnload();
      } catch (error) {
        if (abort.signal.aborted) { this.runtimeState = "idle"; return; }
        if (await this.restoreRelease()) {
          this.download = {...this.download,status:"failed",error:asText(error)};
          this.runtimeState = "idle";
          queueMicrotask(()=>{ void Promise.resolve(this.loading).then(()=>this.startRuntime()); });
          return;
        }
        if (modelFailed && this.tier === "fp16" && !this.closed) {
          // The FP16 model's session or first pass failed on every runtime it may use.
          this.runtimeState = "idle";
          const next = await this.leaveFp16();
          if (next === "fallback") {
            // The FP16 files go, and FP32 downloads in their place.
            await this.dropOtherFiles();
            Object.assign(this.settings, { download_pending: true, download_paused: false, download_failed: false });
            await this.writeSettings().catch(() => {});
            fallbackNext = true;
          } else {
            for (const name of await this.store.list()) if (name !== STATE_FILE) await this.store.delete(name).catch(() => {});
            this.settings.verified = {};
            await this.writeSettings().catch(() => {});
            await this.refreshStorage();
            this.state = "error"; this.error = CANNOT_RUN;
          }
          return;
        }
        this.runtimeState = "error";
        this.runtimeError = asText(error);
        if (this.state === "loading" || this.state === "ready") this.state = "error";
        this.error = { code: "not_ready", message: this.runtimeError };
      } finally {
        this.loading = null;
        if (this.loadAbort === abort) this.loadAbort = null;
        if (fallbackNext && !this.closed) this.beginDownload();
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
    const weights = files.get(modelFileName(this.tier))!.sha256;
    const manifest = {
      files: { "tokenizer.json": sha256Hex(tokenizer) }, max_length: MAX_LENGTH, dtype: this.tier, language_gate: true,
      lid: { name: "fasttext-lid.176", sha256: sha256Hex(lid) }, languages: SUPPORTED_LANGUAGES, labels: BUCKET_LABELS,
      label_schema: CALIBRATION, preprocess: PIPELINE_REV, runtime: "onnxruntime-web", rev: PIPELINE_REV,
    };
    const tail = sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
    return `sha256:${weights.slice(0, 12)}-p${tail.slice(0, 8)}-web1`;
  }

  private releaseModel(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.scoreGeneration++;
    this.clearIdleTimer();
    this.loadAbort?.abort();
    const scores = this.scoreChain;
    this.releasing = (async () => {
      if (this.loading) await this.loading.catch(() => {});
      const loaded = this.loaded;
      this.loaded = null;
      this.activeId = null;
      // A running ONNX pass owns its session until its outputs have been read and disposed.
      await scores;
      if (loaded) await loaded.session.release().catch(() => {});
    })().finally(() => { this.releasing = null; });
    return this.releasing;
  }

  private clearIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Keep one deadline while a model is loaded. Reading more text moves the deadline out. */
  private scheduleIdleUnload(): void {
    if (this.idleTimer !== undefined || this.closed || !this.loaded || this.state !== "ready" ||
        !this.settings.idle_unload_s || this.pendingScores) return;
    const duration = this.settings.idle_unload_s * 1000;
    const remaining = () => duration - Math.max(0, this.now() - this.lastActivity);
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = undefined;
      // A score in flight schedules its next idle check when the last queued score finishes.
      if (this.pendingScores || this.closed || this.state !== "ready") return;
      if (remaining() > 0) { this.scheduleIdleUnload(); return; }
      this.runtimeState = "idle";
      this.state = "idle";
      await this.releaseModel();
      if (this.state === "idle") this.init.onIdle?.();
    }, Math.max(0, remaining()));
  }

  /** runtime_controller.wake_and_wait: an idle engine loads again; a score waits for it, bounded. */
  private async wakeAndWait(): Promise<void> {
    if (this.loaded) return;
    if (this.state !== "idle" && this.state !== "loading") throw new EngineError("not_ready", "The local engine is not ready; open component settings", 503);
    if (this.state === "idle") { this.state = "loading"; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), this.init.wakeTimeoutMs ?? WAKE_TIMEOUT_MS);
    });
    const result = await Promise.race([this.load(), timeout]).finally(() => clearTimeout(timer));
    if (result === "timeout" || !this.loaded) {
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
      tier: this.tier,
      state,
      download: { ...this.download },
      runtime: this.state === "needs_models" || this.state === "downloading" || this.state === "paused" ? null : this.runtimeSnapshot(),
      storage: { models_bytes: this.storageBytes },
      error,
      settings: { idle_unload_s: this.settings.idle_unload_s, release:this.pin.release?.release, revision:this.pin.release?.revision },
      operation: this.operation ? { ...this.operation } : null,
    };
  }

  private info(loaded: Loaded) {
    return {
      ok: true as const,
      contract: CONTRACT_VERSION,
      app_version: this.init.version,
      model: { id: this.pin.model.id, ver: loaded.version, calibration: this.pin.model.calibration },
      n_buckets: loaded.detector ? 3 : N_BUCKETS,
      buckets: loaded.detector?.meta.classes ?? BUCKET_LABELS,
      languages: SUPPORTED_LANGUAGES,
      lid: "fasttext-lid.176",
      max_tokens: loaded.detector ? loaded.detector.meta.window+2 : MAX_LENGTH,
      device: loaded.session.device,
      dtype: this.tier,
    };
  }

  // ---- operations -----------------------------------------------------------------------------

  async handle(op: EngineOperation, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; data: unknown }> {
    await this.start();
    switch (op) {
      case "status":
        checkPayloadKeys(payload);
        return { status: 200, data: this.status() };
      case "health": {
        checkPayloadKeys(payload);
        if (this.state === "idle") throw new EngineError("engine_idle", "The engine was unloaded while idle; scoring will reload it", 503);
        // Not "not ready": a score or count sent now waits for the model (wakeAndWait).
        if (this.state === "loading") throw new EngineError("engine_loading", "The model is loading; what is sent waits for it", 503);
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
        const { texts } = parseTokensPayload(payload);
        const { tokenizer, meta } = await this.countingTools();
        if (!meta) return { status: 200, data: countTokens(tokenizer, texts) };
        const clean = texts.map(normalizeDetector);
        return { status: 200, data: {
          alone: clean.map(t => tokenizer.encode(t, false).length),
          following: clean.map(t => t ? tokenizer.encode(" " + t, false).length : 0),
          window: meta.window,
        } };
      }
      case "score":
        return { status: 200, data: await this.score(parseScorePayload(payload).blocks, signal) };
      case "warm":
        // A page the engine will read is opening (lib/backend/warmup.ts): a model let go while
        // idle starts loading now, beside the page, as the page's first score would start it.
        // Anything else is left as it is, and the idle clock is not touched: a model loaded so
        // and never asked for is let go after the idle time like any other.
        checkPayloadKeys(payload);
        if (this.state === "idle" && !this.loaded && !this.loading && !this.releasing) {
          this.state = "loading";
          void this.load();
        }
        return { status: 200, data: { state: this.state } };
      case "models.select":
        checkPayloadKeys(payload,["release"]);
        if (!validRelease(payload.release)) throw new EngineError("invalid_request","Invalid detector release",422);
        if (await this.canReuseSetup(payload.release)) {
          return { status: 200, data: { ...this.status(), model_reused: true } };
        }
        if (this.selecting || this.downloading || this.loading || this.pendingScores) throw new EngineError("busy","The engine is busy",409);
        this.selecting=true;
        try {
          this.candidates = await this.probeFor("fp32");
          this.settings.pending_release = payload.release;
          this.pin = releasePin(this.init.pin.lid.url,"fp32",payload.release);
          return {status:200,data:await this.startDownload()};
        } finally { this.selecting=false; }
      case "models.download":
        if (this.selecting) throw new EngineError("busy","Model selection in progress",409);
        checkPayloadKeys(payload);
        return { status: 200, data: await this.canReuseSetup() ? { ...this.status(), model_reused: true } : await this.startDownload() };
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
        // Stop scheduling windows immediately, even while the preference write awaits disk.
        this.scoreGeneration++;
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
        if (this.cannotRun) return { status: 200, data: this.status() };
        if (this.init.gpuOnly) {
          this.candidates = await this.probeFor(this.tier);
          if (this.gpuUnavailable()) return { status: 200, data: this.status() };
        }
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
        if (!validIdleUnload(seconds)) throw new EngineError("invalid_request", IDLE_UNLOAD_RULE, 422);
        try { await this.writeSettings(true, seconds); }
        catch (error) {
          if (outOfSpace(error)) throw new EngineError("settings_storage_full", "Free up disk space to save the idle setting", 507);
          throw error;
        }
        this.clearIdleTimer();
        this.scheduleIdleUnload();
        return { status: 200, data: this.status() };
      }
    }
  }

  /** A repeated setup request can use the installed model, including while it wakes or sleeps. */
  private async canReuseSetup(release?: DetectorRelease): Promise<boolean> {
    const pin = this.pin;
    if (release && (release.revision !== pin.release?.revision || release.release !== pin.release.release)) return false;
    const active = () => !this.selecting && !this.releasing && !this.settings.engine_stopped && this.operation?.status !== "running" &&
      (this.state === "ready" || this.state === "loading" || this.state === "idle");
    if (!active()) return false;
    const present = await this.modelsPresent();
    if (this.pin !== pin || !active()) throw new EngineError("busy", "Model setup changed", 409);
    return present;
  }

  private async startDownload() {
    if (this.cannotRun) return this.status();
    if (this.init.gpuOnly) {
      this.candidates = await this.probeFor(this.tier);
      if (this.gpuUnavailable()) throw new EngineError("webgpu_unavailable", this.error!.message, 503);
    }
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
    this.scoreGeneration++;
    this.operation = { name: "delete_models", status: "running", receipt: null };
    try {
      await this.pauseDownload();
      await this.releaseModel();
      for (const name of await this.store.list()) if (name !== STATE_FILE) await this.store.delete(name);
      this.settings = { ...this.settings, models_deleted: true, download_pending: false, download_paused: false, download_failed: false, verified: {} };
      await this.writeSettings();
      this.download = { status: "idle", bytes_received: 0, total_bytes: this.totals().total_bytes, file: null, error: null, phase: "detecting", detail: null };
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

  private async countingTools(): Promise<{ tokenizer: Tokenizer; meta?: DetectorMeta }> {
    if (this.idle) {
      const pin = this.pin;
      const tools = await this.textFiles(pin);
      // A settings operation can stop or replace the engine while OPFS is being read.
      if (this.closed || pin !== this.pin || this.selecting || this.settings.engine_stopped ||
          this.operation?.status === "running" || !["idle", "loading", "ready"].includes(this.state)) {
        throw new EngineError("not_ready", "The model changed while counting tokens", 503);
      }
      return tools;
    }
    await this.wakeAndWait();
    this.lastActivity = this.now();
    return { tokenizer: this.loaded!.tokenizer, meta: this.loaded!.detector?.meta };
  }

  private async score(blocks: Array<{ id: string; text: string }>, signal?: AbortSignal) {
    if (this.releasing || this.closed || this.settings.engine_stopped || this.operation?.status === "running")
      throw new EngineError("not_ready", "The engine is stopped or stopping", 503);
    if (this.pendingScores >= MAX_PENDING_SCORES) throw new EngineError("busy", "Too many pending score requests", 409);
    const generation = this.scoreGeneration;
    const check = () => {
      if (generation !== this.scoreGeneration) throw new EngineError("cancelled", "The model was stopped or changed", 409);
      signal?.throwIfAborted();
    };
    const beforePass = async () => {
      if (signal) await yieldToMessages();
      check();
    };
    this.pendingScores++;
    const turn = this.scoreChain.then(async () => {
      check();
      await this.wakeAndWait();
      check();
      const loaded = this.loaded!;
      this.lastActivity = this.now();
      // engine.score_with_engine: the language gate first, then one scoring pass over what passed it.
      const todo: Array<{ id: string; text: string; lang: string; prob: number }> = [];
      const results = new Map<string, ScoreResult>();
      for (const block of blocks) {
        if (loaded.detector && !enoughDetectorWords(block.text, loaded.detector.meta.min_words)) {
          results.set(block.id,{id:block.id,bucket:0,probs:[1/3,1/3,1/3],score:0,tokens:0,truncated:false,insufficient:true});
          continue;
        }
        if (!block.text.trim()) continue;
        const detected = loaded.lid.predict(block.text.replace(/\n/g, " ")) ?? { label: "und", prob: 0 };
        if (!SUPPORTED_LANGUAGES.includes(detected.label)) {
          results.set(block.id, { id: block.id, bucket: 0, probs: new Array<number>(loaded.detector ? 3 : N_BUCKETS).fill(1 / (loaded.detector ? 3 : N_BUCKETS)), score: 0, tokens: 0, truncated: false,
            lang: detected.label, lang_prob: pyRound(detected.prob, 3), unsupported: true });
          continue;
        }
        todo.push({ id: block.id, text: block.text, lang: detected.label, prob: detected.prob });
      }
      const detector = loaded.detector;
      const scored = detector ? await (async () => {
        const out = [];
        const run = async (ids: number[]) => {
          await beforePass();
          return detector.session.heads(ids);
        };
        for (const block of todo) {
          out.push(await detectorScore(block.text, loaded.tokenizer, detector.meta, detector.crf, run));
        }
        return out;
      })() : todo.length ? await scoreTexts(loaded.session, loaded.tokenizer, todo.map((b) => b.text), signal, beforePass) : [];
      check();
      todo.forEach((block, i) => {
        const r = scored[i]!; // one result per text, in order (scoreTexts)
        results.set(block.id, { id: block.id, ...r, lang: block.lang, lang_prob: pyRound(block.prob, 3) });
      });
      this.lastActivity = this.now();
      return {
        v: CONTRACT_VERSION,
        model: { id: this.pin.model.id, ver: loaded.version, calibration: this.pin.model.calibration },
        results: blocks.map((block) => results.get(block.id) ??
          { id: block.id, bucket: 0, probs: new Array<number>(loaded.detector ? 3 : N_BUCKETS).fill(1 / (loaded.detector ? 3 : N_BUCKETS)), score: 0, tokens: 0, truncated: false, degraded: true }),
      };
    });
    this.scoreChain = turn.catch(() => {});
    try { return await turn; }
    finally { this.pendingScores--; this.scheduleIdleUnload(); }
  }
}
