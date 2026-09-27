// test/node/webengineFake.ts — a fake file server for the engine's download and lifecycle tests.
//
// `fakeServer` answers fetch calls for the files given, with HTTP Range as a real server
// does (206 with Content-Range, 200 for a whole file), and can be told to cut a response
// after so many bytes, to ignore ranges, or to fail. Requests are recorded.
export interface FakeServerOptions {
  /** End the response body after this many bytes (of the requested range), as a lost connection. */
  cutAfter?: number;
  /** Answer every request with the whole file and 200, as a server without Range does. */
  ignoreRange?: boolean;
  /** Answer with this status and no body. */
  status?: number;
  /** Bytes per chunk of the body. */
  chunk?: number;
  /** A body that never ends until the request is aborted, after `stallAfter` bytes. */
  stallAfter?: number;
}

export interface FakeServer {
  fetch: typeof fetch;
  requests: Array<{ url: string; range: string | null }>;
  options: FakeServerOptions;
}

export function fakeServer(files: Record<string, Uint8Array>, options: FakeServerOptions = {}): FakeServer {
  const requests: FakeServer["requests"] = [];
  const server: FakeServer = { requests, options, fetch: undefined as unknown as typeof fetch };
  server.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const range = headers.get("Range");
    requests.push({ url, range });
    const file = files[new URL(url).pathname];
    if (!file) return new Response(null, { status: 404 });
    if (server.options.status) return new Response(null, { status: server.options.status });
    let start = 0;
    let status = 200;
    const responseHeaders: Record<string, string> = { "Accept-Ranges": "bytes", "Content-Length": String(file.length) };
    const match = range && /^bytes=(\d+)-$/.exec(range);
    if (match && !server.options.ignoreRange) {
      start = Number(match[1]);
      status = 206;
      responseHeaders["Content-Range"] = `bytes ${start}-${file.length - 1}/${file.length}`;
      responseHeaders["Content-Length"] = String(file.length - start);
    }
    const body = file.subarray(start);
    const { cutAfter, chunk = 7, stallAfter } = server.options;
    const signal = init?.signal;
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) { controller.error(new DOMException("aborted", "AbortError")); return; }
        if (cutAfter !== undefined && at >= cutAfter) { controller.error(new TypeError("connection lost")); return; }
        if (stallAfter !== undefined && at >= stallAfter) {
          return new Promise<void>((resolve) => { signal?.addEventListener("abort", () => { controller.error(new DOMException("aborted", "AbortError")); resolve(); }, { once: true }); });
        }
        if (at >= body.length) { controller.close(); return; }
        let end = Math.min(body.length, at + chunk);
        if (cutAfter !== undefined) end = Math.min(end, cutAfter);
        if (stallAfter !== undefined) end = Math.min(end, stallAfter);
        controller.enqueue(body.slice(at, end));
        at = end;
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
  }) as typeof fetch;
  return server;
}
