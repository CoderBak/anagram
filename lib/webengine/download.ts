// lib/webengine/download.ts — the pinned files, fetched resumably and verified as they arrive.
//
// download_modelkit.download_asset in the browser: a file downloads into `<name>.part`;
// a download that stops (a pause, a lost connection, a closed browser) keeps the part,
// and the next attempt hashes what is on disk and asks the server for the rest with a
// Range header. The SHA-256 runs over the bytes as they stream, so the file is verified
// the moment its last byte lands and is renamed into place only then; a mismatch drops
// the part. Every request is anonymous, without credentials or referrer, to exactly the
// pinned address, and follows the host's redirect to its storage. It is a CORS request, which
// Hugging Face and its storage answer with the headers that let the extension read it (under
// the pages' cross-origin isolation too), so the extension holds no permission for the host.
//
// Where the host cannot be reached at all — no answer, no byte, a 5xx — the file's mirrors are
// tried next (hf-mirror.com, for where Hugging Face is blocked), as download_modelkit.py does:
// the part carries across the switch, the hash decides what is kept, and a mirror that worked
// is tried first for the rest of the session's files.
import { Sha256 } from "./sha256";
import type { FileStore } from "./storage";
import { MIRROR_HOST, type PinnedFile } from "./pin";

export class DownloadPaused extends Error {
  constructor() { super("Download paused"); this.name = "DownloadPaused"; }
}
export class DownloadFailed extends Error {
  /** `unreachable`: the host answered no byte — a network error, a timeout, a 5xx — so another
   *  address of the file is worth trying. A lost connection, a 404 or a bad hash never is. */
  constructor(message: string, public readonly retryable = false, public readonly unreachable = false) { super(message); this.name = "DownloadFailed"; }
}

/** The notice a switch to a mirror leaves, word for word download_modelkit's (the local engine's),
 *  so the setup page reads both engines' alike (lib/backend/engineSetup.ts). */
export const mirrorNotice = (host: string): string => `Hugging Face is unreachable; downloading from ${host}`;
/** The mirror a notice names, or null. */
export function mirrorOf(notice: string | null | undefined): string | null {
  return /^Hugging Face is unreachable; downloading from (\S+)$/.exec(notice ?? "")?.[1] ?? null;
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
  /** Shared by a session's downloads: set once a mirror has worked, so the next file starts there. */
  route?: { mirror?: boolean };
  /** How long a request may go without an answer before its host counts as unreachable, in ms. */
  connectTimeout?: number;
}

const RETRY_WAITS = [2_000, 5_000, 15_000];
/** A blocked host often answers nothing at all, and a browser waits minutes for that. */
const CONNECT_TIMEOUT = 20_000;

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

/**
 * A disk (or an origin's quota) with no room left. The browser's word for it is
 * QuotaExceededError: the origin-private file system's writes throw it when a quota runs out,
 * and lib/webengine/storage.ts does for a write the disk took only part of or answered with an
 * error code. Chrome's other errors from those writes name the file system's own code.
 */
export function outOfSpace(error: unknown): boolean {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  return name === "QuotaExceededError" || /NO_SPACE|no space (?:left|available)|disk is full/i.test(String(message ?? ""));
}

/** What a full disk stops a download with: never retried, and the part stays for when there is room. */
export const noRoomFor = (name: string): DownloadFailed => new DownloadFailed(`There is not enough free disk space for ${name}`);

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

/** A file the extension ships (lid.176.ftz), read from the package and checked against its pin. */
export async function readPackaged(entry: PinnedFile): Promise<Uint8Array> {
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`${entry.name} is missing from the extension (status ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hasher = new Sha256();
  hasher.update(bytes);
  if (bytes.length !== entry.size_bytes || hasher.digest() !== entry.sha256) throw new Error(`${entry.name} in the extension is not the pinned file`);
  return bytes;
}

/**
 * Bring `entry` into the store, verified. Resolves when the file is in place; throws
 * DownloadPaused when `signal` aborts (the part stays), DownloadFailed otherwise.
 */
export async function downloadFile(store: FileStore, entry: PinnedFile, options: DownloadOptions = {}): Promise<void> {
  const { signal, onProgress = () => {}, onNotice = () => {}, transport, retryWaits = RETRY_WAITS, route = {}, connectTimeout = CONNECT_TIMEOUT } = options;
  const part = `${entry.name}.part`;
  const paused = () => { if (signal?.aborted) throw new DownloadPaused(); };
  paused();
  if (!secure(entry.url)) throw new DownloadFailed("Model downloads require HTTPS");
  const sources = [entry.url, ...(entry.mirrors ?? []).filter(secure)];
  const hostOf = (url: string): string => new URL(url).hostname;
  let source = route.mirror ? Math.max(0, sources.findIndex((url) => hostOf(url) === MIRROR_HOST)) : 0;
  if (source > 0) onNotice(mirrorNotice(hostOf(sources[source]!)));
  for (let attempt = 0; ; attempt++) {
    try {
      await attemptDownload(store, { ...entry, url: sources[source]! }, part, transport, signal, onProgress, connectTimeout);
      return;
    } catch (error) {
      if (error instanceof DownloadPaused) throw error;
      // A full disk stays full however often it is asked, whichever write found it so.
      if (outOfSpace(error)) throw noRoomFor(entry.name);
      // A host that answers nothing: the next address, at once, without spending a retry.
      if (error instanceof DownloadFailed && error.unreachable && source < sources.length - 1) {
        source++;
        if (hostOf(sources[source]!) === MIRROR_HOST) route.mirror = true;
        onNotice(mirrorNotice(hostOf(sources[source]!)));
        attempt--;
        continue;
      }
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
  signal: AbortSignal | undefined, onProgress: (bytes: number) => void, connectTimeout: number): Promise<void> {
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
  // Aborted only while no answer has come: once it has, the body streams for as long as it takes.
  const connecting = new AbortController();
  const timer = setTimeout(() => connecting.abort(), connectTimeout);
  const request: RequestInit = {
    method: "GET",
    mode: "cors",
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, connecting.signal]) : connecting.signal,
  };
  const response = await (transport ? transport(entry.url, request) : fetch(entry.url, request)).catch((error: unknown) => {
    if (signal?.aborted) throw new DownloadPaused();
    if (connecting.signal.aborted) throw new DownloadFailed(`The network request for ${entry.name} timed out`, true, true);
    if ((error as { name?: string }).name === "AbortError") throw new DownloadPaused();
    throw new DownloadFailed(`The network request for ${entry.name} failed`, true, true);
  }).finally(() => clearTimeout(timer));
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
    throw new DownloadFailed(`The server answered ${entry.name} with status ${response.status}`, response.status >= 500 || response.status === 429, response.status >= 500);
  }
  if (!response.body) throw new DownloadFailed(`The server sent no body for ${entry.name}`, true);
  const writer = await store.writer(part, resumed);
  const reader = response.body.getReader();
  let oversized = false;
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
      if (offset + chunk.length > entry.size_bytes) { oversized = true; throw new DownloadFailed(`${entry.name} is larger than its pinned size`); }
      hasher.update(chunk);
      // A write that fails stops the download here: the response is cancelled and the part
      // keeps what the disk took (downloadFile says why).
      await writer.write(chunk);
      offset += chunk.length;
      onProgress(offset);
      paused();
    }
  } catch (error) {
    await writer.close().catch(() => {});
    reader.cancel().catch(() => {});
    // More bytes than the pinned file has are not the pinned file: what arrived goes, as the
    // setup page says of a damaged download.
    if (oversized) await store.delete(part).catch(() => {});
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
