// test/node/httpClient.test.ts — wire validation: nothing malformed becomes a chip.
import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpScoreClient, ProtocolError, fetchHealth } from "../../lib/backend/httpClient";

const MODEL = { id: "editlens_roberta-large", ver: "sha-abc", calibration: "buckets" };
const HEALTH = { ok: true, contract: "2.1", model: MODEL, n_buckets: 4, buckets: ["a", "b", "c", "d"], max_tokens: 512, device: "mps" };
const good = (id: string) => ({ id, bucket: 3, probs: [0.01, 0.02, 0.07, 0.9], score: 0.95, tokens: 80, truncated: false, lang: "en", lang_prob: 0.99 });

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchHealth", () => {
  it("accepts a healthy daemon and strips unknown keys", async () => {
    mockFetch({ ...HEALTH, extra: 1 });
    const h = await fetchHealth("http://127.0.0.1:1");
    expect(h?.model).toEqual(MODEL);
    expect((h as Record<string, unknown>).extra).toBeUndefined();
  });
  it("rejects a wrong bucket count, another contract major, or an HTTP error", async () => {
    mockFetch({ ...HEALTH, n_buckets: 3 });
    expect(await fetchHealth("http://127.0.0.1:1")).toBeNull();
    mockFetch({ ...HEALTH, contract: "1.0" });
    expect(await fetchHealth("http://127.0.0.1:1")).toBeNull();
    mockFetch(HEALTH, 500);
    expect(await fetchHealth("http://127.0.0.1:1")).toBeNull();
  });
});

describe("HttpScoreClient.scoreBatch", () => {
  const blocks = [{ id: "a", text: "one", order: 0 }, { id: "b", text: "two", order: 1 }];
  const client = () => new HttpScoreClient("http://127.0.0.1:1", MODEL);

  it("returns validated results and the model named in the RESPONSE", async () => {
    const other = { ...MODEL, ver: "sha-new" };
    mockFetch({ v: "2.1", model: other, results: [good("a"), good("b")] });
    const r = await client().scoreBatch(blocks);
    expect(r.model).toEqual(other);
    expect(r.results.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it.each([
    ["negative probability", { ...good("a"), probs: [-3, 0, 0, 0] }],
    ["probabilities not summing to 1", { ...good("a"), probs: [0.5, 0.5, 0.5, 0.5] }],
    ["bucket out of range", { ...good("a"), bucket: 7 }],
    ["score above 1", { ...good("a"), score: 1.5 }],
    ["negative token count", { ...good("a"), tokens: -4 }],
    ["language probability above 1", { ...good("a"), lang_prob: 9 }],
  ])("rejects %s as a ProtocolError", async (_name, bad) => {
    mockFetch({ v: "2.1", model: MODEL, results: [bad, good("b")] });
    await expect(client().scoreBatch(blocks)).rejects.toBeInstanceOf(ProtocolError);
  });

  it("rejects another contract major and a response matching no requested id", async () => {
    mockFetch({ v: "99.0", model: MODEL, results: [good("a")] });
    await expect(client().scoreBatch(blocks)).rejects.toBeInstanceOf(ProtocolError);
    mockFetch({ v: "2.1", model: MODEL, results: [good("zzz")] });
    await expect(client().scoreBatch(blocks)).rejects.toBeInstanceOf(ProtocolError);
  });

  it("keeps the first of duplicate ids and ignores strays", async () => {
    mockFetch({ v: "2.1", model: MODEL, results: [good("a"), { ...good("a"), bucket: 0, probs: [1, 0, 0, 0], score: 0 }, good("stray"), good("b")] });
    const r = await client().scoreBatch(blocks);
    expect(r.results.length).toBe(2);
    expect(r.results[0].bucket).toBe(3);
  });
});
