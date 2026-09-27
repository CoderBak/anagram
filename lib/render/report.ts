// lib/render/report.ts — rules the copied report follows that are worth stating once.
// The report itself is assembled where the verdicts live (lib/capture/orchestrator.ts).

/**
 * Whether the report may give each flagged paragraph a link that reopens the page at it.
 * A link is the page's address plus words of the paragraph (lib/render/textFragment.ts),
 * so it needs both of the reader's report options on — addresses and passage text — and
 * a page anybody else could open: http or https, not a local file or an extension page.
 */
export function mayLinkParagraphs(o: { includeUrl: boolean; includeText: boolean; pageUrl: string }): boolean {
  if (!o.includeUrl || !o.includeText) return false;
  try {
    return /^https?:$/.test(new URL(o.pageUrl).protocol);
  } catch {
    return false;
  }
}
