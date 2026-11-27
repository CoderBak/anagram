import { launchExtension, uiLanguage, uiLanguageOf, waitForRegistration } from "../harness.mjs";
import { deviceBuild } from "../test-build.mjs";
import { DEVICES } from "../pw/devices.mjs";
import { modelServer, realFiles } from "./model-server.mjs";
import release from "../../anagramd/detector-release.json" with { type: "json" };

/** Score sample documents in a fresh profile with the release pinned by the extension. */
export async function withScreenshotDetector(lang, capture) {
  const files = realFiles();
  if (!files) throw new Error(`Set ANAGRAM_MODELKIT to a local snapshot of ${release.release} to capture detector results.`);
  const server = await modelServer({ files });
  try {
    const language = lang === "en" ? {} : uiLanguage(lang);
    const run = await launchExtension({
      extDir: deviceBuild("linux-cpu", DEVICES["linux-cpu"]),
      ...language, args: [...(language.args ?? []), ...server.args],
    });
    try {
      const actual = (await uiLanguageOf(run.sw)).replace("_", "-").toLowerCase();
      if (actual !== lang.toLowerCase() && !(lang === "en" && actual.startsWith("en-"))) throw new Error(`Unexpected UI language: ${actual}`);
      const setup = run.context.pages().find(p => p.url().endsWith("/onboarding.html")) ??
        await run.context.waitForEvent("page", { predicate: p => p.url().endsWith("/onboarding.html") });
      await setup.locator("#tryParagraph").waitFor({ state: "visible", timeout: 300_000 });
      const status = await setup.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
      const model = status?.model;
      if (status?.engine !== "inbrowser" || model?.id !== release.release || !model.ver.startsWith(release.revision) || model.calibration !== "anagram-detector/1") {
        throw new Error(`Unexpected screenshot detector: ${JSON.stringify(model)}`);
      }
      await waitForRegistration(run.sw);
      await capture(run);
    } finally { await run.context.close(); }
  } finally { await server.close(); }
}
