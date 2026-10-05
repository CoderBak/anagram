// The paste page: the evidence floor, an idle engine woken only by a real score, cached
// verdicts with their producing model, the opt-in export, cancelling a pass in flight, and the
// text read paragraph by paragraph, as a page is.
//
//   npm run test:paste                # builds output/ first; this loads the SHIPPING build
import { test as base, expect } from "./fixtures.mjs";

/** The engine unloaded while idle, as it is after a quiet spell. */
const idle = (host) => {
  const component = host.state().component;
  host.setState({ component: { ...component, state: "idle", runtime: { ...component.runtime, state: "idle", active_id: null } } });
};

// Idle from the start: the launch must not find a ready engine and wake it.
const test = base.extend({
  nativeHost: async ({ nativeHost }, use) => {
    idle(nativeHost);
    await use(nativeHost);
  },
});
// Shipping package, no website grants.
test.use({ build: "shipping" });

// Exactly 75 words; with the minimum length at 75, the same text one word shorter is refused.
const TEXT =
  "The local library opens every morning and welcomes readers from across the town. Its staff help visitors find books, learn new skills, and share ideas with neighbors. Last week I borrowed a history book and spent the afternoon reading beside a sunny window. I plan to return tomorrow because the quiet room makes it easier to concentrate on difficult passages. On Saturdays the reading room fills with families, and a volunteer reads old stories aloud.";

/** Analyze `text` and wait for its results. */
async function analyze(page, text) {
  await page.locator("#text").fill(text);
  await page.locator("#analyze").click();
  await page.locator("#results").waitFor({ state: "visible" });
}

test("the minimum length (50 words) refuses 49 words without waking the idle engine, and the first score wakes it", async ({ page, extension, nativeHost }) => {
  await page.goto(extension.url("paste.html"));
  await page.locator("#text").fill(TEXT.split(" ").slice(0, 49).join(" "));
  await page.locator("#analyze").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("50"));
  expect(nativeHost.requests().filter((r) => r.op === "score")).toHaveLength(0);
  expect(nativeHost.state().component.state, "Health checks must not wake the idle model").toBe("idle");

  await analyze(page, TEXT);
  expect(nativeHost.requests().some((r) => r.op === "score")).toBe(true);
  expect(nativeHost.state().component.state, "The first score wakes an idle model with no cached identity").toBe("ready");
  expect(await page.locator("#coverage").innerText()).toMatch(/1 of 1 paragraphs read/);
  await expect(page.locator("#reading .read")).toHaveCount(1);
  await expect(page.locator("#reading .chip")).toHaveCount(1);
  expect(await page.evaluate(() => chrome.permissions.getAll()).then((p) => p.origins ?? []), "no host grants").toEqual([]);
});

test("the copied report carries the model and the caveat, and the text only when asked", async ({ page, extension, clipboard }) => {
  await page.goto(extension.url("paste.html"));
  await analyze(page, TEXT);
  const copied = await clipboard.record(page);
  await page.locator("#copy").click();
  const sanitized = await copied();
  expect(sanitized).toContain("fake-editlens");
  expect(sanitized, "The copied result carries its caveat").toContain("not proof of authorship. Do not use them for disciplinary or other high-stakes decisions.");
  expect(sanitized).not.toContain(TEXT);
  await page.locator("#includeText").check();
  await page.locator("#copy").click();
  expect(await copied()).toContain(TEXT);
});

test("while the engine is idle, a cached verdict is shown without waking it, with its real model", async ({ page, extension, nativeHost, clipboard }) => {
  await page.goto(extension.url("paste.html"));
  await analyze(page, TEXT);
  idle(nativeHost);
  const status = await page.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true, session: globalThis.__anagramDocumentSession }));
  expect(status.active).toBe("idle");
  expect(status.server.ok).toBe(false);
  expect(status.model.id).toBe("fake-editlens");
  const beforeCached = nativeHost.stats.requests;
  await page.locator("#analyze").click();
  await page.locator("#results").waitFor({ state: "visible" });
  expect(nativeHost.stats.requests, "Known cached verdicts remain available while idle without waking inference").toBe(beforeCached);
  const copied = await clipboard.record(page);
  await page.locator("#copy").click();
  expect(await copied(), "Cached results retain their real producing model").toContain("fake-editlens");
  expect(nativeHost.state().component.state).toBe("idle");
});

test("a pass cleared in flight unlocks at once, and its text is never shown or sent again", async ({ page, extension, nativeHost }) => {
  await page.goto(extension.url("paste.html"));
  nativeHost.setState({ rules: [{ contains: "Pending cancellation", delayMs: 2500 }] });
  await page.locator("#text").fill(`Pending cancellation. ${TEXT}`);
  await page.locator("#analyze").click();
  await expect
    .poll(() => nativeHost.textsSince().some((value) => value.includes("Pending cancellation")), { message: "The slow request entered inference before cancellation", timeout: 10_000, intervals: [25] })
    .toBe(true);
  await page.locator("#clear").click();
  expect(await page.locator("#analyze").isEnabled(), "Clear immediately unlocks analysis").toBe(true);
  await analyze(page, `${TEXT} This is a fresh request after cancellation.`);
  // The cleared request's own answer is due 2.5 s after it went in: past that, it has had
  // every chance to land in the results, and to be sent again.
  await page.waitForTimeout(2700);
  expect(await page.locator("#reading").innerText()).not.toContain("Pending cancellation");
  expect(nativeHost.textsSince().filter((value) => value.includes("Pending cancellation")), "Cancelled text is never resent").toHaveLength(1);
  await page.locator("#clear").click();
  expect(await page.locator("#text").inputValue()).toBe("");
  expect(await page.locator("#results").isHidden()).toBe(true);
});

// Paragraphs, as blank lines part them: each one long enough read alone, with its chip after it;
// two short ones read together (×2); one too short to read with anything left in muted ink; the
// whole text's verdict from the paragraphs, and how much of it, in words, reads as each word.
test("the text is read paragraph by paragraph, as a page is: a chip after each, short ones together, the flagged ones underlined", async ({ page, extension }) => {
  await page.goto(extension.url("paste.html"));
  const second = TEXT.replace("The local library", "The town museum");
  const shortA = "A short note about the museum café, which serves good coffee to visitors on weekday mornings before the galleries open.";
  const shortB = "Another short note: the gift shop sells postcards of the old harbour, and the staff are always happy to recommend a book.";
  await analyze(page, [TEXT, second, `${shortA}\n${shortB}`, "Thanks."].join("\n\n"));
  await expect(page.locator("#reading p")).toHaveCount(4);
  // One chip each for the two long paragraphs, one for the pair of short ones, read as one
  // (their single line break is a line wrapped inside a paragraph); "Thanks." is read with it.
  const chips = await page.locator("#reading .chip").count();
  expect(chips, "a chip after each paragraph read").toBeGreaterThanOrEqual(2);
  expect(await page.locator("#coverage").innerText()).toMatch(/paragraphs read/);
  // Every chip says its word and its four shares to a screen reader.
  for (const label of await page.locator("#reading .chip").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))) {
    expect(label).toMatch(/^(Human|Lightly edited|Heavily edited|AI-generated), (0\.\d\d|1\.0|\.\d\d), Human \d+%/);
  }
  // The bar's shares add up to the whole text read.
  const shares = await page.locator("#legend .n").allInnerTexts();
  expect(shares.reduce((n, s) => n + Number(s.replace("%", "")), 0)).toBeGreaterThanOrEqual(99);
  // Underlined: the flagged ones only (Heavily edited and up, the default).
  const marks = await page.locator("#reading .read").evaluateAll((els) => els.map((el) => ({ marked: el.classList.contains("marked"), level: [...el.classList].find((c) => /^b\d$/.test(c)) ?? null })));
  for (const m of marks) if (m.level) expect(m.marked, JSON.stringify(m)).toBe(m.level === "b2" || m.level === "b3");
});
