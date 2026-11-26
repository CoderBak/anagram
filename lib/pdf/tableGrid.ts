// Cell rectangles in a PDF's paint or clipping paths can distinguish a table from
// columns of prose. Coordinates in the result use the text layer's scale-one viewport.
import type { PDFPageProxy } from "pdfjs-dist";
import { loadPdfjs } from "../lazy";
import type { PdfTextItem } from "./reflow";

export interface TableRowBox { top: number; bottom: number; edges: number[] }

type Box = [number, number, number, number];

/** A repeated row of touching cells. A standalone box, page border or column frame
 *  does not establish a table. */
function adjoiningStrips(boxes: Box[]): Map<string, TableRowBox[]> {
  const strips = new Map<string, Box[]>();
  for (const box of boxes) {
    const key = box[1] + "," + box[3];
    const strip = strips.get(key);
    if (strip) strip.push(box); else strips.set(key, [box]);
  }
  const columns = new Map<string, TableRowBox[]>();
  for (const strip of strips.values()) {
    strip.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    let edges: number[] = [];
    const finish = () => {
      if (edges.length < 3) return;
      const row = { top: strip[0]![1], bottom: strip[0]![3], edges };
      const key = edges.join(",");
      const group = columns.get(key);
      if (group) group.push(row); else columns.set(key, [row]);
    };
    for (const [left, , right] of strip) {
      const last = edges.at(-1);
      if (last !== undefined && left < last) continue;
      if (last !== left) { finish(); edges = [left]; }
      edges.push(right);
    }
    finish();
  }
  return columns;
}

function adjoiningRows(boxes: Box[]): TableRowBox[] {
  const columns = adjoiningStrips(boxes.filter(([x, y, right, bottom]) => right - x > 2 && bottom - y > 2));
  const rows: TableRowBox[] = [];
  for (const group of columns.values()) {
    group.sort((a, b) => a.top - b.top);
    group.forEach((r, i) => {
      if (group[i - 1]?.bottom === r.top || group[i + 1]?.top === r.bottom) rows.push(r);
    });
  }
  // Some generators paint alternate cell backgrounds. Their unshaded cells have
  // only segmented horizontal rules and the two sides of the enclosing table.
  const rules = adjoiningStrips(boxes.filter(([x, y, right, bottom]) => right - x > 2 && bottom - y <= 2));
  const sides = new Map<number, [number, number][]>();
  for (const [x, y, right, bottom] of boxes) {
    if (right - x > 2 || bottom - y <= 2) continue;
    const key = Math.round((x + right) / 2), spans = sides.get(key);
    if (spans) spans.push([y, bottom]); else sides.set(key, [[y, bottom]]);
  }
  const bounded = (x: number, top: number, bottom: number) => {
    for (let key = Math.round(x) - 1; key <= Math.round(x) + 1; key++)
      if (sides.get(key)?.some(([a, b]) => a <= top + 1 && b >= bottom - 1)) return true;
    return false;
  };
  for (const strips of rules.values()) {
    strips.sort((a, b) => a.top - b.top);
    for (let i = 1; i < strips.length; i++) {
      const upper = strips[i - 1]!, lower = strips[i]!, { edges } = upper;
      const top = (upper.top + upper.bottom) / 2, bottom = (lower.top + lower.bottom) / 2;
      if (bottom - top > 2 && bounded(edges[0]!, top, bottom) && bounded(edges.at(-1)!, top, bottom))
        rows.push({ top, bottom, edges });
    }
  }
  return rows.sort((a, b) => a.top - b.top);
}

function separatedText(items: PdfTextItem[]): boolean {
  const lines = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    if (!item.str.trim() || item.rotated) continue;
    const y = Math.round(item.y), line = lines.get(y);
    if (line) line.push(item); else lines.set(y, [item]);
  }
  const anchors = new Map<number, number>();
  for (const [y, line] of lines) {
    if (line.length < 2) continue;
    line.sort((a, b) => a.x - b.x);
    let right = line[0]!.x + line[0]!.width;
    for (const item of line.slice(1)) {
      if (item.x - right > 2 * item.height) {
        const left = Math.round(item.x / 2), earlier = anchors.get(left);
        if (earlier !== undefined && earlier !== y) return true;
        anchors.set(left, y);
      }
      right = Math.max(right, item.x + item.width);
    }
  }
  return false;
}

export async function pageTableRows(page: PDFPageProxy, viewport: number[], items: PdfTextItem[]): Promise<TableRowBox[]> {
  if (!separatedText(items)) return [];
  const [{ OPS, Util }, ops] = await Promise.all([loadPdfjs(), page.getOperatorList()]);
  const stack: number[][] = [], boxes: Box[] = [];
  let matrix = viewport, isolated = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    // Groups and annotations have their own coordinate systems.
    if (op === OPS.beginGroup || op === OPS.beginAnnotation) { isolated++; continue; }
    if (op === OPS.endGroup || op === OPS.endAnnotation) { isolated--; continue; }
    if (isolated) continue;
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push(matrix);
      if (op === OPS.paintFormXObjectBegin && args?.[0]) matrix = Util.transform(matrix, args[0]);
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      matrix = stack.pop() ?? viewport;
    } else if (op === OPS.transform) matrix = Util.transform(matrix, args);
    else if (op === OPS.constructPath && args?.[2]) {
      // PDF.js DrawOPS: moveTo, three lineTo operations, closePath. Check the
      // vertices as well as the bounding box so arbitrary artwork cannot supply cells.
      const p = args[1]?.[0];
      if (p?.length !== 13 || p[0] !== 0 || p[3] !== 1 || p[6] !== 1 || p[9] !== 1 || p[12] !== 4) continue;
      if (!(p[1] === p[4] && p[5] === p[8] && p[7] === p[10] && p[11] === p[2]) &&
          !(p[2] === p[5] && p[4] === p[7] && p[8] === p[11] && p[10] === p[1])) continue;
      if (!((matrix[1] === 0 && matrix[2] === 0) || (matrix[0] === 0 && matrix[3] === 0))) continue;
      const bounds = [Infinity, Infinity, -Infinity, -Infinity];
      Util.axialAlignedBoundingBox(args[2], matrix, bounds);
      const [x, y, right, bottom] = bounds.map((v) => Math.round(v * 2) / 2) as Box;
      if (right > x && bottom > y && (right - x > 2 || bottom - y > 2)) boxes.push([x, y, right, bottom]);
    }
  }
  return adjoiningRows(boxes);
}
