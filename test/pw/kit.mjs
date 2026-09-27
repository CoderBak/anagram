// test/pw/kit.mjs — what the page-driving specs (e2e, scenarios-*) share: the fixtures of
// fixtures.mjs plus a few that act as the extension's own worker does, and the conditions
// they wait on. Nothing here sleeps: every wait is for something the page or the fixture
// host shows.
//
//   tell(page, message)  the worker's chrome.tabs.sendMessage to that page's tab (the
//                        context menu, the keyboard commands and the popup's Rescan all
//                        arrive this way; the real key combinations never reach a page)
//   report(page)         the panel's Copy report, read back off the clipboard once it holds
//                        more than the sentinel put there first (its links may take 1.5 s)
//   backendUp()          the worker has the fixture host up again (after close()/resume())
import { test as base, expect as baseExpect } from "./fixtures.mjs";
import { BADGE_SEL } from "../harness.mjs";

export { BADGE_SEL };

/** A chip waits on a batch, a batch on a host under whatever else this machine runs. */
export const expect = baseExpect.configure({ timeout: 20_000 });

/** A settled score on a chip: ".42" or "1.0". */
export const SCORE = /^(\.\d\d|1\.0)$/;

/** How long a check that something does NOT happen watches for it, once what would have
 *  caused it is known to have happened: there is no signal for a chip that never comes. */
export const ABSENCE_MS = 2500;

const NO_REPORT = "NO REPORT COPIED";

export const test = base.extend({
  tell: async ({ extension }, use) => {
    /** Resolves to the content script's answer, if it gives one. */
    await use(async (page, message) => {
      const url = page.url();
      const { found, reply } = await extension.worker().evaluate(async ({ url, message }) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
        if (!tab) return { found: false };
        try {
          return { found: true, reply: await chrome.tabs.sendMessage(tab.id, message) };
        } catch {
          return { found: true, reply: null }; // most of these are answered by nobody
        }
      }, { url, message });
      expect(found, `a tab showing ${url}`).toBe(true);
      return reply;
    });
  },

  report: async ({ clipboard }, use) => {
    await use(async (page, { open = true } = {}) => {
      await clipboard.write(page, NO_REPORT);
      await page.evaluate((open) => {
        const sr = document.getElementById("anagram-fab")?.shadowRoot;
        if (open && !sr?.querySelector(".panel.open")) sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        sr?.querySelector(".pcopy")?.click();
      }, open);
      let text = null;
      await expect
        .poll(async () => (text = await clipboard.read(page)), { message: "Copy report put a report on the clipboard" })
        .not.toMatch(new RegExp(`^(${NO_REPORT})?$`));
      // Windows hands the clipboard back with CRLF line ends; the report itself is LF.
      return text.replace(/\r\n/g, "\n");
    });
  },

  backendUp: async ({ extension }, use) => {
    await use(() =>
      expect
        .poll(
          () => extension.worker().evaluate(async () => (await chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }).catch(() => null))?.active).catch(() => null),
          { message: "the worker has the engine up", timeout: 30_000 },
        )
        .toBe("server"),
    );
  },
});

/** The chips under `scope` (every chip without one) that carry their verdict. */
export const settledChips = (page, scope = "") => page.locator(`${scope} ${BADGE_SEL} .pill:not(.pending)`.trim());

/** How many chips the page shows, and how many of them are still "analyzing…". */
export const chipCounts = (page, scope = "") =>
  page.evaluate(
    ({ sel, scope }) => {
      const pills = [...document.querySelectorAll(`${scope} ${sel}`.trim())].map((h) => h.shadowRoot?.querySelector(".pill")).filter(Boolean);
      return { chips: pills.length, pending: pills.filter((p) => p.classList.contains("pending")).length };
    },
    { sel: BADGE_SEL, scope },
  );

/** Wait until exactly `n` chips (under `scope`) carry a verdict and none is pending. */
export const chipsSettle = (page, n, scope = "") =>
  expect.poll(() => chipCounts(page, scope), { message: `${n} settled chips${scope ? ` in ${scope}` : ""}` }).toEqual({ chips: n, pending: 0 });

/** Every range the page's marks are drawn over, as text. */
export const marked = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const h of CSS.highlights?.values() ?? []) for (const r of h) out.push(r.toString());
    return out;
  });

/** Click the ball's counter: the panel opens (or closes). */
export const toggleCounter = (page) =>
  page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

/** A paragraph long enough to be scored alone, opening on `tag`. */
export const PARA = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a self-rewriting page must still end up with chips after it replaces its own document element, which is what legacy challenge pages and some old single-page frameworks do, and the extension then has to find the new document, walk it again from the top and read every paragraph in it as if the page had only just loaded.`;

/** A paragraph long enough to be scored alone. With the four KEY_TAGS, the fake host's
 *  text-seeded scores put it in the FLAGGED band (AI-generated, .91 to .95). */
export const KEY_PARA = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a keyboard user must be able to walk the flagged paragraphs of a page without ever reaching for a mouse, which is what the next and previous commands are for, and each of them has to bring the next verdict into view and say which paragraph it belongs to before the reader moves on.`;
export const KEY_TAGS = ["FLAG-3", "FLAG-2", "FLAG-22", "FLAG-37"];

/** A plain page: a title and a body, in the one layout every fixture uses. */
export const PAGE = (title, body, lang = "en") =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
${body}
</body></html>`;
