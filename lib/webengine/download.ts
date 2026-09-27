// lib/webengine/download.ts — the pinned files, fetched resumably and verified as they arrive.
//
// download_modelkit.download_asset in the browser: a file downloads into `<name>.part`;
// a download that stops (a pause, a lost connection, a closed browser) keeps the part,
// and the next attempt hashes what is on disk and asks the server for the rest with a
// Range header. The SHA-256 runs over the bytes as they stream, so the file is verified
// the moment its last byte lands and is renamed into place only then; a mismatch drops
// the part. Every request is anonymous, without credentials or referrer, to exactly the
// pinned address, and follows the host's redirect to its storage.
import { Sha256 } from "./sha256";
import type { FileStore } from "./storage";
import type { PinnedFile } from "./pin";

export class DownloadPaused extends Error {
  constructor() { super("Download paused"); this.name = "DownloadPaused"; }
}
export class DownloadFailed extends Error {
  constructor(message: string, public readonly retryable = false) { super(message); this.name = "DownloadFailed"; }
}

export interface DownloadOptions {
  signal?: AbortSignal;
  /** Bytes of this file on disk so far, whenever that changes. */
  onProgress?(bytes: number): void;
  /** A message worth showing while retrying. */
  onNotice?(message: string): void;
  /** Stands in for fetch, in the suite. */
  transport?: typeof fetch;
  /** Waits between attempts, in ms. */
  retryWaits?: number[];
}

const RETRY_WAITS = [2_000, 5_000, 15_000];

/** What stopped a download, in the terms the setup page explains it in (lib/ui/inBrowserEngine.ts):
 *  the connection, a full disk, the server's answer, bytes that were not the pinned ones. */
export type DownloadFailure = "network" | "storage" | "server" | "damaged" | "other";

/** The kind of failure a DownloadFailed message describes, as the engine passes it on in
 *  its status (`download.error`); the messages are this file's own. */
export function failureKind(message: string | null | undefined): DownloadFailure {
  if (!message) return "other";
  if (/not enough free disk space/.test(message)) return "storage";
  if (/Checksum or size mismatch|larger than its pinned size/.test(message)) return "damaged";
  if (/answered \S+ with status \d+/.test(message)) return "server";
  if (/network request for|connection for \S+ was lost|Incomplete download|unexpected range|sent no body/.test(message)) return "network";
  return "other";
}

/** The browser's word for a disk (or an origin's quota) with no room left. */
const outOfSpace = (error: unknown): boolean => (error as { name?: string } | null)?.name === "QuotaExceededError";

/** HTTPS, or plain HTTP to this machine only (the suites serve the files themselves). */
export function secure(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
}

/** Whether a file of the pinned size and hash is already at `name`; hashes it to say so. */
export async function verifyFile(store: FileStore, entry: PinnedFile, name = entry.name): Promise<boolean> {
  if ((await store.size(name)) !== entry.size_bytes) return false;
  const hasher = new Sha256();
  for await (const chunk of store.stream(name)) hasher.update(chunk);
  return hasher.digest() === entry.sha256;
}

/**
 * Bring `entry` into the store, verified. Resolves when the file is in place; throws
 * DownloadPaused when `signal` aborts (the part stays), DownloadFailed otherwise.
 */
export async function downloadFile(store: FileStore, entry: PinnedFile, options: DownloadOptions = {}): Promise<void> {
  const { signal, onProgress = () => {}, onNotice = () => {}, transport, retryWaits = RETRY_WAITS } = options;
  const part = `${entry.name}.part`;
  const paused = () => { if (signal?.aborted) throw new DownloadPaused(); };
  paused();
  if (!secure(entry.url)) throw new DownloadFailed("Model downloads require HTTPS");
  for (let attempt = 0; ; attempt++) {
    try {
      await attemptDownload(store, entry, part, transport, signal, onProgress);
      return;
    } catch (error) {
      if (error instanceof DownloadPaused) throw error;
      const retryable = error instanceof DownloadFailed ? error.retryable : true;
      const wait = retryWaits[attempt];
      if (!retryable || wait === undefined) {
        throw error instanceof DownloadFailed ? error : new DownloadFailed(`Downloading ${entry.name} failed: ${(error as Error).message}`);
      }
      onNotice(`Retrying ${entry.name} in ${Math.round(wait / 1000)} s`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      paused();
    }
  }
}

async function attemptDownload(store: FileStore, entry: PinnedFile, part: string, transport: typeof fetch | undefined,
  signal: AbortSignal | undefined, onProgress: (bytes: number) => void): Promise<void> {
  const paused = () => { if (signal?.aborted) throw new DownloadPaused(); };
  // Already there, and the pinned bytes exactly.
  if ((await store.size(entry.name)) === entry.size_bytes) {
    if (await verifyFile(store, entry)) { onProgress(entry.size_bytes); return; }
    await store.delete(entry.name);
  }
  paused();
  // What an earlier attempt left: hash it to continue the digest, unless it is oversized.
  let offset = (await store.size(part)) ?? 0;
  if (offset > entry.size_bytes) { await store.delete(part); offset = 0; }
  const hasher = new Sha256();
  if (offset > 0) {
    for await (const chunk of store.stream(part)) { hasher.update(chunk); paused(); }
  }
  onProgress(offset);
  if (offset === entry.size_bytes) return finish(store, entry, part, hasher);
  const request: RequestInit = {
    method: "GET",
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "follow",
    signal,
  };
  const response = await (transport ? transport(entry.url, request) : fetch(entry.url, request)).catch((error: unknown) => {
    if ((error as { name?: string }).name === "AbortError") throw new DownloadPaused();
    throw new DownloadFailed(`The network request for ${entry.name} failed`, true);
  });
  paused();
  let resumed = false;
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
    if (!range || Number(range[1]) !== offset || Number(range[3]) !== entry.size_bytes) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadFailed(`The server answered ${entry.name} with an unexpected range`, true);
    }
    resumed = true;
  } else if (response.status === 200) {
    // The server ignored the range: start over.
    if (offset > 0) { await store.truncate(part, 0); offset = 0; hasher.reset(); onProgress(0); }
  } else {
    await response.body?.cancel().catch(() => {});
    throw new DownloadFailed(`The server answered ${entry.name} with status ${response.status}`, response.status >= 500 || response.status === 429);
  }
  if (!response.body) throw new DownloadFailed(`The server sent no body for ${entry.name}`, true);
  const writer = await store.writer(part, resumed);
  const reader = response.body.getReader();
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch (error) {
        if (signal?.aborted || (error as { name?: string }).name === "AbortError") throw new DownloadPaused();
        throw new DownloadFailed(`The connection for ${entry.name} was lost`, true);
      }
      if (next.done) break;
      const chunk = next.value;
      if (offset + chunk.length > entry.size_bytes) throw new DownloadFailed(`${entry.name} is larger than its pinned size`);
      hasher.update(chunk);
      // A full disk stays full however often it is asked: no retry, and the part is kept
      // for when there is room again.
      try { await writer.write(chunk); }
      catch (error) { throw outOfSpace(error) ? new DownloadFailed(`There is not enough free disk space for ${entry.name}`) : error; }
      offset += chunk.length;
      onProgress(offset);
      paused();
    }
  } catch (error) {
    await writer.close().catch(() => {});
    reader.cancel().catch(() => {});
    throw error;
  }
  await writer.close();
  if (offset < entry.size_bytes) throw new DownloadFailed(`Incomplete download of ${entry.name}; partial bytes retained for retry`, true);
  await finish(store, entry, part, hasher);
}

async function finish(store: FileStore, entry: PinnedFile, part: string, hasher: Sha256): Promise<void> {
  if (hasher.digest() !== entry.sha256) {
    await store.delete(part);
    throw new DownloadFailed(`Checksum or size mismatch for ${entry.name}`);
  }
  await store.rename(part, entry.name);
}
