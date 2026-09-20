// test/daemon-port.mjs — which anagramd the two real-daemon suites talk to.
//
// test/server.mjs and test/verify-backend.mjs used to take whatever was already answering
// on 8765, which is exactly where a developer's OWN installation listens: a run meant to
// exercise the build sent test paragraphs through somebody's own daemon, and the one that
// kills the daemon afterwards came close to stopping it. So the default is now a daemon of
// the suite's own on a port the operating system picked, and borrowing a running one is
// something you ask for:
//
//   node test/server.mjs                          a private daemon on a free port
//   ANAGRAMD_PORT=8801 node test/server.mjs        a private daemon THERE (busy → error)
//   ANAGRAMD_REUSE=1 node test/server.mjs          the daemon already on 8765 (none → error)
//   ANAGRAMD_REUSE=1 ANAGRAMD_PORT=8801 node …     the daemon already on 8801
//
// A daemon this run did not start is never stopped by it, which is why the reuse cases are
// the ones that print so.
//
// The decision itself is `planDaemon`, which is pure — it is handed the facts and returns
// the plan or throws the sentence the user needs to read — because the suites around it
// cannot be run without the 1.4 GB model, and a rule about somebody else's daemon is worth
// nothing if it is only ever checked by hand (test/node/daemonPort.test.ts).
import net from "node:net";

/** Where an installed Anagram listens: installer/anagram, install.sh, lib/backend. */
export const DEFAULT_PORT = 8765;

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["", "0", "false", "no", "off"]);

/** ANAGRAMD_PORT / ANAGRAMD_REUSE as the two suites read them. Throws on nonsense. */
export function readDaemonEnv(env = process.env) {
  const raw = (env.ANAGRAMD_PORT ?? "").trim();
  let requested = null;
  if (raw !== "") {
    requested = Number(raw);
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
      throw new Error(`ANAGRAMD_PORT="${raw}" is not a port number (1–65535).`);
    }
  }
  const flag = (env.ANAGRAMD_REUSE ?? "").trim().toLowerCase();
  if (!TRUE.has(flag) && !FALSE.has(flag)) {
    throw new Error(`ANAGRAMD_REUSE="${flag}" is not a yes or a no — set it to 1, or leave it unset.`);
  }
  return { requested, reuse: TRUE.has(flag) };
}

/**
 * The plan, from the two settings and whether the port they name is answering.
 *
 *   { port: null, start: true }   start our own daemon on a free port (the default)
 *   { port: N,    start: true }   start our own daemon on the port that was asked for
 *   { port: N,    start: false }  use the daemon already running there, and leave it running
 *
 * `listening` is about the port this run would otherwise use — the one `portToProbe`
 * names — and is irrelevant when there is no such port, because a port the operating
 * system hands out is free by construction.
 */
export function planDaemon({ requested = null, reuse = false, listening = false } = {}) {
  const at = (p) => `http://127.0.0.1:${p}`;
  if (reuse) {
    const port = requested ?? DEFAULT_PORT;
    if (!listening) {
      throw new Error(
        `ANAGRAMD_REUSE asks for a daemon that is already running, and nothing answers on ${at(port)}.\n` +
          `Start one (~/.anagram/bin/anagram start, or npm run serve), or unset ANAGRAMD_REUSE and this run will start its own.`,
      );
    }
    return { port, start: false };
  }
  if (requested === null) return { port: null, start: true };
  if (listening) {
    throw new Error(
      `Something is already listening on ${at(requested)} and this run did not start it — it may be your own daemon.\n` +
        `Set ANAGRAMD_REUSE=1 to test against it (it will be left running), or unset ANAGRAMD_PORT to start a private daemon on a free port.`,
    );
  }
  return { port: requested, start: true };
}

/** The port to ask about before deciding, or null when nothing needs asking. */
export function portToProbe({ requested = null, reuse = false } = {}) {
  if (requested !== null) return requested;
  return reuse ? DEFAULT_PORT : null;
}

/** A port nothing is using, from the operating system. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The whole decision, for a suite that has a way of asking a daemon whether it is there:
 * `health(base)` is called at most once and only has to be truthy when one answers.
 * Returns the port to use, its base URL, and whether this run must start the daemon
 * itself — which is also whether it may stop it again.
 */
export async function resolveDaemon(health, env = process.env) {
  const { requested, reuse } = readDaemonEnv(env);
  const probe = portToProbe({ requested, reuse });
  const listening = probe === null ? false : !!(await health(`http://127.0.0.1:${probe}`));
  const plan = planDaemon({ requested, reuse, listening });
  const port = plan.port ?? (await freePort());
  return { port, base: `http://127.0.0.1:${port}`, start: plan.start };
}
