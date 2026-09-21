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
