// test/survey-gate.mjs — did a site get WORSE between two survey runs?
//
// test/coverage.mjs and test/dynamics.mjs report; they never assert, because a live site
// is not a fixture. This turns two of their reports into one verdict, so the weekly
// schedule (.github/workflows/surveys.yml) can go red when a site breaks and stay green
// when the web merely moves underneath us.
//
//   node test/survey-gate.mjs baseline.json current.json          # coverage OR dynamics
//   node test/survey-gate.mjs base.json cur.json --out gate.md    # …and write the summary
//   node test/survey-gate.mjs one-report.json                     # who answered at all
//
// It prints Markdown — regressions first, then improvements, then everything it refused to
// judge, then one total line — and exits 1 if there is a regression.
//
// WHAT IT WILL NOT CALL A REGRESSION
//
//   A site that was unreachable, bot-walled or login-walled in EITHER run. That is the
//   normal state of a third of this list on a given day (US-hosted CI meets Chinese sites,
//   a headless profile meets Cloudflare), and it is reported as `skipped`, never as a
//   failure — but the count is printed, so a list quietly rotting away is visible.
//
//   A site that served DIFFERENT CONTENT. Every coverage ratio is measured against the
//   page's own prose, and Amazon, Al Jazeera, a Guardian live blog or a Steam review list
//   answer two requests an hour apart with two different bodies of text. When the page's
//   prose word count moved by more than a quarter, the ratios are not comparable and the
//   site is reported as drifted.
//
//   A defect that was ALREADY THERE in the baseline. The gate answers "did this get
//   worse", not "is this perfect": a standing defect is the previous run's problem and was
//   already seen. Every threshold is therefore a comparison, never an absolute.
//
// WHERE THE NUMBERS COME FROM. Each threshold below carries the measurement that set it:
// the run-to-run spread of the same build over the same pages, taken from the survey runs
// of 2026-09-18/19 (five pairs of coverage runs over 124 sites, ten dynamics runs over up
// to 30 pages). Timing fields — collectMs, longestTask, tasksPerMin — are NOT compared at
// all: they measure the machine, and a two-core CI runner is not a laptop.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

// ---- thresholds ----------------------------------------------------------------------

export const T = {
  // --- coverage ---------------------------------------------------------------------
  /** A page that segmented and now segments NOTHING. In five pairs of same-day coverage
   *  runs (~300 comparable site-pairs) no page ever fell from ≥3 units to 0 on its own;
   *  every 0-unit swing in the corpus was a real change to the walker (docs-rfc-html
   *  0→554 units, forum-lobsters 0→34, docs-man-page 0→6). */
  UNITS_FLOOR: 3,
  /** …as long as the page still SHOWS prose. A stub, a cookie interstitial or a "page
   *  moved" answer legitimately has nothing to segment; 200 words is more than any of
   *  those and less than the smallest real page in the list. */
  UNITS_MIN_PROSE: 200,
  /** Coverage (prose judged / prose shown) had to fall by more than BOTH of these. The
   *  worst same-day moves were shop-amazon 48.1 → 30.2 % (17.9 points, 37 % relative) and
   *  news-aljazeera 72.5 → 54.8 % (17.7 points, 24 % relative) — both of them pages that
   *  had served a different body of text, which the drift guard below now catches first. */
  COV_DROP_POINTS: 15,
  COV_DROP_RELATIVE: 0.3,
  /** "The page is not the same page." `wordsProse` moved by more than a quarter on 12 of
   *  ~300 same-day site-pairs (shop-amazon +47 % and −37 %, shop-booking −36 %,
   *  news-guardian-liveblog +228 %, social-mastodon-explore +72 %, wiki-baidu-baike +35 %,
   *  news-aljazeera +32 %) and by less than a quarter everywhere else. */
  PROSE_DRIFT: 0.25,
  /** Fragmentation rising from none. A single new fragmented container appeared twice
   *  between same-day runs (news-bbc 0→1, wiki-baidu-baike 0→1, both on pages whose front
   *  matter had been re-flowed), so one is within the noise and two is not. */
  FRAG_RISE_FROM_ZERO: 2,
  /** Units crossing two posts never moved at all — 0 changes in ~300 same-day site-pairs —
   *  so one is already a finding. */
  CROSS_RISE_FROM_ZERO: 1,

  // --- dynamics ---------------------------------------------------------------------
  /** Chips for one unit twice, chips of different units piled at one insertion point, and
   *  paragraphs sent to the daemon twice: all three were 0 on every page of every run
   *  except where a real defect sat, and there they were stable run to run (goodreads
   *  piled 91/91, steam 52/52/52/49). Any rise above the baseline counts. */
  ZERO_TOLERANCE: 0,
  /** Chips vanishing while the page stood still, and chips stuck "analyzing…": both are
   *  counted over a whole session on pages that recycle their rows, and both wobble there.
   *  tumblr-explore, an infinite feed carrying ~50 chips, reported 7 vanished chips in one
   *  of six same-build runs (0 in the other five) and 5, 6, 0, 0, 0, 0 stuck chips. The
   *  allowance is therefore proportional to the chips the page carries, with a floor. */
  CHIP_NOISE_FLOOR: 3,
  CHIP_NOISE_SHARE: 0.15,
  /** …and never more than ten chips, however long the page is. A Hacker News thread
   *  carries 416 chips, and 15 % of that would forgive sixty stuck ones. */
  CHIP_NOISE_CEILING: 10,
  /** Chips out of sight in a clipping box with nothing parked after it. Same-build repeats
   *  moved this by up to 2 (steam-reviews 25 ↔ 23, goodreads-book 6 ↔ 4). */
  CLIP_RISE: 3,
  /** The extension's own script time against the control run of the same page. dev.to cost
   *  22.9 s of script against a control's 0.5 s (47×) before the fix and 0.1 s after;
   *  youtube-watch, which is expensive in both runs, measured 7.5×, 3.3×, 1.8× and 0.8×
   *  over four same-build runs — so a ratio alone is not enough, the absolute cost must be
   *  real too, and a page that was ALREADY over the bar in the baseline has to have got
   *  materially worse to count again. */
  COST_RATIO: 5,
  COST_ABS_SECONDS: 3,
  COST_RATIO_WORSENING: 2,
  /** …and OUR cost has to have risen, not merely the site's to have fallen: the control is
   *  a second live load of the same page and is as variable as the page (youtube-watch's
   *  control measured 5.4 s, 5.2 s, 5.7 s and 1.9 s of script over four same-build runs,
   *  which alone moved the ratio from 3.3× to 7.5×). */
  COST_EXT_GROWTH: 1.5,
};

// ---- helpers -------------------------------------------------------------------------

const pct = (n) => `${n > 0 ? "+" : ""}${Math.round(n)}`;

/** coverage.mjs writes `wordsJudgedProse` since the chrome split; older reports do not. */
const coveragePct = (r) => {
  const judged = r.wordsJudgedProse ?? r.wordsJudged ?? 0;
  return r.wordsProse ? (judged / r.wordsProse) * 100 : 0;
};

/** Which tool wrote this report. */
export function toolOf(report) {
  if (report.minutes !== undefined) return "dynamics";
  return (report.pages ?? []).some((p) => p.ext || p.control) ? "dynamics" : "coverage";
}

/**
 * Errors that appeared WITH the extension and not in the control run of the same page.
 *
 * `which` is "dom" for the class dynamics.mjs already singles out — removeChild /
 * insertBefore / "not a child of this node" / hydration mismatches, i.e. what a framework
 * re-rendering over one of our text-node splits looks like — and "other" for everything
 * else the page logged. Only the first is gated: an ad-funded page logs a different set of
 * third-party failures on every load, and two runs of the SAME build a minute apart
 * differed by two errors on theverge-home (2 → 4) and by two on a Guardian live blog
 * (3 → 5), all of them "Failed to load resource" and ad-script timeouts. The rest is
 * reported as a note so a real new error is still visible to a reader.
 */
const ourErrors = (row, which) => {
  const pick = (r, k) => (which === "dom" ? (r?.domErrors ?? []) : (r?.pageErrors ?? []).filter((e) => !(r?.domErrors ?? []).includes(e)));
  const theirs = new Set(pick(row.control, which));
  return [...new Set(pick(row.ext, which))].filter((e) => !theirs.has(e));
};
const hasControl = (row) => !!(row.control && !row.control.error);

// ---- the comparison --------------------------------------------------------------------

/**
 * Compare two reports of the SAME tool, site by site. Pure: no I/O, no process exit — the
 * unit test in test/node/surveyGate.test.ts drives it with synthetic reports.
 *
 * Returns { tool, baseline, current, sites: [{ name, status, findings, note }], totals }
 * where status is "regression" | "improvement" | "ok" | "skipped".
 */
export function compare(baseline, current) {
  const tool = toolOf(current);
  const B = new Map((baseline.pages ?? []).map((p) => [p.name, p]));
  const C = new Map((current.pages ?? []).map((p) => [p.name, p]));
  const names = [...new Set([...B.keys(), ...C.keys()])].sort();
  const sites = [];

  for (const name of names) {
    const b = B.get(name);
    const c = C.get(name);
    if (!b) {
      sites.push({ name, status: "skipped", findings: [], note: "new in this run — nothing to compare it with" });
      continue;
    }
    if (!c) {
      sites.push({ name, status: "skipped", findings: [], note: "gone from this run (removed from the list, or the run stopped early)" });
      continue;
    }
    if (b.reach !== "ok" || c.reach !== "ok") {
      const where = b.reach !== "ok" && c.reach !== "ok" ? `both runs (${b.reach} / ${c.reach})` : b.reach !== "ok" ? `the baseline (${b.reach})` : `this run (${c.reach})`;
      sites.push({ name, status: "skipped", findings: [], note: `unreachable in ${where}` });
      continue;
    }
    const site = tool === "coverage" ? coverageSite(name, b, c) : dynamicsSite(name, b, c);
    sites.push(site);
  }

  const totals = {
    compared: sites.filter((s) => s.status !== "skipped").length,
    regressions: sites.filter((s) => s.status === "regression").length,
    improvements: sites.filter((s) => s.status === "improvement").length,
    skipped: sites.filter((s) => s.status === "skipped").length,
  };
  return { tool, baseline: label(baseline), current: label(current), sites, totals };
}

const label = (j) => ({ label: j.label ?? "?", at: j.at ?? null, pages: (j.pages ?? []).length, jobs: j.jobs ?? null, minutes: j.minutes ?? null });

/** Regressions win over improvements: a site that gained one thing and lost another is a
 *  site to look at. */
const verdict = (bad, good) => (bad.length ? "regression" : good.length ? "improvement" : "ok");

// ---- coverage ---------------------------------------------------------------------------

function coverageSite(name, b, c) {
  const bad = [];
  const good = [];
  const notes = [];

  const bProse = b.wordsProse ?? 0;
  const cProse = c.wordsProse ?? 0;
  /** Signed, against the LARGER of the two, so +33 % and −33 % mean the same distance. */
  const drift = Math.max(bProse, cProse) ? (cProse - bProse) / Math.max(bProse, cProse) : 0;
  const drifted = Math.abs(drift) > T.PROSE_DRIFT;

  // A page that still shows prose and produces NO unit is a failure whichever article it
  // happens to be showing, so this one question survives the drift guard.
  if ((b.units ?? 0) >= T.UNITS_FLOOR && (c.units ?? 0) === 0 && cProse >= T.UNITS_MIN_PROSE)
    bad.push(`units ${b.units} → 0 while the page still shows ${cProse} words of prose`);
  else if ((b.units ?? 0) === 0 && (c.units ?? 0) >= T.UNITS_FLOOR) good.push(`units 0 → ${c.units}`);

  if (drifted) {
    return {
      name,
      status: bad.length ? "regression" : "skipped",
      findings: bad,
      note: `the page served different content: ${bProse} → ${cProse} words of prose (${pct(drift * 100)} %), so its ratios are not comparable`,
    };
  }

  const bCov = coveragePct(b);
  const cCov = coveragePct(c);
  const drop = bCov - cCov;
  const bar = Math.max(T.COV_DROP_POINTS, bCov * T.COV_DROP_RELATIVE);
  if (drop > bar) bad.push(`coverage ${bCov.toFixed(0)} % → ${cCov.toFixed(0)} % (−${drop.toFixed(0)} points, past the ${bar.toFixed(0)}-point bar for this page)`);
  else if (-drop > bar) good.push(`coverage ${bCov.toFixed(0)} % → ${cCov.toFixed(0)} %`);

  const bFrag = (b.fragmented ?? []).length;
  const cFrag = (c.fragmented ?? []).length;
  if (bFrag === 0 && cFrag >= T.FRAG_RISE_FROM_ZERO) bad.push(`fragmented containers 0 → ${cFrag} (one post cut into several units)`);
  else if (bFrag >= T.FRAG_RISE_FROM_ZERO && cFrag === 0) good.push(`fragmented containers ${bFrag} → 0`);

  const bCross = (b.crossing ?? []).length;
  const cCross = (c.crossing ?? []).length;
  if (bCross === 0 && cCross >= T.CROSS_RISE_FROM_ZERO) bad.push(`units crossing two posts 0 → ${cCross}`);
  else if (bCross >= T.CROSS_RISE_FROM_ZERO && cCross === 0) good.push(`units crossing two posts ${bCross} → 0`);

  const bCats = new Set(Object.keys(b.chromeByCat ?? {}));
  const cCats = new Set(Object.keys(c.chromeByCat ?? {}));
  const fresh = [...cCats].filter((k) => !bCats.has(k));
  const gone = [...bCats].filter((k) => !cCats.has(k));
  if (fresh.length) bad.push(`units in page chrome of a kind this page never had before: ${fresh.join(", ")}`);
  if (gone.length) good.push(`no more units in ${gone.join(", ")}`);

  if (Math.abs(drift) > 0.05) notes.push(`prose ${bProse} → ${cProse} words`);
  return { name, status: verdict(bad, good), findings: bad.length ? bad : good, note: notes.join("; ") };
}

// ---- dynamics -----------------------------------------------------------------------------

function dynamicsSite(name, b, c) {
  const bad = [];
  const good = [];
  const notes = [];
  const x = c.ext;
  const y = b.ext;
  if (!x || !y) return { name, status: "skipped", findings: [], note: "no session recorded in one of the runs" };

  /** How much of a chip-count metric is noise on a page that carries this many chips. */
  const allowance = Math.min(
    T.CHIP_NOISE_CEILING,
    Math.max(T.CHIP_NOISE_FLOOR, Math.round(Math.max(y.hostsMax ?? 0, x.hostsMax ?? 0) * T.CHIP_NOISE_SHARE)),
  );

  // A defect APPEARING on a page that had none is the whole point of this gate, so from
  // zero there is no allowance at all. A defect that was already there and grew a little
  // is the same defect: steam-reviews reported 49 and 52 piled chips in two runs of one
  // build, over a list of 138 chips, and a weekly red X for those three is a red X nobody
  // reads. Above zero the chip allowance applies.
  const rose = (before, now) => now > before && now - before > (before === 0 ? 0 : allowance);
  const counts = [
    [y.sameUnitChipsMax ?? 0, x.sameUnitChipsMax ?? 0, "chips for one unit twice"],
    [y.pileUpChipsMax ?? 0, x.pileUpChipsMax ?? 0, "chips of different units piled at one insertion point"],
    [y.daemon?.resentBlocks ?? 0, x.daemon?.resentBlocks ?? 0, "paragraphs sent to the daemon twice"],
  ];
  for (const [before, now, what] of counts) {
    if (rose(before, now)) bad.push(`${what} ${before} → ${now}`);
    else if (before > 0 && now === 0) good.push(`${what} ${before} → 0`);
  }

  if ((x.flickerGone ?? 0) - (y.flickerGone ?? 0) > allowance)
    bad.push(`chips vanishing while the page stood still ${y.flickerGone ?? 0} → ${x.flickerGone} (allowance ${allowance} for a page carrying ${x.hostsMax} chips)`);
  else if ((y.flickerGone ?? 0) > allowance && (x.flickerGone ?? 0) === 0) good.push(`chips vanishing while the page stood still ${y.flickerGone} → 0`);

  if ((x.stuckPending ?? 0) - (y.stuckPending ?? 0) > allowance)
    bad.push(`chips stuck "analyzing…" ${y.stuckPending ?? 0} → ${x.stuckPending} (allowance ${allowance})`);
  else if ((y.stuckPending ?? 0) > allowance && (x.stuckPending ?? 0) === 0) good.push(`chips stuck "analyzing…" ${y.stuckPending} → 0`);

  if ((x.clippedOutMax ?? 0) - (y.clippedOutMax ?? 0) > T.CLIP_RISE)
    bad.push(`chips out of sight with nothing parked after their box ${y.clippedOutMax ?? 0} → ${x.clippedOutMax}`);
  else if ((y.clippedOutMax ?? 0) - (x.clippedOutMax ?? 0) > T.CLIP_RISE) good.push(`chips out of sight with nothing parked after their box ${y.clippedOutMax} → ${x.clippedOutMax}`);

  // Errors are only ours when the same page in the same script did NOT produce them
  // without the extension, so both runs need their control.
  if (hasControl(b) && hasControl(c)) {
    const bErr = ourErrors(b, "dom");
    const cErr = ourErrors(c, "dom");
    if (cErr.length > bErr.length)
      bad.push(`DOM-surgery errors with the extension and not in the control run ${bErr.length} → ${cErr.length}: \`${cErr[0].slice(0, 120)}\``);
    else if (bErr.length > 0 && cErr.length === 0) good.push(`DOM-surgery errors attributable to us ${bErr.length} → 0`);
    const otherNow = ourErrors(c, "other").length;
    const otherBefore = ourErrors(b, "other").length;
    if (otherNow > otherBefore) notes.push(`${otherNow} other console errors only the extension run saw (${otherBefore} in the baseline) — third-party scripts differ per load, so this is not gated`);
  } else notes.push("no control run in one of the two: page errors could not be attributed");

  // Cost: script time against the control of the SAME run.
  const ratioOf = (row) => {
    const ext = row.ext?.cdp?.scriptDuration;
    const ctl = row.control?.cdp?.scriptDuration;
    if (ext == null || ctl == null) return null;
    return { ext, ctl, ratio: ext / Math.max(0.05, ctl) };
  };
  const bCost = ratioOf(b);
  const cCost = ratioOf(c);
  if (cCost && bCost) {
    const explodes = cCost.ratio > T.COST_RATIO && cCost.ext > T.COST_ABS_SECONDS;
    const worseThanBefore =
      cCost.ext > bCost.ext * T.COST_EXT_GROWTH && (bCost.ratio <= T.COST_RATIO || cCost.ratio > bCost.ratio * T.COST_RATIO_WORSENING);
    if (explodes && worseThanBefore)
      bad.push(
        `script time ${cCost.ext.toFixed(1)} s against a control's ${cCost.ctl.toFixed(1)} s (${cCost.ratio.toFixed(0)}×; the baseline was ${bCost.ext.toFixed(1)} s / ${bCost.ratio.toFixed(0)}×)`,
      );
    else if (bCost.ratio > T.COST_RATIO && bCost.ext > T.COST_ABS_SECONDS && !explodes)
      good.push(`script time ${bCost.ext.toFixed(1)} s (${bCost.ratio.toFixed(0)}×) → ${cCost.ext.toFixed(1)} s (${cCost.ratio.toFixed(0)}×)`);
  } else notes.push("no CDP metrics in one of the two: cost not compared");

  return { name, status: verdict(bad, good), findings: bad.length ? bad : good, note: notes.join("; ") };
}

// ---- the summary ---------------------------------------------------------------------------

/**
 * Who answered at all, for one report on its own — the line that makes a list rotting away
 * visible even on a first run, before there is anything to compare with. US-hosted runners
 * meet a different web than a developer's machine, and this says which one they met.
 */
export function renderReach(report) {
  const rows = report.pages ?? [];
  const tally = {};
  for (const r of rows) tally[r.reach ?? "no result"] = (tally[r.reach ?? "no result"] ?? 0) + 1;
  const ok = tally.ok ?? 0;
  const worst = Object.entries(tally)
    .filter(([k]) => k !== "ok")
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ×${v}`);
  return (
    `### ${toolOf(report)} run \`${report.label ?? "?"}\` — ${ok} of ${rows.length} pages answered\n\n` +
    (worst.length ? `Not examined: ${worst.join(", ")}.\n` : "Every page answered.\n")
  );
}

/** One Markdown document: regressions, improvements, skipped, total. */
export function render(result) {
  const { tool, baseline, current, sites, totals } = result;
  const when = (x) => (x.at ? x.at.slice(0, 16).replace("T", " ") + " UTC" : "date unknown");
  const md = [];
  md.push(`## ${tool} survey gate — \`${baseline.label}\` (${when(baseline)}) → \`${current.label}\` (${when(current)})`);
  md.push("");
  if (tool === "coverage" && baseline.jobs && current.jobs && baseline.jobs !== current.jobs)
    md.push(`_The two runs opened ${baseline.jobs} and ${current.jobs} pages at a time; timing is not compared for that reason._`, "");

  const regressions = sites.filter((s) => s.status === "regression");
  const improvements = sites.filter((s) => s.status === "improvement");
  const skipped = sites.filter((s) => s.status === "skipped");

  if (regressions.length) {
    md.push(`### Regressions (${regressions.length})`, "");
    for (const s of regressions) {
      md.push(`- **${s.name}**`);
      for (const f of s.findings) md.push(`  - ${f}`);
      if (s.note) md.push(`  - _${s.note}_`);
    }
    md.push("");
  } else {
    md.push("### No regressions", "");
  }
  if (improvements.length) {
    md.push(`### Improvements (${improvements.length})`, "");
    for (const s of improvements) md.push(`- **${s.name}** — ${s.findings.join("; ")}`);
    md.push("");
  }
  if (skipped.length) {
    md.push(`### Not judged (${skipped.length})`, "");
    for (const s of skipped) md.push(`- ${s.name} — ${s.note}${s.findings.length ? ` (still: ${s.findings.join("; ")})` : ""}`);
    md.push("");
  }
  md.push(
    `**${totals.compared} of ${sites.length} sites compared: ${totals.regressions} regressions, ${totals.improvements} improvements, ` +
      `${totals.skipped} not judged** (unreachable, walled, drifted, or new to the list).`,
  );
  return md.join("\n");
}

// ---- command line ------------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && /survey-gate\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf("--out");
  const outFile = outAt >= 0 ? argv.splice(outAt, 2)[1] : null;
  const [basePath, curPath] = argv.filter((a) => !a.startsWith("--"));
  if (!basePath) {
    console.error("usage: node test/survey-gate.mjs <baseline.json> <current.json> [--out summary.md]");
    console.error("       node test/survey-gate.mjs <report.json>          # who answered at all");
    process.exit(2);
  }
  const read = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      console.error(`cannot read ${p}: ${String(e).split("\n")[0]}`);
      process.exit(2);
    }
  };
  // One report on its own: no comparison to make, just say what the run met.
  if (!curPath) {
    const only = read(basePath);
    const md = renderReach(only);
    console.log(md);
    if (outFile) writeFileSync(outFile, md);
    process.exit(0);
  }
  const baseline = read(basePath);
  const current = read(curPath);
  if (toolOf(baseline) !== toolOf(current)) {
    console.error(`${basename(basePath)} is a ${toolOf(baseline)} report and ${basename(curPath)} is a ${toolOf(current)} one — nothing to compare`);
    process.exit(2);
  }
  const result = compare(baseline, current);
  const md = render(result);
  console.log(md);
  if (outFile) writeFileSync(outFile, md + "\n");
  process.exit(result.totals.regressions > 0 ? 1 : 0);
}
