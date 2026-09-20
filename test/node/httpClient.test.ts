// test/node/httpClient.test.ts — wire validation: nothing malformed becomes a chip.
import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpScoreClient, ProtocolError, fetchHealth } from "../../lib/backend/httpClient";

const MODEL = { id: "editlens_roberta-large", ver: "sha-abc", calibration: "buckets" };
const HEALTH = { ok: true, contract: "2.1", model: MODEL, n_buckets: 4, buckets: ["a", "b", "c", "d"], max_tokens: 512, device: "mps" };
const good = (id: string) => ({ id, bucket: 3, probs: [0.01, 0.02, 0.07, 0.9], score: 0.95, tokens: 80, truncated: false, lang: "en", lang_prob: 0.99 });

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchHealth", () => {
  it("accepts a healthy daemon and strips unknown keys", async () => {
    mockFetch({ ...HEALTH, extra: 1 });
    const r = await fetchHealth("http://127.0.0.1:1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.health.model).toEqual(MODEL);
    expect((r.health as Record<string, unknown>).extra).toBeUndefined();
  });

  it.each([
    ["a daemon of an older major", { ...HEALTH, contract: "1.0" }, "1.0"],
    ["a daemon of a newer major", { ...HEALTH, contract: "3.0" }, "3.0"],
    // A future major is free to change the shape of /health too, so the contract is
    // read before the schema — the advice is still "update", not "start".
    ["a newer major with an unrecognizable body", { contract: "3.0", status: "fine" }, "3.0"],
  ])("reports %s as a contract mismatch", async (_name, body, contract) => {
    mockFetch(body);
    const r = await fetchHealth("http://127.0.0.1:1");
    expect(r).toEqual({ ok: false, reason: "contract", contract });
  });

  it("reports a wrong bucket count, an HTTP error, a non-JSON body and a refused connection as unreachable", async () => {
    mockFetch({ ...HEALTH, n_buckets: 3 });
    expect(await fetchHealth("http://127.0.0.1:1")).toEqual({ ok: false, reason: "unreachable" });
    mockFetch(HEALTH, 500);
    expect(await fetchHealth("http://127.0.0.1:1")).toEqual({ ok: false, reason: "unreachable" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>nope</html>", { status: 200 })));
    expect(await fetchHealth("http://127.0.0.1:1")).toEqual({ ok: false, reason: "unreachable" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection refused");
    }));
    expect(await fetchHealth("http://127.0.0.1:1")).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("redirects", () => {
  it("never lets a redirect carry the request (page text) somewhere else", async () => {
    const health = mockFetch(HEALTH);
    await fetchHealth("http://127.0.0.1:1");
    expect(health.mock.calls[0][1]?.redirect).toBe("error");

    const score = mockFetch({ v: "2.1", model: MODEL, results: [good("a")] });
    await new HttpScoreClient("http://127.0.0.1:1", MODEL).scoreBatch([{ id: "a", text: "one" }]);
    expect(score.mock.calls[0][1]?.redirect).toBe("error");
  });
});

describe("HttpScoreClient.scoreBatch", () => {
  const blocks = [{ id: "a", text: "one" }, { id: "b", text: "two", order: 1 }];
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
    // `lang` ends up in chip text and card markup; only a language code may get there.
    ["markup in the language field", { ...good("a"), lang: "<img src>" }],
    ["a language field that is not a code", { ...good("a"), lang: "english!" }],
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

  it("accepts the language codes both detectors can produce", async () => {
    mockFetch({ v: "2.1", model: MODEL, results: [{ ...good("a"), lang: "zh-CN" }, { ...good("b"), lang: "ceb" }] });
    const r = await client().scoreBatch(blocks);
    expect(r.results.map((x) => x.lang)).toEqual(["zh-CN", "ceb"]);
  });

  it("keeps the first of duplicate ids and ignores strays", async () => {
    mockFetch({ v: "2.1", model: MODEL, results: [good("a"), { ...good("a"), bucket: 0, probs: [1, 0, 0, 0], score: 0 }, good("stray"), good("b")] });
    const r = await client().scoreBatch(blocks);
    expect(r.results.length).toBe(2);
    expect(r.results[0].bucket).toBe(3);
  });
});
