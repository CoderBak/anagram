// test/unit-surfaces.mjs — the reading surfaces (lib/surfaces/), run by test/unit.mjs.
//
// Each surface has a fixture under test/fixtures/surfaces/ reduced from the site's own markup
// (the file says what was measured and what was modelled), and every check here opens it in
// the same blank Chromium page the walker cases use, with no network: first what the walk
// alone makes of the page — the reason the surface exists — then what the surface makes of
// it, then that its marks and chips land over the page and that an ordinary page is left to
// the walk.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/** The document in test/fixtures/surfaces/drive-preview.html, paragraph by paragraph. */
export const DRIVE = {
  p1: "The survey of the old harbour began in the spring, when the water was low enough to show the stones along the northern wall. Three of us walked the length of it every morning with a notebook and a measuring tape, writing down every crack and every loose block we could find. By the end of the second week we had filled two notebooks, and it was clear that the wall had been repaired many times before, each time by people who did not know what the last crew had done.",
  p2: "Most of the repairs were honest work. Somebody had cut new stones to fit the old gaps, and the mortar between them was still hard after what must have been fifty years of salt water and winter storms.",
  p3: "Other repairs were less careful. In one place the gap had simply been filled with rubble and covered with a thin skin of concrete, which had cracked and let the sea in behind it, so the wall was hollow there for several yards.",
  p4: "We wrote to the harbour board in June and asked for a meeting. The reply took a month to arrive, and when it came it was polite but vague: the board thanked us for our interest, promised to consider our findings, and suggested that any further work should be done in close collaboration with the engineers they had already hired. We had never heard of these engineers, and nobody in the town seemed to know who they were or when they had been hired, so we went on measuring and waited to see whether anyone would ever come to look.",
  p5: "In August two men arrived with a van full of equipment and spent three days on the northern wall. They did not speak to us, although we offered them our notebooks, and on the fourth day they drove away again. A week later the board announced that the wall was sound and needed no further attention, and the notice was pinned to the door of the harbour office where everyone could read it. Nobody we asked had seen the two men take a single measurement.",
  p6: "The storm came in October. It was not an unusual storm for the time of year, but the hollow stretch of the wall gave way in the first night, and by morning the sea had carried off the concrete skin and most of the rubble behind it. The stones we had measured in the spring were lying on the beach, and the notebooks were the only record of where they had stood. We gave both of them to the town library that winter, and they are still on the shelf there.",
};

export async function surfaceChecks(browser, bundle, fixtures, results) {
  const check = (name, ok, note = "") => results.push({ name, ok: !!ok, note: String(note) });

  // ---- which addresses have a surface --------------------------------------------------
  {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: bundle });
    const r = await page.evaluate(() => {
      const at = (href) => {
        const u = new URL(href);
        return PW.surfaceFor({ hostname: u.hostname, pathname: u.pathname });
      };
      return {
        drive: [
          "https://drive.google.com/file/d/1abc/view",
          "https://drive.google.com/file/d/1abc/preview",
          "https://drive.google.com/drive/folders/1abc",
          "https://docs.google.com/file/d/0B6z/preview",
          "https://docs.google.com/a/school.edu/file/d/0B6z/edit",
          "https://docs.google.com/viewer?url=https://example.org/a.pdf",
          "https://docs.google.com/viewerng/viewer?url=https://example.org/a.pdf",
        ].map(at),
        none: [
          "https://docs.google.com/document/d/1abc/edit",
          "https://docs.google.com/presentation/d/1abc/edit",
          "https://docs.google.com/spreadsheets/d/1abc/edit",
          "https://en.wikipedia.org/wiki/Harbour",
          "https://www.google.com/search?q=drive.google.com",
          "https://drive.google.com.example.org/file/d/1abc/view",
          "https://example.org/docs.google.com/file/d/1abc",
        ].map(at),
      };
    });
    check(
      "surfaces: Google Drive's viewer is recognised by its address, on drive.google.com and docs.google.com",
      r.drive.every((s) => s === "drive"),
      JSON.stringify(r.drive),
    );
    check(
      "surfaces: every other address — the Docs editor, Slides, Sheets, any ordinary page — has no surface and loads nothing",
      r.none.every((s) => s === null),
      JSON.stringify(r.none),
    );
    const pdfjs = await page.evaluate(() => {
      const at = (href, doc) => {
        const u = new URL(href);
        return PW.surfaceFor({ hostname: u.hostname, pathname: u.pathname }, doc);
      };
      const viewer = { querySelector: (sel) => (sel === ".pdfViewer" ? {} : null) };
      const plain = { querySelector: () => null };
      return {
        yes: [
          at("https://onedrive.live.com/?id=ABC%21123&cid=ABC", plain),
          at("https://contoso.sharepoint.com/sites/team/Shared%20Documents/report.pdf", plain),
          at("https://contoso-my.sharepoint.com/personal/a/Documents/report.pdf", plain),
          at("https://mozilla.github.io/pdf.js/web/viewer.html", viewer),
          at("https://moodle.example.edu/mod/resource/view.php", viewer),
        ],
        no: [at("https://mozilla.github.io/pdf.js/", plain), at("https://sharepoint.com.example.org/x", plain), at("https://example.org/", undefined)],
      };
    });
    check(
      "surfaces: a pdf.js viewer is recognised by OneDrive's and SharePoint's addresses, or by pdf.js's own viewer element on any page",
      pdfjs.yes.every((s) => s === "pdfjs") && pdfjs.no.every((s) => s === null),
      JSON.stringify(pdfjs),
    );
    await page.close();
  }

  // ---- Google Drive's file preview ----------------------------------------------------
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.goto(pathToFileURL(join(fixtures, "surfaces", "drive-preview.html")).href);
    await page.addScriptTag({ path: bundle });
    return page;
  };

  {
    const page = await open();
    const walk = await page.evaluate(() =>
      PW.collectUnits(document.body).map((u) => ({ parts: u.parts.length, text: u.text })),
    );
    // What the walk alone makes of the lines: every printed line a "paragraph" of its own, the
    // short ones gone, and a word hyphenated across two lines left in two pieces.
    const lineParts = walk.some((u) => u.parts >= 10);
    const lostShort = !walk.some((u) => u.text.includes("last crew had done."));
    const splitWord = walk.some((u) => u.text.includes("north-\n\nern"));
    check(
      "drive preview: the walk alone reads every printed line as a paragraph, drops the short ones and leaves hyphens in (why the surface exists)",
      lineParts && lostShort && splitWord,
      JSON.stringify({ lineParts, lostShort, splitWord, units: walk.map((u) => [u.parts, u.text.slice(0, 40)]) }),
    );

    const r = await page.evaluate(async (want) => {
      const s = PW.createSurface("drive", document);
      const owned = new Set();
      const claim = (nodes) => (nodes.every((n) => owned.has(n)) ? "skip" : "take");
      const take = (units) => {
        for (const u of units) for (const p of u.parts) for (const n of p.nodes) owned.add(n);
        return units;
      };
      const layerBefore = [...document.querySelectorAll(".kd-layer")].map((l) => l.innerHTML).join("");
      const first = take(s.collect(claim, true));
      const units = first.map((u) => ({ text: u.text, parts: u.parts.length, paragraphs: u.paragraphs, textFixed: u.textFixed === true }));
      const again = s.collect(claim, true).length; // the same burst: answered already
      await new Promise((r) => setTimeout(r, 0));
      const unchanged = s.collect(claim, true).length; // a later burst: nothing new

      // Marks and chips, through the page's own marking and chip code.
      PW.registerHighlightStyles();
      PW.setMarkPainter(s.painter);
      PW.setRangeLocator((u, spans) => s.ranges(u, spans));
      const layer = PW.createBadgeLayer({ place: (u, h) => s.place(u, h) });
      const verdictOf = (u, score) =>
        PW.unitVerdict(u.id, u.text.length, [{ start: 0, end: u.text.length, result: { id: u.id, bucket: 0, probs: [1 - score, score, 0, 0], score } }]);
      first.forEach((u, i) => {
        const v = verdictOf(u, [0.1, 0.5, 0.9, 0.3][i % 4]);
        layer.render(u, v);
        PW.setHighlight(u, v);
      });
      const overlays = [...document.querySelectorAll('.kd-page > [data-anagram="marks"]')];
      const bars = overlays.flatMap((o) => [...o.querySelectorAll(":scope > div")]).filter((d) => !d.hidden);
      const lines = first.reduce((n, u) => n + u.parts.reduce((m, p) => m + p.nodes.length, 0), 0);
      const inPercent = bars.every((b) => /%$/.test(b.style.left) && /%$/.test(b.style.top) && /%$/.test(b.style.width));
      const chips = overlays.flatMap((o) => [...o.querySelectorAll(':scope > [data-chip] > [data-anagram="host"]')]).length;
      const layerAfter = [...document.querySelectorAll(".kd-layer")].map((l) => l.innerHTML).join("");
      // A bar sits on the printed line: across the line box, just under it.
      const p1 = [...document.querySelectorAll(".kd-page p")].find((p) => p.textContent.startsWith("The survey"));
      const pb = p1.getBoundingClientRect();
      const onLine = bars.some((b) => {
        const r = b.getBoundingClientRect();
        return Math.abs(r.left - pb.left) < 2 && Math.abs(r.width - pb.width) < 2 && r.top >= pb.top && r.top <= pb.bottom + 4;
      });
      // Hovering a chip (the active unit) shows the tint; letting go hides it.
      const tints = () => overlays.flatMap((o) => [...o.querySelectorAll(":scope > div")]).filter((d) => !d.hidden).length;
      const resting = tints();
      PW.setActiveUnit(first[0].id);
      const activeTints = tints();
      PW.setActiveUnit(null);
      PW.setHighlightsVisible(false);
      const hidden = tints();
      PW.setHighlightsVisible(true);

      // One stretch of a unit, found on its own line.
      const p4 = first.find((u) => u.text.startsWith("We wrote"));
      const at = p4.text.indexOf("collaboration");
      const found = s.ranges(p4, [{ start: at, end: at + "collaboration".length }]);
      const stretch = found ? found[0].map((r) => r.toString()).join("|") : null;
      const notMine = s.ranges({ id: "u_elsewhere", parts: [], text: "" }, [{ start: 0, end: 1 }]);
      // The whole-unit fallback (a stretch that cannot be located any more) is one range per
      // part, across its lines: every line still gets its own mark.
      const part = p4.parts[0];
      const whole = new Range();
      whole.setStart(part.nodes[0], 0);
      whole.setEnd(part.nodes.at(-1), part.nodes.at(-1).length);
      s.painter.paint(p4, [{ step: 10, ranges: [whole] }], false);
      const wholeBars = overlays.flatMap((o) => [...o.querySelectorAll(":scope > div")]).filter((d) => !d.hidden).length;
      s.painter.clear(p4.id);
      const withoutP4 = overlays.flatMap((o) => [...o.querySelectorAll(":scope > div")]).filter((d) => !d.hidden).length;

      // Page 3 loads as the reader scrolls to it — a later mutation burst.
      await new Promise((r) => setTimeout(r, 0));
      const slot = document.querySelector('[data-page-slot="3"]');
      slot.replaceWith(document.getElementById("page-3").content.firstElementChild.cloneNode(true));
      const later = take(s.collect(claim, true)).map((u) => u.text);

      // The units a surface hands out are its own; clearing one takes its marks away.
      PW.clearHighlight(first[0].id);
      const afterClear = overlays.flatMap((o) => [...o.querySelectorAll(":scope > div")]).length;

      return {
        units, again, unchanged, bars: bars.length, lines, inPercent, chips, sameLayer: layerBefore === layerAfter,
        onLine, resting, activeTints, hidden, stretch, notMine: notMine === undefined, later, afterClear, before: bars.length,
        wholeLines: wholeBars - withoutP4, partLines: part.nodes.length,
        want,
      };
    }, DRIVE);
    const texts = r.units.map((u) => u.text);
    check(
      "drive preview: the surface reads the document's paragraphs — lines joined, hyphens mended, heading and page numbers left out",
      texts.length === 4 &&
        texts[0] === DRIVE.p1 &&
        texts[1] === `${DRIVE.p2}\n\n${DRIVE.p3}` &&
        texts[2] === DRIVE.p4 &&
        texts[3] === DRIVE.p5 &&
        r.units.every((u) => u.textFixed),
      JSON.stringify(texts.map((t) => t.slice(0, 50))),
    );
    check(
      "drive preview: two short paragraphs are read together (×2) and a paragraph running onto the next page is ONE paragraph in two parts",
      r.units[1]?.paragraphs === 2 && r.units[2]?.parts === 2 && r.units[2]?.paragraphs === 1,
      JSON.stringify(r.units.map((u) => [u.parts, u.paragraphs])),
    );
    check(
      "drive preview: a burst asks once, and a later pass over an unchanged document hands out nothing new",
      r.again === 0 && r.unchanged === 0,
      JSON.stringify([r.again, r.unchanged]),
    );
    check(
      "drive preview: a page that loads later is read, and what was read before is left alone",
      r.later.length === 1 && r.later[0] === DRIVE.p6,
      JSON.stringify(r.later.map((t) => t.slice(0, 50))),
    );
    check(
      "drive preview: marks are drawn over the printed lines in the page's proportions, and chips beside the page's own text — none inside Drive's layer",
      r.bars === r.lines && r.inPercent && r.onLine && r.chips === 4 && r.sameLayer,
      JSON.stringify({ bars: r.bars, lines: r.lines, inPercent: r.inPercent, onLine: r.onLine, chips: r.chips, sameLayer: r.sameLayer }),
    );
    check(
      "drive preview: the unit the reader is on is tinted, marks follow the show/hide switch, and a cleared unit takes its marks with it",
      r.activeTints > r.resting && r.hidden === 0 && r.afterClear < r.before * 2,
      JSON.stringify({ resting: r.resting, active: r.activeTints, hidden: r.hidden, afterClear: r.afterClear, before: r.before }),
    );
    check(
      "drive preview: a stretch of a unit is found on its own line, and a unit that is not the surface's is left to the page",
      r.stretch === "collaboration" && r.notMine,
      JSON.stringify({ stretch: r.stretch, notMine: r.notMine }),
    );
    check(
      "drive preview: a mark over a whole part (the fallback when a stretch is lost) is drawn line by line",
      r.partLines === 4 && r.wholeLines === r.partLines,
      JSON.stringify({ wholeLines: r.wholeLines, partLines: r.partLines }),
    );
    await page.close();
  }

  // ---- a PDF in a pdf.js viewer (OneDrive's preview) ---------------------------------------
  {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(pathToFileURL(join(fixtures, "surfaces", "pdfjs-viewer.html")).href);
    await page.addScriptTag({ path: bundle });
    const r = await page.evaluate(() => {
      const walk = PW.collectUnits(document.body).map((u) => ({ parts: u.parts.length, text: u.text }));
      const layers = () => [...document.querySelectorAll(".textLayer")].map((l) => l.innerHTML).join("");
      const before = layers();
      const s = PW.createSurface("pdfjs", document);
      const units = s.collect(() => "take", true);
      PW.registerHighlightStyles();
      PW.setMarkPainter(s.painter);
      PW.setRangeLocator((u, spans) => s.ranges(u, spans));
      const layer = PW.createBadgeLayer({ place: (u, h) => s.place(u, h) });
      for (const u of units) {
        const v = PW.unitVerdict(u.id, u.text.length, [{ start: 0, end: u.text.length, result: { id: u.id, bucket: 0, probs: [0.5, 0.5, 0, 0], score: 0.5 } }]);
        layer.render(u, v);
        PW.setHighlight(u, v);
      }
      const marks = [...document.querySelectorAll('.page > [data-anagram="marks"]')];
      const nodes = units.reduce((n, u) => n + u.parts.reduce((m, p) => m + p.nodes.length, 0), 0);
      return {
        active: s.active(),
        walk,
        units: units.map((u) => ({ text: u.text, parts: u.parts.length, paragraphs: u.paragraphs })),
        bars: marks.flatMap((m) => [...m.querySelectorAll(":scope > div")]).filter((d) => !d.hidden).length,
        nodes,
        chips: marks.flatMap((m) => [...m.querySelectorAll(':scope > [data-chip] > [data-anagram="host"]')]).length,
        sameLayers: layers() === before,
      };
    });
    const columnsMixed = r.walk.some((u) => u.parts >= 10 && u.text.includes("differ-\n\nent"));
    check(
      "pdf.js viewer: the walk alone reads each run of a text layer as a paragraph and leaves hyphens in (why the surface exists)",
      columnsMixed,
      JSON.stringify(r.walk.map((u) => [u.parts, u.text.slice(0, 40)])),
    );
    const texts = r.units.map((u) => u.text);
    check(
      "pdf.js viewer: the surface reads the paragraphs in reading order — a hyphen mended, a paragraph joined across the column and across the page",
      r.active && texts.length === 4 &&
        texts[0].includes("notice what is different about each one") && texts[0].includes("\n\nIn the first year") &&
        texts[1].startsWith("By the third year") && texts[1].includes("who brought the supplies from the harbour") && texts[1].endsWith("gone to the moon to look.") &&
        texts[2].startsWith("The storms are recorded") &&
        texts[3].includes("by the afternoon boat. The new keeper") && r.units[3].parts === 2 && r.units[3].paragraphs === 1 &&
        !texts.some((t) => /Lighthouse Log|(?:^|\n)\d+(?:\n|$)/.test(t)),
      JSON.stringify(r.units.map((u) => [u.parts, u.paragraphs, u.text.slice(0, 40)])),
    );
    check(
      "pdf.js viewer: marks are drawn over every run a unit read and a chip beside each unit, pdf.js's layer untouched",
      r.bars === r.nodes && r.chips === 4 && r.sameLayers,
      JSON.stringify({ bars: r.bars, nodes: r.nodes, chips: r.chips, sameLayers: r.sameLayers }),
    );
    await page.close();
  }

  // ---- an ordinary page is left to the walk --------------------------------------------
  {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(fixtures, "news-article.html")).href);
    await page.addScriptTag({ path: bundle });
    const r = await page.evaluate(() => {
      const s = PW.createSurface("drive", document);
      const wrapped = PW.asPageSurface(s);
      const opts = {};
      const viaSurface = wrapped.collect(document.body, () => "take", opts).map((u) => u.text);
      const walked = PW.collectUnits(document.body, opts).map((u) => u.text);
      const unit = { id: "u_x", parts: [], text: "" };
      return {
        active: s.active(),
        same: JSON.stringify(viaSurface) === JSON.stringify(walked) && walked.length > 0,
        place: wrapped.placeBadge(unit, document.createElement("span")),
        ranges: wrapped.ranges(unit, [{ start: 0, end: 1 }]),
        painted: wrapped.painter.paint(unit, [], false),
        added: document.querySelectorAll('[data-anagram]').length,
      };
    });
    check(
      "surfaces: on a page without the viewer the walk reads the page, and the surface places, locates and paints nothing",
      !r.active && r.same && r.place === null && r.ranges === undefined && r.painted === false && r.added === 0,
      JSON.stringify(r),
    );
    await page.close();
  }
}
