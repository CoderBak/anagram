// entrypoints/onboarding/main.ts — first-run welcome page.
import { browser } from "#imports";

const manifest = browser.runtime.getManifest();
document.getElementById("version")!.textContent = `v${manifest.version}`;
document.getElementById("stub-note")!.textContent =
  "Development note: scores currently come from a deterministic random stub while the " +
  "real detection model is being integrated — the surface behavior you see is final.";
