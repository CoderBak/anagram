// lib/ui/pdfRows.ts — the two PDF rows the setup page and Settings share: "Open PDFs in
// Anagram automatically" (the autoOpenPdfs setting) and "PDFs on this computer".
//
// The second one cannot be turned on from here. Chrome keeps "Allow access to file URLs" on
// the extension's details page, out of any extension's reach, so the row shows whether it is
// on and, while it is off, its button takes the person there (Firefox: the steps, in words).
// The button also asks for Anagram's own half, the file origin, in the same click; the row is
// on when both are.
import { browser } from "#imports";
import { t } from "../i18n";
import { settings } from "../settings/settings";
import { getFileAccess, openFileAccessSettings, requestFileAccess } from "../pdf/fileAccess";
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
  const state = switchInput("fileAccess"); state.disabled = true; state.hidden = true;
  const turnOn = el("button", "btn", t("optFileAccessTurnOn")); turnOn.type = "button"; turnOn.id = "fileAccessEnable";
  turnOn.dataset.variant = "outline"; turnOn.dataset.size = "sm"; turnOn.setAttribute("aria-describedby", "fileAccess");
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
    const note = el("p", "row-note", t("optReadAheadNote"));
    body.append(input);
    row.append(label, body, note, error);
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
    // Off, the button is the row's answer; a greyed-out switch beside it only repeats it.
    state.hidden = !state.checked;
    turnOn.hidden = state.checked;
    if (state.checked) steps.hidden = true;
  }
  async function showSteps(): Promise<void> {
    if (!await openFileAccessSettings()) {
      steps.textContent = t("optFileAccessFirefoxInstructions");
      steps.hidden = false;
      steps.focus();
    }
  }
  turnOn.addEventListener("click", () => {
    // The permission request keeps the click's activation only if nothing comes before it.
    const asked = requestFileAccess();
    turnOn.disabled = true;
    void asked.then(async (accepted) => {
      if (!accepted) { failed(true); return; }
      failed(false);
      if (!(await getFileAccess()).allowed) await showSteps();
    }).catch(() => failed(true)).finally(() => {
      turnOn.disabled = false;
      void refresh();
    });
  });
  window.addEventListener("focus", () => void refresh());
  browser.permissions.onAdded.addListener(() => void refresh());
  browser.permissions.onRemoved.addListener(() => void refresh());
  void refresh();
}
