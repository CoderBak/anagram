import { safePdfSource, samePdfSource } from "./source";
import { SOURCE_CAP, sourceHasMagic } from "./sourceTransfer";

/** The private loader tightens the broad manifest policy before its one authorized read. */
export function loaderConnectPolicy(source: string): string | null {
  const url = safePdfSource(source);
  return url ? `connect-src ${url.protocol === "file:" ? "file:" : url.origin}` : null;
}
export async function readAuthorizedPdf(source: string, signal: AbortSignal, cap = SOURCE_CAP): Promise<Uint8Array> {
  const url = safePdfSource(source);
  if (!url || signal.aborted || !Number.isSafeInteger(cap) || cap < 1 || cap > SOURCE_CAP) throw new Error("read");
  url.hash = "";
  if (url.protocol === "file:") return readFile(url.href, signal, cap);
  const response = await fetch(url.href, {signal, credentials: "include", cache: "force-cache", redirect: "error", referrerPolicy: "no-referrer"});
  if (!response.ok || response.redirected || (response.url && !samePdfSource(response.url, url.href)) || !response.body) {
    await response.body?.cancel(); throw new Error("read");
  }
  if (Number(response.headers.get("content-length")) > cap) { await response.body.cancel(); throw new Error("large"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      if (size > cap || signal.aborted) throw new Error(size > cap ? "large" : "read");
      chunks.push(result.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  if (!sourceHasMagic(bytes)) throw new Error("type");
  return bytes;
}
function readFile(source: string, signal: AbortSignal, cap: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); let done = false;
    const finish = (error?: string, bytes?: Uint8Array) => {
      if (done) return; done = true; signal.removeEventListener("abort", abort);
      if (error) { xhr.abort(); reject(new Error(error)); } else resolve(bytes!);
    };
    const abort = () => finish("read");
    xhr.open("GET", source, true); xhr.responseType = "arraybuffer";
    xhr.timeout = 30_000;
    xhr.onprogress = (event) => { if (event.loaded > cap || (event.lengthComputable && event.total > cap)) finish("large"); };
    xhr.onerror = xhr.ontimeout = xhr.onabort = abort;
    xhr.onload = () => {
      if ((xhr.status !== 0 && xhr.status !== 200) || !samePdfSource(xhr.responseURL || source, source) || !(xhr.response instanceof ArrayBuffer)) { finish("read"); return; }
      const bytes = new Uint8Array(xhr.response);
      if (bytes.byteLength > cap) finish("large");
      else if (!sourceHasMagic(bytes)) finish("type");
      else finish(undefined, bytes);
    };
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort(); else xhr.send();
  });
}
