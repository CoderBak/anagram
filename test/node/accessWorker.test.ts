// test/node/accessWorker.test.ts — the worker's half of optional site access.
//
// None of this can be driven in a browser suite: a permission prompt is native UI that no
// automation can click, and `activeTab` cannot be granted synthetically at all. So the
// three APIs that decide everything — permissions, scripting, tabs — are faked here and
// the module is asked the questions the product asks it: does a grant register the script
// and reach the tabs that are already open, does a withdrawal stop them, is any of it
// upset by the same event arriving twice or by a worker that was evicted halfway.
import { describe, expect, it, beforeEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { ACTIONS } from "../../lib/messaging/protocol";
import { ALL_SITES, matchesAny } from "../../lib/access/patterns";
import { ensureInjected, installAccess, syncRegistration } from "../../lib/access/worker";

const SCRIPT = "/content-scripts/content.js";
const SHADOW_SCRIPT = "/content-scripts/shadow.js";

interface Listener<A extends unknown[]> {
  addListener(fn: (...args: A) => void): void;
  emit(...args: A): void;
}

function event<A extends unknown[]>(): Listener<A> {
  const fns: ((...args: A) => void)[] = [];
  return {
    addListener: (fn) => void fns.push(fn),
    emit: (...args) => fns.forEach((fn) => fn(...args)),
  };
}

/** A tab as the fake browser knows it. `url` is undefined where we may not read it —
 *  which is exactly how a real tab looks once its site has been withdrawn. */
interface Tab {
  id: number;
  url?: string;
  /** Is a content script listening in it? */
  script?: boolean;
  /** Refuse an injection, the way a browser page does. */
  closed?: boolean;
}

/** Everything the module touches, recorded. `origins` starts empty because the
 *  extension requires no host permission of its own: what the browser reports granted is
 *  what the user granted. */
function environment(tabs: Tab[] = [], origins: string[] = [], opts: { refuseMainWorld?: boolean } = {}) {
  const registered: { id: string; matches: string[]; js: string[]; world?: string }[] = [];
  const calls = {
    /** The content script's matches, per register / update call. Its page-world companion
     *  follows it, and is checked on its own below. */
    register: [] as string[][],
    update: [] as string[][],
    unregister: 0,
    injected: [] as { tabId: number; allFrames: boolean; func: boolean }[],
    sent: [] as { tabId: number; action: string }[],
  };
  const onAdded = event<[{ origins?: string[] }]>();
  const onRemoved = event<[{ origins?: string[] }]>();
  const onInstalled = event<[{ reason: string }]>();
  const onStartup = event<[]>();
  const onTabRemoved = event<[number]>();
  const onTabUpdated = event<[number,{status?:string}]>();

  const permissions = {
    getAll: async () => ({ permissions: [], origins: [...origins] }),
    onAdded,
    onRemoved,
  };
  const scripting = {
    getRegisteredContentScripts: async ({ ids }: { ids: string[] }) =>
      registered.filter((s) => ids.includes(s.id)),
    registerContentScripts: async (scripts: typeof registered) => {
      for (const script of scripts) {
        if (opts.refuseMainWorld && script.world === "MAIN") throw new Error("Unexpected property \"world\"");
        if (registered.some((s) => s.id === script.id)) throw new Error("Duplicate script ID");
        if (script.id === "anagram-content") calls.register.push(script.matches);
        registered.push({ ...script });
      }
    },
    updateContentScripts: async (scripts: typeof registered) => {
      for (const script of scripts) {
        if (opts.refuseMainWorld && script.world === "MAIN") throw new Error("Unexpected property \"world\"");
        const found = registered.find((s) => s.id === script.id);
        if (!found) throw new Error("No script with ID");
        Object.assign(found, script);
        if (script.id === "anagram-content") calls.update.push(script.matches);
      }
    },
    unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
      calls.unregister += 1;
      for (let i = registered.length - 1; i >= 0; i--) {
        if (ids.includes(registered[i].id)) registered.splice(i, 1);
      }
    },
    executeScript: async ({
      target,
      files,
    }: {
      target: { tabId: number; allFrames?: boolean };
      files?: string[];
      func?: () => void;
    }) => {
      const tab = tabs.find((t) => t.id === target.tabId);
      if (!tab || tab.closed) throw new Error("Cannot access contents of the page");
      calls.injected.push({
        tabId: target.tabId,
        allFrames: target.allFrames === true,
        func: files === undefined,
      });
      if (files) tab.script = true;
      return [{frameId:0,documentId:`doc-${tab.id}`,result:files ? null : {session:crypto.randomUUID(),url:tab.url ?? "https://one-shot.test/"}}];
    },
  };
  const tabsApi = {
    query: async (info: { url?: string[] }) => {
      if (!info.url) return tabs.map((t) => ({ id: t.id, url: t.url }));
      return tabs.filter((t) => matchesAny(info.url!, t.url)).map((t) => ({ id: t.id, url: t.url }));
    },
    sendMessage: async (tabId: number, message: { action: string }) => {
      calls.sent.push({ tabId, action: message.action });
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab?.script) throw new Error("Could not establish connection");
      return message.action === ACTIONS.PING ? { ok: true } : undefined;
    },
    onRemoved: onTabRemoved,
    onUpdated: onTabUpdated,
  };

  Object.assign(fakeBrowser as unknown as Record<string, unknown>, {
    permissions,
    scripting,
    tabs: tabsApi,
  });
  Object.assign((fakeBrowser as unknown as { runtime: Record<string, unknown> }).runtime, {
    onInstalled,
    onStartup,
    onConnect: event<[unknown]>(),
  });

  return {
    calls,
    registered,
    tabs,
    events: { onAdded, onRemoved, onInstalled, onStartup },
    /** What the browser reports as granted from now on. */
    grant(...added: string[]) {
      origins = [...new Set([...origins, ...added])];
    },
    withdraw(...gone: string[]) {
      origins = origins.filter((o) => !gone.includes(o));
    },
  };
}

/** Let every promise the module chained settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => fakeBrowser.reset());

describe("the registration follows the grant", () => {
  it("registers nothing at all while no site is granted", async () => {
    const env = environment();
    installAccess();
    await settle();
    expect(env.calls.register).toEqual([]);
    expect(env.registered).toEqual([]);
  });

  it("registers on exactly the granted origins, with the options the manifest used to declare", async () => {
    const env = environment();
    env.grant("https://example.com/*");
    await syncRegistration();
    expect(env.calls.register).toEqual([["https://example.com/*"]]);
    expect(env.registered[0]).toMatchObject({
      id: "anagram-content",
      js: [SCRIPT],
      allFrames: true,
      runAt: "document_end",
      persistAcrossSessions: true,
    });
  });

  it("registers the page-world companion on the same origins, ahead of the page's scripts", async () => {
    const env = environment();
    env.grant("https://example.com/*");
    await syncRegistration();
    expect(env.registered.find((s) => s.id === "anagram-shadow")).toMatchObject({
      matches: ["https://example.com/*"],
      js: [SHADOW_SCRIPT],
      allFrames: true,
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: true,
    });
    env.grant(...ALL_SITES);
    await syncRegistration();
    expect(env.registered.find((s) => s.id === "anagram-shadow")?.matches).toEqual(["https://example.com/*", ...ALL_SITES]);
    env.withdraw("https://example.com/*", ...ALL_SITES);
    await syncRegistration();
    expect(env.registered).toEqual([]);
  });

  it("still registers the content script where the page world is refused", async () => {
    const env = environment([], [], { refuseMainWorld: true });
    env.grant("https://example.com/*");
    await syncRegistration();
    expect(env.registered.map((s) => s.id)).toEqual(["anagram-content"]);
  });

  it("never registers on the daemon's own hosts", async () => {
    // They are required permissions, so they are always granted; a content script there
    // would run on every page a local server puts out.
    const env = environment();
    await syncRegistration();
    expect(env.calls.register).toEqual([]);
    env.grant(...ALL_SITES);
    await syncRegistration();
    expect(env.calls.register).toEqual([ALL_SITES]);
  });

  it("widens an existing registration instead of registering a second one", async () => {
    const env = environment();
    env.grant("https://a.com/*");
    await syncRegistration();
    env.grant(...ALL_SITES);
    await syncRegistration();
    expect(env.calls.register).toHaveLength(1);
    expect(env.calls.update).toEqual([["https://a.com/*", ...ALL_SITES]]);
    expect(env.registered).toHaveLength(2);
  });

  it("does nothing when a sync finds what is already registered", async () => {
    const env = environment();
    env.grant("https://a.com/*");
    await syncRegistration();
    await syncRegistration();
    await syncRegistration();
    expect(env.calls.register).toHaveLength(1);
    expect(env.calls.update).toEqual([]);
  });

  it("unregisters when the last site is withdrawn", async () => {
    const env = environment();
    env.grant(...ALL_SITES);
    await syncRegistration();
    env.withdraw(...ALL_SITES);
    await syncRegistration();
    expect(env.calls.unregister).toBe(1);
    expect(env.registered).toEqual([]);
    // And a second withdrawal event does not unregister what is already gone.
    await syncRegistration();
    expect(env.calls.unregister).toBe(1);
  });

  it("survives two events landing in the same tick", async () => {
    const env = environment();
    env.grant(...ALL_SITES);
    await Promise.all([syncRegistration(), syncRegistration(), syncRegistration()]);
    expect(env.calls.register).toHaveLength(1);
    expect(env.registered).toHaveLength(2);
  });

  it("re-asserts itself on install, on startup and when the worker wakes", async () => {
    // An update wipes dynamic registrations, and a worker can be evicted between the
    // grant and the call it was making.
    const env = environment();
    env.grant(...ALL_SITES);
    installAccess(); // the wake
    await settle();
    expect(env.calls.register).toHaveLength(1);
    env.registered.length = 0; // as an update leaves it
    env.events.onInstalled.emit({ reason: "update" });
    await settle();
    expect(env.calls.register).toHaveLength(2);
    env.registered.length = 0;
    env.events.onStartup.emit();
    await settle();
    expect(env.calls.register).toHaveLength(3);
  });
});

describe("a grant reaches the tabs that are already open", () => {
  it("injects into them, all frames, and tells a one-off page it is an ordinary one now", async () => {
    const env = environment([
      { id: 1, url: "https://example.com/article" },
      { id: 2, url: "https://other.org/" },
    ]);
    installAccess();
    await settle();
    env.grant("https://example.com/*");
    env.events.onAdded.emit({ origins: ["https://example.com/*"] });
    await settle();
    expect(env.calls.register).toEqual([["https://example.com/*"]]);
    expect(env.calls.injected).toEqual([{ tabId: 1, allFrames: true, func: false }]);
    expect(env.calls.sent).toEqual([{ tabId: 1, action: ACTIONS.ACCESS_GRANTED }]);
  });

  it("is not upset by the same grant arriving twice", async () => {
    const env = environment([{ id: 1, url: "https://example.com/" }]);
    installAccess();
    await settle();
    env.grant("https://example.com/*");
    env.events.onAdded.emit({ origins: ["https://example.com/*"] });
    env.events.onAdded.emit({ origins: ["https://example.com/*"] });
    await settle();
    expect(env.calls.register).toHaveLength(1);
    expect(env.calls.update).toEqual([]);
    expect(env.calls.injected).toHaveLength(2); // the script itself refuses the second run
  });

  it("ignores a grant that is not a site at all", async () => {
    // Firefox asks for clipboardWrite the same way, from the diagnostics menu.
    const env = environment([{ id: 1, url: "https://example.com/" }]);
    installAccess();
    await settle();
    env.events.onAdded.emit({ permissions: ["clipboardWrite"] } as { origins?: string[] });
    await settle();
    expect(env.calls.register).toEqual([]);
    expect(env.calls.injected).toEqual([]);
  });
});

describe("a withdrawal stops the pages at once", () => {
  it("tells every tab it may no longer read to tear itself down, and leaves the others alone", async () => {
    const env = environment([
      { id: 1, url: undefined, script: true }, // withdrawn: the URL is not ours to read
      { id: 2, url: "https://kept.com/", script: true },
      { id: 3, url: "chrome://extensions", script: false },
    ]);
    env.grant("https://kept.com/*", "https://gone.com/*");
    installAccess();
    await settle();
    env.withdraw("https://gone.com/*");
    env.events.onRemoved.emit({ origins: ["https://gone.com/*"] });
    await settle();
    const teardowns = env.calls.sent.filter((c) => c.action === ACTIONS.TEARDOWN);
    expect(teardowns.map((c) => c.tabId).sort()).toEqual([1, 3]);
    expect(env.calls.update).toEqual([["https://kept.com/*"]]);
  });

  it("leaves a page that was injected for one action alone", async () => {
    // It runs on `activeTab`, not on any grant, so no origin covers it and the pass above
    // would otherwise stop the very run the user just asked for.
    const env = environment([
      { id: 7, url: undefined },
      { id: 8, url: undefined, script: true },
    ]);
    env.grant("https://gone.com/*");
    installAccess();
    await settle();
    await ensureInjected(7);
    env.withdraw("https://gone.com/*");
    env.events.onRemoved.emit({ origins: ["https://gone.com/*"] });
    await settle();
    const stopped = env.calls.sent.filter((c) => c.action === ACTIONS.TEARDOWN).map((c) => c.tabId);
    expect(stopped).toEqual([8]);
  });
});

describe("ensureInjected", () => {
  it("says yes without injecting anything when the script is already there", async () => {
    const env = environment([{ id: 1, url: "https://a.com/", script: true }]);
    expect(await ensureInjected(1)).toBe(true);
    expect(env.calls.injected).toEqual([{tabId:1,allFrames:true,func:true}]);
  });

  it("marks the page as a one-off BEFORE the script arrives, then waits for it to answer", async () => {
    // The flag is what keeps an injected page from analyzing anything on its own: it has
    // to be in the isolated world before the script reads it.
    const env = environment([{ id: 4, url: "https://a.com/" }]);
    expect(await ensureInjected(4)).toBe(true);
    expect(env.calls.injected).toEqual([
      { tabId: 4, allFrames: true, func: true },
      { tabId: 4, allFrames: true, func: false },
    ]);
    expect(env.calls.sent.filter((c) => c.action === ACTIONS.PING).length).toBeGreaterThanOrEqual(2);
  });

  it("says no on a page nobody may inject into", async () => {
    const env = environment([{ id: 5, url: "chrome://extensions", closed: true }]);
    expect(await ensureInjected(5)).toBe(false);
    expect(env.calls.injected).toEqual([]);
  });
});
