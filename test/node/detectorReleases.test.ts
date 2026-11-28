import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRelease,
  setupCatalog,
  detectorBytes,
  listDetectorReleases,
  releaseName,
  resolveDetectorRelease,
  validRelease,
} from "../../lib/detectorReleases";
import { addRead, emptyTally } from "../../lib/stats/model";
import { band } from "../../lib/render/band";
import { detectorScore } from "../../lib/webengine/detectorScore";
import { checkQwenConfig, type DetectorConfig, labeledCharacterBucket } from "../../lib/detectorFormat";
import { unitVerdict, meanVerdict } from "../../lib/capture/windows";

afterEach(() => vi.unstubAllGlobals());
describe("dated detector releases", () => {
  it("accepts published release names and a 20 MB tokenizer while keeping the other metadata limits", () => {
    for (const release of ["2026-11-28-400m-ettin_research", "2026-11-28-0.8b-qwen3.5_research"]) {
      expect(releaseName(release)).toBe(true);
      const pin = { ...defaultRelease, release, files: defaultRelease.files.map(f =>
        f.path === "tokenizer/tokenizer.json" ? { ...f, size_bytes: 19989339 } : f) };
      expect(validRelease(pin)).toBe(true);
      expect(validRelease({ ...pin, files: pin.files.map(f => f.path === "crf.json" ? { ...f, size_bytes: 19989339 } : f) })).toBe(false);
    }
    for (const name of ["0.0b-test", "0b-test", "0.8b-qwen..test", "0.8b-../test", "0.8b-%2f"]) {
      expect(releaseName("2026-11-28-" + name)).toBe(false);
    }
  });

  it("applies the published thresholds to all labeled characters and to combined readings", async () => {
    const result = await detectorScore("A. four.", {
      clsId: -1, sepId: -1, encodeWithOffsets: () => ({ ids: [7, 8], offsets: [[0, 2], [3, 8]] }),
    }, { min_words: 1, window: 512, stride: 256, architecture: "qwen3_5_text", document_fraction_basis: "all_labeled_characters" }, {
      W: [[1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0]],
      alpha: [0, 0, 0], delta: [0, 0, 0], lambda: 0, gamma: 0, l_min: 1,
    }, async ids => {
      expect(ids).toEqual([7, 8]);
      return { token: Float32Array.of(5, 0, 0, 0, 0, 5), segment: new Float32Array(15), mixed: new Float32Array(2) };
    });
    expect(result).toMatchObject({ probs: [3/8, 0, 5/8], bucket: 1, sentenceLabels: [0, 2] });
    const pass = { ...result, id: "p" };
    expect(meanVerdict("p", [{ result: pass, chars: 8 }])?.bucket).toBe(1);
    expect(unitVerdict("p", 12, [{ start: 0, end: 8, result: pass }, { start: 4, end: 12, result: pass }]).result.bucket).toBe(1);
    expect(labeledCharacterBucket([9, 0, 1], 10)).toBe(0);
    expect(labeledCharacterBucket([0, 4, 6], 10)).toBe(2);
  });

  it("validates the Qwen layer shapes and reads the attention order from config", () => {
    const cfg = { model_type: "qwen3_5_text", hidden_size: 1024, num_hidden_layers: 2, vocab_size: 100,
      num_attention_heads: 8, num_key_value_heads: 2, head_dim: 256, linear_num_key_heads: 16,
      linear_num_value_heads: 16, linear_key_head_dim: 128, linear_value_head_dim: 128, linear_conv_kernel_dim: 4,
      intermediate_size: 3584, hidden_act: "silu", rms_norm_eps: 1e-6, attn_output_gate: true, attention_bias: false,
      rope_parameters: { rope_type: "default", rope_theta: 1e7, partial_rotary_factor: .25 }, layer_types: ["full_attention", "linear_attention"] };
    const check = (c: typeof cfg) => checkQwenConfig(c as unknown as DetectorConfig, 512);
    expect(() => check(cfg)).not.toThrow();
    expect(() => check({ ...cfg, head_dim: 128 })).toThrow();
    expect(() => check({ ...cfg, layer_types: ["full_attention", "new_attention"] })).toThrow();
  });

  it("weights decoded sentences by non-whitespace Unicode characters", async () => {
    const result = await detectorScore("A. 🍎abc.", {
      clsId: 0, sepId: 1, encodeWithOffsets: () => ({ ids: [2, 3], offsets: [[0, 2], [3, 8]] }),
    }, { min_words: 1, window: 512, stride: 256 }, {
      W: [[1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0]],
      alpha: [0, 0, 0], delta: [0, 0, 0], lambda: 0, gamma: 0, l_min: 1,
    }, async () => ({
      token: Float32Array.from([0, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0]),
      segment: new Float32Array(15), mixed: new Float32Array(2),
    }));
    expect(result.sentenceLabels).toEqual([0, 2]);
    expect(result.score).toBe(5 / 7);
  });

  it("discovers newly published sizes and optional tags without fetching weights", async () => {
    const next = { name: "2026-12-02-1.2b-preview-2", targetCommit: "a".repeat(40) };
    const fetch = vi.fn(async () =>
      Response.json({
        branches: [next, { name: "main", targetCommit: next.targetCommit }],
        tags: [
          { name: "2026-11-30-100m", targetCommit: "b".repeat(40) },
          next,
          { name: "2026-02-31-400m", targetCommit: next.targetCommit },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await listDetectorReleases()).toEqual([
      { release: next.name, revision: next.targetCommit },
      { release: "2026-11-30-100m", revision: "b".repeat(40) },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toContain(
      "https://huggingface.co/api/models/CoderBak/anagram-detectors/refs",
    );
  });
  it.each([true, false])("reads the default size even if the refs list is gated (%s)", async listed => {
    const other = {name: "2026-12-12-1b", targetCommit: "a".repeat(40)};
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/refs")) return listed ? Response.json({branches: [other]}) : new Response(null, {status: 401});
      expect(url).toContain("/revision/default?blobs=true");
      return Response.json({sha: defaultRelease.revision, siblings: [
        ...defaultRelease.files.map(f => ({rfilename: f.path, size: f.size_bytes})),
        {rfilename: "README.md", size: 10000000},
      ]});
    });
    vi.stubGlobal("fetch", fetcher);
    const catalog = await setupCatalog();
    expect(catalog.listed).toBe(listed);
    expect(catalog.recommended?.revision).toBe(defaultRelease.revision);
    expect(detectorBytes(catalog.recommended!)).toBe(1582812701);
    expect(catalog.choices).toHaveLength(listed ? 2 : 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps the bundled revision available offline and restricts selections to the known file layout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("offline");
      }),
    );
    expect(await resolveDetectorRelease(defaultRelease)).toEqual(defaultRelease);
    expect(validRelease(defaultRelease)).toBe(true);
    expect(validRelease({ ...defaultRelease, repository: "other/repo" })).toBe(false);
    expect(
      validRelease({
        ...defaultRelease,
        files: [...defaultRelease.files.slice(1), defaultRelease.files[1]!],
      }),
    ).toBe(false);
    expect(releaseName("2026-12-01-400m/../../main")).toBe(false);
  });
  it("keeps three-class verdicts and historical reading statistics distinct", () => {
    const r = { id: "p", bucket: 1, probs: [0, 1, 0], score: 0.5 };
    expect(band(r)).toBe("assisted");
    expect(
      unitVerdict("p", 10, [
        { start: 0, end: 6, result: r },
        { start: 4, end: 10, result: r },
      ]).result,
    ).toMatchObject(r);
    const t = addRead(emptyTally(), 100, r.probs, null);
    addRead(t, 10, [0, 0, 1, 0], null);
    expect(t.expected).toEqual([0, 0, 10, 0, 100]);
  });
  it("declines a short passage before encoding or inference", async () => {
    const run = vi.fn();
    const r = await detectorScore("A brief passage.", null!, { min_words: 50 } as never, null!, run);
    expect(r.insufficient).toBe(true);
    expect(band({ ...r, id: "short" })).toBe("short");
    expect(run).not.toHaveBeenCalled();
  });
});

it("pins an added branch to its requested commit and obtains a weight digest without requesting the weight", async () => {
  const release = "2026-12-01-200m-ettin_research",
    revision = "a".repeat(40);
  const meta = {
    format: "anagram-detector/1",
    classes: ["human", "ai_assisted", "ai_generated"],
    heads: ["token", "segment", "mixed"],
    release_id: release,
    document_fraction_basis: "all_labeled_characters",
    architecture: "modernbert",
    language: "en",
    release_date: "2026-12-01",
    size: "200m",
    window: 512,
    stride: 256,
    min_words: 50,
  };
  const cfg = {
    model_type: "modernbert",
    hidden_activation: "gelu",
    norm_eps: 1e-5,
    hidden_size: 512,
    num_attention_heads: 8,
    num_hidden_layers: 12, global_attn_every_n_layers: 3, global_rope_theta: 160000, local_rope_theta: 160000,
  };
  const crf = {
    W: [
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ],
    alpha: [0, 0, 0],
    delta: [0, 0, 0],
    lambda: 1,
    gamma: 1,
    l_min: 1,
  };
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      if (url.endsWith("/refs")) return Response.json({branches: [
        {name: release, targetCommit: revision},
        {name: "2026-12-02-1b", targetCommit: "b".repeat(40)},
      ]});
      if (url.includes("/api/"))
        return Response.json({
          sha: revision,
          siblings: defaultRelease.files.map((f) => ({
            rfilename: f.path,
            size: f.path === "backbone/model.safetensors" ? 700000000 : f.size_bytes,
            lfs: { sha256: f.sha256 },
          })),
        });
      if (url.endsWith("/model.json")) return Response.json(meta);
      if (url.endsWith("/config.json")) return Response.json(cfg);
      if (url.endsWith("/crf.json")) return Response.json(crf);
      throw new Error("unexpected asset request");
    }),
  );
  const pin = await resolveDetectorRelease({ release, revision });
  expect(pin.revision).toBe(revision);
  expect(pin.release).toBe(release);
  expect(requests.every((r) => r.includes(revision))).toBe(true);
  const catalog = await setupCatalog();
  expect(catalog.recommended).toEqual(pin);
  expect(detectorBytes(pin)).toBe(703669013);
  expect(requests.some((r) => r.endsWith(".safetensors"))).toBe(false);
});

it("places mixed sentence labels on the original passage across punctuation normalization",()=>{
  const text='My café is old. “This is new!”';
  const r={id:"p",bucket:0,probs:[0.52,0,0.48],score:0.48,sentenceLabels:[0,2]};
  const v=unitVerdict("p",text.length,[{start:0,end:text.length,result:r}],text);
  expect(v.result.probs).toEqual(r.probs);
  expect(v.stretches.map(s=>[text.slice(s.start,s.end).trim(),s.result.bucket])).toEqual([
    ['My café is old.',0],['“This is new!”',2],
  ]);
  const ambiguous=unitVerdict("p",text.length,[{start:0,end:text.length,result:{...r,sentenceLabels:[0,2,1]}}],text);
  expect(ambiguous.stretches).toHaveLength(1);
});
