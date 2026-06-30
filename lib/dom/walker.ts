// lib/dom/walker.ts — §3 paragraph-detection algorithm (two-stage capture pipeline).
import { INLINE_TEXT_TAGS, INLINE_IGNORE_TAGS, BLOCK_TAGS, NO_SCORE_TAGS, isBlock } from "./tags";
import { isVisible } from "./visibility";
import { type Unit, extractUnitText, isInvalidText, linkTextRatio } from "./text";
import { MARK_ATTR } from "../types";

const MAX_UNIT_CHARS = 1000; // reference's hard size cap (pageTranslator.js)

/** True if this node/subtree must be skipped entirely (do not descend, do not score). */
export function isExcluded(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element & { isContentEditable?: boolean };

  // Tag-based hard skips.
  if (INLINE_IGNORE_TAGS.has(el.nodeName)) return true;
  if (NO_SCORE_TAGS.has(el.nodeName)) return true;

  // Author opt-outs.
  if (el.classList.contains("notranslate")) return true; // honor existing convention
  if (el.getAttribute("translate") === "no") return true;
  if ((el as HTMLElement).isContentEditable) return true; // skip editors (Docs, comment boxes)

  // Our own injected nodes / already-scored subtrees (self-mutation guard).
  if (el.hasAttribute(MARK_ATTR)) return true;
  const parent = el.parentElement;
  if (parent && parent.hasAttribute(MARK_ATTR)) return true;
  if (el.closest(`[${MARK_ATTR}="host"]`)) return true; // inside a badge host
  if (el.closest(`[${MARK_ATTR}="scored"]`)) return true;

  return false;
}

/** A child whose nodeName is inline-text does NOT break the current unit. */
function isInlineNode(node: Node): boolean {
  return INLINE_TEXT_TAGS.has(node.nodeName);
}

/**
 * STAGE 2 — split a block element's descendant text nodes into Units at inline/block
 * boundaries. Faithful port of getPiecesToTranslate / getAllNodes (pageTranslator.js:394).
 */
export function getUnitsForBlock(root: Element): Omit<Unit, "id">[] {
  const units: Array<Omit<Unit, "id">> = [
    { nodes: [], parentElement: root, topElement: null, bottomElement: null, text: "", isScored: false },
  ];
  let index = 0;
  let currentSize = 0;

  function closeUnitIfNonEmpty() {
    if (units[index].nodes.length > 0) {
      units.push({ nodes: [], parentElement: null as any, topElement: null, bottomElement: null, text: "", isScored: false });
      index++;
    }
  }

  function walk(node: Node, lastBlockEl: Element | null) {
    if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      // Shadow fragment: remember host as the "last block element".
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        lastBlockEl = (node as ShadowRoot).host ?? lastBlockEl;
      } else {
        lastBlockEl = node as Element;
      }

      if (isExcluded(node)) {           // BR/CODE/KBD/WBR/PRE, SCRIPT/STYLE/…, notranslate, CE, marked
        closeUnitIfNonEmpty();
        return;                         // do NOT descend
      }

      const children = Array.from((node as Element | ShadowRoot).childNodes);
      for (const child of children) {
        if (!isInlineNode(child)) {
          // BLOCK boundary: close, recurse, close again.
          closeUnitIfNonEmpty();
          walk(child, lastBlockEl);
          closeUnitIfNonEmpty();
        } else {
          // INLINE: keep accumulating into the same unit.
          walk(child, lastBlockEl);
        }
      }

      // Descend into an open shadow root if present.
      const sr = (node as Element).shadowRoot;
      if (sr) {
        for (const child of Array.from(sr.childNodes)) {
          if (!isInlineNode(child)) { closeUnitIfNonEmpty(); walk(child, lastBlockEl); closeUnitIfNonEmpty(); }
          else walk(child, lastBlockEl);
        }
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if ((text.textContent ?? "").trim().length === 0) return; // drop whitespace-only

      const unit = units[index];
      // Resolve nearest BLOCK ancestor by climbing past inline ancestors.
      if (!unit.parentElement) {
        let temp: Node | null = text.parentNode;
        while (
          temp && temp !== root &&
          (INLINE_TEXT_TAGS.has(temp.nodeName) || INLINE_IGNORE_TAGS.has(temp.nodeName))
        ) {
          temp = temp.parentNode;
        }
        if (temp && temp.nodeType === Node.DOCUMENT_FRAGMENT_NODE) temp = (temp as ShadowRoot).host;
        unit.parentElement = (temp as Element) ?? root;
      }
      if (!unit.topElement) unit.topElement = lastBlockEl;

      // Hard 1000-char cap → force a new unit.
      if (currentSize > MAX_UNIT_CHARS) {
        currentSize = 0;
        unit.bottomElement = lastBlockEl;
        const carriedParent = unit.parentElement;
        units.push({ nodes: [], parentElement: carriedParent, topElement: lastBlockEl, bottomElement: null, text: "", isScored: false });
        index++;
      }
      currentSize += (text.textContent ?? "").length;
      units[index].nodes.push(text);
      units[index].bottomElement = null;
    }
  }

  walk(root, root);

  // Pop trailing empty unit.
  if (units.length > 0 && units[units.length - 1].nodes.length === 0) units.pop();

  // Finalize text + drop empties/invalids. (parentElement falls back to root.)
  const out: Array<Omit<Unit, "id">> = [];
  for (const u of units) {
    if (u.nodes.length === 0) continue;
    if (!u.parentElement) u.parentElement = root;
    u.text = extractUnitText(u.nodes);
    out.push(u);
  }
  return out;
}

/**
 * STAGE 1 — coarse block selection. Faithful port of getNodesThatNeedToTranslate
 * (enhance.js:215): querySelectorAll over block tags, filter invalid, dedup nested,
 * sort in document order. Returns clean per-paragraph containers.
 */
export function selectBlocks(root: ParentNode): Element[] {
  const found: Element[] = [];
  for (const tag of BLOCK_TAGS) {
    root.querySelectorAll(tag.toLowerCase()).forEach((el) => found.push(el));
  }
  // image-only <P> filter (enhance.js:155): a P with an <img>, <3 children, <80 chars text.
  const valid = found.filter((el) => {
    if (isExcluded(el)) return false;
    if (!isVisible(el)) return false;
    if (el.nodeName === "P" && el.querySelector("img") && el.childNodes.length < 3) {
      return (el as HTMLElement).innerText.length >= 80;
    }
    return true;
  });
  // Dedup: drop any element contained by another selected block (keep the inner block).
  const blocks = valid.filter((el) => !valid.some((other) => other !== el && el.contains(other) && isBlock(other)));
  // Document order.
  blocks.sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  return blocks;
}

/**
 * TOP-LEVEL — collectUnits(root): Stage 1 → Stage 2 → filter noise → emit Units with ids.
 * This is the public entry the orchestrator calls.
 */
let _unitCounter = 0;
export function collectUnits(root: ParentNode = document.body): Unit[] {
  const blocks = selectBlocks(root);
  // Cache isVisible verdicts for this scan (parentElement repeats across a block's units).
  const visCache = new WeakMap<Element, boolean>();
  const visible = (el: Element): boolean => {
    let v = visCache.get(el);
    if (v === undefined) {
      v = isVisible(el);
      visCache.set(el, v);
    }
    return v;
  };

  const units: Unit[] = [];
  for (const block of blocks) {
    for (const partial of getUnitsForBlock(block)) {
      if (isInvalidText(partial.text)) continue;        // min-length / noise floor
      if (!visible(partial.parentElement)) continue;    // explicit visibility skip (cached)
      if (linkTextRatio(partial.nodes) > 0.6) continue; // skip link-dense (titles/nav/lists)
      units.push({ ...partial, id: `b_${(_unitCounter++).toString(36)}` });
    }
  }
  return units;
}
