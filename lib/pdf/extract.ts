import type { PDFPageProxy } from "pdfjs-dist";
import { loadPdfjs } from "../lazy";
import { isRotated, type PdfPageText, type PdfTextItem } from "./reflow";

/** Match the upstream TextLayerBuilder options so item offsets refer to the same text. */
export async function extractPageText(page: PDFPageProxy): Promise<PdfPageText> {
  const [pdfjs, content] = await Promise.all([
    loadPdfjs(), page.getTextContent({ includeMarkedContent: true, disableNormalization: true }),
  ]);
  const viewport = page.getViewport({ scale: 1 });
  const items: PdfTextItem[] = [];
  const fonts: Record<string, string> = {};
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
    items.push({
      str: item.str, x: matrix[4], y: matrix[5], width: item.width, height: item.height,
      fontName: item.fontName, hasEOL: item.hasEOL,
      rotated: isRotated(matrix),
    });
    // The font's PDF name reaches the main thread with the page's drawing, which the
    // viewer has done by the time it builds the text layer; a font not there yet is
    // simply not named, and nothing set in it is taken for mathematics.
    if (item.fontName && !(item.fontName in fonts)) fonts[item.fontName] = fontNameOf(page, item.fontName);
  }
  return {page: page.pageNumber, width: viewport.width, height: viewport.height, items, transform: [...viewport.transform], fonts};
}

/** Name the fonts of a page's text that were not loaded when it was read: a page not drawn
 *  has its fonts from the pages drawn or read before it that share them, and loads the rest
 *  itself (getOperatorList). Whether every font is named now. */
export function nameFonts(page: PDFPageProxy, text: PdfPageText): boolean {
  const fonts = text.fonts ?? {};
  let all = true;
  for (const id of Object.keys(fonts)) {
    if (!fonts[id]) fonts[id] = fontNameOf(page, id);
    if (!fonts[id]) all = false;
  }
  return all;
}

function fontNameOf(page: PDFPageProxy, loadedName: string): string {
  try {
    const objs = page.commonObjs as { has(id: string): boolean; get(id: string): unknown };
    const font = objs.has(loadedName) ? (objs.get(loadedName) as { name?: unknown } | null) : null;
    return typeof font?.name === "string" ? font.name : "";
  } catch {
    return "";
  }
}
