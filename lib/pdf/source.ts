// Shared PDF source validation and names; these helpers never read a document.
/** The reader page, as an extension URL relative to the extension root. */
export const READER_PAGE = "/reader.html";

/** Filename hint only; automatic HTTP routing uses the observed response MIME. */
export function looksLikePdfUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Only browser-local files and credential-free HTTP(S) documents can be transferred. */
export function safePdfSource(value: string): URL | null {
  if (value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === "file:") {
      // Reject UNC/SMB shares: a local-file grant must not become network access.
      if (url.hostname || !url.pathname.startsWith("/") || decodeURIComponent(url.pathname).replaceAll("\\", "/").startsWith("//")) return null;
    } else if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch { return null; }
}

export function samePdfSource(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = safePdfSource(a), right = safePdfSource(b);
  if (!left || !right) return false;
  left.hash = ""; right.hash = "";
  return left.href === right.href;
}

/** The reader's query string for a source document. */
export function readerQuery(src: string): string {
  return `?src=${encodeURIComponent(src)}`;
}

/**
 * A name for the document, taken from the URL's last path segment, as a file name (pdfFileName).
 * Used as the title until the PDF's own metadata supplies a better one, in the copied report,
 * and as the name the viewer's Download button saves it under.
 */
export function pdfNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    });
    const last = segments.at(-1) ?? "";
    // A segment that only says what the address serves ("pdf", "download", "view"): the
    // document is named in the query (openreview.net/pdf?id=…), or a segment up.
    if (!GENERIC_SEGMENT.test(last.replace(/\.[^.]*$/, ""))) return pdfFileName(last) ?? pdfFileName(parsed.hostname) ?? "document.pdf";
    for (const key of NAMING_PARAMETERS) {
      const value = parsed.searchParams.get(key);
      if (value) return pdfFileName(value.split("/").filter(Boolean).join("_")) ?? "document.pdf";
    }
    const up = segments.length > 1 ? segments[segments.length - 2]! : "";
    return (up && !GENERIC_SEGMENT.test(up) ? pdfFileName(up) : null) ?? pdfFileName(parsed.hostname) ?? "document.pdf";
  } catch {
    return "document.pdf";
  }
}

/** Path segments that name what is served, not which document. */
const GENERIC_SEGMENT = /^(pdf|pdfs|download|downloads|view|viewer|file|files|get|content|fulltext|document|show|stamp|render|open|)$/i;
/** Query parameters that name the document, in the order they are asked. */
const NAMING_PARAMETERS = ["filename", "file", "name", "id", "doi", "paper", "article", "arnumber"];

/** Script extensions a download address ends in, which the saved file does not keep. */
const SCRIPT_EXTENSION = /\.(php|aspx?|jsp|cgi|do|action|ashx|py|pl)$/i;

/**
 * `name` as a PDF's file name: the characters no file name may hold replaced, and ".pdf" at the
 * end — given to an arXiv number (2401.17377v2), put in place of a download script's extension
 * (download.php), as the browser's own viewer names them. pdf.js saves a name without it as
 * "document.pdf". Null for a name with nothing left.
 */
export function pdfFileName(name: string): string | null {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 200);
  if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return null;
  if (/\.pdf$/i.test(clean)) return clean;
  return SCRIPT_EXTENSION.test(clean) ? clean.replace(SCRIPT_EXTENSION, ".pdf") : `${clean}.pdf`;
}

/**
 * The file name a response gives its body (Content-Disposition, RFC 6266): `filename*`, the
 * encoded one, first; null where it gives none.
 */
export function dispositionName(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:"?)([^']*)'[^']*'([^;"]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[2]!.trim()); } catch { /* the plain one, then */ }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const value = plain ? (plain[1] ?? plain[2] ?? "").replace(/\\(.)/g, "$1").trim() : "";
  return value || null;
}
