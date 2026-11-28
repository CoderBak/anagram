// The setup page and Settings as one compact list each, and the popup's two small entries.
//
//   npx playwright test setup-page
//
// What is judged here is the shape the user asked for, not the engine (test/inbrowser.mjs
// drives that): permissions come first on the setup page; no card quotes a speed or a memory
// figure; "Keep this browser open" shows only while the in-browser download runs, on the setup
// page, in Settings and in the popup; the setup page opens one step at a time; Settings is panels
// in order beside its section index with nothing folded; the popup carries the PDF reader and Analyze text. The engine's states are scripted into each
// page (test/webengine/scripted-engine.mjs) on the device builds (test/pw/devices.mjs).
import { join } from "node:path";
import { readFileSync } from "node:fs";
import release from "../../anagramd/detector-release.json" with {type: "json"};
import { test, expect } from "./fixtures.mjs";
import { scriptEngine } from "../webengine/scripted-engine.mjs";
import { DOWNLOAD_BYTES, NO_MODEL_HOSTS } from "../webengine/model-server.mjs";

const progressAt45Percent = `${Math.round(DOWNLOAD_BYTES * 0.45 / 1e6)} MB of ${(DOWNLOAD_BYTES / 1e9).toFixed(1)} GB`;
const device = (name) => join(import.meta.dirname, "..", "..", "output-test", "devices", `${name}-chrome`);
const painted = (page) => page.waitForFunction(() => {
  const status = document.querySelector("#componentSettings .component-status")?.textContent;
  return (status && status !== "Starting…") || !!document.querySelector(".engine-choice-card:not([hidden])");
}, null, { timeout: 15000 });

async function openScripted(extension, path, state, options = {}, viewport = { width: 1000, height: 900 }) {
  const page = await extension.context.newPage();
  await page.setViewportSize(viewport);
  await scriptEngine(page, state, options);
  await page.goto(extension.url(path));
  return page;
}

test.describe("the setup page", () => {
  test("a pending extension update is visible above setup and settings with the in-browser engine", async ({ extension, storage }) => {
    const setup = await openScripted(extension, "onboarding.html", "ready_gpu");
    await expect(setup.locator("#engineCard")).toHaveClass(/done/);
    const notice = setup.locator("#extensionUpdate");
    await expect(notice).toBeHidden();
    await storage.set({ extensionUpdatePending: "9.0.0" });
    await expect(notice).toContainText("9.0.0");
    await expect(notice.getByRole("button", { name: "Apply extension update" })).toBeVisible();
    const settings = await openScripted(extension, "options.html", "ready_gpu");
    await expect(settings.locator("#extensionUpdate")).toContainText("9.0.0");
    await storage.set({ extensionUpdatePending: null });
    await expect(settings.locator("#extensionUpdate")).toBeHidden();
    await expect(notice).toBeHidden();
  });
  test.use({ build: device("apple-silicon"), launch: { args: [NO_MODEL_HOSTS] } });

  test("reading preferences stay visible during setup and follow edits in either tab", async ({ extension, storage }) => {
    await storage.set({ flagFrom: "heavy", displayMode: "flagged", showHighlights: false, underlineScope: "all" });
    const setup = await openScripted(extension, "onboarding.html", "needed");
    const settings = await openScripted(extension, "options.html", "needed");
    const flag = setup.getByLabel("Flag paragraphs", { exact: true });
    await expect(flag).toBeVisible();
    await expect(flag).toHaveValue("ai");
    await expect(setup.getByLabel("Score labels")).toHaveValue("flagged");
    await expect(setup.getByLabel("Underlines")).toHaveValue("off");
    await flag.selectOption("light");
    await expect(settings.getByLabel("Flag paragraphs", { exact: true })).toHaveValue("light");
    await settings.getByLabel("Score labels").selectOption("all");
    await expect(setup.getByLabel("Score labels")).toHaveValue("all");
    await setup.getByLabel("Underlines").selectOption("flagged");
    await expect(settings.getByLabel("Underlines")).toHaveValue("flagged");
    await settings.getByLabel("Underlines").selectOption("off");
    await setup.reload();
    await expect(setup.getByLabel("Underlines")).toHaveValue("off");
    await expect(flag).toHaveValue("light");
    await expect(setup.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/options.html");
  });

  test("the download action shares the status row and the reading controls reflow", async ({ extension }) => {
    const setup = await openScripted(extension, "onboarding.html", "needed");
    const button = setup.locator("#component-primary");
    await expect(button).toBeVisible();
    for (const width of [960, 640, 390, 320]) {
      await setup.setViewportSize({ width, height: 900 });
      const status = await setup.locator(".component-status").boundingBox();
      const download = await button.boundingBox();
      expect(download.y).toBeLessThan(status.y + status.height);
      expect(download.x).toBeGreaterThan(status.x + status.width);
      const selects = await setup.locator("#readingPreferences select").evaluateAll(elements =>
        elements.map(el => el.getBoundingClientRect().toJSON()));
      for (const rect of selects) {
        expect(rect.height).toBe(download.height);
        expect(rect.right).toBeLessThanOrEqual(width);
      }
      expect(await setup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });

  test("the detector link follows the selected revision before installation", async ({ extension }) => {
    const page = await openScripted(extension, "options.html", "ready");
    const current = page.locator("#detectorPicker .detector-name");
    const pin = await import("../../anagramd/detector-release.json", { with: { type: "json" } });
    const {release, revision, repository} = pin.default;
    const base = "https://huggingface.co/" + repository + "/tree/";
    await expect(current).toHaveAttribute("href", base + revision);
    const next = {release: "2026-12-01-400m", revision: "a".repeat(40)};
    await page.evaluate(({next, release, revision}) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, ...args) => message.action !== "detectorCatalog" ? send(message, ...args)
        : Promise.resolve(message.ref ? {ok: false} : {ok: true, value: [next, {release, revision}]});
    }, {next, release, revision});
    await page.locator("#detectorPicker .check-models").click();
    await expect(current).toHaveAttribute("href", base + next.revision);
    await page.selectOption("#detector-release", release + "@" + revision);
    await expect(current).toHaveAttribute("href", base + revision);
  });

  test("teaches toolbar pinning in two short steps, which the toolbar menu's link opens", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "needed", { engine: null });
    await expect(page.locator("#toolbarGuide li")).toHaveCount(2);
    await expect(page.locator("#toolbarGuide")).toContainText("pin beside Anagram");
    // The toolbar menu's "How to keep Anagram in the toolbar" opens this step; Settings has no
    // copy of it.
    await page.goto(extension.url("onboarding.html") + "#pinCard");
    await expect(page.locator("#toolbarGuide li").first()).toBeVisible();
    await expect(page.locator("#pinCard")).toBeInViewport();
    await page.goto(extension.url("options.html"));
    await expect(page.locator("#toolbarGuide")).toHaveCount(0);
  });

  test("numbers its steps — the engine, where it reads, the toolbar — and ticks each off once done", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "needed", { engine: null });
    await painted(page);
    const order = await page.evaluate(() => {
      const at = (id) => document.getElementById(id);
      return {
        // The order on the screen, not only in the markup.
        tops: ["engineCard", "whereCard", "pinCard", "verdictCard"].map((id) => Math.round(at(id).getBoundingClientRect().top)),
        numbers: [...document.querySelectorAll(".step .num")].map((n) => n.textContent.trim()),
        // Every permission control lives in the second step.
        inWhere: ["site-access", "autoOpenPdfs", "local-pdfs"].map((id) => at("whereCard").contains(at(id))),
        folds: document.querySelectorAll("details").length,
        done: [...document.querySelectorAll(".step")].map((s) => s.classList.contains("done")),
      };
    });
    expect(order.tops).toEqual([...order.tops].sort((a, b) => a - b));
    await expect(page.locator("#tryParagraph")).toBeHidden();
    await expect(page.locator("#whereTitle")).toContainText("optional");
    expect(order.numbers).toEqual(["1", "2", "3"]);
    expect(order.inWhere, "site access and both PDF rows are in the second step").toEqual([true, true, true]);
    expect(order.folds, "no collapsed fold anywhere").toBe(0);
    // The test build may read every site; no engine is set up and nothing is pinned.
    expect(order.done).toEqual([false, true, false]);
    // One step open at a time, the first not done; a header opens or closes its own, which stays so.
    const open = () => page.evaluate(() => [...document.querySelectorAll(".step")].map((s) => s.classList.contains("open")));
    expect(await open()).toEqual([true, false, false]);
    await expect(page.locator("#engineCard .step-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#local-pdfs")).toBeHidden();
    await page.click("#whereCard .step-toggle");
    await expect(page.locator("#local-pdfs")).toBeVisible();
    await expect(page.locator("#whereCard .step-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.click("#engineCard header h2");
    expect(await open()).toEqual([false, true, false]);
    await page.waitForTimeout(2500);
    expect(await open(), "the page's own checks change nothing chosen").toEqual([false, true, false]);
  });

  test("the installer can be read before granting Native Messaging or choosing an engine", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "needed", { engine: null });
    const granted = () => page.evaluate(() => chrome.permissions.contains({ permissions: ["nativeMessaging"] }));
    expect(await granted()).toBe(false);
    const link = page.getByRole("link", { name: "Read installer source" });
    await expect(link).toHaveAttribute("href", extension.url("installer-source/install.sh.html"));
    const [source] = await Promise.all([extension.context.waitForEvent("page"), link.click()]);
    for (const ext of ["sh", "ps1"]) {
      if (ext === "ps1") await source.goto(extension.url("installer-source/install.ps1.html"));
      const expected = readFileSync(join(import.meta.dirname, "..", "..", `install.${ext}`), "utf8").replaceAll("\r\n", "\n");
      expect(await source.locator("pre").textContent()).toBe(expected);
      await expect(source.locator("script")).toHaveCount(0);
    }
    await source.close();
    expect(await granted()).toBe(false);
    await expect(page.locator("#engine-pick-inbrowser")).toBeVisible();
  });

  test("the choice quotes no speed and no memory", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "needed", { engine: null });
    await painted(page);
    await page.locator("#engine-pick-inbrowser").waitFor();
    const text = await page.locator("#engineCard").innerText();
    expect(text, "no ms, no GB of memory, no comparison").not.toMatch(/\bms\b|memory|faster|slower|M4/i);
    expect(await page.locator(".engine-cost").count()).toBe(0);
    expect(await page.locator(".engine-choice .engine-note:visible").count(), "the M4 note is gone").toBe(0);
  });

  for (const [state, shown] of [["needed", false], ["downloading", true], ["retrying", true], ["paused", false], ["network", false], ["loading", false], ["ready_gpu", false]]) {
    test(`Keep this browser open is ${shown ? "shown" : "not shown"} while the download is ${state}`, async ({ extension }) => {
      const page = await openScripted(extension, "onboarding.html", state, state === "needed" ? {} : {});
      await painted(page);
      await expect(page.locator(".engine-keepopen")).toHaveCount(1);
      expect(await page.locator(".engine-keepopen").isVisible()).toBe(shown);
      if (shown) await expect(page.locator(".engine-keepopen")).toHaveText("You can close this page while the browser downloads the model.");
    });
  }

  test("verification names the work being done and omits transfer estimates", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "verifying");
    await expect(page.getByRole("progressbar")).toHaveAccessibleName("Verifying model files…");
    await expect(page.locator(".component-status")).toHaveText("Verifying model files…");
    await expect(page.locator("#engine-progress")).toHaveText(progressAt45Percent);
  });

  test("Resume counts a partial file toward the model's space requirement", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "paused_partial", { estimate: { quota: 1.8e9, usage: 9e8 } });
    await page.getByRole("button", { name: "Resume download" }).click();
    await expect.poll(() => page.evaluate(() => window.__engineOps.includes("models.download"))).toBe(true);
  });

  test("the download reads as a bar with its percentage, one line of figures and Pause and Cancel beside it", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "downloading");
    await painted(page);
    const bar = page.getByRole("progressbar");
    await expect(bar).toHaveAttribute("aria-valuenow", "45");
    const seen = await page.evaluate(() => {
      const bar = document.querySelector("#componentSettings .pbar");
      const row = bar.parentElement;
      const box = bar.getBoundingClientRect();
      const fill = bar.firstElementChild;
      return {
        height: Math.round(box.height),
        radius: getComputedStyle(bar).borderTopLeftRadius,
        striped: getComputedStyle(fill).animationName,
        percent: row.querySelector(".engine-percent")?.textContent,
        buttons: [...row.querySelectorAll("button")].map((b) => b.textContent),
        sameRow: [...row.querySelectorAll("button, .engine-percent")].every((el) => Math.abs(el.getBoundingClientRect().top - box.top) < 30),
        line: document.getElementById("engine-progress")?.textContent,
        source: !!document.querySelector("#engine-progress #engine-source"),
      };
    });
    expect(seen.height).toBeGreaterThanOrEqual(10);
    expect(seen.height).toBeLessThanOrEqual(12);
    expect(parseFloat(seen.radius)).toBeGreaterThanOrEqual(5);
    expect(seen.striped, "the stripe moves while it downloads").toBe("pbar-move");
    expect(seen.percent).toBe("45%");
    expect(seen.buttons).toEqual(["Pause download", "Cancel download"]);
    expect(seen.sameRow).toBe(true);
    expect(seen.line, "bytes of total, and nothing else without a speed yet").toContain(progressAt45Percent);
    expect(seen.source, "a place after the line for the source of the files").toBe(true);
  });

  test("the stripe stands still when paused and under reduced motion", async ({ extension }) => {
    const paused = await openScripted(extension, "onboarding.html", "paused");
    await painted(paused);
    expect(await paused.evaluate(() => getComputedStyle(document.querySelector("#componentSettings .pbar > i")).animationName)).toBe("none");
    const still = await extension.context.newPage();
    await still.emulateMedia({ reducedMotion: "reduce" });
    await scriptEngine(still, "downloading");
    await still.goto(extension.url("onboarding.html"));
    await painted(still);
    expect(await still.evaluate(() => getComputedStyle(document.querySelector("#componentSettings .pbar > i")).animationName)).toBe("none");
  });
});

test.describe("Settings", () => {
  for (const engine of ["inbrowser", "native"]) {
    test(`keeps the idle setting selected during a ${engine} status poll`, async ({ extension }) => {
      const page = await openScripted(extension, "options.html", "ready_gpu", { engine });
      await page.locator("#engine-manage").click();
      const idle = page.locator("#idleUnload");
      await expect(idle).toBeEnabled();
      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        let hold = true;
        chrome.runtime.sendMessage = (message, ...args) => {
          if (message.action === "anagram.nativeRequest") {
            if (message.op === "engine.settings") window.submittedIdle = message.payload.idle_unload_s;
            if (message.op === "status" && hold) {
              hold = false;
              return new Promise(resolve => { window.releaseStatus = () => resolve(send(message, ...args)); });
            }
          }
          return send(message, ...args);
        };
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(() => typeof window.releaseStatus === "function");
      await idle.selectOption("900");
      await page.evaluate(() => window.releaseStatus());
      await expect.poll(() => page.evaluate(() => window.submittedIdle)).toBe(900);
    });
  }

  test.use({ build: device("apple-silicon"), launch: { args: [NO_MODEL_HOSTS] } });

  test("lays settings in a focused column without redundant navigation, with the three reading choices on one line", async ({ extension }) => {
    const page = await openScripted(extension, "options.html", "ready_gpu");
    await painted(page);
    const seen = await page.evaluate(() => {
      const top = (el) => Math.round(el.getBoundingClientRect().top);
      const panels = [...document.querySelectorAll(".settings .panel")];
      return {
        titles: panels.map((p) => p.querySelector("h2").textContent),
        tops: panels.map(top),
        folds: [...document.querySelectorAll("details")].map(el => el.id),
        marks: ["flagFrom", "displayMode", "underline"].map((id) => top(document.getElementById(id))),
        ids: ["analysisScope", "debug", "openReader", "toolbarGuide", "statsPreset", "statsCustomize", "sectionJump", "settingsSections"].filter((id) => document.getElementById(id)),
        text: document.body.innerText,
      };
    });
    expect(seen.titles).toEqual(["Websites", "PDFs", "Paragraph marks", "Reading history", "Saved scores", "In-browser engine"]);
    expect(seen.folds).toEqual(["statsKeep"]);
    expect(seen.tops[0]).toBe(seen.tops[1]);
    expect(seen.tops.slice(2).every((top, i) => top > seen.tops[i + 1])).toBe(true);
    await page.locator("#siteRulesToggle").click();
    const websitesBox = await page.locator("#websites").boundingBox();
    const pdfBox = await page.locator("#pdfs").boundingBox();
    expect(pdfBox.y).toBeGreaterThanOrEqual(websitesBox.y + websitesBox.height - 1);
    await page.locator("#siteRulesToggle").click();
    expect(new Set(seen.marks).size, "Flag, Chips and Underlines side by side").toBe(1);
    expect(seen.ids, "Scope, Debug logging, the PDF reader, the toolbar guide, field-by-field statistics and redundant nav are gone").toEqual([]);
    expect(seen.text).not.toMatch(/Shortcuts|Alt\s*\+\s*Shift|Scope|Include passage|Include page title|Debug logging|Analyze text|In detail/);
    await expect(page.locator(".component-status")).toHaveText("Ready (GPU)");
    await expect(page.getByRole("combobox", { name: "What to record" })).toBeEnabled();
    for (const width of [960, 800, 620, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const selectors of [
        ["#engineLabel", ".component-status", "#engine-manage"],
        ["#statsLabel", "#statsPresets"],
        ["#cacheLabel", "#cacheMode"],
      ]) {
        const boxes = await Promise.all(selectors.map((selector) => page.locator(selector).boundingBox()));
        expect(Math.max(...boxes.map((r) => r.y)), `${width}px: ${selectors.join(", ")} share a row`)
          .toBeLessThan(Math.min(...boxes.map((r) => r.y + r.height)));
      }
      for (const id of ["flagFrom", "displayMode", "underline"]) {
        const [label, menu] = await Promise.all([
          page.locator(`label[for="${id}"]`).boundingBox(),
          page.locator(`#${id}`).boundingBox(),
        ]);
        const gap = Math.max(menu.x - label.x - label.width, menu.y - label.y - label.height);
        expect(gap, `${width}px: ${id} label has room before its menu`).toBeGreaterThanOrEqual(7);
      }
      const headingLines = await page.locator("#statsLabel").evaluate(
        (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
      );
      expect(headingLines, `${width}px: Reading history fits beside its menu`).toBe(1);
      const [history, scores, marks, pdf] = await Promise.all(
        ["#statsPresets", "#cacheMode", "#underline", "#autoOpenPdfs"].map((selector) => page.locator(selector).boundingBox()),
      );
      for (const field of [scores, marks, pdf]) {
        expect(Math.abs(field.x + field.width - history.x - history.width), `${width}px: control right edges align`).toBeLessThan(1);
      }
      expect(Math.abs(history.x - scores.x), `${width}px: data menus share a left edge`).toBeLessThan(1);
      if (width > 320) expect(Math.abs(marks.x - history.x), `${width}px: paragraph and data menus align`).toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 600, height: 900 });
    const narrow = await page.evaluate(() => [...document.querySelectorAll(".settings .panel")].map((p) => Math.round(p.getBoundingClientRect().left)));
    expect(new Set(narrow).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.selectOption("#statsPresets", "daily");
    await expect(page.locator("#openStats")).toBeVisible();
    await page.locator("#statsKeep summary").click();
    const [preset, totals, cache] = await Promise.all(
      ["#statsPresets", "#statsTotals", "#cacheMode"].map((selector) => page.locator(selector).boundingBox()),
    );
    expect(Math.abs(preset.x - cache.x)).toBeLessThan(1);
    expect(Math.abs(totals.x - preset.x)).toBeLessThan(1);
  });

  test("Manage reveals the engine switch, model removal and idle unload; Keep open only while downloading", async ({ extension }) => {
    const ready = await openScripted(extension, "options.html", "ready_gpu");
    await painted(ready);
    // The switch comes once the page has read the device (a GPU-less runner's adapter request
    // takes a while): the line is measured when all three are drawn.
    await expect(ready.locator("#engine-delete")).toBeHidden();
    const manage = ready.locator("#engine-manage");
    await manage.press("Enter");
    await expect(manage).toHaveAttribute("aria-expanded", "true");
    for (const id of ["engine-switch", "engine-delete", "idleUnload"]) await expect(ready.locator(`#${id}`)).toBeVisible();
    const line = await ready.evaluate(() => {
      const ids = ["engine-switch", "engine-delete", "idleUnload"];
      const centre = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
      const box = document.querySelector("#componentSettings .component-inline");
      return { visible: ids.map((id) => document.getElementById(id).getClientRects().length > 0), together: ids.every((id) => box.contains(document.getElementById(id))), buttons: Math.abs(centre(ids[0]) - centre(ids[1])) };
    });
    expect(line.visible).toEqual([true, true, true]);
    expect(line.together, "all three are in the one line of controls").toBe(true);
    expect(line.buttons, "the two buttons share a line").toBeLessThan(12);
    expect(await ready.locator(".engine-keepopen").isVisible()).toBe(false);
    const downloading = await openScripted(extension, "options.html", "downloading");
    await painted(downloading);
    await expect(downloading.locator(".engine-keepopen")).toBeVisible();
  });
});

test.describe("first download with several detector releases", () => {
  test.use({ build: device("linux-cpu"), launch: { args: [NO_MODEL_HOSTS] } });

  test("shows a pending catalog check and retries a failed model lookup without starting a download", async ({extension}) => {
    const page = await extension.context.newPage();
    const other = { ...release, release: "2026-12-03-200m", revision: "a".repeat(40) };
    await page.addInitScript(({ recommended, other }) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      let reads = 0, catalogs = 0;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message.action === "getEngine") return Promise.resolve({ engine: null });
        if (message.action === "detectorCatalog") {
          if (message.setup) return new Promise(resolve => {
            catalogs++;
            window.finishCatalog = () => resolve({ ok: true, value: { choices: [recommended, other], recommended, listed: catalogs > 1 } });
          });
          return Promise.resolve(++reads === 1 ? { ok: false } : { ok: true, value: other });
        }
        if (message.action === "setEngine") throw Error("Unexpected automatic installation");
        return send(message, ...args);
      };
    }, { recommended: release, other });
    await page.goto(extension.url("onboarding.html"));
    const row = page.locator(".setup-model");
    await expect(row.getByRole("status")).toHaveText("Checking releases…");
    await expect(row.getByRole("status")).toBeVisible();
    await page.evaluate(() => window.finishCatalog());
    await expect(row.getByRole("status")).toHaveText("Couldn’t check for other models.");
    await row.getByRole("button", { name: "Retry" }).click();
    await expect(row.getByRole("combobox")).toBeDisabled();
    await page.evaluate(() => window.finishCatalog());
    await expect(row.getByRole("combobox")).toBeFocused();
    await row.getByRole("combobox").selectOption(other.revision);
    await expect(row.getByRole("status")).toHaveText("This release could not be loaded.");
    await expect(page.locator("#engine-pick-inbrowser")).toBeDisabled();
    await row.getByRole("button", { name: "Retry" }).click();
    await expect(row.getByRole("status")).toBeEmpty();
    await expect(row.getByRole("button", { name: "Retry" })).toBeHidden();
    await expect(row.getByRole("combobox")).toHaveValue(other.revision);
    await expect(page.locator("#engine-pick-inbrowser")).toBeEnabled();
  });

  test("preselects the Hub default and downloads the version the reader chooses", async ({extension}) => {
    const page = await extension.context.newPage();
    const smaller = {...release, revision: "a".repeat(40), release: "2026-12-01-200m",
      files: release.files.map(f => f.path === "backbone/model.safetensors" ? {...f, size_bytes: 700000000} : f)};
    await page.addInitScript(({recommended, smaller}) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (msg, ...rest) => {
        if (msg.action === "getEngine") return Promise.resolve({engine:null});
        if (msg.action === "detectorCatalog") return Promise.resolve({ok:true, value:msg.setup
          ? {choices:[smaller,recommended], recommended, listed:true} : smaller});
        if (msg.action === "setEngine") { window.chosenRelease = msg.release; return Promise.resolve({ok:true}); }
        return send(msg, ...rest);
      };
    }, {recommended:release, smaller});
    await page.goto(extension.url("onboarding.html"));
    const select = page.getByLabel("Detector", {exact:true}).filter({visible:true});
    await expect(select).toHaveValue(release.revision);
    await expect(select.locator("selectedcontent")).toHaveText(`Recommended (${release.release})`);
    const files = page.locator(".setup-model").getByRole("link", { name: "View on Hugging Face" });
    await expect(files).toHaveAttribute("href", `https://huggingface.co/${release.repository}/tree/${release.revision}`);
    await expect(page.locator("#engine-pick-inbrowser")).toContainText("1.6 GB");
    await select.selectOption(smaller.revision);
    await expect(select.locator("selectedcontent")).toHaveText(smaller.release);
    await expect(files).toHaveAttribute("href", `https://huggingface.co/${smaller.repository}/tree/${smaller.revision}`);
    await expect(page.locator("#engine-pick-inbrowser")).toContainText("704 MB");
    expect(await page.evaluate(() => window.chosenRelease)).toBeUndefined();
    await page.locator("#engine-pick-inbrowser").click();
    expect(await page.evaluate(() => window.chosenRelease)).toEqual(smaller);
  });
});

test.describe("the popup", () => {
  test.use({ build: device("linux-cpu"), launch: { args: [NO_MODEL_HOSTS] } });

  test("says to keep the browser open only while the model downloads", async ({ extension }) => {
    for (const [state, shown] of [["downloading", true], ["paused", false], ["needed", false]]) {
      const page = await openScripted(extension, "popup.html", state, {}, { width: 360, height: 600 });
      await page.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
      expect(await page.locator("#keepOpen").isVisible(), state).toBe(shown);
      if (shown) {
        const status = await page.locator("#status").boundingBox();
        const progress = await page.locator("#action").boundingBox();
        expect(progress.y).toBeLessThan(status.y + status.height);
        expect(progress.x).toBeGreaterThanOrEqual(status.x + status.width);
      }
      await page.close();
    }
  });

  test("says why a downloaded model did not start, and offers the setup page that has Retry", async ({ extension }) => {
    for (const [state, status] of [["load_failed", "The model couldn't start in this browser"], ["cannot_run", "This device can't run Anagram's model"]]) {
      const page = await openScripted(extension, "popup.html", state, {}, { width: 360, height: 600 });
      await page.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
      await expect(page.locator("#status"), state).toHaveText(status);
      await expect(page.locator("#action"), state).toHaveText("See why");
      await page.close();
    }
  });

  test("offers a PDF file and Analyze text at its foot, beside the one action", async ({ extension, context, page, pages }) => {
    // The popup reads the ACTIVE tab: a page in front, the popup reloaded behind it.
    pages.serve({ "/plain.html": "<!doctype html><html><head><meta charset=\"utf-8\"><title>plain</title></head><body><p>Nothing to read.</p></body></html>" });
    await page.goto(pages.url("/plain.html"), { waitUntil: "load" });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await scriptEngine(popup, "ready_gpu");
    await popup.goto(extension.url("popup.html"), { waitUntil: "load" });
    await page.bringToFront();
    await popup.reload({ waitUntil: "load" });
    await popup.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
    await expect(popup.locator("#openReader")).toHaveText("Open a PDF…");
    await expect(popup.locator("#analyzeText")).toHaveText("Analyze text");
    const pdfButton = await popup.locator("#openReader").boundingBox();
    const textButton = await popup.locator("#analyzeText").boundingBox();
    expect(textButton.y).toBe(pdfButton.y);
    expect(textButton.x).toBeGreaterThanOrEqual(pdfButton.x + pdfButton.width);
    expect(await popup.locator(".btn:visible:not([data-variant])").count(), "the new entries are secondary: at most one filled button").toBeLessThanOrEqual(1);

    const paste = context.waitForEvent("page", { predicate: (p) => /paste\.html$/.test(p.url()) });
    await popup.locator("#analyzeText").click();
    expect((await paste).url()).toMatch(/paste\.html$/);

    // The popup closes itself after a click (here: its tab), so the reader is asked from a fresh one.
    const again = await context.newPage();
    await scriptEngine(again, "ready_gpu");
    await again.goto(extension.url("popup.html"), { waitUntil: "load" });
    await page.bringToFront();
    await again.reload({ waitUntil: "load" });
    await again.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
    const reader = context.waitForEvent("page", { predicate: (p) => /reader\.html$/.test(p.url()) });
    await again.locator("#openReader").click();
    expect((await reader).url()).toMatch(/reader\.html$/);
  });

  test("on a page nothing can run on, the one action is the reader and it is not offered twice", async ({ extension }) => {
    const popup = await openScripted(extension, "popup.html", "ready_gpu", {}, { width: 360, height: 600 });
    await popup.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
    const reader = popup.getByRole("button", { name: "Open a PDF…" });
    await expect(reader).toHaveCount(1);
    expect((await reader.boundingBox()).y).toBe((await popup.locator("#analyzeText").boundingBox()).y);
  });
});
