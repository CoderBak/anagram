/** The local static-reading shape used by Docs scenarios and extraction benchmarks.
 * Paragraph markup is authored by the test caller; this is not a live Google snapshot. */
export function docsReadingHtml(paragraphs, version = 1) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refresh fixture v${version} - Google Docs</title>
<style>.doc-content p { margin: 0 0 14px; }</style></head><body><div class="doc-content">
${paragraphs.map((text) => `<p>${text}</p>`).join("")}</div></body></html>`;
}
