// test/node/daemonPort.test.ts — the rule that keeps a test run off somebody's own daemon.
//
// test/server.mjs and test/verify-backend.mjs load the real 1.4 GB model, so neither can be
// run in a suite — and the one thing about them that MUST be right is the thing that
// happens before the model is anywhere near: which port they use, and whether they are
// allowed to touch a daemon that was already running on it. That decision is a pure
// function in test/daemon-port.mjs, and this is where it is held to the rule:
//
//   nothing asked for      → our own daemon, on a port the OS picked
//   a port asked for, free → our own daemon, there
//   a port asked for, busy → refuse, and say what to do instead
//   reuse asked for        → the running daemon, which this run must not stop
//   reuse asked for, none  → refuse
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, planDaemon, portToProbe, readDaemonEnv, resolveDaemon } from "../daemon-port.mjs";

describe("what the environment asked for", () => {
  it("nothing set is nothing asked for", () => {
    expect(readDaemonEnv({})).toEqual({ requested: null, reuse: false });
  });

  it("reads a port and the reuse flag in the spellings people use", () => {
    expect(readDaemonEnv({ ANAGRAMD_PORT: "8801" }).requested).toBe(8801);
    for (const yes of ["1", "true", "YES", "on"]) {
      expect(readDaemonEnv({ ANAGRAMD_REUSE: yes }).reuse, yes).toBe(true);
    }
    for (const no of ["", "0", "false", "no"]) {
      expect(readDaemonEnv({ ANAGRAMD_REUSE: no }).reuse, no).toBe(false);
    }
  });

  it("refuses a port that is not one, rather than falling back to 8765", () => {
    // Number("") is 0 and Number("http://…") is NaN: the old `Number(env || 8765)` turned
    // a typo into the default port, which is the one port this must never land on by
    // accident.
    for (const bad of ["ache", "0", "70000", "http://127.0.0.1:8801"]) {
      expect(() => readDaemonEnv({ ANAGRAMD_PORT: bad }), bad).toThrow(/not a port number/);
    }
  });

  it("refuses a reuse flag nobody can read", () => {
    expect(() => readDaemonEnv({ ANAGRAMD_REUSE: "maybe" })).toThrow(/not a yes or a no/);
  });
});

describe("which daemon a run uses", () => {
  it("asked for nothing: its own, on a free port — and never probes 8765", () => {
    expect(portToProbe({ requested: null, reuse: false })).toBe(null);
    expect(planDaemon({})).toEqual({ port: null, start: true });
  });

  it("asked for a port that is free: its own, there", () => {
    expect(portToProbe({ requested: 8801 })).toBe(8801);
    expect(planDaemon({ requested: 8801, listening: false })).toEqual({ port: 8801, start: true });
  });

  it("asked for a port that is busy: refuses, and names both ways out", () => {
    const boom = () => planDaemon({ requested: DEFAULT_PORT, listening: true });
    expect(boom).toThrow(/already listening on http:\/\/127\.0\.0\.1:8765/);
    expect(boom).toThrow(/ANAGRAMD_REUSE=1/);
    expect(boom).toThrow(/unset ANAGRAMD_PORT/);
  });

  it("asked to reuse: the running daemon, and this run does not start it", () => {
    expect(planDaemon({ reuse: true, listening: true })).toEqual({ port: DEFAULT_PORT, start: false });
    expect(planDaemon({ requested: 8801, reuse: true, listening: true })).toEqual({ port: 8801, start: false });
  });

  it("asked to reuse a daemon that is not running: refuses rather than starting one on 8765", () => {
    // Starting a daemon on the default port and killing it at the end of the run is
    // exactly the behaviour that surprised somebody — so "reuse" means reuse, and an
    // empty port is an error naming the command that fills it.
    expect(() => planDaemon({ reuse: true, listening: false })).toThrow(/nothing answers on http:\/\/127\.0\.0\.1:8765/);
    expect(() => planDaemon({ reuse: true, listening: false })).toThrow(/anagram start/);
  });
});

describe("the resolution the suites actually call", () => {
  it("asks no daemon anything when it is starting its own", async () => {
    const asked: string[] = [];
    const target = await resolveDaemon((base) => (asked.push(base), null), {});
    expect(asked).toEqual([]);
    expect(target.start).toBe(true);
    expect(target.port).toBeGreaterThan(0);
    expect(target.port).not.toBe(DEFAULT_PORT);
    expect(target.base).toBe(`http://127.0.0.1:${target.port}`);
  });

  it("probes only the port that was asked for, and hands back what is there", async () => {
    const asked: string[] = [];
    const health = (base: string) => (asked.push(base), { ok: true });
    const target = await resolveDaemon(health, { ANAGRAMD_PORT: "8801", ANAGRAMD_REUSE: "1" });
    expect(asked).toEqual(["http://127.0.0.1:8801"]);
    expect(target).toEqual({ port: 8801, base: "http://127.0.0.1:8801", start: false });
  });

  it("a free port is really free", async () => {
    // The OS picks it, so two runs in a row cannot collide on it either.
    const a = await resolveDaemon(() => null, {});
    const b = await resolveDaemon(() => null, {});
    expect(a.port).not.toBe(b.port);
  });
});
