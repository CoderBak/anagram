# Reading statistics

Anagram can keep a record of how much of what you read reads as AI-generated. It is off until
you choose a level in Settings, Statistics, and everything it keeps stays in this browser
profile, in the extension's own IndexedDB (`anagram-stats`, [footprint.md](footprint.md)).
Anagram never uploads it. A file you export is yours to keep, read, edit or give to somebody,
for instance a research study you take part in.

## What is counted

A paragraph counts as **read** once it has been on screen for a second in all, while its tab
was in front and the page was not being flung past faster than anyone reads. It counts once
per page view, however often you scroll back to it; if it was read before its verdict came, it
counts when the verdict comes. A page view is one document at one address (origin and path):
a site that changes its address without loading a page starts a new view there.

For each paragraph read, its words are added to the four verdicts by the model's
probabilities: a paragraph of 100 words that the model finds 60% likely AI-generated and 40%
likely heavily edited adds 60 words to *AI-generated* and 40 to *heavily edited*. These are
**expected words**, and the shares shown are expected words over the words scored. The
paragraph is also counted once under the word its chip showed (the band whose slice of the
0–1 score contains Σ pᵢ·i/3, cut at 1/6, 1/2 and 5/6), which is not always the most likely
bucket.

Words read that could not be scored are kept apart, by why: **short** (a stretch under your
minimum length, with nothing of its own voice to join), **language** (not English) and
**unavailable** (the engine could not read them; counted when the page view ends without a
verdict). They are never in the four verdicts.

Each reading is filed under the kind of page it was on: `document` (the PDF reader, the Google
Docs overlay, Drive and OneDrive previews, e-book readers), `forum` (a page that declares a
question or a discussion in schema.org, or whose address is a thread's: `/questions/…`,
`/comments/…`, `/thread/…`, `/t/…`), `feed` (a short list of well-known social sites, a page
with `role="feed"`, or five or more posts by different people), `article` (a page that
declares an article, or whose text is mostly in one `<article>` or `<main>`) or `other`
(`lib/stats/pageKind.ts`).

Never recorded, at any level: any text of a page; anything read in a private window; a site
you switched Anagram off for, even a page of it you analyzed from the menu; Analyze text.

## Levels

| Level | Keeps |
| --- | --- |
| Off (default) | nothing |
| Daily totals | per day: the words read, scored and not scored (and why), the expected words and paragraphs per verdict, the same per kind of page, the model and minimum length in force |
| Daily totals and sites | and per site and day: the same numbers. The site is the hostname the tab showed, without `www.`; a PDF opened from this computer has none |
| Every page | and per page and day: the address (origin and path, never the query or the fragment), its title, the minute it was first read that day, the seconds it was shown with somebody reading (two minutes with nothing scrolled, clicked or typed stops the count), its kind, and the same numbers |

A day keeps at most 1,000 sites and 2,000 pages; past them its totals still count. Changing
the level does not delete what was kept: Clear statistics does. Days older than Settings,
Statistics, Keep (30, 90 or 365 days) are deleted, at most once a day.

## The exported file

Export… on the statistics page saves the period shown, at the level it was recorded at or a
coarser one. A coarser file holds nothing of the finer level: exported as daily totals, a
file recorded by page has no site, no address and no count of either. JSON holds everything
below; CSV holds the daily rows only, one line a day with the same numbers.

```json
{
  "schema": "anagram-stats",
  "version": 1,
  "generatedAt": "2026-10-04",
  "extension": { "version": "0.8.2" },
  "model": [{ "id": "pangram/editlens_roberta-large", "ver": "…", "calibration": "…" }],
  "settings": { "minWords": [50], "minWordsNow": 50, "flagFrom": "heavy", "mergeShorts": true },
  "scale": { "bands": ["human", "light", "heavy", "ai"], "cuts": [0.1667, 0.5, 0.8333] },
  "level": { "recorded": "pages", "exported": "daily" },
  "range": { "from": "2026-09-05", "to": "2026-10-04" },
  "words": { "viewed": 10200, "scored": 8400 },
  "expected": [5000, 1500, 724, 1176],
  "units": [40, 10, 6, 9],
  "coverage": { "short": 1200, "language": 500, "unavailable": 100 },
  "days": [{ "date": "2026-10-04", "level": "daily", "words": {}, "expected": [], "units": [], "coverage": {}, "kinds": { "feed": {} } }],
  "sites": [{ "date": "2026-10-04", "site": "example.com", "words": {}, "expected": [], "units": [], "coverage": {} }],
  "pages": [{ "date": "2026-10-04", "start": "09:15", "url": "https://example.com/post", "title": "…", "kind": "article", "dwell": 125, "words": {}, "expected": [], "units": [], "coverage": {} }]
}
```

- `generatedAt` is the day the file was made; days are the browser's local dates.
- `model` lists every model that scored the period; `settings.minWords` every minimum length
  in force (it decides what is too short), `minWordsNow` and `flagFrom` the settings when the
  file was made (the flag level changes nothing in the numbers).
- Every group of numbers has the same shape: `words.viewed` (all words read) and
  `words.scored`; `expected`, the expected words per band in `scale.bands` order, rounded to
  a tenth (they add up to `words.scored`); `units`, paragraphs per band by the word their chip
  showed; `coverage`, the words not scored by why. The top level is the whole period.
- `days[].level` is the finer of what that day was recorded at and the file's level: a day
  recorded by site in the morning and by day in the afternoon has sites that add up to less
  than its totals. `sites` is present only from `"sites"` up, `pages` only at `"pages"`; a
  site or a URL of `""` is a PDF from this computer.

The expected shares are what the model expects of the text; they are not prevalence. A study
estimating how much of what people read is AI-generated can correct `units` (or the expected
words) for the classifier's error rates, for instance with the Rogan–Gladen estimator
p = (p̂ + Sp − 1) / (Se + Sp − 1), taking sensitivity and specificity for the band cut it uses
from an evaluation of the model named in `model`, and should report `coverage`: text that
could not be scored is not in the shares.

The file is plain text and is not signed: whoever has it can edit it. Anything that relies on
it relies on the person who gave it.
