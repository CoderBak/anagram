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

// A draft above the minimum, also used to exercise the 49 / 50-word boundary.
const TEXT =
  "The local library opens every morning and welcomes readers from across the town. Its staff help visitors find books, learn new skills, and share ideas with neighbors. Last week I borrowed a history book and spent the afternoon reading beside a sunny window. I plan to return tomorrow because the quiet room makes it easier to concentrate on difficult passages. On Saturdays the reading room fills with families, and a volunteer reads old stories aloud.";

/** Analyze `text` and wait for its results. */
async function analyze(page, text) {
  if (await page.locator("#edit").isVisible()) await page.locator("#edit").click();
  await page.locator("#text").fill(text);
  await page.locator("#analyze").click();
  await page.locator("#results").waitFor({ state: "visible" });
}

test("opening a text file preserves the report until a replacement can be read", async ({ page, extension }) => {
  await page.goto(extension.url("paste.html"));
  await analyze(page, TEXT);
  const file = page.locator("#file");
  const verdict = await page.locator("#summary").innerText();
  for (const buffer of [Buffer.from([0xff]), Buffer.alloc(1024 ** 2 + 1)]) {
    await file.setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer });
    await expect(page.locator("#status")).not.toBeEmpty();
    await expect(page.locator("#results")).toBeVisible();
    await expect(page.locator("#summary")).toHaveText(verdict);
    await expect(page.locator("#text")).toHaveValue(TEXT);
    await expect(file).toHaveValue("");
  }
  // Going back to edit the draft while a file is decoding wins over the late read.
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      File.prototype.arrayBuffer = read;
      const bytes = await read.call(this);
      await new Promise(resolve => { window.finishFileRead = resolve; });
      return bytes;
    };
  });
  await file.setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Late file.") });
  await page.waitForFunction(() => typeof window.finishFileRead === "function");
  await page.locator("#edit").click();
  await page.evaluate(() => window.finishFileRead());
  await expect(page.locator("#text")).toHaveValue(TEXT);
  await expect(page.locator("#analyze")).toBeEnabled();
  await page.locator("#pick").focus();
  await file.setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("A new draft.") });
  await expect(page.locator("#text")).toHaveValue("A new draft.");
  await expect(page.locator("#text")).toBeFocused();
  await expect(page.locator("#results")).toBeHidden();
  await expect(page.locator("#analyze")).toBeDisabled();
});

test("the result toolbar keeps its file action named and its controls on one row in narrow windows", async ({ page, extension }) => {
  await page.goto(extension.url("paste.html"));
  await analyze(page, TEXT);
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("button", { name: "Open file…" })).toBeVisible();
    const boxes = await Promise.all(["#edit", "#pick", "#words", "#clear"].map((id) => page.locator(id).boundingBox()));
    expect(Math.max(...boxes.map((box) => box.y)), `${width}px toolbar`)
      .toBeLessThan(Math.min(...boxes.map((box) => box.y + box.height)));
  }
});

test("the minimum length (50 words) refuses 49 words without waking the idle engine, and the first score wakes it", async ({ page, extension, nativeHost }) => {
  await page.goto(extension.url("paste.html"));
  await expect(page.locator("#words")).toHaveText("At least 50 words");
  await expect(page.locator("#analyze")).toBeDisabled();
  await page.locator("#text").fill(TEXT.split(" ").slice(0, 49).join(" "));
  await expect(page.locator("#words")).toHaveText("49 / 50 words");
  await expect(page.locator("#analyze")).toBeDisabled();
  await page.locator("#text").fill(TEXT.split(" ").slice(0, 50).join(" "));
  await expect(page.locator("#analyze")).toBeEnabled();
  expect(nativeHost.requests().filter((r) => r.op === "score")).toHaveLength(0);
  expect(nativeHost.state().component.state, "Health checks must not wake the idle model").toBe("idle");

  await analyze(page, TEXT);
  expect(nativeHost.requests().some((r) => r.op === "score")).toBe(true);
  expect(nativeHost.state().component.state, "The first score wakes an idle model with no cached identity").toBe("ready");
  await expect(page.locator("#legend")).toBeHidden();
  await page.getByText("Score breakdown", { exact: true }).click();
  await expect(page.locator("#legend")).toBeVisible();
  const shares = await page.locator("#legend .n").allTextContents();
  const readout = await page.locator("#score").getAttribute("aria-label");
  expect(shares).toEqual(readout.match(/\d+%/g));
  await expect(page.locator("#estimate")).toContainText("Class probabilities");
  await expect(page.locator("#coverage")).toHaveText("One paragraph read");
  await expect(page.locator("#coverage")).toBeHidden();
  await expect(page.locator("#reading .read")).toHaveCount(1);
  await expect(page.locator("#reading .chip")).toHaveCount(0);
  await expect(page.locator("#score")).toHaveAccessibleName(/%/);
  expect(await page.evaluate(() => chrome.permissions.getAll()).then((p) => p.origins ?? []), "no host grants").toEqual([]);
});

test("the copied report carries the model and the caveat, and the text only when asked", async ({ page, extension, clipboard }) => {
  await page.goto(extension.url("paste.html"));
  await analyze(page, TEXT);
  const copied = await clipboard.record(page);
  await page.getByRole("button", { name: "Copy report" }).press("Enter");
  await expect(page.locator("#copyStatus")).toHaveText(/^Copied/);
  const sanitized = await copied();
  expect(sanitized).toContain("fake-editlens");
  expect(sanitized, "The copied result carries its caveat").toContain("Exclude these scores from disciplinary and other high-stakes decisions.");
  expect(sanitized).not.toContain(TEXT);
  await page.locator("#includeText").check();
  await page.locator("#copy").click();
  expect(await copied()).toContain(TEXT);
  const next = TEXT.replace("local library", "private workshop");
  await analyze(page, next);
  await expect(page.locator("#includeText")).not.toBeChecked();
  await page.click("#copy");
  expect(await copied()).not.toContain("private workshop");
});

test("drafts stay out of the persistent score cache and are cleared when leaving the editor", async ({ page, extension }) => {
  await page.goto(extension.url("options.html"));
  await expect(page.locator("#cacheMode")).toHaveValue("session");
  await page.selectOption("#cacheMode", "persistent");
  await expect(page.locator("#cacheMode")).toBeEnabled();
  await page.goto(extension.url("paste.html"));
  await analyze(page, TEXT);
  // Give a scheduled disk write time to finish before querying the persistent count.
  await page.waitForTimeout(500);
  await page.goto(extension.url("options.html"));
  const entries = await page.evaluate(async () => (await chrome.runtime.sendMessage({ action: "getCacheCount" })).entries);
  expect(entries).toBe(0);
  await page.goBack();
  await expect(page.locator("#text")).toHaveValue("");
  await expect(page.locator("#reading")).toBeEmpty();
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
  await expect(page.locator("#text")).toBeHidden();
  await page.getByRole("button", { name: "Edit text" }).press("Enter");
  await expect(page.locator("#text")).toBeFocused();
  await expect(page.locator("#text")).toHaveValue(TEXT);
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
  await expect(page.locator("#analyze")).toBeDisabled();
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
  await page.getByText("Score breakdown", { exact: true }).click();
  const shares = await page.locator("#legend .n").allInnerTexts();
  expect(shares.reduce((n, s) => n + Number(s.replace("%", "")), 0)).toBeGreaterThanOrEqual(99);
  // Underlined: the flagged ones only (Heavily edited and up, the default).
  const marks = await page.locator("#reading .read").evaluateAll((els) => els.map((el) => ({ marked: !!el.querySelector(".marked"), level: [...el.classList].find((c) => /^b\d$/.test(c)) ?? null })));
  for (const m of marks) if (m.level) expect(m.marked, JSON.stringify(m)).toBe(m.level === "b2" || m.level === "b3");
});

test("two separately scored short paragraphs carry the training-length warning in the page and copy", async ({ page, extension, clipboard }) => {
  await page.goto(extension.url("paste.html"));
  const paragraph = TEXT.split(/\s+/).slice(0, 60).join(" ");
  await page.fill("#text", paragraph + "\n\n" + paragraph);
  await page.click("#analyze");
  await expect(page.locator("#reading .chip")).toHaveCount(2);
  await expect(page.locator("#reading .note")).toHaveCount(2);
  await expect(page.locator("#coverage")).toContainText("75");
  const copied = await clipboard.record(page);
  await page.click("#copy");
  expect(await copied()).toContain("75");
});

test("mixed sentences keep their own underline across grouped paragraphs", async ({ page, extension, storage }) => {
  const sentences = [
    "The shelves in the old library were still covered with the handwritten labels that my aunt remembered from her first visit.",
    "We spent the afternoon comparing those labels with the map and making a fresh list of the books we had found.",
    "The resulting inventory provides a detailed account of the collection and establishes a framework for future research in the town.",
  ];
  const paragraphs = [sentences.slice(0, 2).join(" "), sentences[2]];
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.action !== "scoreBatch") return send(message, ...args);
      return Promise.resolve({
        backend: "up", model: {id: "test-detector", ver: "1", calibration: "test"},
        results: message.req.blocks.map(({id}) => ({id, bucket: 0, score: .45, probs: [.4, .3, .3], sentenceLabels: [0, 1, 2]})),
      });
    };
  });
  await page.goto(extension.url("paste.html"));
  await analyze(page, paragraphs.join("\n\n"));
  for (const [options, labels] of [
    [{showHighlights: true, underlineScope: "flagged", flagFrom: "heavy"}, ["AI-generated"]],
    [{underlineScope: "all"}, ["Human", "AI-assisted", "AI-generated"]],
    [{showHighlights: false}, []],
  ]) {
    await storage.set(options);
    const marks = page.locator("#reading .marked");
    await expect(marks).toHaveCount(labels.length);
    expect(await marks.evaluateAll(nodes => nodes.map(mark => mark.title))).toEqual(labels);
    if (labels.length === 3) {
      expect((await marks.allTextContents()).map(text => text.trim())).toEqual(sentences);
      expect(await marks.evaluateAll(nodes => nodes.map(mark => mark.className))).toEqual(["marked b0", "marked b1", "marked b3"]);
    }
    expect(await page.locator("#reading p").evaluateAll(nodes => nodes.map(p => {
      const text = p.cloneNode(true);
      text.querySelectorAll(".chip, .note").forEach(note => note.remove());
      return text.textContent.trim();
    }))).toEqual(paragraphs);
  }
});
