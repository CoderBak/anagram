// test/node/pdf-handoff.test.ts — the rules of the PDF handoff, without a browser.
//
// lib/pdf/handoff.ts is what replaced the reading mode's own `fetch(?src=)`. Three of its
// four parts are plain functions over their inputs and belong here: the bytes-as-JSON
// encoding both hops use, the read out of the tab (over an injected `fetch`, so nothing
// here goes near a network), and the worker's ticket store. The fourth — two ports and a
// tab navigation — is checked in a real browser by test/pdf-route-check.mjs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import {
  base64Bytes,
  createPdfHandoff,
  createTicketStore,
  fromBase64,
  newTicket,
  streamPdfBytes,
  toBase64,
  CHUNK_BYTES,
  createHandoffBudget,
  readPdfFromTab,
  claimPdfBytes,
  validatedChunkBytes,
  PDF_CLAIM_PORT,
  MAX_HANDOFF_BYTES,
} from "../../lib/pdf/handoff";
import { hasPdfMagic } from "../../lib/pdf/sourceTransfer";

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** A response whose body arrives in the pieces given, as the network really delivers one. */
function streamed(pieces: Uint8Array[], init: { status?: number; length?: number | null } = {}): Response {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers();
  const stated = init.length === undefined ? pieces.reduce((n, p) => n + p.byteLength, 0) : init.length;
  if (stated !== null) headers.set("content-length", String(stated));
  const response = new Response(body, { status: init.status ?? 200, headers });
  Object.defineProperty(response, "wasCancelled", { get: () => cancelled });
  return response;
}

/** A PDF-shaped body of `bytes` bytes: the header, then filler. */
const pdfOf = (bytes: number): Uint8Array => latin1("%PDF-1.7\n" + "x".repeat(Math.max(0, bytes - 9)));

/** Collect what a stream hands over, the way the port on the other side would. */
async function collect(response: Response, cap: number): Promise<{ result: unknown; bytes: Uint8Array }> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const chunks: string[] = [];
  const result = await streamPdfBytes("https://example.test/a.pdf", (c) => chunks.push(c), { cap });
  const size = chunks.reduce((n, c) => n + base64Bytes(c), 0);
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) at += fromBase64(chunk, bytes, at);
  return { result, bytes };
}

beforeEach(()=>fakeBrowser.reset());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bytes as JSON", () => {
  it("survives the round trip, whatever the length modulo three", () => {
    for (const size of [0, 1, 2, 3, 4, 5, 255, 1000, 1001, 1002]) {
      const source = new Uint8Array(size);
      for (let i = 0; i < size; i++) source[i] = (i * 37 + 11) & 255;
      const text = toBase64(source);
      const back = new Uint8Array(size);
      expect(fromBase64(text, back, 0)).toBe(size);
      expect([...back]).toEqual([...source]);
      expect(base64Bytes(text)).toBe(size);
    }
  });

  it("carries every byte value, not just the ones a string survives", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const back = new Uint8Array(256);
    fromBase64(toBase64(all), back, 0);
    expect([...back]).toEqual([...all]);
  });

  it("encodes a chunk larger than the argument limit of String.fromCharCode", () => {
    const big = new Uint8Array(CHUNK_BYTES).fill(0xab);
    const back = new Uint8Array(CHUNK_BYTES);
    fromBase64(toBase64(big), back, 0);
    expect(back.every((b) => b === 0xab)).toBe(true);
  });
});

describe("what counts as a PDF", () => {
  it("takes the header at the start, and anywhere in the first kilobyte", () => {
    expect(hasPdfMagic(latin1("%PDF-1.4\nrest"))).toBe(true);
    expect(hasPdfMagic(latin1("\n".repeat(900) + "%PDF-1.4"))).toBe(true);
  });

  it("does not go looking past that, and is not fooled by a page that says so", () => {
    expect(hasPdfMagic(latin1("\n".repeat(2000) + "%PDF-1.4"))).toBe(false);
    expect(hasPdfMagic(latin1("<!doctype html><title>Sign in to read this PDF</title>"))).toBe(false);
    expect(hasPdfMagic(new Uint8Array(0))).toBe(false);
  });
});

describe("reading the document out of the tab", () => {
  it("hands over every byte, in order", async () => {
    const source = pdfOf(CHUNK_BYTES * 2 + 1234);
    const pieces = [source.subarray(0, 7777), source.subarray(7777, 400_000), source.subarray(400_000)];
    const { result, bytes } = await collect(streamed(pieces), 10 * 1024 * 1024);
    expect(result).toEqual({ ok: true, bytes: source.byteLength });
    expect(bytes.byteLength).toBe(source.byteLength);
    expect([...bytes.subarray(0, 9)]).toEqual([...source.subarray(0, 9)]);
    expect([...bytes.subarray(-9)]).toEqual([...source.subarray(-9)]);
  });

  it("refuses a stated length over the cap before a byte of the body is read", async () => {
    const response = streamed([pdfOf(64)], { length: 200 * 1024 * 1024 });
    const { result, bytes } = await collect(response, 1024);
    expect(result).toEqual({ ok: false, failure: "large" });
    expect(bytes.byteLength).toBe(0);
    expect((response as unknown as { wasCancelled: boolean }).wasCancelled).toBe(true);
  });

  it("stops at the cap on a body that never said how long it was", async () => {
    // Six chunks offered, a cap of two and a half: the rest is never read, which is the
    // whole point — the old reader bought the entire file and THEN measured it.
    const pieces = Array.from({ length: 6 }, (_, i) =>
      i === 0 ? pdfOf(CHUNK_BYTES) : new Uint8Array(CHUNK_BYTES).fill(i),
    );
    const response = streamed(pieces, { length: null });
    const { result, bytes } = await collect(response, CHUNK_BYTES * 2.5);
    expect(result).toEqual({ ok: false, failure: "large" });
    expect(bytes.byteLength).toBeLessThanOrEqual(CHUNK_BYTES * 3);
    expect((response as unknown as { wasCancelled: boolean }).wasCancelled).toBe(true);
  });

  it("refuses a body that is not a PDF, however it was labelled", async () => {
    const html = latin1("<!doctype html><html><body>Please sign in to download this file.</body></html>");
    const { result } = await collect(streamed([html]), 1024 * 1024);
    expect(result).toEqual({ ok: false, failure: "type" });
  });

  it("cancels the source stream when its receiver rejects a chunk", async () => {
    const response = streamed([pdfOf(CHUNK_BYTES), new Uint8Array(CHUNK_BYTES)]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const send = vi.fn().mockRejectedValue(new Error("receiver closed"));
    expect(await streamPdfBytes("https://example.test/a.pdf", send, {cap: CHUNK_BYTES * 3}))
      .toEqual({ok:false,failure:"read"});
    expect(send).toHaveBeenCalledOnce();
    expect((response as unknown as {wasCancelled:boolean}).wasCancelled).toBe(true);
  });

  it("refuses an empty body and an error status", async () => {
    expect((await collect(streamed([new Uint8Array(0)]), 1024)).result).toEqual({ ok: false, failure: "type" });
    expect((await collect(streamed([pdfOf(64)], { status: 404 }), 1024)).result).toEqual({
      ok: false,
      failure: "read",
    });
  });

  it("says so when the request never happened at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const out = await streamPdfBytes("https://example.test/a.pdf", () => undefined, { cap: 1024 });
    expect(out).toEqual({ ok: false, failure: "read" });
  });

  it("asks for the document the way the tab already has it", async () => {
    const fetcher = vi.fn().mockResolvedValue(streamed([pdfOf(64)]));
    vi.stubGlobal("fetch", fetcher);
    await streamPdfBytes("https://example.test/a.pdf", () => undefined, { cap: 1024 });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "include", cache: "force-cache" });
  });
});

describe("the worker's ticket store", () => {
  it("gives the bytes to the tab they were read for, once", () => {
    const store = createTicketStore();
    const ticket = store.hold(7, [latin1("abc")], 3);
    expect(store.size()).toBe(1);
    expect(store.take(ticket!, 9)).toBeNull(); // another tab: not its document
    expect(store.take(ticket!, 7)?.bytes).toBe(3);
    expect(store.take(ticket!, 7)).toBeNull(); // spent
    expect(store.size()).toBe(0);
  });

  it("makes a ticket nobody can guess, and no two alike", () => {
    const tickets = new Set(Array.from({ length: 200 }, () => newTicket()));
    expect(tickets.size).toBe(200);
    for (const ticket of tickets) expect(ticket).toMatch(/^[0-9a-f]{32}$/);
  });

  it("drops a document no reader ever came for", () => {
    vi.useFakeTimers();
    const store = createTicketStore(1000);
    const ticket = store.hold(7, [latin1("abc")], 3);
    vi.advanceTimersByTime(1001);
    expect(store.take(ticket!, 7)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("lets go of everything a closed tab was holding", () => {
    const store = createTicketStore();
    store.hold(7, [latin1("a")], 1);
    store.hold(7, [latin1("b")], 1);
    const other = store.hold(8, [latin1("c")], 1);
    store.forget(7);
    expect(store.size()).toBe(1);
    expect(store.take(other!, 8)?.bytes).toBe(1);
  });
});

// ---- the wiring the browser suites cannot reach ------------------------------------------------
//
// Site access is optional, and the one case that matters most here — a PDF on a site the
// user has granted NOTHING, opened from the popup or the context menu — cannot be driven
// by a suite: `activeTab` is granted by a real click on real browser chrome, and the
// browser suites load a build where every site is granted instead (test/test-build.mjs).
// So what is pinned here is the ORDER: the tab is never asked for bytes before something
// has been done about putting a content script in it. docs/manual-checks.md has the rest.

describe("asking a tab with no content script in it", () => {
  it("tries to inject before it asks, and says so when nobody answers", async () => {
    const calls: string[] = [];
    const updated: { tabId: number; url: string }[] = [];
    const handoff = createPdfHandoff({
      readerUrl: (src) => `chrome-extension://x/reader.html?src=${encodeURIComponent(src)}`,
      ensureInjected: async (tabId) => {
        calls.push(`inject ${tabId}`);
        return true;
      },
    });
    const tabs = fakeBrowser.tabs;
    vi.spyOn(tabs,"get").mockImplementation((async (id:number)=>({id,url:`https://example.test/${id===7 ? "a" : id===8 ? "b" : "c"}.pdf`})) as never);
    vi.spyOn(tabs, "connect").mockImplementation(((tabId: number) => {
      calls.push(`connect ${tabId}`);
      throw new Error("no receiving end");
    }) as never);
    vi.spyOn(tabs, "update").mockImplementation((async (tabId: number, props: { url: string }) => {
      updated.push({ tabId, url: props.url });
      return {} as never;
    }) as never);

    await handoff.open(7, "https://example.test/a.pdf", { auto: false });
    expect(calls).toEqual(["inject 7", "connect 7"]);
    // An explicit click is answered: the reading mode opens and says what happened.
    expect(updated).toHaveLength(1);
    expect(updated[0].url).toMatch(/&err=read$/);

    // The automatic route is not a click, so a tab it cannot read is left exactly as it is.
    updated.length = 0;
    await handoff.open(8, "https://example.test/b.pdf", { auto: true });
    expect(updated).toEqual([]);
  });

  it("reads a tab once, however many things ask at the same moment", async () => {
    const calls: number[] = [];
    const handoff = createPdfHandoff({
      readerUrl: (src) => `chrome-extension://x/reader.html?src=${encodeURIComponent(src)}`,
      // Slow on purpose: the second caller arrives while the first is still injecting,
      // which is exactly what happens when a click injects a script that then announces
      // the tab and sets the automatic route going too.
      ensureInjected: async (tabId) => {
        calls.push(tabId);
        await new Promise((r) => setTimeout(r, 10));
        return true;
      },
    });
    const tabs = fakeBrowser.tabs;
    vi.spyOn(tabs,"get").mockImplementation((async (id:number)=>({id,url:`https://example.test/${id===7 ? "a" : id===8 ? "b" : "c"}.pdf`})) as never);
    vi.spyOn(tabs, "connect").mockImplementation((() => {
      throw new Error("no receiving end");
    }) as never);
    vi.spyOn(tabs, "update").mockImplementation((async () => ({}) as never) as never);

    await Promise.all([
      handoff.open(9, "https://example.test/c.pdf", { auto: false }),
      handoff.open(9, "https://example.test/c.pdf", { auto: true }),
    ]);
    expect(calls).toEqual([9]);
  });
});

function mockPort(sender?:unknown) {
  let receive:(value:unknown)=>void=()=>{},disconnect=()=>{};
  const port={sender,name:PDF_CLAIM_PORT,postMessage:vi.fn(),disconnect:vi.fn(()=>disconnect()),
    onMessage:{addListener:(fn:typeof receive)=>receive=fn},onDisconnect:{addListener:(fn:typeof disconnect)=>disconnect=fn}};
  return {port,receive:(value:unknown)=>receive(value),disconnect:()=>disconnect()};
}
const ticks=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
describe("PDF chunk validation and backpressure",()=>{
  it.each(["bad!","YQ=","Y===","", "A".repeat(Math.ceil(CHUNK_BYTES/3)*4+4)])("refuses malformed or oversized encoded chunks",(value)=>{
    expect(validatedChunkBytes(value)).toBeNull();
  });
  it("does not silently decode past the destination buffer",()=>{
    expect(()=>fromBase64("YWJj",new Uint8Array(2),0)).toThrow();
    expect(()=>fromBase64("YWJj",new Uint8Array(3),-1)).toThrow();
  });
  it("waits for the receiver before reading/sending the next stream chunk",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(streamed([pdfOf(CHUNK_BYTES*2)])));
    let release!:()=>void;const send=vi.fn(()=>new Promise<void>((resolve)=>release=resolve));
    const done=streamPdfBytes("https://example.test/a.pdf",send,{cap:CHUNK_BYTES*3});
    await ticks();expect(send).toHaveBeenCalledTimes(1);
    release();await ticks();expect(send).toHaveBeenCalledTimes(2);
    release();expect(await done).toEqual({ok:true,bytes:CHUNK_BYTES*2});
  });
  it("acks validated chunks and rejects a forged final byte count",async()=>{
    const p=mockPort();vi.spyOn(fakeBrowser.tabs,"connect").mockReturnValue(p.port as never);
    const result=readPdfFromTab(7,"https://example.test/a.pdf");
    p.receive({chunk:toBase64(pdfOf(64)),seq:0});expect(p.port.postMessage).toHaveBeenLastCalledWith({ack:1});
    p.receive({done:true,bytes:63});expect(await result).toEqual({ok:false,failure:"read"});
  });
  it("rejects duplicate or out-of-order chunks without adding them",async()=>{
    const p=mockPort();vi.spyOn(fakeBrowser.tabs,"connect").mockReturnValue(p.port as never);
    const result=readPdfFromTab(7,"https://example.test/a.pdf");
    p.receive({chunk:toBase64(pdfOf(64)),seq:1});expect(await result).toEqual({ok:false,failure:"read"});
    expect(p.port.postMessage).toHaveBeenCalledTimes(1);
  });
  it.each([Infinity,-1,0,1.5,MAX_HANDOFF_BYTES+1])("rejects invalid reader allocation %s",async(bytes)=>{
    const p=mockPort();vi.spyOn(fakeBrowser.runtime,"connect").mockReturnValue(p.port as never);
    const result=claimPdfBytes("a".repeat(32));p.receive({bytes});expect(await result).toEqual({failure:"read"});
  });
  it("does not accept overflow or an incomplete reader payload",async()=>{
    const p=mockPort();vi.spyOn(fakeBrowser.runtime,"connect").mockReturnValue(p.port as never);
    const result=claimPdfBytes("a".repeat(32));p.receive({bytes:5});p.receive({chunk:toBase64(pdfOf(64)),seq:0});
    expect(await result).toEqual({failure:"read"});
  });
});
describe("PDF global resource budget",()=>{
  it("counts pending tickets and active transfers together, and releases every reservation once",()=>{
    vi.useFakeTimers();const budget=createHandoffBudget(6,2),store=createTicketStore(100,budget);
    const first=budget.start()!,second=budget.start()!;expect(budget.start()).toBeNull();
    const one=store.hold(1,[latin1("abc")],3),two=store.hold(2,[latin1("def")],3);
    expect(one).not.toBeNull();expect(two).not.toBeNull();expect(budget.bytes()).toBe(6);
    expect(store.hold(3,[latin1("a")],1)).toBeNull();
    expect(store.take(one!,undefined)).toBeNull();
    const claimed=store.take(one!,1)!;expect(budget.bytes()).toBe(6);
    claimed.release();claimed.release();expect(budget.bytes()).toBe(3);
    vi.advanceTimersByTime(101);expect(budget.bytes()).toBe(0);
    first();second();expect(budget.active()).toBe(0);
  });
  it("holds a document in the decoded bytes the budget counts, not in base64 a third larger",async()=>{
    const budget=createHandoffBudget(),body=pdfOf(CHUNK_BYTES+64);
    const p=mockPort();vi.spyOn(fakeBrowser.tabs,"connect").mockReturnValue(p.port as never);
    const result=readPdfFromTab(7,"https://example.test/a.pdf",{lease:budget.lease()});
    p.receive({chunk:toBase64(body.subarray(0,CHUNK_BYTES)),seq:0});p.receive({chunk:toBase64(body.subarray(CHUNK_BYTES)),seq:1});
    p.receive({done:true,bytes:body.length});
    const got=await result;if(!got.ok)throw new Error(got.failure);
    expect(got.chunks.map((c)=>c.byteLength)).toEqual([CHUNK_BYTES,64]);expect(budget.bytes()).toBe(body.length);
    expect(Buffer.concat(got.chunks)).toEqual(Buffer.from(body));
  });
  it("says a document under the cap is waiting on other tabs, not that it is too large",async()=>{
    const budget=createHandoffBudget(CHUNK_BYTES*3),other=budget.lease();other.grow(CHUNK_BYTES*2);
    const p=mockPort();vi.spyOn(fakeBrowser.tabs,"connect").mockReturnValue(p.port as never);
    const result=readPdfFromTab(7,"https://example.test/a.pdf",{lease:budget.lease()}),body=pdfOf(CHUNK_BYTES*2);
    p.receive({chunk:toBase64(body.subarray(0,CHUNK_BYTES)),seq:0});p.receive({chunk:toBase64(body.subarray(CHUNK_BYTES)),seq:1});
    expect(await result).toEqual({ok:false,failure:"busy"});
  });
  it("rejects malformed ticket contents and mismatched byte totals",()=>{
    const store=createTicketStore();expect(store.hold(1,["abc" as never],3)).toBeNull();expect(store.hold(1,[new Uint8Array(CHUNK_BYTES+1)],CHUNK_BYTES+1)).toBeNull();expect(store.hold(1,[latin1("abc")],4)).toBeNull();
  });
});
describe("PDF sender and navigation binding",()=>{
  async function setup() {
    const src="https://example.test/a.pdf";let current=src;
    let incoming:(port:never)=>void=()=>{},updated:(tabId:number,change:{status:string})=>void=()=>{},navigation:(value:never)=>void=()=>{},commit:(value:never)=>void=()=>{},revoke:(value:never)=>void=()=>{};
    vi.spyOn(fakeBrowser.runtime.onConnect,"addListener").mockImplementation((fn)=>{incoming=fn as typeof incoming;});
    vi.spyOn(fakeBrowser.tabs.onUpdated,"addListener").mockImplementation((fn)=>{updated=fn as typeof updated;});
    vi.spyOn(fakeBrowser.permissions.onRemoved,"addListener").mockImplementation((fn)=>{revoke=fn as never;});
    vi.spyOn(fakeBrowser.webNavigation.onCommitted,"addListener").mockImplementation((fn)=>{commit=fn as never;});
    vi.spyOn(fakeBrowser.webNavigation.onBeforeNavigate,"addListener").mockImplementation((fn)=>{navigation=fn as never;});
    vi.spyOn(fakeBrowser.webNavigation,"getFrame").mockImplementation((async()=>({url:current,documentId:"reader-1"})) as never);
    vi.spyOn(fakeBrowser.tabs,"get").mockImplementation((async()=>({id:7,url:current})) as never);
    const update=vi.spyOn(fakeBrowser.tabs,"update").mockImplementation((async(_id:number,value:{url:string})=>{current=value.url;navigation({tabId:7,frameId:0,url:current} as never);commit({tabId:7,frameId:0,url:current} as never);return {};}) as never);
    const source=mockPort();vi.spyOn(fakeBrowser.tabs,"connect").mockReturnValue(source.port as never);
    const handoff=createPdfHandoff({readerUrl:(url)=>`${fakeBrowser.runtime.getURL("/reader.html")}?src=${encodeURIComponent(url)}`});handoff.serve();
    return {src,source,handoff,update,move:(url:string)=>{current=url;},url:()=>current,connect:(port:unknown)=>incoming(port as never),reload:()=>updated(7,{status:"loading"}),navigate:()=>navigation({tabId:7,frameId:0,url:current} as never),revoke:()=>revoke({origins:["https://example.test/*"]} as never)};
  }
  it("never replaces a page navigated away while its PDF read was pending",async()=>{
    const e=await setup(),done=e.handoff.open(7,e.src,{auto:false});await ticks();
    e.move("https://other.test/new-page");e.source.receive({failure:"read"});await done;
    expect(e.update).not.toHaveBeenCalled();
  });
  it("does not overwrite a reload of the same PDF URL",async()=>{
    const e=await setup(),done=e.handoff.open(7,e.src,{auto:false});await ticks();
    e.reload();await done;expect(e.update).not.toHaveBeenCalled();
  });
  it.each(["revoke","navigate"] as const)("drops held bytes when authorization ends before claim: %s",async(change)=>{
    const e=await setup(),done=e.handoff.open(7,e.src,{auto:false});await ticks();
    e.source.receive({chunk:toBase64(pdfOf(64)),seq:0});e.source.receive({done:true,bytes:64});await done;
    const reader=e.url(),ticket=new URL(reader).searchParams.get("ticket")!;e[change]();
    const p=mockPort({id:fakeBrowser.runtime.id,url:reader,frameId:0,documentId:"reader-1",tab:{id:7}});
    e.connect(p.port);p.receive({ticket});await ticks();
    expect(p.port.postMessage).not.toHaveBeenCalledWith({bytes:64});
  });
  it("ends an in-flight byte claim on permission withdrawal",async()=>{
    const e=await setup(),done=e.handoff.open(7,e.src,{auto:false});await ticks();
    e.source.receive({chunk:toBase64(pdfOf(64)),seq:0});e.source.receive({done:true,bytes:64});await done;
    const reader=e.url(),ticket=new URL(reader).searchParams.get("ticket")!;
    const p=mockPort({id:fakeBrowser.runtime.id,url:reader,frameId:0,documentId:"reader-1",tab:{id:7}});
    e.connect(p.port);p.receive({ticket});await ticks();expect(p.port.postMessage).toHaveBeenCalledWith({bytes:64});
    e.revoke();expect(p.port.disconnect).toHaveBeenCalled();p.receive({ack:0});
    expect(p.port.postMessage.mock.calls).toHaveLength(1);
  });
  it("requires the designated reader URL, originating tab and sender identity before sending bytes",async()=>{
    const e=await setup(),done=e.handoff.open(7,e.src,{auto:false});await ticks();
    e.source.receive({chunk:toBase64(pdfOf(64)),seq:0});e.source.receive({done:true,bytes:64});await done;
    const reader=e.url(),ticket=new URL(reader).searchParams.get("ticket")!;
    const identity={id:fakeBrowser.runtime.id,url:reader,frameId:0,tab:{id:7}};
    for(const sender of [undefined,{...identity,id:"other"},{...identity,tab:undefined},{...identity,frameId:1},{...identity,url:fakeBrowser.runtime.getURL("/options.html")}]) {
      const p=mockPort(sender);e.connect(p.port);p.receive({ticket});expect(p.port.postMessage).not.toHaveBeenCalled();expect(p.port.disconnect).toHaveBeenCalled();
    }
    const wrongTab=mockPort({...identity,tab:{id:8}});e.connect(wrongTab.port);wrongTab.receive({ticket});expect(wrongTab.port.postMessage).toHaveBeenCalledWith({gone:true});
    const right=mockPort(identity);e.connect(right.port);right.receive({ticket});await ticks();expect(right.port.postMessage).toHaveBeenLastCalledWith({bytes:64});
    expect(right.port.postMessage.mock.calls).toHaveLength(1); // no chunk until the header is acknowledged
    right.receive({ack:0});expect(right.port.postMessage).toHaveBeenLastCalledWith({chunk:toBase64(pdfOf(64)),seq:0});
    right.receive({ack:1});expect(right.port.postMessage).toHaveBeenLastCalledWith({done:true});
  });
});
