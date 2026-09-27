// test/webengine/model-server.mjs — the model's download hosts, on this machine.
//
// The oneclick build downloads from the exact addresses it pins (lib/webengine/pin.ts):
// the modelkit on huggingface.co and lid.176.ftz on dl.fbaipublicfiles.com. A suite that
// drives setup from its button cannot hand the engine other addresses, so the browser is
// pointed here instead: Chromium resolves those names to this HTTPS server
// (`--host-resolver-rules`, every other name to nothing) and accepts its throwaway
// certificate (`--ignore-certificate-errors`); nothing leaves the machine. The server answers
// the pinned paths as the real hosts do — Hugging Face with CORS headers, fastText's host
// without, which is why the setup page must hold the optional host grant first — with HTTP
// Range, and with what a test sets:
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
const LID = { size: 938013, path: "/fasttext/supervised-models/lid.176.ftz" };
const size = (path) => modelkit.files.find((f) => f.path === path).size_bytes;

/** The pinned files by the engine's name: where each is asked for, and its pinned size. */
export const PINNED = {
  "model.onnx": { host: "huggingface.co", path: kitPath("onnx/model.onnx"), size: size("onnx/model.onnx") },
  "tokenizer.json": { host: "huggingface.co", path: kitPath("tokenizer.json"), size: size("tokenizer.json") },
  "lid.176.ftz": { host: "dl.fbaipublicfiles.com", path: LID.path, size: LID.size },
};
export const DOWNLOAD_BYTES = Object.values(PINNED).reduce((n, f) => n + f.size, 0);

/** The real files where the other suites find them, when they are all there. */
export function realFiles(kit = process.env.ANAGRAM_MODELKIT, lid = process.env.ANAGRAM_LID_MODEL) {
  const files = { "model.onnx": kit && join(kit, "onnx", "model.onnx"), "tokenizer.json": kit && join(kit, "tokenizer.json"), "lid.176.ftz": lid };
  for (const [name, path] of Object.entries(files)) {
    try { if (!path || statSync(path).size !== PINNED[name].size) return null; } catch { return null; }
  }
  return files;
}

/** A self-signed certificate for the pinned hosts, made with openssl for this run. */
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "anagram-model-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=huggingface.co",
      "-addext", "subjectAltName=DNS:huggingface.co,DNS:*.hf.co,DNS:dl.fbaipublicfiles.com",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function modelServer(options = {}) {
  let opts = { files: {}, rate: 0, status: 0, cutAfter: 0, ...options };
  const requests = [];
  const sockets = new Set();
  const server = https.createServer(certificate(), (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url, `https://${host}`);
    const entry = Object.entries(PINNED).find(([, f]) => f.host === host && f.path === url.pathname);
    requests.push({ host, path: url.pathname, file: entry?.[0] ?? null, range: req.headers.range ?? null, origin: req.headers.origin ?? null });
    // Hugging Face answers any origin; fastText's host sends no CORS headers at all.
    const cors = host === "huggingface.co" ? { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" } : {};
    const headers = { "Cache-Control": "no-store", ...cors };
    if (!entry) { res.writeHead(404, headers).end(); return; }
    if (opts.status) { res.writeHead(opts.status, headers).end(); return; }
    const [name, pinned] = entry;
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
  const map = ["huggingface.co", "*.hf.co", "dl.fbaipublicfiles.com"].map((h) => `MAP ${h} 127.0.0.1:${port}`);
  return {
    port, requests,
    /** Chromium's switches that send the pinned hosts here, and every other name nowhere. */
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
