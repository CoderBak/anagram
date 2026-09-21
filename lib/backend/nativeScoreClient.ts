import { browser } from "#imports";
import { CONTRACT_VERSION, type ModelInfo, type ScoreBlock, type ScoreClient, type ScoredBatch } from "../contract";
import type { BackendStatus } from "../messaging/protocol";
import { componentIsBehind, parseHealth, parseScoreResponse } from "./scoreProtocol";
import { type NativeOperation, type NativePayload, type NativeReply } from "./nativeProtocol";
import { nativeTransport } from "./nativeTransport";

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
  constructor(private readonly request: Request = (op, payload, signal) => nativeTransport().request(op, payload, signal)) {}
  invalidate(): void { this.generation++; this.current = {...this.current, active:"down", model:null,
    server:{ok:false,checkedAt:0,reason:"unreachable"}}; this.probing = undefined; }
  isUp(): boolean { return this.current.server.ok; }
  model(): ModelInfo { return { ...(this.current.model ?? NONE) }; }
  revision(): number { return this.generation; }
  private observeModel(model: ModelInfo): void {
    const old = this.current.model;
    if (old && (old.id !== model.id || old.ver !== model.ver || old.calibration !== model.calibration)) this.generation++;
  }
  async ready(): Promise<void> { await this.probe(); }
  private async probe(force = false): Promise<void> {
    if (!force && Date.now() - this.current.server.checkedAt < (this.isUp() ? 60_000 : 1500)) return;
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
          // a subsequent score is allowed to wake the engine, health never wakes it.
          const idle = reply.error?.code === "engine_idle";
          this.current = {active:idle ? "idle" : "down",model:idle ? this.current.model : null,
            server:{ok:false,checkedAt:Date.now(),reason:result && !result.ok ? result.reason : "unreachable",
              contract:result && !result.ok ? result.contract : undefined,code:reply.error?.code,error:reply.error?.message}};
        }
      } catch {
        if (generation !== this.generation) return;
        this.current = {active:"down",model:null,
          server:{ok:false,checkedAt:Date.now(),reason:"unreachable",code:"native_unavailable"}};
      }
    })();
    this.probing = pending;
    await pending;
    if (this.probing === pending) this.probing = undefined;
  }
  async status(force: boolean): Promise<BackendStatus> { await this.probe(force); return this.current; }
  async scoreBatch(blocks: ScoreBlock[], signal?: AbortSignal): Promise<ScoredBatch> {
    await this.probe();
    if (!this.isUp() && this.current.server.code !== "engine_idle") throw new Error("Local inference is not ready");
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
      // Loading and idle-wakeup are retryable without changing the model generation.
      // Cancellation belongs to the caller; it must not invalidate other shared work.
      const retryable = error instanceof NativeScoreError && ["not_ready", "busy", "engine_idle", "cancelled"].includes(error.code);
      if (!retryable && !signal?.aborted && generation === this.generation) this.invalidate();
      throw error;
    }
  }
}
