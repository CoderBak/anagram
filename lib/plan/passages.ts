// Adjacent paragraphs compete for the same context. Count the joined input so the
// tokenizer sees exactly the punctuation and paragraph breaks the detector will see.
import { CONTRACT_LIMITS, type TokenCounts } from "../contract";
import { MAX_UNIT_TEXT_CHARS } from "../dom/text";

export interface PassageBlock {
  /** Input in the same normalized form as the scoring request. */
  text: string;
  sourceChars?: number;
  words: number;
  breakBefore?: boolean;
}

export async function groupPassages(blocks: readonly PassageBlock[], floor: number,
  count: (texts: string[]) => Promise<TokenCounts | null>): Promise<number[][] | null> {
  let groups = blocks.map((block, index) => ({
    indices: [index], chars: block.sourceChars ?? block.text.length, text: block.text, words: block.words, standalone: block.words >= floor, breakBefore: block.breakBefore,
  }));
  while (groups.length > 1) {
    const pairs: { index: number; text: string; shortWords: number }[] = [];
    for (let i = 0; i + 1 < groups.length; i++) {
      const a = groups[i]!, b = groups[i + 1]!;
      // A readable source paragraph keeps its own verdict when its neighbour already
      // has enough evidence. Runs made entirely of short paragraphs may use the full window.
      if ((a.standalone || b.standalone) && a.words >= floor && b.words >= floor) continue;
      if (b.breakBefore || a.chars + b.chars + 2 > MAX_UNIT_TEXT_CHARS || a.text.length + b.text.length + 2 > CONTRACT_LIMITS.text_chars) continue;
      pairs.push({ index: i, text: a.text + "\n\n" + b.text,
        shortWords: (a.words < floor ? a.words : 0) + (b.words < floor ? b.words : 0) });
    }
    if (!pairs.length) break;
    const counts = await count(pairs.map(pair => pair.text));
    const window = counts?.window;
    if (!counts || !window || counts.alone.length !== pairs.length) return null;
    const fits = pairs.map((pair, i) => ({ ...pair, tokens: counts.alone[i]! }))
      .filter(pair => pair.tokens <= window);
    if (!fits.length) break;
    // Give unread paragraphs first access to a neighbour. Among equally readable
    // choices, join the smaller pair, leaving room on either side for the next round.
    fits.sort((a, b) => b.shortWords - a.shortWords || a.tokens - b.tokens || a.index - b.index);
    const joins = new Set<number>();
    for (const pair of fits) {
      if (!joins.has(pair.index - 1) && !joins.has(pair.index + 1)) joins.add(pair.index);
    }
    const next: typeof groups = [];
    for (let i = 0; i < groups.length; i++) {
      const a = groups[i]!;
      if (!joins.has(i)) { next.push(a); continue; }
      const b = groups[++i]!;
      next.push({ indices: [...a.indices, ...b.indices], chars: a.chars + b.chars + 2, text: a.text + "\n\n" + b.text,
        words: a.words + b.words, standalone: a.standalone || b.standalone, breakBefore: a.breakBefore });
    }
    groups = next;
  }
  return groups.map(group => group.indices);
}
