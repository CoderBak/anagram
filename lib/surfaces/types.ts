// lib/surfaces/types.ts — what a reading surface hands the page's pipeline.
//
// Most pages are read by the walk (lib/dom/walker.ts): their text is laid out as text and
// its markup says where a paragraph ends. A few sites show a document in a way the walk
// cannot read — Google Drive previews a PDF or a Word file as page images with an invisible
// line of text set over every printed line. A SURFACE is the reading of one such site: it
// finds the document on the page, rebuilds its paragraphs, and returns ordinary units whose
// parts are the page's own text nodes, so chips, marks, the panel and the scheduler work on
// them exactly as they do on any page (lib/capture/orchestrator.ts asks it where it would
// have walked). It reads only what the page already shows: no request, no other version.
import type { Unit } from "../types";
import type { MarkPainter } from "../render/highlight";

/** A stretch of a unit's text: offsets into `unit.text`, end exclusive. */
export interface Span {
  start: number;
  end: number;
}

export interface Surface {
  /** Is the document on the page now? While it is not, the page is walked as usual. */
  active(): boolean;
  /** The document's units, by the walker's claim protocol: what a live unit already owns
   *  exactly is left alone, the rest comes back fresh. A surface without it only places
   *  chips, and the page is always walked. */
  collect?(claim: (nodes: Text[]) => "take" | "skip", mergeShorts: boolean): Unit[];
  /** Ranges over the page for stretches of one of its units; undefined for any other unit. */
  ranges(unit: Unit, spans: readonly Span[]): Range[][] | null | undefined;
  /** Put a chip for one of its units (true), fail to (false), or null for any other unit. */
  place(unit: Unit, host: HTMLElement): boolean | null;
  /** Draws its units' marks where the page's own text cannot show a highlight. */
  painter?: MarkPainter;
}
