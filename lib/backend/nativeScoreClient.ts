import { browser } from "#imports";
import { CONTRACT_VERSION, type ModelInfo, type ScoreBlock, type ScoreClient, type ScoredBatch, type TokenCounts } from "../contract";
import type { BackendStatus } from "../messaging/protocol";
import { componentIsBehind, parseHealth, parseScoreResponse, parseTokenCounts } from "./scoreProtocol";
import { type NativeOperation, type NativePayload, type NativeReply } from "./nativeProtocol";
import { engineTransport } from "./engines";
import { NativeTransportError, RECONNECT_MS } from "./transport";

const NONE: ModelInfo = {id:"none", ver:"0", calibration:"none"};
function extensionVersion(): string {
  try { return browser.runtime.getManifest().version; } catch { return ""; }
}
type Request = (op: NativeOperation, payload?: NativePayload, signal?: AbortSignal) => Promise<NativeReply>;
export class NativeScoreError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message); this.name = "NativeScoreError";
  }
}
export class NativeScoreClient implements ScoreClient {
  private current: BackendStatus = { active:"down", model:null,
    server:{ok:false, checkedAt:0, reason:"unreachable"}};
  private probing: Promise<void> | undefined;
  private generation = 0;
  constructor(private readonly request: Request = (op, payload, signal) => engineTransport().request(op, payload, signal)) {}
  /** The runtime changed: work in flight belongs to the old one, and health must be read again. */
  invalidate(): void { this.generation++; this.disconnected(); }
  /** The port closed. Every request on it was refused, so none can answer late and no
   *  identity changed: only health is unknown until it is read again. */
  disconnected(): void { this.current = {...this.current, active:"down", model:null,
    server:{ok:false,checkedAt:0,reason:"unreachable"}}; this.probing = undefined; }
  /** The engine died under a request twice, or so often that it was given up on: down,
   *  saying why. Health is read again as for any engine that is down, so one that recovers
   *  (it was the request, not the engine) comes back by itself; one given up on is refused
   *  that health read by its transport until a Retry. */
  private crashed(error: NativeTransportError): void {
    this.current = {active:"down",model:null,
      server:{ok:false,checkedAt:Date.now(),reason:"unreachable",code:error.code,error:error.message}};
    this.probing = undefined;
  }
  isUp(): boolean { return this.current.server.ok; }
  /** The engine's state as last read, without asking it: asking starts an engine that is not running. */
  known(): BackendStatus["active"] { return this.current.active; }
  model(): ModelInfo { return { ...(this.current.model ?? NONE) }; }
  revision(): number { return this.generation; }
  private observeModel(model: ModelInfo): void {
    const old = this.current.model;
    if (old && (old.id !== model.id || old.ver !== model.ver || old.calibration !== model.calibration)) this.generation++;
  }
  async ready(): Promise<void> { await this.probe(); }
  private async probe(force = false): Promise<void> {
    if (!force && Date.now() - this.current.server.checkedAt < (this.isUp() ? 60_000 : RECONNECT_MS)) return;
    if (this.probing) return this.probing;
    const generation = this.generation;
    const pending = (async () => {
      try {
        const reply = await this.request("health");
        if (generation !== this.generation) return;
        const result = reply.ok ? parseHealth(reply.data) : null;
        if (result?.ok) {
          const h = result.health;
          this.observeModel(h.model);
          this.current = {active:"server",model:{...h.model},
            server:{ok:true,checkedAt:Date.now(),device:h.device,dtype:h.dtype,
              outdated:componentIsBehind(h.app_version,extensionVersion())}};
        } else {
          // Idle is unload-for-memory, not an explicit stop. Preserve known provenance;
          // a subsequent score is allowed to wake the engine, health never wakes it. The
          // in-browser engine loading its model is reachable the same way: what it is sent
          // waits for the model. (The local engine says "not ready" while it loads: down.)
          const code = reply.error?.code;
          const active = code === "engine_idle" ? "idle" : code === "engine_loading" ? "loading" : "down";
          this.current = {active,model:active === "down" ? null : this.current.model,
            server:{ok:false,checkedAt:Date.now(),reason:result && !result.ok ? result.reason : "unreachable",
              contract:result && !result.ok ? result.contract : undefined,code:reply.error?.code,error:reply.error?.message}};
        }
      } catch (error) {
        if (generation !== this.generation) return;
        if (error instanceof NativeTransportError && error.code === "engine_crashed") { this.crashed(error); return; }
        this.current = {active:"down",model:null,
          server:{ok:false,checkedAt:Date.now(),reason:"unreachable",code:"native_unavailable"}};
      }
    })();
    this.probing = pending;
    await pending;
    if (this.probing === pending) this.probing = undefined;
  }
  async status(force: boolean): Promise<BackendStatus> { await this.probe(force); return this.current; }
  /**
   * How many model tokens each text is, alone and following a space, counted by the
   * engine's own tokenizer on the text it scores; null when it did not answer.
   */
  async countTokens(texts: string[], signal?: AbortSignal): Promise<TokenCounts | null> {
    if (texts.length === 0) return { alone: [], following: [] };
    await this.probe();
    try {
      const reply = await this.request("tokens", {v:CONTRACT_VERSION, texts}, signal);
      return reply.ok ? parseTokenCounts(reply.data, texts.length) : null;
    } catch (error) {
      if (error instanceof NativeTransportError && error.code === "engine_crashed") this.crashed(error);
      return null;
    }
  }
  async scoreBatch(blocks: ScoreBlock[], signal?: AbortSignal): Promise<ScoredBatch> {
    await this.probe();
    if (!this.isUp() && this.current.active === "down") throw new Error("Local inference is not ready");
    const generation = this.generation;
    try {
      const reply = await this.request("score",{v:CONTRACT_VERSION,blocks:blocks.map(({id,text}) => ({id,text}))}, signal);
      if (!reply.ok) throw new NativeScoreError(reply.status, reply.error?.code ?? "inference_failed", reply.error?.message ?? "Local inference failed");
      const batch = parseScoreResponse(reply.data, blocks);
      if (generation !== this.generation) throw new NativeScoreError(409, "cancelled", "Runtime changed during inference");
      this.observeModel(batch.model);
      this.current = {...this.current, active:"server", model:{...batch.model},
        server:{...this.current.server,ok:true,checkedAt:Date.now(),reason:undefined,code:undefined,error:undefined}};
      return batch;
    } catch (error) {
      // Loading and idle-wakeup are retryable without changing the model generation, and so
      // is a batch the runtime failed on and said so (`engine_failed`: it is still loaded).
      // Cancellation belongs to the caller; it must not invalidate other shared work.
      const retryable = error instanceof NativeScoreError && ["not_ready", "busy", "engine_idle", "engine_failed", "cancelled"].includes(error.code);
      // Nor does a port that closed (it has said so itself, see getScoreClient.ts) or a full
      // local queue change the runtime: nothing sent can answer after its port failed, so
      // the router may send the batch again under the same generation.
      const transport = error instanceof NativeTransportError;
      // One request that ran out of time on a live port says the host is slow, not gone.
      // Health is read again before the next batch; the engine is not declared down for
      // every tab, and the batches still running keep their answers.
      if (transport && error.code === "native_timeout")
        this.current = {...this.current, server:{...this.current.server, checkedAt:0}};
      if (transport && error.code === "engine_crashed") this.crashed(error);
      if (!retryable && !transport && !signal?.aborted && generation === this.generation) this.invalidate();
      throw error;
    }
  }
}
