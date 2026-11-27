// Optional measurements for test/inbrowser.mjs --real --measure-scans. The model is already
// warm. Every measured request uses fresh text so the verdict cache cannot answer it.
import { performance } from "node:perf_hooks";

const passage = "We spent the morning measuring the flow of the river at the old stone bridge. " +
  "After lunch the team walked upstream to compare the readings with observations from the previous week. ";

async function documentSession(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url);
    const session = await page.evaluate(async () => {
      const id = crypto.randomUUID();
      const port = chrome.runtime.connect({ name: "anagram-document" });
      window.scanBenchmarkPort = port;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Document session timed out")), 10000);
        port.onDisconnect.addListener(() => { clearTimeout(timer); reject(new Error("Document session closed")); });
        port.onMessage.addListener(message => {
          if (message.session === id) { clearTimeout(timer); resolve(); }
        });
        port.postMessage({ session: id });
      });
      return id;
    });
    return { page, session };
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function score({ page, session }, text) {
  const began = performance.now();
  const result = await page.evaluate(async ({ session, text }) => {
    const reply = await chrome.runtime.sendMessage({
      action: "scoreBatch", session,
      req: { v: "3.0", session, priority: "viewport", blocks: [{ id: crypto.randomUUID(), text }] },
    });
    const first = reply?.results?.[0];
    if (!first?.tokens || first.degraded || first.insufficient) throw new Error("The model did not score the benchmark passage");
    return { tokens: first.tokens, score: first.score };
  }, { session, text });
  return { ...result, ms: Math.round(performance.now() - began) };
}

export async function measureScanLatency(context, extensionId, runtime, model) {
  const url = `chrome-extension://${extensionId}/paste.html`;
  const current = await documentSession(context, url);
  try {
    await score(current, passage.repeat(2));
    const long = passage.repeat(37);
    const control = await score(current, long + " The observer recorded measurement 1. Another note.");
    const delayMs = Math.min(450, Math.max(10, Math.floor(control.ms / 12)));
    const replacements = [];
    for (const reading of [1, 9, 17]) {
      const previous = await documentSession(context, url);
      let finished = false;
      const pending = score(previous, long + ` The observer recorded measurement ${reading}.`)
        .then(() => { finished = true; }, error => error);
      try {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        const alreadyFinished = finished;
        const began = performance.now();
        await previous.page.close();
        const measured = await score(current, passage.repeat(2) + ` The recorder wrote down reading ${replacements.length}.`);
        const ms = Math.round(performance.now() - began);
        const error = await pending;
        if (error && !/closed|destroyed/i.test(error.message)) throw error;
        replacements.push({ ...measured, ms, oldScanFinishedBeforeClose: alreadyFinished });
      } finally { if (!previous.page.isClosed()) await previous.page.close(); }
    }
    return { browser: context.browser()?.version(), platform: process.platform, runtime, model, delayMs, control, replacements };
  } finally { await current.page.close(); }
}
