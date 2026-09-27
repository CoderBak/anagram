// test/node/webengineDownload.test.ts — resumable, verified downloads into the engine's store.
import { describe, expect, it } from "vitest";
import { downloadFile, DownloadFailed, DownloadPaused, verifyFile } from "../../lib/webengine/download";
import { sha256Hex } from "../../lib/webengine/sha256";
import { MemoryStore } from "../../lib/webengine/storage";
import { fakeServer } from "./webengineFake";

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}
const FILE = bytes(1000);
const entry = (sha = sha256Hex(FILE)) => ({ name: "model.bin", size_bytes: FILE.length, sha256: sha, url: "https://example.test/model.bin" });
const NO_WAIT = { retryWaits: [0, 0, 0] };

describe("model download", () => {
  it("streams a file into place, verifying it as it arrives", async () => {
    const store = new MemoryStore();
    const server = fakeServer({ "/model.bin": FILE });
    const progress: number[] = [];
    await downloadFile(store, entry(), { transport: server.fetch, onProgress: (n) => progress.push(n), ...NO_WAIT });
    expect(await store.read("model.bin")).toEqual(FILE);
    expect(await store.list()).toEqual(["model.bin"]);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(FILE.length);
    expect(server.requests).toEqual([{ url: "https://example.test/model.bin", range: null }]);
  });

  it("resumes after a lost connection from the bytes on disk, with a Range request", async () => {
    const store = new MemoryStore();
    const server = fakeServer({ "/model.bin": FILE }, { cutAfter: 350 });
    const notices: string[] = [];
    const first = downloadFile(store, entry(), { transport: server.fetch, retryWaits: [0], onNotice: (m) => notices.push(m) });
    // One retry only: the second attempt is cut too, and the failure keeps the part.
    await expect(first).rejects.toBeInstanceOf(DownloadFailed);
    expect(await store.size("model.bin.part")).toBe(700);
    expect(server.requests.map((r) => r.range)).toEqual([null, "bytes=350-"]);
    expect(notices).toEqual(["Retrying model.bin in 0 s"]);
    server.options.cutAfter = undefined;
    await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
    expect(server.requests[2].range).toBe("bytes=700-");
    expect(await store.read("model.bin")).toEqual(FILE);
    expect(await store.size("model.bin.part")).toBeNull();
  });

  it("pauses on abort and keeps the part for the next attempt", async () => {
    const store = new MemoryStore();
    const server = fakeServer({ "/model.bin": FILE }, { stallAfter: 200 });
    const controller = new AbortController();
    const paused = downloadFile(store, entry(), { transport: server.fetch, signal: controller.signal, ...NO_WAIT });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(paused).rejects.toBeInstanceOf(DownloadPaused);
    expect(await store.size("model.bin.part")).toBe(200);
    server.options.stallAfter = undefined;
    await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
    expect(server.requests[1].range).toBe("bytes=200-");
    expect(await store.read("model.bin")).toEqual(FILE);
  });

  it("starts over when the server ignores the range", async () => {
    const store = new MemoryStore();
    const writer = await store.writer("model.bin.part", false);
    await writer.write(FILE.subarray(0, 300));
    await writer.close();
    const server = fakeServer({ "/model.bin": FILE }, { ignoreRange: true });
    await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
    expect(server.requests[0].range).toBe("bytes=300-");
    expect(await store.read("model.bin")).toEqual(FILE);
  });

  it("drops a finished file whose hash is not the pinned one", async () => {
    const store = new MemoryStore();
    const server = fakeServer({ "/model.bin": FILE });
    await expect(downloadFile(store, entry("0".repeat(64)), { transport: server.fetch, ...NO_WAIT })).rejects.toThrow(/Checksum or size mismatch/);
    expect(await store.list()).toEqual([]);
  });

  it("refuses a file that grows past its pinned size, and a part that already has", async () => {
    const store = new MemoryStore();
    const server = fakeServer({ "/model.bin": bytes(1200) });
    await expect(downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT })).rejects.toThrow(/larger than its pinned size/);
    const writer = await store.writer("model.bin.part", false);
    await writer.write(bytes(1500));
    await writer.close();
    const good = fakeServer({ "/model.bin": FILE });
    await downloadFile(store, entry(), { transport: good.fetch, ...NO_WAIT });
    expect(good.requests[0].range).toBeNull();
    expect(await store.read("model.bin")).toEqual(FILE);
  });

  it("retries a server error, and gives up on a client error", async () => {
    const store = new MemoryStore();
    const server = fakeServer({ "/model.bin": FILE }, { status: 503 });
    await expect(downloadFile(store, entry(), { transport: server.fetch, retryWaits: [0] })).rejects.toThrow(/status 503/);
    expect(server.requests).toHaveLength(2);
    server.options.status = 403;
    await expect(downloadFile(store, entry(), { transport: server.fetch, retryWaits: [0] })).rejects.toThrow(/status 403/);
    expect(server.requests).toHaveLength(3);
  });

  it("skips a file already in place and verified, and replaces a wrong one of the right size", async () => {
    const store = new MemoryStore();
    let writer = await store.writer("model.bin", false);
    await writer.write(FILE);
    await writer.close();
    const server = fakeServer({ "/model.bin": FILE });
    await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
    expect(server.requests).toHaveLength(0);
    expect(await verifyFile(store, entry())).toBe(true);
    writer = await store.writer("model.bin", false);
    await writer.write(bytes(1000, 9));
    await writer.close();
    expect(await verifyFile(store, entry())).toBe(false);
    await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
    expect(server.requests).toHaveLength(1);
    expect(await store.read("model.bin")).toEqual(FILE);
  });

  it("insists on HTTPS", async () => {
    await expect(downloadFile(new MemoryStore(), { ...entry(), url: "http://example.test/model.bin" })).rejects.toThrow(/HTTPS/);
  });
});
