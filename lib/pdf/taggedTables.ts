import type { PDFPageProxy } from "pdfjs-dist";
import type { StructTreeNode, StructTreeContent, TextContent } from "pdfjs-dist/types/src/display/api";

/** Table rows in declared cell order. Each number indexes a text-layer item. */
export type TaggedRow = number[][];

export async function taggedTableRows(page: PDFPageProxy, content: TextContent): Promise<TaggedRow[]> {
  if (!content.items.some((item) => "type" in item && item.type === "beginMarkedContentProps" && item.id)) return [];
  const tree = await page.getStructTree();
  if (!tree) return [];
  const rows: TaggedRow[] = [];
  const owners = new Map<string, number[]>();
  function visit(node: StructTreeNode | StructTreeContent, row?: TaggedRow, cell?: number[]): void {
    if ("type" in node) {
      if (node.type === "content" && cell && !owners.has(node.id)) owners.set(node.id, cell);
      return;
    }
    if (node.role === "Table") { row = undefined; cell = undefined; }
    if (node.role === "TR") { row = []; rows.push(row); cell = undefined; }
    if ((node.role === "TD" || node.role === "TH") && row) { cell = []; row.push(cell); }
    for (const child of node.children) visit(child, row, cell);
  }
  visit(tree);
  if (!owners.size) return [];

  let index = 0;
  const stack: (number[] | undefined)[] = [];
  for (const item of content.items) {
    if ("str" in item) {
      if (item.str.trim()) stack.at(-1)?.push(index);
      index++;
    } else if (item.type === "endMarkedContent") stack.pop();
    else if (item.type === "beginMarkedContent" || item.type === "beginMarkedContentProps")
      stack.push(owners.get(item.id) ?? stack.at(-1));
  }
  return rows.filter((row) => row.some((cell) => cell.length));
}
