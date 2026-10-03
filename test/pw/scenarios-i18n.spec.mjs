// The whole interface in Simplified Chinese, in a browser whose UI language is zh-CN. That is
// the browser's own language, not `navigator.language` (all Playwright's `locale` sets), so it
// is switched at launch, differently on every platform (test/harness.mjs, uiLanguage()); where
// it cannot be switched the test is skipped, loudly, never run against English. The page under
// it stays English: EditLens reads English, and the point is a Chinese reader looking at an
// English article. And the English build is untouched by any of it.
//
//   npx playwright test scenarios-i18n
import { test, expect, BADGE_SEL, PAGE, KEY_PARA, KEY_TAGS, chipsSettle, popupOver, menuReport } from "./kit.mjs";
import { EXTENSION_VERSION } from "../fake-native.mjs";

const ZH_PAGE = PAGE("Chinese UI fixture", KEY_TAGS.map((t, i) => `<p id="z${i + 1}">${KEY_PARA(t)}</p>`).join("\n"));
/** The first chip's card: its verdict, the words row, the copy action and the language. */
const firstCard = (page) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel)?.shadowRoot;
    return {
      verdict: root?.querySelector(".card .verdict")?.textContent ?? "",
      words: root?.querySelector(".card .row .k")?.textContent ?? "",
      copy: root?.querySelector(".card .act.copy")?.textContent ?? "",
      // Our own chrome declares its language whatever the article is written in.
      lang: root?.querySelector(".pill")?.lang ?? "",
    };
  }, BADGE_SEL);

test.describe("a zh-CN browser", () => {
  test.use({ uiLanguage: "zh-CN" });

  test("a zh-CN browser gets a Chinese popup, options page, chip card, page report and menu entries", async ({ context, page, pages, extension }) => {
    const zh = "a zh-CN browser gets a Chinese popup, options page, chip card, page report and menu entries";
    // The context menus are created with t(), and chrome.contextMenus cannot read a title
    // back, so the same lookup the worker made is asked for again.
    const menus = await extension.worker().evaluate(() => ["menuAnalyzeSelection", "menuAnalyzePage", "menuOpenPdf", "cmdOpenPanel"].map((k) => chrome.i18n.getMessage(k)));
    expect.soft(menus, `${zh} (menus)`).toEqual(["用 Anagram 分析所选文本", "用 Anagram 分析本页", "用 Anagram 打开 PDF", "打开工具栏中的 Anagram"]);

    // The popup: plain text, an attribute, a group heading and the one action button, whose
    // label the page chooses. Opened as a tab it is its own active tab, a page nothing can
    // run on, so the action is the reading mode with a file from this computer.
    const popup = await context.newPage();
    await popup.goto(extension.url("popup.html"), { waitUntil: "load" });
    await expect
      .poll(() => popup.evaluate(() => ({
        lang: document.documentElement.lang,
        gear: document.getElementById("gear")?.getAttribute("aria-label") ?? "",
        site: document.querySelector('label[for="siteEnabled"]')?.textContent ?? "",
        action: document.getElementById("action")?.textContent ?? "",
        flagged: document.querySelector('[role="tab"][data-value="flagged"]')?.textContent ?? "",
      })), { message: `${zh} (popup)` })
      .toEqual({ lang: "zh-CN", gear: "设置", site: "在此网站运行", action: "阅读本机 PDF…", flagged: "仅存疑" });
    await popup.close();

    const opts = await context.newPage();
    await opts.goto(extension.url("options.html"), { waitUntil: "load" });
    await expect
      .poll(() => opts.evaluate(() => ({
        lang: document.documentElement.lang,
        engine: document.getElementById("engineLabel")?.textContent ?? "",
        componentStatus: document.querySelector(".component-status")?.textContent ?? "",
        update: [...document.querySelectorAll("button")].some((b) => !b.hidden && b.textContent === "更新引擎"),
        marks: document.querySelector('label[for="underline"]')?.textContent ?? "",
        fabricatedCommand: /~\/.anagram\/bin\/anagram|curl -fsSL/.test(document.body.innerText),
        // The footer's link to this version's source, next to the model credit.
        source: document.getElementById("sourceCode")?.textContent ?? "",
        sourceHref: document.getElementById("sourceCode")?.getAttribute("href") ?? "",
      })), { message: `${zh} (options)` })
      .toEqual({
        lang: "zh-CN", engine: "引擎", componentStatus: "本地引擎：就绪", update: true, marks: "下划线",
        fabricatedCommand: false, source: "源代码（AGPL-3.0）", sourceHref: `https://github.com/CoderBak/anagram/tree/v${EXTENSION_VERSION}`,
      });
    await opts.close();

    // The in-page UI, a chip's card, and the toolbar menu's report on that page.
    pages.serve({ "/zh.html": ZH_PAGE });
    await page.goto(pages.url("/zh.html"), { waitUntil: "load" });
    await chipsSettle(page, 4);
    const chip = await firstCard(page);
    expect.soft(chip.lang, `${zh} (chip)`).toBe("zh-CN");
    expect.soft(["人工撰写", "轻度 AI 编辑", "重度 AI 编辑", "AI 生成"], `${zh} (chip verdict)`).toContain(chip.verdict);
    expect.soft({ words: chip.words, copy: chip.copy }, `${zh} (chip card)`).toEqual({ words: "词数", copy: "复制原文" });

    const menu = await popupOver(page);
    // The title is flagged out of read, each row is named in Chinese, and there are no Copy
    // report and Turn off buttons; with every paragraph read, there is no coverage line.
    await expect.poll(() => menuReport(menu), { message: `${zh} (report)` }).toMatchObject({ title: "存疑段落（4/4）", notes: [] });
    const report = await menuReport(menu);
    expect.soft(report.rows, `${zh} (report rows)`).toHaveLength(4);
    for (const row of report.rows) expect.soft(row, `${zh} (report rows)`).toMatch(/^(重度 AI 编辑|AI 生成)，(0\.\d\d|1\.0)：\S/);
    expect.soft(await menu.locator("#pageReport").textContent(), `${zh} (report buttons)`).not.toMatch(/复制报告|关闭 localhost|在 localhost 关闭/);
  });
});

test("an English browser is unaffected: the same page, the same chip, the English verdict", async ({ page, pages }) => {
  pages.serve({ "/zh.html": ZH_PAGE });
  await page.goto(pages.url("/zh.html"), { waitUntil: "load" });
  await chipsSettle(page, 4);
  const chip = await firstCard(page);
  const en = "an English browser is unaffected: the same page, the same chip, the English verdict";
  expect.soft(["Human", "Lightly edited", "Heavily edited", "AI-generated"], en).toContain(chip.verdict);
  expect.soft(chip.lang, en).toBe("en");
});
