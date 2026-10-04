// test/node/settingsUi.test.ts — what Settings and the setup page no longer carry.
//
// The pages are one compact list each (test/pw/setup-page.spec.mjs judges them rendered); this
// pins what was deleted so it stays deleted: the Scope setting with the code path for "main",
// the shortcuts list, the report and debug switches, the folds, and the speed and memory
// figures of the engine choice.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { settings } from "../../lib/settings/settings";

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");
const LOCALES = ["en", "zh_CN"].map((l) => JSON.parse(read("public", "_locales", l, "messages.json")) as Record<string, { message: string }>);

function sourcesOf(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) sourcesOf(rel, out);
    else if (/\.(ts|html)$/.test(name)) out.push(rel);
  }
  return out;
}

describe("the Scope setting is gone", () => {
  it("has no stored item, no control and no code path", () => {
    expect(Object.keys(settings)).not.toContain("analysisScope");
    expect(read("entrypoints", "options", "index.html")).not.toMatch(/analysisScope|optScope/);
    const product = [...sourcesOf("lib"), ...sourcesOf("entrypoints")].filter((f) => !/^lib\/pdf\/|^entrypoints\/reader\//.test(f));
    const users = product.filter((f) => /analysisScope|lockScope|Main content only|useDefuddle/.test(read(f)));
    expect(users).toEqual([]);
    for (const messages of LOCALES) expect(Object.keys(messages).filter((k) => /^optScope/.test(k))).toEqual([]);
  });
});

describe("Settings is one list", () => {
  const html = read("entrypoints", "options", "index.html");

  it("has no section headings, no folds and no shortcuts", () => {
    expect(html).not.toMatch(/<h[2-6][ >]/);
    expect(html).not.toMatch(/<details|<summary/);
    expect(html).not.toMatch(/kbd|shortcuts|cmdToggleOverlay/);
  });

  it("has neither the report switches nor Debug logging", () => {
    expect(html).not.toMatch(/reportIncludeText|reportIncludeUrl|id="debug"/);
    for (const messages of LOCALES) expect(Object.keys(messages).filter((k) => /^(optReportText|optReportUrl|optDebug|optShortcuts)$/.test(k))).toEqual([]);
  });

  it("names its rows: Engine, Sites, PDFs, Marks, Length, Cache and Statistics", () => {
    const labels = [...html.matchAll(/class="group-label"[^>]*data-i18n="(\w+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["optEngine", "optSites", "optPdfs", "optMarks", "optLength", "optCache", "optStats"]);
  });

  it("no longer holds the PDF reader or the paste page: the popup does", () => {
    expect(html).not.toMatch(/openReader|paste\.html/);
    expect(read("entrypoints", "popup", "index.html")).toMatch(/id="openReader"[\s\S]*id="analyzeText"/);
  });
});

describe("the setup page is one page", () => {
  const html = read("entrypoints", "onboarding", "index.html");

  it("has no folds and numbers its steps: the engine, where it reads, the toolbar, then the marks", () => {
    // The download is the step that takes longest and the one nothing works without, so it
    // starts first; the three steps are on screen together, each turning into a tick when done.
    expect(html).not.toMatch(/<details|<summary/);
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(at("engineCard")).toBeGreaterThan(0);
    expect(at("engineCard")).toBeLessThan(at("whereCard"));
    expect(at("whereCard")).toBeLessThan(at("pinCard"));
    expect(at("pinCard")).toBeLessThan(at("verdictCard"));
    expect([...html.matchAll(/class="card step"/g)]).toHaveLength(3);
  });

  it("quotes no speed or memory for the engines", () => {
    for (const messages of LOCALES) {
      for (const key of ["engineOneClickCost", "engineTerminalCost", "engineMeasured", "engineChooseIntro"]) expect(messages[key], key).toBeUndefined();
      for (const [key, entry] of Object.entries(messages)) {
        if (/^engine(OneClickWhat|TerminalWhat)/.test(key)) expect(entry.message, key).not.toMatch(/\bms\b|memory|faster|更快|内存|毫秒/i);
      }
    }
  });
});
