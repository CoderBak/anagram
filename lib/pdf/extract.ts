import type { PDFPageProxy } from "pdfjs-dist";
import { loadPdfjs } from "../lazy";
import type { PdfPageText, PdfTextItem } from "./reflow";

/** Match the upstream TextLayerBuilder options so item offsets refer to the same text. */
export async function extractPageText(page: PDFPageProxy): Promise<PdfPageText> {
  const [pdfjs, content] = await Promise.all([
    loadPdfjs(), page.getTextContent({ includeMarkedContent: true, disableNormalization: true }),
  ]);
  const viewport = page.getViewport({ scale: 1 });
  const items: PdfTextItem[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
    items.push({
      str: item.str, x: matrix[4], y: matrix[5], width: item.width, height: item.height,
      fontName: item.fontName, hasEOL: item.hasEOL,
      rotated: Math.abs(matrix[1]) > .02 || Math.abs(matrix[2]) > .02,
    });
  }
  return {page: page.pageNumber, width: viewport.width, height: viewport.height, items};
}
