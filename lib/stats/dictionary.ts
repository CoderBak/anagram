// lib/stats/dictionary.ts — what every table and column of an exported file is, and which
// dimension's layer decided it (lib/stats/config.ts). Every file carries the entries for what it
// holds, so it explains itself; docs/statistics.md says the same for people.
//
// A column named with a dot is a field of a field ("expo.band"); an exposure is four
// milliseconds: [all of it, in a focused window, while flung past, both]. Times are epoch
// milliseconds, offsets milliseconds from the visit's start, both as fine as TIME and DUR let.

export interface Column { column: string; dimension: string | null; description: string }

export const TABLES: Record<string, { description: string; columns: Column[] }> = {
  visits: {
    description: "One document at one address: a page, a frame of one, a route of a single-page site, a document in the PDF reader.",
    columns: [
      { column: "id", dimension: null, description: "The visit, by an id of this file's." },
      { column: "date", dimension: "time", description: "The local day it began on." },
      { column: "start", dimension: "time", description: "When it began (epoch ms)." },
      { column: "end", dimension: "time", description: "When it ended (epoch ms)." },
      { column: "ended", dimension: null, description: "Why: navigated, closed, route (another route of the page), hidden, stopped (statistics turned off, or Anagram stopped reading the page)." },
      { column: "frame", dimension: null, description: "top, or a frame within a page." },
      { column: "parent", dimension: "nav", description: "For a frame, the visit of the page it was in." },
      { column: "tab", dimension: "tabs", description: "The tab, by an id of this browser session's." },
      { column: "window", dimension: "tabs", description: "The window, likewise." },
      { column: "url", dimension: "place", description: "The address at PLACE's layer (a salted hash where hashed)." },
      { column: "site", dimension: "place", description: "Its host, or the domain it is registered under (a salted hash where hashed)." },
      { column: "title", dimension: "title", description: "The tab's title (a salted hash where hashed)." },
      { column: "kind", dimension: "struct", description: "feed, article, forum, document or other (lib/stats/pageKind.ts)." },
      { column: "signals", dimension: "struct", description: "What the page-kind rule looked at: a feed host, role=feed, a thread's address, a declared kind, posts among the first 64 paragraphs, the share of words in the largest post and in <main>; and, since 2026-10-10, forum software or a forum's host, an article declared in og:type alone, a product, and the words of the largest body of text." },
      { column: "surface", dimension: null, description: "web, pdf (the PDF reader), docs (the Google Docs view), drive, pdfjs, kindle or webnovel." },
      { column: "arrival", dimension: "nav", description: "How it was arrived at: link, typed, bookmark, reload, history (back or forward), form, redirect, generated, restored (from the back-forward cache), route, other." },
      { column: "referrer", dimension: "nav", description: "The page it came from, at PLACE's layer." },
      { column: "previous", dimension: "nav", description: "The visit before it in the same tab." },
      { column: "opener", dimension: "nav", description: "The visit the tab that opened this one's showed." },
      { column: "shown", dimension: "state", description: "Milliseconds the page was shown (not a hidden tab)." },
      { column: "active", dimension: "state", description: "…of them with input within the last two minutes." },
      { column: "focused", dimension: "state", description: "…of them in a focused window." },
      { column: "height", dimension: "geom", description: "The page's height and width in CSS pixels." },
      { column: "found", dimension: "cover", description: "Paragraphs and words the reader found on the page, read or not." },
      { column: "leftOut", dimension: "cover", description: "Words the reader left out, by why: links (runs mostly of links), symbols, names, code, teaser (cut by the site), chrome (navigation, header and footer, consent banners), hidden. Counted, never kept." },
      { column: "display", dimension: null, description: "What the person saw: which chips, which underlines, the word paragraphs are flagged from." },
      { column: "model", dimension: "engine", description: "The model that scored the visit: id, version and calibration." },
      { column: "engine", dimension: "engine", description: "Which engine (native, inbrowser), its backend and precision." },
      { column: "scroll", dimension: "scroll", description: "How far down the page was scrolled (share of its height) and how far in all (pixels)." },
      { column: "idle", dimension: "input", description: "Spells of two minutes or more without input: [from, to] offsets." },
      { column: "minutes", dimension: "input", description: "Input per minute of the visit: pointer, key, wheel and touch counts." },
      { column: "ui", dimension: "ui", description: "Uses of Anagram's chips and cards on the page, by kind." },
      { column: "pdf", dimension: null, description: "For the PDF reader: pages, which reader (Zotero's structure or the reflow), pages drawn." },
      { column: "tally", dimension: null, description: "What was read in the visit by the default rule: words scored; expected words per band (human, lightly edited, heavily edited, AI-generated); paragraphs per band by chip word and by most likely band; words not scored by why." },
    ],
  },
  units: {
    description: "One paragraph of a visit, read or not: as the reader found it, its verdict, and its time on screen.",
    columns: [
      { column: "visit", dimension: null, description: "The visit it belongs to." },
      { column: "n", dimension: null, description: "Its order of finding in the visit, from 0." },
      { column: "status", dimension: null, description: "scored, short (under 50 words with nothing of its voice to join), language (not English), unavailable (no verdict by the visit's end), removed (taken off the page before its verdict), pending." },
      { column: "hash", dimension: "text", description: "A salted hash of its text: the same text has the same hash within this file." },
      { column: "sketch", dimension: "text", description: "A salted near-duplicate sketch: the share of its 32 slots two paragraphs share estimates how alike their texts are." },
      { column: "head", dimension: "text", description: "Its first twelve words." },
      { column: "len", dimension: "len", description: "Characters, words, model tokens, sentences, rendered lines, the words of each paragraph joined into it, formulas left out; or its length band." },
      { column: "lang", dimension: "lang", description: "The language detected (fastText), its confidence and the writing system." },
      { column: "struct", dimension: "struct", description: "What kind of paragraph (paragraph, post, joined, pdf, docs, surface), its element, role and landmark, the post it is in and how deep in a thread, its order on the page, whether quoted." },
      { column: "geom", dimension: "geom", description: "Its box on the page when first seen (CSS pixels from the page's top left), its place as a share of the page's height, its PDF page." },
      { column: "verdict", dimension: "verdict", description: "The four probabilities (human, lightly edited, heavily edited, AI-generated), the score, the chip's word and the most likely band (0–3), whether flagged, whether under 75 words." },
      { column: "timing", dimension: "engine", description: "Whether its verdict came from the cache, and when it came." },
      { column: "expo", dimension: "expo", description: "Time on screen, as exposures: any part of it, at least half of it (or any of a paragraph taller than the screen), any part in the middle 80% of the viewport; when it was first and last on screen, how often it came on screen, when it counted as read by the default rule." },
      { column: "found", dimension: "dur", description: "When it was found (offset)." },
      { column: "removedAt", dimension: "dur", description: "When the page took it away (offset)." },
    ],
  },
  steps: { description: "Every step of how much of a paragraph was on screen (EXPO steps).", columns: [
    { column: "obs", dimension: "expo", description: "0: the whole viewport; 1: its middle 80%." },
    { column: "ratio", dimension: "expo", description: "The share of the paragraph within it." },
    { column: "top", dimension: "expo", description: "The paragraph's top edge relative to the viewport, and its height (CSS pixels)." },
  ] },
  intervals: { description: "Each spell a paragraph was on screen (kind 0) or in the middle band (kind 1), with its peak share.", columns: [] },
  scroll: { description: "Scroll positions: box 0 is the page, another number a box within it that scrolled; with the viewport's and the page's size.", columns: [] },
  episodes: { description: "Scrolls: start, end, distance (pixels) and peak speed (pixels a second).", columns: [] },
  input: { description: "Input events by kind (manifest.names.input); the pointer's position where kept (-1 where not); for select and copy, how many characters (never what).", columns: [] },
  state: { description: "The page shown or hidden, the window focused or not, the page frozen, resumed or restored, flung past or settled (manifest.names.state).", columns: [] },
  ui: { description: "Uses of Anagram's chips and cards (manifest.names.ui), and the paragraph each was about.", columns: [] },
  geom: { description: "A paragraph's box after the page's layout moved it.", columns: [] },
  tabs: { description: "Windows and tabs: opened, in front, closed, focused; time in front of a tab Anagram cannot read (uncovered, ms); uses of Anagram's toolbar menu and pages (ui).", columns: [] },
  context: { description: "What the log was recorded under, a row each time it changed: the extension, browser, system and device; the model and engine; the settings that shape what is read and shown; the recording's layers and retention.", columns: [] },
  texts: { description: "The text of each paragraph, by its hash (TEXT full).", columns: [] },
  totals: { description: "The totals the extension kept by the default rule: per day, per kind of page, per site and per page.", columns: [] },
  lens: { description: "The paragraphs of this file added up by day and kind of page under the lens in manifest.lens.", columns: [] },
};
