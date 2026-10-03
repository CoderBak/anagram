// Frames: a cross-origin subframe that cannot see the page it sits in, a consent banner in a
// frame of its own, frames with no address (srcdoc, about:blank, blob:, sandboxed), and a
// comment thread served from another site nobody granted.
//
//   npx playwright test scenarios-frames
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, BADGE_SEL, ABSENCE_MS, PARA, KEY_PARA, KEY_TAGS, PAGE, settledChips, popupOver } from "./kit.mjs";
import { EXT, waitForRegistration } from "../harness.mjs";

/** The same server under another origin: 127.0.0.1 where the page is on localhost. */
const otherOrigin = (pages) => pages.base.replace("localhost", "127.0.0.1");

// The embedded page is served from 127.0.0.1 while its host page is on localhost (a
// different origin, so the frame cannot read window.top), and the embed forbids the
// referrer, which used to leave the frame keyed on its OWN hostname and therefore deaf to
// the rule written for the page it sits in.
test("a no-referrer cross-origin subframe follows the top page's site rule", async ({ context, pages, storage, tell }) => {
  pages.serve({
    "/frame.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>framed article</title></head><body style="margin:12px;font:15px/1.6 system-ui">
<p id="fp">${PARA("FRAMED")}</p></body></html>`,
    "/frame-top.html": PAGE("frame host", `<p id="topp">${PARA("FRAMEHOST")}</p>
<iframe id="embed" src="${otherOrigin(pages)}/frame.html" referrerpolicy="no-referrer" width="640" height="320" style="border:1px solid #ccc"></iframe>`),
  });
  const rule = "a no-referrer cross-origin subframe follows the top page's site rule";
  const chipsIn = async (page) => {
    const frame = page.frames().find((f) => f.url().includes("/frame.html"));
    return {
      top: await page.locator(BADGE_SEL).count(),
      frame: await frame.locator(BADGE_SEL).count(),
      // The proof that the old chain is dead here: no referrer, and the frame's own host is
      // 127.0.0.1, which the rule below never names.
      referrer: await frame.evaluate(() => document.referrer),
    };
  };
  const open = await context.newPage();
  await open.goto(pages.url("/frame-top.html"), { waitUntil: "load" });
  await expect(settledChips(open, "#topp"), `${rule} (on: the page)`).toHaveCount(1);
  await expect(open.frameLocator("#embed").locator(`${BADGE_SEL} .pill:not(.pending)`), `${rule} (on: the frame)`).toHaveCount(1);
  expect(await chipsIn(open), `${rule} (on)`).toEqual({ top: 1, frame: 1, referrer: "" });
  await open.close();

  await storage.set({ siteOverrides: { localhost: "off" } });
  const ruled = await context.newPage();
  await ruled.goto(pages.url("/frame-top.html"), { waitUntil: "load" });
  await expect.poll(async () => (await tell(ruled, { action: "getTabState" }))?.enabled, { message: `${rule} (off: the page knows)` }).toBe(false);
  await ruled.waitForTimeout(ABSENCE_MS); // long enough that a chip in the frame would have appeared
  expect(await chipsIn(ruled), `${rule} (off)`).toEqual({ top: 0, frame: 0, referrer: "" });
});

// With every site granted the content script runs in each frame, and Sourcepoint's message
// frame holds a paragraph of consent text as long as any article's. The hosts are served
// locally (the frames' markup is modelled); the third frame is a Sourcepoint message on the
// publisher's own domain, known only by its address.
test("a consent platform's banner in a frame of its own (Sourcepoint, on its CDN or the publisher's domain; TrustArc) is not read, the page around it is", async ({ context, page, pages, nativeHost }) => {
  const CONSENT = (tag) => `${tag} We and our partners store and access information on your device, such as cookies and unique identifiers, and process personal data such as browsing data, to show you personalised advertising and content, to measure how advertising and content perform, to understand our audiences and to develop our services. Some partners rely on their legitimate interest for this, which you can object to. You can accept, reject or choose purpose by purpose, and change your mind at any time from the privacy settings link in the footer of every page.`;
  const message = (tag) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SP Consent Message</title></head><body style="margin:0;font:14px/1.4 sans-serif">
<div id="notice" class="message type-modal" role="dialog" aria-label="Privacy notice" tabindex="0">
  <div class="message-component message-row"><p class="message-component">${CONSENT(tag)}</p></div>
  <div class="message-component message-row"><button class="message-component message-button sp_choice_type_11" title="Accept all">Accept all</button><button class="message-component message-button sp_choice_type_12" title="Settings">Settings</button></div>
</div></body></html>`;
  const trustarc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TrustArc Cookie Consent Manager</title></head><body style="margin:0;font:14px/1.4 sans-serif">
<div class="banner"><div class="banner-content"><h2>How we use your data</h2><p>${CONSENT("TRUSTEFRAME")}</p><button class="call">Agree and proceed</button></div></div></body></html>`;
  await context.route("https://cdn.privacy-mgmt.com/**", (route) => route.fulfill({ contentType: "text/html", body: message("SPCDNFRAME") }));
  await context.route("https://consent-pref.trustarc.com/**", (route) => route.fulfill({ contentType: "text/html", body: trustarc }));
  pages.serve({
    "/index.html": message("SPCNAMEFRAME"),
    "/consent-top.html": PAGE("consent frames", `<p id="topp">${PARA("CONSENTHOST")}</p>
<div id="sp_message_container_1000"><iframe id="sp_message_iframe_1000" title="SP Consent Message" src="https://cdn.privacy-mgmt.com/index.html?message_id=1000&amp;consentUUID=00000000-0000&amp;preload_message=true" width="640" height="300"></iframe></div>
<div id="sp_message_container_1001"><iframe id="sp_message_iframe_1001" title="SP Consent Message" src="${otherOrigin(pages)}/index.html?message_id=1001&amp;requestUUID=00000000-0001" width="640" height="300"></iframe></div>
<div class="truste_box_overlay"><iframe class="truste_popframe" title="TrustArc Cookie Consent Manager" src="https://consent-pref.trustarc.com/?type=example&amp;site=example.com&amp;action=notice&amp;country=gb&amp;locale=en" width="640" height="300"></iframe></div>`),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/consent-top.html"), { waitUntil: "load" });
  const consent = "a consent platform's banner in a frame of its own (Sourcepoint, on its CDN or the publisher's domain; TrustArc) is not read, the page around it is";
  await expect(settledChips(page, "#topp"), consent).toHaveCount(1);
  await page.waitForTimeout(ABSENCE_MS); // long enough for a frame's chip to have appeared
  const frames = await Promise.all(page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.locator(BADGE_SEL).count()));
  expect(frames, consent).toEqual([0, 0, 0]);
  expect(["SPCDNFRAME", "SPCNAMEFRAME", "TRUSTEFRAME"].filter((t) => nativeHost.textsSince(mark).some((s) => s.includes(t))), consent).toEqual([]);
});

// An EPUB reader shows each chapter in a srcdoc frame (epub.js), editors and embeds write
// into about:blank frames, and some pages show a blob: document. Each has its parent's
// origin, which is granted, and gets the content script through it. A sandboxed frame has no
// origin at all (the worker could not tell whose it is) and is left alone.
test("frames with no address of their own: srcdoc, about:blank and blob: frames are read, a sandboxed one is left alone", async ({ page, pages, nativeHost }) => {
  const LONG = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a chapter of a book may be shown in a frame that has no address of its own, only the origin of the page that wrote it, and the reader of that page still expects every paragraph of the chapter to be read like any other paragraph on the site they turned the extension on for.`;
  const doc = (tag) => `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:12px;font:15px/1.6 system-ui"><p>${LONG(tag)}</p></body></html>`;
  const attr = (html) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  pages.serve({
    "/frames-local.html": PAGE("frames without an address", `<iframe id="srcdoc" srcdoc="${attr(doc("SRCDOCFRAME"))}" width="640" height="300"></iframe>
<iframe id="blank" width="640" height="300"></iframe>
<iframe id="blob" width="640" height="300"></iframe>
<iframe id="sandboxed" sandbox srcdoc="${attr(doc("SANDBOXEDFRAME"))}" width="640" height="300"></iframe>
<script>
  document.getElementById("blank").contentDocument.body.innerHTML = ${JSON.stringify(`<p style="font:15px/1.6 system-ui">${LONG("BLANKFRAME")}</p>`)};
  document.getElementById("blob").src = URL.createObjectURL(new Blob([${JSON.stringify(doc("BLOBFRAME"))}], { type: "text/html" }));
</script>`),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/frames-local.html"), { waitUntil: "load" });
  // The sandboxed frame is out of the page's reach but not of the test's: every chip host
  // ever inserted there is counted, the "analyzing…" ones a refused request takes down too.
  const sandboxed = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame() || !(await f.evaluate(() => window.origin === "null").catch(() => false))) continue;
    sandboxed.push(f);
    await f.evaluate(() => {
      window.__hosts = document.querySelectorAll('[data-anagram="host"]').length;
      new MutationObserver((records) => {
        for (const rec of records) for (const n of rec.addedNodes) if (n.nodeType === 1 && n.matches('[data-anagram="host"]')) window.__hosts++;
      }).observe(document, { childList: true, subtree: true });
    });
  }
  const inFrame = () => page.evaluate((sel) => Object.fromEntries(["srcdoc", "blank", "blob"].map((id) => [id, document.getElementById(id)?.contentDocument?.querySelectorAll(sel).length ?? -1])), BADGE_SEL);
  await expect.poll(inFrame, { message: "a srcdoc, an about:blank and a blob: frame on a granted page are read, each in its own frame" }).toEqual({ srcdoc: 1, blank: 1, blob: 1 });
  const left = "a sandboxed frame, whose origin the worker cannot know, is left alone";
  expect(sandboxed, left).toHaveLength(1);
  await page.waitForTimeout(ABSENCE_MS);
  expect(await sandboxed[0].evaluate(() => window.__hosts), left).toBe(0);
  expect(nativeHost.textsSince(mark).filter((t) => t.includes("SANDBOXEDFRAME")), left).toEqual([]);
});

// Disqus shows a page's comments in a frame of disqus.com, which a content script reaches only
// once that site is granted too. The test build grants every site, so this runs a copy of it
// that grants localhost ALONE (the page's own site) and leaves the rest optional, as a
// reader's per-site grant does. A permission prompt is native UI no automation can answer:
// what is checked is that the toolbar menu names the site and offers it, that nothing is ever asked
// for by itself, and that the offer's button opens Settings at the one row that can ask.
const localhostOnly = test.extend({
  localhostBuild: [
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), "anagram-localhost-grant-"));
      const ext = join(dir, "chrome-mv3");
      cpSync(EXT, ext, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
      manifest.name += " — LOCALHOST GRANT TEST ONLY";
      manifest.host_permissions = ["http://localhost/*"];
      manifest.optional_host_permissions = ["https://*/*", "http://*/*", "file:///*"];
      writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));
      await use(ext);
      rmSync(dir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],
  build: async ({ localhostBuild }, use) => use(localhostBuild),
});

localhostOnly("a comment thread in another site's frame: not read, named and offered by the toolbar menu, allowed only from the Settings row it opens", async ({ context, page, pages, extension, nativeHost }) => {
  await waitForRegistration(extension.sw);
  await context.route("https://disqus.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html lang="en"><body><p>${KEY_PARA("DISQUSCOMMENT")}</p></body></html>` }),
  );
  pages.serve({
    "/comments.html": PAGE("comments from another site", `${KEY_TAGS.slice(0, 2).map((t) => `<p>${KEY_PARA(t)}</p>`).join("\n")}
<div id="disqus_thread"><iframe id="dsq-app1" src="https://disqus.com/embed/comments/?base=default&f=fixture&t_u=http%3A%2F%2Flocalhost%2Fcomments.html" width="680" height="400"></iframe></div>`),
  });
  const granted = () => extension.worker().evaluate(() => chrome.permissions.contains({ origins: ["https://disqus.com/*"] }));
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/comments.html"), { waitUntil: "load" });
  await expect(settledChips(page), "the page's own paragraphs are read").toHaveCount(2);
  const menu = await popupOver(page);
  const offered = "a comment thread in another site's frame is not read; the toolbar menu names that site and offers to allow it";
  const offer = menu.locator("#pageReport .report-comment");
  await expect(offer, offered).toContainText("disqus.com");
  await expect(offer.locator("button"), offered).toHaveAttribute("aria-label", /disqus\.com/);
  expect(nativeHost.textsSince(mark).filter((t) => t.includes("DISQUSCOMMENT")), offered).toEqual([]);

  const asks = "…the offer asks for nothing by itself: its button opens Settings at the one row that can, and the site stays ungranted until the reader says yes there";
  expect(await granted(), `${asks} (before)`).toBe(false);
  const opened = context.waitForEvent("page");
  await offer.locator("button").click();
  const settings = await opened;
  await settings.waitForLoadState("load");
  await expect(settings.locator("#comments"), asks).toBeVisible();
  await expect(settings.locator("#commentsState"), asks).toContainText("disqus.com");
  await expect(settings.locator("#commentsAllow"), asks).toContainText("disqus.com");
  await expect(settings.locator("#commentsAllow"), asks).toBeFocused();
  expect(new URL(settings.url()).hash, asks).toBe("#comments=disqus.com");
  expect(await granted(), `${asks} (after)`).toBe(false);

  const forged = await context.newPage();
  await forged.goto(extension.url("options.html#comments=bank.example"), { waitUntil: "load" });
  await expect(forged.locator("#cacheCount"), "the Settings page has run").toHaveText(/entr(y|ies)$/);
  await expect(forged.locator("#comments"), "…and Settings offers only a comment provider, whatever its address names").toBeHidden();
});
