import { browser } from "#imports";
import { CONTRACT_VERSION, type ModelInfo, type ScoreBlock, type ScoreClient, type ScoredBatch } from "../contract";
import type { BackendStatus } from "../messaging/protocol";
import { daemonIsBehind, parseHealth, parseScoreResponse } from "./httpClient";
import { NATIVE_HOST, type NativeOperation, type NativePayload, type NativeReply } from "./nativeProtocol";
import { nativeTransport } from "./nativeTransport";

const NONE: ModelInfo = {id:"none", ver:"0", calibration:"none"};
function extensionVersion(): string {
  try { return browser.runtime.getManifest().version; } catch { return ""; }
}
type Request = (op: NativeOperation, payload?: NativePayload) => Promise<NativeReply>;
export class NativeScoreError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message); this.name = "NativeScoreError";
  }
}
export class NativeScoreClient implements ScoreClient {
  private current: BackendStatus = {serverUrl:`native:${NATIVE_HOST}`, active:"down", model:null,
    server:{ok:false, checkedAt:0, reason:"unreachable", transport:"native"}};
  private probing: Promise<void> | undefined;
  private generation = 0;
  constructor(private readonly request: Request = (op, payload) => nativeTransport().request(op, payload)) {}
  invalidate(): void { this.generation++; this.current = {...this.current, active:"down", model:null,
    server:{ok:false,checkedAt:0,transport:"native",reason:"unreachable"}}; this.probing = undefined; }
  isUp(): boolean { return this.current.server.ok; }
  model(): ModelInfo { return this.current.model ?? NONE; }
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
          this.current = {serverUrl:`native:${NATIVE_HOST}`,active:"server",model:h.model,
            server:{ok:true,checkedAt:Date.now(),device:h.device,dtype:h.dtype,transport:"native",
              outdated:daemonIsBehind(h.app_version,extensionVersion())}};
        } else {
          this.current = {serverUrl:`native:${NATIVE_HOST}`,active:"down",model:null,
            server:{ok:false,checkedAt:Date.now(),transport:"native",reason:result && !result.ok ? result.reason : "unreachable",
              contract:result && !result.ok ? result.contract : undefined,code:reply.error?.code,error:reply.error?.message}};
        }
      } catch {
        if (generation !== this.generation) return;
        this.current = {serverUrl:`native:${NATIVE_HOST}`,active:"down",model:null,
          server:{ok:false,checkedAt:Date.now(),transport:"native",reason:"unreachable",code:"native_unavailable"}};
      }
    })();
    this.probing = pending;
    await pending;
    if (this.probing === pending) this.probing = undefined;
  }
  async status(force: boolean): Promise<BackendStatus> { await this.probe(force); return this.current; }
  async scoreBatch(blocks: ScoreBlock[]): Promise<ScoredBatch> {
    await this.probe();
    if (!this.isUp()) throw new Error("Local inference is not ready");
    const generation = this.generation;
    try {
      const reply = await this.request("score",{v:CONTRACT_VERSION,blocks:blocks.map(({id,text}) => ({id,text}))});
      if (!reply.ok) throw new NativeScoreError(reply.status, reply.error?.code ?? "inference_failed", reply.error?.message ?? "Local inference failed");
      const batch = parseScoreResponse(reply.data, blocks);
      if (generation === this.generation) this.current = {...this.current, model:batch.model};
      return batch;
    } catch (error) { if (generation === this.generation) this.invalidate(); throw error; }
  }
}
