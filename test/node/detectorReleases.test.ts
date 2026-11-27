import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRelease,
  listDetectorReleases,
  releaseName,
  resolveDetectorRelease,
  validRelease,
} from "../../lib/detectorReleases";
import { addRead, emptyTally } from "../../lib/stats/model";
import { band } from "../../lib/render/band";
import { detectorScore } from "../../lib/webengine/detectorScore";
import { unitVerdict } from "../../lib/capture/windows";

afterEach(() => vi.unstubAllGlobals());
describe("dated detector releases", () => {
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
  const release = "2026-12-01-200m-test",
    revision = "a".repeat(40);
  const meta = {
    format: "anagram-detector/1",
    classes: ["human", "ai_assisted", "ai_generated"],
    heads: ["token", "segment", "mixed"],
    decoder: "linear_chain_crf",
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
    layer_types: ["full_attention"],
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
      if (url.includes("/api/"))
        return Response.json({
          sha: revision,
          siblings: defaultRelease.files.map((f) => ({
            rfilename: f.path,
            size: f.size_bytes,
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
