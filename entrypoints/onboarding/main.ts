// entrypoints/onboarding/main.ts — first-run welcome page.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";

followSystemTheme();
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
    if (s?.active === "server" && s.model) {
      note.textContent =
        `Scoring daemon: ${s.model.id} running locally via anagramd (${s.server.device ?? "cpu"}). ` +
        "Nothing leaves this computer.";
      return;
    }
  } catch {
    /* fall through to the not-running note */
  }
  note.textContent =
    "The local scoring daemon (anagramd) is not running, so paragraphs will show as Unavailable " +
    "until you start it with `npm run serve` in the extension folder — it is picked up automatically. " +
    "Scores come from pangram/editlens_roberta-large; nothing leaves this computer.";
})();
