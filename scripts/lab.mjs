#!/usr/bin/env node
// scripts/lab.mjs — drive the Anagram test lab (test/lab/): a Linux container with its own
// screen, so test browsers never open on the Mac.
//
//   npm run lab -- up [--hidpi] [--screen 1920x1080] [--port 6080]   start (or refresh) the lab
//   npm run lab -- view [--watch]        open the lab's screen in your browser (--watch = look, don't touch)
//   npm run lab -- test [suite…] [--headless] [--offline]   sync + build + run suites on the lab's screen
//                                        --offline runs them in a throwaway container with NO
//                                        network at all, to prove the suites need none; that
//                                        container publishes no port, so the viewer shows
//                                        nothing while it runs (the lab itself keeps running)
//   npm run lab -- show [url…] [--size 390x844] [--dark] [--dpr 2] [--real]
//                                        leave a browser with the extension open on the lab's screen
//   npm run lab -- hide                  close what `show` opened
//   npm run lab -- shot [name]           save a picture of the lab's screen to test-results/lab/
//   npm run lab -- run -- <command…>     run anything inside the lab (cwd /work)
//   npm run lab -- status | logs | shell | down
//
// What is shared with the container: the repository, READ-ONLY, at /src, and one writable
// folder, test-results/lab, at /out. Dependencies and the build live inside the container.
// The only port is the viewer, bound to 127.0.0.1.
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = process.env.ANAGRAM_LAB_NAME || "anagram-lab";
const RESULTS = join(ROOT, "test-results", "lab");
const PW_VERSION = JSON.parse(readFileSync(join(ROOT, "node_modules", "playwright", "package.json"), "utf8")).version;
const IMAGE = `anagram-lab:pw${PW_VERSION}`;
const LAB_USER = "node";
// A mirror of Playwright's browser builds, used only when the official CDN cannot be reached.
const BROWSER_MIRROR = "https://cdn.npmmirror.com/binaries/playwright";

const SUITES = {
  node: "npx vitest run",
  unit: "node test/unit.mjs",
  e2e: "node test/e2e.mjs",
  scenarios: "node test/scenarios.mjs --local",
  matrix: "node test/matrix.mjs",
  perf: "node test/perf.mjs",
  pages: "node test/pages.mjs",
  live: "node test/scenarios.mjs",
};
const DEFAULT_SUITES = ["node", "unit", "e2e", "scenarios", "matrix"];
// Paths whose change does not alter the built extension.
const NO_REBUILD = /^(test\/|docs\/|scripts\/lab\.mjs|README\.md|\.github\/|anagramd\/|installer\/|install\.sh)/;

// ---- docker plumbing -----------------------------------------------------------------
function pickContext() {
  if (process.env.ANAGRAM_DOCKER_CONTEXT) return process.env.ANAGRAM_DOCKER_CONTEXT;
  const r = spawnSync("docker", ["context", "ls", "--format", "{{.Name}}"], { encoding: "utf8" });
  if (r.status !== 0) die("docker is not available — install OrbStack (or Docker) and start it.");
  return r.stdout.split("\n").includes("orbstack") ? "orbstack" : null;
}
const CONTEXT = pickContext();
const dockerArgs = (args) => (CONTEXT ? ["--context", CONTEXT, ...args] : args);
/** Run docker, return { status, stdout }. `show` streams to the terminal instead. */
function docker(args, { show = false, input } = {}) {
  const r = spawnSync("docker", dockerArgs(args), { encoding: "utf8", stdio: show ? "inherit" : ["pipe", "pipe", "pipe"], input, maxBuffer: 64 << 20 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function die(msg) {
  console.error(`lab: ${msg}`);
  process.exit(1);
}
function inspect(name = NAME) {
  const r = docker(["inspect", name]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout)[0]; } catch { return null; }
}
const isUp = () => inspect()?.State?.Running === true;
function labEnv(info = inspect()) {
  const env = Object.fromEntries((info?.Config?.Env ?? []).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
  const port = info?.HostConfig?.PortBindings?.["6080/tcp"]?.[0]?.HostPort ?? "6080";
  return { scale: Number(env.LAB_SCALE || 1), screen: env.LAB_SCREEN || "1920x1080", port };
}
const viewerUrl = (port, watch) =>
  `http://localhost:${port}/vnc.html?autoconnect=1&reconnect=1&reconnect_delay=1500&resize=scale${watch ? "&view_only=1" : ""}`;

/** `docker exec` inside the lab as the unprivileged user, on the lab's display. */
function exec(command, { env = {}, show = true, detach = false, container = NAME } = {}) {
  const { scale } = labEnv(inspect(container));
  // --test-type only silences Chromium's "unsupported flag: --no-sandbox" bar, which would
  // otherwise sit on top of every page on the lab's screen. (Chromium's own sandbox needs
  // privileges the container deliberately does not have; the container is the boundary.)
  const chromiumArgs = ["--test-type", ...(scale > 1 ? [`--force-device-scale-factor=${scale}`] : [])].join(" ");
  const merged = { DISPLAY: ":99", ANAGRAM_CHROMIUM_ARGS: chromiumArgs, ...env };
  const flags = Object.entries(merged).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return docker(["exec", ...(detach ? ["-d"] : []), "-u", LAB_USER, "-w", "/work", ...flags, container, "sh", "-c", command], { show });
}

// ---- argument parsing ----------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv.shift() ?? "status";
function flag(name, takesValue = false) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return takesValue ? undefined : false;
  const v = takesValue ? argv[i + 1] : true;
  argv.splice(i, takesValue ? 2 : 1);
  return v;
}

// ---- commands ------------------------------------------------------------------------
/** Where the image gets its Chromium from. An existing image answers first (so its cached
 *  browser layer is reused); otherwise the official CDN, unless it is unreachable from
 *  this network — then the npmmirror copy. PLAYWRIGHT_DOWNLOAD_HOST overrides both. */
function browserHost() {
  if (process.env.PLAYWRIGHT_DOWNLOAD_HOST !== undefined) return process.env.PLAYWRIGHT_DOWNLOAD_HOST;
  const label = docker(["image", "inspect", IMAGE, "--format", '{{ index .Config.Labels "anagram.lab.download-host" }}']);
  if (label.status === 0) return label.stdout.trim();
  const probe = spawnSync("curl", ["-sS", "-L", "-o", "/dev/null", "-r", "0-1048575", "--max-time", "8", "-w", "%{size_download}",
    "https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-linux-arm64.zip"], { encoding: "utf8" });
  if (Number(probe.stdout) >= 1048576) return "";
  console.log(`lab: Playwright's CDN is not reachable from this network — taking Chromium from ${BROWSER_MIRROR}`);
  return BROWSER_MIRROR;
}

function build() {
  const registry = spawnSync("npm", ["config", "get", "registry"], { encoding: "utf8" }).stdout.trim() || "https://registry.npmjs.org/";
  const args = ["build", "-f", join(ROOT, "test", "lab", "Dockerfile"),
    "--build-arg", `PLAYWRIGHT_VERSION=${PW_VERSION}`,
    "--build-arg", `PLAYWRIGHT_DOWNLOAD_HOST=${browserHost()}`,
    "--build-arg", `NPM_CONFIG_REGISTRY=${registry}`,
    "-t", IMAGE, ROOT];
  const fresh = docker(["image", "inspect", IMAGE]).status !== 0;
  console.log(fresh ? `lab: building image ${IMAGE} — the first build downloads Chromium and takes a few minutes…` : `lab: checking image ${IMAGE}…`);
  // A first build streams its log (it is long); later ones are cache hits and stay quiet.
  const r = docker(fresh ? args : [...args.slice(0, 1), "-q", ...args.slice(1)], { show: fresh });
  if (r.status !== 0) {
    if (!fresh) docker(args, { show: true });
    die("image build failed");
  }
  return docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"]).stdout.trim();
}

function up({ hidpi, screen, port } = {}) {
  const imageId = build();
  const info = inspect();
  const cur = info ? labEnv(info) : null;
  const want = { scale: hidpi === undefined ? (cur?.scale ?? 1) : hidpi ? 2 : 1, screen: screen ?? cur?.screen ?? "1920x1080", port: String(port ?? cur?.port ?? 6080) };
  const same = info && info.State?.Running && info.Image === imageId && cur.scale === want.scale && cur.screen === want.screen && cur.port === want.port;
  if (!same) {
    if (info) docker(["rm", "-f", NAME]);
    mkdirSync(RESULTS, { recursive: true });
    const r = docker([
      "run", "-d", "--name", NAME, "--hostname", NAME, "--init",
      "--restart", "unless-stopped",
      // Nothing in the lab needs privileges: everything runs as an ordinary user.
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--shm-size", "2g",
      "--cpus", process.env.LAB_CPUS || "4",
      "--memory", process.env.LAB_MEMORY || "6g",
      "-p", `127.0.0.1:${want.port}:6080`,
      "-v", `${ROOT}:/src:ro`,
      "-v", `${RESULTS}:/out`,
      "-e", `LAB_SCREEN=${want.screen}`, "-e", `LAB_SCALE=${want.scale}`,
      IMAGE,
    ]);
    if (r.status !== 0) die(`could not start the lab:\n${r.stderr}`);
    // Wait for the viewer to answer.
    for (let i = 0; i < 50; i++) {
      if (docker(["exec", NAME, "sh", "-c", "curl -fsS -o /dev/null http://127.0.0.1:6080/vnc.html"]).status === 0) break;
      spawnSync("sleep", ["0.2"]);
    }
  }
  console.log(`lab: up — screen ${want.screen}${want.scale > 1 ? ` @${want.scale}x` : ""}${CONTEXT ? ` on ${CONTEXT}` : ""}`);
  console.log(`     view   ${viewerUrl(want.port, false)}`);
  console.log(`     watch  ${viewerUrl(want.port, true)}   (look, don't touch)`);
}

function ensureUp() {
  if (!isUp()) up();
}

/** Copy the sources into `container` and rebuild the extension there when it must change. */
function syncInto(container) {
  const r = exec(
    "rsync -a --delete -i --exclude node_modules --exclude output --exclude .wxt --exclude .git --exclude dist " +
      "--exclude test-results --exclude 'anagramd/.venv' --exclude '__pycache__' --exclude .DS_Store --exclude .lab-lock " +
      "--exclude 'test/*.png' --exclude 'test/.unit-bundle.js' --exclude 'public/vendor' /src/ /work/", // public/vendor is regenerated by every build
    { show: false, container },
  );
  if (r.status !== 0) die(`sync failed:\n${r.stderr}`);
  const changed = r.stdout.split("\n").map((l) => l.slice(12).trim()).filter((p) => p && !p.endsWith("/"));
  const built = exec("test -f output/chrome-mv3/manifest.json", { show: false, container }).status === 0;
  const needsBuild = !built || changed.some((p) => !NO_REBUILD.test(p));
  console.log(`lab: synced (${changed.length} file${changed.length === 1 ? "" : "s"} changed)${needsBuild ? " — rebuilding the extension" : ""}`);
  if (needsBuild && exec("npm run -s build 2>&1 | tail -4", { container }).status !== 0) die("build failed inside the lab");
}

/** Bring the lab up, refresh the image if the lockfile moved on, then sync into it. */
function sync() {
  ensureUp();
  const lock = createHash("sha256").update(readFileSync(join(ROOT, "package-lock.json"))).digest("hex");
  const baked = docker(["exec", NAME, "cat", "/work/.lab-lock"]).stdout.trim();
  if (baked !== lock) {
    console.log("lab: package-lock.json changed — refreshing the image…");
    up();
  }
  syncInto(NAME);
}

function runSuites(suites, headless, container) {
  const rows = [];
  for (const s of suites) {
    console.log(`\n━━ ${s} ${"━".repeat(Math.max(4, 70 - s.length))}`);
    const t0 = Date.now();
    const r = exec(SUITES[s], { env: { ...(headless ? {} : { HEADED: "1" }), ANAGRAM_ARTIFACTS: `/out/${s}`, CI: "1" }, container });
    rows.push({ suite: s, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 100) / 10 });
  }
  return rows;
}

/** One hermetic run: a throwaway container of the same image with NO network interface at all
 *  (`--network none` — only loopback exists inside it), the same read-only /src and writable
 *  /out, and a screen of its own. The running lab is deliberately left alone: taking it off
 *  the bridge network is what would prove the same thing, but a published port does not
 *  reliably come back when the container is reconnected, and that port is the viewer. So the
 *  viewer shows nothing of this run — there is no port to publish from a container that has no
 *  network. The sync and the build happen inside it too, so those are proven offline as well. */
function offlineRun(suites, headless) {
  const OFF = `${NAME}-offline`;
  const imageId = build(); // the image build may need the network; it happens before we drop it
  const { screen, scale } = labEnv(inspect()); // the lab's own screen size, or the defaults
  const remove = () => docker(["rm", "-f", OFF]);
  remove(); // anything left behind by an interrupted run
  mkdirSync(RESULTS, { recursive: true });
  // Ctrl-C, a signal, a die() deep inside a helper: the container goes either way.
  const onSignal = () => { remove(); process.exit(130); };
  process.on("exit", remove);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const r = docker(["run", "-d", "--name", OFF, "--hostname", OFF, "--init",
      "--network", "none",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--shm-size", "2g",
      "--cpus", process.env.LAB_CPUS || "4", "--memory", process.env.LAB_MEMORY || "6g",
      "-v", `${ROOT}:/src:ro`, "-v", `${RESULTS}:/out`,
      "-e", `LAB_SCREEN=${screen}`, "-e", `LAB_SCALE=${scale}`,
      imageId]);
    if (r.status !== 0) die(`could not start the offline lab:\n${r.stderr}`);
    for (let i = 0; i < 100; i++) {
      if (exec("test -S /tmp/.X11-unix/X99", { show: false, container: OFF }).status === 0) break;
      spawnSync("sleep", ["0.2"]);
    }
    console.log(`lab: offline — ${OFF} has no network at all; nothing to view until it is done`);
    syncInto(OFF);
    return runSuites(suites, headless, OFF);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    remove();
  }
}

function test() {
  const headless = flag("headless");
  const offline = flag("offline");
  const suites = argv.length ? argv : DEFAULT_SUITES;
  for (const s of suites) if (!SUITES[s]) die(`unknown suite "${s}" — one of: ${Object.keys(SUITES).join(", ")}`);
  let rows;
  if (offline) {
    rows = offlineRun(suites, headless);
  } else {
    sync();
    rows = runSuites(suites, headless, NAME);
  }
  const where = offline ? "offline, no network" : headless ? "headless" : "on the lab's screen";
  console.log(`\n━━ lab summary (${where}) ${"━".repeat(30)}`);
  for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.suite.padEnd(10)} ${r.seconds}s`);
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, "summary.json"), JSON.stringify({ at: new Date().toISOString(), headless, offline, rows }, null, 1));
  console.log(`artifacts: ${RESULTS}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

function hide() {
  exec("pkill -f test/lab/show.mjs 2>/dev/null; pkill -f 'socat TCP-LISTEN:8765' 2>/dev/null; true", { show: false });
}

function show() {
  sync();
  hide();
  const passthrough = argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  exec(`node test/lab/show.mjs ${passthrough} >/tmp/show.log 2>&1`, { detach: true, show: false });
  // Give it a moment, then relay what it said (it prints what it opened, or why it could not).
  spawnSync("sleep", ["4"]);
  console.log(exec("cat /tmp/show.log", { show: false }).stdout.trim());
  console.log(`lab: look at ${viewerUrl(labEnv().port, false)}   ·   close with: npm run lab -- hide`);
}

function shot() {
  ensureUp();
  const name = (argv[0] ?? "screen").replace(/[^\w.-]/g, "_");
  if (exec(`scrot -o /out/${name}.png`, { show: false }).status !== 0) die("could not capture the lab's screen");
  console.log(join(RESULTS, `${name}.png`));
}

switch (cmd) {
  case "up":
    up({ hidpi: flag("hidpi") ? true : flag("lodpi") ? false : undefined, screen: flag("screen", true), port: flag("port", true) });
    break;
  case "down":
    docker(["rm", "-f", NAME]);
    console.log("lab: removed (the image stays cached; `docker rmi " + IMAGE + "` frees it)");
    break;
  case "view": {
    ensureUp();
    const url = viewerUrl(labEnv().port, flag("watch"));
    console.log(url);
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    break;
  }
  case "sync": sync(); break;
  case "test": test(); break;
  case "show": show(); break;
  case "hide": hide(); console.log("lab: closed"); break;
  case "shot": shot(); break;
  case "run": {
    ensureUp();
    const rest = argv[0] === "--" ? argv.slice(1) : argv;
    if (!rest.length) die("usage: npm run lab -- run -- <command…>");
    process.exit(exec(rest.join(" "), { env: { HEADED: "1", ANAGRAM_ARTIFACTS: "/out/run" } }).status);
    break;
  }
  case "shell":
    ensureUp();
    spawnSync("docker", dockerArgs(["exec", "-it", "-u", LAB_USER, "-w", "/work", "-e", "DISPLAY=:99", "-e", "HEADED=1", NAME, "bash"]), { stdio: "inherit" });
    break;
  case "logs":
    docker(["logs", "--tail", "50", NAME], { show: true });
    exec("tail -n 20 /tmp/xvnc.log /tmp/websockify.log /tmp/show.log 2>/dev/null", { show: true });
    break;
  case "status": {
    const info = inspect();
    if (!info?.State?.Running) { console.log("lab: not running — start it with: npm run lab -- up"); break; }
    const e = labEnv(info);
    console.log(`lab: running${CONTEXT ? ` on ${CONTEXT}` : ""} — screen ${e.screen}${e.scale > 1 ? ` @${e.scale}x` : ""}`);
    console.log(`     view   ${viewerUrl(e.port, false)}`);
    const busy = exec("ps -eo etime,args | grep -E '^ *[0-9:-]+ node (test/|.*vitest)' | grep -v grep | cut -c1-100", { show: false }).stdout.trim();
    console.log(busy ? busy.split("\n").map((l) => `     running  ${l.trim()}`).join("\n") : "     idle — nothing on the screen");
    break;
  }
  default:
    die(`unknown command "${cmd}" — up, view, test, show, hide, shot, run, shell, status, logs, down`);
}
