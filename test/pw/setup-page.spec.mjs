// The setup page and Settings as one compact list each, and the popup's two small entries.
//
//   npx playwright test setup-page
//
// What is judged here is the shape the user asked for, not the engine (test/inbrowser.mjs
// drives that): permissions come first on the setup page; no card quotes a speed or a memory
// figure; "Keep this browser open" shows only while the in-browser download runs, on the setup
// page, in Settings and in the popup; Settings has no headings and no folds and no Scope; the
// popup carries the PDF reader and Analyze text. The engine's states are scripted into each
// page (test/webengine/scripted-engine.mjs) on the device builds (test/pw/devices.mjs).
import { join } from "node:path";
import { test, expect } from "./fixtures.mjs";
import { scriptEngine } from "../webengine/scripted-engine.mjs";
import { NO_MODEL_HOSTS } from "../webengine/model-server.mjs";

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
  test.use({ build: device("apple-silicon"), launch: { args: [NO_MODEL_HOSTS] } });

  test("puts where it reads above the engine, and both above how to read a verdict", async ({ extension }) => {
    const page = await openScripted(extension, "onboarding.html", "needed", { engine: null });
    await painted(page);
    const order = await page.evaluate(() => {
      const at = (id) => document.getElementById(id);
      const before = (a, b) => !!(at(a).compareDocumentPosition(at(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        whereBeforeEngine: before("whereCard", "engineCard"),
        engineBeforeVerdict: before("engineCard", "verdictCard"),
        // Every permission control lives in the first card.
        inWhere: ["site-access", "autoOpenPdfs", "local-pdfs"].map((id) => at("whereCard").contains(at(id))),
        folds: document.querySelectorAll("details").length,
        // The order on the screen, not only in the markup.
        tops: ["whereCard", "engineCard", "verdictCard"].map((id) => Math.round(at(id).getBoundingClientRect().top)),
      };
    });
    expect(order.whereBeforeEngine, "permissions come first").toBe(true);
    expect(order.engineBeforeVerdict).toBe(true);
    expect(order.inWhere, "site access and both PDF rows are in the permissions card").toEqual([true, true, true]);
    expect(order.folds, "no collapsed fold anywhere").toBe(0);
    expect(order.tops).toEqual([...order.tops].sort((a, b) => a - b));
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
      if (shown) await expect(page.locator(".engine-keepopen")).toHaveText("Keep this browser open until the download finishes.");
    });
  }

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
    expect(seen.line, "bytes of total, and nothing else without a speed yet").toMatch(/^\d+ MB of 1\.4 GB/);
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
  test.use({ build: device("apple-silicon"), launch: { args: [NO_MODEL_HOSTS] } });

  test("is one list: no headings, no folds, no Scope, no shortcuts, no report or debug switches", async ({ extension }) => {
    const page = await openScripted(extension, "options.html", "ready_gpu");
    await painted(page);
    const seen = await page.evaluate(() => ({
      headings: [...document.querySelectorAll("h2, h3")].filter((h) => !h.closest("dialog") && h.getClientRects().length > 0).length,
      folds: document.querySelectorAll("details, summary").length,
      ids: ["analysisScope", "reportIncludeText", "reportIncludeUrl", "debug", "openReader"].filter((id) => document.getElementById(id)),
      labels: [...document.querySelectorAll(".group-label")].map((el) => el.textContent),
      text: document.body.innerText,
    }));
    expect(seen.headings, "no section headings").toBe(0);
    expect(seen.folds, "no folds").toBe(0);
    expect(seen.ids, "Scope, the two report switches, Debug logging and the PDF reader are gone").toEqual([]);
    expect(seen.labels).toEqual(["Engine", "Sites", "PDFs", "Marks", "Length", "Cache"]);
    expect(seen.text).not.toMatch(/Shortcuts|Alt\s*\+\s*Shift|Scope|Include passage|Include page title|Debug logging|Analyze text/);
    expect(seen.text, "the engine in words").toContain("In the browser, on the graphics card, Ready");
  });

  test("the engine row carries the switch, Delete model files and the idle unload inline; Keep open only while downloading", async ({ extension }) => {
    const ready = await openScripted(extension, "options.html", "ready_gpu");
    await painted(ready);
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

test.describe("the popup", () => {
  test.use({ build: device("linux-cpu"), launch: { args: [NO_MODEL_HOSTS] } });

  test("says to keep the browser open only while the model downloads", async ({ extension }) => {
    for (const [state, shown] of [["downloading", true], ["paused", false], ["needed", false]]) {
      const page = await openScripted(extension, "popup.html", state, {}, { width: 300, height: 600 });
      await page.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
      expect(await page.locator("#keepOpen").isVisible(), state).toBe(shown);
      await page.close();
    }
  });

  test("offers the PDF reader and Analyze text beside the one action", async ({ extension, context, page, pages }) => {
    // The popup reads the ACTIVE tab: a page in front, the popup reloaded behind it.
    pages.serve({ "/plain.html": "<!doctype html><html><head><meta charset=\"utf-8\"><title>plain</title></head><body><p>Nothing to read.</p></body></html>" });
    await page.goto(pages.url("/plain.html"), { waitUntil: "load" });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 300, height: 600 });
    await scriptEngine(popup, "ready_gpu");
    await popup.goto(extension.url("popup.html"), { waitUntil: "load" });
    await page.bringToFront();
    await popup.reload({ waitUntil: "load" });
    await popup.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
    await expect(popup.locator("#openReader")).toHaveText("PDF reader");
    await expect(popup.locator("#analyzeText")).toHaveText("Analyze text");
    expect(await popup.locator("main .btn:not([data-variant])").count(), "the new entries are secondary: at most one filled button").toBeLessThanOrEqual(1);

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
    const popup = await openScripted(extension, "popup.html", "ready_gpu", {}, { width: 300, height: 600 });
    await popup.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
    expect(await popup.locator("#action").textContent()).toBe("Read a PDF file…");
    expect(await popup.locator("#openReader").isHidden()).toBe(true);
    await expect(popup.locator("#analyzeText")).toBeVisible();
  });
});
