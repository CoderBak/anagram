# Reading statistics

Anagram can keep a log of what you read and how much of it reads as AI-generated. It is off
until you choose what to keep in Settings, Statistics, and everything it keeps stays in this
browser profile, in the extension's own IndexedDB (`anagram-stats`, [footprint.md](footprint.md)).
Anagram never uploads it. A file you export is yours to keep, read, edit or give to somebody,
for instance a research study you take part in.

## What is kept

The log is made of rows: visits, the paragraphs of each visit, a visit's events, and totals.
Everything the statistics page shows and every export is worked out from them.

Every field belongs to a **dimension**, and every dimension has a ladder of **layers**, from
the most exact to nothing. A coarser layer can always be made from a finer one, never the other
way. What is kept is one layer per dimension:

| Dimension | Layers, most exact first |
| --- | --- |
| What a row is | every event · every paragraph · every visit · each page per day · each site per day · each kind of page per day · each day |
| Clock times | millisecond · second · minute · quarter hour · hour · day |
| Durations (and offsets from a visit's start) | millisecond · tenth of a second · second · doubling bins (¼ s … 64 s) · none |
| Addresses | full URL · without the fragment · query names without values · origin and path · path pattern (segments with digits or longer than 24 characters as `:id`, slugs as `:slug`) · host · registered domain · none |
| Titles | full · first 60 characters · none |
| Paragraph text | full text · first 12 words · near-duplicate sketch · salted hash · none |
| Lengths | every count (characters, words, model tokens, sentences, rendered lines, the words of each paragraph joined) · words and tokens · words to the nearest 5 · length bands (<50, 50–74, 75–149, 150–299, 300–599, 600+) · none |
| Verdicts | the four probabilities as the engine gives them (4 decimals) · 2 decimals · the chip's word and the most likely band · flagged or not · none |
| Languages | fastText label, its confidence and the writing system · label · English or not · none |
| Page structure | everything (paragraph kind, element, role, landmark, post, thread depth, order, quoted; the page-kind rule's signals) · paragraph kind, post and order · page kind only · none |
| Positions | boxes and every move · box when first seen · place as a share of the page · order only · none |
| Time on screen | every visible-share step · on-screen spells · totals per paragraph · read or not · none |
| Scrolling | every frame · 10 a second · once a second · each scroll (start, end, distance, peak speed) · per visit (depth, distance) · none |
| Input | events and the pointer's track (10 a second) · events with positions · events · counts per minute · idle spells · none |
| Shown and focused | every change · totals per visit · none |
| Tabs and windows | ids, opener, sizes and counts · ids, front and focus · none |
| Navigation | arrival, referrer, the visit before and the opener's · arrival only · none |
| Engine | every detail (engine, backend, precision, cache, timing) · engine and cache · model only |
| Use of Anagram | every use (cards, chips, the menu, jumps, Analyze, sites switched, the reader, the statistics page, exports) · counts per visit · none |
| Device | exact (browser, system and their versions, cores, memory) · families · none |
| What was missed | per visit (paragraphs and words found, and the words left out by why: mostly links, symbols or names, code, a teaser the site cut, the page's navigation and other chrome, hidden; counted, never kept) and time in front of tabs Anagram cannot read · per day · none |

A row holds only what it can: paragraph rows hold no event streams, visit rows no paragraphs,
and so on; Settings makes a choice coarser where the rows chosen cannot hold it, and says so.
Addresses and titles can also be kept as **salted hashes**: counted and told apart, but not
named. Hashes and sketches are made with a random key kept in the extension's storage, never
exported, and made anew when the statistics are cleared.

Presets: **Daily totals**, **Daily totals and sites**, **Every page** (the three that keep no
paragraph), **Every paragraph** (visits and paragraphs, no address, no text), **Research study**
(an event log at tenths of a second, domains, sketches, no text), **Full reading trace** (all
but the text) and **Full trace with text**. Settings shows each one's layers, field by field.

How long each part is kept: the fine trace (events) 7, 30 or 90 days; visits and paragraphs
30, 90 or 365 days; the totals a year, or until cleared. Retention runs at most once a day.

**Never kept, at any choice:** anything in a private window; a site you switched Anagram off
for, even a page of it you analyzed from the menu; Analyze text; what is typed or which key
(only whether it was a reading key, typing or a shortcut); the contents of form fields; what is
selected or copied (only how many characters); the address or title of a page Anagram cannot
read.

## What counts as read

The recorder (lib/stats/recorder.ts) keeps each paragraph's time on screen three ways: any part
of it on screen; at least half of it (or, for a paragraph taller than the window, any of it);
any part in the middle 80% of the viewport. Each is kept as four numbers, in milliseconds while
the page was shown: all of it, in a focused window, while the page was flung past (two screens a
second or faster), and both.

**The default rule**, which the totals and the toolbar menu use: a paragraph is read after one
second with some of it in the middle 80%, not counting time flung past, and counts once per
visit. A visit is one document at one address; a route change within a single-page site starts
another, filed under its own address. A paragraph read before its verdict counts when the
verdict comes; one still without a verdict when the visit ends counts as *unavailable*; one the
page took away before its verdict counts as *removed*.

On the statistics page, **How it counts** applies any other rule to what was kept at paragraph
rows or finer: another time (¼ s to 30 s), half visible or any of it, a focused window only,
time flung past or not, once per visit, per day or ever (by the text's hash), shares from
expected words, the chip's word or the most likely band, each paragraph weighing its words, one
or its seconds on screen, the headline AI-generated or heavily edited and AI-generated, and a
floor of 50, 75, 100 or 150 words (above 50 an approximation: a joined group of 50–74 words
would have kept joining under a real floor of 75). Totals hold the default rule alone.

For each paragraph read, its words are added to the four verdicts by the model's probabilities:
a paragraph of 100 words the model finds 60% likely AI-generated and 40% heavily edited adds 60
words to *AI-generated* and 40 to *heavily edited*. These are **expected words**, and the shares
are expected words over the words scored. The paragraph is also counted once under the word its
chip showed (the band whose slice of the score Σ pᵢ·i/3 it falls in, cut at 1/6, 1/2 and 5/6)
and once under its most likely band. Words read that could not be scored are kept apart, by why:
**short** (under 50 words, with nothing of its own voice to join), **language** (not English),
**unavailable** and **removed**.

Each visit is filed under the kind of page it was, decided once, with its first paragraph read:
`document` (the PDF reader, the Google Docs view, Drive and OneDrive previews, e-book readers),
`forum` (a page that declares a question or a discussion in schema.org, names forum software in
its generator meta, is on a `forum.`, `forums.`, `community.` or `discuss.` host, or whose
address, query included, is a thread's: `/questions/…`, `/comments/…`, `/thread(s)/…`,
`/discussions/…`, `/t/…`, `/forum(s)/…`, `viewtopic.php`, `?topic=`, Hacker News' `item`), `feed`
(a short list of social sites, a page with `role="feed"`, or one where five or more posts hold
more than half of the first 64 paragraphs found and none of them two-fifths of the words),
`article` (a page that declares an article in schema.org, including TechArticle, or in og:type
with a body of text of 150 words; or where 60% of the words of those paragraphs stand in one
post, or, with at most one post, in `<main>` with a body of text; or one element holding 300 words
of them as its children) or `other` (anything else; a page that says it is a product is never an
article) (lib/stats/pageKind.ts). On the web benchmark's pages labelled article, forum or other,
this files 80% of the held-out pages right (it filed 65%; 2026-10-09); there were no real feeds to
check it on. Where page structure is kept in full, the signals the rule looked at are kept with
the visit, so the rule can be checked or another applied afterwards.

A visit is filed under the day it began, and what it read under the day the worker heard of it,
by the browser's clock, so a visit over midnight counts on both days.

## The exported file

**Export…** on the statistics page saves the period shown with each dimension at the layer
chosen, never finer than what was kept, and shows the file's tables, rows and size before it
saves. Formats: JSON (`.json`, or compressed `.json.gz`), or CSV, a file per table plus
`manifest.json`, in a `.zip`.

Every id and hash in the file (visits, tabs, windows, texts, hashed addresses and titles) is
keyed again for the file, and sketches are masked likewise: by default with a key of that file
alone, so two files cannot be joined by them; or, if you choose, with a key the same for every
file from this browser profile, so a study can join one person's files.

```json
{
  "manifest": {
    "schema": "anagram-stats", "version": 1, "generatedAt": "2026-10-05T10:00:00.000Z",
    "extension": { "version": "0.9.0" }, "range": { "from": "2026-10-01", "to": "2026-10-05" },
    "layers": { "rows": "event", "time": "s", "place": "domain", "text": "sketch", "…": "…" },
    "hashed": [], "link": "file",
    "lens": { "readMs": 1000, "visibility": "band", "once": "visit", "estimator": "expected", "…": "…" },
    "recorded": [{ "layers": {}, "hashed": [], "retention": {} }],
    "scale": { "bands": ["human", "light", "heavy", "ai"], "cuts": [0.1667, 0.5, 0.8333] },
    "names": { "input": ["pointerdown", "…"], "state": ["shown", "…"], "ui": ["card", "…"], "arrival": ["link", "…"] },
    "rows": { "visits": 12, "units": 340, "intervals": 910, "totals": 14 },
    "dictionary": { "visits": { "description": "…", "columns": [{ "column": "start", "dimension": "time", "description": "…" }] } }
  },
  "tables": {
    "visits": { "columns": ["id", "date", "start", "…"], "rows": [["3f9c…", "2026-10-05", 1791180000000, "…"]] },
    "units": { "columns": ["visit", "n", "status", "…"], "rows": [] }
  }
}
```

Each table is a list of columns and rows of values in that order; a nested field is a dotted
column (`expo.band`), an exposure four milliseconds `[all, focused, flung, both]`. The tables a
file can hold, each present only where its dimension's layer keeps it:

- `visits`, `units`: one per visit, one per paragraph of a visit.
- `steps`, `intervals`: what was on screen, step by step or spell by spell.
- `scroll`, `episodes`, `input`, `state`, `ui`, `geom`: a visit's event streams; their kinds are
  numbers into `manifest.names`.
- `tabs`: window and tab events, uncovered time, uses of Anagram's own pages.
- `context`: what the log was recorded under, a row each time it changed.
- `texts`: each paragraph's text by its hash (Full trace with text).
- `totals`: per day, kind, site and page, by the default rule.
- `lens`: the paragraphs of the file added up by day and kind of page under `manifest.lens`.

`manifest.dictionary` says what every table and column of the file is (lib/stats/dictionary.ts).

## For a study

The expected shares are what the model expects of the text; they are not prevalence. A study
estimating how much of what people read is AI-generated can correct the paragraph counts (by
chip word or most likely band) or the expected words for the classifier's error rates, for
instance with the Rogan–Gladen estimator p = (p̂ + Sp − 1) / (Se + Sp − 1), taking sensitivity
and specificity for the band cut it uses from an evaluation of the model in `context.model`.
It should report: the model, its version and calibration; the minimum length (50 words, short
paragraphs of one voice joined); the rule for read (time, visibility, focus, flinging), counted
once per what; the estimator; the coverage (short, language, unavailable, removed, and the time
in front of tabs Anagram cannot read); the local-day definition; and each participant's layers
(`manifest.recorded`) and granted sites. Exposure is not attention: nothing here says where the
eyes were.

The file is plain text and is not signed: whoever has it can edit it. Anything that relies on
it relies on the person who gave it.
