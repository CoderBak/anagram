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
    await expect(c.scoreBatch([{ id: "a", text: "x", order: 0 }])).rejects.toThrow(/loopback/);
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
    expect((await c.status(false)).active).toBe("down");
    expect(fetchFn).toHaveBeenCalledTimes(1); // within the 5 s down TTL
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
    const batch = await c.scoreBatch([{ id: "a", text: "x", order: 0 }]);
    expect(batch.model.ver).toBe("sha-new");
    expect(c.model().ver).toBe("sha-new"); // provenance moved with the response
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
    await expect(c.scoreBatch([{ id: "a", text: "x", order: 0 }])).rejects.toThrow();
    expect(c.isUp()).toBe(false);
  });
});
