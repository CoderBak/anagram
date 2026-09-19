// test/node/pdf-handoff.test.ts — the rules of the PDF handoff, without a browser.
//
// lib/pdf/handoff.ts is what replaced the reading mode's own `fetch(?src=)`. Three of its
// four parts are plain functions over their inputs and belong here: the bytes-as-JSON
// encoding both hops use, the read out of the tab (over an injected `fetch`, so nothing
// here goes near a network), and the worker's ticket store. The fourth — two ports and a
// tab navigation — is checked in a real browser by test/pdf-route-check.mjs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64Bytes,
  createTicketStore,
  fromBase64,
  hasPdfMagic,
  newTicket,
  streamPdfBytes,
  toBase64,
  CHUNK_BYTES,
} from "../../lib/pdf/handoff";

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** A response whose body arrives in the pieces given, as the network really delivers one. */
function streamed(pieces: Uint8Array[], init: { status?: number; length?: number | null } = {}): Response {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers();
  const stated = init.length === undefined ? pieces.reduce((n, p) => n + p.byteLength, 0) : init.length;
  if (stated !== null) headers.set("content-length", String(stated));
  const response = new Response(body, { status: init.status ?? 200, headers });
  Object.defineProperty(response, "wasCancelled", { get: () => cancelled });
  return response;
}

/** A PDF-shaped body of `bytes` bytes: the header, then filler. */
const pdfOf = (bytes: number): Uint8Array => latin1("%PDF-1.7\n" + "x".repeat(Math.max(0, bytes - 9)));

/** Collect what a stream hands over, the way the port on the other side would. */
async function collect(response: Response, cap: number): Promise<{ result: unknown; bytes: Uint8Array }> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const chunks: string[] = [];
  const result = await streamPdfBytes("https://example.test/a.pdf", (c) => chunks.push(c), { cap });
  const size = chunks.reduce((n, c) => n + base64Bytes(c), 0);
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) at += fromBase64(chunk, bytes, at);
  return { result, bytes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bytes as JSON", () => {
  it("survives the round trip, whatever the length modulo three", () => {
    for (const size of [0, 1, 2, 3, 4, 5, 255, 1000, 1001, 1002]) {
      const source = new Uint8Array(size);
      for (let i = 0; i < size; i++) source[i] = (i * 37 + 11) & 255;
      const text = toBase64(source);
      const back = new Uint8Array(size);
      expect(fromBase64(text, back, 0)).toBe(size);
      expect([...back]).toEqual([...source]);
      expect(base64Bytes(text)).toBe(size);
    }
  });

  it("carries every byte value, not just the ones a string survives", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const back = new Uint8Array(256);
    fromBase64(toBase64(all), back, 0);
    expect([...back]).toEqual([...all]);
  });

  it("encodes a chunk larger than the argument limit of String.fromCharCode", () => {
    const big = new Uint8Array(CHUNK_BYTES).fill(0xab);
    const back = new Uint8Array(CHUNK_BYTES);
    fromBase64(toBase64(big), back, 0);
    expect(back.every((b) => b === 0xab)).toBe(true);
  });
});

describe("what counts as a PDF", () => {
  it("takes the header at the start, and anywhere in the first kilobyte", () => {
    expect(hasPdfMagic(latin1("%PDF-1.4\nrest"))).toBe(true);
    expect(hasPdfMagic(latin1("\n".repeat(900) + "%PDF-1.4"))).toBe(true);
  });

  it("does not go looking past that, and is not fooled by a page that says so", () => {
    expect(hasPdfMagic(latin1("\n".repeat(2000) + "%PDF-1.4"))).toBe(false);
    expect(hasPdfMagic(latin1("<!doctype html><title>Sign in to read this PDF</title>"))).toBe(false);
    expect(hasPdfMagic(new Uint8Array(0))).toBe(false);
  });
});

describe("reading the document out of the tab", () => {
  it("hands over every byte, in order", async () => {
    const source = pdfOf(CHUNK_BYTES * 2 + 1234);
    const pieces = [source.subarray(0, 7777), source.subarray(7777, 400_000), source.subarray(400_000)];
    const { result, bytes } = await collect(streamed(pieces), 10 * 1024 * 1024);
    expect(result).toEqual({ ok: true, bytes: source.byteLength });
    expect(bytes.byteLength).toBe(source.byteLength);
    expect([...bytes.subarray(0, 9)]).toEqual([...source.subarray(0, 9)]);
    expect([...bytes.subarray(-9)]).toEqual([...source.subarray(-9)]);
  });

  it("refuses a stated length over the cap before a byte of the body is read", async () => {
    const response = streamed([pdfOf(64)], { length: 200 * 1024 * 1024 });
    const { result, bytes } = await collect(response, 1024);
    expect(result).toEqual({ ok: false, failure: "large" });
    expect(bytes.byteLength).toBe(0);
    expect((response as unknown as { wasCancelled: boolean }).wasCancelled).toBe(true);
  });

  it("stops at the cap on a body that never said how long it was", async () => {
    // Six chunks offered, a cap of two and a half: the rest is never read, which is the
    // whole point — the old reader bought the entire file and THEN measured it.
    const pieces = Array.from({ length: 6 }, (_, i) =>
      i === 0 ? pdfOf(CHUNK_BYTES) : new Uint8Array(CHUNK_BYTES).fill(i),
    );
    const response = streamed(pieces, { length: null });
    const { result, bytes } = await collect(response, CHUNK_BYTES * 2.5);
    expect(result).toEqual({ ok: false, failure: "large" });
    expect(bytes.byteLength).toBeLessThanOrEqual(CHUNK_BYTES * 3);
    expect((response as unknown as { wasCancelled: boolean }).wasCancelled).toBe(true);
  });

  it("refuses a body that is not a PDF, however it was labelled", async () => {
    const html = latin1("<!doctype html><html><body>Please sign in to download this file.</body></html>");
    const { result } = await collect(streamed([html]), 1024 * 1024);
    expect(result).toEqual({ ok: false, failure: "type" });
  });

  it("refuses an empty body and an error status", async () => {
    expect((await collect(streamed([new Uint8Array(0)]), 1024)).result).toEqual({ ok: false, failure: "type" });
    expect((await collect(streamed([pdfOf(64)], { status: 404 }), 1024)).result).toEqual({
      ok: false,
      failure: "read",
    });
  });

  it("says so when the request never happened at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const out = await streamPdfBytes("https://example.test/a.pdf", () => undefined, { cap: 1024 });
    expect(out).toEqual({ ok: false, failure: "read" });
  });

  it("asks for the document the way the tab already has it", async () => {
    const fetcher = vi.fn().mockResolvedValue(streamed([pdfOf(64)]));
    vi.stubGlobal("fetch", fetcher);
    await streamPdfBytes("https://example.test/a.pdf", () => undefined, { cap: 1024 });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "include", cache: "force-cache" });
  });
});

describe("the worker's ticket store", () => {
  it("gives the bytes to the tab they were read for, once", () => {
    const store = createTicketStore();
    const ticket = store.hold(7, ["abcd"], 3);
    expect(store.size()).toBe(1);
    expect(store.take(ticket, 9)).toBeNull(); // another tab: not its document
    expect(store.take(ticket, 7)?.bytes).toBe(3);
    expect(store.take(ticket, 7)).toBeNull(); // spent
    expect(store.size()).toBe(0);
  });

  it("makes a ticket nobody can guess, and no two alike", () => {
    const tickets = new Set(Array.from({ length: 200 }, () => newTicket()));
    expect(tickets.size).toBe(200);
    for (const ticket of tickets) expect(ticket).toMatch(/^[0-9a-f]{32}$/);
  });

  it("drops a document no reader ever came for", () => {
    vi.useFakeTimers();
    const store = createTicketStore(1000);
    const ticket = store.hold(7, ["abcd"], 3);
    vi.advanceTimersByTime(1001);
    expect(store.take(ticket, 7)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("lets go of everything a closed tab was holding", () => {
    const store = createTicketStore();
    store.hold(7, ["a"], 1);
    store.hold(7, ["b"], 1);
    const other = store.hold(8, ["c"], 1);
    store.forget(7);
    expect(store.size()).toBe(1);
    expect(store.take(other, 8)?.bytes).toBe(1);
  });
});
