// test/node/daemonClient.test.ts — the daemon-only client: loopback enforcement, probe
// caching while down, and provenance from the response.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { DaemonClient } from "../../lib/backend/getScoreClient";

const MODEL = { id: "editlens_roberta-large", ver: "sha-abc", calibration: "buckets" };
const HEALTH = { ok: true, contract: "2.1", model: MODEL, n_buckets: 4, buckets: ["a", "b", "c", "d"], max_tokens: 512, device: "mps" };

beforeEach(() => fakeBrowser.reset());
afterEach(() => vi.unstubAllGlobals());

describe("DaemonClient", () => {
  it("refuses a non-loopback daemon URL without ever fetching", async () => {
    await fakeBrowser.storage.local.set({ serverUrl: "http://evil.example:8765" });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const c = new DaemonClient();
    const s = await c.status(true);
    expect(s.active).toBe("down");
    expect(s.server.reason).toBe("loopback");
    expect(s.server.error).toMatch(/loopback/);
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(c.scoreBatch([{ id: "a", text: "x" }])).rejects.toThrow(/loopback/);
  });

  it("serves a URL this build has narrowed away with the default, and probes only that", async () => {
    // An address an older build accepted: loopback, but one no `connect-src` can name.
    await fakeBrowser.storage.local.set({ serverUrl: "http://[::1]:8765" });
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(String(url));
        return new Response(JSON.stringify(HEALTH), { status: 200 });
      }),
    );
    const c = new DaemonClient();
    const s = await c.status(true);
    expect(s.active).toBe("server");
    expect(s.serverUrl).toBe("http://127.0.0.1:8765");
    expect(asked).toEqual(["http://127.0.0.1:8765/health"]);
  });

  it("caches a failed probe for the down TTL and reports down", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    vi.stubGlobal("fetch", fetchFn);
    const c = new DaemonClient();
    const s = await c.status(false);
    expect(s.active).toBe("down");
    expect(s.server.reason).toBe("unreachable");
    // ONE probe is two requests now: the ordinary /health, and — because it never came
    // back — the `no-cors` question that tells a closed port from a daemon too old to
    // answer this extension (lib/backend/httpClient.ts). Here both fail, so: unreachable.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((await c.status(false)).active).toBe("down");
    expect(fetchFn).toHaveBeenCalledTimes(2); // within the 5 s down TTL, no second probe
    expect(c.isUp()).toBe(false);
    expect(c.model().id).toBe("none");
  });

  it("reports a daemon of another contract major as a version mismatch, not an outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...HEALTH, contract: "3.0" }), { status: 200 })),
    );
    const c = new DaemonClient();
    const s = await c.status(true);
    expect(s.active).toBe("down");
    expect(s.server.reason).toBe("contract");
    expect(s.server.contract).toBe("3.0");
    expect(s.server.error).toMatch(/contract 3\.0/);
  });

  it("goes up on a healthy probe and adopts the model a score response names", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) return new Response(JSON.stringify(HEALTH), { status: 200 });
      return new Response(
        JSON.stringify({ v: "2.1", model: { ...MODEL, ver: "sha-new" }, results: [{ id: "a", bucket: 0, probs: [0.9, 0.1, 0, 0], score: 0.03, tokens: 5 }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchFn);
    const c = new DaemonClient();
    const s = await c.status(true);
    expect(s.active).toBe("server");
    expect(s.model).toEqual(MODEL);
    const batch = await c.scoreBatch([{ id: "a", text: "x" }]);
    expect(batch.model.ver).toBe("sha-new");
    expect(c.model().ver).toBe("sha-new"); // provenance moved with the response
  });

  // The daemon and the extension are released together (one `npm run bump` sets both), and
  // an extension updates by itself in the background while the daemon on disk does not. So
  // the status carries whether the daemon is behind, and the pages ask for one command.
  it("says a daemon behind this extension needs updating, while it goes on scoring", async () => {
    fakeBrowser.runtime.getManifest = () => ({ version: "9.9.9" }) as ReturnType<typeof fakeBrowser.runtime.getManifest>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...HEALTH, app_version: "0.0.1" }), { status: 200 })),
    );
    const s = await new DaemonClient().status(true);
    expect(s.active).toBe("server"); // it works — the contract is what decides that
    expect(s.server.ok).toBe(true);
    expect(s.server.outdated).toBe(true);
    expect(s.server.reason).toBeUndefined();
  });

  it("says nothing about a daemon level with this extension", async () => {
    fakeBrowser.runtime.getManifest = () => ({ version: "0.3.3" }) as ReturnType<typeof fakeBrowser.runtime.getManifest>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...HEALTH, app_version: "0.3.3" }), { status: 200 })),
    );
    const s = await new DaemonClient().status(true);
    expect(s.server.outdated).toBe(false);
  });

  it("reports a daemon too old to answer at all as 'outdated', not as an outage", async () => {
    // No host permission, so a daemon that sends no CORS headers fails exactly like a
    // closed port. The opaque follow-up is what separates them, and the advice differs.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.mode === "no-cors") return new Response(null, { status: 200 });
        throw new TypeError("Failed to fetch");
      }),
    );
    const s = await new DaemonClient().status(true);
    expect(s.active).toBe("down");
    expect(s.server.reason).toBe("outdated");
    expect(s.server.outdated).toBe(true);
    expect(s.server.error).toMatch(/older than the extension/);
  });

  it("marks itself down when a batch fails, so the router reports the outage", async () => {
    let healthy = true;
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) {
        if (!healthy) throw new TypeError("refused");
        return new Response(JSON.stringify(HEALTH), { status: 200 });
      }
      throw new TypeError("refused");
    });
    vi.stubGlobal("fetch", fetchFn);
    const c = new DaemonClient();
    await c.status(true);
    expect(c.isUp()).toBe(true);
    healthy = false;
    await expect(c.scoreBatch([{ id: "a", text: "x" }])).rejects.toThrow();
    expect(c.isUp()).toBe(false);
  });
});
