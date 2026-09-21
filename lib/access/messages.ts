// Validate worker messages before authorization, hashing, cache access or queueing.
import * as v from "valibot";
import { safePdfSource } from "../pdf/source";
import { CONTRACT_VERSION } from "../contract";
import { ACTIONS } from "../messaging/protocol";

export interface AccessSender {
  id?: string; url?: string; origin?: string; documentId?: string; frameId?: number; documentLifecycle?: string;
  tab?: { id?: number; url?: string; incognito?: boolean };
}
export type CallerRole = "content" | "reader" | "popup" | "options" | "onboarding" | "paste";
export const SESSION_PORT = "anagram-document";
export const SESSION_KEY = "__anagramDocumentSession";
export const SessionSchema = v.pipe(v.string(), v.regex(/^[a-f0-9-]{36}$/));
const session = v.optional(SessionSchema);
const tabId = v.pipe(v.number(), v.integer(), v.minValue(0));
const url = v.pipe(v.string(), v.maxLength(8192), v.check((s) => {
  try { return ["http:", "https:"].includes(new URL(s).protocol); } catch { return false; }
}));
const pdfUrl = v.pipe(v.string(), v.check((s) => safePdfSource(s) !== null));
const Block = v.strictObject({id:v.pipe(v.string(),v.minLength(1),v.maxLength(64)),text:v.pipe(v.string(),v.maxLength(16000))});
export const ScoreRequestSchema = v.pipe(v.strictObject({
  v:v.literal(CONTRACT_VERSION), session:v.pipe(v.string(),v.minLength(1),v.maxLength(64)),
  priority:v.picklist(["viewport","near","background"]),
  blocks:v.pipe(v.array(Block),v.minLength(1),v.maxLength(256)),
}),v.check((r) => new Set(r.blocks.map((b)=>b.id)).size === r.blocks.length, "duplicate block IDs"),
  v.check((r) => r.blocks.reduce((n,b)=>n+b.text.length,0) <= 256_000,"request too large"),
  v.check((r) => new TextEncoder().encode(JSON.stringify(r)).byteLength <= 900_000,"encoded request too large"));
const schema = v.variant("action",[
  v.strictObject({action:v.literal(ACTIONS.SCORE_BATCH),session,req:ScoreRequestSchema}),
  v.strictObject({action:v.literal(ACTIONS.ANALYZE_TAB),tabId}),
  v.strictObject({action:v.literal(ACTIONS.OPEN_PDF_READER),session,tabId:v.optional(tabId),url:v.optional(pdfUrl)}),
  v.strictObject({action:v.literal(ACTIONS.GET_PDF_STATUS),tabId}),
  v.strictObject({action:v.literal(ACTIONS.PDF_TAB_OPENED),session,url,contentType:v.literal("application/pdf"),protocol:v.picklist(["http:","https:"]),navigationType:v.picklist(["navigate","reload","back_forward","prerender"])}),
  v.strictObject({action:v.literal(ACTIONS.PDF_PASS_ONCE),session,url:pdfUrl}),
  v.strictObject({action:v.literal(ACTIONS.CLEAR_CACHE)}),
  v.strictObject({action:v.literal(ACTIONS.SET_CACHE_MODE),mode:v.picklist(["persistent","session"])}),
  v.strictObject({action:v.literal(ACTIONS.GET_CACHE_COUNT)}),
  v.strictObject({action:v.literal(ACTIONS.UPDATE_BADGE),session,flagged:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(1_000_000))}),
  v.strictObject({action:v.literal(ACTIONS.GET_TOP_HOST),session}),
  v.strictObject({action:v.literal(ACTIONS.GET_BACKEND_STATUS),session,probe:v.optional(v.boolean())}),
]);
export type WorkerMessage = v.InferOutput<typeof schema>;
export function parseWorkerMessage(value: unknown): WorkerMessage | null {
  // Reject excessive fan-out before the schema traverses any block values.
  const raw=value as {action?:unknown;req?:{blocks?:unknown}}|null;
  if(raw?.action === ACTIONS.SCORE_BATCH && Array.isArray(raw.req?.blocks) && raw.req.blocks.length>256)return null;
  const result = v.safeParse(schema,value,{abortEarly:true,abortPipeEarly:true}); return result.success ? result.output : null;
}
export function callerRole(sender: AccessSender, extensionId: string, root: string): CallerRole | null {
  if (sender.id !== extensionId || !sender.url || (sender.documentLifecycle && sender.documentLifecycle !== "active")) return null;
  let parsed: URL;
  try { parsed = new URL(sender.url); } catch { return null; }
  if (sender.url.startsWith(root)) {
    if (sender.frameId !== undefined && sender.frameId !== 0) return null;
    const pages: Record<string,CallerRole> = {"/reader.html":"reader","/popup.html":"popup","/options.html":"options","/onboarding.html":"onboarding","/paste.html":"paste"};
    return pages[parsed.pathname] ?? null;
  }
  if (!["http:","https:"].includes(parsed.protocol) || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId) || sender.frameId! < 0) return null;
  if (sender.origin && sender.origin !== parsed.origin) return null;
  return "content";
}
export function permitsMessage(role: CallerRole, msg: WorkerMessage, sender: AccessSender): boolean {
  switch (msg.action) {
    case ACTIONS.CLEAR_CACHE: case ACTIONS.GET_CACHE_COUNT: case ACTIONS.SET_CACHE_MODE: return role === "options";
    case ACTIONS.ANALYZE_TAB: case ACTIONS.GET_PDF_STATUS: return role === "popup";
    case ACTIONS.OPEN_PDF_READER:
      return role === "popup" ? msg.tabId !== undefined && !!msg.url : role === "content" && sender.frameId === 0 && msg.tabId === undefined && msg.url === undefined;
    case ACTIONS.PDF_TAB_OPENED: return role === "content" && sender.frameId === 0 && msg.url === sender.url && new URL(msg.url).protocol === msg.protocol;
    case ACTIONS.PDF_PASS_ONCE: return role === "reader" && Number.isInteger(sender.tab?.id);
    case ACTIONS.SCORE_BATCH: return role === "content" || role === "reader" || role === "paste";
    case ACTIONS.GET_TOP_HOST: return role === "content";
    case ACTIONS.UPDATE_BADGE: return (role === "content" || role === "reader") && sender.frameId === 0;
    case ACTIONS.GET_BACKEND_STATUS: return true;
  }
}
