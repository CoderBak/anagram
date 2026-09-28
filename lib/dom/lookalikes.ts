// lib/dom/lookalikes.ts — Cyrillic and Greek letters disguised as Latin ones, folded back.
//
// A text can be disguised by writing look-alike letters from another alphabet inside its
// English words: "hаvе" with a Cyrillic а and е, "Ι'm" with a Greek capital iota. It reads
// the same and is no longer the same text: fastText calls it Ukrainian, so the language
// gate refuses it, and RAID's homoglyph attack left every such text without a verdict. The
// model form (modelText in lib/dom/text.ts) folds those letters back before both engines
// and the caches see the text, by Unicode's confusables (UTS #39; lib/dom/confusables.json,
// written by scripts/confusables.mjs). The official EditLens pipeline does not.
//
// Only a disguise is folded, never a word somebody wrote in another alphabet:
//   · A word is a run of letters, marks and digits. It is MIXED when it has Latin letters
//     and letters of the table, and no letter of another alphabet outside it ("hаvе" is,
//     "Москва" and "iPhone拍照" are not). It is a LOOK-ALIKE when its letters are all
//     from the table ("Неу", a lone Cyrillic "а").
//   · A text is disguised when a mixed word has a letter of the table that is not a small
//     Greek one (the sciences write "Hα", "dν", "lnρ" and mean it; omicron is nobody's
//     symbol), and its letters are mostly Latin once folded. Then every mixed and
//     look-alike word is folded; otherwise nothing is. So a Russian or Greek paragraph
//     stays as written and is still refused, an English one that quotes a Russian word
//     keeps it, and a physics paper keeps its α and ν.
// Measured: 15,979 arXiv paragraphs, EditLens's 20,619 texts and RAID's 467,985 texts
// without an attack come out byte for byte as before but for 43 of RAID's machine texts,
// which wrote Cyrillic letters into English words themselves; of 3,961 web pages, four
// change, each a disguise (spam, a keyboard slip). RAID's homoglyph attack is undone
// exactly in 1,103 of 1,104 texts.
//
// Every letter of the table is one UTF-16 unit and folds to one ASCII character, so a
// folded text keeps every offset of the text it came from.
import DATA from "./confusables.json";

const FOLD: Readonly<Record<string, string>> = DATA.fold;
const ANY = new RegExp(`[${Object.keys(FOLD).join("")}]`);
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;
const ANY_SCRIPT = /[\p{Script=Common}\p{Script=Inherited}]/u;
const GREEK = /\p{Script=Greek}/u;
const SMALL = /\p{Ll}/u;

interface Word {
  /** Letters in all. */
  letters: number;
  /** Latin letters, and letters of the table. */
  latin: number;
  table: number;
  /** A letter of the table that says "disguise" on its own: not a small Greek one. */
  telling: boolean;
  /** Mixed (Latin and table letters), look-alike (table letters only), or neither. */
  kind: "mixed" | "lookalike" | null;
}

function wordOf(word: string): Word {
  let letters = 0;
  let latin = 0;
  let table = 0;
  let foreign = 0;
  let telling = false;
  for (const ch of word) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (FOLD[ch] !== undefined) {
      table++;
      if (!(GREEK.test(ch) && SMALL.test(ch)) || ch === "ο") telling = true;
    } else if (LATIN.test(ch)) latin++;
    else if (!ANY_SCRIPT.test(ch)) foreign++;
  }
  const kind = table === 0 || foreign > 0 ? null : latin > 0 ? "mixed" : "lookalike";
  return { letters, latin, table, telling, kind };
}

/** The text with its disguised words folded to Latin letters, or the text itself: the same
 *  length, and a fixed point. */
export function foldLookalikes(text: string): string {
  if (!ANY.test(text)) return text;
  const words = new Map<string, Word>();
  let letters = 0;
  let latin = 0;
  let disguised = false;
  for (const [w] of text.matchAll(WORD)) {
    let word = words.get(w);
    if (!word) words.set(w, (word = wordOf(w)));
    letters += word.letters;
    latin += word.latin + (word.kind ? word.table : 0);
    if (word.kind === "mixed" && word.telling) disguised = true;
  }
  if (!disguised || latin * 2 <= letters) return text;
  return text.replace(WORD, (w) => (words.get(w)!.kind ? Array.from(w, (ch) => FOLD[ch] ?? ch).join("") : w));
}

/** Whether the model reads this text with look-alike letters folded (the card says so). */
export function hasLookalikes(text: string): boolean {
  return foldLookalikes(text) !== text;
}
