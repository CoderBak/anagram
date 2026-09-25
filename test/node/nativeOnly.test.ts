import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { getScoreClient } from "../../lib/backend/getScoreClient";
import { nativeTransport } from "../../lib/backend/nativeTransport";
import { createRouter } from "../../lib/backend/router";
import { createSwCache } from "../../lib/backend/swCache";
import { fakeScoreStore } from "./scoreStore";

const model = {id:"local",ver:"fp32",calibration:"buckets"};
const health = {ok:true,contract:"3.0",model,n_buckets:4,buckets:["a","b","c","d"],max_tokens:512,device:"cpu",app_version:"0.4.0"};
let nativeClock = Date.now();
beforeEach(() => { fakeBrowser.reset(); getScoreClient().invalidate(); });
afterEach(() => { nativeTransport().close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native-only scoring and settings migration", () => {
  it.each(["disconnect", "invalid frame", "explicit close"])("invalidates idle cached health after %s without a forced probe", async (event) => {
    vi.useFakeTimers();
    // The singleton's reconnect cooldown survives between tests, so keep time monotonic.
    vi.setSystemTime(nativeClock += 5000);
    let receive: (value: unknown) => void = () => {};
    let disconnected: () => void = () => {};
    let available = true;
    const connect = vi.spyOn(fakeBrowser.runtime, "connectNative").mockImplementation(() => {
      if (!available) throw new Error("Host unavailable");
      return {
        postMessage: (message: {id: string}) => receive({v:1,id:message.id,ok:true,status:200,data:health}),
        disconnect: () => disconnected(),
        onMessage: {addListener: (fn: typeof receive) => { receive = fn; }},
        onDisconnect: {addListener: (fn: typeof disconnected) => { disconnected = fn; }},
      } as ReturnType<typeof fakeBrowser.runtime.connectNative>;
    });
    const client = getScoreClient();
    expect((await client.status(false)).active).toBe("server");
    expect((await client.status(false)).active).toBe("server");
    expect(connect).toHaveBeenCalledTimes(1);
    available = false;
    if (event === "disconnect") disconnected();
    else if (event === "invalid frame") receive({v:2});
    else nativeTransport().close();
    expect(client.isUp()).toBe(false);
    expect(client.model().id).toBe("none");
    expect((await client.status(false)).active).toBe("down");
  });
  it("sends a batch again once the port that closed under it can open again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nativeClock += 5000);
    let receive: (value: unknown) => void = () => {};
    let disconnected: () => void = () => {};
    let closeOnScore = true;
    const connect = vi.spyOn(fakeBrowser.runtime, "connectNative").mockImplementation(() => ({
      postMessage: (message: {id: string; op: string; payload: {blocks?: {id: string}[]}}) => {
        if (message.op === "score" && closeOnScore) { closeOnScore = false; disconnected(); return; }
        receive({v:1,id:message.id,ok:true,status:200,data:message.op === "health" ? health :
          {v:"3.0",model,results:message.payload.blocks!.map(({id}) => ({id,bucket:0,probs:[1,0,0,0],score:0}))}});
      },
      disconnect: () => disconnected(),
      onMessage: {addListener: (fn: typeof receive) => { receive = fn; }},
      onDisconnect: {addListener: (fn: typeof disconnected) => { disconnected = fn; }},
    }) as ReturnType<typeof fakeBrowser.runtime.connectNative>);
    const router = createRouter(getScoreClient(), createSwCache(fakeScoreStore()));
    const work = router.handle({v:"3.0",session:"s",priority:"viewport",blocks:[{id:"b0",text:"One local paragraph"}]});
    await vi.advanceTimersByTimeAsync(5000);
    expect((await work).results[0].degraded).toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it.each(["http://127.0.0.1:8765","https://example.com/score"])("ignores the saved HTTP destination %s even before migration", async (serverUrl) => {
    await fakeBrowser.storage.local.set({backendTransport:"http",serverUrl});
    const fetcher = vi.fn(); vi.stubGlobal("fetch",fetcher);
    const request = vi.spyOn(nativeTransport(),"request").mockImplementation(async (op) => ({v:1,id:"fixture",ok:true,status:200,data:op === "health" ? health : {v:"3.0",model,results:[{id:"a",bucket:0,probs:[1,0,0,0],score:0}]}}));
    const client = getScoreClient();
    expect(getScoreClient()).toBe(client);
    expect((await client.status(true)).active).toBe("server");
    expect((await client.scoreBatch([{id:"a",text:"One local paragraph"}])).model).toEqual(model);
    expect(request.mock.calls.map(([op])=>op)).toEqual(["health","score"]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not fall back to fetch when the native component cannot answer", async () => {
    await fakeBrowser.storage.local.set({backendTransport:"http",serverUrl:"http://localhost:8765"});
    const fetcher = vi.fn(); vi.stubGlobal("fetch",fetcher);
    vi.spyOn(nativeTransport(),"request").mockRejectedValue(new Error("Host missing"));
    expect((await getScoreClient().status(true)).active).toBe("down");
    await expect(getScoreClient().scoreBatch([{id:"a",text:"No remote fallback"}])).rejects.toThrow("not ready");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
