// lib/diagnostics/silence.ts — which text on this page got nothing, and WHY.
//
// The owner's report is always the same sentence: "nothing shows up on this site". The
// answer is never the same twice — the paragraphs are under the word floor, the post sits
// in a `<nav>`, a modal marked the article aria-hidden, the whole column is one heading,
// the text is Chinese and the model reads English. Rediscovering which of those it is
// costs an afternoon per site, so this file answers it in the page, in the vocabulary
// a 124-site survey (2026-09) used for the same question.
//
// THE RULE THIS FILE IS BUILT ON: the reason given must be the reason the walk really had.
// So nothing here decides anything by itself. The walk's own predicates are imported and
// re-run — `isExcludedByAncestry` says WHETHER a stretch is refused before a single reason
// is named, `isBoilerplate` is probed one class token at a time to find which branch of it
// fired, `linkTextRatio` measures the links, `symbolNoiseRatio` and `looksLikeNameList`
// answer for the barriers, and the floors are the constants the assembler uses. A copy of
// a rule here would drift from the rule in lib/dom/ within a release, and the report would
// then explain a page the product no longer reads that way.
import { collectUnits, isExcludedByAncestry, isProsePre } from "../dom/walker";
import { isBoilerplate, isConsentBanner, isNoTranslate, mediaWikiFurniture } from "../dom/boilerplate";
import { NO_SCORE_TAGS, isHeading, isHeadingLabel, tagOf } from "../dom/tags";
import {
  clipsOwnText,
  createStyleCache,
  flowClassOf,
  isOutOfFlow,
  isVisuallyHidden,
  preservesNewlines,
} from "../dom/style";
import {
  countWords,
  hasColumnGaps,
  hasLetters,
  isSeparatorRun,
  linkTextRatio,
  looksLikeNameList,
  symbolNoiseRatio,
  MIN_MERGE_WORDS,
  MIN_UNIT_WORDS,
  type Unit,
} from "../dom/text";
import { MARK_ATTR } from "../types";
import { nameOf, pathOf } from "./anonymise";

/** Our own chips, which is how "did anything get drawn here?" is answered. */
const CHIP_SEL = `[${MARK_ATTR}="host"]`;

/** What the survey counts as page chrome when it reports how much prose a page holds.
 *  This is the report's own accounting — the walk's chrome filter is isBoilerplate, which
 *  is what every REASON below is taken from. */
const CHROME_SEL =
  'nav,header,footer,aside,dialog,[role="navigation"],[role="banner"],[role="contentinfo"],' +
  '[role="complementary"],[role="dialog"],[role="menu"],[role="toolbar"],[role="search"]';

/** Never walked into when counting words: media, controls and machine text hold no prose
 *  a reader reads (the same set the walk refuses, plus the tags it never reaches). */
const NO_TEXT_TAGS = new Set([...NO_SCORE_TAGS, "IFRAME", "FRAME", "HEAD"]);

/** An out-of-flow box with at most this much text is a marker, not content — the walk's
 *  own SMALL_OUT_OF_FLOW_CHARS, which is private to it. */
const MARKER_CHARS = 40;
/** Barrier thresholds the assembler routes runs by (walker.route). */
const MAX_LINK_RATIO = 0.6;
const MAX_SYMBOL_NOISE = 0.2;
/** A stretch smaller than this is a label, a button or a date — never the text somebody
 *  came to read, and fifteen of them would bury the finding that matters. */
const MIN_STRETCH_WORDS = MIN_MERGE_WORDS;

export interface SilentStretch {
  /** The box itself — the report keeps it only to refine the reason asynchronously. */
  el: Element;
  /** Anonymised ancestor path: `main > div.feed > article.post > div.body > p`. */
  path: string;
  words: number;
  reason: string;
  /** What the site does to the box on top of that: a clamp, a "show more" control. */
  note: string | null;
  /** A unit was made here and nothing was drawn — the language gate may be the answer,
   *  and only the caller can ask it (the detector is asynchronous). */
  undrawn: boolean;
}

export interface PageSurvey {
  units: Unit[];
  multiPartUnits: number;
  wordsJudged: number;
  proseWords: number;
  chromeWords: number;
  chips: number;
  /** Blocks with prose in them that ended with no chip, biggest first. */
  silent: SilentStretch[];
  /** How many boxes over the floor were examined at all. */
  examined: number;
  /** Custom elements that draw a box and expose no text: a closed shadow root is the
   *  usual explanation, and nothing in the page can see into one. */
  darkElements: string[];
  /** Open shadow roots the walk descended into. */
  shadowRoots: number;
}

// ---- composed-tree helpers (the walk's tree: a shadow root replaces light children) ----

function composedKids(el: Element): Node[] {
  const sr = el.shadowRoot;
  if (sr) return Array.from(sr.childNodes);
  if (typeof HTMLSlotElement !== "undefined" && el instanceof HTMLSlotElement) {
    return el.assignedNodes({ flatten: true });
  }
  return Array.from(el.childNodes);
}

function composedParent(el: Element): Element | null {
  const root = el.getRootNode();
  return el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
}

function containsComposed(ancestor: Element, node: Element): boolean {
  for (let cur: Element | null = node; cur; cur = composedParent(cur)) if (cur === ancestor) return true;
  return false;
}

// ---- the survey -----------------------------------------------------------------------

export function surveyPage(opts: { running: boolean; max: number }): PageSurvey {
  const styles = createStyleCache();
  const cs = (el: Element): CSSStyleDeclaration | null => styles.get(el);
  const body = document.body;
  // The walk is re-run rather than asked for: the orchestrator keeps no public list of its
  // units, and a report has to describe the page as it is NOW anyway. It costs a second
  // walk on a page that asked for one, and it is safe to repeat — the only thing a walk
  // writes is a text-node split at a blank line in preserved-whitespace text, which the
  // first scan already made. This chunk carries its own copy of the module, so the unit
  // ids it hands out cannot collide with the ones the live page is rendering.
  const units = body ? collectUnits(body) : [];
  const partContainers = units.map((u) => u.parts.map((p) => p.container));

  // A unit is "drawn" when a chip sits inside one of its parts, or just after it — the
  // badge layer puts the chip after the last run, which for a clipped box is a sibling of
  // the box rather than a child of it.
  const drawn = units.map((_, i) =>
    partContainers[i].some(
      (c) => c.querySelector(CHIP_SEL) !== null || (c.nextElementSibling?.hasAttribute(MARK_ATTR) ?? false),
    ),
  );

  const wordsOf = new Map<Element, number>();
  const proseOf = new Map<Element, number>();
  const blocks: Element[] = [];
  const darkElements = new Set<string>();
  let chromeWords = 0;
  let shadowRoots = 0;

  /** Visible words per subtree, chrome split off, smallest blocks over the floor kept.
   *  `all` is every word on the screen; `prose` is the same with chrome zeroed. */
  function walkWords(el: Element, inChrome: boolean): { all: number; prose: number } {
    if (NO_TEXT_TAGS.has(tagOf(el)) || el.hasAttribute(MARK_ATTR)) return { all: 0, prose: 0 };
    const style = cs(el);
    // display:none takes no space, so it is never why a reader sees nothing; everything
    // else that hides a box is kept and REPORTED (an aria-hidden article behind a modal is
    // the most common answer of all).
    if (style && (flowClassOf(el, style) === "hidden" || style.getPropertyValue("content-visibility") === "hidden")) {
      return { all: 0, prose: 0 };
    }
    if (el.shadowRoot) shadowRoots++;
    let chrome = inChrome;
    if (!chrome) {
      try {
        chrome = el.matches(CHROME_SEL);
      } catch {
        /* a selector no engine here supports — treat the box as content */
      }
    }
    let all = 0;
    let prose = 0;
    // The SMALLEST box holding a stretch is the one worth naming, and "smallest" has to be
    // measured in every word a child holds rather than in its prose: inside page chrome
    // every child's prose count is zero, and a nav would otherwise be reported as a
    // stretch of its own beside each of its links.
    let childMax = 0;
    for (const node of composedKids(el)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const w = countWords((node.textContent ?? "").replace(/\s+/g, " ").trim());
        all += w;
        prose += w;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const r = walkWords(node as Element, chrome);
        all += r.all;
        prose += r.prose;
        if (r.all > childMax) childMax = r.all;
      }
    }
    // A custom element with a box, no text and no open shadow root is a closed shadow root
    // (or a canvas widget): its text is unreachable from the page, ours included.
    if (all === 0 && el.tagName.includes("-") && !el.shadowRoot) {
      const box = el.getBoundingClientRect();
      if (box.width * box.height > 10_000) darkElements.add(`<${el.tagName.toLowerCase()}>`);
    }
    if (chrome) {
      if (!inChrome) chromeWords += all;
      prose = 0;
    }
    wordsOf.set(el, all);
    proseOf.set(el, prose);
    if (all >= MIN_STRETCH_WORDS && childMax < MIN_STRETCH_WORDS) blocks.push(el);
    return { all, prose };
  }
  const proseWords = body ? walkWords(body, false).prose : 0;

  // ---- which boxes ended in silence ----------------------------------------------------

  const silent: SilentStretch[] = [];
  for (const el of blocks) {
    const hits: number[] = [];
    for (let i = 0; i < units.length; i++) {
      if (partContainers[i].some((c) => containsComposed(el, c) || containsComposed(c, el))) hits.push(i);
    }
    // While Anagram is running, silence means NO CHIP: a unit nobody drew is exactly the
    // case the owner reports. On a page it is switched off for there are no chips to
    // count, so silence falls back to what the walk alone would have found.
    const covered = opts.running ? hits.some((i) => drawn[i]) : hits.length > 0;
    if (covered) continue;
    const words = wordsOf.get(el) ?? 0;
    silent.push({
      el,
      path: pathOf(el),
      words,
      reason: hits.length > 0 ? "" : reasonFor(el, cs),
      note: siteNote(el, cs),
      undrawn: hits.length > 0,
    });
  }
  silent.sort((a, b) => b.words - a.words);

  return {
    units,
    multiPartUnits: units.filter((u) => u.parts.length > 1).length,
    wordsJudged: units.reduce((n, u) => n + u.wordCount, 0),
    proseWords,
    chromeWords,
    chips: countChips(),
    silent: silent.slice(0, opts.max),
    examined: blocks.length,
    darkElements: [...darkElements].slice(0, 6),
    shadowRoots,
  };
}

/** Every chip on the page, our own floating ball excluded (it shares the marker). */
function countChips(): number {
  let n = 0;
  for (const host of document.querySelectorAll(CHIP_SEL)) if (host.id !== "anagram-fab") n++;
  for (const el of document.querySelectorAll("*")) {
    const sr = el.shadowRoot;
    if (sr) n += sr.querySelectorAll(CHIP_SEL).length;
  }
  return n;
}

// ---- naming the reason -----------------------------------------------------------------

type Styler = (el: Element) => CSSStyleDeclaration | null;

/**
 * Which branch of isBoilerplate() fired, found by probing the SHIPPED predicate on a
 * detached element one attribute at a time — so the answer is the filter's, never a copy
 * of its table.
 */
function boilerplateBranch(el: Element): string {
  const probe = document.createElement("div");
  const role = el.getAttribute("role");
  if (role) {
    probe.setAttribute("role", role);
    if (isBoilerplate(probe)) return `role="${role}"`;
    probe.removeAttribute("role");
  }
  const tag = tagOf(el);
  if (tag === "NAV") return "<nav> is chrome wherever it stands";
  if (tag === "ASIDE") return "<aside> is chrome wherever it stands";
  if (tag === "HEADER" || tag === "FOOTER") return `<${tag.toLowerCase()}> outside an <article>/<main>`;
  if (tag === "FORM") return "a <form> with fields to fill in is a widget";
  const wiki = mediaWikiFurniture(el);
  if (wiki) return `MediaWiki's "${wiki}", not the article's prose`;
  const hay = `${el.id} ${el.getAttribute("class") ?? ""}`.slice(0, 256);
  // One probe per token, as a class. isBoilerplate merges the id and the classes into a
  // single haystack and runs one regex over it, so asking again as an id can only ever
  // give the same answer — and by the same token the report cannot say WHICH of the two
  // the name came from, only that the element carries it.
  for (const token of hay.split(/\s+/)) {
    if (!token) continue;
    probe.className = token;
    if (isBoilerplate(probe)) return `name token "${token.slice(0, 40)}"`;
    probe.className = "";
  }
  return "reply-form token beside fields to type in";
}

/** The walk's ancestry exclusion, re-run so the answer names the test AND the ancestor. */
function ancestryReason(el: Element): string | null {
  if (!isExcludedByAncestry(el)) return null;
  const plainTextDoc = document.contentType === "text/plain";
  for (let cur: Element | null = el; cur; cur = composedParent(cur)) {
    const tag = tagOf(cur);
    if (NO_SCORE_TAGS.has(tag)) return `never-scored tag <${tag.toLowerCase()}>`;
    if (tag === "PRE" && !plainTextDoc && !isProsePre(cur)) {
      return "inside a <pre> of machine text — a code block, never scored";
    }
    if (cur.hasAttribute(MARK_ATTR)) return "inside Anagram's own UI";
    if (isNoTranslate(cur)) return `translate="no" / .notranslate on ${nameOf(cur)}`;
    if ((cur as HTMLElement).isContentEditable) return `inside contenteditable ${nameOf(cur)}`;
    if (cur.getAttribute("aria-hidden") === "true") {
      return `aria-hidden ${nameOf(cur)} — hidden from assistive tech, so hidden from the walk`;
    }
    if (isBoilerplate(cur)) return `page chrome ${nameOf(cur)} — ${boilerplateBranch(cur)}`;
    if (isConsentBanner(cur)) return `page chrome ${nameOf(cur)} — a consent platform's cookie banner`;
  }
  return "refused by an ancestor (branch not determined)";
}

/** A heading the walk treats as a LABEL stops it dead: it returns without descending. */
function headingReason(el: Element): string | null {
  for (let cur: Element | null = el; cur; cur = composedParent(cur)) {
    if (isHeading(cur) && isHeadingLabel(cur)) {
      return `inside heading label ${nameOf(cur)} — the walk never descends into a heading`;
    }
  }
  return null;
}

/** Hidden by layout rather than by markup — checked up the chain, because the walk carries
 *  `hidden` down with it and a paragraph under a hidden wrapper is never read. */
function hiddenReason(el: Element, cs: Styler): string | null {
  for (let cur: Element | null = el; cur; cur = composedParent(cur)) {
    const style = cs(cur);
    if (!style) continue;
    if (style.visibility === "hidden" || style.visibility === "collapse") {
      return `visibility:${style.visibility} on ${nameOf(cur)}`;
    }
    if (style.opacity === "0") return `opacity:0 on ${nameOf(cur)}`;
    if (isVisuallyHidden(style)) return `visually hidden (a screen-reader-only copy) on ${nameOf(cur)}`;
    if (isOutOfFlow(style) && (cur.textContent ?? "").trim().length <= MARKER_CHARS) {
      return `out of flow (position:${style.position}) with under ${MARKER_CHARS} characters — read as a marker, not prose`;
    }
  }
  const box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0 && el.getClientRects().length === 0) {
    return "zero-size box (0×0) — nothing of it is on the screen";
  }
  return null;
}

/** One approximation of the walk's runs: text nodes grouped by the block that lays them
 *  out. It exists only to say WHY a box is silent, never to decide anything. */
interface RunLike {
  text: string;
  /** Pre-collapse text: interior column gaps only survive here. */
  raw: string;
  /** The block keeps its newlines, so the column-gap barrier applies to it. */
  preserved: boolean;
  words: number;
  linkRatio: number;
}

function runsIn(root: Element, cs: Styler): RunLike[] {
  const map = new Map<Element, Text[]>();
  (function rec(el: Element, block: Element): void {
    if (NO_TEXT_TAGS.has(tagOf(el)) || el.hasAttribute(MARK_ATTR)) return;
    const style = cs(el);
    const flow = style ? flowClassOf(el, style) : "block";
    if (flow === "hidden") return;
    if (el !== root && isHeading(el) && isHeadingLabel(el)) return; // a barrier, never read
    const owner = flow === "inline" || flow === "contents" ? block : el;
    for (const node of composedKids(el)) {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? "").trim() === "") continue;
        const list = map.get(owner);
        if (list) list.push(node as Text);
        else map.set(owner, [node as Text]);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        rec(node as Element, owner);
      }
    }
  })(root, root);
  return [...map.entries()].map(([owner, nodes]) => {
    const raw = nodes.map((n) => n.textContent ?? "").join("");
    const text = raw.replace(/\s+/g, " ").trim();
    return {
      text,
      raw,
      preserved: preservesNewlines(cs(owner)),
      words: countWords(text),
      linkRatio: linkTextRatio(nodes),
    };
  });
}

/**
 * Why this box produced nothing. The order mirrors the walk: what it refuses outright
 * first, then what it cannot see, then how the assembler routed the runs it did read.
 */
function reasonFor(el: Element, cs: Styler): string {
  const ancestry = ancestryReason(el);
  if (ancestry) return ancestry;
  const heading = headingReason(el);
  if (heading) return heading;
  const hidden = hiddenReason(el, cs);
  if (hidden) return hidden;

  // The box read on its own yields units — so nothing about the box is the problem, and
  // something above it (a barrier, another voice's scope) kept it from becoming one here.
  let standalone: Unit[] = [];
  try {
    standalone = collectUnits(el);
  } catch {
    /* nothing in the walk throws, but this runs inside a report about a page that is
       already behaving oddly: a host-DOM surprise must not cost the reader the report */
  }
  if (standalone.length > 0) {
    return `the box alone yields ${standalone.length} unit(s) — a page-level barrier or a neighbouring voice suppressed it here`;
  }

  const runs = runsIn(el, cs).filter((r) => r.words > 0);
  if (runs.length === 0) return "no run survived the walk — every block in it is invisible or excluded";
  const longest = runs.reduce((m, r) => Math.max(m, r.words), 0);
  const linkDense = runs.filter((r) => r.linkRatio > MAX_LINK_RATIO);
  const noisy = runs.filter((r) => symbolNoiseRatio(r.text) > MAX_SYMBOL_NOISE);
  const names = runs.filter((r) => looksLikeNameList(r.text));
  const half = Math.ceil(runs.length / 2);

  if (runs.every((r) => !hasLetters(r.text))) {
    const separators = runs.filter((r) => isSeparatorRun(r.text)).length;
    return `no letters in it — ${separators > 0 ? "a separator rule" : "digits and symbols only"}, which is not prose`;
  }
  if (noisy.length >= half) {
    return `symbol noise over ${MAX_SYMBOL_NOISE} in ${noisy.length}/${runs.length} blocks — machine layout (ASCII art, a table rule), a barrier`;
  }
  if (runs.some((r) => r.preserved && hasColumnGaps(r.raw))) {
    return "preserved-whitespace text with interior column gaps — read as machine layout (an ASCII table, an RFC header), a barrier";
  }
  if (linkDense.length >= half) {
    const worst = Math.max(...linkDense.map((r) => r.linkRatio));
    return `link-dense: ${linkDense.length}/${runs.length} blocks over the ${MAX_LINK_RATIO} link-text ratio (worst ${worst.toFixed(2)}) — a nav/menu barrier`;
  }
  if (names.length >= half) {
    return `reads as a name list (${names.length}/${runs.length} blocks) — an author or citation row, not prose`;
  }
  if (longest < MIN_UNIT_WORDS) {
    return (
      `under the ${MIN_UNIT_WORDS}-word floor: longest paragraph ${longest} words over ${runs.length} block(s), ` +
      "and no neighbour of the same voice to merge with"
    );
  }
  // The walk counts fewer words than this does: citation marks and formulas are skipped
  // mid-sentence, so a block measuring 76 here can be 73 to it and fall under the floor.
  const marks = el.querySelectorAll("sup,cite").length;
  const formulas = el.querySelectorAll("math,mjx-container,.katex,.mwe-math-element,.ltx_Math,.MathJax").length;
  return (
    `no unit although the longest block measures ${longest} words here — the walk counts less ` +
    `(${marks} sup/cite marks and ${formulas} formulas are skipped mid-sentence), leaving it under the ${MIN_UNIT_WORDS}-word floor`
  );
}

/** What the SITE does to the box on top of everything else: a clamp, a "show more"
 *  control. None of it stops a unit — it is why a paragraph can be in the page and not on
 *  the screen, and why a chip ends up somewhere unexpected. */
function siteNote(el: Element, cs: Styler): string | null {
  for (let cur: Element | null = el; cur; cur = composedParent(cur)) {
    const style = cs(cur);
    if (!style) continue;
    const clamp = style.getPropertyValue("-webkit-line-clamp");
    if (clamp && clamp !== "none") return `clamped to ${clamp} lines on ${nameOf(cur)}`;
    if (clipsOwnText(cur, style)) {
      return `clipped: ${cur.scrollHeight}px of content in a ${cur.clientHeight}px box on ${nameOf(cur)}`;
    }
    if (cur === document.body) break;
  }
  // A collapsed control means the rest of the text is not in the page at all — nothing can
  // read what the site has not written yet.
  if (el.querySelector('[aria-expanded="false"]')) return 'a collapsed control (aria-expanded="false") holds the rest back';
  return null;
}
