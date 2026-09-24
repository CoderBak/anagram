// lib/dom/splits.ts — the page text nodes the walker cut, and how to put the page back.
//
// In preserved-whitespace text (a chat message, a post on X, a mailing-list archive) the
// walker cuts a text node at its blank lines so every paragraph is whole nodes and can
// carry a chip of its own. That is the one change Anagram makes to a page's own nodes,
// and a script that renders the page does not know about it: React, Vue, Svelte, Lit and
// Angular all update text by writing to the node THEY created. On X, "Show more" rewrote
// the post into that first node while the pieces cut off it stayed on screen, so the
// expanded post ended with a stale copy of its old preview — which was then scored too.
//
// So every cut is recorded: the page's own node (the head), the pieces made from it, in
// document order, and what the head was left holding. A cut stands only while the head
// still holds exactly that and the pieces still follow it. repairSplits() reads the
// page's mutations and puts things back the moment that stops being true:
//
// - the page wrote to its node       → the pieces are stale: remove them
// - the page removed its node        → the pieces are leftovers: remove them
// - the page moved its node away     → the head holds only its first paragraph: merge the
//                                      pieces back into it, as the page wrote it
//
// restoreSplits() merges everything back when Anagram stops on a page.
import { MARK_ATTR } from "../types";

interface Split {
  /** Nodes cut off the head, in document order. */
  pieces: Text[];
  /** What the head held after the last cut. */
  left: string;
}

const byHead = new Map<Text, Split>();
/** Piece → the page node it was cut from, so cutting a piece records it under its head. */
const headOf = new WeakMap<Text, Text>();

/** Text.splitText, recorded. Returns the new node after the cut, as splitText does. */
export function cutText(node: Text, offset: number): Text {
  const head = headOf.get(node) ?? node;
  const rest = node.splitText(offset);
  let split = byHead.get(head);
  if (!split) {
    split = { pieces: [], left: "" };
    byHead.set(head, split);
  }
  // splitText puts the new node right after the one it cut, and the walker only ever
  // cuts the head or the last piece, so appending keeps document order.
  const at = node === head ? 0 : split.pieces.indexOf(node) + 1;
  split.pieces.splice(at, 0, rest);
  headOf.set(rest, head);
  split.left = head.data;
  return rest;
}

function forget(head: Text, split: Split): void {
  byHead.delete(head);
  for (const piece of split.pieces) headOf.delete(piece);
}

/** The page changed its node: take the pieces away. */
function drop(head: Text, split: Split): void {
  forget(head, split);
  for (const piece of split.pieces) piece.remove();
}

/** The head is the page's own and unchanged: give it its text back. */
function merge(head: Text, split: Split): void {
  forget(head, split);
  head.appendData(split.pieces.map((piece) => piece.data).join(""));
  for (const piece of split.pieces) piece.remove();
}

/** One of Anagram's own elements: a chip sits between the pieces of a cut node. */
function ours(node: ChildNode | null): boolean {
  return node?.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute(MARK_ATTR);
}

/** Do the pieces still sit right after the head, in order, with only our chips between? */
function inPlace(head: Text, split: Split): boolean {
  let node: ChildNode | null = head.nextSibling;
  for (const piece of split.pieces) {
    while (ours(node)) node = node!.nextSibling;
    if (node !== piece) return false;
    node = node.nextSibling;
  }
  return true;
}

/**
 * Put the page back wherever it changed a node that was cut. Call with every batch of
 * mutation records BEFORE acting on them; the observer must ask for characterDataOldValue.
 */
export function repairSplits(records: Iterable<MutationRecord>): void {
  if (byHead.size === 0) return;
  let structural = false;
  for (const rec of records) {
    if (rec.type === "characterData") {
      const head = rec.target as Text;
      const split = byHead.get(head);
      // A write by the page finds the text as the cut left it. The cut's own record does
      // not: its old value is the text from before the cut.
      if (split && (rec.oldValue === split.left || head.data !== split.left)) drop(head, split);
    } else if (rec.type === "childList" && rec.removedNodes.length > 0) {
      structural = true;
    }
  }
  if (!structural) return;
  // A node leaves the page with its parent as often as on its own, and then no record
  // names it: look at every cut whenever anything was removed.
  for (const [head, split] of [...byHead]) {
    if (!head.isConnected) drop(head, split);
    else if (!inPlace(head, split)) merge(head, split);
  }
}

/** Anagram is leaving the page: every node it cut gets its text back. */
export function restoreSplits(): void {
  for (const [head, split] of [...byHead]) {
    if (!head.isConnected || head.data !== split.left) drop(head, split);
    else merge(head, split);
  }
}
