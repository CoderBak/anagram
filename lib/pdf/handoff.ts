// Chromium reads its current PDF tab; Firefox and local files use a private, ticketed loader.
import { browser } from "#imports";
import * as v from "valibot";
import { claimSourceBytes, createSourceBroker, hasPdfMagic, type PdfOpenResult } from "./sourceTransfer";
import { PDF_TAB_SCRIPTS_RUN } from "../surface";
import { matchesAny } from "../access/patterns";

/** The PDF tab → the worker: the document this tab is showing, in chunks. */
export const PDF_BYTES_PORT = "anagram-pdf-bytes";
/** The reader → the worker: the bytes held under this ticket. */
export const PDF_CLAIM_PORT = "anagram-pdf-claim";

/** Raw bytes per acknowledged chunk; only one chunk may be in flight per transfer. */
export const CHUNK_BYTES = 256 * 1024;

/** Per-document relay cap, below the reader's 100 MiB direct-file limit. */
export const MAX_HANDOFF_BYTES = 50 * 1024 * 1024;

/** How long held bytes wait for their reader before they are dropped. */
export const TICKET_TTL_MS = 30_000;

/** How long the worker waits for a tab to hand over the document. */
export const READ_TIMEOUT_MS = 30_000;

/** How long the reader waits for the worker to answer its ticket. */
export const CLAIM_TIMEOUT_MS = 15_000;

/**
 * Why a handoff produced nothing, in the three ways the reader can say it out loud:
 * the document is over the cap, it is not a PDF at all, or it could not be read.
 */
export type HandoffFailure = "large" | "type" | "read";

/** `String.fromCharCode` takes an argument list, and a long one overflows the stack. */
const BINARY_STEP = 0x8000;

// ---- bytes as JSON ------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += BINARY_STEP) {
    binary += String.fromCharCode(...bytes.subarray(at, at + BINARY_STEP));
  }
  return btoa(binary);
}

/** Decode `text` into `into` at `at`, and say how many bytes that was. */
export function fromBase64(text: string, into: Uint8Array, at: number): number {
  const size=text === "" ? 0 : validatedChunkBytes(text);
  if(size === null || !Number.isInteger(at) || at < 0 || at+size > into.length) throw new Error("Invalid PDF chunk");
  const binary = atob(text);
  for (let i = 0; i < binary.length; i++) into[at + i] = binary.charCodeAt(i);
  return binary.length;
}

/** How many bytes a base64 string stands for, without decoding it. */
export function base64Bytes(text: string): number {
  if (text.length === 0) return 0;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

// ---- the tab: re-read the document it is showing --------------------------------------------

export type StreamResult = { ok: true; bytes: number } | { ok: false; failure: HandoffFailure };

/**
 * Read `url` from this page's own origin and hand it over a chunk at a time. Everything
 * about it is bounded: the body is STREAMED rather than buffered, the running total stops
 * at the cap without the rest of the file ever being read, a document that does not begin
 * with `%PDF-` is refused as soon as the first chunk is in hand, and an abort ends it.
 *
 * `cache: "force-cache"` is what keeps this from being a second download: the tab has
 * just fetched this very document, so the cache normally answers and the network is never
 * touched. Where it cannot (a no-store header, a POST result), the request goes out from
 * the PAGE's own origin with its own cookies, which is the request the reader already made
 * by opening the tab — not a new one from ours.
 */
export async function streamPdfBytes(
  url: string,
  send: (chunk: string) => unknown | Promise<unknown>,
  opts: { cap: number; signal?: AbortSignal },
): Promise<StreamResult> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "force-cache", signal: opts.signal, redirect: "error" });
  } catch {
    return { ok: false, failure: "read" };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, failure: "read" };
  }
  // A server that states a length over the cap is answered before a byte of it is read.
  const stated = Number(response.headers.get("content-length"));
  if (Number.isFinite(stated) && stated > opts.cap) {
    await response.body.cancel().catch(() => undefined);
    return { ok: false, failure: "large" };
  }

  const reader = response.body.getReader();
  const pending = new Uint8Array(CHUNK_BYTES);
  let held = 0;
  let total = 0;
  let checked = false;
  /** Hand over what is in `pending`, checking the first one for the header. */
  const flush = async (): Promise<HandoffFailure | null> => {
    if (held === 0) return checked ? null : "type";
    if (!checked) {
      checked = true;
      if (!hasPdfMagic(pending.subarray(0, held))) return "type";
    }
    await send(toBase64(pending.subarray(0, held)));
    held = 0;
    return null;
  };
  const stop = async (failure: HandoffFailure): Promise<StreamResult> => {
    await reader.cancel().catch(() => undefined);
    return { ok: false, failure };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.cap) return await stop("large");
      let at = 0;
      while (at < value.byteLength) {
        const take = Math.min(CHUNK_BYTES - held, value.byteLength - at);
        pending.set(value.subarray(at, at + take), held);
        held += take;
        at += take;
        if (held === CHUNK_BYTES) {
          // flush() copies out of the buffer, so the same one is filled again: one
          // quarter-megabyte allocation for a document of any size.
          const bad = await flush();
          if (bad) return await stop(bad);
        }
      }
    }
    const bad = await flush();
    if (bad) return await stop(bad);
    return { ok: true, bytes: total };
  } catch {
    return await stop("read");
  }
}

/**
 * Answer the worker when it asks this tab for the document it is showing. Registered by
 * the content script in a PDF tab and nowhere else — the port name is ours and every
 * other connection is left for whoever it belongs to.
 */
export function serveTabPdfBytes(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PDF_BYTES_PORT) return;
    if(port.sender?.id !== browser.runtime.id){port.disconnect();return;}
    const stopped=new AbortController();
    let started=false,seq=0,ack:((ok:boolean)=>void)|undefined;
    port.onDisconnect.addListener(()=>{stopped.abort();ack?.(false);});
    const post=(message:unknown) => {try{port.postMessage(message);return true;}catch{stopped.abort();return false;}};
    port.onMessage.addListener((message) => {
      if(started) {
        if(!isAck(message,seq)){stopped.abort();ack?.(false);return;}
        const done=ack;ack=undefined;done?.(true);return;
      }
      const ask=v.safeParse(v.strictObject({want:v.string(),cap:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(MAX_HANDOFF_BYTES))}),message);
      if(!ask.success || ask.output.want !== location.href){post({failure:"read"});return;}
      started=true;
      void streamPdfBytes(location.href,async(chunk)=>{
        const accepted=new Promise<boolean>((resolve)=>{ack=resolve;});
        if(!post({chunk,seq:seq++}) || !await accepted)throw new Error("PDF receiver closed");
      },{cap:ask.output.cap,signal:stopped.signal}).then((result)=>post(result.ok ? {done:true,bytes:result.bytes} : {failure:result.failure}),()=>post({failure:"read"}));
    });
  });
}

export const MAX_HANDOFF_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_HANDOFF_TRANSFERS = 2;
const ChunkSchema=v.strictObject({chunk:v.pipe(v.string(),v.maxLength(Math.ceil(CHUNK_BYTES/3)*4)),seq:v.pipe(v.number(),v.integer(),v.minValue(0))});
const DoneSchema=v.strictObject({done:v.literal(true),bytes:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(MAX_HANDOFF_BYTES))});
const FailureSchema=v.strictObject({failure:v.picklist(["large","type","read"])});
const TicketSchema=v.pipe(v.string(),v.regex(/^[a-f0-9]{32}$/));
function isAck(value:unknown,next:number):boolean {
  return v.safeParse(v.strictObject({ack:v.literal(next)}),value).success;
}
export function validatedChunkBytes(value:unknown):number|null {
  if(typeof value!=="string" || !value.length || value.length>Math.ceil(CHUNK_BYTES/3)*4 || value.length%4!==0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return null;
  const size=base64Bytes(value);return size>0 && size<=CHUNK_BYTES ? size : null;
}
export interface ByteLease {grow(bytes:number):boolean;release():void}
export function createHandoffBudget(limit=MAX_HANDOFF_TOTAL_BYTES,concurrency=MAX_HANDOFF_TRANSFERS) {
  let bytes=0,active=0;
  return {
    lease():ByteLease {
      let held=0,released=false;
      return {grow(n){if(released || !Number.isSafeInteger(n) || n<0 || bytes+n>limit)return false;held+=n;bytes+=n;return true;},
        release(){if(!released){released=true;bytes-=held;held=0;}}};
    },
    start(): (()=>void)|null {if(active>=concurrency)return null;active++;let done=false;return ()=>{if(!done){done=true;active--;}};},
    bytes:()=>bytes,active:()=>active,
  };
}
interface Held {tabId:number;chunks:string[];bytes:number;timer:ReturnType<typeof setTimeout>;release():void}
export function newTicket(): string {
  const raw = new Uint8Array(16);crypto.getRandomValues(raw);
  return [...raw].map((b)=>b.toString(16).padStart(2,"0")).join("");
}
export interface TicketStore {
  hold(tabId:number,chunks:string[],bytes:number,lease?:ByteLease):string|null;
  take(ticket:string,tabId:number|undefined):Held|null;
  forget(tabId:number):void;
  size():number;
}
export function createTicketStore(ttlMs=TICKET_TTL_MS,budget=createHandoffBudget()):TicketStore {
  const held=new Map<string,Held>();
  const drop=(ticket:string,release=true)=>{const entry=held.get(ticket);if(!entry)return;clearTimeout(entry.timer);held.delete(ticket);if(release)entry.release();};
  return {
    hold(tabId,chunks,bytes,lease){
      if(!Number.isInteger(tabId) || tabId<0 || !Number.isSafeInteger(bytes) || bytes<1 || bytes>MAX_HANDOFF_BYTES)return null;
      const sizes=chunks.map(validatedChunkBytes);if(sizes.some((n)=>n===null) || sizes.reduce<number>((a,n)=>a+(n??0),0)!==bytes)return null;
      const owned=lease ?? budget.lease();if(!lease && !owned.grow(bytes)){owned.release();return null;}
      const ticket=newTicket(),timer=setTimeout(()=>drop(ticket),ttlMs);
      held.set(ticket,{tabId,chunks,bytes,timer,release:()=>owned.release()});return ticket;
    },
    take(ticket,tabId){const entry=held.get(ticket);if(!entry || tabId===undefined || tabId!==entry.tabId)return null;drop(ticket,false);return entry;},
    forget(tabId){for(const [ticket,entry]of held)if(entry.tabId===tabId)drop(ticket);},
    size:()=>held.size,
  };
}
export type ReadResult={ok:true;chunks:string[];bytes:number}|{ok:false;failure:HandoffFailure};
export async function readPdfFromTab(tabId:number,src:string,opts:{cap?:number;timeoutMs?:number;signal?:AbortSignal;lease?:ByteLease}={}):Promise<ReadResult> {
  const cap=Math.min(opts.cap ?? MAX_HANDOFF_BYTES,MAX_HANDOFF_BYTES);
  if(opts.signal?.aborted)return {ok:false,failure:"read"};
  let port:ReturnType<typeof browser.tabs.connect>;
  try{port=browser.tabs.connect(tabId,{name:PDF_BYTES_PORT,frameId:0});}catch{return {ok:false,failure:"read"};}
  return new Promise((resolve)=>{
    const chunks:string[]=[];let bytes=0,settled=false;
    const abort=()=>finish({ok:false,failure:"read"});
    const finish=(result:ReadResult)=>{if(settled)return;settled=true;clearTimeout(timer);opts.signal?.removeEventListener("abort",abort);try{port.disconnect();}catch{}resolve(result);};
    const timer=setTimeout(abort,opts.timeoutMs ?? READ_TIMEOUT_MS);
    opts.signal?.addEventListener("abort",abort,{once:true});
    port.onMessage.addListener((value)=>{
      if(settled)return;
      const chunk=v.safeParse(ChunkSchema,value);
      if(chunk.success){
        const m=chunk.output,n=validatedChunkBytes(m.chunk);
        if(n===null || m.seq!==chunks.length){finish({ok:false,failure:"read"});return;}
        if(bytes+n>cap || (opts.lease && !opts.lease.grow(n))){finish({ok:false,failure:"large"});return;}
        if(chunks.length===0){const head=new Uint8Array(n);fromBase64(m.chunk,head,0);if(!hasPdfMagic(head)){finish({ok:false,failure:"type"});return;}}
        bytes+=n;chunks.push(m.chunk);
        try{port.postMessage({ack:chunks.length});}catch{abort();}return;
      }
      const done=v.safeParse(DoneSchema,value);
      if(done.success){finish(done.output.bytes===bytes && bytes>0 ? {ok:true,chunks,bytes} : {ok:false,failure:"read"});return;}
      const failure=v.safeParse(FailureSchema,value);finish({ok:false,failure:failure.success ? failure.output.failure : "read"});
    });
    port.onDisconnect.addListener(abort);
    try{port.postMessage({want:src,cap});}catch{abort();}
  });
}
export interface HandoffDeps {readerUrl(src:string):string;ensureInjected?(tabId:number):Promise<boolean>}
export interface PdfHandoff {serve():void;open(tabId:number,src:string,opts:{auto:boolean}):Promise<PdfOpenResult>;forget(tabId:number):void}
export function createPdfHandoff(deps:HandoffDeps):PdfHandoff {
  const budget=createHandoffBudget(),store=createTicketStore(TICKET_TTL_MS,budget);
  const sourceBroker=createSourceBroker(deps.readerUrl);
  const tickets=new Map<string,{tabId:number;source:string;reader:string;navigating:boolean;loadingSeen:boolean;complete:boolean;documentId?:string;stop?:()=>void}>();
  const discard=(key:string)=>{const meta=tickets.get(key);if(!meta)return;tickets.delete(key);meta.stop?.();store.take(key,meta.tabId)?.release();};
  const reading=new Map<number,AbortController>(),sources=new Map<number,string>(),epochs=new Map<number,number>();
  const forget=(tabId:number)=>{sourceBroker.forget(tabId);reading.get(tabId)?.abort();store.forget(tabId);for(const [key,meta]of tickets)if(meta.tabId===tabId)discard(key);epochs.delete(tabId);};
  return {
    serve(){
      sourceBroker.serve();
      browser.permissions.onRemoved.addListener((removed)=>{
        for(const [tabId,src]of sources)if(matchesAny(removed.origins??[],src))reading.get(tabId)?.abort();
        for(const [key,meta]of tickets)if(matchesAny(removed.origins??[],meta.source))discard(key);
      });
      browser.webNavigation.onBeforeNavigate.addListener((details)=>{
        if(details.frameId!==0)return;
        for(const [key,meta]of tickets)if(meta.tabId===details.tabId){
          if(!meta.navigating || details.url!==meta.reader)discard(key);
        }
      });
      browser.webNavigation.onCommitted.addListener((details)=>{
        if(details.frameId!==0)return;
        for(const [key,meta]of tickets)if(meta.tabId===details.tabId){
          const documentId=(details as {documentId?:string}).documentId;
          if(details.url!==meta.reader || (meta.documentId && documentId && meta.documentId!==documentId))discard(key);
          else{meta.navigating=false;meta.documentId??=documentId;}
        }
      });
      browser.tabs.onUpdated.addListener((tabId,change)=>{
        if(change.status==="loading"){epochs.set(tabId,(epochs.get(tabId)??0)+1);reading.get(tabId)?.abort();}
        for(const [key,meta]of tickets)if(meta.tabId===tabId && !meta.stop){
          if(change.status==="loading"){
            if(meta.complete || (change.url && change.url!==meta.reader))discard(key);
            else meta.loadingSeen=true;
          }else if(change.status==="complete" && meta.loadingSeen)meta.complete=true;
        }
      });
      browser.runtime.onConnect.addListener((port)=>{
        if(port.name!==PDF_CLAIM_PORT)return;
        const sender=port.sender,tabId=sender?.tab?.id;
        const expected=browser.runtime.getURL("/reader.html");
        let senderUrl:URL|undefined;try{senderUrl=new URL(sender?.url ?? "");}catch{}
        if(sender?.id!==browser.runtime.id || (sender.documentLifecycle && sender.documentLifecycle!=="active") || !Number.isInteger(tabId) || sender?.frameId!==0 || !senderUrl || senderUrl.href.split(/[?#]/)[0]!==expected){port.disconnect();return;}
        let entry:Held|null=null,next=0,finished=false,checking=false,claimedKey:string|undefined;
        const endTransfer=budget.start();if(!endTransfer){port.disconnect();return;}
        const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);if(claimedKey){tickets.delete(claimedKey);store.take(claimedKey,tabId)?.release();}entry?.release();endTransfer();try{port.disconnect();}catch{}};
        const timer=setTimeout(finish,CLAIM_TIMEOUT_MS);
        port.onDisconnect.addListener(finish);
        port.onMessage.addListener((value)=>{
          if(finished)return;
          if(checking){finish();return;}
          try {
            if(!entry){
              const ask=v.safeParse(v.strictObject({ticket:TicketSchema}),value);
              if(!ask.success || senderUrl!.searchParams.get("ticket")!==ask.output.ticket){finish();return;}
              const key=ask.output.ticket,meta=tickets.get(key);
              if(!meta || meta.tabId!==tabId || meta.reader!==senderUrl!.href || meta.stop || (meta.documentId && sender?.documentId && meta.documentId!==sender.documentId)){port.postMessage({gone:true});finish();return;}
              checking=true;claimedKey=key;meta.stop=finish;meta.navigating=false;meta.documentId??=sender?.documentId;
              void (async()=>{
                const tab=await browser.tabs.get(tabId!);
                const frame=await browser.webNavigation.getFrame({tabId:tabId!,frameId:0}).catch(()=>null);
                const documentId=(frame as {documentId?:string}|null)?.documentId;
                if(finished || tickets.get(key)!==meta || (tab.url && tab.url!==meta.reader) || (tab.pendingUrl && tab.pendingUrl!==meta.reader) ||
                   (frame && frame.url!==meta.reader) || (documentId && sender?.documentId && documentId!==sender.documentId)){finish();return;}
                entry=store.take(key,tabId);checking=false;
                if(!entry){port.postMessage({gone:true});finish();return;}
                port.postMessage({bytes:entry.bytes});
              })().catch(finish);
              return;
            }
            if(!isAck(value,next)){finish();return;}
            if(next===entry.chunks.length){port.postMessage({done:true});finish();return;}
            const seq=next++;port.postMessage({chunk:entry.chunks[seq],seq});
          }catch{finish();}
        });
      });
    },
    async open(tabId,src,{auto}){
      if(src.startsWith("file:") || !PDF_TAB_SCRIPTS_RUN){return sourceBroker.open(tabId,src);}
      if(reading.has(tabId))return {ok:false,error:"busy"};
      const endTransfer=budget.start();if(!endTransfer)return {ok:false,error:"busy"};
      const abort=new AbortController(),lease=budget.lease();reading.set(tabId,abort);sources.set(tabId,src);
      const epoch=epochs.get(tabId)??0;
      const stillHere=async()=>{
        if(abort.signal.aborted || (epochs.get(tabId)??0)!==epoch)return false;
        try{const tab=await browser.tabs.get(tabId);return !abort.signal.aborted && (epochs.get(tabId)??0)===epoch && tab.url===src && (!tab.pendingUrl || tab.pendingUrl===src);}catch{return false;}
      };
      let transferred=false;
      try {
        if(!await stillHere())return {ok:false,error:"forbidden"};
        if(deps.ensureInjected)await deps.ensureInjected(tabId).catch(()=>false);
        if(!await stillHere())return {ok:false,error:"forbidden"};
        const got=await readPdfFromTab(tabId,src,{signal:abort.signal,lease});
        if(!await stillHere())return {ok:false,error:"forbidden"};
        if(!got.ok){if(!auto)await browser.tabs.update(tabId,{url:`${deps.readerUrl(src)}&err=${got.failure}`}).catch(()=>undefined);return {ok:false,error:"read"};}
        const ticket=store.hold(tabId,got.chunks,got.bytes,lease);
        if(!ticket)return {ok:false,error:"busy"};
        transferred=true;
        const reader=`${deps.readerUrl(src)}&ticket=${ticket}`;
        tickets.set(ticket,{tabId,source:src,reader,navigating:true,loadingSeen:false,complete:false});
        // The byte store owns expiry; mirror it for source/navigation authorization.
        setTimeout(()=>discard(ticket),TICKET_TTL_MS);
        try{await browser.tabs.update(tabId,{url:reader});return {ok:true};}
        catch{discard(ticket);return {ok:false,error:"read"};}
      }finally{if(!transferred)lease.release();reading.delete(tabId);sources.delete(tabId);endTransfer();}
    },forget,
  };
}
/** The reader's claim: the document, or why there is none. */
export type ClaimedPdf={bytes:Uint8Array}|{failure:HandoffFailure};
export async function claimPdfBytes(ticket:string,signal?:AbortSignal):Promise<ClaimedPdf> {
  if(ticket.startsWith("s-"))return claimSourceBytes(ticket,signal);
  if(signal?.aborted || !v.safeParse(TicketSchema,ticket).success)return {failure:"read"};
  let port:ReturnType<typeof browser.runtime.connect>;
  try{port=browser.runtime.connect({name:PDF_CLAIM_PORT});}catch{return {failure:"read"};}
  return new Promise((resolve)=>{
    let out:Uint8Array|null=null,at=0,seq=0,settled=false;
    const abort=()=>finish({failure:"read"});
    const finish=(result:ClaimedPdf)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);try{port.disconnect();}catch{}resolve(result);};
    const timer=setTimeout(abort,CLAIM_TIMEOUT_MS);signal?.addEventListener("abort",abort,{once:true});
    const post=(value:unknown)=>{try{port.postMessage(value);}catch{abort();}};
    port.onDisconnect.addListener(abort);
    port.onMessage.addListener((value)=>{
      if(settled)return;
      if(!out){const header=v.safeParse(v.strictObject({bytes:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(MAX_HANDOFF_BYTES))}),value);
        if(!header.success){abort();return;}out=new Uint8Array(header.output.bytes);post({ack:0});return;}
      const chunk=v.safeParse(ChunkSchema,value);
      if(chunk.success){
        const m=chunk.output,n=validatedChunkBytes(m.chunk);
        if(n===null || m.seq!==seq || at+n>out.length){abort();return;}
        try{at+=fromBase64(m.chunk,out,at);}catch{abort();return;}seq++;post({ack:seq});return;
      }
      if(v.safeParse(v.strictObject({done:v.literal(true)}),value).success && at===out.length && hasPdfMagic(out))finish({bytes:out});else abort();
    });
    post({ticket});
  });
}
