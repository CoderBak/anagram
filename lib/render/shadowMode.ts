// lib/render/shadowMode.ts — whether Anagram's own UI in a page is a closed shadow tree.
//
// In a web page the chips and the selection card are CLOSED: the page can neither read what
// they say (a verdict, or that the reader checked a draft of their own) nor rewrite it (a site
// making a chip say "Human"), and nothing of Anagram's reads `host.shadowRoot` (rootOf in
// lib/render/badge.ts). The test build keeps them open for the tests to read; Anagram's own
// pages (the PDF reader), where no page script runs, may as well.
export function chipShadowMode(): ShadowRootMode {
  return import.meta.env.ANAGRAM_TEST_BUILD === "1" || /-extension:$/.test(location.protocol) ? "open" : "closed";
}
