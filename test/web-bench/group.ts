// test/web-bench/group.ts — another extractor's text, read the way Anagram would read it.
//
// bench.mjs bundles this for Node. An extractor such as Trafilatura or MinerU-HTML returns
// the main content as Markdown; to compare it with our reading of the live page, its
// paragraphs go through the same grouping rules the walker and the PDF reader use
// (lib/plan/group.ts): the 75-word floor, short neighbours read together up to one model
// window, a heading or a table row a barrier nothing is read across. Words are counted
// with the walker's own countWords.
import { groupBlocks, type PlanBlock } from "../../lib/plan/group";
import { countWords } from "../../lib/dom/text";

interface Block extends PlanBlock {
  text: string;
}

/** Markdown (or plain text, one paragraph per line) as the blocks grouping reads. */
function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  let fenced = false;
  const barrier = (): void => {
    blocks.push({ text: "", words: 0, chars: 0, role: "barrier" });
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      barrier();
      continue;
    }
    if (fenced || line === "") continue;
    if (/^#{1,6}\s/.test(line) || /^\|/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      barrier();
      continue;
    }
    const text = line
      .replace(/^>\s?/, "")
      .replace(/^([-*+]|\d+[.)])\s+/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    blocks.push({ text, words: countWords(text), chars: text.length });
  }
  return blocks;
}

/** The units a Markdown text becomes: their texts, "\n\n" between paragraphs. */
export function unitsOfMarkdown(markdown: string): string[] {
  const blocks = blocksOf(markdown);
  return groupBlocks(blocks).map((group) => group.map((i) => blocks[i].text).join("\n\n"));
}
