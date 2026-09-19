// entrypoints/onboarding/main.ts — first-run welcome page.
//
// The page's one moving part is the setup strip at the top: three status rows that say,
// in a few words each, whether anything is actually going to happen. A new install sees
// nothing on real pages until the separately-installed daemon is started, so that row —
// and the one command that fixes it — is the first thing on the page, live, rather than
// a sentence in a footer. Each row is a dot AND words: the colour never carries the
// meaning alone.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { t, tn } from "../../lib/i18n";
import { ALL_SITES } from "../../lib/access/patterns";
import { accessSummary, requestAccess } from "../../lib/access/grant";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus } from "../../lib/messaging/protocol";

localizePage();
followSystemTheme();
const version = browser.runtime.getManifest().version;
document.getElementById("version")!.textContent = `v${version}`;
document.getElementById("ext-version")!.textContent = `v${version}`;

const START_CMD = "~/.anagram/bin/anagram start";
const UPDATE_CMD = "~/.anagram/bin/anagram update";
/** While the daemon is down the page re-asks often (a user who just ran the command
 *  should not have to reload); once it is up, one slow re-check is enough. */
const POLL_DOWN_MS = 3_000;
const POLL_UP_MS = 60_000;

const daemonRow = document.getElementById("row-daemon")!;
const daemonState = document.getElementById("daemon-state")!;
const daemonDetail = document.getElementById("daemon-detail")!;
const daemonCmd = document.getElementById("daemon-cmd")!;
const daemonCmdText = document.getElementById("daemon-cmd-text")!;
const daemonLink = document.getElementById("daemon-link")!;
const accessRow = document.getElementById("row-access")!;
const accessState = document.getElementById("access-state")!;
const accessGrant = document.getElementById("access-grant") as HTMLButtonElement;
const readyRow = document.getElementById("row-ready")!;
const readyText = document.getElementById("ready-text")!;
const install = document.getElementById("install")!;

/** Copy on an extension page: the Clipboard API is always there, so no textarea dance. */
function wireCopy(buttonId: string, text: () => string): void {
  const button = document.getElementById(buttonId) as HTMLButtonElement;
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(text()).then(
      () => {
        button.textContent = t("copied");
        setTimeout(() => {
          button.textContent = t("onbCopy");
        }, 1400);
      },
      () => {
        /* nothing to fall back to, and nothing to say — the command is on screen */
      },
    );
  });
}
const installCmd = document.getElementById("install-cmd")!;
wireCopy("daemon-copy", () => daemonCmdText.textContent ?? "");
wireCopy("install-copy", () => installCmd.textContent ?? "");

/** Paint the two live rows from one status answer. Returns whether the daemon is up. */
function render(s: BackendStatus | undefined): boolean {
  const up = s?.active === "server" && s.model != null;
  // Everything optional goes away first, so a row never keeps a stale detail beside a
  // fresh verdict; the elements themselves are reused, so nothing is rebuilt.
  daemonDetail.hidden = true;
  daemonCmd.hidden = true;
  daemonLink.hidden = true;
  let notInstalled = false;

  if (s && s.active === "server" && s.model) {
    daemonRow.dataset.state = "ok";
    daemonState.textContent = t("onbRunning");
    daemonDetail.textContent = `${s.model.id} · ${s.server.device ?? "cpu"}`;
    daemonDetail.hidden = false;
  } else if (s?.server.reason === "contract") {
    // Something IS listening, of another generation: the fix is an update, not a start.
    daemonRow.dataset.state = "bad";
    daemonState.textContent = t("onbMismatch");
    daemonCmdText.textContent = UPDATE_CMD;
    daemonCmd.hidden = false;
  } else if (s?.server.reason === "loopback") {
    // The configured URL is not local, so no probe was ever made — only the options
    // page can put that right.
    daemonRow.dataset.state = "bad";
    daemonState.textContent = t("onbNotLocal");
    daemonLink.hidden = false;
  } else {
    // Nothing answered — the same row whether the daemon was never installed or merely
    // is not started, so the install one-liner rides along under the card.
    daemonRow.dataset.state = "bad";
    daemonState.textContent = t("onbNotRunning");
    daemonCmdText.textContent = START_CMD;
    daemonCmd.hidden = false;
    notInstalled = true;
  }

  readyRow.dataset.state = up ? "ok" : "idle";
  readyText.textContent = up ? t("onbGo") : t("onbWaiting");
  install.hidden = !notInstalled;
  return up;
}

/**
 * The site-access row. A fresh install reads nothing until this is answered, so the row is
 * a state and one button: the browser's own prompt is the explanation, and the button is
 * gone once every site is granted. Somebody who would rather grant sites one at a time
 * does that from the popup on each site, and this row then counts them.
 */
async function renderAccess(): Promise<void> {
  const { all, sites } = await accessSummary();
  accessRow.dataset.state = all || sites.length > 0 ? "ok" : "idle";
  accessState.textContent = all
    ? t("accessAll")
    : sites.length > 0
      ? tn("accessSites", sites.length)
      : t("accessNone");
  accessGrant.hidden = all;
}
// The request is the first thing the click does: the browsers honour it only inside the
// user's gesture. The worker registers the content script and injects the open tabs.
accessGrant.addEventListener("click", () => {
  void requestAccess(ALL_SITES).then(renderAccess);
});
browser.permissions.onAdded.addListener(() => void renderAccess());
browser.permissions.onRemoved.addListener(() => void renderAccess());
void renderAccess();

let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;

function schedule(ms: number): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
}

async function tick(): Promise<void> {
  if (inFlight) return; // the call in progress will schedule the next one
  inFlight = true;
  let up = false;
  try {
    let s: BackendStatus | undefined;
    try {
      // `probe: true` — the cached verdict is up to 5 s old when the daemon is down,
      // which is most of the interval we poll on.
      s = (await browser.runtime.sendMessage({
        action: ACTIONS.GET_BACKEND_STATUS,
        probe: true,
      })) as BackendStatus | undefined;
    } catch {
      /* the service worker did not answer — same advice as a daemon that is not there */
    }
    up = render(s);
  } finally {
    inFlight = false;
  }
  // A hidden tab is never polled: the visibilitychange handler re-checks on return.
  if (document.visibilityState === "visible") schedule(up ? POLL_UP_MS : POLL_DOWN_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void tick();
  } else if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
});

void tick();
