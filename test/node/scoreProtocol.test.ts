// Native scoring payload validation: malformed results never become chips.
import { describe, expect, it } from "vitest";
import { ProtocolError, componentIsBehind, parseHealth, parseScoreResponse } from "../../lib/backend/scoreProtocol";

const MODEL = { id: "editlens_roberta-large", ver: "sha-abc", calibration: "buckets" };
const HEALTH = { ok: true, contract: "2.1", model: MODEL, n_buckets: 4, buckets: ["a", "b", "c", "d"], max_tokens: 512, device: "mps" };
const good = (id: string) => ({ id, bucket: 3, probs: [0.01, 0.02, 0.07, 0.9], score: 0.95, tokens: 80, truncated: false, lang: "en", lang_prob: 0.99 });

describe("parseHealth", () => {
  it("accepts component health and strips unknown fields", () => {
    const parsed = parseHealth({...HEALTH, extra:1});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) { expect(parsed.health.model).toEqual(MODEL); expect(parsed.health).not.toHaveProperty("extra"); }
  });
  it.each(["1.0", "3.0"])("reports incompatible contract %s even before schema validation", (contract) => {
    expect(parseHealth({contract,status:"different shape"})).toEqual({ok:false,reason:"contract",contract});
  });
  it.each([null, {}, {...HEALTH,n_buckets:3}, {...HEALTH,max_tokens:-1}, {...HEALTH,ok:false}])("rejects malformed health", (body) => {
    expect(parseHealth(body)).toEqual({ok:false,reason:"unreachable"});
  });
});

describe("componentIsBehind", () => {
  it("is true only when the component's release is lower than the extension's", () => {
    expect(componentIsBehind("0.3.2", "0.3.3")).toBe(true);
    expect(componentIsBehind("0.2.9", "0.10.0")).toBe(true); // compared as numbers, not text
    expect(componentIsBehind("0.3.3", "0.3.3")).toBe(false);
    expect(componentIsBehind("0.4.0", "0.3.3")).toBe(false); // a component ahead of us is fine
    expect(componentIsBehind("1.0", "1.0.0")).toBe(false); // a missing part is a zero
    expect(componentIsBehind("1.0.1", "1.0")).toBe(false);
  });

  it("treats a component that names no version as old, because every such component is", () => {
    for (const v of [undefined, null, "", "unknown", "0.3.3-dev"]) {
      expect(componentIsBehind(v, "0.3.3"), String(v)).toBe(true);
    }
  });

  it("never blames the component for something odd in our own manifest", () => {
    expect(componentIsBehind("0.1.0", "")).toBe(false);
  });
});

describe("parseScoreResponse", () => {
  const blocks = [{ id: "a", text: "one" }, { id: "b", text: "two", order: 1 }];

  it("returns validated results and the model named in the RESPONSE", async () => {
    const other = { ...MODEL, ver: "sha-new" };
    const body = ({ v: "2.1", model: other, results: [good("a"), good("b")] });
    const r = parseScoreResponse(body, blocks);
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
    const body = ({ v: "2.1", model: MODEL, results: [bad, good("b")] });
    expect(() => parseScoreResponse(body, blocks)).toThrow(ProtocolError);
  });

  it("rejects another contract major and a response matching no requested id", async () => {
    const body = ({ v: "99.0", model: MODEL, results: [good("a")] });
    expect(() => parseScoreResponse(body, blocks)).toThrow(ProtocolError);
    const missing = { v: "2.1", model: MODEL, results: [good("zzz")] };
    expect(() => parseScoreResponse(missing, blocks)).toThrow(ProtocolError);
  });

  it("accepts the language codes both detectors can produce", async () => {
    const body = ({ v: "2.1", model: MODEL, results: [{ ...good("a"), lang: "zh-CN" }, { ...good("b"), lang: "ceb" }] });
    const r = parseScoreResponse(body, blocks);
    expect(r.results.map((x) => x.lang)).toEqual(["zh-CN", "ceb"]);
  });

  it("keeps the first of duplicate ids and ignores strays", async () => {
    const body = ({ v: "2.1", model: MODEL, results: [good("a"), { ...good("a"), bucket: 0, probs: [1, 0, 0, 0], score: 0 }, good("stray"), good("b")] });
    const r = parseScoreResponse(body, blocks);
    expect(r.results.length).toBe(2);
    expect(r.results[0].bucket).toBe(3);
  });
});
