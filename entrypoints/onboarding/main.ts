// entrypoints/onboarding/main.ts — first-run welcome page.
import { browser } from "#imports";

const manifest = browser.runtime.getManifest();
document.getElementById("version")!.textContent = `v${manifest.version}`;
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus } from "../../lib/messaging/protocol";

const note = document.getElementById("stub-note")!;
void (async () => {
  try {
    const s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe: true,
    })) as BackendStatus | undefined;
    if (s?.active === "server") {
      note.textContent =
        `Scoring backend: ${s.model.id} running locally via anagramd (${s.server.device ?? "cpu"}). ` +
        "Nothing leaves this computer.";
      return;
    }
  } catch {
    /* fall through to the demo note */
  }
  note.textContent =
    "Demo mode: the local scoring daemon (anagramd) is not running, so chips show deterministic " +
    "placeholder numbers. Start it with `npm run serve` in the extension folder — Auto mode " +
    "picks it up on the next page load. Real scores come from pangram/editlens_roberta-large.";
})();
