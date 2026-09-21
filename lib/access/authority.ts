// Authorization follows browser-provided sender identity and a live document port.
import { browser } from "#imports";
import * as v from "valibot";
import { ACTIONS } from "../messaging/protocol";
import { callerRole, SESSION_PORT, SessionSchema, type AccessSender } from "./messages";
import { matchesAny } from "./patterns";

interface Identity {tabId:number;frameId:number;url:string;origin:string;documentId?:string;session:string}
export interface DocumentAccess extends Identity { documentKey:string; signal:AbortSignal }
interface Live extends DocumentAccess {key:string;controller:AbortController;port:ReturnType<typeof browser.runtime.connect>}
const frameKey = (tabId:number,frameId:number) => `${tabId}:${frameId}`;
function sameDocument(identity: Identity, sender: AccessSender, session: string): boolean {
  if (identity.tabId !== (sender.tab?.id ?? -1) || identity.frameId !== (sender.frameId ?? 0) || identity.session !== session || !sender.url) return false;
  if (identity.documentId !== undefined && identity.documentId !== sender.documentId) return false;
  try { return new URL(sender.url).origin === identity.origin; } catch { return false; }
}
export function createDocumentAuthority() {
  const live = new Map<string,Live>();
  const once = new Map<string,Identity>();
  const retire = (record:Live, teardown=false) => {
    if(record.signal.aborted)return;
    record.controller.abort();
    if (live.get(record.key) === record) live.delete(record.key);
    if (once.get(frameKey(record.tabId,record.frameId))?.session === record.session) once.delete(frameKey(record.tabId,record.frameId));
    if (teardown && record.tabId >= 0) void browser.tabs.sendMessage(record.tabId,{action:ACTIONS.TEARDOWN},{frameId:record.frameId,...(record.documentId ? {documentId:record.documentId} : {})}).catch(()=>undefined);
    try{record.port.disconnect();}catch{/* already closed */}
  };
  const granted = async (url:string) => {
    try {return matchesAny((await browser.permissions.getAll()).origins ?? [],url);} catch {return false;}
  };
  return {
    install() {
      browser.runtime.onConnect.addListener((port) => {
        if (port.name !== SESSION_PORT) return;
        const sender = port.sender;
        const role = sender ? callerRole(sender,browser.runtime.id,browser.runtime.getURL("/")) : null;
        if (!sender || !["content","reader","paste"].includes(role ?? "") || (role !== "paste" && (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId)))) {port.disconnect();return;}
        let record:Live | undefined;
        const timer=setTimeout(()=>{if(!record)port.disconnect();},2000);
        port.onDisconnect.addListener(()=>{clearTimeout(timer);if(record)retire(record);});
        port.onMessage.addListener((value) => {
          if (record) return;
          const parsed=v.safeParse(v.strictObject({session:SessionSchema}),value);
          if (!parsed.success || live.size >= 1024) {port.disconnect();return;}
          clearTimeout(timer);
          const key=sender.tab?.id === undefined ? `page:${parsed.output.session}` : frameKey(sender.tab.id,sender.frameId ?? 0);
          const old=live.get(key); if(old)retire(old);
          const controller=new AbortController();
          record={key,tabId:sender.tab?.id ?? -1,frameId:sender.frameId ?? 0,url:sender.url!,origin:new URL(sender.url!).origin,
            documentId:sender.documentId,session:parsed.output.session,documentKey:crypto.randomUUID(),controller,signal:controller.signal,port};
          live.set(key,record); port.postMessage({session:record.session});
        });
      });
    },
    grantOnce(identity: Omit<Identity,"origin">) {
      if (!Number.isInteger(identity.tabId) || !Number.isInteger(identity.frameId) || !v.safeParse(SessionSchema,identity.session).success) return;
      try {
        const parsed=new URL(identity.url); if (!["http:","https:"].includes(parsed.protocol)) return;
        once.set(frameKey(identity.tabId,identity.frameId),{...identity,origin:parsed.origin});
      } catch { /* injection did not identify a document */ }
    },
    hasOnce(tabId:number):boolean {return [...once.values()].some((r)=>r.tabId===tabId);},
    async authorize(sender:AccessSender,session:string|undefined):Promise<DocumentAccess|null> {
      if (!session) return null;
      const key=sender.tab?.id === undefined ? `page:${session}` : frameKey(sender.tab.id,sender.frameId ?? 0),record=live.get(key);
      if (!record || !sameDocument(record,sender,session) || record.signal.aborted) return null;
      const role=callerRole(sender,browser.runtime.id,browser.runtime.getURL("/"));
      const one=once.get(key);
      const allowed=role === "reader" || role === "paste" || (role === "content" && ((one && sameDocument(one,sender,session)) || await granted(sender.url!)));
      if (!allowed || record.signal.aborted || live.get(key)!==record) return null;
      return record;
    },
    revoke(origins:readonly string[]) {
      for(const [key,identity] of once) if(matchesAny(origins,identity.url))once.delete(key);
      for(const record of [...live.values()]) if(matchesAny(origins,record.url))retire(record,true);
    },
    forget(tabId:number) {
      for(const [key,identity] of once)if(identity.tabId===tabId)once.delete(key);
      for(const record of [...live.values()])if(record.tabId===tabId)retire(record);
    },
  };
}
export const documentAuthority = createDocumentAuthority();
