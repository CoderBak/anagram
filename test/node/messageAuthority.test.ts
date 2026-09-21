import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { createDocumentAuthority } from "../../lib/access/authority";
import { callerRole,parseWorkerMessage,permitsMessage,SESSION_PORT,type AccessSender } from "../../lib/access/messages";
import { ACTIONS } from "../../lib/messaging/protocol";

beforeEach(()=>{fakeBrowser.reset();vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function environment(origins:string[]=["https://top.test/*","https://frame.test/*"]) {
  let connect:(port:never)=>void=()=>{};
  vi.spyOn(fakeBrowser.runtime.onConnect,"addListener").mockImplementation((fn)=>{connect=fn as typeof connect;});
  vi.spyOn(fakeBrowser.permissions,"getAll").mockImplementation(async()=>({origins,permissions:[]}));
  const sent=vi.spyOn(fakeBrowser.tabs,"sendMessage").mockResolvedValue(undefined);
  const authority=createDocumentAuthority();authority.install();
  const open=(sender:AccessSender,session=crypto.randomUUID())=>{
    let receive:(v:unknown)=>void=()=>{},disconnect=()=>{};
    const port={name:SESSION_PORT,sender,onMessage:{addListener:(fn:typeof receive)=>receive=fn},onDisconnect:{addListener:(fn:typeof disconnect)=>disconnect=fn},postMessage:vi.fn(),disconnect:vi.fn(()=>disconnect())};
    connect(port as never);receive({session});return {session,port,close:()=>disconnect()};
  };
  return {authority,open,sent,withdraw:(origin:string)=>{origins=origins.filter((x)=>x!==origin);authority.revoke([origin]);}};
}
function sender(frameId=0,url="https://top.test/article",documentId:string|undefined="doc-top"):AccessSender {
  return {id:fakeBrowser.runtime.id,url,origin:new URL(url).origin,frameId,documentId,tab:{id:7,url:"https://top.test/article"}};
}
describe("document-scoped authorization",()=>{
  it("withdraws a cross-origin iframe immediately while retaining its granted parent",async()=>{
    const env=environment(),top=sender(),child=sender(3,"https://frame.test/embed","doc-child");
    const a=env.open(top),b=env.open(child);
    const parent=await env.authority.authorize(top,a.session),frame=await env.authority.authorize(child,b.session);
    expect(parent).not.toBeNull();expect(frame).not.toBeNull();
    env.withdraw("https://frame.test/*");
    expect(frame!.signal.aborted).toBe(true);expect(parent!.signal.aborted).toBe(false);
    expect(env.sent).toHaveBeenCalledWith(7,{action:ACTIONS.TEARDOWN},{frameId:3,documentId:"doc-child"});
    expect(await env.authority.authorize(child,b.session)).toBeNull();
    const renewed=env.open(child);expect(await env.authority.authorize(child,renewed.session)).toBeNull();
  });
  it("rejects another frame, document, origin or extension using a copied session",async()=>{
    const env=environment(),source=sender(),port=env.open(source);
    for(const forged of [{...source,frameId:2},{...source,documentId:"new"},{...source,url:"https://other.test/"},{...source,id:"foreign"}])
      expect(await env.authority.authorize(forged,port.session)).toBeNull();
  });
  it("binds activeTab to a Firefox document port, not a reusable tab or URL",async()=>{
    const env=environment([]),source=sender(0,"https://top.test/article",undefined),port=env.open(source);
    expect(await env.authority.authorize(source,port.session)).toBeNull();
    env.authority.grantOnce({tabId:7,frameId:0,url:source.url!,session:port.session});
    const granted=await env.authority.authorize(source,port.session);expect(granted).not.toBeNull();
    port.close();expect(granted!.signal.aborted).toBe(true);
    const reloaded=env.open(source);expect(await env.authority.authorize(source,reloaded.session)).toBeNull();
  });
  it("rejects a permission check that completes after revocation",async()=>{
    const env=environment(),source=sender(),port=env.open(source);
    let finish!:(value:{origins:string[];permissions:[]})=>void;
    vi.mocked(fakeBrowser.permissions.getAll).mockImplementation(()=>new Promise((r)=>finish=r));
    const pending=env.authority.authorize(source,port.session);
    env.authority.revoke(["https://top.test/*"]);finish({origins:["https://top.test/*"],permissions:[]});
    expect(await pending).toBeNull();
  });
  it("allows trusted pasted text without a tab, but not an arbitrary extension page",async()=>{
    const env=environment([]),paste={id:fakeBrowser.runtime.id,url:fakeBrowser.runtime.getURL("/paste.html")};
    const p=env.open(paste);expect(await env.authority.authorize(paste,p.session)).not.toBeNull();
    const reader={...paste,url:fakeBrowser.runtime.getURL("/unexpected.html")};
    expect(callerRole(reader,fakeBrowser.runtime.id,fakeBrowser.runtime.getURL("/"))).toBeNull();
  });
});
describe("worker message schema and roles",()=>{
  const score=()=>({action:ACTIONS.SCORE_BATCH,req:{v:"2.1",session:"scan",priority:"viewport",blocks:[{id:"one",text:"Paragraph"}]}});
  it("bounds requests before hashing or scheduling",()=>{
    expect(parseWorkerMessage(score())).not.toBeNull();
    for(const change of [{priority:"urgent"},{session:"x".repeat(65)},{blocks:Array.from({length:257},(_,i)=>({id:String(i),text:"x"}))},{blocks:[{id:"one",text:"x".repeat(16001)}]},{blocks:[{id:"one",text:"x"},{id:"one",text:"y"}]},{blocks:Array.from({length:17},(_,i)=>({id:String(i),text:"x".repeat(16000)}))}])
      expect(parseWorkerMessage({...score(),req:{...score().req,...change}})).toBeNull();
    expect(parseWorkerMessage({...score(),tabId:99})).toBeNull();
  });
  it("allows only Settings to mutate caches and only the popup to name a target tab",()=>{
    const clear=parseWorkerMessage({action:ACTIONS.CLEAR_CACHE})!,tab=parseWorkerMessage({action:ACTIONS.ANALYZE_TAB,tabId:99})!;
    for(const role of ["content","reader","popup","onboarding","paste"] as const)expect(permitsMessage(role,clear,sender())).toBe(false);
    expect(permitsMessage("options",clear,sender())).toBe(true);
    expect(permitsMessage("content",tab,sender())).toBe(false);expect(permitsMessage("popup",tab,sender())).toBe(true);
    const pdf=parseWorkerMessage({action:ACTIONS.OPEN_PDF_READER,url:"https://other.test/a.pdf",tabId:99})!;
    expect(permitsMessage("content",pdf,sender())).toBe(false);
  });
  it("allows local sources only in privileged reader/popup operations, never content announcements",()=>{
    const open=parseWorkerMessage({action:ACTIONS.OPEN_PDF_READER,tabId:7,url:"file:///tmp/book.pdf"})!;
    expect(open).not.toBeNull();expect(permitsMessage("popup",open,sender())).toBe(true);
    expect(permitsMessage("content",open,sender())).toBe(false);
    expect(parseWorkerMessage({action:ACTIONS.OPEN_PDF_READER,tabId:7,url:"file://server/share/book.pdf"})).toBeNull();
    expect(parseWorkerMessage({action:ACTIONS.PDF_TAB_OPENED,url:"file:///tmp/book.pdf",contentType:"application/pdf",protocol:"file:",navigationType:"navigate"})).toBeNull();
    const status=parseWorkerMessage({action:ACTIONS.GET_PDF_STATUS,tabId:7})!;
    expect(permitsMessage("popup",status,sender())).toBe(true);expect(permitsMessage("content",status,sender())).toBe(false);
  });
  it("rejects subframe badge writes and PDF announcements that differ from the sender",()=>{
    const msg=parseWorkerMessage({action:ACTIONS.PDF_TAB_OPENED,url:"https://top.test/file.pdf",contentType:"application/pdf",protocol:"https:",navigationType:"navigate"})!;
    expect(permitsMessage("content",msg,sender())).toBe(false);
    expect(permitsMessage("content",parseWorkerMessage({action:ACTIONS.UPDATE_BADGE,flagged:2})!,sender(2))).toBe(false);
    for(const flagged of [-1,0.1,NaN,Infinity])expect(parseWorkerMessage({action:ACTIONS.UPDATE_BADGE,flagged})).toBeNull();
  });
});
