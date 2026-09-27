// lib/webengine/clean.ts — EditLens's text cleaning, character for character.
//
// anagramd/engine.py clean_text is the official scripts/preprocess.py: emoji spelt out,
// a "</think>" prelude cut, a chatbot's opening line dropped, lowercase, whitespace
// collapsed. The browser engine must feed the model the same string, so this follows the
// Python line by line, with Python's notion of whitespace rather than JavaScript's: `\s`
// and str.strip() in Python mean the characters str.isspace() accepts, which include the
// four ASCII separators U+001C–U+001F and U+0085 and exclude U+FEFF; JavaScript's `\s`
// is the other way round on both.
import { demojize, removeEmoji } from "./emoji";

/** Python's str.isspace() set, as a character class. */
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "g");
const EDGE_SPACE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const ONLY_SPACE = new RegExp(`^[${PY_SPACE}]*$`);
/** scripts/preprocess.py's list of openings a chatbot's answer starts with. */
const BOILERPLATE_STARTS = ["Sure", "Here", "Abstract", "Title", "I'm happy to help", "Certainly"];

/** Python's str.strip(). */
export function pyStrip(text: string): string {
  return text.replace(EDGE_SPACE, "");
}

function normalizeWhitespace(text: string): string {
  return pyStrip(text.replace(SPACE_RUN, " "));
}

function removeThinkTag(text: string): string {
  // Python: text.split("</think>")[1].strip() — the part between the first and the second tag.
  if (!text.includes("</think>")) return text;
  return pyStrip(text.split("</think>")[1]);
}

function removeAiHeader(text: string): string {
  const paragraphs = text.split("\n").filter((p) => !ONLY_SPACE.test(p));
  if (paragraphs.length === 0) return text;
  let first = paragraphs[0].replace(/^[^a-zA-Z0-9]*/, "");
  first = removeEmoji(first);
  if (BOILERPLATE_STARTS.some((p) => first.startsWith(p)) && paragraphs.length > 1) return paragraphs.slice(1).join("\n");
  return text;
}

/** clean_text(text): what the model reads, before tokenization. */
export function cleanText(text: string): string {
  text = demojize(text);
  text = removeThinkTag(text);
  text = removeAiHeader(text);
  text = text.toLowerCase();
  return normalizeWhitespace(text);
}
