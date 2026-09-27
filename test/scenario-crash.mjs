// test/scenario-crash.mjs — the local engine dying mid-work, with the real extension. Run
// by test/scenarios.mjs (phase A, local), or alone: node test/scenario-crash.mjs
//
// The fake host (test/fake-native.mjs, `crash`) dies the way an engine does when MLX aborts
// the process: no reply, no exception, the pipe simply closes with batches in flight. Its
// restart takes a while to load, as the real one does. A single death must cost the reader
// nothing but time: every chip ends with a verdict, nothing reads "Unavailable", nothing is
// scored twice that was already answered. A host that dies on every batch must be given up
// on after a bounded number of starts, into the engine-down state the pages already know.
// It runs in a browser of its own, so giving up cannot leak into any other check.
import { fileURLToPath } from "node:url";
import { launchExtension, serveHtml, BADGE_SEL } from "./harness.mjs";
import { createNativeFixture } from "./fake-native.mjs";
import { servePdfs, openPdfInReader, PDF_CHIP } from "./pdf-fixture.mjs";

/** Long enough to be read alone; the `long` form is past 510 bytes, so its words are counted
 *  by the engine before it is scored and a count can be what meets the dead host. */
const PARA = (tag, long = false) => `${tag} is a paragraph written for a host that dies in the middle of its work, ` +
  "the way the engine does when the graphics driver throws away a command buffer and takes the whole process down with it, " +
  "and the page that asked for it must still end up with a verdict under every paragraph once a new host has started, " +
  "without telling the reader that anything was unavailable in between and without asking the engine twice about a text it already answered." +
  (long ? ` The longer paragraphs carry a second part, so that the engine is asked how many tokens they are before they are scored, and ${tag} ` +
    "is the one that finds out whether a count that was in flight when the host went away is asked again of the next host, just as a score is." : "");
const PAGE = (tag, count) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${tag}</title></head>
<body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui"><main>
${Array.from({ length: count }, (_, i) => `<p id="p${i}">${PARA(`${tag}-${i}`, i % 3 === 2)}</p>`).join("\n")}
</main></body></html>`;
const PASTE = (tag) => PARA(`${tag}-A`) + " " + PARA(`${tag}-B`);

/** What the page shows, and what it has shown since watch() began: a chip read as
 *  "Unavailable" (band-unknown, no longer pending) or the ball's "!" at any moment. */
const watch = (page, chipSel) => page.evaluate((sel) => {
  const seen = window.__crashWatch = { unavailable: 0, down: false };
  setInterval(() => {
    for (const host of document.querySelectorAll(sel)) {
      const pill = host.shadowRoot?.querySelector(".pill");
      if (pill?.classList.contains("band-unknown") && !pill.classList.contains("pending")) seen.unavailable++;
    }
    if (document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent === "!") seen.down = true;
  }, 40);
}, chipSel);
const seen = (page) => page.evaluate(() => window.__crashWatch);
/** Every chip on the page: "pending", "unavailable" or "verdict" (hosts without a pill,
 *  such as the reader's toolbar, are not chips). */
const chipStates = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].flatMap((host) => {
  const pill = host.shadowRoot?.querySelector(".pill");
  if (!pill) return [];
  return [pill.classList.contains("pending") ? "pending" : pill.classList.contains("band-unknown") ? "unavailable" : "verdict"];
}), sel);
const ball = (page) => page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);
const until = async (check, timeout, step = 200) => {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, step));
  }
};

/**
 * Texts the engine was asked about again although the host it asked before had answered,
 * or had not died: every second request for a text must follow one that died with its host.
 */
function unnecessaryResends(fixture, mark) {
  const log = fixture.requests();
  const answered = new Set(log.filter((r) => r.op === "__reply").map((r) => `${r.pid}:${r.id}`));
  const died = new Set(log.filter((r) => r.op === "__crash").map((r) => r.pid));
  const sends = new Map();
  for (const r of log.slice(mark)) {
    if (r.op !== "score") continue;
    for (const { text } of r.payload.blocks ?? []) {
      const list = sends.get(text) ?? [];
      list.push(r);
      sends.set(text, list);
    }
  }
  const extra = [];
  for (const [text, list] of sends) {
    list.slice(1).forEach((_, i) => {
      const before = list[i];
      if (answered.has(`${before.pid}:${before.id}`) || !died.has(before.pid)) extra.push(text.slice(0, 40));
    });
  }
  return extra;
}

export async function crashScenarios({ record }) {
  const fixture = await createNativeFixture();
  const pages = {};
  const server = await serveHtml(pages, "/none");
  pages["/none"] = "<!doctype html><title>none</title>";
  const pdfs = await servePdfs();
  const { context, extId } = await launchExtension({ nativeFixture: fixture });
  // Restarts take this long to load their model, as the real engine's do (a few seconds
  // on Apple silicon; less here, and the same shape).
  const STARTUP_MS = 1500;
  /** Wait until the worker has the engine up, so a check starts from a healthy engine and
   *  not from whatever the one before it left behind. */
  const healthy = async () => {
    const probe = await context.newPage();
    await probe.goto(`chrome-extension://${extId}/options.html`);
    await until(() => probe.evaluate(async () =>
      (await chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }))?.active === "server").catch(() => false), 20000, 300);
    await probe.close();
  };
  try {
    // ---- (a) one death in the middle of a page ------------------------------------------
    {
      pages["/once.html"] = PAGE("ONCE", 12);
      const logMark = fixture.requests().length;
      fixture.setState({ crash: { skip: 1, times: 1, delayMs: 250 }, startupMs: STARTUP_MS });
      // The running host was started with the browser; only the ones after it load.
      await new Promise((r) => setTimeout(r, STARTUP_MS));
      const page = await context.newPage();
      await page.goto(server.url("/once.html"), { waitUntil: "load" });
      await watch(page, BADGE_SEL);
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); }
      });
      const settled = await until(async () => {
        const states = await chipStates(page, BADGE_SEL);
        return states.length === 12 && states.every((s) => s === "verdict");
      }, 45000);
      const states = await chipStates(page, BADGE_SEL);
      const shown = await seen(page);
      const extra = unnecessaryResends(fixture, logMark);
      record("ui", "engine dies once mid-page: every chip ends with a verdict after the restart",
        fixture.crashes() === 1 && settled, JSON.stringify({ crashes: fixture.crashes(), states }));
      record("ui", "engine dies once mid-page: no chip ever reads Unavailable and the ball never shows !",
        fixture.crashes() === 1 && shown.unavailable === 0 && !shown.down, JSON.stringify(shown));
      record("ui", "engine dies once mid-page: nothing already answered is asked again, what died with the host is asked once more",
        fixture.crashes() === 1 && extra.length === 0, JSON.stringify(extra.slice(0, 4)));
      await page.close();
    }

    // ---- (a) the PDF reader --------------------------------------------------------------
    {
      await healthy();
      const logMark = fixture.requests().length;
      const before = fixture.crashes();
      fixture.setState({ crash: { skip: 0, times: 1, delayMs: 250 } });
      const page = await openPdfInReader(context, pdfs.url("/doc.pdf"));
      await watch(page, PDF_CHIP);
      const settled = await until(async () => {
        const states = await chipStates(page, PDF_CHIP);
        return states.length >= 2 && states.every((s) => s === "verdict");
      }, 45000);
      const states = await chipStates(page, PDF_CHIP);
      const shown = await seen(page);
      const extra = unnecessaryResends(fixture, logMark);
      const died = fixture.crashes() - before;
      record("ui", "engine dies once while the PDF reader scores: every chip ends with a verdict, none reads Unavailable",
        died === 1 && settled && shown.unavailable === 0 && !shown.down && extra.length === 0,
        JSON.stringify({ died, states, shown, extra: extra.slice(0, 3) }));
      await page.close();
    }

    // ---- (a) the paste page --------------------------------------------------------------
    {
      await healthy();
      const before = fixture.crashes();
      fixture.setState({ crash: { skip: 0, times: 1, delayMs: 250 } });
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/paste.html`);
      await page.locator("#text").fill(PASTE("PASTEONCE"));
      await page.locator("#analyze").click();
      const done = await until(async () => (await page.locator("#results").isVisible()) ||
        !(await page.locator("#analyze").isDisabled()), 45000);
      const results = await page.locator("#results").isVisible();
      const status = await page.locator("#status").innerText();
      const died = fixture.crashes() - before;
      record("ui", "engine dies once while the paste page analyzes: the result is shown, not a failure",
        died === 1 && done && results, JSON.stringify({ died, results, status }));
      await page.close();
    }

    // ---- (b) a host that dies on every batch ---------------------------------------------
    {
      pages["/always.html"] = PAGE("ALWAYS", 6);
      await healthy();
      fixture.setState({ crash: { skip: 0, times: -1, delayMs: 150 }, startupMs: 300 });
      /** Deaths since `from` once no host has died for 12 s (at most a minute): a loop would
       *  start one at each of the pages' re-checks, every 5 s. */
      const quiet = async (from) => {
        let last = fixture.crashes(), still = Date.now();
        const end = Date.now() + 60000;
        while (Date.now() < end && Date.now() - still < 12000) {
          await new Promise((r) => setTimeout(r, 500));
          if (fixture.crashes() !== last) { last = fixture.crashes(); still = Date.now(); }
        }
        return { crashes: last - from, stopped: Date.now() - still >= 12000 };
      };
      const before = fixture.crashes();
      const page = await context.newPage();
      await page.goto(server.url("/always.html"), { waitUntil: "load" });
      const down = await until(async () => (await ball(page)) === "!", 60000);
      // Down may be passing at first (a batch that killed two hosts takes the page down, and
      // the engine is asked again once it answers health); the starts must stop all the same.
      const first = await quiet(before);
      const states = await chipStates(page, BADGE_SEL);
      const downAtEnd = (await ball(page)) === "!";
      record("ui", "engine dies on every batch: the page shows the engine-down state (ball !, no verdict invented)",
        down && downAtEnd && states.every((s) => s === "unavailable") && states.includes("unavailable"),
        JSON.stringify({ down, downAtEnd, states }));
      record("ui", "engine dies on every batch: restarts stop after a bounded number, nothing loops",
        first.stopped && first.crashes >= 2 && first.crashes <= 4, JSON.stringify(first));
      const later = fixture.crashes();

      // The panel says why: not the generic "not ready" but that the engine keeps stopping.
      await page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.click());
      const notice = await until(async () => !!(await page.evaluate(() =>
        document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".pnotice")?.textContent)), 3000)
        ? await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".pnotice").textContent) : null;
      record("ui", "engine dies on every batch: the panel says the engine keeps stopping and offers Retry",
        !!notice && /stopp/i.test(notice) && /Retry/.test(notice), JSON.stringify(notice));

      // The reader and the paste page meet the same state and start nothing either.
      const reader = await openPdfInReader(context, pdfs.url("/grouped.pdf"));
      const readerDown = await until(async () => (await ball(reader)) === "!", 20000);
      const paste = await context.newPage();
      await paste.goto(`chrome-extension://${extId}/paste.html`);
      await paste.locator("#text").fill(PASTE("PASTEALWAYS"));
      await paste.locator("#analyze").click();
      await until(async () => !(await paste.locator("#analyze").isDisabled()), 30000);
      const pasteStatus = await paste.locator("#status").innerText();
      record("ui", "engine dies on every batch: the PDF reader and the paste page show their engine-down state and start no host",
        readerDown && /did not complete/.test(pasteStatus) && fixture.crashes() === later,
        JSON.stringify({ readerDown, pasteStatus, crashes: fixture.crashes() - before }));

      // Settings says so too, and reading it wakes nothing. Its Retry starts the engine again:
      // the pages ask again by themselves, and an engine still broken is given up on again
      // after as many deaths.
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extId}/options.html`);
      const status = () => options.locator("#componentSettings .component-status").innerText().catch(() => "");
      const crashNotice = await until(async () => /stopp/i.test(await options.locator("#componentSettings").innerText().catch(() => "")), 10000);
      const settingsText = (await options.locator("#componentSettings").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 240);
      record("ui", "engine dies on every batch: Settings names the repeated stops and offers Retry",
        crashNotice && (await status()) === "Needs attention" && /Retry/.test(settingsText) && fixture.crashes() === later,
        JSON.stringify(settingsText));
      await options.locator("#component-primary").click();
      const lifted = await until(async () => (await status()) === "Ready", 10000);
      const second = await quiet(later);
      record("ui", "engine dies on every batch: Retry in Settings starts it again, and it is given up on again as quickly",
        lifted && second.stopped && second.crashes >= 2 && second.crashes <= 4, JSON.stringify({ lifted, ...second }));
      await options.close();

      // Mended, and Retry in the panel brings everything back: the page, and the reader
      // with it (it re-checks by itself once the engine answers again).
      fixture.setState({ crash: null, startupMs: 0 });
      await page.bringToFront();
      await page.evaluate(() => {
        const root = document.getElementById("anagram-fab")?.shadowRoot;
        if (!root?.querySelector(".pnotice")) root?.querySelector(".count")?.click();
        [...(root?.querySelectorAll(".pnotice button") ?? [])].find((b) => b.textContent === "Retry")?.click();
      });
      const back = await until(async () => {
        const s = await chipStates(page, BADGE_SEL);
        return s.length === 6 && s.every((x) => x === "verdict");
      }, 30000);
      const readerBack = await until(async () => {
        const s = await chipStates(reader, PDF_CHIP);
        return s.length >= 1 && s.every((x) => x === "verdict");
      }, 30000);
      record("ui", "engine mended: Retry brings verdicts back to the page, and the reader follows",
        back && readerBack, JSON.stringify({ page: await chipStates(page, BADGE_SEL), reader: await chipStates(reader, PDF_CHIP) }));
      await Promise.all([page.close(), reader.close(), paste.close()]);
    }
  } finally {
    await context.close();
    await server.close();
    await pdfs.close();
    await fixture.close();
    fixture.dispose();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = [];
  const record = (phase, name, ok, note = "") => results.push({ phase, name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note });
  await crashScenarios({ record });
  for (const r of results) console.log(`${r.status.padEnd(4)}  [${r.phase}]  ${r.name}${r.note ? `  —  ${r.note}` : ""}`);
  const fails = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${results.length - fails} pass / ${fails} fail`);
  process.exit(fails ? 1 : 0);
}
