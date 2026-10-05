// lib/ui/engineCard.ts — the engine card of the setup page and of Settings.
//
// With an engine in use it is that engine's panel: the local engine's (./componentSettings.ts,
// the install command and the component's lifecycle) or the in-browser engine's
// (./inBrowserEngine.ts, its download). Before one is chosen the device decides
// (lib/device.ts): the in-browser engine's download starts by itself where there is no
// choice; two cards offer both where the local engine is clearly better, the in-browser one
// highlighted, and nothing downloads until one is picked; the local engine alone where the
// browser cannot run the model; a plain message where the device cannot afford it. Picking
// the local engine asks the browser for Native Messaging first, in the click; a refusal
// comes back to the choice with a line saying so.
//
// In Settings the panel's own line of controls carries the switch between engines, both ways,
// and offers to delete what the in-browser engine left on disk once the local engine is in
// use. On the setup page, while the local engine keeps crashing, the panel offers the
// in-browser engine beside Retry.
import { browser } from "#imports";
import { t, type MessageKey } from "../i18n";
import { TIERS, decide, type Decision } from "../device";
import { chooseEngine, readEngine, requestNative, type Engine } from "../backend/engineChoice";
import { ACTIONS } from "../messaging/protocol";
import { storedModelBytes } from "../webengine/autoSetup";
import type { ComponentReply } from "../backend/nativeClient";
import { readDeviceInputs } from "./deviceInputs";
import * as nativePanel from "./componentSettings";
import * as inBrowserPanel from "./inBrowserEngine";
import { formatSize } from "./size";
import { IS_SAFARI } from "../surface";
import "./engineCard.css";

export interface EngineCardOptions {
  /** The card's title, renamed for what it shows; Settings has none. */
  title?: HTMLElement;
  /** Where the engine's panel goes (#componentSettings). */
  panelHost: HTMLElement;
  /** Settings: the switch beside the panel's controls. The setup page: the crash fallback beside Retry. */
  settings: boolean;
  /** Every status the panel reads, with the engine it belongs to; null while there is none. */
  /** `crashed`: the engine is set up and keeps dying (its card says it needs attention). */
  onUpdate?: (engine: Engine | null, reply: ComponentReply | null, crashed?: boolean) => void;
}


function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function button(key: MessageKey, variant?: string, ...subs: string[]): HTMLButtonElement {
  const b = element("button", t(key, ...subs), "btn");
  b.type = "button";
  if (variant) b.dataset.variant = variant;
  return b;
}

/** Whether the ready panel's snapshot says the engine can score. */
export function engineReady(engine: Engine | null, reply: ComponentReply | null): boolean {
  if (!engine || reply?.kind !== "ok") return false;
  return (engine === "native" ? nativePanel : inBrowserPanel).componentReady(reply.snapshot);
}

/** The engine's state in a few words, for Settings' version line. */
export function engineLabel(engine: Engine | null, reply: ComponentReply | null): string {
  if (!engine || !reply) return t("engineNotSetUp");
  return (engine === "native" ? nativePanel : inBrowserPanel).componentConnectionLabel(reply);
}

export function mountEngineCard(options: EngineCardOptions): { refresh(): void } {
  const { title, panelHost, settings } = options;

  // ---- the choice -----------------------------------------------------------------------
  const choice = element("div", undefined, "engine-choice"); choice.hidden = true;
  const cards = element("div", undefined, "engine-choice-cards");
  const oneClick = element("section", undefined, "engine-choice-card"); oneClick.dataset.engine = "inbrowser"; oneClick.dataset.recommended = "";
  const oneClickTitle = element("h3", t("engineOneClick"));
  oneClickTitle.id = "engine-choice-inbrowser";
  const badge = element("span", t("engineRecommended"), "badge"); badge.dataset.variant = "secondary";
  const oneClickHead = element("div", undefined, "engine-choice-head"); oneClickHead.append(oneClickTitle, badge);
  const oneClickTight = element("p", t("engineTight"), "engine-note"); oneClickTight.hidden = true;
  const oneClickButton = button("engineOneClickButton", undefined, formatSize(TIERS[0].bytes));
  oneClickButton.id = "engine-pick-inbrowser";
  oneClickButton.setAttribute("aria-describedby", "engine-choice-inbrowser");
  oneClick.setAttribute("aria-labelledby", oneClickTitle.id);
  oneClick.append(oneClickHead, element("p", t("engineOneClickWhat")), oneClickTight, oneClickButton);
  const terminal = element("section", undefined, "engine-choice-card"); terminal.dataset.engine = "native";
  const terminalTitle = element("h3", t("engineTerminal")); terminalTitle.id = "engine-choice-native";
  const terminalWhat = element("p", t("engineTerminalWhat"));
  const terminalButton = button("engineTerminalButton", "outline");
  terminalButton.id = "engine-pick-native";
  terminalButton.setAttribute("aria-describedby", "engine-choice-native");
  terminal.setAttribute("aria-labelledby", terminalTitle.id);
  terminal.append(terminalTitle, terminalWhat, terminalButton);
  cards.append(oneClick, terminal);
  const refused = element("p", "", "engine-error"); refused.setAttribute("role", "alert"); refused.hidden = true;
  choice.append(cards, refused);

  const cannot = element("p", "", "engine-cannot"); cannot.hidden = true;
  const tight = element("p", t("engineTight"), "engine-note engine-tight"); tight.hidden = true;

  // ---- Settings: switching, and what the in-browser engine left behind ------------------------
  // Both go into the panel's line of controls (`extra`), so they sit beside its own.
  const deleteLeftover = button("engineLeftoverDelete", "outline", ""); deleteLeftover.id = "engine-delete-leftover"; deleteLeftover.dataset.size = "sm"; deleteLeftover.hidden = true;
  const switchButton = button("engineSwitchToInBrowser", "outline"); switchButton.id = "engine-switch"; switchButton.dataset.size = "sm"; switchButton.hidden = true;
  const switchError = element("p", "", "engine-error"); switchError.setAttribute("role", "alert"); switchError.hidden = true;

  // The setup page's crash fallback, handed to the local engine's panel to show beside Retry.
  const fallback = button("engineSwitchToInBrowser", "outline"); fallback.id = "engine-crash-switch"; fallback.dataset.size = "sm";

  panelHost.before(choice, cannot);
  panelHost.after(tight, switchError);
  const safariNote = element("p", t("safariEngineTabNote"), "engine-note");
  safariNote.hidden = true;
  if (IS_SAFARI) panelHost.before(safariNote);

  let engine: Engine | null = null;
  let decision: Decision | null = null;
  /** The model tier the engine itself says it runs (its status), once it has said. */
  let engineTier: "fp32" | "fp16" | null = null;
  let panel: { refresh(): void; destroy(): void } | undefined;
  let busy = false;

  const setTitle = (key: MessageKey): void => { if (title) { title.textContent = t(key); title.dataset.i18n = key; } };

  /** What this device can run, read once. */
  let deciding: Promise<Decision> | null = null;
  const device = (): Promise<Decision> => deciding ??= readDeviceInputs().then(decide).then((d) => (decision = d));

  function show(next: Engine): void {
    engine = next;
    safariNote.hidden = !IS_SAFARI || next !== "inbrowser";
    choice.hidden = cannot.hidden = true;
    setTitle(next === "native" ? "componentTitle" : "engineTitle");
    panel?.destroy();
    panelHost.replaceChildren();
    panelHost.hidden = false;
    const crashAction = !settings && next === "native" && decision && decision.path !== null ? fallback : undefined;
    engineTier = null;
    panel = (next === "native" ? nativePanel : inBrowserPanel).mountComponentSettings(panelHost, (reply, crashed) => {
      if (reply.kind === "ok" && next === "inbrowser") { const before = engineTier; engineTier = reply.snapshot.tier ?? null; if (engineTier !== before) paintTight(); }
      options.onUpdate?.(next, reply, crashed === true);
    }, { crashAction, settings, extra: settings ? [switchButton, deleteLeftover] : [] });
    paintTight();
    void paintSwitch();
  }

  /** The in-browser engine on 4 GB: the computer may slow down while it scores. Not under the
   *  lighter model, which says its own line (lib/ui/inBrowserEngine.ts); but a lighter model that
   *  did not run here leaves FP32 in its place, and on 4 GB that is the note again. */
  function paintTight(): void {
    const lighter = engineTier === "fp16" || (engineTier === null && decision?.tier === "fp16");
    const slow = decision?.tier === "fp16" ? engineTier === "fp32" && decision.fallback?.tight === true : decision?.tight === true;
    tight.hidden = !(engine === "inbrowser" && !lighter && slow);
  }

  function showChoice(d: Decision): void {
    engine = null;
    safariNote.hidden = true;
    panel?.destroy(); panel = undefined;
    panelHost.replaceChildren(); panelHost.hidden = true;
    tight.hidden = switchError.hidden = true;
    if (d.offer === "cannot-run") {
      setTitle("engineCannotTitle");
      cannot.textContent = t(d.reason === "browser" ? "safariBrowserRequired" : d.reason === "webgpu" ? "safariWebGpuRequired" : "engineCannotRun");
      cannot.hidden = false; choice.hidden = true;
    } else {
      // Where the model does not fit but the local engine installs: one way to run it.
      setTitle(d.offer === "terminal-only" ? "componentTitle" : "engineChooseTitle");
      cannot.hidden = true; choice.hidden = false;
      oneClick.hidden = d.offer === "terminal-only";
      terminal.hidden = d.offer === "auto-inbrowser";
      // The lighter model says so where it is offered; FP32 on 4 GB says the computer may slow down.
      const bytes = TIERS.find((tier) => tier.id === d.tier)?.bytes ?? TIERS[0].bytes;
      oneClickButton.textContent = t("engineOneClickButton", formatSize(bytes));
      oneClickTight.textContent = t(d.tier === "fp16" ? "engineLighter" : "engineTight");
      oneClickTight.hidden = !(d.tight || d.tier === "fp16");
      terminalWhat.textContent = t(d.reason === "nvidia" ? "engineTerminalWhatNvidia"
        : d.os === "windows" ? "engineTerminalWhatWindows" : "engineTerminalWhat");
      if (d.offer === "terminal-only") { delete terminalButton.dataset.variant; } else terminalButton.dataset.variant = "outline";
    }
    options.onUpdate?.(null, null);
  }

  async function pickInBrowser(setup: "now" | "auto"): Promise<void> {
    if (busy) return;
    busy = true; paintBusy();
    try {
      // The model tier this device gets goes with the pick: the engine starts on it.
      const d = decision ?? await device().catch(() => null);
      const reply = await chooseEngine("inbrowser", setup, d?.tier ? { tier: d.tier, fallback: d.fallback !== null } : undefined);
      if (!reply.ok) { refused.textContent = t("engineSwitchFailed"); refused.hidden = false; return; }
      refused.hidden = true;
      show("inbrowser");
    } finally { busy = false; paintBusy(); }
  }

  /** The local engine: Native Messaging first, asked inside this click; then its panel. */
  function pickNative(onRefused: (text: string) => void): void {
    if (busy) return;
    busy = true; paintBusy();
    void requestNative().then(async (granted) => {
      if (!granted) { onRefused(t("engineNativeRefused")); return; }
      const reply = await chooseEngine("native");
      if (!reply.ok) { onRefused(t(reply.error === "permission" ? "engineNativeRefused" : "engineSwitchFailed")); return; }
      show("native");
    }).finally(() => { busy = false; paintBusy(); });
  }

  function paintBusy(): void {
    oneClickButton.disabled = terminalButton.disabled = switchButton.disabled = fallback.disabled = deleteLeftover.disabled = busy;
  }

  async function paintSwitch(): Promise<void> {
    if (!settings || !engine) { switchButton.hidden = deleteLeftover.hidden = true; return; }
    const d = await device();
    const current = engine;
    // To the in-browser engine where the device runs it; to the local one where it installs.
    const offered = current === "native" ? d.path !== null : d.native;
    switchButton.textContent = t(current === "native" ? "engineSwitchToInBrowser" : "engineSwitchToNative");
    switchButton.hidden = !offered;
    const bytes = current === "native" ? await storedModelBytes() : 0;
    if (engine !== current) return;
    deleteLeftover.hidden = bytes <= 0;
    deleteLeftover.textContent = bytes > 0 ? t("engineLeftoverDelete", formatSize(bytes)) : "";
  }

  oneClickButton.addEventListener("click", () => void pickInBrowser("now"));
  terminalButton.addEventListener("click", () => pickNative((text) => { refused.textContent = text; refused.hidden = false; }));
  fallback.addEventListener("click", () => void pickInBrowser("now"));
  switchButton.addEventListener("click", () => {
    switchError.hidden = true;
    if (engine === "inbrowser") pickNative((text) => { switchError.textContent = text; switchError.hidden = false; });
    else void pickInBrowser("now");
  });
  deleteLeftover.addEventListener("click", () => {
    if (busy) return;
    busy = true; paintBusy();
    void browser.runtime.sendMessage({ action: ACTIONS.DELETE_INBROWSER_MODEL }).then((reply: { ok?: boolean } | undefined) => {
      switchError.textContent = reply?.ok ? "" : t("engineSwitchFailed");
      switchError.hidden = !!reply?.ok;
    }, () => { switchError.textContent = t("engineSwitchFailed"); switchError.hidden = false; })
      .finally(() => { busy = false; paintBusy(); void paintSwitch(); });
  });

  async function start(): Promise<void> {
    const chosen = await readEngine();
    if (chosen) {
      // The crash fallback needs to know the device runs the in-browser engine.
      if (chosen === "native" && !settings) await device().catch(() => null);
      show(chosen);
      void device().then(paintTight, () => undefined);
      return;
    }
    const d = await device();
    if (d.offer === "auto-inbrowser") { await pickInBrowser("auto"); if (engine) return; }
    showChoice(d);
  }
  void start();

  return {
    refresh: () => { if (panel) panel.refresh(); else void start(); },
  };
}
