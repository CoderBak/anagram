// lib/webengine/autoSetup.ts — the model's download, started by itself when the oneclick
// build is installed.
//
// Adding the extension is the whole of setup: on install (runtime.onInstalled, "install") the
// background asks the engine for `models.download` before it opens the setup page, which
// then shows the download running, with Pause and Cancel. On an update it does the same when
// a download was under way, or when the model is not there and nobody chose otherwise. What
// the person chose is in the engine's state file, read here from the extension's storage
// before the engine is started (starting it would load a model that is there): never after
// Cancel or Delete model files, a pause, a failed download or a stopped engine. A plain
// browser restart fires no onInstalled, so it starts nothing; a download the browser closed
// on carries on when the engine next starts, as it always has. Nor does it start while the
// browser asks sites to save data, or when the storage estimate leaves too little room: the
// setup page then offers Set up and says why (lib/ui/inBrowserEngine.ts).
import { roomShort } from "../backend/engineSetup";
import type { NativeReply } from "../backend/nativeProtocol";
import { pinnedFiles } from "./pin";
import { DIRECTORY } from "./storage";

/** lib/webengine/engine.ts's state file: what the engine saved about the download. */
const STATE_FILE = "state.json";
/** How long the setup page waits for the engine to take the request before it opens anyway. */
const OPEN_AFTER_MS = 10_000;

/** The part of the engine's saved state that says what the person chose. */
export interface SavedSetup {
  download_paused?: boolean;
  download_failed?: boolean;
  engine_stopped?: boolean;
  models_deleted?: boolean;
  /** The pinned hashes of the files verified so far, by name. */
  verified?: Record<string, string>;
}

/** Why the download did not start by itself. */
export type Skipped = "not_wanted" | "save_data" | "no_room" | "unreadable";

/**
 * Whether the saved state lets the download start by itself: some pinned file is not there
 * yet (nothing downloaded, or a download under way), and the person neither cancelled nor
 * deleted it, paused it, left a failed one or stopped the engine. No state file is a fresh
 * install.
 */
export function wantsDownload(saved: SavedSetup | null, files: ReadonlyArray<{ name: string; sha256: string }> = pinnedFiles()): boolean {
  if (!saved) return true;
  if (saved.models_deleted || saved.download_paused || saved.download_failed || saved.engine_stopped) return false;
  return files.some((f) => saved.verified?.[f.name] !== f.sha256);
}

/** Save-Data first, then room: what keeps a wanted download from starting by itself. */
export function blockedBy(env: { saveData?: boolean; quota?: number; usage?: number }, needed: number): "save_data" | "no_room" | null {
  if (env.saveData === true) return "save_data";
  return roomShort(env, needed) !== null ? "no_room" : null;
}

/** The engine's saved state and the bytes its directory holds, read without starting it:
 *  null state for a fresh install, "unreadable" for a file the engine would not trust either. */
async function readSaved(): Promise<{ saved: SavedSetup | null; bytes: number } | "unreadable"> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY);
  } catch (error) {
    return (error as { name?: string }).name === "NotFoundError" ? { saved: null, bytes: 0 } : "unreadable";
  }
  try {
    let bytes = 0, text: string | null = null;
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== "file") continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      bytes += file.size;
      if (name === STATE_FILE) text = await file.text();
    }
    if (text === null) return { saved: null, bytes };
    const saved = JSON.parse(text) as unknown;
    return saved && typeof saved === "object" ? { saved: saved as SavedSetup, bytes } : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** The bytes the engine's directory holds, read without starting the engine; 0 when unreadable. */
export async function storedModelBytes(): Promise<number> {
  try {
    const read = await readSaved();
    return read === "unreadable" ? 0 : read.bytes;
  } catch { return 0; }
}

/**
 * On install or update: start the model's download when it is wanted and nothing stands in
 * the way. Resolves once the engine has taken the request, or after OPEN_AFTER_MS, with
 * "started" or why not; never rejects.
 */
export async function startSetupByItself(request: (op: "models.download") => Promise<NativeReply>): Promise<"started" | "unavailable" | Skipped> {
  try {
    const read = await readSaved();
    if (read === "unreadable") return "unreadable";
    if (!wantsDownload(read.saved)) return "not_wanted";
    const total = pinnedFiles().reduce((n, f) => n + f.size_bytes, 0);
    let estimate: { quota?: number; usage?: number } = {};
    try { estimate = await navigator.storage.estimate(); } catch { /* no estimate: room is not known to be short */ }
    const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
    const blocked = blockedBy({ saveData: connection?.saveData, ...estimate }, Math.max(0, total - read.bytes));
    if (blocked) return blocked;
    const asked = request("models.download").then(() => "started" as const, () => "unavailable" as const);
    return await Promise.race([asked, new Promise<"started">((resolve) => setTimeout(() => resolve("started"), OPEN_AFTER_MS))]);
  } catch {
    return "unreadable";
  }
}
