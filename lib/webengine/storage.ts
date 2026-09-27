// lib/webengine/storage.ts — where the in-browser engine keeps its model files.
//
// The origin-private file system (OPFS) of the extension's own origin: a file system
// only this extension can open, on disk, outside any quota prompt for an installed
// extension, with random-access reads and appends through synchronous access handles in
// a worker, and a file handed to the runtime as a Blob that it reads a tensor at a time.
// Cache Storage would hold the same bytes but only whole responses: no appending to a
// partial download. The engine's directory holds the verified files, `.part` files of
// unfinished downloads and `state.json` (settings, and which files were verified).
// `FileStore` is the seam; the suite runs the engine on the in-memory store.

export interface FileWriter {
  write(chunk: Uint8Array): Promise<void>;
  /** Flush and close, keeping the file. */
  close(): Promise<void>;
}

export interface FileStore {
  /** The file's size, or null when there is no such file. */
  size(name: string): Promise<number | null>;
  /** The whole file. */
  read(name: string): Promise<Uint8Array>;
  /** The file as a Blob, read from disk only as it is read. */
  file(name: string): Promise<Blob>;
  /** The file's bytes from the start, in chunks. */
  stream(name: string, chunkBytes?: number): AsyncIterable<Uint8Array>;
  /** A writer at the end of the file (`append`) or over a new empty file. */
  writer(name: string, append: boolean): Promise<FileWriter>;
  /** Cut the file to `length` bytes. */
  truncate(name: string, length: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
  /** Bytes used by the store's files, and the origin's estimate when the browser gives one. */
  estimate(): Promise<{ used: number; quota: number | null }>;
}

/** The directory under the origin's root that holds everything. */
export const DIRECTORY = "anagram-engine";
const CHUNK = 8 * 1024 * 1024;

interface SyncHandle {
  read(buffer: ArrayBufferView, options?: { at: number }): number;
  write(buffer: ArrayBufferView, options?: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface OpfsFile extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncHandle>;
  move?(name: string): Promise<void>;
}

/** The origin-private file system, from a dedicated worker (synchronous access handles). */
export class OpfsStore implements FileStore {
  private constructor(private readonly dir: FileSystemDirectoryHandle) {}

  static async open(): Promise<OpfsStore> {
    const root = await navigator.storage.getDirectory();
    return new OpfsStore(await root.getDirectoryHandle(DIRECTORY, { create: true }));
  }

  private async handle(name: string, create = false): Promise<OpfsFile | null> {
    try { return (await this.dir.getFileHandle(name, { create })) as OpfsFile; }
    catch (error) { if ((error as { name?: string }).name === "NotFoundError") return null; throw error; }
  }

  async size(name: string): Promise<number | null> {
    const file = await this.handle(name);
    return file ? (await file.getFile()).size : null;
  }

  async read(name: string): Promise<Uint8Array> {
    const file = await this.handle(name);
    if (!file) throw new Error(`no such file: ${name}`);
    const access = await file.createSyncAccessHandle();
    try {
      const out = new Uint8Array(access.getSize());
      this.readAll(access, out);
      return out;
    } finally { access.close(); }
  }

  async file(name: string): Promise<Blob> {
    const file = await this.handle(name);
    if (!file) throw new Error(`no such file: ${name}`);
    return file.getFile();
  }

  private readAll(access: SyncHandle, target: Uint8Array): void {
    // Chunked: one read of a gigabyte is refused by some implementations.
    for (let at = 0; at < target.length; ) {
      const got = access.read(target.subarray(at, Math.min(target.length, at + CHUNK)), { at });
      if (got <= 0) throw new Error("short read from the origin-private file system");
      at += got;
    }
  }

  async *stream(name: string, chunkBytes = CHUNK): AsyncIterable<Uint8Array> {
    const file = await this.handle(name);
    if (!file) throw new Error(`no such file: ${name}`);
    const access = await file.createSyncAccessHandle();
    try {
      const size = access.getSize();
      for (let at = 0; at < size; ) {
        const chunk = new Uint8Array(Math.min(chunkBytes, size - at));
        const got = access.read(chunk, { at });
        if (got <= 0) throw new Error("short read from the origin-private file system");
        yield chunk.subarray(0, got);
        at += got;
      }
    } finally { access.close(); }
  }

  async writer(name: string, append: boolean): Promise<FileWriter> {
    const file = (await this.handle(name, true))!;
    const access = await file.createSyncAccessHandle();
    let at = append ? access.getSize() : 0;
    if (!append) access.truncate(0);
    return {
      write: async (chunk) => {
        const wrote = access.write(chunk, { at });
        if (wrote !== chunk.length) { access.close(); throw new Error("short write to the origin-private file system"); }
        at += wrote;
      },
      close: async () => { access.flush(); access.close(); },
    };
  }

  async truncate(name: string, length: number): Promise<void> {
    const file = await this.handle(name);
    if (!file) return;
    const access = await file.createSyncAccessHandle();
    try { access.truncate(length); access.flush(); } finally { access.close(); }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = await this.handle(from);
    if (!file) throw new Error(`no such file: ${from}`);
    await this.delete(to);
    if (file.move) { await file.move(to); return; }
    // No move(): copy through access handles, then drop the source.
    const target = (await this.handle(to, true))!;
    const source = await file.createSyncAccessHandle();
    const sink = await target.createSyncAccessHandle();
    try {
      const size = source.getSize();
      const chunk = new Uint8Array(CHUNK);
      for (let at = 0; at < size; ) {
        const got = source.read(chunk, { at });
        if (got <= 0) throw new Error("short read from the origin-private file system");
        sink.write(chunk.subarray(0, got), { at });
        at += got;
      }
      sink.flush();
    } finally { source.close(); sink.close(); }
    await this.delete(from);
  }

  async delete(name: string): Promise<void> {
    try { await this.dir.removeEntry(name); }
    catch (error) { if ((error as { name?: string }).name !== "NotFoundError") throw error; }
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of (this.dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.sort();
  }

  async estimate(): Promise<{ used: number; quota: number | null }> {
    let used = 0;
    for (const name of await this.list()) used += (await this.size(name)) ?? 0;
    let quota: number | null = null;
    try { quota = (await navigator.storage.estimate()).quota ?? null; } catch { /* no estimate here */ }
    return { used, quota };
  }
}

/** The same store in memory, for the suite. */
export class MemoryStore implements FileStore {
  readonly files = new Map<string, Uint8Array>();
  quota: number | null = null;

  async size(name: string): Promise<number | null> { return this.files.get(name)?.length ?? null; }
  async read(name: string): Promise<Uint8Array> {
    const file = this.files.get(name);
    if (!file) throw new Error(`no such file: ${name}`);
    return file.slice();
  }
  async file(name: string): Promise<Blob> {
    return new Blob([await this.read(name) as Uint8Array<ArrayBuffer>]);
  }
  async *stream(name: string, chunkBytes = 64 * 1024): AsyncIterable<Uint8Array> {
    const file = await this.read(name);
    for (let at = 0; at < file.length; at += chunkBytes) yield file.subarray(at, Math.min(file.length, at + chunkBytes));
  }
  async writer(name: string, append: boolean): Promise<FileWriter> {
    const parts: Uint8Array[] = [];
    if (append && this.files.has(name)) parts.push(this.files.get(name)!);
    else this.files.set(name, new Uint8Array(0));
    const flush = () => {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      this.files.set(name, out);
    };
    return {
      write: async (chunk) => { parts.push(chunk.slice()); flush(); },
      close: async () => { flush(); },
    };
  }
  async truncate(name: string, length: number): Promise<void> {
    const file = this.files.get(name);
    if (file) this.files.set(name, file.slice(0, length));
  }
  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) throw new Error(`no such file: ${from}`);
    this.files.set(to, file);
    this.files.delete(from);
  }
  async delete(name: string): Promise<void> { this.files.delete(name); }
  async list(): Promise<string[]> { return [...this.files.keys()].sort(); }
  async estimate(): Promise<{ used: number; quota: number | null }> {
    let used = 0;
    for (const file of this.files.values()) used += file.length;
    return { used, quota: this.quota };
  }
}
