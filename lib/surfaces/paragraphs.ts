// lib/surfaces/paragraphs.ts — a site whose every paragraph is a box of its own.
//
// The walk reads short paragraphs together only where they stand together in the markup:
// siblings, or a paragraph and its uncle. Two paragraphs each wrapped in a box of its own
// are cousins, and a cousin is what the next person's comment is on a page nobody marked
// up, so they are never read together — which is right on a comment thread and wrong on a
// site that wraps every paragraph of a chapter that way. Web fiction is written in short
// paragraphs, and there the walk read only the rare one of seventy-five words or more.
//
// A site like that is read here from the list of its paragraphs, which its source knows:
// in document order, with the breaks between them (a new chapter). The grouping rules are
// the walk's own (lib/plan/group.ts), and so are the unit's text and parts — each part is a
// paragraph element and its text nodes — so chips, marks and re-scans work on these units
// exactly as on any page's. Nothing is placed or painted differently.
import {
  countWords,
  extractPartText,
  hasLetters,
  isSeparatorRun,
  looksLikeNameList,
  shortRole,
  unitPartText,
  MAX_UNIT_TEXT_CHARS,
  MIN_UNIT_WORDS,
  type Unit,
} from "../dom/text";
import { groupBlocks, type BlockRole, type PlanBlock } from "../plan/group";
import { MARK_ATTR } from "../types";
import type { Surface } from "./types";

export interface Paragraph {
  el: Element;
  /** Nothing is read across the joint in front of it: a new chapter. */
  breakBefore: boolean;
}

export interface ParagraphSource {
  /** The document's paragraphs in order, or null when there is none on the page. */
  paragraphs(): Paragraph[] | null;
}

/** The text nodes of a paragraph, our own chips left out. */
function textNodes(el: Element): Text[] {
  const out: Text[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(`[${MARK_ATTR}]`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  while (out.length > 0 && out[0].data.trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].data.trim() === "") out.pop();
  return out;
}

function roleOf(text: string, words: number): BlockRole {
  if (words >= MIN_UNIT_WORDS) return "prose";
  if (!hasLetters(text)) return isSeparatorRun(text) ? "barrier" : "skip";
  if (looksLikeNameList(text)) return "barrier";
  const role = shortRole(text);
  return role === "prose" ? "prose" : role === "aside" ? "skip" : "barrier";
}

let _seq = 0;

export function createParagraphSurface(source: ParagraphSource): Surface {
  let answered = false;
  return {
    active: () => source.paragraphs() !== null,
    ranges: () => undefined,
    place: () => null,
    collect(claim, mergeShorts) {
      if (answered) return [];
      answered = true;
      queueMicrotask(() => {
        answered = false;
      });
      const paragraphs = source.paragraphs() ?? [];
      const blocks = paragraphs.map((p) => {
        const nodes = textNodes(p.el);
        const text = unitPartText(extractPartText(nodes), false);
        const words = countWords(text);
        return { p, nodes, text, words, chars: text.length, role: roleOf(text, words), barrierBefore: p.breakBefore };
      });
      const usable = blocks.filter((b) => b.nodes.length > 0 && b.text !== "");
      const plan: PlanBlock[] = usable;
      const groups = mergeShorts
        ? groupBlocks(plan)
        : usable.flatMap((b, i) => (b.role === "prose" && b.words >= MIN_UNIT_WORDS ? [[i]] : []));
      const out: Unit[] = [];
      for (const group of groups) {
        const members = group.map((i) => usable[i]);
        // The walker's protocol: a unit whose every part a live unit owns exactly is that
        // unit; anything else is asked for as a whole, which retires a stale owner.
        if (members.every((m) => claim(m.nodes) === "skip")) continue;
        if (claim(members.flatMap((m) => m.nodes)) === "skip") continue;
        const seq = _seq++;
        out.push({
          id: `w_${seq.toString(36)}`,
          parts: members.map((m) => ({ nodes: m.nodes, container: m.p.el })),
          text: members.map((m) => m.text).join("\n\n").slice(0, MAX_UNIT_TEXT_CHARS),
          wordCount: members.reduce((n, m) => n + m.words, 0),
          formulas: 0,
          order: seq,
          topElement: members[0].p.el,
          container: members[members.length - 1].p.el,
          isScored: false,
        });
      }
      return out;
    },
  };
}

/**
 * Webnovel (www.webnovel.com/book/…): every chapter is an `h1` over its paragraphs, each
 * `.cha-paragraph` holding one `<p>` and the counter of readers' comments on it, and the
 * next chapter is added below as the reader reaches the foot of the page. Selectors from
 * Read Aloud's adapter (js/content/webnovel.js, https://github.com/ken107/read-aloud, MIT
 * licence, Copyright (c) 2016 Hai Phan and contributors); the page itself answers a
 * headless browser with a challenge, so the one-paragraph-per-box structure is modelled
 * (test/fixtures/surfaces/webnovel-chapter.html).
 */
export function createWebnovelSource(doc: Document): ParagraphSource {
  return {
    paragraphs() {
      // Headings and paragraphs in one list, in document order: a chapter ends where the
      // next chapter's heading stands.
      const out: Paragraph[] = [];
      let heading = false;
      for (const el of doc.querySelectorAll("h1, .cha-paragraph p")) {
        if (el.tagName === "H1") {
          heading = true;
          continue;
        }
        out.push({ el, breakBefore: heading && out.length > 0 });
        heading = false;
      }
      return out.length > 0 ? out : null;
    },
  };
}
