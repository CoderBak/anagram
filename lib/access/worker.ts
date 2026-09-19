// lib/access/worker.ts — the service worker's half of optional site access.
//
// Nothing is declared in the manifest any more: the content script is registered at
// runtime, and its `matches` are exactly the origins the user has granted. Four things
// follow, and they are the whole module.
//
//  1. The registration FOLLOWS the grant. It is re-asserted whenever a grant changes, on
//     every install/update (an update wipes dynamic registrations) and on browser start,
//     and once when the worker wakes — an MV3 worker can be evicted between the grant and
//     the registerContentScripts call it was in the middle of, and nothing else would put
//     that right until the next restart.
//  2. A grant takes effect AT ONCE: the already-open tabs of the newly granted origins are
//     injected into, so nobody has to reload a page to see what they just asked for.
//  3. A removal takes effect at once too. The browser leaves an already-injected content
//     script running until the tab navigates, so every tab we can no longer see is told to
//     tear itself down — chips, marks, ball, observers, pending work.
//  4. `ensureInjected` is the way in for the one-off actions that have no grant behind
//     them at all, only `activeTab`: the context menus, the keyboard commands, the popup.
//
// The content script is safe to inject twice (entrypoints/content.ts guards on a flag in
// its isolated world), so every path here may overlap with any other.
import { browser } from "#imports";
import { ACTIONS } from "../messaging/protocol";
import type { PingReply } from "../messaging/protocol";
import { browsingOrigins, matchesAny } from "./patterns";
import { createLogger } from "../log";

const log = createLogger("access");

/** The one dynamic registration, and the file it runs. Built by WXT from
 *  entrypoints/content.ts, whose `registration: "runtime"` keeps it out of the manifest;
 *  test/node/permissions.test.ts pins that this path is what the build produces. */
const SCRIPT_ID = "anagram-content";
const CONTENT_SCRIPT = "/content-scripts/content.js";

/** How long `ensureInjected` waits for a freshly injected script to start listening.
 *  executeScript resolves when the file has been evaluated, which is before the async
 *  main() has read its settings and added its message listener. */
const PING_TRIES = 15;
const PING_GAP_MS = 100;

/**
 * Tabs a one-off action injected into with `activeTab` and no grant at all. They are not
 * covered by any origin the worker can see, so the teardown pass below would stop them
 * the next time some OTHER site's access is withdrawn. Worker memory only: a worker that
 * was evicted has no such tabs, which costs at most one interrupted one-off run.
 */
const oneShotTabs = new Set<number>();

/** Serialises every sync: two events in the same tick would otherwise both register. */
let chain: Promise<void> = Promise.resolve();

/** The registration the granted origins ask for, as one idempotent step. */
export function syncRegistration(): Promise<void> {
  chain = chain.then(syncNow, syncNow);
  return chain;
}

async function grantedMatches(): Promise<string[]> {
  const granted = await browser.permissions.getAll();
  return browsingOrigins(granted.origins);
}

async function syncNow(): Promise<void> {
  try {
    const matches = await grantedMatches();
    const registered = await browser.scripting
      .getRegisteredContentScripts({ ids: [SCRIPT_ID] })
      .catch(() => []);
    if (matches.length === 0) {
      if (registered.length > 0) await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      log.log("no site access — content script unregistered");
      return;
    }
    // The same options the manifest declaration carried before this was dynamic.
    const script = {
      id: SCRIPT_ID,
      matches,
      js: [CONTENT_SCRIPT],
      allFrames: true,
      runAt: "document_end" as const,
      persistAcrossSessions: true,
    };
    if (registered.length === 0) {
      // A registration that survived a restart but was not reported (or a duplicate id
      // from a race we lost) is an update, not a failure.
      await browser.scripting.registerContentScripts([script]).catch(() => browser.scripting.updateContentScripts([script]));
    } else if (!sameMatches(registered[0].matches ?? [], matches)) {
      await browser.scripting.updateContentScripts([script]);
    }
    log.log("registered on", matches.join(" "));
  } catch (e) {
    // Nothing else can be done here: the next event re-asserts, and every one-off action
    // still works through ensureInjected.
    log.log("registration failed", e);
  }
}

function sameMatches(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");
}

/**
 * Inject into the already-open tabs of just-granted origins, frames and all, so a grant
 * shows on the pages the user can see without them reloading anything. A tab that already
 * holds a script — one put there for a single action before the grant — refuses the second
 * injection (it would draw everything twice); the message is for that case, and is what
 * turns a one-off page into an ordinary one.
 */
async function injectGranted(origins: string[]): Promise<void> {
  if (origins.length === 0) return;
  const tabs = await browser.tabs.query({ url: origins }).catch(() => []);
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      oneShotTabs.delete(tab.id);
      await browser.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files: [CONTENT_SCRIPT] })
        .catch(() => undefined); // a tab that navigated away, or a page nobody may inject
      void browser.tabs
        .sendMessage(tab.id, { action: ACTIONS.ACCESS_GRANTED })
        .catch(() => undefined);
    }),
  );
}

/**
 * Stop every tab this extension may no longer read. A tab whose URL we cannot see is one
 * we have no permission for — that is the same test — so the pass is written the safe way
 * round: anything not covered by what is still granted is told to stop.
 */
async function stopWithdrawnTabs(): Promise<void> {
  const matches = await grantedMatches();
  const tabs = await browser.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (tab.id == null || oneShotTabs.has(tab.id)) continue;
    if (tab.url && matchesAny(matches, tab.url)) continue;
    void browser.tabs.sendMessage(tab.id, { action: ACTIONS.TEARDOWN }).catch(() => undefined);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Runs in the page's isolated world, ahead of the script itself — see ON_DEMAND in
 * entrypoints/content.ts. Injected as a function, so it carries no bundled code.
 *
 * A page that already holds a running script is left alone: the probe can miss one that
 * has not added its message listener yet (its main() is still reading the settings), and
 * marking THAT page would quietly stop an ordinary run on a site the user has granted.
 */
function markOnDemand(): void {
  const world = window as unknown as Record<string, boolean>;
  if (!world.__anagramContentScript) world.__anagramOnDemand = true;
}

/** Is a content script listening in this tab? Only the top frame is asked. */
async function ping(tabId: number): Promise<boolean> {
  try {
    const reply = (await browser.tabs.sendMessage(tabId, { action: ACTIONS.PING }, { frameId: 0 })) as
      | PingReply
      | undefined;
    return reply?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Make sure the content script is running in this tab, and say whether it is.
 *
 * Every worker path that talks to a tab's content script goes through here: with a grant
 * the script is already there and this is one message; with none, the action the user just
 * performed — a context-menu click, a keyboard command, opening the popup — has given the
 * extension `activeTab`, which is enough to inject into that one tab and no other. The
 * injected script is an ordinary run: it reads the settings and the site rules like any
 * other page, and it is gone when the tab navigates.
 *
 * A caller that has something to say should say it whether this returns true or false: a
 * page nobody may inject into (an extension page of our own, a browser page) can still be
 * listening on its own account.
 */
export async function ensureInjected(tabId: number): Promise<boolean> {
  if (await ping(tabId)) return true;
  // The flag first, in the same isolated world the content script will read it from: a
  // script that arrives this way analyzes nothing until the action asks it to, exactly as
  // it behaves on a site the user has switched off.
  await browser.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: markOnDemand })
    .catch(() => undefined);
  const injected = await browser.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: [CONTENT_SCRIPT] })
    // activeTab covers the frames of the tab it was granted for, but a page that refuses
    // an all-frames injection is still worth the top frame on its own.
    .catch(() =>
      browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] }).catch(() => null),
    );
  if (injected === null) return false;
  oneShotTabs.add(tabId);
  for (let i = 0; i < PING_TRIES; i++) {
    if (await ping(tabId)) return true;
    await sleep(PING_GAP_MS);
  }
  return false;
}

/**
 * Wire the worker to the grants. Called synchronously from the background entry, because
 * MV3 wakes a worker by re-running it and a listener added later would miss the event
 * that woke it.
 */
export function installAccess(): void {
  browser.permissions.onAdded.addListener((added) => {
    const origins = browsingOrigins(added.origins);
    void syncRegistration().then(() => injectGranted(origins));
  });
  browser.permissions.onRemoved.addListener(() => {
    void syncRegistration().then(stopWithdrawnTabs);
  });
  // An update wipes dynamic registrations; a browser restart brings back the persisted
  // one, which is re-asserted anyway in case a grant changed while the browser was shut.
  browser.runtime.onInstalled.addListener(() => void syncRegistration());
  browser.runtime.onStartup?.addListener(() => void syncRegistration());
  browser.tabs.onRemoved.addListener((tabId) => oneShotTabs.delete(tabId));
  // And once per worker life: the grant may have landed while this worker was evicted.
  void syncRegistration();
}
