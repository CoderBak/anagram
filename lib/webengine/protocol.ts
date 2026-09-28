// lib/webengine/protocol.ts — the in-browser engine's wire contract: the native host's.
//
// The engine answers the same requests as anagramd/native_host.py, in the same envelope
// ({v: 1, id, op, payload} → {v: 1, id, ok, status, data | error}), with the same
// operation names, payload limits, error codes and status numbers, so that the
// background's score client (lib/backend/nativeScoreClient.ts) and the setup pages'
// component client (lib/backend/nativeClient.ts) read its answers unchanged. The subset
// that has no meaning without a native process (runtime benchmarks, component update and
// uninstall) is refused as the host refuses an unknown operation.
import { isRecord, parseNativeReply, type NativeReply } from "../backend/nativeProtocol";
import { CONTRACT_VERSION } from "../contract";

export { CONTRACT_VERSION };
/** Operations the in-browser engine answers: the native host's, and `warm`, its own (a model
 *  let go while idle starts loading; lib/backend/warmup.ts). */
export const ENGINE_OPERATIONS = [
  "status", "health", "score", "tokens", "runtime", "runtime.config",
  "models.download", "models.pause", "models.delete", "engine.stop", "engine.resume", "engine.settings", "warm",
] as const;
export type EngineOperation = typeof ENGINE_OPERATIONS[number];
/** The name of the runtime port between the background and the offscreen document. */
export const ENGINE_PORT = "anagram-engine";
/** anagramd/native_host.py's limits. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024 - 1024;
export const MAX_BLOCKS = 256;
export const MAX_TEXT_CHARS = 16000;
export const MAX_TOKEN_TEXTS = 512;
export const MAX_TOKEN_CHARS = 256000;
export const MAX_ID_CHARS = 64;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,96}$/;

export interface EngineRequest { v: 1; id: string; op: EngineOperation; payload: Record<string, unknown> }
export type EngineReply = NativeReply;
export { parseNativeReply };

export class EngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "EngineError";
  }
}

export const ok = (id: string, data: unknown, status = 200): EngineReply => ({ v: 1, id, ok: true, status, data });
export const fail = (id: string, code: string, message: string, status: number): EngineReply =>
  ({ v: 1, id, ok: false, status, error: { code, message: message.slice(0, 2000) } });

/** native_host.validate_request: the envelope, or null. */
export function parseEngineRequest(value: unknown): EngineRequest | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "id,op,payload,v" || value.v !== 1 || typeof value.id !== "string" || !IDENTIFIER.test(value.id) ||
      typeof value.op !== "string" || !(ENGINE_OPERATIONS as readonly string[]).includes(value.op) || !isRecord(value.payload)) return null;
  return value as unknown as EngineRequest;
}

export interface ScorePayload { blocks: Array<{ id: string; text: string }> }
export interface TokensPayload { texts: string[] }

function contractMajor(v: unknown): void {
  if (typeof v !== "string" || v.length > 16 || v.split(".")[0] !== CONTRACT_VERSION.split(".")[0]) {
    throw new EngineError("invalid_request", "Invalid score request", 422);
  }
}

/** engine.ScoreRequest: the blocks, with the model's limits, or a 422. */
export function parseScorePayload(payload: Record<string, unknown>): ScorePayload {
  contractMajor(payload.v);
  const blocks = payload.blocks ?? [];
  if (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS) throw new EngineError("invalid_request", "Invalid score request", 422);
  const seen = new Set<string>();
  const out: ScorePayload["blocks"] = [];
  for (const block of blocks) {
    if (!isRecord(block) || typeof block.id !== "string" || block.id.length < 1 || block.id.length > MAX_ID_CHARS ||
        (block.text !== undefined && typeof block.text !== "string") || (typeof block.text === "string" && block.text.length > MAX_TEXT_CHARS) ||
        seen.has(block.id)) {
      throw new EngineError("invalid_request", "Invalid score request", 422);
    }
    seen.add(block.id);
    out.push({ id: block.id, text: typeof block.text === "string" ? block.text : "" });
  }
  return { blocks: out };
}

/** engine.TokensRequest: the texts, with their limits, or a 422. */
export function parseTokensPayload(payload: Record<string, unknown>): TokensPayload {
  contractMajor(payload.v);
  const texts = payload.texts ?? [];
  if (!Array.isArray(texts) || texts.length > MAX_TOKEN_TEXTS) throw new EngineError("invalid_request", "Invalid tokens request", 422);
  let total = 0;
  for (const text of texts) {
    if (typeof text !== "string" || text.length > MAX_TEXT_CHARS) throw new EngineError("invalid_request", "Invalid tokens request", 422);
    total += text.length;
  }
  if (total > MAX_TOKEN_CHARS) throw new EngineError("invalid_request", "Invalid tokens request", 422);
  return { texts: texts as string[] };
}

/** The payload keys an operation allows (and requires), as the native component checks them. */
export function checkPayloadKeys(payload: Record<string, unknown>, allowed: string[] = [], required: string[] = []): void {
  const keys = Object.keys(payload);
  if (!required.every((k) => keys.includes(k)) || !keys.every((k) => allowed.includes(k))) {
    throw new EngineError("invalid_request", "Unexpected operation payload", 422);
  }
}
