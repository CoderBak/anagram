// lib/pdf/route.ts — where a PDF opens, decided in one place.
//
// One question, answered here so that the ball's "Analyze PDF" chip, the popup's "Read
// this PDF" button and the context menu's "Open PDF with Anagram" can never disagree:
// does this paper's HTML rendering really exist? lib/pdf/source.ts says what its address
// WOULD be; only the network knows whether it was ever built.
//
// It is written as a plain function over its inputs — the fetch is injected — so the rule
// can be pinned in test/node/pdf-route.test.ts without a browser.
//
// WHAT LEAVES THE MACHINE. Only arxiv.org is ever contacted, only for a paper the reader
// is opening at that moment, and only for the first four kilobytes of its HTML page. No
// page text, no verdict and no address of anything else goes anywhere: scoring stays on
// the loopback daemon, as it always has.
import { htmlTwinOf } from "./source";

/**
 * How long the twin may take to answer. A reader clicked something and is waiting, and
 * the reading mode is a perfectly good answer — so anything slower than this is treated
 * as "no twin" and the PDF opens the way it always did.
 */
export const TWIN_TIMEOUT_MS = 2500;

/** How much of the page is read to recognise it. The LaTeXML marker sits in the first
 *  300 bytes of every arXiv paper checked; the rest is slack for a longer <head>. */
export const TWIN_PREFIX_BYTES = 4096;

/**
 * What a converted paper looks like in its own first bytes. arXiv answers 404 for a paper
 * it never converted (verified 2026-09-19: physics/0004090 and quant-ph/9605043 both 404,
 * as does a version that does not exist), so the status alone would do today — but a
 * "sorry, no HTML" page served as 200 is exactly the sort of thing a repository changes
 * one day, and it would land the reader on an error page instead of their paper. A page
 * that does not say LaTeXML built it is not the paper.
 */
const LATEXML_MARKER = /LaTeXML|ltx_/;

export interface TwinDeps {
  /** Injected so the suites can answer it themselves; the worker passes the real one. */
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** The first `max` bytes of a response as text, leaving the rest on the wire. */
async function prefixOf(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (!body) return (await response.text()).slice(0, max);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    while (read < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      read += value.byteLength;
    }
  } finally {
    // A paper is half a megabyte and we want four kilobytes of it: the rest is cancelled
    // rather than downloaded and thrown away.
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined.subarray(0, max));
}

/**
 * Has this HTML twin been built? A ranged GET rather than a HEAD: HEAD answers correctly
 * today, but it cannot tell a paper from a stub, and the range costs one packet more.
 * Anything unclear — a timeout, a refused connection, a redirect somewhere else, an
 * answer that is not HTML — is a no, because the reading mode is always available and
 * sending a reader to the wrong page is worse than converting a PDF they could have read.
 */
export async function twinExists(url: string, deps: TwinDeps): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TWIN_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, {
      method: "GET",
      // arXiv honours the range (206 with a content-range); a server that ignores it
      // sends 200 and the whole file, which prefixOf() stops reading after 4 kB.
      headers: { Range: `bytes=0-${TWIN_PREFIX_BYTES - 1}`, Accept: "text/html" },
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (response.status !== 200 && response.status !== 206) return false;
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) return false;
    return LATEXML_MARKER.test(await prefixOf(response, TWIN_PREFIX_BYTES));
  } catch {
    // Offline, aborted at the deadline, or a body that stopped mid-read.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A resolver with a memory: the address of the HTML twin of `pdfUrl` when one exists,
 * null otherwise. Each paper is asked about once — a reader who opens the same paper
 * twice, or clicks the chip twice, makes one request — and the answers live only as long
 * as the worker does, so a paper converted this afternoon is found this evening.
 */
export function createTwinResolver(deps: TwinDeps): (pdfUrl: string) => Promise<string | null> {
  const asked = new Map<string, Promise<boolean>>();
  return async (pdfUrl: string) => {
    const twin = htmlTwinOf(pdfUrl);
    if (twin === null) return null;
    let answer = asked.get(twin);
    if (!answer) {
      // Stored before it settles, so two clicks in the same second share one request.
      answer = twinExists(twin, deps);
      asked.set(twin, answer);
    }
    return (await answer) ? twin : null;
  };
}
