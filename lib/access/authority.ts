// Authorization follows browser-provided sender identity and a live document port.
import { browser } from "#imports";
import * as v from "valibot";
import { ACTIONS } from "../messaging/protocol";
import { callerRole, pageAddress, SESSION_HANDSHAKE_MS, SESSION_PORT, SessionSchema, type AccessSender } from "./messages";
import { matcher, matchesAny } from "./patterns";

interface Identity {tabId:number;frameId:number;url:string;origin:string;documentId?:string;session:string}
export interface DocumentAccess extends Identity { documentKey:string; signal:AbortSignal }
interface Live extends DocumentAccess {key:string;controller:AbortController;port:ReturnType<typeof browser.runtime.connect>;revoked?:boolean}
/** A message a document sent on its session port after the handshake (the reading log's last
 *  message of a visit, posted as the page goes): ordered before the port's disconnect, as a
 *  runtime message is not. */
export type PortMessageHandler = (record:DocumentAccess, sender:AccessSender, value:unknown) => void;
const frameKey = (tabId:number,frameId:number) => `${tabId}:${frameId}`;
/** The most documents of one tab served at once: a page with more frames than this has the
 *  rest of them unread, and no tab can take the other tabs' places. */
const PER_TAB_SESSIONS = 128;
/** What a sender is checked against: the page a content script speaks for (for a srcdoc or
 *  about:blank frame, the origin it took from its page), an extension page's own URL. */
const addressOf = (sender: AccessSender): string | undefined => pageAddress(sender) ?? sender.url;
function sameDocument(identity: Identity, sender: AccessSender, session: string): boolean {
  const address = addressOf(sender);
  if (identity.tabId !== (sender.tab?.id ?? -1) || identity.frameId !== (sender.frameId ?? 0) || identity.session !== session || !address) return false;
  if (identity.documentId !== undefined && identity.documentId !== sender.documentId) return false;
  try { return new URL(address).origin === identity.origin; } catch { return false; }
}
export function createDocumentAuthority() {
  const live = new Map<string,Live>();
  const once = new Map<string,Identity>();
  let onPortMessage: PortMessageHandler | null = null;
  const retire = (record:Live, teardown=false) => {
    if(record.signal.aborted)return;
    record.revoked = teardown;
    record.controller.abort();
    if (live.get(record.key) === record) live.delete(record.key);
    if (once.get(frameKey(record.tabId,record.frameId))?.session === record.session) once.delete(frameKey(record.tabId,record.frameId));
    if (teardown && record.tabId >= 0) void browser.tabs.sendMessage(record.tabId,{action:ACTIONS.TEARDOWN},{frameId:record.frameId,...(record.documentId ? {documentId:record.documentId} : {})}).catch(()=>undefined);
    try{record.port.disconnect();}catch{/* already closed */}
  };
  // The granted origins, read and compiled once and kept until a grant changes: every
  // content message is checked against them. A read already running when a grant changes
  // still answers its own caller, whose document revoke() aborts if the change withdrew
  // it, but it is not kept.
  let grants:Promise<(url:string)=>boolean> | undefined;
  const granted = async (url:string) => {
    let read=grants;
    try {
      if(!read)read=grants=browser.permissions.getAll().then((all)=>matcher(all.origins ?? []));
      return (await read)(url);
    } catch {
      if(grants===read)grants=undefined; // a failed read is not kept
      return false;
    }
  };
  return {
    install() {
      browser.runtime.onConnect.addListener((port) => {
        if (port.name !== SESSION_PORT) return;
        const sender = port.sender;
        const role = sender ? callerRole(sender,browser.runtime.id,browser.runtime.getURL("/")) : null;
        if (!sender || !["content","reader","paste"].includes(role ?? "") || (role !== "paste" && (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId)))) {port.disconnect();return;}
        let record:Live | undefined;
        const timer=setTimeout(()=>{if(!record)port.disconnect();},SESSION_HANDSHAKE_MS);
        port.onDisconnect.addListener(()=>{clearTimeout(timer);if(record)retire(record);});
        port.onMessage.addListener((value) => {
          if (record) { onPortMessage?.(record, sender, value); return; }
          const parsed=v.safeParse(v.strictObject({session:SessionSchema}),value);
          // No tab may take every document's place: a page of a thousand tiny frames would
          // otherwise leave every other tab with none (PER_TAB_SESSIONS).
          const tabId=sender.tab?.id;
          const ofTab=tabId === undefined ? 0 : [...live.values()].filter((r)=>r.tabId===tabId && r.key!==frameKey(tabId,sender.frameId ?? 0)).length;
          if (!parsed.success || live.size >= 1024 || ofTab >= PER_TAB_SESSIONS) {port.disconnect();return;}
          clearTimeout(timer);
          const key=sender.tab?.id === undefined ? `page:${parsed.output.session}` : frameKey(sender.tab.id,sender.frameId ?? 0);
          const old=live.get(key); if(old)retire(old);
          const controller=new AbortController();
          const address=addressOf(sender)!;
          record={key,tabId:sender.tab?.id ?? -1,frameId:sender.frameId ?? 0,url:address,origin:new URL(address).origin,
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
    /** Where a session port's later messages go (the background's handler). */
    setPortHandler(handler:PortMessageHandler|null) {onPortMessage=handler;},
    /**
     * Whether a message that came on `record`'s port may be acted on: the document was allowed
     * when it sent it. It may have closed its port since — the page went, which is when such a
     * message is sent — but not had its access withdrawn (a revoked record says no).
     */
    async allowsPort(record:DocumentAccess, sender:AccessSender):Promise<boolean> {
      const live=record as Live;
      if (live.revoked || !sameDocument(record,sender,record.session)) return false;
      const role=callerRole(sender,browser.runtime.id,browser.runtime.getURL("/"));
      const one=once.get(frameKey(record.tabId,record.frameId));
      return role === "reader" || role === "paste" || (role === "content" && ((one !== undefined && sameDocument(one,sender,record.session)) || await granted(addressOf(sender)!)));
    },
    async authorize(sender:AccessSender,session:string|undefined):Promise<DocumentAccess|null> {
      if (!session) return null;
      const key=sender.tab?.id === undefined ? `page:${session}` : frameKey(sender.tab.id,sender.frameId ?? 0),record=live.get(key);
      if (!record || !sameDocument(record,sender,session) || record.signal.aborted) return null;
      const role=callerRole(sender,browser.runtime.id,browser.runtime.getURL("/"));
      const one=once.get(key);
      const allowed=role === "reader" || role === "paste" || (role === "content" && ((one && sameDocument(one,sender,session)) || await granted(addressOf(sender)!)));
      if (!allowed || record.signal.aborted || live.get(key)!==record) return null;
      return record;
    },
    /** A site was granted: read the grants again. A withdrawal comes through revoke(). */
    grantsAdded() {grants=undefined;},
    revoke(origins:readonly string[]) {
      grants=undefined;
      for(const [key,identity] of once) if(matchesAny(origins,identity.url))once.delete(key);
      for(const record of [...live.values()]) if(matchesAny(origins,record.url))retire(record,true);
    },
    /** The tab closed, or a new document committed in it (`graceMs`): its one-off grants end
     *  at once; its documents' sessions after `graceMs`, so the document that is leaving can
     *  still say its last on its port as it goes (the browser commits the next page before the
     *  old one's pagehide). A session the next document opened meanwhile is its own. */
    forget(tabId:number, graceMs=0) {
      for(const [key,identity] of once)if(identity.tabId===tabId)once.delete(key);
      const leaving=[...live.values()].filter((record)=>record.tabId===tabId);
      if (graceMs <= 0) { for(const record of leaving) retire(record); return; }
      setTimeout(()=>{ for(const record of leaving) retire(record); },graceMs);
    },
  };
}
export const documentAuthority = createDocumentAuthority();
