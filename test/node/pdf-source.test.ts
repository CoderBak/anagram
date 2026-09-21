import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { safePdfSource } from "../../lib/pdf/source";
import { loaderConnectPolicy, readAuthorizedPdf } from "../../lib/pdf/loader";
import { createSourceBroker, SOURCE_CAP, SOURCE_CLAIM_PORT, SOURCE_LOADER_PORT } from "../../lib/pdf/sourceTransfer";
import { hasPdfSourceAccess } from "../../lib/pdf/sourceAccess";
vi.mock("../../lib/pdf/sourceAccess", () => ({hasPdfSourceAccess: vi.fn(async () => true)}));
const ticks = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
beforeEach(() => { fakeBrowser.reset(); vi.mocked(hasPdfSourceAccess).mockResolvedValue(true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function port(name: string, sender: unknown) {
  const messages: ((v: unknown) => void)[] = [], closes: (() => void)[] = [];
  let closed = false;
  const p = {name, sender, postMessage: vi.fn(), disconnect: vi.fn(() => { if (!closed) { closed = true; for (const f of closes) f(); } }),
    onMessage: {addListener: (f: (v: unknown) => void) => messages.push(f)}, onDisconnect: {addListener: (f: () => void) => closes.push(f)}};
  return {port: p, send: (value: unknown) => messages.forEach((f) => f(value))};
}
function setup() {
  vi.useFakeTimers();
  let connect = (_: never) => {}, navigate = (_: never) => {}, commit = (_: never) => {}, revoke = () => {}, updated = (_id:number,_change:never) => {};
  let current = "https://example.test/document", readerDocument = "reader-1", childParent = 0;
  const frames = new Map<number, string>();
  vi.spyOn(fakeBrowser.runtime.onConnect, "addListener").mockImplementation((f) => { connect = f as never; });
  vi.spyOn(fakeBrowser.webNavigation.onCommitted,"addListener").mockImplementation((f)=>{commit=f as never;});
  vi.spyOn(fakeBrowser.webNavigation.onBeforeNavigate, "addListener").mockImplementation((f) => { navigate = f as never; });
  vi.spyOn(fakeBrowser.tabs.onUpdated,"addListener").mockImplementation((f)=>{updated=f as never;});
  vi.spyOn(fakeBrowser.permissions.onRemoved, "addListener").mockImplementation((f) => { revoke = f as never; });
  vi.spyOn(fakeBrowser.tabs, "get").mockImplementation((async (id: number) => ({id, url: current})) as never);
  const update = vi.spyOn(fakeBrowser.tabs, "update").mockImplementation((async (id: number, details: {url: string}) => {
    current = details.url; navigate({tabId: id, frameId: 0, url: current} as never); navigate({tabId: id, frameId: 0, url: current} as never); commit({tabId:id,frameId:0,url:current} as never); return {id, url: current};
  }) as never);
  vi.spyOn(fakeBrowser.webNavigation, "getFrame").mockImplementation((async ({frameId}: {frameId: number}) =>
    frameId === 0 ? {url: current, parentFrameId: -1, documentId: readerDocument} : {url: frames.get(frameId), parentFrameId: childParent, documentId: "loader-1"}) as never);
  const broker = createSourceBroker((src) => `${fakeBrowser.runtime.getURL("/reader.html")}?src=${encodeURIComponent(src)}`); broker.serve();
  const reader = (overrides = {}) => {
    const p = port(SOURCE_CLAIM_PORT, {id: fakeBrowser.runtime.id, tab: {id: 7}, frameId: 0, documentId: "reader-1", url: current, ...overrides});
    connect(p.port as never); p.send({ticket: new URL(current).searchParams.get("ticket")}); return p;
  };
  let proof = "";
  const loader = (key: string, overrides = {}, providedProof = proof) => {
    const url = `${fakeBrowser.runtime.getURL("/pdf-loader.html")}?ticket=${key}`; frames.set(2, url);
    const p = port(SOURCE_LOADER_PORT, {id: fakeBrowser.runtime.id, tab: {id: 7}, frameId: 2, documentId: "loader-1", url, ...overrides});
    connect(p.port as never); p.send({ticket: key, proof: providedProof}); return p;
  };
  return {broker, update, reader, loader, revoke, loading:()=>updated(7,{status:"loading"} as never), complete:()=>updated(7,{status:"complete"} as never), proof: (value: string) => {proof = value;}, current: () => current, move: (url: string) => { current = url; navigate({tabId: 7, frameId: 0, url} as never); },
    document: (id: string) => { readerDocument = id; }, parent: (id: number) => { childParent = id; }};
}

describe("private PDF source tickets", () => {
  it("discloses only the exact source to an iframe of the live, same-tab reader", async () => {
    const e = setup(); await e.broker.open(7, "https://example.test/document");
    const owner = e.reader(); await ticks();
    const key = owner.port.postMessage.mock.calls[0][0].load; e.proof(owner.port.postMessage.mock.calls[0][0].proof);
    expect(owner.port.postMessage).toHaveBeenCalledWith({load: key, proof: expect.stringMatching(/^[a-f0-9]{32}$/)});
    const child = e.loader(key); await ticks();
    expect(child.port.postMessage).toHaveBeenCalledWith({source: "https://example.test/document", cap: SOURCE_CAP});
    owner.port.disconnect(); expect(child.port.disconnect).toHaveBeenCalled();
  });
  it.each([{tab: {id: 8}}, {frameId: 2}, {id: "other-extension"}, {documentId: "stale"}])("refuses forged or stale reader identity %j", async (identity) => {
    const e = setup(); await e.broker.open(7, "https://example.test/document");
    const owner = e.reader(identity); await ticks();
    expect(owner.port.postMessage).not.toHaveBeenCalled(); expect(owner.port.disconnect).toHaveBeenCalled();
  });
  it("consumes the reader ticket once and requires direct-parent iframe identity", async () => {
    const e = setup(); await e.broker.open(7, "https://example.test/document");
    const owner = e.reader(); await ticks(); const key = owner.port.postMessage.mock.calls[0][0].load; e.proof(owner.port.postMessage.mock.calls[0][0].proof);
    const replay = e.reader(); await ticks(); expect(replay.port.postMessage).not.toHaveBeenCalled();
    e.parent(1); const child = e.loader(key); await ticks();
    expect(child.port.postMessage).not.toHaveBeenCalled(); expect(child.port.disconnect).toHaveBeenCalled();
  });
  it("revokes unclaimed tickets on a reload of the same reader URL", async () => {
    const e = setup(); await e.broker.open(7, "https://example.test/document");
    e.move(e.current()); const owner = e.reader(); await ticks(); expect(owner.port.postMessage).not.toHaveBeenCalled();
  });
  it("aborts an active loader when its source permission is withdrawn", async () => {
    const e = setup(); await e.broker.open(7, "https://example.test/document");
    const owner = e.reader(); await ticks(); e.proof(owner.port.postMessage.mock.calls[0][0].proof); const child = e.loader(owner.port.postMessage.mock.calls[0][0].load); await ticks();
    vi.mocked(hasPdfSourceAccess).mockResolvedValue(false); e.revoke(); await ticks();
    expect(child.port.disconnect).toHaveBeenCalled(); expect(owner.port.disconnect).toHaveBeenCalled();
  });
  it("invalidates a pre-claim reload even when extension navigation details are hidden", async () => {
    const e=setup();await e.broker.open(7,"https://example.test/document");
    e.loading();e.complete();e.loading(); const owner=e.reader();await ticks();expect(owner.port.postMessage).not.toHaveBeenCalled();
  });
  it("allows duplicate loading events for one normal extension navigation", async () => {
    const e=setup();await e.broker.open(7,"https://example.test/document");
    e.loading();e.loading();e.complete();const owner=e.reader();await ticks();
    expect(owner.port.postMessage).toHaveBeenCalledWith({load:expect.any(String),proof:expect.any(String)});
  });
  it("uses a separate parent proof when Chromium hides extension URL/frame metadata", async () => {
    const e = setup(); await e.broker.open(7, "https://example.test/document");
    vi.spyOn(fakeBrowser.tabs, "get").mockResolvedValue({id:7} as never);
    vi.spyOn(fakeBrowser.webNavigation, "getFrame").mockResolvedValue(null);
    const owner=e.reader(); await ticks(); const reply=owner.port.postMessage.mock.calls[0][0];
    const forged=e.loader(reply.load,{},"0".repeat(32)); await ticks(); expect(forged.port.postMessage).not.toHaveBeenCalled();
    e.proof(reply.proof);const child=e.loader(reply.load);await ticks();
    expect(child.port.postMessage).toHaveBeenCalledWith({source:"https://example.test/document",cap:SOURCE_CAP});
  });
  it("cannot open a source other than the currently displayed document or without permission", async () => {
    const e = setup(); await e.broker.open(7, "https://example.test/secret.pdf"); expect(e.update).not.toHaveBeenCalled();
    vi.mocked(hasPdfSourceAccess).mockResolvedValue(false); await e.broker.open(7, "https://example.test/document"); expect(e.update).not.toHaveBeenCalled();
  });
  it("bounds all pending/active source transfers to one, and expires them", async () => {
    const e = setup(); await e.broker.open(7, "https://example.test/document");
    vi.spyOn(fakeBrowser.tabs, "get").mockResolvedValueOnce({id: 8, url: "https://example.test/second.pdf"} as never);
    expect(await e.broker.open(8, "https://example.test/second.pdf")).toEqual({ok: false, error: "busy"}); expect(e.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_001); const owner = e.reader(); await ticks(); expect(owner.port.postMessage).not.toHaveBeenCalled();
  });
});

describe("authorized source reads", () => {
  it.each(["file://server/share/file.pdf", "file:////server/share/file.pdf", "file:///%5c%5cserver/share/file.pdf", "ftp://example.test/a.pdf", "https://u:p@example.test/a.pdf", "data:application/pdf,secret"])("rejects nonlocal or unsafe source %s", (url) => {
    expect(safePdfSource(url)).toBeNull(); expect(loaderConnectPolicy(url)).toBeNull();
  });
  it("narrows network CSP to the authorized origin, or local file scheme", () => {
    expect(loaderConnectPolicy("https://example.test:8443/private/document?q=1")).toBe("connect-src https://example.test:8443");
    expect(loaderConnectPolicy("file:///tmp/a.pdf")).toBe("connect-src file:");
  });
  it("uses one credentialed exact GET and refuses redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(bytes)); vi.stubGlobal("fetch", fetch);
    expect(await readAuthorizedPdf("https://example.test/paper#page=2", new AbortController().signal)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith("https://example.test/paper", expect.objectContaining({credentials: "include", redirect: "error", referrerPolicy: "no-referrer"}));
    const redirected = new Response(bytes); Object.defineProperty(redirected, "redirected", {value: true}); fetch.mockResolvedValue(redirected);
    await expect(readAuthorizedPdf("https://example.test/paper", new AbortController().signal)).rejects.toThrow("read");
  });
  it("rejects oversized, non-PDF and aborted responses", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(bytes)); vi.stubGlobal("fetch", fetch);
    await expect(readAuthorizedPdf("https://example.test/paper", new AbortController().signal, 5)).rejects.toThrow("large");
    fetch.mockResolvedValue(new Response("login required"));
    await expect(readAuthorizedPdf("https://example.test/paper", new AbortController().signal)).rejects.toThrow("type");
    await expect(readAuthorizedPdf("https://example.test/paper", AbortSignal.abort())).rejects.toThrow("read");
  });
});

describe("bounded local-file XHR", () => {
  function xhrFixture() {
    let xhr: FakeXhr;
    class FakeXhr {
      status=0; response: ArrayBuffer=bytes.slice().buffer; responseURL="file:///tmp/book.pdf";
      responseType=""; timeout=0; onprogress?: (event: {loaded:number;total:number;lengthComputable:boolean})=>void;
      onload?:()=>void; onabort?:()=>void; onerror?:()=>void; ontimeout?:()=>void;
      open=vi.fn(); send=vi.fn(); abort=vi.fn(()=>this.onabort?.());
      constructor(){xhr=this;}
    }
    vi.stubGlobal("XMLHttpRequest",FakeXhr);
    const controller=new AbortController();const result=readAuthorizedPdf("file:///tmp/book.pdf",controller.signal,128);
    return {xhr:xhr!,controller,result};
  }
  it("reads only the authorized local URL and validates its PDF bytes",async()=>{
    const {xhr,result}=xhrFixture();expect(xhr.open).toHaveBeenCalledWith("GET","file:///tmp/book.pdf",true);
    xhr.onload!();expect(await result).toEqual(bytes);
  });
  it("aborts as soon as progress exceeds the cap",async()=>{
    const {xhr,result}=xhrFixture();xhr.onprogress!({loaded:129,total:0,lengthComputable:false});
    await expect(result).rejects.toThrow("large");expect(xhr.abort).toHaveBeenCalledOnce();
  });
  it("honors cancellation and rejects a changed response URL",async()=>{
    const first=xhrFixture();first.controller.abort();await expect(first.result).rejects.toThrow("read");
    const second=xhrFixture();second.xhr.responseURL="file:///tmp/other.pdf";second.xhr.onload!();
    await expect(second.result).rejects.toThrow("read");
  });
});
