// entrypoints/onboarding/main.ts — first-run welcome page.
import { browser } from "#imports";

const manifest = browser.runtime.getManifest();
document.getElementById("version")!.textContent = `v${manifest.version}`;
document.getElementById("stub-note")!.textContent =
  "Development note: everything you just toured — chips, underlines, the ball, the Docs " +
  "reading mode — is final surface behavior, but scores still come from a deterministic " +
  "random stub while the real detection model is integrated. Don't trust the percentages yet.";
