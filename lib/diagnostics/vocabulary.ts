// lib/diagnostics/vocabulary.ts — the words a diagnostics report is allowed to repeat.
//
// A class or an id is written by the page's author, and an author writes what they like:
// `div.author-marla-quillgrove`, `#thread-quillgrove`, `data-testid="quillgrovePanel"`.
// The report exists to describe a page's SHAPE to somebody who will turn it into a
// fixture, and none of that needs a name in it — so the rule is the strictest one that
// still leaves the shape readable: an atom survives only if it is a word we can point at
// in our own source, and every other atom becomes a placeholder of its length (`x10`).
//
// Where the vocabulary comes from, in order of authority:
//
//   1. The tokens and selectors our own detectors test for. If `lib/dom/boilerplate.ts`
//      decides a box is page chrome because it is called `site-nav`, then "site" and "nav"
//      are exactly the words a report has to be able to say — otherwise it cannot explain
//      its own verdict.
//      They are DERIVED from those lists rather than copied, so a token added there turns
//      up here without anybody remembering to.
//   2. The framework markers the orchestrator gates on (below): a page whose root is
//      `#__next` is a page whose chips wait for hydration.
//   3. A short list of structural English — the words layouts are built out of. This one
//      is written by hand because there is nowhere to derive it from; it is deliberately
//      generic, and nothing in it is a name.
import {
  CHROME_TOKEN_PATTERNS,
  MAIN_CONTENT_NAME_RE,
  MEDIAWIKI_FURNITURE_RE,
  REFERENCE_LIST_RE,
  REPLY_FORM_TOKEN_RE,
  SKIP_DESTINATION_RE,
} from "../dom/boilerplate";
import { CONSENT_BANNER_SELECTORS } from "../dom/consentBanners";

/**
 * Frameworks whose pages are still being hydrated when the document is "ready". The
 * orchestrator owns the authoritative list (lib/capture/orchestrator.ts) and gates its
 * insertions on it; this mirror exists so the report can say whether that gate was in play
 * at all, which is the difference between "the chips came late" and "the chips never came".
 * It lives here rather than in ./report.ts because the vocabulary is derived from it too.
 */
export const HYDRATION_MARKERS: [string, string][] = [
  ["#__next", "Next.js (pages router)"],
  ["script#__NEXT_DATA__", "Next.js (__NEXT_DATA__)"],
  ['script[src*="/_next/"]', "Next.js (app router)"],
  ["#__docusaurus", "Docusaurus"],
  ["#___gatsby", "Gatsby"],
  ["#__nuxt", "Nuxt"],
  ["[data-server-rendered]", "Vue SSR / Nuxt 2"],
  ["[data-reactroot]", "React 17 or earlier"],
  ["astro-island", "Astro"],
  ["[data-sveltekit-preload-data]", "SvelteKit"],
  ["[ng-server-context]", "Angular Universal"],
];

/**
 * The words a layout is built out of. Every one of them is a container, a part of a
 * document, a piece of furniture or a state — the kind of word that says where a box sits
 * and nothing about who wrote it or what it says. Longer than "short" for one reason: an
 * atom missing from here is a placeholder in every report, and a structure of placeholders
 * is no longer a structure anybody can read.
 */
const STRUCTURAL = `
  page pages site app root shell layout wrapper wrap container inner outer holder
  main body content contents region section block box panel pane area zone
  column col row grid flex stack group cluster band strip
  header head footer foot top bottom left right center centre middle side sidebar aside
  nav navigation menu submenu toolbar bar breadcrumb breadcrumbs pager pagination
  article post posts story stories entry entries feed timeline stream thread threads
  comment comments reply replies message messages note notes doc docs document
  list listing item items card cards cell tile tiles teaser preview summary excerpt
  snippet quote blockquote figure caption media gallery embed widget module component
  text title subtitle heading label byline author name date time meta tag tags
  category topic badge chip avatar icon image img picture photo thumb thumbnail
  link links button btn action actions control controls form input field select option
  textarea search table thead tbody tfoot
  modal dialog popup tooltip dropdown accordion tab tabs overlay layer portal slot host
  shadow mount view screen window scroll scroller viewport
  first last next prev previous more less show hide toggle open closed close
  active current selected checked disabled hidden visible collapsed expanded
  loading empty error warning success info primary secondary small large wide narrow
  dark light mini full half
  react vue angular svelte ember nuxt astro gatsby docusaurus svelte-kit ssr
  headline published modified publisher organization person creative work review rating
  blog posting news description position element entity profile user account
`;

/** Atoms a pattern or a selector is written out of: its letter runs, nothing else. A
 *  regex fragment like `social[-_]?(?:share|links?)` gives "social", "share", "links". */
function atomsOf(source: string): string[] {
  return (source.match(/[A-Za-z]{2,}/g) ?? []).map((a) => a.toLowerCase());
}

/** Both numbers of a word. The detector lists spell some tokens plural ("articles") and
 *  some singular ("advert"), and a page uses whichever it likes. */
function withBothNumbers(atom: string): string[] {
  if (atom.endsWith("s") && atom.length > 3) return [atom, atom.slice(0, -1)];
  return [atom, `${atom}s`];
}

/** Every atom this build will print verbatim. */
const VOCABULARY: ReadonlySet<string> = new Set(
  [
    ...CHROME_TOKEN_PATTERNS,
    ...CONSENT_BANNER_SELECTORS,
    MAIN_CONTENT_NAME_RE.source,
    MEDIAWIKI_FURNITURE_RE.source,
    REFERENCE_LIST_RE.source,
    REPLY_FORM_TOKEN_RE.source,
    SKIP_DESTINATION_RE.source,
    ...HYDRATION_MARKERS.map(([selector]) => selector),
    // `lib/dom/scope.ts` recognises a byline by an image the site calls an avatar — the one
    // class token it reads, and inline in a regex there, so it is named rather than derived.
    "avatar",
    STRUCTURAL,
  ].flatMap((source) => atomsOf(source).flatMap(withBothNumbers)),
);

/** Is this a word the report may repeat as it stands? */
export function isKnownAtom(atom: string): boolean {
  return VOCABULARY.has(atom.toLowerCase());
}
