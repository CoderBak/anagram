// test/node/webengineAutoSetup.test.ts — the model's download, started by itself on install
// (lib/webengine/autoSetup.ts): when it is wanted, what stops it, and that the decision reads
// the state file the engine really writes (lib/webengine/engine.ts, on the in-memory store).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blockedBy, startSetupByItself, wantsDownload, type SavedSetup } from "../../lib/webengine/autoSetup";
import { Engine } from "../../lib/webengine/engine";
import { pinnedFiles } from "../../lib/webengine/pin";
import { sha256Hex } from "../../lib/webengine/sha256";
import { MemoryStore } from "../../lib/webengine/storage";
import type { Candidate } from "../../lib/webengine/session";
import { fakeServer } from "./webengineFake";

const ROOT = join(__dirname, "..", "..");
const PINNED = pinnedFiles();
const all = Object.fromEntries(PINNED.map((f) => [f.name, f.sha256]));

describe("whether the download is wanted", () => {
  it("is wanted on a fresh install and while a download is under way", () => {
    expect(wantsDownload(null)).toBe(true);
    expect(wantsDownload({})).toBe(true);
    expect(wantsDownload({ verified: { "model.onnx": all["model.onnx"]! } })).toBe(true);
    // A file verified against another pin is not the pinned one.
    expect(wantsDownload({ verified: { ...all, "model.onnx": "0".repeat(64) } })).toBe(true);
  });

  it("is not wanted once the model is there, or after the person cancelled, deleted, paused or stopped", () => {
    expect(wantsDownload({ verified: all })).toBe(false);
    for (const flag of ["models_deleted", "download_paused", "download_failed", "engine_stopped"] as const) {
      expect(wantsDownload({ [flag]: true } as SavedSetup), flag).toBe(false);
    }
  });

  it("waits while the browser asks to save data, or when the estimate leaves too little room", () => {
    expect(blockedBy({ saveData: true, quota: 1e12, usage: 0 }, 1.4e9)).toBe("save_data");
    expect(blockedBy({ quota: 2e9, usage: 1e9 }, 1.4e9)).toBe("no_room");
    expect(blockedBy({ quota: 1e12, usage: 1e9 }, 1.4e9)).toBeNull();
    expect(blockedBy({ saveData: false }, 1.4e9)).toBeNull();
  });
});

// ---- on the engine's own state file -----------------------------------------------------------

const MODEL = new Uint8Array(4096).map((_, i) => i % 251);
const TOKENIZER = new TextEncoder().encode("{}");
const tiny = [
  { name: "model.onnx", size_bytes: MODEL.length, sha256: sha256Hex(MODEL), url: "https://example.test/model.onnx" },
  { name: "tokenizer.json", size_bytes: TOKENIZER.length, sha256: sha256Hex(TOKENIZER), url: "https://example.test/tokenizer.json" },
];
const candidates = (): Candidate[] => [{ id: "wasm:fp32", label: "CPU", device: "cpu", runtime: "onnxruntime-web/wasm", precision: "fp32", experimental: false, available: true, reason: null }];

function engineOn(store: MemoryStore, stallAfter?: number): Engine {
  const server = fakeServer({ "/model.onnx": MODEL, "/tokenizer.json": TOKENIZER }, { stallAfter, chunk: 512 });
  return new Engine({
    pin: { files: tiny, lid: { name: "lid.176.ftz", size_bytes: 0, sha256: "", url: "data:," }, model: { id: "m", calibration: "c" }, license: "l" },
    assets: { jspi: { ort: "x", mjs: "x", wasm: "x" }, plain: { ort: "x", mjs: "x", wasm: "x" } },
    version: "9.9.9", store, transport: server.fetch, retryWaits: [0], probe: async () => candidates(),
    createSession: async () => { throw new Error("no model here"); },
  });
}
const saved = async (store: MemoryStore): Promise<SavedSetup> => JSON.parse(new TextDecoder().decode(await store.read("state.json"))) as SavedSetup;
const status = async (engine: Engine) => (await engine.handle("status", {})).data as { download: { status: string } };

describe("the engine's state file decides", () => {
  it("names the file the engine writes", () => {
    expect(readFileSync(join(ROOT, "lib", "webengine", "engine.ts"), "utf8")).toContain('const STATE_FILE = "state.json";');
  });

  it("wants a download that was under way, and not one the person paused or cancelled", async () => {
    const store = new MemoryStore();
    const engine = engineOn(store, 1024);
    await engine.handle("models.download", {});
    for (let i = 0; i < 100 && (await status(engine)).download.status !== "running"; i++) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 20));
    expect(wantsDownload(await saved(store), tiny)).toBe(true);
    await engine.handle("models.pause", {});
    expect(wantsDownload(await saved(store), tiny)).toBe(false);
    await engine.handle("engine.resume", {});
    // Cancel is models.delete: never started again by itself.
    await engine.handle("models.delete", { confirm: true });
    expect(wantsDownload(await saved(store), tiny)).toBe(false);
    await engine.close();
  });

  it("does not want a model that is there", async () => {
    const store = new MemoryStore();
    const engine = engineOn(store);
    await engine.handle("models.download", {});
    for (let i = 0; i < 200 && (await status(engine)).download.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 2));
    expect(wantsDownload(await saved(store), tiny)).toBe(false);
    await engine.close();
  });
});

// ---- in the background, with the browser's answers stood in ------------------------------------

/** navigator as the background sees it: OPFS holding `files` (null: never created), a storage estimate, Save-Data. */
function browserWith(files: Record<string, string> | null, { saveData = false, quota = 1e12, usage = 0 } = {}): void {
  const dir = {
    async *entries() {
      for (const [name, text] of Object.entries(files ?? {})) yield [name, { kind: "file", getFile: async () => new Blob([text]) }];
    },
  };
  vi.stubGlobal("navigator", {
    connection: { saveData },
    storage: {
      estimate: async () => ({ quota, usage }),
      getDirectory: async () => ({
        getDirectoryHandle: async () => {
          if (files === null) throw Object.assign(new Error("gone"), { name: "NotFoundError" });
          return dir;
        },
      }),
    },
  });
}
const ok = { v: 1 as const, id: "x", ok: true as const, status: 200, data: {} };

describe("starting it from the background", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts the download on a fresh install", async () => {
    browserWith(null);
    const request = vi.fn(async () => ok);
    expect(await startSetupByItself(request)).toBe("started");
    expect(request).toHaveBeenCalledWith("models.download");
  });

  it("asks for nothing while the browser asks to save data, or without room", async () => {
    const request = vi.fn(async () => ok);
    browserWith(null, { saveData: true });
    expect(await startSetupByItself(request)).toBe("save_data");
    browserWith(null, { quota: 1e9, usage: 0 });
    expect(await startSetupByItself(request)).toBe("no_room");
    expect(request).not.toHaveBeenCalled();
  });

  it("asks for nothing after a cancel, and nothing when the state file cannot be read", async () => {
    const request = vi.fn(async () => ok);
    browserWith({ "state.json": JSON.stringify({ models_deleted: true, verified: {} }) });
    expect(await startSetupByItself(request)).toBe("not_wanted");
    browserWith({ "state.json": "{not json" });
    expect(await startSetupByItself(request)).toBe("unreadable");
    expect(request).not.toHaveBeenCalled();
  });

  it("counts what is on disk against the room it needs", async () => {
    const total = PINNED.reduce((n, f) => n + f.size_bytes, 0);
    const request = vi.fn(async () => ok);
    // A thousand bytes are there already: the rest fits in 500 bytes less than the whole, and not in 2000 less.
    const onDisk = { "state.json": JSON.stringify({ verified: {} }), "model.onnx.part": "x".repeat(1000) };
    browserWith(onDisk, { quota: total - 2000, usage: 0 });
    expect(await startSetupByItself(request)).toBe("no_room");
    browserWith(onDisk, { quota: total - 500, usage: 0 });
    expect(await startSetupByItself(request)).toBe("started");
  });
});
