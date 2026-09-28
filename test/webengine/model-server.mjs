// test/webengine/model-server.mjs — Hugging Face, on this machine.
//
// The in-browser engine downloads from the exact addresses it pins (lib/webengine/pin.ts): the
// modelkit's model and tokenizer on huggingface.co. Its language identifier ships in the
// package, so nothing else is fetched. A suite that drives setup cannot hand the engine
// other addresses, so the browser is pointed here instead: Chromium resolves Hugging Face's
// names to this HTTPS server (`--host-resolver-rules`, every other name to nothing) and
// accepts its throwaway certificate (`--ignore-certificate-errors`); nothing leaves the
// machine. The extension holds no permission for the host, so the browser enforces CORS, and
// the server answers as Hugging Face does: huggingface.co echoes the request's Origin and
// exposes Content-Range, answers the preflight a Range header may bring, and redirects the
// model, a large file, to its CDN under hf.co, which answers any origin (`*`, the redirected
// request's origin being opaque). With HTTP Range, and with what a test sets:
//
//   files      each pinned file's bytes: a path (the real files, verified by the engine) or a
//              size of zeros (a download that is paused or failed long before it could verify)
//   rate       bytes per second, so a test can pause mid-download
//   status     answer every request with this status instead
//   cutAfter   drop the connection after this many bytes of a response
//
//   const server = await modelServer({ files: { "model.onnx": 1e9 }, rate: 40e6 });
//   chromium.launchPersistentContext(dir, { args: [...server.args] });
//   server.set({ status: 404 }); server.requests; await server.close();
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./harness.mjs";

const modelkit = JSON.parse(readFileSync(join(ROOT, "anagramd", "modelkit.json"), "utf8"));
const kitPath = (path) => `/${modelkit.repository}/resolve/${modelkit.revision}/${path.split("/").map(encodeURIComponent).join("/")}`;
const size = (path) => modelkit.files.find((f) => f.path === path).size_bytes;
const HF = "huggingface.co";
const CDN = "us.aws.cdn.hf.co";

/** The pinned files by the engine's name: where each is asked for, where Hugging Face sends
 *  the request on (`cdn`: a path on its CDN), and its pinned size. */
export const PINNED = {
  "model.onnx": { host: HF, path: kitPath("onnx/model.onnx"), cdn: "/xet-bridge-us/anagram-test/model.onnx", size: size("onnx/model.onnx") },
  "tokenizer.json": { host: HF, path: kitPath("tokenizer.json"), size: size("tokenizer.json") },
};
export const DOWNLOAD_BYTES = Object.values(PINNED).reduce((n, f) => n + f.size, 0);

/**
 * Chromium's switch that sends Hugging Face nowhere. A fresh profile on a device with no
 * choice starts the model's download by itself (lib/webengine/autoSetup.ts): a suite that is
 * not about the download passes this, and the download fails on a name that does not resolve.
 */
export const NO_MODEL_HOSTS = `--host-resolver-rules=MAP ${HF} ~NOTFOUND, MAP *.hf.co ~NOTFOUND`;

/**
 * Cancel what a fresh profile's install started, as Cancel does, through the extension's
 * Settings page: the engine is then not set up and stays so. Waits for the engine to have
 * taken the automatic start first, or for it not to come.
 */
export async function cancelAutoSetup(context, extId) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extId}/options.html`);
    const request = (op, payload = {}) => page.evaluate(([op, payload]) => chrome.runtime.sendMessage({ action: "anagram.nativeRequest", op, payload }), [op, payload]);
    for (let i = 0; i < 60; i++) {
      const reply = await request("status").catch(() => null);
      if (["running", "failed"].includes(reply?.data?.download?.status)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const reply = await request("models.delete", { confirm: true });
    if (reply?.data?.state !== "needs_models") throw new Error(`the automatic download did not cancel: ${JSON.stringify(reply).slice(0, 300)}`);
  } finally {
    await page.close();
  }
}

/** The real files where the other suites find them, when they are all there. */
export function realFiles(kit = process.env.ANAGRAM_MODELKIT) {
  const files = { "model.onnx": kit && join(kit, "onnx", "model.onnx"), "tokenizer.json": kit && join(kit, "tokenizer.json") };
  for (const [name, path] of Object.entries(files)) {
    try { if (!path || statSync(path).size !== PINNED[name].size) return null; } catch { return null; }
  }
  return files;
}

/** A self-signed certificate for Hugging Face's names, made with openssl for this run. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "anagram-model-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${HF}`,
      "-addext", `subjectAltName=DNS:${HF},DNS:*.hf.co,DNS:${CDN}`,
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Hugging Face's CORS answer: the hub echoes the origin and lists what it exposes; its CDN answers anyone. */
function cors(host, origin) {
  return host === HF
    ? { "Access-Control-Allow-Origin": origin ?? "*", "Vary": "Origin, Accept", "Access-Control-Expose-Headers": "ETag,Link,Accept-Ranges,Content-Range,X-Linked-Size" }
    : { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "*" };
}

export async function modelServer(options = {}) {
  let opts = { files: {}, rate: 0, status: 0, cutAfter: 0, ...options };
  const requests = [];
  const sockets = new Set();
  const server = https.createServer(certificate(), (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url, `https://${host}`);
    const origin = req.headers.origin ?? null;
    // The preflight a request with Range may bring: allowed, as Hugging Face allows it.
    if (req.method === "OPTIONS") {
      requests.push({ host, path: url.pathname, file: null, range: null, origin, preflight: true });
      res.writeHead(200, { ...cors(host, origin), "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "range", "Access-Control-Max-Age": "86400" }).end();
      return;
    }
    const entry = Object.entries(PINNED).find(([, f]) => (host === f.host && f.path === url.pathname) || (host === CDN && f.cdn === url.pathname));
    requests.push({ host, path: url.pathname, file: entry?.[0] ?? null, range: req.headers.range ?? null, origin });
    const headers = { "Cache-Control": "no-store", ...cors(host, origin) };
    if (!entry) { res.writeHead(404, headers).end(); return; }
    if (opts.status) { res.writeHead(opts.status, headers).end(); return; }
    const [name, pinned] = entry;
    // The hub sends a large file on to its CDN.
    if (host === HF && pinned.cdn) { res.writeHead(302, { ...headers, Location: `https://${CDN}${pinned.cdn}?expires=${Date.now() + 3600e3}` }).end(); return; }
    const source = opts.files[name] ?? pinned.size;
    const total = typeof source === "string" ? statSync(source).size : source;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : total - 1;
    res.writeHead(range ? 206 : 200, {
      ...headers, "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    });
    const chunks = typeof source === "string" ? createReadStream(source, { start, end, highWaterMark: 1 << 20 }) : zeros(end - start + 1);
    void pump(chunks, res);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

  /** `n` bytes of zeros, a megabyte at a time. */
  async function* zeros(n) {
    const block = Buffer.alloc(1 << 20);
    for (let left = n; left > 0; left -= block.length) yield left >= block.length ? block : block.subarray(0, left);
  }

  /** Stream `chunks` into the response at the set rate, dropping the connection where told. */
  async function pump(chunks, res) {
    let sent = 0;
    const began = Date.now();
    try {
      for await (let chunk of chunks) {
        if (res.destroyed) return;
        if (opts.cutAfter && sent + chunk.length > opts.cutAfter) {
          chunk = chunk.subarray(0, Math.max(0, opts.cutAfter - sent));
          if (chunk.length) res.write(chunk);
          res.destroy();
          return;
        }
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
            res.on("drain", done); res.on("close", done);
          });
        }
        sent += chunk.length;
        if (opts.rate) {
          const due = began + (sent / opts.rate) * 1000;
          if (due > Date.now()) await new Promise((resolve) => setTimeout(resolve, due - Date.now()));
        }
      }
      res.end();
    } catch { res.destroy(); }
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const map = [HF, "*.hf.co"].map((h) => `MAP ${h} 127.0.0.1:${port}`);
  return {
    port, requests,
    /** Chromium's switches that send Hugging Face here, and every other name nowhere. */
    args: [`--host-resolver-rules=${[...map, "MAP * ~NOTFOUND", "EXCLUDE localhost"].join(", ")}`, "--ignore-certificate-errors"],
    set(change) { opts = { ...opts, ...change }; },
    /** Drop every open connection, as a network that went away does. */
    drop() { for (const socket of sockets) socket.destroy(); },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
