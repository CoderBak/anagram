import { MARK_ATTR } from "../types";

const semantic = "[role],[itemprop],[itemscope],[typeof],[lang],[dir],[data-author],[data-speaker]";
const paragraph = "p,li,div:not([role]),span:not([role]),[role=paragraph],[role=listitem]";

/** A paragraph can occupy a layout wrapper or be the sole content of a sibling list item. */
export function paragraphBox(el: Element): Element {
  for (let parent = el.parentElement; parent; parent = el.parentElement) {
    if (!parent.matches("div,span,li") || parent.matches(semantic) || parent.childElementCount !== 1) break;
    if (Array.from(parent.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) break;
    el = parent;
    if (el.matches("li")) break;
  }
  return el;
}

export function siblingParagraphs(a: Element, b: Element): boolean {
  if (a === b) return true; // consecutive lines of one block, including a plain-text document
  if (!a.matches(paragraph) || !b.matches(paragraph)) return false;
  // Do not unwrap a shared parent, and keep two independently declared speakers apart.
  const voice = "[data-author],[data-speaker],[itemscope],[role=article],[role=comment]";
  if (a.closest(voice) !== b.closest(voice) ||
      a.closest("[lang]")?.getAttribute("lang")?.toLowerCase() !== b.closest("[lang]")?.getAttribute("lang")?.toLowerCase()) return false;
  const left = paragraphBox(a), right = paragraphBox(b);
  if (!left.parentNode || left.parentNode !== right.parentNode) return false;
  for (let n = left.nextSibling; n; n = n.nextSibling) {
    if (n === right) return true;
    if (n.nodeType === Node.ELEMENT_NODE && !(n as Element).hasAttribute(MARK_ATTR)) return false;
    if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) return false;
  }
  return false;
}
