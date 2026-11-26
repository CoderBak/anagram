import { readReflowed } from "./reading";
import {
  continuedPrefix, copyTypography, fusesWord, LONGEST_WORD, sourcePosition,
  type BatchSpellings, type PdfPageText, type PdfTextItem, type PrintedBreak,
  type ReflowBlock, type ReflowTypography, type SourceRun,
} from "./reflow";
import { append } from "./arrays";
import { documentParagraphs, groupsOf, type DocumentParagraph } from "./units";

/** A gap in the pages on screen is a real break in the text. */
export function reflowRendered(rendered: PdfPageText[], compoundHeads: readonly string[] = [], typography?: ReflowTypography, spellings?: BatchSpellings): ReflowBlock[] {
  const blocks: ReflowBlock[] = [];
  let run: PdfPageText[] = [];
  const flush = () => {
    const next = readReflowed(run, compoundHeads, typography, spellings);
    if (next[0] && blocks.length) next[0].columnBreak = true;
    append(blocks, next);
    run = [];
  };
  for (const page of rendered) {
    if (!page.items.some((it) => it.str.trim())) { if (run.length) flush(); continue; }
    if (run.length && run.at(-1)!.page + 1 !== page.page) flush();
    run.push(page);
  }
  if (run.length) flush();
  return blocks;
}

interface BrokenWord extends PrintedBreak { block: number; run: number }

/** Reading can remove citations and mathematics after reflowing the physical lines.
 *  Keep only joins whose two sides survived, at their normalized paragraph offsets. */
function locateBreaks(blocks: ReflowBlock[], breaks: PrintedBreak[]): BrokenWord[] {
  if (!breaks.length) return [];
  const after = new Map(breaks.map((w) => [w.after, w]));
  const found: BrokenWord[] = [];
  for (const [block, b] of blocks.entries()) {
    if (b.kind !== "paragraph") continue;
    for (let run = 1; run < b.runs.length; run++) {
      const left = b.runs[run - 1]!, right = b.runs[run]!;
      if (left.at + left.length !== right.at) continue;
      const w = after.get(sourcePosition(right.page, right.item, right.from));
      if (!w) continue;
      const end = w.kept ? right.at - 1 : right.at;
      if (w.kept && (b.text[end] !== w.glyph || left.page !== w.page || left.item !== w.item ||
        left.from + left.length - 1 !== w.offset)) continue;
      if (b.text.slice(Math.max(0, end - w.stem.length), end).toLowerCase() !== w.stem ||
        b.text.slice(right.at, right.at + w.tail.length).toLowerCase() !== w.tail) continue;
      found.push({...w, block, run});
    }
  }
  return found;
}

function scoringGroups(blocks: ReflowBlock[]) {
  const groups = groupsOf(blocks);
  const paragraphs = documentParagraphs(blocks, (b) => [...new Set(b.runs.map((r) => r.page))], undefined, groups);
  return {groups, paragraphs};
}

export function prepareBatch(pages: PdfPageText[], compoundHeads: readonly string[] = [], previous?: ReflowTypography) {
  const typography = copyTypography(previous);
  const spellings: BatchSpellings = {fused: new Set(), hyphenated: new Set(), breaks: []};
  const blocks = reflowRendered(pages, compoundHeads, typography, spellings);
  return {blocks, typography, fused: spellings.fused, hyphenated: spellings.hyphenated,
    broken: locateBreaks(blocks, spellings.breaks), ...scoringGroups(blocks)};
}
export type ReflowBatch = ReturnType<typeof prepareBatch>;

type StoredBlock = Omit<ReflowBlock, "runs"> & { runs: Uint32Array };
function pack({runs, ...block}: ReflowBlock): StoredBlock {
  const packed = new Uint32Array(runs.length * 5);
  let i = 0;
  for (const r of runs) {
    packed[i++] = r.page; packed[i++] = r.item; packed[i++] = r.at;
    packed[i++] = r.from; packed[i++] = r.length;
  }
  return { ...block, runs: packed };
}

function unpack(block: StoredBlock, drawn?: ReadonlySet<number>): ReflowBlock {
  const runs: SourceRun[] = [];
  const a = block.runs;
  for (let i = 0; i < a.length; i += 5) {
    const page = a[i]!;
    if (!drawn || drawn.has(page)) runs.push({page, item: a[i + 1]!, at: a[i + 2]!, from: a[i + 3]!, length: a[i + 4]!});
  }
  return { ...block, runs };
}

/** Apply changed line-break decisions to both the string and its source runs. A
 *  hyphen can share the stem's PDF.js item or be painted in an item of its own. */
function correctBreaks(block: ReflowBlock, words: BrokenWord[]): void {
  const edits = new Map(words.map((w) => [w.run, w]));
  const runs: SourceRun[] = [], parts: string[] = [];
  let from = 0, shift = 0;
  for (const [i, r] of block.runs.entries()) {
    const w = edits.get(i);
    if (w) {
      const last = runs.at(-1)!;
      if (w.kept) {
        parts.push(block.text.slice(from, r.at - 1));
        if (--last.length === 0) runs.pop();
        shift--;
      } else {
        parts.push(block.text.slice(from, r.at), w.glyph);
        if (last.page === w.page && last.item === w.item && last.from + last.length === w.offset) last.length++;
        else runs.push({page: w.page, item: w.item, at: r.at + shift, from: w.offset, length: 1});
        shift++;
      }
      from = r.at;
    }
    runs.push({...r, at: r.at + shift});
  }
  parts.push(block.text.slice(from));
  block.text = parts.join("");
  block.runs = runs;
}

interface SavedGroup { members: StoredBlock[]; paragraph: DocumentParagraph }
interface SavedBatch { groups: SavedGroup[] }
interface Revision { batch: SavedBatch; blocks: StoredBlock[]; words: BrokenWord[]; applied: BrokenWord[] }

const EMPTY: PdfTextItem = { str: "", x: 0, y: 0, width: 0, height: 0 };
const BATCH_PAGES = 8;

/** Read consecutive pages once. Keep the unfinished paragraph at the frontier and
 *  discard finished pages' geometry. Saved groups supply both the background score
 *  and the exact same text and source offsets when a page is drawn later. */
export class ReflowScan {
  readonly plan: DocumentParagraph[] = [];
  readonly texts = new Set<string>();
  private readonly batches: SavedBatch[] = [];
  private readonly byPage = new Map<number, SavedGroup[]>();
  private readonly pending = new Map<number, PdfPageText>();
  private readonly unreadPages = new Set<number>();
  private readonly compoundHeads = new Set<string>();
  private readonly hyphenated = new Set<string>();
  private readonly fused = new Set<string>();
  private readonly revisions: Revision[] = [];
  private typography = copyTypography();
  private nextFlush = BATCH_PAGES;
  scanned = 0;
  done = false;

  constructor(readonly total: number) {}

  private headsFor(pages: PdfPageText[]): string[] {
    const relevant = new Set<string>();
    if (!this.compoundHeads.size) return [];
    for (const page of pages) for (const item of page.items) {
      const end = item.str.trimEnd();
      if (!end.endsWith("-") && !end.endsWith("‐") && !end.endsWith("\u00ad")) continue;
      const stem = /\p{L}{2,}$/u.exec(end.slice(-LONGEST_WORD - 2, -1))?.[0].toLowerCase();
      if (stem && this.compoundHeads.has(stem)) relevant.add(stem);
    }
    return [...relevant];
  }

  async add(text: PdfPageText | null, prepare: (pages: PdfPageText[], compoundHeads: readonly string[], typography: ReflowTypography) => ReflowBatch | Promise<ReflowBatch> = prepareBatch): Promise<boolean> {
    const page = text ?? {page: this.scanned + 1, width: 0, height: 0, items: []};
    if (page.page !== this.scanned + 1 || this.done) throw new Error("Expected the next PDF page");
    if (!text) this.unreadPages.add(page.page);
    else this.unreadPages.delete(page.page);
    this.pending.set(page.page, page);
    const final = page.page === this.total;
    if (page.page < this.nextFlush && !final) { this.scanned = page.page; return false; }

    let pages: PdfPageText[], previous: ReflowTypography, batch: ReflowBatch;
    // Drawing a formerly unreadable page can restore it while the worker is busy.
    // Commit only geometry and font measurements that still describe this scan.
    do {
      pages = [...this.pending.values()];
      previous = this.typography;
      batch = await prepare(pages, this.headsFor(pages), previous);
    } while (previous !== this.typography || pages.some((p) => this.pending.get(p.page) !== p));
    this.typography = batch.typography;
    this.scanned = page.page;
    const {blocks, groups} = batch;
    let cut = blocks.length;
    if (!final) {
      const last = blocks.findIndex((b) => b.runs.some((r) => r.page === page.page));
      if (last >= 0) cut = last;
    }
    for (const g of groups) {
      if (g[0]! < cut && g.at(-1)! >= cut) cut = g[0]!;
    }

    this.save(batch, cut);
    if (final) {
      this.pending.clear();
      this.done = true;
      if (this.reconcileSpellings()) this.reindex();
      this.releaseEvidence();
      return true;
    }

    // At a page turn one paragraph (or a group of short ones) can already
    // start on an earlier page. Preserve only its uncommitted runs there, with
    // original PDF.js item indices. Keep the last page whole for its successor.
    const needed = new Map<number, Set<number>>();
    for (let i = cut; i < blocks.length; i++) {
      for (const r of blocks[i]!.runs) {
        if (r.page === page.page) continue;
        let indices = needed.get(r.page);
        if (!indices) needed.set(r.page, indices = new Set());
        indices.add(r.item);
      }
    }
    // The typesetter can paint the hyphen as its own item. A provisional
    // join then has no surviving run for it, but the next batch needs the glyph.
    for (const w of batch.broken) if (w.block >= cut) needed.get(w.page)?.add(w.item);
    for (const [n, p] of this.pending) {
      if (n === page.page) continue;
      const indices = needed.get(n);
      if (!indices) this.pending.delete(n);
      else this.pending.set(n, { ...p, items: p.items.map((it, i) => indices.has(i) ? it : EMPTY) });
    }
    // A single unusually long paragraph may cross a whole batch. Give it more
    // room on each pass so it is not rebuilt quadratically as pages arrive.
    this.nextFlush = this.scanned + Math.max(BATCH_PAGES, this.pending.size);
    return true;
  }

  /** A page the PDF worker could not extract can become readable when drawn. */
  recover(page: PdfPageText): void {
    if (!this.unreadPages.delete(page.page)) return;
    if (this.pending.has(page.page)) {
      this.pending.set(page.page, page);
      return;
    }
    const batch = prepareBatch([page], this.headsFor([page]), {...this.typography, through: page.page - 1});
    batch.typography.through = Math.max(this.typography.through, batch.typography.through);
    this.typography = batch.typography;
    this.save(batch, batch.blocks.length);
    if (this.done) this.reconcileSpellings();
    this.reindex();
    this.releaseEvidence();
  }

  private releaseEvidence(): void {
    if (!this.done || this.unreadPages.size) return;
    this.batches.length = 0;
    this.revisions.length = 0;
    this.fused.clear();
    this.hyphenated.clear();
    this.compoundHeads.clear();
  }

  private index(group: SavedGroup): void {
    const p = group.paragraph;
    p.order = this.plan.length;
    this.plan.push(p);
    this.texts.add(p.text);
    for (const n of p.pages) {
      const groups = this.byPage.get(n);
      if (groups) groups.push(group);
      else this.byPage.set(n, [group]);
    }
  }

  private save({blocks, groups, paragraphs, broken, fused, hyphenated}: ReflowBatch, cut: number): void {
    for (const w of fused) this.fused.add(w);
    for (const w of hyphenated) {
      this.hyphenated.add(w);
      this.compoundHeads.add(w.slice(0, w.indexOf("-")));
    }
    const candidates = broken.filter((w) => w.block < cut);
    // Only a batch with a disputed word can need regrouping. Keep its compact
    // blocks (including short, currently ineligible ones), never its page geometry.
    const saved = candidates.length ? blocks.slice(0, cut).map(pack) : [];
    const batch: SavedBatch = {groups: []};
    for (const [i, g] of groups.entries()) {
      if (g[0]! >= cut) break;
      const p = paragraphs[i];
      if (!p) continue;
      const group = { members: g.map((n) => saved[n] ?? pack(blocks[n]!)), paragraph: p };
      batch.groups.push(group);
      this.index(group);
    }
    this.batches.push(batch);
    if (candidates.length) this.revisions.push({batch, blocks: saved, words: candidates, applied: []});
  }

  /** Reconsider only actual printed line breaks once every available page has
   *  contributed its vocabulary. Keep whole spellings once per document, and
   *  look up only the prefixes needed by those breaks. */
  private reconcileSpellings(): boolean {
    if (!this.revisions.length) return false;
    const requested = new Set<string>();
    for (const revision of this.revisions) for (const word of revision.words) {
      const prefix = continuedPrefix(word);
      if (prefix) requested.add(prefix);
    }
    const starts = new Set<string>(), dictionary = [...this.fused].sort();
    let at = 0;
    for (const prefix of [...requested].sort()) {
      while (at < dictionary.length && dictionary[at]! < prefix) at++;
      if (dictionary[at]?.startsWith(prefix)) starts.add(prefix);
    }
    const vocab = {hyphenated: this.hyphenated, heads: this.compoundHeads, fused: this.fused, starts};
    let changed = false;
    for (const revision of this.revisions) {
      const edits = revision.words.filter((w) => w.kept === fusesWord(w, vocab));
      if (edits.length === revision.applied.length && edits.every((w, i) => w === revision.applied[i])) continue;
      changed = true;
      revision.applied = edits;
      const byBlock = new Map<number, BrokenWord[]>();
      for (const word of edits) {
        const words = byBlock.get(word.block);
        if (words) words.push(word);
        else byBlock.set(word.block, [word]);
      }
      const packed = revision.blocks.slice(), all = packed.map((b) => unpack(b));
      for (const [i, words] of byBlock) {
        correctBreaks(all[i]!, words);
        packed[i] = pack(all[i]!);
      }
      const {groups, paragraphs} = scoringGroups(all);
      revision.batch.groups = groups.map((g, i) => ({members: g.map((n) => packed[n]!), paragraph: paragraphs[i]!}));
    }
    return changed;
  }

  private reindex(): void {
    const ordered = this.batches.flatMap((batch) => batch.groups);
    ordered.sort((a, b) => a.paragraph.pages[0]! - b.paragraph.pages[0]!);
    this.plan.length = 0;
    this.byPage.clear();
    this.texts.clear();
    for (const group of ordered) this.index(group);
  }

  visible(rendered: PdfPageText[]): ReflowBlock[] {
    const drawn = new Set(rendered.map((p) => p.page));
    const groups = new Set<SavedGroup>();
    for (const n of drawn) for (const group of this.byPage.get(n) ?? []) groups.add(group);
    const out: ReflowBlock[] = [];
    for (const group of [...groups].sort((a, b) => a.paragraph.order - b.paragraph.order)) {
      const members = group.members.map((b) => unpack(b, drawn));
      members[0]!.columnBreak = true;
      append(out, members);
    }
    const pending = rendered.flatMap((p) => this.pending.get(p.page) ?? (p.page > this.scanned ? [p] : []));
    if (!pending.length) return out;
    const provisional = reflowRendered(pending, this.headsFor(pending), copyTypography(this.typography));
    if (provisional[0]) provisional[0].columnBreak = true;
    return append(out, provisional);
  }
}
