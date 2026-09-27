// test/node/webengineSha256.test.ts — the streaming SHA-256 against WebCrypto.
import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { Sha256, sha256Hex } from "../../lib/webengine/sha256";

const hex = async (data: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)), (b) => b.toString(16).padStart(2, "0")).join("");

function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}

describe("streaming SHA-256", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("gives the same digest whatever the chunking, around every block boundary", async () => {
    for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 100_003]) {
      const data = bytes(length, length);
      const expected = await hex(data);
      expect(sha256Hex(data), `${length} bytes at once`).toBe(expected);
      for (const chunk of [1, 3, 7, 64, 65, 1000]) {
        const hasher = new Sha256();
        for (let at = 0; at < length; at += chunk) hasher.update(data.subarray(at, Math.min(length, at + chunk)));
        expect(hasher.bytes).toBe(length);
        expect(hasher.digest(), `${length} bytes in chunks of ${chunk}`).toBe(expected);
      }
    }
  });

  it("takes no input after the digest", () => {
    const hasher = new Sha256().update(new Uint8Array([1, 2, 3]));
    hasher.digest();
    expect(() => hasher.update(new Uint8Array([4]))).toThrow();
    expect(() => hasher.digest()).toThrow();
  });
});
