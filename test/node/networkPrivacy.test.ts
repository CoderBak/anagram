import { afterEach, expect, it, vi } from "vitest";
import { NativeScoreClient } from "../../lib/backend/nativeScoreClient";
import { CONTRACT_VERSION } from "../../lib/contract";

afterEach(() => vi.unstubAllGlobals());

it("sends only scoring text and IDs to the local component, without source metadata", async () => {
  const model = { id: "fixture", ver: "local", calibration: "four-buckets" };
  const health = { ok: true, contract: CONTRACT_VERSION, model, n_buckets: 4,
    buckets: ["human", "light", "heavy", "ai"], max_tokens: 512, device: "cpu" };
  const request = vi.fn(async (op: string) => ({ v: 1 as const, id: "reply", ok: true, status: 200,
    data: op === "health" ? health : { v: CONTRACT_VERSION, model,
      results: [{ id: "paragraph", bucket: 0, probs: [1, 0, 0, 0], score: 0 }] },
  }));
  const fetcher = vi.fn(() => { throw new Error("Scoring must not use browser networking"); });
  vi.stubGlobal("fetch", fetcher);
  const client = new NativeScoreClient(request);
  // Structural typing permits extra fields on an existing object. Protect the
  // boundary against forwarding an internal scan block with a spread operator.
  const block = { id: "paragraph", text: "A private paragraph for local inference.",
    url: "https://private.invalid/document?access=secret", title: "Private document",
    cookies: "session=secret", documentKey: "internal-session", source: { tabId: 123 } };
  await client.scoreBatch([block]);
  expect(request.mock.calls[1]).toEqual(["score", {
    v: CONTRACT_VERSION, blocks: [{ id: block.id, text: block.text }],
  }, undefined]);
  expect(fetcher).not.toHaveBeenCalled();
});
