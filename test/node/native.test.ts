import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { NativeTransport, NativeTransportError, type NativePort } from "../../lib/backend/nativeTransport";
import { trustedNativePage, validPageRequest, parseNativeReply } from "../../lib/backend/nativeProtocol";
import { NativeScoreClient } from "../../lib/backend/nativeScoreClient";
import { parseComponent } from "../../lib/backend/nativeClient";
import { handleNativePageMessage } from "../../lib/backend/nativeBridge";
import { NATIVE_MESSAGE, NATIVE_UNINSTALL } from "../../lib/backend/nativeProtocol";
import { isTransientFailure } from "../../lib/backend/retry";

function port() {
  const messages: Array<{id:string;op:string;payload:unknown}> = [];
  let receive: (value:unknown) => void = () => {};
  let disconnect: () => void = () => {};
  const p: NativePort = {
    postMessage: (value) => { messages.push(value as typeof messages[number]); },
    disconnect: vi.fn(() => disconnect()),
    onMessage: {addListener: (fn) => { receive = fn; }},
    onDisconnect: {addListener: (fn) => { disconnect = fn; }},
  };
  return {p,messages,receive:(value:unknown) => receive(value),disconnect:() => disconnect(),
    answer:(index:number,data:unknown={}) => receive({v:1,id:messages[index].id,ok:true,status:200,data})};
}
beforeEach(() => fakeBrowser.reset());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native port multiplexing and failure recovery", () => {
  it("shares one host between concurrent requests and matches out-of-order replies", async () => {
    const p = port(); const connect = vi.fn(() => p.p); const transport = new NativeTransport(connect);
    const first = transport.request("status"); const second = transport.request("health");
    expect(connect).toHaveBeenCalledTimes(1);
    p.answer(1,{name:"health"}); p.answer(0,{name:"status"});
    expect((await first).data).toEqual({name:"status"});
    expect((await second).data).toEqual({name:"health"}); transport.close();
  });
  it("rejects outstanding work on disconnect and reconnects on a later request", async () => {
    vi.useFakeTimers(); const first = port(); const second = port();
    const connect = vi.fn().mockReturnValueOnce(first.p).mockReturnValue(second.p);
    const transport = new NativeTransport(connect);
    const pending = expect(transport.request("status")).rejects.toMatchObject({code:"native_unavailable"});
    first.disconnect(); await pending;
    await expect(transport.request("status")).rejects.toMatchObject({code:"native_unavailable"});
    await vi.advanceTimersByTimeAsync(1501);
    const next = transport.request("status"); second.answer(0); await next;
    // Late events from the retired port cannot tear down the new connection.
    first.disconnect(); const next2 = transport.request("health"); second.answer(1); await next2;
    expect(connect).toHaveBeenCalledTimes(2); transport.close();
  });
  it("cancels one request without interrupting another, ignoring late replies", async () => {
    const p = port(); const transport = new NativeTransport(() => p.p); const ctl = new AbortController();
    const cancelled = expect(transport.request("status",{},ctl.signal)).rejects.toMatchObject({code:"cancelled"});
    const other = transport.request("health"); ctl.abort(); await cancelled;
    p.answer(0); p.answer(1,{ready:true}); expect((await other).data).toEqual({ready:true});
    expect(p.p.disconnect).not.toHaveBeenCalled(); transport.close();
  });
  it("bounds a stuck request and rejects malformed host frames", async () => {
    vi.useFakeTimers(); const p = port(); const transport = new NativeTransport(() => p.p);
    const timed = expect(transport.request("status",{},undefined,100)).rejects.toMatchObject({code:"native_timeout"});
    await vi.advanceTimersByTimeAsync(100); await timed;
    const invalid = expect(transport.request("status")).rejects.toMatchObject({code:"native_protocol"});
    p.receive({v:2,id:"other",ok:true,status:200,data:{}}); await invalid;
    expect(p.p.disconnect).toHaveBeenCalledTimes(1);
  });
  it("refuses oversized requests before starting any native process", async () => {
    const connect = vi.fn(); const transport = new NativeTransport(connect);
    await expect(transport.request("score",{text:"x".repeat(1_000_001)})).rejects.toMatchObject({code:"request_too_large"});
    expect(connect).not.toHaveBeenCalled();
  });
  it("retires a startup-busy host so retry can acquire a released component lock", async () => {
    vi.useFakeTimers(); const first = port(); const second = port();
    const connect = vi.fn().mockReturnValueOnce(first.p).mockReturnValue(second.p);
    const transport = new NativeTransport(connect);
    const busy = transport.request("status");
    first.receive({v:1,id:first.messages[0].id,ok:false,status:409,error:{code:"busy",message:"Another browser owns the component"}});
    expect((await busy).error?.code).toBe("busy"); expect(first.p.disconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1501);
    const retried = transport.request("status"); second.answer(0,{state:"ready"});
    expect((await retried).data).toEqual({state:"ready"});
    const scoring = transport.request("score");
    second.receive({v:1,id:second.messages[1].id,ok:false,status:409,error:{code:"busy",message:"Scoring queue full"}});
    await scoring; expect(second.p.disconnect).not.toHaveBeenCalled(); transport.close();
  });
  it("reconnects an updated component even after the Settings page was closed", async () => {
    vi.useFakeTimers(); const first = port(); const second = port();
    const transport = new NativeTransport(vi.fn().mockReturnValueOnce(first.p).mockReturnValue(second.p));
    const health = transport.request("health");
    first.receive({v:1,id:first.messages[0].id,ok:false,status:503,error:{code:"component_updated",message:"Reconnect after update"}});
    expect((await health).error?.code).toBe("component_updated");
    expect(first.p.disconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1501);
    const retried = transport.request("health"); second.answer(0,{ok:true});
    expect((await retried).data).toEqual({ok:true}); transport.close();
  });
});

describe("privileged native operation boundary", () => {
  const id = "a".repeat(32); const base = `chrome-extension://${id}/`;
  it("accepts our setup tab but rejects page scripts, other extensions and subframes", () => {
    expect(trustedNativePage({id,url:base+"onboarding.html",frameId:0},id,base)).toBe(true);
    expect(trustedNativePage({id,url:base+"options.html?x=1"},id,base)).toBe(true);
    for (const sender of [
      {id,url:"https://example.com/options.html"}, {id:"b".repeat(32),url:base+"options.html"},
      {id,url:base+"reader.html"}, {id,url:base+"options.html.evil"},
      {id,url:base+"options.html",frameId:1}, {url:base+"options.html"},
    ]) expect(trustedNativePage(sender,id,base)).toBe(false);
  });
  it("requires deletion confirmation and refuses arbitrary paths/commands", () => {
    expect(validPageRequest("models.delete",{confirm:true})).toBe(true);
    expect(validPageRequest("models.delete",{})).toBe(false);
    expect(validPageRequest("component.uninstall",{confirm:true,path:"/tmp/other"})).toBe(false);
    expect(validPageRequest("component.update",{url:"https://evil.example"})).toBe(false);
    expect(validPageRequest("execute",{command:"anything"})).toBe(false);
    expect(validPageRequest("runtime.benchmark",{budget_s:30})).toBe(true);
    expect(validPageRequest("runtime.benchmark",{budget_s:Infinity})).toBe(false);
  });
  it("allows only explicit bounded download profiles, while empty payload resumes", () => {
    for (const payload of [{}, {profile:"recommended"}, {profile:"expanded"}])
      expect(validPageRequest("models.download",payload)).toBe(true);
    for (const payload of [{profile:"all"}, {profile:null}, {profile:"expanded",url:"https://example.com"},
      {profile:"expanded",path:"/tmp/models"}, {files:["model.safetensors"]}, null, []])
      expect(validPageRequest("models.download",payload)).toBe(false);
  });
  it("the actual bridge rejects a content-script mutation without touching the component", async () => {
    const controls = {invalidate:vi.fn(),clear:vi.fn()};
    const reply = await handleNativePageMessage({action:NATIVE_MESSAGE,op:"models.delete",payload:{confirm:true}},
      {id:fakeBrowser.runtime.id,url:"https://example.com"},controls);
    expect(reply).toMatchObject({ok:false,status:403,error:{code:"forbidden"}});
    expect(controls.invalidate).not.toHaveBeenCalled();
  });
  it("cannot remove the extension using an invented cleanup receipt", async () => {
    const controls = {invalidate:vi.fn(),clear:vi.fn()};
    const reply = await handleNativePageMessage({action:NATIVE_UNINSTALL,receipt:"invented"},
      {id:fakeBrowser.runtime.id,url:fakeBrowser.runtime.getURL("/options.html")},controls);
    expect(reply).toMatchObject({ok:false}); expect(controls.clear).not.toHaveBeenCalled();
  });
});

const MODEL = {id:"editlens_roberta-large",ver:"verified-fp32",calibration:"editlens"};
const HEALTH = {ok:true,contract:"2.1",model:MODEL,n_buckets:4,buckets:["a","b","c","d"],max_tokens:512,device:"cpu",dtype:"fp32"};
const result = {id:"block",bucket:0,probs:[1,0,0,0],score:0};
const reply = (data:unknown) => ({v:1 as const,id:"test",ok:true,status:200,data});
describe("native scoring preserves the scoring contract", () => {
  it("preserves transient scoring failures without retrying malformed native data", async () => {
    const request = vi.fn().mockResolvedValueOnce(reply(HEALTH)).mockResolvedValueOnce({v:1,id:"score",ok:false,status:409,error:{code:"busy",message:"Queue full"}});
    const client = new NativeScoreClient(request);
    const error = await client.scoreBatch([{id:"block",text:"sample"}]).catch((e:unknown) => e);
    expect(error).toMatchObject({status:409,code:"busy"}); expect(isTransientFailure(error)).toBe(true);
    expect(isTransientFailure(new NativeTransportError("native_timeout", "Timed out"))).toBe(true);
    expect(isTransientFailure(new NativeTransportError("native_protocol", "Invalid frame"))).toBe(false);
    expect(isTransientFailure(new NativeTransportError("cancelled", "Cancelled"))).toBe(false);
  });
  it("caches health and adopts the actual producing model identity", async () => {
    const request = vi.fn().mockResolvedValueOnce(reply(HEALTH))
      .mockResolvedValueOnce(reply({v:"2.1",model:{...MODEL,ver:"verified-fp16"},results:[result]}));
    const client = new NativeScoreClient(request);
    await client.ready(); expect(client.model()).toEqual(MODEL);
    const batch = await client.scoreBatch([{id:"block",text:"sample"}]);
    expect(batch.model.ver).toBe("verified-fp16"); expect(client.model()).toEqual(batch.model);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid probabilities instead of showing or caching a verdict", async () => {
    const request = vi.fn().mockResolvedValueOnce(reply(HEALTH))
      .mockResolvedValueOnce(reply({v:"2.1",model:MODEL,results:[{...result,probs:[1,1,1,1]}]}));
    const client = new NativeScoreClient(request);
    await expect(client.scoreBatch([{id:"block",text:"sample"}])).rejects.toThrow(/probabilities/);
    expect(client.isUp()).toBe(false); expect(client.model().id).toBe("none");
  });
  it("does not let old health probes restore readiness after a user stops inference", async () => {
    let resolve!: (value:ReturnType<typeof reply>) => void;
    const client = new NativeScoreClient(() => new Promise((r) => {resolve=r;}));
    const started = client.ready(); client.invalidate(); resolve(reply(HEALTH)); await started;
    expect(client.isUp()).toBe(false);
  });
});

describe("component status validation", () => {
  const status = {schema_version:1,version:"0.4.0",home:"/owned/anagram",state:"needs_models",
    download:{status:"idle",bytes_received:0,total_bytes:100,file:null,error:null},runtime:null,
    storage:{models_bytes:0},error:null,operation:null};
  it("accepts bounded progress and truthful scheduled maintenance", () => {
    expect(parseComponent(status)?.state).toBe("needs_models");
    expect(parseComponent({...status,operation:{name:"uninstall",status:"scheduled",receipt:null}})?.operation?.status).toBe("scheduled");
  });
  it("rejects malformed progress, messages and unsupported schemas", () => {
    expect(parseComponent({...status,download:{...status.download,bytes_received:101}})).toBeNull();
    expect(parseComponent({...status,storage:{models_bytes:Infinity}})).toBeNull();
    expect(parseComponent({...status,schema_version:2})).toBeNull();
    expect(parseNativeReply({v:1,id:"x",ok:false,status:500})).toBeNull();
    expect(parseNativeReply({v:1,id:"x",ok:true,status:500,data:{}})).toBeNull();
  });
  it("accepts old components and device plans during detection, verification and reuse", () => {
    expect(parseComponent(status)?.download.plan).toBeUndefined();
    expect(parseComponent({...status,state:"downloading",download:{...status.download,status:"running",phase:"detecting",total_bytes:0}})?.download.phase).toBe("detecting");
    const plan = {profile:"recommended",devices:["Apple GPU (MPS)","CPU (arm64)"],files:["model.safetensors","lid.176.bin"],total_bytes:100,expanded_bytes:250};
    const parsed = parseComponent({...status,download:{...status.download,phase:"verifying",bytes_received:100,plan}});
    expect(parsed?.download.plan).toEqual(plan);
    expect(parsed?.download.bytes_received).toBe(100); // Reused verified files count toward preparation.
  });
  it("rejects malformed or unbounded plans instead of presenting false progress", () => {
    const plan = {profile:"recommended",devices:["CPU"],files:["model.onnx"],total_bytes:100};
    for (const bad of [null, {...plan,profile:"all"}, {...plan,total_bytes:-1}, {...plan,expanded_bytes:Infinity},
      {...plan,devices:Array(65).fill("CPU")}, {...plan,files:Array(129).fill("model.onnx")}, {...plan,files:["x".repeat(2001)]}])
      expect(parseComponent({...status,download:{...status.download,plan:bad}})).toBeNull();
    expect(parseComponent({...status,download:{...status.download,phase:"converting"}})).toBeNull();
  });
});

describe("native scoring lifecycle generation", () => {
  it("allows an idle engine to receive score without waking it through health", async () => {
    const idle = {v:1,id:"health",ok:false,status:503,error:{code:"engine_idle",message:"Unloaded"}};
    const loading = {v:1,id:"score",ok:false,status:503,error:{code:"not_ready",message:"Loading"}};
    const request = vi.fn().mockResolvedValueOnce(idle).mockResolvedValueOnce(loading)
      .mockResolvedValueOnce(reply({v:"2.1",model:MODEL,results:[result]}));
    const client = new NativeScoreClient(request);
    await client.ready(); const generation = client.revision();
    expect(client.isUp()).toBe(false);
    expect(await client.status(false)).toMatchObject({active:"idle",model:null,server:{ok:false,code:"engine_idle"}});
    const controller = new AbortController();
    await expect(client.scoreBatch([{id:"block",text:"sample"}], controller.signal)).rejects.toMatchObject({code:"not_ready"});
    expect(client.revision()).toBe(generation);
    const batch = await client.scoreBatch([{id:"block",text:"sample"}], controller.signal);
    expect(batch.model).toEqual(MODEL);
    expect(await client.status(false)).toMatchObject({active:"server",model:MODEL,server:{ok:true}});
    expect(request.mock.calls.map(([operation]) => operation)).toEqual(["health", "score", "score"]);
    expect(request.mock.calls[1][2]).toBe(controller.signal);
  });

  it("does not auto-wake an explicitly stopped component", async () => {
    const request = vi.fn().mockResolvedValue({v:1,id:"health",ok:false,status:503,error:{code:"not_ready",message:"Stopped"}});
    const client = new NativeScoreClient(request);
    await expect(client.scoreBatch([{id:"block",text:"sample"}])).rejects.toThrow(/not ready/);
    expect(request.mock.calls.map(([operation]) => operation)).toEqual(["health"]);
  });

  it("rejects a late score after invalidate and advances on calibration changes", async () => {
    const { deferred } = await import("./scoreStore");
    const held = deferred<ReturnType<typeof reply>>();
    const request = vi.fn().mockResolvedValueOnce(reply(HEALTH)).mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(reply(HEALTH)).mockResolvedValueOnce(reply({...HEALTH,model:{...MODEL,calibration:"new"}}));
    const client = new NativeScoreClient(request);
    await client.ready(); const work = client.scoreBatch([{id:"block",text:"sample"}]);
    await Promise.resolve(); client.invalidate();
    held.resolve(reply({v:"2.1",model:MODEL,results:[result]}));
    await expect(work).rejects.toMatchObject({code:"cancelled"});
    await client.ready(); const generation = client.revision();
    await client.status(true); expect(client.revision()).toBe(generation + 1);
    const model = client.model(); model.calibration = "mutated";
    expect(client.model().calibration).toBe("new");
  });
});
