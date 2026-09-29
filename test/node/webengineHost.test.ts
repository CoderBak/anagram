// test/node/webengineHost.test.ts — the engine's worker seen as a port (lib/webengine/host.ts),
// on a fake Worker: requests wait for the engine, a crash is a disconnect, and a worker
// that let the model go while idle is ended quietly and followed by an idle one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineHost } from "../../lib/webengine/host";

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: Array<{ type: string; idle?: boolean; request?: { id: string } }> = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor() { FakeWorker.all.push(this); }
  postMessage(message: FakeWorker["posted"][number]): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  emit(data: unknown): void { this.onmessage?.({ data }); }
}

const saved = (globalThis as { Worker?: unknown }).Worker;
beforeEach(() => { FakeWorker.all = []; (globalThis as { Worker?: unknown }).Worker = FakeWorker; });
afterEach(() => { (globalThis as { Worker?: unknown }).Worker = saved; });

function host() {
  const h = new EngineHost({ workerUrl: "worker.min.mjs", init: { pin: {} as never, assets: {} as never, version: "1" } });
  const replies: unknown[] = [];
  let disconnects = 0;
  h.onMessage.addListener((r) => replies.push(r));
  h.onDisconnect.addListener(() => { disconnects++; });
  return { h, replies, disconnects: () => disconnects };
}

describe("EngineHost", () => {
  it("queues requests until the engine is up, then passes replies on", () => {
    const { h, replies } = host();
    h.postMessage({ id: "a" });
    const w = FakeWorker.all[0]!;
    expect(w.posted).toEqual([{ type: "init", pin: {}, assets: {}, version: "1", idle: false }]);
    w.emit({ type: "ready" });
    expect(w.posted.slice(1)).toEqual([{ type: "request", request: { id: "a" } }]);
    w.emit({ type: "reply", reply: { id: "a", ok: true } });
    expect(replies).toEqual([{ id: "a", ok: true }]);
  });

  it("ends an idle worker once nothing waits on it, and starts the next one idle", () => {
    const { h, replies, disconnects } = host();
    h.postMessage({ id: "a" });
    const first = FakeWorker.all[0]!;
    first.emit({ type: "ready" });
    first.emit({ type: "idle" });
    expect(first.terminated).toBe(false);
    first.emit({ type: "reply", reply: { id: "a" }, idle: true });
    expect(first.terminated).toBe(true);
    expect(h.running).toBe(false);
    expect(disconnects()).toBe(0);
    h.postMessage({ id: "b" });
    const second = FakeWorker.all[1]!;
    expect(second.posted[0]).toMatchObject({ type: "init", idle: true });
    second.emit({ type: "ready" });
    second.emit({ type: "reply", reply: { id: "b" }, idle: true });
    expect(second.terminated).toBe(false);
    expect(replies).toEqual([{ id: "a" }, { id: "b" }]);
    h.disconnect();
    h.postMessage({ id: "c" });
    expect(FakeWorker.all[2]!.posted[0]).toMatchObject({ type: "init", idle: false });
  });

  it("keeps a worker that a request woke before the idle notice was acted on", () => {
    const { h } = host();
    h.postMessage({ id: "a" });
    const w = FakeWorker.all[0]!;
    w.emit({ type: "ready" });
    w.emit({ type: "reply", reply: { id: "a" }, idle: false });
    h.postMessage({ id: "score" });
    w.emit({ type: "idle" });
    w.emit({ type: "reply", reply: { id: "score" }, idle: false });
    expect(w.terminated).toBe(false);
    expect(h.running).toBe(true);
    w.emit({ type: "idle" });
    expect(w.terminated).toBe(true);
  });

  it("sends an init that has to be read (the chosen tier) once it is, and no earlier", async () => {
    let give!: (init: { pin: never; assets: never; version: string }) => void;
    const h = new EngineHost({ workerUrl: "w", init: () => new Promise((resolve) => { give = resolve; }) });
    h.postMessage({ id: "a" });
    const w = FakeWorker.all[0]!;
    expect(w.posted).toEqual([]);
    give({ pin: { tier: "fp16" } as never, assets: {} as never, version: "1" });
    await Promise.resolve();
    expect(w.posted).toEqual([{ type: "init", pin: { tier: "fp16" }, assets: {}, version: "1", idle: false }]);
    w.emit({ type: "ready" });
    expect(w.posted.slice(1)).toEqual([{ type: "request", request: { id: "a" } }]);
  });

  it("turns a crashed worker into a disconnect", () => {
    const { h, disconnects } = host();
    h.postMessage({ id: "a" });
    FakeWorker.all[0]!.onerror?.({ message: "boom" });
    expect(disconnects()).toBe(1);
    expect(h.error?.message).toBe("boom");
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });
});
