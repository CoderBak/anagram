// Native fixture registration stays inside temporary browser profiles/homes.
// Windows cannot isolate HKCU registration by profile. Its deterministic UI suites
// relay an injected test port to the same real stdio child; no shipping hook is used.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { HOST_NAME, HOST_SCRIPT } from "./fake-native.mjs";

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
export function registerTestHost(manifestPath, fixture, browser, extensionId) {
  const launcher = join(fixture.home, "launch-host");
  if (!existsSync(launcher)) writeFileSync(launcher, `#!/bin/sh\nexec ${[process.execPath, HOST_SCRIPT, "--host", fixture.stateFile, fixture.logFile].map(quote).join(" ")}\n`);
  chmodSync(launcher, 0o700);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ name: HOST_NAME, description: "Isolated Anagram test fixture",
    path: launcher, type: "stdio", ...(browser === "firefox" ? { allowed_extensions: [extensionId] }
      : { allowed_origins: [`chrome-extension://${extensionId}/`] }) }));
}

/** Prevent startup from reaching an existing user host before the runner attaches.
 * Only relay suites use this temporary manifest; shipping output is never changed. */
export function copyForTestPort(extension, home) {
  const copy = join(home, "extension");
  cpSync(extension, copy, { recursive: true });
  const path = join(copy, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.permissions = manifest.permissions.filter((permission) => permission !== "nativeMessaging");
  writeFileSync(path, JSON.stringify(manifest));
  return copy;
}

/** Shadow any user/global registration before a POSIX Chrome process can start. */
export function blockNativeHostInProfile(profile) {
  const path = join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ name: HOST_NAME, description: "Isolated test startup guard",
    path: join(profile, "host-not-yet-registered"), type: "stdio",
    allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] }));
}

/** Test-runner-only native API adapter; evaluation target is the isolated background. */
export async function attachTestPort(target, fixture) {
  await target.evaluate(async () => {
    const scope = globalThis.browser?.runtime.getBackgroundPage ? await browser.runtime.getBackgroundPage() : globalThis;
    const ports = new Map(); let sequence = 0;
    scope.__anagramTestNative = { queue: [], receive(id, reply) { ports.get(id)?.messages.forEach((fn) => fn(reply)); },
      disconnected(id) { const port = ports.get(id); ports.delete(id); port?.disconnects.forEach((fn) => fn()); } };
    const api = scope.browser?.runtime ?? scope.chrome.runtime;
    api.connectNative = () => {
      const id = ++sequence, messages = [], disconnects = [];
      ports.set(id, { messages, disconnects });
      scope.__anagramTestNative.queue.push({ type: "connect", id });
      return { postMessage(message) { scope.__anagramTestNative.queue.push({ type: "message", id, message }); },
        disconnect() { scope.__anagramTestNative.queue.push({ type: "disconnect", id }); },
        onMessage: { addListener(fn) { messages.push(fn); } }, onDisconnect: { addListener(fn) { disconnects.push(fn); } } };
    };
  });
  let stopped = false, timer;
  const children = new Map();
  const relay = (id, message) => target.evaluate(async ({ id, message }) => { const scope = globalThis.browser?.runtime.getBackgroundPage ? await browser.runtime.getBackgroundPage() : globalThis; scope.__anagramTestNative?.receive(id, message); }, { id, message }).catch(() => {});
  const start = (id) => {
    const child = spawn(process.execPath, [HOST_SCRIPT, "--host", fixture.stateFile, fixture.logFile], { stdio: ["pipe", "pipe", "pipe"] });
    children.set(id, child); let incoming = Buffer.alloc(0);
    child.stderr.on("data", (bytes) => process.stderr.write(bytes));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (bytes) => {
      incoming = Buffer.concat([incoming, bytes]);
      while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
        const size = incoming.readUInt32LE(0), message = JSON.parse(incoming.subarray(4, size + 4));
        incoming = incoming.subarray(size + 4); void relay(id, message);
      }
    });
    child.on("exit", () => { children.delete(id); void target.evaluate(async (id) => { const scope = globalThis.browser?.runtime.getBackgroundPage ? await browser.runtime.getBackgroundPage() : globalThis; scope.__anagramTestNative?.disconnected(id); }, id).catch(() => {}); });
  };
  const poll = async () => {
    if (stopped) return;
    try {
      const queue = await target.evaluate(async () => { const scope = globalThis.browser?.runtime.getBackgroundPage ? await browser.runtime.getBackgroundPage() : globalThis; return scope.__anagramTestNative.queue.splice(0); });
      for (const event of queue) {
        if (event.type === "connect") start(event.id);
        else if (event.type === "disconnect") children.get(event.id)?.kill();
        else {
          const bytes = Buffer.from(JSON.stringify(event.message)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
          children.get(event.id)?.stdin.write(Buffer.concat([header, bytes]));
        }
      }
    } catch { /* the background may have closed */ }
    if (!stopped) timer = setTimeout(poll, 10);
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); for (const child of children.values()) child.kill(); };
}
