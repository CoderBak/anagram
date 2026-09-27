// The whole interface in Simplified Chinese, in a browser whose UI language is zh-CN. That is
// the browser's own language, not `navigator.language` (all Playwright's `locale` sets), so it
// is switched at launch, differently on every platform (test/harness.mjs, uiLanguage()); where
// it cannot be switched the test is skipped, loudly, never run against English. The page under
// it stays English: EditLens reads English, and the point is a Chinese reader looking at an
// English article. And the English build is untouched by any of it.
//
//   npx playwright test scenarios-i18n
import { test, expect, BADGE_SEL, PAGE, KEY_PARA, KEY_TAGS, chipsSettle, toggleCounter } from "./kit.mjs";
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

  test("a zh-CN browser gets a Chinese popup, options page, chip card, triage panel, menu entries and report", async ({ context, page, pages, extension, report }) => {
    const zh = "a zh-CN browser gets a Chinese popup, options page, chip card, triage panel, menu entries and report";
    // The context menus are created with t(), and chrome.contextMenus cannot read a title
    // back, so the same lookup the worker made is asked for again.
    const menus = await extension.worker().evaluate(() => ["menuAnalyzeSelection", "menuAnalyzePage", "menuOpenPdf", "cmdOpenPanel"].map((k) => chrome.i18n.getMessage(k)));
    expect.soft(menus, `${zh} (menus)`).toEqual(["用 Anagram 分析所选文本", "用 Anagram 分析本页", "用 Anagram 打开 PDF", "打开存疑段落列表"]);

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
        componentCard: document.querySelector("#componentCard > header h2")?.textContent ?? "",
        componentStatus: document.querySelector(".component-status")?.textContent ?? "",
        update: [...document.querySelectorAll("button")].some((b) => !b.hidden && b.textContent === "更新引擎"),
        runtimeTitle: document.querySelector("#runtimeSettings h3")?.textContent ?? "",
        marks: document.querySelector('label[for="underline"]')?.textContent ?? "",
        fabricatedCommand: /~\/.anagram\/bin\/anagram|curl -fsSL/.test(document.body.innerText),
        // The footer's link to this version's source, next to the model credit.
        source: document.getElementById("sourceCode")?.textContent ?? "",
        sourceHref: document.getElementById("sourceCode")?.getAttribute("href") ?? "",
      })), { message: `${zh} (options)` })
      .toEqual({
        lang: "zh-CN", componentCard: "本地引擎", componentStatus: "就绪", update: true, runtimeTitle: "运行配置", marks: "下划线",
        fabricatedCommand: false, source: "源代码（AGPL-3.0）", sourceHref: `https://github.com/CoderBak/anagram/tree/v${EXTENSION_VERSION}`,
      });
    await opts.close();

    // The in-page UI: a chip's card, the panel behind the ball, and the report.
    pages.serve({ "/zh.html": ZH_PAGE });
    await page.goto(pages.url("/zh.html"), { waitUntil: "load" });
    await chipsSettle(page, 4);
    const chip = await firstCard(page);
    expect.soft(chip.lang, `${zh} (chip)`).toBe("zh-CN");
    expect.soft(["人工撰写", "轻度 AI 编辑", "重度 AI 编辑", "AI 生成"], `${zh} (chip verdict)`).toContain(chip.verdict);
    expect.soft({ words: chip.words, copy: chip.copy }, `${zh} (chip card)`).toEqual({ words: "词数", copy: "复制原文" });

    await toggleCounter(page);
    const panel = () => page.evaluate(() => {
      const sr = document.getElementById("anagram-fab").shadowRoot;
      return {
        lang: sr.querySelector(".stack")?.lang ?? "",
        title: sr.querySelector(".phead h2")?.textContent ?? "",
        cov: sr.querySelector(".pcov")?.textContent ?? "",
        copy: sr.querySelector(".pcopy")?.textContent ?? "",
        off: sr.querySelector(".psiteoff")?.textContent ?? "",
      };
    });
    await expect.poll(panel, { message: `${zh} (panel)` }).toMatchObject({ lang: "zh-CN", title: "存疑段落（4）", copy: "复制报告", off: "在 localhost 关闭" });
    // The coverage line is translated too: "已读 N", and nothing else where every paragraph was read.
    expect.soft((await panel()).cov, `${zh} (panel coverage)`).toMatch(/^已读 \d+$/);

    // The button says it copied, for 1.6 s: every label it shows is kept.
    await page.evaluate(() => {
      const copy = document.getElementById("anagram-fab").shadowRoot.querySelector(".pcopy");
      window.__copyLabels = [];
      new MutationObserver(() => window.__copyLabels.push(copy.textContent)).observe(copy, { childList: true, characterData: true, subtree: true });
    });
    const text = await report(page);
    expect.soft(await page.evaluate(() => window.__copyLabels), `${zh} (copied)`).toContain("已复制 ✓");
    expect.soft(text, `${zh} (report)`).toMatch(/^# Anagram 分析报告/);
    expect.soft(text, `${zh} (report)`).toContain("## 存疑段落（4）");
    expect.soft(text, `${zh} (report)`).toContain("也不能证明作者身份");
    expect.soft(text, `${zh} (report)`).toContain("请勿将其用于纪律处分或其他重大决定");
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
