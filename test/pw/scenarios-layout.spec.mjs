// Where a chip goes when the site clips, rewrites or cuts the text it belongs to: a post
// behind "see more", a review clipped to a few lines, a box that starts clipping when its
// picture arrives, a mailing-list quotation the page moves around, a pre-wrap post its
// framework rewrites (X's "Show more"), and a preview the site cut short ("… See more").
//
//   npx playwright test scenarios-layout
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, BADGE_SEL, ABSENCE_MS, PARA, PAGE, settledChips, chipsSettle } from "./kit.mjs";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

test("a post clipped to three lines is scored with its chip under the visible text, and back at its own last line once opened", async ({ page, pages }) => {
  // The shape LinkedIn, Substack Notes and Goodreads use: the rest of the post is in the DOM,
  // behind a "see more" control. The chip has to end up UNDER the visible lines.
  pages.serve({
    "/clipped.html": PAGE("clipped fixture", `<h1>A post behind "see more"</h1>
<div id="post" style="border:1px solid #ddd;padding:12px">
  <div id="box" style="overflow:hidden;max-height:48px">${PARA("CLIPPEDPOST")} ${PARA("CLIPPEDPOST-MORE")}</div>
  <button id="more" type="button" aria-expanded="false" onclick="document.getElementById('box').style.maxHeight='none';this.setAttribute('aria-expanded','true')">…see more</button>
</div>
<p id="plain">${PARA("PLAINPOST")}</p>`),
  });
  await page.goto(pages.url("/clipped.html"), { waitUntil: "load" });
  const clipped = "a post clipped to three lines is scored and its chip sits under the visible text, then returns to its own last line when the post is opened";
  await expect(settledChips(page, "#post"), clipped).toHaveCount(1);
  const placed = () =>
    page.evaluate((sel) => {
      const host = document.querySelector(`#post ${sel}`);
      const box = document.getElementById("box");
      const hr = host.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      return {
        insideBox: box.contains(host),
        afterBox: host.previousElementSibling === box,
        onScreen: hr.height > 0 && hr.top < br.bottom + 60,
      };
    }, BADGE_SEL);
  await expect.poll(placed, { message: clipped }).toEqual({ insideBox: false, afterBox: true, onScreen: true });

  await page.click("#more");
  const opened = () =>
    page.evaluate((sel) => {
      const hosts = document.querySelectorAll(`#post ${sel}`);
      const box = document.getElementById("box");
      const hr = hosts[0]?.getBoundingClientRect();
      return {
        chips: hosts.length,
        backAtItsText: !!hosts[0] && box.contains(hosts[0]),
        drawn: !!hr && hr.height > 0 && hr.bottom <= box.getBoundingClientRect().bottom + 1,
        expanded: getComputedStyle(box).maxHeight === "none",
      };
    }, BADGE_SEL);
  await expect.poll(opened, { message: clipped }).toEqual({ chips: 1, backAtItsText: true, drawn: true, expanded: true });
});

// A 30-page session survey (2026-09) found the chips themselves stable and their PLACEMENT
// wrong in exactly one shape of box: the "see more" review. Every unit of a clamped review
// ends out of sight, so every chip was inserted after the box — 91 of them at 16 anchors on
// one Goodreads page.
test("a review clipped to a few lines: ONE chip under it, the other five at their own paragraphs, all six back in place when it is opened", async ({ page, pages }) => {
  pages.serve({ "/clipped-reviews.html": readFileSync(join(FIXTURES, "clipped-reviews.html"), "utf8") });
  await page.goto(pages.url("/clipped-reviews.html"), { waitUntil: "load" });
  const read = () =>
    page.evaluate((sel) => {
      const box = document.getElementById("nadia-box");
      const card = box.closest("article");
      const all = [...card.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".card .head"));
      const num = (h) => h.shadowRoot.querySelector(".num").textContent;
      const br = box.getBoundingClientRect();
      return {
        after: all.filter((h) => !box.contains(h)).map(num),
        within: all.filter((h) => box.contains(h)).map(num),
        // Nothing the reader can see may be drawn with no box at all, and nothing inside the
        // collapsed review may be drawn over the lines that ARE on screen.
        undrawn: all.filter((h) => !box.contains(h) && h.getBoundingClientRect().height === 0).length,
        parkedBelow: all.filter((h) => !box.contains(h)).every((h) => h.getBoundingClientRect().top >= br.top),
      };
    }, BADGE_SEL);
  const shape = async () => {
    const r = await read();
    return { after: r.after.length, within: r.within.length, undrawn: r.undrawn, parkedBelow: r.parkedBelow };
  };
  const review = "a review clipped to a few lines: ONE chip under it, the other five at their own paragraphs, all six back in place when it is opened";
  await expect.poll(shape, { message: `${review} (collapsed)` }).toEqual({ after: 1, within: 5, undrawn: 0, parkedBelow: true });
  const collapsed = await read();
  await page.click("#nadia-more");
  await expect.poll(shape, { message: `${review} (opened)` }).toMatchObject({ after: 0, within: 6 });
  await page.click("#nadia-more");
  await expect.poll(shape, { message: `${review} (closed again)` }).toMatchObject({ after: 1, within: 5 });
  expect((await read()).after[0], `${review} (the same chip under it)`).toBe(collapsed.after[0]);
});

test("a box that only starts clipping when its image arrives still puts one chip where it can be seen, and only one", async ({ page, pages }) => {
  // The Goodreads review whose images outlive the scan.
  pages.serve({
    "/latecover.html": PAGE("late cover fixture", `<h1>A review whose picture arrives last</h1>
<article id="post"><div id="box" style="max-height:420px;overflow:hidden">
<img id="cover" alt="" style="display:block;width:100%;height:0;background:#ddd">
<p id="lp1">${PARA("LATE-ONE")}</p>
<p id="lp2">${PARA("LATE-TWO")}</p>
</div></article>`),
  });
  await page.goto(pages.url("/latecover.html"), { waitUntil: "load" });
  // An <article> is one post, and a post's paragraphs are one unit: one chip, ×2.
  await chipsSettle(page, 1, "#post");
  const late = "a box that only starts clipping when its image arrives still puts one chip where it can be seen, and only one";
  expect(await page.evaluate((sel) => [...document.querySelectorAll(`#post ${sel}`)].filter((h) => !document.getElementById("box").contains(h)).length, BADGE_SEL), late).toBe(0);
  await page.evaluate(() => (document.getElementById("cover").style.height = "700px"));
  const after = () =>
    page.evaluate((sel) => {
      const box = document.getElementById("box");
      const hosts = [...document.querySelectorAll(`#post ${sel}`)];
      const out = hosts.filter((h) => !box.contains(h));
      const br = box.getBoundingClientRect();
      return {
        chips: hosts.length,
        out: out.length,
        first: out[0] ? out[0].previousElementSibling === box : false,
        onScreen: out.every((h) => h.getBoundingClientRect().height > 0 && h.getBoundingClientRect().top >= br.bottom - 1),
        clips: box.scrollHeight > box.clientHeight + 32,
      };
    }, BADGE_SEL);
  await expect.poll(after, { message: late }).toEqual({ chips: 1, out: 1, first: true, onScreen: true, clips: true });
});

// The "> " markers of a quoted run are not part of the text the unit carries (lib/dom/text.ts),
// so the orchestrator recomputes that text the same way (partTextOf). Rebuilding it from the
// nodes alone brought the markers back, and ANY mutation whose scan root touched the <pre>
// threw the unit away, removed its chip and read it again.
test("a quoted mail unit survives a mutation beside it: same chip node, no re-read, no new request", async ({ page, pages, nativeHost, storage }) => {
  await storage.set({ debug: true });
  const scans = [];
  page.on("console", (m) => {
    if (m.text().includes("dirty scan:")) scans.push(m.text());
  });
  pages.serve({ "/mailing-list.html": readFileSync(join(FIXTURES, "mailing-list.html"), "utf8") });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/mailing-list.html"), { waitUntil: "load" });
  await chipsSettle(page, 3);
  const survives = "a quoted mail unit survives a mutation beside it: same chip node, no re-read, no new request";
  // Every chip host is tagged, and the QUOTED unit's (right after the last quoted line,
  // inside the <pre>) is marked.
  const before = await page.evaluate((sel) => {
    const hosts = [...document.querySelectorAll(sel)];
    hosts.forEach((h, i) => { h.__anagramTag = i; });
    const quoted = hosts.find((h) => (h.previousSibling?.textContent ?? "").includes("year it was typed"));
    if (quoted) quoted.__quoted = true;
    return { hosts: hosts.length, found: !!quoted, pills: hosts.map((h) => h.shadowRoot?.querySelector(".num")?.textContent ?? "") };
  }, BADGE_SEL);
  expect(before.found, `${survives} (the quoted unit's chip)`).toBe(true);
  const timesAsked = () => nativeHost.textsSince(mark).filter((t) => t.includes("maintained by four people")).length;
  const askedBefore = timesAsked();
  // What the host was given: the quotation without its markers, while the page holds them.
  const sent = nativeHost.textsSince(mark).find((t) => t.includes("maintained by four people")) ?? "";
  expect(sent, `${survives} (the quotation was read)`).not.toBe("");
  expect(sent, `${survives} (without its "> " markers)`).not.toContain(">");
  expect(await page.evaluate(() => document.querySelector("pre").textContent.includes("> Right, so a package")), `${survives} (the page keeps them)`).toBe(true);

  // Four mutations, not one character of the unit changed by any of them. The removal is the
  // one lib/dom/splits.ts reacts to: the <pre>'s text node was cut, with chips between its
  // pieces, and a cut must stay standing when something else leaves the page.
  const scanned = scans.length;
  await page.evaluate(() => {
    const pre = document.querySelector("pre");
    const note = document.createElement("p");
    note.textContent = "Archive index"; // a label: too short to be scored, and never merged
    document.body.appendChild(note);
    pre.appendChild(document.createElement("span"));
    pre.classList.toggle("touched");
    const gone = document.createElement("i");
    document.body.appendChild(gone);
    gone.remove();
  });
  await expect.poll(() => scans.length, { message: `${survives} (the mutations were walked)` }).toBeGreaterThan(scanned);
  await page.waitForTimeout(ABSENCE_MS);
  const after = await page.evaluate((sel) => {
    const hosts = [...document.querySelectorAll(sel)];
    const quoted = hosts.find((h) => h.__quoted);
    return {
      hosts: hosts.length,
      tagged: hosts.filter((h) => typeof h.__anagramTag === "number").length,
      quotedAlive: !!quoted && quoted.isConnected,
      pills: hosts.map((h) => h.shadowRoot?.querySelector(".num")?.textContent ?? ""),
    };
  }, BADGE_SEL);
  expect.soft(after, survives).toEqual({ hosts: before.hosts, tagged: before.hosts, quotedAlive: true, pills: before.pills });
  expect.soft(timesAsked(), survives).toBe(askedBefore);
});

// The walker cuts preserved-whitespace text at its blank lines, and a framework writes to the
// one node it created. X's "Show more" wrote the whole post into that node and the pieces cut
// off it stayed on screen: the expanded post ended with a stale copy of its preview, and that
// copy was scored with it. lib/dom/splits.ts puts the page back.
test("a script rewriting the pre-wrap post it owns shows exactly its new text, which is what gets scored; removing its node leaves nothing behind", async ({ page, pages, nativeHost }) => {
  const P1 = "FWHEAD The keeper's log for that winter runs to nearly four hundred pages, and almost none of it is about the light. It is about weather, mostly, and about the small economies of a household cut off from the mainland: how much coal was left, which hens were still laying, when the supply boat was due and whether it came, and which books the children read by the stove.";
  const P2 = "He wrote in pencil because ink froze in the well, and he wrote every evening without exception, even on the night his youngest was born in the room below the lantern.";
  const P3 = "FWTAIL The entry for that night is eleven words long, and it gives the wind, the barometer and the hour the glass went before anything else.";
  const PREVIEW = `${P1}\n\n${P2.slice(0, 60)}`;
  const FULL = `${P1}\n\n${P2}\n\n${P3}`;
  pages.serve({
    "/framework-post.html": PAGE("framework post fixture", `<div id="post" style="white-space:pre-wrap"></div><button id="more">Show more</button>
<script>
  const node = document.createTextNode(${JSON.stringify(PREVIEW)});
  document.getElementById("post").append(node);
  document.getElementById("more").addEventListener("click", () => { node.nodeValue = ${JSON.stringify(FULL)}; });
  window.__dropPost = () => node.remove();
</script>`),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/framework-post.html"), { waitUntil: "load" });
  const rewritten = "a script rewriting the pre-wrap post it owns shows exactly its new text, and the new text is what gets scored";
  await expect(settledChips(page, "#post").first(), rewritten).toBeAttached();
  expect(await page.evaluate(() => [...document.getElementById("post").childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).length), `${rewritten} (the walker cut the node)`).toBeGreaterThan(1);
  const opened = nativeHost.textMark();
  await page.evaluate(() => document.getElementById("more").click());
  await expect.poll(() => page.evaluate(() => document.getElementById("post").textContent), { message: rewritten }).toBe(FULL);
  // The old chip stays up until the new verdict replaces it, so wait for the request itself:
  // the text only the rewrite holds is sent (with the head paragraph at the model's 75 words,
  // in a unit of its own at the shipped 50, where the head clears the minimum by itself).
  await expect.poll(() => nativeHost.textsSince(opened).some((t) => t.includes("FWTAIL")), { message: rewritten }).toBe(true);
  expect(nativeHost.textsSince(mark).some((t) => t.includes("FWHEAD")), rewritten).toBe(true);
  await expect(settledChips(page, "#post").first(), rewritten).toBeAttached();

  await page.evaluate(() => window.__dropPost());
  const gone = () => page.evaluate((sel) => ({ text: document.getElementById("post").textContent, chips: document.querySelectorAll(`#post ${sel}`).length }), BADGE_SEL);
  await expect.poll(gone, { message: "…and removing its node leaves no piece of the post and no chip behind" }).toEqual({ text: "", chips: 0 });
});

// Facebook puts only the first lines of a long post in the page, ending in "…" and an inline
// "See more" button, and writes the rest in when it is pressed. The preview is not the post.
test("a post the site cut to a preview (\"… See more\") is not read until it is opened, and then it is read whole", async ({ page, pages, nativeHost }) => {
  const HEAD = "SEEMOREHEAD Volunteers from the history society have spent the last two long winters transcribing them all by hand. The keeper's logs for that winter run to nearly four hundred pages, and almost none of it is about the light. It is about weather, mostly, and about the small economies of a household cut off from the mainland: how much coal was left, which hens were still laying, when the supply boat was due and whether it";
  const TAIL = " came at all, and which books the children read by the stove. SEEMORETAIL He wrote in pencil because ink froze in the well, and he wrote every evening without exception.";
  pages.serve({
    "/see-more.html": PAGE("see more fixture", `<div role="article" id="post"><div data-ad-preview="message"><div style="white-space:pre-wrap"><div dir="auto" id="text">${HEAD}…<div role="button" tabindex="0" id="more" style="display:inline;cursor:pointer;font-weight:600">See more</div></div></div></div></div>
<script>
  document.getElementById("more").addEventListener("click", () => {
    document.getElementById("text").replaceChildren(document.createTextNode(${JSON.stringify(HEAD + TAIL)}));
  });
</script>`),
  });
  const mark = nativeHost.textMark();
  const mine = () => nativeHost.textsSince(mark).filter((t) => t.includes("SEEMOREHEAD"));
  await page.goto(pages.url("/see-more.html"), { waitUntil: "load" });
  const preview = "a post the site cut to a preview (\"… See more\") is not read until it is opened, and then it is read whole";
  await expect(page.locator("#anagram-fab"), `${preview} (the page is being read)`).toBeAttached();
  await page.waitForTimeout(ABSENCE_MS); // the ball is up before the first walk has run
  await expect(page.locator(`#post ${BADGE_SEL}`), `${preview} (no chip on the preview)`).toHaveCount(0);
  expect(mine(), `${preview} (nothing of the preview sent)`).toEqual([]);
  await page.click("#more");
  await expect(page.locator(`#post ${BADGE_SEL}`).first(), preview).toBeAttached();
  // The chip that answers the wait may be the pending one: wait for the text itself.
  await expect.poll(() => mine().length, { message: preview }).toBeGreaterThan(0);
  expect(mine().filter((t) => !t.includes("SEEMORETAIL")), `${preview} (read whole)`).toEqual([]);
});
