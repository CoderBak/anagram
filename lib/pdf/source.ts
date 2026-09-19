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
