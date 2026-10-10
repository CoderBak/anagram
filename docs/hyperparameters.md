# Anagram's hyperparameters

This is an inventory of every value in Anagram that someone chose and that changes what Anagram reads, scores, shows, records or costs: thresholds, limits, timings, cut-offs and defaults. It covers 696 of them. Each row gives the value, where it is set, what it controls, what it rests on, and what moving it would do.

**Snapshot:** every row was read from the code on `dev` at a998acc (2026-10-05), checked again on 2026-10-09 against `dev` at f74740a, and the rows changed since were brought up to date on 2026-10-10. The code is the authority, and line numbers will drift.

**Not covered:** enumerations, message keys and cosmetic styling, and the tests, apart from the performance budgets.

**Contents**

- [How to read the tables](#how-to-read-the-tables)
- [At a glance](#at-a-glance)
- [What matters most](#what-matters-most)
- [Problems found while surveying](#problems-found-while-surveying)
- [Overfitting risk](#overfitting-risk)
- [Recommendations](#recommendations)
- [Performance budgets: headroom on 2026-10-10](#performance-budgets-headroom-on-2026-10-10)
- Areas:
  1. [The web-page reader](#area-1-the-web-page-reader)
  2. [Scheduling and rendering on web pages](#area-2-scheduling-and-rendering-on-web-pages)
  3. [Model, scoring and engines](#area-3-model-scoring-and-engines)
  4. [The PDF reader](#area-4-the-pdf-reader)
  5. [Statistics, settings, site access and diagnostics](#area-5-statistics-settings-site-access-and-diagnostics)

## How to read the tables

Every table has the same columns: **Parameter**, **Value**, **Where** (`path:line`), **Controls**, **Basis** and **Notes**. Notes say what raising or lowering the value would do, whether a user can change it, whether it moves what the statistics count, and any inconsistency.

**Basis** is one of:

| Basis | Meaning |
|---|---|
| Measured | A measurement in a comment, the docs or a commit backs the value. |
| Platform | Set by a browser, operating system, standard or library limit. |
| Model | Set by the EditLens model or its tokenizer. |
| Convention | A common default, or taken from an established tool such as Readability, trafilatura, talon or autoconsent. |
| Safety | A bound against hostile input or running out of memory or time. |
| Judgement | Chosen by hand; no measurement was found. |
| Fitted | Tuned until a test, a fixture or one split of a benchmark passed. These carry an overfitting risk. |

Five separate surveys assigned the bases, so they are not perfectly uniform:

- The web-page reader's rules were tuned on the web benchmark and checked on its held-out split. They are mostly marked **Measured**.
- The PDF reader's rules were tuned on the PDF benchmark's development split. They are marked **Fitted** whether or not their test-split numbers were reported. Its section says which were.

**What a user can change.** Only these values are settings:

| Setting | Default |
|---|---|
| Flag from | heavily edited |
| Underlines | flagged paragraphs |
| Chips shown | all |
| Statistics | off (a preset, or a layer per dimension) |
| Retention | fine trace 7 days, visits and paragraphs 90 days, totals until cleared |
| Idle unload | 5 min |
| Cache | persistent, 30 days |
| Open PDFs in the reader | off |
| PDF read-ahead | on |
| PDF structure | on (no UI) |
| Engine and precision | — |

Everything else is fixed in the code.

## At a glance

| Area | Rows | Measured | Platform | Model | Convention | Safety | Judgement | Fitted |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Web-page reader | 155 | 25 | 6 | 1 | 20 | 16 | 86 | 1 |
| Scheduling and rendering | 134 | 29 | 3 | 3 | 1 | 15 | 81 | 2 |
| Model, scoring and engines | 130 | 9 | 4 | 16 | 7 | 21 | 73 | 0 |
| PDF reader | 163 | 6 | 5 | 0 | 28 | 5 | 87 | 32 |
| Statistics, settings and access | 114 | 0 | 3 | 3 | 3 | 21 | 84 | 0 |
| **All** | **696** | **69** | **21** | **23** | **59** | **78** | **411** | **35** |

**Most values rest on judgement alone.** That is 59% of the 696. One in ten is backed by a measurement and one in twenty is fitted.

**Most judgement values are harmless.** They are poll intervals, timeouts, display caps and retry waits.

**A minority decide what is read and counted.** Those are the ones collected below. None of the statistics' own values is measured.

## What matters most

### For the reading statistics

The headline "share AI-generated" is the sum over paragraphs read and scored of words × p(AI-generated), divided by the words scored, under the default rule (`DEFAULT_LENS`). Totals, visits and the toolbar menu hold that rule alone. The statistics page's **How it counts** applies another to what was kept at paragraph rows or finer.

**What moves it, in order:**

1. **The minimum length** (`MIN_WORDS`, 50, fixed since 2026-10-05; short paragraphs of one voice are always grouped). It chooses the population.
   - Text under the floor counts as "short" and leaves the denominator. That removes most short feed posts.
   - Verdicts on 50–74 words enter the share, although that is under the model's 75-word training minimum. Only paragraph rows mark them (`verdict.doubt`).
   - A lens can raise the floor to 75, 100 or 150 afterwards, approximately. Nothing can lower it.
2. **The estimand:** the expected share of the AI-generated band, weighted by words.
   - It equals the true prevalence only where the model's probabilities are calibrated for this reading.
   - It leaves out heavily edited text, although flagging includes it by default.
   - Long texts dominate it.
   - A lens can count paragraphs under the chip's word or the most likely band instead, weigh paragraphs or time, or add heavily edited.
3. **What "read" means**, by default.
   - A paragraph counts after 1 s in all with some of it in the middle 80% of the viewport. Any overlap counts.
   - Only time while the page is shown counts, less any time it was flung past at 2 or more screens a second. That fling rule is the scheduler's.
   - It counts once per visit: one document at one origin and path.
   - This measures exposure, not attention.
4. **What is never seen.** None of the following reaches the numerator or the denominator. Only text that isn't English is still counted, as "language". The `cover` layer adds each visit's paragraphs and words found and the time in front of tabs Anagram cannot read, but none of the rest:
   - text the reader drops: runs over 0.7 link share or 0.2 symbol share, name lists, 63 chrome class patterns, teasers and cut previews;
   - frames under 40,000 px² or 200 px wide;
   - text that isn't English (fastText top-1, at any confidence);
   - private windows, sites switched off and Analyze text;
   - PDFs outside the reader;
   - text the PDF structure path leaves out: captions, code and quoted prompts, contents, author lists.
5. **Engine latency.**
   - A paragraph read before its verdict counts when the verdict comes. One still unscored when the visit ends counts as "unavailable"; one the page removed first, as "removed".
   - These all move words between scored and unavailable:
     - the 30 s request timeout, counted from the request's turn in the engine;
     - 4 batches in flight per page, against engines that score one batch at a time;
     - the background pace;
     - the cache.
6. **Page kinds** (feeds against the rest).
   - The rules: a forum is declared (schema.org QAPage or DiscussionForumPosting), named in the generator meta, on a `forum.`, `community.` or `discuss.` host, or at a thread's address. A feed is one of 14 feed hosts, `role="feed"`, or 5 or more posts holding most of the first 64 paragraphs with none holding 40% of the words. An article is declared (og:type article alone needs a 150-word body), has 60% or more of the words in one post or in `<main>` with a 300-word body, or has such a body at all. A product page is other.
   - Checked on the web benchmark's labelled pages (2026-10-09): 0.80 of the held-out pages and 0.81 of the dev pages filed right, against 0.65 and 0.68 before. No real feeds were in the sample. Where page structure is kept in full, each visit keeps the rule's signals, so another rule can be tried afterwards.

**The binding constraint for a study.** Another rule can be applied afterwards only to what was recorded at paragraph rows or finer (the **Every paragraph**, **Research study**, **Full reading trace** and **Full trace with text** presets), and never below 50 words or without the grouping. Daily, site and page totals hold the default rule alone. A study therefore has to record every participant at paragraph rows or finer, or accept the default rule, and read each participant's layers from `manifest.recorded`.

The estimators an export can compare are the expected share and the paragraph counts by chip word (`units`) and by most likely band (`argmax`).

**A paper should report:**

- the model id, version and calibration;
- the minimum length (50 words, short paragraphs of one voice joined);
- the rule for "read" (time, visibility, focus, fling) and what it counts once per;
- the estimand;
- the coverage breakdown (short, language, unavailable, removed, time on tabs Anagram cannot read);
- the local-day definition;
- each participant's layers and granted sites.

### For what a reader sees

- **The verdict cuts** (`SCORE_CUTS`: 1/6, 1/2, 5/6) set every word, colour and underline.
  - They come from EditLens's equal-bucket decoding, not from calibration on web text.
  - The statistics use the probabilities, so the cuts do not move them.
- **Flag from** (default: heavily edited) sets the flagged count, the toolbar badge, the list and the underlines.
- **The post rule.** A post that fits one model window (`WINDOW_CHARS`: 1,800 characters, about 300 English words) gets one verdict. An article gets one per paragraph.
- **Time to the first chip** depends on:
  - one-paragraph batches on screen (0.27 s instead of 0.69 s), and on a processor;
  - the hydration gate, up to 2.5 s on framework sites;
  - the 250 ms drain debounce;
  - drain spacing, up to 5 s on expensive live pages.
- **How far ahead chips are ready:**
  - `ROOT_MARGIN`, 1,200 px, never measured;
  - the background pace (`DUTY`; `SESSION_MS`, 10 minutes; `LOW_BATTERY`, 20%), after which the rest of a long page or document stays pending;
  - in the PDF reader, `SLOW_SCOPE`: 2 pages behind, 6 ahead.

### For what Anagram costs a page

These values hold Anagram's cost on a page:

- `SLICE_MS`: 8 ms;
- `MOST_NODES_UNPAUSED`: 4,096;
- `DRAIN_COST_SPACING`: 19, i.e. at most 1/20 of the main thread;
- `DRAIN_MAX_SPACING_MS`: 5 s;
- `MAX_SCAN_ROOTS`: 10;
- `NEAR_MARGIN`: one screen;
- no chip animation.

The budgets in `test/pw/perf.spec.mjs` guard them. Their headroom is [below](#performance-budgets-headroom-on-2026-10-10).

### For the PDF reader

The PDF reader has two readers: Zotero's structure, or the reflow of the pages drawn. Which one runs depends on:

- the page count, against `autoStructurePages`: 300, 600 or 2,500 pages by device memory. Firefox and Safari always get 300.
- `MOST_STRUCTURE_PAGES`: 2,500;
- the structure deadline: 20 s + 250 ms per page, set on one M4. When it expires, the reflow is kept without notice.

The two readers read different text, captions and front matter for instance. So verdicts and counted words change with page count, memory and browser.

## Problems found while surveying

These are places where behaviour, comments or docs disagree with what was intended. What has been fixed since 2026-10-05 has been taken out. "Verified" means the claim was checked against the code a second time.

### Values that must change together but are written separately

- **The reading log's default rule:** the recorder's `BAND_MARGIN` (`-10% 0px -10% 0px`) is what `visibility: "band"` in `DEFAULT_LENS` means; nothing ties the two. Its `READ_MS` is `DEFAULT_LENS.readMs`.

Since 2026-10-10 the other values that were written twice come from one place: the place-retry wait (`PLACE_WAIT_MS + 100`), the page-kind sample (`KIND_SAMPLE`), the chip width (`CHIP_PX`), `COVERED_MS` (`HEARTBEAT_MS + 10 s`), the 200,000-character text cap (`MAX_UNIT_TEXT_CHARS`, used by the reading log's schema and the paste page), the engine's request limits, the idle-unload range and the language-ID pin (`anagramd/contract.json`), the tier download sizes (summed from `modelkit.json`), the embedding size (`EMBEDDING_BYTES` in `lib/device.ts`), the idle choices (`IDLE_CHOICES`), the walker's link, symbol and marker thresholds (shared with the diagnostics), the PDF reader's `SPACE_GAP`, `PARA_GAP`, `INDENT`, `SHORT_LINE`, `EDGE_PERCENTILE` and `PITCH_OF_SIZE` (exported by the reflow), the 50 MiB PDF cap (`MAX_HANDOFF_BYTES` is `SOURCE_CAP`), the diagnostics' settings defaults (the storage items' own fallbacks), and the public suffixes (`PUBLIC_SUFFIXES`).

### Same purpose, different value

"Smaller than body" has five thresholds in the PDF reader: 0.75, 0.79, 0.8, 0.92 and 0.95. Each was set for its own decision (a superscript, a display font, a running head, a footnote, a caption) and none was swept.

The two year patterns and the two caption patterns have been renamed after what they find: `CITED_YEAR_RE` (1500–2099, with a letter after it, in the walker), `MOMENT_YEAR_RE` (1900–2099, in a moment's title, in `scope.ts`), `CAPTION_START` (the reflow's aside rule) and `CAPTION_LABEL` (the structured path's skip rule).

### Policies that differ between the engines

- **Disk margins:** 200 MB for the tier check, none for the automatic download, 64 MiB per file for the local engine.
- **Download retries:** the browser waits 2, 5 and 15 s over 4 attempts; the local engine 1 and 2 s over 3 attempts.
- **Waiting for a loading model:** the local engine waits 25 s, the browser engine 285 s.
- **Download time left:** the toolbar menu estimates over a 20 s window, because it sees whole percents (about 14 MB each), and the setup page over 8 s of bytes.

Background batches no longer differ: a web page's 6,000-character batches are cut by the pace the router measures (`BATCH_TARGET_MS`), as the PDF reader's pacer cuts its own.

## Overfitting risk

**Web-page reader.**

- Most site-specific rules were checked on the web benchmark's held-out split.
- Four have no such check: `THREAD_LEVELS` (3, the depths of V2EX and HN plus one), `LAYOUT_WRAPPER_HOPS`, `EDGE_CHARS` and `ONE_LINE_BOX_LEVELS`.

**PDF reader.**

- About twenty rules of the structure path were tuned on the PDF benchmark's dev split:
  - captions, table notes, affiliations and author lists;
  - code and quoted prompts;
  - contents and bibliography;
  - reading-order slack;
  - folded line numbers and ragged manuscripts;
  - scripts and citation marks.
- Their test split was reported on 2026-10-10 (run `truthfix`). Coverage held: 95.7% of the words scored on test against 96.2% on dev. Leakage is 4.6% of the scored tokens on test against 3.3% on dev, the difference spread thinly over kinds: text not in the truth 2.2% against 1.8%, captions 0.4% against 0.1%, references 0.3% against 0.1%, figure text 0.6% against 0.5%. No one rule fails on test. (A first report showed 6.0%: one Word-made paper's tagged truth called its body "references" from a table's "References" column header on page 10 on. `test/pdf-bench/tagged.mjs` no longer opens a reference list inside a table.)
- Some rest on thin evidence:
  - the line-number family: 18 manuscripts, 7 of them tagged;
  - `FOLDED_MIN`: 4 manuscripts;
  - `HEADLINE_SHARED` and `ORDER_SLACK`: one or two pages;
  - `STRETCH_BANDS`: one page, kept although olmOCR's test score fell from 441 to 433.
- `HYPHEN_MEASURE` was changed to make a unit test pass.

**Performance.**

- `LAYOUTS_PER_CHIP` (1.6) sits between two variants measured on one fixture.
- Budget G's 8% was set just above one machine's values; it measured 7.7% on 2026-10-05 and 5.8–7.4% on 2026-10-10, and swings with the plain browser's run.
- `DRAIN_COST_SPACING` and `MAX_SCAN_ROOTS` each rest on one fixture page.

## Recommendations

1. **For the study.**
   - Record every participant at paragraph rows or finer, so that another rule for "read" can be applied afterwards.
   - Report the definitions listed under [For the reading statistics](#for-the-reading-statistics).
   - The page-kind rules were checked on the web benchmark's labelled articles, forums and other pages (0.80 held out). Check feeds on a labelled sample of real feeds before comparing feeds with the rest; the benchmark has none.
2. **Settle the minimum length on evidence.**
   - 0.7.0 raised it to 75 because "at 50 words a quarter of human texts read as AI-edited".
   - 0.8.0 made it a setting, 50 by default, to match Pangram's product; since 2026-10-05 it is fixed at 50.
   - Measure false positives on human web text at 50 and at 75.
3. **What the sweeps settled (2026-10-09, web benchmark dev split, 2,345 pages).** Each threshold was moved both ways against the shipped value, and none moved F1 by more than 0.002 (0.8457 shipped):
   - `MAX_LINK_RATIO`: 0.5 to 1.0. 0.7 gains recall for no precision (F1 0.8464) and is shipped; 1.0 lets link lists in (precision 0.920, leakage 6.2%).
   - the symbol share (0.15 to 0.4), the name-list thresholds (caps, commas, tokens, or off), the short-run merge (6 to 10), the line and sentence counts: all within 0.002.
   - `SCRIPT_SHARE` (0.6 to 0.8) changes nothing, because the corpus is Latin script; it needs a corpus in other scripts.
   - The language gate (fastText's top-1 at any confidence) was measured on the same pages: of 23,314 English paragraphs, 0.20% got a non-English guess and none of them was English prose, while a minimum confidence of 0.5 would score 10.7% more of the non-English Latin-script paragraphs. It stays. Batch size against a slow engine is now set by the pace the router measures.
4. **Still open:** sweep the PDF reflow core on the dev split; label real feeds for the page kinds; a corpus in other scripts for `SCRIPT_SHARE`; the minimum length's false positives at 50 and 75 words.

## Performance budgets: headroom on 2026-10-10

**Setup:** the `dev` branch with this file's changes, on an M4 (load average 2–6, other work running), with `npx playwright test --project perf --no-deps`. All budgets passed. The reading-log column ran F to J again with `ANAGRAM_PERF_STATS=full`, the heaviest preset.

**Sources:** the limits are in `test/pw/perf.spec.mjs`. [Area 2](#performance-budgets) explains each budget.

| Budget | Limit | 2026-10-10 | Reading log on (full) | 2026-10-05 | Headroom |
|---|---|---|---|---|---|
| A: first badge (3,000 paragraphs) | < 4,000 ms | 305 ms | — | 297 ms | Wide |
| A: worst startup long task | < 1,000 ms | 93 ms | — | 91 ms | Wide |
| A: badges after 10 screens | ≥ 60 | 121 | — | 150 | Wide, fixture-bound |
| B: re-render bursts, worst / total long tasks | < 500 / 3,000 ms | 0 / 0 ms | — | 0 / 0 ms | Wide |
| C: virtualized feed heap growth | < 8 MB | 1.2 MB | — | 1.3 MB | Wide |
| D: extra layouts per chip (clamped cards) | < 1.6 | 1.23 | — | 1.22 | Moderate (23%) |
| E: PDF first page / first text layer | < 6,000 ms | 244 / 280 ms | — | 243 / 277 ms | Wide |
| E: PDF reflow total / worst run | < 400 / 200 ms | 11 / 7 ms | — | 11 / 7 ms | Wide |
| E: canvases after scrolling | ≤ 10 | 10 | — | 10 | At the limit (pdf.js's own policy) |
| F: content script share, X-like / Reddit-like | < 5% | 1.2% / 2.4% | 1.4% / 2.5% | 1.3% / 2.6% | Wide |
| F: mutation handling, last minute, X-like / Reddit-like | < 6% | 1.2% / 3.3% | 1.4% / 3.3% | 1.3% / 3.4% | Moderate |
| F: heap kept, X-like / Reddit-like (second half) | < 8 MB / < 8 KB per post | 1.5 MB / 2.7 KB | 2.9 MB / 4.0 KB | 1.6 MB / 2.7 KB | Wide |
| G: Reddit-like feed, added main-thread share | < 8% | 5.8%, 7.4%, 7.1% | 7.7%, 8.0%, 8.0% (study preset: 7.4%, 7.8%) | 7.7% | **Tight**, and tighter with the reading log on |
| H: 20,000-row table, worst long task | < page's own + 50 ms | 133 ms against 136 ms | — | 127 against 137 ms | About 50 ms |
| I: chat (message every 300 ms), added share | < 7% | 5.6% | 6.2% | 6.1% | Moderate |
| I: chat long tasks ≥ 50 ms | 0 | 0 | 0 | 0 | Zero tolerance |
| J: idle page, script and layouts in 30 s | < 20 ms, 0 | 0 ms, 0 | 8 ms, 0 | 0 ms, 0 | Zero tolerance on layouts |

**Budget G swings with the plain browser's run.** Its share is the extension's main-thread time less a plain browser's over the same 60 s, and the plain browser's own time moved from 1.2 s to 1.7 s between runs while the extension's stayed near 6.0 s. Read G over several runs.

**The reading log's cost.** With it on, the extension's own script took about 50 ms more a minute on budget G's feed, and the browser's native work about 240 ms more: the log's two intersection observers (`viewIO`, `bandIO`) over every paragraph of a 650-post feed. That is what measuring exposure costs, so it stays. The log is off by default; on a busy feed at the study or full preset, G reads 7.4–8.0%.

The perf matrix compares Anagram with a plain browser on 12 real pages from the web benchmark and in five synthetic scenarios: a big DOM, a chatty page, an SPA, the toolbar menu and a paste (2026-10-05).

- **Real pages:** no long task from Anagram on any of them. Each load added 50–230 ms of main-thread time.
- **Toolbar menu:** opened in 55–82 ms.

G and I hold the cost of live pages. About half of what they measure is Chromium's own work: it re-validates every registered highlight range and repaints on each DOM change. Area 2 explains why only marks near the screen are registered.

## Area 1: The web-page reader

This section covers the web-page reader in `lib/dom/`. Its main file is `walker.ts`. The walker relies on `text.ts`, `scope.ts`, `boilerplate.ts`, `style.ts`, `tags.ts`, `splits.ts`, `shadow.ts`, `kept.ts`, `lookalikes.ts`, `translation.ts`, `consentBanners.ts`, `visibility.ts`, `locate.ts` and `mainContent.ts`. It also uses the grouping arithmetic it imports from `lib/plan/group.ts` and `lib/capture/windows.ts`.

The walker makes one pass over the composed tree (shadow roots and slots included) and works in five steps:

1. It splits the page into visual paragraphs ("runs") by computed layout.
2. It drops page chrome, machine text, previews and hidden text.
3. It assigns each run a voice ("scope"), which is a post, a quotation, a review or the page itself.
4. It groups short runs of one voice into units. A post that fits one model window becomes a single unit.
5. It reports any sub-floor stretch that no neighbour could take to the statistics as "short".

Every row below changes what is read, how it is split or what is skipped.

None of these values can be changed by the user.

How this area affects the statistics:

- **Counted as read:** a unit, or a stretch reported through `onShortText`.
- **Never counted at all:** a run that is dropped as a barrier, chrome, a teaser, a cut preview or an aside. It is missing from both the numerator and the denominator of the "share of words".

### Units and length

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MODEL_MIN_WORDS` | 75 words | `lib/dom/text.ts:94` | Below it, a verdict is flagged "less reliable". Teasers are only recognised below it. | Model | This value does not gate reading. It feeds the "less reliable" count. The teaser rule is tied to 75, not to the floor. |
| `MIN_WORDS` | 50 words | `lib/dom/text.ts:102` | Evidence floor. A run this long is a unit by itself. Shorter runs of one voice are always grouped up to it. | Convention | The comment cites Pangram's product minimum. CHANGELOG 0.7.0 measured that at 50 words "a quarter of human texts read as AI-edited" and moved to 75. Release 0.8.0 lowered it back as a setting; since 2026-10-05 it is fixed. Shared with the PDF reader, selections, pasted text and the frame stub. This value sets stats coverage directly. |
| `WINDOW_CHARS` (imported) | 1800 chars (about 300 English words) | `lib/capture/windows.ts:41` | Caps group size, sets the post-versus-article line and limits orphan joins | Measured | Measured with the tokenizer on English. The model area owns this value. Raising it merges longer posts into one verdict. In CJK text, 1800 chars is far more than one pass. |
| Post rule: scope prose clears the floor and fits one window | ≥ floor and ≤ 1800 chars | `lib/dom/walker.ts:1726` | A declared or recognised scope becomes ONE unit, with its full paragraphs included | Judgement | Justified as "about the mean training-text length", without a figure. Anything longer is an article, with one chip per full paragraph. |
| `WHOLE_POST_CHARS` | 2 × `WINDOW_CHARS` = 3600 chars | `lib/dom/walker.ts:1474` | A re-scan root inside a scope this small restarts at the whole scope | Judgement | Too low and a re-scanned comment is read paragraph by paragraph, each paragraph too short. Too high and re-scans cost more. |
| Raw-size bound in `wholePost` | 8 × 3600 = 28 800 chars | `lib/dom/walker.ts:1494` | Skips collapsing whitespace in a huge scope's `textContent` | Safety | Bounds cost only. Above it, the walk stays where it was asked to start. |
| `modelSized` even division | ceil(chars / 1800) groups, each ≥ floor | `lib/plan/group.ts:87` | How a long stretch of short runs is cut into units | Judgement | Shared with the PDF reader. Motivated by examples (a Zhihu answer that was cut into 20 chips), not by a measured optimum. |
| `orphanHome` | prefers the paragraph before; within one window, else either side | `lib/plan/group.ts:123`, `:138` | A sub-floor stretch joins the adjacent full paragraph | Measured | Measured case: Substack lost 570 of 2407 words without it. The rule turns "short" (unscored) words into scored words, so it raises stats coverage. Lines 138–139 allow a join past the window. |
| `MAX_UNIT_TEXT_CHARS` | 200 000 chars (about 32 000 words) | `lib/dom/text.ts:139` | Hard cap on one unit's text | Safety | Past the cap, only the words of the text kept count (`unitTextOf`, `:145`). |
| `MIN_MERGE_WORDS` | 8 letter-words | `lib/dom/text.ts:115` | An unpunctuated block counts as prose and can merge. It also makes a list item prose. | Judgement | Present since the initial commit. Raising it drops unstopped bullets. Lowering it lets names and labels merge into text. |
| `MIN_SENTENCE_WORDS` | 3 letter-words | `lib/dom/text.ts:119` | A punctuated block counts as prose; shorter ones ("Yes.") are asides | Judgement | Asides are skipped silently: they are neither scored nor reported as short. |
| `MIN_LINE_WORDS` | 4 letter-words | `lib/dom/text.ts:128` | Joins the next line of the same block without punctuation. Also sets the verse and "pending first line" thresholds. | Judgement | Unpunctuated lines of 1–3 words are skipped as a handle or "2h ago". Used at `walker.ts:1922`, `:2008` and `:2017`. |
| Running-text shape | one lower-case-led word of ≥2 letters, or fewer than half the words cased | `lib/dom/text.ts:496` | Whether a short run is running text rather than a Name or Title | Measured | The example behind it: an X post of 223 words was judged on only 135 of them. A Title-Case sentence never counts as prose. |
| `PROSE_END_RE` punctuation set | `. ! ? … , ; 。 ！ ？ ， ； 、` (plus closing quotes and emoji) | `lib/dom/text.ts:444` | What "ends like prose" means | Judgement | A comma or semicolon counts as a sentence end, so a label ending in "," passes as punctuated. |
| `near` / `compatible` proximity | same parent, or parent and grandparent; lists see-through | `lib/dom/walker.ts:1365` | Which runs on the bare page may merge | Judgement | Present since the initial design. Deeper cousins never merge unless an exception applies (lists, LaTeXML, same-template wrappers). |
| `LAYOUT_WRAPPER_HOPS` | 3 single-child DIV or SPAN wrappers | `lib/dom/walker.ts:1432` | How far `unwrapped()` climbs to compare two paragraphs | Judgement | Set for Facebook's `pre-wrap` boxes, one per paragraph. On the bare page it only applies when the boxes come from the same template (`sameBody`). |
| `paragraphBox` (LaTeXML) | `div.ltx_para`, `li.ltx_item` | `lib/dom/walker.ts:1353` | arXiv HTML paragraphs count as siblings | Measured | Measured: "12% of the prose of 50 papers" was unread without it. Site-specific class names. |
| `LIST_MARKUP` / `outsideLists` | UL OL LI DL DT DD | `lib/dom/walker.ts:1386` | A list does not separate one section's text | Judgement | Example: an epam.com list of 112 words. This list markup lets lead-in, items and follow-up merge into one unit. |
| `LONGEST_ABBREVIATION` | 10 chars (+2 for brackets) | `lib/dom/text.ts:407`, `:415` | Checks for an abbreviation before an ICU sentence break | Safety | Affects only where long units are cut into windows, not what is read. |

### Language and writing system

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `SCRIPT_MIN_LETTERS` | 8 letters | `lib/dom/text.ts:309` | Below this, a run's writing system is unknown and it merges with anything | Judgement | Added 2026-10-04 for a Chinese paragraph followed by an English note. No measurement. |
| `SCRIPT_SHARE` | 0.7 of letters | `lib/dom/text.ts:311` | Share that one script must hold to name the run's script | Judgement | A 60/40 mixed run is "unknown" and may join either side. Lowering the share splits more bilingual posts. |
| `SCRIPTS` buckets | 5: CJK (Han, Kana and Hangul as one), Latin, Cyrillic, Arabic, Greek | `lib/dom/text.ts:312` | Which script changes are voice barriers | Judgement | Hebrew, Devanagari and Thai map to null and are never a barrier. Chinese next to Japanese is not a barrier either. |
| Look-alike trigger | a mixed word with a table letter other than small Greek (omicron counts) | `lib/dom/lookalikes.ts:64` | Whether Cyrillic or Greek homoglyphs are folded at all | Measured | Measured on 15 979 arXiv paragraphs, 20 619 EditLens texts and 467 985 RAID texts: unchanged except for 43 RAID texts. |
| Look-alike Latin majority | fold only if Latin letters > half after folding | `lib/dom/lookalikes.ts:87` | Leaves Russian or Greek prose as written | Measured | Undoes 1103 of 1104 RAID homoglyph attacks. 4 of 3961 web pages change. |
| `isNoTranslate` scope | below page level, block display, not a shell | `lib/dom/boilerplate.ts:97` | `notranslate` excludes a box only when it is a small block | Measured | Applied inline, it holed sentences: a 76-word paragraph counted 73 and fell under the floor. |
| `SHELL_ELEMENT_SHARE` | 0.5 of body elements | `lib/dom/boilerplate.ts:65` | A box holding half the page's elements is a shell, so its `notranslate` and `<form>` are ignored | Judgement | Introduced for Mastodon's `notranslate` app root. Applies only when no sectioning landmark exists. |
| Translation markers | 2 Chrome classes, 2 attributes and 1 class for translator extensions | `lib/dom/translation.ts:38`, `:95` | Text written by a translator is skipped | Platform | These are vendor markers, not tuned values. The language gate itself (English only) is in the model area. |

### Machine text and noise barriers

A barrier run is never scored and never reported as short. It also ends any group of short runs.

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Symbol-noise cut-off (unnamed) | > 0.2 of non-space chars | `lib/dom/walker.ts:2059` | Treats ASCII diagrams and table rules as a barrier | Measured | The comment measures prose at 0.02–0.06; the 0.2 margin was chosen by hand. Prose heavy in maths or slashes is the risk. |
| `STRUCTURAL_SYMBOLS` | 31 chars: 14 ASCII (plus, minus, pipe, equals, underscore, tilde, caret, asterisk, both slashes, angle brackets, hash, backtick) and 17 box-drawing | `lib/dom/text.ts:572` | What counts as a symbol | Judgement | Includes `-` and `/`, which are common in prose and URLs. |
| `MAX_SHORTCODE_SHARE` | 0.3 of chars | `lib/dom/walker.ts:273` | Treats unrendered WordPress shortcode rows as a barrier | Measured | Measured on the web benchmark (dev precision 93.34 → 93.41). Specific to WPBakery and Divi. |
| Column gap | ≥ 8 interior spaces (`/\S {8,}\S/`) | `lib/dom/text.ts:604` | Treats a preserved-whitespace column layout as a barrier | Judgement | Applies only to `pre` and `pre-wrap` runs. Monospaced prose that justifies with spaces would be lost. |
| `REPEAT_MIN_WORDS` | 30 words | `lib/dom/text.ts:634` | Minimum length for the repetition test | Measured | Measured on the web benchmark (dev leak 5.00 → 4.96). |
| `MAX_REPEATED_WORDS` | 8 distinct words | `lib/dom/text.ts:635` | A run of ≥30 words using ≤8 distinct words is a barrier | Measured | Same commit. It is a cap on distinct words, not a share, so long text is never caught. |
| Server diagnostic | every non-blank line matches a PHP warning | `lib/dom/text.ts:671` | Treats phpBB and PHP debug output as a barrier | Measured | One phpBB topic leaked 750 words. Specific to PHP. |
| Separator run | ≥ 3 chars, punctuation or symbols only | `lib/dom/text.ts:567` | Treats "* * *" as a section barrier | Judgement | A letterless run that is not a separator is transparent instead. |
| Name list: minimum tokens | 12 letter-tokens | `lib/dom/text.ts:623` | The name-list test applies only from this length | Judgement | Present since the initial commit. A shorter byline of authors is handled by the role test instead. |
| Name list: capitalised share | ≥ 0.6 of tokens | `lib/dom/text.ts:627` | Treats author lists and citation strings as a barrier | Judgement | The comment says German prose stays "well under" it, without a number. A risk for Title-Case-heavy prose. |
| Name list: comma density | ≥ 1 comma per 8 tokens | `lib/dom/text.ts:627` | Second condition of the name-list test | Judgement | No measurement found. |
| `MAX_LINK_RATIO` | 0.7 of chars inside `a[href]` | `lib/dom/walker.ts` | Treats nav and menu runs as a barrier | Measured | Swept from 0.5 to 1.0 on the web benchmark's dev split (2026-10-09). 0.7 read more of the pages' text (F1 0.8457 → 0.8464; held out, +0.11 points) for −0.03 points of precision; 1.0 lets link lists in. The diagnostics use the same constant. Text over it is counted as left out (`links`) in the reading log. |
| `CARD_TEXT_WORDS` | 20 words plus a sentence end | `lib/dom/walker.ts:275` | Prose inside a link that wraps a whole card is exempt from the link-ratio barrier | Measured | Measured on the web benchmark (dev recall 70.64 → 70.69). Made for stackoverflow.blog. |

### Prose inside `<pre>`

A `<pre>` is read only if it has no code markup and passes every test below.

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `PRE_SAMPLE_CHARS` | 2000 chars | `lib/dom/walker.ts:1161` | How much of a `<pre>` is sampled | Safety | "Twenty-five lines settle it." An RFC has 176 such blocks. |
| `PRE_MIN_WORDS` | 20 words | `lib/dom/walker.ts:1164` | Shorter `<pre>` blocks are code or commands | Judgement | Below every floor anyway. |
| `PRE_MIN_LINES` | 3 lines | `lib/dom/walker.ts:1165` | Minimum lines for the prose test | Judgement | — |
| `PRE_MIN_WORDS_PER_LINE` | 4 words per line | `lib/dom/walker.ts:1167` | Wrapped prose fills its column; code lines are short | Judgement | Applied to the whole RFC, man page and mailing-list corpus. |
| `PRE_MAX_CODE_PUNCT` | 0.03 of non-space chars | `lib/dom/walker.ts:1171` | Share of `(){}[];=<>` allowed | Measured | Measured: RFC prose < 0.03, Python 0.10, a diff 0.12. Prose that quotes code is excluded. |
| `PRE_MIN_LOWER_SHARE` | 0.5 of words | `lib/dom/walker.ts:1174` | Words beginning in lower case | Judgement | Caseless scripts count as lower case. |
| `PRE_MIN_SENTENCE_ENDS` | 1.5 per 100 words | `lib/dom/walker.ts:1176` | Requires sentence ends | Judgement | Commit dfe4b80 says "sentence ends at all", but the code requires 1.5 per 100 words. |
| `CODE_WRAPPER_LEVELS` | 3 levels | `lib/dom/walker.ts:1189` | How far up highlighter classes are looked for | Judgement | Sphinx needs 2 levels. |

### Inline marks, formulas, hidden and out-of-flow content

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MARK_NUMBER` | 1–4 digits plus an optional letter | `lib/dom/walker.ts:132` | Numeric citation marks skipped in mid-sentence | Judgement | Skipped marks shorten the word count slightly. A 5-digit mark is kept as words. |
| Bracketed label | each label ≤ 3 words | `lib/dom/walker.ts:150` | "[citation needed]" and "[Knu84]" are skipped as marks | Judgement | A longer bracketed phrase is read. |
| Footnote symbols | 1–3 of `* † ‡ § ¶` in `<sup>` | `lib/dom/walker.ts:151` | Symbol marks skipped | Convention | — |
| `YEAR_RE` (walker) | 1500–2099, optional letter | `lib/dom/walker.ts:136` | An author–year citation is kept as words | Judgement | Inconsistent with `scope.ts:198` (1900–2099). |
| `MARKED_WORD` | 3 letters | `lib/dom/walker.ts:156` | A raised number after a word of ≥3 letters is a mark; after a shorter word it is an exponent | Convention | Deliberately the same line the PDF reader draws. "km²" keeps its exponent. |
| `DROP_CAP_CHARS` | 12 chars and ≤ 1 word | `lib/dom/walker.ts:173` | Decides whether a floated phrase is a drop cap (stays in the sentence) or a sidenote | Judgement | A longer float is read as a separate note after the paragraph. |
| `SMALL_OUT_OF_FLOW_CHARS` | 40 chars | `lib/dom/walker.ts:290` | An absolute or fixed box this small is skipped without breaking the sentence | Judgement | Present since the initial commit. A larger box closes the run and becomes a block. Counted over the composed tree (bounded). |
| Visually hidden | font-size 0, opacity 0, or out-of-flow ≤ 2 px or clipped | `lib/dom/style.ts:178` | Screen-reader-only and MathML copies are skipped | Convention | The common `sr-only` idiom. Opacity-0 text that fades in later is skipped until a re-scan. |
| Zero-size container | width > 0 and height > 0 | `lib/dom/visibility.ts:20` | A run in a zero-size box is not read | Platform | Cached per scan. |
| `HEADING_SAMPLE_CHARS` | 400 chars | `lib/dom/tags.ts:56` | A longer "heading" is walked as a container | Judgement | A cheap pre-check before counting words. |
| `MAX_HEADING_WORDS` | 30 words | `lib/dom/tags.ts:58` | A heading of ≤30 words with no `p`/`li` is a barrier label that is never read | Judgement | Made for lobste.rs comment bodies (up to 172 words) marked `role=heading`. A 31-word headline is read as prose. |
| `NO_SCORE_TAGS` | 36 tags | `lib/dom/tags.ts:13` | Never descended into | Convention | Includes `BUTTON`, `RT` and `RP`. This list is a decision. |
| `MATH_CLASS_RE` | 14 class names, plus the `MATH` and `MJX-CONTAINER` tags | `lib/dom/walker.ts:107` | A formula is skipped and counted on the card | Convention | Case-sensitive on purpose, because of arXiv's `abstract mathjax`. |

### Previews, teasers and clamps

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MAX_EXPAND_LABEL_CHARS` | 40 chars | `lib/dom/walker.ts:325` | Longest "See more"-type control label | Judgement | Used together with `EXPAND_LABELS`. |
| `EXPAND_LABELS` | 42 labels in 9 languages | `lib/dom/walker.ts:333` | Vocabulary of controls that bring the rest of a text | Judgement | Site-specific: Facebook, X, YouTube, Reddit, Quora, LinkedIn, Weibo and Zhihu. A preview that is cut is dropped, not counted as short. |
| Cut-mark tail | ≤ 40 chars after "…" (`{0,39}`) | `lib/dom/walker.ts:358` | Text after the ellipsis that may still be a "Read more" | Judgement | Matches `MAX_EXPAND_LABEL_CHARS`. |
| `CLAMP_BOX_LEVELS` | 4 levels | `lib/dom/walker.ts:319` | How far up a clamp, control or preceding run is looked for | Judgement | Used in 3 places (`:719`, `:751`, `:775`). |
| `CAP_MIN_HIDDEN_PX` | 4 px | `lib/dom/style.ts:140` | Hidden overflow that counts as a clamp, so the text is read rather than cut | Judgement | — |
| `TEASER_CARD_LEVELS` | 3 levels | `lib/dom/walker.ts:366` | How far up a teaser's card is looked for | Judgement | — |
| `TEASER_CARD_WORDS` | 150 words | `lib/dom/walker.ts:367` | Most words a teaser card holds | Measured | Measured on the web benchmark with minimum 50 (dev leak 5.24 → 5.18, recall −232 words). |
| Teaser word limit | < `MODEL_MIN_WORDS` (75) | `lib/dom/walker.ts:673` | Only excerpts under 75 words can be teasers | Measured | Independent of the floor: a cut excerpt of 50–74 words is dropped, not read. |
| Title-link coverage | link text ≥ 0.9 of the heading | `lib/dom/walker.ts:386` | A heading is a card's title link | Judgement | — |
| `ONE_LINE_BOX_LEVELS` | 3 levels | `lib/dom/style.ts:144` | A one-line ellipsis preview is not read | Judgement | Made for Discord's reply preview, which needs 1 level. |
| Cut post | any cut run in a post that fits one window drops the whole post | `lib/dom/walker.ts:1720` | No verdict on a site-cut preview | Judgement | Silent: not reported as short in the stats. |
| `CLIP_CONTENT_RATIO` | 2× box height | `lib/dom/style.ts:84` | `clipsOwnText`, now used only by the diagnostics | Measured | LinkedIn measured 60 px around 497 px. It no longer affects reading. |
| `CLIP_MIN_HIDDEN_PX` | 32 px | `lib/dom/style.ts:87` | Same as above | Measured | Duplicated in `lib/render/badge.ts`. |
| `CLIP_MAX_VIEWPORT_SHARE` | 0.9 of viewport | `lib/dom/style.ts:90` | Same as above | Judgement | Duplicated in `lib/render/badge.ts`. |

### Boilerplate and page structure

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `CHROME_TOKEN_PATTERNS` | 63 class or id patterns | `lib/dom/boilerplate.ts:111` | Treats a class or id name as chrome and skips the subtree | Convention | From trafilatura and Readability, made stricter with compound forms. The single largest silent filter, and invisible in the stats. |
| `CHROME_ROLES` | 18 ARIA roles | `lib/dom/boilerplate.ts:24` | Landmark roles that are always chrome | Platform | `tab` is exempt when it holds a panel or paragraph. |
| header/footer rule | skipped unless inside `article`/`main` | `lib/dom/boilerplate.ts:583` | Page-level `<header>` and `<footer>` | Convention | Follows Readability. |
| `PAGE_FOOTER_NAME_RE` | names like `footer`, `site-footer`, `footer-wrapper` | `lib/dom/boilerplate.ts:270` | A div or section named as the page's footer | Judgement | Examples: Gutenberg's licence and bank notices. |
| `MAX_ID_PARTS` | 4 hyphen- or underscore-separated parts | `lib/dom/boilerplate.ts:186` | An id with more parts is a slug, not a component name | Measured | Measured on the web benchmark (dev recall +0.01, precision −0.04). Examples: PostgreSQL and Consumer Reports. |
| Name length cap | 256 chars | `lib/dom/boilerplate.ts:202`, `:603` | The id and class string tested for chrome tokens | Safety | Tokens past 256 chars are ignored. |
| `PAGE_TEXT_SHARE` | 0.4 of the page's text | `lib/dom/boilerplate.ts:225` | A box holding more than this is never chrome by name | Convention | From Unclutter's `mainContentFractionThreshold`. It changed no unit on the existing fixtures. A pre-check skips boxes of ≤200 chars (`:257`). |
| `PAGE_TEXT_MIN_CHARS` | 500 chars | `lib/dom/boilerplate.ts:226` | The page must be this long for the share to apply | Convention | From Unclutter. |
| `LIST_ITEM_MIN` | 3 siblings | `lib/dom/boilerplate.ts:318` | A reply-form box that holds a list is the comments, not the form | Judgement | Made for cnblogs' `comment_form`. |
| `LIST_ITEM_MIN_CHARS` | 20 chars | `lib/dom/boilerplate.ts:320` | Minimum text for a list item | Judgement | — |
| `holdsAList` depth | 2 levels | `lib/dom/boilerplate.ts:329` | How deep the list is looked for | Judgement | — |
| Form rule | a form with a fillable control is chrome, unless it is a shell or holds the page | `lib/dom/boilerplate.ts:597` | Consent and sign-up text inside forms | Judgement | ASP.NET (shell) and osCommerce (holds the page) are the exceptions. |
| `VENDOR_LIST_MIN` | 5 distinct outside hosts | `lib/dom/boilerplate.ts:410` | A list of policy links is a consent box's vendor list | Measured | Measured on the web benchmark (Daily Mail: dev leak 4.59 → 4.58). |
| `CONSENT_BOX_LEVELS` | 8 levels | `lib/dom/boilerplate.ts:412` | How far above the vendor list the consent controls are looked for | Judgement | — |
| Consent control label | ≤ 40 chars | `lib/dom/boilerplate.ts:470` | Button label length for the "Accept"/"Reject" match | Judgement | — |
| `CONSENT_BANNER_SELECTORS` | about 48 selectors | `lib/dom/consentBanners.ts:16` | Consent containers of known platforms | Convention | Taken from DuckDuckGo autoconsent 16.42.0. |
| `CONSENT_FRAME_HOSTS` | 7 hosts | `lib/dom/consentBanners.ts:59` | A whole frame is not read | Convention | Also from autoconsent. |
| `AMP_CHROME_TAGS` | 11 AMP components | `lib/dom/boilerplate.ts:48` | AMP chrome | Platform | — |
| `BESIDE_TEXT_CHARS` | 40 chars | `lib/dom/boilerplate.ts:482` | An `<aside>` with this much running text beside it stands in the text | Judgement | The scope's `IN_SENTENCE_CHARS` (24) asks a like question. |
| `ASIDE_PROSE_CHARS` | 120 chars outside links | `lib/dom/boilerplate.ts:503` | An aside holds prose of its own and is read | Measured | Measured on the web benchmark (dev recall +0.09, test +0.02). |
| `holdsProse` block cap | 40 blocks | `lib/dom/boilerplate.ts:511` | How many blocks of an aside are checked | Safety | — |
| Pull-quote test | the aside's words occur once in its surroundings | `lib/dom/boilerplate.ts:534` | A repeated pull quote is skipped | Judgement | Exact word match only. A paraphrased pull quote is read twice. |
| `REFERENCE_LIST_RE` | 6 class tokens plus `doc-bibliography` | `lib/dom/boilerplate.ts:626` | Paper reference lists | Convention | Publisher-specific names: LaTeXML, JATS, Springer, Wiley and CSL. |
| `MEDIAWIKI_FURNITURE_RE` | 4 classes plus CS1/CS2 `cite` | `lib/dom/boilerplate.ts:650` | Wikipedia hatnotes and references | Convention | Follows mwparserfromhtml. Applies only inside `.mw-parser-output`. |
| `NOTICES_NAME_RE` | a `notices` token on a list | `lib/dom/boilerplate.ts:351` | Forum site notices | Judgement | Specific to XenForo and vBulletin. |

### Main-content probe (diagnostics only)

`findMainContent` is used only by `lib/diagnostics/report.ts`. None of these values changes what is read.

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `DOMINANCE` | 0.56 of the parent's text | `lib/dom/mainContent.ts:9` | Descent into a dominant child | Judgement | An oddly precise value, present since the initial commit with no source. |
| `MIN_REGION_CHARS` | 500 chars | `lib/dom/mainContent.ts:11` | Smallest region that is trusted | Judgement | — |
| `MIN_SEMANTIC_SHARE` | 0.2 of the page | `lib/dom/mainContent.ts:13` | Smallest share for a `main` or `article` candidate | Judgement | — |
| `MAX_DESCENT` | 14 levels | `lib/dom/mainContent.ts:14` | Depth of the descent | Safety | — |

### Posts, bylines and scopes

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `DECLARED_SCOPE_SELECTOR` | article, role=article, blockquote, figure, role=link, LinkedIn listitem, Facebook `aria-posinset`, 2 Bilibili tags, schema.org Review | `lib/dom/scope.ts:160` | Voices that the markup declares | Platform | Partly site-specific. Nothing merges across a scope. |
| `MAX_RATING_CHARS` | 60 chars | `lib/dom/scope.ts:185` | Longest rating label that counts as byline evidence | Judgement | — |
| Rating number | 1–2 digits; ≤ 12 non-digits after "rated" | `lib/dom/scope.ts:179`, `:181` | Matches star-rating labels | Judgement | Examples: Google Play, Yelp, Amazon and Trustpilot. |
| `MAX_MOMENT_TITLE_CHARS` | 40 chars | `lib/dom/scope.ts:199` | A `title` that spells out a date is byline evidence | Judgement | — |
| Moment years | 1900–2099 (ISO date, or a clock time next to a year) | `lib/dom/scope.ts:196`, `:198` | Dated-title evidence | Judgement | Differs from the walker's 1500–2099. |
| `PERSON_HREF_RE` | `user`, `u`, `members`, `profile`, `@name`, `~name`, `?uid=`, … | `lib/dom/scope.ts:216` | A link to a person is byline evidence | Measured | Partly measured on live pages (HN, Substack, Lobsters, YouTube, Steam, phpBB); the rest is convention. |
| `siteOf` | last two host labels | `lib/dom/scope.ts:307` | Restricts person links to the same site | Judgement | "Near enough": all `*.co.uk` sites count as one site. |
| `MAX_NAME_CHARS` | 40 chars | `lib/dom/scope.ts:218` | Longest text of a person link | Judgement | — |
| `MAX_CAPTION_CHARS` | 200 chars | `lib/dom/scope.ts:221` | Longest text link in a picture-and-name pair | Judgement | Set for LinkedIn's name, headline and age, which share one link. |
| `IN_SENTENCE_CHARS` | 24 chars | `lib/dom/scope.ts:224` | Evidence next to more text than this is mid-sentence, not a byline | Judgement | — |
| `SENTENCE_WRAPPER_HOPS` | 3 wrappers | `lib/dom/scope.ts:226` | Wrappers looked through for that sentence check | Judgement | — |
| `MAX_NEST_HOPS` | 8 levels | `lib/dom/scope.ts:228` | How far up a lone reply looks for a post of its shape | Judgement | — |
| `EDGE_CHARS` | 120 chars | `lib/dom/scope.ts:231` | Text allowed between a byline and the edge of its post | Judgement | With more than 120 chars on both sides, the element is not a post. An opening post needs more than 120 chars of body (`:1059`). |
| `THREAD_LEVELS` | 3 levels | `lib/dom/scope.ts:235` | How deep inside a neighbour the posts of a thread are looked for | Fitted | Derived from V2EX (1 level) and HN (2 levels), plus one spare. Overfitting risk. |
| "Several alike" | ≥ 2 siblings of the same shape, the element included | `lib/dom/scope.ts:1020` | Recognises posts that declare nothing | Judgement | Two look-alike bylined siblings make both posts. This decides post-or-article and so the unit granularity. |
| `isSectioned` | > 1 heading | `lib/dom/scope.ts:445` | An article with comments is not an opening post | Judgement | Made for Hugging Face paper pages. |
| Avatar evidence | class or src contains "avatar" | `lib/dom/scope.ts:302` | An image counts as WHO evidence | Judgement | A naming convention that holds on Zhihu, V2EX and Steam. |

### Reviews and a list's repeated text

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MIN_FOUND_CHARS` | 24 chars | `lib/dom/scope.ts:625` | Shortest JSON-LD review body searched for in the page | Judgement | A text node shorter than 12 chars (`:703`) is never matched. |
| `PROBE_CHARS` | 32 chars | `lib/dom/scope.ts:626` | Head and tail probes used to find a review text | Judgement | — |
| `MAX_LD_DEPTH` | 12 levels | `lib/dom/scope.ts:628` | JSON-LD recursion depth | Safety | — |
| `MAX_LD_REVIEWS` | 200 texts | `lib/dom/scope.ts:629` | Review texts taken from JSON-LD | Safety | Reviews past the 200th are not separated from their furniture. |
| `MAX_LOCATED` | 2000 entries | `lib/dom/scope.ts:676` | Memo of located review texts, cleared when full | Safety | — |
| Locate climb bound | text > 2 × length + 400 chars | `lib/dom/scope.ts:709` | Stops widening past the review | Judgement | — |
| Single-body page | < 2 bodies: no card inferred | `lib/dom/scope.ts:755` | One review body never makes a card | Measured | Made for movebuddha.com; part of the web benchmark round in commit 969ff2f. |
| `CARD_EXTRA_WORDS` | 60 whitespace words | `lib/dom/scope.ts:723` | Largest amount of furniture beside a body that is known only by its text | Measured | 16 → 7 pages changed out of 3437. Uses a whitespace count, not `countWords`. |
| `SHARED_MIN` | 3 cards | `lib/dom/scope.ts:780` | Text repeated in this many cards belongs to the list and is left out | Judgement | Made for Tripadvisor's 38-word disclaimer. |
| Shared majority | ≥ half of the cards | `lib/dom/scope.ts:854` | Second condition of the shared-text test | Judgement | — |
| `SHARED_MIN_CHARS` | 16 chars | `lib/dom/scope.ts:782` | Shorter texts are not counted as shared | Judgement | — |
| `LIST_LEVELS` | 3 levels | `lib/dom/scope.ts:784` | How far above a post the list of cards is looked for | Judgement | — |
| `MAX_CARD_BLOCKS` | 400 elements | `lib/dom/scope.ts:785` | Elements read per card | Safety | — |
| `MAX_LIST_CARDS` | 60 cards | `lib/dom/scope.ts:788` | Cards sampled per list | Safety | — |

### Mail and quoted text

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Quote-depth change | any change in the number of leading `>` | `lib/dom/walker.ts:687` | Starts a new voice (barrier), also for owned runs | Convention | Applies only in preserved whitespace. Quoted `>` markers are removed from the text (`text.ts:749`). |
| `PARA_GAP_RE` | a blank line | `lib/dom/walker.ts:313` | Paragraph break in preserved-whitespace text; the node is split | Convention | The only page mutation the reader makes (`splits.ts`). |
| `ATTRIBUTION_RE` | "On … wrote:" with ≤ 500 chars between | `lib/dom/text.ts:507` | A mail program's attribution line is skipped | Convention | The shape comes from talon. The 500-char limit bounds the match. |
| `ATTRIBUTION_DETAIL_RE` | a clock time (h:mm) or an `@` address | `lib/dom/text.ts:508` | Tells an attribution from an author's own sentence | Judgement | — |
| `MIN_HEADER_LABELS` | 3 labels, including From | `lib/dom/scope.ts:503` | A bold From/Sent/To/Subject block is a header | Convention | From talon. |
| `MAX_HEADER_LINES` | 6 sibling blocks | `lib/dom/scope.ts:506` | Header lines followed after the From line | Judgement | Apple Mail puts one line per div. |
| `MAX_HEADER_CHARS` | 1000 chars | `lib/dom/scope.ts:508` | Above this, a block with a bold "From:" is someone's text | Judgement | — |
| `wholeWrapper` hops | 2 levels | `lib/dom/scope.ts:529` | Wrappers climbed around a marker | Judgement | An unnamed literal, unlike its siblings. |
| `SPLITTER_STYLE_RE` | Outlook 1 pt top border in #E1E1E1 or #B5C4DF; Windows Mail padding | `lib/dom/scope.ts:484` | Outlook's splitter marks the start of the quoted history | Convention | From talon's `cut_microsoft_quote`. |
| `MAIL_MARKER_SELECTOR` | 11 selectors | `lib/dom/scope.ts:486` | Gmail, Yahoo, Outlook, Zimbra and Thunderbird markers | Convention | From talon and planer. |

### Hostile-input limits

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MAX_WALK_DEPTH` | 512 composed levels | `lib/dom/walker.ts:301` | Deeper elements close the run and are not read | Platform | The HTML parsers of Chromium and WebKit never nest deeper than 512. Around 1500 levels the walk overflowed the stack. Script-built deeper content is lost silently. |
| `MOST_NODES_UNPAUSED` | 4096 nodes | `lib/dom/walker.ts:310` | The walk pauses even inside a paragraph | Safety | Measured: a paragraph of a million inline elements went from 5 s held to 1 s. Does not change what is read. |
| `composedTextLength` limit | stops at 40 chars | `lib/dom/walker.ts:1095` | Bounds the cost of the small out-of-flow check | Safety | Iterative, because the shadow nesting depth is unbounded. |
| Shadow-root search yield | every 512 elements | `lib/dom/shadow.ts:93` | Pauses the full-page shadow-root search | Safety | — |
| `cutTextAt` halving | log2(cuts) copy rounds | `lib/dom/splits.ts:45` | Splits a node at many blank lines | Safety | Measured: a 10 MB log went from more than 90 s to 1.9 s. An algorithm choice, not a tunable value. |

### Caching and slicing

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `KEPT_CHARS` | 524 288 chars (2^19) | `lib/dom/text.ts:289` | Memo of facts about each text (words, shape, script, model form); cleared all at once when full | Judgement | Introduced for a chat that adds a message every 300 ms. Does not change results. |
| `KEPT_TEXT_CHARS` | 8192 chars (2^13) | `lib/dom/text.ts:290` | Longer texts are never memoised | Judgement | — |
| `keptUntilChanged` | invalidated by any mutation | `lib/dom/kept.ts:28` | Keeps the scope survey and vendor lists between walks | Measured | Chat re-reading went from 0.49 s to 0.23–0.35 s per 30 s. DEVELOPMENT.md: on feeds it is invalidated every drain. |
| `SLICE_MS` | 8 ms | `lib/slices.ts:17` (walks: `lib/capture/orchestrator.ts:747`) | How long a walk runs before yielding to the page | Judgement | The walk yields only between blocks or every 4096 nodes. Owned by the scheduling area. |
| `listTexts` validity | child count plus first and last child | `lib/dom/scope.ts:831` | Reuses a list's shared texts across scans | Judgement | A card that changes in the middle of the list is not noticed until the count or the ends change. |

### Findings

#### Most consequential parameters

1. **`MIN_WORDS` = 50.** It decides which paragraphs become units, how far short ones are grouped, and so directly the statistics' coverage. The basis is weak and contradictory:
   - 0.7.0 raised the floor to 75 because "at 50 words a quarter of human texts read as AI-edited".
   - 0.8.0 lowered it back to 50, citing Pangram's product minimum. It has been fixed since 2026-10-05.
2. **The one-window post rule** (`walker.ts:1726`, `WINDOW_CHARS` 1800, `modelSized`, `orphanHome`). This rule sets the unit granularity: a whole post gets one verdict, while an article gets one per paragraph. `orphanHome` turns sub-floor text into scored text, which raises coverage. The window was measured in English characters only.
3. **`MAX_LINK_RATIO` = 0.7**, measured on the web benchmark (2026-10-09; it was 0.6, unmeasured). Runs above it are barriers; the reading log counts their words as left out (`links`), never as read.
4. **The short-run role test**: `MIN_MERGE_WORDS` 8, `MIN_SENTENCE_WORDS` 3, `MIN_LINE_WORDS` 4, the running-text shape, and a `PROSE_END_RE` that accepts a comma. Together they decide which short text joins a group and which labels split voices. All are Judgement.
5. **Post recognition**: "several alike" ≥ 2, `EDGE_CHARS` 120, `THREAD_LEVELS` 3, `IN_SENTENCE_CHARS` 24. Whether a thread's comments are separate voices, and whether each is one unit, depends on them.
6. **Chrome filters**: `CHROME_TOKEN_PATTERNS` (63 patterns), guarded only by `PAGE_TEXT_SHARE` 0.4 and `PAGE_TEXT_MIN_CHARS` 500. They are the largest silent exclusion, and the statistics never see what they exclude.
7. **Noise barriers**: symbol share > 0.2 and the name-list rule (12 tokens, 0.6 capitalised, 1 comma per 8 tokens). Swept on the web benchmark (2026-10-09): neither moves F1 by more than 0.002 either way. What they drop is counted as left out (`symbols`, `names`) in the reading log.

#### Duplicates and contradictions across files

- **The year patterns** are named for what they find: `CITED_YEAR_RE` (1500–2099, a citation's year, in the walker) and `MOMENT_YEAR_RE` (1900–2099, in a moment's title, in `scope.ts`).
- **Word counting differs.** Most rules use `countWords` (`Intl.Segmenter`). `scope.ts:725` (`wordCount`, used by `CARD_EXTRA_WORDS`) splits on whitespace. A CJK review card therefore counts about one "word" per clause there.
- **Page-level checks.** `scope.ts` has one `isPageLevel` (2026-10-10; there were two identical ones). `boilerplate.ts`'s `PAGE_LEVEL_TAGS` also includes `ARTICLE`, for its own purpose.
- **Clip constants.** `CLIP_MIN_HIDDEN_PX`, `CLIP_MAX_VIEWPORT_SHARE` and `NEVER_CLIPPED_TAGS` are exported by `lib/dom/style.ts` and used by `lib/render/badge.ts` (2026-10-10; they were copied).
- **`POST`** in `lib/stats/pageKind.ts` (used by the recorder too) re-states part of `DECLARED_SCOPE_SELECTOR`. Feed classification can drift from voice scoping.
- **Teasers ignore the floor.** The teaser rule is tied to `MODEL_MIN_WORDS` (75), not to `MIN_WORDS` (50).

#### Judgement values that deserve a measurement

The web benchmark (`test/web-bench`, which tunes on dev and reports on test) is the tool used for the Measured rows. On 2026-10-09 it swept `MAX_LINK_RATIO`, the symbol share, the name-list thresholds, `MIN_MERGE_WORDS`, `MIN_SENTENCE_WORDS`, `MIN_LINE_WORDS` and `SCRIPT_SHARE`; only the link share moved (Recommendations, above). Still to run:

- `SCRIPT_SHARE` 0.7 and `SCRIPT_MIN_LETTERS` 8, on pages in other scripts (the benchmark's are Latin)
- `SMALL_OUT_OF_FLOW_CHARS` 40
- `MAX_HEADING_WORDS` 30
- `EDGE_CHARS` 120 and "several alike" ≥ 2
- `SHELL_ELEMENT_SHARE` 0.5
- `MIN_WORDS` 50 itself, measured against the false-positive rate on human text at 50 compared with 75 words

`DOMINANCE` 0.56 is oddly precise and unexplained, but it only feeds the diagnostics.

#### Site-specific or fixture-fitted values

- **Fitted:**
  - `THREAD_LEVELS` 3, derived from V2EX and HN depths plus one.
- **Named for one site or vendor:**
  - `paragraphBox` (arXiv LaTeXML)
  - `CARD_TEXT_WORDS` (stackoverflow.blog)
  - `CARD_EXTRA_WORDS` and the single-body rule (movebuddha.com)
  - `SHARED_MIN` (Tripadvisor)
  - `VENDOR_LIST_MIN` (Daily Mail)
  - `MAX_ID_PARTS` (PostgreSQL, Consumer Reports)
  - `ONE_LINE_BOX_LEVELS` (Discord)
  - `MAX_CAPS_HEADING_WORDS` (osCommerce)
  - `isSectioned` (Hugging Face)
  - the `LAYOUT_WRAPPER_HOPS` unwrapping (Facebook)
  - `MAX_HEADING_WORDS` (lobste.rs)
  - `EXPAND_LABELS` (eight platforms)
  - `DECLARED_SCOPE_SELECTOR` entries (LinkedIn, Facebook, Bilibili)
  - `PERSON_HREF_RE` (HN, Substack, Lobsters, Steam, phpBB)
  - `CONTROL_SELECTOR` (GitHub Discussions)
  - `SKIP_DESTINATION_RE` (Gemini)
  - `TAXONOMY_TERM_RE` (WordPress, Ghost)
  - `NOTICES_NAME_RE` (XenForo, vBulletin)
  - PHP diagnostics (phpBB)
  - shortcodes (WPBakery, Divi)
- **Benchmark-validated:** most of the named-site values above were checked on the web benchmark's held-out split, which lowers the risk. `THREAD_LEVELS`, `LAYOUT_WRAPPER_HOPS`, `EDGE_CHARS` and `ONE_LINE_BOX_LEVELS` show no benchmark run.

#### Comments that no longer match the code

- **Commit dfe4b80** describes the `<pre>` test as needing "sentence ends at all". The code requires 1.5 per 100 words (`PRE_MIN_SENTENCE_ENDS`).
- **"one window, some 300 words"** (`walker.ts:1697–1698`, `lib/plan/group.ts:49`) holds for English only. In CJK, 1800 characters is far more than one model pass.

## Area 2: Scheduling and rendering on web pages

This area covers when and how fast Anagram reads, scores and draws on a web page. It includes the orchestrator and its three-lane scheduler (viewport, near, background), the observers that place paragraphs and batch mutations, the background pace and the fling hold, the insertion and language gates, the per-frame cache, long-text passes and request slicing, the chip, card and highlight layers (`lib/render/scale.ts` excluded), the page surfaces (Google Drive, pdf.js viewers, Kindle, Webnovel), the content-script entry points, the toolbar menu, the Settings engine cards, the paste page, and the performance budgets A–J the project holds itself to. Line numbers are for the `dev` branch on 2026-10-09.

### Lanes and read-ahead

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Viewport-lane batch size | 1 unit | `lib/capture/orchestrator.ts:68` | Units in each on-screen batch | Measured | First chip came at 0.27 s instead of 0.69 s on an M4 GPU (CHANGELOG); a pass costs ~12 ms there. Larger batches delay the first chip, because a pass pads to its longest text. |
| `LANE_BATCH_CHARS.near` | 4000 chars | `lib/capture/orchestrator.ts:61` | Size of near-lane batches | Judgement | Unchanged since the initial commit (2026-06-30). Batching gains flatten past batch 8 (`scheduler.ts:25-28`). A bigger batch makes the next on-screen paragraph wait longer behind it. |
| `LANE_BATCH_CHARS.background` | 6000 chars | `lib/capture/orchestrator.ts:61` | Size of background batches | Judgement | Ignores the measured pace. `pace.ts` gives ~1 s of engine time (≤4000 chars, one paragraph until measured), but only the PDF reader uses that. |
| One-unit batches on a processor | `oneUnitBatches ?? onProcessor` | `lib/capture/orchestrator.ts:1261` | Near and background batches drop to 1 unit | Measured | On an M4 CPU, three paragraphs took 4.8 s together and 3.1 s one by one (`pace.ts:23`). Keyed on the device kind, not measured speed: a slow GPU still gets 4000/6000. |
| `PAGE_IN_FLIGHT` | 4 batches | `lib/contract.ts:36` | Concurrent batches per frame | Judgement | `REQUEST_BLOCKS` is `DOCUMENT_SHARE.blocks` divided by it, so the batches in flight stay inside the router's per-document share together. Raising it makes requests smaller, not Unavailable. |
| `MAX_BACKGROUND_IN_FLIGHT` | 1 batch | `lib/capture/orchestrator.ts:74` | Slots the background may hold | Judgement | The engine cannot be interrupted, so one background batch can still delay an on-screen paragraph by up to one batch. |
| `PREFETCH_PASS` | 300 units | `lib/capture/orchestrator.ts:76` | Units queued per idle-prefetch pass | Judgement | Huge pages drain over several passes via `onIdle`. Raising it holds a larger queue at once; lowering it adds passes. |
| `PLACE_RETRY_MS` | 1100 ms | `lib/capture/orchestrator.ts:72` | When the prefetch re-checks units the observers have not placed | Judgement | Must exceed `PLACE_WAIT_MS` (1000 ms) to find them placed. The coupling is kept by two literals in two files. |
| `PLACE_WAIT_MS` | 1000 ms | `lib/capture/observers.ts:56` | How long the prefetch defers to the observers | Judgement | "An observer answers within a frame or two." Shorter risks sending the first screen in background batches that cannot be promoted. |
| Idle-prefetch scheduling | `requestIdleCallback` timeout 1500 ms; else `setTimeout` 400 ms | `lib/capture/orchestrator.ts:820-821` | When each prefetch pass runs | Judgement | The insertion gate uses 1200/200 ms for the same "wait for idle" idea. |
| `ROOT_MARGIN` | `"1200px 0px"` | `lib/capture/observers.ts:79` | How far ahead the near lane reads | Judgement | 1.41 screens at the perf viewport, under 1 on tall screens. Bounds how far ahead chips are ready. Never measured since 06-30. |
| `DEFAULT_BUDGET` | 800 chars | `lib/capture/scheduler.ts:49` | Fallback lane budget | Judgement | Dead for the orchestrator, which sets every lane; only a budget of 0 falls back to it. |
| `HOLD_LOOK_MS` | 30 000 ms | `lib/capture/scheduler.ts:51` | Longest sleep before a held lane is looked at again | Judgement | With the pace at Infinity (limited), the background lane is re-checked every 30 s. The cost is negligible. |

### Background pace

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `DUTY` | fast 0.5, mid 1/3, slow 0.15 | `lib/capture/pace.ts:44` | Engine share the background may take | Judgement | Rest after a batch of B ms is B(1−d)/d: B, 2B or 5.7B. On web pages "slow" stops the lane outright, so 0.15 serves only the PDF reader. |
| Battery factor | duty × 0.5 | `lib/capture/pace.ts:95` | Background share on battery | Judgement | Rest becomes 3B (fast) or 5B (mid). Read from `navigator.getBattery`, which is Chromium-only, so Firefox and Safari keep full duty. |
| `LOW_BATTERY` | 20 % and not charging | `lib/capture/pace.ts:134` | Stops background reading | Convention | Matches where Chrome's Energy Saver starts. Below it only the viewport and near lanes read, and the report keeps the rest as pending. |
| `FAST_MS_PER_K` | 400 ms per 1000 chars | `lib/capture/pace.ts:37` | Line between fast and mid | Measured | Placed between M4 GPU (~200) and M4 CPU (~1000). Decides 0.5 or 1/3 duty. |
| `SLOW_MS_PER_K` | 2000 ms per 1000 chars | `lib/capture/pace.ts:38` | Line between mid and slow | Judgement | No device measured near it. Above 2400 (with hysteresis) a web page's background lane stops entirely. |
| `HYSTERESIS` | 0.2 | `lib/capture/pace.ts:40` | Margin before a speed changes class | Judgement | Fast→mid at 480, mid→slow at 2400, back at 320 and 1600 ms/K. |
| `OUTLIER` | 6 × the pace | `lib/capture/pace.ts:42` | One much slower batch is ignored | Judgement | Covers a model reload after idle unload; a second slow batch in a row is accepted. |
| Smoothing weights | 0.5 for the first 3 samples, then 0.2 | `lib/capture/pace.ts:105` | Moving average of ms per 1000 chars | Judgement | Batches are timed by wall clock in `send()`, so queueing behind other tabs' work inflates the pace. |
| Seeds | 600 before anything is known; GPU 250, CPU 1000 ms/K | `lib/capture/pace.ts:52, 57` | Pace before the first measurement | Measured | The device seeds match the M4 figures in `pace.ts:35-36`; 600 is a guess between them (mid → duty 1/3). |
| `quiet()` + `READER_INPUT` | clamp(2 × ms/K, 500, 5000) ms after wheel, scroll, keydown, pointerdown or touchstart | `lib/capture/pace.ts:124, 131` | Wait after reader input before background work | Judgement | 0.5 s on a GPU, 2 s on a CPU. Steady scrolling starves the background lane by design. |
| `SESSION_MS` | 10 min of engine time | `lib/capture/pace.ts:50` | Background budget per document | Judgement | After it only near and viewport read; a route change resets it (`orchestrator.ts:1447`). Bounds how much of a long page or feed is read ahead. |
| `BATCH_MS` / `MAX_BATCH_CHARS` | 1000 ms / 4000 chars | `lib/capture/pace.ts:46-47` | Batch size for a fast engine | Judgement | Only the PDF reader uses `pacer.budget()`; web pages use `LANE_BATCH_CHARS` (6000). |

### Scroll, fling and jumps

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `READING_SCREENS_PER_SECOND` | 2 screens/s | `lib/capture/fling.ts:15` | Speed above which on-screen lanes hold | Judgement | Reasoned, not measured ("prose read in a minute, skimmed in seconds"); tested at 3.5 screens/s. Lower values hold the viewport lane during ordinary scrolling. |
| `SETTLE_MS` | 150 ms | `lib/capture/fling.ts:17` | Hold after the last fast sample | Judgement | Adds up to 150 ms to the first chip after a fling. Longer leaves the engine idle once the reader has stopped. |
| `SAMPLE_MS` | 200 ms | `lib/capture/fling.ts:19` | Largest gap between two scroll events still read as one speed | Judgement | Stepped scrolls with events more than 200 ms apart never count as flings. |
| Jump pulse delay | 350 ms | `lib/capture/orchestrator.ts:545` | When the chip flashes after a smooth scroll | Judgement | A fixed guess at smooth-scroll duration, so a long jump may pulse before it lands. |
| `FLASH_PULSE_MS` × `FLASH_PULSES` | 800 ms × 2 | `lib/render/badge.css.ts:31-32`; timer `lib/render/badge.ts:588` | Pulse, and how long the marks stay active | Judgement | The stylesheet and the timer read the same two constants. Under reduced motion the outline and tint still last 1.6 s. |
| `JUMP_WAIT_MS` | 5000 ms | `lib/capture/orchestrator.ts:88` | How long a report jump waits for its page to be drawn | Judgement | PDF reader only (`revealPage`). A slower redraw drops the jump silently. |
| `JUMP_MATCH_CHARS` | ≥40 chars; first 80 chars compared | `lib/capture/orchestrator.ts:89, 778` | Finding a regrouped paragraph after a jump | Judgement | Too short could land on another paragraph with the same opening. |

### Main-thread slicing and walks

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `SLICE_MS` | 8 ms | `lib/slices.ts:17` | Walk time, and every other sliced task's (`finishInSlices`), before yielding to the page | Measured | On a 20 000-row table the longest task fell from 1064 ms to 129 ms (the page's own: 136 ms; commit bc42958). Budget H guards it. |
| `yieldToMain` fallback | `setTimeout(…, 0)` | `lib/slices.ts:39` | Yield where `scheduler.yield` is missing | Platform | Nested timeouts can clamp to 4 ms, so sliced walks take longer in browsers without `scheduler.yield`. |
| `MAX_SCAN_ROOTS` | 10 walks per burst | `lib/capture/orchestrator.ts:1862` | Merging a burst's dirty roots | Measured | On dev.to, 200 roots cost 1.4–2.0 s; one shared walk cost 40 ms. Derived from one 11 000-element page; larger pages may want fewer. |
| Scan-root climb | one level above each dirty node | `lib/capture/orchestrator.ts:1887` | Context a re-walk includes | Measured | Walking per post was worse on Wikipedia (1.18 s against 0.77 s of scripting). |
| Stale-claim rounds | ≤4 | `lib/capture/orchestrator.ts:1378` | Re-scan rounds after invalidations | Safety | Units still stale after four rounds stay unread until the next mutation. |
| `URL_REFRESH_DEBOUNCE_MS` | 300 ms | `lib/capture/orchestrator.ts:83` | Collapses bursts of route changes | Judgement | Adds 300 ms before a SPA route's new paragraphs are collected. |
| Address rewrites | purge only, no walk | `lib/capture/orchestrator.ts:1432` | How `replaceState` is answered | Measured | Discourse caused 51 whole-page re-walks and 1058 layouts in 90 s before this. |

### Observers and mutation handling

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `DRAIN_DEBOUNCE_MS` | 250 ms | `lib/capture/observers.ts:54` | Trailing debounce before a mutation drain | Judgement | The floor on chip latency for new content (chat messages, infinite scroll). |
| `DRAIN_MAX_WAIT_MS` | 1000 ms | `lib/capture/observers.ts:59` | Forced drain on a page that never stops mutating | Judgement | Not a hard bound: the wait is max(1000, spacing) and never ends before the last drain + spacing. Budget B's 1500 ms wait between bursts relies on it. |
| `DRAIN_COST_SPACING` | 19 × the last drain's cost | `lib/capture/observers.ts:70` | Keeps drains to 1/20 of the main thread | Measured | On the Reddit-like fixture the last-minute share fell from 9 % to under 5 %. Validated on one fixture only. |
| `DRAIN_MAX_SPACING_MS` | 5000 ms | `lib/capture/observers.ts:75` | Ceiling on drain spacing | Judgement | Drains dearer than ~263 ms exceed the 1/20 share. On such pages new text may wait 5 s. |
| Drain-cost memory | max(cost, previous / 2) | `lib/capture/observers.ts:291` | How fast spacing relaxes after a dear drain | Judgement | One stalled or GC-hit drain is halved away drain by drain. |
| `ATTR_RESCAN_MIN_MS` | 1500 ms (+20 ms slack) | `lib/capture/observers.ts:81, 210` | Attribute-driven rescans of one element | Judgement | Changes are deferred, not dropped: a reveal that follows another change within 1.5 s is read up to 1.5 s late. |
| `MOST_HELD` | 10 000 nodes | `lib/capture/observers.ts:89` | Most changed nodes held for one drain | Safety | Past it the next drain walks the whole page. Trades memory held for one full walk. |
| `WATCHED_ATTRS` | class, style, hidden, open, aria-hidden, aria-expanded | `lib/capture/observers.ts:94` | Attributes that dirty a subtree | Judgement | Class and style churn on feeds drives most drains (DEVELOPMENT.md, open work). |
| Quiet-text rule | same word count before and after | `lib/capture/observers.ts:489` | Text changes that need no walk | Judgement | Counters and timestamps skip walks. An edit that keeps the word count is still rechecked against its owning unit. |

### Gates, cache and backend

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `HYDRATION_MARKERS` | 11 selectors (Next, Docusaurus, Gatsby, Nuxt, Astro, SvelteKit, Angular, React ≤17) | `lib/capture/insertionGate.ts:20` | Pages whose chips wait for hydration | Measured | React #418 appeared on jestjs.io 3/3 runs and nextjs.org 2/2; none with the gate. Unlisted frameworks draw immediately. |
| `HYDRATION_IDLE_MS` + fallback | idle timeout 1200 ms after load; else 200 ms | `lib/capture/insertionGate.ts:36, 132` | When a hydrating page's gate opens | Judgement | Scoring is not gated; only painting waits. |
| `HYDRATION_MAX_MS` | 2500 ms | `lib/capture/insertionGate.ts:40` | Longest delay for chips on server-rendered pages | Judgement | Bounds what a reader waits for on framework sites. Static pages are unaffected (first chip 232 vs 237 ms). |
| `DOWN_POLL_MS` | 5000 ms | `lib/capture/orchestrator.ts:85` | Re-probe interval while the engine is down | Judgement | Each frame polls on its own; recovery shows up to 5 s late. |
| `L1_MAX_ENTRIES` | 2000 entries, LRU | `lib/capture/cache.ts:21` | Per-frame verdict cache | Safety | An evicted text costs a worker round trip of a few ms. Max age is `SCORE_CACHE_MAX_AGE_MS` (`lib/cachePolicy.ts`, another area). |
| `MIN_SHARE_RELIABLE` / `MIN_SHARE_UNSURE` | 85 % / 90 % | `lib/capture/langGate.ts:16-17` | Top-language share for a local "not English" verdict | Judgement | Lower values settle more mixed paragraphs without the engine, changing the report's notEnglish count. |
| `MAX_ENGLISH_SHARE` | 10 % | `lib/capture/langGate.ts:19` | English share that sends a paragraph to the engine | Judgement | Pairs with the shares above; the engine's fastText stays authoritative. |
| Detection sample | first 2000 chars | `lib/capture/langGate.ts:34` | Text given to the browser's language detector | Judgement | A long paragraph is judged by its opening. |
| Page-kind sample | first 64 units | `lib/capture/orchestrator.ts:338` | Units the statistics' page kind is judged from | Judgement | Changes how reading statistics classify a page (`lib/stats`, another area). A literal beside `SAMPLE` (`lib/stats/pageKind.ts:43`). |

### Long texts and request slicing

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `PASS_TOKENS` | 510 tokens | `lib/capture/windows.ts:44` | Text tokens per model pass | Model | 512 less two special tokens. |
| `WINDOW_CHARS` | 1800 chars | `lib/capture/windows.ts:41` | One pass of text, the grouping target | Measured | Tokenizer: prose runs 4.3–5.0 chars per token; 1800 fits one pass down to 3.53. |
| `SNAP_TOKENS` | 32 tokens | `lib/capture/windows.ts:52` | How far a half edge moves to reach a sentence start | Judgement | About one English sentence. Passes are planned 64 tokens short of 510. |
| `fitsWithoutCounting` | ≤510 UTF-8 bytes (pre-check ≤2040 chars) | `lib/capture/windows.ts:67` | Texts that skip the token-count round trip | Model | BPE never makes more tokens than bytes. Longer texts wait for a count before scoring. |
| `JOINT_REACH_CHARS` | 300 chars | `lib/capture/windows.ts:150` | Cut snaps to a paragraph joint | Judgement | Keeps merged short paragraphs whole within a half. |
| `MAX_READ_CHARS` | 201 600 chars | `lib/capture/windows.ts:79` | Most of one text read; a unit's cost in the scheduler | Safety | `MAX_UNIT_TEXT_CHARS` + `WINDOW_CHARS`. Text past it is reported as unread and gets no mark. |
| `MAX_WINDOWS` | 400 passes | `lib/capture/windows.ts:87` | Passes per text | Safety | Derived: about 362 halves for the densest text at the cap. |
| `MAX_BLOCK_CHARS` | 4000 chars | `lib/capture/windows.ts:95` | Hard cap on one block on the wire | Safety | The engine refuses blocks over 16 000 chars and fails the whole request. |
| `REQUEST_BLOCKS` / `REQUEST_CHARS` | 64 blocks (`DOCUMENT_SHARE.blocks` / `PAGE_IN_FLIGHT`) / 48 000 chars | `lib/capture/windows.ts:108-109` | Size of one scoring request | Safety | The blocks are derived, so the batches in flight fill the page's share exactly. The characters are a literal: 4×48 000 < 250 000. |

### Chips and cards

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Chip entrance and colour transition | none | `lib/render/badge.css.ts:82` | Animation when chips appear or change | Measured | Fades took about a third of Anagram's cost on a feed. Budget G fell from 9–10.7 % to 6.3–7.5 % without them. |
| Inline climb depth | ≤12 ancestors | `lib/render/badge.ts:789` | Climb out of inline wrappers to place a chip | Safety | Bounds the walk up from the last text node. |
| `CLIP_BOX_LEVELS` | 6 levels | `lib/render/badge.ts:820` | How far up a "see more" box is searched | Judgement | LinkedIn's box is 1 level up, Goodreads' 2. Deeper boxes are page layout. |
| `CLIP_MIN_HIDDEN_PX` | 32 px | `lib/render/badge.ts:880` | Hidden overflow that counts as clipped text | Judgement | Less is a shadow or descender. A Steam card hid 108 px, which had left 25 chips out of sight. |
| `CLIP_MAX_VIEWPORT_SHARE` | 0.9 × viewport height | `lib/render/badge.ts:878` | Excludes the page's own scrolling regions | Judgement | A box taller than this never parks chips. |
| `POST_SELECTOR` | article, [role=article], [role=link], main, body | `lib/render/badge.ts:817` | Boundary a parked chip may not leave | Measured | Not stopping at blockquote or li fixed 2 of 150 Goodreads chips hidden in clipped boxes. |
| Clip-group flush | next frame, or a 50 ms timer | `lib/render/badge.ts:208-211` | Batched re-placement of clipped chips | Measured | Batching cut extra layouts from 443 to 229 on 60 cards. The 50 ms timer keeps hidden tabs correct. |
| Hover-card timing | shown after 60 ms, fade 130 ms, hidden after 190 ms | `lib/render/badge.css.ts:172-188` | Card visibility on hover | Judgement | The 190 ms hide delay lets the pointer cross into the card. Reduced motion removes the fade. |
| Selection floor | `MIN_WORDS` (50 words) | `lib/render/selectionCard.ts:206` | Selections too short to score | Judgement | Same floor as paragraphs, so a selection and its paragraph agree. |
| Selection scoring path | viewport priority; no L1 cache or language gate | `lib/render/selectionCard.ts:235` | How "Analyze selection" is sent | Judgement | Non-English selections always cost an engine round trip. |

### Card readout, flagging and theme

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `DEFAULT_FLAG_FROM` | "heavy" (level 2) | `lib/render/flagLevel.ts:9-10` | Lowest word that counts as flagged | Judgement | The user's choice: "heavily edited" is right under a third of the time. Drives flagged counts, the toolbar badge, the list and underlines. User-settable. |
| Confidence model | logistic; intercept, per-level and shared slopes, input ranges | `lib/render/confidence.ts:22-39` | Chance the shown word is right | Measured | Fitted on the EditLens validation split; calibration error 0.044 / 0.037 / 0.041 on the test, Enron and Llama sets. |
| `SHORT_TOKENS` | 100 tokens | `lib/render/confidence.ts:57` | Length below which confidence falls | Model | About the model's 75-word training minimum. |
| `SHORT_SLOPE` | 0.37 per ln(tokens) | `lib/render/confidence.ts:58` | Short-text confidence penalty | Measured | 95th percentile of 200 bootstrap fits; leaves a gap of 0.001–0.009 on the test split. |
| `UNSURE_BELOW` | 0.5 | `lib/render/dist.ts:17` | When the card says "Unsure: close to …" | Judgement | Changes card text only, never counts. |
| `DARK_LUMINANCE` | 0.15 WCAG luminance (alpha ≤0.1 = unpainted; ≤8 ancestors) | `lib/render/theme.ts:48, 50, 61` | Dark or light chip and mark palette | Judgement | ≈0.42 sRGB-encoded. Highlights switch per page, chips per anchor. |

### Highlights

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `NEAR_MARGIN` | `"100% 0px"` | `lib/render/highlight.ts:141` | Marks registered within one screen; the rest parked | Measured | 50 off-screen marked paragraphs cost +0.8 s per 10 s. Registering only on-screen marks saved 50–100 ms/min but drew them a frame late. |
| Parking with a locator | off where a surface locates ranges | `lib/render/highlight.ts:473` | PDF reader and surfaces register everything drawn | Judgement | Their drawn layers already bound what is registered. |
| Underline threshold | `flagLevel(flagFrom)`; 0 when underline scope is "all" | `lib/capture/orchestrator.ts:593`; `lib/render/highlight.ts:439, 445` | Which stretches are underlined | Judgement | By default only heavily edited and AI-generated stretches. User-settable. |

### Surfaces and entry points

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MIN_FRAME_AREA` | 40 000 px² | `lib/dom/frameGate.ts:7` | Smallest subframe that is read | Judgement | Below it nothing in the frame is read, counted or recorded in statistics, and its stub never asks for the content script. |
| `MIN_FRAME_WIDTH` | 200 px | `lib/dom/frameGate.ts:6` | Narrowest subframe that is read | Judgement | Narrow chat or comment frames start only once resized past it. |
| Frame text before the content script | `MIN_WORDS` (50) characters other than white space, or a shadow root | `entrypoints/frame.content.ts:35`; `lib/dom/frameGate.ts:21` | When a subframe's stub asks the worker to inject the 240 KB content script | Safety | An upper bound: every word holds such a character, so no frame with a readable paragraph is passed over. Text in a shadow root is not counted; any root asks. 12 ad frames: page-thread CPU 36–43 → 30–34 ms, their own process's heap 12.9 → 8.5 MB, first chip 215–235 → 208–214 ms (2026-10-09, M4, `perf-matrix` startup). |
| `RECOUNT_MS` | 500 ms | `entrypoints/frame.content.ts:16` | How long after a change a waiting frame's text is counted again | Judgement | A frame that fills in later is read up to half a second later than its change. |
| `TOP_HOST_TIMEOUT_MS` | 1000 ms | `entrypoints/content.ts:36` | Wait for the worker to name the tab's host | Judgement | The fallback is the referrer, then the frame's own host, so the wrong site rule may apply. |
| Shadow event name | 20 random letters per document | `entrypoints/shadow.content.ts:61` | Name of the attachShadow event | Safety | Prevents pages from listening for, or faking, Anagram's event. |
| `TALLER` | 1.25 × median line height | `lib/surfaces/lineLayer.ts:70, 85` | Heading lines on Drive and pdf.js surfaces | Judgement | Feeds the PDF reflow (another area). |
| `BASELINE` / `GLYPH` | 0.8 / 0.75 of the line box | `lib/surfaces/lineLayer.ts:72-73` | Line geometry given to the reflow | Judgement | Wrong shares shift column and heading decisions downstream. |
| `CHIP_GAP` (line layer) | 0.006 × page width | `lib/surfaces/lineLayer.ts:75` | Chip distance from the line's end | Judgement | Scales with zoom because positions are percentages. |
| Reserved chip sizes | 54 px single, 80 px group, 22 px high | `lib/surfaces/lineLayer.ts:77-79` | Collision checks for chip slots | Judgement | The real chip width varies with locale and number, so a wide chip can still overlap print. |
| Kindle chip | gap 4 px, width 54 px | `lib/surfaces/kindle.ts:19-20` | Keeps the chip inside the page | Judgement | Layer structure measured on one public sample (2026-09). The 54 px duplicates `lineLayer.ts:77`. |

### Toolbar menu and report

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `REPORT_PAGE_SIZE` | 50 entries | `lib/capture/pageReport.ts:34` | Flagged entries per list page | Judgement | Larger pages cost more per poll, since the report is rebuilt every second. |
| Snippet length | 140 chars | `lib/capture/orchestrator.ts:440` | Text shown per flagged row | Judgement | Also the spoken name of each row. |
| `MIN_MIX` | 3 paragraphs | `entrypoints/popup/report.ts:44` | Read paragraphs before the colour mix shows mid-read | Judgement | Changes display only. |
| Menu refresh | every 1000 ms; engine and stats every 5th tick | `entrypoints/popup/main.ts:627-633` | Live counts while the menu is open | Judgement | Each tick rebuilds the page report in the tab. |
| Post-action re-read | 400 ms after a site switch; 1500 ms after Rescan | `entrypoints/popup/main.ts:511, 578` | When the menu asks again | Judgement | Fixed sleeps; the 1 s poll covers a slow page. |
| Download time-left estimate | 20 s window, ≥3 s span | `entrypoints/popup/main.ts:280-282` | The menu's model-download estimate | Judgement | The setup page uses 8 s / 1.5 s (`lib/ui/inBrowserEngine.ts:59, 64`), so the two estimates of one download can differ. |

### Settings engine cards

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Idle-unload choices | 5 min, 1 min, 15 min, never | `lib/ui/componentSettings.ts:120`; `lib/ui/inBrowserEngine.ts:111` | Options offered for unloading the model | Judgement | The same list in two files; the default lives with the engines (another area). |
| Engine status poll | 1 s busy, 15 s ready, 3 s otherwise | `lib/ui/componentSettings.ts:292`; `lib/ui/inBrowserEngine.ts:325` | Settings page refresh | Judgement | Duplicated in both cards. |
| Device probe timeouts | GPU adapter 3000 ms; UA hints and storage 2000 ms | `lib/ui/deviceInputs.ts:32, 66, 68` | Inputs to the engine choice | Judgement | A slow `requestAdapter` counts as no GPU, which can steer setup to another engine. |

### Paste page

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| File size cap | 1 MiB | `entrypoints/paste/main.ts:65` | Files accepted | Safety | Checked before decoding. |
| Text cap | 200 000 chars | `entrypoints/paste/main.ts:69, 77` | Text accepted | Safety | A literal that duplicates `MAX_UNIT_TEXT_CHARS` (`lib/dom/text.ts:139`). |
| Blocks per request | 4 | `entrypoints/paste/main.ts:94-96` | Request slicing | Judgement | Pages use 64 (`REQUEST_BLOCKS`). A long paste becomes many sequential round trips. Added in 0.5.0 without a stated reason. |
| Minimum length | `MIN_WORDS` (50 words) | `entrypoints/paste/main.ts:79-80` | Refusal floor and grouping floor | Judgement | The same as pages, so a paste and its page give the same units. |
| Whole-text verdict | length-weighted mean of unit probabilities | `entrypoints/paste/main.ts:128` | Headline verdict | Judgement | The maximum was rejected because it grows with length (`windows.ts:444-451`). |

### Performance budgets

These are the soft assertions in `test/pw/perf.spec.mjs`. `test/perf-kit.mjs` holds no budgets, only harness settings: long animation frames ≥50 ms are kept (`:21`), profiler sampling is 500 µs (`:80`), and a page counts as settled after 2000 ms with no new chip, at most 20 s (`:114`). "Recorded" values come from commit messages, the CHANGELOG and spec comments.

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Test viewport | 1100 × 850 px (E: 1200 × 900) | `test/pw/perf.spec.mjs:74, 314` | Screen size for every budget | Judgement | `ROOT_MARGIN` reaches 1.41 screens here; results do not carry over to taller screens. |
| A: first badge | < 4000 ms | `test/pw/perf.spec.mjs:114` | 3000-paragraph page | Measured | 283–382 ms recorded (July 2026): about 10× headroom. |
| A: worst startup long task | < 1000 ms | `test/pw/perf.spec.mjs:115` | Same page | Measured | 77 ms recorded: wide headroom. |
| A: badges after 10 screens | ≥60 | `test/pw/perf.spec.mjs:116` | Scoring keeps up while scrolling | Fitted | Count tied to this fixture (80-word paragraphs, 250 ms steps, fake host); no value recorded. |
| B: worst long task | < 500 ms | `test/pw/perf.spec.mjs:166` | 8 re-render bursts of 450 nodes | Measured | < 150 ms recorded: about 3×. |
| B: total long tasks | < 3000 ms | `test/pw/perf.spec.mjs:167` | Same | Measured | ~0.2 s recorded: about 15×. The 1500 ms gap between bursts assumes the drain constants. |
| C: heap growth | < 8 MB | `test/pw/perf.spec.mjs:210` | 2000 posts through a virtualized feed | Measured | 0.8 MB recorded: 10×. |
| C: chips and ranges | chips ≤ posts; 0 detached ranges | `test/pw/perf.spec.mjs:211-212` | Leaks | Safety | Pass/fail invariants. |
| D: `LAYOUTS_PER_CHIP` | 1.6 extra layouts per chip | `test/pw/perf.spec.mjs:226` | Clamped-card layouts against no extension | Fitted | 1.27 batched, 2.46 unbatched on this fixture. Set between the two, with 26 % headroom. |
| D: one chip per box | exactly 1, never 2 | `test/pw/perf.spec.mjs:303-306` | The clip-group rule | Safety | Invariant. |
| E: first page and first text | < 6000 ms each | `test/pw/perf.spec.mjs:364-365` | PDF reader opening a 30-page paper | Judgement | No measured value recorded. |
| E: lazy text layers and long task | < 30 of 30 layers at open; worst task < 1000 ms | `test/pw/perf.spec.mjs:366-367` | Opening cost | Judgement | No recorded values. |
| E: `MAX_LIVE_CANVASES` | ≤10 | `test/pw/perf.spec.mjs:320, 368` | Bitmaps kept after scrolling | Platform | pdf.js 6.4.299 keeps max(10, 2×visible+1) views. Tied to that version. |
| E: reflow and handoff | reflow < 400 ms total, < 200 ms per run; handoff < 500 ms | `test/pw/perf.spec.mjs:369-371` | Costs that grow with the document | Judgement | Added with "neither had a number on it"; no recorded values. |
| F: content-script share | < 5 % of the session (120 s by default, `:375`) | `test/pw/perf.spec.mjs:446` | Script CPU on long feeds | Measured | Reddit-like 3.1–3.6 %, X-like 0.7–1.2 % recorded. |
| F: mutation handling, last minute | < 6 % | `test/pw/perf.spec.mjs:447` | Cost growing with page length | Measured | Reddit-like 4.2–5.0 % recorded: close (1–1.8 points); 5.0 % beside another load. |
| F: worst long task | < 500 ms | `test/pw/perf.spec.mjs:448` | Feed sessions | Measured | Up to 176 ms recorded. |
| F: full rescans | 0 | `test/pw/perf.spec.mjs:449` | Accidental teardown and re-read | Safety | Invariant. |
| F: heap kept | X-like < 8 MB; Reddit-like < 8 KB per post (second half) | `test/pw/perf.spec.mjs:378, 380` | Memory on long feeds | Measured | 0.8–1.0 MB and 2.6–2.9 KB per post recorded. |
| G: added main-thread share | < 8 % | `test/pw/perf.spec.mjs:501` | Reddit-like feed, 60 s, against a plain browser | Measured | 6.3–7.5 % recorded on one M4 (2026-10-04), 5.8–7.4 % on 2026-10-10, 7.4–8.0 % with the reading log on: close. The plain browser's own time moves the share by up to a point between runs. |
| H: worst long task | < max(page's own, 50) + 50 ms | `test/pw/perf.spec.mjs:509` | 20 000-row table | Measured | 129 ms recorded against the page's own 131–136 ms: about 55 ms headroom. |
| I: added share | < 7 % | `test/pw/perf.spec.mjs:518` | Chat with a message every 300 ms, 30 s | Judgement | No whole-thread share recorded; drains alone took 0.23–0.35 s per 30 s. |
| I: long tasks | none ≥50 ms | `test/pw/perf.spec.mjs:519` | Same | Platform | The long-task API's own 50 ms threshold. Zero tolerance. |
| J: idle cost | < 20 ms script and 0 layouts in 30 s | `test/pw/perf.spec.mjs:535` | Page read and left open | Measured | Recorded as costing nothing (commit bc42958). Zero layout tolerance. |

### Findings

#### The most consequential parameters

1. **The viewport lane's one unit per batch, and one-unit batches on a processor** (`orchestrator.ts:68, 1261`). Together they set time to first chip (0.27 s instead of 0.69 s) and how long an on-screen paragraph waits behind other work. The CPU rule keys on the device kind, not the measured pace.
2. **`ROOT_MARGIN` 1200 px** (`observers.ts:79`). Sets how far ahead chips are ready, and so most of the unpaced engine load while scrolling. It is the main unmeasured value that bounds what a reader sees, and it is in pixels while `NEAR_MARGIN` is in screens.
3. **The background pace as a whole** (`DUTY`, battery ×0.5, `quiet()`, `SESSION_MS` 10 min, `LOW_BATTERY` 20 %, `pace.ts`). Together these set the CPU and battery cost of read-ahead and how much of a long page is read before the reader gets there. After 10 minutes, on a slow engine, or at 20 % battery, everything beyond the near margin stays "pending".
4. **`PAGE_IN_FLIGHT` 4** (`lib/contract.ts:36`). Both engines score one batch at a time, so the fourth waits behind three. `REQUEST_BLOCKS` is derived from it and `DOCUMENT_SHARE`, so raising it makes requests smaller rather than tripping the router.
5. **Drain pacing** (`DRAIN_COST_SPACING` 19, `DRAIN_MAX_SPACING_MS` 5 s, `MAX_SCAN_ROOTS` 10). These hold the cost of live pages (budgets B, F, I). They also bound how late new content is read: up to 5 s on expensive pages.
6. **`NEAR_MARGIN` 100 %** (`highlight.ts:141`). It trades Chromium's highlight revalidation cost (budget G) against marks drawn a frame late. It is backed by a measurement.
7. **`HYDRATION_MAX_MS` 2.5 s** (`insertionGate.ts:40`). On every Next, Nuxt or Astro page, chips may wait up to 2.5 s after scoring is done.
8. **`MIN_FRAME_AREA` / `MIN_FRAME_WIDTH`** (`frameGate.ts:6-7`). Smaller frames are not read, reported or counted in statistics at all.

#### Duplicates and contradictions

- The background batch is 6000 chars on web pages (`orchestrator.ts:61`) but at most 4000 chars and "one paragraph until measured" by the pacer (`pace.ts:46-47, 123`). Two background-batch policies exist, and web pages use the one that ignores the measured speed; the router then sizes engine batches by a third, its own measured pace (`router.ts:22-24`).
- The idle-wait literals differ: the prefetch uses 1500/400 ms (`orchestrator.ts:820-821`) and the insertion gate 1200/200 ms (`insertionGate.ts:131-132`).
- `PLACE_RETRY_MS` 1100 must exceed `PLACE_WAIT_MS` 1000. The two live in different files with no shared constant.
- Chip width 54 px is held twice: `kindle.ts:20` and `lineLayer.ts:77`.
- The paste page's 200 000-char cap is a literal copy of `MAX_UNIT_TEXT_CHARS`. It sends 4 blocks per request where pages send 64.
- Download time-left: the menu uses a 20 s / 3 s window (`popup/main.ts:280-282`), the setup page 8 s / 1.5 s (`inBrowserEngine.ts:59, 64`). The menu's comment says it estimates "as the setup page tells it".
- The idle-unload choices (`IDLE_CHOICES`) and the poll intervals (`POLL_MS`, 1/15/3 s) are shared by both engine cards (2026-10-10).
- `DEFAULT_SNAPSHOT` (`orchestrator.ts`) copies the fallbacks in `settings.ts`, so that the orchestrator's tests can mock the settings without them. They agree today.
- Margin units differ: `ROOT_MARGIN` is 1200 px and `NEAR_MARGIN` is one screen. On screens taller than 1200 px, marks are registered beyond the near lane's reach; on shorter ones, chips arrive for paragraphs whose marks are still parked.

#### Judgement values that deserve a measurement

`ROOT_MARGIN`; `LANE_BATCH_CHARS` near/background; `PAGE_IN_FLIGHT`; `PREFETCH_PASS`; `DUTY` (no measurement in the code, commits or CHANGELOG); `SLOW_MS_PER_K`; the `quiet()` clamp; `SESSION_MS`; `READING_SCREENS_PER_SECOND` and `SETTLE_MS` (reasoned, only tested at 3.5 screens/s); `DRAIN_DEBOUNCE_MS`, `DRAIN_MAX_WAIT_MS` and `ATTR_RESCAN_MIN_MS` (all from the initial commit); `HYDRATION_IDLE_MS` and `HYDRATION_MAX_MS` (only checked to remove the console error); `MIN_FRAME_AREA`; the language-gate shares; `DOWN_POLL_MS`; the device-probe timeouts (a 3 s GPU timeout steers engine choice). Most of these date from the 2026-06-30 initial commit.

#### Fixture-fitted values (overfitting risk)

- **`LAYOUTS_PER_CHIP` 1.6** (budget D) sits between the two variants measured on one 60-card fixture (1.27 and 2.46).
- **Budget A's "≥60 badges after 10 screens"** depends on paragraph length, step timing and the fake host.
- **`DRAIN_COST_SPACING` 19** was validated only on the Reddit-like fixture. **`MAX_SCAN_ROOTS` 10** was derived from a single dev.to page of 11 000 elements.
- **Budget G's 8 %** was set just above 6.3–7.5 % on one M4.
- **Budget B's 1500 ms gap between bursts** is tied to the drain constants: raising `DRAIN_MAX_WAIT_MS` past ~1250 ms would merge bursts and change what B measures.
- **Surface geometry:** the Webnovel surface's structure is modelled from a fixture (`test/fixtures/surfaces/webnovel-chapter.html`), because the live site returns a challenge. The Kindle chip offsets come from one public sample.

#### Comments that no longer match the code

- `observers.ts:57-58` says the drain is forced once dirt has waited `DRAIN_MAX_WAIT_MS`. The code waits max(1000, spacing), up to 5 s.

#### Headroom of the performance budgets

See [Performance budgets: headroom on 2026-10-10](#performance-budgets-headroom-on-2026-10-10), which sets each budget against the values measured that day.

## Area 3: Model, scoring and engines

This area takes a paragraph's text from the content script and returns the verdict for it. It covers the score contract and the four-word scale (`lib/contract.ts`, `lib/render/scale.ts`), and the shared scoring pipeline: cleaning, tokenizing, truncating, batching, softmax and rounding. Both engines run that pipeline: the local Python engine (`anagramd/`, reached over Native Messaging) and the in-browser ONNX Runtime Web engine (`lib/webengine/`). The area also includes the service-worker router and score cache (`lib/backend/`), engine and tier selection (`lib/device.ts`), transports, retries and crash recovery, model downloads, and the installers' pins. Every value below was checked on the `dev` branch on 2026-10-09. Paths are repo-relative.

### Verdict scale and score contract

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `BUCKET_COUNT` | 4 buckets | lib/contract.ts:30 | Length of `probs`; number of verdict words | Model | Fixed by EditLens's 4-way head; validated against health `n_buckets` (lib/backend/scoreProtocol.ts:57) and `config.num_labels` (anagramd/engine.py:247). |
| Score formula | Σ pᵢ·i / (BUCKET_COUNT−1), in [0,1] | lib/webengine/scoring.ts:121; anagramd/scoring.py:128 | The number on the chip and the input to `levelOf` | Model | This is EditLens's weighted-average decoding (Thai et al. §C.2). Statistics use `probs`, not this number. |
| `SCORE_CUTS` | 1/6, 1/2, 5/6 | lib/render/scale.ts:18 | Where human / lightly / heavily / AI-generated begin | Model | Midpoints between equal bucket centres. Not a setting. Moving a cut changes every word and underline. Statistics weight by probabilities, so they are unaffected. |
| Argmax `bucket` | first maximum of `probs` | lib/webengine/scoring.ts:115; anagramd/scoring.py:126 | `ScoreResult.bucket` | Model | Still computed and validated, but no reader outside lib/backend and lib/webengine uses it. The word comes from the score. |
| Probability and score rounding | 4 decimals, round-half-even | lib/webengine/scoring.ts:120-121; anagramd/scoring.py:127-128 | Precision of results on the wire | Convention | `pyRound` copies Python's `round` so the two engines agree to the digit. The cache keeps them as given (`toStored`, lib/backend/swCache.ts:102). |
| `spread` normaliser | (BUCKET_COUNT−1)/2 = 1.5 | lib/render/scale.ts:99 | Scales the bucket-index SD to the 0–1 "doubt" | Model | 1.5 is the largest possible SD (half on each end bucket). It feeds the "unsure" wording in lib/render/confidence.ts, which belongs to another area. |
| `nearestOtherLevel` tie-break | equal distance → lower word | lib/render/scale.ts:109 | Which alternative an unsure verdict names | Judgement | Only matters exactly midway between two cuts. |
| `SCALE_STEPS` | 3 | lib/render/scale.ts:79 | Number of `::highlight` names (steps 0..3) | Model | Equals BUCKET_COUNT−1, so four names. The name reads like a count of 3. |
| Placeholder result | bucket 0, probs 0.25×4, score 0 | lib/backend/router.ts:66; lib/webengine/engine.ts:743,759; anagramd/engine.py:433-444 | What degraded and unsupported results carry | Convention | `levelOf(0)` is "human". Any consumer that ignores the `degraded`/`unsupported` flags would count these as human. Degraded results are never cached; unsupported ones are. |
| `PROB_SUM_TOLERANCE` | 0.02 | lib/backend/scoreProtocol.ts:8 | Allowed drift of Σprobs in replies | Safety | Ten times the worst rounding drift (4×0.0005). The same 0.02 is repeated for statistics in lib/stats/wire.ts:93. |
| Reply schema caps | model id/ver/calibration ≤120 chars; token counts ≤1,000,000 | lib/backend/scoreProtocol.ts:25-27,127 | Rejecting malformed engine replies | Safety | A rejected score reply throws `ProtocolError`. The batch is not retried and becomes "Unavailable". |
| Contract major check | major of "3.0" must match | anagramd/contract.json:2; lib/contract.ts:16; anagramd/engine.py:36-37; lib/backend/scoreProtocol.ts:76 | Compatibility of extension and engine | Convention | On a mismatch, health reports "contract" (an update is offered). Both engines and the extension read the version from anagramd/contract.json. |

### Model input and scoring pipeline (both engines)

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MAX_LENGTH` / `max_length` | 512 tokens (2 special) | lib/webengine/scoring.ts:15; anagramd/runtime_adapters.py:354 | Model window per text | Model | RoBERTa position limit. Reported as health `max_tokens`. Raising it is impossible; lowering it cuts more text. |
| Truncation rule | first 511 ids + `</s>` | lib/webengine/scoring.ts:106; anagramd/scoring.py:116 | What an over-long text keeps | Model | The tail is never seen and `truncated` is set. The extension windows texts so this is rare (lib/capture/windows.ts, another area). |
| Planning window | MAX_LENGTH − 2 = 510 tokens | lib/webengine/scoring.ts:142; anagramd/engine.py:521 | `window` returned by the `tokens` op | Model | Used to cut long paragraphs into windows elsewhere. Must stay in step with MAX_LENGTH. |
| `BATCH_SIZE` / `batch_size` | 32 texts | anagramd/runtime_adapters.py:354; lib/webengine/scoring.ts:17 | Max texts per forward pass (native; web fallback) | Judgement | No measurement found. Router batches of ≤6000 chars rarely reach 32. Results do not depend on batch size. |
| `PASS_TOKENS` (native) | 24 tokens | anagramd/scoring.py:13 | Fixed cost per pass in the padding/pass DP | Measured | Fitted to MLX timings on an M4 (4.3 ms/pass, 0.2 ms/token). Affects speed only. Not measured for CUDA or ONNX CPU. |
| `SESSION_BATCH` | WebGPU 4, WASM 8 texts | lib/webengine/session.ts:67 | Texts per pass in the browser | Measured | M4: on WebGPU, 4 texts keep 0.3 GB of GPU buffers versus 0.6 GB for 8. On the CPU, 8 is 6% faster than 4. Speed and memory only. |
| `PASS_TOKENS` (web) | WebGPU 24, WASM 40 tokens | lib/webengine/session.ts:74 | Pass cost by provider | Measured | M4: GPU 12 ms/pass and 0.5 ms/token; CPU 110 ms and 2.7 ms. Fitted on one machine. |
| Cleaning (`clean_text`) | demojize, cut `</think>`, drop chatbot first line, lowercase, collapse spaces | anagramd/engine.py:78-114; lib/webengine/clean.ts:18-51 | The exact string the model reads | Model | Copies EditLens preprocess.py. A human text whose first of several lines starts "Here", "Sure", "Title" and so on loses that line. |
| `SUPPORTED_LANGUAGES` | ["en"] | anagramd/contract.json:5 (anagramd/engine.py:51; lib/contract.ts:19) | Which texts are scored at all | Model | EditLens is English-only. Other texts return `unsupported`, which statistics count as "not English". |
| Language gate rule | fastText lid.176 top-1, threshold 0.0, no minimum probability | anagramd/engine.py:148,455; lib/webengine/engine.ts:741-742 | Gating between en and unsupported | Measured | An "en" guess at any confidence is scored, and a non-en guess at any confidence is refused. On the web benchmark's English pages (2026-10-09, 23,314 paragraphs of 50 words or more), 0.20% got a non-English guess, and none of them was English prose: foreign comments and patent claims (p ≥ 0.84), name lists and code. Requiring 0.5 to skip would have recovered no English prose and scored 10.7% more of WebMainBench's non-English Latin-script paragraphs; 0.8, 23.6% more. Mixed-language paragraphs are the one English loss (2 units). Both engines' fastText agree to 1.8e-7. |
| `dtype "auto"` | maps to FP32 | anagramd/engine.py:234 | Torch precision when unspecified | Judgement | Matches the "FP32 is automatic" policy. FP16 on CPU is refused. |
| Torch warm-up text | "warm-up paragraph " × 40 | anagramd/engine.py:286 | First pass at EditLens construction | Judgement | Only runs when `warmup=True`. Controller activations warm up with `paragraph()` instead (runtime_controller.py:716). |
| `paragraph()` sample | 120 words of fixed English sentences | anagramd/runtime_controller.py:161 | Warm-up and benchmark workload | Judgement | The docstring says the samples do not measure accuracy. Benchmark latency depends on this length. |
| In-browser warm-up pass | one 8-token row | lib/webengine/session.ts:215 | Shader compile; proof that a session runs | Judgement | If this pass fails for FP16, FP16 is abandoned permanently (see `fp16_failed`). |
| MLX buffer cache limit | 1 GiB | anagramd/runtime_adapters.py:297 | Freed GPU buffers MLX keeps | Measured | The comment says "a gigabyte costs no measurable speed"; the default would keep most of RAM. |
| `disable_prepacking` (WASM) | "1" | lib/webengine/session.ts:205 | ORT weight repacking on CPU | Measured | Saves 0.5 GB that is never returned, at a cost of 2–8% speed. |
| `wasmThreads()` | min(8, cores−2); 1 if not cross-origin isolated | lib/webengine/session.ts:157-158 | CPU-provider threads | Measured | M4: 8×512 tokens took 10.7 s on 8 threads, 14.4 s on 4 and 10.1 s on 10. Isolation comes from wxt.config.ts:332. Results do not depend on the count. |
| `graphOptimizationLevel` | "all" | lib/webengine/session.ts:200 | ORT graph rewrites | Convention | Parity with the official probabilities was checked by test/webengine/parity.mjs. |
| WebGPU adapter policy | high-performance; software/fallback adapter refused | lib/webengine/session.ts:127-130 | Whether the GPU path is offered | Judgement | The comment says SwiftShader is "far slower than the CPU provider", with no figure. |
| `EMBEDDING_BYTES` | 50,265×1024×4 B ≈ 206 MB (FP16: half) | lib/webengine/session.ts:54,81 | Minimum `maxStorageBufferBinding`/`maxBufferSize` for WebGPU | Model | WebGPU's default limit is 128 MiB, so the adapter's maximum is requested. Defined in `lib/device.ts`, which TIERS `maxTensorBytes` uses too. |

### Local engine (anagramd)

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `preference_rank` | torch-CUDA < MLX < torch-MPS < ONNX-CUDA < ONNX-CPU < torch-CPU; FP32 only | anagramd/runtime_controller.py:93-114 | Automatic runtime choice | Judgement | FP16 and INT8 are only explicit Settings choices. Each runtime gets its own model `ver`, so its cache and statistics provenance are separate. |
| `build_plan` "recommended" order | MLX > torch GPU > ONNX GPU (FP32) > ONNX CPU > torch CPU | anagramd/model_plan.py:243-259 | Which weights are downloaded | Judgement | A Mac downloads MLX safetensors only, so there is no fallback runtime installed when MLX crashes (CHANGELOG ~380). This ordering is separate from `preference_rank`. |
| Default model profile | "recommended" | anagramd/native_component.py:34 | Download set (versus "expanded") | Judgement | The "expanded" profile is only reachable from the terminal. |
| `STARTUP_CRASH_LIMIT` | 2 deaths | anagramd/runtime_controller.py:68 | When a crashing runtime is passed over | Judgement | Counts process deaths before the first scored batch. Choosing the runtime again resets the count. |
| Crash fallback target | ONNX CPU FP32 first | anagramd/runtime_controller.py:124-133 | Runtime after a pass-over | Judgement | Measured slower than in-browser WASM (lib/device.ts:10-11), but considered least likely to crash. |
| Idle unload default | 300 s; allowed 0 or 60–86,400 | anagramd/native_component.py:33; lib/webengine/engine.ts:54 | Seconds idle before the model is freed | Judgement | User setting: 5 min, 1 min, 15 min or never (lib/ui/componentSettings.ts:120). The range is validated in about 7 places. |
| Idle check period | 1 s | anagramd/runtime_controller.py:292; lib/webengine/engine.ts:29 | Resolution of the idle unload | Judgement | Cost is negligible. |
| `score_wait_timeout` / `wake_and_wait` | 25 s | anagramd/native_component.py:173; anagramd/runtime_controller.py:331 | How long a score waits for a loading model | Judgement | Kept below the extension's 30 s so the engine answers first. Longer cold loads give "not ready" (retried once). Starting is polled every 0.02 s (`STARTING_POLL_S`, :30). |
| `stop_timeout` | 30 s (=`QUEUE_TIMEOUT_S`) | anagramd/native_host.py:321 | Wait for inference to drain before stop or download | Judgement | After it expires the call returns `not_ready` (503). |
| Startup verification | size only; pinned hash trusted | anagramd/native_component.py:357-369 | Integrity check at every start | Judgement | Files are hashed during download. Later on-disk corruption is not caught, and the model `ver` uses the remembered pin digests. |
| Benchmark budget | 10–30 s; the UI always sends 30 | lib/backend/nativeProtocol.ts:61; lib/backend/runtimeClient.ts:10; anagramd/runtime_controller.py:605 | Total measurement time across candidates | Judgement | Shared evenly per workload. A comparison never changes the selection. |
| `max_runs` | 20 timed runs per workload | anagramd/runtime_controller.py:224 | Benchmark samples | Judgement | "Sufficient" needs ≥3 samples (:878). RSS is sampled every 50 ms (:197). |
| Benchmark workloads | batch 1 and 8; "fastest" = lowest batch-1 latency | anagramd/runtime_controller.py:918,761 | Which runtime is labelled fastest | Judgement | Real batches are up to 6000 chars, which is neither workload. "Fastest" may be FP16/INT8, but it is never auto-selected. |
| Benchmark worker timeout | 180 s per candidate | anagramd/benchmark_worker.py:30 | Kills a hung comparison process | Safety | Independent of the 30 s budget. |
| `MAX_REQUEST_BYTES` (host) | 2 MiB | anagramd/native_host.py:26 | Largest frame accepted from the browser | Safety | The extension never sends more than 1,000,000 B (`MAX_NATIVE_BYTES`), so the extension's cap is the one that binds. |
| `MAX_RESPONSE_BYTES` | 1 MiB − 1 KiB | anagramd/native_host.py:27; lib/webengine/protocol.ts:27 | Largest reply | Platform | Chrome limits host→browser messages to 1 MB. A larger reply becomes 413 for the whole batch. The in-browser copy exists only for parity. |
| `MAX_PENDING_SCORES` / `_TOKENS` | 8 each | anagramd/native_host.py:28-29; lib/webengine/engine.ts:22 | Queued requests per lane before "busy" (409) | Judgement | Each lane runs one batch at a time (native_host.py:155). The router sends at most 4. |
| `QUEUE_TIMEOUT_S` / `MOST_QUEUE_WAIT_S` | 30 s; 30 s × 8 = 240 s | anagramd/native_host.py:33, :36 | Drops queued work the browser has abandoned | Judgement | The extension times a request from its turn in its lane, so one may wait behind 8 others of 30 s each and still be wanted. The 25 s wake wait counts inside the extension's 30 s. |
| Request limits | 256 blocks; 16,000 chars/text; 512 token texts; 256,000 token chars; id ≤64 | anagramd/contract.json:6 (anagramd/engine.py:52-56; lib/access/messages.ts:30); lib/webengine/protocol.ts:28-32 | Validation of score and tokens payloads | Safety | One bad block fails the whole batch with 422 (not retried). Every copy reads `contract.json`; the page's count requests are cut to the same limits (`lib/messaging/client.ts`). |
| Maintenance helper limits | 1200 s timeout; ≤64 KiB output | anagramd/native_component.py:750,756 | Component update and uninstall helper | Safety | Applies only to updates and uninstalls. |
| Error text cap | 2000 UTF-16 units | anagramd/runtime_controller.py:90; lib/backend/nativeProtocol.ts:35 | Error message length | Safety | Longer messages make the reply invalid on the extension side. |

### In-browser engine and device selection

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `TIERS[fp32].bytes` | 1,425,459,555 B | lib/device.ts (`downloadBytes`) | Disk needed for FP32 | Model | model.onnx + tokenizer.json, summed from modelkit.json through `pinnedFiles`. |
| `TIERS[fp16].bytes` | 714,899,390 B | lib/device.ts (`downloadBytes`) | Disk needed for FP16 | Model | model_fp16.onnx + tokenizer.json, summed the same way. |
| FP32 `minMemoryGb` | 4 GB | lib/device.ts:94 | Smallest `deviceMemory` that runs FP32 | Measured | Peak 2.8 GB on GPU and 1.9 GB on CPU (M4). Chrome rounds `deviceMemory` down to a power of two. |
| FP16 `minMemoryGb` | 4 GB | lib/device.ts:95 | Smallest memory for FP16 | Judgement | The 1.6 GB peak is measured; the threshold is not. 2 GB devices are refused even though 1.6 GB might fit. |
| "tight" at exactly 4 GB | prefer FP16, else FP32 with a slow-down note | lib/device.ts:178,186 | Tier choice on 4 GB devices | Judgement | This is the main route to FP16, which changes verdicts on 0.18% of texts. Statistics see a different model id. |
| Unknown memory/disk | treated as fitting | lib/device.ts:169,173 | Firefox and Safari (no `deviceMemory`) | Judgement | These browsers never get "short on memory" and can fail later at load. |
| FP16 eligibility | only where FP32 does not fit; WebGPU + `shader-f16`; INT8 never | lib/device.ts:88-91,180 | Precision of in-browser verdicts | Measured | Same word as FP32 on 99.82% of the EditLens test split (6,100/6,111). The user decided this on 2026-09-29. |
| `DISK_MARGIN` | 200 MB | lib/device.ts:100 | Free-disk slack beyond the model | Judgement | autoSetup.ts:116 checks room with no margin, and native staging uses 64 MiB per file. |
| `fp16_failed` | one failure abandons FP16 permanently | lib/webengine/engine.ts:342-358 | Retrying FP16 after a failed load or warm-up | Judgement | Falls back to FP32 on the CPU only (the GPU is marked unavailable). A transient GPU error therefore costs the GPU path for good. |
| Safari `gpuOnly` | CPU provider never offered | lib/webengine/assets.ts:25 | Safari without suitable WebGPU | Judgement | No stated measurement or reason. Without suitable WebGPU, Safari users get "terminal-only" or "cannot-run". |
| `MAX_PENDING_SCORES` (web) | 8 | lib/webengine/engine.ts:22 | Queued score requests before 409 | Judgement | Scores run one at a time (`scoreChain`). The transport times each from its turn. |
| `WAKE_TIMEOUT_MS` | 285 s | lib/webengine/engine.ts:28 | Score wait for a loading model | Judgement | The comment says a CPU load "takes minutes". Kept 15 s under `LOAD_WAIT_MS` so the engine's answer arrives first. |
| `LOAD_WAIT_MS` | 300 s | lib/webengine/client.ts:24 | Transport patience while the engine says "loading" | Judgement | Applies to the in-browser engine only. The native engine has no equivalent (25 s). |
| Safari `START_TIMEOUT_MS` | 20 s | lib/webengine/safariTab.ts:10 | Engine tab load and handshake | Judgement | — |
| Safari bridge probe | 3 s | lib/backend/safariBridge.ts:12 | Detecting the containing app's XPC bridge | Judgement | If it times out, only the browser engine is offered. |
| Warm-up trigger | main frame, http(s), not prerender, tab in front, granted and enabled site, in-browser engine idle or loaded | lib/backend/warmup.ts:43-52 | Preloading a model that was unloaded while idle | Judgement | Saves about 2 s on the first verdict (comment; `extension.mjs --warm`). Never used for the local engine. |
| `INLINE_BELOW` / `WINDOW` | 4096 B / 64 KiB | lib/webengine/onnx.ts:33-34 | Which tensors become external data; read window | Judgement | Affects memory and I/O only; it keeps 1.4 GB of weights out of WASM memory. |
| Tokenizer piece cache | 50,000 entries, cleared all at once | lib/webengine/tokenizer.ts:117 | BPE memoization | Judgement | Speed only. Not an LRU. |
| OPFS `CHUNK` | 8 MiB | lib/webengine/storage.ts:43 | Read/copy/hash chunk size | Platform | The comment says "one read of a gigabyte is refused by some implementations". |
| Worker request cap | 2 MiB | lib/webengine/protocol.ts:26 | Envelope size accepted by the worker | Safety | Mirrors native_host.py. |

### Transport, retries and health

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `RECONNECT_MS` | 1500 ms | lib/backend/transport.ts:9 | Minimum gap before reopening a closed port | Judgement | Also the health re-probe interval while down. It doubles into retry waits (below). |
| Default request timeout | 30,000 ms | lib/backend/portTransport.ts:253 | Every score/tokens/health/status call | Judgement | Scores and token counts are timed from their turn in their lane (`LANES`, :45), not from posting, so time waiting behind other batches does not count. |
| Pending cap | 64 per transport | lib/backend/portTransport.ts:264 | Requests outstanding before "busy" | Safety | Restart probes are exempt. |
| `CRASH_LIMIT` / `CRASH_WINDOW_MS` | 4 deaths / 120 s | lib/backend/portTransport.ts:31-32 | When the extension gives up restarting an engine | Judgement | Reset by any scored batch or Retry. After it trips, pages show "down until Retry", and statistics count those paragraphs as engine unavailable. |
| `RESTART_BACKOFF_MS` | 250 ms, doubling per death | lib/backend/portTransport.ts:34 | Delay before restarting a dead engine | Judgement | 250, 500, 1000 ms before the limit. |
| `RESTART_POLL_MS` / `RESTART_WAIT_MS` | 250 ms / 60 s | lib/backend/portTransport.ts:37-38 | Holding replayed work until the restarted model loads | Judgement | A load longer than 60 s sends the work anyway, and it is answered "not ready". |
| Restart status probe | 5000 ms | lib/backend/portTransport.ts:226,311 | Timeout of the internal "status" asks | Judgement | — |
| `REPLAYABLE` replay | once per request (score, tokens, health, status, runtime) | lib/backend/portTransport.ts:40,190 | Re-asking work lost in a crash | Safety | A second death fails the request with `engine_crashed`. |
| Router retry count | 1 retry per batch | lib/backend/router.ts:155 | Attempts before "Unavailable" | Judgement | If the retry also fails, the paragraphs are degraded. Statistics count them as "engine unavailable". |
| `RETRY_BACKOFF_MS` | 150 ms × (1+rand); +3000 ms after a closed port | lib/backend/retry.ts:6,24 | Wait before the retry | Judgement | Jitter spreads retries from many tabs. The 2×`RECONNECT_MS` waits out the reconnect and health gaps. |
| `TRANSIENT_STATUS` | 429, 502, 503, 504; 409 "busy" | lib/backend/retry.ts:5,12 | Which failures are retried | Convention | A 422 or protocol error is final, and the whole batch shows "Unavailable". |
| Health cache | 60 s when up; 1.5 s when down | lib/backend/nativeScoreClient.ts:56 | How often `health` is re-read | Judgement | A timeout resets it at once (:133-134). |
| Page→worker component timeout | 35,000 ms | lib/backend/nativeClient.ts:43 | Setup and Settings requests | Judgement | Deliberately above the 30 s transport timeout. |
| `MAX_NATIVE_BYTES` | 1,000,000 B | lib/backend/nativeProtocol.ts:5 | Largest request the extension posts | Safety | Stricter than the host's 2 MiB. Content→worker requests are capped at 900,000 B (lib/access/messages.ts:38). |
| Reply envelope caps | id ≤120; code ≤100; message ≤2000 chars; status 200–599 | lib/backend/nativeProtocol.ts:30-35 | Rejecting invalid replies | Safety | An invalid reply closes the port (`native_protocol`). |
| `runtimePollMs` | 15 s ready; 1 s busy; 5 s unknown | lib/backend/runtimeProtocol.ts:94 | Settings page polling of runtime state | Judgement | — |
| `FOLLOW_MS` / `WAITING_MS` | 500 ms / 1000 ms | lib/backend/setupFeed.ts:19,21 | Download-progress push cadence | Judgement | — |
| `deviceKind` mapping | /gpu\|cuda\|mps\|metal\|rocm\|directml\|dml/ → gpu; /cpu\|wasm/ → cpu | lib/backend/deviceKind.ts:9-10 | GPU/CPU label for PDF pacing and request sizing | Judgement | An unknown device string gives null (the default pace). It is used in other areas (lib/capture/orchestrator.ts:1255, lib/pdf). |

### Router and caches

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `ENGINE_BATCH_CHARS` | 6000 chars | lib/backend/router.ts:13 | Characters per engine batch | Judgement | From the initial commit. A slow engine's batches are cut further by its measured pace (`BATCH_TARGET_MS`, below), so this caps a fast engine's only. |
| `BATCH_TARGET_MS` / `PACE_SAMPLES` / `PACE_MIN_CHARS` | 10 s of engine time; median of the last 5 batches; batches of ≥500 chars | lib/backend/router.ts:22-24, :112-116 | A slow engine's batches: what it reads in 10 s at its measured pace, where that is under `ENGINE_BATCH_CHARS` | Judgement | A third of the 30 s a request has from its turn. Needs 3 samples first; one block at the least. A fast engine keeps 6000. |
| `MAX_IN_FLIGHT` | 4 batches | lib/backend/router.ts:25 | Concurrent batches sent to the engine | Judgement | Both engines run one score at a time, so the extra 3 wait in the engine's queue; each is timed from its turn. |
| `MAX_DOCUMENT_IN_FLIGHT` | 2 batches | lib/backend/router.ts:26 | Per-document share of `MAX_IN_FLIGHT` | Judgement | Fairness between frames and tabs. Added in 0.5.0. |
| `PRIORITY` + aging | viewport 2, near 1, background 0; +1 per 1000 ms queued | lib/backend/router.ts:27,203 | Batch order | Judgement | A background batch ties a fresh viewport batch after 2 s, which guards strongly against starvation. Untuned. |
| `ROUTER_LIMITS` (global) | 256 requests; 1024 blocks; 1,000,000 chars | lib/backend/router.ts:34 | Admission into the worker | Safety | Over the limit, the request gets "Unavailable" at once, with no queueing. Statistics count it as engine unavailable. |
| `ROUTER_LIMITS` (tab) | 128; 512; 500,000 | lib/backend/router.ts:35 | One tab's share | Safety | Half the global limit, so one page's frames cannot starve other tabs (comment and DEVELOPMENT.md). |
| `ROUTER_LIMITS` (document) | 16; `DOCUMENT_SHARE` | lib/backend/router.ts:36 | One frame's share | Safety | — |
| `DOCUMENT_SHARE` | 256 blocks; 250,000 chars | lib/contract.ts:35 | What of one page the worker scores at once | Safety | The router's per-document limits and the page's request size (`REQUEST_BLOCKS` = 256 / `PAGE_IN_FLIGHT`) both read it. |
| `SCORE_CACHE_MAX_AGE_MS` | 30 days from write | lib/cachePolicy.ts:2 | Verdict retention | Judgement | A privacy choice: hits do not extend it. The user can switch to session-only or clear it in Settings. |
| `MEMORY_MAX_ENTRIES` | 5000 | lib/backend/swCache.ts:81 | In-memory LRU in front of IndexedDB | Judgement | Hit rate never measured. The tab layer's 2000 is in another area (CHANGELOG ~1095). |
| `MAX_ENTRIES` / `PRUNE_TO` | 20,000 / 15,000 rows | lib/backend/swCache.ts:82-83 | Persistent cache size | Judgement | Oldest rows are dropped first. Interacts with the 30-day limit for heavy readers. |
| `PRUNE_EVERY_WRITES` | 500 writes | lib/backend/swCache.ts:84 | Pruning cadence | Judgement | The store can exceed 20,000 by up to 499 rows between prunes. |
| `FLUSH_MS` | 250 ms | lib/backend/swCache.ts:85 | Write batching to IndexedDB | Judgement | Writes still waiting when the worker is killed are lost (they are re-scored later). |
| Cache key | normalization version : model dim (id, ver, calibration) : digest(partition) : digest(modelText) | lib/backend/swCache.ts:269-270 | When a verdict is reused | Safety | `ver` folds in package versions and code hashes (anagramd/runtime_adapters.py:153-167). Every engine update, runtime switch or engine change starts an empty cache. |
| Partition | "private\|normal" + top host + frame origin | entrypoints/background.ts:63-67 | Cache and dedup sharing scope | Safety | Uses the host, not the registrable site, so it is finer than browser partitioning. Subdomains of one site never share a cached verdict. |
| `digest128` | SHA-256 truncated to 128 bits | lib/hash.ts:19 | Key hashing for cache and token counts | Safety | Collision-resistant against hostile pages. The per-tab layer still uses the 53-bit `cyrb53` (lib/capture/cache.ts:36). |
| `MAX_COUNTS` | 50,000 entries | lib/backend/tokenCounts.ts:11 | Token-count memo (keyed by model id, partition, text) | Judgement | Speed only. Uses only the model id (not `ver`), so it is shared across FP32 runtimes. |

### Downloads, pins and installer

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Modelkit pin | CoderBak/editlens_roberta_modelkit @ f7cb4b0…; source pangram/editlens_roberta-large @ f93e1ac… | anagramd/modelkit.json:3-7 | Exact weights both engines run | Model | Size and SHA-256 per file. Changing it changes `ver`, the TIERS bytes and every cached verdict. |
| fastText LID pin | lid.176.ftz, 938,013 B, SHA-256 8f3472… | anagramd/contract.json (`language_id`), read by lib/webengine/pin.ts, anagramd/download_modelkit.py and scripts/webengine.mjs | Language gate model | Model | One pin (2026-10-10; it was written in three places). The browser ships it in the package because fastText's host sends no CORS headers. |
| `onnxruntime-web` | 1.30.0 exact, JSPI build | package.json:68; scripts/webengine.mjs:49 | Browser runtime | Measured | The default JSEP WebGPU build gave wrong logits on this model ("every text off", parity.mjs, ORT 1.27 and 1.30). JSPI needs Chrome 137 and Firefox 153. |
| Native runtime ranges | onnxruntime ≥1.30,<1.31; mlx ≥0.32.2,<0.33; torch ≥2.4 (locked 2.14.0) | anagramd/pyproject.toml:10-29 | Local runtimes | Judgement | `uv.lock` is frozen. Package versions are folded into `ver`, so an upgrade resets cache provenance. |
| Windows torch wheel | PyPI CPU-only build (124 MB in uv.lock) | anagramd/pyproject.toml:11 | Windows native runtime | Platform | No CUDA on Windows, and onnxruntime has no CUDA EP, so Windows with an NVIDIA GPU is given the in-browser engine (lib/device.ts:12-17). Untested on Windows (DEVELOPMENT.md:349). |
| Linux CUDA detection | /proc/driver/nvidia, `nvidia-smi -L`, or the WSL nvidia-smi | install.sh:183-187 | Install torch+CUDA (~5 GB) or ONNX CPU | Judgement | Without a detected driver, torch is removed. A driver installed later needs a reinstall. |
| Platform floors | macOS ≥14 arm64; glibc ≥2.28; Windows x64 only | install.sh:161-178; install.ps1:241 | Where the local engine installs | Platform | Limits of the locked wheels. Mirrored by lib/device.ts `nativeInstalls`. |
| uv / Python pins | uv 0.11.18 (SHA-256 per target); Python 3.12.13 | install.sh:8-9; install.ps1:16-18 | Toolchain | Judgement | Reproducibility. `ANAGRAM_PYTHON` overrides the version on POSIX. |
| sigstore-python pin | 4.5.0; every file's hash pinned in installer/sigstore.txt (scripts/sigstoreLock.mjs) | installer/sigstore.in:1 | The verifier the installers run in a throwaway environment | Safety | Wheels for CPython 3.12 on macOS arm64, glibc Linux x86-64 and arm64, and Windows x86-64, copied into both installers (test/node/sigstoreLock.test.ts holds the copies to their sources). |
| Release signer | `SIGNER` `https://github.com/CoderBak/anagram/.github/workflows/release.yml@refs/tags/v` and one version; `ISSUER` `https://token.actions.githubusercontent.com` | installer/verify_release.py:25-27 | Which signature a release must carry to be installed | Safety | Keyless: only the release workflow at a version tag (the one asked for, when one is) passes. The trust root is updated where Sigstore's update server answers, else sigstore-python's own. A file:// release keeps the checksum check alone. |
| `RETRY_WAITS` (browser) | 2 s, 5 s, 15 s | lib/webengine/download.ts:56 | Retries per file (4 attempts) | Judgement | A full disk, bad hash or 404 is never retried. |
| `CONNECT_TIMEOUT` (browser) | 20 s | lib/webengine/download.ts:58 | Declaring a host unreachable and switching to the mirror | Judgement | "A blocked host often answers nothing", and browsers otherwise wait minutes. Matches httpx `connect=20`. |
| `STALL_TIMEOUT` (browser) | 60 s | lib/webengine/download.ts:90 | Body silence counted as a lost connection | Judgement | The partial file is kept and resumed with Range. |
| Retryable HTTP | ≥500 or 429; mirror switch only on ≥500 or no answer | lib/webengine/download.ts:226 | Download error handling | Convention | — |
| Mirror | hf-mirror.com; sticky once it has worked | lib/webengine/pin.ts:28; anagramd/download_modelkit.py:29 | Fallback host | Judgement | The SHA-256 still decides which bytes are kept. |
| Native staging headroom | 64 MiB beyond each file | anagramd/download_modelkit.py:236 | Disk check before staging | Judgement | Differs from the browser's 200 MB `DISK_MARGIN`. |
| hub_transfer retries | 3 attempts, 1 s and 2 s backoff; 408/429/5xx | anagramd/hub_transfer.py:68-91 | Native download retries | Convention | Fewer and shorter than the browser's 2/5/15 s. |
| httpx and HF timeouts | read 60 s, connect 20 s; `HF_HUB_DOWNLOAD_TIMEOUT` 60; ETag 30 | anagramd/hub_transfer.py:47,103 | Native stall and connect detection | Judgement | — |
| `DOWNLOAD_CHUNK_SIZE` / progress | 1 MiB; progress lines ≥0.2 s apart | anagramd/hub_transfer.py:112,121 | Durable write granularity | Judgement | — |
| `OPEN_AFTER_MS` | 10 s | lib/webengine/autoSetup.ts:25 | Setup page waits for the engine to accept the download | Judgement | Reports "started" after the timeout even if unconfirmed. |
| Save-Data gate | auto-download skipped when `saveData` (unless the user asked) | lib/webengine/autoSetup.ts:54,116 | Automatic 1.4 GB download | Judgement | The room check here uses no margin. |

### Findings

#### Most consequential parameters

1. **`SCORE_CUTS` = 1/6, 1/2, 5/6** (lib/render/scale.ts:18). These cuts decide every verdict word, colour and underline. They come from EditLens's equal-bucket decoding, not from calibration on web text. Statistics use the probabilities, so the menu's "x% AI-generated" does not depend on them. What the reader sees depends on nothing else.
2. **The language gate: fastText top-1, threshold 0, English only** (anagramd/engine.py:148,455; lib/webengine/engine.ts:741). This rule alone decides the "not English" share in statistics and which paragraphs get any verdict. Measured on 2026-10-09 (the row above): it refuses no English prose on the web benchmark, and any minimum confidence would score more non-English text, so it stays.
3. **`MAX_LENGTH` 512, truncation, and the 510-token planning window.** These fix what the model sees and how long paragraphs are cut into windows.
4. **The FP32/FP16 tier rule** (lib/device.ts:93-186: 4 GB minimum, "tight" at exactly 4 GB, unknown memory counted as fitting). On some devices it changes the model: FP16 gives a different word on 0.18% of the test split and has its own model id. A one-time warm-up failure abandons FP16 for good.
5. **Router admission and concurrency** (`ROUTER_LIMITS`, `MAX_IN_FLIGHT` 4, `ENGINE_BATCH_CHARS` 6000). An over-limit request becomes "Unavailable" with no queueing. Both engines run one batch at a time, so with 4 in flight up to three batches wait their turn. Each is timed from its turn, so waiting delays verdicts but no longer times them out. The delay on slow CPU paths is unmeasured.
6. **Timeouts:** 30 s request, 25 s native wake, 285 s/300 s in-browser load waits. Together they decide whether a cold or slow engine yields verdicts or "Unavailable". The native engine is ten times less patient than the browser engine.
7. **Cache key and retention** (30 days; `ver` folds in package and code hashes; partition by host). Every engine update or runtime switch empties the effective cache.
8. **Idle unload of 300 s** (both engines, user-settable). This sets how often readers pay the reload: about 2 s in the browser, and up to 25 s natively before "not ready".

#### Values duplicated or contradicting each other across files

- **Disk margins disagree.** The browser's tier check uses 200 MB (`DISK_MARGIN`), the browser's auto-download check uses no margin (autoSetup.ts:116 via `roomShort`), and native staging uses 64 MiB per file.
- **Request size caps differ at each hop.** Content→worker allows 900,000 B (messages.ts:38), extension→host 1,000,000 B (`MAX_NATIVE_BYTES`), and the host accepts 2 MiB (`MAX_REQUEST_BYTES`). They are consistent in direction, but three numbers have to be kept in mind.
- **Constants that used to be hand-copied** now have one source (2026-10-10): the request limits, the idle range 0|60–86,400 and the language-ID pin in `anagramd/contract.json`, read by both engines and the build; the TIERS byte counts summed from `modelkit.json`; the idle options in `IDLE_CHOICES`.
- **Two automatic orderings:** `build_plan` puts MLX first, while `preference_rank` puts torch-CUDA ahead of MLX. They agree in practice only because the plan limits what is installed.
- **Download retry policies differ:** the browser waits 2/5/15 s (4 attempts), the native path 1/2 s (3 attempts).

#### Judgement values that deserve a measurement

- `ENGINE_BATCH_CHARS` 6000, `MAX_IN_FLIGHT` 4, `MAX_DOCUMENT_IN_FLIGHT` 2 and the priority aging rate of 1 level/s. The first two date from the initial commit and `MAX_DOCUMENT_IN_FLIGHT` from 0.5.0. Since 2026-10-09 a request is timed from its turn and a slow engine's batches are sized by its pace, so these decide latency, no longer failures. Measure time-to-first-chip and time to verdict on CPU paths (ONNX CPU, single-thread WASM in Firefox, whose manifest sets no cross-origin isolation; wxt.config.ts:332 is Chrome-only) against batch count.
- The language-gate confidence threshold (now 0). Measure the misgating rate on short, quoted or code-mixed English paragraphs.
- Cache sizes: `MEMORY_MAX_ENTRIES` 5000, `MAX_ENTRIES` 20,000 / `PRUNE_TO` 15,000, `MAX_COUNTS` 50,000. Also the 30-day retention against the hit rate. No hit-rate figure exists.
- FP16 `minMemoryGb` 4: the measured 1.6 GB peak suggests 2 GB devices might work. `DISK_MARGIN` 200 MB is also unmeasured.
- The 30 s request timeout, `RECONNECT_MS` 1500, `CRASH_LIMIT` 4/120 s, `STARTUP_CRASH_LIMIT` 2, `RESTART_WAIT_MS` 60 s and the 25 s native wake wait. Native cold-load times on CUDA, MPS and ONNX CPU are not recorded anywhere I found.
- The idle-unload default of 300 s: there are reload costs for the browser (~2 s), but no data on how often readers return after more than 5 minutes.
- `BATCH_SIZE` 32 (native) and `PASS_TOKENS` 24 for non-MLX native runtimes. They were fitted on MLX on one M4, so CUDA and CPU costs are untested. Speed is affected, not verdicts.
- The permanent `fp16_failed` latch: measure how often FP16 warm-up fails transiently, since one failure removes the GPU path for good.

#### Comments that no longer match the code

- **lib/render/scale.ts:76-79.** "one name per word" sits next to `SCALE_STEPS = 3`. The code is correct (steps 0..3 make four names), but the constant reads as a count.
- **`CALIBRATION` "editlens-4bucket-cosine(0.03,0.15)"** (anagramd/contract.json:3) looks like it holds numeric thresholds, but nothing in the code uses 0.03 or 0.15. It is only a label folded into cache keys. Whether it describes the upstream bucket definition is unclear.

## Area 4: The PDF reader

This area covers the PDF reader: the page in `entrypoints/reader/` (caps, read-ahead, chips) and everything in `lib/pdf/`. The reader shows the document with pdf.js and rebuilds its paragraphs in one of two ways:

- **Structured path.** Zotero's document-worker reads the whole document. `lib/pdf/structured.ts` maps its glyphs back onto pdf.js's text runs. `lib/pdf/reading.ts` then decides which glyphs are text.
- **Reflow path.** This is the fallback. `lib/pdf/reflow.ts` infers lines, columns and paragraphs from the runs of the pages pdf.js has drawn. `reading.ts` cleans the result.

`lib/pdf/units.ts` turns either path's blocks into ordinary scoring units. `vendor/document-worker/src/worker.js` is entirely Anagram's entry file, but it adds no number of its own: it applies the page ranges that `lib/pdf/structureWorker.ts` chooses.

Some neighbouring values belong to other sections:

- the pacer's duty cycle and batch size (`lib/capture/pace.ts`);
- the minimum unit length (`MIN_WORDS` = 50, `lib/dom/text.ts:102`);
- the grouping rules (`lib/plan/group.ts`).

**What the user can change.** No constant below is user-settable. The user controls only three things:

- Zotero's structure on or off (`settings.pdfStructure`);
- background reading on or off (`settings.pdfReadAhead`);
- the menu's **Read the whole document** button.

**Effect on statistics.** Every extraction row changes the text that reaches the model. Text the reader leaves out never becomes a unit, so it is neither scored nor counted in statistics. This covers formulas, citation marks, captions, code, contents entries, line numbers and running heads. The rows for caps, the viewer and slicing change which words are counted only where their notes say so.

**Overfitting checks.** The PDF benchmark (`test/pdf-bench/bench.mjs:18-19,43`) holds out a test split: documents whose id's SHA-1 starts with hex 0–4, about 31%. The rules are meant to be tuned on the `dev` split.

### Document caps and memory

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MOST_STRUCTURE_PAGES` | 2,500 pages | `entrypoints/reader/main.ts:31` | Longest document given Zotero's structure at all | Measured | 2,445-page book: 27.5 s, page memory 195→311 MB, no frame over 150 ms (M4, 2026-10-04; the earlier 0.3 s pause was sliced away in 77ad85c). Past it: reflow of drawn pages only; whole-document report impossible. |
| Automatic structure cap (`autoStructurePages`) | 300 pages (under 4 GB or unknown), 600 (4 GB), 2,500 (8 GB) | `entrypoints/reader/main.ts:37` | Pages read whole without the menu's ask | Judgement | Never measured on 4 or 8 GB machines. Chrome reports at most 8; Firefox and Safari report nothing, so always 300. |
| `MAX_BYTES` | 100 MiB | `entrypoints/reader/main.ts:23` | Largest file opened by picker or drop | Judgement | Twice the web caps: a 60 MB paper opens from disk but not from its address. |
| `MAX_HANDOFF_BYTES` | 50 MiB | `lib/pdf/handoff.ts:18` | Largest PDF relayed from a Chromium PDF tab | Judgement | Is `SOURCE_CAP`, so a web PDF has one limit whichever way it comes. Over it: "too large", nothing read. |
| `SOURCE_CAP` | 50 MiB | `lib/pdf/sourceTransfer.ts:9` | Largest PDF the private loader fetches (Firefox, local files, refresh) | Judgement | Also the ceiling `readAuthorizedPdf` accepts (`lib/pdf/loader.ts:15`). |
| `MAX_HANDOFF_TOTAL_BYTES` / `MAX_HANDOFF_TRANSFERS` | 64 MiB / 2 transfers | `lib/pdf/handoff.ts:183-184` | Memory and concurrency of the relay across tabs | Safety | A third concurrent open, or a second near-cap one, fails "busy". |
| Transfer deadlines (`TICKET_TTL_MS`, `READ_TIMEOUT_MS`, `CLAIM_TIMEOUT_MS`, local XHR, `SOURCE_TIMEOUT`) | 30 s, 30 s, 15 s, 30 s, 45 s | `lib/pdf/handoff.ts:21-27`, `lib/pdf/loader.ts:52`, `lib/pdf/sourceTransfer.ts:10` | How long fetching a document may take | Judgement | A slow 50 MB download fails as "read". The relay and the loader use 30 s and 45 s for the same job. |
| `CHUNK_BYTES` | 256 KiB | `lib/pdf/handoff.ts:15` | Relay chunk, one in flight | Judgement | Throughput only; no measurement found. |
| `MAGIC_WINDOW` | 1,024 bytes | `lib/pdf/sourceTransfer.ts:25` | How deep `%PDF-` may sit | Platform | pdf.js's own window. A login page served as PDF is refused as "type". |
| Glyphs freed once read (`pagesStay`) | when every page of a block has text | `lib/pdf/structured.ts:1816` | When a paragraph's glyphs are let go for good | Measured | 150 MB held at 300 pages otherwise. Unread blocks stay packed (`packPieces`: 525 MB of objects at 2,445 pages), each from when it is drafted: preparing a 2,448-page structure peaked at 1,032 MB live with them unpacked, 162 MB packed (2026-10-05, M4; the PDF benchmark's output unchanged). |

### Zotero structure: page ranges and deadlines

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `RANGE_PAGES` | 1,000 pages | `lib/pdf/structureWorker.ts:31` | Most pages one worker reads | Measured | Peaks measured at 813 pages (1.4 GB) and 2,445 (2.7 GB whole, 2.0 GB in ranges). 1,000 itself was never measured. Lower: less memory, more seams. |
| Even range split (`pageRanges`) | ceil(n / ceil(n / 1,000)) pages per range | `lib/pdf/structureWorker.ts:37` | Range sizes | Judgement | A 1,001-page document is read as 501 + 500. Each range is a separate document to Zotero. |
| Page-range view | each range numbered from 0, then shifted back | `vendor/document-worker/src/worker.js:62` | What Zotero's whole-document rules see | Judgement | Anagram's addition (3498a5c). Running heads, reference lists and outline pages are worked out per range; links across a seam resolve to nothing. |
| `TIMEOUT_BASE_MS` + `TIMEOUT_PER_PAGE_MS` | 20 s + 250 ms per page, per worker | `lib/pdf/structureWorker.ts:28-29` | When a worker counts as hung | Judgement | Comment: 20 ms/page measured; 12.5 times that is a hang. Only an M4 was timed. On expiry the reader silently keeps the reflow. |
| Worker password and hash | "" and 32 zeros | `lib/pdf/structureWorker.ts:99` | What Zotero is given | Judgement | A PDF locked with a user password opens in pdf.js but never gets a structure: reflow only. |
| Structure setting | on | `entrypoints/reader/main.ts:179` | Whether Zotero is used at all | Judgement | User-settable (`settings.pdfStructure`). Off: reflow of drawn pages and no read-ahead, so paragraph texts and verdicts differ. |

### Glyphs and lines

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MOST_TILT_DEGREES` | 5°, the angle of the run's baseline | `lib/pdf/reflow.ts:53` (`isRotated`, :59; `lib/pdf/extract.ts:19`) | Runs treated as rotated, dropped by the reflow and the run index | Judgement | A scan's text layer skewed by a degree or two and a slanted (synthetic italic) font are read; arXiv's 90° identifier, 45° watermarks and upside-down text are not. |
| `BASELINE_TOL` | 0.55 × taller run | `lib/pdf/reflow.ts:149` | Runs that share a line | Judgement | Higher: tight lines merge; lower: scripts open lines. Also drives the line-number and drop-cap tests. Never swept on the benchmark. |
| Dominant run | widest run of the line | `lib/pdf/reflow.ts:555` | A line's baseline, size and font | Judgement | Stops a superscript setting the size. A wide formula run can make a math face the line's font. |
| `SPACE_GAP` | 0.2 × size | `lib/pdf/reflow.ts`, used by `lib/pdf/reading.ts` | Gap read as a word space | Convention | Lower: spaces inside kerned words; higher: words run together. Both change tokens the model reads. |
| `CJK_SPACE_GAP` | 1 em | `lib/pdf/reflow.ts:289` | Gap between ideographs kept as a space | Convention | A CJK space is a full ideograph wide. Anagram scores English only. |
| `DROP_CAP_SIZE` / `DROP_CAP_LINES` / `DROP_CAP_GAP` / `DROP_CAP_ALIGN` | 1.8 × body; ≥2 lines; 1.5 em; 0.7 × body | `lib/pdf/reflow.ts:151-157` | A large single letter put back at its paragraph's head | Convention | Drop caps sink two or three lines. Missed: the letter lands mid-paragraph. Body size here weights per 4 characters, the document's per 8. |
| `BOX_SLACK` | 0.15 run heights | `lib/pdf/structured.ts:76` | How far outside a pdf.js run a Zotero glyph may lie | Judgement | Higher: glyphs found in neighbouring lines' runs (wrong marks); lower: unlocated glyphs, text with no runs. |
| `ASCENT` / `DESCENT` | 1.0 / 0.35 of run size | `lib/pdf/structured.ts:78-79` | A run's vertical box | Convention | Typical Latin font metrics. Match scoring uses a separate literal 0.35 (`:180`). |
| `DRIFT` | 1.5 run heights | `lib/pdf/structured.ts:82` | Reach to the nearest run on the right for a shifted glyph | Judgement | Covers the word space Zotero's fork folds into glyphs. |
| `RUN_REACH` | 4 run heights | `lib/pdf/structured.ts:85` | How far right other candidate runs are tried | Judgement | — |
| Glyph search band | ±4 glyph heights | `lib/pdf/structured.ts:168,175` | Runs scanned around each glyph | Judgement | Bounded in total by `SEARCHES_PER_CHAR`. |
| Glyph-count trust | glyphs must equal non-space characters | `lib/pdf/structured.ts:221` | Whether a Zotero text node's glyphs are used | Judgement | One mismatch drops all of the node's glyphs: its text is read but never marked. |
| `sameLine` overlap | ≥0.3 of the taller glyph | `lib/pdf/reading.ts:196` | Two glyphs on one line | Judgement | Used for spaces, scripts, hyphen mends, line numbers and accents. |
| Run baseline match | within 0.5 run heights | `lib/pdf/reading.ts:220,520` | Two pdf.js runs on one line | Judgement | Decides whether a space is put back between runs. |
| `ACCENT_REACH` | 3 letters | `lib/pdf/structured.ts:234` | How far an accent's letter is sought | Judgement | Mends "Alfven´". Higher risks accenting the wrong letter. |

### Columns and reading order

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MIN_LINES_FOR_COLUMNS` | 6 lines | `lib/pdf/reflow.ts:161` | Fewest lines before gutters are sought | Judgement | Below it the page is read full width. |
| Text-span floor | 0.4 × page width | `lib/pdf/reflow.ts:735` | Narrow text skips the column search | Judgement | Unnamed literal. |
| `COLUMN_EVEN_SHARE` | 0.5 of an even 1/N share of characters | `lib/pdf/reflow.ts:167` | Each column must carry enough text | Judgement | 0.25 at two columns. Counted in characters after a formula column failed by runs (arXiv 2004.04906 p. 2). |
| `GUTTER_MIN_EMS` / `GUTTER_MIN_WIDTH` | max(1 em, 0.015 × page width) | `lib/pdf/reflow.ts:170-171` | Narrowest gutter | Measured | Templates measured near 1 em (IEEE 0.17 in at 10 pt). Out-of-order 144→46 on dev and 146→27 on test. Lower: word rivers become gutters. |
| `GUTTER_BAND_SHARE` | 0.45 of bands with text | `lib/pdf/reflow.ts:180` | Share of bands a gutter must divide | Judgement | Below half so that a spanning title or figure does not hide the columns. |
| `GUTTER_BANDS` | 12 bands | `lib/pdf/reflow.ts:182` | Vertical resolution of the gutter test | Judgement | Sets what `STRETCH_BANDS` means (3 = a quarter). |
| `GUTTER_CELLS` | 400 cells | `lib/pdf/reflow.ts:184` | Horizontal resolution of the scan | Judgement | Gutter width is credited two extra cells. |
| `MAX_COLUMNS` | 5 | `lib/pdf/reflow.ts:186` | Most columns per page | Judgement | Extra gutters are ignored, so a grid is read in at most five columns. |
| `STRADDLE_TOL` | 0.5 × run size on each side | `lib/pdf/reflow.ts:193` | When a run spans a gutter | Judgement | Lower: a justified line's last word joins both columns into one line. |
| `STRETCH_BANDS` | 3 consecutive bands | `lib/pdf/reflow.ts:850` | Gutter that divides only part of a page | Fitted | Lowered from 4 for one olmOCR-Bench page (013a3686 p. 1). On test, arXiv F1 rose 0.13 and olmOCR scored fell 441→433. Overfitting risk. |
| `STRETCH_LINES` | 8 lines per column | `lib/pdf/reflow.ts:851` | Partial-page columns must hold this many lines | Fitted | Added with the above to keep table rows from becoming columns. Dev and test reported. |
| `ORDER_SLACK` / `SHARED` | 3 pt / 0.5 of the narrower extent | `lib/pdf/structured.ts:885,888` | "Above" / "left of" and same column or band | Fitted | Tuned on two magazine pages, olmOCR dev only (a3ebc6f); test not reported. Points, not a ratio. |
| `HEADLINE_SHARED` | 0.8 of own width | `lib/pdf/structured.ts:908` | Block under a headline joins its run | Fitted | One journal page (910f487). The rest of the benchmark is unchanged; test not reported. |
| Reorder floor | ≥3 blocks in a page stretch | `lib/pdf/structured.ts:945` | When column reordering is tried | Judgement | With two blocks, Zotero's order stands. |

### Paragraph breaks and joins

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `PARA_GAP` | 1.45 line pitches | `lib/pdf/reflow.ts`, used by `lib/pdf/structured.ts` | Vertical gap that starts a paragraph | Judgement | Set on synthetic pages (c9ee49d); the structured path's numbered manuscripts use the same constant, with `INDENT`, `SHORT_LINE`, `EDGE_PERCENTILE` and `PITCH_OF_SIZE`. Lower: splits at display maths; higher: merges. Moves unit boundaries. |
| `INDENT` | 0.5 em | `lib/pdf/reflow.ts:217`, `lib/pdf/structured.ts:1002` | First-line indent that starts a paragraph | Judgement | Measured from the 15th-percentile left edge. Duplicated. |
| `SHORT_LINE` | 2 em short of the right edge | `lib/pdf/reflow.ts:219`, `lib/pdf/structured.ts:1003` | Last line, when the next opens fresh | Judgement | The reflow has no ragged-right mode: ragged prose splits at many line ends. |
| `SIZE_CHANGE` | 0.15 of the larger size | `lib/pdf/reflow.ts:225` | Size change that starts a block or refuses a join | Judgement | Also keeps a caption's second half off the body. |
| Measure edges | 15th / 85th percentile of line starts and ends | `lib/pdf/reflow.ts:1491-1492` | Column's left and right edge | Judgement | Repeated at `reflow.ts:1592-1593` and `structured.ts:1388-1389`. |
| Pitch fallback | 1.2 × line size | `lib/pdf/reflow.ts:1480` | Pitch when there is none to measure | Convention | Standard leading. Repeated at `structured.ts:1389` and `chips.ts:52`. |
| Own-measure test | no gap over 1 em in a line; most lines flush | `lib/pdf/reflow.ts:1597-1601` | Inset abstract or quote measured on its own | Judgement | A table keeps the column's measure. |
| `LIST_MARKER` / `DASH_ITEM` | bullet, 1–3 digits, [n] or (a) then space; a dash only after a colon, semicolon or sentence end | `lib/pdf/reflow.ts:253-263` | Lines that open a list item | Convention | Each item is a block. Structured `LIST_OPENING` (`structured.ts:1015`) lacks the dash check. |
| `ASIDE_MAX` | 2 asides | `lib/pdf/reflow.ts:243` | Footnotes or captions a join may reach past | Judgement | Higher joins across more floats. |
| Continuation rule | no sentence end, full last line, size within 15%, lower-case start | `lib/pdf/reflow.ts:1648` | Sewing a paragraph across a column or page | Convention | The structured path checks only the sentence end and the case (`structured.ts:1420,1867`). |
| `SENTENCE_END` | . ! ? 。！？… then closers | `lib/pdf/reflow.ts:292` | Whether text ends its sentence | Convention | A line ending "et al." counts as an end, so the join is refused. |
| Page-turn barrier | soft after a sentence end at a page | `lib/pdf/structured.ts:1730` | Short tail after a page may join the paragraph before | Measured | Measured on all 207 papers, test included (353e6c7): +1,308 words. No held-out check. |

### Headings, front matter and running heads

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `HEADING_SIZE` | 1.12 × body | `lib/pdf/reflow.ts:227` | Larger type is a heading; also finds the title | Judgement | Headings are barriers and never scored. Lower: large body text is lost as headings. |
| `HEADING_MAX_WORDS` | 20 words | `lib/pdf/reflow.ts:229` | Longest heading | Judgement | Longer display text is prose. |
| `DISPLAY_FONT_SHARE` | 0.06 of the document's characters | `lib/pdf/reflow.ts:231` | Rare face is a display face (heading if no sentence end) | Judgement | Short text in a rare face with no full stop becomes a heading and goes unscored. |
| Body-size weighting | 1 sample per 8 characters of a line | `lib/pdf/reflow.ts:1741` | What "body size" means | Judgement | The page-level drop-cap test uses 1 per 4 (`:647`). |
| `SECTION_NUMBER` | "2 ", "3.1 ", "IV. " then a capital | `lib/pdf/reflow.ts:245` | Numbered heading; ends the front matter | Convention | Also matches numbered list items: "1. Apples" with no full stop, ≤20 words, becomes an unscored heading. |
| `FRONT_MATTER_MAX_Y` / `FRONT_MATTER_MAX_LINES` | top 0.5 of page 1; 24 lines | `lib/pdf/reflow.ts:1058-1060` | Extent of the title block | Judgement | Only when the drawn run starts at page 1. Front matter is "apart". |
| `FLUSH_TOL` / `FLUSH_RUN` | 0.15 em; 3 lines | `lib/pdf/reflow.ts:1066-1068` | Prose starts at three flush lines | Judgement | Also splits front-matter lines and gates the own-measure test. |
| `FIRST_LINE_INDENT_MAX` / `FRONT_MATTER_LABEL_WORDS` | 4 em; 3 words | `lib/pdf/reflow.ts:1074-1076` | Indented abstract line; closing label as heading | Judgement | |
| `CONTACT` | an @ between characters, http(s)://, www. | `lib/pdf/reflow.ts:1056` | E-mail or URL lines are not prose | Convention | |
| `MARGIN_TOP` / `MARGIN_BOTTOM` | 0.09 / 0.88 of page height | `lib/pdf/reflow.ts:200-201` | Bands where heads, footers and page numbers are sought | Convention | One-inch margins; page numbers at 0.90. A repeating body line inside the bands is dropped too. |
| `RUNNING_MIN_SHARE` / `RUNNING_MIN_PAGES` | half of the pages; at least 2 | `lib/pdf/reflow.ts:203-205` | A repeating margin line is a running head | Judgement | The reflow sees only consecutive drawn pages, so detection depends on scroll position and pdf.js's page buffer. |
| `RUNNING_MIN_PARITY_PAGES` | 3 pages | `lib/pdf/reflow.ts:213` | Verso and recto heads judged by parity | Judgement | |
| Running-head shape | ≤14 words; height within 0.02 of the page | `lib/pdf/reflow.ts:1183,1208` | Margin lines eligible as heads, and how still they must sit | Judgement | Unnamed literals. |
| `PAGE_NUMBER` | ≤5 digits or ≤7 roman letters, "Page n of m" | `lib/pdf/reflow.ts:1154` | Page numbers dropped from the margin bands | Convention | A lone margin word spelt in roman-numeral letters ("civil", "dim") is dropped too. |

### Captions, notes, contents and bibliography

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `FOOTNOTE_SIZE` | 0.92 × body | `lib/pdf/reflow.ts:233` | Small blocks ending a column become asides | Judgement | Asides are still scored when over the floor, but never grouped. |
| `CAPTION_START` (reflow) | fig., figure, table, tab., chart, listing, algorithm, scheme + digit | `lib/pdf/reflow.ts` | Captions on the fallback path | Convention | Narrower than the structured list. These captions are scored as "apart" units when over the floor; the structured path leaves them out. |
| `CAPTION_MAX_WORDS` | 60 words | `lib/pdf/reflow.ts:241` | A body-size caption longer than this is prose | Judgement | The structured path dropped its 60-word cap (ae76ac8). |
| `CAPTION_LABEL` (structured) | label, number or roman numeral, then colon, bar, full stop, dash or capital | `lib/pdf/structured.ts:670` | Captions Zotero read as body, left out | Fitted | Dev only (cf2616d): arXiv leakage 4.44→4.13%, 103 tokens of HTML prose lost. Words not counted. |
| `NAMES_NEXT` | about 30 words (in, of, see, the…) | `lib/pdf/structured.ts:673` | A "caption" that carries the sentence above stays | Fitted | Dev only; works with `CAPTION_RUN_ON_GAP`. |
| `CAPTION_GAP` / `CAPTION_RUN_ON_GAP` / `CAPTION_LABEL_GAP` / `CAPTION_OVERLAP` | 0.25 / 0.6 / 1.5 line heights; 0.8 of width | `lib/pdf/structured.ts:738-742` | A paragraph under a caption is the caption's rest | Fitted | Development papers put the nearest body text 0.38 line below (27acbe3). Test never reported. |
| `NOTE_SET_OFF` / `NOTE_GAP` / `NOTE_SIZE` | 0.5–1.3 line heights below a table; under 0.95 × body | `lib/pdf/structured.ts:770-772` | A paragraph set as a table's note, left out | Fitted | Dev notes sat 0.72–1.17 lines below, at 0.74–0.93 size (abe9afb). Test not reported. |
| Raised-number note | opens with a raised 1–3 digit number and is linked | `lib/pdf/structured.ts:386` | Footnotes Zotero read as list items, left out | Judgement | A four-digit note number is missed. |
| `AFFILIATION_MARK` / `AFFILIATION` | 1–2 digits, a–h or symbols; English institution words | `lib/pdf/structured.ts:390-392` | Affiliations on page 1, left out | Fitted | Dev only (418a09c). |
| `AUTHOR_MARKS` / `WORDS_PER_MARK` | ≥3 raised marks; ≤5 words per mark | `lib/pdf/structured.ts:394-395` | Author lists on page 1, left out | Fitted | Dev only; the reflow reads the same lines as "apart" front matter. |
| `CONTENTS_ENTRY` | ≥4 leader dots then a page number (≤4 digits or ≤7 roman) | `lib/pdf/structured.ts:614` | Contents entries become barriers, not read | Fitted | Dev only: thesis leakage 9.3→6.2% (0f54b06). |
| `SHORT_LEADER` / `ENTRY_PARTS` | 2–3 dots after a numbered opening; 4 paragraphs back | `lib/pdf/structured.ts:615-619` | Full-line entries and entries split into parts | Fitted | Dev only. |
| Contents-list share | at least half of a list's items | `lib/pdf/structured.ts:645` | A whole list read as contents | Fitted | Unnamed literal; dev only. |
| `LABELLED_ITEMS` / `DATED_ITEMS` | 0.6 open with [n]; 0.5 cite a year | `lib/pdf/structured.ts:594-595` | An unmarked list taken as the bibliography | Fitted | Dev only (511a712): "every such list of the corpora is one". |
| `ENTRY_LABEL` / `ENTRY_YEAR` | [1–4 digits]; years 1500–2099 | `lib/pdf/structured.ts:591-592` | Bibliography evidence | Convention | The reflow's `MARK_YEAR` (`reflow.ts:427`) uses different word boundaries. |
| `BODY_SIZE_TOLERANCE` / `IN_FLOAT` | ±0.05 of body size; 0.5 of own area | `lib/pdf/structured.ts:451-454` | Text set aside, read again as its paragraph's rest | Fitted | Dev and held-out test reported alike (0fbae51): precision +0.4 on both. Guarded. |
| Type-area slack | one body size | `lib/pdf/structured.ts:516` | Margin around the median type area | Judgement | Keeps arXiv's margin stamp out. |
| `KEYWORD_LINE` | "Index Terms", "Keywords", 关键词 + separator | `lib/pdf/units.ts:127` | Keyword line is a barrier | Judgement | Applies to both paths; never scored. |
| `FIRST_PAGE_NOTE` | funding, "Manuscript received", corresponding author; page 1 only | `lib/pdf/units.ts:131` | First-page boilerplate is a barrier | Judgement | The same text on page 2 is read. |
| `MAX_SYMBOL_NOISE` | 0.2 symbol share | `lib/dom/text.ts`, used by `lib/pdf/units.ts` | A short symbol-heavy block is a barrier | Judgement | One constant with the walker's and the diagnostics' (2026-10-10). |

### Line numbers

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `COLUMN_MIN` | 8 numbers on a page | `lib/pdf/lineNumbers.ts:50` | A page alone founds a line-number column | Fitted | 3927a43: 18 manuscripts (7 with tagged truth), dev and test reported. Lower: an algorithm's or a list's numbers vanish. |
| `MAX_STEP` / `COUNTING` | steps of 1–3; 0.8 of steps | `lib/pdf/lineNumbers.ts:53-55` | Numbers must count on down the column | Fitted | Allows numbered blank lines and one lost number. |
| `ALIGN` | 0.35 number heights | `lib/pdf/lineNumbers.ts:57` | Edge alignment within a column | Fitted | |
| `OUTER` / `IN_LINE` | ≤0.1 of the text beyond; ≤0.2 in line per number | `lib/pdf/lineNumbers.ts:59-62` | The column stands clear in a margin | Fitted | Keeps list markers and a table's first column. |
| `EDGE_REACH` / `EDGE_SLACK` | 0.5 / 0.15 heights | `lib/pdf/lineNumbers.ts:65-66` | "In line with" and edge tolerances | Fitted | |
| `BARE_NUMBER` | 1–5 digits | `lib/pdf/lineNumbers.ts:195` | Candidate line number | Convention | Lines numbered past 99,999 are not found. |
| Neighbour window | ±3 run heights (reflow); ±2 glyph heights (structured) | `lib/pdf/reflow.ts:537`, `lib/pdf/structured.ts:1119` | Where "first or last on its line" is checked | Judgement | Differs between the two paths. |
| `FOLDED_MIN` | 16 per page | `lib/pdf/structured.ts:1040` | Numbers Zotero ran into the text may found a column | Fitted | Dev only, four EarthArXiv manuscripts (efba802). Overfitting risk. |
| `GLYPH_TOUCH` | 0.15 glyph heights | `lib/pdf/structured.ts:998` | Glyphs set against each other | Judgement | |
| `FLUSH_SHARE` / `RAGGED_SHORT` | fewer than 0.5 of lines flush means ragged; then short only before 0.7 of the measure | `lib/pdf/structured.ts:1007-1008,1390` | Paragraph ends in ragged numbered manuscripts | Fitted | Dev only (2d698b3); recall 93.2→83.9%. Test "unchanged", probably with no ragged manuscript. Flush means within one line height. |
| `CELL_GAP` | 1.5 sizes | `lib/pdf/structured.ts:1010` | In-line gap that marks a table cell | Fitted | |
| `NUMBERED_TABLE` / `GAPPED_TABLE` | ≥0.9 of lines numbered; ≤0.1 with a cell gap | `lib/pdf/structured.ts:1013-1014` | A "table" of numbered prose is read as prose | Fitted | Worth 13.6 points of read coverage; dev and test reported. |
| Manuscript pitch | median step under 3 heights; else 1.2 × height | `lib/pdf/structured.ts:1383-1389` | Line pitch per page | Judgement | |
| `REFERENCES_HEAD` | References, Bibliography, Literature cited… | `lib/pdf/structured.ts:1017` | Numbered "bibliography" lines before it are prose | Convention | English only. |
| `LIST_OPENING` | bullet, or a dash and space | `lib/pdf/structured.ts:1015` | List items in numbered manuscripts | Judgement | No numbered markers; any dash-opened line breaks, unlike the reflow. |

### Hyphenation and vocabulary

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `KEEP_HYPHEN` | 12 stems: self, non, semi, quasi, pseudo, anti, multi, cross, co, ex, well, so | `lib/pdf/reflow.ts:1224` | A line-end hyphen kept after these | Judgement | Each entry keeps some real syllable breaks ("so-/lution" unless "solution" occurs). Attested usage outranks it. |
| Default join | lower case to lower case is joined unless attested | `lib/pdf/reflow.ts:1348` | Unattested compounds lose their hyphen | Judgement | "in-/depth" written once becomes "indepth". Changes the words the model reads. |
| Stem filters | stem of ≥2 letters, not all capitals; next part lower case | `lib/pdf/reflow.ts:1336-1339` | Hyphen kept for "e-/mail", "AI-/generated", "COVID-/19" | Convention | |
| `INLINE_COMPOUND` | two parts of ≥2 letters | `lib/pdf/reflow.ts:1243` | Mid-line compounds attest a hyphen | Judgement | A one-letter part ("x-ray") is never attested. |
| `WORD` / starts | words of ≥3 letters; beginnings from 5 letters | `lib/pdf/reflow.ts:1246,1305` | Fused spellings and word starts recorded | Judgement | |
| `CONTINUED` | 3 letters | `lib/pdf/reflow.ts:1278` | Letters after a break matched to a known word | Judgement | Three, so that "near-/equilibrium" is not taken for "nearest". |
| `HYPHEN_MEASURE` | 0.5 of the measure | `lib/pdf/reflow.ts:1256` | A line this short keeps its hyphen | Fitted | Changed to pass one synthetic page in `test/scenarios.mjs` (5a453ef). No held-out check. |
| `LONGEST_WORD` | 64 letters | `lib/pdf/reflow.ts:1283` | Longest word kept in the vocabulary | Safety | Hostile 50,000-letter words took gigabytes. Longer words are never attested, so they are joined by default. |

### Citations

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| Bracket `NUMBERS` | 1–4 digits, a letter, ranges | `lib/pdf/reflow.ts:424` | Numeric bracket citations, left out | Convention | Used by both paths. Words not counted. |
| Bracket `REFERENCE` key | capital + ≤6 letters + 2 digits ("Kir08") | `lib/pdf/reflow.ts:426` | Alphabetic citation keys, left out | Convention | |
| Bracket `MARK_YEAR` | 1500–2099 | `lib/pdf/reflow.ts:427` | A year in brackets keeps the bracket as text | Convention | |
| `MARK_PART_WORDS` | ≤3 words per part | `lib/pdf/reflow.ts:429` | Locators inside a mark ("Theorem 3.9") | Judgement | |
| `MARK_NUMBERS` | 1–4 digits, lists and ranges | `lib/pdf/reading.ts:760` | Raised numbers that may be citations | Convention | |
| `CITED_WORD` | ≥3 letters before | `lib/pdf/reading.ts:763` | A raised number after a word is a citation | Fitted | Dev split, 115 papers (022c328). After shorter words it is an exponent ("cm²") and kept. |
| `RAISED` | raised ≥0.15 × word size, no larger than `SCRIPT_SIZE` | `lib/pdf/reading.ts:810,855` | Raised runs in the reflow read as citations | Fitted | Part of 2588164; dev and test reported. |

### Code and math

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `MATH_FONT` | about 50 TeX, OpenType and office math face families | `lib/pdf/reading.ts:40` | Glyphs in these faces are formulas, left out | Convention | An unlisted math face leaks symbols into the text. |
| `MONO_FONT` / `SANS_FONT` / `BOLD_FONT` / `ITALIC_FONT` | face-name patterns | `lib/pdf/reading.ts:94,96,270,361` | Code faces kept; lone bold or italic variables dropped | Convention | |
| `PROSE_WORDS` | fewer than 3 words of ≥4 letters | `lib/pdf/reading.ts:98,127` | A face used only for formulas on a page | Fitted | Dev split (e1e44c9). Judged per page. |
| Family match | name prefix of ≥5 characters | `lib/pdf/reading.ts:109` | Two faces are one family | Judgement | |
| `OPERATOR` | 39 names (log, max, sup…) | `lib/pdf/reading.ts:230` | Operator names beside formulas, left out | Convention | |
| `SCRIPT_SIZE` | 0.8 × median letter size | `lib/pdf/reading.ts:236` | A script-sized token beside a formula, left out | Fitted | Dev and test reported (3663ae3): leakage 5.86→4.74% and 8.25→7.01%. |
| `SCRIPT_OFFSET` / `SCRIPT_REACH` | 0.1–0.7 × body off the baseline | `lib/pdf/reading.ts:238-240` | A small word is a sub- or superscript | Fitted | Dev only (8bd5703); one dictionary entry motivated the floor. |
| `GLUED` | 0.1 × size | `lib/pdf/reading.ts:245` | No space between a relation and a number | Convention | A thick space is 5/18 em. |
| `CORNER` | 0.79 | `lib/pdf/reading.ts:274` | A glyph is its letter's script | Convention | BabelDOC's ratio: scripts at 0.76, small capitals at 0.8. |
| Formula-face word | ≤3 letters | `lib/pdf/reading.ts:586` | Words in formula-only faces, dropped | Judgement | "km" and "SNR" are dropped; four-letter words are kept. |
| `REFERENCE` words | 40 cross-reference words, plurals included | `lib/pdf/reading.ts:277` | A number after "Eq." or "Theorem" is kept | Convention | English only. |
| Display equation | a block with no letters and a math face | `lib/pdf/reading.ts:890` | Block skipped; the sentence around it carried over | Judgement | |
| `CODE_SHARE` / `CODE_CHARS` | ≥0.9 monospace among ≥20 letters | `lib/pdf/structured.ts:417-418` | Code and quoted prompts, left out | Fitted | Dev only (8cb62db). Prompts quoted in a typewriter face are never scored. |
| `TYPED_BODY` | ≥0.5 of the body monospace | `lib/pdf/structured.ts:419` | Typed documents exempt from the code rule | Fitted | |

### Hostile-input limits and slicing

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `SEARCHES_PER_CHAR` | 512 per run and character | `lib/pdf/reading.ts:90` | Glyph-search budget per page | Safety | 16,000 runs on a line took 1.5 s. Past the budget, glyphs get no runs: unmarked, and a paragraph left with none cannot be placed on the page. |
| `MAX_NESTING` | 32 levels | `lib/pdf/structured.ts:203` | Deepest block read | Safety | Deeper blocks are silently not read. |
| Spread-free helpers | V8's limit of about 120,000 arguments | `lib/pdf/arrays.ts:3` | Arrays of any length | Platform | |
| `MAX_UNIT_TEXT_CHARS` | 200,000 characters | `lib/pdf/units.ts:207` | A unit's text is truncated | Safety | Defined in `lib/dom/text.ts:139`. |
| `SLICE_BLOCKS` | 32 blocks per step | `lib/pdf/structured.ts:532` | Granularity of structure preparation | Measured | No frame over 150 ms at 2,445 pages, where one piece took 0.3 s. |
| `PLAN_SLICE` | 16 blocks | `lib/pdf/units.ts:187` | Granularity of planning | Judgement | |
| `SLICE_MS` | 8 ms | `lib/slices.ts:17` | Main-thread time per slice | Judgement | Shared with the web observers. |
| Vocabulary yields | every 32 texts; every 2,048 words | `lib/pdf/reflow.ts:1301,1306` | Granularity of the vocabulary build | Judgement | |

### Read-ahead

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `SLOW_SCOPE` | 2 pages behind, 6 ahead | `lib/pdf/readAhead.ts:17` | Pages read without asking on a slow or long-used engine | Judgement | Outside it, nothing is scored until scrolled to or asked for. A 3:1 ratio against the 2:1 order weight. |
| Order weight | pages behind count double | `lib/pdf/readAhead.ts:23` | Order of background pages | Judgement | |
| `PAGE_CHUNK` / `PAGE_CHUNK_MS` | 4 pages / 200 ms | `entrypoints/reader/main.ts:402-403` | Pages read per step | Judgement | Then the loop rests as long as it worked: a 50% duty cycle (`:436`). |
| `PAGES_AHEAD` | 2 pages | `entrypoints/reader/main.ts:404` | How far page reading leads scoring | Judgement | |
| Neighbour pages | ±1 page | `entrypoints/reader/main.ts:372,388` | Pages read before a paragraph is planned or scored | Judgement | Avoids rescoring a paragraph that runs onto the next page. |
| Hold and rest times | 1 s not ready; 2 s hidden, low battery or scan; 0.25 s busy; 3 s idle; 5 s after an error | `entrypoints/reader/main.ts:303-306,439,456` | Polling while held | Judgement | |
| `RETRY_MS` / `MAX_TRIES` | 60 s, doubling; 3 tries | `entrypoints/reader/main.ts:105-106,447` | Paragraphs answered without a verdict | Judgement | After three tries they count as read in the menu's share until their page is drawn. |
| Stall pause | 3 empty batches, then 60 s | `entrypoints/reader/main.ts:452` | Backs off a failing engine | Judgement | |
| Low battery | 20% or less while discharging | `entrypoints/reader/main.ts:675` | Read-ahead stops | Platform | Chrome Energy Saver's threshold. Duplicates `LOW_BATTERY` (`lib/capture/pace.ts:134`). |
| Progress text | ETA after 3 samples; dips of ≤2 points hidden | `entrypoints/reader/main.ts:252,256` | The menu's report | Judgement | |
| Scan detection | the first 2 drawn pages have no text | `entrypoints/reader/main.ts:536` | "No text" notice; read-ahead held | Judgement | |
| Read-ahead setting | on | `entrypoints/reader/main.ts:289` | Background reading at all | Judgement | User-settable (`settings.pdfReadAhead`). Off: only drawn pages are scored and counted. |

### Viewer and chips

| Parameter | Value | Where | Controls | Basis | Notes |
|---|---|---|---|---|---|
| `maxCanvasPixels` | 16 Mi pixels | `entrypoints/reader/viewer.ts:40` | Largest page canvas | Judgement | Half of pdf.js's 2^25 default, with no reason recorded. Affects sharpness, not text. |
| pdf.js page buffer | 10 pages (`DEFAULT_CACHE_SIZE`; at least 2 × visible + 1) | `vendor/pdfjs/6.4.299/web/viewer.mjs:14533` | Pages kept drawn | Platform | Without the structure, the reflow reads only these. Running heads and report scope depend on it. |
| `fontExtraProperties` | on | `entrypoints/reader/viewer.ts` (`VIEWER_OPTIONS`) | Whether pdf.js 6 names each run's font | Platform | Without it pdf.js 6 sends no font names, the math-font test finds nothing, and formulas leaked into what is scored (11% of the scored tokens on the benchmark). It also keeps loaded fonts through the viewer's idle cleanup. |
| Document-worker decoders | `jbig2.wasm` and `openjpeg.wasm` from the fork's own tree | `vendor/document-worker/wasm/` (`roots.wasm` in lib/pdf/structureWorker.ts) | Image decoders for Zotero's pdf.js fork | Platform | Kept apart from the viewer's, which are pdf.js 6.4.299's: the fork is another version. |
| Text-layer span cap | 100,000 spans per page | `node_modules/pdfjs-dist/build/pdf.mjs:15004` | Runs that get a span | Platform | Past it there is no span, so those runs cannot be marked (`lib/pdf/units.ts:61`). |
| Structure switch | once the structure and the drawn pages' neighbours are read | `entrypoints/reader/main.ts:192-201` | When the reflow's units are replaced | Judgement | Verdicts for unchanged text come from the cache; changed text is scored again. |
| Script-mark height | under 0.75 of the usual rect height | `entrypoints/reader/chips.ts:32` | Raised marks don't move the chip's line | Judgement | A third "small" threshold beside 0.79 and 0.8. |
| Pill font | 9–12 px, from (0.94 × pitch − 2) / 1.6 | `entrypoints/reader/chips.ts:63` | Chip size | Convention | The badge's own clamp. |
| Trailing reach | obstacles within 40 px, 2 px apart | `entrypoints/reader/chips.ts:121` | Chip goes after a footnote mark | Judgement | |
| Edge margin | 6 px | `entrypoints/reader/chips.ts:127` | Bounds for chip placement | Judgement | With no room, no chip is shown; marks and the list still work. |

### Findings

#### The most consequential parameters

1. **Structure caps.** `MOST_STRUCTURE_PAGES` (2,500), `autoStructurePages` (300 / 600 / 2,500) and `RANGE_PAGES` (1,000) choose between two different readers.
   - The two paths read different text. The structured path leaves out captions, title-page matter and table notes; the reflow reads them, scoring captions and front matter as "apart" units. Verdicts and counted words therefore change with page count, device memory and browser.
   - Firefox and Safari always get 300.
   - The 4 GB and 8 GB rules were never measured on such machines.
2. **The structure deadline.** `TIMEOUT_BASE_MS` + `TIMEOUT_PER_PAGE_MS` (20 s + 250 ms per page) was set from one M4. A slower machine loses the structure silently, and with it whole-document reading.
3. **Paragraph segmentation.** `PARA_GAP` (1.45), `INDENT` (0.5) and `SHORT_LINE` (2) set every unit boundary of the fallback and of numbered manuscripts. They were set on synthetic pages and never swept.
4. **Gutter detection.** `GUTTER_MIN_EMS`, `GUTTER_BAND_SHARE`, `STRETCH_BANDS` and `STRETCH_LINES` decide whether columns are interleaved. One change moved out-of-order paragraphs on test from 146 to 27.
5. **Formula removal.** `MATH_FONT`, `SCRIPT_SIZE`, `CORNER` and `PROSE_WORDS` decide which tokens the model sees. Single changes moved leakage by more than a point.
6. **Structured skip rules.** `CAPTION_LABEL`, `CODE_SHARE`/`CODE_CHARS`, the contents rules, the bibliography shares and `AUTHOR_MARKS` decide which words are never scored or counted, and all of them were fitted on dev only. The code rule also drops quoted AI prompts, which matters for an AI-text detector.
7. **`SLOW_SCOPE`** (2 pages behind, 6 ahead). On a slow engine, or after ten minutes of engine time, most of a long document is never scored unless the user asks.

#### Duplicates and contradictions

- **Values once copied, now shared (2026-10-10):** `SPACE_GAP`, `PARA_GAP`, `INDENT`, `SHORT_LINE`, the edge percentiles (`EDGE_PERCENTILE`) and the pitch fallback (`PITCH_OF_SIZE`) are exported by `reflow.ts`; the reader's battery threshold and input list are `pace.ts`'s `LOW_BATTERY` and `READER_INPUT`.
- **Two caption patterns, named apart:** the reflow's `CAPTION_START` marks a block the join may reach past; the structured path's `CAPTION_LABEL` leaves a caption out. Only the reflow has a 60-word cap.
- **The two paths disagree:**
  - Captions, front matter and footnotes are scored by the reflow (`units.ts:136`) but left out by the structured path.
  - The line-number neighbour window is ±3 heights in the reflow and ±2 in the structured path.
  - `LIST_OPENING` breaks at any dash; `DASH_ITEM` asks what the line above it finished.
  - The two `median()` functions differ: the reflow's averages the middle pair and returns 0 when empty; the structured path's takes the upper middle and returns NaN.
- **"Smaller than body" has five thresholds:** 0.75 (chips), 0.79 (`CORNER`), 0.8 (`SCRIPT_SIZE`), 0.92 (`FOOTNOTE_SIZE`) and 0.95 (`NOTE_SIZE` and the lower edge of `BODY_SIZE_TOLERANCE`).
- **Body size is weighted two ways:** one sample per 4 characters on a page, one per 8 characters in the document.
- **An absolute value among ratios.** `reflow.ts:144-146` promises ratios only, "never an absolute point value"; the structured path's `ORDER_SLACK` is 3 pt.
- **Byte caps and deadlines disagree:**
  - Files from disk may be 100 MiB, but web documents only 50 MiB (`SOURCE_CAP`).
  - Transfer deadlines are 30 s in the relay and 45 s in the loader for the same job.
- **Read-ahead ratios differ.** `readAhead.ts:10` describes a 2:1 reading order, and `readingDistance` matches it. `SLOW_SCOPE` reads in a 3:1 ratio.

#### Judgement values that deserve a measurement

- **Caps and deadlines:**
  - `autoStructurePages` on real 4 GB and 8 GB devices, and the flat 300 for Firefox and Safari;
  - `TIMEOUT_PER_PAGE_MS` on a slow CPU;
  - `RANGE_PAGES` at exactly 1,000 pages;
  - `MAX_BYTES` and the 50 MiB web caps against real document sizes.
- **The reflow core, set on synthetic pages:** `BASELINE_TOL`, `PARA_GAP`, `INDENT`, `SHORT_LINE`, `SIZE_CHANGE`, `HEADING_SIZE`, `HEADING_MAX_WORDS`, `DISPLAY_FONT_SHARE`, `FOOTNOTE_SIZE`, `CAPTION_MAX_WORDS`, the margin bands and the 14-word running-head cap. A dev-split sweep with the existing `bench.mjs run` would cover them.
- **Glyph location:** `BOX_SLACK`, `DRIFT` and `RUN_REACH`, measured as the rate of glyphs left without a run.
- **`SEARCHES_PER_CHAR`:** confirm that no benchmark page exhausts it.
- **Viewer and read-ahead:** `maxCanvasPixels`, `SLOW_SCOPE`, `PAGE_CHUNK` and `PAGES_AHEAD`.

#### Benchmark-fitted values and the test split

- **The test split exists.** `bench.mjs:43` assigns about 31% of documents to test by the SHA-1 of their id. This applies to every corpus, olmOCR-Bench pages included.
- **Fitted on dev, test reported together on 2026-10-10.** Coverage held (95.7% on test against 96.2% on dev), and leakage rose from 3.3% to 4.6%, spread thinly over kinds (above, under Overfitting risk), with no one rule failing:
  - `CAPTION_LABEL` and `NAMES_NEXT`;
  - the caption-rest gaps and the `NOTE_*` values;
  - `AFFILIATION`, `AUTHOR_MARKS` and `WORDS_PER_MARK`;
  - `CODE_SHARE`, `CODE_CHARS` and `TYPED_BODY`;
  - the contents and bibliography shares;
  - `ORDER_SLACK`, `SHARED` and `HEADLINE_SHARED`;
  - `FOLDED_MIN`, `FLUSH_SHARE` and `RAGGED_SHORT`;
  - `SCRIPT_OFFSET` and `SCRIPT_REACH`;
  - `PROSE_WORDS` and `CITED_WORD`.
- **Fitted, with test reported:**
  - `GUTTER_MIN_EMS`;
  - `STRETCH_BANDS` and `STRETCH_LINES`;
  - the `lineNumbers.ts` values;
  - `CELL_GAP`, `NUMBERED_TABLE` and `GAPPED_TABLE`;
  - `SCRIPT_SIZE` and `RAISED`;
  - `BODY_SIZE_TOLERANCE` and `IN_FLOAT`.
- **Thin evidence, high overfitting risk:**
  - The line-number family rests on 18 manuscripts, only 7 of them with tagged truth. `FOLDED_MIN` rests on four.
  - `FLUSH_SHARE`'s test result was "unchanged", probably because the test split has no ragged manuscript.
  - `HEADLINE_SHARED` and `ORDER_SLACK` rest on one or two magazine pages.
  - `STRETCH_BANDS` was tuned for one olmOCR page. It was kept although olmOCR's test score fell from 441 to 433.
- **Not held out:** the page-turn rule (353e6c7) was measured over all 207 papers.
- **Fitted to a unit test:** `HYPHEN_MEASURE` was changed to pass `test/scenarios.mjs`.

#### Comments that no longer match the code

1. **`lib/pdf/reflow.ts:14-18`** says footnotes and formula fragments "are left as the paragraphs … they look like". In fact `markAsides` (`reflow.ts:1419`) marks footnotes and captions, and `readReflowed` (`reading.ts:873`) removes formulas and citation marks. Line 18 still says "the daemon", although there are now two engines.

## Area 5: Statistics, settings, site access and diagnostics

This part of Anagram decides what counts as read and how the reading log is kept and shown (`lib/stats/`, `entrypoints/stats/`, `docs/statistics.md`). It also covers every user setting and its default (`lib/settings/`), site access, sessions and message bounds (`lib/access/`, `lib/messaging/`, the non-engine parts of `entrypoints/background.ts`), the diagnostics report, i18n and logging. Some values that belong to other areas also shape the statistics: the fling detector, the score cuts and the minimum length. Those rows are marked "(inherited)" and are listed here only for their effect on the statistics. Engine-choice storage items (`engine`, `engineTier`) are covered by the engines survey. All paths are relative to the repository root on `dev`.

No value in `lib/stats/` is backed by a measurement in a comment, doc, changelog entry or the commits that made it (`1fb4bc9`, and `cc429af` for the reading log). No value in this area appears to be fitted to tests: the tests use the constants by name or use fixtures well clear of the thresholds.

### What counts as read

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `DEFAULT_LENS` read rule | 1000 ms in all with some of the paragraph in the middle 80% (`visibility: "band"`), time flung past not counted, once per visit | lib/stats/lens.ts:38-41 | What totals, visits and the toolbar menu count as read | Judgement | The rule a paper must report. Raising the time drops skimmed text, mostly in feeds. |
| `READ_MS` / `BAND_MARGIN` | 1000 ms; `-10% 0px -10% 0px`, `threshold: 0` | lib/stats/recorder.ts:32-33, :248, :782 | The default rule as the recorder applies it (`readAt`) | Judgement | Copies of `DEFAULT_LENS`'s time and band. One line inside the band counts the whole paragraph's words, so word totals favour long paragraphs. |
| Exposure kept | per paragraph: any part, at least half, the middle band; each as all, focused, flung, both, in ms while shown | lib/stats/recorder.ts:229-252 | What another rule can be applied to | Judgement | Settled at each change of state (shown, focus, fling), not sampled per tick. Kept at paragraph rows or finer only. |
| "At least half" | ≥0.5 of the paragraph, or any of it when taller than the viewport | lib/stats/recorder.ts:349 | The lens's `half` visibility | Judgement | — |
| Lens choices | read after 0.25–30 s; band, half or any; focused only; flung or not; once per visit, day or ever; expected words, chip word or most likely band; words, paragraphs or seconds; AI or heavy and AI; floor 50, 75, 100 or 150 | entrypoints/stats/main.ts:100-108; lib/stats/lens.ts:13-36 | **How it counts** on the statistics page | Judgement | Applies to paragraph rows or finer; totals hold the default alone. Once per day or ever needs the text's hash, else a paragraph counts once per visit. Above 50 the floor is approximate. Kept for the tab's session only. |
| `READING_SCREENS_PER_SECOND` (inherited) | 2 screens/s | lib/capture/fling.ts:15 | Scroll speed above which time is "flung" | Judgement | Justified only as "a page of prose is read in a minute, skimmed in a few seconds". The recorder follows the scheduler's detector on each scroll (lib/stats/recorder.ts:549-551, :576-580), so retuning scheduling changes the default rule. Report it. |
| `SETTLE_MS` (inherited) | 150 ms | lib/capture/fling.ts:17 | How long after a fast scroll time still counts as flung | Convention | The usual scroll-end debounce from before `scrollend`. Small effect on counts. |
| Visibility gate | time counts only while `document.visibilityState !== "hidden"` | lib/stats/recorder.ts:202, :633 | Whether on-screen time accrues | Platform | A visible, unfocused window counts; focused time is kept apart. Reading has no idle check: a page left open counts its first screen after 1 s. Measures exposure, not attention. |
| `TICK_MS` | 1000 ms | lib/stats/recorder.ts:35, :427 | How often time on screen is added up while a paragraph is on screen | Judgement | The time stays exact; reaching `READ_MS` is noticed up to 1 s late. |
| Once per visit | deduplicated by `cyrb53(text)` | lib/stats/recorder.ts:483, :495 | A paragraph scrolled back to adds nothing | Judgement | Identical text twice in one visit counts once. A reload, a new visit or another day counts it again, so totals measure exposures, not unique text. |
| Visit boundary | one document at `location.origin + location.pathname`; a changed query or fragment is the same visit | lib/capture/orchestrator.ts:1427-1431 | When the per-visit deduplication resets | Judgement | Sites addressed by query (YouTube `watch?v=`) stay one visit. A route to another path is a new visit, which counts again what is still on screen. |
| Read before its verdict | counted when the verdict comes; still without one at the visit's end, `unavailable`; taken off the page first, `removed` | lib/stats/recorder.ts:302-311, :519-524, :718-723 | Paragraphs read before they are scored | Judgement | A slow engine or fast navigation moves words from scored to unavailable. |
| Short-stretch counting | counted as `short` once read | lib/stats/recorder.ts:294, :489-496 | Which sub-floor text enters coverage | Judgement | Only prose the walker reports through `onShortText`. Labels and chrome, such as runs under `MIN_MERGE_WORDS` (8), never count. The recorder never asks `stillShort`, so a stretch a later walk joined into a unit still counts as short. |
| `MOST_HELD` | 2000 short stretches | lib/stats/meter.ts:49 | Stretches held until the recorder chunk has loaded | Safety | More are not counted. |
| Private windows | never measured: the recorder is not loaded (`inIncognitoContext`); the worker drops `tab.incognito` | lib/stats/meter.ts:18-24; lib/capture/orchestrator.ts:1544; lib/stats/worker.ts:137 | Excludes private browsing | Judgement | A fixed privacy choice. Private reading is missing from every share, and a study cannot know how much. |
| Coverage by access | only documents Anagram runs in: granted (or one-off) http(s) pages and the PDF reader, with an authorised session | entrypoints/background.ts:436-437; lib/capture/orchestrator.ts:1544 | Which reading can be measured at all | Judgement | Other reading leaves only the time in front of tabs Anagram cannot read (`cover` layer). The participant's grants create selection bias. `leftOut`, text dropped by why, is in the schema but nothing fills it. |

### Time shown and sending

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `IDLE_MS` | 120 000 ms (2 min) | lib/stats/recorder.ts:34, :265 | A visit's `active` time and idle spells | Judgement | Never changes what is read or any share. |
| Activity signals | pointer, wheel, touch, keys, scrolling, a form field, a paragraph coming on screen | lib/stats/recorder.ts:377, :547, :601-605, :624 | What counts as somebody there | Judgement | — |
| `FLUSH_MS` | 5000 ms; also on freeze and at `pagehide` | lib/stats/recorder.ts:38, :652 | Delay before what was learned is sent | Judgement | The last message of a visit goes over the document's session port. |
| `HEARTBEAT_MS` | 60 000 ms | lib/stats/model.ts | How often a shown page sends its time when nothing else goes | Judgement | Top frame and PDF reader only (`ownsDwell`). The worker counts a tab silent for `COVERED_MS` (`HEARTBEAT_MS` + 10 s) as uncovered. |
| `MOST_LEFT_OUT_CHARS` | 50,000 characters | lib/dom/walker.ts | How much of a left-out element's text has its words counted (`leftOut`: links, symbols, names, code, teaser, chrome, hidden) | Safety | Words are counted, never kept, once per node per visit. A larger left-out element is counted short. |
| `SHOWN_TO_SEND_MS` | 1000 ms | lib/stats/recorder.ts:42, :728 | A visit is sent once shown this long, or once something on it was read | Judgement | A tab opened behind another and never looked at is no visit. |
| Message caps | `MOST_UNITS` 200, `MOST_EVENTS` 4000 per stream, `MOST_TEXT` 400 000 chars | lib/stats/recorder.ts:44-47, :748, :767 | How a send is split | Safety | Under `STATS_LIMITS`. Events past 4000 in one send are dropped, not sent later. |
| Event-layer details | `MOVED_PX` 20 px; `EPISODE_GAP_MS` 300 ms; `TENTHS` (visible-share steps of 0.1); pointer track ≤10 a second; `READ_KEYS` | lib/stats/recorder.ts:49-52, :152, :781 | Layout moves, scroll episodes, visible-share steps, input kinds | Judgement | Only at the event layers. Which key was pressed is never kept. |
| No resend | a failed send is dropped | lib/stats/recorder.ts:757 | Delivery guarantee | Judgement | A restarting worker or a withdrawn grant loses a few seconds of reading. Small, unmeasured downward bias. |
| `LEAVING_MS` | 2000 ms | lib/access/worker.ts:375, :397 | How long a document a new one replaced in its tab keeps its session | Judgement | Long enough for its last message to arrive. A route change (`pushState`) is no new document and ends no session. |

### Aggregation and the share

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| Expected-share rule | `expected[i] += words × pᵢ`; share = expected / scored | lib/stats/model.ts:114-123, :83-91 | The headline statistic | Judgement | Estimates prevalence only if the probabilities are calibrated on this reading population. Borderline paragraphs are not rounded. The paper must state this definition. |
| Weighting | words (`weight: "words"`); a lens can weigh paragraphs or seconds on screen | lib/stats/lens.ts:76-82 | What the share is averaged over | Judgement | Long texts dominate: one long article outweighs many posts. |
| Headline band | AI-generated only (`headline: "ai"`); a lens can add heavily edited | lib/stats/lens.ts:106-112; lib/stats/model.ts:89-91 | The "AI-generated" headline number | Judgement | Flagging defaults to heavily edited and above. All four bands are exported. |
| Denominator | scored words only; `short`, `language`, `unavailable` and `removed` apart | lib/stats/model.ts:44-68 | The population the share is conditional on | Judgement | The share covers English text at or above the floor that got a verdict. If AI text differs in length, language or scoring latency, it is biased. Always report coverage. |
| `units` and `argmax` | paragraphs under the chip's word (Σ pᵢ·i/3) and under the most likely band | lib/stats/model.ts:102-111, :119-120 | Paragraph counts per band | Model | `[0.4,0,0,0.6]` is heavily edited by the chip and AI-generated by argmax. A Rogan–Gladen correction needs sensitivity and specificity for the decoding it uses. |
| `SCORE_CUTS` (inherited) | 1/6, 1/2, 5/6 | lib/render/scale.ts:18 | Band boundaries for `units` | Model | Halfway between bucket centres (EditLens weighted-average decoding). Exported as `scale.cuts`. |
| Renormalisation | p / Σp; uniform 0.25 each if Σ = 0 | lib/stats/worker.ts:285-288 | The stored distribution | Safety | The uniform fallback cannot be reached after the schema check (Σ within ±0.02). |
| Probability-sum tolerance | \|Σp − 1\| ≤ 0.02 | lib/stats/wire.ts:93 | Whether a paragraph is accepted | Safety | One bad paragraph silently rejects the whole message. A model whose outputs drift would lose data unseen. |
| 30-day comparison | pooled share over today−29 … today, by the lens on screen | entrypoints/stats/main.ts (`render`) | "Over the last 30 days, today included" | Judgement | A word-weighted pooled ratio, not a mean of daily shares, and the wording says so. It includes the period on screen. Display only. |
| Share display | whole percent; "<1%" when 0 < x < 0.005; "–" with nothing scored | lib/stats/format.ts:24-28 | Headline and table text | Convention | Display only; the export has the full numbers. |
| Toolbar menu line | today's pooled AI share and words scored, every 5th tick while open | entrypoints/popup/main.ts:436-445, :630 | The menu's statistics line | Judgement | Read from the day's total. |
| `TOP_SITES`, `MOST_ROWS` | 10 sites; 200 pages | entrypoints/stats/main.ts:45-46 | Rows listed on the statistics page | Judgement | Display only. Sites are ranked by words viewed. |

### Layers, presets and retention

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `DIMENSIONS` | 21 dimensions, each a ladder of layers from finest to none | lib/stats/config.ts:15-49 | What each field may keep | Judgement | A coarser layer can always be made from a finer one, never the reverse. |
| `PRESETS` | Daily totals, Daily totals and sites, Every page, Every paragraph, Research study, Full reading trace, Full trace with text | lib/stats/config.ts:91-107 | The layers each preset keeps | Judgement | Only Every paragraph and finer keep what another rule for "read" needs. Research study: events at tenths of a second, domains, sketches, no text. |
| Off by default | `OFF`; a stored value that is no configuration reads as off | lib/stats/config.ts:113, :189-200; lib/settings/settings.ts:41 | Whether anything is recorded | Judgement | Opt-in by design. A study must instruct participants and check their layers. |
| `normalize` | what the rows cannot hold is made coarser; an event log times to the second or finer; paragraph rows keep words to the nearest 5 or finer | lib/stats/config.ts:148-185 | The configuration as kept | Judgement | Settings says which dimensions moved. |
| `RETENTION` / `DEFAULT_RETENTION` | fine trace 7, 30 or 90 days (7); visits and paragraphs 30, 90 or 365 (90); totals 365 days or until cleared (until cleared) | lib/stats/config.ts:61-70 | When old rows are deleted | Judgement | Pruned at most once a day, on the day's first message (lib/stats/worker.ts:120-130), so expired rows stay until something is recorded. Studies longer than 90 days need 365 or periodic exports. Deletion is irreversible. |
| Layer cut-offs | durations in doubling bins, 250 ms to 64 s (`DUR_BINS`); length bands at 50, 75, 150, 300, 600 (`LEN_BANDS`); path segments with a digit or over 24 chars as `:id`, three or more hyphenated parts as `:slug`; short titles 60 chars, full ones cut at 300; a text's head 12 words; verdicts to 2 decimals (`probs2`) | lib/stats/coarsen.ts:24, :107, :68-79, :100-104, :127; lib/stats/hash.ts:95-102 | What each coarser layer keeps | Judgement | — |
| `PUBLIC_SUFFIXES` | 119: 95 country second levels and 24 hosts that give each site a subdomain | lib/publicSuffixes.ts | A host's registered domain, and where site rules stop inheriting | Judgement | One list for the reading log and the site rules (2026-10-10; there were two). Not the Public Suffix List: a missing suffix names a site one label too high. |
| `HASHABLE` | addresses and titles | lib/stats/config.ts:58 | What can be kept as salted hashes | Judgement | — |
| Keeping less | what was kept stays unless the reader confirms deleting it | entrypoints/options/main.ts:334-347; lib/stats/strip.ts | What survives a change of layers | Judgement | Each configuration is noted in `context` and exported as `manifest.recorded`. |
| Models per total | 4 | lib/stats/store.ts:282 | Model versions noted on a day's total | Safety | A fifth distinct model in one day is not noted, so provenance can be incomplete without saying so. |

### Hashes and sketches

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `keyedHash` | 64 bits of HMAC-SHA-256 | lib/stats/hash.ts:35-37 | A text's, site's or title's salted hash | Safety | About one chance in thirty million of a collision among a million texts. |
| `SKETCH_SLOTS` / `SHINGLE_WORDS` | 32 slots of 16 bits (b-bit MinHash); 5-word shingles | lib/stats/hash.ts:40-41 | A paragraph's near-duplicate sketch | Judgement | Similarity comes in steps of 1/32. A text of five words or fewer is one shingle. |
| Log secret | 32 random bytes | lib/stats/settings.ts:25-36 | The key of every hash and sketch | Safety | Kept in the extension's storage, never exported, made anew when the statistics are cleared. |
| Export key | a new random key per file (`link: "file"`, the default), or the profile's stable one | lib/stats/export.ts:55-68; entrypoints/stats/main.ts:564-565 | Whether two files can be joined | Judgement | Every id, hash and sketch is keyed again for the file. |

### Worker, tabs and limits

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `STATS_LIMITS` | 256 paragraphs, 2048 reads, 4096 events, 200 000 text chars, 600 000 chars a message, 100 000 words, 31 days of ms, 512 idle spells, 1440 minutes, strings of 64, addresses of 8192 | lib/stats/wire.ts:82-85 | The message schema | Safety | One field over its limit rejects the whole message, unseen. |
| Excluded sources | private windows, sites switched off (even one-off runs), Analyze text | lib/stats/worker.ts:137-141; lib/access/messages.ts:138 | Reading refused at write time | Judgement | A participant's "off" rules remove whole sites from the denominator without trace. |
| Day boundary | the local date of the visit's start, as the page sends it | lib/stats/worker.ts:165 | Which day a visit is filed under | Judgement | A visit across midnight is filed under the day it began. Report "local day". |
| Page and site keys | page totals at the `place` layer (origin and path for Every page), `file:` and its title for a local file; a site is the host or registered domain | lib/stats/worker.ts:259-266 | Granularity of totals | Judgement | Query-addressed pages merge (every HN `item?id=` thread is one row a day), and revisits add up. |
| Where words are filed | a frame's words go to the tab's top page; the PDF reader's to its `src` | lib/stats/worker.ts:76-107 | Site and page attribution | Judgement | Disqus or giscus comments count for the host page, as site rules apply. |
| Visit owners | 5000 visit ids remembered | lib/stats/worker.ts:143-147 | Which document may add to a visit | Safety | — |
| `COVERED_MS` / `UNCOVERED_MIN_MS` | `HEARTBEAT_MS` + 10 s (70 s); 1 s | lib/stats/tabs.ts | Time in front of tabs Anagram cannot read | Judgement | Derived from the heartbeat, so it always exceeds it. Shorter spells are not kept. |
| `datesBetween` cap | 400 dates | lib/stats/model.ts:351 | Length of a date range | Safety | Above the 365-day maximum retention, so it never binds. |

### Export

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| Export layers | each dimension at the layer chosen, never finer than kept; JSON, JSON.gz or a CSV zip | lib/stats/export.ts:58; entrypoints/stats/main.ts:637-638 | Detail in the file | Judgement | The dialog shows the tables, rows and size first. |
| Rounding | expected words to 0.1; `scale.cuts` to 4 decimals | lib/stats/export.ts:245, :220 | Precision in the file | Judgement | Band sums can differ from `words.scored` by rounding. |
| Period exported | the period on screen: Today (default), 7 days, 30 days, a month or a range | entrypoints/stats/main.ts:135-136 | Date range of the file | Judgement | Retention silently bounds what any export can contain. |

### Page kinds

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| Precedence | forum, then feed, then declared article, then structure, then a body of text | lib/stats/pageKind.ts (`kindFrom`) | Order of the tests | Measured | A Reddit thread is a forum (its path is tested first). A declared article with many comment `<article>`s stays an article. The whole rule files 0.80 of the web benchmark's held-out labelled pages right (0.81 dev; 0.65 and 0.68 before the rules of 2026-10-09). |
| `FEED_HOSTS` and `role="feed"` | 14 hosts (x.com, twitter.com, facebook.com, instagram.com, threads.net/.com, bsky.app, linkedin.com, mastodon.social, tumblr.com, weibo.com/.cn, reddit.com, tiktok.com), subdomains included; any page with `role="feed"` | lib/stats/pageKind.ts:30-33, :86 | Feeds by host or by declaration | Judgement | Every non-forum page there is a feed, including LinkedIn articles. YouTube and other Mastodon servers are absent. Drives "feeds against the rest". The benchmark has no real feeds, so this part is unvalidated. |
| `FORUM_ADDRESS`, `FORUM_SOFTWARE`, `FORUM_HOST` and HN | thread paths and queries (`/questions/…`, `/comments/…`, `/t/…`, `/forum/…`, `viewtopic.php`, `?topic=`…); a generator meta naming forum software (Discourse, phpBB, XenForo…); a `forum.`, `community.` or `discuss.` host; `news.ycombinator.com/item` | lib/stats/pageKind.ts | Forums by address, software and host | Measured | Any site with such a path, such as a news `/comments/` page, becomes a forum. Part of the rule measured above. |
| Declared types | JSON-LD or microdata QAPage, DiscussionForumPosting; Article, NewsArticle, BlogPosting, Report, ScholarlyArticle, TechArticle; `og:type=article` | lib/stats/pageKind.ts:37-38, :68-70 | Kind the page claims | Judgement | `og:type=article` is very common, so "article" is generous. |
| `LD_CHARS` | 20 000 characters | lib/stats/pageKind.ts:45 | JSON-LD scanned | Safety | A type declared late in large JSON-LD is missed. |
| `POST` selector | `article, [role="article"], [aria-posinset], [role="listitem"]:not(li)` | lib/stats/pageKind.ts | What counts as a post | Judgement | Counts containers, not authors. The recorder imports it. |
| `manyVoices` / `onePost` | 5 posts, more than half of sampled units inside posts, and no post holding 40% of the words | lib/stats/lens.ts (`DEFAULT_KIND_RULE`); lib/stats/pageKind.ts | Feed by structure | Measured | `onePost` keeps an article with its comments from reading as a feed. No real feeds to check it on. Another rule can be applied to the signals a visit kept. |
| `KIND_SAMPLE` | 64 units | lib/stats/pageKind.ts, used by lib/capture/orchestrator.ts | Units inspected | Judgement | The first units found, in the walk's order. |
| `articleShare` / `textBody` / `ogBody` | ≥60% of sampled words in one post, or in `<main>` with a 300-word body when there is at most one post; or any 300-word body (the words one element holds as its own paragraphs); `og:type=article` alone needs a 150-word body | lib/stats/lens.ts (`DEFAULT_KIND_RULE`); lib/stats/pageKind.ts | Article without a declaration, and a bare og:type | Measured | Otherwise "other"; an `og:type=product` page with no Article type is "other". Part of the rule measured above. |
| Documents | the PDF reader, Google Docs and reading surfaces are forced to `document` | entrypoints/content.ts:146; entrypoints/reader/main.ts:475 | The document kind | Judgement | PDFs in the browser's own viewer are not measured unless opened in the reader (`autoOpenPdfs` is off by default). |
| Re-evaluation | on every send, on the current DOM; an exception gives `other` | lib/stats/recorder.ts:683, :704-706 | Kind per message | Judgement | One page's words can split across kinds as it loads. A visit keeps its last message's kind, a page total its first (lib/stats/store.ts:278). |

### User settings and defaults

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `statsConfig` | off by default; a preset, or a layer per dimension, and a retention per part | lib/settings/settings.ts:41; lib/stats/config.ts:113 | Whether anything is recorded, and what | Judgement | Opt-in by design; set in Settings or on the statistics page. A study must instruct participants and check their layers. |
| Preset preselected on the statistics page | Daily totals (the first) | entrypoints/stats/main.ts:523-528 | What "Turn on" applies by default | Judgement | Participants who accept it record no sites, pages or paragraphs, so no other rule for "read" can be applied afterwards. |
| `MODEL_MIN_WORDS` (inherited) | 75 words | lib/dom/text.ts:94 | The model's training minimum | Model | The floor of 50 lets verdicts on 50–74 words enter the share. Only paragraph rows mark them (`verdict.doubt`). |
| `flagFrom` (`DEFAULT_FLAG_FROM`) | default `heavy`; choices light, heavy, ai | lib/settings/settings.ts:37; lib/render/flagLevel.ts:9 | Which paragraphs are flagged and counted on the icon | Judgement | The comment says "heavily edited" is right under a third of the time. It changes no statistic but sits beside the AI-only headline. |
| `enabled` | default true | lib/settings/settings.ts:14 | Master switch | Judgement | Decides which sites are recorded when no site rule applies. |
| `siteOverrides` | default `{}`; host → on/off, the most specific rule wins, parent domains inherit | lib/settings/settings.ts:15, :90–138 | Per-site rules | Judgement | An "off" rule removes the site from the statistics, even for one-off runs. |
| `showHighlights` and `underlineScope` | true and `flagged` (UI: flagged, every paragraph, off) | lib/settings/settings.ts:17, :19 | Underlines | Judgement | Display only. |
| `displayMode` | default `all`; choices all, flagged | lib/settings/settings.ts:32–34 | Chips shown | Judgement | Rendering only; the statistics are unaffected. |
| `autoOpenPdfs` | default false | lib/settings/settings.ts:21 | Whether PDF tabs open in the reader | Judgement | Off means PDFs read in the browser's viewer are not measured, so the `document` kind is undercounted. |
| `pdfStructure` | default true; no UI | lib/settings/settings.ts:25 | Zotero structure or the reader's own reflow | Judgement | Changes PDF paragraphs, and with them words and verdicts. Not recorded in the statistics. |
| `pdfReadAhead` | default true | lib/settings/settings.ts:28 | Reading undrawn PDF pages in the background | Judgement | Off, more PDF paragraphs are read before they have a verdict, so `unavailable` grows. |
| `cacheMode` | default `persistent` (30-day expiry); choice `session` | lib/settings/settings.ts:7; lib/cachePolicy.ts:2 | Verdict cache | Judgement | Cached verdicts arrive at once and lower `unavailable`. |
| `debug` | default false; no UI | lib/settings/settings.ts:30; lib/log.ts:30–39 | Console logging | Judgement | Errors are always logged, namespaced. |
| Fallback to the default | a stored value that is not a choice reads as the default | lib/stats/config.ts:189-206; lib/render/flagLevel.ts:18-20 | Robust reads | Safety | Hard-coded copies in the diagnostics (`true`, `"all"`) can drift from these defaults (see Findings). |
| One-shot end rule | ends only when this site is newly turned off | lib/settings/oneShot.ts:31–35 | Whether a menu-started run survives other setting writes | Judgement | Other rules and the global switch do not stop it. |

### Site access, sessions and messaging

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `ALL_SITES` | `https://*/*`, `http://*/*`; optional | lib/access/patterns.ts:13 | The one-click grant | Platform | Nothing is read or counted before a grant. Coverage depends on what each participant grants. |
| `OFF_LIMITS` and exclusions | Chrome Web Store (old and new hosts), addons.mozilla.org; `file:` and IPv6 literals | lib/access/patterns.ts:20–24, :41–43 | Sites never requested | Platform | Browsers block extensions there anyway. |
| Comment `PROVIDERS` | Disqus, Facebook comments plugin, utterances, giscus; https only | lib/access/commentFrames.ts:21–30 | Third-party comment frames Anagram offers to read | Judgement | Without a grant these threads are unread and uncounted. Once read, they count for the host page. |
| Content-script registration | the top frame, `matchOriginAsFallback`, `document_end`; every frame below runs the stub, which asks for the content script (`readFrame`); page-world pair at `document_start`; persisted | lib/access/worker.ts:84-134, :302-310 | Where and when the reader runs | Judgement | Covers srcdoc and blob frames (e-book readers) once their stub asks. Chrome before 119 gets no fallback, so those frames are not read. |
| `PING_TRIES`, `PING_GAP_MS` | 15 × 100 ms (≈1.5 s) | lib/access/worker.ts:55–56 | Wait for an injected script to answer | Judgement | A slow page can report failure although injection worked. |
| `PER_TAB_SESSIONS` | 128 documents per tab | lib/access/authority.ts:16–18 | Frames served per tab | Safety | Frames past 128 are refused: unread and uncounted. |
| Global session cap | 1024 live documents | lib/access/authority.ts:73 | Documents across all tabs | Safety | An unnamed literal. Past it, new documents are refused silently. |
| `SESSION_HANDSHAKE_MS` | 2000 ms on both sides | lib/access/messages.ts:18 (lib/access/session.ts:66; lib/access/authority.ts:64) | Deadline to establish a document session | Safety | One constant for both sides. A worker slow to wake fails the session, and statistics sends then reject. |
| Score request bounds | ≤256 blocks; ≤16 000 chars a block; ≤256 000 chars; ≤900 000 bytes encoded; ids ≤64 chars | lib/access/messages.ts:30-38 | Accepted score batches | Safety | Checked before any hashing or queueing. All but the encoded size come from anagramd/contract.json. |
| Token-count bounds | worker: 512 texts, 256 000 chars; client: `COUNT_TEXTS` 512, `COUNT_CHARS` 200 000 | lib/access/messages.ts:39-40; lib/messaging/client.ts:82-83 | Size of a count request | Safety | The client comment says this is "what the worker takes", but 200 000 ≠ 256 000. Harmless (conservative), but a drift. |
| Other message bounds | URL ≤8192 chars; badge count ≤1 000 000; ≤8 comment origins | lib/access/messages.ts:23, :53, :57 | Validation | Safety | — |
| Score retry | one retry after 300 ms; a second refusal stands | lib/messaging/client.ts:53–78 | Transient transport failures | Judgement | A failure gives "unreachable", and those units can end as `unavailable`. |
| Cache partition key | `private`/`normal` + the tab's top host + the frame's origin | entrypoints/background.ts:60–67 | Which cached verdicts a page may reuse | Convention | Mirrors browser storage partitioning. Narrower partitions mean fewer cache hits and more waiting for verdicts. |
| PDF link menu patterns | `*://*/*.pdf`, `*.pdf?*`, `*.PDF`, `*.PDF?*` | entrypoints/background.ts:270 | When "Open PDF" is offered on a link | Judgement | Mixed-case (`.Pdf`) and extensionless PDF links are not offered. |
| `FLASH_MS` | 1500 ms | entrypoints/background.ts:117 | Badge tick after Copy diagnostics | Judgement | Feedback only. |

### Diagnostics, i18n and logging

| Parameter | Value | Where | Controls | Basis | Notes |
| --- | --- | --- | --- | --- | --- |
| `MAX_BYTES` | 60 000 bytes | lib/diagnostics/report.ts:29, :274, :338–343 | Size cap of the copied report | Judgement | "What a chat window will take". 200-byte slack for the structure budget; the last cut goes in 256-character steps. |
| `MAX_SILENT` | 15 stretches | lib/diagnostics/report.ts:31 | Silent stretches named | Judgement | "Past this the answer repeats itself." |
| Report scope | 12 subframes listed; climbs ≤8 ancestors to a box with ≥200 characters | lib/diagnostics/report.ts:135, :184–185 | Which region is anonymised | Judgement | — |
| `captureRegion` limit | 24 000 by default (the report passes its remaining budget) | lib/diagnostics/anonymise.ts:224 | Size of the anonymised fixture | Safety | — |
| Anonymisation caps | `MAX_WORDY_TOKENS` 6 per class or id; attribute values ≤40 chars | lib/diagnostics/anonymise.ts:61, :186 | What structure survives anonymisation | Safety | A privacy bound: fewer tokens leak less and identify containers worse. |
| Walker thresholds | `SMALL_OUT_OF_FLOW_CHARS` 40, `MAX_LINK_RATIO` 0.7, `MAX_SYMBOL_NOISE` 0.2 | lib/diagnostics/silence.ts | Reasons the report gives | Judgement | Imported from the walker and `lib/dom/text.ts` (2026-10-10), so the report's reasons follow the walk. |
| `MIN_STRETCH_WORDS` | = `MIN_MERGE_WORDS` (8) | lib/diagnostics/silence.ts:71 | Smallest stretch the report names | Judgement | — |
| Closed-shadow detection | box >10 000 px²; at most 6 listed | lib/diagnostics/silence.ts:213, :260 | "Dark" custom elements reported | Judgement | — |
| Survey walk floor | `MIN_WORDS` (50), or another a benchmark passes | lib/diagnostics/silence.ts:130-131 | The report's re-run of the walk | Judgement | The same floor and grouping as the page's walk. |
| `MAX_ANSWERED` | 2000 memoised messages | lib/i18n.ts:59–60 | i18n memo size | Safety | The memo itself is Measured ("12 ms in 30 s" on a chat); the cap is not. |

### Findings

#### The most consequential parameters for the research measurement

1. **The minimum length (`MIN_WORDS` 50, short paragraphs always grouped).** It decides which text the share is computed over. Short posts, the bulk of a feed, fall to `short` and leave the denominator. Verdicts on 50–74 words, below the model's 75-word training minimum, enter the share; only paragraph rows mark them. It is the same for every participant; a lens can raise it afterwards, approximately.
2. **The estimand: expected share, AI band only, word-weighted** (`model.ts:83-123`). The headline is Σ words·p₃ / Σ scored words. It equals prevalence only if the model's probabilities are calibrated for this population. It excludes "heavily edited", although flagging defaults to heavy and above, and long texts dominate it. `units` and `argmax` give two more estimators, paragraph-weighted.
3. **What "read" means by default: 1 s, the 80% band with threshold 0, the page shown, time flung past left out, no idle gate on reading.** Together these measure exposure, not reading. A paragraph with one line in the band for 1 s counts all its words, and a page left visible counts its first screen. Paragraph rows keep the time on screen three ways, so another rule can be applied to them; totals hold this one.
4. **Coverage gates.** Only granted, enabled http(s) pages and the PDF reader are measured. There is nothing from private windows, sites switched off, non-English text, or PDFs in the browser's viewer (`autoOpenPdfs` off). Other reading leaves only the time in front of tabs Anagram cannot read, so coverage of total reading can be bounded in time, not in words.
5. **Verdict latency becomes `unavailable`.** Paragraphs read but unscored at the end of a visit count as unavailable; those the page removed first, as `removed`. Coverage therefore depends on engine speed (CPU or in-browser), `pdfReadAhead` and `cacheMode`. If AI text differs in length, and so in latency, the share is biased.
6. **The fling threshold (2 screens/s)**, shared with the scheduler. Fast feed scrolling is left out by default, and a change made for scheduling reasons silently changes the statistic. Time flung past is kept apart, so a lens can count it.
7. **The visit and page-key rules (origin+path).** Text is counted once per visit by default, so totals count repeated exposures; a lens can count once per day or ever where the text's hash is kept. Query-addressed pages merge into one record a day, which distorts any per-page analysis.
8. **The page-kind heuristics** (`FEED_HOSTS`, `manyVoices` 5, `onePost` 0.4, `articleShare` 0.6, `textBody` 300, `ogBody` 150, the forum signals). Checked on the web benchmark's labelled articles, forums and other pages (0.80 held out), but not on real feeds, which drive the "feeds against the rest" comparison a paper would likely cite.
9. **The preset.** Only Every paragraph and finer let anything above be changed afterwards, and the statistics page preselects Daily totals.

#### Report and sensitivity analysis

- **A paper should report:** the rule for "read" (time, visibility, focus, fling) and what it counts once per; the minimum length (50 words, grouped); the model id, version and calibration (the tier is in the id); the estimand (expected share, band 3, word-weighted); the full coverage breakdown (`short`, `language`, `unavailable`, `removed`, time on tabs Anagram cannot read); the local-day definition; each participant's layers (`manifest.recorded`) and granted-site scope; and `IDLE_MS` if active time is used.
- **Sensitivity analysis** is possible on paragraph rows or finer, on the statistics page: the time (0.25 to 30 s), the visibility rule (band, half, any part), focus, fling, once per visit, day or ever, the estimator (expected share, chip word, most likely band), the weight, and a floor of 75, 100 or 150 words. Not possible: a floor under 50, ungrouped short paragraphs, or another band than the three kept.
- **Critical constraint:** daily, site and page totals hold the default rule only. A study that wants another rule must record every participant at paragraph rows or finer.
- **Not needed:** the message bounds, caps, rounding, flush intervals and diagnostics limits are Safety or UX values that do not plausibly move the share.

#### Duplicates and contradictions across files

- The page-kind sample is set twice: `SAMPLE = 64` (pageKind.ts:43) and the literal `firstUnits(64)` (orchestrator.ts:338).
- The default read rule is written twice: `READ_MS` and `BAND_MARGIN` in recorder.ts:32-33, `readMs` and `visibility` in `DEFAULT_LENS` (lens.ts:38-41).
- The 200 000-character text cap is `MAX_UNIT_TEXT_CHARS`, `STATS_LIMITS.textChars` (wire.ts:83) and a literal in recorder.ts:658.
- The diagnostics copy the walker's thresholds (silence.ts:65–68 against walker.ts:271, :290 and the literal `0.2` at :2059). Nothing ties them together.
- Token-count limits differ: client `COUNT_CHARS` 200 000 against the worker's 256 000, though the client's comment says they match.
- `www.` is stripped three times, by `normalizeRuleHost` (settings.ts), by `hostIn` (pageKind.ts) and by `placeLadder` (coarsen.ts), with different trimming rules. Registered domains and site rules share one suffix list (`PUBLIC_SUFFIXES`).
- Flagging defaults to heavily edited and above, while the statistics headline is AI-generated only. Both are intentional, but a reader of the toolbar sees two different notions of "AI".
- A visit keeps its last message's kind and a page total its first (store.ts:278), while the day's kinds are tallied per message (worker.ts:256).

#### Comments and docs that no longer match the code

- lib/stats/worker.ts:6 says the date comes from the worker's clock. It is the local date of the visit's start, as the page sends it (worker.ts:165).
- The pageKind.ts header omits TechArticle (`:17`) and, among forum paths, `/question/` and `/discussions/`. pageKind.ts:42 says "paragraphs read", but it receives the first units found.
- lib/messaging/client.ts:81 says the client's limits are "what the worker takes"; the character limit is lower.
