// Validate worker messages before authorization, hashing, cache access or queueing.
import * as v from "valibot";
import { safePdfSource } from "../pdf/source";
import { isCommentOrigin } from "./commentFrames";
import { CONTRACT_VERSION } from "../contract";
import { ACTIONS } from "../messaging/protocol";
import { PAGE_KINDS, SKIP_REASONS, STATS_MAX_DWELL_S, STATS_MAX_ENTRIES, STATS_MAX_WORDS } from "../stats/model";

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
/** A comment provider's pattern (lib/access/commentFrames.ts), and nothing else: the page
 *  may not ask the worker what else is granted. */
const commentOrigin = v.pipe(v.string(), v.check(isCommentOrigin));
const Block = v.strictObject({id:v.pipe(v.string(),v.minLength(1),v.maxLength(64)),text:v.pipe(v.string(),v.maxLength(16000))});
export const ScoreRequestSchema = v.pipe(v.strictObject({
  v:v.literal(CONTRACT_VERSION), session:v.pipe(v.string(),v.minLength(1),v.maxLength(64)),
  priority:v.picklist(["viewport","near","background"]),
  blocks:v.pipe(v.array(Block),v.minLength(1),v.maxLength(256)),
}),v.check((r) => new Set(r.blocks.map((b)=>b.id)).size === r.blocks.length, "duplicate block IDs"),
  v.check((r) => r.blocks.reduce((n,b)=>n+b.text.length,0) <= 256_000,"request too large"),
  v.check((r) => new TextEncoder().encode(JSON.stringify(r)).byteLength <= 900_000,"encoded request too large"));
const TokenTexts = v.pipe(v.array(v.pipe(v.string(),v.maxLength(16000))),v.minLength(1),v.maxLength(512),
  v.check((texts) => texts.reduce((n,t)=>n+t.length,0) <= 256_000,"request too large"));
/** A stretch of words read, for the statistics: numbers only, never text. */
const StatsWords = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(STATS_MAX_WORDS));
const Probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const StatsUnit = v.pipe(v.strictObject({w:StatsWords,p:v.pipe(v.array(Probability),v.length(4))}),
  v.check((u) => Math.abs(u.p.reduce((n,p)=>n+p,0)-1) <= 0.02, "probabilities do not sum to one"));
const StatsSkip = v.strictObject({w:StatsWords,why:v.picklist(SKIP_REASONS)});
const schema = v.variant("action",[
  v.strictObject({action:v.literal(ACTIONS.SCORE_BATCH),session,req:ScoreRequestSchema}),
  v.strictObject({action:v.literal(ACTIONS.COUNT_TOKENS),session,texts:TokenTexts}),
  v.strictObject({action:v.literal(ACTIONS.ANALYZE_TAB),tabId}),
  v.strictObject({action:v.literal(ACTIONS.OPEN_PDF_READER),session,tabId:v.optional(tabId),url:v.optional(pdfUrl)}),
  v.strictObject({action:v.literal(ACTIONS.GET_PDF_STATUS),tabId}),
  v.strictObject({action:v.literal(ACTIONS.PDF_TAB_OPENED),session,url,contentType:v.literal("application/pdf"),protocol:v.picklist(["http:","https:"]),navigationType:v.picklist(["navigate","reload","back_forward","prerender"])}),
  v.strictObject({action:v.literal(ACTIONS.PDF_PASS_ONCE),session,url:pdfUrl}),
  v.strictObject({action:v.literal(ACTIONS.PDF_REOPEN),session,url:pdfUrl}),
  v.strictObject({action:v.literal(ACTIONS.CLEAR_CACHE)}),
  v.strictObject({action:v.literal(ACTIONS.SET_CACHE_MODE),mode:v.picklist(["persistent","session"])}),
  v.strictObject({action:v.literal(ACTIONS.GET_CACHE_COUNT)}),
  v.strictObject({action:v.literal(ACTIONS.UPDATE_BADGE),session,flagged:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(1_000_000))}),
  v.strictObject({action:v.literal(ACTIONS.GET_TOP_HOST),session}),
  v.strictObject({action:v.literal(ACTIONS.GET_BACKEND_STATUS),session,probe:v.optional(v.boolean())}),
  v.strictObject({action:v.literal(ACTIONS.COMMENT_ACCESS),session,origins:v.pipe(v.array(commentOrigin),v.maxLength(8))}),
  v.strictObject({action:v.literal(ACTIONS.GET_ENGINE)}),
  v.strictObject({action:v.literal(ACTIONS.SET_ENGINE),engine:v.picklist(["native","inbrowser"]),setup:v.optional(v.picklist(["now","auto"])),tier:v.optional(v.picklist(["fp32","fp16"])),fallback:v.optional(v.boolean())}),
  v.strictObject({action:v.literal(ACTIONS.DELETE_INBROWSER_MODEL)}),
  v.strictObject({action:v.literal(ACTIONS.STATS_RECORD),session,kind:v.picklist(PAGE_KINDS),
    dwell:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(STATS_MAX_DWELL_S)),
    units:v.pipe(v.array(StatsUnit),v.maxLength(STATS_MAX_ENTRIES)),skipped:v.pipe(v.array(StatsSkip),v.maxLength(STATS_MAX_ENTRIES))}),
]);
export type WorkerMessage = v.InferOutput<typeof schema>;
export function parseWorkerMessage(value: unknown): WorkerMessage | null {
  // Reject excessive fan-out before the schema traverses any block values.
  const raw=value as {action?:unknown;req?:{blocks?:unknown}}|null;
  if(raw?.action === ACTIONS.SCORE_BATCH && Array.isArray(raw.req?.blocks) && raw.req.blocks.length>256)return null;
  if(raw?.action === ACTIONS.COUNT_TOKENS && Array.isArray((raw as {texts?:unknown}).texts) && (raw as {texts:unknown[]}).texts.length>512)return null;
  if(raw?.action === ACTIONS.STATS_RECORD && ["units","skipped"].some((k)=>{const list=(raw as Record<string,unknown>)[k];return Array.isArray(list) && list.length>STATS_MAX_ENTRIES;}))return null;
  const result = v.safeParse(schema,value,{abortEarly:true,abortPipeEarly:true}); return result.success ? result.output : null;
}
/** Schemes of the documents that take their origin from the page that made them. */
const ORIGINLESS = new Set(["about:", "blob:"]);

/**
 * The http(s) address a content script's document speaks for, or null. That is its own URL,
 * or — for an about:blank or srcdoc frame, or a blob: document, which the content script
 * reaches by the origin it took from its page (matchOriginAsFallback, lib/access/worker.ts)
 * — that origin, as the browser reports it on the sender (MessageSender.origin).
 * An opaque origin (a sandboxed frame, a data: URL) speaks for no site at all.
 */
export function pageAddress(sender: AccessSender): string | null {
  if (!sender.url) return null;
  let parsed: URL;
  try { parsed = new URL(sender.url); } catch { return null; }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return !sender.origin || sender.origin === parsed.origin ? sender.url : null;
  }
  if (!ORIGINLESS.has(parsed.protocol) || !sender.origin) return null;
  try {
    const origin = new URL(sender.origin);
    const web = origin.protocol === "http:" || origin.protocol === "https:";
    return web && origin.origin === sender.origin ? `${origin.origin}/` : null;
  } catch {
    return null; // "null": an opaque origin
  }
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
  if (pageAddress(sender) === null || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId) || sender.frameId! < 0) return null;
  return "content";
}
export function permitsMessage(role: CallerRole, msg: WorkerMessage, sender: AccessSender): boolean {
  switch (msg.action) {
    case ACTIONS.CLEAR_CACHE: case ACTIONS.GET_CACHE_COUNT: case ACTIONS.SET_CACHE_MODE: return role === "options";
    case ACTIONS.ANALYZE_TAB: case ACTIONS.GET_PDF_STATUS: return role === "popup";
    case ACTIONS.OPEN_PDF_READER:
      return role === "popup" ? msg.tabId !== undefined && !!msg.url : role === "content" && sender.frameId === 0 && msg.tabId === undefined && msg.url === undefined;
    case ACTIONS.PDF_TAB_OPENED: return role === "content" && sender.frameId === 0 && msg.url === sender.url && new URL(msg.url).protocol === msg.protocol;
    case ACTIONS.PDF_PASS_ONCE: case ACTIONS.PDF_REOPEN: return role === "reader" && Number.isInteger(sender.tab?.id);
    case ACTIONS.SCORE_BATCH: case ACTIONS.COUNT_TOKENS: return role === "content" || role === "reader" || role === "paste";
    case ACTIONS.GET_TOP_HOST: return role === "content";
    case ACTIONS.UPDATE_BADGE: return (role === "content" || role === "reader") && sender.frameId === 0;
    case ACTIONS.GET_BACKEND_STATUS: return true;
    case ACTIONS.COMMENT_ACCESS: return role === "content" && sender.frameId === 0;
    // The panel's Set up: from the page it is drawn on, the top frame's, or the reader.
    // The engine is chosen on the setup page and in Settings, and the popup offers the
    // in-browser one when the local one keeps crashing.
    case ACTIONS.GET_ENGINE: case ACTIONS.SET_ENGINE: return role === "onboarding" || role === "options" || role === "popup";
    case ACTIONS.DELETE_INBROWSER_MODEL: return role === "options";
    // What was read, from a page or the PDF reader; never from Analyze text, whose text is the
    // reader's own (lib/stats/worker.ts).
    case ACTIONS.STATS_RECORD: return role === "content" || role === "reader";
  }
}
