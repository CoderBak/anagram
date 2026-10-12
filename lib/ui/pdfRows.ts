// lib/ui/pdfRows.ts — the two PDF rows the setup page and Settings share: "Open PDFs in
// Anagram automatically" (the autoOpenPdfs setting) and "PDFs on this computer".
//
// The second is a switch like the first, on when Anagram holds the file origin and the
// browser's own "Allow access to file URLs" is on. Turning it on asks for the origin; Chrome keeps
// its own switch on the extension's details page, out of any extension's reach, so while that is
// off the row says so and opens the page (Firefox: the steps, in words). Off gives the origin back.
import { browser } from "#imports";
import { t } from "../i18n";
import { settings } from "../settings/settings";
import { FILE_ORIGIN, getFileAccess, openFileAccessSettings, requestFileAccess } from "../pdf/fileAccess";
import { bindConfirmedToggle } from "./confirmedToggle";
import { FILE_URL_ACCESS_SUPPORTED } from "../surface";
import "./rows.css";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function switchInput(id: string): HTMLInputElement {
  const input = el("input");
  input.id = id; input.className = "input"; input.type = "checkbox"; input.setAttribute("role", "switch");
  return input;
}

/** Append the rows to `host` (a `.rows` container); `readAhead`, Settings', adds the switch for
 *  reading a document's pages before they are scrolled to. */
export function mountPdfRows(host: HTMLElement, { readAhead = false }: { readAhead?: boolean } = {}): void {
  const auto = el("div", "row");
  const autoLabel = el("label", undefined, t("optAutoOpenPdfs")); autoLabel.htmlFor = "autoOpenPdfs";
  const autoBody = el("div", "row-body");
  const autoInput = switchInput("autoOpenPdfs");
  const autoError = el("p", "row-error"); autoError.id = "pdfSettingsError"; autoError.setAttribute("role", "alert"); autoError.hidden = true;
  autoBody.append(autoInput);
  auto.append(autoLabel, autoBody, autoError);

  const local = el("div", "row"); local.id = "local-pdfs";
  const localLabel = el("label", undefined, t("optLocalPdfs")); localLabel.htmlFor = "fileAccess";
  const localBody = el("div", "row-body");
  // A switch like the others: on asks for the permission (and, where the browser keeps a switch of
  // its own for file URLs, opens it), off gives the permission back.
  const state = switchInput("fileAccess");
  // Safari's way in instead of the switch (below); elsewhere it stays hidden.
  const turnOn = el("button", "btn"); turnOn.type = "button"; turnOn.id = "fileAccessEnable";
  turnOn.dataset.variant = "outline"; turnOn.dataset.size = "sm";
  turnOn.hidden = true;
  localBody.append(state, turnOn);
  const steps = el("p", "row-note"); steps.id = "fileAccessInstructions"; steps.tabIndex = -1; steps.setAttribute("role", "status"); steps.hidden = true;
  const localError = el("p", "row-error"); localError.id = "fileAccessError"; localError.setAttribute("role", "alert"); localError.hidden = true;
  local.append(localLabel, localBody, steps, localError);
  host.append(auto, local);

  const failedIn = (line: HTMLElement) => (bad: boolean): void => {
    line.textContent = bad ? t("optSaveFailed") : "";
    line.hidden = !bad;
  };
  bindConfirmedToggle(autoInput, settings.autoOpenPdfs, failedIn(autoError));
  if (readAhead) {
    const row = el("div", "row");
    const label = el("label", undefined, t("optReadAhead")); label.htmlFor = "pdfReadAhead";
    const body = el("div", "row-body");
    const input = switchInput("pdfReadAhead");
    const error = el("p", "row-error"); error.setAttribute("role", "alert"); error.hidden = true;
    body.append(input);
    row.append(label, body, error);
    auto.after(row);
    bindConfirmedToggle(input, settings.pdfReadAhead, failedIn(error));
  }
  if (!FILE_URL_ACCESS_SUPPORTED) {
    state.remove();
    localLabel.removeAttribute("for");
    turnOn.textContent = t("safariOpenPdf");
    turnOn.hidden = false;
    turnOn.removeAttribute("aria-describedby");
    turnOn.addEventListener("click", () => void browser.tabs.create({ url: browser.runtime.getURL("/reader.html") }));
    steps.textContent = t("safariLocalPdfNote");
    steps.hidden = false;
    return;
  }
  const failed = failedIn(localError);

  let generation = 0;
  async function refresh(): Promise<void> {
    const mine = ++generation;
    const { granted, allowed } = await getFileAccess();
    if (mine !== generation) return;
    state.checked = granted && allowed;
    if (state.checked) steps.hidden = true;
  }
  async function showSteps(): Promise<void> {
    if (!await openFileAccessSettings()) {
      steps.textContent = t("optFileAccessFirefoxInstructions");
      steps.hidden = false;
      steps.focus();
    }
  }
  state.addEventListener("change", () => {
    if (!state.checked) {
      steps.hidden = true;
      void browser.permissions.remove({ origins: [FILE_ORIGIN] }).catch(() => false).finally(() => void refresh());
      return;
    }
    // The permission request keeps the change's activation only if nothing comes before it.
    const asked = requestFileAccess();
    state.disabled = true;
    void asked.then(async (accepted) => {
      // Declined: the switch goes back off, which says so.
      failed(false);
      if (!accepted) return;
      if (!(await getFileAccess()).allowed) {
        // The browser's own switch is still off: say where it is, open it where we can, and
        // come on once it is on (refresh on focus).
        steps.textContent = t("optFileAccessChromeHint");
        steps.hidden = false;
        await showSteps();
      }
    }).catch(() => failed(true)).finally(() => {
      state.disabled = false;
      void refresh();
    });
  });
  window.addEventListener("focus", () => void refresh());
  browser.permissions.onAdded.addListener(() => void refresh());
  browser.permissions.onRemoved.addListener(() => void refresh());
  void refresh();
}
