import { checkDetector, checkBackbone } from "./detectorFormat";
import initial from "../anagramd/detector-release.json";
export type DetectorRelease = typeof initial;
export const defaultRelease = initial;
export const detectorRepo = initial.repository;
const root = `https://huggingface.co/${detectorRepo}`;
export function detectorRevisionUrl(revision: string): string {
  return `${root}/tree/${encodeURIComponent(revision)}`;
}
const api = `https://huggingface.co/api/models/${detectorRepo}`;
const commit = /^[0-9a-f]{40}$/;
const name = /^(\d{4}-\d{2}-\d{2})-((?:[1-9]\d*|0(?=\.))(?:\.\d+)?)([mb])(?:-[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/;
export function releaseName(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 96) return false;
  const match = name.exec(value);
  const date = match?.[1];
  if (!match || Number(match[2]) <= 0) return false;
  if (!date) return false;
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}
function auxiliaryLimit(path: string) {
  return (path === "tokenizer/tokenizer.json" ? 32 : 16) * 2 ** 20;
}
export function validRelease(r: unknown): r is DetectorRelease {
  if (!r || typeof r !== "object") return false;
  const p = r as DetectorRelease;
  return (
    p.repository === detectorRepo &&
    p.schema_version === 1 &&
    releaseName(p.release) &&
    typeof p.revision === "string" &&
    commit.test(p.revision) &&
    Array.isArray(p.files) &&
    p.files.length === initial.files.length &&
    initial.files.every(({ path }) =>
      p.files.some(
        (f) =>
          f?.path === path &&
          typeof f.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(f.sha256) &&
          Number.isSafeInteger(f.size_bytes) &&
          f.size_bytes > 0 &&
          f.size_bytes <= (path === "backbone/model.safetensors" ? 32 * 2 ** 30 : auxiliaryLimit(path)),
      ),
    )
  );
}
export function detectorBytes(pin: DetectorRelease): number {
  return pin.files.reduce((sum, file) => sum + file.size_bytes, 0);
}

export interface ReleaseRef {
  release: string;
  revision: string;
}
async function read(url: string, limit: number, signal?: AbortSignal) {
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
    cache: "no-cache",
  });
  if (!response.ok) throw new Error(`Hugging Face HTTP ${response.status}`);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Release metadata exceeds the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function listDetectorReleases(signal?: AbortSignal): Promise<ReleaseRef[]> {
  const data = JSON.parse(new TextDecoder().decode(await read(api + "/refs", 2 ** 20, signal)));
  const refs = new Map<string, ReleaseRef>();
  for (const r of [...(data.tags ?? []), ...(data.branches ?? [])]) {
    if (releaseName(r.name) && commit.test(r.targetCommit))
      refs.set(r.name, { release: r.name, revision: r.targetCommit });
  }
  return [...refs.values()].sort(
    (a, b) =>
      b.release.slice(0, 10).localeCompare(a.release.slice(0, 10)) ||
      a.release.localeCompare(b.release, "en", { numeric: true }),
  );
}
interface HubRevision {
  sha: string;
  siblings: { rfilename: string; size: number; lfs?: { sha256: string } }[];
}

async function revisionInfo(revision: string, signal?: AbortSignal): Promise<HubRevision> {
  return JSON.parse(new TextDecoder().decode(await read(api + "/revision/" + revision + "?blobs=true", 2 ** 20, signal)));
}

export interface SetupCatalog {
  choices: ReleaseRef[];
  recommended: DetectorRelease | null;
  listed: boolean;
}

/** The Hub exposes revision metadata even when a gated repository restricts its refs. */
export async function setupCatalog(signal?: AbortSignal): Promise<SetupCatalog> {
  const [refs, info] = await Promise.all([
    listDetectorReleases(signal).catch(() => null),
    revisionInfo("default", signal).catch(() => null),
  ]);
  const choices = [...(refs ?? [])];
  let recommended: DetectorRelease | null = null;
  if (info && commit.test(info.sha)) {
    let ref = choices.find(r => r.revision === info.sha) ?? (info.sha === initial.revision ? initial : null);
    // A maintainer can move the default branch before creating its dated tag.
    if (!ref) {
      try {
        const bytes = await read(`${root}/resolve/${info.sha}/model.json`, 65536, signal);
        const meta = JSON.parse(new TextDecoder().decode(bytes));
        const release = meta.release_id ?? `${meta.release_date}-${meta.size}`;
        if (releaseName(release)) ref = {release, revision:info.sha};
      } catch { /* The Hub may restrict access to this revision's files. */ }
    }
    if (ref) {
      if (info.sha === initial.revision) {
        const files = initial.files.map(file => {
          const live = info.siblings?.find(item => item.rfilename === file.path);
          if (live?.size !== file.size_bytes || (live.lfs && live.lfs.sha256 !== file.sha256)) return null;
          return { ...file, size_bytes: live.size };
        });
        if (files.every(file => file !== null)) recommended = { ...initial, files };
      } else {
        recommended = await resolveDetectorRelease(ref, signal, info).catch(() => null);
      }
    }
  }
  if (recommended && !choices.some(ref => ref.revision === recommended.revision)) choices.unshift({release: recommended.release, revision: recommended.revision});
  if (!choices.some(ref => ref.revision === initial.revision)) choices.push({release: initial.release, revision: initial.revision});
  return { choices, recommended, listed: refs !== null };
}

export async function resolveDetectorRelease(
  ref: ReleaseRef,
  signal?: AbortSignal,
  info?: HubRevision,
): Promise<DetectorRelease> {
  if (!releaseName(ref.release) || !commit.test(ref.revision)) throw new Error("Invalid detector release");
  if (ref.release === initial.release && ref.revision === initial.revision) return initial;
  const data = info ?? await revisionInfo(ref.revision, signal);
  if (data.sha !== ref.revision) throw new Error("Release revision changed");
  const smallFiles = new Map<string, Uint8Array<ArrayBuffer>>();
  const metadata = async (path: string) => {
    const bytes = await read(`${root}/resolve/${ref.revision}/${path}`, 65536, signal);
    smallFiles.set(path, bytes);
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const [meta, config, crf] = await Promise.all(
    ["model.json", "backbone/config.json", "crf.json"].map(metadata),
  );
  checkDetector(meta, crf, ref.release);
  checkBackbone(config, meta.window, meta.architecture);
  const files = await Promise.all(
    initial.files.map(async ({ path }) => {
      const item = data.siblings?.find((s: { rfilename: string }) => s.rfilename === path);
      if (!item || !Number.isSafeInteger(item.size) || item.size <= 0)
        throw new Error("Incomplete detector release");
      let sha256 = item.lfs?.sha256;
      if (!sha256) {
        if (item.size > auxiliaryLimit(path)) throw new Error("Missing weight checksum");
        const bytes =
          smallFiles.get(path) ?? (await read(`${root}/resolve/${ref.revision}/${path}`, item.size, signal));
        if (bytes.length !== item.size) throw new Error("Incomplete metadata");
        sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      }
      return { path, size_bytes: item.size as number, sha256 };
    }),
  );
  const pin = { ...initial, ...ref, files };
  if (!validRelease(pin)) throw new Error("Invalid release files");
  return pin;
}
