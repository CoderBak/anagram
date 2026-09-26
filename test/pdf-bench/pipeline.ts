// test/pdf-bench/pipeline.ts — the reader's own path from a PDF page to scored units.
//
// bench.mjs bundles this with esbuild and runs it in Node. Nothing here re-implements the
// reader: extractPageText, reflowPdf, structuredBlocks and groupsOf are the functions
// entrypoints/reader/main.ts and lib/pdf/units.ts call, and pdf.js is the very file the
// reader loads (public/vendor/pdfjs.min.mjs, through lib/lazy.ts with a stub for the
// extension API). The one thing written out again is the join of a group's text, which
// units.ts does inside a DOM-bound function: "\n\n" between paragraphs, cut at
// MAX_UNIT_TEXT_CHARS, the words being the plan's own counts.
import { loadPdfjs } from "../../lib/lazy";
import { extractPageText } from "../../lib/pdf/extract";
import { reflowPdf, type PdfPageText, type ReflowBlock } from "../../lib/pdf/reflow";
import { structuredBlocks } from "../../lib/pdf/structured";
import { groupsOf, planOf } from "../../lib/pdf/units";
import { MAX_UNIT_TEXT_CHARS, MIN_UNIT_WORDS } from "../../lib/dom/text";

export { loadPdfjs, extractPageText, reflowPdf, structuredBlocks, MIN_UNIT_WORDS };

export interface BenchUnit {
  text: string;
  words: number;
  /** Indices into the blocks the unit was grouped from. */
  blocks: number[];
  page: number;
}

/** The reader's reflow over runs of consecutive pages, exactly as main.ts rebuild() does. */
export function reflowRuns(groups: PdfPageText[][]): ReflowBlock[] {
  const blocks: ReflowBlock[] = [];
  for (const group of groups) {
    const reflow = reflowPdf(group);
    if (reflow[0] && blocks.length) reflow[0].columnBreak = true;
    blocks.push(...reflow);
  }
  return blocks;
}

/** What lib/pdf/units.ts hands the orchestrator for these blocks, minus the DOM. */
export function unitsOf(blocks: ReflowBlock[], mergeShorts = true): BenchUnit[] {
  const plan = planOf(blocks);
  return groupsOf(blocks, mergeShorts).map((group) => {
    let text = "";
    for (const at of group) text = text.length === 0 ? blocks[at].text : `${text}\n\n${blocks[at].text}`;
    let words = 0;
    for (const at of group) words += plan[at].words;
    return { text: text.slice(0, MAX_UNIT_TEXT_CHARS), words, blocks: group, page: blocks[group[0]].page };
  });
}

export function planWords(blocks: ReflowBlock[]): number[] {
  return planOf(blocks).map((b) => b.words);
}
