// lib/pdf/route.ts — where a PDF opens, decided in one place.
//
// Two questions, both answered here so that the ball's "Analyze PDF" chip, the popup's
// "Read this PDF" button, the context menu's "Open PDF with Anagram" and the automatic
// route can never disagree:
//
//   twinExists()     — does this paper's HTML rendering really exist? (lib/pdf/source.ts
//                      says what its address WOULD be; only the network knows.)
//   shouldAutoOpen() — may a PDF tab turn itself into the reading mode by itself?
//
// Both are written as plain functions over their inputs — the fetch is injected — so the
// rules can be pinned in test/node/pdf-route.test.ts without a browser.
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

// ---- the automatic route -----------------------------------------------------------------

/** What the worker knows about a tab that has just shown it a PDF. */
export interface AutoOpenFacts {
  /** "Open PDFs in Anagram". Read fresh for every PDF, so turning it off needs no restart. */
  setting: boolean;
  /** What the document says it is — the tab's own `document.contentType`. */
  contentType: string;
  /** The PDF's `location.protocol`. */
  protocol: string;
  /** `performance.getEntriesByType("navigation")[0].type` for that document. */
  navigationType: string;
  /** Which frame reported it. Only the tab's own document may take the tab somewhere. */
  frame: number;
  /** This one load was let through — "Open original" in the reader is on its way here. */
  pass: boolean;
}

/**
 * Protocols the reading mode can fetch the document back from. A `blob:`, `data:` or
 * POST-result PDF exists only in the tab that is showing it — the reader would be handed
 * an address it cannot re-fetch and would land on "This PDF could not be loaded", which is
 * a worse tab than the PDF was.
 *
 * `file:` is in the list because the one permission decides both halves of it: Chrome's
 * "Allow access to file URLs" is what lets a content script run on a local PDF at all AND
 * what lets the reader page fetch it. Without the tick nothing here is ever asked, because
 * no content script runs; with it, both work (verified in test/pdf-route-check.mjs).
 *
 * What the protocol cannot catch is a PDF that came back from a POST: nothing inside the
 * document says which method fetched it, so the reader would re-ask with a GET and land on
 * "This PDF could not be loaded". The Back button still holds the PDF itself, which is the
 * same way out as every other unreadable file here.
 */
const REFETCHABLE = new Set(["http:", "https:", "file:"]);

/**
 * May this PDF tab become the reading mode by itself?
 *
 * The rules that are not obvious, and the case each one is for:
 *
 *   back/forward — the reading mode REPLACES the tab, so the PDF is still in history and
 *                  Back lands on it again. Bouncing forward from there would take the
 *                  Back button away from the reader altogether.
 *   pass         — "Open original" in the reader, and the same way out of every line that
 *                  says the file could not be read, would otherwise come straight back.
 *   frame        — a PDF in an <iframe> is part of somebody's page, not the tab.
 *   protocol     — see REFETCHABLE above.
 *
 * Downloads need no rule: a PDF served with `Content-Disposition: attachment` never
 * becomes a document, no content script runs for it, and nothing here is ever asked.
 */
export function shouldAutoOpen(facts: AutoOpenFacts): boolean {
  if (!facts.setting) return false;
  if (facts.frame !== 0) return false;
  if (facts.contentType !== "application/pdf") return false;
  if (!REFETCHABLE.has(facts.protocol)) return false;
  if (facts.navigationType === "back_forward") return false;
  if (facts.pass) return false;
  return true;
}
