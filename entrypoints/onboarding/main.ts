// entrypoints/onboarding/main.ts — first-run welcome page.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";

followSystemTheme();
const manifest = browser.runtime.getManifest();
document.getElementById("version")!.textContent = `v${manifest.version}`;
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus } from "../../lib/messaging/protocol";
import { CONTRACT_VERSION } from "../../lib/contract";

const note = document.getElementById("backend-note")!;
void (async () => {
  let s: BackendStatus | undefined;
  try {
    s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe: true,
    })) as BackendStatus | undefined;
  } catch {
    /* the service worker did not answer — fall through to the not-running note */
  }
  if (s?.active === "server" && s.model) {
    note.textContent =
      `Scoring daemon: ${s.model.id} running locally via anagramd (${s.server.device ?? "cpu"}). ` +
      "Nothing leaves this computer.";
    return;
  }
  if (s?.server.reason === "contract") {
    // A daemon is there, just of another generation: point at the update, not the start.
    note.textContent =
      `A scoring daemon answers at ${s.serverUrl}, but it speaks contract ${s.server.contract ?? "?"} ` +
      `and this extension needs ${CONTRACT_VERSION.split(".")[0]}.x, so paragraphs will show as ` +
      "Unavailable until you update it: ~/.anagram/bin/anagram update.";
    return;
  }
  note.textContent =
    "The local scoring daemon (anagramd) is not running, so paragraphs will show as Unavailable " +
    "until you start it: ~/.anagram/bin/anagram start (or `npm run serve` from a source checkout) — it is " +
    "picked up automatically. Scores come from pangram/editlens_roberta-large; nothing leaves this computer.";
})();
