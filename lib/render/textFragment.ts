// lib/render/textFragment.ts — a link that reopens a page at one of its paragraphs.
//
// A text fragment (`#:~:text=start,end`) makes the browser scroll to the words it names
// and highlight them. It has to name them UNIQUELY: the browser highlights the first
// match, so a fragment that also matches an earlier sentence opens the page at the wrong
// place. Finding the fewest words that are unique, and checking uniqueness the way the
// browser will search, is what the code below does.
//
// Adapted from GoogleChromeLabs' text-fragments-polyfill
// (https://github.com/GoogleChromeLabs/text-fragments-polyfill, version 6.7.0, commit
// abc6ed4): generateFragmentFromRange and what it calls, from src/fragment-generation-utils.js,
// and the search it checks uniqueness with, processTextFragmentDirective, from
// src/text-fragment-utils.js.
//
//   Copyright 2020 Google LLC
//
//   Licensed under the Apache License, Version 2.0 (the "License");
//   you may not use this file except in compliance with the License.
//   You may obtain a copy of the License at
//
//       https://www.apache.org/licenses/LICENSE-2.0
//
//   Unless required by applicable law or agreed to in writing, software
//   distributed under the License is distributed on an "AS IS" BASIS,
//   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//   See the License for the specific language governing permissions and
//   limitations under the License.
//
// Changed by Anagram: ported to TypeScript; the time limit is a deadline per call rather
// than module state; an element's visibility is read once per batch of links; word bounds
// come from Intl.Segmenter only (every browser Anagram runs in has it), so the fallback
// that scans for boundary characters is gone; the polyfill's highlighting, parsing and
// directive handling are left out; opacity is read as a number (parseInt read 0.5 as 0);
// the walk up to a block ancestor stops at a root instead of looping, and a start with no
// word segment moves the start rather than the end; and a fragment is written out as a
// URL here.

/** A text directive's four parts, unencoded. */
export interface TextFragment {
  textStart: string;
  textEnd?: string;
  prefix?: string;
  suffix?: string;
}

// ---- Anagram's use ---------------------------------------------------------------------

/** Time for all the links of one report: a click has to reach the clipboard while the
 *  browser still counts it as the user's. */
const BATCH_MS = 1500;
/** Time for one link: the polyfill's own default. */
const LINK_MS = 500;

/**
 * A link to `pageUrl` that opens it at each range, in order; null for a range no unique
 * fragment was found for in time (the report then gives that paragraph no link). The
 * ranges are the page's own, in its top document. The page gets the main thread back
 * between two links.
 */
export async function paragraphLinks(pageUrl: string, ranges: readonly (Range | null)[], budgetMs = BATCH_MS): Promise<(string | null)[]> {
  const end = Date.now() + budgetMs;
  const cache = new WeakMap<Element, boolean>();
  const out: (string | null)[] = [];
  for (const range of ranges) {
    const now = Date.now();
    if (!range || now >= end) {
      out.push(null);
      continue;
    }
    visibility = cache;
    words = makeSegmenter();
    try {
      const fragment = words ? generateFragment(range.cloneRange(), Math.min(end, now + LINK_MS)) : null;
      out.push(fragment ? withTextDirective(pageUrl, fragment) : null);
    } finally {
      visibility = null;
      words = null;
    }
    await new Promise((resume) => setTimeout(resume, 0));
  }
  return out;
}

/** A text directive part: percent-encoded, with the characters the directive's own
 *  syntax uses (`-`, `,`, `&`) and the parentheses a Markdown link ends at encoded too. */
function encodePart(text: string): string {
  return encodeURIComponent(text).replace(/[-!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `text=prefix-,start,end,-suffix`. */
export function textDirective(f: TextFragment): string {
  return (
    "text=" +
    (f.prefix ? `${encodePart(f.prefix)}-,` : "") +
    encodePart(f.textStart) +
    (f.textEnd ? `,${encodePart(f.textEnd)}` : "") +
    (f.suffix ? `,-${encodePart(f.suffix)}` : "")
  );
}

/**
 * `pageUrl` opened at `f`. The page's own fragment stays — a hash route decides what the
 * page shows, and an anchor is where the browser goes if the text is not found — and a
 * directive already on it is replaced.
 */
export function withTextDirective(pageUrl: string, f: TextFragment): string {
  const at = pageUrl.indexOf("#");
  const base = at < 0 ? pageUrl : pageUrl.slice(0, at);
  const hash = at < 0 ? "" : pageUrl.slice(at + 1).split(":~:")[0];
  return `${base}#${hash}:~:${textDirective(f)}`;
}

// ---- the polyfill: shared state for one batch -------------------------------------------

/** When the current generation has to give up. */
let deadline = Infinity;
/** Visibility of the elements seen in this batch; getComputedStyle is what the searches cost. */
let visibility: WeakMap<Element, boolean> | null = null;
/** One word segmenter for the batch. */
let words: Intl.Segmenter | null = null;

class Timeout extends Error {}

function checkTimeout(): void {
  if (Date.now() > deadline) throw new Timeout();
}

function makeSegmenter(): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== "function") return null;
  return new Intl.Segmenter(document.documentElement.lang || navigator.language, { granularity: "word" });
}

function segmenter(): Intl.Segmenter {
  if (!words) words = makeSegmenter();
  if (!words) throw new Error("no Intl.Segmenter");
  return words;
}

// ---- text-fragment-utils.js ---------------------------------------------------------------

// Elements of a text fragment cannot cross the boundaries of a block element.
const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DETAILS", "DIALOG", "DD", "DIV", "DL",
  "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5",
  "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE",
  "UL", "TR", "TH", "TD", "COLGROUP", "COL", "CAPTION", "THEAD", "TBODY", "TFOOT",
]);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const isText = (node: Node): node is Text => node.nodeType === TEXT_NODE;
const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;

/**
 * Searches the document for a text fragment. Returns up to two ranges: a fragment is
 * unique exactly when it returns one.
 */
export function processTextFragmentDirective(textFragment: TextFragment, root: Node | null = document.body): Range[] {
  const results: Range[] = [];
  if (!root) return results;
  const searchRange = document.createRange();
  searchRange.selectNodeContents(root);

  while (!searchRange.collapsed && results.length < 2) {
    let potentialMatch: Range | undefined;
    if (textFragment.prefix) {
      const prefixMatch = findTextInRange(textFragment.prefix, searchRange);
      if (prefixMatch == null) break;
      // Future iterations, if necessary, should start after the first character of the
      // prefix match.
      advanceRangeStartPastOffset(searchRange, prefixMatch.startContainer, prefixMatch.startOffset);

      // The search space for textStart is everything after the prefix and before the end
      // of the top-level search range, starting at the next non-whitespace position.
      const matchRange = document.createRange();
      matchRange.setStart(prefixMatch.endContainer, prefixMatch.endOffset);
      matchRange.setEnd(searchRange.endContainer, searchRange.endOffset);

      advanceRangeStartToNonWhitespace(matchRange);
      if (matchRange.collapsed) break;

      potentialMatch = findTextInRange(textFragment.textStart, matchRange);
      // If textStart wasn't found anywhere in the matchRange, there's no possible match.
      if (potentialMatch == null) break;

      // A candidate only if it starts right after the prefix; otherwise look for the
      // next instance of the prefix.
      if (potentialMatch.compareBoundaryPoints(Range.START_TO_START, matchRange) !== 0) continue;
    } else {
      // With no prefix, just look directly for textStart.
      potentialMatch = findTextInRange(textFragment.textStart, searchRange);
      if (potentialMatch == null) break;
      advanceRangeStartPastOffset(searchRange, potentialMatch.startContainer, potentialMatch.startOffset);
    }

    if (textFragment.textEnd) {
      const textEndRange = document.createRange();
      textEndRange.setStart(potentialMatch.endContainer, potentialMatch.endOffset);
      textEndRange.setEnd(searchRange.endContainer, searchRange.endOffset);

      // Matches of the end term followed by the suffix term (if needed). If none is
      // found there's no point in looking past the current start term occurrence.
      let matchFound = false;

      // Search through the rest of the document to find a textEnd match. This may take
      // multiple iterations if a suffix needs to be found.
      while (!textEndRange.collapsed && results.length < 2) {
        const textEndMatch = findTextInRange(textFragment.textEnd, textEndRange);
        if (textEndMatch == null) break;

        advanceRangeStartPastOffset(textEndRange, textEndMatch.startContainer, textEndMatch.startOffset);
        potentialMatch.setEnd(textEndMatch.endContainer, textEndMatch.endOffset);

        if (textFragment.suffix) {
          // If there's supposed to be a suffix, check if it appears after the textEnd we
          // just found.
          const suffixResult = checkSuffix(textFragment.suffix, potentialMatch, searchRange);
          if (suffixResult === CheckSuffixResult.NO_SUFFIX_MATCH) {
            break;
          } else if (suffixResult === CheckSuffixResult.SUFFIX_MATCH) {
            matchFound = true;
            results.push(potentialMatch.cloneRange());
            continue;
          } else if (suffixResult === CheckSuffixResult.MISPLACED_SUFFIX) {
            continue;
          }
        } else {
          // textEnd found and no suffix: a match.
          matchFound = true;
          results.push(potentialMatch.cloneRange());
        }
      }
      // Suffix or textEnd are missing from the rest of the search space.
      if (!matchFound) break;
    } else if (textFragment.suffix) {
      // No textEnd but a suffix: search for the suffix after potentialMatch.
      const suffixResult = checkSuffix(textFragment.suffix, potentialMatch, searchRange);
      if (suffixResult === CheckSuffixResult.NO_SUFFIX_MATCH) {
        break;
      } else if (suffixResult === CheckSuffixResult.SUFFIX_MATCH) {
        results.push(potentialMatch.cloneRange());
        advanceRangeStartPastOffset(searchRange, searchRange.startContainer, searchRange.startOffset);
        continue;
      } else if (suffixResult === CheckSuffixResult.MISPLACED_SUFFIX) {
        continue;
      }
    } else {
      results.push(potentialMatch.cloneRange());
    }
  }
  return results;
}

enum CheckSuffixResult {
  NO_SUFFIX_MATCH, // Suffix wasn't found at all. Search should halt.
  SUFFIX_MATCH, // The suffix matches the expectation.
  MISPLACED_SUFFIX, // The suffix was found, but not in the right place.
}

/** Whether potentialMatch satisfies the suffix conditions of the fragment. Nothing before
 *  potentialMatch is considered, whatever searchRange's start. */
function checkSuffix(suffix: string, potentialMatch: Range, searchRange: Range): CheckSuffixResult {
  const suffixRange = document.createRange();
  suffixRange.setStart(potentialMatch.endContainer, potentialMatch.endOffset);
  suffixRange.setEnd(searchRange.endContainer, searchRange.endOffset);
  advanceRangeStartToNonWhitespace(suffixRange);

  const suffixMatch = findTextInRange(suffix, suffixRange);
  // Not found anywhere in the suffixRange: no possible match, stop early.
  if (suffixMatch == null) return CheckSuffixResult.NO_SUFFIX_MATCH;

  // Immediately after potentialMatch (its start equals suffixRange's start): a match.
  // If not, start over from the beginning.
  if (suffixMatch.compareBoundaryPoints(Range.START_TO_START, suffixRange) !== 0) {
    return CheckSuffixResult.MISPLACED_SUFFIX;
  }
  return CheckSuffixResult.SUFFIX_MATCH;
}

/** Sets the start of `range` to the first boundary point after `offset` in `node`:
 *  offset + 1, or after the node. */
function advanceRangeStartPastOffset(range: Range, node: Node, offset: number): void {
  try {
    range.setStart(node, offset + 1);
  } catch {
    range.setStartAfter(node);
  }
}

/** Moves `range` to start at the next non-whitespace position. */
function advanceRangeStartToNonWhitespace(range: Range): void {
  const walker = makeTextNodeWalker(range);

  let node = walker.nextNode();
  while (!range.collapsed && node != null) {
    if (node !== range.startContainer) range.setStart(node, 0);

    const text = node.textContent ?? "";
    if (text.length > range.startOffset) {
      const firstChar = text[range.startOffset];
      if (!/\s/.test(firstChar)) return;
    }

    try {
      range.setStart(node, range.startOffset + 1);
    } catch {
      node = walker.nextNode();
      if (node == null) range.collapse();
      else range.setStart(node, 0);
    }
  }
}

/** A TreeWalker that emits the visible text nodes in a range. */
function makeTextNodeWalker(range: Range): TreeWalker {
  return document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    (node) => acceptTextNodeIfVisibleInRange(node, range),
  );
}

/** `hidden="until-found"`: content the browser's find reveals, so it counts as visible. */
function isHiddenUntilFound(elt: Element): boolean {
  return elt.getAttribute("hidden") === "until-found";
}

/**
 * Whether a node is rendered by its own computed style (not its ancestors'): zero height
 * or width with its overflow clipped, `visibility: hidden`, `display: none` or zero
 * opacity read as not rendered.
 */
function isNodeVisible(node: Node): boolean {
  // Find an HTMLElement (this node or an ancestor) so its visibility can be checked.
  let elt: Node | null = node;
  while (elt != null && !(elt instanceof HTMLElement)) elt = elt.parentNode;
  if (elt == null) return true;
  const el = elt as HTMLElement;
  const known = visibility?.get(el);
  if (known !== undefined) return known;
  let shown = true;
  if (!isHiddenUntilFound(el)) {
    const style = window.getComputedStyle(el);
    shown = !(
      style.visibility === "hidden" ||
      style.display === "none" ||
      (parseInt(style.height, 10) === 0 && style.overflowY !== "visible") ||
      (parseInt(style.width, 10) === 0 && style.overflowX !== "visible") ||
      parseFloat(style.opacity) === 0
    );
  }
  visibility?.set(el, shown);
  return shown;
}

/** TreeWalker filter: rejects nodes outside `range` (when given) or not visible. */
function acceptNodeIfVisibleInRange(node: Node, range?: Range): number {
  if (range != null && !range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
  return isNodeVisible(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
}

/** TreeWalker filter: accepts visible text nodes in `range`, skips other visible nodes in
 *  it (so their subtrees are still visited), rejects the rest. */
function acceptTextNodeIfVisibleInRange(node: Node, range: Range): number {
  if (range != null && !range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
  if (!isNodeVisible(node)) return NodeFilter.FILTER_REJECT;
  return isText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
}

/**
 * The text nodes within `range`, in document order, as lists split at block boundaries:
 * two nodes are in the same list iff no block element starts or ends between them. Yielded
 * one list at a time, so a search that finds its words stops walking there.
 */
function* getAllTextNodes(root: Node, range: Range): Generator<Text[]> {
  let tmp: Text[] = [];

  for (const node of getElementsIn(root, (n) => acceptNodeIfVisibleInRange(n, range))) {
    if (isText(node)) {
      tmp.push(node);
    } else if (node instanceof HTMLElement && BLOCK_ELEMENTS.has(node.tagName.toUpperCase()) && tmp.length > 0) {
      // A block element: the current set of text nodes is complete.
      yield tmp;
      tmp = [];
    }
  }
  if (tmp.length > 0) yield tmp;
}

/** The text of the nodes, whitespace runs collapsed to one space. */
function getTextContent(nodes: Text[], startOffset: number, endOffset?: number): string {
  let str: string;
  if (nodes.length === 1) {
    str = nodes[0].data.substring(startOffset, endOffset);
  } else {
    str =
      nodes[0].data.substring(startOffset) +
      nodes.slice(1, -1).reduce((s, n) => s + n.data, "") +
      nodes[nodes.length - 1].data.substring(0, endOffset);
  }
  return str.replace(/[\t\n\r ]+/g, " ");
}

/** Every node under root the filter accepts, elements twice (entering and leaving). */
function* getElementsIn(root: Node, filter: (node: Node) => number): Generator<Node> {
  const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: filter });
  const finishedSubtrees = new Set<Node>();
  while (forwardTraverse(treeWalker, finishedSubtrees) !== null) {
    checkTimeout();
    yield treeWalker.currentNode;
  }
}

/** The first instance of `query` within `range`. */
function findTextInRange(query: string, range: Range): Range | undefined {
  const textNodeLists = getAllTextNodes(range.commonAncestorContainer, range);
  for (const list of textNodeLists) {
    const found = findRangeFromNodeList(query, range, list, segmenter());
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The first instance of `query` within `range`, searching the text of `textNodes`. */
function findRangeFromNodeList(query: string, range: Range, textNodes: Text[], wordSegmenter: Intl.Segmenter): Range | undefined {
  if (!query || !range || !textNodes.length) return undefined;
  const startOffset = textNodes[0] === range.startContainer ? range.startOffset : 0;
  const data = normalizeString(getTextContent(textNodes, startOffset));
  const normalizedQuery = normalizeString(query);
  let searchStart = 0;
  let start: BoundaryPoint | undefined;
  let end: BoundaryPoint | undefined;
  while (searchStart < data.length) {
    const matchIndex = data.indexOf(normalizedQuery, searchStart);
    if (matchIndex === -1) return undefined;
    if (isWordBounded(data, matchIndex, normalizedQuery.length, wordSegmenter)) {
      const normalizedStartOffset = normalizeString(textNodes[0].data.slice(0, startOffset)).length;
      start = getBoundaryPointAtIndex(normalizedStartOffset + matchIndex, textNodes, false);
      end = getBoundaryPointAtIndex(normalizedStartOffset + matchIndex + normalizedQuery.length, textNodes, true);
    }

    if (start != null && end != null) {
      const foundRange = new Range();
      foundRange.setStart(start.node, start.offset);
      foundRange.setEnd(end.node, end.offset);

      // Verify that foundRange is a subrange of range.
      if (
        range.compareBoundaryPoints(Range.START_TO_START, foundRange) <= 0 &&
        range.compareBoundaryPoints(Range.END_TO_END, foundRange) >= 0
      ) {
        return foundRange;
      }
    }
    searchStart = matchIndex + 1;
  }
  return undefined;
}

interface BoundaryPoint {
  node: Text;
  offset: number;
}

/**
 * The boundary point at `index` of the concatenated, normalized text of `textNodes`: the
 * start or (`isEnd`) the end of a substring there.
 */
function getBoundaryPointAtIndex(index: number, textNodes: Text[], isEnd: boolean): BoundaryPoint | undefined {
  let counted = 0;
  let normalizedData: string | undefined;
  for (let i = 0; i < textNodes.length; i++) {
    const node = textNodes[i];
    if (!normalizedData) normalizedData = normalizeString(node.data);
    let nodeEnd = counted + normalizedData.length;
    if (isEnd) nodeEnd += 1;
    if (nodeEnd > index) {
      // index falls within this node: turn the offset in the normalized data into an
      // offset in the real node data.
      const normalizedOffset = index - counted;
      let denormalizedOffset = Math.min(index - counted, node.data.length);

      // Walk through the string until denormalizedOffset produces a substring that
      // corresponds to the target from the normalized data.
      const targetSubstring = isEnd ? normalizedData.substring(0, normalizedOffset) : normalizedData.substring(normalizedOffset);

      let candidateSubstring = isEnd
        ? normalizeString(node.data.substring(0, denormalizedOffset))
        : normalizeString(node.data.substring(denormalizedOffset));

      // Lengthen or shrink the candidate to approach the length of the target. For the
      // start, adding 1 makes the candidate shorter; for the end, longer.
      const direction = (isEnd ? -1 : 1) * (targetSubstring.length > candidateSubstring.length ? -1 : 1);

      while (denormalizedOffset >= 0 && denormalizedOffset <= node.data.length) {
        if (candidateSubstring.length === targetSubstring.length) {
          return { node, offset: denormalizedOffset };
        }
        denormalizedOffset += direction;
        candidateSubstring = isEnd
          ? normalizeString(node.data.substring(0, denormalizedOffset))
          : normalizeString(node.data.substring(denormalizedOffset));
      }
    }
    counted += normalizedData.length;

    if (i + 1 < textNodes.length) {
      // A node that ends with whitespace before one that starts with it would be counted
      // twice relative to the normalized text.
      const nextNormalizedData = normalizeString(textNodes[i + 1].data);
      if (normalizedData.slice(-1) === " " && nextNormalizedData.slice(0, 1) === " ") counted -= 1;
      normalizedData = nextNormalizedData;
    }
  }
  return undefined;
}

/** Whether a substring starts and ends on word boundaries of the longer text. */
function isWordBounded(text: string, startPos: number, length: number, wordSegmenter: Intl.Segmenter): boolean {
  if (startPos < 0 || startPos >= text.length || length <= 0 || startPos + length > text.length) return false;

  const segments = wordSegmenter.segment(text);
  const startSegment = segments.containing(startPos);
  if (!startSegment) return false;
  // Inside a word segment but not at its first character: not word-bounded. A non-word
  // segment (punctuation, space) counts as a bound.
  if (startSegment.isWordLike && startSegment.index !== startPos) return false;

  // endPos is the first character outside the substring. No segment there is the end of
  // the text; a non-word segment is punctuation or space; a word must start right there.
  const endPos = startPos + length;
  const endSegment = segments.containing(endPos);
  if (endSegment && endSegment.isWordLike && endSegment.index !== endPos) return false;

  return true;
}

/** Whitespace runs to one space, diacritics removed (é → e), lower case. */
function normalizeString(str: string): string {
  return (str || "")
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * One step of a traversal that visits each subtree in document order and emits its root
 * twice, entering and leaving, so the end of a block is seen as well as its start.
 */
function forwardTraverse(walker: TreeWalker, finishedSubtrees: Set<Node>): Node | null {
  if (!finishedSubtrees.has(walker.currentNode)) {
    const firstChild = walker.firstChild();
    if (firstChild !== null) return firstChild;
  }
  const nextSibling = walker.nextSibling();
  if (nextSibling !== null) return nextSibling;
  const parent = walker.parentNode();
  if (parent !== null) finishedSubtrees.add(parent);
  return parent;
}

/** The same, in reverse document order. */
function backwardTraverse(walker: TreeWalker, finishedSubtrees: Set<Node>): Node | null {
  if (!finishedSubtrees.has(walker.currentNode)) {
    const lastChild = walker.lastChild();
    if (lastChild !== null) return lastChild;
  }
  const previousSibling = walker.previousSibling();
  if (previousSibling !== null) return previousSibling;
  const parent = walker.parentNode();
  if (parent !== null) finishedSubtrees.add(parent);
  return parent;
}

// ---- fragment-generation-utils.js ---------------------------------------------------------

const MAX_EXACT_MATCH_LENGTH = 300;
const MIN_LENGTH_WITHOUT_CONTEXT = 20;
const ITERATIONS_BEFORE_ADDING_CONTEXT = 1;
const WORDS_TO_ADD_FIRST_ITERATION = 3;
const WORDS_TO_ADD_SUBSEQUENT_ITERATIONS = 1;
const TRUNCATE_RANGE_CHECK_CHARS = 10000;
const MAX_DEPTH = 500;

/**
 * The shortest fragment that identifies `range` and nothing else on the page, or null
 * when there is none (the words recur, the range is not in the page's own text) or it
 * was not found by `until`. The range is changed.
 */
export function generateFragment(range: Range, until = Date.now() + LINK_MS): TextFragment | null {
  deadline = until;
  try {
    if (!isValidRangeForFragmentGeneration(range)) return null;
    return doGenerateFragmentFromRange(range);
  } catch {
    // Out of time, or the page changed under the walk.
    return null;
  } finally {
    deadline = Infinity;
  }
}

/**
 * Rules out ranges generation would fail on: one with no word in it, one outside the top
 * document, one inside an editable field.
 */
function isValidRangeForFragmentGeneration(range: Range): boolean {
  if (!/[\p{L}\p{N}]/u.test(range.toString().substring(0, TRUNCATE_RANGE_CHECK_CHARS))) return false;

  // Only the top document: a text directive is not applied inside a frame.
  if (window.self !== window.top || range.startContainer.ownerDocument !== document) return false;

  // Not inside an editable. The walk up is capped at MAX_DEPTH.
  let node: Node | null = range.commonAncestorContainer;
  let numIterations = 0;
  while (node) {
    if (isElement(node)) {
      if (["TEXTAREA", "INPUT"].includes(node.tagName.toUpperCase())) return false;
      const editable = node.attributes.getNamedItem("contenteditable");
      if (editable && editable.value !== "false") return false;
      numIterations++;
      if (numIterations >= MAX_DEPTH) return false;
    }
    node = node.parentNode;
  }
  // A range in a shadow tree: the directive searches the document's own tree.
  return range.commonAncestorContainer.getRootNode() === document;
}

function doGenerateFragmentFromRange(range: Range): TextFragment | null {
  expandRangeStartToWordBound(range);
  expandRangeEndToWordBound(range);
  // The edges before shrinking to text nodes: context terms are built from them.
  const rangeBeforeShrinking = range.cloneRange();

  moveRangeEdgesToTextNodes(range);
  if (range.collapsed) return null;

  let factory: FragmentFactory;

  if (canUseExactMatch(range)) {
    const exactText = normalizeString(range.toString());
    const fragment: TextFragment = { textStart: exactText };
    // Long enough to be used on its own: try that and skip the longer process below.
    if (exactText.length >= MIN_LENGTH_WITHOUT_CONTEXT && isUniquelyIdentifying(fragment)) return fragment;
    factory = new FragmentFactory().setExactTextMatch(exactText);
  } else {
    // textStart and textEnd. Break the range up at block boundaries, which neither can
    // cross.
    const startSearchSpace = getSearchSpaceForStart(range);
    const endSearchSpace = getSearchSpaceForEnd(range);

    if (startSearchSpace && endSearchSpace) {
      // A block boundary between them.
      factory = new FragmentFactory().setStartAndEndSearchSpace(startSearchSpace, endSearchSpace);
    } else {
      // No block boundary: textStart and textEnd share a search space and must not
      // overlap.
      factory = new FragmentFactory().setSharedSearchSpace(range.toString().trim());
    }
  }

  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(document.body);
  const suffixRange = prefixRange.cloneRange();

  prefixRange.setEnd(rangeBeforeShrinking.startContainer, rangeBeforeShrinking.startOffset);
  suffixRange.setStart(rangeBeforeShrinking.endContainer, rangeBeforeShrinking.endOffset);

  const prefixSearchSpace = getSearchSpaceForEnd(prefixRange);
  const suffixSearchSpace = getSearchSpaceForStart(suffixRange);

  if (prefixSearchSpace || suffixSearchSpace) factory.setPrefixAndSuffixSearchSpace(prefixSearchSpace, suffixSearchSpace);

  factory.useSegmenter(segmenter());

  let didEmbiggen = false;
  do {
    checkTimeout();
    didEmbiggen = factory.embiggen();
    const fragment = factory.tryToMakeUniqueFragment();
    if (fragment != null) return fragment;
  } while (didEmbiggen);

  return null;
}

/**
 * The text from the start of the range to the first block boundary with text in it,
 * trimmed; undefined when the range holds no block boundary or only empty blocks.
 */
function getSearchSpaceForStart(range: Range): string | undefined {
  let node: Node | null = getFirstNodeForBlockSearch(range);
  const walker = makeWalkerForNode(node, range.endContainer);
  if (!walker) return undefined;

  const finishedSubtrees = new Set<Node>();
  // A range that starts after the last child of an element does not include its subtree.
  if (isElement(range.startContainer) && range.startOffset === range.startContainer.childNodes.length) {
    finishedSubtrees.add(range.startContainer);
  }
  const origin = node;
  const textAccumulator = new BlockTextAccumulator(range, true);
  // tempRange monitors whether the search space is exhausted.
  const tempRange = range.cloneRange();
  while (!tempRange.collapsed && node != null) {
    checkTimeout();
    // An ancestor of the search's start contributes its trailing edge, anything else its
    // leading one.
    if (node.contains(origin)) tempRange.setStartAfter(node);
    else tempRange.setStartBefore(node);
    textAccumulator.appendNode(node);
    if (textAccumulator.textInBlock !== null) return textAccumulator.textInBlock;
    node = forwardTraverse(walker, finishedSubtrees);
  }
  return undefined;
}

/** The same, from the last block boundary to the end of the range. */
function getSearchSpaceForEnd(range: Range): string | undefined {
  let node: Node | null = getLastNodeForBlockSearch(range);
  const walker = makeWalkerForNode(node, range.startContainer);
  if (!walker) return undefined;
  const finishedSubtrees = new Set<Node>();
  // A range that ends before the first child of an element does not include its subtree.
  if (isElement(range.endContainer) && range.endOffset === 0) finishedSubtrees.add(range.endContainer);

  const origin = node;
  const textAccumulator = new BlockTextAccumulator(range, false);
  const tempRange = range.cloneRange();
  while (!tempRange.collapsed && node != null) {
    checkTimeout();
    if (node.contains(origin)) tempRange.setEnd(node, 0);
    else tempRange.setEndAfter(node);
    textAccumulator.appendNode(node);
    if (textAccumulator.textInBlock !== null) return textAccumulator.textInBlock;
    node = backwardTraverse(walker, finishedSubtrees);
  }
  return undefined;
}

enum Mode {
  ALL_PARTS = 1,
  SHARED_START_AND_END = 2,
  CONTEXT_ONLY = 3,
}

/**
 * Builds candidate fragments of growing length for a range. Exactly one of
 * setStartAndEndSearchSpace, setSharedSearchSpace or setExactTextMatch is called, then
 * optionally setPrefixAndSuffixSearchSpace, then useSegmenter.
 */
class FragmentFactory {
  mode: Mode = Mode.CONTEXT_ONLY;
  startOffset = 0;
  endOffset = 0;
  prefixOffset: number | null = null;
  suffixOffset: number | null = null;

  startSearchSpace = "";
  endSearchSpace = "";
  backwardsEndSearchSpace = "";
  sharedSearchSpace = "";
  backwardsSharedSearchSpace = "";
  exactTextMatch = "";
  prefixSearchSpace = "";
  backwardsPrefixSearchSpace = "";
  suffixSearchSpace = "";

  startSegments?: Intl.Segments;
  endSegments?: Intl.Segments;
  sharedSegments?: Intl.Segments;
  prefixSegments?: Intl.Segments;
  suffixSegments?: Intl.Segments;

  numIterations = 0;

  /** The fragment for the current state, if it identifies one place only. */
  tryToMakeUniqueFragment(): TextFragment | undefined {
    let fragment: TextFragment;
    if (this.mode === Mode.CONTEXT_ONLY) {
      fragment = { textStart: this.exactTextMatch };
    } else {
      fragment = {
        textStart: this.getStartSearchSpace().substring(0, this.startOffset).trim(),
        textEnd: this.getEndSearchSpace().substring(this.endOffset).trim(),
      };
    }
    if (this.prefixOffset != null) {
      const prefix = this.getPrefixSearchSpace().substring(this.prefixOffset).trim();
      if (prefix) fragment.prefix = prefix;
    }
    if (this.suffixOffset != null) {
      const suffix = this.getSuffixSearchSpace().substring(0, this.suffixOffset).trim();
      if (suffix) fragment.suffix = suffix;
    }
    return isUniquelyIdentifying(fragment) ? fragment : undefined;
  }

  /**
   * Grows textStart and textEnd over more of their search spaces, then the context.
   * False once every search space is used up.
   */
  embiggen(): boolean {
    let canExpandRange = true;

    if (this.mode === Mode.SHARED_START_AND_END) {
      // Stop when textStart would overlap textEnd.
      if (this.startOffset >= this.endOffset) canExpandRange = false;
    } else if (this.mode === Mode.ALL_PARTS) {
      // Stop when both have consumed their full search spaces.
      if (
        this.startOffset === this.getStartSearchSpace().length &&
        this.backwardsEndOffset() === this.getEndSearchSpace().length
      ) {
        canExpandRange = false;
      }
    } else if (this.mode === Mode.CONTEXT_ONLY) {
      canExpandRange = false;
    }

    if (canExpandRange) {
      const desiredIterations = this.getNumberOfRangeWordsToAdd();
      const startSegments = this.getStartSegments();
      if (this.startOffset < this.getStartSearchSpace().length && startSegments) {
        let i = 0;
        while (i < desiredIterations && this.startOffset < this.getStartSearchSpace().length) {
          this.startOffset = this.getNextOffsetForwards(startSegments, this.startOffset, this.getStartSearchSpace());
          i++;
        }
        // No overlapping start and end offsets.
        if (this.mode === Mode.SHARED_START_AND_END) this.startOffset = Math.min(this.startOffset, this.endOffset);
      }

      const endSegments = this.getEndSegments();
      if (this.backwardsEndOffset() < this.getEndSearchSpace().length && endSegments) {
        let i = 0;
        while (i < desiredIterations && this.endOffset > 0) {
          this.endOffset = this.getNextOffsetBackwards(endSegments, this.endOffset);
          i++;
        }
        if (this.mode === Mode.SHARED_START_AND_END) this.endOffset = Math.max(this.startOffset, this.endOffset);
      }
    }

    let canExpandContext = false;
    if (
      !canExpandRange ||
      this.startOffset + this.backwardsEndOffset() < MIN_LENGTH_WITHOUT_CONTEXT ||
      this.numIterations >= ITERATIONS_BEFORE_ADDING_CONTEXT
    ) {
      // Any unused context left?
      const backwardsPrefix = this.backwardsPrefixOffset();
      if (
        (backwardsPrefix != null && backwardsPrefix !== this.getPrefixSearchSpace().length) ||
        (this.suffixOffset != null && this.suffixOffset !== this.getSuffixSearchSpace().length)
      ) {
        canExpandContext = true;
      }
    }

    if (canExpandContext) {
      const desiredIterations = this.getNumberOfContextWordsToAdd();
      const backwardsPrefix = this.backwardsPrefixOffset();
      if (backwardsPrefix != null && backwardsPrefix < this.getPrefixSearchSpace().length && this.prefixSegments) {
        let i = 0;
        while (i < desiredIterations && (this.prefixOffset ?? 0) > 0) {
          this.prefixOffset = this.getNextOffsetBackwards(this.prefixSegments, this.prefixOffset ?? 0);
          i++;
        }
      }
      if (this.suffixOffset != null && this.suffixOffset < this.getSuffixSearchSpace().length && this.suffixSegments) {
        let i = 0;
        while (i < desiredIterations && this.suffixOffset < this.getSuffixSearchSpace().length) {
          this.suffixOffset = this.getNextOffsetForwards(this.suffixSegments, this.suffixOffset, this.getSuffixSearchSpace());
          i++;
        }
      }
    }
    this.numIterations++;

    return canExpandRange || canExpandContext;
  }

  /** A range-based match whose highlight crosses block boundaries. */
  setStartAndEndSearchSpace(startSearchSpace: string, endSearchSpace: string): this {
    this.startSearchSpace = startSearchSpace;
    this.endSearchSpace = endSearchSpace;
    this.backwardsEndSearchSpace = reverseString(endSearchSpace);
    this.startOffset = 0;
    this.endOffset = endSearchSpace.length;
    this.mode = Mode.ALL_PARTS;
    return this;
  }

  /** A range-based match whose highlight stays inside one block. */
  setSharedSearchSpace(sharedSearchSpace: string): this {
    this.sharedSearchSpace = sharedSearchSpace;
    this.backwardsSharedSearchSpace = reverseString(sharedSearchSpace);
    this.startOffset = 0;
    this.endOffset = sharedSearchSpace.length;
    this.mode = Mode.SHARED_START_AND_END;
    return this;
  }

  /** An exact text match. */
  setExactTextMatch(exactTextMatch: string): this {
    this.exactTextMatch = exactTextMatch;
    this.mode = Mode.CONTEXT_ONLY;
    return this;
  }

  /** The search spaces for prefix and suffix. */
  setPrefixAndSuffixSearchSpace(prefixSearchSpace: string | undefined, suffixSearchSpace: string | undefined): this {
    if (prefixSearchSpace) {
      this.prefixSearchSpace = prefixSearchSpace;
      this.backwardsPrefixSearchSpace = reverseString(prefixSearchSpace);
      this.prefixOffset = prefixSearchSpace.length;
    }
    if (suffixSearchSpace) {
      this.suffixSearchSpace = suffixSearchSpace;
      this.suffixOffset = 0;
    }
    return this;
  }

  /** Segments every search space set so far into words. */
  useSegmenter(wordSegmenter: Intl.Segmenter): this {
    if (this.mode === Mode.ALL_PARTS) {
      this.startSegments = wordSegmenter.segment(this.startSearchSpace);
      this.endSegments = wordSegmenter.segment(this.endSearchSpace);
    } else if (this.mode === Mode.SHARED_START_AND_END) {
      this.sharedSegments = wordSegmenter.segment(this.sharedSearchSpace);
    }
    if (this.prefixSearchSpace) this.prefixSegments = wordSegmenter.segment(this.prefixSearchSpace);
    if (this.suffixSearchSpace) this.suffixSegments = wordSegmenter.segment(this.suffixSearchSpace);
    return this;
  }

  /** Words to add to prefix and suffix this time. */
  getNumberOfContextWordsToAdd(): number {
    return this.backwardsPrefixOffset() === 0 && this.suffixOffset === 0
      ? WORDS_TO_ADD_FIRST_ITERATION
      : WORDS_TO_ADD_SUBSEQUENT_ITERATIONS;
  }

  /** Words to add to textStart and textEnd this time. */
  getNumberOfRangeWordsToAdd(): number {
    return this.startOffset === 0 && this.backwardsEndOffset() === 0
      ? WORDS_TO_ADD_FIRST_ITERATION
      : WORDS_TO_ADD_SUBSEQUENT_ITERATIONS;
  }

  /** The end of the next word-like segment at or after `offset`. */
  getNextOffsetForwards(segments: Intl.Segments, offset: number, searchSpace: string): number {
    let currentSegment = segments.containing(offset);
    while (currentSegment != null) {
      checkTimeout();
      const currentSegmentEnd = currentSegment.index + currentSegment.segment.length;
      if (currentSegment.isWordLike) return currentSegmentEnd;
      currentSegment = segments.containing(currentSegmentEnd);
    }
    // No word-like segment by the end of the string: the whole search space.
    return searchSpace.length;
  }

  /** The start of the nearest word-like segment before `offset`. */
  getNextOffsetBackwards(segments: Intl.Segments, offset: number): number {
    let currentSegment = segments.containing(offset);
    // At the end of the search space there is no segment; at the start of a segment,
    // moving to its start would be a no-op. Either way take the one before.
    if (!currentSegment || offset === currentSegment.index) currentSegment = segments.containing(offset - 1);
    while (currentSegment != null) {
      checkTimeout();
      if (currentSegment.isWordLike) return currentSegment.index;
      currentSegment = segments.containing(currentSegment.index - 1);
    }
    return 0;
  }

  getStartSearchSpace(): string {
    return this.mode === Mode.SHARED_START_AND_END ? this.sharedSearchSpace : this.startSearchSpace;
  }

  getStartSegments(): Intl.Segments | undefined {
    return this.mode === Mode.SHARED_START_AND_END ? this.sharedSegments : this.startSegments;
  }

  getEndSearchSpace(): string {
    return this.mode === Mode.SHARED_START_AND_END ? this.sharedSearchSpace : this.endSearchSpace;
  }

  getEndSegments(): Intl.Segments | undefined {
    return this.mode === Mode.SHARED_START_AND_END ? this.sharedSegments : this.endSegments;
  }

  getPrefixSearchSpace(): string {
    return this.prefixSearchSpace;
  }

  getSuffixSearchSpace(): string {
    return this.suffixSearchSpace;
  }

  /** The end offset, counted from the end of the end search space. */
  backwardsEndOffset(): number {
    return this.getEndSearchSpace().length - this.endOffset;
  }

  /** The prefix offset, counted from the end of the prefix search space. */
  backwardsPrefixOffset(): number | null {
    if (this.prefixOffset == null) return null;
    return this.getPrefixSearchSpace().length - this.prefixOffset;
  }
}

/**
 * Collects the text from the start (or end) of a range until a block boundary with text
 * inside it is reached; `textInBlock` is that text, trimmed, once found.
 */
class BlockTextAccumulator {
  textFound = false;
  textNodes: { textContent: string | null }[] = [];
  textInBlock: string | null = null;

  constructor(
    private readonly searchRange: Range,
    private readonly isForwardTraversal: boolean,
  ) {}

  appendNode(node: Node): void {
    if (this.textInBlock !== null) return;
    if (isBlock(node)) {
      if (this.textFound) {
        // Backwards, the nodes were pushed in reverse order.
        if (!this.isForwardTraversal) this.textNodes.reverse();
        this.textInBlock = this.textNodes
          .map((textNode) => textNode.textContent)
          .join("")
          .trim();
      } else {
        // Only empty nodes so far: carry on to the next block boundary.
        this.textNodes = [];
      }
      return;
    }
    if (!isText(node)) return;

    // Only the part of the node inside the search range.
    const nodeToInsert = this.getNodeIntersectionWithRange(node);
    this.textFound = this.textFound || (nodeToInsert.textContent ?? "").trim() !== "";
    this.textNodes.push(nodeToInsert);
  }

  /** The node, or the part of its text inside the search range. */
  getNodeIntersectionWithRange(node: Text): { textContent: string | null } {
    let startOffset: number | null = null;
    let endOffset: number | null = null;
    if (node === this.searchRange.startContainer && this.searchRange.startOffset !== 0) {
      startOffset = this.searchRange.startOffset;
    }
    if (node === this.searchRange.endContainer && this.searchRange.endOffset !== node.data.length) {
      endOffset = this.searchRange.endOffset;
    }
    if (startOffset !== null || endOffset !== null) {
      return { textContent: node.data.substring(startOffset ?? 0, endOffset ?? node.data.length) };
    }
    return node;
  }
}

/** Whether a candidate fragment identifies exactly one place in the document. */
function isUniquelyIdentifying(fragment: TextFragment): boolean {
  return processTextFragmentDirective(fragment).length === 1;
}

/** A string backwards, compound characters kept whole. */
function reverseString(string: string): string {
  return [...(string || "")].reverse().join("");
}

/** Short enough, and inside one block, for textStart alone. */
function canUseExactMatch(range: Range): boolean {
  if (range.toString().length > MAX_EXACT_MATCH_LENGTH) return false;
  return !containsBlockBoundary(range);
}

/** Where a forward traversal through `range` starts. */
function getFirstNodeForBlockSearch(range: Range): Node {
  let node = range.startContainer;
  if (isElement(node) && range.startOffset < node.childNodes.length) node = node.childNodes[range.startOffset];
  return node;
}

/** Where a backward traversal through `range` starts. */
function getLastNodeForBlockSearch(range: Range): Node {
  let node = range.endContainer;
  if (isElement(node) && range.endOffset > 0) node = node.childNodes[range.endOffset - 1];
  return node;
}

/** The first visible text node within `range`. */
function getFirstTextNode(range: Range): Node | null {
  const firstNode = getFirstNodeForBlockSearch(range);
  if (isText(firstNode) && isNodeVisible(firstNode)) return firstNode;
  const walker = makeTextNodeWalker(range);
  walker.currentNode = firstNode;
  return walker.nextNode();
}

/** The last visible text node within `range`. */
function getLastTextNode(range: Range): Node | null {
  const lastNode = getLastNodeForBlockSearch(range);
  if (isText(lastNode) && isNodeVisible(lastNode)) return lastNode;
  const walker = makeTextNodeWalker(range);
  walker.currentNode = lastNode;
  return backwardTraverse(walker, new Set());
}

/** Whether a range crosses a block boundary. */
function containsBlockBoundary(range: Range): boolean {
  const tempRange = range.cloneRange();
  let node: Node | null = getFirstNodeForBlockSearch(tempRange);
  const walker = makeWalkerForNode(node);
  if (!walker) return false;
  const finishedSubtrees = new Set<Node>();

  while (!tempRange.collapsed && node != null) {
    if (isBlock(node)) return true;
    tempRange.setStartAfter(node);
    node = forwardTraverse(walker, finishedSubtrees);
    checkTimeout();
  }
  return false;
}

/**
 * A TreeWalker over visible text and elements, rooted at a block ancestor of `node` that
 * also holds `endNode`, and standing at `node`. Undefined when there is no such ancestor.
 */
function makeWalkerForNode(node: Node | null, endNode?: Node): TreeWalker | undefined {
  if (!node) return undefined;

  let blockAncestor: Node = node;
  const endNodeNotNull = endNode != null ? endNode : node;
  while (!blockAncestor.contains(endNodeNotNull) || !isBlock(blockAncestor)) {
    if (!blockAncestor.parentNode) return undefined;
    blockAncestor = blockAncestor.parentNode;
  }

  const walker = document.createTreeWalker(blockAncestor, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (n) =>
    acceptNodeIfVisibleInRange(n),
  );
  walker.currentNode = node;
  return walker;
}

/** Widens the start of the range to a word boundary. */
function expandRangeStartToWordBound(range: Range): void {
  // The range may start with a non-text node.
  const startNode = getFirstNodeForBlockSearch(range);
  if (startNode !== range.startContainer) range.setStartBefore(startNode);
  expandToNearestWordBoundaryPointUsingSegments(segmenter(), false, range);
}

/** Widens the end of the range to a word boundary. */
function expandRangeEndToWordBound(range: Range): void {
  const endNode = getLastNodeForBlockSearch(range);
  if (endNode !== range.endContainer) range.setEndAfter(endNode);
  expandToNearestWordBoundaryPointUsingSegments(segmenter(), true, range);
}

/** Moves the range's edges to the first and last visible text nodes in it; collapses it
 *  when there are none. */
function moveRangeEdgesToTextNodes(range: Range): void {
  const firstTextNode = getFirstTextNode(range);
  if (firstTextNode == null) {
    range.collapse();
    return;
  }
  const firstNode = getFirstNodeForBlockSearch(range);
  if (firstNode !== firstTextNode) range.setStart(firstTextNode, 0);

  const lastNode = getLastNodeForBlockSearch(range);
  const lastTextNode = getLastTextNode(range);
  if (lastTextNode && lastNode !== lastTextNode) range.setEnd(lastTextNode, (lastTextNode.textContent ?? "").length);
}

/** Moves the start or (`isRangeEnd`) the end of a range out to the edge of the word it
 *  falls in. */
function expandToNearestWordBoundaryPointUsingSegments(wordSegmenter: Intl.Segmenter, isRangeEnd: boolean, range: Range): void {
  // The boundary as an offset in the full text of its block.
  const boundary = isRangeEnd
    ? { node: range.endContainer, offset: range.endOffset }
    : { node: range.startContainer, offset: range.startOffset };

  const nodes = getTextNodesInSameBlock(boundary.node);
  if (!nodes) return;
  const preNodeText = nodes.preNodes.reduce((prev, cur) => prev.concat(cur.data), "");
  const innerNodeText = nodes.innerNodes.reduce((prev, cur) => prev.concat(cur.data), "");

  let offsetInText = preNodeText.length;
  if (isText(boundary.node)) offsetInText += boundary.offset;
  else if (isRangeEnd) offsetInText += innerNodeText.length;

  const postNodeText = nodes.postNodes.reduce((prev, cur) => prev.concat(cur.data), "");
  const allNodes = [...nodes.preNodes, ...nodes.innerNodes, ...nodes.postNodes];
  // No text in the block: no word boundary to find.
  if (allNodes.length === 0) return;

  const text = preNodeText.concat(innerNodeText, postNodeText);
  const segments = wordSegmenter.segment(text);
  const foundSegment = segments.containing(offsetInText);

  if (!foundSegment) {
    if (isRangeEnd) range.setEndAfter(allNodes[allNodes.length - 1]);
    else range.setStartBefore(allNodes[0]);
    return;
  }

  // Not a word (whitespace, punctuation): the boundary is between words already.
  if (!foundSegment.isWordLike) return;

  // At the first or last character of the segment: done.
  if (offsetInText === foundSegment.index || offsetInText === foundSegment.index + foundSegment.segment.length) return;

  // Inside a word: move to its start or end.
  const desiredOffsetInText = isRangeEnd ? foundSegment.index + foundSegment.segment.length : foundSegment.index;
  let newNodeIndexInText = 0;
  for (const node of allNodes) {
    if (newNodeIndexInText <= desiredOffsetInText && desiredOffsetInText < newNodeIndexInText + node.data.length) {
      const offsetInNode = desiredOffsetInText - newNodeIndexInText;
      if (isRangeEnd) {
        if (offsetInNode >= node.data.length) range.setEndAfter(node);
        else range.setEnd(node, offsetInNode);
      } else if (offsetInNode >= node.data.length) {
        range.setStartAfter(node);
      } else {
        range.setStart(node, offsetInNode);
      }
      return;
    }
    newNodeIndexInText += node.data.length;
  }

  // The offset fell in no node: the start or end of the block.
  if (isRangeEnd) range.setEndAfter(allNodes[allNodes.length - 1]);
  else range.setStartBefore(allNodes[0]);
}

/**
 * The text nodes in the same block as `node`: before it, in it, and after it, up to the
 * block boundaries on either side.
 */
function getTextNodesInSameBlock(node: Node): { preNodes: Text[]; innerNodes: Text[]; postNodes: Text[] } | undefined {
  const preNodes: Text[] = [];
  const backWalker = makeWalkerForNode(node);
  if (!backWalker) return undefined;
  const finishedSubtrees = new Set<Node>();
  let backNode = backwardTraverse(backWalker, finishedSubtrees);
  while (backNode != null && !isBlock(backNode)) {
    checkTimeout();
    if (isText(backNode)) preNodes.push(backNode);
    backNode = backwardTraverse(backWalker, finishedSubtrees);
  }
  preNodes.reverse();

  const innerNodes: Text[] = [];
  if (isText(node)) {
    innerNodes.push(node);
  } else {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (n) => acceptNodeIfVisibleInRange(n));
    walker.currentNode = node;
    let child = walker.nextNode();
    while (child != null) {
      checkTimeout();
      if (isText(child)) innerNodes.push(child);
      child = walker.nextNode();
    }
  }

  const postNodes: Text[] = [];
  const forwardWalker = makeWalkerForNode(node);
  if (!forwardWalker) return undefined;
  // Forward from the end of node's subtree to the next block boundary.
  const finishedSubtreesForward = new Set<Node>([node]);
  let forwardNode = forwardTraverse(forwardWalker, finishedSubtreesForward);
  while (forwardNode != null && !isBlock(forwardNode)) {
    checkTimeout();
    if (isText(forwardNode)) postNodes.push(forwardNode);
    forwardNode = forwardTraverse(forwardWalker, finishedSubtreesForward);
  }

  return { preNodes, innerNodes, postNodes };
}

/** A block-level element, <html> and <body> included. */
function isBlock(node: Node): boolean {
  if (!isElement(node)) return false;
  const tag = node.tagName.toUpperCase();
  return BLOCK_ELEMENTS.has(tag) || tag === "HTML" || tag === "BODY";
}
