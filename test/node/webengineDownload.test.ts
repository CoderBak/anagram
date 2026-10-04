// test/node/webengineDownload.test.ts — resumable, verified downloads into the engine's store.
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFile, DownloadFailed, DownloadPaused, failureKind, mirrorOf, outOfSpace, secure, verifyFile } from "../../lib/webengine/download";
import { sha256Hex } from "../../lib/webengine/sha256";
import { MemoryStore, OpfsStore } from "../../lib/webengine/storage";
import { fakeServer, FullDisk } from "./webengineFake";

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}
const FILE = bytes(1000);
const entry = (sha = sha256Hex(FILE)) => ({ name: "model.bin", size_bytes: FILE.length, sha256: sha, url: "https://example.test/model.bin" });
const NO_WAIT = { retryWaits: [0, 0, 0] };

/** The message a failed download leaves, as the engine reports it in `download.error`. */
async function failure(run: Promise<void>): Promise<string> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DownloadFailed);
  return (error as Error).message;
}

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
    expect(server.requests[2]!.range).toBe("bytes=700-");
    expect(await store.read("model.bin")).toEqual(FILE);
    expect(await store.size("model.bin.part")).toBeNull();
  });

  describe("where Hugging Face cannot be reached", () => {
    const HF = "https://huggingface.co/x/resolve/r/model.bin";
    const MIRROR = "https://hf-mirror.com/x/resolve/r/model.bin";
    const pinned = (name = "model.bin") => ({ ...entry(), name, url: HF.replace("model.bin", name), mirrors: [MIRROR.replace("model.bin", name)] });
    /** Hugging Face as a blocked network has it: `how` it fails; the mirror serves the files. */
    const blocked = (server: ReturnType<typeof fakeServer>, how: "refused" | "silent" | number) => (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (new URL(url).hostname !== "huggingface.co") return server.fetch(url, init);
      server.requests.push({ url, range: new Headers(init?.headers).get("Range") });
      if (how === "refused") throw new TypeError("Failed to fetch");
      if (how === "silent") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      return new Response(null, { status: how });
    }) as typeof fetch;

    it("downloads from hf-mirror.com, says so, and starts the session's next file there", async () => {
      const store = new MemoryStore();
      const server = fakeServer({ "/x/resolve/r/model.bin": FILE, "/x/resolve/r/tokenizer.json": FILE });
      const notices: string[] = [];
      const route: { mirror?: boolean } = {};
      await downloadFile(store, pinned(), { transport: blocked(server, "refused"), route, onNotice: (m) => notices.push(m), ...NO_WAIT });
      expect(await store.read("model.bin")).toEqual(FILE);
      expect(server.requests.map((r) => new URL(r.url).hostname)).toEqual(["huggingface.co", "hf-mirror.com"]);
      expect(notices).toEqual(["Hugging Face is unreachable; downloading from hf-mirror.com"]);
      expect(mirrorOf(notices[0])).toBe("hf-mirror.com");
      expect(route.mirror).toBe(true);
      server.requests.length = 0;
      await downloadFile(store, pinned("tokenizer.json"), { transport: blocked(server, "refused"), route, ...NO_WAIT });
      expect(server.requests.map((r) => new URL(r.url).hostname)).toEqual(["hf-mirror.com"]);
    });

    it("takes a host that answers nothing for unreachable after the connect timeout", async () => {
      const store = new MemoryStore();
      const server = fakeServer({ "/x/resolve/r/model.bin": FILE });
      await downloadFile(store, pinned(), { transport: blocked(server, "silent"), connectTimeout: 20, ...NO_WAIT });
      expect(await store.read("model.bin")).toEqual(FILE);
      expect(server.requests.map((r) => new URL(r.url).hostname)).toEqual(["huggingface.co", "hf-mirror.com"]);
    });

    it("tries the mirror on a 5xx, not on a 404: a missing file is missing on the mirror too", async () => {
      const server = fakeServer({ "/x/resolve/r/model.bin": FILE });
      await downloadFile(new MemoryStore(), pinned(), { transport: blocked(server, 503), ...NO_WAIT });
      expect(server.requests.map((r) => new URL(r.url).hostname)).toEqual(["huggingface.co", "hf-mirror.com"]);
      const missing = fakeServer({ "/x/resolve/r/model.bin": FILE });
      expect(failureKind(await failure(downloadFile(new MemoryStore(), pinned(), { transport: blocked(missing, 404), ...NO_WAIT })))).toBe("server");
      expect(missing.requests.map((r) => new URL(r.url).hostname)).toEqual(["huggingface.co"]);
    });

    it("resumes a connection lost mid-file on the same host, carrying the part across a later switch", async () => {
      const store = new MemoryStore();
      const server = fakeServer({ "/x/resolve/r/model.bin": FILE }, { cutAfter: 350 });
      let calls = 0;
      // Hugging Face serves 350 bytes, then stops answering at all.
      const transport = (async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(input)).hostname === "huggingface.co" && calls++ > 0) { server.requests.push({ url: String(input), range: null }); throw new TypeError("Failed to fetch"); }
        if (new URL(String(input)).hostname === "hf-mirror.com") server.options.cutAfter = undefined;
        return server.fetch(input, init);
      }) as typeof fetch;
      await downloadFile(store, pinned(), { transport, ...NO_WAIT });
      expect(await store.read("model.bin")).toEqual(FILE);
      expect(server.requests.map((r) => [new URL(r.url).hostname, r.range])).toEqual([
        ["huggingface.co", null], ["huggingface.co", null], ["hf-mirror.com", "bytes=350-"],
      ]);
    });
  });

  it("refuses a download its redirects took off the model's hosts, and reads none of it", async () => {
    const transport = (async () => {
      const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(FILE); c.close(); } });
      const response = new Response(body, { status: 200 });
      Object.defineProperty(response, "url", { value: "https://attacker.example/model.bin" });
      return response;
    }) as unknown as typeof fetch;
    const store = new MemoryStore();
    expect(await failure(downloadFile(store, entry(), { transport, ...NO_WAIT }))).toMatch(/somewhere other than the model's host/);
    // Nothing of it was written: no file, no part.
    expect(await store.size("model.bin")).toBeNull();
    expect(await store.size("model.bin.part")).toBeNull();
  });

  it("takes a body that stops arriving for a lost connection, not a wait for ever, and keeps what came", async () => {
    const transport = (async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(FILE.subarray(0, 100)); }, // and nothing more, ever
    }), { status: 200 })) as unknown as typeof fetch;
    const store = new MemoryStore();
    const error = await downloadFile(store, entry(), { transport, stallTimeout: 20, ...NO_WAIT }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadFailed);
    expect(failureKind((error as Error).message)).toBe("network");
    expect(await store.size("model.bin.part")).toBe(100);
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
    expect(server.requests[1]!.range).toBe("bytes=200-");
    expect(await store.read("model.bin")).toEqual(FILE);
  });

  it("starts over when the server ignores the range", async () => {
    const store = new MemoryStore();
    const writer = await store.writer("model.bin.part", false);
    await writer.write(FILE.subarray(0, 300));
    await writer.close();
    const server = fakeServer({ "/model.bin": FILE }, { ignoreRange: true });
    await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
    expect(server.requests[0]!.range).toBe("bytes=300-");
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
    // What arrived is removed, as the setup page says of a damaged file.
    expect(await store.list()).toEqual([]);
    const writer = await store.writer("model.bin.part", false);
    await writer.write(bytes(1500));
    await writer.close();
    const good = fakeServer({ "/model.bin": FILE });
    await downloadFile(store, entry(), { transport: good.fetch, ...NO_WAIT });
    expect(good.requests[0]!.range).toBeNull();
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

  it("stops at once when the disk is full, keeping what arrived, and says so", async () => {
    const store = new FullDisk(400);
    const server = fakeServer({ "/model.bin": FILE });
    const progress: number[] = [];
    const message = await failure(downloadFile(store, entry(), { transport: server.fetch, onProgress: (n) => progress.push(n), ...NO_WAIT }));
    expect(message).toBe("There is not enough free disk space for model.bin");
    expect(failureKind(message)).toBe("storage");
    // Retrying cannot make room: one request, and the part stays for when there is some,
    // every byte the disk took, which is what the download last said it had.
    expect(server.requests).toHaveLength(1);
    const kept = (await store.size("model.bin.part"))!;
    expect(kept).toBeGreaterThan(390);
    expect(progress.at(-1)).toBe(kept);
    // Room again: Retry asks for the rest only.
    store.room = Infinity;
    await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
    expect(server.requests[1]!.range).toBe(`bytes=${kept}-`);
    expect(await store.read("model.bin")).toEqual(FILE);
  });

  it("takes the file system's other ways of saying the disk is full for one", async () => {
    // Chrome's other error for a write the file system refused names its code; a flush that
    // finds the disk full as the file is closed; a file that cannot even be opened for writing.
    const refusals: Array<[string, (store: FullDisk) => void]> = [
      ["the file system's code", (store) => { store.refuse = () => new DOMException("An error occurred while writing to the file: FILE_ERROR_NO_SPACE", "InvalidStateError"); }],
      ["a flush", (store) => {
        store.room = Infinity;
        const writer = store.writer.bind(store);
        store.writer = async (name, append) => ({ ...(await writer(name, append)), close: async () => { throw new DOMException("No space available for this operation", "QuotaExceededError"); } });
      }],
      ["opening the part", (store) => { store.writer = async () => { throw new DOMException("No space available for this operation", "QuotaExceededError"); }; }],
    ];
    for (const [how, refuse] of refusals) {
      const store = new FullDisk(400);
      refuse(store);
      const server = fakeServer({ "/model.bin": FILE });
      const message = await failure(downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT }));
      expect(failureKind(message), how).toBe("storage");
      expect(server.requests, how).toHaveLength(1);
    }
    expect(outOfSpace(new DOMException("x", "QuotaExceededError"))).toBe(true);
    expect(outOfSpace(new Error("No space left on device"))).toBe(true);
    expect(outOfSpace(new TypeError("Failed to fetch"))).toBe(false);
    expect(outOfSpace(null)).toBe(false);
  });

  it("names every way a download fails in the terms the setup page explains", async () => {
    const run = (options: Parameters<typeof fakeServer>[1], sha?: string, file = FILE) =>
      failure(downloadFile(new MemoryStore(), entry(sha), { transport: fakeServer({ "/model.bin": file }, options).fetch, retryWaits: [] }));
    expect(failureKind(await run({ cutAfter: 100 }))).toBe("network");
    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(failureKind(await failure(downloadFile(new MemoryStore(), entry(), { transport: offline, retryWaits: [] })))).toBe("network");
    expect(failureKind(await run({ status: 503 }))).toBe("server");
    expect(failureKind(await run({ status: 404 }))).toBe("server");
    expect(failureKind(await run({}, "0".repeat(64)))).toBe("damaged");
    expect(failureKind(await run({}, undefined, bytes(1200)))).toBe("damaged");
    // What the engine says after a restart that found a failed download, and nothing at all.
    expect(failureKind("Retry the model download to continue setup")).toBe("other");
    expect(failureKind(null)).toBe("other");
  });

  it("insists on HTTPS, except to this machine", async () => {
    await expect(downloadFile(new MemoryStore(), { ...entry(), url: "http://example.test/model.bin" })).rejects.toThrow(/HTTPS/);
    expect(secure("http://127.0.0.1:8080/model.bin")).toBe(true);
    expect(secure("http://localhost/model.bin")).toBe(true);
    expect(secure("http://127.0.0.1.example.test/model.bin")).toBe(false);
    expect(secure("ftp://127.0.0.1/model.bin")).toBe(false);
  });
});

/** What Chrome 149's FileSystemSyncAccessHandle.write() returns when the disk itself is full
 *  under unlimitedStorage (a 400 MB disk image, the engine's own download): base::File's
 *  FILE_ERROR_NO_SPACE, -8, read as an unsigned count. */
const NO_SPACE_COUNT = 2 ** 32 - 8;

/**
 * The origin-private file system as the engine's worker sees it through synchronous access
 * handles, on a disk with `room` bytes: a write that does not fit takes what fits and says how
 * much (`partial`), or takes nothing and answers Chrome's NO_SPACE_COUNT (`code`); a file with
 * an open handle cannot be opened again.
 */
function fakeOpfs(room: number, full: "partial" | "code" = "partial") {
  const files = new Map<string, Uint8Array>();
  const open = new Set<string>();
  const disk = { files, open, room, flushFails: false };
  const used = () => [...files.values()].reduce((n, f) => n + f.length, 0);
  const handle = (name: string) => ({
    kind: "file",
    getFile: async () => new Blob([files.get(name)! as Uint8Array<ArrayBuffer>]),
    move: async (to: string) => { files.set(to, files.get(name)!); files.delete(name); },
    createSyncAccessHandle: async () => {
      if (open.has(name)) throw new DOMException("Access Handles cannot be created if there is another open Access Handle", "NoModificationAllowedError");
      open.add(name);
      return {
        getSize: () => files.get(name)!.length,
        truncate: (n: number) => { files.set(name, files.get(name)!.slice(0, n)); },
        read: (buffer: Uint8Array, { at }: { at: number }) => {
          const part = files.get(name)!.subarray(at, at + buffer.length);
          buffer.set(part);
          return part.length;
        },
        write: (buffer: Uint8Array, { at }: { at: number }) => {
          const file = files.get(name)!;
          const fits = Math.max(0, Math.min(buffer.length, disk.room - used() + Math.max(0, file.length - at)));
          if (fits < buffer.length && full === "code") return NO_SPACE_COUNT;
          const next = new Uint8Array(Math.max(file.length, at + fits));
          next.set(file);
          next.set(buffer.subarray(0, fits), at);
          files.set(name, next);
          return fits;
        },
        flush: () => { if (disk.flushFails) throw new DOMException("No space available for this operation", "QuotaExceededError"); },
        close: () => { open.delete(name); },
      };
    },
  });
  const dir = {
    getFileHandle: async (name: string, { create = false } = {}) => {
      if (!files.has(name)) {
        if (!create) throw new DOMException("not found", "NotFoundError");
        files.set(name, new Uint8Array(0));
      }
      return handle(name);
    },
    removeEntry: async (name: string) => {
      if (!files.delete(name)) throw new DOMException("not found", "NotFoundError");
    },
    keys: async function* () { yield* files.keys(); },
  };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }), estimate: async () => ({}) } });
  return disk;
}

describe("the origin-private file system, full", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a write the disk takes only part of is a full disk, and the part keeps what it took", async () => {
    const disk = fakeOpfs(1000);
    const store = await OpfsStore.open();
    const writer = await store.writer("model.bin.part", false);
    await writer.write(new Uint8Array(600).fill(1));
    const refused = await writer.write(new Uint8Array(600).fill(2)).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ name: "QuotaExceededError" });
    expect(outOfSpace(refused)).toBe(true);
    await writer.close();
    expect(await store.size("model.bin.part")).toBe(1000);
    expect(disk.open.size).toBe(0);
  });

  it("closes the file when the flush finds the disk full, so that Retry can open it again", async () => {
    const disk = fakeOpfs(10_000);
    const store = await OpfsStore.open();
    const writer = await store.writer("state.json", false);
    await writer.write(new Uint8Array(10));
    disk.flushFails = true;
    await expect(writer.close()).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(disk.open.size).toBe(0);
    disk.flushFails = false;
    await (await store.writer("state.json", true)).close();
  });

  it("writes a file over its old bytes and cuts it to the new ones; a disk that refuses them leaves the old", async () => {
    const disk = fakeOpfs(1000, "code");
    const store = await OpfsStore.open();
    const save = async (text: string) => {
      const writer = await store.writer("state.json", false);
      try { await writer.write(new TextEncoder().encode(text)); } finally { await writer.close(); }
    };
    await save('{"download_pending":true,"verified":{}}');
    await save('{"a":1}');
    expect(new TextDecoder().decode(await store.read("state.json"))).toBe('{"a":1}');
    disk.room = disk.files.get("state.json")!.length;
    await expect(save('{"download_failed":true}')).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(new TextDecoder().decode(await store.read("state.json"))).toBe('{"a":1}');
    expect(disk.open.size).toBe(0);
  });

  it("takes Chrome's error code for a count as a full disk too, and writes nothing past it", async () => {
    const disk = fakeOpfs(1000, "code");
    const store = await OpfsStore.open();
    const writer = await store.writer("model.bin.part", false);
    await writer.write(new Uint8Array(600).fill(1));
    const refused = await writer.write(new Uint8Array(600).fill(2)).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ name: "QuotaExceededError", message: `The disk took 0 of 600 bytes (${NO_SPACE_COUNT})` });
    await writer.close();
    expect(await store.size("model.bin.part")).toBe(600);
    expect(disk.open.size).toBe(0);
  });

  it("stops a download there, and Retry carries on from the part once there is room", async () => {
    for (const full of ["partial", "code"] as const) {
      const disk = fakeOpfs(400, full);
      const store = await OpfsStore.open();
      const server = fakeServer({ "/model.bin": FILE });
      const message = await failure(downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT }));
      expect(failureKind(message), full).toBe("storage");
      expect(server.requests, full).toHaveLength(1);
      // Every byte the disk took, in 7-byte chunks: a code takes none of the chunk that did not fit.
      const kept = full === "partial" ? 400 : 399;
      expect(await store.size("model.bin.part"), full).toBe(kept);
      expect(disk.open.size, full).toBe(0);
      disk.room = Infinity;
      await downloadFile(store, entry(), { transport: server.fetch, ...NO_WAIT });
      expect(server.requests[1]!.range, full).toBe(`bytes=${kept}-`);
      expect(await store.read("model.bin"), full).toEqual(FILE);
      vi.unstubAllGlobals();
    }
  });
});
