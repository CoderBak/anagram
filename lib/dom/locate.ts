// lib/dom/locate.ts — from offsets in a unit's text back to places in the page.
//
// A unit's `text` is not what the DOM holds: the walker joins the text nodes of each
// part, collapses every whitespace run to one space, trims, and puts "\n\n" between the
// parts of a merged unit. A window of that text ("characters 1790 to 3571") therefore
// has to be walked back through the same steps to become a Range. Nodes the walker
// skipped — a formula in mid-sentence, a "[7]" citation mark — are simply not in
// `part.nodes`: the text runs straight across them, and so does the mapping.
//
// Nothing here touches the page: ranges start and end INSIDE text nodes, no node is
// split and nothing is wrapped.
import { extractPartText, quoteMarkerMask, type UnitPart } from "./text";

/** A stretch of a unit's text: offsets into `unit.text`, end exclusive. */
interface Span {
  start: number;
  end: number;
}

/** One part as the walker collapsed it, with the home of every character it kept. */
interface PartMap {
  text: string;
  /** Per character of `text`: index into part.nodes … */
  node: number[];
  /** … and the offset in that node's data. A collapsed space points at the FIRST
   *  whitespace character of its run. */
  offset: number[];
}

/** The walker's `unitPartText(extractPartText(nodes), part.preserved)` (lib/dom/text.ts),
 *  remembering where each surviving character came from. The quote markers of a mailing-list
 *  message are not in the unit's text, so they are not in this map either — the two have to
 *  drop the same characters or nothing lines up. */
function mapPart(part: UnitPart): PartMap {
  const nodes = part.nodes;
  const marker = part.preserved ? quoteMarkerMask(extractPartText(nodes)) : null;
  const chars: string[] = [];
  const node: number[] = [];
  const offset: number[] = [];
  /** A whitespace run waiting to see whether a word follows it (else it is the trim). */
  let gap: { n: number; o: number } | null = null;
  /** Offset in the joined text of the part — what the marker flags are counted in. */
  let at = 0;
  for (let n = 0; n < nodes.length; n++) {
    const data = nodes[n].data;
    for (let o = 0; o < data.length; o++, at++) {
      if (marker !== null && marker[at]) continue;
      if (/\s/.test(data[o])) {
        if (chars.length > 0 && !gap) gap = { n, o };
        continue;
      }
      if (gap) {
        chars.push(" ");
        node.push(gap.n);
        offset.push(gap.o);
        gap = null;
      }
      chars.push(data[o]);
      node.push(n);
      offset.push(o);
    }
  }
  return { text: chars.join(""), node, offset };
}

/**
 * One Range per (span, part) the span reaches into — never one range across two parts,
 * which would sweep up whatever sits between two merged paragraphs. A span's range runs
 * from its first word to the first word of whatever follows it in the same part, so
 * consecutive windows leave no unmarked space between them.
 *
 * Returns null when the page no longer says what `text` says (edited or re-rendered
 * under us, a node detached): the caller then marks the whole unit the way it always
 * did, and the mutation observer retires the unit a moment later.
 */
export function locateSpans(parts: UnitPart[], text: string, spans: Span[]): Range[][] | null {
  const out: Range[][] = spans.map(() => []);
  let base = 0; // offset of the current part inside `text`
  let matched = 0; // how much of `text` the parts have accounted for
  for (const part of parts) {
    if (base >= text.length) break; // the unit's storage cap fell before this part
    const map = mapPart(part);
    // Only the part that storage cap cuts through may hold more than `text` does.
    const expected = text.slice(base, base + map.text.length);
    if (expected.length === 0 || !map.text.startsWith(expected)) return null;
    matched = base + expected.length;
    if (expected.length < map.text.length && matched !== text.length) return null;

    const before = (i: number): [Text, number] => [part.nodes[map.node[i]], map.offset[i]];
    const firstWord = (i: number): number => {
      while (i < map.text.length && map.text[i] === " ") i++;
      return i;
    };
    for (let k = 0; k < spans.length; k++) {
      const from = firstWord(Math.max(spans[k].start - base, 0));
      const to = Math.min(spans[k].end - base, expected.length);
      if (from >= to) continue;
      const next = firstWord(to);
      const last = map.text.length - 1;
      try {
        const range = new Range();
        range.setStart(...before(from));
        if (next <= last) range.setEnd(...before(next));
        else range.setEnd(part.nodes[map.node[last]], map.offset[last] + 1);
        out[k].push(range);
      } catch {
        return null; // a node left the document between the scan and now
      }
    }
    base += map.text.length + 2; // the "\n\n" the walker joins parts with
  }
  // Text the parts never produced (a node emptied, a part gone) is a mismatch as well.
  return text.slice(matched).trim() === "" ? out : null;
}
