// The local engine dying mid-work, with the real extension. The fake host (test/fake-native.mjs,
// `crash`) dies the way an engine does when MLX aborts the process: no reply, no exception, the
// pipe simply closes with batches in flight. Its restart takes a while to load, as the real
// one's does. A single death must cost the reader nothing but time: every chip ends with a
// verdict, nothing reads "Unavailable", nothing answered is scored twice. A host that dies on
// every batch must be given up on after a bounded number of starts, into the engine-down state
// the pages already know.
//
//   npx playwright test scenarios-crash
import { test as base, expect, BADGE_SEL, PAGE } from "./kit.mjs";
import { GROUPED_PDF, TEST_PDF, PDF_CHIP, openPdfInReader } from "../pdf-fixture.mjs";
import { join } from "node:path";
import { NO_MODEL_HOSTS } from "../webengine/model-server.mjs";

const test = base.extend({
  /** What the host is told before the browser starts: the browser's first host has then
   *  loaded (the launch waits for it) before the page asks anything. */
  hostState: [{}, { option: true }],
  nativeHost: async ({ nativeHost, hostState }, use) => {
    nativeHost.setState(hostState);
    await use(nativeHost);
  },
});

/** Long enough to be read alone; the `long` form is past 510 bytes, so its words are counted
 *  by the engine before it is scored and a count can be what meets the dead host. */
const PARA = (tag, long = false) => `${tag} is a paragraph written for a host that dies in the middle of its work, ` +
  "the way the engine does when the graphics driver throws away a command buffer and takes the whole process down with it, " +
  "and the page that asked for it must still end up with a verdict under every paragraph once a new host has started, " +
  "without telling the reader that anything was unavailable in between and without asking the engine twice about a text it already answered." +
  (long ? ` The longer paragraphs carry a second part, so that the engine is asked how many tokens they are before they are scored, and ${tag} ` +
    "is the one that finds out whether a count that was in flight when the host went away is asked again of the next host, just as a score is." : "");
const PARAS = (tag, count) => PAGE(tag, `<main>\n${Array.from({ length: count }, (_, i) => `<p id="p${i}">${PARA(`${tag}-${i}`, i % 3 === 2)}</p>`).join("\n")}\n</main>`);
const PASTE = (tag) => PARA(`${tag}-A`) + " " + PARA(`${tag}-B`);

/** What the page has shown since watch() began: a chip read as "Unavailable" (band-unknown,
 *  no longer pending) or the ball's "!", at any moment. */
const watch = (page, sel) => page.evaluate((sel) => {
  const seen = window.__crashWatch = { unavailable: 0, down: false };
  setInterval(() => {
    for (const host of document.querySelectorAll(sel)) {
      const pill = host.shadowRoot?.querySelector(".pill");
      if (pill?.classList.contains("band-unknown") && !pill.classList.contains("pending")) seen.unavailable++;
    }
    if (document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent === "!") seen.down = true;
  }, 40);
}, sel);
const seen = (page) => page.evaluate(() => window.__crashWatch);
/** Every chip: "pending", "unavailable" or "verdict" (hosts without a pill are not chips). */
const chipStates = (page, sel = BADGE_SEL) => page.evaluate((s) => [...document.querySelectorAll(s)].flatMap((host) => {
  const pill = host.shadowRoot?.querySelector(".pill");
  if (!pill) return [];
  return [pill.classList.contains("pending") ? "pending" : pill.classList.contains("band-unknown") ? "unavailable" : "verdict"];
}), sel);
const allVerdicts = (states) => states.length > 0 && states.every((s) => s === "verdict");
const ball = (page) => page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);

/**
 * Texts the engine was asked about again although the host it asked before had answered,
 * or had not died: every second request for a text must follow one that died with its host.
 */
function unnecessaryResends(host, mark) {
  const log = host.requests();
  const answered = new Set(log.filter((r) => r.op === "__reply").map((r) => `${r.pid}:${r.id}`));
  const died = new Set(log.filter((r) => r.op === "__crash").map((r) => r.pid));
  const sends = new Map();
  for (const r of log.slice(mark)) {
    if (r.op !== "score") continue;
    for (const { text } of r.payload.blocks ?? []) sends.set(text, [...(sends.get(text) ?? []), r]);
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

// Restarts take this long to load their model, as the real engine's do (a few seconds on Apple
// silicon; less here, and the same shape).
const STARTUP_MS = 1500;

test.describe("the engine dies once", () => {
  test.describe(() => {
    test.use({ hostState: { crash: { skip: 1, times: 1, delayMs: 250 }, startupMs: STARTUP_MS } });

    test("engine dies once mid-page: every chip ends with a verdict, none reads Unavailable, nothing answered is asked again", async ({ page, pages, nativeHost }) => {
      pages.serve({ "/once.html": PARAS("ONCE", 12) });
      const mark = nativeHost.requests().length;
      await page.goto(pages.url("/once.html"), { waitUntil: "load" });
      await watch(page, BADGE_SEL);
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); }
      });
      const verdicts = "engine dies once mid-page: every chip ends with a verdict after the restart";
      await expect.poll(() => chipStates(page), { message: verdicts, timeout: 45_000 }).toEqual(Array(12).fill("verdict"));
      expect.soft(nativeHost.crashes(), verdicts).toBe(1);
      expect.soft(await seen(page), "engine dies once mid-page: no chip ever reads Unavailable and the ball never shows !").toEqual({ unavailable: 0, down: false });
      expect.soft(unnecessaryResends(nativeHost, mark), "engine dies once mid-page: nothing already answered is asked again, what died with the host is asked once more").toEqual([]);
    });
  });

  test.describe(() => {
    test.use({ hostState: { crash: { skip: 0, times: 1, delayMs: 250 }, startupMs: STARTUP_MS } });

    test("engine dies once while the PDF reader scores: every chip ends with a verdict, none reads Unavailable", async ({ context, pages, nativeHost }) => {
      pages.serve({ "/doc.pdf": TEST_PDF });
      const mark = nativeHost.requests().length;
      const page = await openPdfInReader(context, pages.url("/doc.pdf"));
      await watch(page, PDF_CHIP);
      const reader = "engine dies once while the PDF reader scores: every chip ends with a verdict, none reads Unavailable";
      await expect.poll(async () => { const s = await chipStates(page, PDF_CHIP); return s.length >= 2 && allVerdicts(s); }, { message: reader, timeout: 45_000 }).toBe(true);
      expect.soft(nativeHost.crashes(), reader).toBe(1);
      expect.soft(await seen(page), reader).toEqual({ unavailable: 0, down: false });
      expect.soft(unnecessaryResends(nativeHost, mark), reader).toEqual([]);
    });

    test("engine dies once while the paste page analyzes: the result is shown, not a failure", async ({ page, extension, nativeHost }) => {
      await page.goto(extension.url("paste.html"));
      await page.locator("#text").fill(PASTE("PASTEONCE"));
      await page.locator("#analyze").click();
      const paste = "engine dies once while the paste page analyzes: the result is shown, not a failure";
      await expect(page.locator("#results"), paste).toBeVisible({ timeout: 45_000 });
      expect(nativeHost.crashes(), paste).toBe(1);
    });
  });
});

test.describe("the engine dies on every batch", () => {
  test.use({ hostState: { crash: { skip: 0, times: -1, delayMs: 150 }, startupMs: 300 } });

  test("given up on after a bounded number of starts: every surface shows the engine down and starts nothing, Retry starts it again, and once mended the verdicts come back", async ({ context, page, pages, extension, nativeHost }) => {
    test.setTimeout(5 * 60_000);
    pages.serve({ "/always.html": PARAS("ALWAYS", 6), "/grouped.pdf": GROUPED_PDF });
    /** Deaths since `from` once no host has died for 12 s (at most a minute): a loop would
     *  start one at each of the pages' re-checks, every 5 s. */
    const quiet = async (from, message) => {
      let last = nativeHost.crashes(), still = Date.now();
      await expect
        .poll(() => {
          if (nativeHost.crashes() !== last) { last = nativeHost.crashes(); still = Date.now(); }
          return Date.now() - still >= 12_000;
        }, { message, timeout: 60_000, intervals: [500] })
        .toBe(true);
      return last - from;
    };
    const before = nativeHost.crashes();
    await page.goto(pages.url("/always.html"), { waitUntil: "load" });
    const down = "engine dies on every batch: the page shows the engine-down state (ball !, no verdict invented)";
    await expect.poll(() => ball(page), { message: down, timeout: 60_000 }).toBe("!");
    // Down may pass at first (a batch that killed two hosts takes the page down, and the engine
    // is asked again once it answers health); the starts must stop all the same.
    const bounded = "engine dies on every batch: restarts stop after a bounded number, nothing loops";
    const first = await quiet(before, bounded);
    expect.soft(first, bounded).toBeGreaterThanOrEqual(2);
    expect.soft(first, bounded).toBeLessThanOrEqual(4);
    const states = await chipStates(page);
    expect.soft(await ball(page), down).toBe("!");
    expect.soft(states.length > 0 && states.every((s) => s === "unavailable"), `${down}: ${JSON.stringify(states)}`).toBe(true);
    const later = nativeHost.crashes();

    // The panel says why: not the generic "not ready" but that the engine keeps stopping.
    await page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.click());
    const notice = page.locator("#anagram-fab .pnotice");
    const says = "engine dies on every batch: the panel says the engine keeps stopping and offers Retry";
    await expect(notice, says).toHaveText(/stopp/i);
    await expect(notice, says).toContainText("Retry");

    // The reader and the paste page meet the same state and start nothing either.
    const reader = await openPdfInReader(context, pages.url("/grouped.pdf"));
    const others = "engine dies on every batch: the PDF reader and the paste page show their engine-down state and start no host";
    await expect.poll(() => ball(reader), { message: `${others} (the reader)` }).toBe("!");
    const paste = await context.newPage();
    await paste.goto(extension.url("paste.html"));
    await paste.locator("#text").fill(PASTE("PASTEALWAYS"));
    await paste.locator("#analyze").click();
    await expect(paste.locator("#status"), `${others} (the paste page)`).toContainText("did not complete", { timeout: 30_000 });
    await expect(paste.locator("#analyze"), `${others} (the paste page)`).toBeEnabled();
    expect.soft(nativeHost.crashes(), `${others} (no host started)`).toBe(later);

    // Settings says so too, and reading it wakes nothing. Its Retry starts the engine again: the
    // pages ask again by themselves, and an engine still broken is given up on again as quickly.
    const options = await context.newPage();
    await options.goto(extension.url("options.html"));
    const settings = "engine dies on every batch: Settings names the repeated stops and offers Retry";
    const status = options.locator("#componentSettings .component-status");
    await expect(options.locator("#componentSettings"), settings).toContainText(/stopp/i);
    await expect(status, settings).toHaveText("Local engine, Needs attention");
    await expect(options.locator("#componentSettings"), settings).toContainText("Retry");
    expect.soft(nativeHost.crashes(), `${settings} (reading it wakes nothing)`).toBe(later);
    await options.locator("#component-primary").click();
    const again = "engine dies on every batch: Retry in Settings starts it again, and it is given up on again as quickly";
    await expect(status, again).toHaveText("Local engine, Ready");
    const second = await quiet(later, again);
    expect.soft(second, again).toBeGreaterThanOrEqual(2);
    expect.soft(second, again).toBeLessThanOrEqual(4);
    await options.close();

    // Mended, and Retry in the panel brings everything back: the page, and the reader with it
    // (it re-checks by itself once the engine answers again).
    nativeHost.setState({ crash: null, startupMs: 0 });
    await page.bringToFront();
    await page.evaluate(() => {
      const root = document.getElementById("anagram-fab")?.shadowRoot;
      if (!root?.querySelector(".pnotice")) root?.querySelector(".count")?.click();
      [...(root?.querySelectorAll(".pnotice button") ?? [])].find((b) => b.textContent === "Retry")?.click();
    });
    const mended = "engine mended: Retry brings verdicts back to the page, and the reader follows";
    await expect.poll(() => chipStates(page), { message: `${mended} (the page)`, timeout: 30_000 }).toEqual(Array(6).fill("verdict"));
    await expect.poll(async () => allVerdicts(await chipStates(reader, PDF_CHIP)), { message: `${mended} (the reader)`, timeout: 30_000 }).toBe(true);
  });
});

// An Apple Silicon Mac (test/pw/devices.mjs) whose local engine keeps dying: the setup page
// and the popup offer the in-browser engine beside Retry, and the popup's switch sets it up.
test.describe("the local engine dies on every batch, where the in-browser engine runs", () => {
  test.use({
    build: join(import.meta.dirname, "..", "..", "output-test", "devices", "apple-silicon-chrome-granted"),
    launch: { args: [NO_MODEL_HOSTS] },
    hostState: { crash: { skip: 0, times: -1, delayMs: 150 }, startupMs: 300 },
  });

  test("given up on: the setup page and the popup offer the in-browser engine beside Retry, and the popup's switch sets it up", async ({ context, page, pages, extension, nativeHost }) => {
    test.setTimeout(3 * 60_000);
    pages.serve({ "/fallback.html": PARAS("FALLBACK", 6) });
    await page.goto(pages.url("/fallback.html"), { waitUntil: "load" });
    await expect.poll(() => ball(page), { message: "the page shows the engine down", timeout: 60_000 }).toBe("!");
    // Given up on once no host has died for 12 s: a request that killed two hosts takes the
    // engine down for a moment too, and health brings it back until the starts are counted out.
    let last = nativeHost.crashes(), still = Date.now();
    await expect.poll(() => {
      if (nativeHost.crashes() !== last) { last = nativeHost.crashes(); still = Date.now(); }
      return Date.now() - still >= 12_000;
    }, { message: "the engine is given up on", timeout: 90_000, intervals: [500] }).toBe(true);
    const setup = await context.newPage();
    await setup.goto(extension.url("onboarding.html"));
    const code = () => setup.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus" }).then((s) => s?.server?.code ?? null));
    await expect.poll(code, { message: "the engine is given up on" }).toBe("engine_crashed");
    const offer = "the setup page offers the in-browser engine beside Retry";
    await expect(setup.locator("#engine-crash-switch"), offer).toBeVisible({ timeout: 15_000 });
    await expect(setup.locator("#engine-crash-switch"), offer).toHaveText("Switch to the in-browser engine");
    await expect(setup.locator("#component-primary"), offer).toHaveText("Retry");
    const popup = await context.newPage();
    await popup.goto(extension.url("popup.html"));
    const says = "the popup says the local engine keeps stopping, with Retry and the in-browser engine";
    await expect(popup.locator("#status"), says).toHaveText("The local engine kept stopping unexpectedly");
    await expect(popup.locator("#action"), says).toHaveText("Retry");
    await expect(popup.locator("#switchEngine"), says).toBeVisible();
    const opened = context.waitForEvent("page", { predicate: (p) => p.url().endsWith("/onboarding.html"), timeout: 15_000 });
    await popup.locator("#switchEngine").click();
    const next = await opened;
    const switched = "the popup's switch makes the in-browser engine the one in use and opens its setup";
    await expect.poll(() => next.evaluate(() => chrome.runtime.sendMessage({ action: "getEngine" }).then((r) => r?.engine)), { message: switched }).toBe("inbrowser");
    await expect(next.locator("#engineTitle"), switched).toHaveText("In-browser engine");
  });
});
