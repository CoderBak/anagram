// The controls around the page: the setup page following the engine's lifecycle, clearing
// cached verdicts, "Analyze this page" from the menu, the popup's button and the toggle
// shortcut on a page Anagram is off for, and the popup's one action per state.
//
//   npx playwright test scenarios-controls
import { test, expect, BADGE_SEL, ABSENCE_MS, PARA, PAGE, chipCounts, chipsSettle } from "./kit.mjs";

/** Three paragraphs nothing else has scored, on a page of their own. */
const CONTROLS_PAGE = (tag) => PAGE(`${tag} fixture`, `<p id="p1">${PARA(`${tag}-ONE`)}</p>
<p id="p2">${PARA(`${tag}-TWO`)}</p>
<p id="p3">${PARA(`${tag}-THREE`)}</p>`);
const chips = async (page) => (await chipCounts(page)).chips;
/** The content script is up on `page` and says whether it runs there. */
const runsHere = (page, tell, enabled) =>
  expect.poll(async () => (await tell(page, { action: "getTabState" }))?.enabled, { message: `the page's content script says it is ${enabled ? "on" : "off"}` }).toBe(enabled);
/** What the settings say: on or off, and the sites with a rule of their own. */
const stored = async (storage) => {
  const s = await storage.get(["enabled", "siteOverrides"]);
  return { enabled: s.enabled, rules: Object.keys(s.siteOverrides ?? {}) };
};

// ---- the setup page's status card follows the engine (native-browser.mjs covers install
// copying and the destructive actions) --------------------------------------------------------
const readCard = (page) =>
  page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent ?? null;
    return {
      // Settings puts the engine's name in front of the stage ("Local engine, Ready").
      status: txt("#componentSettings .component-status")?.replace(/^Local engine, /, "") ?? null,
      access: txt("#accessState"),
      install: document.getElementById("install")?.hidden === false ? txt("#install-cmd") : null,
      primary: document.getElementById("component-primary")?.hidden === false ? txt("#component-primary") : null,
      update: [...document.querySelectorAll("button")].some((b) => !b.hidden && b.textContent === "Update engine"),
      error: document.querySelector(".component-error")?.textContent ?? null,
    };
  });
const cardReady = (page, message) =>
  expect.poll(async () => (await readCard(page)).status, { message }).toBe("Ready");

test("the setup page says Ready, offers the scoped installer when the engine is gone, and follows it back without a reload", async ({ page, extension, nativeHost }) => {
  await page.goto(extension.url("onboarding.html"), { waitUntil: "load" });
  const up = "the setup page says Ready, the site grant and no install command";
  await cardReady(page, up);
  const ready = await readCard(page);
  // The test build already grants every site.
  expect.soft({ access: ready.access, install: ready.install, primary: ready.primary, error: !!ready.error }, up)
    .toEqual({ access: "All sites allowed", install: null, primary: null, error: false });

  await nativeHost.close();
  await page.reload({ waitUntil: "load" });
  const down = "the setup page offers a scoped installer and does not claim Ready when disconnected";
  await expect.poll(async () => (await readCard(page)).status, { message: down }).toBe("Not installed");
  const gone = await readCard(page);
  expect.soft({ primary: gone.primary }, down).toEqual({ primary: null });
  expect.soft(gone.install, down).toContain(extension.extId);
  expect.soft(gone.install, down).toContain("/releases/download/v");

  await nativeHost.resume();
  const back = "the setup page follows engine recovery without a reload";
  await cardReady(page, back);
  const recovered = await readCard(page);
  expect.soft({ install: recovered.install }, back).toEqual({ install: null });
});

test("an engine error leaves setup incomplete, shows Retry and, in Settings, the Update engine action", async ({ page, extension, nativeHost }) => {
  await page.goto(extension.url("options.html"), { waitUntil: "load" });
  await cardReady(page, "Settings starts Ready");
  const healthy = nativeHost.state().component;
  nativeHost.setState({ component: { ...healthy, state: "error", error: { code: "incompatible", message: "Fixture component requires update" } } });
  const broken = "an engine error leaves setup incomplete, shows Retry and the Update engine action";
  // A ready page polls every 15 s, so the change is seen on the next tick.
  await expect.poll(async () => (await readCard(page)).status, { message: broken, timeout: 40_000 }).toBe("Needs attention");
  const card = await readCard(page);
  expect.soft({ update: card.update, primary: card.primary, install: card.install }, broken).toEqual({ update: true, primary: "Retry", install: null });
  expect.soft(card.error, broken).toBeTruthy();
  nativeHost.setState({ component: healthy });
  await expect.poll(async () => (await readCard(page)).status, { message: `${broken} (and Ready again once mended)`, timeout: 40_000 }).toBe("Ready");
});

// A rescan of an unchanged page is answered from the worker's cache and the host never hears
// about it; once "Clear" (Settings, Cache) has run, the same rescan has to
// reach the host again.
test("cached verdicts: a rescan is answered from the worker cache, the options page counts them, and once cleared the rescan asks the fixture again", async ({ context, page, pages, extension, nativeHost, tell }) => {
  pages.serve({ "/cached.html": CONTROLS_PAGE("CACHED") });
  const asked = () => ({ requests: nativeHost.stats.requests, blocks: nativeHost.stats.blocks });
  // Exactly what the popup's Rescan does: the chips go at once (the handler drops them
  // before it returns) and come back with their verdicts; a host asked is asked before that.
  const rescan = async () => {
    await tell(page, { action: "rescan" });
    await chipsSettle(page, 3);
  };
  await page.goto(pages.url("/cached.html"), { waitUntil: "load" });
  await chipsSettle(page, 3);
  const before = asked();
  await rescan();
  const cached = "cached verdicts: a rescan is answered from the worker cache, and asks the fixture again once cleared";
  expect.soft(asked(), `${cached} (from the cache)`).toEqual(before);

  const opt = await context.newPage();
  await opt.goto(extension.url("options.html"), { waitUntil: "load" });
  const counted = "cached verdicts: the options page says how many are stored, and says zero once they are cleared";
  // The worker writes its verdicts to the disk a moment after it has them, and the page
  // counts the disk once, when it opens: it is opened again once the three are there.
  await expect
    .poll(() => opt.evaluate(async () => (await chrome.runtime.sendMessage({ action: "getCacheCount" }))?.entries), { message: `${counted} (on the disk)` })
    .toBeGreaterThanOrEqual(3);
  await opt.reload({ waitUntil: "load" });
  await expect(opt.locator("#cacheCount"), counted).toHaveText(/^[\d,]+ entr(y|ies)$/);
  await expect(opt.locator("#cacheCount"), counted).not.toHaveText("0 entries");
  await opt.click("#clearCache");
  await expect(opt.locator("#cacheStatus"), cached).toContainText("Cleared");
  await expect(opt.locator("#cacheCount"), counted).toHaveText("0 entries");
  await opt.close();

  await rescan();
  const after = asked();
  expect.soft(after.requests, `${cached} (asked again)`).toBeGreaterThan(before.requests);
  expect.soft(after.blocks, `${cached} (all three)`).toBeGreaterThanOrEqual(before.blocks + 3);
});

// With Anagram off everywhere the page stays bare; the menu's action analyzes it once, and
// because nothing is written, a reload is bare again and the settings are exactly as they were.
test("analyze this page: one run on a switched-off site, gone after a reload, nothing written", async ({ page, pages, storage, tell }) => {
  pages.serve({ "/oneshot.html": CONTROLS_PAGE("ONESHOT") });
  await storage.set({ enabled: false });
  await page.goto(pages.url("/oneshot.html"), { waitUntil: "load" });
  const once = "analyze this page: one run on a switched-off site, gone after a reload, nothing written";
  await runsHere(page, tell, false);
  expect(await chips(page), `${once} (off at first)`).toBe(0);
  await tell(page, { action: "analyzePage" }); // what contextMenus.onClicked sends for the page entry
  await chipsSettle(page, 3);
  await page.reload({ waitUntil: "load" });
  await runsHere(page, tell, false);
  expect(await chips(page), `${once} (bare after a reload)`).toBe(0);
  expect(await stored(storage), `${once} (nothing written)`).toEqual({ enabled: false, rules: [] });
});

// The popup cannot reach a page that holds no content script (a site nothing was granted
// for), so it asks the worker, which injects with `activeTab` and then says what the menu
// entry says. Sent here from an extension page of ours, exactly as the popup sends it.
test("analyze this page from the popup's button: the worker starts one run in the named tab, nothing written", async ({ context, page, pages, extension, storage, tell }) => {
  pages.serve({ "/oneshot-popup.html": CONTROLS_PAGE("ONESHOTPOPUP") });
  await storage.set({ enabled: false });
  await page.goto(pages.url("/oneshot-popup.html"), { waitUntil: "load" });
  const popup = "analyze this page from the popup's button: the worker starts one run in the named tab, nothing written";
  await runsHere(page, tell, false);
  expect(await chips(page), `${popup} (off at first)`).toBe(0);
  const tabId = await extension.worker().evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id ?? null, page.url());
  expect(tabId, popup).not.toBeNull();
  const ours = await context.newPage();
  await ours.goto(extension.url("popup.html"), { waitUntil: "load" });
  await ours.evaluate((id) => chrome.runtime.sendMessage({ action: "analyzeTab", tabId: id }), tabId);
  await ours.close();
  await page.bringToFront();
  await chipsSettle(page, 3);
  expect(await stored(storage), `${popup} (nothing written)`).toEqual({ enabled: false, rules: [] });
});

// There is no overlay to show or hide on a page Anagram is off for, and the key used to do
// nothing whatsoever there, which on a fresh install, where no site is granted, is every page.
test("the toggle shortcut analyzes a switched-off page once instead of doing nothing, and writes nothing", async ({ page, pages, storage, tell }) => {
  pages.serve({ "/oneshot-key.html": CONTROLS_PAGE("ONESHOTKEY") });
  await storage.set({ enabled: false });
  await page.goto(pages.url("/oneshot-key.html"), { waitUntil: "load" });
  const key = "the toggle shortcut analyzes a switched-off page once instead of doing nothing, and writes nothing";
  await runsHere(page, tell, false);
  expect(await chips(page), `${key} (off at first)`).toBe(0);
  await tell(page, { action: "toggleOverlay" }); // what commands.onCommand sends for "toggle-overlay"
  await chipsSettle(page, 3);
  expect(await stored(storage), `${key} (nothing written)`).toEqual({ enabled: false, rules: [] });
});

// The same run on a site whose rule ALREADY says "off", the likeliest page to ask for one. An
// unrelated rule written while it runs must leave it alone.
test("analyze this page: an already-off site keeps its run through an unrelated rule", async ({ page, pages, storage, tell }) => {
  pages.serve({ "/turnoff.html": CONTROLS_PAGE("TURNOFF") });
  await storage.set({ enabled: true, siteOverrides: { localhost: "off" } });
  await page.goto(pages.url("/turnoff.html"), { waitUntil: "load" });
  const off = "analyze this page: an already-off site keeps its run through an unrelated rule";
  await runsHere(page, tell, false);
  expect(await chips(page), `${off} (off at first)`).toBe(0);
  await tell(page, { action: "analyzePage" });
  await chipsSettle(page, 3);
  // Someone else's rule: the watch fires, this site is still off by the same rule it was off
  // by when the run started, and the run must not notice.
  await storage.set({ siteOverrides: { localhost: "off", "example.org": "off" } });
  await page.waitForTimeout(ABSENCE_MS);
  expect(await chips(page), `${off} (kept through an unrelated rule)`).toBe(3);
  expect((await storage.get("siteOverrides")).siteOverrides?.localhost, off).toBe("off");
});

// ---- the popup leads with ONE action, the right one for the tab under it ------------------
// The popup reads the ACTIVE tab, so each state is produced the way the popup meets it: the
// page is brought to the front and the popup, a background tab of the same window, is
// reloaded, which is when it asks which tab is active. Opened as its own active tab it sees
// ITSELF, which is the "nothing can run here" state.
const popupSays = (popup) =>
  popup.evaluate(() => ({
    status: document.getElementById("status")?.textContent ?? "",
    button: document.getElementById("action")?.textContent ?? "",
    // The one filled button, or an outline one where the action is merely available.
    primary: document.getElementById("action")?.dataset.variant !== "outline",
    engine: document.getElementById("backend")?.hidden === false ? document.getElementById("backend")?.textContent : null,
    fabricatedCommand: /~\/.anagram\/bin\/anagram|curl -fsSL/.test(document.body.innerText),
    // Never two main events at once: at most one filled button on the whole page.
    filled: document.querySelectorAll("main .btn:not([data-variant])").length,
  }));
async function popupOver(context, extension, page) {
  const popup = await context.newPage();
  await popup.goto(extension.url("popup.html"), { waitUntil: "load" });
  if (page) {
    await page.bringToFront();
    await popup.reload({ waitUntil: "load" });
  }
  return popup;
}
const ONE_ACTION = "the popup offers one action per state, names the engine's state, and an unavailable engine opens Settings without a terminal command";

test("the popup on a page being read offers Rescan and names the engine", async ({ context, page, pages, extension }) => {
  pages.serve({ "/popup-state.html": CONTROLS_PAGE("POPUPSTATE") });
  await page.goto(pages.url("/popup-state.html"), { waitUntil: "load" });
  await chipsSettle(page, 3);
  const popup = await popupOver(context, extension, page);
  await expect.poll(() => popupSays(popup), { message: `${ONE_ACTION} (running)` }).toMatchObject({ button: "Rescan", primary: false, engine: "Local engine: Ready" });
  const seen = await popupSays(popup);
  expect.soft(seen.status, `${ONE_ACTION} (running)`).toMatch(/paragraphs analyzed/);
  expect.soft(seen.filled, `${ONE_ACTION} (running)`).toBeLessThanOrEqual(1);
});

test("the popup on a page Anagram is off for offers to analyze it", async ({ context, page, pages, extension, storage, tell }) => {
  pages.serve({ "/popup-state.html": CONTROLS_PAGE("POPUPSTATE") });
  await storage.set({ enabled: false });
  await page.goto(pages.url("/popup-state.html"), { waitUntil: "load" });
  await runsHere(page, tell, false);
  const popup = await popupOver(context, extension, page);
  await expect.poll(() => popupSays(popup), { message: `${ONE_ACTION} (off)` }).toMatchObject({ button: "Analyze this page", primary: true, status: "Anagram is off for this page." });
  expect.soft((await popupSays(popup)).filled, `${ONE_ACTION} (off)`).toBeLessThanOrEqual(1);
});

test("the popup on a PDF tab offers the reader", async ({ context, page, pages, extension }) => {
  // The popup decides a PDF tab from its URL; what the tab holds is the reading mode's
  // problem, and a real PDF tab cannot be driven here.
  pages.serve({ "/popup-state.pdf": CONTROLS_PAGE("POPUPPDF") });
  await page.goto(pages.url("/popup-state.pdf"), { waitUntil: "load" });
  const popup = await popupOver(context, extension, page);
  await expect.poll(() => popupSays(popup), { message: `${ONE_ACTION} (pdf)` }).toMatchObject({ button: "Read this PDF", primary: true, status: "" });
  expect.soft((await popupSays(popup)).filled, `${ONE_ACTION} (pdf)`).toBeLessThanOrEqual(1);
});

test("the popup where nothing can run offers a PDF file from this computer", async ({ context, extension }) => {
  const popup = await popupOver(context, extension, null);
  await expect.poll(() => popupSays(popup), { message: `${ONE_ACTION} (nothing)` }).toMatchObject({ button: "Read a PDF file…", primary: false, status: "Not available on this page." });
  expect.soft((await popupSays(popup)).filled, `${ONE_ACTION} (nothing)`).toBeLessThanOrEqual(1);
});

test("the popup with the engine gone opens Settings, and offers no terminal command", async ({ context, page, pages, extension, nativeHost }) => {
  pages.serve({ "/popup-state.html": CONTROLS_PAGE("POPUPSTATE") });
  await nativeHost.close(); // the native pipe breaks
  await page.goto(pages.url("/popup-state.html"), { waitUntil: "load" });
  const popup = await popupOver(context, extension, null);
  // An idle native disconnect invalidates the old Ready result even when every paragraph is
  // cached: the ordinary status path says so, without a probe.
  await expect
    .poll(() => popup.evaluate(async () => (await chrome.runtime.sendMessage({ action: "getBackendStatus", probe: false }))?.active), { message: `${ONE_ACTION} (down: the worker knows)` })
    .toBe("down");
  await page.bringToFront();
  await popup.reload({ waitUntil: "load" });
  const down = `${ONE_ACTION} (down)`;
  await expect.poll(() => popupSays(popup), { message: down }).toMatchObject({ button: "Open Settings", primary: true, status: "Local engine is not ready", engine: null, fabricatedCommand: false });
  expect.soft((await popupSays(popup)).filled, down).toBeLessThanOrEqual(1);
  // Settings runs in its own extension page, so native setup has a trusted top-level sender.
  await popup.click("#action");
  const settingsUrl = extension.url("options.html");
  await expect.poll(() => context.pages().some((p) => p.url() === settingsUrl), { message: `${down}: Settings opens` }).toBe(true);
  await expect(context.pages().find((p) => p.url() === settingsUrl).locator("#engineLabel"), `${down}: Settings opens`).toBeVisible();
});
