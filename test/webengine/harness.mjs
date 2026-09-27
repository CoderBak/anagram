// test/webengine/harness.mjs — the in-browser engine on its own, in a throwaway browser.
//
// The engine is a Web Worker that takes its pin (which files, where from, which hashes)
// in its first message, so a suite can run the real worker build on files of its own:
// this serves public/vendor/engine/ and any model directory over a local HTTP server
// (cross-origin isolated by header, so the WebAssembly path may use threads) and opens a
// blank page that starts the worker, exactly as the offscreen document does. Chromium is
// Playwright's bundled build in its new headless mode, which exposes the Metal WebGPU
// adapter without flags (recorded by the other side: the headless shell has none) — with
// `--enable-unsafe-webgpu --ignore-gpu-blocklist` passed for machines whose GPU is
// blocklisted. Firefox is a test ESR the caller names, driven over WebDriver BiDi. Every
// profile is a temporary directory removed at the end: a profile holding the model costs
// the model's 1.4 GB, so the parity script reuses one and deletes it.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_DIR, vendorWebEngine } from "../../scripts/webengine.mjs";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const VENDOR = join(ROOT, ENGINE_DIR);

/** The worker build the suites serve, rebuilt when it is missing or older than lib/webengine/. */
export async function ensureEngineBuild() {
  const worker = join(VENDOR, "worker.min.mjs");
  const built = existsSync(worker) ? statSync(worker).mtimeMs : 0;
  const sources = join(ROOT, "lib", "webengine");
  const newest = Math.max(...readdirSync(sources).map((name) => statSync(join(sources, name)).mtimeMs), statSync(join(ROOT, "scripts", "webengine.mjs")).mtimeMs);
  if (built > newest) return;
  await vendorWebEngine(ROOT);
}
const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

/** The extension's Content-Security-Policy (wxt.config.ts), sent on every response when asked:
 *  the page and the worker then run under exactly the policy the offscreen document has. */
export const EXTENSION_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; " +
  "connect-src 'self' http: https: file:; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "worker-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'";

/** The engine's page: one worker, driven through window.engine from page.evaluate. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>Anagram engine test</title><script type="module" src="/page.mjs"></script>`;
const PAGE_SCRIPT = `
const pending = new Map();
let sequence = 0;
let worker = null, ready = null;
window.engine = {
  start(init) {
    worker = new Worker("/vendor/engine/worker.min.mjs", { type: "module" });
    ready = new Promise((resolve) => {
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "ready") resolve();
        else if (message.type === "reply") { const p = pending.get(message.reply.id); pending.delete(message.reply.id); p?.(message.reply); }
      };
    });
    worker.onerror = (event) => { window.__workerError = String(event.message || event); };
    worker.postMessage({ type: "init", ...init });
    return ready;
  },
  request(op, payload = {}, id = "t-" + (++sequence)) {
    return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage({ type: "request", request: { v: 1, id, op, payload } }); });
  },
  raw(request) {
    return new Promise((resolve) => { const id = request?.id ?? "protocol-error"; pending.set(id, resolve); worker.postMessage({ type: "request", request }); });
  },
  async until(predicate, timeoutMs = 600000) {
    const began = Date.now();
    for (;;) {
      const reply = await this.request("status");
      if (predicate(reply.data ?? {}, reply)) return reply;
      if (Date.now() - began > timeoutMs) throw new Error("timeout waiting for " + JSON.stringify(reply).slice(0, 500));
      await new Promise((r) => setTimeout(r, 250));
    }
  },
  gpu: async () => {
    try {
      const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize } : null;
    } catch (e) { return { error: String(e?.message ?? e) }; }
  },
  isolated: () => crossOriginIsolated,
};
window.__ready = true;
`;

/**
 * Serve the engine's vendor files and the given directories. `mounts` maps a URL prefix
 * ("/model/") to a directory. Range requests are honoured, so a download can resume.
 */
/**
 * `csp` goes on every response; with `pageCsp` false only the worker's script carries it
 * (a dedicated worker takes its policy from its script's response), for a driver whose
 * page.evaluate is itself dynamic code under the page's policy (Firefox 140 over BiDi).
 */
export async function serve(mounts = {}, { isolate = true, csp = EXTENSION_CSP, pageCsp = true } = {}) {
  await ensureEngineBuild();
  const roots = [["/vendor/engine/", VENDOR], ...Object.entries(mounts)];
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ path: url.pathname, range: req.headers.range ?? null });
    const headers = { "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" };
    if (isolate) Object.assign(headers, { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
    if (csp && (pageCsp || url.pathname.startsWith("/vendor/engine/"))) headers["Content-Security-Policy"] = csp;
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { ...headers, "Content-Type": TYPES[".html"] });
      res.end(PAGE);
      return;
    }
    if (url.pathname === "/page.mjs") {
      res.writeHead(200, { ...headers, "Content-Type": TYPES[".mjs"] });
      res.end(PAGE_SCRIPT);
      return;
    }
    let file = null;
    for (const [prefix, root] of roots) {
      if (!url.pathname.startsWith(prefix)) continue;
      const candidate = normalize(join(root, decodeURIComponent(url.pathname.slice(prefix.length))));
      if (candidate.startsWith(root)) file = candidate;
      break;
    }
    if (!file || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, headers).end("not found"); return; }
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const type = TYPES[extname(file)] || "application/octet-stream";
    if (range && server.ignoreRange !== true) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { ...headers, "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" });
      createReadStream(file, { start, end, highWaterMark: 4 << 20 }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    createReadStream(file, { highWaterMark: 4 << 20 }).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, server, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A pin over files the server mounts, hashed by the caller (see pinOf). The one named
 *  lid.176.ftz stands for the package's copy, which the engine reads rather than downloads. */
export function pinFor(base, files) {
  const entry = (f) => ({ name: f.name, size_bytes: f.size_bytes, sha256: f.sha256, url: `${base}${f.path}` });
  return {
    files: files.filter((f) => f.name !== "lid.176.ftz").map(entry),
    lid: entry(files.find((f) => f.name === "lid.176.ftz")),
    model: { id: "editlens_roberta-large", calibration: "editlens-4bucket-cosine(0.03,0.15)" },
    license: "CC-BY-NC-SA-4.0",
  };
}

/** The worker's init message against `base`. */
export function initFor(base, pin, version = "0.0.0-test") {
  const build = (lib, suffix) => ({ ort: `${base}/vendor/engine/${lib}`, mjs: `${base}/vendor/engine/ort-wasm-simd-threaded${suffix}.mjs`, wasm: `${base}/vendor/engine/ort-wasm-simd-threaded${suffix}.wasm` });
  return { pin, assets: { jspi: build("ort.jspi.min.mjs", ".jspi"), plain: build("ort.wasm.min.mjs", "") }, version };
}

/**
 * A Chromium with a temporary profile (or the one given, kept for the caller to remove).
 * Headless by default; HEADED=1 opens a window. Returns the context, the page on `base`
 * and a close() that removes a profile it created.
 */
export async function launchChromium(base, { profile, headed = process.env.HEADED === "1", args = [] } = {}) {
  const dir = profile ?? mkdtempSync(join(tmpdir(), "anagram-webengine-"));
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chromium", headless: !headed,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--no-first-run", "--no-default-browser-check", ...args],
    env: { ...process.env, HOME: dir },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text().slice(0, 500)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 500)));
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.__ready === true);
  return {
    context, page, errors, profile: dir,
    version: context.browser()?.version(),
    close: async ({ keepProfile = profile !== undefined } = {}) => {
      await context.close().catch(() => {});
      if (!keepProfile) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/**
 * A Firefox (an ESR under test, never an installed one) over WebDriver BiDi through
 * puppeteer-core, with a temporary profile and HOME. `prefs` may turn WebGPU on.
 */
export async function launchFirefox(base, executablePath, { headed = process.env.HEADED === "1", prefs = {} } = {}) {
  const { launch } = await import("puppeteer-core");
  const dir = mkdtempSync(join(tmpdir(), "anagram-webengine-ff-"));
  const browser = await launch({
    browser: "firefox", protocol: "webDriverBiDi", executablePath, userDataDir: join(dir, "profile"), headless: !headed,
    ignoreDefaultArgs: ["--foreground"], defaultViewport: null, protocolTimeout: 0,
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), MOZ_CRASHREPORTER_DISABLE: "1" },
    extraPrefsFirefox: {
      "browser.shell.checkDefaultBrowser": false, "datareporting.policy.dataSubmissionEnabled": false, "toolkit.telemetry.enabled": false,
      "app.update.enabled": false, "browser.aboutwelcome.enabled": false, ...prefs,
    },
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(m.text().slice(0, 500)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 500)));
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.__ready === true);
  return {
    page, errors, profile: dir, version: await browser.version(),
    close: async () => { await browser.close().catch(() => {}); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); },
  };
}
