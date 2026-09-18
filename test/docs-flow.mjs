// test/docs-flow.mjs — verify Google Docs support on a real public document.
//
// Phase 1 (the new default): the FAB's "Analyze document" opens the IN-TAB
// reading overlay — no navigation, badges render inside the overlay's shadow
// root, Esc returns to the untouched editor instantly.
// Phase 2 (the classic flow, still used as fallback + "Open as page"): overlay's
// "Open as page" navigates to /mobilebasic, badges render there, "Back to
// editor" returns to the same editor URL.
//   node test/docs-flow.mjs [docUrlBase]      (or ANAGRAM_DOC_URL=…)
//
// Needs a PUBLIC Google Doc ("anyone with the link can view"). The original demo
// document was deleted from Drive in Sept 2026 (its /mobilebasic now answers 410),
// so the suite pre-flights the URL and SKIPS (exit 0) instead of failing when the
// document is gone — pass your own doc to run it for real.
import { launchExtension, artifact } from "./harness.mjs";

const BADGE_SEL = '[data-anagram="host"]:not(#anagram-fab)';
const DOC =
  process.argv[2] ??
  process.env.ANAGRAM_DOC_URL ??
  "https://docs.google.com/document/d/1gRLkVx985SLnysZvrkm8PQolykP-rRWxBtxFoywXXRo";

// Pre-flight: is the document still there and public? (410 = deleted, 401/403 = private.)
{
  let status = 0;
  try {
    status = (await fetch(`${DOC}/mobilebasic`, { redirect: "follow", signal: AbortSignal.timeout(15000) })).status;
  } catch (e) {
    console.log(`SKIP  docs-flow: cannot reach Google Docs (${String(e).slice(0, 60)})`);
    process.exit(0);
  }
  if (status !== 200) {
    console.log(
      `SKIP  docs-flow: the test document answers HTTP ${status} (${status === 410 ? "deleted" : "not public"}). ` +
        "Pass a public doc URL as the first argument (or ANAGRAM_DOC_URL) to run this suite.",
    );
    process.exit(0);
  }
}

const checks = [];
const check = (name, ok, note = "") => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  —  ${note}` : ""}`);
};

const { context } = await launchExtension({ viewport: { width: 1280, height: 850 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  const u = m.location()?.url ?? "";
  // chrome-extension://invalid/ is GOOGLE's own extension-detection probe, not us.
  if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid"))
    errors.push(m.text().slice(0, 140));
});

// ---- phase 1: in-tab overlay ---------------------------------------------------------
await page.goto(`${DOC}/edit?usp=sharing`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(6000); // editor bootstraps slowly

const editorState = await page.evaluate(() => {
  const fab = document.getElementById("anagram-fab");
  const action = fab?.shadowRoot?.querySelector("#anagram-action");
  return {
    fab: !!fab,
    actionShown: action ? getComputedStyle(action).display !== "none" : false,
    actionLabel: action?.textContent ?? null,
    hasCanvas: !!document.querySelector("canvas"),
  };
});
check("editor: FAB present with action chip", editorState.fab && editorState.actionShown, JSON.stringify(editorState));
check("editor: action offers in-tab analysis", editorState.actionLabel === "Analyze document", editorState.actionLabel ?? "");
await page.screenshot({ path: artifact("docs-editor.png") });

const editorUrl = page.url();
await page.evaluate(() => {
  document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.click();
});

// Overlay mounts after the same-origin fetch — badges live inside ITS shadow root.
const overlayReady = await page
  .waitForFunction(
    (sel) => {
      const ovl = document.getElementById("anagram-docs-overlay");
      return !!ovl?.shadowRoot && ovl.shadowRoot.querySelectorAll(sel).length >= 1;
    },
    BADGE_SEL,
    { timeout: 25000 },
  )
  .then(() => true)
  .catch(() => false);
check("overlay: opened in-tab with badges inside its shadow root", overlayReady, "");
check("overlay: NO navigation happened (URL unchanged)", page.url() === editorUrl, page.url().slice(0, 90));

// Scroll the overlay itself so below-fold paragraphs dispatch, then count.
await page.evaluate(async () => {
  const ovl = document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector(".ovl");
  if (!ovl) return;
  for (let i = 0; i < 10; i++) {
    ovl.scrollBy(0, ovl.clientHeight * 0.8);
    await new Promise((r) => setTimeout(r, 280));
  }
  ovl.scrollTo(0, 0);
});
await page.waitForTimeout(2500);

const overlayState = await page.evaluate((sel) => {
  const ovl = document.getElementById("anagram-docs-overlay");
  const sr = ovl?.shadowRoot;
  const fabSr = document.getElementById("anagram-fab")?.shadowRoot;
  const hl = [];
  if (typeof CSS !== "undefined" && CSS.highlights) {
    for (const h of CSS.highlights.values()) for (const rg of h) hl.push(rg);
  }
  return {
    badges: sr ? sr.querySelectorAll(sel).length : 0,
    title: sr?.querySelector(".bar .t")?.textContent?.slice(0, 40) ?? null,
    paper: !!sr?.querySelector(".paper"),
    highlights: hl.length,
    fabAction: fabSr?.querySelector("#anagram-action")?.textContent ?? null,
    sample: (sr?.querySelector(`${sel}`)?.parentElement?.textContent ?? "").trim().slice(0, 50),
  };
}, BADGE_SEL);
console.log("OVERLAY:", JSON.stringify(overlayState, null, 2));
check("overlay: multiple paragraphs analyzed", overlayState.badges >= 2, `badges=${overlayState.badges}`);
check("overlay: underlines painted inside the shadow tree", overlayState.highlights > 0, `ranges=${overlayState.highlights}`);
check("overlay: FAB action switched to close", overlayState.fabAction === "Close reading mode", overlayState.fabAction ?? "");
await page.screenshot({ path: artifact("docs-overlay.png") });

// Esc closes instantly, editor untouched, action restored.
await page.keyboard.press("Escape");
await page.waitForTimeout(800);
const afterClose = await page.evaluate(() => ({
  overlayGone: !document.getElementById("anagram-docs-overlay"),
  url: location.href,
  canvas: !!document.querySelector("canvas"),
  action: document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.textContent ?? null,
}));
check("overlay: Esc closes, editor + URL untouched", afterClose.overlayGone && afterClose.url === editorUrl && afterClose.canvas, JSON.stringify(afterClose.action));
check("overlay: FAB action restored", afterClose.action === "Analyze document", afterClose.action ?? "");

// ---- phase 2: classic navigation flow (fallback / "Open as page") ---------------------
await page.evaluate(() => {
  document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.click();
});
await page.waitForFunction(() => !!document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector(".bar"), null, { timeout: 25000 }).catch(() => {});
await page.evaluate(() => {
  const sr = document.getElementById("anagram-docs-overlay")?.shadowRoot;
  const openPage = [...(sr?.querySelectorAll(".bar button") ?? [])].find((b) => b.textContent.includes("Open as page"));
  openPage?.click();
});
await page.waitForURL(/mobilebasic/, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
const readingState = await page.evaluate((sel) => ({
  url: location.href.slice(0, 110),
  badges: document.querySelectorAll(sel).length,
  actionLabel: document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.textContent ?? null,
  readingStyle: !!document.querySelector('style[data-anagram="style"]'),
}), BADGE_SEL);
console.log("READING PAGE:", JSON.stringify(readingState, null, 2));
check("page view: mobilebasic badged with Back action", /mobilebasic/.test(readingState.url) && readingState.badges >= 1 && readingState.actionLabel === "Back to editor", JSON.stringify(readingState));

await page.evaluate(() => {
  document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.click();
});
await page.waitForURL(/\/edit/, { timeout: 20000 }).catch(() => {});
check("page view: Back returns to the editor", /\/edit/.test(page.url()), page.url().slice(0, 90));
check("no extension console errors", errors.length === 0, errors.join(" | "));

await context.close();
const pass = checks.every((c) => c.ok);
console.log("\n" + (pass ? "✅ DOCS FLOW GREEN" : "❌ DOCS FLOW FAILURES"));
process.exit(pass ? 0 : 1);
