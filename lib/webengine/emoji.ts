// lib/webengine/emoji.ts — emoji spelt out by name, as the `emoji` Python package does it.
//
// EditLens's preprocessing (anagramd/engine.py clean_text, identical to the official
// scripts/preprocess.py) starts with emoji.demojize: every emoji sequence becomes its
// English shortcode, ":thumbs_up:". The in-browser engine must produce the very same
// string, so this is a port of the package's tokenizer (emoji/tokenizer.py, BSD-3-Clause,
// https://github.com/carpedm20/emoji) over the same data (emoji.data.json, written from
// the pinned package by scripts/emojiData.py): longest match in a search tree keyed by
// code point, the zero-width-joiner rules for sequences the data does not list, and the
// dropping of stray variation selectors that are not part of a match.
import DATA from "./emoji.data.json";

const ZWJ = "‍";
/** The package's STATUS["component"]: skin tones, hair components. */
const COMPONENT = 1;

interface Node { next?: Map<string, Node>; data?: readonly [name: string, status: number] }

let tree: Node | undefined;
let table: Map<string, readonly [string, number]> | undefined;

/** The search tree over every emoji sequence, built once, as the package's get_search_tree. */
function searchTree(): Node {
  if (tree) return tree;
  const root: Node = {};
  table = new Map();
  for (const [sequence, entry] of Object.entries(DATA.emoji as unknown as Record<string, [string, number]>)) {
    const value: readonly [string, number] = [entry[0], entry[1]];
    table.set(sequence, value);
    let node = root;
    for (const char of sequence) {
      node.next ??= new Map();
      let child = node.next.get(char);
      if (!child) { child = {}; node.next.set(char, child); }
      node = child;
    }
    node.data = value;
  }
  tree = root;
  return root;
}

/** One unit of the tokenized string: a matched emoji sequence (`name` set) or one character. */
export interface EmojiToken { chars: string; name?: string; status?: number }

/**
 * The package's tokenize(string, keep_zwj), on an array of code points. Text characters
 * come out one code point each; a matched emoji comes out as one token carrying its name.
 * A U+FE0E/U+FE0F that is not inside a match is dropped, as the package drops it.
 */
export function tokenizeEmoji(text: string, keepZwj: boolean): EmojiToken[] {
  const root = searchTree();
  const chars = Array.from(text);
  const length = chars.length;
  const out: EmojiToken[] = [];
  let result: EmojiToken[] = [];
  const ignore = new Set<number>();
  let i = 0;
  while (i < length) {
    let consumed = false;
    const char = chars[i];
    if (ignore.has(i)) {
      i++;
      if (char === ZWJ && keepZwj) result.push({ chars: char });
      continue;
    }
    const first = root.next?.get(char);
    if (first) {
      let j = i + 1;
      let sub = first;
      while (j < length) {
        const next = sub.next?.get(chars[j]);
        if (!next || ignore.has(j)) break;
        sub = next;
        j++;
      }
      if (sub.data) {
        result.push({ chars: chars.slice(i, j).join(""), name: sub.data[0], status: sub.data[1] });
        i = j - 1;
        consumed = true;
      }
    } else if (char === ZWJ && result.length > 0 && table!.has(result[result.length - 1].chars) &&
               i > 0 && root.next?.has(chars[i - 1])) {
      // A joiner right after an emoji: read the sequence again from before that emoji, with
      // the joiner skipped, so "👨‍👩‍👧" is found as one match where the data lists it.
      ignore.add(i);
      const last = result[result.length - 1];
      if (table!.get(last.chars)![1] === COMPONENT) {
        // The last match was a component: ZWJ+EMOJI+COMPONENT or ZWJ+COMPONENT.
        let back = 0;
        for (const token of result.slice(-2)) back += Array.from(token.chars).length;
        i -= back;
        if (chars[i] === ZWJ) { i++; result.pop(); }
        else result.splice(-2, 2);
      } else {
        i -= Array.from(last.chars).length;
        result.pop();
      }
      continue;
    } else if (result.length > 0) {
      out.push(...result);
      result = [];
    }
    if (!consumed && char !== "︎" && char !== "️") result.push({ chars: char });
    i++;
  }
  out.push(...result);
  return out;
}

/** emoji.demojize(text): every emoji sequence the data lists becomes its English name. */
export function demojize(text: string): string {
  let out = "";
  for (const token of tokenizeEmoji(text, true)) out += token.name ?? token.chars;
  return out;
}

/** emoji.replace_emoji(text, ""): every listed emoji sequence removed. */
export function removeEmoji(text: string): string {
  let out = "";
  for (const token of tokenizeEmoji(text, false)) if (token.name === undefined) out += token.chars;
  return out;
}
