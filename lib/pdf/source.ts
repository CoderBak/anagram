// lib/pdf/source.ts — what counts as a PDF, and what to call it.
//
// Three surfaces have to agree on this without being able to ask each other: the popup
// (which sees a tab URL and, on Chrome, a content script's answer), the service worker
// (which sees a link's URL) and the reader page (which sees its own ?src=). The rules
// live here, free of the extension APIs, so test/node/pdf-reflow.test.ts can pin them.

/** The reader page, as an extension URL relative to the extension root. */
export const READER_PAGE = "/reader.html";

/**
 * Does this URL point at a PDF? Only the path can answer, so the test is the path's
 * extension — the popup uses it on Firefox, whose built-in viewer admits no content
 * script that could report `document.contentType` instead.
 */
export function looksLikePdfUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The reader's query string for a source document. */
export function readerQuery(src: string): string {
  return `?src=${encodeURIComponent(src)}`;
}

// ---- HTML twins -------------------------------------------------------------------------
//
// Some PDFs are a rendering of a document that also exists as real HTML, and where that is
// so the HTML is strictly the better thing to analyze: it has paragraphs, headings and
// formulas as themselves, rather than glyphs at coordinates that lib/pdf/reflow.ts has to
// guess a document back out of. arXiv is the case that started this — every paper it can
// convert is published at arxiv.org/html/<id> (LaTeXML) beside the PDF — and the shape
// below is a list of recognisers so a second source (ar5iv, PMC, bioRxiv `.full`) is one
// more function and nothing else.
//
// This only says WHICH address would be the twin. Whether it exists is a question for the
// network, and the service worker asks it — see lib/pdf/route.ts.

/**
 * The arXiv hosts whose `/pdf/` addresses name a paper. The two mirrors are the same
 * repository under another name, so a paper found on either is asked for from arxiv.org
 * itself — that is the address that always answers and the one a reader expects to see.
 */
const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);

/**
 * An arXiv identifier: `2301.10226` and `2301.10226v7` from 2007 onward, `hep-th/9901001`
 * and `cond-mat.stat-mech/0703041v2` before it. The version is kept when the PDF URL names
 * one, so the HTML is the same version of the paper; without one arXiv resolves the
 * address to the latest, which is what a versionless PDF URL means too.
 */
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z-]{2,})?\/\d{7})(?:v\d+)?$/;

function arxivTwin(u: URL): string | null {
  if (!ARXIV_HOSTS.has(u.hostname.toLowerCase())) return null;
  if (!u.pathname.startsWith("/pdf/")) return null;
  // `/abs/` is already an HTML page and `/format/`, `/src/` and the rest are not the paper
  // at all, so only `/pdf/` gets here. The `.pdf` suffix is optional on arXiv's own links.
  const id = u.pathname.slice("/pdf/".length).replace(/\.pdf$/i, "");
  return ARXIV_ID.test(id) ? `https://arxiv.org/html/${id}` : null;
}

/** Every source we know a true HTML rendering of, tried in order. */
const TWIN_RULES: ((u: URL) => string | null)[] = [arxivTwin];

/**
 * The HTML rendering of the document this PDF URL points at, or null when the URL names
 * no source we know. A twin is a claim about the ADDRESS only: the caller still has to
 * find out whether that page was ever built.
 */
export function htmlTwinOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // A `file:` or `blob:` PDF has no publisher to ask, and a `javascript:` URL that spells
  // a host somewhere inside itself is not that host.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  for (const rule of TWIN_RULES) {
    const twin = rule(u);
    if (twin) return twin;
  }
  return null;
}

/**
 * A name for the document, taken from the URL's last path segment. Used as the title
 * until the PDF's own metadata supplies a better one, and in the copied report.
 */
export function pdfNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    return name === "" ? url : name;
  } catch {
    return url;
  }
}
